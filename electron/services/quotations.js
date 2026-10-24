'use strict';

// Quotations (QT-0001): the billing screen in "Quotation" mode. Same maths as a bill, no stock
// or ledger effect, a valid-till date. "Convert to bill" goes through sales.prefill (which
// re-checks stock, prices and asks for serial numbers) and sales.create({ quotation_id }).

const { AppError } = require('../errors');
const { isISODate, todayISO, str } = require('./parse');
const settings = require('./settings');
const sales = require('./sales');
const { variantLabel } = require('./products');
const { amountInWords } = require('./words');

function quotationRow(db, quotationId) {
  const q = db.prepare('SELECT * FROM quotations WHERE id = ? AND is_deleted = 0').get(quotationId);
  if (!q) throw new AppError('Quotation not found.', 'NOT_FOUND');
  return q;
}

function create(db, payload, ctx = {}) {
  const p = payload || {};
  const quotationId = db.transaction(() => {
    // Quotations are often dated ahead / back: no date confirmation needed.
    const v = sales.validate(db, { ...p, confirm_date: true }, { kind: 'quotation' });
    const num = settings.takeNextNumber(db, 'quotation');
    const h = v.header;
    const qid = Number(
      db
        .prepare(
          `INSERT INTO quotations (quote_no, seq_no, quote_date, valid_till, bill_type, price_mode,
             party_id, customer_name, customer_phone, customer_address, customer_gstin,
             customer_state_code, place_of_supply_code, is_interstate, vehicle_id, vehicle_no,
             vehicle_no_key, vehicle_model, sub_total, item_discount_total, bill_discount_bp,
             bill_discount, taxable_total, cgst_total, sgst_total, igst_total, tax_total, round_off,
             grand_total, goods_total, services_total, notes)
           VALUES (@quote_no, @seq_no, @date, @valid_till, @bill_type, @price_mode, @party_id,
             @customer_name, @customer_phone, @customer_address, @customer_gstin,
             @customer_state_code, @place_of_supply_code, @is_interstate, @vehicle_id, @vehicle_no,
             @vehicle_no_key, @vehicle_model, @sub_total, @item_discount_total, @bill_discount_bp,
             @bill_discount, @taxable_total, @cgst_total, @sgst_total, @igst_total, @tax_total,
             @round_off, @grand_total, @goods_total, @services_total, @notes)`,
        )
        .run({
          date: h.date,
          valid_till: h.valid_till,
          bill_type: h.bill_type,
          price_mode: h.price_mode,
          party_id: h.party_id,
          customer_name: h.customer_name,
          customer_phone: h.customer_phone,
          customer_address: h.customer_address,
          customer_gstin: h.customer_gstin,
          customer_state_code: h.customer_state_code,
          place_of_supply_code: h.place_of_supply_code,
          is_interstate: h.is_interstate,
          vehicle_id: h.vehicle_id,
          vehicle_no: h.vehicle_no,
          vehicle_no_key: h.vehicle_no_key,
          vehicle_model: h.vehicle_model,
          sub_total: h.sub_total,
          item_discount_total: h.item_discount_total,
          bill_discount_bp: h.bill_discount_bp,
          bill_discount: h.bill_discount,
          taxable_total: h.taxable_total,
          cgst_total: h.cgst_total,
          sgst_total: h.sgst_total,
          igst_total: h.igst_total,
          tax_total: h.tax_total,
          round_off: h.round_off,
          grand_total: h.grand_total,
          goods_total: h.goods_total,
          services_total: h.services_total,
          notes: h.notes,
          quote_no: num.number,
          seq_no: num.seq_no,
        }).lastInsertRowid,
    );
    const ins = db.prepare(
      `INSERT INTO quotation_items (quotation_id, product_id, variant_id, item_type, product_name,
         variant_label, sku, unit, hsn_code, qty_milli, rate, mrp, discount_bp, discount,
         bill_discount_share, gst_rate_bp, taxable, cgst, sgst, igst, line_total, warranty_months,
         fitting_merged, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const ids = v.items.map((l, i) =>
      Number(
        ins.run(
          qid,
          l.v.product_id,
          l.v.id,
          l.item_type,
          l.v.product_name,
          variantLabel(l.v) || null,
          l.v.sku,
          l.v.unit,
          l.v.hsn_code || null,
          l.qty_milli,
          l.rate,
          l.v.mrp,
          l.discount_bp,
          l.discount,
          l.bill_discount_share,
          l.gst_rate_bp,
          l.taxable,
          l.cgst,
          l.sgst,
          l.igst,
          l.line_total,
          l.warranty_months,
          l.fitting_merged ? 1 : 0,
          i,
        ).lastInsertRowid,
      ),
    );
    const link = db.prepare('UPDATE quotation_items SET fitting_for_item_id = ? WHERE id = ?');
    v.items.forEach((l, i) => {
      if (l.fitting_for != null) link.run(ids[l.fitting_for], ids[i]);
    });
    sales.audit(db, {
      quotation_id: qid,
      action: 'quotation_created',
      actor: ctx.actor,
      summary: `Quotation ${num.number} for ${h.customer_name}: ${v.items.length} line(s), ${sales.money(h.grand_total)}, valid till ${h.valid_till}`,
    });
    if (Number.isInteger(p.draft_id)) {
      db.prepare(
        "UPDATE sale_drafts SET status = 'saved', quotation_id = ? WHERE id = ? AND status = 'open'",
      ).run(qid, p.draft_id);
    }
    return qid;
  })();
  return get(db, quotationId);
}

function statusOf(q, today = todayISO()) {
  if (q.status === 'open' && q.valid_till < today) return 'expired';
  return q.status;
}

function get(db, quotationId) {
  const q = quotationRow(db, quotationId);
  const items = db
    .prepare('SELECT * FROM quotation_items WHERE quotation_id = ? ORDER BY sort_order, id')
    .all(q.id);
  const summary = new Map();
  for (const x of items) {
    const r = summary.get(x.gst_rate_bp) || {
      gst_rate_bp: x.gst_rate_bp,
      taxable: 0,
      cgst: 0,
      sgst: 0,
      igst: 0,
    };
    r.taxable += x.taxable;
    r.cgst += x.cgst;
    r.sgst += x.sgst;
    r.igst += x.igst;
    summary.set(x.gst_rate_bp, r);
  }
  const converted = q.converted_sale_id
    ? db.prepare('SELECT id, invoice_no FROM sales WHERE id = ?').get(q.converted_sale_id)
    : null;
  const auditRows = db
    .prepare('SELECT * FROM sale_audit WHERE quotation_id = ? ORDER BY id DESC')
    .all(q.id);
  return {
    ...q,
    display_status: statusOf(q),
    items,
    tax_summary: [...summary.values()].sort((a, b) => a.gst_rate_bp - b.gst_rate_bp),
    converted_sale: converted || null,
    audit: auditRows,
    amount_in_words: amountInWords(q.grand_total),
  };
}

function list(db, params = {}) {
  const where = ['q.is_deleted = 0'];
  const args = [];
  if (params.from && isISODate(params.from)) {
    where.push('q.quote_date >= ?');
    args.push(params.from);
  }
  if (params.to && isISODate(params.to)) {
    where.push('q.quote_date <= ?');
    args.push(params.to);
  }
  if (params.bill_type === 'gst' || params.bill_type === 'non_gst') {
    where.push('q.bill_type = ?');
    args.push(params.bill_type);
  }
  if (Number.isInteger(params.party_id)) {
    where.push('q.party_id = ?');
    args.push(params.party_id);
  }
  const q = str(params.search);
  if (q) {
    const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    where.push(`(q.quote_no LIKE ? ESCAPE '\\' OR q.customer_name LIKE ? ESCAPE '\\'
      OR q.customer_phone LIKE ? ESCAPE '\\' OR q.vehicle_no_key LIKE ? ESCAPE '\\'
      OR EXISTS (SELECT 1 FROM quotation_items i WHERE i.quotation_id = q.id AND i.product_name LIKE ? ESCAPE '\\'))`);
    args.push(like, like, like, `%${q.toUpperCase().replace(/[^A-Z0-9]/g, '')}%`, like);
  }
  const today = todayISO();
  const rows = db
    .prepare(
      `SELECT q.id, q.quote_no, q.quote_date, q.valid_till, q.bill_type, q.party_id, q.customer_name,
         q.customer_phone, q.vehicle_no, q.grand_total, q.status, q.converted_sale_id,
         s.invoice_no AS converted_invoice_no,
         (SELECT COUNT(*) FROM quotation_items i WHERE i.quotation_id = q.id) AS item_count
       FROM quotations q LEFT JOIN sales s ON s.id = q.converted_sale_id
       WHERE ${where.join(' AND ')} ORDER BY q.quote_date DESC, q.id DESC LIMIT 5000`,
    )
    .all(...args)
    .map((r) => ({ ...r, display_status: statusOf(r, today) }));
  return { rows, total: rows.length, truncated: rows.length === 5000 };
}

function cancel(db, { id: quotationId, reason }, ctx = {}) {
  const why = str(reason);
  if (!why) throw new AppError('A reason is required.', 'VALIDATION', { reason: 'Required.' });
  db.transaction(() => {
    const q = quotationRow(db, quotationId);
    if (q.status !== 'open') throw new AppError('Only an open quotation can be cancelled.');
    db.prepare(
      `UPDATE quotations SET status = 'cancelled', cancel_reason = ?,
         cancelled_at = strftime('%Y-%m-%d %H:%M:%S','now','localtime') WHERE id = ?`,
    ).run(why, q.id);
    sales.audit(db, {
      quotation_id: q.id,
      action: 'quotation_cancelled',
      actor: ctx.actor,
      summary: `Cancelled: ${why}`,
    });
  })();
  return get(db, quotationId);
}

module.exports = { create, get, list, cancel, statusOf };
