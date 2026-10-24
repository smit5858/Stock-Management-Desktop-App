import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { require, tempDir, testPaths } from './helpers.js';

const { openDatabase } = require('../electron/db/connection.js');
const { migrate, MIGRATIONS_DIR, currentVersion } = require('../electron/db/migrate.js');
const settings = require('../electron/services/settings.js');
const products = require('../electron/services/products.js');
const parties = require('../electron/services/parties.js');
const serials = require('../electron/services/serials.js');
const stock = require('../electron/services/stock.js');
const purchases = require('../electron/services/purchases.js');
const returns = require('../electron/services/purchaseReturns.js');
const drafts = require('../electron/services/purchaseDrafts.js');
const billing = require('../electron/services/billing.js');

const open = [];
function freshDb() {
  const db = openDatabase(testPaths().dbFile);
  open.push(db);
  migrate(db);
  settings.updateSettings(db, { business_state_code: '24' });
  return db;
}
afterEach(() => {
  while (open.length) {
    const db = open.pop();
    if (db.open) db.close();
  }
});

const TODAY = new Date().toISOString().slice(0, 10);
const supplier = (db, party = {}) =>
  parties.create(db, {
    type: 'supplier',
    party: { name: 'Ramesh Traders', state_code: '24', ...party },
  });

function item(db, overrides = {}) {
  const p = products.create(db, {
    name: overrides.name || 'Seat Cover',
    unit: 'pcs',
    gst_rate_bp: 1800,
    track_serials: Boolean(overrides.track_serials),
    supplier_warranty_months: overrides.supplier_warranty_months || 0,
    variants: [{ selling_price: 150000, mrp: 200000, purchase_price: 0 }],
  });
  return { product: p, variant: p.variants[0] };
}

const stockOf = (db, vid) => products.variantStock(db, vid);
const avgOf = (db, vid) =>
  db.prepare('SELECT avg_cost FROM product_variants WHERE id = ?').pluck().get(vid);

function bill(partyId, items, extra = {}) {
  return {
    party_id: partyId,
    bill_no: 'INV-1',
    bill_date: TODAY,
    entry_date: TODAY,
    bill_type: 'gst',
    price_mode: 'exclusive',
    items,
    ...extra,
  };
}

const line = (variantId, qty, rate, extra = {}) => ({
  variant_id: variantId,
  qty_milli: qty * 1000,
  rate,
  gst_rate_bp: 1800,
  ...extra,
});

describe('billing maths', () => {
  it('divRound rounds half up', () => {
    expect(billing.divRound(5, 2)).toBe(3);
    expect(billing.divRound(4, 3)).toBe(1);
    expect(billing.divRound(-5, 2)).toBe(-3);
  });

  it('spread always adds up exactly (largest remainder)', () => {
    expect(billing.spread(100, [1, 1, 1])).toEqual([34, 33, 33]);
    expect(billing.spread(1000, [300, 700])).toEqual([300, 700]);
    expect(billing.spread(7, [0, 0])).toEqual([4, 3]);
    const parts = billing.spread(99999, [12345, 67890, 1, 0, 5]);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(99999);
  });

  it('exclusive tax: CGST + SGST in state, IGST across states', () => {
    const base = { bill_type: 'gst', price_mode: 'exclusive', charges: [] };
    const items = [{ qty_milli: 2000, rate: 50000, discount: 0, gst_rate_bp: 1800 }];
    const intra = billing.calculatePurchase({ ...base, is_interstate: false, items });
    expect(intra.items[0]).toMatchObject({ taxable: 100000, cgst: 9000, sgst: 9000, igst: 0 });
    expect(intra.totals.grand_total).toBe(118000);
    const inter = billing.calculatePurchase({ ...base, is_interstate: true, items });
    expect(inter.items[0]).toMatchObject({ taxable: 100000, cgst: 0, sgst: 0, igst: 18000 });
  });

  it('inclusive tax: line total equals the amount entered', () => {
    const r = billing.calculatePurchase({
      bill_type: 'gst',
      price_mode: 'inclusive',
      is_interstate: false,
      items: [{ qty_milli: 1000, rate: 118000, discount: 0, gst_rate_bp: 1800 }],
      charges: [],
    });
    expect(r.items[0]).toMatchObject({
      taxable: 100000,
      cgst: 9000,
      sgst: 9000,
      line_total: 118000,
    });
    // Odd amount: halves stay equal, total still matches what was typed.
    const odd = billing.calculatePurchase({
      bill_type: 'gst',
      price_mode: 'inclusive',
      is_interstate: false,
      items: [{ qty_milli: 1000, rate: 99999, discount: 0, gst_rate_bp: 1800 }],
      charges: [],
    });
    expect(odd.items[0].cgst).toBe(odd.items[0].sgst);
    expect(odd.items[0].line_total).toBe(99999);
  });

  it('non-GST bills have no tax; % discount is applied before tax', () => {
    const r = billing.calculatePurchase({
      bill_type: 'non_gst',
      price_mode: 'exclusive',
      items: [{ qty_milli: 3000, rate: 10000, discount_bp: 1000, gst_rate_bp: 1800 }],
      charges: [],
    });
    expect(r.items[0]).toMatchObject({ gross: 30000, discount: 3000, taxable: 27000, cgst: 0 });
    expect(r.totals.tax_total).toBe(0);
  });

  it('rounds the bill total to the rupee', () => {
    const r = billing.calculatePurchase({
      bill_type: 'non_gst',
      price_mode: 'exclusive',
      items: [{ qty_milli: 1000, rate: 10049, discount: 0, gst_rate_bp: 0 }],
      charges: [],
    });
    expect(r.totals.round_off).toBe(-49);
    expect(r.totals.grand_total).toBe(10000);
  });

  it('spreads extra charges into landed cost by value (cost mode only)', () => {
    const input = {
      bill_type: 'gst',
      price_mode: 'exclusive',
      is_interstate: false,
      charges_mode: 'cost',
      items: [
        { qty_milli: 1000, rate: 30000, discount: 0, gst_rate_bp: 1800 },
        { qty_milli: 1000, rate: 70000, discount: 0, gst_rate_bp: 1800 },
      ],
      charges: [{ kind: 'freight', amount: 10000, gst_rate_bp: 1800 }],
    };
    const r = billing.calculatePurchase(input);
    expect(r.items.map((i) => i.charges_share)).toEqual([3000, 7000]);
    expect(r.items.map((i) => i.unit_cost)).toEqual([33000, 77000]); // GST is not cost
    expect(r.totals.grand_total).toBe(100000 * 1.18 + 11800);
    const exp = billing.calculatePurchase({ ...input, charges_mode: 'expense' });
    expect(exp.items.map((i) => i.unit_cost)).toEqual([30000, 70000]);
    expect(exp.totals.grand_total).toBe(r.totals.grand_total); // still payable to the supplier
  });

  it('includes free quantity in the unit cost', () => {
    const r = billing.calculatePurchase({
      bill_type: 'gst',
      price_mode: 'exclusive',
      items: [
        { qty_milli: 10000, free_qty_milli: 2000, rate: 12000, discount: 0, gst_rate_bp: 1800 },
      ],
      charges: [],
    });
    expect(r.items[0].unit_cost).toBe(10000); // ₹1200 over 12 units
  });

  it('weighted average: in, out at cost, negative stock counts as zero', () => {
    expect(billing.averageIn({ stock_milli: 10000, avg_cost: 10000 }, 10000, 200000)).toBe(15000);
    expect(billing.averageIn({ stock_milli: -3000, avg_cost: 10000 }, 5000, 100000)).toBe(20000);
    expect(billing.averageOut({ stock_milli: 20000, avg_cost: 15000 }, 10000, 20000)).toBe(10000);
    expect(billing.averageOut({ stock_milli: 5000, avg_cost: 15000 }, 5000, 20000)).toBe(15000);
  });
});

describe('purchase save', () => {
  it('adds stock, cost, ledger entry and number in one go', () => {
    const db = freshDb();
    const s = supplier(db, { payment_terms_days: 30 });
    const { variant } = item(db);
    const p = purchases.create(
      db,
      bill(s.id, [line(variant.id, 10, 50000, { free_qty_milli: 2000 })]),
    );
    expect(p.entry_no).toBe('PUR-0001');
    expect(p.grand_total).toBe(590000);
    expect(p.due_date).toBe(purchases.addDays(TODAY, 30));
    expect(stockOf(db, variant.id)).toBe(12000);
    expect(avgOf(db, variant.id)).toBe(41667); // ₹5000 / 12
    expect(parties.balanceOf(db, s.id)).toBe(-590000);
    const m = db.prepare("SELECT * FROM stock_movements WHERE type = 'purchase'").get();
    expect(m).toMatchObject({ qty_milli: 12000, unit_cost: 41667, ref_type: 'purchase_item' });
    expect(p.pay_status).toBe('unpaid');
    expect(p.audit[0].action).toBe('created');
  });

  it('uses IGST for a supplier in another state', () => {
    const db = freshDb();
    const s = supplier(db, { state_code: '27' });
    const { variant } = item(db);
    const p = purchases.create(db, bill(s.id, [line(variant.id, 1, 100000)]));
    expect(p).toMatchObject({ is_interstate: 1, igst_total: 18000, cgst_total: 0 });
  });

  it('blocks the same supplier bill number twice', () => {
    const db = freshDb();
    const s = supplier(db);
    const { variant } = item(db);
    purchases.create(db, bill(s.id, [line(variant.id, 1, 100)], { bill_no: 'inv 77' }));
    expect(purchases.checkBillNo(db, { party_id: s.id, bill_no: 'INV77' }).duplicate.entry_no).toBe(
      'PUR-0001',
    );
    expect(() =>
      purchases.create(db, bill(s.id, [line(variant.id, 1, 100)], { bill_no: 'INV77' })),
    ).toThrow(/Already entered: PUR-0001/);
    // Another supplier may use the same number.
    const other = supplier(db, { name: 'Other' });
    expect(
      purchases.create(db, bill(other.id, [line(variant.id, 1, 100)], { bill_no: 'INV77' }))
        .entry_no,
    ).toBe('PUR-0002');
    // The failed attempt did not use up a number.
    expect(settings.listSequences(db).find((q) => q.name === 'purchase').next_value).toBe(3);
  });

  it('asks for confirmation when the printed total differs, and flags it', () => {
    const db = freshDb();
    const s = supplier(db);
    const { variant } = item(db);
    const payload = bill(s.id, [line(variant.id, 1, 100000)], { printed_total: 118100 });
    expect(() => purchases.create(db, payload)).toThrow(/differs from the printed bill/);
    const p = purchases.create(db, { ...payload, confirm_mismatch: true });
    expect(p).toMatchObject({ total_mismatch: 1, mismatch_amount: 100 });
    expect(purchases.list(db, { mismatched: true }).rows).toHaveLength(1);
  });

  it('records payment at purchase and adjusts an advance', () => {
    const db = freshDb();
    const s = supplier(db, { opening_amount: 50000, opening_type: 'advance' });
    const { variant } = item(db);
    const p = purchases.create(
      db,
      bill(s.id, [line(variant.id, 1, 100000)], {
        payment: { amount: 60000, mode: 'upi' },
        advance_amount: 50000,
      }),
    );
    expect(p.paid).toBe(110000);
    expect(p.pay_status).toBe('partial');
    expect(parties.balanceOf(db, s.id)).toBe(50000 - 118000 + 60000);
    expect(() => purchases.recordPayment(db, { id: p.id, amount: 1000, mode: 'advance' })).toThrow(
      /advance is available/,
    );
    const paid = purchases.recordPayment(db, { id: p.id, amount: 8000, mode: 'cash' });
    expect(paid.pay_status).toBe('paid');
  });

  it('serial items need one serial per unit (qty + free) and get the supplier warranty', () => {
    const db = freshDb();
    const s = supplier(db);
    const { variant } = item(db, {
      name: 'Music System',
      track_serials: true,
      supplier_warranty_months: 12,
    });
    const l = line(variant.id, 2, 500000, { free_qty_milli: 1000 });
    expect(() =>
      purchases.create(db, bill(s.id, [{ ...l, serials: { entries: [{ serial_no: 'A1' }] } }])),
    ).toThrow(/Enter 3 serial numbers/);
    const p = purchases.create(
      db,
      bill(
        s.id,
        [
          {
            ...l,
            serials: {
              entries: [{ serial_no: 'A1' }, { serial_no: 'A2' }],
              auto: { prefix: 'MS-', count: 1 },
            },
          },
        ],
        {
          bill_date: '2026-01-31',
        },
      ),
    );
    expect(p.items[0].serials).toHaveLength(3);
    expect(p.items[0].serials[0].supplier_warranty_end).toBe('2027-01-30');
    expect(serials.consistency(db, variant.id).ok).toBe(true);
    expect(stockOf(db, variant.id)).toBe(3000);
  });
});

describe('edit and cancel', () => {
  function setup() {
    const db = freshDb();
    const s = supplier(db);
    const { variant } = item(db);
    const p = purchases.create(db, bill(s.id, [line(variant.id, 10, 10000)]));
    return { db, s, variant, p };
  }

  it('edit = reverse + re-apply, with audit and the same entry number', () => {
    const { db, s, variant, p } = setup();
    const e = purchases.update(db, p.id, bill(s.id, [line(variant.id, 8, 12500)]));
    expect(e.entry_no).toBe(p.entry_no);
    expect(e.revision).toBe(2);
    expect(stockOf(db, variant.id)).toBe(8000);
    expect(avgOf(db, variant.id)).toBe(12500);
    expect(e.items).toHaveLength(1);
    expect(parties.balanceOf(db, s.id)).toBe(-118000);
    expect(e.audit[0]).toMatchObject({ action: 'edited' });
    expect(e.audit[0].details.lines.changed[0].qty_milli).toEqual([10000, 8000]);
    // Movements are only appended.
    expect(db.prepare('SELECT COUNT(*) FROM stock_movements').pluck().get()).toBe(3);
  });

  it('refuses an edit or cancel that would make stock negative', () => {
    const { db, s, variant, p } = setup();
    stock.adjust(db, { variant_id: variant.id, qty_milli: -7000, reason: 'Sold (manual)' });
    expect(() => purchases.update(db, p.id, bill(s.id, [line(variant.id, 2, 10000)]))).toThrow(
      /negative/,
    );
    expect(purchases.editCheck(db, { id: p.id }).can_cancel).toBe(false);
    expect(() => purchases.cancel(db, { id: p.id, reason: 'x' })).toThrow(/negative/);
    // Raising the quantity is fine.
    expect(purchases.update(db, p.id, bill(s.id, [line(variant.id, 12, 10000)])).revision).toBe(2);
  });

  it('cancel reverses stock and ledger; paid money stays as advance or is refunded', () => {
    const { db, s, variant } = setup();
    const p2 = purchases.create(
      db,
      bill(s.id, [line(variant.id, 1, 10000)], {
        bill_no: 'INV-2',
        payment: { amount: 11800, mode: 'cash' },
      }),
    );
    const before = parties.balanceOf(db, s.id);
    const c = purchases.cancel(db, { id: p2.id, reason: 'Wrong supplier' });
    expect(c.status).toBe('cancelled');
    expect(stockOf(db, variant.id)).toBe(10000);
    expect(parties.balanceOf(db, s.id)).toBe(before + 11800); // payment now an advance
    // Re-entering the same bill number is allowed after a cancel.
    const p3 = purchases.create(
      db,
      bill(s.id, [line(variant.id, 1, 10000)], {
        bill_no: 'INV-2',
        payment: { amount: 11800, mode: 'cash' },
      }),
    );
    const c3 = purchases.cancel(db, {
      id: p3.id,
      reason: 'Damaged goods',
      refund: { amount: 11800, mode: 'cash' },
    });
    expect(c3.refunds).toHaveLength(1);
    expect(() => purchases.cancel(db, { id: p3.id, reason: 'again' })).toThrow(/cancelled/);
  });

  it('cannot edit or cancel once a serial from it is sold or claimed', () => {
    const db = freshDb();
    const s = supplier(db);
    const { variant } = item(db, { track_serials: true });
    const p = purchases.create(
      db,
      bill(s.id, [
        {
          ...line(variant.id, 2, 1000),
          serials: { entries: [{ serial_no: 'X1' }, { serial_no: 'X2' }] },
        },
      ]),
    );
    db.prepare("UPDATE product_serials SET status = 'sold' WHERE serial_no = 'X1'").run();
    const check = purchases.editCheck(db, { id: p.id });
    expect(check.can_edit).toBe(false);
    expect(check.reasons[0]).toMatch(/X1 is sold/);
    expect(() => purchases.cancel(db, { id: p.id, reason: 'x' })).toThrow(/cannot be cancelled/);
  });

  it('edit keeps unchanged serials, voids removed ones and frees their numbers', () => {
    const db = freshDb();
    const s = supplier(db);
    const { variant } = item(db, { track_serials: true });
    const sl = (...list) => ({ entries: list.map((serial_no) => ({ serial_no })) });
    const p = purchases.create(
      db,
      bill(s.id, [{ ...line(variant.id, 2, 1000), serials: sl('S-1', 'S-2X') }]),
    );
    const keptId = p.items[0].serials[0].id;
    const e = purchases.update(
      db,
      p.id,
      bill(s.id, [{ ...line(variant.id, 2, 1000), serials: sl('S-1', 'S-2') }]),
    );
    expect(e.items[0].serials.map((x) => x.serial_no)).toEqual(['S-1', 'S-2']);
    expect(e.items[0].serials[0].id).toBe(keptId);
    expect(
      db.prepare("SELECT status FROM product_serials WHERE serial_no = 'S-2X'").pluck().get(),
    ).toBe('voided');
    expect(serials.consistency(db, variant.id).ok).toBe(true);
    // A voided number can be entered again.
    purchases.update(
      db,
      p.id,
      bill(s.id, [{ ...line(variant.id, 3, 1000), serials: sl('S-1', 'S-2', 'S-2X') }]),
    );
    expect(serials.consistency(db, variant.id)).toMatchObject({ ok: true, in_stock_units: 3 });
    purchases.cancel(db, { id: p.id, reason: 'test' });
    expect(serials.consistency(db, variant.id)).toMatchObject({ ok: true, in_stock_units: 0 });
  });

  it('does not let the new total go below what was paid', () => {
    const { db, s, variant, p } = setup();
    purchases.recordPayment(db, { id: p.id, amount: 100000, mode: 'cash' });
    expect(() => purchases.update(db, p.id, bill(s.id, [line(variant.id, 5, 10000)]))).toThrow(
      /already paid/,
    );
  });
});

describe('purchase returns', () => {
  function setup(extra = {}) {
    const db = freshDb();
    const s = supplier(db);
    const { variant } = item(db);
    const p = purchases.create(
      db,
      bill(s.id, [line(variant.id, 10, 12000, { free_qty_milli: 2000 })], extra),
    );
    return { db, s, variant, p };
  }

  it('limits qty to purchased − returned and numbers by bill type', () => {
    const { db, s, variant, p } = setup();
    const itemId = p.items[0].id;
    const r = returns.create(db, {
      purchase_id: p.id,
      lines: [{ purchase_item_id: itemId, qty_milli: 3000 }],
    });
    expect(r.return_no).toBe('DN-GST-0001');
    // Proportional credit: ₹1200 taxable over 12 units → ₹100 per unit.
    expect(r.lines[0]).toMatchObject({ default_taxable: 30000, taxable: 30000, cgst: 2700 });
    expect(r.total).toBe(35400);
    expect(stockOf(db, variant.id)).toBe(9000);
    expect(() =>
      returns.create(db, {
        purchase_id: p.id,
        lines: [{ purchase_item_id: itemId, qty_milli: 10000 }],
      }),
    ).toThrow(/Only 9 pcs can still be returned/);
    expect(parties.balanceOf(db, s.id)).toBe(-p.grand_total + 35400);
    expect(purchases.get(db, p.id).paid).toBe(35400); // reduces this bill's due
    expect(purchases.editCheck(db, { id: p.id }).can_edit).toBe(false);
  });

  it('agreed credit may differ; stock still leaves at the original cost', () => {
    const { db, variant, p } = setup();
    // Average after purchase = 10000/unit. Buy more at a higher cost.
    const s2 = supplier(db, { name: 'B' });
    purchases.create(db, bill(s2.id, [line(variant.id, 12, 22000)], { bill_no: 'B1' }));
    expect(avgOf(db, variant.id)).toBe(16000);
    const r = returns.create(db, {
      purchase_id: p.id,
      lines: [{ purchase_item_id: p.items[0].id, qty_milli: 2000, taxable: 0 }],
    });
    expect(r.total).toBe(0);
    expect(r.lines[0].unit_cost).toBe(10000);
    // (24 × 16000 − 2 × 10000) / 22
    expect(avgOf(db, variant.id)).toBe(billing.divRound(24 * 16000 - 2 * 10000, 22));
    const m = db.prepare("SELECT * FROM stock_movements WHERE type = 'purchase_return'").get();
    expect(m).toMatchObject({ qty_milli: -2000, unit_cost: 10000 });
  });

  it('non-GST bills use the DN-EST series; refund is recorded as money received', () => {
    const { db, s, p } = setup({ bill_type: 'non_gst' });
    const before = parties.balanceOf(db, s.id);
    const r = returns.create(db, {
      purchase_id: p.id,
      settlement: 'refund',
      refund: { mode: 'cash' },
      lines: [{ purchase_item_id: p.items[0].id, qty_milli: 1000 }],
    });
    expect(r.return_no).toBe('DN-EST-0001');
    expect(r.refund).toMatchObject({ amount: 10000, mode: 'cash' });
    expect(parties.balanceOf(db, s.id)).toBe(before); // credit and refund cancel out
  });

  it('serial returns: only in-stock / defective units of that bill; cancel brings them back', () => {
    const db = freshDb();
    const s = supplier(db);
    const { variant } = item(db, { track_serials: true });
    const p = purchases.create(
      db,
      bill(s.id, [
        {
          ...line(variant.id, 3, 1000),
          serials: { entries: [{ serial_no: 'R1' }, { serial_no: 'R2' }, { serial_no: 'R3' }] },
        },
      ]),
    );
    const [r1, r2, r3] = p.items[0].serials;
    serials.setStatus(db, { id: r2.id, to_status: 'defective', reason: 'Dead on arrival' });
    serials.setStatus(db, { id: r3.id, to_status: 'written_off', reason: 'Lost' });
    expect(() =>
      returns.create(db, {
        purchase_id: p.id,
        lines: [{ purchase_item_id: p.items[0].id, qty_milli: 1000, serial_ids: [r3.id] }],
      }),
    ).toThrow(/cannot be returned/);
    const r = returns.create(db, {
      purchase_id: p.id,
      lines: [{ purchase_item_id: p.items[0].id, qty_milli: 2000, serial_ids: [r1.id, r2.id] }],
    });
    expect(serials.consistency(db, variant.id)).toMatchObject({ ok: true, in_stock_units: 0 });
    returns.cancel(db, { id: r.id, reason: 'Supplier refused' });
    expect(db.prepare('SELECT status FROM product_serials WHERE id = ?').pluck().get(r2.id)).toBe(
      'defective',
    );
    expect(serials.consistency(db, variant.id)).toMatchObject({ ok: true, in_stock_units: 1 });
  });
});

describe('drafts', () => {
  it('stores a schema version and reports problem lines on resume', () => {
    const db = freshDb();
    const { product, variant } = item(db);
    const { id } = drafts.save(db, {
      form: { items: [{ variant_id: variant.id, gst_rate_bp: 1800 }, { variant_id: 99999 }] },
    });
    expect(
      JSON.parse(db.prepare('SELECT data FROM purchase_drafts WHERE id = ?').pluck().get(id)).v,
    ).toBe(1);
    products.setActive(db, { id: product.id, is_active: false });
    const d = drafts.get(db, { id });
    expect(d.issues[0][0]).toMatch(/inactive/);
    expect(d.issues[1][0]).toMatch(/removed/);
    expect(d.form.items).toHaveLength(2); // nothing dropped
  });
});

describe('migration safety', () => {
  it('upgrades a v4 database and keeps serials', () => {
    const v4 = tempDir();
    for (const f of fs.readdirSync(MIGRATIONS_DIR).filter((x) => x < '005')) {
      fs.copyFileSync(path.join(MIGRATIONS_DIR, f), path.join(v4, f));
    }
    const db = openDatabase(path.join(tempDir(), 'app.db'));
    open.push(db);
    migrate(db, v4);
    const pid = db
      .prepare("INSERT INTO products (name, track_serials) VALUES ('Cam', 1)")
      .run().lastInsertRowid;
    const vid = db
      .prepare("INSERT INTO product_variants (product_id, sku) VALUES (?, 'C1')")
      .run(pid).lastInsertRowid;
    db.prepare(
      "INSERT INTO product_serials (product_id, variant_id, serial_no, serial_key, source_type) VALUES (?, ?, 'z1', 'Z1', 'opening')",
    ).run(pid, vid);
    expect(migrate(db)).toEqual(['005_purchases', '006_sales', '007_warranty']);
    expect(db.prepare('SELECT serial_no FROM product_serials').pluck().all()).toEqual(['z1']);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });

  it('rolls back a rebuild that breaks a foreign key, and switches foreign keys back on', () => {
    const dir = tempDir();
    for (const f of fs.readdirSync(MIGRATIONS_DIR)) {
      fs.copyFileSync(path.join(MIGRATIONS_DIR, f), path.join(dir, f));
    }
    fs.writeFileSync(
      path.join(dir, '099_bad_rebuild.sql'),
      "-- foreign_keys: off\nCREATE TABLE half (a INTEGER);\nINSERT INTO product_variants (product_id, sku) VALUES (424242, 'ORPHAN');\n",
    );
    const db = openDatabase(path.join(tempDir(), 'app.db'));
    open.push(db);
    expect(() => migrate(db, dir)).toThrow(/foreign key check failed/);
    expect(currentVersion(db)).toBe(7);
    expect(db.prepare("SELECT COUNT(*) FROM sqlite_master WHERE name = 'half'").pluck().get()).toBe(
      0,
    );
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
  });
});

describe('barcode labels and goods received note', () => {
  const barcode = require('../electron/services/barcode.js');
  const print = require('../electron/services/purchasePrint.js');

  it('Code 128 table is complete and the checksum follows the standard', () => {
    expect(barcode.PATTERNS).toHaveLength(106);
    for (const pat of barcode.PATTERNS) {
      expect([...pat].reduce((s, c) => s + Number(c), 0)).toBe(11);
    }
    expect(barcode.encode128B('A')).toEqual([104, 33, 34]);
    // start + 8 symbols + checksum = 10 × 11 modules, + stop (13)
    expect(barcode.modules('PC-00001').reduce((s, w) => s + w, 0)).toBe(10 * 11 + 13);
    expect(() => barcode.encode128B('₹')).toThrow();
  });

  it('renders the GRN and labels for a purchase', () => {
    const db = freshDb();
    const s = supplier(db);
    const { variant } = item(db);
    const p = purchases.create(db, bill(s.id, [line(variant.id, 2, 10000)]));
    const html = print.grnHtml(db, p.id);
    expect(html).toContain('Goods Received Note');
    expect(html).toContain(p.entry_no);
    const labels = print.labelsHtml(db, {
      id: p.id,
      size: 'a4',
      items: [{ variant_id: variant.id, copies: 3 }],
    });
    expect(labels.match(/class="label"/g)).toHaveLength(3);
    expect(labels).toContain('<svg');
  });
});
