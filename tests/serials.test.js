import { afterEach, describe, expect, it } from 'vitest';
import { require, testPaths } from './helpers.js';

const { openDatabase } = require('../electron/db/connection.js');
const { migrate } = require('../electron/db/migrate.js');
const products = require('../electron/services/products.js');
const stock = require('../electron/services/stock.js');
const serials = require('../electron/services/serials.js');
const { warrantyEnd, warrantyStatus } = require('../electron/services/warranty.js');

const open = [];
function freshDb() {
  const db = openDatabase(testPaths().dbFile);
  open.push(db);
  migrate(db);
  return db;
}
afterEach(() => {
  while (open.length) open.pop().close();
});

const entries = (...list) => ({ entries: list.map((serial_no) => ({ serial_no })) });

function musicSystem(db, overrides = {}) {
  return products.create(db, {
    name: 'Android Music System',
    unit: 'pcs',
    gst_rate_bp: 1800,
    track_serials: true,
    customer_warranty_months: 12,
    supplier_warranty_months: 6,
    variants: [
      { selling_price: 999900, purchase_price: 650000, serials: entries('AB-001', 'AB-002') },
    ],
    ...overrides,
  });
}

describe('warranty dates', () => {
  it('adds calendar months minus one day (inclusive end)', () => {
    expect(warrantyEnd('2026-10-18', 12)).toBe('2027-10-17');
    expect(warrantyEnd('2026-10-01', 1)).toBe('2026-10-31');
    expect(warrantyEnd('2026-03-01', 1)).toBe('2026-03-31');
    expect(warrantyEnd('2026-12-15', 1)).toBe('2027-01-14');
    expect(warrantyEnd('2026-11-30', 3)).toBe('2027-02-28');
  });

  it('clamps to the last day of shorter months', () => {
    expect(warrantyEnd('2026-01-31', 1)).toBe('2026-02-28');
    expect(warrantyEnd('2028-01-31', 1)).toBe('2028-02-29'); // leap year
    expect(warrantyEnd('2026-01-30', 1)).toBe('2026-02-28');
    expect(warrantyEnd('2027-01-29', 1)).toBe('2027-02-28');
    expect(warrantyEnd('2026-01-28', 1)).toBe('2026-02-27');
    expect(warrantyEnd('2026-03-31', 1)).toBe('2026-04-30');
    expect(warrantyEnd('2028-02-29', 12)).toBe('2029-02-28');
  });

  it('has no end without months', () => {
    expect(warrantyEnd('2026-10-18', 0)).toBeNull();
    expect(warrantyEnd(null, 12)).toBeNull();
  });

  it('is active through the end date and expired from the next day', () => {
    expect(warrantyStatus('2027-10-17', '2027-10-17')).toEqual({
      status: 'expiring',
      days_left: 0,
    });
    expect(warrantyStatus('2027-10-17', '2027-10-18').status).toBe('expired');
    expect(warrantyStatus('2027-10-17', '2027-09-17').status).toBe('expiring'); // 30 days left
    expect(warrantyStatus('2027-10-17', '2027-09-16').status).toBe('active'); // 31 days left
    expect(warrantyStatus(null, '2027-01-01').status).toBe('none');
  });
});

describe('serial numbers', () => {
  it('creates opening stock from serials and keeps stock = in-stock units', () => {
    const db = freshDb();
    const p = musicSystem(db);
    const v = p.variants[0];
    expect(v.stock_milli).toBe(2000);
    expect(v.serials_in_stock).toBe(2);
    expect(serials.consistency(db, v.id).ok).toBe(true);
    const unit = serials.list(db, { product_id: p.id }).rows.find((r) => r.serial_no === 'AB-001');
    expect(unit.supplier_warranty_end).toBe(warrantyEnd(unit.purchase_date, 6));
    expect(serials.get(db, unit.id).events[0]).toMatchObject({
      type: 'received_opening',
      to_status: 'in_stock',
    });
  });

  it('rejects duplicates in the list and on the same product (case/space-insensitive), warns for other products', () => {
    const db = freshDb();
    const p = musicSystem(db);
    const check = serials.checkSerials(db, {
      product_id: p.id,
      entries: [
        { serial_no: ' ab-001 ' },
        { serial_no: 'NEW-1' },
        { serial_no: 'new-1' },
        { serial_no: '' },
      ],
    });
    expect(check[0].error).toMatch(/Already exists on this product/);
    expect(check[1].error).toBeNull();
    expect(check[2].error).toMatch(/Repeated/);
    expect(check[3].error).toMatch(/Empty/);

    const other = serials.checkSerials(db, {
      product_id: null,
      entries: [{ serial_no: 'AB-002' }],
    });
    expect(other[0].error).toBeNull();
    expect(other[0].warning).toMatch(/Android Music System/);

    expect(() =>
      musicSystem(db, {
        name: 'Dup',
        variants: [{ selling_price: 1, serials: entries('X1', 'x1') }],
      }),
    ).toThrow(/Repeated/);
  });

  it('auto-generates numbers per prefix after the highest used', () => {
    const db = freshDb();
    const p = musicSystem(db, {
      variants: [
        { selling_price: 100, serials: { entries: [], auto: { prefix: 'OLD-', count: 3 } } },
      ],
    });
    const rows = serials.list(db, { product_id: p.id }).rows;
    expect(rows.map((r) => r.serial_no).sort()).toEqual(['OLD-0001', 'OLD-0002', 'OLD-0003']);
    expect(rows.every((r) => r.is_auto === 1)).toBe(true);
    expect(serials.previewAuto(db, { prefix: 'OLD-', count: 2 })).toEqual(['OLD-0004', 'OLD-0005']);
  });

  it('adds and removes stock by serial in one movement each', () => {
    const db = freshDb();
    const p = musicSystem(db);
    const v = p.variants[0];
    expect(() => stock.adjust(db, { variant_id: v.id, qty_milli: 1000, reason: 'x' })).toThrow(
      /serial numbers/,
    );

    stock.adjust(db, { variant_id: v.id, reason: 'Found', serials: entries('AB-003', 'AB-004') });
    const ids = serials
      .inStock(db, { variant_id: v.id })
      .slice(0, 2)
      .map((r) => r.id);
    stock.adjust(db, {
      variant_id: v.id,
      reason: 'Broken in shop',
      serial_ids: ids,
      to_status: 'defective',
    });

    expect(serials.consistency(db, v.id)).toMatchObject({
      ok: true,
      in_stock_units: 2,
      defective_units: 2,
    });
    const moves = db
      .prepare(
        "SELECT qty_milli FROM stock_movements WHERE variant_id = ? AND location = 'main' ORDER BY id",
      )
      .pluck()
      .all(v.id);
    expect(moves).toEqual([2000, 2000, -2000]);
    expect(serials.defectiveStock(db, v.id).qty_milli).toBe(2000);
    expect(() =>
      stock.adjust(db, {
        variant_id: v.id,
        reason: 'again',
        serial_ids: ids,
        to_status: 'written_off',
      }),
    ).toThrow(/not in stock/);
  });

  it('repairs a defective unit back to stock and writes off another, with history', () => {
    const db = freshDb();
    const p = musicSystem(db);
    const [a, b] = serials.inStock(db, { variant_id: p.variants[0].id });
    serials.setStatus(db, { id: a.id, to_status: 'defective', reason: 'No sound' });
    serials.setStatus(db, { id: a.id, to_status: 'in_stock', reason: 'Fuse replaced' });
    serials.setStatus(db, { id: b.id, to_status: 'written_off', reason: 'Water damage' });
    expect(() => serials.setStatus(db, { id: b.id, to_status: 'in_stock', reason: 'x' })).toThrow(
      /cannot be changed/,
    );
    expect(() => serials.setStatus(db, { id: a.id, to_status: 'defective', reason: '' })).toThrow(
      /reason/,
    );

    expect(serials.consistency(db, p.variants[0].id)).toMatchObject({
      ok: true,
      in_stock_units: 1,
    });
    expect(serials.get(db, a.id).events.map((e) => e.type)).toEqual([
      'received_opening',
      'marked_defective',
      'repaired_to_stock',
    ]);
  });

  it('overrides warranty with a reason in history', () => {
    const db = freshDb();
    const p = musicSystem(db);
    const [a] = serials.inStock(db, { variant_id: p.variants[0].id });
    expect(() =>
      serials.setWarranty(db, { id: a.id, warranty_end: '2028-01-01', reason: '' }),
    ).toThrow(/reason/);
    const s = serials.setWarranty(db, {
      id: a.id,
      warranty_end: '2028-01-01',
      reason: 'Dealer extension',
    });
    expect(s).toMatchObject({ warranty_end: '2028-01-01', warranty_overridden: 1 });
    expect(s.events.at(-1).note).toMatch(/Dealer extension/);
  });

  it('turning tracking on needs exactly one serial per unit in stock; off only with none in stock', () => {
    const db = freshDb();
    const p = products.create(db, {
      name: 'Speaker Set',
      gst_rate_bp: 1800,
      variants: [{ selling_price: 500000, opening_stock_milli: 3000 }],
    });
    const base = { name: 'Speaker Set', gst_rate_bp: 1800, track_serials: true };
    const variant = (serialInput) => [
      { id: p.variants[0].id, selling_price: 500000, serials: serialInput },
    ];

    expect(() =>
      products.update(db, p.id, { ...base, variants: variant(entries('S1', 'S2')) }),
    ).toThrow(/exactly 3/);
    const updated = products.update(db, p.id, {
      ...base,
      variants: variant({ entries: [{ serial_no: 'S1' }], auto: { prefix: 'OLD-', count: 2 } }),
    });
    expect(updated.track_serials).toBe(1);
    expect(updated.variants[0].stock_milli).toBe(3000); // no stock movement added
    expect(serials.consistency(db, p.variants[0].id).ok).toBe(true);

    expect(() =>
      products.update(db, p.id, { ...base, track_serials: false, variants: variant() }),
    ).toThrow(/turned off/);
  });

  it('finds serials across products with the product name', () => {
    const db = freshDb();
    musicSystem(db);
    products.create(db, {
      name: 'Reverse Camera',
      gst_rate_bp: 1800,
      track_serials: true,
      variants: [{ selling_price: 1, serials: entries('AB-002') }],
    });
    const hits = serials.search(db, { query: 'ab-002' });
    expect(hits.map((h) => h.product_name).sort()).toEqual([
      'Android Music System',
      'Reverse Camera',
    ]);
  });

  it('never deletes serial rows or history', () => {
    const db = freshDb();
    const p = musicSystem(db);
    const [a] = serials.inStock(db, { variant_id: p.variants[0].id });
    expect(() => db.prepare('DELETE FROM product_serials WHERE id = ?').run(a.id)).toThrow(
      /never deleted/,
    );
    expect(() => db.prepare('DELETE FROM serial_events WHERE serial_id = ?').run(a.id)).toThrow(
      /append-only/,
    );
  });
});
