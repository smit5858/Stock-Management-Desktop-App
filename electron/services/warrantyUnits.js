'use strict';

// Warranty read side: the Warranty page search, the detail card of one unit (serial) or bill
// line (non-serial), the warranty lists, dashboard alerts, voiding a warranty and the Excel
// export rows. A warranty's status is always computed (dates + sale + claims), never stored.
// No electron imports.

const { AppError } = require('../errors');
const { isISODate, todayISO, str } = require('./parse');
const settings = require('./settings');
const serials = require('./serials');
const sales = require('./sales');
const W = require('./warranty');
const id = require('../validation/identity');

const OPEN = "('closed','cancelled')"; // claim statuses that are NOT open
const MANUAL_VOID = ['physical_damage', 'water_damage', 'tampered', 'wrong_fitting', 'other'];
const LIST_LIMIT = 2000;

const EVENT_LABELS = {
  received_opening: 'Added (opening stock)',
  tracking_enabled: 'Serial recorded for existing stock',
  adjusted_in: 'Added (stock adjustment)',
  received_purchase: 'Purchased',
  purchased: 'Purchased',
  purchase_edited: 'Purchase edited',
  sold: 'Sold',
  returned_by_customer: 'Returned by customer',
  sale_returned: 'Returned by customer',
  sale_cancelled: 'Sale cancelled',
  returned_to_supplier: 'Returned to supplier',
  return_cancelled: 'Supplier return cancelled',
  marked_defective: 'Marked defective',
  written_off: 'Written off',
  repaired_to_stock: 'Repaired, back in stock',
  warranty_changed: 'Warranty changed',
  warranty_voided: 'Warranty voided',
  voided: 'Removed from purchase',
  claim_received: 'Claim received',
  claim_sent: 'Sent to supplier',
  claim_back: 'Back from supplier',
  claim_repaired: 'Repaired under claim',
  claim_replaced: 'Replaced under claim',
  claim_rejected: 'Claim rejected',
  claim_returned: 'Returned to customer',
  claim_refunded: 'Refunded under claim',
  replacement_issued: 'Given as replacement',
  supplier_replacement_received: 'Received from supplier as replacement',
};

const CLAIM_EVENT_LABELS = {
  received: 'Claim opened',
  inspected: 'Under inspection',
  decided: 'Decision',
  repaired: 'Repaired',
  dispatched: 'Sent to supplier',
  supplier_result: 'Supplier result',
  replaced: 'Replacement given',
  refunded: 'Refunded',
  rejected: 'Rejected',
  returned: 'Returned to customer',
  closed: 'Closed',
  cancelled: 'Cancelled',
  billed: 'Bill created',
  attachment_added: 'Photo added',
  attachment_removed: 'Photo removed',
  note: 'Note',
};

function expiringDays(db) {
  const n = Number(settings.getSettings(db).warranty_expiring_days);
  return Number.isInteger(n) && n >= 1 && n <= 365 ? n : W.EXPIRING_DAYS;
}

function likeArg(word) {
  return `%${word.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

function variantLabelOf(r) {
  return [r.color, r.size, r.variant_type].filter(Boolean).join(' / ');
}

function openClaimOfSerial(db, serialId) {
  return (
    db
      .prepare(
        `SELECT id, claim_no, status FROM warranty_claims
         WHERE serial_id = ? AND is_deleted = 0 AND status NOT IN ${OPEN} ORDER BY id DESC LIMIT 1`,
      )
      .get(serialId) || null
  );
}

function openClaimsOfLine(db, saleItemId) {
  return db
    .prepare(
      `SELECT id, claim_no, status, qty_milli FROM warranty_claims
       WHERE sale_item_id = ? AND serial_id IS NULL AND is_deleted = 0 AND status NOT IN ${OPEN}
       ORDER BY id`,
    )
    .all(saleItemId);
}

function refundedByClaim(db, { serialId = null, saleItemId = null }) {
  return Boolean(
    db
      .prepare(
        `SELECT 1 FROM warranty_claims WHERE is_deleted = 0 AND outcome = 'refunded'
           AND ${serialId ? 'serial_id = ?' : 'sale_item_id = ? AND serial_id IS NULL'} LIMIT 1`,
      )
      .get(serialId || saleItemId),
  );
}

// ---------------------------------------------------------------- one serial unit

const SERIAL_SQL = `
  SELECT s.*, p.name AS product_name, p.brand, p.category_id, p.unit, p.customer_warranty_months,
    p.warranty_covered, p.warranty_not_covered, c.name AS category_name, v.sku, v.color, v.size,
    v.variant_type, su.name AS supplier_name, pu.entry_no AS purchase_entry_no,
    pu.bill_no AS purchase_bill_no
  FROM product_serials s
  JOIN products p ON p.id = s.product_id
  JOIN product_variants v ON v.id = s.variant_id
  LEFT JOIN product_categories c ON c.id = p.category_id
  LEFT JOIN parties su ON su.id = s.supplier_party_id
  LEFT JOIN purchases pu ON pu.id = s.purchase_id`;

/** The unit's latest sale link (current sale, or the last one if it was returned / cancelled). */
function latestLink(db, serialId) {
  return (
    db
      .prepare(
        `SELECT x.*, si.sale_id, si.fitted_by, si.warranty_months AS line_warranty_months,
           si.qty_milli AS line_qty_milli
         FROM sale_item_serials x JOIN sale_items si ON si.id = x.sale_item_id
         WHERE x.serial_id = ? ORDER BY x.id DESC LIMIT 1`,
      )
      .get(serialId) || null
  );
}

function saleSnapshot(db, saleId) {
  if (!saleId) return null;
  return db
    .prepare(
      `SELECT id, invoice_no, invoice_date, status, party_id, customer_name, customer_phone,
         vehicle_id, vehicle_no, vehicle_model, cancel_reason
       FROM sales WHERE id = ?`,
    )
    .get(saleId);
}

/** Summary of one serial unit (as on a bill). `link` = a sale_item_serials row (optional). */
function serialSummary(db, s, link, ctx) {
  const sale = link ? ctx.sale || saleSnapshot(db, link.sale_id) : null;
  const current = link && link.status === 'sold' && s.sale_item_id === link.sale_item_id;
  const start = current ? s.warranty_start : link ? link.warranty_start : null;
  const end = current ? s.warranty_end : link ? link.warranty_end : null;
  const openClaim = current || !link ? openClaimOfSerial(db, s.id) : null;
  let voidReason = s.warranty_void_reason || null;
  let closedAs = null;
  if (s.replaced_by_serial_id || s.status === 'replaced') closedAs = 'replaced';
  else if (link && link.status === 'returned' && refundedByClaim(db, { serialId: s.id }))
    closedAs = 'refunded';
  if (!voidReason && !closedAs && link) {
    if (link.status === 'cancelled' || (sale && sale.status === 'cancelled'))
      voidReason = 'sale_cancelled';
    else if (link.status === 'returned') voidReason = 'returned';
  }
  return {
    key: `s-${s.id}${link ? `-${link.sale_item_id}` : ''}`,
    kind: 'serial',
    serial_id: s.id,
    sale_item_id: link ? link.sale_item_id : null,
    sale_id: sale ? sale.id : null,
    invoice_no: sale ? sale.invoice_no : null,
    invoice_date: sale ? sale.invoice_date : null,
    product_id: s.product_id,
    variant_id: s.variant_id,
    product_name: s.product_name,
    variant_label: variantLabelOf(s),
    brand: s.brand || null,
    serial_no: s.serial_no,
    serial_no_2: s.serial_no_2,
    serial_status: s.status,
    serial_status_label: serials.STATUS_LABELS[s.status],
    qty_milli: 1000,
    unit: s.unit,
    is_replacement: Boolean(link && link.is_replacement),
    customer_name: sale ? sale.customer_name : null,
    customer_phone: sale ? id.formatPhone(sale.customer_phone) : null,
    vehicle_no: sale ? sale.vehicle_no : null,
    fitted_by: link ? link.fitted_by : null,
    warranty_start: start,
    warranty_end: end,
    open_claim: openClaim,
    status: W.unitStatus({
      end,
      start,
      today: ctx.today,
      expiringDays: ctx.days,
      voidReason: link || voidReason ? voidReason : null,
      closedAs,
      openClaim: Boolean(openClaim),
    }),
  };
}

// ---------------------------------------------------------------- one bill line

const LINE_SQL = `
  SELECT si.*, sa.invoice_no, sa.invoice_date, sa.status AS sale_status, sa.party_id,
    sa.customer_name, sa.customer_phone, sa.vehicle_id, sa.vehicle_no, sa.vehicle_model,
    p.brand, p.category_id, p.track_serials, p.customer_warranty_months, p.warranty_covered,
    p.warranty_not_covered, c.name AS category_name
  FROM sale_items si JOIN sales sa ON sa.id = si.sale_id
  JOIN products p ON p.id = si.product_id
  LEFT JOIN product_categories c ON c.id = p.category_id`;

function lineSummary(db, l, ctx) {
  const returned = sales.returnedQty(db, l.id);
  const claims = openClaimsOfLine(db, l.id);
  const claimed = claims.reduce((sum, c) => sum + c.qty_milli, 0);
  let voidReason = l.warranty_void_reason || null;
  let closedAs = null;
  if (!voidReason) {
    if (l.sale_status === 'cancelled') voidReason = 'sale_cancelled';
    else if (returned >= l.qty_milli) {
      if (refundedByClaim(db, { saleItemId: l.id })) closedAs = 'refunded';
      else voidReason = 'returned';
    }
  }
  return {
    key: `l-${l.id}`,
    kind: 'line',
    serial_id: null,
    sale_item_id: l.id,
    sale_id: l.sale_id,
    invoice_no: l.invoice_no,
    invoice_date: l.invoice_date,
    product_id: l.product_id,
    variant_id: l.variant_id,
    product_name: l.product_name,
    variant_label: l.variant_label || '',
    brand: l.brand || null,
    serial_no: null,
    serial_no_2: null,
    qty_milli: l.qty_milli,
    returned_milli: returned,
    claimed_milli: claimed,
    claimable_milli: Math.max(0, l.qty_milli - returned - claimed),
    unit: l.unit,
    is_replacement: false,
    customer_name: l.customer_name,
    customer_phone: id.formatPhone(l.customer_phone),
    vehicle_no: l.vehicle_no,
    fitted_by: l.fitted_by,
    warranty_start: l.warranty_start,
    warranty_end: l.warranty_end,
    open_claim: claims[0] || null,
    open_claims: claims,
    status: W.unitStatus({
      end: l.warranty_end,
      start: l.warranty_start || l.invoice_date,
      today: ctx.today,
      expiringDays: ctx.days,
      voidReason,
      closedAs,
      openClaim: claims.length > 0,
    }),
  };
}

/** Goods on a bill: one entry per serial unit (incl. replacements), one per non-serial line. */
function unitsOfSale(db, saleId, ctx) {
  const sale = saleSnapshot(db, saleId);
  const out = [];
  const lines = db
    .prepare(
      `${LINE_SQL} WHERE si.sale_id = ? AND si.item_type = 'goods' ORDER BY si.sort_order, si.id`,
    )
    .all(saleId);
  const links = db.prepare(
    'SELECT * FROM sale_item_serials WHERE sale_item_id = ? ORDER BY is_replacement, id',
  );
  const serialRow = db.prepare(`${SERIAL_SQL} WHERE s.id = ?`);
  for (const l of lines) {
    const rows = links.all(l.id);
    if (rows.length) {
      for (const x of rows) {
        const s = serialRow.get(x.serial_id);
        out.push(
          serialSummary(db, s, { ...x, sale_id: saleId, fitted_by: l.fitted_by }, { ...ctx, sale }),
        );
      }
    } else out.push(lineSummary(db, l, ctx));
  }
  return out;
}

function ctxOf(db) {
  return { today: todayISO(), days: expiringDays(db) };
}

// ---------------------------------------------------------------- search

/**
 * One box: serial no. (or second number), invoice no., customer name / phone, vehicle plate
 * (any format), claim no. Results are grouped by bill; units not on any bill (in the shop) are
 * listed separately, and matching claims too.
 */
function search(db, { query }) {
  const q = str(query);
  if (q.length < 2) return { query: q, groups: [], claims: [] };
  const ctx = ctxOf(db);
  const key = serials.serialKey(q);

  const claims = db
    .prepare(
      `SELECT c.id, c.claim_no, c.status, c.received_date, c.customer_name, p.name AS product_name,
         s.serial_no
       FROM warranty_claims c JOIN products p ON p.id = c.product_id
       LEFT JOIN product_serials s ON s.id = c.serial_id
       WHERE c.is_deleted = 0 AND (c.claim_no LIKE ? ESCAPE '\\' OR s.serial_key = ?)
       ORDER BY c.id DESC LIMIT 20`,
    )
    .all(likeArg(q), key);

  const saleIds = sales
    .list(db, { search: q })
    .rows.slice(0, 25)
    .map((r) => r.id);
  for (const c of db
    .prepare(
      "SELECT DISTINCT sale_id FROM warranty_claims WHERE claim_no LIKE ? ESCAPE '\\' AND sale_id IS NOT NULL LIMIT 10",
    )
    .pluck()
    .all(likeArg(q))) {
    if (!saleIds.includes(c)) saleIds.push(c);
  }

  const matchedSerials = new Set(
    key.length >= 2
      ? db
          .prepare(
            `SELECT id FROM product_serials WHERE status <> 'voided'
               AND (serial_key LIKE ? ESCAPE '\\' OR serial_key_2 LIKE ? ESCAPE '\\') LIMIT 50`,
          )
          .pluck()
          .all(likeArg(key), likeArg(key))
      : [],
  );

  const groups = saleIds.map((saleId) => {
    const sale = saleSnapshot(db, saleId);
    const units = unitsOfSale(db, saleId, ctx).map((u) => ({
      ...u,
      matched: Boolean(u.serial_id && matchedSerials.has(u.serial_id)),
    }));
    return {
      key: `sale-${saleId}`,
      sale: { ...sale, customer_phone: id.formatPhone(sale.customer_phone) },
      units,
    };
  });

  // Units never sold (in the shop, defective, at the supplier…): supplier warranty only.
  const loose = [...matchedSerials].filter(
    (sid) => !db.prepare('SELECT 1 FROM sale_item_serials WHERE serial_id = ?').get(sid),
  );
  if (loose.length) {
    const row = db.prepare(`${SERIAL_SQL} WHERE s.id = ?`);
    groups.push({
      key: 'unsold',
      sale: null,
      units: loose.map((sid) => ({ ...serialSummary(db, row.get(sid), null, ctx), matched: true })),
    });
  }
  return { query: q, groups, claims };
}

// ---------------------------------------------------------------- detail card

function ownerNote(db, sale) {
  if (!sale || !sale.vehicle_id) return null;
  const v = db
    .prepare(
      `SELECT v.customer_id, p.name FROM vehicles v JOIN parties p ON p.id = v.customer_id
       WHERE v.id = ?`,
    )
    .get(sale.vehicle_id);
  if (!v || v.customer_id === sale.party_id) return null;
  return {
    current_owner_id: v.customer_id,
    current_owner_name: v.name,
    text: `The vehicle now belongs to ${v.name}. The warranty follows the unit, so a claim is still allowed; the original buyer is shown.`,
  };
}

function claimsOf(db, { serialId = null, saleItemId = null }) {
  return db
    .prepare(
      `SELECT c.id, c.claim_no, c.status, c.decision, c.outcome, c.received_date, c.complaint,
         c.qty_milli, c.chargeable, c.closed_date
       FROM warranty_claims c
       WHERE c.is_deleted = 0 AND ${serialId ? 'c.serial_id = ?' : 'c.sale_item_id = ? AND c.serial_id IS NULL'}
       ORDER BY c.id DESC`,
    )
    .all(serialId || saleItemId);
}

function claimTimeline(db, claimIds) {
  if (!claimIds.length) return [];
  return db
    .prepare(
      `SELECT e.*, c.claim_no FROM claim_events e JOIN warranty_claims c ON c.id = e.claim_id
       WHERE e.claim_id IN (${claimIds.map(() => '?').join(',')}) ORDER BY e.id`,
    )
    .all(...claimIds)
    .map((e) => ({
      key: `c${e.id}`,
      date: e.date,
      at: e.created_at,
      source: 'claim',
      type: e.type,
      label: `${e.claim_no}: ${CLAIM_EVENT_LABELS[e.type] || e.type}`,
      note: e.note,
      claim_id: e.claim_id,
    }));
}

function sortTimeline(items) {
  return items.sort((a, b) =>
    a.date === b.date ? String(a.at).localeCompare(String(b.at)) : a.date.localeCompare(b.date),
  );
}

function terms(row) {
  return {
    months: row.customer_warranty_months || 0,
    covered: row.warranty_covered || '',
    not_covered: row.warranty_not_covered || '',
  };
}

/** Detail card of a serial unit ({ serial_id }) or a non-serial bill line ({ sale_item_id }). */
function unit(db, ref) {
  const ctx = ctxOf(db);
  if (Number.isInteger(ref.serial_id)) {
    const s = db.prepare(`${SERIAL_SQL} WHERE s.id = ?`).get(ref.serial_id);
    if (!s) throw new AppError('Serial number not found.', 'NOT_FOUND');
    const link = latestLink(db, s.id);
    const sum = serialSummary(db, s, link, ctx);
    const sale = link ? saleSnapshot(db, link.sale_id) : null;
    const claims = claimsOf(db, { serialId: s.id });
    const events = db
      .prepare('SELECT * FROM serial_events WHERE serial_id = ? ORDER BY date, id')
      .all(s.id)
      .map((e) => ({
        key: `s${e.id}`,
        date: e.date,
        at: e.created_at,
        source: 'serial',
        type: e.type,
        label: EVENT_LABELS[e.type] || e.type.replace(/_/g, ' '),
        note: e.note,
      }));
    const related = (sid) =>
      sid
        ? db.prepare('SELECT id, serial_no, status FROM product_serials WHERE id = ?').get(sid)
        : null;
    const withCustomer = s.status === 'sold' && link && link.status === 'sold';
    return {
      ...sum,
      category_name: s.category_name,
      sku: s.sku,
      terms: terms(s),
      sale: sale && { ...sale, customer_phone: id.formatPhone(sale.customer_phone) },
      customer_party_id: sale ? sale.party_id : s.customer_party_id,
      owner_note: ownerNote(db, sale),
      supplier_warranty: {
        supplier_party_id: s.supplier_party_id,
        supplier_name: s.supplier_name,
        purchase_id: s.purchase_id,
        purchase_entry_no: s.purchase_entry_no,
        purchase_bill_no: s.purchase_bill_no,
        purchase_date: s.purchase_date,
        end: s.supplier_warranty_end,
        ...W.warrantyStatus(s.supplier_warranty_end, ctx.today, ctx.days),
      },
      replaced_by: related(s.replaced_by_serial_id),
      replaces: related(s.replaces_serial_id),
      void_note: s.warranty_void_note,
      voided_at: s.warranty_voided_at,
      claims,
      timeline: sortTimeline([
        ...events,
        ...claimTimeline(
          db,
          claims.map((c) => c.id),
        ),
      ]),
      can: {
        claim: withCustomer && !sum.open_claim,
        void: withCustomer && !s.warranty_void_reason && Boolean(sum.warranty_end),
        card: withCustomer,
      },
    };
  }
  if (Number.isInteger(ref.sale_item_id)) {
    const l = db.prepare(`${LINE_SQL} WHERE si.id = ?`).get(ref.sale_item_id);
    if (!l || l.item_type !== 'goods') throw new AppError('Bill line not found.', 'NOT_FOUND');
    if (db.prepare('SELECT 1 FROM sale_item_serials WHERE sale_item_id = ?').get(l.id)) {
      throw new AppError(
        'This item has serial numbers: open the unit by its serial.',
        'VALIDATION',
      );
    }
    const sum = lineSummary(db, l, ctx);
    const sale = saleSnapshot(db, l.sale_id);
    const claims = claimsOf(db, { saleItemId: l.id });
    const items = [
      {
        key: 'sold',
        date: l.invoice_date,
        at: l.created_at,
        source: 'sale',
        type: 'sold',
        label: 'Sold',
        note: `${l.invoice_no} · ${l.customer_name}${l.warranty_end ? ` · warranty till ${l.warranty_end}` : ''}`,
      },
      ...db
        .prepare(
          `SELECT ri.id, ri.qty_milli, r.return_no, r.date, r.created_at, r.status FROM sale_return_items ri
           JOIN sale_returns r ON r.id = ri.sale_return_id WHERE ri.sale_item_id = ?`,
        )
        .all(l.id)
        .map((r) => ({
          key: `r${r.id}`,
          date: r.date,
          at: r.created_at,
          source: 'sale',
          type: 'returned',
          label: `Returned ${r.qty_milli / 1000} ${l.unit}`,
          note: `${r.return_no}${r.status === 'cancelled' ? ' (cancelled)' : ''}`,
        })),
    ];
    if (l.sale_status === 'cancelled') {
      items.push({
        key: 'cancel',
        date: l.invoice_date,
        at: '~',
        source: 'sale',
        type: 'sale_cancelled',
        label: 'Sale cancelled',
        note: sale.cancel_reason,
      });
    }
    if (l.warranty_voided_at) {
      items.push({
        key: 'void',
        date: l.warranty_voided_at.slice(0, 10),
        at: l.warranty_voided_at,
        source: 'sale',
        type: 'warranty_voided',
        label: 'Warranty voided',
        note: `${W.VOID_REASONS[l.warranty_void_reason] || ''}${l.warranty_void_note ? `: ${l.warranty_void_note}` : ''}`,
      });
    }
    const live = l.sale_status === 'active' && sum.claimable_milli > 0;
    return {
      ...sum,
      category_name: l.category_name,
      sku: l.sku,
      terms: terms(l),
      sale: { ...sale, customer_phone: id.formatPhone(sale.customer_phone) },
      customer_party_id: l.party_id,
      owner_note: ownerNote(db, sale),
      supplier_warranty: null,
      replaced_by: null,
      replaces: null,
      void_note: l.warranty_void_note,
      voided_at: l.warranty_voided_at,
      claims,
      timeline: sortTimeline([
        ...items,
        ...claimTimeline(
          db,
          claims.map((c) => c.id),
        ),
      ]),
      can: {
        claim: live,
        void: live && !l.warranty_void_reason && Boolean(l.warranty_end),
        card: l.sale_status === 'active',
      },
    };
  }
  throw new AppError('Choose a unit or bill line.', 'VALIDATION');
}

// ---------------------------------------------------------------- void

/** Voids a customer warranty by hand, with a reason (kept on the unit / line and in history). */
function voidWarranty(db, { serial_id: serialId, sale_item_id: saleItemId, reason, note }) {
  const why = str(note);
  const errors = {};
  if (!MANUAL_VOID.includes(reason)) errors.reason = 'Choose a reason.';
  if (reason === 'other' && !why) errors.note = 'Describe the reason.';
  if (why.length > 300) errors.note = 'Too long (max 300).';
  if (Object.keys(errors).length)
    throw new AppError(`Please check: ${Object.values(errors)[0]}`, 'VALIDATION', errors);
  db.transaction(() => {
    if (Number.isInteger(serialId)) {
      const s = serials.loadSerial(db, serialId);
      if (s.status !== 'sold') throw new AppError('Only a sold unit has a customer warranty.');
      if (s.warranty_void_reason) throw new AppError('This warranty is already void.');
      if (openClaimOfSerial(db, s.id))
        throw new AppError('Close the open claim first (a claim can reject instead).');
      db.prepare(
        `UPDATE product_serials SET warranty_void_reason = ?, warranty_void_note = ?,
           warranty_voided_at = strftime('%Y-%m-%d %H:%M:%S','now','localtime') WHERE id = ?`,
      ).run(reason, why || null, s.id);
      serials.insertEvent(db, s.id, {
        type: 'warranty_voided',
        from_status: s.status,
        to_status: s.status,
        note: `${W.VOID_REASONS[reason]}${why ? `: ${why}` : ''}`,
      });
    } else if (Number.isInteger(saleItemId)) {
      const l = db.prepare('SELECT * FROM sale_items WHERE id = ?').get(saleItemId);
      if (!l) throw new AppError('Bill line not found.', 'NOT_FOUND');
      if (l.warranty_void_reason) throw new AppError('This warranty is already void.');
      if (openClaimsOfLine(db, l.id).length)
        throw new AppError('Close the open claim first (a claim can reject instead).');
      db.prepare(
        `UPDATE sale_items SET warranty_void_reason = ?, warranty_void_note = ?,
           warranty_voided_at = strftime('%Y-%m-%d %H:%M:%S','now','localtime') WHERE id = ?`,
      ).run(reason, why || null, l.id);
    } else throw new AppError('Choose a unit or bill line.', 'VALIDATION');
  })();
  return unit(db, { serial_id: serialId, sale_item_id: saleItemId });
}

// ---------------------------------------------------------------- lists

/**
 * Warranty lists. tab: 'active' (incl. expiring) | 'expiring' (≤ N days) | 'expired' (last 90
 * days). Filters: product_id, brand, category_id (incl. sub-categories), supplier_id, from / to
 * (sale date), technician (fitted by).
 */
function list(db, params = {}) {
  const ctx = ctxOf(db);
  const tab = ['active', 'expiring', 'expired'].includes(params.tab) ? params.tab : 'active';
  const range = {
    active: [ctx.today, '9999-12-31'],
    expiring: [ctx.today, W.addDays(ctx.today, ctx.days)],
    expired: [W.addDays(ctx.today, -90), W.addDays(ctx.today, -1)],
  }[tab];

  const f = [];
  const fa = [];
  if (Number.isInteger(params.product_id)) {
    f.push('p.id = ?');
    fa.push(params.product_id);
  }
  if (str(params.brand)) {
    f.push('p.brand = ? COLLATE NOCASE');
    fa.push(str(params.brand));
  }
  if (Number.isInteger(params.category_id)) {
    f.push(
      '(p.category_id = ? OR p.category_id IN (SELECT id FROM product_categories WHERE parent_id = ?))',
    );
    fa.push(params.category_id, params.category_id);
  }
  if (params.from && isISODate(params.from)) {
    f.push('sa.invoice_date >= ?');
    fa.push(params.from);
  }
  if (params.to && isISODate(params.to)) {
    f.push('sa.invoice_date <= ?');
    fa.push(params.to);
  }
  if (str(params.technician)) {
    f.push("si.fitted_by LIKE ? ESCAPE '\\'");
    fa.push(likeArg(str(params.technician)));
  }
  const extra = f.length ? ` AND ${f.join(' AND ')}` : '';
  const supplier = Number.isInteger(params.supplier_id) ? params.supplier_id : null;

  const serialRows = db
    .prepare(
      `SELECT s.id FROM product_serials s
       JOIN sale_item_serials x ON x.serial_id = s.id AND x.sale_item_id = s.sale_item_id AND x.status = 'sold'
       JOIN sale_items si ON si.id = x.sale_item_id
       JOIN sales sa ON sa.id = si.sale_id AND sa.status = 'active'
       JOIN products p ON p.id = s.product_id
       WHERE s.status IN ('sold','under_claim') AND s.warranty_void_reason IS NULL
         AND s.warranty_end BETWEEN ? AND ?${extra}
         ${supplier ? 'AND s.supplier_party_id = ?' : ''}
       ORDER BY s.warranty_end ${tab === 'expired' ? 'DESC' : 'ASC'} LIMIT ${LIST_LIMIT}`,
    )
    .all(...range, ...fa, ...(supplier ? [supplier] : []));
  const lineRows = db
    .prepare(
      `SELECT si.id FROM sale_items si
       JOIN sales sa ON sa.id = si.sale_id AND sa.status = 'active'
       JOIN products p ON p.id = si.product_id
       WHERE si.item_type = 'goods' AND si.warranty_void_reason IS NULL
         AND si.warranty_end BETWEEN ? AND ?
         AND NOT EXISTS (SELECT 1 FROM sale_item_serials x WHERE x.sale_item_id = si.id)
         AND si.qty_milli > (SELECT COALESCE(SUM(ri.qty_milli), 0) FROM sale_return_items ri
           JOIN sale_returns r ON r.id = ri.sale_return_id
           WHERE ri.sale_item_id = si.id AND r.status = 'active' AND r.is_deleted = 0)${extra}
         ${
           supplier
             ? `AND EXISTS (SELECT 1 FROM purchase_items pi JOIN purchases pu ON pu.id = pi.purchase_id
                 WHERE pi.variant_id = si.variant_id AND pu.party_id = ? AND pu.status = 'active')`
             : ''
         }
       ORDER BY si.warranty_end ${tab === 'expired' ? 'DESC' : 'ASC'} LIMIT ${LIST_LIMIT}`,
    )
    .all(...range, ...fa, ...(supplier ? [supplier] : []));

  const serialRow = db.prepare(`${SERIAL_SQL} WHERE s.id = ?`);
  const lineRow = db.prepare(`${LINE_SQL} WHERE si.id = ?`);
  const rows = [
    ...serialRows.map((r) => {
      const s = serialRow.get(r.id);
      return serialSummary(db, s, latestLink(db, s.id), ctx);
    }),
    ...lineRows.map((r) => lineSummary(db, lineRow.get(r.id), ctx)),
  ].sort((a, b) =>
    tab === 'expired'
      ? b.warranty_end.localeCompare(a.warranty_end)
      : a.warranty_end.localeCompare(b.warranty_end),
  );
  return {
    tab,
    rows,
    total: rows.length,
    truncated: serialRows.length === LIST_LIMIT || lineRows.length === LIST_LIMIT,
  };
}

// ---------------------------------------------------------------- alerts (dashboard + bell)

function alerts(db) {
  const ctx = ctxOf(db);
  const count = (sql, ...args) =>
    db
      .prepare(sql)
      .pluck()
      .get(...args);
  const openClaims = count(
    `SELECT COUNT(*) FROM warranty_claims WHERE is_deleted = 0 AND status NOT IN ${OPEN}`,
  );
  const ready = count(
    "SELECT COUNT(*) FROM warranty_claims WHERE is_deleted = 0 AND status IN ('ready','rejected')",
  );
  const overdueRows = db
    .prepare(
      `SELECT c.id, c.claim_no, c.customer_name, p.name AS product_name, d.expected_date,
         su.name AS supplier_name
       FROM claim_dispatches d JOIN warranty_claims c ON c.id = d.claim_id
       JOIN products p ON p.id = c.product_id JOIN parties su ON su.id = d.supplier_party_id
       WHERE d.status = 'at_supplier' AND d.expected_date IS NOT NULL AND d.expected_date < ?
         AND c.is_deleted = 0
       ORDER BY d.expected_date LIMIT 50`,
    )
    .all(ctx.today);
  const readyRows = db
    .prepare(
      `SELECT c.id, c.claim_no, c.customer_name, c.status, p.name AS product_name
       FROM warranty_claims c JOIN products p ON p.id = c.product_id
       WHERE c.is_deleted = 0 AND c.status IN ('ready','rejected') ORDER BY c.updated_at DESC LIMIT 10`,
    )
    .all();
  const monthEnd = W.monthEnd(ctx.today);
  const expiring =
    count(
      `SELECT COUNT(*) FROM product_serials s WHERE s.status IN ('sold','under_claim')
         AND s.warranty_void_reason IS NULL AND s.warranty_end BETWEEN ? AND ?`,
      ctx.today,
      monthEnd,
    ) +
    count(
      `SELECT COUNT(*) FROM sale_items si JOIN sales sa ON sa.id = si.sale_id AND sa.status = 'active'
       WHERE si.item_type = 'goods' AND si.warranty_void_reason IS NULL
         AND si.warranty_end BETWEEN ? AND ?
         AND NOT EXISTS (SELECT 1 FROM sale_item_serials x WHERE x.sale_item_id = si.id)`,
      ctx.today,
      monthEnd,
    );
  return {
    open_claims: openClaims,
    ready_for_pickup: ready,
    overdue_at_supplier: overdueRows.length,
    expiring_this_month: expiring,
    overdue: overdueRows.slice(0, 10),
    ready: readyRows,
    total: ready + overdueRows.length,
  };
}

// ---------------------------------------------------------------- customer tab

/** Units and lines sold to a customer, and their claims (Customer → Warranties tab). */
function forCustomer(db, partyId) {
  const ctx = ctxOf(db);
  const saleIds = db
    .prepare(
      `SELECT DISTINCT sa.id FROM sales sa JOIN sale_items si ON si.sale_id = sa.id
       WHERE sa.party_id = ? AND sa.is_deleted = 0 AND si.item_type = 'goods'
         AND (si.warranty_end IS NOT NULL OR EXISTS (SELECT 1 FROM sale_item_serials x WHERE x.sale_item_id = si.id))
       ORDER BY sa.invoice_date DESC, sa.id DESC LIMIT 300`,
    )
    .pluck()
    .all(partyId);
  const items = saleIds
    .flatMap((sid) => unitsOfSale(db, sid, ctx))
    .filter((u) => u.warranty_end || u.kind === 'serial');
  const claims = db
    .prepare(
      `SELECT c.id, c.claim_no, c.status, c.received_date, c.complaint, c.outcome,
         p.name AS product_name, s.serial_no
       FROM warranty_claims c JOIN products p ON p.id = c.product_id
       LEFT JOIN product_serials s ON s.id = c.serial_id
       WHERE c.customer_party_id = ? AND c.is_deleted = 0 ORDER BY c.id DESC`,
    )
    .all(partyId);
  return { items, claims };
}

module.exports = {
  EVENT_LABELS,
  CLAIM_EVENT_LABELS,
  MANUAL_VOID,
  expiringDays,
  search,
  unit,
  unitsOfSale,
  voidWarranty,
  list,
  alerts,
  forCustomer,
  openClaimOfSerial,
  openClaimsOfLine,
};
