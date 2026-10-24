import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { require, tempDir, testPaths } from './helpers.js';

const { openDatabase } = require('../electron/db/connection.js');
const { migrate } = require('../electron/db/migrate.js');
const products = require('../electron/services/products.js');
const stock = require('../electron/services/stock.js');
const productImport = require('../electron/services/productImport.js');
const { parseMoney, parseQty, isISODate } = require('../electron/services/parse.js');

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

function vehicleId(db, make, model) {
  return db
    .prepare('SELECT id FROM vehicle_models WHERE make = ? AND model = ?')
    .pluck()
    .get(make, model);
}

const seatCover = (db, overrides = {}) => ({
  product_type: 'stock',
  name: 'Premium Seat Cover',
  category_id: 1,
  brand: 'Autoform',
  unit: 'set',
  hsn_code: '8708',
  gst_rate_bp: 1800,
  price_includes_gst: true,
  has_variants: true,
  is_universal: false,
  vehicles: [
    { vehicle_model_id: vehicleId(db, 'Maruti Suzuki', 'Swift'), year_from: 2018, year_to: 2024 },
  ],
  warranty_months: 6,
  variants: [
    {
      color: 'Black',
      purchase_price: 220000,
      mrp: 399900,
      selling_price: 349900,
      opening_stock_milli: 5000,
      min_stock_milli: 2000,
    },
    {
      color: 'Beige',
      purchase_price: 220000,
      mrp: 399900,
      selling_price: 349900,
      opening_stock_milli: 1000,
      min_stock_milli: 2000,
    },
  ],
  ...overrides,
});

describe('parse helpers', () => {
  it('parses money and quantities without floats', () => {
    expect(parseMoney('3,499.50')).toBe(349950);
    expect(parseMoney(199.99)).toBe(19999);
    expect(parseMoney('Rs. 10')).toBe(1000);
    expect(parseQty('1.25')).toBe(1250);
    expect(parseQty('1.2345')).toBeNull();
  });

  it('validates dates without timezone shifts', () => {
    expect(isISODate('2026-10-18')).toBe(true);
    expect(isISODate('2026-02-30')).toBe(false);
    expect(isISODate('18-10-2026')).toBe(false);
  });
});

describe('products', () => {
  it('creates a product with variants, auto SKUs, opening stock and vehicles', () => {
    const db = freshDb();
    const p = products.create(db, seatCover(db));
    expect(p.variants).toHaveLength(2);
    expect(p.variants[0].sku).toBe('PC-00001');
    expect(p.variants[1].sku).toBe('PC-00002');
    expect(p.variants.map((v) => v.stock_milli)).toEqual([5000, 1000]);
    expect(p.vehicles[0]).toMatchObject({ make: 'Maruti Suzuki', model: 'Swift', year_from: 2018 });

    const movements = db
      .prepare("SELECT COUNT(*) FROM stock_movements WHERE type = 'opening'")
      .pluck()
      .get();
    expect(movements).toBe(2);
  });

  it('rejects selling above MRP, duplicate SKUs and inactive GST rates with field errors', () => {
    const db = freshDb();
    const bad = seatCover(db);
    bad.variants[0].selling_price = 500000;
    expect(() => products.create(db, bad)).toThrow(/MRP/);

    products.create(
      db,
      seatCover(db, { variants: [{ ...seatCover(db).variants[0], sku: 'SC-1' }] }),
    );
    try {
      products.create(
        db,
        seatCover(db, { name: 'Other', variants: [{ ...seatCover(db).variants[0], sku: 'sc-1' }] }),
      );
      expect.unreachable();
    } catch (err) {
      expect(err.fields['variants.0.sku']).toMatch(/already used/);
    }

    expect(() => products.create(db, seatCover(db, { name: 'X', gst_rate_bp: 1200 }))).toThrow(
      /GST rate/,
    );
  });

  it('computes list status, filters by vehicle (incl. universal) and stats', () => {
    const db = freshDb();
    products.create(db, seatCover(db));
    products.create(db, {
      product_type: 'stock',
      name: 'Car Perfume',
      unit: 'pcs',
      gst_rate_bp: 1800,
      variants: [
        { purchase_price: 10000, mrp: 25000, selling_price: 19900, opening_stock_milli: 0 },
      ],
    });
    products.create(db, {
      product_type: 'service',
      name: 'Seat Cover Fitting',
      unit: 'pcs',
      gst_rate_bp: 1800,
      hsn_code: '998714',
      variants: [{ selling_price: 30000 }],
    });

    const all = products.list(db, {});
    expect(all.total).toBe(3);
    const byName = Object.fromEntries(all.rows.map((r) => [r.name, r]));
    expect(byName['Premium Seat Cover'].stock_status).toBe('in'); // 6 total vs min 4
    expect(byName['Car Perfume'].stock_status).toBe('out');
    expect(byName['Seat Cover Fitting'].stock_status).toBe('service');
    expect(byName['Premium Seat Cover'].stock_value).toBe(6 * 220000);

    const creta = products.list(db, { vehicle_model_id: vehicleId(db, 'Hyundai', 'Creta') });
    expect(creta.rows.map((r) => r.name).sort()).toEqual(['Car Perfume', 'Seat Cover Fitting']);

    expect(products.list(db, { search: 'swift black' }).total).toBe(1);
    expect(products.list(db, { stock_status: 'out' }).rows.map((r) => r.name)).toEqual([
      'Car Perfume',
    ]);

    const s = products.stats(db);
    expect(s).toMatchObject({
      total_products: 3,
      out_count: 1,
      low_count: 0,
      stock_value: 1320000,
    });
  });

  it('updates variants: edits, adds with opening stock, and refuses removing one with stock', () => {
    const db = freshDb();
    const p = products.create(db, seatCover(db));
    const payload = {
      ...seatCover(db),
      variants: [
        { ...p.variants[0], selling_price: 300000 },
        {
          color: 'Grey',
          purchase_price: 200000,
          mrp: 399900,
          selling_price: 329900,
          opening_stock_milli: 4000,
        },
      ],
    };
    expect(() => products.update(db, p.id, payload)).toThrow(/still has stock/);

    stock.adjust(db, { variant_id: p.variants[1].id, qty_milli: -1000, reason: 'Damaged' });
    const updated = products.update(db, p.id, payload);
    expect(updated.variants.map((v) => v.color)).toEqual(['Black', 'Grey']);
    expect(updated.variants[0].selling_price).toBe(300000);
    expect(updated.variants[1].stock_milli).toBe(4000);
    // The removed variant is soft-deleted, never erased.
    expect(
      db
        .prepare('SELECT is_deleted FROM product_variants WHERE id = ?')
        .pluck()
        .get(p.variants[1].id),
    ).toBe(1);
  });

  it('search finds by barcode first, then by vehicle model text', () => {
    const db = freshDb();
    const p = products.create(
      db,
      seatCover(db, { variants: [{ ...seatCover(db).variants[0], barcode: '8901234567890' }] }),
    );
    const hit = products.search(db, { query: '8901234567890' });
    expect(hit[0]).toMatchObject({ variant_id: p.variants[0].id, variant_label: 'Black' });
    expect(products.search(db, { query: 'swift' })).toHaveLength(1);
  });
});

describe('stock', () => {
  it('adjusts with a reason, refuses negative stock, and builds a running ledger', () => {
    const db = freshDb();
    const p = products.create(db, seatCover(db));
    const variantId = p.variants[0].id;

    expect(() => stock.adjust(db, { variant_id: variantId, qty_milli: 1000, reason: '' })).toThrow(
      /reason/,
    );
    expect(() =>
      stock.adjust(db, { variant_id: variantId, qty_milli: -9000, reason: 'x' }),
    ).toThrow(/Only 5/);
    stock.adjust(db, {
      variant_id: variantId,
      qty_milli: 2000,
      reason: 'Found in godown',
      date: '2099-01-19',
    });
    stock.adjust(db, {
      variant_id: variantId,
      qty_milli: -500,
      reason: 'Damaged',
      date: '2099-01-20',
    });

    const l = stock.ledger(db, { variant_id: variantId });
    expect(l.rows.map((r) => r.balance_milli)).toEqual([5000, 7000, 6500]);
    expect(l.closing_milli).toBe(6500);

    const ranged = stock.ledger(db, { variant_id: variantId, from: '2099-01-20' });
    expect(ranged.opening_milli).toBe(7000);
    expect(ranged.rows).toHaveLength(1);
    expect(ranged.total_out_milli).toBe(500);
  });

  it('does not allow stock on services', () => {
    const db = freshDb();
    const s = products.create(db, {
      product_type: 'service',
      name: 'Fitting',
      gst_rate_bp: 1800,
      variants: [{ selling_price: 10000, opening_stock_milli: 5000 }],
    });
    expect(s.variants[0].stock_milli).toBe(0); // opening stock ignored for services
    expect(() =>
      stock.adjust(db, { variant_id: s.variants[0].id, qty_milli: 1000, reason: 'x' }),
    ).toThrow(/Services/);
  });
});

describe('import / export', () => {
  it('parses CSV with quotes', () => {
    expect(productImport.parseCsv('a,"b, c","d ""q"""\r\n1,2,3')).toEqual([
      ['a', 'b, c', 'd "q"'],
      ['1', '2', '3'],
    ]);
  });

  it('parses vehicle lists with year ranges and new "Make: Model" entries', () => {
    const known = [{ id: 1, make: 'Maruti Suzuki', model: 'Swift' }];
    const r = productImport.parseVehicles(
      'Maruti Suzuki Swift 2018-2024; Tata: Sierra 2025; Foo Bar',
      known,
    );
    expect(r.vehicles).toEqual([
      { make: 'Maruti Suzuki', model: 'Swift', year_from: 2018, year_to: 2024 },
      { make: 'Tata', model: 'Sierra', year_from: 2025, year_to: null },
    ]);
    expect(r.errors[0]).toMatch(/Unknown vehicle "Foo Bar"/);
  });

  it('previews a CSV with errors, then imports only valid products in one transaction', async () => {
    const db = freshDb();
    const dir = tempDir();
    const file = path.join(dir, 'p.csv');
    fs.writeFileSync(
      file,
      [
        'Name,Type,Category,Sub-category,GST %,Selling price,MRP,Opening stock,Colour,Vehicles',
        'Floor Mat 3D,Stock,Floor Mats,Premium,18,1500,2000,4,Black,Hyundai Creta 2020-',
        'Floor Mat 3D,Stock,Floor Mats,Premium,18,1500,2000,2,Grey,Hyundai Creta 2020-',
        'Bad Horn,Stock,Horns,,12,abc,,,,',
        'Wiper Fitting,Service,Fitting Charges,,18,100,,,,Universal',
      ].join('\n'),
    );
    const prev = await productImport.preview(db, file);
    expect(prev.summary).toMatchObject({ total_rows: 4, products: 2, variants: 3, error_rows: 1 });
    expect(prev.summary.new_categories).toEqual(['Floor Mats › Premium']);
    const bad = prev.rows.find((r) => r.name === 'Bad Horn');
    expect(bad.errors.join(' ')).toMatch(/Selling price "abc"/);

    const res = productImport.commit(db, { token: prev.token });
    expect(res).toEqual({ products: 2, variants: 3 });
    const mat = products.list(db, { search: 'floor mat' }).rows[0];
    expect(mat).toMatchObject({ variant_count: 2, stock_milli: 6000, category_name: 'Premium' });
    expect(() => productImport.commit(db, { token: prev.token })).toThrow(/expired/);
  });

  it('exports to Excel and the export can be imported again', async () => {
    const db = freshDb();
    products.create(db, seatCover(db));
    const file = path.join(tempDir(), 'out.xlsx');
    expect((await productImport.exportXlsx(db, file)).rows).toBe(2);

    const db2 = freshDb();
    const prev = await productImport.preview(db2, file);
    expect(prev.summary).toMatchObject({ products: 1, variants: 2, error_rows: 0 });
    productImport.commit(db2, { token: prev.token });
    const p = products.list(db2, {}).rows[0];
    expect(p).toMatchObject({
      name: 'Premium Seat Cover',
      stock_milli: 6000,
      vehicles_text: 'Maruti Suzuki Swift',
    });
  });
});

describe('products without GST', () => {
  it('allows "No GST" (0) even when 0% is removed from the rate list, and in imports', async () => {
    const db = freshDb();
    db.prepare('UPDATE gst_rates SET is_deleted = 1 WHERE rate_bp = 0').run();
    const p = products.create(db, {
      name: 'Microfibre Cloth',
      gst_rate_bp: 0,
      variants: [{ selling_price: 9900 }],
    });
    expect(p.gst_rate_bp).toBe(0);
    expect(p.image_path).toBeNull(); // photo is optional

    const file = path.join(tempDir(), 'nogst.csv');
    fs.writeFileSync(
      file,
      'Name,GST %,Selling price\nWax Polish,,350\nTyre Shine,No,250\nHorn,abc,500\n',
    );
    const prev = await productImport.preview(db, file);
    expect(prev.summary).toMatchObject({ products: 2, error_rows: 1 });
    expect(prev.rows.find((r) => r.name === 'Horn').errors.join(' ')).toMatch(/"abc" is not valid/);
  });
});
