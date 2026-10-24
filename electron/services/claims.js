'use strict';

// Warranty claims (WC-0001). A claim is for a sold serial unit, a quantity of a non-serial bill
// line (kind 'customer'), or our own defective stock sent to the supplier (kind 'stock').
//
//   received → inspecting → repairing | at_supplier | awaiting_replacement → ready
//            → returned → closed            (also: rejected → returned, cancelled)
//
// Every action is ONE transaction: claim row, serial status, stock movements, serial_events,
// claim_events and warranty money (warranty_costs; a supplier credit also reduces the supplier
// payable through v_party_ledger). Claims are never deleted: cancelled ones keep their number.
// No electron imports.

const { AppError } = require('../errors');
const { isISODate, todayISO, str } = require('./parse');
const settings = require('./settings');
const serials = require('./serials');
const sales = require('./sales');
const saleReturns = require('./saleReturns');
const billing = require('./billing');
const { variantStock, variantLabel } = require('./products');
const W = require('./warranty');
const units = require('./warrantyUnits');
const id = require('../validation/identity');

const STATUS_LABELS = {
  received: 'Received',
  inspecting: 'Under inspection',
  repairing: 'Repairing',
  at_supplier: 'Sent to supplier',
  awaiting_replacement: 'Awaiting replacement',
  ready: 'Ready for pickup',
  returned: 'Returned to customer',
  closed: 'Closed',
  rejected: 'Rejected',
  cancelled: 'Cancelled',
};
const OPEN_STATUSES = Object.keys(STATUS_LABELS).filter(
  (s) => !['closed', 'cancelled'].includes(s),
);
const DECISIONS = {
  repair: 'Repair in shop',
  supplier: 'Send to supplier',
  replace: 'Replace from my stock',
  refund: 'Refund / credit note',
  reject: 'Reject',
};
const OUTCOMES = {
  repaired: 'Repaired in shop',
  replaced: 'Replaced from stock',
  refunded: 'Refunded',
  rejected: 'Rejected',
  returned_as_is: 'Returned as is',
  supplier_repaired: 'Repaired by supplier',
  supplier_replaced: 'Replaced by supplier',
  supplier_credit: 'Supplier credit note',
  absorbed: 'Loss absorbed',
};
const REJECT_REASONS = {
  physical_damage: 'Physical damage',
  water_damage: 'Water damage',
  tampered: 'Tampered / seal broken',
  wrong_fitting: 'Wrong fitting by customer',
  other: 'Other',
};
const DISPATCH_MODES = { hand: 'Hand delivery', courier: 'Courier' };
const ACCESSORIES = ['Box', 'Remote', 'Wires / cables', 'Manual', 'Bill copy', 'Mounting kit'];

// Common complaints, by words in the category name (the Settings JSON can add more).
const ISSUE_PRESETS = [
  [
    /music|speaker|audio|amplifier|woofer|stereo/i,
    [
      'No sound',
      'Distorted sound',
      'Not powering on',
      'Bluetooth not pairing',
      'Display not working',
      'Remote not working',
    ],
  ],
  [
    /light|led|lamp|bulb/i,
    ['Not glowing', 'Flickering', 'One side not working', 'Water inside', 'Dim light'],
  ],
  [
    /camera|sensor|parking/i,
    ['No picture', 'Blurry picture', 'Beeping all the time', 'Not detecting', 'Wiring fault'],
  ],
  [/charger|mobile|holder/i, ['Not charging', 'Slow charging', 'Loose fit', 'Holder broken']],
  [
    /seat|mat|steering|cover|interior/i,
    ['Torn', 'Stitching open', 'Fading', 'Shrunk', 'Loose fit'],
  ],
  [/perfume|fragrance/i, ['Leaking', 'No fragrance']],
  [/horn/i, ['No sound', 'Low sound', 'Works on and off']],
  [/wiper/i, ['Streaking', 'Noisy', 'Rubber worn']],
];
const GENERAL_ISSUES = ['Not working', 'Works on and off', 'Physical damage', 'Noise'];

const MAX_TEXT = 500;
const MAX_PARTS = 20;

// ---------------------------------------------------------------- helpers

function fail(errors) {
  const keys = Object.keys(errors);
  if (keys.length) throw new AppError(`Please check: ${errors[keys[0]]}`, 'VALIDATION', errors);
}

const money = sales.money;

/** Local 'YYYY-MM-DD HH:MM:SS' (like the DB's own timestamps). */
function localNow(d = new Date()) {
  const p2 = (n) => String(n).padStart(2, '0');
  return `${todayISO(d)} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
}

function dateOf(value, errors, key = 'date', { allowFuture = false } = {}) {
  const d = value || todayISO();
  if (!isISODate(d)) errors[key] = 'Invalid date.';
  else if (!allowFuture && d > todayISO()) errors[key] = 'The date is in the future.';
  return d;
}

function text(value, max, errors, key, label) {
  const s = str(value);
  if (s.length > max) errors[key] = `${label} is too long (max ${max}).`;
  return s;
}

function stringList(value, maxItems, maxLen) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((v) => str(v).slice(0, maxLen)).filter(Boolean))].slice(0, maxItems);
}

function claimRow(db, claimId) {
  const c = db
    .prepare('SELECT * FROM warranty_claims WHERE id = ? AND is_deleted = 0')
    .get(claimId);
  if (!c) throw new AppError('Claim not found.', 'NOT_FOUND');
  return c;
}

function assertStatus(c, allowed, action) {
  if (!allowed.includes(c.status)) {
    throw new AppError(
      `${c.claim_no} is "${STATUS_LABELS[c.status]}": it cannot ${action} now.`,
      'STATUS',
    );
  }
}

function event(db, c, { type, to = null, note = null, date = todayISO() }, ctx = {}) {
  db.prepare(
    `INSERT INTO claim_events (claim_id, date, type, from_status, to_status, note, actor)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(c.id, date, type, c.status, to || c.status, note, ctx.actor || 'This computer');
}

function update(db, claimId, fields) {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  db.prepare(
    `UPDATE warranty_claims SET ${keys.map((k) => `${k} = @${k}`).join(', ')} WHERE id = @id`,
  ).run({ ...fields, id: claimId });
}

/** Moves a claim to `to`, logging the change. Returns the updated row. */
function move(db, c, to, fields, ev, ctx) {
  event(db, c, { ...ev, to }, ctx);
  update(db, c.id, { ...fields, status: to });
  return claimRow(db, c.id);
}

function supplierRow(db, partyId) {
  const p = Number.isInteger(partyId)
    ? db.prepare('SELECT * FROM parties WHERE id = ? AND is_deleted = 0').get(partyId)
    : null;
  if (!p || p.type !== 'supplier')
    throw new AppError('Choose the supplier.', 'VALIDATION', { supplier_party_id: 'Required.' });
  return p;
}

function variantInfo(db, variantId) {
  const v = sales.loadVariantInfo(db, variantId);
  if (!v || v.is_deleted || v.product_deleted)
    throw new AppError('Product not found.', 'NOT_FOUND');
  return v;
}

function avgCost(v) {
  return v.avg_cost || v.purchase_price || 0;
}

function costOf(qtyMilli, unitCost) {
  return billing.divRound(qtyMilli * unitCost, 1000);
}

/** Sellable stock check for things taken out of stock by a claim (parts, replacements). */
function assertStock(db, v, qtyMilli) {
  const have = variantStock(db, v.id);
  const allowNegative = settings.getSettings(db).allow_negative_stock === '1';
  if (have < qtyMilli && (v.track_serials || !allowNegative)) {
    throw new AppError(
      `Only ${Math.max(have, 0) / 1000} ${v.unit} of "${v.product_name}" in stock.`,
      'VALIDATION',
    );
  }
}

function openDispatch(db, claimId) {
  return (
    db
      .prepare(
        "SELECT * FROM claim_dispatches WHERE claim_id = ? AND status = 'at_supplier' ORDER BY id DESC LIMIT 1",
      )
      .get(claimId) || null
  );
}

function issuePresets(db, categoryId) {
  const cat = categoryId
    ? db
        .prepare(
          `SELECT c.id, c.name, pc.id AS parent_id, pc.name AS parent_name FROM product_categories c
           LEFT JOIN product_categories pc ON pc.id = c.parent_id WHERE c.id = ?`,
        )
        .get(categoryId)
    : null;
  const names = cat ? [cat.name, cat.parent_name].filter(Boolean).join(' ') : '';
  const builtIn = ISSUE_PRESETS.filter(([re]) => re.test(names)).flatMap(([, list]) => list);
  let custom = {};
  try {
    custom = JSON.parse(settings.getSettings(db).claim_issue_presets || '{}') || {};
  } catch {
    custom = {};
  }
  const own = [
    ...(cat ? custom[String(cat.id)] || [] : []),
    ...(cat && cat.parent_id ? custom[String(cat.parent_id)] || [] : []),
    ...(custom['*'] || []),
  ];
  return [...new Set([...builtIn, ...own, ...GENERAL_ISSUES])].slice(0, 20);
}

function replacementDefault(db) {
  return settings.getSettings(db).replacement_warranty === 'fresh' ? 'fresh' : 'remaining';
}

// ---------------------------------------------------------------- open a claim

/** What the "New claim" form needs: the unit card, defaults, presets and warnings. */
function prepare(db, ref) {
  const u = units.unit(db, ref);
  if (!u.can.claim) {
    if (u.open_claim)
      throw new AppError(
        `Claim ${u.open_claim.claim_no} is already open for this item.`,
        'CLAIM_OPEN',
      );
    throw new AppError('This item is not with a customer, so no claim can be opened for it.');
  }
  const today = todayISO();
  const inWarranty = ['active', 'expiring'].includes(u.status.date_status) && !u.status.void_reason;
  const categoryId = db
    .prepare('SELECT category_id FROM products WHERE id = ?')
    .pluck()
    .get(u.product_id);
  const warnings = [];
  if (!inWarranty) {
    warnings.push(
      u.status.void_reason
        ? `The warranty is void (${u.status.void_label}). The claim will be a chargeable repair.`
        : u.warranty_end
          ? `The warranty expired on ${u.warranty_end}. The claim will be a chargeable repair.`
          : 'This item has no warranty. The claim will be a chargeable repair.',
    );
  }
  if (u.owner_note) warnings.push(u.owner_note.text);
  return {
    unit: u,
    in_warranty: inWarranty,
    defaults: {
      received_date: today,
      expected_date: W.addDays(today, 7),
      qty_milli: u.kind === 'line' ? Math.min(u.claimable_milli, 1000) || u.claimable_milli : 1000,
      supplier_party_id: u.supplier_warranty ? u.supplier_warranty.supplier_party_id : null,
    },
    presets: issuePresets(db, categoryId),
    accessories: ACCESSORIES,
    replacement_warranty: replacementDefault(db),
    warnings,
  };
}

function validateOpen(db, p) {
  const errors = {};
  const date = dateOf(p.received_date, errors, 'received_date');
  const tags = stringList(p.complaint_tags, 10, 60);
  const complaintText = text(p.complaint, MAX_TEXT, errors, 'complaint', 'Complaint');
  const complaint = complaintText || tags.join(', ');
  if (!complaint) errors.complaint = 'Describe the complaint (or pick a common issue).';
  const expected = p.expected_date || null;
  if (expected && !isISODate(expected)) errors.expected_date = 'Invalid date.';
  else if (expected && isISODate(date) && expected < date)
    errors.expected_date = 'Before the received date.';
  const broughtPhone = str(p.brought_by_phone) ? id.normalizePhone(p.brought_by_phone) : '';
  return {
    errors,
    data: {
      received_date: date,
      received_by: text(p.received_by, 60, errors, 'received_by', 'Received by') || null,
      complaint,
      complaint_tags: tags.length ? JSON.stringify(tags) : null,
      condition_notes:
        text(p.condition_notes, MAX_TEXT, errors, 'condition_notes', 'Condition') || null,
      accessories: (() => {
        const list = stringList(p.accessories, 15, 60);
        return list.length ? JSON.stringify(list) : null;
      })(),
      expected_date: expected,
      brought_by_name: text(p.brought_by_name, 100, errors, 'brought_by_name', 'Name') || null,
      brought_by_phone: broughtPhone || null,
      notes: text(p.notes, MAX_TEXT, errors, 'notes', 'Notes') || null,
      attachments: (Array.isArray(p.attachments) ? p.attachments : []).slice(0, 10).map((a) => ({
        temp_path: a.temp_path,
        original_name: str(a.original_name).slice(0, 120) || 'photo',
        size_bytes: Number.isSafeInteger(a.size_bytes) ? a.size_bytes : 0,
      })),
    },
  };
}

function insertClaim(db, row) {
  const num = settings.takeNextNumber(db, 'warranty_claim');
  const claimId = Number(
    db
      .prepare(
        `INSERT INTO warranty_claims (claim_no, seq_no, kind, serial_id, sale_id, sale_item_id,
           product_id, variant_id, qty_milli, customer_party_id, customer_name, customer_phone,
           vehicle_id, vehicle_no, vehicle_model, brought_by_name, brought_by_phone, ownership_note,
           supplier_party_id, in_warranty, chargeable, warranty_end, received_date, received_by,
           complaint, complaint_tags, condition_notes, accessories, expected_date, status, notes)
         VALUES (@claim_no, @seq_no, @kind, @serial_id, @sale_id, @sale_item_id, @product_id,
           @variant_id, @qty_milli, @customer_party_id, @customer_name, @customer_phone,
           @vehicle_id, @vehicle_no, @vehicle_model, @brought_by_name, @brought_by_phone,
           @ownership_note, @supplier_party_id, @in_warranty, @chargeable, @warranty_end,
           @received_date, @received_by, @complaint, @complaint_tags, @condition_notes,
           @accessories, @expected_date, 'received', @notes)`,
      )
      .run({ ...row, claim_no: num.number, seq_no: num.seq_no }).lastInsertRowid,
  );
  return claimRow(db, claimId);
}

function attach(db, c, list, ctx) {
  if (!list.length) return [];
  if (!ctx.files) throw new Error('Attachments need a file handler');
  const moves = ctx.files.commit(
    list.map((a) => a.temp_path),
    c.claim_no,
    'claims',
  );
  const ins = db.prepare(
    'INSERT INTO claim_attachments (claim_id, file_path, original_name, size_bytes) VALUES (?, ?, ?, ?)',
  );
  list.forEach((a, i) => ins.run(c.id, moves[i].to, a.original_name, a.size_bytes));
  return moves;
}

/**
 * Opens a customer claim. payload: { serial_id | sale_item_id + qty_milli, received_date,
 * received_by, complaint, complaint_tags[], condition_notes, accessories[], expected_date,
 * brought_by_name / phone, supplier_party_id, chargeable, notes, attachments[] (staged) }.
 * Out of warranty (expired / void / none) needs chargeable = true (AppError OUT_OF_WARRANTY).
 */
function create(db, payload, ctx = {}) {
  const p = payload || {};
  const { errors, data } = validateOpen(db, p);
  fail(errors);
  let moves = [];
  try {
    const claimId = db.transaction(() => {
      const ref = Number.isInteger(p.serial_id)
        ? { serial_id: p.serial_id }
        : { sale_item_id: p.sale_item_id };
      const u = units.unit(db, ref);
      if (u.open_claim && u.kind === 'serial') {
        throw new AppError(
          `Claim ${u.open_claim.claim_no} is already open for this unit.`,
          'CLAIM_OPEN',
        );
      }
      if (!u.can.claim)
        throw new AppError('This item is not with a customer, so no claim can be opened for it.');
      let qty = 1000;
      if (u.kind === 'line') {
        qty = p.qty_milli;
        if (!Number.isSafeInteger(qty) || qty <= 0) fail({ qty_milli: 'Enter the quantity.' });
        if (qty > u.claimable_milli) {
          fail({
            qty_milli: `Only ${u.claimable_milli / 1000} ${u.unit} can be claimed on this line.`,
          });
        }
      }
      const inWarranty =
        ['active', 'expiring'].includes(
          W.warrantyStatus(u.warranty_end, data.received_date).status,
        ) && !u.status.void_reason;
      if (!inWarranty && p.chargeable !== true) {
        throw new AppError(
          'This item is out of warranty. Open it as a chargeable repair?',
          'OUT_OF_WARRANTY',
        );
      }
      const supplierId = Number.isInteger(p.supplier_party_id)
        ? supplierRow(db, p.supplier_party_id).id
        : u.supplier_warranty?.supplier_party_id || null;
      const sale = u.sale;
      const notes = [u.owner_note?.text];
      if (data.brought_by_name && sale && data.brought_by_name !== sale.customer_name) {
        notes.push(
          `Brought in by ${data.brought_by_name}${data.brought_by_phone ? ` (${id.formatPhone(data.brought_by_phone)})` : ''}.`,
        );
      }
      const c = insertClaim(db, {
        kind: 'customer',
        serial_id: u.serial_id,
        sale_id: sale ? sale.id : null,
        sale_item_id: u.sale_item_id,
        product_id: u.product_id,
        variant_id: u.variant_id,
        qty_milli: qty,
        customer_party_id: u.customer_party_id || null,
        customer_name: sale ? sale.customer_name : null,
        customer_phone: sale ? sale.customer_phone : null,
        vehicle_id: sale ? sale.vehicle_id : null,
        vehicle_no: sale ? sale.vehicle_no : null,
        vehicle_model: sale ? sale.vehicle_model : null,
        brought_by_name: data.brought_by_name,
        brought_by_phone: data.brought_by_phone,
        ownership_note: notes.filter(Boolean).join(' ') || null,
        supplier_party_id: supplierId,
        in_warranty: inWarranty ? 1 : 0,
        chargeable: p.chargeable === true || !inWarranty ? 1 : 0,
        warranty_end: u.warranty_end,
        received_date: data.received_date,
        received_by: data.received_by,
        complaint: data.complaint,
        complaint_tags: data.complaint_tags,
        condition_notes: data.condition_notes,
        accessories: data.accessories,
        expected_date: data.expected_date,
        notes: data.notes,
      });
      event(
        db,
        c,
        {
          type: 'received',
          date: data.received_date,
          note: `${data.complaint}${c.chargeable ? ' · chargeable repair' : ''}${u.kind === 'line' ? ` · qty ${qty / 1000}` : ''}`,
        },
        ctx,
      );
      if (c.serial_id) {
        serials.insertEvent(db, c.serial_id, {
          date: data.received_date,
          type: 'claim_received',
          from_status: 'sold',
          to_status: 'sold',
          ref_type: 'warranty_claim',
          ref_id: c.id,
          note: `${c.claim_no}: ${data.complaint}`,
        });
      }
      moves = attach(db, c, data.attachments, ctx);
      return c.id;
    })();
    return get(db, claimId);
  } catch (err) {
    if (moves.length && ctx.files) ctx.files.undo(moves);
    throw err;
  }
}

// ---------------------------------------------------------------- inspection & decision

function inspect(db, { id: claimId, notes, date }, ctx = {}) {
  const errors = {};
  const d = dateOf(date, errors);
  const n = text(notes, MAX_TEXT, errors, 'notes', 'Notes');
  fail(errors);
  db.transaction(() => {
    const c = claimRow(db, claimId);
    assertStatus(c, ['received', 'inspecting'], 'go under inspection');
    if (c.kind !== 'customer') throw new AppError('Only customer claims are inspected.');
    move(
      db,
      c,
      'inspecting',
      { inspection_notes: n || c.inspection_notes, inspected_date: d },
      { type: 'inspected', note: n || null, date: d },
      ctx,
    );
  })();
  return get(db, claimId);
}

/**
 * The inspection decision. payload: { id, decision, date, inspection_notes, ...branch }
 *   repair   → Repairing
 *   supplier → dispatch: { supplier_party_id, mode, courier, docket_no, expected_date }
 *   replace  → { replacement_serial_id | (non-serial: from stock), mode, reason } or pending
 *   refund   → { settlement: 'refund' | 'adjust', refund_mode } (credit note, then Closed)
 *   reject   → { reject_reason, reject_notes } (unit goes back to the customer)
 */
function decide(db, payload, ctx = {}) {
  const p = payload || {};
  if (!DECISIONS[p.decision]) fail({ decision: 'Choose what to do.' });
  const errors = {};
  const date = dateOf(p.date, errors);
  const notes = text(p.inspection_notes, MAX_TEXT, errors, 'inspection_notes', 'Notes');
  fail(errors);
  db.transaction(() => {
    let c = claimRow(db, p.id);
    if (c.kind !== 'customer') throw new AppError('This claim only waits for the supplier.');
    assertStatus(c, ['received', 'inspecting'], 'take a decision');
    if (c.chargeable && ['replace', 'refund'].includes(p.decision)) {
      throw new AppError(
        'A chargeable (out of warranty) claim can be repaired, sent to the supplier or rejected.',
      );
    }
    if (notes || !c.inspected_date) {
      update(db, c.id, {
        inspection_notes: notes || c.inspection_notes,
        inspected_date: c.inspected_date || date,
      });
    }
    update(db, c.id, { decision: p.decision });
    c = claimRow(db, c.id);
    const label = DECISIONS[p.decision];
    if (p.decision === 'repair') {
      move(db, c, 'repairing', {}, { type: 'decided', note: label, date }, ctx);
    } else if (p.decision === 'supplier') {
      event(db, c, { type: 'decided', note: label, date }, ctx);
      dispatchInner(db, c, { ...p.dispatch, dispatch_date: date }, ctx);
    } else if (p.decision === 'replace') {
      if (p.pending) {
        move(
          db,
          c,
          'awaiting_replacement',
          {},
          { type: 'decided', note: `${label}: waiting for stock`, date },
          ctx,
        );
      } else {
        event(db, c, { type: 'decided', note: label, date }, ctx);
        replaceInner(db, c, { ...p, date }, ctx);
      }
    } else if (p.decision === 'refund') {
      event(db, c, { type: 'decided', note: label, date }, ctx);
      refundInner(db, c, { ...p, date }, ctx);
    } else {
      rejectInner(db, c, { reason: p.reject_reason, notes: p.reject_notes, date }, ctx);
    }
  })();
  return get(db, p.id);
}

function rejectInner(db, c, { reason, notes, date }, ctx) {
  const errors = {};
  if (!REJECT_REASONS[reason]) errors.reject_reason = 'Choose the reason.';
  const n = text(notes, MAX_TEXT, errors, 'reject_notes', 'Notes');
  if (reason === 'other' && !n) errors.reject_notes = 'Describe the reason.';
  fail(errors);
  move(
    db,
    c,
    'rejected',
    { reject_reason: reason, reject_notes: n || null, outcome: 'rejected', decision: 'reject' },
    { type: 'rejected', note: `${REJECT_REASONS[reason]}${n ? `: ${n}` : ''}`, date },
    ctx,
  );
  if (c.serial_id) {
    serials.insertEvent(db, c.serial_id, {
      date,
      type: 'claim_rejected',
      from_status: 'sold',
      to_status: 'sold',
      ref_type: 'warranty_claim',
      ref_id: c.id,
      note: `${c.claim_no}: ${REJECT_REASONS[reason]}${n ? ` (${n})` : ''}`,
    });
  }
}

// ---------------------------------------------------------------- repair in shop

/**
 * Repair done. payload: { id, date, repair_notes, parts: [{ variant_id, qty_milli }],
 * labour_amount }. In warranty: parts leave stock (warranty_parts_used, at average cost) and
 * parts + labour are warranty loss. Chargeable: parts and labour are only noted for the bill.
 */
function repairDone(db, payload, ctx = {}) {
  const p = payload || {};
  const errors = {};
  const date = dateOf(p.date, errors);
  const notes = text(p.repair_notes, MAX_TEXT, errors, 'repair_notes', 'Repair notes');
  const labour = p.labour_amount == null ? 0 : p.labour_amount;
  if (!Number.isSafeInteger(labour) || labour < 0) errors.labour_amount = 'Invalid amount.';
  const parts = Array.isArray(p.parts) ? p.parts : [];
  if (parts.length > MAX_PARTS) errors.parts = `At most ${MAX_PARTS} parts.`;
  parts.forEach((x, i) => {
    if (!Number.isInteger(x.variant_id)) errors[`parts.${i}.variant_id`] = 'Choose the part.';
    if (!Number.isSafeInteger(x.qty_milli) || x.qty_milli <= 0)
      errors[`parts.${i}.qty_milli`] = 'Enter the quantity.';
  });
  fail(errors);
  db.transaction(() => {
    const c = claimRow(db, p.id);
    assertStatus(c, ['repairing'], 'be marked repaired');
    const chargeable = Boolean(c.chargeable);
    const ins = db.prepare(
      `INSERT INTO claim_parts (claim_id, product_id, variant_id, product_name, variant_label, unit,
         qty_milli, unit_cost, chargeable, movement_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    let partsCost = 0;
    parts.forEach((x, i) => {
      const v = variantInfo(db, x.variant_id);
      if (v.product_type !== 'stock') fail({ [`parts.${i}.variant_id`]: 'Choose a stock item.' });
      if (v.track_serials) {
        fail({ [`parts.${i}.variant_id`]: 'Parts with serial numbers are not supported here.' });
      }
      const unitCost = avgCost(v);
      let movementId = null;
      if (!chargeable) {
        assertStock(db, v, x.qty_milli);
        movementId = serials.insertMovement(db, {
          variant_id: v.id,
          date,
          type: 'warranty_parts_used',
          qty_milli: -x.qty_milli,
          unit_cost: unitCost,
          ref_type: 'warranty_claim',
          ref_id: c.id,
          reason: `${c.claim_no}: repair part`,
        });
        partsCost += costOf(x.qty_milli, unitCost);
      }
      ins.run(
        c.id,
        v.product_id,
        v.id,
        v.product_name,
        variantLabel(v) || null,
        v.unit,
        x.qty_milli,
        unitCost,
        chargeable ? 1 : 0,
        movementId,
      );
    });
    if (!chargeable && partsCost > 0) {
      serials.insertCost(db, {
        claim_id: c.id,
        date,
        kind: 'parts',
        direction: 'cost',
        amount: partsCost,
        note: `${parts.length} part(s)`,
      });
    }
    if (!chargeable && labour > 0) {
      serials.insertCost(db, {
        claim_id: c.id,
        date,
        kind: 'labour',
        direction: 'cost',
        amount: labour,
      });
    }
    move(
      db,
      c,
      'ready',
      { repair_notes: notes || null, labour_amount: labour, outcome: 'repaired' },
      {
        type: 'repaired',
        date,
        note:
          [
            notes,
            parts.length ? `${parts.length} part(s)` : null,
            labour ? `labour ${money(labour)}` : null,
            chargeable ? 'chargeable: create the bill' : null,
          ]
            .filter(Boolean)
            .join(' · ') || null,
      },
      ctx,
    );
    if (c.serial_id) {
      serials.insertEvent(db, c.serial_id, {
        date,
        type: 'claim_repaired',
        ref_type: 'warranty_claim',
        ref_id: c.id,
        note: `${c.claim_no}${notes ? `: ${notes}` : ''}`,
      });
    }
  })();
  return get(db, p.id);
}

// ---------------------------------------------------------------- supplier

/**
 * Sends the unit to the supplier (inside a transaction). Customer units leave no stock trace
 * (they were sold): the serial becomes under_claim. Our own defective stock leaves the
 * defective location (supplier_claim_out) at its average cost (kept as sent_value).
 */
function dispatchInner(db, c, d, ctx) {
  const errors = {};
  const date = dateOf(d.dispatch_date, errors, 'dispatch.dispatch_date');
  const mode = d.mode === 'courier' ? 'courier' : 'hand';
  const courier = text(d.courier, 60, errors, 'dispatch.courier', 'Courier');
  const docket = text(d.docket_no, 60, errors, 'dispatch.docket_no', 'Docket no.');
  if (mode === 'courier' && !docket) errors['dispatch.docket_no'] = 'Enter the docket number.';
  const expected = d.expected_date || null;
  if (expected && !isISODate(expected)) errors['dispatch.expected_date'] = 'Invalid date.';
  else if (expected && expected < date)
    errors['dispatch.expected_date'] = 'Before the dispatch date.';
  const notes = text(d.notes, MAX_TEXT, errors, 'dispatch.notes', 'Notes');
  fail(errors);
  const supplier = supplierRow(
    db,
    Number.isInteger(d.supplier_party_id) ? d.supplier_party_id : c.supplier_party_id,
  );
  if (openDispatch(db, c.id)) throw new AppError('This unit is already at the supplier.');

  let sentValue = 0;
  if (c.serial_id) {
    const s = serials.loadSerial(db, c.serial_id);
    const from = c.kind === 'stock' ? 'defective' : 'sold';
    if (s.status !== from) {
      throw new AppError(
        `Serial ${s.serial_no} is ${serials.STATUS_LABELS[s.status].toLowerCase()}, it cannot be sent.`,
      );
    }
    if (c.kind === 'stock') {
      const unitCost = serials.defectiveUnitCost(db, s.variant_id);
      serials.insertMovement(db, {
        variant_id: s.variant_id,
        date,
        type: 'supplier_claim_out',
        location: 'defective',
        qty_milli: -1000,
        unit_cost: unitCost,
        ref_type: 'warranty_claim',
        ref_id: c.id,
        reason: `${c.claim_no}: sent to ${supplier.name}`,
      });
      sentValue = unitCost;
    }
    db.prepare("UPDATE product_serials SET status = 'under_claim' WHERE id = ?").run(s.id);
    serials.insertEvent(db, s.id, {
      date,
      type: 'claim_sent',
      from_status: from,
      to_status: 'under_claim',
      ref_type: 'warranty_claim',
      ref_id: c.id,
      note: `${c.claim_no} → ${supplier.name}${docket ? ` · docket ${docket}` : ''}`,
    });
  } else if (c.kind === 'stock') {
    const have = serials.defectiveStock(db, c.variant_id).qty_milli;
    if (have < c.qty_milli) throw new AppError(`Only ${have / 1000} defective in stock.`);
    const unitCost = serials.defectiveUnitCost(db, c.variant_id);
    serials.insertMovement(db, {
      variant_id: c.variant_id,
      date,
      type: 'supplier_claim_out',
      location: 'defective',
      qty_milli: -c.qty_milli,
      unit_cost: unitCost,
      ref_type: 'warranty_claim',
      ref_id: c.id,
      reason: `${c.claim_no}: sent to ${supplier.name}`,
    });
    sentValue = costOf(c.qty_milli, unitCost);
  }
  db.prepare(
    `INSERT INTO claim_dispatches (claim_id, supplier_party_id, dispatch_date, mode, courier,
       docket_no, expected_date, qty_milli, sent_value, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    c.id,
    supplier.id,
    date,
    mode,
    courier || null,
    docket || null,
    expected,
    c.qty_milli,
    sentValue,
    notes || null,
  );
  move(
    db,
    c,
    'at_supplier',
    { supplier_party_id: supplier.id, decision: c.kind === 'customer' ? 'supplier' : c.decision },
    {
      type: 'dispatched',
      date,
      note: `${supplier.name} · ${DISPATCH_MODES[mode]}${courier ? ` ${courier}` : ''}${docket ? ` #${docket}` : ''}${expected ? ` · expected ${expected}` : ''}`,
    },
    ctx,
  );
}

/** Sends a claim (back) to the supplier: from Received / Under inspection or Repairing. */
function dispatch(db, payload, ctx = {}) {
  const p = payload || {};
  db.transaction(() => {
    const c = claimRow(db, p.id);
    assertStatus(c, ['received', 'inspecting', 'repairing'], 'be sent to the supplier');
    dispatchInner(db, c, p, ctx);
  })();
  return get(db, p.id);
}

/** Creates a new serial for a unit the supplier sent back as a replacement. */
function newSupplierSerial(db, c, input, { status, sale, date, supplierId }) {
  const entry = {
    serial_no: str(input && input.serial_no),
    serial_no_2: str(input && input.serial_no_2),
  };
  if (!entry.serial_no)
    fail({ 'new_serial.serial_no': 'Enter the serial number of the new unit.' });
  const check = serials.checkSerials(db, { product_id: c.product_id, entries: [entry] })[0];
  if (check.error) fail({ 'new_serial.serial_no': `${entry.serial_no}: ${check.error}` });
  const product = db
    .prepare('SELECT supplier_warranty_months FROM products WHERE id = ?')
    .get(c.product_id);
  const old = serials.loadSerial(db, c.serial_id);
  const newId = Number(
    db
      .prepare(
        `INSERT INTO product_serials (product_id, variant_id, serial_no, serial_key, serial_no_2,
           serial_key_2, status, source_type, purchase_date, supplier_party_id, supplier_warranty_end,
           sale_id, sale_item_id, sale_date, customer_party_id, warranty_start, warranty_end,
           replaces_serial_id, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'replacement', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        old.product_id,
        old.variant_id,
        entry.serial_no,
        serials.serialKey(entry.serial_no),
        entry.serial_no_2 || null,
        entry.serial_no_2 ? serials.serialKey(entry.serial_no_2) : null,
        status,
        date,
        supplierId,
        W.warrantyEnd(date, product.supplier_warranty_months),
        sale ? sale.sale_id : null,
        sale ? sale.sale_item_id : null,
        sale ? sale.sale_date : null,
        sale ? sale.customer_party_id : null,
        sale ? sale.warranty_start : null,
        sale ? sale.warranty_end : null,
        old.id,
        `Replacement from supplier for ${old.serial_no} (${c.claim_no})`,
      ).lastInsertRowid,
  );
  serials.insertEvent(db, newId, {
    date,
    type: 'supplier_replacement_received',
    to_status: status,
    ref_type: 'warranty_claim',
    ref_id: c.id,
    note: `${c.claim_no}: replaces ${old.serial_no}`,
  });
  return newId;
}

function markReplaced(db, c, oldSerialId, newSerialId, date, note) {
  const old = serials.loadSerial(db, oldSerialId);
  db.prepare(
    "UPDATE product_serials SET status = 'replaced', replaced_by_serial_id = ? WHERE id = ?",
  ).run(newSerialId, old.id);
  serials.insertEvent(db, old.id, {
    date,
    type: 'claim_replaced',
    from_status: old.status,
    to_status: 'replaced',
    ref_type: 'warranty_claim',
    ref_id: c.id,
    note,
  });
}

/** Links a replacement unit to the original bill line (with its warranty) and marks it sold. */
function giveToCustomer(db, c, newSerialId, warranty, date) {
  const old = serials.loadSerial(db, c.serial_id);
  db.prepare(
    `UPDATE product_serials SET status = 'sold', sale_id = ?, sale_item_id = ?, sale_date = ?,
       customer_party_id = ?, warranty_start = ?, warranty_end = ?, warranty_overridden = 0,
       replaces_serial_id = ? WHERE id = ?`,
  ).run(
    c.sale_id,
    c.sale_item_id,
    old.sale_date || date,
    c.customer_party_id,
    warranty.start,
    warranty.end,
    old.id,
    newSerialId,
  );
  db.prepare(
    `INSERT INTO sale_item_serials (sale_item_id, serial_id, warranty_start, warranty_end,
       is_replacement, claim_id) VALUES (?, ?, ?, ?, 1, ?)`,
  ).run(c.sale_item_id, newSerialId, warranty.start, warranty.end, c.id);
  serials.insertEvent(db, newSerialId, {
    date,
    type: 'replacement_issued',
    to_status: 'sold',
    ref_type: 'warranty_claim',
    ref_id: c.id,
    note: `${c.claim_no}: replaces ${old.serial_no}${warranty.end ? ` · warranty till ${warranty.end}` : ''}`,
  });
}

function replacementMode(db, p) {
  const def = replacementDefault(db);
  const mode = p.mode === 'fresh' || p.mode === 'remaining' ? p.mode : def;
  const reason = str(p.reason);
  if (mode !== def && !reason) {
    fail({
      reason: `Say why this replacement gets a ${mode === 'fresh' ? 'fresh' : 'remaining'} warranty.`,
    });
  }
  if (reason.length > 200) fail({ reason: 'Too long (max 200).' });
  return { mode, reason: reason || null };
}

function lineMonths(db, c) {
  const m = c.sale_item_id
    ? db.prepare('SELECT warranty_months FROM sale_items WHERE id = ?').pluck().get(c.sale_item_id)
    : 0;
  return (
    m ||
    db
      .prepare('SELECT customer_warranty_months FROM products WHERE id = ?')
      .pluck()
      .get(c.product_id) ||
    0
  );
}

/**
 * The supplier's answer for the unit at the supplier. payload: { id, result, date, notes,
 *   new_serial: { serial_no, serial_no_2 }, new_to: 'customer' | 'stock',  (replaced)
 *   credit_amount, credit_ref,                                            (credit)
 *   rejected_action: 'return_as_is' | 'chargeable' | 'absorb',            (rejected)
 *   mode, reason }                                       (warranty of a replacement to the customer)
 */
function supplierResult(db, payload, ctx = {}) {
  const p = payload || {};
  const errors = {};
  const date = dateOf(p.date, errors);
  const notes = text(p.notes, MAX_TEXT, errors, 'notes', 'Notes');
  if (!['repaired', 'replaced', 'credit', 'rejected'].includes(p.result))
    errors.result = 'Choose the result.';
  fail(errors);
  db.transaction(() => {
    const c = claimRow(db, p.id);
    assertStatus(c, ['at_supplier'], 'take the supplier result');
    const d = openDispatch(db, c.id);
    if (!d) throw new AppError('No unit of this claim is at the supplier.');
    if (date < d.dispatch_date) fail({ date: 'Before the dispatch date.' });
    const supplier = db.prepare('SELECT * FROM parties WHERE id = ?').get(d.supplier_party_id);
    const stockClaim = c.kind === 'stock';
    const v = variantInfo(db, c.variant_id);
    const s = c.serial_id ? serials.loadSerial(db, c.serial_id) : null;
    const disp = {
      result: p.result,
      result_date: date,
      result_notes: notes || null,
      status: 'back',
    };
    let next;
    let outcome = null;
    const claimFields = {};
    const resultNote = [];

    // What our own defective stock was worth when it went: no longer ours unless it comes back.
    const writeOffSent = () => {
      if (stockClaim && d.sent_value > 0) {
        serials.insertCost(db, {
          claim_id: c.id,
          date,
          kind: 'write_off',
          direction: 'cost',
          amount: d.sent_value,
          variant_id: c.variant_id,
          serial_id: c.serial_id,
          qty_milli: c.qty_milli,
          note: 'Defective stock given to the supplier',
        });
      }
    };
    // A good unit received into our sellable stock (repaired, or a new one).
    const intoStock = (serialId) => {
      const value = costOf(c.qty_milli, avgCost(v));
      serials.insertMovement(db, {
        variant_id: c.variant_id,
        date,
        type: 'supplier_claim_in',
        qty_milli: c.qty_milli,
        unit_cost: avgCost(v),
        ref_type: 'warranty_claim',
        ref_id: c.id,
        reason: `${c.claim_no}: from ${supplier.name}`,
      });
      serials.insertCost(db, {
        claim_id: c.id,
        date,
        kind: 'supplier_replacement',
        direction: 'recovery',
        amount: value,
        variant_id: c.variant_id,
        serial_id: serialId,
        qty_milli: c.qty_milli,
        party_id: supplier.id,
        note: `Good unit received from ${supplier.name}`,
      });
      writeOffSent();
    };

    if (p.result === 'repaired') {
      outcome = 'supplier_repaired';
      resultNote.push('Repaired by supplier');
      if (s) {
        const to = stockClaim ? 'in_stock' : 'sold';
        db.prepare('UPDATE product_serials SET status = ? WHERE id = ?').run(to, s.id);
        serials.insertEvent(db, s.id, {
          date,
          type: 'claim_back',
          from_status: 'under_claim',
          to_status: to,
          ref_type: 'warranty_claim',
          ref_id: c.id,
          note: `${c.claim_no}: repaired by ${supplier.name}`,
        });
      }
      if (stockClaim) {
        intoStock(s ? s.id : null);
        next = 'closed';
      } else next = 'ready';
    } else if (p.result === 'replaced') {
      outcome = 'supplier_replaced';
      const newTo = stockClaim ? 'stock' : p.new_to === 'stock' ? 'stock' : 'customer';
      disp.new_to = newTo;
      if (s) {
        if (newTo === 'customer') {
          const { mode, reason } = replacementMode(db, p);
          const w = W.replacementWarranty({
            mode,
            oldEnd: c.warranty_end,
            months: lineMonths(db, c),
            today: date,
            fromDate: c.received_date,
          });
          const newId = newSupplierSerial(db, c, p.new_serial, {
            status: 'sold',
            sale: null,
            date,
            supplierId: supplier.id,
          });
          markReplaced(db, c, s.id, newId, date, `${c.claim_no}: replaced by supplier`);
          giveToCustomer(db, c, newId, w, date);
          Object.assign(claimFields, {
            replacement_serial_id: newId,
            replacement_mode: mode,
            replacement_reason: reason,
            replacement_warranty_end: w.end,
          });
          disp.new_serial_id = newId;
          resultNote.push(`New unit ${str(p.new_serial.serial_no)} for the customer`);
          next = 'ready';
        } else {
          const newId = newSupplierSerial(db, c, p.new_serial, {
            status: 'in_stock',
            sale: null,
            date,
            supplierId: supplier.id,
          });
          markReplaced(
            db,
            c,
            s.id,
            newId,
            date,
            `${c.claim_no}: replaced by supplier (new unit to stock)`,
          );
          intoStock(newId);
          disp.new_serial_id = newId;
          resultNote.push(`New unit ${str(p.new_serial.serial_no)} into stock`);
          next = stockClaim ? 'closed' : 'awaiting_replacement';
        }
      } else if (newTo === 'customer') {
        resultNote.push('New goods for the customer');
        next = 'ready';
      } else {
        intoStock(null);
        resultNote.push('New goods into stock');
        next = stockClaim ? 'closed' : 'awaiting_replacement';
      }
    } else if (p.result === 'credit') {
      outcome = 'supplier_credit';
      const amount = p.credit_amount;
      if (!Number.isSafeInteger(amount) || amount < 0)
        fail({ credit_amount: 'Enter the credit amount.' });
      const ref = text(p.credit_ref, 60, {}, 'credit_ref', 'Reference');
      disp.credit_amount = amount;
      disp.credit_ref = ref || null;
      if (amount > 0) {
        serials.insertCost(db, {
          claim_id: c.id,
          date,
          kind: 'supplier_credit',
          direction: 'recovery',
          amount,
          variant_id: c.variant_id,
          serial_id: c.serial_id,
          qty_milli: c.qty_milli,
          party_id: supplier.id,
          ref_no: ref || null,
          note: `Credit note from ${supplier.name}`,
        });
      }
      writeOffSent();
      if (s) {
        db.prepare("UPDATE product_serials SET status = 'returned_to_supplier' WHERE id = ?").run(
          s.id,
        );
        serials.insertEvent(db, s.id, {
          date,
          type: 'returned_to_supplier',
          from_status: 'under_claim',
          to_status: 'returned_to_supplier',
          ref_type: 'warranty_claim',
          ref_id: c.id,
          note: `${c.claim_no}: supplier credit ${money(amount)}${ref ? ` (${ref})` : ''}`,
        });
      }
      resultNote.push(`Credit note ${money(amount)}${ref ? ` ${ref}` : ''}`);
      next = stockClaim ? 'closed' : 'awaiting_replacement';
    } else {
      // Rejected by the supplier: the unit comes back.
      if (stockClaim) {
        outcome = 'rejected';
        const back = c.qty_milli;
        serials.insertMovement(db, {
          variant_id: c.variant_id,
          date,
          type: 'supplier_claim_in',
          location: 'defective',
          qty_milli: back,
          unit_cost: billing.divRound(d.sent_value * 1000, back),
          ref_type: 'warranty_claim',
          ref_id: c.id,
          reason: `${c.claim_no}: rejected by ${supplier.name}`,
        });
        if (s) {
          db.prepare("UPDATE product_serials SET status = 'defective' WHERE id = ?").run(s.id);
          serials.insertEvent(db, s.id, {
            date,
            type: 'claim_back',
            from_status: 'under_claim',
            to_status: 'defective',
            ref_type: 'warranty_claim',
            ref_id: c.id,
            note: `${c.claim_no}: rejected by ${supplier.name}`,
          });
        }
        resultNote.push('Rejected: back in defective stock');
        next = 'closed';
      } else {
        const action = ['return_as_is', 'chargeable', 'absorb'].includes(p.rejected_action)
          ? p.rejected_action
          : null;
        if (!action) fail({ rejected_action: 'Choose what happens now.' });
        disp.rejected_action = action;
        if (s) {
          db.prepare("UPDATE product_serials SET status = 'sold' WHERE id = ?").run(s.id);
          serials.insertEvent(db, s.id, {
            date,
            type: 'claim_back',
            from_status: 'under_claim',
            to_status: 'sold',
            ref_type: 'warranty_claim',
            ref_id: c.id,
            note: `${c.claim_no}: rejected by ${supplier.name}`,
          });
        }
        if (action === 'return_as_is') {
          outcome = 'returned_as_is';
          Object.assign(claimFields, {
            reject_reason: 'other',
            reject_notes: `Rejected by ${supplier.name}${notes ? `: ${notes}` : ''}`,
          });
          resultNote.push('Rejected: return as is');
          next = 'rejected';
        } else if (action === 'chargeable') {
          claimFields.chargeable = 1;
          claimFields.decision = 'repair';
          resultNote.push('Rejected: chargeable repair');
          next = 'repairing';
        } else {
          outcome = 'absorbed';
          claimFields.decision = null;
          resultNote.push('Rejected: shop absorbs the loss (decide again)');
          next = 'inspecting';
        }
      }
    }

    db.prepare(
      `UPDATE claim_dispatches SET result = @result, result_date = @result_date,
         result_notes = @result_notes, status = @status, new_serial_id = @new_serial_id,
         new_to = @new_to, credit_amount = @credit_amount, credit_ref = @credit_ref,
         rejected_action = @rejected_action WHERE id = @id`,
    ).run({
      new_serial_id: null,
      new_to: null,
      credit_amount: null,
      credit_ref: null,
      rejected_action: null,
      ...disp,
      id: d.id,
    });
    if (next === 'closed') claimFields.closed_date = date;
    move(
      db,
      c,
      next,
      { ...claimFields, outcome: outcome ?? c.outcome },
      {
        type: 'supplier_result',
        date,
        note: `${supplier.name}: ${resultNote.join(' · ')}${notes ? ` · ${notes}` : ''}`,
      },
      ctx,
    );
  })();
  return get(db, p.id);
}

// ---------------------------------------------------------------- replace from stock

/** Did the customer's faulty goods leave us (supplier kept them / sent new goods to stock)? */
function goodsLeft(db, c) {
  return Boolean(
    db
      .prepare(
        `SELECT 1 FROM claim_dispatches WHERE claim_id = ? AND status = 'back'
           AND (result = 'credit' OR (result = 'replaced' AND new_to = 'stock'))`,
      )
      .get(c.id),
  );
}

function replaceInner(db, c, p, ctx) {
  const date = p.date;
  const { mode, reason } = replacementMode(db, p);
  let replacementId = null;
  let warranty = { start: null, end: null };
  const v = variantInfo(db, c.variant_id);
  let costAmount;
  if (c.serial_id) {
    if (!Number.isInteger(p.replacement_serial_id))
      fail({ replacement_serial_id: 'Pick the replacement unit.' });
    const n = serials.loadSerial(db, p.replacement_serial_id);
    if (n.product_id !== c.product_id)
      fail({ replacement_serial_id: 'Pick a unit of the same product.' });
    if (n.status !== 'in_stock') fail({ replacement_serial_id: `${n.serial_no} is not in stock.` });
    const nv = variantInfo(db, n.variant_id);
    const unitCost = avgCost(nv);
    warranty = W.replacementWarranty({
      mode,
      oldEnd: c.warranty_end,
      months: lineMonths(db, c),
      today: date,
      fromDate: c.received_date,
    });
    serials.insertMovement(db, {
      variant_id: n.variant_id,
      date,
      type: 'warranty_replacement_out',
      qty_milli: -1000,
      unit_cost: unitCost,
      ref_type: 'warranty_claim',
      ref_id: c.id,
      reason: `${c.claim_no}: replaces ${serials.loadSerial(db, c.serial_id).serial_no}`,
    });
    const old = serials.loadSerial(db, c.serial_id);
    if (old.status === 'sold') {
      // The faulty unit stays with us, out of sale: defective location at no value (its
      // cost was the customer's; the replacement is the loss).
      serials.insertMovement(db, {
        variant_id: old.variant_id,
        date,
        type: 'warranty_return_in',
        location: 'defective',
        qty_milli: 1000,
        unit_cost: 0,
        ref_type: 'warranty_claim',
        ref_id: c.id,
        reason: `${c.claim_no}: faulty unit taken back`,
      });
      db.prepare(
        "UPDATE product_serials SET status = 'defective', replaced_by_serial_id = ? WHERE id = ?",
      ).run(n.id, old.id);
      serials.insertEvent(db, old.id, {
        date,
        type: 'claim_replaced',
        from_status: 'sold',
        to_status: 'defective',
        ref_type: 'warranty_claim',
        ref_id: c.id,
        note: `${c.claim_no}: replaced by ${n.serial_no}; faulty unit kept as defective`,
      });
    } else {
      db.prepare('UPDATE product_serials SET replaced_by_serial_id = ? WHERE id = ?').run(
        n.id,
        old.id,
      );
    }
    // The new unit leaves stock for the customer, linked to the original bill line.
    giveToCustomer(db, c, n.id, warranty, date);
    replacementId = n.id;
    costAmount = unitCost;
  } else {
    assertStock(db, v, c.qty_milli);
    const unitCost = avgCost(v);
    serials.insertMovement(db, {
      variant_id: v.id,
      date,
      type: 'warranty_replacement_out',
      qty_milli: -c.qty_milli,
      unit_cost: unitCost,
      ref_type: 'warranty_claim',
      ref_id: c.id,
      reason: `${c.claim_no}: replacement`,
    });
    if (!goodsLeft(db, c)) {
      serials.insertMovement(db, {
        variant_id: v.id,
        date,
        type: 'warranty_return_in',
        location: 'defective',
        qty_milli: c.qty_milli,
        unit_cost: 0,
        ref_type: 'warranty_claim',
        ref_id: c.id,
        reason: `${c.claim_no}: faulty goods taken back`,
      });
    }
    costAmount = costOf(c.qty_milli, unitCost);
    warranty = { start: null, end: c.warranty_end };
  }
  serials.insertCost(db, {
    claim_id: c.id,
    date,
    kind: 'replacement',
    direction: 'cost',
    amount: costAmount,
    variant_id: c.variant_id,
    serial_id: replacementId,
    qty_milli: c.qty_milli,
    note: 'Replacement given from stock',
  });
  const cur = claimRow(db, c.id);
  move(
    db,
    cur,
    'ready',
    {
      replacement_serial_id: replacementId,
      replacement_mode: mode,
      replacement_reason: reason,
      replacement_warranty_end: warranty.end,
      outcome: 'replaced',
      decision: 'replace',
    },
    {
      type: 'replaced',
      date,
      note: `${replacementId ? serials.loadSerial(db, replacementId).serial_no : `${c.qty_milli / 1000} ${v.unit}`} from stock${warranty.end ? ` · warranty till ${warranty.end} (${mode})` : ''}${reason ? ` · ${reason}` : ''}`,
    },
    ctx,
  );
}

/** Replacement from stock for a claim waiting for one (or straight after the inspection). */
function replace(db, payload, ctx = {}) {
  const p = payload || {};
  const errors = {};
  const date = dateOf(p.date, errors);
  fail(errors);
  db.transaction(() => {
    const c = claimRow(db, p.id);
    if (c.kind !== 'customer') throw new AppError('Only a customer claim gets a replacement.');
    if (c.chargeable) throw new AppError('A chargeable claim does not get a replacement.');
    assertStatus(c, ['received', 'inspecting', 'awaiting_replacement'], 'give a replacement');
    replaceInner(db, c, { ...p, date }, ctx);
  })();
  return get(db, p.id);
}

// ---------------------------------------------------------------- refund

function refundInner(db, c, p, ctx) {
  if (!c.sale_id) throw new AppError('This claim has no bill to refund.');
  const sale = sales.saleRow(db, c.sale_id);
  if (sale.status !== 'active') throw new AppError('The bill is cancelled.');
  if (c.serial_id) {
    const s = serials.loadSerial(db, c.serial_id);
    if (s.status !== 'sold' || s.sale_item_id !== c.sale_item_id) {
      throw new AppError('Only a unit that is still with us for this claim can be refunded.');
    }
  }
  const settlement = p.settlement === 'adjust' ? 'adjust' : 'refund';
  const ret = saleReturns.create(
    db,
    {
      sale_id: c.sale_id,
      date: p.date,
      reason: `Warranty claim ${c.claim_no}`,
      settlement,
      refund: settlement === 'refund' ? { mode: p.refund_mode || 'cash' } : null,
      claim_id: c.id,
      lines: [
        {
          sale_item_id: c.sale_item_id,
          qty_milli: c.qty_milli,
          serials: c.serial_id ? [{ id: c.serial_id, to_status: 'defective' }] : undefined,
        },
      ],
    },
    ctx,
  );
  if (!c.serial_id) {
    // Non-serial returns go back to sellable stock: these goods are faulty, move them aside.
    const ri = db
      .prepare(
        'SELECT unit_cost FROM sale_return_items WHERE sale_return_id = ? AND sale_item_id = ?',
      )
      .get(ret.id, c.sale_item_id);
    const unitCost = ri ? ri.unit_cost : 0;
    for (const [location, qty] of [
      ['main', -c.qty_milli],
      ['defective', c.qty_milli],
    ]) {
      serials.insertMovement(db, {
        variant_id: c.variant_id,
        date: p.date,
        type: 'warranty_return_in',
        location,
        qty_milli: qty,
        unit_cost: unitCost,
        ref_type: 'warranty_claim',
        ref_id: c.id,
        reason: `${c.claim_no}: refunded goods are faulty`,
      });
    }
  } else {
    serials.insertEvent(db, c.serial_id, {
      date: p.date,
      type: 'claim_refunded',
      from_status: 'defective',
      to_status: 'defective',
      ref_type: 'warranty_claim',
      ref_id: c.id,
      note: `${c.claim_no}: credit note ${ret.return_no}`,
    });
  }
  const cur = claimRow(db, c.id);
  move(
    db,
    cur,
    'closed',
    { sale_return_id: ret.id, outcome: 'refunded', decision: 'refund', closed_date: p.date },
    {
      type: 'refunded',
      date: p.date,
      note: `Credit note ${ret.return_no} ${money(ret.total)} (${settlement === 'refund' ? 'refunded' : 'adjusted / advance'})`,
    },
    ctx,
  );
}

/** Refund for a claim waiting for a replacement (e.g. none in stock). */
function refund(db, payload, ctx = {}) {
  const p = payload || {};
  const errors = {};
  const date = dateOf(p.date, errors);
  fail(errors);
  db.transaction(() => {
    const c = claimRow(db, p.id);
    if (c.kind !== 'customer' || c.chargeable) throw new AppError('This claim cannot be refunded.');
    assertStatus(c, ['received', 'inspecting', 'awaiting_replacement'], 'be refunded');
    refundInner(db, c, { ...p, date }, ctx);
  })();
  return get(db, p.id);
}

// ---------------------------------------------------------------- hand over, close, cancel

function unbilledWork(db, c) {
  if (!c.chargeable || c.bill_sale_id) return false;
  const parts = db
    .prepare('SELECT COUNT(*) FROM claim_parts WHERE claim_id = ? AND chargeable = 1')
    .pluck()
    .get(c.id);
  return parts > 0 || c.labour_amount > 0;
}

/**
 * The unit (or its replacement) is given back to the customer. payload: { id, date,
 * handed_over_by, final_notes, close (default true), confirm_unbilled }.
 */
function handover(db, payload, ctx = {}) {
  const p = payload || {};
  const errors = {};
  const date = dateOf(p.date, errors);
  const by = text(p.handed_over_by, 60, errors, 'handed_over_by', 'Name');
  const notes = text(p.final_notes, MAX_TEXT, errors, 'final_notes', 'Notes');
  fail(errors);
  db.transaction(() => {
    let c = claimRow(db, p.id);
    if (c.kind !== 'customer') throw new AppError('Nothing to hand over on a supplier claim.');
    assertStatus(c, ['ready', 'rejected'], 'be handed over');
    if (openDispatch(db, c.id)) throw new AppError('The unit is still at the supplier.');
    if (date < c.received_date) fail({ date: 'Before the claim was received.' });
    if (unbilledWork(db, c) && p.confirm_unbilled !== true) {
      throw new AppError(
        'This chargeable repair has no bill yet. Hand it over without a bill?',
        'NOT_BILLED',
      );
    }
    const given = c.replacement_serial_id || c.serial_id;
    c = move(
      db,
      c,
      'returned',
      { handover_date: date, handed_over_by: by || null, final_notes: notes || null },
      {
        type: 'returned',
        date,
        note: [by ? `by ${by}` : null, notes].filter(Boolean).join(' · ') || null,
      },
      ctx,
    );
    if (given) {
      serials.insertEvent(db, given, {
        date,
        type: 'claim_returned',
        ref_type: 'warranty_claim',
        ref_id: c.id,
        note: `${c.claim_no}${c.outcome ? `: ${OUTCOMES[c.outcome]}` : ''}`,
      });
    }
    if (p.close !== false) {
      move(db, c, 'closed', { closed_date: date }, { type: 'closed', date }, ctx);
    }
  })();
  return get(db, p.id);
}

function close(db, { id: claimId, notes, date }, ctx = {}) {
  const errors = {};
  const d = dateOf(date, errors);
  const n = text(notes, MAX_TEXT, errors, 'notes', 'Notes');
  fail(errors);
  db.transaction(() => {
    const c = claimRow(db, claimId);
    assertStatus(c, ['returned'], 'be closed');
    if (openDispatch(db, c.id))
      throw new AppError('A unit of this claim is still at the supplier.');
    move(db, c, 'closed', { closed_date: d }, { type: 'closed', date: d, note: n || null }, ctx);
  })();
  return get(db, claimId);
}

/** Why a claim cannot be cancelled (anything physical or financial already happened). */
function cancelBlockers(db, c) {
  const out = [];
  if (['closed', 'cancelled', 'returned'].includes(c.status))
    out.push(`It is ${STATUS_LABELS[c.status].toLowerCase()}.`);
  if (db.prepare('SELECT 1 FROM claim_dispatches WHERE claim_id = ?').get(c.id))
    out.push('It was sent to the supplier.');
  if (db.prepare('SELECT 1 FROM claim_parts WHERE claim_id = ?').get(c.id))
    out.push('Parts were used.');
  if (c.replacement_serial_id || c.outcome === 'replaced') out.push('A replacement was given.');
  if (c.sale_return_id) out.push('It was refunded.');
  if (c.bill_sale_id) out.push('A bill was made for it.');
  return out;
}

/** Cancels a claim opened by mistake (keeps its number). */
function cancel(db, { id: claimId, reason }, ctx = {}) {
  const why = str(reason);
  if (!why) fail({ reason: 'A reason is required.' });
  if (why.length > 200) fail({ reason: 'Too long (max 200).' });
  db.transaction(() => {
    const c = claimRow(db, claimId);
    const blockers = cancelBlockers(db, c);
    if (blockers.length)
      throw new AppError(`${c.claim_no} cannot be cancelled: ${blockers[0]}`, 'LOCKED');
    move(
      db,
      c,
      'cancelled',
      { cancel_reason: why, cancelled_at: localNow() },
      { type: 'cancelled', note: why },
      ctx,
    );
    if (c.serial_id) {
      serials.insertEvent(db, c.serial_id, {
        type: 'claim_cancelled',
        ref_type: 'warranty_claim',
        ref_id: c.id,
        note: `${c.claim_no} cancelled: ${why}`,
      });
    }
  })();
  return get(db, claimId);
}

// ---------------------------------------------------------------- chargeable bill

function labourService(db) {
  return (
    db
      .prepare(
        `SELECT v.id FROM product_variants v JOIN products p ON p.id = v.product_id
         WHERE p.product_type = 'service' AND p.is_active = 1 AND p.is_deleted = 0 AND v.is_deleted = 0
           AND v.is_active = 1
         ORDER BY (p.name LIKE '%repair%') DESC, (p.name LIKE '%labour%' OR p.name LIKE '%labor%') DESC,
           (p.name LIKE '%service%') DESC, p.id LIMIT 1`,
      )
      .pluck()
      .get() || null
  );
}

/** Billing pre-fill for a chargeable repair: the parts noted + a labour / repair service line. */
function billPrefill(db, { id: claimId }) {
  const c = claimRow(db, claimId);
  if (!c.chargeable) throw new AppError('Only a chargeable claim is billed.');
  if (c.bill_sale_id) throw new AppError('A bill was already made for this claim.');
  if (['cancelled', 'closed'].includes(c.status))
    throw new AppError(`The claim is ${STATUS_LABELS[c.status].toLowerCase()}.`);
  const s = settings.getSettings(db);
  const lineFor = (variantId, qty, rate, issues = []) => {
    const v = variantInfo(db, variantId);
    const stock = variantStock(db, v.id);
    if (v.product_type === 'stock' && stock < qty && s.allow_negative_stock !== '1') {
      issues.push(`Only ${Math.max(stock, 0) / 1000} ${v.unit} in stock now.`);
    }
    return {
      variant_id: v.id,
      product_id: v.product_id,
      item_type: v.product_type === 'service' ? 'service' : 'goods',
      name: v.product_name,
      variant_label: variantLabel(v) || '',
      sku: v.sku,
      hsn_code: v.hsn_code || '',
      unit: v.unit,
      track_serials: Boolean(v.track_serials),
      qty_milli: qty,
      rate: rate ?? v.selling_price,
      mrp: v.mrp,
      selling_price: v.selling_price,
      avg_cost: avgCost(v),
      stock_milli: stock,
      discount_bp: null,
      discount: 0,
      gst_rate_bp: v.product_gst_rate_bp,
      warranty_months: 0,
      fitting_for: null,
      fitting_merged: false,
      fitted_by: '',
      serials: [],
      issues,
    };
  };
  const parts = db
    .prepare('SELECT * FROM claim_parts WHERE claim_id = ? AND chargeable = 1 ORDER BY id')
    .all(c.id);
  const lines = parts.map((x) => lineFor(x.variant_id, x.qty_milli, null));
  const labourId = labourService(db);
  if (labourId) {
    const rate = c.labour_amount > 0 ? c.labour_amount : null;
    lines.push(lineFor(labourId, 1000, rate, rate ? [] : ['Enter the repair charge.']));
  }
  const product = db.prepare('SELECT name FROM products WHERE id = ?').pluck().get(c.product_id);
  const serialNo = c.serial_id ? serials.loadSerial(db, c.serial_id).serial_no : null;
  const vehicle = c.vehicle_id ? sales.vehicleSnapshot(db, c.vehicle_id) : null;
  return {
    source: { type: 'claim', id: c.id, no: c.claim_no },
    party_id: c.customer_party_id,
    customer_name: c.customer_name || '',
    vehicle_id: vehicle && vehicle.customer_id === c.customer_party_id ? vehicle.id : null,
    bill_type: sales.effectiveBillType(s.default_bill_type, s),
    price_mode: s.default_price_mode === 'inclusive' ? 'inclusive' : 'exclusive',
    bill_discount_bp: null,
    bill_discount: 0,
    notes: `Repair of ${product}${serialNo ? ` (S/N ${serialNo})` : ''} under ${c.claim_no}`,
    lines,
    no_labour_service: !labourId,
  };
}

/** Called inside the bill's save transaction (sales.create with claim_id). */
function linkBill(db, claimId, saleId, ctx = {}) {
  const c = claimRow(db, claimId);
  if (!c.chargeable) throw new AppError('Only a chargeable claim is billed.');
  if (c.bill_sale_id) throw new AppError('A bill was already made for this claim.');
  if (c.status === 'cancelled') throw new AppError('The claim is cancelled.');
  const inv = db.prepare('SELECT invoice_no, grand_total FROM sales WHERE id = ?').get(saleId);
  update(db, c.id, { bill_sale_id: saleId });
  event(db, c, { type: 'billed', note: `${inv.invoice_no} ${money(inv.grand_total)}` }, ctx);
}

// ---------------------------------------------------------------- attachments

function addAttachments(db, { id: claimId, attachments }, ctx = {}) {
  let moves = [];
  try {
    db.transaction(() => {
      const c = claimRow(db, claimId);
      const list = (attachments || []).slice(0, 10).map((a) => ({
        temp_path: a.temp_path,
        original_name: str(a.original_name).slice(0, 120) || 'photo',
        size_bytes: Number.isSafeInteger(a.size_bytes) ? a.size_bytes : 0,
      }));
      const count = db
        .prepare('SELECT COUNT(*) FROM claim_attachments WHERE claim_id = ? AND is_deleted = 0')
        .pluck()
        .get(c.id);
      if (count + list.length > 20) throw new AppError('At most 20 photos per claim.');
      moves = attach(db, c, list, ctx);
      event(
        db,
        c,
        { type: 'attachment_added', note: list.map((a) => a.original_name).join(', ') },
        ctx,
      );
    })();
  } catch (err) {
    if (moves.length && ctx.files) ctx.files.undo(moves);
    throw err;
  }
  return get(db, claimId);
}

/** Soft-removes a photo (the file stays in the data folder). */
function removeAttachment(db, { id: attachmentId }, ctx = {}) {
  const a = db
    .prepare('SELECT * FROM claim_attachments WHERE id = ? AND is_deleted = 0')
    .get(attachmentId);
  if (!a) throw new AppError('Photo not found.', 'NOT_FOUND');
  db.transaction(() => {
    db.prepare('UPDATE claim_attachments SET is_deleted = 1 WHERE id = ?').run(a.id);
    event(db, claimRow(db, a.claim_id), { type: 'attachment_removed', note: a.original_name }, ctx);
  })();
  return get(db, a.claim_id);
}

function attachmentFile(db, { id: attachmentId }) {
  const a = db
    .prepare('SELECT * FROM claim_attachments WHERE id = ? AND is_deleted = 0')
    .get(attachmentId);
  if (!a) throw new AppError('Photo not found.', 'NOT_FOUND');
  return a;
}

// ---------------------------------------------------------------- reading

function moneyOf(db, claimId) {
  const rows = db
    .prepare("SELECT * FROM warranty_costs WHERE claim_id = ? AND status = 'active' ORDER BY id")
    .all(claimId);
  const cost = rows.filter((r) => r.direction === 'cost').reduce((s, r) => s + r.amount, 0);
  const recovered = rows
    .filter((r) => r.direction === 'recovery')
    .reduce((s, r) => s + r.amount, 0);
  return { rows, cost, recovered, net_loss: cost - recovered };
}

function isOverdue(d, today) {
  return Boolean(d && d.status === 'at_supplier' && d.expected_date && d.expected_date < today);
}

function get(db, claimId) {
  const c = claimRow(db, claimId);
  const today = todayISO();
  const p = db
    .prepare(
      `SELECT p.name, p.brand, p.unit, p.warranty_covered, p.warranty_not_covered,
         p.customer_warranty_months, v.sku, v.color, v.size, v.variant_type
       FROM products p JOIN product_variants v ON v.id = ? WHERE p.id = ?`,
    )
    .get(c.variant_id, c.product_id);
  const serial = c.serial_id
    ? db
        .prepare(
          'SELECT id, serial_no, serial_no_2, status, warranty_end, supplier_warranty_end FROM product_serials WHERE id = ?',
        )
        .get(c.serial_id)
    : null;
  const replacement = c.replacement_serial_id
    ? db
        .prepare('SELECT id, serial_no, warranty_end FROM product_serials WHERE id = ?')
        .get(c.replacement_serial_id)
    : null;
  const sale = c.sale_id
    ? db
        .prepare('SELECT id, invoice_no, invoice_date, status FROM sales WHERE id = ?')
        .get(c.sale_id)
    : null;
  const item = c.sale_item_id
    ? db.prepare('SELECT fitted_by, qty_milli FROM sale_items WHERE id = ?').get(c.sale_item_id)
    : null;
  const supplier = c.supplier_party_id
    ? db.prepare('SELECT id, name, phone FROM parties WHERE id = ?').get(c.supplier_party_id)
    : null;
  const dispatches = db
    .prepare(
      `SELECT d.*, su.name AS supplier_name, ns.serial_no AS new_serial_no
       FROM claim_dispatches d JOIN parties su ON su.id = d.supplier_party_id
       LEFT JOIN product_serials ns ON ns.id = d.new_serial_id
       WHERE d.claim_id = ? ORDER BY d.id`,
    )
    .all(c.id)
    .map((d) => ({ ...d, overdue: isOverdue(d, today), mode_label: DISPATCH_MODES[d.mode] }));
  const parts = db.prepare('SELECT * FROM claim_parts WHERE claim_id = ? ORDER BY id').all(c.id);
  const attachments = db
    .prepare(
      'SELECT id, file_path, original_name, size_bytes, created_at FROM claim_attachments WHERE claim_id = ? AND is_deleted = 0 ORDER BY id',
    )
    .all(c.id)
    .map((a) => ({ ...a, url: `app-data://files/${a.file_path}` }));
  const events = db
    .prepare('SELECT * FROM claim_events WHERE claim_id = ? ORDER BY id')
    .all(c.id)
    .map((e) => ({ ...e, label: units.CLAIM_EVENT_LABELS[e.type] || e.type }));
  const creditNote = c.sale_return_id
    ? db
        .prepare('SELECT id, return_no, total, date FROM sale_returns WHERE id = ?')
        .get(c.sale_return_id)
    : null;
  const bill = c.bill_sale_id
    ? db
        .prepare('SELECT id, invoice_no, grand_total, status FROM sales WHERE id = ?')
        .get(c.bill_sale_id)
    : null;
  const open = openDispatch(db, c.id);
  const blockers = cancelBlockers(db, c);
  const isCustomer = c.kind === 'customer';
  const parse = (j) => {
    try {
      return j ? JSON.parse(j) : [];
    } catch {
      return [];
    }
  };
  return {
    ...c,
    customer_phone_display: id.formatPhone(c.customer_phone),
    brought_by_phone_display: id.formatPhone(c.brought_by_phone),
    status_label: STATUS_LABELS[c.status],
    decision_label: c.decision ? DECISIONS[c.decision] : null,
    outcome_label: c.outcome ? OUTCOMES[c.outcome] : null,
    reject_reason_label: c.reject_reason ? REJECT_REASONS[c.reject_reason] : null,
    complaint_tags: parse(c.complaint_tags),
    accessories: parse(c.accessories),
    product: {
      id: c.product_id,
      name: p.name,
      brand: p.brand,
      unit: p.unit,
      sku: p.sku,
      variant_label: variantLabel(p),
      terms: {
        covered: p.warranty_covered || '',
        not_covered: p.warranty_not_covered || '',
        months: p.customer_warranty_months,
      },
    },
    serial,
    replacement,
    sale,
    fitted_by: item ? item.fitted_by : null,
    supplier,
    warranty: W.warrantyStatus(c.warranty_end, c.received_date, units.expiringDays(db)),
    dispatches,
    at_supplier: open ? { ...open, overdue: isOverdue(open, today) } : null,
    overdue: isOverdue(open, today),
    parts,
    attachments,
    events,
    credit_note: creditNote,
    bill,
    money: moneyOf(db, c.id),
    days_open: W.daysBetween(c.received_date, c.closed_date || today),
    can: {
      inspect: isCustomer && c.status === 'received',
      decide: isCustomer && ['received', 'inspecting'].includes(c.status),
      dispatch: ['received', 'inspecting', 'repairing'].includes(c.status) && !open,
      repair_done: c.status === 'repairing',
      supplier_result: c.status === 'at_supplier',
      replace: isCustomer && !c.chargeable && c.status === 'awaiting_replacement',
      refund:
        isCustomer &&
        !c.chargeable &&
        c.status === 'awaiting_replacement' &&
        Boolean(c.sale_id) &&
        (!serial || serial.status === 'sold'),
      handover: isCustomer && ['ready', 'rejected'].includes(c.status),
      close: c.status === 'returned',
      cancel: blockers.length === 0,
      bill: Boolean(c.chargeable) && !c.bill_sale_id && !['cancelled', 'closed'].includes(c.status),
      print_rejection:
        c.status === 'rejected' || c.outcome === 'rejected' || c.outcome === 'returned_as_is',
      print_handover: ['returned', 'closed'].includes(c.status) && Boolean(c.handover_date),
    },
    cancel_blockers: blockers,
    unbilled: unbilledWork(db, c),
  };
}

const LIST_SELECT = `
  SELECT c.id, c.claim_no, c.kind, c.status, c.decision, c.outcome, c.received_date, c.received_by,
    c.expected_date, c.closed_date, c.complaint, c.qty_milli, c.chargeable, c.in_warranty,
    c.customer_name, c.customer_phone, c.vehicle_no, c.product_id, c.serial_id,
    p.name AS product_name, p.brand, p.unit, s.serial_no, su.name AS supplier_name,
    sa.invoice_no, si.fitted_by,
    d.dispatch_date, d.expected_date AS supplier_expected, d.docket_no,
    (SELECT COALESCE(SUM(CASE direction WHEN 'cost' THEN amount ELSE -amount END), 0)
       FROM warranty_costs wc WHERE wc.claim_id = c.id AND wc.status = 'active') AS net_loss
  FROM warranty_claims c
  JOIN products p ON p.id = c.product_id
  LEFT JOIN product_serials s ON s.id = c.serial_id
  LEFT JOIN parties su ON su.id = c.supplier_party_id
  LEFT JOIN sales sa ON sa.id = c.sale_id
  LEFT JOIN sale_items si ON si.id = c.sale_item_id
  LEFT JOIN claim_dispatches d ON d.claim_id = c.id AND d.status = 'at_supplier'`;

/**
 * Claims list. tab: 'open' | 'closed' | 'all'; status; overdue (at supplier past the expected
 * date); filters: product_id, brand, category_id, supplier_id, from / to (received), technician
 * (received by / fitted by), search (claim no., serial, customer, phone, plate, product).
 */
function list(db, params = {}) {
  const where = ['c.is_deleted = 0'];
  const args = [];
  const today = todayISO();
  if (params.tab === 'open') where.push("c.status NOT IN ('closed','cancelled')");
  else if (params.tab === 'closed') where.push("c.status IN ('closed','cancelled')");
  if (STATUS_LABELS[params.status]) {
    where.push('c.status = ?');
    args.push(params.status);
  }
  if (params.status === 'ready') where[where.length - 1] = "c.status IN ('ready','rejected')";
  if (params.overdue) {
    where.push('d.expected_date IS NOT NULL AND d.expected_date < ?');
    args.push(today);
  }
  if (Number.isInteger(params.product_id)) {
    where.push('c.product_id = ?');
    args.push(params.product_id);
  }
  if (str(params.brand)) {
    where.push('p.brand = ? COLLATE NOCASE');
    args.push(str(params.brand));
  }
  if (Number.isInteger(params.category_id)) {
    where.push(
      '(p.category_id = ? OR p.category_id IN (SELECT id FROM product_categories WHERE parent_id = ?))',
    );
    args.push(params.category_id, params.category_id);
  }
  if (Number.isInteger(params.supplier_id)) {
    where.push(
      '(c.supplier_party_id = ? OR EXISTS (SELECT 1 FROM claim_dispatches x WHERE x.claim_id = c.id AND x.supplier_party_id = ?))',
    );
    args.push(params.supplier_id, params.supplier_id);
  }
  if (Number.isInteger(params.customer_id)) {
    where.push('c.customer_party_id = ?');
    args.push(params.customer_id);
  }
  if (params.from && isISODate(params.from)) {
    where.push('c.received_date >= ?');
    args.push(params.from);
  }
  if (params.to && isISODate(params.to)) {
    where.push('c.received_date <= ?');
    args.push(params.to);
  }
  const tech = str(params.technician);
  if (tech) {
    where.push(
      "(c.received_by LIKE ? ESCAPE '\\' OR si.fitted_by LIKE ? ESCAPE '\\' OR c.handed_over_by LIKE ? ESCAPE '\\')",
    );
    const like = `%${tech.replace(/[\\%_]/g, (x) => `\\${x}`)}%`;
    args.push(like, like, like);
  }
  const q = str(params.search);
  if (q) {
    const like = `%${q.replace(/[\\%_]/g, (x) => `\\${x}`)}%`;
    const plate = id.normalizePlate(q);
    const phone = id.normalizePhone(q);
    where.push(`(c.claim_no LIKE ? ESCAPE '\\' OR c.customer_name LIKE ? ESCAPE '\\'
      OR p.name LIKE ? ESCAPE '\\' OR s.serial_key LIKE ? ESCAPE '\\'
      OR (? <> '' AND c.customer_phone LIKE ? ESCAPE '\\')
      OR (? <> '' AND REPLACE(REPLACE(UPPER(c.vehicle_no), ' ', ''), '-', '') LIKE ? ESCAPE '\\'))`);
    const phoneKey = phone.replace(/\D/g, '').length >= 4 ? phone : '';
    const plateKey = plate.length >= 3 ? plate : '';
    args.push(
      like,
      like,
      like,
      `%${serials.serialKey(q)}%`,
      phoneKey,
      `%${phoneKey}%`,
      plateKey,
      `%${plateKey}%`,
    );
  }
  const rows = db
    .prepare(
      `${LIST_SELECT} WHERE ${where.join(' AND ')} ORDER BY c.received_date DESC, c.id DESC LIMIT 2000`,
    )
    .all(...args)
    .map((r) => ({
      ...r,
      status_label: STATUS_LABELS[r.status],
      decision_label: r.decision ? DECISIONS[r.decision] : null,
      outcome_label: r.outcome ? OUTCOMES[r.outcome] : null,
      customer_phone_display: id.formatPhone(r.customer_phone),
      overdue:
        r.status === 'at_supplier' && Boolean(r.supplier_expected) && r.supplier_expected < today,
      days_open: W.daysBetween(r.received_date, r.closed_date || today),
    }));
  return { rows, total: rows.length };
}

/** Supplier detail: claims sent to this supplier, pending returns, recovery totals. */
function forSupplier(db, partyId) {
  const today = todayISO();
  const claims = list(db, { supplier_id: partyId }).rows;
  const pending = db
    .prepare(
      `SELECT d.*, c.claim_no, p.name AS product_name, s.serial_no FROM claim_dispatches d
       JOIN warranty_claims c ON c.id = d.claim_id JOIN products p ON p.id = c.product_id
       LEFT JOIN product_serials s ON s.id = c.serial_id
       WHERE d.supplier_party_id = ? AND d.status = 'at_supplier' ORDER BY d.dispatch_date`,
    )
    .all(partyId)
    .map((d) => ({ ...d, overdue: isOverdue(d, today) }));
  const rec = db
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN kind = 'supplier_credit' THEN amount END), 0) AS credit,
         COALESCE(SUM(CASE WHEN kind = 'supplier_replacement' THEN amount END), 0) AS replacement
       FROM warranty_costs WHERE party_id = ? AND direction = 'recovery' AND status = 'active'`,
    )
    .get(partyId);
  const turn = db
    .prepare(
      `SELECT AVG(julianday(result_date) - julianday(dispatch_date)) FROM claim_dispatches
       WHERE supplier_party_id = ? AND status = 'back' AND result_date IS NOT NULL`,
    )
    .pluck()
    .get(partyId);
  return {
    claims,
    pending,
    totals: {
      sent: db
        .prepare('SELECT COUNT(*) FROM claim_dispatches WHERE supplier_party_id = ?')
        .pluck()
        .get(partyId),
      pending: pending.length,
      overdue: pending.filter((d) => d.overdue).length,
      recovered_credit: rec.credit,
      recovered_units: rec.replacement,
      recovered: rec.credit + rec.replacement,
      avg_turnaround_days: turn == null ? null : Math.round(turn),
    },
  };
}

/** Product detail: claims history and claim rate (claims ÷ units sold). */
function forProduct(db, productId) {
  const claims = list(db, { product_id: productId }).rows;
  const soldMilli = db
    .prepare(
      `SELECT COALESCE(SUM(si.qty_milli), 0) FROM sale_items si JOIN sales sa ON sa.id = si.sale_id
       WHERE si.product_id = ? AND sa.status = 'active' AND si.item_type = 'goods'`,
    )
    .pluck()
    .get(productId);
  const claimedMilli = claims
    .filter((c) => c.kind === 'customer' && c.status !== 'cancelled')
    .reduce((s, c) => s + c.qty_milli, 0);
  return {
    claims,
    sold_milli: soldMilli,
    claimed_milli: claimedMilli,
    claim_rate_bp: soldMilli > 0 ? Math.round((claimedMilli * 10000) / soldMilli) : null,
  };
}

module.exports = {
  STATUS_LABELS,
  OPEN_STATUSES,
  DECISIONS,
  OUTCOMES,
  REJECT_REASONS,
  DISPATCH_MODES,
  ACCESSORIES,
  issuePresets,
  prepare,
  create,
  insertClaim,
  event,
  move,
  claimRow,
  dispatchInner,
  inspect,
  decide,
  repairDone,
  dispatch,
  supplierResult,
  replace,
  refund,
  handover,
  close,
  cancel,
  cancelBlockers,
  billPrefill,
  linkBill,
  addAttachments,
  removeAttachment,
  attachmentFile,
  get,
  list,
  forSupplier,
  forProduct,
};
