import { afterEach, describe, expect, it } from 'vitest';
import { require, testPaths } from './helpers.js';

const { openDatabase } = require('../electron/db/connection.js');
const { migrate } = require('../electron/db/migrate.js');
const settings = require('../electron/services/settings.js');
const products = require('../electron/services/products.js');
const parties = require('../electron/services/parties.js');
const serials = require('../electron/services/serials.js');
const billing = require('../electron/services/billing.js');
const sales = require('../electron/services/sales.js');
const saleReturns = require('../electron/services/saleReturns.js');
const quotations = require('../electron/services/quotations.js');
const drafts = require('../electron/services/saleDrafts.js');
const print = require('../electron/services/salePrint.js');
const { amountInWords, numberToWords } = require('../electron/services/words.js');
const { warrantyEnd } = require('../electron/services/warranty.js');
const qr = require('../electron/services/qr.js');

const open = [];
function freshDb() {
  const db = openDatabase(testPaths().dbFile);
  open.push(db);
  migrate(db);
  settings.updateSettings(db, { business_state_code: '24', business_name: 'Pragati Car' });
  return db;
}
afterEach(() => {
  while (open.length) {
    const db = open.pop();
    if (db.open) db.close();
  }
});

const ctx = { actor: 'test' };
const TODAY = (() => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
})();

function stockItem(db, o = {}) {
  const p = products.create(db, {
    name: o.name || 'Seat Cover',
    unit: 'pcs',
    gst_rate_bp: o.gst ?? 1800,
    track_serials: Boolean(o.serials),
    customer_warranty_months: o.warranty || 0,
    fitting_variant_id: o.fitting || null,
    variants: [
      {
        selling_price: o.price ?? 100000,
        mrp: o.mrp ?? 150000,
        purchase_price: o.cost ?? 60000,
        opening_stock_milli: o.serials ? 0 : (o.stock ?? 10) * 1000,
        serials: o.serials
          ? { entries: o.serials.map((s) => ({ serial_no: s })), auto: null }
          : undefined,
      },
    ],
  });
  return p.variants[0];
}

function service(db, price = 30000) {
  return products.create(db, {
    name: 'Fitting charge',
    product_type: 'service',
    unit: 'pcs',
    gst_rate_bp: 1800,
    variants: [{ selling_price: price }],
  }).variants[0];
}

function customer(db, o = {}) {
  return parties.create(db, {
    type: 'customer',
    party: {
      name: o.name || 'Amit Shah',
      phone: o.phone || '9876543210',
      state_code: o.state || '24',
      credit_limit: o.limit ?? null,
    },
    vehicles: o.plate ? [{ plate_no: o.plate }] : [],
  });
}

const line = (v, qty, rate, extra = {}) => ({
  variant_id: v.id,
  qty_milli: qty * 1000,
  rate,
  gst_rate_bp: 1800,
  ...extra,
});

const bill = (partyId, items, extra = {}) => ({
  party_id: partyId,
  date: TODAY,
  bill_type: 'gst',
  price_mode: 'exclusive',
  items,
  ...extra,
});

const stockOf = (db, v) => products.variantStock(db, v.id);
const balance = (db, partyId) => sales.balanceOf(db, partyId);

// ---------------------------------------------------------------- maths

describe('sale maths', () => {
  const calc = (o) =>
    billing.calculateSale({
      bill_type: 'gst',
      price_mode: 'exclusive',
      is_interstate: false,
      round_off: null,
      ...o,
    });

  it('exclusive: tax added on top, CGST = SGST', () => {
    const r = calc({ items: [{ qty_milli: 2000, rate: 50000, gst_rate_bp: 1800 }] });
    expect(r.items[0]).toMatchObject({
      taxable: 100000,
      cgst: 9000,
      sgst: 9000,
      igst: 0,
      line_total: 118000,
    });
    expect(r.totals.grand_total).toBe(118000);
  });

  it('inclusive: tax taken out of the price', () => {
    const r = calc({
      price_mode: 'inclusive',
      items: [{ qty_milli: 1000, rate: 118000, gst_rate_bp: 1800 }],
    });
    expect(r.items[0]).toMatchObject({
      taxable: 100000,
      cgst: 9000,
      sgst: 9000,
      line_total: 118000,
    });
  });

  it('interstate: IGST only', () => {
    const r = calc({
      is_interstate: true,
      items: [{ qty_milli: 1000, rate: 100000, gst_rate_bp: 1800 }],
    });
    expect(r.items[0]).toMatchObject({ cgst: 0, sgst: 0, igst: 18000, line_total: 118000 });
  });

  it('non-GST bill: no tax at all', () => {
    const r = calc({
      bill_type: 'non_gst',
      items: [{ qty_milli: 1000, rate: 100000, gst_rate_bp: 1800 }],
    });
    expect(r.items[0]).toMatchObject({ taxable: 100000, cgst: 0, igst: 0, gst_rate_bp: 0 });
    expect(r.totals.tax_total).toBe(0);
  });

  it('bill discount is spread before tax, exactly, in proportion', () => {
    const r = calc({
      bill_discount: 1001,
      items: [
        { qty_milli: 1000, rate: 30000, gst_rate_bp: 1800 },
        { qty_milli: 1000, rate: 70000, gst_rate_bp: 500 },
      ],
    });
    const shares = r.items.map((i) => i.bill_discount_share);
    expect(shares[0] + shares[1]).toBe(1001);
    expect(shares).toEqual([300, 701]);
    expect(r.items[0].taxable).toBe(29700);
    expect(r.items[0].cgst).toBe(2673); // 9% of 29700
    expect(r.items[1].taxable).toBe(69299);
    expect(r.totals.bill_discount).toBe(1001);
  });

  it('bill discount in % and line discounts', () => {
    const r = calc({
      bill_discount_bp: 1000,
      items: [{ qty_milli: 1000, rate: 100000, discount_bp: 1000, gst_rate_bp: 0 }],
    });
    expect(r.items[0].discount).toBe(10000);
    expect(r.totals.bill_discount).toBe(9000);
    expect(r.items[0].taxable).toBe(81000);
  });

  it('rounds to the nearest rupee (half up) and keeps a typed round-off', () => {
    const r = calc({ items: [{ qty_milli: 1000, rate: 10050, gst_rate_bp: 0 }] });
    expect(r.totals.round_off).toBe(50);
    expect(r.totals.grand_total).toBe(10100);
    const r2 = calc({ items: [{ qty_milli: 1000, rate: 10049, gst_rate_bp: 0 }] });
    expect(r2.totals.round_off).toBe(-49);
    const r3 = calc({ round_off: 0, items: [{ qty_milli: 1000, rate: 10049, gst_rate_bp: 0 }] });
    expect(r3.totals.grand_total).toBe(10049);
  });

  it('products vs fitting totals', () => {
    const r = calc({
      items: [
        { qty_milli: 1000, rate: 100000, gst_rate_bp: 0, item_type: 'goods' },
        { qty_milli: 1000, rate: 20000, gst_rate_bp: 0, item_type: 'service' },
      ],
    });
    expect(r.totals.goods_total).toBe(100000);
    expect(r.totals.services_total).toBe(20000);
  });
});

describe('amount in words (Indian numbering)', () => {
  it('lakh and crore', () => {
    expect(numberToWords(0)).toBe('Zero');
    expect(numberToWords(15)).toBe('Fifteen');
    expect(numberToWords(105)).toBe('One Hundred Five');
    expect(numberToWords(123456)).toBe('One Lakh Twenty Three Thousand Four Hundred Fifty Six');
    expect(numberToWords(10000000)).toBe('One Crore');
    expect(numberToWords(1234567890)).toBe(
      'One Hundred Twenty Three Crore Forty Five Lakh Sixty Seven Thousand Eight Hundred Ninety',
    );
    expect(amountInWords(12345678)).toBe(
      'Rupees One Lakh Twenty Three Thousand Four Hundred Fifty Six and Seventy Eight Paise Only',
    );
    expect(amountInWords(100)).toBe('Rupees One Only');
  });
});

describe('warranty end dates (inclusive)', () => {
  it('calendar months minus one day; short months clamp', () => {
    expect(warrantyEnd('2026-10-18', 12)).toBe('2027-10-17');
    expect(warrantyEnd('2026-01-31', 1)).toBe('2026-02-28');
    expect(warrantyEnd('2028-01-31', 1)).toBe('2028-02-29');
    expect(warrantyEnd('2026-03-01', 6)).toBe('2026-08-31');
  });
});

describe('QR encoder', () => {
  it('Reed-Solomon matches the standard example (HELLO WORLD, 1-M)', () => {
    const data = [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17];
    expect(qr.rsRemainder(data, qr.rsDivisor(10))).toEqual([
      196, 35, 39, 119, 235, 215, 231, 226, 93, 23,
    ]);
  });
  it('picks the smallest version and draws finder patterns', () => {
    const m = qr.qrMatrix(
      qr.upiLink({
        vpa: 'shop@okaxis',
        name: 'Pragati Car',
        amountPaise: 266050,
        note: 'GST-0001',
      }),
    );
    expect(m.modules.length).toBe(m.version * 4 + 17);
    expect(m.modules[0].slice(0, 7).every(Boolean)).toBe(true);
    expect(qr.upiLink({ vpa: 'a@b', name: 'X', amountPaise: 5 })).toContain('am=0.05');
  });
});

// ---------------------------------------------------------------- saving

describe('sales: save', () => {
  it('numbers each series separately, gap-free, assigned only on save', () => {
    const db = freshDb();
    const v = stockItem(db);
    const cash = sales.cashCustomerId(db);
    const pay = (amount) => [{ mode: 'cash', amount }];
    const a = sales.create(db, bill(cash, [line(v, 1, 10000)], { payments: pay(11800) }), ctx);
    const b = sales.create(
      db,
      bill(cash, [line(v, 1, 10000)], { bill_type: 'non_gst', payments: pay(10000) }),
      ctx,
    );
    // A failing save does not use up a number.
    expect(() =>
      sales.create(db, bill(cash, [line(v, 100, 10000)], { payments: pay(1) }), ctx),
    ).toThrow();
    const c = sales.create(db, bill(cash, [line(v, 1, 10000)], { payments: pay(11800) }), ctx);
    expect([a.invoice_no, b.invoice_no, c.invoice_no]).toEqual([
      'GST-0001',
      'EST-0001',
      'GST-0002',
    ]);
    expect(a.bill_title).toBe('Tax Invoice');
    expect(b.bill_title).toBe('Bill of Supply');
  });

  it('composition dealer: always a Bill of Supply without tax', () => {
    const db = freshDb();
    settings.updateSettings(db, { composition_dealer: '1' });
    const v = stockItem(db);
    const s = sales.create(
      db,
      bill(sales.cashCustomerId(db), [line(v, 1, 10000)], {
        payments: [{ mode: 'cash', amount: 10000 }],
      }),
      ctx,
    );
    expect(s.bill_type).toBe('non_gst');
    expect(s.bill_title).toBe('Bill of Supply');
    expect(s.tax_total).toBe(0);
  });

  it('writes stock at the average cost, payments and ledger in one go', () => {
    const db = freshDb();
    const v = stockItem(db, { cost: 60000, stock: 5 });
    const c = customer(db);
    const s = sales.create(
      db,
      bill(c.id, [line(v, 2, 100000)], {
        payments: [
          { mode: 'upi', amount: 100000, ref_no: 'UTR1' },
          { mode: 'cash', amount: 36000 },
        ],
      }),
      ctx,
    );
    expect(s.grand_total).toBe(236000);
    expect(stockOf(db, v)).toBe(3000);
    expect(s.items[0].unit_cost).toBe(60000);
    expect(s.cost_total).toBe(120000);
    expect(s.paid).toBe(136000);
    expect(s.due).toBe(100000);
    expect(s.pay_status).toBe('partial');
    expect(balance(db, c.id)).toBe(100000);
    const st = sales.stats(db);
    expect(st.today_by_mode.upi).toBe(100000);
    expect(st.today_credit).toBe(100000);
  });

  it('IGST for a customer in another state', () => {
    const db = freshDb();
    const v = stockItem(db);
    const c = customer(db, { state: '27' });
    const s = sales.create(db, bill(c.id, [line(v, 1, 100000)]), ctx);
    expect(s.is_interstate).toBe(1);
    expect(s.igst_total).toBe(18000);
    expect(s.cgst_total).toBe(0);
  });

  it('blocks selling more than in stock unless negative stock is allowed', () => {
    const db = freshDb();
    const v = stockItem(db, { stock: 2 });
    const c = customer(db);
    expect(() => sales.create(db, bill(c.id, [line(v, 3, 1000)]), ctx)).toThrow(/in stock/);
    // Two lines of the same item count together.
    expect(() => sales.create(db, bill(c.id, [line(v, 1, 1000), line(v, 2, 1000)]), ctx)).toThrow(
      /in stock/,
    );
    settings.updateSettings(db, { allow_negative_stock: '1' });
    sales.create(db, bill(c.id, [line(v, 3, 1000)]), ctx);
    expect(stockOf(db, v)).toBe(-1000);
  });

  it('credit needs a named customer; credit limit needs confirmation', () => {
    const db = freshDb();
    const v = stockItem(db);
    expect(() =>
      sales.create(db, bill(sales.cashCustomerId(db), [line(v, 1, 10000)]), ctx),
    ).toThrow(/Credit needs a named customer/);
    const c = customer(db, { limit: 5000 });
    let err;
    try {
      sales.create(db, bill(c.id, [line(v, 1, 10000)]), ctx);
    } catch (e) {
      err = e;
    }
    expect(err.code).toBe('CREDIT_LIMIT');
    const s = sales.create(db, bill(c.id, [line(v, 1, 10000)], { confirm_credit: true }), ctx);
    expect(s.due).toBe(11800);
  });

  it('back-dated bills need confirmation', () => {
    const db = freshDb();
    const v = stockItem(db);
    const c = customer(db);
    let err;
    try {
      sales.create(db, bill(c.id, [line(v, 1, 1000)], { date: sales.addDays(TODAY, -10) }), ctx);
    } catch (e) {
      err = e;
    }
    expect(err.code).toBe('DATE_CONFIRM');
    sales.create(
      db,
      bill(c.id, [line(v, 1, 1000)], { date: sales.addDays(TODAY, -10), confirm_date: true }),
      ctx,
    );
  });

  it('adjusts from advance', () => {
    const db = freshDb();
    const v = stockItem(db);
    const c = parties.create(db, {
      type: 'customer',
      party: { name: 'Adv', phone: '9876500000', opening_amount: 50000, opening_type: 'advance' },
    });
    expect(balance(db, c.id)).toBe(-50000);
    expect(() =>
      sales.create(db, bill(c.id, [line(v, 1, 100000)], { advance_amount: 60000 }), ctx),
    ).toThrow(/advance/);
    const s = sales.create(db, bill(c.id, [line(v, 1, 100000)], { advance_amount: 50000 }), ctx);
    expect(s.paid).toBe(50000);
    expect(balance(db, c.id)).toBe(68000);
  });
});

describe('sales: serials, warranty, fitting', () => {
  it('serial units go to sold with warranty; can never be oversold', () => {
    const db = freshDb();
    const v = stockItem(db, { serials: ['A1', 'A2'], warranty: 12 });
    const units = serials.inStock(db, { variant_id: v.id });
    const c = customer(db, { plate: 'GJ03AB1234' });
    const veh = parties.get(db, c.id).vehicles[0];
    expect(() =>
      sales.create(db, bill(c.id, [line(v, 2, 1000, { serial_ids: [units[0].id] })]), ctx),
    ).toThrow(/Pick 2 serial/);
    const s = sales.create(
      db,
      bill(c.id, [line(v, 1, 1000, { serial_ids: [units[0].id] })], { vehicle_id: veh.id }),
      ctx,
    );
    const unit = db.prepare('SELECT * FROM product_serials WHERE id = ?').get(units[0].id);
    expect(unit.status).toBe('sold');
    expect(unit.customer_party_id).toBe(c.id);
    expect(unit.warranty_end).toBe(warrantyEnd(TODAY, 12));
    expect(s.vehicle_no).toBe('GJ 03 AB 1234');
    expect(serials.consistency(db, v.id).ok).toBe(true);
    // The same unit cannot be sold twice.
    expect(() =>
      sales.create(db, bill(c.id, [line(v, 1, 1000, { serial_ids: [units[0].id] })]), ctx),
    ).toThrow(/not in stock/);
  });

  it('non-serial warranty on the line', () => {
    const db = freshDb();
    const v = stockItem(db, { warranty: 6 });
    const c = customer(db);
    const s = sales.create(db, bill(c.id, [line(v, 1, 1000)]), ctx);
    expect(s.items[0].warranty_months).toBe(6);
    expect(s.items[0].warranty_end).toBe(warrantyEnd(TODAY, 6));
  });

  it('fitting line linked to its product; no stock for services', () => {
    const db = freshDb();
    const fit = service(db);
    const v = stockItem(db, { fitting: fit.id });
    const c = customer(db);
    const found = sales.searchItems(db, { query: 'Seat' })[0];
    expect(found.fitting.variant_id).toBe(fit.id);
    const s = sales.create(
      db,
      bill(c.id, [line(v, 1, 100000), line(fit, 1, 0, { fitting_for: 0, fitted_by: 'Raju' })]),
      ctx,
    );
    expect(s.items[1].fitting_for_item_id).toBe(s.items[0].id);
    expect(s.items[1].item_type).toBe('service');
    expect(s.services_total).toBe(0);
    expect(sales.list(db, { technician: 'raj' }).total).toBe(1);
    expect(() =>
      sales.create(db, bill(c.id, [line(fit, 1, 100, { fitting_for: 0 })]), ctx),
    ).toThrow();
  });
});

// ---------------------------------------------------------------- cancel

describe('sales: cancel', () => {
  it('reverses stock at the original cost, serials back, money becomes advance', () => {
    const db = freshDb();
    const v = stockItem(db, { stock: 5, cost: 60000 });
    const t = stockItem(db, { name: 'Tyre inflator', serials: ['X1'], cost: 200000 });
    const unit = serials.inStock(db, { variant_id: t.id })[0];
    const c = customer(db);
    const s = sales.create(
      db,
      bill(c.id, [line(v, 2, 100000), line(t, 1, 300000, { serial_ids: [unit.id] })], {
        payments: [{ mode: 'cash', amount: 100000 }],
      }),
      ctx,
    );
    expect(() => sales.cancel(db, { id: s.id, reason: '' }, ctx)).toThrow(/reason/);
    const done = sales.cancel(db, { id: s.id, reason: 'Wrong item' }, ctx);
    expect(done.status).toBe('cancelled');
    expect(stockOf(db, v)).toBe(5000);
    expect(stockOf(db, t)).toBe(1000);
    const u = db.prepare('SELECT * FROM product_serials WHERE id = ?').get(unit.id);
    expect(u.status).toBe('in_stock');
    expect(u.warranty_end).toBeNull();
    expect(serials.consistency(db, t.id).ok).toBe(true);
    expect(balance(db, c.id)).toBe(-100000); // advance
    expect(done.invoice_no).toBe('GST-0001'); // number kept
    expect(sales.stats(db).today_amount).toBe(0);
    expect(() => sales.cancel(db, { id: s.id, reason: 'again' }, ctx)).toThrow(/already cancelled/);
  });

  it('Cash Customer must be refunded; refund is a payment out', () => {
    const db = freshDb();
    const v = stockItem(db);
    const cash = sales.cashCustomerId(db);
    const s = sales.create(
      db,
      bill(cash, [line(v, 1, 10000)], { payments: [{ mode: 'cash', amount: 11800 }] }),
      ctx,
    );
    expect(() => sales.cancel(db, { id: s.id, reason: 'x' }, ctx)).toThrow(/refund/);
    sales.cancel(db, { id: s.id, reason: 'x', refund: { mode: 'cash', amount: 11800 } }, ctx);
    expect(balance(db, cash)).toBe(0);
  });

  it('a bill with a credit note cannot be cancelled; re-issue links back', () => {
    const db = freshDb();
    const v = stockItem(db);
    const c = customer(db);
    const s = sales.create(db, bill(c.id, [line(v, 2, 10000)]), ctx);
    saleReturns.create(
      db,
      { sale_id: s.id, lines: [{ sale_item_id: s.items[0].id, qty_milli: 1000 }] },
      ctx,
    );
    expect(() => sales.cancel(db, { id: s.id, reason: 'x' }, ctx)).toThrow(/return/);

    const s2 = sales.create(db, bill(c.id, [line(v, 1, 10000)]), ctx);
    sales.cancel(db, { id: s2.id, reason: 'rate wrong' }, ctx);
    const pre = sales.prefill(db, { sale_id: s2.id });
    expect(pre.lines[0].rate).toBe(10000);
    const s3 = sales.create(db, { ...bill(c.id, [line(v, 1, 9000)]), reissue_of_id: s2.id }, ctx);
    expect(sales.get(db, s2.id).reissued_as.id).toBe(s3.id);
  });
});

// ---------------------------------------------------------------- returns

describe('sale returns (credit notes)', () => {
  it('credits the exact share; the last return takes the remainder; limits qty', () => {
    const db = freshDb();
    const v = stockItem(db, { stock: 10, cost: 50000 });
    const c = customer(db);
    // 3 × ₹333.33 with a bill discount: shares do not divide evenly.
    const s = sales.create(db, bill(c.id, [line(v, 3, 33333)], { bill_discount: 1000 }), ctx);
    const it = s.items[0];
    const r1 = saleReturns.create(
      db,
      { sale_id: s.id, lines: [{ sale_item_id: it.id, qty_milli: 1000 }] },
      ctx,
    );
    expect(r1.return_no).toBe('CN-GST-0001');
    const r2 = saleReturns.create(
      db,
      { sale_id: s.id, lines: [{ sale_item_id: it.id, qty_milli: 2000 }] },
      ctx,
    );
    const sumTaxable = r1.lines[0].taxable + r2.lines[0].taxable;
    const sumCgst = r1.lines[0].cgst + r2.lines[0].cgst;
    expect(sumTaxable).toBe(it.taxable);
    expect(sumCgst).toBe(it.cgst);
    expect(() =>
      saleReturns.create(
        db,
        { sale_id: s.id, lines: [{ sale_item_id: it.id, qty_milli: 1000 }] },
        ctx,
      ),
    ).toThrow(/fully returned/);
    expect(stockOf(db, v)).toBe(10000);
    // Credit reduced what was due on the bill.
    const after = sales.get(db, s.id);
    expect(after.due).toBe(after.grand_total - r1.total - r2.total);
  });

  it('serials back to stock or defective, warranty voided; CN-EST for non-GST', () => {
    const db = freshDb();
    const t = stockItem(db, { serials: ['S1', 'S2'], warranty: 12, cost: 100000 });
    const units = serials.inStock(db, { variant_id: t.id });
    const cash = sales.cashCustomerId(db);
    const s = sales.create(
      db,
      bill(cash, [line(t, 2, 200000, { serial_ids: units.map((u) => u.id) })], {
        bill_type: 'non_gst',
        payments: [{ mode: 'cash', amount: 400000 }],
      }),
      ctx,
    );
    expect(stockOf(db, t)).toBe(0);
    // Cash Customer: refund needed.
    expect(() =>
      saleReturns.create(
        db,
        {
          sale_id: s.id,
          settlement: 'adjust',
          lines: [{ sale_item_id: s.items[0].id, qty_milli: 1000, serials: [{ id: units[0].id }] }],
        },
        ctx,
      ),
    ).toThrow(/refund/);
    const r = saleReturns.create(
      db,
      {
        sale_id: s.id,
        settlement: 'refund',
        refund: { mode: 'cash' },
        lines: [
          {
            sale_item_id: s.items[0].id,
            qty_milli: 2000,
            serials: [
              { id: units[0].id, to_status: 'in_stock' },
              { id: units[1].id, to_status: 'defective' },
            ],
          },
        ],
      },
      ctx,
    );
    expect(r.return_no).toBe('CN-EST-0001');
    expect(r.total).toBe(400000);
    expect(stockOf(db, t)).toBe(1000);
    expect(serials.consistency(db, t.id).ok).toBe(true);
    const u2 = db
      .prepare('SELECT status, warranty_end FROM product_serials WHERE id = ?')
      .get(units[1].id);
    expect(u2).toEqual({ status: 'defective', warranty_end: null });
    expect(balance(db, cash)).toBe(0);
  });

  it('fitting refund only when chosen; stock back at the original sale cost', () => {
    const db = freshDb();
    const fit = service(db);
    const v = stockItem(db, { stock: 1, cost: 40000 });
    const c = customer(db);
    const s = sales.create(
      db,
      bill(c.id, [line(v, 1, 100000), line(fit, 1, 20000, { fitting_for: 0 })]),
      ctx,
    );
    const prep = saleReturns.prepare(db, { sale_id: s.id });
    expect(prep.lines[1].fitting_for_item_id).toBe(s.items[0].id);
    // Cost changes later: the return still uses the sale's cost.
    db.prepare('UPDATE product_variants SET avg_cost = 99999 WHERE id = ?').run(v.id);
    const r = saleReturns.create(
      db,
      { sale_id: s.id, lines: [{ sale_item_id: s.items[0].id, qty_milli: 1000 }] },
      ctx,
    );
    expect(r.lines).toHaveLength(1);
    const mv = db
      .prepare(
        "SELECT unit_cost FROM stock_movements WHERE type = 'sale_return' AND variant_id = ?",
      )
      .pluck()
      .get(v.id);
    expect(mv).toBe(40000);
  });

  it('exchange: only the difference is paid or refunded', () => {
    const db = freshDb();
    const a = stockItem(db, { name: 'Mat A', stock: 5 });
    const b = stockItem(db, { name: 'Mat B', stock: 5 });
    const cash = sales.cashCustomerId(db);
    const s = sales.create(
      db,
      bill(cash, [line(a, 1, 100000)], { payments: [{ mode: 'cash', amount: 118000 }] }),
      ctx,
    );
    // New item costs more: customer pays 59,000.
    const ex = saleReturns.exchange(
      db,
      {
        sale_return: { sale_id: s.id, lines: [{ sale_item_id: s.items[0].id, qty_milli: 1000 }] },
        sale: bill(cash, [line(b, 1, 150000)], { payments: [{ mode: 'upi', amount: 59000 }] }),
      },
      ctx,
    );
    expect(ex.sale_return.settlement).toBe('exchange');
    expect(ex.sale.paid).toBe(177000);
    expect(ex.sale.due).toBe(0);
    expect(ex.sale_return.exchange_sale.id).toBe(ex.sale.id);
    expect(balance(db, cash)).toBe(0);
    expect(stockOf(db, a)).toBe(5000);
    expect(stockOf(db, b)).toBe(4000);

    // New item cheaper: the difference is refunded.
    const ex2 = saleReturns.exchange(
      db,
      {
        sale_return: {
          sale_id: ex.sale.id,
          refund: { mode: 'cash' },
          lines: [{ sale_item_id: ex.sale.items[0].id, qty_milli: 1000 }],
        },
        sale: bill(cash, [line(a, 1, 50000)]),
      },
      ctx,
    );
    expect(ex2.sale.due).toBe(0);
    const refunded = ex2.sale_return.refunds.reduce((sum, p) => sum + p.amount, 0);
    expect(refunded).toBe(177000 - 59000);
    expect(balance(db, cash)).toBe(0);
  });

  it('standalone return with a customer', () => {
    const db = freshDb();
    const v = stockItem(db, { stock: 0 });
    const c = customer(db);
    const r = saleReturns.create(
      db,
      {
        party_id: c.id,
        bill_type: 'gst',
        lines: [{ variant_id: v.id, qty_milli: 1000, rate: 11800, gst_rate_bp: 1800 }],
      },
      ctx,
    );
    expect(r.sale_id).toBeNull();
    expect(r.taxable_total).toBe(10000);
    expect(r.total).toBe(11800);
    expect(stockOf(db, v)).toBe(1000);
    expect(balance(db, c.id)).toBe(-11800);
  });
});

// ---------------------------------------------------------------- quotations, drafts, print

describe('quotations, held bills, printing', () => {
  it('quotation has no stock effect and converts once', () => {
    const db = freshDb();
    const v = stockItem(db, { stock: 1 });
    const c = customer(db);
    const q = quotations.create(db, bill(c.id, [line(v, 5, 1000)]), ctx);
    expect(q.quote_no).toBe('QT-0001');
    expect(stockOf(db, v)).toBe(1000);
    expect(balance(db, c.id)).toBe(0);
    const pre = sales.prefill(db, { quotation_id: q.id });
    expect(pre.lines[0].issues.join(' ')).toMatch(/in stock/);
    const s = sales.create(db, { ...bill(c.id, [line(v, 1, 1000)]), quotation_id: q.id }, ctx);
    expect(quotations.get(db, q.id).converted_sale.id).toBe(s.id);
    expect(() =>
      sales.create(db, { ...bill(c.id, [line(v, 1, 1000)]), quotation_id: q.id }, ctx),
    ).toThrow();
  });

  it('held bills are re-checked on resume', () => {
    const db = freshDb();
    const v = stockItem(db, { stock: 1 });
    const { id } = drafts.save(db, {
      form: { kind: 'bill', items: [{ variant_id: v.id, qty_milli: 3000, gst_rate_bp: 1800 }] },
    });
    const d = drafts.get(db, { id });
    expect(d.issues[0][0]).toMatch(/in stock/);
    drafts.discard(db, { id });
    expect(drafts.list(db)).toHaveLength(0);
  });

  it('invoice HTML: duplicate, cancelled watermark, warranty and UPI QR', () => {
    const db = freshDb();
    settings.updateSettings(db, { upi_id: 'pragati@okaxis' });
    const t = stockItem(db, { serials: ['Q1'], warranty: 12 });
    const unit = serials.inStock(db, { variant_id: t.id })[0];
    const c = customer(db);
    const s = sales.create(db, bill(c.id, [line(t, 1, 100000, { serial_ids: [unit.id] })]), ctx);
    const html = print.invoiceHtml(db, s.id, { format: 'a4' });
    expect(html).toContain('TAX INVOICE');
    expect(html).toContain('Q1');
    expect(html).toContain('warranty till');
    expect(html).toContain('<svg');
    expect(html).not.toContain('DUPLICATE');
    expect(sales.markPrinted(db, s.id, { format: 'a4' }, ctx)).toBe(false);
    expect(sales.markPrinted(db, s.id, { format: 'a4' }, ctx)).toBe(true);
    expect(print.invoiceHtml(db, s.id, { format: 'thermal80', duplicate: true })).toContain(
      'DUPLICATE',
    );
    sales.cancel(db, { id: s.id, reason: 'x' }, ctx);
    expect(print.invoiceHtml(db, s.id, { format: 'a4' })).toContain('CANCELLED');
  });

  it('saved bills are never deleted', () => {
    const db = freshDb();
    const v = stockItem(db);
    const c = customer(db);
    const s = sales.create(db, bill(c.id, [line(v, 1, 1000)]), ctx);
    expect(() => db.prepare('DELETE FROM sales WHERE id = ?').run(s.id)).toThrow(/never deleted/);
    expect(() => db.prepare('DELETE FROM sale_items WHERE sale_id = ?').run(s.id)).toThrow(
      /never deleted/,
    );
  });
});
