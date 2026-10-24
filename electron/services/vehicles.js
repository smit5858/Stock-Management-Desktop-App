'use strict';

const { AppError } = require('../errors');
const { validateVehicle } = require('../validation/parties');
const id = require('../validation/identity');
const { str, todayISO, isISODate } = require('./parse');

// Customer vehicles. A plate exists once in the whole shop; ownership history lives in
// vehicle_owners (from_date inclusive, to_date = the day ownership ended, NULL = current).

function vehicleRow(db, vehicleId) {
  const v = db.prepare('SELECT * FROM vehicles WHERE id = ? AND is_deleted = 0').get(vehicleId);
  if (!v) throw new AppError('Vehicle not found.', 'NOT_FOUND');
  return v;
}

function customerRow(db, customerId) {
  const c = db
    .prepare("SELECT * FROM parties WHERE id = ? AND type = 'customer' AND is_deleted = 0")
    .get(customerId);
  if (!c) throw new AppError('Customer not found.', 'NOT_FOUND');
  if (c.is_system) {
    throw new AppError(
      'Vehicles cannot be added to Cash Customer. Create a customer with a phone number.',
    );
  }
  return c;
}

function get(db, vehicleId) {
  const v = db
    .prepare(
      `SELECT v.*, vm.make, vm.model, p.name AS customer_name, p.phone AS customer_phone
       FROM vehicles v LEFT JOIN vehicle_models vm ON vm.id = v.vehicle_model_id
       JOIN parties p ON p.id = v.customer_id WHERE v.id = ?`,
    )
    .get(vehicleId);
  if (!v) throw new AppError('Vehicle not found.', 'NOT_FOUND');
  return {
    ...v,
    plate_display: id.formatPlate(v.plate_no),
    plate_format: id.plateFormat(v.plate_no),
    customer_phone_display: id.formatPhone(v.customer_phone),
  };
}

/** Live check while typing a plate: normalised key, display form, format, and current owner. */
function check(db, { plate, id: selfId }) {
  const key = id.normalizePlate(plate);
  const owner = key
    ? db
        .prepare(
          `SELECT v.id AS vehicle_id, v.customer_id, p.name AS customer_name, p.phone
           FROM vehicles v JOIN parties p ON p.id = v.customer_id
           WHERE v.plate_no = ? AND v.is_deleted = 0 AND v.id <> ?`,
        )
        .get(key, Number(selfId) || 0)
    : null;
  return {
    plate_key: key,
    display: id.formatPlate(key),
    format: key ? id.plateFormat(key) : null,
    valid: id.isPlateKey(key),
    owner: owner ? { ...owner, phone_display: id.formatPhone(owner.phone) } : null,
  };
}

function checkData(db, data, selfId) {
  const errors = {};
  const owner = db
    .prepare(
      `SELECT p.name FROM vehicles v JOIN parties p ON p.id = v.customer_id
       WHERE v.plate_no = ? AND v.is_deleted = 0 AND v.id <> ?`,
    )
    .get(data.plate_no, selfId ?? 0);
  if (owner) {
    errors.plate_no = `Already exists: ${id.formatPlate(data.plate_no)} belongs to ${owner.name}. Use "Transfer vehicle" if it was sold.`;
  }
  if (data.vehicle_model_id !== null) {
    const ok = db
      .prepare('SELECT 1 FROM vehicle_models WHERE id = ? AND is_deleted = 0')
      .get(data.vehicle_model_id);
    if (!ok) errors.vehicle_model_id = 'Model not found.';
  }
  if (Object.keys(errors).length) throw new AppError(Object.values(errors)[0], 'DUPLICATE', errors);
}

function hasPrimary(db, customerId, exceptId = 0) {
  return Boolean(
    db
      .prepare(
        'SELECT 1 FROM vehicles WHERE customer_id = ? AND is_primary = 1 AND is_deleted = 0 AND id <> ?',
      )
      .get(customerId, exceptId),
  );
}

/** Inserts a validated vehicle for a customer. Call inside a transaction. Returns the id. */
function insertVehicle(db, customerId, data, date = todayISO()) {
  checkData(db, data, null);
  const primary = data.is_primary || !hasPrimary(db, customerId);
  if (primary)
    db.prepare('UPDATE vehicles SET is_primary = 0 WHERE customer_id = ?').run(customerId);
  const vehicleId = Number(
    db
      .prepare(
        `INSERT INTO vehicles (plate_no, customer_id, vehicle_model_id, variant, year, fuel, color, notes, is_primary)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        data.plate_no,
        customerId,
        data.vehicle_model_id,
        data.variant || null,
        data.year,
        data.fuel,
        data.color || null,
        data.notes || null,
        primary ? 1 : 0,
      ).lastInsertRowid,
  );
  db.prepare(
    'INSERT INTO vehicle_owners (vehicle_id, customer_id, from_date) VALUES (?, ?, ?)',
  ).run(vehicleId, customerId, date);
  return vehicleId;
}

function create(db, { customer_id: customerId, vehicle }) {
  const { data, warnings } = validateVehicle(vehicle);
  const vehicleId = db.transaction(() => {
    customerRow(db, customerId);
    return insertVehicle(db, customerId, data);
  })();
  return { ...get(db, vehicleId), warnings };
}

function update(db, { id: vehicleId, vehicle }) {
  const { data, warnings } = validateVehicle(vehicle);
  db.transaction(() => {
    const current = vehicleRow(db, vehicleId);
    checkData(db, data, vehicleId);
    if (data.is_primary) {
      db.prepare('UPDATE vehicles SET is_primary = 0 WHERE customer_id = ? AND id <> ?').run(
        current.customer_id,
        vehicleId,
      );
    }
    // Unticking the only primary vehicle is ignored: a customer with vehicles keeps one primary.
    const primary =
      data.is_primary || (current.is_primary && !hasPrimary(db, current.customer_id, vehicleId));
    db.prepare(
      `UPDATE vehicles SET plate_no = ?, vehicle_model_id = ?, variant = ?, year = ?, fuel = ?, color = ?,
         notes = ?, is_primary = ? WHERE id = ?`,
    ).run(
      data.plate_no,
      data.vehicle_model_id,
      data.variant || null,
      data.year,
      data.fuel,
      data.color || null,
      data.notes || null,
      primary ? 1 : 0,
      vehicleId,
    );
  })();
  return { ...get(db, vehicleId), warnings };
}

function setPrimary(db, { id: vehicleId }) {
  db.transaction(() => {
    const v = vehicleRow(db, vehicleId);
    db.prepare('UPDATE vehicles SET is_primary = 0 WHERE customer_id = ?').run(v.customer_id);
    db.prepare('UPDATE vehicles SET is_primary = 1 WHERE id = ?').run(vehicleId);
  })();
  return get(db, vehicleId);
}

/**
 * The car was sold: it moves to the new owner. Old bills and warranties keep pointing at the
 * customer who bought them; vehicle_owners records who owned the car when.
 */
function transfer(db, { id: vehicleId, to_customer_id: toId, date, note }) {
  const on = str(date) || todayISO();
  if (!isISODate(on))
    throw new AppError('Invalid transfer date.', 'VALIDATION', { date: 'Invalid date.' });
  db.transaction(() => {
    const v = vehicleRow(db, vehicleId);
    customerRow(db, toId);
    if (v.customer_id === toId) throw new AppError('The vehicle already belongs to this customer.');
    const current = db
      .prepare('SELECT * FROM vehicle_owners WHERE vehicle_id = ? AND to_date IS NULL')
      .get(vehicleId);
    if (current && on < current.from_date) {
      throw new AppError(
        `The transfer date cannot be before the current owner got the vehicle (${current.from_date}).`,
        'VALIDATION',
        { date: 'Too early.' },
      );
    }
    if (current) {
      db.prepare(
        'UPDATE vehicle_owners SET to_date = ?, note = COALESCE(note, ?) WHERE id = ?',
      ).run(on, str(note) || null, current.id);
    }
    db.prepare(
      'INSERT INTO vehicle_owners (vehicle_id, customer_id, from_date, note) VALUES (?, ?, ?, ?)',
    ).run(vehicleId, toId, on, str(note) || null);
    db.prepare('UPDATE vehicles SET customer_id = ?, is_primary = ? WHERE id = ?').run(
      toId,
      hasPrimary(db, toId) ? 0 : 1,
      vehicleId,
    );
    // The seller keeps a primary vehicle if they still have one.
    if (v.is_primary) {
      const next = db
        .prepare(
          'SELECT id FROM vehicles WHERE customer_id = ? AND is_deleted = 0 ORDER BY id LIMIT 1',
        )
        .pluck()
        .get(v.customer_id);
      if (next) db.prepare('UPDATE vehicles SET is_primary = 1 WHERE id = ?').run(next);
    }
  })();
  return get(db, vehicleId);
}

function history(db, { id: vehicleId }) {
  return db
    .prepare(
      `SELECT o.id, o.customer_id, o.from_date, o.to_date, o.note, p.name AS customer_name,
         p.phone, p.is_deleted
       FROM vehicle_owners o JOIN parties p ON p.id = o.customer_id
       WHERE o.vehicle_id = ? ORDER BY o.from_date DESC, o.id DESC`,
    )
    .all(vehicleId)
    .map((r) => ({ ...r, phone_display: id.formatPhone(r.phone) }));
}

/** Who owned the vehicle on `date` (for bills and warranties of that day). */
function ownerOn(db, vehicleId, date) {
  return (
    db
      .prepare(
        `SELECT customer_id FROM vehicle_owners WHERE vehicle_id = ? AND from_date <= ?
           AND (to_date IS NULL OR ? < to_date) ORDER BY from_date DESC, id DESC LIMIT 1`,
      )
      .pluck()
      .get(vehicleId, date, date) ?? null
  );
}

/** Removing a vehicle added by mistake: soft delete, only when no bill uses it. */
function remove(db, { id: vehicleId }) {
  db.transaction(() => {
    const v = vehicleRow(db, vehicleId);
    const used = db
      .prepare('SELECT COUNT(*) FROM sales WHERE vehicle_id = ? OR vehicle_no_key = ?')
      .pluck()
      .get(vehicleId, v.plate_no);
    if (used) {
      throw new AppError(
        'Bills refer to this vehicle, so it cannot be removed. Use "Transfer vehicle" if it was sold.',
        'HAS_HISTORY',
      );
    }
    db.prepare(
      'UPDATE vehicle_owners SET to_date = ? WHERE vehicle_id = ? AND to_date IS NULL',
    ).run(todayISO(), vehicleId);
    db.prepare('UPDATE vehicles SET is_deleted = 1, is_primary = 0 WHERE id = ?').run(vehicleId);
    if (v.is_primary) {
      const next = db
        .prepare(
          'SELECT id FROM vehicles WHERE customer_id = ? AND is_deleted = 0 ORDER BY id LIMIT 1',
        )
        .pluck()
        .get(v.customer_id);
      if (next) db.prepare('UPDATE vehicles SET is_primary = 1 WHERE id = ?').run(next);
    }
  })();
  return { removed: true };
}

/** Products that fit this vehicle's model (and year, when both are known). */
function compatibleProducts(db, { id: vehicleId }) {
  const v = vehicleRow(db, vehicleId);
  if (!v.vehicle_model_id) return { rows: [], universal_count: 0, needs_model: true };
  const year = v.year ?? null;
  const rows = db
    .prepare(
      `SELECT p.id, p.name, p.brand, p.image_path, pv.year_from, pv.year_to,
         MIN(pvar.selling_price) AS min_price, MAX(pvar.selling_price) AS max_price,
         (SELECT COALESCE(SUM(m.qty_milli), 0) FROM stock_movements m
            JOIN product_variants x ON x.id = m.variant_id
            WHERE x.product_id = p.id AND x.is_deleted = 0 AND m.location = 'main') AS stock_milli, p.unit
       FROM products p
       JOIN product_vehicles pv ON pv.product_id = p.id AND pv.vehicle_model_id = ?
       JOIN product_variants pvar ON pvar.product_id = p.id AND pvar.is_deleted = 0 AND pvar.is_active = 1
       WHERE p.is_deleted = 0 AND p.is_active = 1 AND p.is_universal = 0
         AND (? IS NULL OR ((pv.year_from IS NULL OR pv.year_from <= ?) AND (pv.year_to IS NULL OR pv.year_to >= ?)))
       GROUP BY p.id ORDER BY p.name COLLATE NOCASE LIMIT 200`,
    )
    .all(v.vehicle_model_id, year, year, year)
    .map((r) => ({ ...r, image_url: r.image_path ? `app-data://files/${r.image_path}` : null }));
  const universal = db
    .prepare(
      "SELECT COUNT(*) FROM products WHERE is_universal = 1 AND is_active = 1 AND is_deleted = 0 AND product_type = 'stock'",
    )
    .pluck()
    .get();
  return { rows, universal_count: universal, needs_model: false };
}

module.exports = {
  get,
  check,
  create,
  update,
  setPrimary,
  transfer,
  history,
  ownerOn,
  remove,
  compatibleProducts,
  insertVehicle,
};
