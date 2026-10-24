'use strict';

// Purchase returns (debit notes): DN-GST-0001 for GST bills, DN-EST-0001 for non-GST bills.
// Stock leaves at the ORIGINAL landed cost of the purchase line, whatever credit the supplier
// agrees to. Tax is reversed at the original rate. One transaction per document.

const { AppError } = require('../errors');
const { isISODate, todayISO, str } = require('./parse');
const settings = require('./settings');
const serials = require('./serials');
const payments = require('./payments');
const billing = require('./billing');
const { variantLabel, variantStock } = require('./products');
const pu = require('./purchases');

const RETURNABLE = ['in_stock', 'defective'];

function fail(errors) {
  const keys = Object.keys(errors);
  if (keys.length) throw new AppError(`Please check: ${errors[keys[0]]}`, 'VALIDATION', errors);
}

/** Quantity of a purchase line already returned on active debit notes. */
function returnedQty(db, purchaseItemId, excludeReturnId = null) {
  return db
    .prepare(
      `SELECT COALESCE(SUM(ri.qty_milli), 0) FROM purchase_return_items ri
       JOIN purchase_returns r ON r.id = ri.purchase_return_id
       WHERE ri.purchase_item_id = ? AND r.status = 'active' AND r.is_deleted = 0 AND r.id IS NOT ?`,
    )
    .pluck()
    .get(purchaseItemId, excludeReturnId);
}

/** Default credit for `qty` units of a line: its value per unit including free units. */
function defaultTaxable(item, qty) {
  return billing.divRound(item.taxable * qty, item.qty_milli + item.free_qty_milli);
}

/** What can be returned from a purchase: lines with remaining qty and eligible serials. */
function prepare(db, { purchase_id: purchaseId }) {
  const pur = pu.purchaseRow(db, purchaseId);
  if (pur.status !== 'active') throw new AppError('This purchase is cancelled.');
  const lines = pu.currentItems(db, pur).map((it) => {
    const v = pu.loadVariantInfo(db, it.variant_id);
    const purchased = it.qty_milli + it.free_qty_milli;
    const returned = returnedQty(db, it.id);
    const units = v.track_serials
      ? db
          .prepare(
            `SELECT id, serial_no, serial_no_2, status FROM product_serials
             WHERE purchase_item_id = ? AND status IN ('in_stock','defective') ORDER BY id`,
          )
          .all(it.id)
          .map((s) => ({ ...s, status_label: serials.STATUS_LABELS[s.status] }))
      : null;
    const stock = variantStock(db, v.id);
    const left = purchased - returned;
    return {
      purchase_item_id: it.id,
      variant_id: it.variant_id,
      product_name: it.product_name,
      variant_label: it.variant_label,
      unit: it.unit,
      hsn_code: it.hsn_code,
      gst_rate_bp: it.gst_rate_bp,
      qty_milli: it.qty_milli,
      free_qty_milli: it.free_qty_milli,
      rate: it.rate,
      taxable: it.taxable,
      unit_cost: it.unit_cost,
      effective_rate: billing.divRound(it.taxable * 1000, purchased),
      returned_milli: returned,
      returnable_milli: v.track_serials
        ? Math.min(left, units.length * 1000)
        : Math.min(left, Math.max(stock, 0)),
      left_milli: left,
      stock_milli: stock,
      track_serials: v.track_serials,
      serials: units,
    };
  });
  return {
    purchase: {
      id: pur.id,
      entry_no: pur.entry_no,
      bill_no: pur.bill_no,
      bill_date: pur.bill_date,
      bill_type: pur.bill_type,
      is_interstate: pur.is_interstate,
      party_id: pur.party_id,
      supplier_name: pur.supplier_name,
      grand_total: pur.grand_total,
      due: pur.grand_total - pu.paidOf(db, pur.id),
    },
    lines,
  };
}

/**
 * payload: { purchase_id | null, party_id (standalone), bill_type (standalone), date, reason,
 *   settlement: 'adjust' | 'refund', refund: { mode, ref_no },
 *   lines: [{ purchase_item_id | variant_id, qty_milli, serial_ids, taxable, gst_rate_bp }] }
 * `taxable` = credit agreed (before GST); when omitted the proportional value is used.
 */
function build(db, payload) {
  const p = payload || {};
  const errors = {};
  const s = settings.getSettings(db);
  const date = p.date || todayISO();
  if (!isISODate(date)) errors.date = 'Invalid date.';
  const reason = str(p.reason);
  if (reason.length > 200) errors.reason = 'Reason is too long (max 200).';
  const settlement = p.settlement === 'refund' ? 'refund' : 'adjust';

  let pur = null;
  let supplier;
  let billType;
  let interstate;
  let pos;
  if (Number.isInteger(p.purchase_id)) {
    pur = pu.purchaseRow(db, p.purchase_id);
    if (pur.status !== 'active') throw new AppError('This purchase is cancelled.');
    supplier = db.prepare('SELECT * FROM parties WHERE id = ?').get(pur.party_id);
    billType = pur.bill_type;
    interstate = Boolean(pur.is_interstate);
    pos = pur.place_of_supply_code;
    if (date < pur.entry_date) errors.date = 'The return date is before the purchase.';
  } else {
    if (!Number.isInteger(p.party_id)) fail({ party_id: 'Choose the supplier.' });
    supplier = db.prepare('SELECT * FROM parties WHERE id = ?').get(p.party_id);
    if (!supplier || supplier.is_deleted || supplier.type !== 'supplier') {
      fail({ party_id: 'Supplier not found.' });
    }
    billType = p.bill_type === 'non_gst' ? 'non_gst' : 'gst';
    const place = pu.placeOfSupply(supplier, s);
    interstate = place.interstate;
    pos = place.pos;
  }

  const raw = Array.isArray(p.lines) ? p.lines.filter((l) => l && l.qty_milli) : [];
  if (raw.length === 0) errors.lines = 'Choose what to return.';
  const items = pur ? new Map(pu.currentItems(db, pur).map((i) => [i.id, i])) : null;
  const usedSerials = new Set();
  const lines = raw.map((l, i) => {
    const f = (k) => `lines.${i}.${k}`;
    const item = items ? items.get(l.purchase_item_id) : null;
    const variantId = item ? item.variant_id : l.variant_id;
    const v = Number.isInteger(variantId) ? pu.loadVariantInfo(db, variantId) : null;
    const out = { index: i, item, v, qty_milli: l.qty_milli, serial_rows: [] };
    if (!v || (items && !item)) {
      errors[f('qty_milli')] = 'This line is not on the purchase.';
      return out;
    }
    if (!Number.isSafeInteger(l.qty_milli) || l.qty_milli <= 0) {
      errors[f('qty_milli')] = 'Enter the quantity.';
      return out;
    }
    const left = item ? item.qty_milli + item.free_qty_milli - returnedQty(db, item.id) : null;
    if (item && l.qty_milli > left) {
      errors[f('qty_milli')] =
        `Only ${left / 1000} ${item.unit} can still be returned from this bill.`;
    } else if (v.track_serials) {
      const ids = [...new Set((l.serial_ids || []).map(Number))];
      if (ids.length * 1000 !== l.qty_milli) {
        errors[f('serial_ids')] = `Pick ${l.qty_milli / 1000} serial number(s).`;
      }
      for (const id of ids) {
        const sr = db.prepare('SELECT * FROM product_serials WHERE id = ?').get(id);
        if (!sr || sr.variant_id !== v.id || !RETURNABLE.includes(sr.status)) {
          errors[f('serial_ids')] =
            `${sr ? sr.serial_no : 'A unit'} cannot be returned (not in stock / defective).`;
        } else if (item && sr.purchase_item_id !== item.id) {
          errors[f('serial_ids')] = `${sr.serial_no} was not received on this bill.`;
        } else if (usedSerials.has(id))
          errors[f('serial_ids')] = `${sr.serial_no} is picked twice.`;
        usedSerials.add(id);
        if (sr) out.serial_rows.push(sr);
      }
    } else if (l.qty_milli > variantStock(db, v.id)) {
      errors[f('qty_milli')] = `Only ${variantStock(db, v.id) / 1000} ${v.unit} in stock.`;
    }

    // Credit value: proportional by default, editable ("amount agreed with supplier").
    const suggested = item
      ? defaultTaxable(item, l.qty_milli)
      : billing.divRound((l.rate || 0) * l.qty_milli, 1000);
    const taxable = l.taxable == null ? suggested : l.taxable;
    if (!Number.isSafeInteger(taxable) || taxable < 0) errors[f('taxable')] = 'Invalid amount.';
    const rateBp = billType === 'gst' ? (item ? item.gst_rate_bp : l.gst_rate_bp) : 0;
    if (!item && billType === 'gst' && !settings.isActiveGstRate(db, rateBp)) {
      errors[f('gst_rate_bp')] = 'Choose a GST rate.';
    }
    if (!item && !(Number.isSafeInteger(l.rate) && l.rate >= 0))
      errors[f('rate')] = 'Enter the rate.';
    Object.assign(out, {
      default_taxable: suggested,
      taxable,
      gst_rate_bp: rateBp,
      rate: item
        ? billing.divRound(item.taxable * 1000, item.qty_milli + item.free_qty_milli)
        : l.rate,
      // Stock leaves at the cost it came in at (standalone: today's average).
      unit_cost: item ? item.unit_cost : v.avg_cost || v.purchase_price,
    });
    return out;
  });

  let refund = null;
  if (settlement === 'refund') {
    const r = payments.validatePayment({ amount: 1, ...p.refund }, 'refund');
    delete r.errors['refund.amount'];
    Object.assign(errors, r.errors);
    refund = r.data;
  }
  fail(errors);

  const calc = billing.calculateReturn({
    bill_type: billType,
    is_interstate: interstate,
    lines: lines.map((l) => ({ taxable: l.taxable, gst_rate_bp: l.gst_rate_bp })),
  });
  calc.lines.forEach((c, i) => Object.assign(lines[i], c, { taxable: lines[i].taxable }));
  return {
    pur,
    supplier,
    date,
    reason,
    settlement,
    refund,
    bill_type: billType,
    is_interstate: interstate,
    pos,
    lines,
    totals: calc.totals,
  };
}

function calculate(db, payload) {
  const b = build(db, payload);
  return {
    totals: b.totals,
    lines: b.lines.map((l) => ({
      default_taxable: l.default_taxable,
      taxable: l.taxable,
      cgst: l.cgst,
      sgst: l.sgst,
      igst: l.igst,
      line_total: l.line_total,
    })),
  };
}

function create(db, payload, ctx = {}) {
  const id = db.transaction(() => {
    const b = build(db, payload);
    const series = b.bill_type === 'gst' ? 'purchase_return_gst' : 'purchase_return_non_gst';
    const num = settings.takeNextNumber(db, series);
    const returnId = Number(
      db
        .prepare(
          `INSERT INTO purchase_returns (return_no, series, seq_no, purchase_id, party_id, supplier_name,
             supplier_gstin, date, bill_type, place_of_supply_code, is_interstate, taxable_total,
             cgst_total, sgst_total, igst_total, tax_total, round_off, total, settlement, reason)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          num.number,
          series,
          num.seq_no,
          b.pur ? b.pur.id : null,
          b.supplier.id,
          b.supplier.name,
          b.supplier.gstin || null,
          b.date,
          b.bill_type,
          b.pos,
          b.is_interstate ? 1 : 0,
          b.totals.taxable_total,
          b.totals.cgst_total,
          b.totals.sgst_total,
          b.totals.igst_total,
          b.totals.tax_total,
          b.totals.round_off,
          b.totals.total,
          b.settlement,
          b.reason || null,
        ).lastInsertRowid,
    );

    const insItem = db.prepare(
      `INSERT INTO purchase_return_items (purchase_return_id, purchase_item_id, product_id, variant_id,
         product_name, variant_label, unit, hsn_code, qty_milli, rate, gst_rate_bp, default_taxable,
         taxable, cgst, sgst, igst, line_total, unit_cost, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insSerial = db.prepare(
      'INSERT INTO purchase_return_serials (purchase_return_item_id, serial_id, from_status) VALUES (?, ?, ?)',
    );
    const setAvg = db.prepare('UPDATE product_variants SET avg_cost = ? WHERE id = ?');
    b.lines.forEach((l, i) => {
      const v = l.v;
      const itemId = Number(
        insItem.run(
          returnId,
          l.item ? l.item.id : null,
          v.product_id,
          v.id,
          v.product_name,
          variantLabel(v) || null,
          v.unit,
          v.hsn_code || null,
          l.qty_milli,
          l.rate,
          l.gst_rate_bp,
          l.default_taxable,
          l.taxable,
          l.cgst,
          l.sgst,
          l.igst,
          l.line_total,
          l.unit_cost,
          i,
        ).lastInsertRowid,
      );
      // Defective units already left stock when they were marked defective.
      const outMilli = v.track_serials
        ? l.serial_rows.filter((sr) => sr.status === 'in_stock').length * 1000
        : l.qty_milli;
      if (outMilli > 0) {
        const before = { stock_milli: variantStock(db, v.id), avg_cost: v.avg_cost };
        serials.insertMovement(db, {
          variant_id: v.id,
          date: b.date,
          type: 'purchase_return',
          qty_milli: -outMilli,
          unit_cost: l.unit_cost,
          ref_type: 'purchase_return_item',
          ref_id: itemId,
          reason: num.number,
        });
        setAvg.run(billing.averageOut(before, outMilli, l.unit_cost), v.id);
      }
      const defectiveOut = l.serial_rows.filter((sr) => sr.status === 'defective').length * 1000;
      if (defectiveOut > 0) {
        serials.insertMovement(db, {
          variant_id: v.id,
          date: b.date,
          type: 'purchase_return',
          location: 'defective',
          qty_milli: -defectiveOut,
          unit_cost: serials.defectiveUnitCost(db, v.id),
          ref_type: 'purchase_return_item',
          ref_id: itemId,
          reason: num.number,
        });
      }
      for (const sr of l.serial_rows) {
        insSerial.run(itemId, sr.id, sr.status);
        db.prepare("UPDATE product_serials SET status = 'returned_to_supplier' WHERE id = ?").run(
          sr.id,
        );
        serials.insertEvent(db, sr.id, {
          date: b.date,
          type: 'returned_to_supplier',
          from_status: sr.status,
          to_status: 'returned_to_supplier',
          ref_type: 'purchase_return',
          ref_id: returnId,
          note: num.number,
        });
      }
    });

    // Settlement: reduce what we owe on the bill, or the supplier pays the credit back.
    if (b.settlement === 'refund' && b.totals.total > 0) {
      const pay = payments.insertPayment(db, {
        direction: 'in',
        party_id: b.supplier.id,
        date: b.date,
        amount: b.totals.total,
        mode: b.refund.mode,
        ref_no: b.refund.ref_no,
        ref_type: 'purchase_return',
        ref_id: returnId,
        notes: `Refund for ${num.number}`,
      });
      void pay;
    } else if (b.pur) {
      const due = b.pur.grand_total - pu.paidOf(db, b.pur.id);
      payments.allocate(db, {
        party_id: b.supplier.id,
        doc_type: 'purchase',
        doc_id: b.pur.id,
        source_type: 'purchase_return',
        source_id: returnId,
        amount: Math.min(due, b.totals.total),
        date: b.date,
        note: num.number,
      });
    }
    pu.audit(db, {
      purchase_id: b.pur ? b.pur.id : null,
      purchase_return_id: returnId,
      action: 'return',
      actor: ctx.actor,
      summary: `Purchase return ${num.number}: ${b.lines.length} line(s), credit ${pu.money(b.totals.total)}${
        b.settlement === 'refund' ? ' (refund received)' : ''
      }`,
    });
    return returnId;
  })();
  return get(db, id);
}

function returnRow(db, id) {
  const r = db.prepare('SELECT * FROM purchase_returns WHERE id = ? AND is_deleted = 0').get(id);
  if (!r) throw new AppError('Purchase return not found.', 'NOT_FOUND');
  return r;
}

function get(db, id) {
  const r = returnRow(db, id);
  const lines = db
    .prepare(
      'SELECT * FROM purchase_return_items WHERE purchase_return_id = ? ORDER BY sort_order, id',
    )
    .all(id)
    .map((l) => ({
      ...l,
      serials: db
        .prepare(
          `SELECT s.id, s.serial_no, s.status, rs.from_status FROM purchase_return_serials rs
           JOIN product_serials s ON s.id = rs.serial_id WHERE rs.purchase_return_item_id = ?`,
        )
        .all(l.id),
    }));
  const purchase = r.purchase_id
    ? db
        .prepare('SELECT id, entry_no, bill_no, bill_date FROM purchases WHERE id = ?')
        .get(r.purchase_id)
    : null;
  const refund = db
    .prepare(
      "SELECT id, payment_no, amount, mode, ref_no, status FROM payments WHERE ref_type = 'purchase_return' AND ref_id = ?",
    )
    .get(id);
  return { ...r, lines, purchase, refund: refund || null };
}

function list(db, params = {}) {
  const where = ['r.is_deleted = 0'];
  const args = [];
  if (params.from && isISODate(params.from)) {
    where.push('r.date >= ?');
    args.push(params.from);
  }
  if (params.to && isISODate(params.to)) {
    where.push('r.date <= ?');
    args.push(params.to);
  }
  if (Number.isInteger(params.party_id)) {
    where.push('r.party_id = ?');
    args.push(params.party_id);
  }
  if (params.bill_type === 'gst' || params.bill_type === 'non_gst') {
    where.push('r.bill_type = ?');
    args.push(params.bill_type);
  }
  const q = str(params.search);
  if (q) {
    const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    where.push(`(r.return_no LIKE ? ESCAPE '\\' OR r.supplier_name LIKE ? ESCAPE '\\'
      OR pu.entry_no LIKE ? ESCAPE '\\' OR pu.bill_no LIKE ? ESCAPE '\\'
      OR EXISTS (SELECT 1 FROM purchase_return_items i WHERE i.purchase_return_id = r.id AND i.product_name LIKE ? ESCAPE '\\'))`);
    args.push(like, like, like, like, like);
  }
  return db
    .prepare(
      `SELECT r.id, r.return_no, r.date, r.party_id, r.supplier_name, r.bill_type, r.total, r.status,
         r.settlement, r.purchase_id, pu.entry_no, pu.bill_no,
         (SELECT COUNT(*) FROM purchase_return_items i WHERE i.purchase_return_id = r.id) AS item_count
       FROM purchase_returns r LEFT JOIN purchases pu ON pu.id = r.purchase_id
       WHERE ${where.join(' AND ')} ORDER BY r.date DESC, r.id DESC LIMIT 5000`,
    )
    .all(...args);
}

/** Cancels a debit note: stock and serials come back, its settlement is undone. */
function cancel(db, { id, reason }, ctx = {}) {
  const why = str(reason);
  if (!why) fail({ reason: 'A reason is required.' });
  db.transaction(() => {
    const r = returnRow(db, id);
    if (r.status !== 'active') throw new AppError('This return is already cancelled.');
    const setAvg = db.prepare('UPDATE product_variants SET avg_cost = ? WHERE id = ?');
    const lines = db
      .prepare('SELECT * FROM purchase_return_items WHERE purchase_return_id = ?')
      .all(id);
    for (const l of lines) {
      const v = pu.loadVariantInfo(db, l.variant_id);
      const rows = db
        .prepare(
          `SELECT s.*, rs.from_status FROM purchase_return_serials rs JOIN product_serials s ON s.id = rs.serial_id
           WHERE rs.purchase_return_item_id = ?`,
        )
        .all(l.id);
      for (const s of rows) {
        if (s.status !== 'returned_to_supplier') {
          throw new AppError(`Serial ${s.serial_no} has changed since the return; cannot cancel.`);
        }
      }
      const inMilli = v.track_serials
        ? rows.filter((s) => s.from_status === 'in_stock').length * 1000
        : l.qty_milli;
      if (inMilli > 0) {
        const before = { stock_milli: variantStock(db, v.id), avg_cost: v.avg_cost };
        serials.insertMovement(db, {
          variant_id: v.id,
          date: todayISO(),
          type: 'purchase_return',
          qty_milli: inMilli,
          unit_cost: l.unit_cost,
          ref_type: 'purchase_return_item',
          ref_id: l.id,
          reason: `${r.return_no}: cancelled`,
        });
        setAvg.run(
          billing.averageIn(before, inMilli, billing.divRound(l.unit_cost * inMilli, 1000)),
          v.id,
        );
      }
      const defectiveBack = rows.filter((s) => s.from_status === 'defective').length * 1000;
      if (defectiveBack > 0) {
        serials.insertMovement(db, {
          variant_id: v.id,
          date: todayISO(),
          type: 'purchase_return',
          location: 'defective',
          qty_milli: defectiveBack,
          unit_cost: l.unit_cost,
          ref_type: 'purchase_return_item',
          ref_id: l.id,
          reason: `${r.return_no}: cancelled`,
        });
      }
      for (const s of rows) {
        db.prepare('UPDATE product_serials SET status = ? WHERE id = ?').run(s.from_status, s.id);
        serials.insertEvent(db, s.id, {
          type: 'return_cancelled',
          from_status: 'returned_to_supplier',
          to_status: s.from_status,
          ref_type: 'purchase_return',
          ref_id: r.id,
          note: `${r.return_no} cancelled: ${why}`,
        });
      }
    }
    db.prepare(
      `UPDATE purchase_returns SET status = 'cancelled', cancel_reason = ?,
         cancelled_at = strftime('%Y-%m-%d %H:%M:%S','now','localtime') WHERE id = ?`,
    ).run(why, id);
    payments.releaseAllocations(db, { source_type: 'purchase_return', source_id: id });
    const refund = db
      .prepare(
        "SELECT id FROM payments WHERE ref_type = 'purchase_return' AND ref_id = ? AND status = 'active'",
      )
      .pluck()
      .get(id);
    if (refund) payments.cancelPayment(db, refund, `${r.return_no} cancelled: ${why}`);
    pu.audit(db, {
      purchase_id: r.purchase_id,
      purchase_return_id: r.id,
      action: 'return_cancelled',
      actor: ctx.actor,
      summary: `Purchase return ${r.return_no} cancelled: ${why}`,
    });
  })();
  return get(db, id);
}

module.exports = { prepare, calculate, create, get, list, cancel, returnedQty, defaultTaxable };
