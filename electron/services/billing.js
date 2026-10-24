'use strict';

// Bill maths shared by purchases (Phase 4) and sales (Phase 5). Pure functions: integers only
// (paise, milli-units, basis points), no DB access. See docs/DESIGN.md "Line and bill calculation".

/** a / b rounded half up (half away from zero for negatives). b > 0. Accepts Number or BigInt. */
function divRound(a, b) {
  const big = typeof a === 'bigint' || typeof b === 'bigint';
  const A = BigInt(a);
  const B = BigInt(b);
  const neg = A < 0n;
  const abs = neg ? -A : A;
  const q = (abs * 2n + B) / (2n * B);
  const r = neg ? -q : q;
  return big ? r : Number(r);
}

/**
 * Splits `total` (integer ≥ 0) in proportion to `weights` (integers ≥ 0) with the largest
 * remainder method, so the parts always add up to exactly `total`. All weights 0 → equal split.
 */
function spread(total, weights) {
  const n = weights.length;
  if (n === 0) return [];
  let w = weights.map((x) => BigInt(Math.max(0, x)));
  let sum = w.reduce((a, b) => a + b, 0n);
  if (sum === 0n) {
    w = weights.map(() => 1n);
    sum = BigInt(n);
  }
  const T = BigInt(total);
  const parts = w.map((x) => (T * x) / sum);
  const rems = w.map((x, i) => ({ i, rem: (T * x) % sum }));
  let left = T - parts.reduce((a, b) => a + b, 0n);
  rems.sort((a, b) => (a.rem === b.rem ? a.i - b.i : a.rem > b.rem ? -1 : 1));
  for (let k = 0; left > 0n; k++, left--) parts[rems[k % n].i] += 1n;
  return parts.map(Number);
}

/**
 * GST on one amount. `amount` is the value after discounts, as entered (inclusive or exclusive).
 *   exclusive: taxable = amount
 *   inclusive: base = amount × 10000 / (10000 + bp); tax on base; taxable = amount − tax
 * Same state: CGST = SGST = base × bp / 20000 (equal halves). Other state: IGST = base × bp / 10000.
 */
function taxOn(amount, { gst, inclusive, interstate, rateBp }) {
  if (!gst || rateBp === 0) return { taxable: amount, cgst: 0, sgst: 0, igst: 0, total: amount };
  const base = inclusive ? divRound(amount * 10000, 10000 + rateBp) : amount;
  let cgst = 0;
  let sgst = 0;
  let igst = 0;
  if (interstate) igst = divRound(base * rateBp, 10000);
  else {
    cgst = divRound(base * rateBp, 20000);
    sgst = cgst;
  }
  const tax = cgst + sgst + igst;
  const taxable = inclusive ? amount - tax : amount;
  return { taxable, cgst, sgst, igst, total: taxable + tax };
}

/** Nearest rupee, half up: returns the round-off in paise (−50 … +49). */
function autoRoundOff(paise) {
  return divRound(paise, 100) * 100 - paise;
}

const MAX_ROUND_OFF = 500; // ±₹5

/**
 * Calculates a purchase bill.
 * input: { bill_type, price_mode, is_interstate, charges_mode, gst_in_cost, round_off (null = auto),
 *   items: [{ qty_milli, free_qty_milli, rate, discount_bp (or null), discount, gst_rate_bp }],
 *   charges: [{ kind, label, amount, gst_rate_bp }] }
 * `gst_in_cost`: GST cannot be claimed (composition dealer), so it is part of the stock cost.
 * Returns lines, charges, totals and a rate-wise tax summary. Throws nothing: the caller
 * validates the inputs first.
 */
function calculatePurchase(input) {
  const gst = input.bill_type === 'gst';
  const opts = (rateBp) => ({
    gst,
    inclusive: input.price_mode === 'inclusive',
    interstate: Boolean(input.is_interstate),
    rateBp,
  });

  const items = input.items.map((it) => {
    const gross = divRound(it.qty_milli * it.rate, 1000);
    const discount =
      it.discount_bp != null ? divRound(gross * it.discount_bp, 10000) : it.discount || 0;
    const amount = gross - discount;
    const t = taxOn(amount, opts(gst ? it.gst_rate_bp : 0));
    return {
      ...it,
      gst_rate_bp: gst ? it.gst_rate_bp : 0,
      gross,
      discount,
      taxable: t.taxable,
      cgst: t.cgst,
      sgst: t.sgst,
      igst: t.igst,
      line_total: t.total,
    };
  });

  const charges = (input.charges || []).map((c) => {
    const t = taxOn(c.amount, opts(gst ? c.gst_rate_bp : 0));
    return {
      ...c,
      gst_rate_bp: gst ? c.gst_rate_bp : 0,
      taxable: t.taxable,
      cgst: t.cgst,
      sgst: t.sgst,
      igst: t.igst,
      total: t.total,
    };
  });

  // Landed cost: charges (cost mode) spread across lines by taxable value. GST is input tax
  // (claimed back), so it is not cost, unless it cannot be claimed.
  const taxOf = (x) => x.cgst + x.sgst + x.igst;
  const chargeCost =
    input.charges_mode === 'expense'
      ? 0
      : charges.reduce((s, c) => s + c.taxable + (input.gst_in_cost ? taxOf(c) : 0), 0);
  const weights = items.some((i) => i.taxable > 0)
    ? items.map((i) => i.taxable)
    : items.map((i) => i.qty_milli + (i.free_qty_milli || 0));
  const shares = spread(chargeCost, weights);
  items.forEach((it, i) => {
    it.charges_share = shares[i] || 0;
    it.landed_total = it.taxable + it.charges_share + (input.gst_in_cost ? taxOf(it) : 0);
    it.unit_cost = divRound(it.landed_total * 1000, it.qty_milli + (it.free_qty_milli || 0));
  });

  const sum = (list, k) => list.reduce((s, x) => s + x[k], 0);
  const raw = sum(items, 'line_total') + sum(charges, 'total');
  const roundOff = input.round_off == null ? autoRoundOff(raw) : input.round_off;

  const summary = new Map();
  for (const x of [...items, ...charges]) {
    const row = summary.get(x.gst_rate_bp) || {
      gst_rate_bp: x.gst_rate_bp,
      taxable: 0,
      cgst: 0,
      sgst: 0,
      igst: 0,
    };
    row.taxable += x.taxable;
    row.cgst += x.cgst;
    row.sgst += x.sgst;
    row.igst += x.igst;
    summary.set(x.gst_rate_bp, row);
  }

  const cgst = sum(items, 'cgst') + sum(charges, 'cgst');
  const sgst = sum(items, 'sgst') + sum(charges, 'sgst');
  const igst = sum(items, 'igst') + sum(charges, 'igst');
  return {
    items,
    charges,
    totals: {
      sub_total: sum(items, 'gross'),
      discount_total: sum(items, 'discount'),
      taxable_total: sum(items, 'taxable'),
      charges_taxable: sum(charges, 'taxable'),
      charges_total: sum(charges, 'total'),
      cgst_total: cgst,
      sgst_total: sgst,
      igst_total: igst,
      tax_total: cgst + sgst + igst,
      before_round_off: raw,
      auto_round_off: autoRoundOff(raw),
      round_off: roundOff,
      grand_total: raw + roundOff,
    },
    tax_summary: [...summary.values()].sort((a, b) => a.gst_rate_bp - b.gst_rate_bp),
  };
}

const MAX_SALE_ROUND_OFF = 100; // ±₹1

/**
 * Calculates a sale bill (also quotations).
 * input: { bill_type, price_mode, is_interstate, round_off (null = auto),
 *   bill_discount_bp (null) | bill_discount (paise),
 *   items: [{ qty_milli, rate, discount_bp (or null), discount, gst_rate_bp, item_type }] }
 * 1. gross = qty × rate; amount = gross − line discount
 * 2. the bill discount is spread across lines in proportion to `amount` (largest remainder),
 *    BEFORE tax, so GST is charged on what the customer really pays
 * 3. tax per line on the net amount (inclusive / exclusive; CGST+SGST or IGST)
 * 4. grand total rounded to the nearest rupee (or the round-off given, within ±₹1)
 * Lines keep their order. Throws nothing: the caller validates first.
 */
function calculateSale(input) {
  const gst = input.bill_type === 'gst';
  const opts = (rateBp) => ({
    gst,
    inclusive: input.price_mode === 'inclusive',
    interstate: Boolean(input.is_interstate),
    rateBp,
  });

  const base = input.items.map((it) => {
    const gross = divRound(it.qty_milli * it.rate, 1000);
    const discount =
      it.discount_bp != null ? divRound(gross * it.discount_bp, 10000) : it.discount || 0;
    return { gross, discount, amount: Math.max(gross - discount, 0) };
  });
  const amountSum = base.reduce((s, b) => s + b.amount, 0);
  let billDiscount =
    input.bill_discount_bp != null
      ? divRound(amountSum * input.bill_discount_bp, 10000)
      : input.bill_discount || 0;
  billDiscount = Math.min(Math.max(billDiscount, 0), amountSum);
  const shares =
    amountSum > 0
      ? spread(
          billDiscount,
          base.map((b) => b.amount),
        )
      : base.map(() => 0);

  const items = input.items.map((it, i) => {
    const b = base[i];
    const net = b.amount - shares[i];
    const t = taxOn(net, opts(gst ? it.gst_rate_bp : 0));
    return {
      ...it,
      gst_rate_bp: gst ? it.gst_rate_bp : 0,
      gross: b.gross,
      discount: b.discount,
      amount: b.amount,
      bill_discount_share: shares[i],
      net,
      taxable: t.taxable,
      cgst: t.cgst,
      sgst: t.sgst,
      igst: t.igst,
      line_total: t.total,
    };
  });

  const sum = (list, k) => list.reduce((s, x) => s + x[k], 0);
  const raw = sum(items, 'line_total');
  const auto = autoRoundOff(raw);
  const roundOff = input.round_off == null ? auto : input.round_off;
  const summary = new Map();
  for (const x of items) {
    const row = summary.get(x.gst_rate_bp) || {
      gst_rate_bp: x.gst_rate_bp,
      taxable: 0,
      cgst: 0,
      sgst: 0,
      igst: 0,
    };
    row.taxable += x.taxable;
    row.cgst += x.cgst;
    row.sgst += x.sgst;
    row.igst += x.igst;
    summary.set(x.gst_rate_bp, row);
  }
  const cgst = sum(items, 'cgst');
  const sgst = sum(items, 'sgst');
  const igst = sum(items, 'igst');
  const of = (type) =>
    items.filter((x) => (x.item_type || 'goods') === type).reduce((s, x) => s + x.line_total, 0);
  return {
    items,
    totals: {
      sub_total: sum(items, 'gross'),
      item_discount_total: sum(items, 'discount'),
      bill_discount: billDiscount,
      taxable_total: sum(items, 'taxable'),
      cgst_total: cgst,
      sgst_total: sgst,
      igst_total: igst,
      tax_total: cgst + sgst + igst,
      goods_total: of('goods'),
      services_total: of('service'),
      before_round_off: raw,
      auto_round_off: auto,
      round_off: roundOff,
      grand_total: raw + roundOff,
    },
    tax_summary: [...summary.values()].sort((a, b) => a.gst_rate_bp - b.gst_rate_bp),
  };
}

/**
 * The share of a sold line that `qty` units are worth, for a credit note: taxable and each tax
 * in proportion to the quantity. The last return of a line (`isLast`) takes exactly what is
 * left (`left` = original amounts − amounts already credited), so the credit notes of a line
 * always add up to the line itself. Tax is never recalculated, so it is reversed at the rate
 * and on the value it was charged.
 */
function proportionalLine(item, qty, left, isLast) {
  const part = (k) => (isLast ? left[k] : divRound(item[k] * qty, item.qty_milli));
  const taxable = part('taxable');
  const cgst = part('cgst');
  const sgst = part('sgst');
  const igst = part('igst');
  return { taxable, cgst, sgst, igst, line_total: taxable + cgst + sgst + igst };
}

/** Totals of credit-note lines (already split by proportionalLine), rounded to the rupee. */
function returnTotals(lines) {
  const sum = (k) => lines.reduce((s, x) => s + x[k], 0);
  const raw = sum('line_total');
  const roundOff = autoRoundOff(raw);
  return {
    taxable_total: sum('taxable'),
    cgst_total: sum('cgst'),
    sgst_total: sum('sgst'),
    igst_total: sum('igst'),
    tax_total: sum('cgst') + sum('sgst') + sum('igst'),
    round_off: roundOff,
    total: raw + roundOff,
  };
}

/**
 * Tax on credit amounts (debit / credit notes): `taxable` per line is the agreed value before
 * GST, taxed at the original rate and split. Total rounded to the rupee.
 */
function calculateReturn({ bill_type: billType, is_interstate: interstate, lines }) {
  const gst = billType === 'gst';
  const out = lines.map((l) => {
    const t = taxOn(l.taxable, {
      gst,
      inclusive: false,
      interstate,
      rateBp: gst ? l.gst_rate_bp : 0,
    });
    return { ...l, cgst: t.cgst, sgst: t.sgst, igst: t.igst, line_total: t.total };
  });
  const sum = (k) => out.reduce((s, x) => s + x[k], 0);
  const raw = sum('line_total');
  const roundOff = autoRoundOff(raw);
  return {
    lines: out,
    totals: {
      taxable_total: sum('taxable'),
      cgst_total: sum('cgst'),
      sgst_total: sum('sgst'),
      igst_total: sum('igst'),
      tax_total: sum('cgst') + sum('sgst') + sum('igst'),
      round_off: roundOff,
      total: raw + roundOff,
    },
  };
}

// ---------------------------------------------------------------- weighted average cost

/**
 * Moving weighted average after stock comes in.
 * Stock below zero (sold before it was entered) counts as zero, so the new units set the cost.
 * `value` = total landed value (paise) of `inMilli` units (free units included in inMilli).
 */
function averageIn({ stock_milli: stock, avg_cost: avg }, inMilli, value) {
  const base = BigInt(Math.max(stock, 0));
  const qty = base + BigInt(inMilli);
  if (qty <= 0n) return avg;
  return Number(divRound(base * BigInt(avg) + BigInt(value) * 1000n, qty));
}

/**
 * Average after stock leaves at a known cost (purchase return, reversal of a purchase).
 * Other outflows (sales, write-offs) leave at the average and do not change it.
 * When nothing (or a negative quantity) remains, the last average is kept.
 */
function averageOut({ stock_milli: stock, avg_cost: avg }, outMilli, unitCost) {
  const left = BigInt(stock) - BigInt(outMilli);
  if (left <= 0n || stock <= 0) return avg;
  const value = BigInt(stock) * BigInt(avg) - BigInt(outMilli) * BigInt(unitCost);
  if (value <= 0n) return 0;
  return Number(divRound(value, left));
}

module.exports = {
  divRound,
  spread,
  taxOn,
  autoRoundOff,
  MAX_ROUND_OFF,
  MAX_SALE_ROUND_OFF,
  calculatePurchase,
  calculateSale,
  proportionalLine,
  returnTotals,
  calculateReturn,
  averageIn,
  averageOut,
};
