import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { require, tempDir, testPaths } from './helpers.js';
import * as ui from '../src/utils/identity.js';

const { openDatabase } = require('../electron/db/connection.js');
const { migrate } = require('../electron/db/migrate.js');
const idm = require('../electron/validation/identity.js');
const parties = require('../electron/services/parties.js');
const vehicles = require('../electron/services/vehicles.js');
const partyImport = require('../electron/services/partyImport.js');
const statements = require('../electron/services/statements.js');
const products = require('../electron/services/products.js');
const serials = require('../electron/services/serials.js');

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

const customer = (db, party) => parties.create(db, { type: 'customer', party });
const supplier = (db, party) => parties.create(db, { type: 'supplier', party });
const modelId = (db, make, model) =>
  db.prepare('SELECT id FROM vehicle_models WHERE make = ? AND model = ?').pluck().get(make, model);

let seq = 0;
function insertSale(db, partyId, total, date, extra = {}) {
  seq += 1;
  return Number(
    db
      .prepare(
        `INSERT INTO sales (invoice_no, series, seq_no, invoice_date, bill_type, price_mode, bill_title,
           party_id, customer_name, place_of_supply_code, grand_total, vehicle_id, vehicle_no_key)
         VALUES (?, 'sale_gst', ?, ?, 'gst', 'inclusive', 'Tax Invoice', ?, 'Test', '24', ?, ?, ?)`,
      )
      .run(`T-${seq}`, seq, date, partyId, total, extra.vehicle_id ?? null, extra.plate ?? null)
      .lastInsertRowid,
  );
}
function insertPayment(db, partyId, amount, date, direction = 'in') {
  seq += 1;
  db.prepare(
    'INSERT INTO payments (payment_no, date, direction, party_id, account_id, amount) VALUES (?, ?, ?, ?, 1, ?)',
  ).run(`P-${seq}`, date, direction, partyId, amount);
}

// ---------------------------------------------------------------- pure rules

describe('phone normalisation', () => {
  it('strips spaces, dashes, brackets and the +91 / 0 prefix', () => {
    for (const input of [
      '9876543210',
      '98765 43210',
      '98765-43210',
      '+91 98765 43210',
      '+91-9876543210',
      '919876543210',
      '09876543210',
      '0091 98765 43210',
      '(+91) 98765.43210',
    ]) {
      expect(idm.normalizePhone(input)).toBe('9876543210');
    }
    expect(idm.normalizePhone('0281 245 1234')).toBe('2812451234');
    expect(idm.normalizePhone('')).toBe('');
    expect(idm.normalizePhone(null)).toBe('');
  });

  it('validates Indian mobiles (10 digits, 6–9 first) and formats them', () => {
    expect(idm.isMobile('9876543210')).toBe(true);
    expect(idm.isMobile('6000000000')).toBe(true);
    expect(idm.isMobile('5876543210')).toBe(false);
    expect(idm.isMobile('987654321')).toBe(false);
    expect(idm.isPhone('2812451234')).toBe(true); // landline with STD
    expect(idm.formatPhone('9876543210')).toBe('+91 98765 43210');
    expect(idm.formatPhone('2812451234')).toBe('+91 2812451234');
    expect(idm.formatLocalPhone('9876543210')).toBe('98765 43210');
  });

  it('stores foreign numbers in international form and validates them per country', () => {
    expect(idm.normalizePhone('+971 50 123 4567')).toBe('+971501234567');
    expect(idm.normalizePhone('00971 50 123 4567')).toBe('+971501234567');
    expect(idm.normalizePhone('+1 (415) 555-2671')).toBe('+14155552671');
    expect(idm.normalizePhone('+91 98765 43210')).toBe('9876543210'); // India stays national
    expect(idm.isMobile('+971501234567')).toBe(true);
    expect(idm.isPhone('+97150123')).toBe(false);
    expect(idm.formatPhone('+971501234567')).toBe('+971 50 123 4567');
    expect(idm.phoneCountry('+971501234567')).toBe('AE');
    expect(idm.phoneCountry('9876543210')).toBe('IN');
  });

  it('refuses extra digits while typing', () => {
    expect(idm.phoneDigitsAllowed('9876543210', 'IN')).toBe(true);
    expect(idm.phoneDigitsAllowed('98765432101', 'IN')).toBe(false);
    expect(idm.phoneDigitsAllowed('41555526712', 'US', '4155552671')).toBe(false);
    // UAE mobile is complete at 9 digits: a 10th is refused.
    expect(idm.phoneDigitsAllowed('5012345678', 'AE', '501234567')).toBe(false);
    expect(idm.phoneDigitsAllowed('501234567', 'AE', '50123456')).toBe(true);
  });

  it('searches partial numbers in any format', () => {
    expect(idm.phoneSearchDigits('98765')).toBe('98765');
    expect(idm.phoneSearchDigits('+91 98765 43210')).toBe('9876543210');
  });
});

describe('number plate normalisation', () => {
  it('upper-cases and removes spaces, dashes and dots', () => {
    for (const input of [
      'GJ03AB1234',
      'gj 03 ab 1234',
      'GJ-03-AB-1234',
      'gj.03.ab.1234',
      ' GJ 03-ab.1234 ',
    ]) {
      expect(idm.normalizePlate(input)).toBe('GJ03AB1234');
    }
  });

  it('formats standard and BH-series plates', () => {
    expect(idm.formatPlate('GJ03AB1234')).toBe('GJ 03 AB 1234');
    expect(idm.formatPlate('MH12A1')).toBe('MH 12 A 1');
    expect(idm.formatPlate('GJ011234')).toBe('GJ 01 1234');
    expect(idm.plateFormat('GJ03AB1234')).toBe('standard');
    expect(idm.normalizePlate('22 BH 1234 AA')).toBe('22BH1234AA');
    expect(idm.formatPlate('22BH1234AA')).toBe('22 BH 1234 AA');
    expect(idm.plateFormat('22BH1234AA')).toBe('bh');
    expect(idm.formatPlate('21BH0001A')).toBe('21 BH 0001 A');
  });

  it('recognises old, Delhi, government, defence, diplomatic, temporary and vintage plates', () => {
    const cases = [
      ['DL3CAB1234', 'DL 3C AB 1234', 'standard'], // Delhi vehicle-class letter
      ['DL10CA0001', 'DL 10C A 0001', 'standard'],
      ['GJ18G1234', 'GJ 18 G 1234', 'standard'], // government series
      ['MHU1234', 'MHU 1234', 'old'],
      ['DL1234', 'DL 1234', 'old'],
      ['15B123456K', '15 B 123456 K', 'defence'],
      ['77CD12', '77 CD 12', 'diplomatic'],
      ['101UN25', '101 UN 25', 'diplomatic'],
      ['T0124GJ1234AB', 'T 0124 GJ 1234 AB', 'temporary'],
      ['GJVAAB1234', 'GJ VA AB 1234', 'vintage'],
    ];
    for (const [key, display, format] of cases) {
      expect([idm.formatPlate(key), idm.plateFormat(key)]).toEqual([display, format]);
      expect(idm.plateFormatLabel(format)).toBeTruthy();
    }
    expect(idm.plateFormatLabel('other')).toBe('Unusual format');
  });

  it('accepts unusual plates (soft warning) but not junk', () => {
    expect(idm.plateFormat('TEMP1234X')).toBe('other');
    expect(idm.isPlateKey('TEMP1234X')).toBe(true);
    expect(idm.isPlateKey('AB')).toBe(false);
    expect(idm.isPlateKey('ABCDEF')).toBe(false); // no digit
  });
});

describe('GSTIN validation', () => {
  it('accepts valid GSTINs (with check digit)', () => {
    const g = idm.checkGstin('27AAPFU0939F1ZV', '27');
    expect(g).toMatchObject({ valid: true, error: null, warnings: [], state_code: '27' });
    expect(idm.gstinCheckChar('29AAGCB7383J1Z')).toBe('4');
  });

  it('rejects bad formats', () => {
    expect(idm.checkGstin('27AAPFU0939F1Z').error).toMatch(/15 characters/);
    expect(idm.checkGstin('2XAAPFU0939F1ZV').error).toMatch(/format/);
    expect(idm.checkGstin('27AAPFU0939F1AV').error).toMatch(/format/); // 14th must be Z
  });

  it('warns (does not block) on state mismatch and wrong check digit', () => {
    const g = idm.checkGstin('27AAPFU0939F1ZV', '24');
    expect(g.valid).toBe(true);
    expect(g.warnings.join()).toMatch(/Maharashtra.*Gujarat/);
    expect(idm.checkGstin('27AAPFU0939F1ZA').warnings.join()).toMatch(/check digit/);
  });

  it('maps state names and codes', () => {
    expect(idm.stateCodeFrom('Gujarat')).toBe('24');
    expect(idm.stateCodeFrom('24')).toBe('24');
    expect(idm.stateCodeFrom('7')).toBe('07');
    expect(idm.stateCodeFrom('Atlantis')).toBe('');
  });
});

describe('renderer copy of the identity rules', () => {
  it('gives the same results as the main process', () => {
    const phones = [
      '+91 98765 43210',
      '0281 245 1234',
      '5876543210',
      '98765',
      '+971 50 123 4567',
      '+44 7911 123456',
    ];
    const plates = [
      'gj-03 ab.1234',
      '22 bh 1234 aa',
      'DL3CAB1234',
      'temp 12',
      'mhu 1234',
      '15b123456k',
      't0124gj1234ab',
    ];
    const gstins = ['27AAPFU0939F1ZV', '27AAPFU0939F1ZA', '2XAAPFU0939F1ZV'];
    for (const p of phones) {
      expect(ui.normalizePhone(p)).toBe(idm.normalizePhone(p));
      expect(ui.formatPhone(ui.normalizePhone(p))).toBe(idm.formatPhone(idm.normalizePhone(p)));
    }
    for (const p of plates) {
      const k = idm.normalizePlate(p);
      expect(ui.normalizePlate(p)).toBe(k);
      expect(ui.formatPlate(k)).toBe(idm.formatPlate(k));
      expect(ui.plateFormat(k)).toBe(idm.plateFormat(k));
    }
    for (const g of gstins) expect(ui.checkGstin(g, '24')).toEqual(idm.checkGstin(g, '24'));
    expect(ui.STATES).toEqual(idm.STATES);
  });
});

// ---------------------------------------------------------------- customers & suppliers

describe('customers', () => {
  it('stores the phone normalised and refuses a duplicate in any format', () => {
    const db = freshDb();
    const c = customer(db, { name: 'Ramesh Patel', phone: '+91 98765-43210' });
    expect(c.phone).toBe('9876543210');
    expect(c.phone_display).toBe('+91 98765 43210');
    expect(() => customer(db, { name: 'Someone', phone: '098765 43210' })).toThrow(
      /Already exists: Ramesh Patel/,
    );
    // The same number may belong to a supplier (separate records).
    expect(supplier(db, { name: 'Ramesh Traders', phone: '9876543210' }).phone).toBe('9876543210');
  });

  it('requires a valid mobile for customers', () => {
    const db = freshDb();
    expect(() => customer(db, { name: 'No phone' })).toThrow(/required/);
    expect(() => customer(db, { name: 'Bad', phone: '12345' })).toThrow(/10-digit/);
    expect(() => customer(db, { name: 'Bad UAE', phone: '+971 50 123' })).toThrow(/not a valid/);
  });

  it('accepts foreign customers and finds duplicates across formats', () => {
    const db = freshDb();
    const c = customer(db, { name: 'Dubai Customer', phone: '+971 50 123 4567' });
    expect(c).toMatchObject({ phone: '+971501234567', phone_display: '+971 50 123 4567' });
    expect(() => customer(db, { name: 'Again', phone: '00971501234567' })).toThrow(
      /Already exists/,
    );
    expect(parties.list(db, { type: 'customer', search: '50 123 45' }).rows[0].id).toBe(c.id);
  });

  it('warns (does not block) when an alternate phone matches another customer', () => {
    const db = freshDb();
    const a = customer(db, { name: 'A', phone: '9876543210', alt_phone: '9898989898' });
    const dup = parties.checkDuplicates(db, {
      type: 'customer',
      phone: '9123456789',
      alt_phone: '98765 43210',
    });
    expect(dup.phone).toBeNull();
    expect(dup.alt_phone.map((o) => o.id)).toEqual([a.id]);
    const live = parties.checkDuplicates(db, { type: 'customer', phone: '9876543210' });
    expect(live.phone).toMatchObject({ id: a.id, name: 'A', phone_display: '+91 98765 43210' });
    expect(
      customer(db, { name: 'B', phone: '9123456789', alt_phone: '9898989898' }).id,
    ).toBeTruthy();
  });

  it('keeps GSTIN unique, fills the state from it and warns on mismatch', () => {
    const db = freshDb();
    const c = customer(db, { name: 'Firm', phone: '9876543210', gstin: '27aapfu0939f1zv' });
    expect(c.gstin).toBe('27AAPFU0939F1ZV');
    expect(c.state_code).toBe('27');
    expect(() =>
      customer(db, { name: 'Other', phone: '9876543211', gstin: '27AAPFU0939F1ZV' }),
    ).toThrow(/GSTIN already used/);
    const w = customer(db, {
      name: 'Mismatch',
      phone: '9876543212',
      gstin: '29AAGCB7383J1Z4',
      state_code: '24',
    });
    expect(w.state_code).toBe('24');
    expect(w.warnings.join()).toMatch(/Karnataka/);
  });

  it('stores opening balance signed and splits it back for the form', () => {
    const db = freshDb();
    const c = customer(db, {
      name: 'Due',
      phone: '9876543210',
      opening_amount: 150000,
      opening_type: 'receivable',
      opening_balance_date: '2026-04-01',
    });
    expect(c.opening_balance).toBe(150000);
    expect(c.balance).toBe(150000);
    const adv = customer(db, {
      name: 'Adv',
      phone: '9876543211',
      opening_amount: 5000,
      opening_type: 'advance',
    });
    expect(adv.opening_balance).toBe(-5000);
    expect(adv).toMatchObject({ opening_amount: 5000, opening_type: 'advance' });
    const s = supplier(db, { name: 'Sup', opening_amount: 20000, opening_type: 'payable' });
    expect(s.balance).toBe(-20000);
  });

  it('lists with balances from the ledger view and searches phone / plate in any format', () => {
    const db = freshDb();
    const a = customer(db, { name: 'Ramesh Patel', phone: '9876543210', city: 'Rajkot' });
    const b = customer(db, { name: 'Suresh Shah', phone: '9123456789', credit_limit: 10000 });
    vehicles.create(db, {
      customer_id: a.id,
      vehicle: {
        plate_no: 'GJ 03 AB 1234',
        vehicle_model_id: modelId(db, 'Maruti Suzuki', 'Swift'),
      },
    });
    insertSale(db, b.id, 25000, '2026-10-01');

    const find = (search) => parties.list(db, { type: 'customer', search }).rows.map((r) => r.name);
    expect(find('98765 4')).toEqual(['Ramesh Patel']);
    expect(find('+91 9876543210')).toEqual(['Ramesh Patel']);
    expect(find('gj-03-ab')).toEqual(['Ramesh Patel']);
    expect(find('ab1234')).toEqual(['Ramesh Patel']);
    expect(find('rajkot')).toEqual(['Ramesh Patel']);
    expect(find('shah')).toEqual(['Suresh Shah']);

    const pending = parties.list(db, { type: 'customer', balance: 'pending' }).rows;
    expect(pending.map((r) => [r.name, r.balance])).toEqual([['Suresh Shah', 25000]]);
    expect(parties.list(db, { type: 'customer', balance: 'over_limit' }).rows).toHaveLength(1);
    expect(parties.stats(db, { type: 'customer' })).toMatchObject({
      total: 2,
      positive: 25000,
      over_limit: 1,
    });
    const listed = parties.list(db, { type: 'customer' }).rows.find((r) => r.id === a.id);
    expect(listed.plates).toEqual([{ plate_no: 'GJ03AB1234', display: 'GJ 03 AB 1234' }]);
  });

  it('quick find: a full plate selects that customer and vehicle', () => {
    const db = freshDb();
    customer(db, { name: 'Other', phone: '9000000000' });
    const r = parties.quickAdd(db, {
      name: 'Walk In',
      phone: '9876543210',
      plate_no: 'gj03ab1234',
      vehicle_model_id: modelId(db, 'Hyundai', 'Creta'),
    });
    expect(r.customer.matched_vehicle).toMatchObject({ plate_no: 'GJ03AB1234', model: 'Creta' });
    const found = parties.search(db, { query: 'GJ 03 AB 1234', type: 'customer' });
    expect(found[0]).toMatchObject({ name: 'Walk In' });
    expect(found[0].matched_vehicle.id).toBe(r.vehicle_id);
    // Quick add is all-or-nothing: a taken plate leaves no customer behind.
    expect(() =>
      parties.quickAdd(db, { name: 'X', phone: '9111111111', plate_no: 'GJ03AB1234' }),
    ).toThrow(/belongs to Walk In/);
    expect(parties.list(db, { type: 'customer', search: '9111111111' }).rows).toHaveLength(0);
  });

  it('removes only records without history or balance; otherwise deactivate', () => {
    const db = freshDb();
    const a = customer(db, { name: 'Typo', phone: '9876543210' });
    const b = customer(db, { name: 'Has bill', phone: '9876543211' });
    const c = customer(db, {
      name: 'Has due',
      phone: '9876543212',
      opening_amount: 100,
      opening_type: 'receivable',
    });
    insertSale(db, b.id, 1000, '2026-10-01');
    expect(() => parties.remove(db, { id: b.id })).toThrow(/Deactivate it instead/);
    expect(() => parties.remove(db, { id: c.id })).toThrow(/balance/);
    expect(() => parties.remove(db, { id: 1 })).toThrow(/Cash Customer/);
    parties.remove(db, { id: a.id });
    expect(db.prepare('SELECT is_deleted FROM parties WHERE id = ?').pluck().get(a.id)).toBe(1);
    // The phone is free again.
    expect(customer(db, { name: 'Real', phone: '9876543210' }).id).toBeTruthy();
    expect(() => db.prepare('DELETE FROM parties WHERE id = ?').run(a.id)).toThrow(/never deleted/);
    expect(parties.setActive(db, { id: b.id, is_active: false }).is_active).toBe(0);
  });

  it('warns when the state changes after GST bills exist', () => {
    const db = freshDb();
    const c = customer(db, { name: 'GST', phone: '9876543210', state_code: '24' });
    insertSale(db, c.id, 1000, '2026-10-01');
    const r = parties.update(db, c.id, { ...c, state_code: '27' });
    expect(r.warnings.join()).toMatch(/only affects new bills/);
  });

  it('links a customer with a separate supplier record', () => {
    const db = freshDb();
    const c = customer(db, { name: 'Mahesh', firm_name: 'Mahesh Motors', phone: '9876543210' });
    const s = parties.createLinked(db, { id: c.id });
    expect(s).toMatchObject({
      type: 'supplier',
      name: 'Mahesh Motors',
      contact_person: 'Mahesh',
      phone: '9876543210',
    });
    expect(parties.get(db, c.id).linked).toMatchObject({ id: s.id, type: 'supplier' });
    insertSale(db, c.id, 5000, '2026-10-01');
    expect(parties.get(db, s.id).balance).toBe(0); // ledgers never mix
    parties.unlink(db, { id: s.id });
    expect(parties.get(db, c.id).linked).toBeNull();
  });
});

// ---------------------------------------------------------------- vehicles

describe('vehicles', () => {
  it('keeps plates unique shop-wide (any format) with one primary per customer', () => {
    const db = freshDb();
    const a = customer(db, { name: 'A', phone: '9876543210' });
    const b = customer(db, { name: 'B', phone: '9876543211' });
    const v1 = vehicles.create(db, { customer_id: a.id, vehicle: { plate_no: 'GJ03AB1234' } });
    expect(v1.is_primary).toBe(1);
    expect(() =>
      vehicles.create(db, { customer_id: b.id, vehicle: { plate_no: 'gj 03 ab-1234' } }),
    ).toThrow(/belongs to A/);
    const v2 = vehicles.create(db, {
      customer_id: a.id,
      vehicle: { plate_no: '22 BH 1234 AA', is_primary: true },
    });
    expect(v2.plate_display).toBe('22 BH 1234 AA');
    expect(vehicles.get(db, v1.id).is_primary).toBe(0);
    const odd = vehicles.create(db, { customer_id: a.id, vehicle: { plate_no: 'TEMP 1234 X' } });
    expect(odd.warnings.join()).toMatch(/not a usual/);
    expect(vehicles.check(db, { plate: 'gj03ab1234' }).owner).toMatchObject({ customer_name: 'A' });
    expect(() =>
      vehicles.create(db, { customer_id: 1, vehicle: { plate_no: 'GJ01AA0001' } }),
    ).toThrow(/Cash Customer/);
  });

  it('transfers a vehicle and keeps ownership history (old bills stay with the old owner)', () => {
    const db = freshDb();
    const seller = customer(db, { name: 'Seller', phone: '9876543210' });
    const buyer = customer(db, { name: 'Buyer', phone: '9876543211' });
    const v = vehicles.create(db, { customer_id: seller.id, vehicle: { plate_no: 'GJ03AB1234' } });
    db.prepare("UPDATE vehicle_owners SET from_date = '2024-01-01' WHERE vehicle_id = ?").run(v.id);
    const sale = insertSale(db, seller.id, 9000, '2025-06-01', {
      vehicle_id: v.id,
      plate: 'GJ03AB1234',
    });

    expect(() =>
      vehicles.transfer(db, { id: v.id, to_customer_id: buyer.id, date: '2023-12-31' }),
    ).toThrow(/cannot be before/);
    const moved = vehicles.transfer(db, {
      id: v.id,
      to_customer_id: buyer.id,
      date: '2026-10-01',
      note: 'Sold the car',
    });
    expect(moved).toMatchObject({ customer_id: buyer.id, is_primary: 1 });

    const history = vehicles.history(db, { id: v.id });
    expect(history.map((h) => [h.customer_name, h.from_date, h.to_date])).toEqual([
      ['Buyer', '2026-10-01', null],
      ['Seller', '2024-01-01', '2026-10-01'],
    ]);
    expect(vehicles.ownerOn(db, v.id, '2025-06-01')).toBe(seller.id);
    expect(vehicles.ownerOn(db, v.id, '2026-09-30')).toBe(seller.id);
    expect(vehicles.ownerOn(db, v.id, '2026-10-01')).toBe(buyer.id);
    expect(db.prepare('SELECT party_id FROM sales WHERE id = ?').pluck().get(sale)).toBe(seller.id);
    expect(parties.get(db, seller.id).vehicles).toHaveLength(0);
    expect(() => vehicles.remove(db, { id: v.id })).toThrow(/Bills refer/);
    expect(() => db.prepare('DELETE FROM vehicle_owners').run()).toThrow(/never deleted/);
  });

  it('finds compatible products for the vehicle model and year', () => {
    const db = freshDb();
    const swift = modelId(db, 'Maruti Suzuki', 'Swift');
    const c = customer(db, { name: 'A', phone: '9876543210' });
    const v = vehicles.create(db, {
      customer_id: c.id,
      vehicle: { plate_no: 'GJ03AB1234', vehicle_model_id: swift, year: 2020 },
    });
    const mk = (name, from, to) =>
      products.create(db, {
        name,
        unit: 'pcs',
        gst_rate_bp: 1800,
        is_universal: false,
        vehicles: [{ vehicle_model_id: swift, year_from: from, year_to: to }],
        variants: [{ selling_price: 1000 }],
      });
    mk('Swift mats 2018-2024', 2018, 2024);
    mk('Old Swift mats', 2005, 2017);
    const r = vehicles.compatibleProducts(db, { id: v.id });
    expect(r.rows.map((p) => p.name)).toEqual(['Swift mats 2018-2024']);
  });
});

// ---------------------------------------------------------------- ledger & merge

describe('ledger', () => {
  it('runs a balance from opening, bills and payments, with a date range', () => {
    const db = freshDb();
    const c = customer(db, {
      name: 'A',
      phone: '9876543210',
      opening_amount: 100000,
      opening_type: 'receivable',
      opening_balance_date: '2026-04-01',
    });
    insertSale(db, c.id, 50000, '2026-05-10');
    insertPayment(db, c.id, 120000, '2026-06-01');
    const cancelled = insertSale(db, c.id, 99999, '2026-06-02');
    db.prepare("UPDATE sales SET status = 'cancelled' WHERE id = ?").run(cancelled);

    const all = parties.ledger(db, { id: c.id });
    expect(all.rows.map((r) => [r.entry_type, r.debit, r.credit, r.balance])).toEqual([
      ['opening', 100000, 0, 100000],
      ['sale', 50000, 0, 150000],
      ['payment_in', 0, 120000, 30000],
    ]);
    expect(all.closing).toBe(30000);
    expect(parties.get(db, c.id).balance).toBe(30000);

    const ranged = parties.ledger(db, { id: c.id, from: '2026-05-01', to: '2026-05-31' });
    expect(ranged.opening).toBe(100000);
    expect(ranged.rows).toHaveLength(1);
    expect(ranged.closing).toBe(150000);

    const html = statements.statementHtml(db, { id: c.id });
    expect(html).toContain('Statement of Account');
    expect(html).toContain('₹300.00 receivable');
  });
});

describe('merge customers', () => {
  it('moves bills, payments, vehicles, warranties and opening balance in one transaction', () => {
    const db = freshDb();
    const keep = customer(db, {
      name: 'Ramesh',
      phone: '9876543210',
      opening_amount: 1000,
      opening_type: 'receivable',
      opening_balance_date: '2026-05-01',
    });
    const dup = customer(db, {
      name: 'Ramesh P',
      phone: '9123456789',
      email: 'r@example.com',
      gstin: '27AAPFU0939F1ZV',
      opening_amount: 500,
      opening_type: 'receivable',
      opening_balance_date: '2026-04-01',
    });
    vehicles.create(db, { customer_id: keep.id, vehicle: { plate_no: 'GJ03AA0001' } });
    const dv = vehicles.create(db, { customer_id: dup.id, vehicle: { plate_no: 'GJ03AA0002' } });
    const sale = insertSale(db, dup.id, 7000, '2026-10-01', { vehicle_id: dv.id });
    insertPayment(db, dup.id, 2000, '2026-10-02');
    const prod = products.create(db, {
      name: 'Speaker',
      unit: 'pcs',
      gst_rate_bp: 1800,
      track_serials: true,
      variants: [{ selling_price: 1000, serials: { entries: [{ serial_no: 'S1' }] } }],
    });
    db.prepare('UPDATE product_serials SET customer_party_id = ? WHERE product_id = ?').run(
      dup.id,
      prod.id,
    );

    const before = parties.balanceOf(db, keep.id) + parties.balanceOf(db, dup.id);
    const preview = parties.mergePreview(db, { keep_id: keep.id, merge_id: dup.id });
    expect(preview.moves).toMatchObject({
      'sales.party_id': 1,
      'payments.party_id': 1,
      'vehicles.customer_id': 1,
    });
    expect(preview.combined_balance).toBe(before);

    const merged = parties.merge(db, { keep_id: keep.id, merge_id: dup.id, note: 'same person' });
    expect(merged.balance).toBe(before); // 1000 + 500 + 7000 - 2000
    expect(merged.opening_balance).toBe(1500);
    expect(merged.opening_balance_date).toBe('2026-04-01');
    expect(merged).toMatchObject({
      email: 'r@example.com',
      gstin: '27AAPFU0939F1ZV',
      alt_phone: '9123456789',
    });
    expect(merged.vehicles.map((v) => [v.plate_no, v.is_primary])).toEqual([
      ['GJ03AA0001', 1],
      ['GJ03AA0002', 0],
    ]);
    expect(db.prepare('SELECT party_id FROM sales WHERE id = ?').pluck().get(sale)).toBe(keep.id);
    expect(
      db
        .prepare('SELECT customer_party_id FROM product_serials WHERE product_id = ?')
        .pluck()
        .get(prod.id),
    ).toBe(keep.id);
    expect(serials.consistency(db, prod.variants[0].id).ok).toBe(true);

    expect(() => parties.get(db, dup.id)).toThrow(/merged into "Ramesh"/);
    const log = db.prepare('SELECT * FROM party_merges').get();
    expect(log).toMatchObject({ kept_id: keep.id, merged_id: dup.id, note: 'same person' });
    expect(JSON.parse(log.details).moved['sales.party_id']).toBe(1);
    // The merged phone is free for a new customer (it is now the kept record's alternate).
    expect(customer(db, { name: 'New', phone: '9123456789' }).id).toBeTruthy();
  });

  it('rolls back completely when something fails half-way', () => {
    const db = freshDb();
    const keep = customer(db, { name: 'K', phone: '9876543210' });
    const dup = customer(db, { name: 'D', phone: '9123456789' });
    insertSale(db, dup.id, 7000, '2026-10-01');
    db.exec(
      "CREATE TRIGGER boom BEFORE INSERT ON party_merges BEGIN SELECT RAISE(ABORT, 'boom'); END",
    );
    expect(() => parties.merge(db, { keep_id: keep.id, merge_id: dup.id })).toThrow(/boom/);
    expect(db.prepare('SELECT party_id FROM sales').pluck().get()).toBe(dup.id);
    expect(parties.get(db, dup.id).is_deleted).toBe(0);
  });

  it('refuses Cash Customer and mixed types', () => {
    const db = freshDb();
    const c = customer(db, { name: 'C', phone: '9876543210' });
    const s = supplier(db, { name: 'S' });
    expect(() => parties.merge(db, { keep_id: c.id, merge_id: 1 })).toThrow(/Cash Customer/);
    expect(() => parties.merge(db, { keep_id: c.id, merge_id: s.id })).toThrow(/two customers/);
  });
});

// ---------------------------------------------------------------- import

describe('import', () => {
  function csv(lines) {
    const dir = tempDir();
    const file = path.join(dir, 'customers.csv');
    fs.writeFileSync(file, lines.join('\n'));
    return file;
  }

  it('maps columns, groups vehicles by phone, detects duplicates and imports in one go', async () => {
    const db = freshDb();
    customer(db, { name: 'Existing', phone: '9123456789', city: 'Old city' });
    const file = csv([
      'Customer Name,Mobile No,Vehicle No,Make,Model,Year,State,Opening Balance,Remarks',
      'Ramesh,+91 98765 43210,GJ-03-AB-1234,Maruti Suzuki,Swift,2021,Gujarat,1500,',
      'Ramesh,98765 43210,22 BH 1234 AA,Tata,Sierra,2025,,,',
      'Existing,09123456789,GJ03CD0001,,,,,,updated',
      'Bad phone,12345,,,,,,,',
      'Dup plate,9000000001,GJ03AB1234,,,,,,',
    ]);
    const opened = await partyImport.open(db, { type: 'customer', file });
    expect(opened.row_count).toBe(5);
    expect(opened.mapping).toMatchObject({
      name: 0,
      phone: 1,
      plate: 2,
      make: 3,
      model: 4,
      year: 5,
      state: 6,
      opening_balance: 7,
      notes: 8,
    });

    const skip = partyImport.preview(db, { token: opened.token, mapping: opened.mapping });
    expect(skip.summary).toMatchObject({ create: 1, skip: 1, error: 2, vehicles: 2 });
    expect(skip.summary.new_models).toEqual(['Tata Sierra']);
    const bad = skip.rows.filter((r) => r.action === 'error');
    expect(bad.map((r) => r.errors.join(' ')).join(' | ')).toMatch(/10-digit.*\|.*also in row 2/);

    const upd = partyImport.preview(db, {
      token: opened.token,
      mapping: opened.mapping,
      on_duplicate: 'update',
    });
    expect(upd.summary).toMatchObject({ create: 1, update: 1, vehicles: 3 });
    const r = partyImport.commit(db, { token: opened.token });
    expect(r).toEqual({ created: 1, updated: 1, vehicles: 3 });

    const ramesh = parties.list(db, { type: 'customer', search: 'Ramesh' }).rows[0];
    expect(ramesh.plates.map((p) => p.display)).toEqual(['GJ 03 AB 1234', '22 BH 1234 AA']);
    expect(ramesh.balance).toBe(150000);
    expect(parties.get(db, ramesh.id).state_code).toBe('24');
    const existing = parties.list(db, { type: 'customer', search: 'Existing' }).rows[0];
    expect(parties.get(db, existing.id)).toMatchObject({ city: 'Old city', notes: 'updated' });
    expect(() => partyImport.commit(db, { token: opened.token })).toThrow(/expired/);
  });
});
