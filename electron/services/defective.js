'use strict';

// Defective stock: units kept out of sellable stock (stock_movements.location = 'defective').
// Serial items: product_serials.status = 'defective'. Non-serial items: a quantity per variant.
// Actions: write off (loss), repair back into sellable stock, send to the supplier (a 'stock'
// warranty claim). Each action is one transaction. No electron imports.

const { AppError } = require('../errors');
const { isISODate, todayISO, str } = require('./parse');
const serials = require('./serials');
const billing = require('./billing');
const { variantLabel } = require('./products');
const claims = require('./claims');

function fail(errors) {
  const keys = Object.keys(errors);
  if (keys.length) throw new AppError(`Please check: ${errors[keys[0]]}`, 'VALIDATION', errors);
}

function likeArg(word) {
  return `%${word.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/** Defective stock per variant, with the serial units and where each came from. */
function list(db, params = {}) {
  const q = str(params.search);
  const where = q
    ? `AND (p.name LIKE ? ESCAPE '\\' OR v.sku LIKE ? ESCAPE '\\' OR EXISTS (
         SELECT 1 FROM product_serials s WHERE s.variant_id = v.id AND s.status = 'defective'
           AND s.serial_key LIKE ? ESCAPE '\\'))`
    : '';
  const args = q ? [likeArg(q), likeArg(q), likeArg(serials.serialKey(q))] : [];
  const rows = db
    .prepare(
      `SELECT v.id AS variant_id, v.product_id, v.sku, v.color, v.size, v.variant_type, v.avg_cost,
         p.name AS product_name, p.brand, p.unit, p.track_serials,
         SUM(m.qty_milli) AS qty_milli, SUM(m.qty_milli * m.unit_cost) AS value_milli
       FROM stock_movements m JOIN product_variants v ON v.id = m.variant_id
       JOIN products p ON p.id = v.product_id
       WHERE m.location = 'defective' ${where}
       GROUP BY v.id HAVING SUM(m.qty_milli) > 0
       ORDER BY p.name COLLATE NOCASE, v.sort_order`,
    )
    .all(...args);
  const units = db.prepare(
    `SELECT s.id, s.serial_no, s.serial_no_2, s.supplier_party_id, su.name AS supplier_name,
       s.supplier_warranty_end, s.replaced_by_serial_id,
       (SELECT e.note FROM serial_events e WHERE e.serial_id = s.id ORDER BY e.id DESC LIMIT 1) AS last_note,
       (SELECT e.date FROM serial_events e WHERE e.serial_id = s.id ORDER BY e.id DESC LIMIT 1) AS since,
       (SELECT c.claim_no FROM warranty_claims c WHERE c.serial_id = s.id AND c.is_deleted = 0
          ORDER BY c.id DESC LIMIT 1) AS claim_no
     FROM product_serials s LEFT JOIN parties su ON su.id = s.supplier_party_id
     WHERE s.variant_id = ? AND s.status = 'defective' ORDER BY s.id`,
  );
  const today = todayISO();
  const out = rows.map((r) => ({
    ...r,
    variant_label: variantLabel(r),
    value: Math.max(0, Math.round(r.value_milli / 1000)),
    serials: r.track_serials
      ? units.all(r.variant_id).map((u) => ({
          ...u,
          supplier_warranty_active: Boolean(
            u.supplier_warranty_end && u.supplier_warranty_end >= today,
          ),
        }))
      : [],
    last_supplier_id:
      db
        .prepare(
          `SELECT pu.party_id FROM purchase_items pi JOIN purchases pu ON pu.id = pi.purchase_id
           WHERE pi.variant_id = ? AND pu.status = 'active' ORDER BY pu.bill_date DESC LIMIT 1`,
        )
        .pluck()
        .get(r.variant_id) || null,
  }));
  return {
    rows: out,
    total_units: out.reduce((s, r) => s + r.qty_milli, 0),
    total_value: out.reduce((s, r) => s + r.value, 0),
  };
}

function count(db) {
  return db
    .prepare("SELECT COALESCE(SUM(qty_milli), 0) FROM stock_movements WHERE location = 'defective'")
    .pluck()
    .get();
}

function common(p) {
  const errors = {};
  const date = p.date || todayISO();
  if (!isISODate(date)) errors.date = 'Invalid date.';
  else if (date > todayISO()) errors.date = 'The date is in the future.';
  const reason = str(p.reason);
  if (!reason) errors.reason = 'A reason is required.';
  else if (reason.length > 200) errors.reason = 'Too long (max 200).';
  return { errors, date, reason };
}

function loadVariant(db, variantId) {
  const v = db
    .prepare(
      `SELECT v.*, p.name AS product_name, p.unit, p.track_serials FROM product_variants v
       JOIN products p ON p.id = v.product_id WHERE v.id = ?`,
    )
    .get(variantId);
  if (!v) throw new AppError('Product not found.', 'NOT_FOUND');
  return v;
}

function qtyCheck(db, v, qty) {
  if (!Number.isSafeInteger(qty) || qty <= 0) fail({ qty_milli: 'Enter the quantity.' });
  const have = serials.defectiveStock(db, v.id).qty_milli;
  if (qty > have) fail({ qty_milli: `Only ${have / 1000} ${v.unit} defective.` });
}

/** Writes off defective stock (serial_id, or variant_id + qty_milli): the cost becomes a loss. */
function writeOff(db, payload) {
  const p = payload || {};
  const { errors, date, reason } = common(p);
  fail(errors);
  db.transaction(() => {
    if (Number.isInteger(p.serial_id)) {
      serials.changeStatus(db, { id: p.serial_id, to_status: 'written_off', reason, date });
      return;
    }
    const v = loadVariant(db, p.variant_id);
    if (v.track_serials) throw new AppError('Choose the serial number to write off.');
    qtyCheck(db, v, p.qty_milli);
    const unitCost = serials.defectiveUnitCost(db, v.id);
    serials.insertMovement(db, {
      variant_id: v.id,
      date,
      type: 'write_off',
      location: 'defective',
      qty_milli: -p.qty_milli,
      unit_cost: unitCost,
      reason,
    });
    const amount = billing.divRound(p.qty_milli * unitCost, 1000);
    if (amount > 0) {
      serials.insertCost(db, {
        date,
        kind: 'write_off',
        direction: 'cost',
        amount,
        variant_id: v.id,
        qty_milli: p.qty_milli,
        note: reason,
      });
    }
  })();
  return list(db);
}

/** Repaired: back into sellable stock at the average cost (the value gained is recovered). */
function repair(db, payload) {
  const p = payload || {};
  const { errors, date, reason } = common(p);
  fail(errors);
  db.transaction(() => {
    if (Number.isInteger(p.serial_id)) {
      serials.changeStatus(db, { id: p.serial_id, to_status: 'in_stock', reason, date });
      return;
    }
    const v = loadVariant(db, p.variant_id);
    if (v.track_serials) throw new AppError('Choose the serial number that was repaired.');
    qtyCheck(db, v, p.qty_milli);
    const poolCost = serials.defectiveUnitCost(db, v.id);
    const avg = v.avg_cost || v.purchase_price || 0;
    serials.insertMovement(db, {
      variant_id: v.id,
      date,
      type: 'adjustment',
      location: 'defective',
      qty_milli: -p.qty_milli,
      unit_cost: poolCost,
      reason,
    });
    serials.insertMovement(db, {
      variant_id: v.id,
      date,
      type: 'adjustment',
      qty_milli: p.qty_milli,
      unit_cost: avg,
      reason: `Repaired: ${reason}`,
    });
    const gain = billing.divRound(p.qty_milli * (avg - poolCost), 1000);
    if (gain > 0) {
      serials.insertCost(db, {
        date,
        kind: 'repaired_to_stock',
        direction: 'recovery',
        amount: gain,
        variant_id: v.id,
        qty_milli: p.qty_milli,
        note: reason,
      });
    }
  })();
  return list(db);
}

/**
 * Sends defective stock to the supplier as a 'stock' claim (WC-…), dispatched at once.
 * payload: { serial_id | variant_id + qty_milli, complaint, supplier_party_id, mode, courier,
 * docket_no, expected_date, date }
 */
function sendToSupplier(db, payload, ctx = {}) {
  const p = payload || {};
  const errors = {};
  const date = p.date || todayISO();
  if (!isISODate(date) || date > todayISO()) errors.date = 'Invalid date.';
  const complaint = str(p.complaint);
  if (!complaint) errors.complaint = 'Describe the fault.';
  else if (complaint.length > 500) errors.complaint = 'Too long (max 500).';
  fail(errors);
  const claimId = db.transaction(() => {
    let v;
    let serial = null;
    if (Number.isInteger(p.serial_id)) {
      serial = serials.loadSerial(db, p.serial_id);
      if (serial.status !== 'defective')
        throw new AppError(`${serial.serial_no} is not in defective stock.`);
      v = loadVariant(db, serial.variant_id);
    } else {
      v = loadVariant(db, p.variant_id);
      if (v.track_serials) throw new AppError('Choose the serial number to send.');
      qtyCheck(db, v, p.qty_milli);
    }
    const supplierId = Number.isInteger(p.supplier_party_id)
      ? p.supplier_party_id
      : serial && serial.supplier_party_id;
    const fromClaim = serial
      ? db
          .prepare(
            "SELECT claim_no FROM warranty_claims WHERE replacement_serial_id IS NOT NULL AND serial_id = ? AND kind = 'customer' ORDER BY id DESC LIMIT 1",
          )
          .pluck()
          .get(serial.id)
      : null;
    const c = claims.insertClaim(db, {
      kind: 'stock',
      serial_id: serial ? serial.id : null,
      sale_id: null,
      sale_item_id: null,
      product_id: v.product_id,
      variant_id: v.id,
      qty_milli: serial ? 1000 : p.qty_milli,
      customer_party_id: null,
      customer_name: null,
      customer_phone: null,
      vehicle_id: null,
      vehicle_no: null,
      vehicle_model: null,
      brought_by_name: null,
      brought_by_phone: null,
      ownership_note: fromClaim ? `Faulty unit taken back on ${fromClaim}.` : null,
      supplier_party_id: Number.isInteger(supplierId) ? supplierId : null,
      in_warranty:
        serial && serial.supplier_warranty_end && serial.supplier_warranty_end >= date ? 1 : 0,
      chargeable: 0,
      warranty_end: serial ? serial.supplier_warranty_end : null,
      received_date: date,
      received_by: null,
      complaint,
      complaint_tags: null,
      condition_notes: null,
      accessories: null,
      expected_date: p.expected_date || null,
      notes: null,
    });
    claims.event(db, c, { type: 'received', date, note: `Defective stock: ${complaint}` }, ctx);
    claims.dispatchInner(
      db,
      c,
      {
        supplier_party_id: Number.isInteger(supplierId) ? supplierId : null,
        dispatch_date: date,
        mode: p.mode,
        courier: p.courier,
        docket_no: p.docket_no,
        expected_date: p.expected_date,
        notes: p.notes,
      },
      ctx,
    );
    return c.id;
  })();
  return claims.get(db, claimId);
}

module.exports = { list, count, writeOff, repair, sendToSupplier };
