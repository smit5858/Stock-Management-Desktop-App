'use strict';

// Sale returns (credit notes): CN-GST-0001 against GST invoices, CN-EST-0001 against non-GST
// bills. From a bill, or standalone with a customer. Each line credits its share of the
// original line (tax reversed at the original rate and value); stock comes back at the
// original sale cost. Serial units go back to stock or to defective (the user chooses) and
// their warranty is voided. "Exchange" = a credit note + a new bill in one transaction.

const { AppError } = require('../errors');
const { isISODate, todayISO, str } = require('./parse');
const settings = require('./settings');
const serials = require('./serials');
const payments = require('./payments');
const billing = require('./billing');
const { variantLabel, variantStock } = require('./products');
const sales = require('./sales');
const { amountInWords } = require('./words');
const { warrantyStatus } = require('./warranty');

const SERIES = { gst: 'sale_return_gst', non_gst: 'sale_return_non_gst' };

function fail(errors) {
  const keys = Object.keys(errors);
  if (keys.length) throw new AppError(`Please check: ${errors[keys[0]]}`, 'VALIDATION', errors);
}

/** Amounts of a sale line already credited on active credit notes. */
function creditedOf(db, saleItemId) {
  return db
    .prepare(
      `SELECT COALESCE(SUM(ri.qty_milli), 0) AS qty_milli, COALESCE(SUM(ri.taxable), 0) AS taxable,
         COALESCE(SUM(ri.cgst), 0) AS cgst, COALESCE(SUM(ri.sgst), 0) AS sgst,
         COALESCE(SUM(ri.igst), 0) AS igst
       FROM sale_return_items ri JOIN sale_returns r ON r.id = ri.sale_return_id
       WHERE ri.sale_item_id = ? AND r.status = 'active' AND r.is_deleted = 0`,
    )
    .get(saleItemId);
}

/** Serial units of a line that are still with the customer (returnable). */
function soldUnits(db, saleItemId) {
  return db
    .prepare(
      `SELECT ps.id, ps.serial_no, ps.serial_no_2, ps.status, x.warranty_end, x.id AS link_id,
         ps.warranty_void_reason,
         (SELECT c.claim_no FROM warranty_claims c WHERE c.serial_id = ps.id AND c.is_deleted = 0
            AND c.status NOT IN ('closed','cancelled') LIMIT 1) AS open_claim_no
       FROM sale_item_serials x JOIN product_serials ps ON ps.id = x.serial_id
       WHERE x.sale_item_id = ? AND x.status = 'sold' AND ps.status = 'sold' AND ps.sale_item_id = ?
       ORDER BY x.id`,
    )
    .all(saleItemId, saleItemId);
}

/** Claim no. of an open warranty claim on this serial (other than `exceptClaimId`), or null. */
function openClaimOf(db, { serial_id: serialId }, exceptClaimId = null) {
  return db
    .prepare(
      `SELECT claim_no FROM warranty_claims WHERE serial_id = ? AND is_deleted = 0
         AND status NOT IN ('closed','cancelled') AND id IS NOT ? LIMIT 1`,
    )
    .pluck()
    .get(serialId, Number.isInteger(exceptClaimId) ? exceptClaimId : null);
}

/** Quantity of a non-serial bill line under open warranty claims (other than `exceptClaimId`). */
function openClaimQty(db, saleItemId, exceptClaimId = null) {
  return db
    .prepare(
      `SELECT COALESCE(SUM(qty_milli), 0) FROM warranty_claims WHERE sale_item_id = ? AND serial_id IS NULL
         AND is_deleted = 0 AND status NOT IN ('closed','cancelled') AND id IS NOT ?`,
    )
    .pluck()
    .get(saleItemId, Number.isInteger(exceptClaimId) ? exceptClaimId : null);
}

/** Bills to return against: invoice no., serial, phone, plate, customer or product. */
function find(db, { query }) {
  const q = str(query);
  if (q.length < 2) return [];
  return sales.list(db, { search: q, status: 'active' }).rows.slice(0, 20);
}

/** What can be returned from a bill: lines with remaining qty, serials with the customer. */
function prepare(db, { sale_id: saleId }) {
  const sale = sales.saleRow(db, saleId);
  if (sale.status !== 'active') throw new AppError('This bill is cancelled.');
  const items = sales.itemsOf(db, sale.id);
  const lines = items.map((it) => {
    const v = sales.loadVariantInfo(db, it.variant_id);
    const done = creditedOf(db, it.id);
    const units = it.item_type === 'goods' && v.track_serials ? soldUnits(db, it.id) : null;
    const left = it.qty_milli - done.qty_milli;
    return {
      sale_item_id: it.id,
      variant_id: it.variant_id,
      item_type: it.item_type,
      product_name: it.product_name,
      variant_label: it.variant_label,
      unit: it.unit,
      hsn_code: it.hsn_code,
      gst_rate_bp: it.gst_rate_bp,
      qty_milli: it.qty_milli,
      rate: it.rate,
      taxable: it.taxable,
      line_total: it.line_total,
      unit_value: billing.divRound(it.line_total * 1000, it.qty_milli), // incl. tax, per unit
      returned_milli: done.qty_milli,
      returnable_milli: units ? Math.min(left, units.length * 1000) : left,
      track_serials: Boolean(units),
      // Warranty status of each unit (the return screen shows it when a serial is looked up).
      serials: units
        ? units.map((u) => ({
            ...u,
            warranty: u.warranty_void_reason
              ? { status: 'void', days_left: null }
              : warrantyStatus(u.warranty_end, todayISO()),
          }))
        : null,
      fitting_for_item_id: it.fitting_for_item_id,
      fitted_by: it.fitted_by,
      warranty_end: it.warranty_end,
    };
  });
  const paid = sales.paidOf(db, sale.id);
  const customer = db
    .prepare('SELECT id, name, is_system FROM parties WHERE id = ?')
    .get(sale.party_id);
  return {
    sale: {
      id: sale.id,
      invoice_no: sale.invoice_no,
      invoice_date: sale.invoice_date,
      bill_type: sale.bill_type,
      is_interstate: sale.is_interstate,
      party_id: sale.party_id,
      customer_name: sale.customer_name,
      vehicle_no: sale.vehicle_no,
      grand_total: sale.grand_total,
      paid,
      due: sale.grand_total - paid,
      is_cash: Boolean(customer && customer.is_system),
    },
    lines,
  };
}

/**
 * payload: { sale_id | null, party_id + bill_type + price_mode (standalone), date, reason,
 *   settlement: 'adjust' | 'refund' | 'exchange', refund: { mode, ref_no },
 *   lines: [{ sale_item_id, qty_milli, serials: [{ id, to_status }] }   (from a bill)
 *         | { variant_id, qty_milli, rate, gst_rate_bp }               (standalone) ] }
 */
function build(db, payload, { exchange = false } = {}) {
  const p = payload || {};
  const errors = {};
  const s = settings.getSettings(db);
  const date = p.date || todayISO();
  if (!isISODate(date)) errors.date = 'Invalid date.';
  if (date > todayISO()) errors.date = 'The return date is in the future.';
  const reason = str(p.reason);
  if (reason.length > 200) errors.reason = 'Reason is too long (max 200).';
  const settlement = exchange ? 'exchange' : p.settlement === 'refund' ? 'refund' : 'adjust';

  let sale = null;
  let customer;
  let billType;
  let interstate;
  let pos;
  if (Number.isInteger(p.sale_id)) {
    sale = sales.saleRow(db, p.sale_id);
    if (sale.status !== 'active') throw new AppError('This bill is cancelled.');
    customer = db.prepare('SELECT * FROM parties WHERE id = ?').get(sale.party_id);
    billType = sale.bill_type;
    interstate = Boolean(sale.is_interstate);
    pos = sale.place_of_supply_code;
    if (isISODate(date) && date < sale.invoice_date)
      errors.date = 'The return date is before the bill.';
  } else {
    if (!Number.isInteger(p.party_id)) fail({ party_id: 'Choose the customer.' });
    customer = sales.customerRow(db, p.party_id);
    billType = sales.effectiveBillType(p.bill_type, s);
    const place = sales.placeOfSupply(customer, s);
    interstate = place.interstate;
    pos = place.pos;
  }

  const raw = Array.isArray(p.lines) ? p.lines.filter((l) => l && l.qty_milli) : [];
  if (raw.length === 0) errors.lines = 'Choose what is being returned.';
  const items = sale ? new Map(sales.itemsOf(db, sale.id).map((i) => [i.id, i])) : null;
  const usedSerials = new Set();
  const seenItems = new Set();
  const lines = raw.map((l, i) => {
    const f = (k) => `lines.${i}.${k}`;
    const item = items ? items.get(l.sale_item_id) : null;
    const variantId = item ? item.variant_id : l.variant_id;
    const v = Number.isInteger(variantId) ? sales.loadVariantInfo(db, variantId) : null;
    const out = { index: i, item, v, qty_milli: l.qty_milli, serial_rows: [] };
    if (!v || (items && !item)) {
      errors[f('qty_milli')] = 'This line is not on the bill.';
      return out;
    }
    if (item && seenItems.has(item.id)) errors[f('qty_milli')] = 'This line is listed twice.';
    if (item) seenItems.add(item.id);
    out.item_type = item ? item.item_type : v.product_type === 'service' ? 'service' : 'goods';
    if (!Number.isSafeInteger(l.qty_milli) || l.qty_milli <= 0) {
      errors[f('qty_milli')] = 'Enter the quantity.';
      return out;
    }

    if (item) {
      const done = creditedOf(db, item.id);
      const left = item.qty_milli - done.qty_milli;
      if (l.qty_milli > left) {
        errors[f('qty_milli')] =
          left > 0
            ? `Only ${left / 1000} ${item.unit} can still be returned from this bill.`
            : 'Already fully returned.';
        return out;
      }
      if (!v.track_serials) {
        const claimed = openClaimQty(db, item.id, p.claim_id);
        if (claimed > 0 && l.qty_milli > left - claimed) {
          errors[f('qty_milli')] =
            `${claimed / 1000} ${item.unit} of this line is under a warranty claim. Refund it from the claim.`;
          return out;
        }
      }
      if (out.item_type === 'goods' && v.track_serials) {
        const picked = Array.isArray(l.serials) ? l.serials : [];
        if (picked.length * 1000 !== l.qty_milli) {
          errors[f('serials')] = `Pick ${l.qty_milli / 1000} serial number(s).`;
        }
        const allowed = new Map(soldUnits(db, item.id).map((u) => [u.id, u]));
        for (const x of picked) {
          const u = allowed.get(Number(x.id));
          if (!u) errors[f('serials')] = 'A picked serial number was not sold on this line.';
          else if (usedSerials.has(u.id)) errors[f('serials')] = `${u.serial_no} is picked twice.`;
          else if (openClaimOf(db, { serial_id: u.id }, p.claim_id)) {
            errors[f('serials')] =
              `${u.serial_no} has an open warranty claim (${openClaimOf(db, { serial_id: u.id }, p.claim_id)}). Refund it from the claim.`;
          } else {
            usedSerials.add(u.id);
            out.serial_rows.push({
              ...u,
              to_status: x.to_status === 'defective' ? 'defective' : 'in_stock',
            });
          }
        }
      }
      Object.assign(
        out,
        billing.proportionalLine(
          item,
          l.qty_milli,
          {
            taxable: item.taxable - done.taxable,
            cgst: item.cgst - done.cgst,
            sgst: item.sgst - done.sgst,
            igst: item.igst - done.igst,
          },
          done.qty_milli + l.qty_milli === item.qty_milli,
        ),
      );
      out.gst_rate_bp = item.gst_rate_bp;
      out.unit_cost = item.unit_cost;
      out.rate = billing.divRound(out.taxable * 1000, l.qty_milli);
    } else {
      if (out.item_type === 'goods' && v.track_serials) {
        errors[f('qty_milli')] =
          'Serial-numbered items are returned from their bill (search the bill by serial number).';
        return out;
      }
      if (!Number.isSafeInteger(l.rate) || l.rate < 0) errors[f('rate')] = 'Enter the rate.';
      const rateBp = billType === 'gst' ? l.gst_rate_bp : 0;
      if (billType === 'gst' && !(rateBp === 0 || settings.isActiveGstRate(db, rateBp))) {
        errors[f('gst_rate_bp')] = 'Choose a GST rate.';
      }
      const amount = billing.divRound(l.qty_milli * (l.rate || 0), 1000);
      const t = billing.taxOn(amount, {
        gst: billType === 'gst',
        inclusive: p.price_mode !== 'exclusive',
        interstate,
        rateBp: rateBp || 0,
      });
      Object.assign(out, {
        taxable: t.taxable,
        cgst: t.cgst,
        sgst: t.sgst,
        igst: t.igst,
        line_total: t.total,
        gst_rate_bp: rateBp || 0,
        unit_cost: out.item_type === 'goods' ? v.avg_cost || v.purchase_price : 0,
        rate: billing.divRound(t.taxable * 1000, l.qty_milli),
      });
    }
    return out;
  });

  let refund = null;
  if (settlement === 'refund' || (exchange && p.refund && p.refund.mode)) {
    const r = payments.validatePayment({ amount: 1, ...p.refund }, 'refund');
    delete r.errors['refund.amount'];
    Object.assign(errors, r.errors);
    refund = r.data;
  }
  fail(errors);

  const totals = billing.returnTotals(lines);
  // The credit first reduces what is still due on the bill; the rest is refunded / kept.
  const due = sale ? Math.max(sale.grand_total - sales.paidOf(db, sale.id), 0) : 0;
  const toBill = settlement === 'exchange' ? 0 : Math.min(due, totals.total);
  const rest = totals.total - toBill;
  if (!exchange && customer.is_system && settlement === 'adjust' && rest > 0) {
    fail({ settlement: 'Cash Customer cannot keep an advance: choose a refund.' });
  }
  return {
    sale,
    customer,
    date,
    reason,
    settlement,
    refund,
    bill_type: billType,
    is_interstate: interstate,
    pos,
    lines,
    totals,
    to_bill: toBill,
    refund_amount: settlement === 'refund' ? rest : 0,
    to_advance: settlement === 'adjust' ? rest : 0,
  };
}

function calculate(db, payload) {
  const b = build(db, payload, { exchange: payload && payload.settlement === 'exchange' });
  return {
    totals: b.totals,
    to_bill: b.to_bill,
    refund_amount: b.refund_amount,
    to_advance: b.to_advance,
    amount_in_words: amountInWords(b.totals.total),
    lines: b.lines.map((l) => ({
      taxable: l.taxable,
      cgst: l.cgst,
      sgst: l.sgst,
      igst: l.igst,
      line_total: l.line_total,
    })),
  };
}

/** Inside a transaction: writes the credit note `b`. Returns { id, return_no, total }. */
function insertReturn(db, b, ctx) {
  const series = SERIES[b.bill_type];
  const num = settings.takeNextNumber(db, series);
  const returnId = Number(
    db
      .prepare(
        `INSERT INTO sale_returns (return_no, series, seq_no, sale_id, party_id, customer_name,
           customer_phone, customer_gstin, date, bill_type, place_of_supply_code, is_interstate,
           taxable_total, cgst_total, sgst_total, igst_total, tax_total, round_off, total,
           settlement, reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        num.number,
        series,
        num.seq_no,
        b.sale ? b.sale.id : null,
        b.customer.id,
        b.sale ? b.sale.customer_name : b.customer.name,
        b.sale ? b.sale.customer_phone : b.customer.phone,
        b.sale ? b.sale.customer_gstin : b.customer.gstin,
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
    `INSERT INTO sale_return_items (sale_return_id, sale_item_id, product_id, variant_id, item_type,
       product_name, variant_label, unit, hsn_code, qty_milli, rate, gst_rate_bp, taxable, cgst,
       sgst, igst, line_total, unit_cost, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        l.item_type,
        l.item ? l.item.product_name : v.product_name,
        l.item ? l.item.variant_label : variantLabel(v) || null,
        l.item ? l.item.unit : v.unit,
        l.item ? l.item.hsn_code : v.hsn_code || null,
        l.qty_milli,
        l.rate,
        l.gst_rate_bp,
        l.taxable,
        l.cgst,
        l.sgst,
        l.igst,
        l.line_total,
        l.unit_cost,
        i,
      ).lastInsertRowid,
    );
    if (l.item_type !== 'goods') return;
    // Defective serial units do not come back into saleable stock.
    const inMilli = v.track_serials
      ? l.serial_rows.filter((u) => u.to_status === 'in_stock').length * 1000
      : l.qty_milli;
    const defectiveMilli = v.track_serials
      ? l.serial_rows.filter((u) => u.to_status === 'defective').length * 1000
      : 0;
    if (defectiveMilli > 0) {
      serials.insertMovement(db, {
        variant_id: v.id,
        date: b.date,
        type: 'sale_return',
        location: 'defective',
        qty_milli: defectiveMilli,
        unit_cost: l.unit_cost,
        ref_type: 'sale_return_item',
        ref_id: itemId,
        reason: `${num.number} (defective)`,
      });
    }
    if (inMilli > 0) {
      const before = { stock_milli: variantStock(db, v.id), avg_cost: v.avg_cost };
      serials.insertMovement(db, {
        variant_id: v.id,
        date: b.date,
        type: 'sale_return',
        qty_milli: inMilli,
        unit_cost: l.unit_cost,
        ref_type: 'sale_return_item',
        ref_id: itemId,
        reason: num.number,
      });
      setAvg.run(
        billing.averageIn(before, inMilli, billing.divRound(l.unit_cost * inMilli, 1000)),
        v.id,
      );
    }
    for (const u of l.serial_rows) {
      db.prepare(
        `UPDATE product_serials SET status = ?, sale_id = NULL, sale_item_id = NULL, sale_date = NULL,
           customer_party_id = NULL, warranty_start = NULL, warranty_end = NULL, warranty_overridden = 0
         WHERE id = ?`,
      ).run(u.to_status, u.id);
      db.prepare(
        "UPDATE sale_item_serials SET status = 'returned', sale_return_item_id = ? WHERE id = ?",
      ).run(itemId, u.link_id);
      db.prepare(
        'INSERT INTO sale_return_serials (sale_return_item_id, serial_id, to_status) VALUES (?, ?, ?)',
      ).run(itemId, u.id, u.to_status);
      serials.insertEvent(db, u.id, {
        date: b.date,
        type: 'returned_by_customer',
        from_status: 'sold',
        to_status: u.to_status,
        ref_type: 'sale_return',
        ref_id: returnId,
        note: `${num.number}${b.sale ? ` against ${b.sale.invoice_no}` : ''} (warranty voided)`,
      });
    }
  });

  if (b.to_bill > 0) {
    payments.allocate(db, {
      party_id: b.customer.id,
      doc_type: 'sale',
      doc_id: b.sale.id,
      source_type: 'sale_return',
      source_id: returnId,
      amount: b.to_bill,
      date: b.date,
      note: num.number,
    });
  }
  if (b.refund_amount > 0) {
    const pay = payments.insertPayment(db, {
      direction: 'out',
      party_id: b.customer.id,
      date: b.date,
      amount: b.refund_amount,
      mode: b.refund.mode,
      ref_no: b.refund.ref_no,
      ref_type: 'sale_return',
      ref_id: returnId,
      notes: `Refund for ${num.number}`,
    });
    void pay;
  }
  const parts = [];
  if (b.to_bill) parts.push(`${sales.money(b.to_bill)} off the bill's due`);
  if (b.refund_amount) parts.push(`${sales.money(b.refund_amount)} refunded`);
  if (b.to_advance) parts.push(`${sales.money(b.to_advance)} kept as advance`);
  sales.audit(db, {
    sale_id: b.sale ? b.sale.id : null,
    sale_return_id: returnId,
    action: 'return',
    actor: ctx.actor,
    summary: `Credit note ${num.number}: ${b.lines.length} line(s), ${sales.money(b.totals.total)}${
      parts.length ? ` (${parts.join(', ')})` : ''
    }${b.reason ? `. Reason: ${b.reason}` : ''}`,
  });
  return { id: returnId, return_no: num.number, total: b.totals.total };
}

function create(db, payload, ctx = {}) {
  const returnId = db.transaction(() => insertReturn(db, build(db, payload), ctx).id)();
  return get(db, returnId);
}

/**
 * Exchange: the returned items are credited and a new bill is made, in ONE transaction. The
 * credit is paid towards the new bill; the customer pays only the difference (payments of the
 * new bill) or gets the difference back (`sale_return.refund`, or advance for named customers).
 */
function exchange(db, { sale_return: returnPayload, sale: salePayload }, ctx = {}) {
  const result = db.transaction(() => {
    const b = build(db, returnPayload, { exchange: true });
    const v = sales.validate(db, salePayload, { kind: 'bill', exchange_credit: b.totals.total });
    if (v.header.party_id !== b.customer.id) {
      fail({ party_id: 'The new bill must be for the same customer as the return.' });
    }
    const r = insertReturn(db, b, ctx);
    const saleId = sales.insertSale(db, v, ctx, {
      exchange: { return_id: r.id, return_no: r.return_no, credit: r.total },
      draft_id: salePayload.draft_id,
    });
    db.prepare('UPDATE sale_returns SET exchange_sale_id = ? WHERE id = ?').run(saleId, r.id);
    const diff = r.total - v.header.grand_total;
    if (diff > 0) {
      if (b.refund) {
        payments.insertPayment(db, {
          direction: 'out',
          party_id: b.customer.id,
          date: b.date,
          amount: diff,
          mode: b.refund.mode,
          ref_no: b.refund.ref_no,
          ref_type: 'sale_return',
          ref_id: r.id,
          notes: `Exchange difference refunded (${r.return_no})`,
        });
      } else if (b.customer.is_system) {
        fail({ 'refund.mode': `Refund the difference of ${sales.money(diff)} to the customer.` });
      }
    }
    const sale = sales.saleRow(db, saleId);
    sales.audit(db, {
      sale_id: saleId,
      sale_return_id: r.id,
      action: 'exchange',
      actor: ctx.actor,
      summary: `Exchange: ${r.return_no} (${sales.money(r.total)}) → ${sale.invoice_no} (${sales.money(sale.grand_total)}). ${
        diff > 0
          ? `${sales.money(diff)} ${b.refund ? 'refunded' : 'kept as advance'}`
          : diff < 0
            ? `Customer pays ${sales.money(-diff)}`
            : 'No difference'
      }`,
    });
    return { sale_id: saleId, return_id: r.id };
  })();
  return { sale: sales.get(db, result.sale_id), sale_return: get(db, result.return_id) };
}

function returnRow(db, returnId) {
  const r = db.prepare('SELECT * FROM sale_returns WHERE id = ? AND is_deleted = 0').get(returnId);
  if (!r) throw new AppError('Credit note not found.', 'NOT_FOUND');
  return r;
}

function get(db, returnId) {
  const r = returnRow(db, returnId);
  const lines = db
    .prepare('SELECT * FROM sale_return_items WHERE sale_return_id = ? ORDER BY sort_order, id')
    .all(r.id)
    .map((l) => ({
      ...l,
      serials: db
        .prepare(
          `SELECT s.id, s.serial_no, s.status, rs.to_status FROM sale_return_serials rs
           JOIN product_serials s ON s.id = rs.serial_id WHERE rs.sale_return_item_id = ?`,
        )
        .all(l.id),
    }));
  const sale = r.sale_id
    ? db.prepare('SELECT id, invoice_no, invoice_date FROM sales WHERE id = ?').get(r.sale_id)
    : null;
  const exchangeSale = r.exchange_sale_id
    ? db
        .prepare('SELECT id, invoice_no, grand_total FROM sales WHERE id = ?')
        .get(r.exchange_sale_id)
    : null;
  const refunds = db
    .prepare(
      "SELECT id, payment_no, amount, mode, ref_no, status FROM payments WHERE ref_type = 'sale_return' AND ref_id = ? ORDER BY id",
    )
    .all(r.id);
  const allocations = db
    .prepare(
      `SELECT a.amount, a.doc_id, s.invoice_no FROM bill_allocations a JOIN sales s ON s.id = a.doc_id
       WHERE a.source_type = 'sale_return' AND a.source_id = ? AND a.status = 'active'`,
    )
    .all(r.id);
  const summary = new Map();
  for (const x of lines) {
    const t = summary.get(x.gst_rate_bp) || {
      gst_rate_bp: x.gst_rate_bp,
      taxable: 0,
      cgst: 0,
      sgst: 0,
      igst: 0,
    };
    t.taxable += x.taxable;
    t.cgst += x.cgst;
    t.sgst += x.sgst;
    t.igst += x.igst;
    summary.set(x.gst_rate_bp, t);
  }
  return {
    ...r,
    lines,
    sale: sale || null,
    exchange_sale: exchangeSale || null,
    refunds,
    allocations,
    tax_summary: [...summary.values()].sort((a, b) => a.gst_rate_bp - b.gst_rate_bp),
    amount_in_words: amountInWords(r.total),
  };
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
    where.push(`(r.return_no LIKE ? ESCAPE '\\' OR r.customer_name LIKE ? ESCAPE '\\'
      OR r.customer_phone LIKE ? ESCAPE '\\' OR s.invoice_no LIKE ? ESCAPE '\\'
      OR EXISTS (SELECT 1 FROM sale_return_items i WHERE i.sale_return_id = r.id AND i.product_name LIKE ? ESCAPE '\\'))`);
    args.push(like, like, like, like, like);
  }
  const rows = db
    .prepare(
      `SELECT r.id, r.return_no, r.date, r.party_id, r.customer_name, r.bill_type, r.total, r.status,
         r.settlement, r.sale_id, s.invoice_no, x.invoice_no AS exchange_invoice_no,
         (SELECT COUNT(*) FROM sale_return_items i WHERE i.sale_return_id = r.id) AS item_count
       FROM sale_returns r LEFT JOIN sales s ON s.id = r.sale_id
       LEFT JOIN sales x ON x.id = r.exchange_sale_id
       WHERE ${where.join(' AND ')} ORDER BY r.date DESC, r.id DESC LIMIT 5000`,
    )
    .all(...args);
  return { rows, total: rows.length, truncated: rows.length === 5000 };
}

function markPrinted(db, returnId, { pdf = false } = {}, ctx = {}) {
  return db.transaction(() => {
    const r = returnRow(db, returnId);
    if (!pdf)
      db.prepare('UPDATE sale_returns SET print_count = print_count + 1 WHERE id = ?').run(r.id);
    sales.audit(db, {
      sale_id: r.sale_id,
      sale_return_id: r.id,
      action: pdf ? 'pdf' : 'printed',
      actor: ctx.actor,
      summary: `${pdf ? 'Saved PDF of' : 'Printed'} credit note ${r.return_no}`,
    });
    return r.print_count > 0;
  })();
}

module.exports = {
  SERIES,
  find,
  prepare,
  build,
  calculate,
  create,
  exchange,
  get,
  list,
  markPrinted,
  creditedOf,
  openClaimOf,
  openClaimQty,
};
