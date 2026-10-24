import { afterEach, describe, expect, it } from 'vitest';
import { require, testPaths } from './helpers.js';

const { openDatabase } = require('../electron/db/connection.js');
const { migrate } = require('../electron/db/migrate.js');
const settings = require('../electron/services/settings.js');
const products = require('../electron/services/products.js');
const parties = require('../electron/services/parties.js');
const serials = require('../electron/services/serials.js');
const sales = require('../electron/services/sales.js');
const W = require('../electron/services/warranty.js');
const units = require('../electron/services/warrantyUnits.js');
const claims = require('../electron/services/claims.js');
const defective = require('../electron/services/defective.js');
const claimPrint = require('../electron/services/claimPrint.js');

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
    name: o.name || 'Music System',
    unit: 'pcs',
    gst_rate_bp: 1800,
    track_serials: Boolean(o.serials),
    customer_warranty_months: o.warranty ?? 12,
    supplier_warranty_months: o.supplierWarranty ?? 12,
    variants: [
      {
        selling_price: o.price ?? 500000,
        mrp: 600000,
        purchase_price: o.cost ?? 300000,
        opening_stock_milli: o.serials ? 0 : (o.stock ?? 10) * 1000,
        serials: o.serials
          ? { entries: o.serials.map((s) => ({ serial_no: s })), auto: null }
          : undefined,
      },
    ],
  });
  return p.variants[0];
}

function service(db, name = 'Repair charges', price = 50000) {
  return products.create(db, {
    name,
    product_type: 'service',
    unit: 'pcs',
    gst_rate_bp: 1800,
    variants: [{ selling_price: price }],
  }).variants[0];
}

let phoneSeq = 0;
function customer(db, o = {}) {
  phoneSeq += 1;
  return parties.create(db, {
    type: 'customer',
    party: {
      name: o.name || `Amit Shah ${phoneSeq}`,
      phone: o.phone || `98765${String(43210 + phoneSeq).padStart(5, '0')}`,
      state_code: '24',
    },
    vehicles: o.plate ? [{ plate_no: o.plate }] : [],
  });
}

function supplier(db) {
  return parties.create(db, {
    type: 'supplier',
    party: { name: 'Ramesh Traders', phone: '9898989898', state_code: '24' },
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
  payments: [{ mode: 'cash', amount: null }],
  ...extra,
});

/** Sells one serial unit (paid in cash). Returns { v, sale, unit, c }. */
function soldUnit(db, o = {}) {
  const v = stockItem(db, { serials: o.serials || ['SN-1', 'SN-2', 'SN-3'], ...o });
  const [first] = serials.inStock(db, { variant_id: v.id });
  const c = o.customer || customer(db, { plate: o.plate });
  const calc = sales.calculate(db, bill(c.id, [line(v, 1, 500000, { serial_ids: [first.id] })]));
  const sale = sales.create(
    db,
    bill(c.id, [line(v, 1, 500000, { serial_ids: [first.id] })], {
      payments: [{ mode: 'cash', amount: calc.totals.grand_total }],
      vehicle_id: o.vehicle_id ?? null,
    }),
    ctx,
  );
  return { v, sale, unit: serials.loadSerial(db, first.id), c };
}

function soldLine(db, o = {}) {
  const v = stockItem(db, { name: o.name || 'Floor Mat', warranty: o.warranty ?? 6, stock: 10 });
  const c = customer(db);
  const calc = sales.calculate(db, bill(c.id, [line(v, o.qty ?? 2, 100000)]));
  const sale = sales.create(
    db,
    bill(c.id, [line(v, o.qty ?? 2, 100000)], {
      payments: [{ mode: 'cash', amount: calc.totals.grand_total }],
    }),
    ctx,
  );
  return { v, sale, item: sale.items[0], c };
}

const open1 = (db, ref, extra = {}) =>
  claims.create(db, { ...ref, complaint: 'No sound', received_by: 'Raju', ...extra }, ctx);

const sumAt = (db, variantId, location) =>
  db
    .prepare(
      'SELECT COALESCE(SUM(qty_milli), 0) FROM stock_movements WHERE variant_id = ? AND location = ?',
    )
    .pluck()
    .get(variantId, location);

// ---------------------------------------------------------------- status maths

describe('warranty status', () => {
  it('active / expiring (setting N) / expired, inclusive end', () => {
    expect(W.warrantyStatus('2027-10-17', '2027-10-17').status).toBe('expiring');
    expect(W.warrantyStatus('2027-10-17', '2027-10-18').status).toBe('expired');
    expect(W.warrantyStatus('2027-10-17', '2027-09-17').status).toBe('expiring'); // 30 days
    expect(W.warrantyStatus('2027-10-17', '2027-09-16').status).toBe('active'); // 31 days
    expect(W.warrantyStatus('2027-10-17', '2027-09-16', 45).status).toBe('expiring');
    expect(W.warrantyStatus(null, '2027-01-01').status).toBe('none');
    expect(W.warrantyEnd('2026-10-18', 12)).toBe('2027-10-17');
  });

  it('void and claim states win over the dates', () => {
    const base = { end: '2027-10-17', start: '2026-10-18', today: '2027-01-01' };
    expect(W.unitStatus(base).status).toBe('active');
    expect(W.unitStatus({ ...base, openClaim: true }).status).toBe('under_claim');
    expect(W.unitStatus({ ...base, closedAs: 'replaced' }).status).toBe('replaced');
    expect(W.unitStatus({ ...base, closedAs: 'refunded', openClaim: true }).status).toBe(
      'refunded',
    );
    const v = W.unitStatus({ ...base, voidReason: 'water_damage', openClaim: true });
    expect(v.status).toBe('void');
    expect(v.void_label).toBe('Water damage');
    expect(W.unitStatus({ ...base, today: '2027-10-18' }).status).toBe('expired');
    expect(W.unitStatus(base).progress_bp).toBeGreaterThan(2000);
  });

  it('remaining warranty for a replacement counts from the claim date; fresh = new period', () => {
    // Claim received 2027-01-01 with the old warranty till 2027-10-17 (289 days left).
    const same = W.replacementWarranty({
      mode: 'remaining',
      oldEnd: '2027-10-17',
      months: 12,
      today: '2027-01-01',
      fromDate: '2027-01-01',
    });
    expect(same).toEqual({ start: '2027-01-01', end: '2027-10-17' });
    // Replaced 10 days later: the customer keeps the 289 days.
    const later = W.replacementWarranty({
      mode: 'remaining',
      oldEnd: '2027-10-17',
      months: 12,
      today: '2027-01-11',
      fromDate: '2027-01-01',
    });
    expect(later.end).toBe('2027-10-27');
    const fresh = W.replacementWarranty({
      mode: 'fresh',
      oldEnd: '2027-10-17',
      months: 12,
      today: '2027-01-31',
      fromDate: '2027-01-01',
    });
    expect(fresh).toEqual({ start: '2027-01-31', end: '2028-01-30' });
  });

  it('detail card: void after a sale cancel; owner changed note', () => {
    const db = freshDb();
    const { unit, sale } = soldUnit(db);
    const card = units.unit(db, { serial_id: unit.id });
    expect(['active', 'expiring']).toContain(card.status.status);
    expect(card.can.claim).toBe(true);
    sales.cancel(
      db,
      { id: sale.id, reason: 'Wrong bill', refund: { amount: sale.grand_total, mode: 'cash' } },
      ctx,
    );
    const after = units.unit(db, { serial_id: unit.id });
    expect(after.status.status).toBe('void');
    expect(after.status.void_reason).toBe('sale_cancelled');
    expect(after.can.claim).toBe(false);
  });

  it('search finds by serial, invoice, phone and plate; groups by bill', () => {
    const db = freshDb();
    const c = customer(db, { plate: 'GJ03AB1234' });
    const veh = parties.get(db, c.id).vehicles[0];
    const { sale, unit } = soldUnit(db, { customer: c, vehicle_id: veh.id });
    for (const q of [unit.serial_no, sale.invoice_no, c.phone, 'gj-03-ab-1234']) {
      const r = units.search(db, { query: q });
      expect(r.groups.map((g) => g.sale && g.sale.id)).toContain(sale.id);
    }
    const r = units.search(db, { query: unit.serial_no });
    expect(r.groups[0].units.find((u) => u.serial_id === unit.id).matched).toBe(true);
    // Units still in the shop show in their own group.
    const loose = units.search(db, { query: 'SN-2' });
    expect(loose.groups.find((g) => g.key === 'unsold').units[0].serial_no).toBe('SN-2');
  });

  it('voids a warranty with a reason; lists by tab', () => {
    const db = freshDb();
    const { unit } = soldUnit(db);
    const { item } = soldLine(db);
    expect(units.list(db, { tab: 'active' }).rows).toHaveLength(2);
    db.prepare('UPDATE sale_items SET warranty_end = ? WHERE id = ?').run(
      W.addDays(TODAY, 10),
      item.id,
    );
    expect(units.list(db, { tab: 'expiring' }).rows.map((r) => r.sale_item_id)).toEqual([item.id]);
    db.prepare('UPDATE sale_items SET warranty_end = ? WHERE id = ?').run(
      W.addDays(TODAY, -5),
      item.id,
    );
    expect(units.list(db, { tab: 'expired' }).rows).toHaveLength(1);
    expect(() => units.voidWarranty(db, { serial_id: unit.id, reason: 'other' })).toThrow(
      /Describe/,
    );
    const v = units.voidWarranty(db, {
      serial_id: unit.id,
      reason: 'tampered',
      note: 'Seal broken',
    });
    expect(v.status.status).toBe('void');
    expect(units.list(db, { tab: 'active' }).rows).toHaveLength(0);
    expect(v.timeline.some((e) => e.type === 'warranty_voided')).toBe(true);
  });
});

// ---------------------------------------------------------------- claims

describe('claims', () => {
  it('only ONE open claim per serial (service + DB index)', () => {
    const db = freshDb();
    const { unit } = soldUnit(db);
    const c1 = open1(db, { serial_id: unit.id });
    expect(c1.claim_no).toBe('WC-0001');
    expect(c1.status).toBe('received');
    expect(() => open1(db, { serial_id: unit.id })).toThrow(/already open/);
    expect(() =>
      db
        .prepare(
          `INSERT INTO warranty_claims (claim_no, seq_no, serial_id, product_id, variant_id, received_date, complaint)
           VALUES ('X-1', 99, ?, ?, ?, ?, 'x')`,
        )
        .run(unit.id, unit.product_id, unit.variant_id, TODAY),
    ).toThrow(/UNIQUE/);
    expect(units.unit(db, { serial_id: unit.id }).status.status).toBe('under_claim');
    // A cancelled claim frees the unit; the number is kept.
    claims.cancel(db, { id: c1.id, reason: 'Opened by mistake' }, ctx);
    const c2 = open1(db, { serial_id: unit.id });
    expect(c2.claim_no).toBe('WC-0002');
    expect(claims.get(db, c1.id).status).toBe('cancelled');
    // The bill cannot be cancelled while a claim is open.
    expect(sales.get(db, unit.sale_id).can_cancel).toBe(false);
  });

  it('non-serial lines: claim qty ≤ sold − returned − already claimed', () => {
    const db = freshDb();
    const { item } = soldLine(db, { qty: 2 });
    expect(() => open1(db, { sale_item_id: item.id, qty_milli: 3000 })).toThrow(/Only 2/);
    open1(db, { sale_item_id: item.id, qty_milli: 1000 });
    open1(db, { sale_item_id: item.id, qty_milli: 1000 });
    expect(() => open1(db, { sale_item_id: item.id, qty_milli: 1000 })).toThrow();
  });

  it('repair in shop (in warranty): parts leave stock, parts + labour are warranty loss', () => {
    const db = freshDb();
    const { unit } = soldUnit(db);
    const part = stockItem(db, { name: 'Speaker wire', cost: 2000, stock: 5 });
    const c = open1(db, { serial_id: unit.id });
    claims.inspect(db, { id: c.id, notes: 'Wire cut' }, ctx);
    claims.decide(db, { id: c.id, decision: 'repair' }, ctx);
    const done = claims.repairDone(
      db,
      {
        id: c.id,
        repair_notes: 'Rewired',
        parts: [{ variant_id: part.id, qty_milli: 2000 }],
        labour_amount: 10000,
      },
      ctx,
    );
    expect(done.status).toBe('ready');
    expect(done.outcome).toBe('repaired');
    expect(products.variantStock(db, part.id)).toBe(3000);
    expect(
      db
        .prepare('SELECT type FROM stock_movements WHERE variant_id = ? ORDER BY id DESC')
        .pluck()
        .get(part.id),
    ).toBe('warranty_parts_used');
    expect(done.money).toMatchObject({ cost: 4000 + 10000, recovered: 0, net_loss: 14000 });
    const closed = claims.handover(db, { id: c.id, handed_over_by: 'Raju' }, ctx);
    expect(closed.status).toBe('closed');
    expect(closed.handover_date).toBe(TODAY);
    expect(serials.loadSerial(db, unit.id).status).toBe('sold');
    expect(claims.get(db, c.id).events.map((e) => e.type)).toEqual([
      'received',
      'inspected',
      'decided',
      'repaired',
      'returned',
      'closed',
    ]);
  });

  it('replace from stock (serial): new unit sold on the same bill, old unit to defective', () => {
    const db = freshDb();
    const { unit, v, sale } = soldUnit(db);
    const c = open1(db, { serial_id: unit.id });
    const spare = serials.inStock(db, { variant_id: v.id })[0];
    const before = products.variantStock(db, v.id);
    const r = claims.decide(
      db,
      { id: c.id, decision: 'replace', replacement_serial_id: spare.id },
      ctx,
    );
    expect(r.status).toBe('ready');
    expect(r.replacement.serial_no).toBe(spare.serial_no);
    // Remaining warranty: same day → the old end date.
    expect(r.replacement_warranty_end).toBe(unit.warranty_end);
    expect(products.variantStock(db, v.id)).toBe(before - 1000);
    expect(sumAt(db, v.id, 'defective')).toBe(1000);
    expect(serials.consistency(db, v.id).ok).toBe(true);
    const old = serials.loadSerial(db, unit.id);
    expect(old.status).toBe('defective');
    expect(old.replaced_by_serial_id).toBe(spare.id);
    const n = serials.loadSerial(db, spare.id);
    expect(n).toMatchObject({ status: 'sold', sale_id: sale.id, sale_item_id: unit.sale_item_id });
    // Bill detail marks the replacement; searching the new serial finds the bill.
    const s = sales.get(db, sale.id);
    expect(s.items[0].serials.find((x) => x.id === spare.id).is_replacement).toBe(1);
    expect(units.search(db, { query: spare.serial_no }).groups[0].sale.id).toBe(sale.id);
    expect(units.unit(db, { serial_id: unit.id }).status.status).toBe('replaced');
    // Loss = the replacement at average cost; nothing recovered yet.
    expect(r.money).toMatchObject({ cost: 300000, recovered: 0 });
    // A fresh warranty different from the setting needs a reason.
    const { unit: u2, v: v2 } = soldUnit(db, { serials: ['B-1', 'B-2'], name: 'Camera' });
    const c2 = open1(db, { serial_id: u2.id });
    const spare2 = serials.inStock(db, { variant_id: v2.id })[0];
    expect(() =>
      claims.decide(
        db,
        { id: c2.id, decision: 'replace', replacement_serial_id: spare2.id, mode: 'fresh' },
        ctx,
      ),
    ).toThrow(/Say why/);
    const f = claims.decide(
      db,
      {
        id: c2.id,
        decision: 'replace',
        replacement_serial_id: spare2.id,
        mode: 'fresh',
        reason: 'Goodwill',
      },
      ctx,
    );
    expect(f.replacement_warranty_end).toBe(W.warrantyEnd(TODAY, 12));
  });

  it('replace from stock (non-serial): stock out, faulty goods to defective at no value', () => {
    const db = freshDb();
    const { v, item } = soldLine(db, { qty: 2 });
    const c = open1(db, { sale_item_id: item.id, qty_milli: 1000, complaint: 'Torn' });
    const r = claims.decide(db, { id: c.id, decision: 'replace' }, ctx);
    expect(r.status).toBe('ready');
    expect(products.variantStock(db, v.id)).toBe(10000 - 2000 - 1000);
    expect(serials.defectiveStock(db, v.id)).toEqual({ qty_milli: 1000, value: 0 });
    expect(r.money.cost).toBe(300000);
  });

  it('send to supplier: customer unit leaves no stock trace; supplier replacement to customer', () => {
    const db = freshDb();
    const sup = supplier(db);
    const { unit, v, sale } = soldUnit(db);
    const c = open1(db, { serial_id: unit.id });
    const before = { main: sumAt(db, v.id, 'main'), def: sumAt(db, v.id, 'defective') };
    const sent = claims.decide(
      db,
      {
        id: c.id,
        decision: 'supplier',
        dispatch: {
          supplier_party_id: sup.id,
          mode: 'courier',
          courier: 'DTDC',
          docket_no: 'D123',
          expected_date: W.addDays(TODAY, 10),
        },
      },
      ctx,
    );
    expect(sent.status).toBe('at_supplier');
    expect(serials.loadSerial(db, unit.id).status).toBe('under_claim');
    expect({ main: sumAt(db, v.id, 'main'), def: sumAt(db, v.id, 'defective') }).toEqual(before);
    expect(() => claims.handover(db, { id: c.id }, ctx)).toThrow(/cannot be handed over/);
    const back = claims.supplierResult(
      db,
      { id: c.id, result: 'replaced', new_to: 'customer', new_serial: { serial_no: 'NEW-77' } },
      ctx,
    );
    expect(back.status).toBe('ready');
    expect(back.outcome).toBe('supplier_replaced');
    const n = db.prepare("SELECT * FROM product_serials WHERE serial_key = 'NEW-77'").get();
    expect(n).toMatchObject({
      status: 'sold',
      sale_id: sale.id,
      replaces_serial_id: unit.id,
      source_type: 'replacement',
    });
    expect(serials.loadSerial(db, unit.id).status).toBe('replaced');
    expect(serials.consistency(db, v.id).ok).toBe(true);
    expect(back.money).toMatchObject({ cost: 0, recovered: 0 });
  });

  it('supplier credit note: recovery + supplier payable reduced; customer then gets a replacement', () => {
    const db = freshDb();
    const sup = supplier(db);
    const { unit, v } = soldUnit(db);
    const c = open1(db, { serial_id: unit.id });
    claims.decide(
      db,
      { id: c.id, decision: 'supplier', dispatch: { supplier_party_id: sup.id, mode: 'hand' } },
      ctx,
    );
    const balBefore = sales.balanceOf(db, sup.id);
    const r = claims.supplierResult(
      db,
      { id: c.id, result: 'credit', credit_amount: 250000, credit_ref: 'CN-55' },
      ctx,
    );
    expect(r.status).toBe('awaiting_replacement');
    expect(sales.balanceOf(db, sup.id)).toBe(balBefore + 250000);
    expect(serials.loadSerial(db, unit.id).status).toBe('returned_to_supplier');
    const spare = serials.inStock(db, { variant_id: v.id })[0];
    const done = claims.replace(db, { id: c.id, replacement_serial_id: spare.id }, ctx);
    expect(done.status).toBe('ready');
    // The faulty unit is with the supplier: nothing enters defective stock.
    expect(sumAt(db, v.id, 'defective')).toBe(0);
    expect(done.money).toMatchObject({ cost: 300000, recovered: 250000, net_loss: 50000 });
    expect(serials.consistency(db, v.id).ok).toBe(true);
    const ledger = parties.ledger(db, { id: sup.id });
    expect(ledger.rows.some((x) => x.entry_type === 'warranty_credit')).toBe(true);
  });

  it('supplier rejects: return as is → rejection slip, unit back with the customer', () => {
    const db = freshDb();
    const sup = supplier(db);
    const { unit } = soldUnit(db);
    const c = open1(db, { serial_id: unit.id });
    claims.decide(
      db,
      { id: c.id, decision: 'supplier', dispatch: { supplier_party_id: sup.id, mode: 'hand' } },
      ctx,
    );
    const r = claims.supplierResult(
      db,
      { id: c.id, result: 'rejected', rejected_action: 'return_as_is', notes: 'Burnt' },
      ctx,
    );
    expect(r.status).toBe('rejected');
    expect(r.can.print_rejection).toBe(true);
    expect(serials.loadSerial(db, unit.id).status).toBe('sold');
    expect(claimPrint.claimHtml(db, c.id, { doc: 'rejection' })).toContain(
      'Rejected by Ramesh Traders',
    );
    expect(claims.handover(db, { id: c.id }, ctx).status).toBe('closed');
  });

  it('refund: credit note through the sale return flow, unit to defective, claim closed', () => {
    const db = freshDb();
    const { unit, v, sale } = soldUnit(db);
    const c = open1(db, { serial_id: unit.id });
    // A return outside the claim is refused while the claim is open.
    const { saleReturns } = { saleReturns: require('../electron/services/saleReturns.js') };
    expect(() =>
      saleReturns.create(
        db,
        {
          sale_id: sale.id,
          settlement: 'refund',
          refund: { mode: 'cash' },
          lines: [{ sale_item_id: unit.sale_item_id, qty_milli: 1000, serials: [{ id: unit.id }] }],
        },
        ctx,
      ),
    ).toThrow(/open warranty claim/);
    const r = claims.decide(
      db,
      { id: c.id, decision: 'refund', settlement: 'refund', refund_mode: 'cash' },
      ctx,
    );
    expect(r.status).toBe('closed');
    expect(r.outcome).toBe('refunded');
    expect(r.credit_note.total).toBe(sale.grand_total);
    expect(serials.loadSerial(db, unit.id).status).toBe('defective');
    expect(sumAt(db, v.id, 'defective')).toBe(1000);
    expect(serials.consistency(db, v.id).ok).toBe(true);
    expect(units.unit(db, { serial_id: unit.id }).status.status).toBe('refunded');
  });

  it('refund of a non-serial line moves the goods to defective, not sellable stock', () => {
    const db = freshDb();
    const { v, item } = soldLine(db, { qty: 2 });
    const c = open1(db, { sale_item_id: item.id, qty_milli: 1000, complaint: 'Torn' });
    const stock = products.variantStock(db, v.id);
    claims.decide(
      db,
      { id: c.id, decision: 'refund', settlement: 'refund', refund_mode: 'cash' },
      ctx,
    );
    expect(products.variantStock(db, v.id)).toBe(stock);
    expect(sumAt(db, v.id, 'defective')).toBe(1000);
  });

  it('reject with a reason; rejection needs a reason', () => {
    const db = freshDb();
    const { unit } = soldUnit(db);
    const c = open1(db, { serial_id: unit.id });
    expect(() => claims.decide(db, { id: c.id, decision: 'reject' }, ctx)).toThrow(/reason/);
    const r = claims.decide(
      db,
      { id: c.id, decision: 'reject', reject_reason: 'water_damage' },
      ctx,
    );
    expect(r.status).toBe('rejected');
    expect(r.reject_reason_label).toBe('Water damage');
  });

  it('out of warranty → chargeable repair: parts on the bill, bill linked to the claim', () => {
    const db = freshDb();
    const repairSvc = service(db, 'Repair charges', 50000);
    const { unit, c: cust } = soldUnit(db);
    const part = stockItem(db, { name: 'Fuse', cost: 1000, stock: 5 });
    db.prepare('UPDATE product_serials SET warranty_end = ? WHERE id = ?').run(
      W.addDays(TODAY, -1),
      unit.id,
    );
    expect(() => open1(db, { serial_id: unit.id })).toThrow(/out of warranty/);
    const c = open1(db, { serial_id: unit.id, chargeable: true });
    expect(c).toMatchObject({ chargeable: 1, in_warranty: 0 });
    expect(() => claims.decide(db, { id: c.id, decision: 'replace' }, ctx)).toThrow(/chargeable/);
    claims.decide(db, { id: c.id, decision: 'repair' }, ctx);
    const done = claims.repairDone(
      db,
      { id: c.id, parts: [{ variant_id: part.id, qty_milli: 1000 }], labour_amount: 30000 },
      ctx,
    );
    // Chargeable: no stock out by the claim, no warranty loss.
    expect(products.variantStock(db, part.id)).toBe(5000);
    expect(done.money.cost).toBe(0);
    expect(done.unbilled).toBe(true);
    expect(() => claims.handover(db, { id: c.id }, ctx)).toThrow(/no bill/);
    const pre = claims.billPrefill(db, { id: c.id });
    expect(pre.party_id).toBe(cust.id);
    expect(pre.lines.map((l) => [l.variant_id, l.qty_milli, l.rate])).toEqual([
      [part.id, 1000, part.selling_price],
      [repairSvc.id, 1000, 30000],
    ]);
    const items = pre.lines.map((l) => line({ id: l.variant_id }, l.qty_milli / 1000, l.rate));
    const calc = sales.calculate(db, bill(cust.id, items));
    const s = sales.create(
      db,
      bill(cust.id, items, {
        claim_id: c.id,
        payments: [{ mode: 'cash', amount: calc.totals.grand_total }],
      }),
      ctx,
    );
    expect(products.variantStock(db, part.id)).toBe(4000);
    const after = claims.get(db, c.id);
    expect(after.bill.invoice_no).toBe(s.invoice_no);
    expect(claims.handover(db, { id: c.id }, ctx).status).toBe('closed');
  });

  it('warranty follows the unit: a new vehicle owner can claim; original buyer kept', () => {
    const db = freshDb();
    const a = customer(db, { name: 'First Owner', plate: 'GJ01AA1111' });
    const veh = parties.get(db, a.id).vehicles[0];
    const { unit } = soldUnit(db, { customer: a, vehicle_id: veh.id });
    const b = customer(db, { name: 'Second Owner', phone: '9123456780' });
    const vehicles = require('../electron/services/vehicles.js');
    vehicles.transfer(db, { id: veh.id, to_customer_id: b.id, date: TODAY });
    const prep = claims.prepare(db, { serial_id: unit.id });
    expect(prep.warnings.join(' ')).toMatch(/Second Owner/);
    const c = open1(db, { serial_id: unit.id, brought_by_name: 'Second Owner' });
    expect(c.customer_party_id).toBe(a.id);
    expect(c.ownership_note).toMatch(/Second Owner/);
  });
});

// ---------------------------------------------------------------- defective stock

describe('defective stock', () => {
  it('stock claim from the Defective list; supplier sends a new unit to stock = recovery', () => {
    const db = freshDb();
    const sup = supplier(db);
    const { unit, v } = soldUnit(db);
    const c = open1(db, { serial_id: unit.id });
    const spare = serials.inStock(db, { variant_id: v.id })[0];
    claims.decide(db, { id: c.id, decision: 'replace', replacement_serial_id: spare.id }, ctx);
    const list = defective.list(db);
    expect(list.rows[0].serials.map((s) => s.id)).toEqual([unit.id]);
    const sc = defective.sendToSupplier(
      db,
      { serial_id: unit.id, supplier_party_id: sup.id, complaint: 'Dead', mode: 'hand' },
      ctx,
    );
    expect(sc).toMatchObject({ kind: 'stock', status: 'at_supplier' });
    expect(sumAt(db, v.id, 'defective')).toBe(0);
    expect(serials.loadSerial(db, unit.id).status).toBe('under_claim');
    const mainBefore = sumAt(db, v.id, 'main');
    const r = claims.supplierResult(
      db,
      { id: sc.id, result: 'replaced', new_serial: { serial_no: 'FRESH-1' } },
      ctx,
    );
    expect(r.status).toBe('closed');
    expect(sumAt(db, v.id, 'main')).toBe(mainBefore + 1000);
    expect(serials.consistency(db, v.id).ok).toBe(true);
    expect(r.money).toMatchObject({ recovered: 300000, cost: 0 });
  });

  it('write off (loss) and repair back to sellable stock', () => {
    const db = freshDb();
    const v = stockItem(db, { serials: ['D-1', 'D-2'] });
    const [a, b] = serials.inStock(db, { variant_id: v.id });
    serials.setStatus(db, { id: a.id, to_status: 'defective', reason: 'Dropped' });
    serials.setStatus(db, { id: b.id, to_status: 'defective', reason: 'Dropped' });
    expect(defective.count(db)).toBe(2000);
    defective.writeOff(db, { serial_id: a.id, reason: 'Beyond repair' });
    defective.repair(db, { serial_id: b.id, reason: 'Fixed' });
    expect(serials.consistency(db, v.id)).toMatchObject({
      ok: true,
      in_stock_units: 1,
      defective_units: 0,
    });
    const loss = db.prepare('SELECT kind, amount FROM warranty_costs ORDER BY id').all();
    expect(loss).toEqual([{ kind: 'write_off', amount: 300000 }]);
    // Non-serial: quantities.
    const m = stockItem(db, { name: 'Floor Mat', stock: 5 });
    db.prepare(
      "INSERT INTO stock_movements (variant_id, date, type, location, qty_milli, unit_cost) VALUES (?, ?, 'adjustment', 'defective', 2000, 0)",
    ).run(m.id, TODAY);
    expect(() =>
      defective.writeOff(db, { variant_id: m.id, qty_milli: 3000, reason: 'x' }),
    ).toThrow(/Only 2/);
    defective.repair(db, { variant_id: m.id, qty_milli: 1000, reason: 'Stitched' });
    expect(products.variantStock(db, m.id)).toBe(6000);
    const rec = db
      .prepare("SELECT amount FROM warranty_costs WHERE kind = 'repaired_to_stock'")
      .pluck()
      .get();
    expect(rec).toBe(300000);
  });

  it('alerts: open, ready for pickup, overdue at supplier, expiring this month', () => {
    const db = freshDb();
    const sup = supplier(db);
    const { unit } = soldUnit(db);
    const c = open1(db, { serial_id: unit.id });
    claims.decide(
      db,
      {
        id: c.id,
        decision: 'supplier',
        dispatch: { supplier_party_id: sup.id, mode: 'hand', expected_date: TODAY },
      },
      ctx,
    );
    db.prepare('UPDATE claim_dispatches SET expected_date = ?').run(W.addDays(TODAY, -1));
    const a = units.alerts(db);
    expect(a).toMatchObject({ open_claims: 1, overdue_at_supplier: 1, ready_for_pickup: 0 });
    expect(claims.list(db, { tab: 'open', overdue: true }).rows).toHaveLength(1);
    expect(claims.forSupplier(db, sup.id).totals).toMatchObject({ pending: 1, overdue: 1 });
  });

  it('prints a claim slip with both copies and a warranty card', () => {
    const db = freshDb();
    const { unit, sale } = soldUnit(db);
    const c = open1(db, { serial_id: unit.id, accessories: ['Box', 'Remote'] });
    const html = claimPrint.claimHtml(db, c.id, { doc: 'slip', format: 'a4half' });
    expect(html).toContain('CUSTOMER COPY');
    expect(html).toContain('SHOP COPY');
    expect(html).toContain('Box, Remote');
    expect(claimPrint.claimHtml(db, c.id, { format: 'thermal80' })).toContain('Shop copy');
    const card = claimPrint.warrantyCardHtml(db, { sale_id: sale.id });
    expect(card).toContain(unit.serial_no);
    expect(card).toContain('WARRANTY CARD');
  });
});
