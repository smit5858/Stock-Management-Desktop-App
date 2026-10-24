'use strict';

const { AppError } = require('../errors');
const { validateParty, validateVehicle, splitOpening } = require('../validation/parties');
const { insertVehicle } = require('./vehicles');
const id = require('../validation/identity');
const { str, todayISO, isISODate } = require('./parse');

const TYPES = ['customer', 'supplier'];
const MAX_LIST = 20000;

function likeArg(word) {
  return `%${word.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

function assertType(type) {
  if (!TYPES.includes(type)) throw new AppError('Unknown party type.', 'VALIDATION');
  return type;
}

/** Start of the Indian financial year (1 April) containing `today`. */
function fyStart(today = todayISO()) {
  const [y, m] = today.split('-').map(Number);
  return `${m >= 4 ? y : y - 1}-04-01`;
}

function balanceOf(db, partyId) {
  return db
    .prepare('SELECT COALESCE(SUM(amount), 0) FROM v_party_ledger WHERE party_id = ?')
    .pluck()
    .get(partyId);
}

// ---------------------------------------------------------------- reference data

function listCustomerTypes(db) {
  return db
    .prepare(
      `SELECT t.id, t.name, t.default_discount_bp,
         (SELECT COUNT(*) FROM parties p WHERE p.customer_type_id = t.id AND p.is_deleted = 0) AS customer_count
       FROM customer_types t WHERE t.is_deleted = 0 ORDER BY t.sort_order, t.name COLLATE NOCASE`,
    )
    .all();
}

function saveCustomerType(db, { id: typeId, name, default_discount_bp: bp }) {
  const clean = str(name);
  const discount = bp == null || bp === '' ? 0 : Number(bp);
  if (!clean || clean.length > 40) {
    throw new AppError('Type name: 1–40 characters.', 'VALIDATION', { name: 'Required.' });
  }
  if (!Number.isInteger(discount) || discount < 0 || discount > 10000) {
    throw new AppError('Discount must be 0–100%.', 'VALIDATION', {
      default_discount_bp: 'Invalid.',
    });
  }
  const clash = db
    .prepare(
      'SELECT id FROM customer_types WHERE name = ? COLLATE NOCASE AND is_deleted = 0 AND id <> ?',
    )
    .get(clean, typeId ?? 0);
  if (clash)
    throw new AppError('A type with this name already exists.', 'VALIDATION', { name: 'Exists.' });
  if (typeId) {
    const res = db
      .prepare(
        'UPDATE customer_types SET name = ?, default_discount_bp = ? WHERE id = ? AND is_deleted = 0',
      )
      .run(clean, discount, typeId);
    if (!res.changes) throw new AppError('Type not found.', 'NOT_FOUND');
  } else {
    db.prepare(
      'INSERT INTO customer_types (name, default_discount_bp, sort_order) VALUES (?, ?, 100)',
    ).run(clean, discount);
  }
  return listCustomerTypes(db);
}

/** Types are tags (configuration): removing one clears it from its customers. */
function deleteCustomerType(db, { id: typeId }) {
  db.transaction(() => {
    db.prepare('UPDATE customer_types SET is_deleted = 1 WHERE id = ?').run(typeId);
    db.prepare('UPDATE parties SET customer_type_id = NULL WHERE customer_type_id = ?').run(typeId);
  })();
  return listCustomerTypes(db);
}

function meta(db) {
  const business = db
    .prepare("SELECT value FROM settings WHERE key = 'business_state_code'")
    .pluck()
    .get();
  return {
    states: id.STATES,
    customer_types: listCustomerTypes(db),
    vehicle_models: db
      .prepare(
        'SELECT id, make, model FROM vehicle_models WHERE is_deleted = 0 ORDER BY make COLLATE NOCASE, model COLLATE NOCASE',
      )
      .all(),
    business_state_code: business || '',
  };
}

// ---------------------------------------------------------------- list / search

const LIST_SELECT = `
  SELECT p.id, p.type, p.name, p.firm_name, p.contact_person, p.phone, p.alt_phone, p.email,
    p.city, p.state_code, p.gstin, p.is_active, p.is_system, p.customer_type_id, p.credit_limit,
    p.payment_terms_days, p.linked_party_id, p.updated_at,
    ct.name AS type_name,
    COALESCE(b.balance, 0) AS balance,
    (SELECT group_concat(plate_no, ',') FROM (SELECT plate_no FROM vehicles
       WHERE customer_id = p.id AND is_deleted = 0 ORDER BY is_primary DESC, id)) AS plates,
    CASE p.type
      WHEN 'customer' THEN (SELECT MAX(invoice_date) FROM sales
        WHERE party_id = p.id AND status = 'active' AND is_deleted = 0)
      ELSE (SELECT MAX(bill_date) FROM purchases
        WHERE party_id = p.id AND status = 'active' AND is_deleted = 0)
    END AS last_date
  FROM parties p
  LEFT JOIN customer_types ct ON ct.id = p.customer_type_id
  LEFT JOIN v_party_balance b ON b.party_id = p.id`;

const SORTS = {
  name: 't.name COLLATE NOCASE',
  phone: "COALESCE(t.phone, '')",
  city: "COALESCE(t.city, '') COLLATE NOCASE",
  balance: 't.balance',
  last_date: "COALESCE(t.last_date, '')",
  vehicles: "COALESCE(t.plates, '')",
};

/**
 * One search box: name / firm / contact / city / GSTIN / email (every word must match), OR
 * phone digits (any format, partial), OR plate (any format, partial, must contain a digit).
 */
function searchCondition(text, type) {
  const q = str(text);
  if (!q) return null;
  const ors = [];
  const args = [];
  const words = q.split(/\s+/).filter(Boolean).slice(0, 6);
  const wordSql = words.map((w) => {
    const like = likeArg(w);
    args.push(like, like, like, like, like, like);
    return `(p.name LIKE ? ESCAPE '\\' OR p.firm_name LIKE ? ESCAPE '\\' OR p.contact_person LIKE ? ESCAPE '\\'
      OR p.city LIKE ? ESCAPE '\\' OR p.gstin LIKE ? ESCAPE '\\' OR p.email LIKE ? ESCAPE '\\')`;
  });
  ors.push(`(${wordSql.join(' AND ')})`);

  const digits = id.phoneSearchDigits(q);
  if (digits.length >= 3 && /^[\d\s+\-().]+$/.test(q)) {
    ors.push("(p.phone LIKE ? ESCAPE '\\' OR p.alt_phone LIKE ? ESCAPE '\\')");
    args.push(likeArg(digits), likeArg(digits));
  }
  const plate = id.normalizePlate(q);
  if (type !== 'supplier' && plate.length >= 2 && /\d/.test(plate)) {
    ors.push(
      "EXISTS (SELECT 1 FROM vehicles vs WHERE vs.customer_id = p.id AND vs.is_deleted = 0 AND vs.plate_no LIKE ? ESCAPE '\\')",
    );
    args.push(likeArg(plate));
  }
  return { sql: `(${ors.join(' OR ')})`, args };
}

function buildList(params = {}) {
  const where = ['p.is_deleted = 0'];
  const args = [];
  if (params.type) {
    where.push('p.type = ?');
    args.push(assertType(params.type));
  }
  const active = params.active || 'active';
  if (active === 'active') where.push('p.is_active = 1');
  else if (active === 'inactive') where.push('p.is_active = 0');

  if (Number.isInteger(params.customer_type_id)) {
    where.push('p.customer_type_id = ?');
    args.push(params.customer_type_id);
  }
  if (Number.isInteger(params.vehicle_model_id)) {
    where.push(
      'EXISTS (SELECT 1 FROM vehicles vf WHERE vf.customer_id = p.id AND vf.is_deleted = 0 AND vf.vehicle_model_id = ?)',
    );
    args.push(params.vehicle_model_id);
  } else if (params.make) {
    where.push(
      `EXISTS (SELECT 1 FROM vehicles vf JOIN vehicle_models vm ON vm.id = vf.vehicle_model_id
        WHERE vf.customer_id = p.id AND vf.is_deleted = 0 AND vm.make = ? COLLATE NOCASE)`,
    );
    args.push(String(params.make));
  }
  const search = searchCondition(params.search, params.type);
  if (search) {
    where.push(search.sql);
    args.push(...search.args);
  }

  // Balance filters run on the outer query (balance is computed).
  const outer = [];
  const supplier = params.type === 'supplier';
  if (params.balance === 'pending') outer.push(supplier ? 't.balance < 0' : 't.balance > 0');
  else if (params.balance === 'advance') outer.push(supplier ? 't.balance > 0' : 't.balance < 0');
  else if (params.balance === 'settled') outer.push('t.balance = 0');
  else if (params.balance === 'over_limit') {
    outer.push('t.credit_limit IS NOT NULL AND t.balance > t.credit_limit');
  }
  return {
    sql: `SELECT * FROM (${LIST_SELECT} WHERE ${where.join(' AND ')}) t${outer.length ? ` WHERE ${outer.join(' AND ')}` : ''}`,
    args,
  };
}

function decorateRow(r) {
  const plates = r.plates ? r.plates.split(',') : [];
  return {
    ...r,
    phone_display: id.formatPhone(r.phone),
    alt_phone_display: id.formatPhone(r.alt_phone),
    plates: plates.map((p) => ({ plate_no: p, display: id.formatPlate(p) })),
  };
}

/** Whole filtered list (the renderer virtualises it). */
function list(db, params = {}) {
  assertType(params.type);
  const { sql, args } = buildList(params);
  const sort = SORTS[params.sort] || SORTS.name;
  const dir = params.dir === 'desc' ? 'DESC' : 'ASC';
  const rows = db
    .prepare(`${sql} ORDER BY t.is_system DESC, ${sort} ${dir}, t.id ${dir} LIMIT ?`)
    .all(...args, MAX_LIST)
    .map(decorateRow);
  return { rows, total: rows.length, truncated: rows.length === MAX_LIST };
}

function stats(db, { type }) {
  assertType(type);
  const { sql, args } = buildList({ type, active: 'active' });
  return db
    .prepare(
      `SELECT COUNT(*) AS total,
         COALESCE(SUM(CASE WHEN balance > 0 THEN balance END), 0) AS positive,
         COALESCE(SUM(CASE WHEN balance < 0 THEN -balance END), 0) AS negative,
         COALESCE(SUM(credit_limit IS NOT NULL AND balance > credit_limit), 0) AS over_limit,
         COALESCE(SUM(balance < 0), 0) AS negative_count
       FROM (${sql}) WHERE is_system = 0`,
    )
    .get(...args);
}

/**
 * Quick find for the customer picker and Ctrl+K. A full plate selects that vehicle too; a full
 * mobile number puts its owner first.
 */
function search(db, { query, type = null, limit = 10 }) {
  const q = str(query);
  if (q.length < 2) return [];
  if (type) assertType(type);
  const max = Math.min(Number(limit) || 10, 50);
  const { sql, args } = buildList({ type, search: q, active: 'active' });
  const rows = db
    .prepare(`${sql} ORDER BY t.name COLLATE NOCASE LIMIT ?`)
    .all(...args, max)
    .map(decorateRow);

  const plate = id.normalizePlate(q);
  const vehicle =
    type !== 'supplier' && id.isPlateKey(plate)
      ? db
          .prepare(
            `SELECT v.id, v.customer_id, v.plate_no, vm.make, vm.model FROM vehicles v
             LEFT JOIN vehicle_models vm ON vm.id = v.vehicle_model_id
             WHERE v.plate_no = ? AND v.is_deleted = 0`,
          )
          .get(plate)
      : null;
  const phone = id.normalizePhone(q);
  const exactPhone = id.isPhone(phone) ? phone : null;

  const score = (r) =>
    (vehicle && r.id === vehicle.customer_id ? 2 : 0) +
    (exactPhone && r.phone === exactPhone ? 1 : 0);
  rows.sort((a, b) => score(b) - score(a));
  return rows.map((r) => ({
    ...r,
    matched_vehicle:
      vehicle && vehicle.customer_id === r.id
        ? { ...vehicle, display: id.formatPlate(vehicle.plate_no) }
        : null,
  }));
}

/** One row shaped like a list / search result (for the customer picker). */
function summary(db, partyId) {
  const row = db.prepare(`${LIST_SELECT} WHERE p.id = ? AND p.is_deleted = 0`).get(partyId);
  if (!row) throw new AppError('Customer / supplier not found.', 'NOT_FOUND');
  return decorateRow(row);
}

// ---------------------------------------------------------------- read one

function partyRow(db, partyId) {
  const p = db.prepare('SELECT * FROM parties WHERE id = ?').get(partyId);
  if (!p) throw new AppError('Customer / supplier not found.', 'NOT_FOUND');
  if (p.is_deleted) {
    const into = p.merged_into_id
      ? db.prepare('SELECT name FROM parties WHERE id = ?').pluck().get(p.merged_into_id)
      : null;
    throw new AppError(
      into ? `This record was merged into "${into}".` : 'This record was removed.',
      'NOT_FOUND',
    );
  }
  return p;
}

function vehiclesOf(db, customerId) {
  return db
    .prepare(
      `SELECT v.*, vm.make, vm.model,
         (SELECT COUNT(*) FROM sales s WHERE s.status = 'active' AND s.is_deleted = 0
            AND (s.vehicle_id = v.id OR s.vehicle_no_key = v.plate_no)) AS bill_count,
         (SELECT from_date FROM vehicle_owners o WHERE o.vehicle_id = v.id AND o.to_date IS NULL) AS owner_since
       FROM vehicles v LEFT JOIN vehicle_models vm ON vm.id = v.vehicle_model_id
       WHERE v.customer_id = ? AND v.is_deleted = 0 ORDER BY v.is_primary DESC, v.id`,
    )
    .all(customerId)
    .map((v) => ({
      ...v,
      plate_display: id.formatPlate(v.plate_no),
      plate_format: id.plateFormat(v.plate_no),
    }));
}

function totals(db, p) {
  const fy = fyStart();
  if (p.type === 'customer') {
    const s = db
      .prepare(
        `SELECT COUNT(*) AS bills, COALESCE(SUM(grand_total), 0) AS total,
           COALESCE(SUM(CASE WHEN invoice_date >= ? THEN grand_total END), 0) AS fy, MAX(invoice_date) AS last
         FROM sales WHERE party_id = ? AND status = 'active' AND is_deleted = 0`,
      )
      .get(fy, p.id);
    const r = db
      .prepare(
        `SELECT COALESCE(SUM(total), 0) AS total, COALESCE(SUM(CASE WHEN date >= ? THEN total END), 0) AS fy
         FROM sale_returns WHERE party_id = ? AND status = 'active' AND is_deleted = 0`,
      )
      .get(fy, p.id);
    return {
      bill_count: s.bills,
      lifetime: s.total - r.total,
      this_fy: s.fy - r.fy,
      last_date: s.last,
      fy_start: fy,
    };
  }
  const s = db
    .prepare(
      `SELECT COUNT(*) AS bills, COALESCE(SUM(grand_total), 0) AS total,
         COALESCE(SUM(CASE WHEN bill_date >= ? THEN grand_total END), 0) AS fy, MAX(bill_date) AS last
       FROM purchases WHERE party_id = ? AND status = 'active' AND is_deleted = 0`,
    )
    .get(fy, p.id);
  const r = db
    .prepare(
      `SELECT COALESCE(SUM(total), 0) AS total, COALESCE(SUM(CASE WHEN date >= ? THEN total END), 0) AS fy
       FROM purchase_returns WHERE party_id = ? AND status = 'active' AND is_deleted = 0`,
    )
    .get(fy, p.id);
  return {
    bill_count: s.bills,
    lifetime: s.total - r.total,
    this_fy: s.fy - r.fy,
    last_date: s.last,
    fy_start: fy,
  };
}

function get(db, partyId) {
  const p = partyRow(db, partyId);
  const type = p.customer_type_id
    ? db
        .prepare('SELECT name, default_discount_bp FROM customer_types WHERE id = ?')
        .get(p.customer_type_id)
    : null;
  const linked = p.linked_party_id
    ? db
        .prepare('SELECT id, type, name, phone FROM parties WHERE id = ? AND is_deleted = 0')
        .get(p.linked_party_id)
    : null;
  const gstBills = db
    .prepare(
      `SELECT COUNT(*) FROM ${p.type === 'customer' ? 'sales' : 'purchases'}
       WHERE party_id = ? AND bill_type = 'gst' AND status = 'active' AND is_deleted = 0`,
    )
    .pluck()
    .get(p.id);
  return {
    ...p,
    ...splitOpening(p.type, p.opening_balance),
    type_name: type ? type.name : null,
    default_discount_bp: type ? type.default_discount_bp : 0,
    phone_display: id.formatPhone(p.phone),
    alt_phone_display: id.formatPhone(p.alt_phone),
    state_name: id.stateName(p.state_code),
    balance: balanceOf(db, p.id),
    vehicles: p.type === 'customer' ? vehiclesOf(db, p.id) : [],
    linked: linked
      ? {
          ...linked,
          phone_display: id.formatPhone(linked.phone),
          balance: balanceOf(db, linked.id),
        }
      : null,
    gst_bill_count: gstBills,
    totals: totals(db, p),
    documents: documentCounts(db, p.id),
  };
}

// ---------------------------------------------------------------- write

/** Unique phone / GSTIN per type and referenced rows. Throws AppError with fields. */
function checkReferences(db, data, selfId) {
  const errors = {};
  const owner = (sql, ...args) => db.prepare(sql).get(...args, selfId ?? 0);
  if (data.phone) {
    const o = owner(
      'SELECT id, name FROM parties WHERE type = ? AND phone = ? AND is_deleted = 0 AND id <> ?',
      data.type,
      data.phone,
    );
    if (o) errors.phone = `Already exists: ${o.name}`;
  }
  if (data.gstin) {
    const o = owner(
      'SELECT id, name FROM parties WHERE type = ? AND gstin = ? AND is_deleted = 0 AND id <> ?',
      data.type,
      data.gstin,
    );
    if (o) errors.gstin = `GSTIN already used by ${o.name}`;
  }
  if (data.customer_type_id !== null) {
    const ok = db
      .prepare('SELECT 1 FROM customer_types WHERE id = ? AND is_deleted = 0')
      .get(data.customer_type_id);
    if (!ok) errors.customer_type_id = 'Type not found.';
  }
  if (Object.keys(errors).length) {
    throw new AppError(Object.values(errors)[0], 'DUPLICATE', errors);
  }
}

const COLUMNS = [
  'name',
  'phone',
  'alt_phone',
  'whatsapp_same',
  'email',
  'firm_name',
  'contact_person',
  'address',
  'city',
  'state_code',
  'pincode',
  'gstin',
  'customer_type_id',
  'credit_limit',
  'payment_terms_days',
  'supplies',
  'bank_details',
  'notes',
  'is_active',
  'opening_balance',
  'opening_balance_date',
];

function columnValues(data) {
  return COLUMNS.map((c) => {
    const v = data[c];
    if (typeof v === 'boolean') return v ? 1 : 0;
    return v === '' || v === undefined ? null : v;
  });
}

/** Inserts a validated party. Call inside a transaction. Returns the new id. */
function insertParty(db, data) {
  checkReferences(db, data, null);
  const cols = ['type', ...COLUMNS];
  return Number(
    db
      .prepare(
        `INSERT INTO parties (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
      )
      .run(data.type, ...columnValues(data)).lastInsertRowid,
  );
}

/** Updates a party with validated data. Call inside a transaction. */
function writeParty(db, partyId, data) {
  checkReferences(db, data, partyId);
  db.prepare(`UPDATE parties SET ${COLUMNS.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(
    ...columnValues(data),
    partyId,
  );
}

/** New customer / supplier; a new customer may bring vehicles (same transaction). */
function create(db, { type, party, vehicles = [] }) {
  assertType(type);
  const { data, warnings } = validateParty(party, { type });
  const list = type === 'customer' && Array.isArray(vehicles) ? vehicles : [];
  const checked = list.map((v, i) => {
    try {
      return validateVehicle(v);
    } catch (e) {
      if (e instanceof AppError && e.fields) {
        const fields = Object.fromEntries(
          Object.entries(e.fields).map(([k, m]) => [`vehicles.${i}.${k}`, m]),
        );
        throw new AppError(e.message, e.code, fields);
      }
      throw e;
    }
  });
  for (const v of checked) warnings.push(...v.warnings);
  const newId = db.transaction(() => {
    const partyId = insertParty(db, data);
    for (const v of checked) insertVehicle(db, partyId, v.data);
    return partyId;
  })();
  return { ...get(db, newId), warnings };
}

/**
 * Inline "new customer" from the picker: name + phone, optionally a plate (+ model / year),
 * all in one transaction. Returns { customer (picker row), vehicle_id, warnings }.
 */
function quickAdd(db, { name, phone, plate_no: plate, vehicle_model_id: modelId, year }) {
  const { data, warnings } = validateParty({ name, phone }, { type: 'customer' });
  const vehicle = str(plate)
    ? validateVehicle({ plate_no: plate, vehicle_model_id: modelId, year })
    : null;
  if (vehicle) warnings.push(...vehicle.warnings);
  const ids = db.transaction(() => {
    const customerId = insertParty(db, data);
    const vehicleId = vehicle ? insertVehicle(db, customerId, vehicle.data) : null;
    return { customerId, vehicleId };
  })();
  const customer = summary(db, ids.customerId);
  let matched = null;
  if (ids.vehicleId) {
    matched = db
      .prepare(
        `SELECT v.id, v.customer_id, v.plate_no, vm.make, vm.model FROM vehicles v
         LEFT JOIN vehicle_models vm ON vm.id = v.vehicle_model_id WHERE v.id = ?`,
      )
      .get(ids.vehicleId);
    matched.display = id.formatPlate(matched.plate_no);
  }
  return {
    customer: { ...customer, matched_vehicle: matched },
    vehicle_id: ids.vehicleId,
    warnings,
  };
}

function update(db, partyId, payload) {
  const { warnings, changedState } = db.transaction(() => {
    const current = partyRow(db, partyId);
    const { data, warnings: w } = validateParty(payload, {
      type: current.type,
      isSystem: Boolean(current.is_system),
    });
    if (current.is_system) {
      // Cash Customer: walk-in sales only, never a credit balance.
      data.opening_balance = 0;
      data.opening_balance_date = null;
      data.is_active = true;
    }
    writeParty(db, partyId, data);
    return { warnings: w, changedState: (current.state_code || '') !== (data.state_code || '') };
  })();
  const result = get(db, partyId);
  if (changedState && result.gst_bill_count > 0) {
    warnings.push('State changed: this only affects new bills. Saved bills keep their GST split.');
  }
  return { ...result, warnings };
}

function setActive(db, { id: partyId, is_active: active }) {
  const p = partyRow(db, partyId);
  if (p.is_system && !active) throw new AppError('Cash Customer cannot be deactivated.');
  db.prepare('UPDATE parties SET is_active = ? WHERE id = ?').run(active ? 1 : 0, partyId);
  return get(db, partyId);
}

const DOC_TABLES = {
  sales: 'SELECT COUNT(*) FROM sales WHERE party_id = @id',
  sale_returns: 'SELECT COUNT(*) FROM sale_returns WHERE party_id = @id',
  quotations: 'SELECT COUNT(*) FROM quotations WHERE party_id = @id',
  payments: 'SELECT COUNT(*) FROM payments WHERE party_id = @id',
  purchases: 'SELECT COUNT(*) FROM purchases WHERE party_id = @id',
  purchase_returns: 'SELECT COUNT(*) FROM purchase_returns WHERE party_id = @id',
  serials:
    'SELECT COUNT(*) FROM product_serials WHERE customer_party_id = @id OR supplier_party_id = @id',
  claims:
    'SELECT COUNT(*) FROM warranty_claims WHERE customer_party_id = @id OR supplier_party_id = @id',
};

/** Every document that refers to the party (cancelled ones too: they are history). */
function documentCounts(db, partyId) {
  const out = {};
  for (const [k, sql] of Object.entries(DOC_TABLES))
    out[k] = db.prepare(sql).pluck().get({ id: partyId });
  return out;
}

/**
 * Soft delete (is_deleted = 1), only for a record nothing refers to and with no balance:
 * typing mistakes. Anything with history can only be deactivated.
 */
function remove(db, { id: partyId }) {
  db.transaction(() => {
    const p = partyRow(db, partyId);
    if (p.is_system) throw new AppError('Cash Customer cannot be removed.');
    const docs = documentCounts(db, partyId);
    if (Object.values(docs).some((n) => n > 0)) {
      throw new AppError(
        'This record has bills or payments, so it cannot be removed. Deactivate it instead.',
        'HAS_HISTORY',
      );
    }
    if (balanceOf(db, partyId) !== 0) {
      throw new AppError(
        'This record has a balance, so it cannot be removed. Deactivate it instead.',
        'HAS_BALANCE',
      );
    }
    const today = todayISO();
    for (const v of db
      .prepare('SELECT id FROM vehicles WHERE customer_id = ? AND is_deleted = 0')
      .pluck()
      .all(partyId)) {
      db.prepare(
        'UPDATE vehicle_owners SET to_date = ? WHERE vehicle_id = ? AND to_date IS NULL',
      ).run(today, v);
      db.prepare('UPDATE vehicles SET is_deleted = 1, is_primary = 0 WHERE id = ?').run(v);
    }
    if (p.linked_party_id) {
      db.prepare('UPDATE parties SET linked_party_id = NULL WHERE id = ?').run(p.linked_party_id);
    }
    db.prepare('UPDATE parties SET is_deleted = 1, linked_party_id = NULL WHERE id = ?').run(
      partyId,
    );
  })();
  return { removed: true };
}

// ---------------------------------------------------------------- live duplicate check

/**
 * While typing: `phone` / `gstin` owners block saving; matches on alternate numbers only warn.
 * Returns { phone, gstin, phone_alt: [..], alt_phone: [..] }, each owner { id, name, phone_display }.
 */
function checkDuplicates(db, { type, id: selfId, phone, alt_phone: alt, gstin }) {
  assertType(type);
  const self = Number(selfId) || 0;
  const out = { phone: null, gstin: null, phone_alt: [], alt_phone: [] };
  const fmt = (r) => r && { ...r, phone_display: id.formatPhone(r.phone) };
  const base = 'SELECT id, name, phone FROM parties WHERE type = ? AND is_deleted = 0 AND id <> ?';
  const p = id.normalizePhone(phone);
  if (id.isPhone(p)) {
    out.phone = fmt(db.prepare(`${base} AND phone = ?`).get(type, self, p)) || null;
    out.phone_alt = db.prepare(`${base} AND alt_phone = ?`).all(type, self, p).map(fmt);
  }
  const a = id.normalizePhone(alt);
  if (id.isPhone(a)) {
    out.alt_phone = db
      .prepare(`${base} AND (phone = ? OR alt_phone = ?)`)
      .all(type, self, a, a)
      .map(fmt);
  }
  const g = id.normalizeGstin(gstin);
  if (g.length === 15)
    out.gstin = fmt(db.prepare(`${base} AND gstin = ?`).get(type, self, g)) || null;
  return out;
}

// ---------------------------------------------------------------- customer ↔ supplier link

function link(db, { id: partyId, other_id: otherId }) {
  db.transaction(() => {
    const a = partyRow(db, partyId);
    const b = partyRow(db, otherId);
    if (a.type === b.type) throw new AppError('Link a customer with a supplier.');
    if (a.is_system || b.is_system) throw new AppError('Cash Customer cannot be linked.');
    if (a.linked_party_id || b.linked_party_id) {
      throw new AppError('One of these records is already linked. Unlink it first.');
    }
    db.prepare('UPDATE parties SET linked_party_id = ? WHERE id = ?').run(b.id, a.id);
    db.prepare('UPDATE parties SET linked_party_id = ? WHERE id = ?').run(a.id, b.id);
  })();
  return get(db, partyId);
}

function unlink(db, { id: partyId }) {
  db.transaction(() => {
    const p = partyRow(db, partyId);
    if (p.linked_party_id) {
      db.prepare('UPDATE parties SET linked_party_id = NULL WHERE id IN (?, ?)').run(
        p.id,
        p.linked_party_id,
      );
    }
  })();
  return get(db, partyId);
}

/** "Also a supplier" / "Also a customer": a separate record with the same contact details. */
function createLinked(db, { id: partyId }) {
  const newId = db.transaction(() => {
    const p = partyRow(db, partyId);
    if (p.is_system) throw new AppError('Cash Customer cannot be a supplier.');
    if (p.linked_party_id) throw new AppError('This record is already linked.');
    const toSupplier = p.type === 'customer';
    const { data } = validateParty(
      {
        name: toSupplier ? p.firm_name || p.name : p.name,
        contact_person: toSupplier && p.firm_name ? p.name : '',
        firm_name: !toSupplier && p.contact_person ? p.name : '',
        phone: p.phone,
        alt_phone: p.alt_phone,
        email: p.email,
        address: p.address,
        city: p.city,
        state_code: p.state_code,
        pincode: p.pincode,
        gstin: p.gstin,
      },
      { type: toSupplier ? 'supplier' : 'customer' },
    );
    const created = insertParty(db, data);
    db.prepare('UPDATE parties SET linked_party_id = ? WHERE id = ?').run(created, p.id);
    db.prepare('UPDATE parties SET linked_party_id = ? WHERE id = ?').run(p.id, created);
    return created;
  })();
  return get(db, newId);
}

// ---------------------------------------------------------------- merge

// Every column that points at a party. Moving these is what "merge" means.
const MERGE_REFS = [
  ['sales', 'party_id'],
  ['sale_returns', 'party_id'],
  ['payments', 'party_id'],
  ['purchases', 'party_id'],
  ['purchase_returns', 'party_id'],
  ['bill_allocations', 'party_id'],
  ['purchase_drafts', 'party_id'],
  ['quotations', 'party_id'],
  ['sale_drafts', 'party_id'],
  ['product_serials', 'customer_party_id'],
  ['product_serials', 'supplier_party_id'],
  ['warranty_claims', 'customer_party_id'],
  ['warranty_claims', 'supplier_party_id'],
  ['claim_dispatches', 'supplier_party_id'],
  ['warranty_costs', 'party_id'],
  ['vehicles', 'customer_id'],
  ['vehicle_owners', 'customer_id'],
];

function mergePair(db, keepId, mergeId) {
  if (keepId === mergeId) throw new AppError('Choose two different records.');
  const keep = partyRow(db, keepId);
  const other = partyRow(db, mergeId);
  if (keep.type !== other.type)
    throw new AppError('Only two customers (or two suppliers) can be merged.');
  if (keep.is_system || other.is_system) throw new AppError('Cash Customer cannot be merged.');
  return { keep, other };
}

function mergePreview(db, { keep_id: keepId, merge_id: mergeId }) {
  const { keep, other } = mergePair(db, keepId, mergeId);
  const moves = {};
  for (const [table, col] of MERGE_REFS) {
    const n = db.prepare(`SELECT COUNT(*) FROM ${table} WHERE ${col} = ?`).pluck().get(other.id);
    if (n) moves[`${table}.${col}`] = n;
  }
  return {
    keep: {
      id: keep.id,
      name: keep.name,
      phone_display: id.formatPhone(keep.phone),
      balance: balanceOf(db, keep.id),
    },
    merge: {
      id: other.id,
      name: other.name,
      phone_display: id.formatPhone(other.phone),
      balance: balanceOf(db, other.id),
    },
    moves,
    combined_balance: balanceOf(db, keep.id) + balanceOf(db, other.id),
  };
}

const FILL_BLANKS = [
  'email',
  'firm_name',
  'contact_person',
  'address',
  'city',
  'state_code',
  'pincode',
  'gstin',
  'customer_type_id',
  'credit_limit',
  'payment_terms_days',
  'supplies',
  'bank_details',
];

/**
 * Moves every bill, payment, vehicle, warranty and ledger entry of `merge_id` to `keep_id`
 * in ONE transaction, soft-deletes the merged record and logs the merge.
 */
function merge(db, { keep_id: keepId, merge_id: mergeId, note }) {
  db.transaction(() => {
    const { keep, other } = mergePair(db, keepId, mergeId);
    const moved = {};
    const today = todayISO();

    // One primary vehicle per customer: the kept record's primary wins.
    const keepHasPrimary = db
      .prepare('SELECT 1 FROM vehicles WHERE customer_id = ? AND is_primary = 1 AND is_deleted = 0')
      .get(keep.id);
    if (keepHasPrimary) {
      db.prepare('UPDATE vehicles SET is_primary = 0 WHERE customer_id = ?').run(other.id);
    }
    // A supplier bill number may appear once per supplier.
    const clash = db
      .prepare(
        `SELECT a.bill_no, a.entry_no AS a_no, b.entry_no AS b_no FROM purchases a JOIN purchases b
           ON b.bill_no_key = a.bill_no_key AND b.party_id = ?
         WHERE a.party_id = ? AND a.status = 'active' AND b.status = 'active'
           AND a.is_deleted = 0 AND b.is_deleted = 0 LIMIT 1`,
      )
      .get(other.id, keep.id);
    if (clash) {
      throw new AppError(
        `Both suppliers have bill no. ${clash.bill_no} (${clash.a_no} and ${clash.b_no}). Cancel the duplicate purchase first.`,
      );
    }
    for (const [table, col] of MERGE_REFS) {
      const n = db
        .prepare(`UPDATE ${table} SET ${col} = ? WHERE ${col} = ?`)
        .run(keep.id, other.id).changes;
      if (n) moved[`${table}.${col}`] = n;
    }

    // Opening balances add up; the earlier as-of date is kept.
    const opening = keep.opening_balance + other.opening_balance;
    const dates = [keep, other]
      .filter((p) => p.opening_balance !== 0 && p.opening_balance_date)
      .map((p) => p.opening_balance_date)
      .sort();
    const openingDate = opening === 0 ? null : dates[0] || today;

    // Free the merged record's unique phone / GSTIN first, then fill the kept record's blanks.
    db.prepare(
      'UPDATE parties SET is_deleted = 1, is_active = 0, merged_into_id = ?, linked_party_id = NULL WHERE id = ?',
    ).run(keep.id, other.id);
    db.prepare('UPDATE parties SET merged_into_id = ? WHERE merged_into_id = ?').run(
      keep.id,
      other.id,
    );

    const patch = { opening_balance: opening, opening_balance_date: openingDate };
    for (const c of FILL_BLANKS) {
      if ((keep[c] == null || keep[c] === '') && other[c] != null && other[c] !== '')
        patch[c] = other[c];
    }
    if (!keep.alt_phone && other.phone && other.phone !== keep.phone) patch.alt_phone = other.phone;
    if (other.notes) patch.notes = [keep.notes, other.notes].filter(Boolean).join('\n');
    if (other.linked_party_id) {
      if (!keep.linked_party_id) {
        patch.linked_party_id = other.linked_party_id;
        db.prepare('UPDATE parties SET linked_party_id = ? WHERE id = ?').run(
          keep.id,
          other.linked_party_id,
        );
      } else {
        db.prepare('UPDATE parties SET linked_party_id = NULL WHERE id = ?').run(
          other.linked_party_id,
        );
      }
    }
    const keys = Object.keys(patch);
    db.prepare(`UPDATE parties SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(
      ...keys.map((k) => patch[k]),
      keep.id,
    );

    db.prepare(
      'INSERT INTO party_merges (kept_id, merged_id, date, details, note) VALUES (?, ?, ?, ?, ?)',
    ).run(
      keep.id,
      other.id,
      today,
      JSON.stringify({
        moved,
        merged: { name: other.name, phone: other.phone, opening_balance: other.opening_balance },
        kept_opening_before: keep.opening_balance,
      }),
      str(note) || null,
    );
  })();
  return get(db, keepId);
}

// ---------------------------------------------------------------- ledger

const ENTRY_LABELS = {
  opening: 'Opening balance',
  sale: 'Sale bill',
  sale_return: 'Sale return (credit note)',
  payment_in: 'Payment received',
  payment_out: 'Payment made',
  purchase: 'Purchase bill',
  purchase_return: 'Purchase return (debit note)',
  warranty_credit: 'Warranty credit from supplier',
};

/**
 * Running balance from v_party_ledger. Entries before `from` are carried in as the opening.
 * Debit = increases what the party owes us; credit = decreases it.
 */
function ledger(db, { id: partyId, from = '', to = '' }) {
  const p = partyRow(db, partyId);
  if (from && !isISODate(from)) throw new AppError('Invalid "from" date.', 'VALIDATION');
  if (to && !isISODate(to)) throw new AppError('Invalid "to" date.', 'VALIDATION');
  const opening = from
    ? db
        .prepare(
          'SELECT COALESCE(SUM(amount), 0) FROM v_party_ledger WHERE party_id = ? AND date < ?',
        )
        .pluck()
        .get(partyId, from)
    : 0;
  const where = ['party_id = ?'];
  const args = [partyId];
  if (from) {
    where.push('date >= ?');
    args.push(from);
  }
  if (to) {
    where.push('date <= ?');
    args.push(to);
  }
  let running = opening;
  let debit = 0;
  let credit = 0;
  const rows = db
    .prepare(
      `SELECT * FROM v_party_ledger WHERE ${where.join(' AND ')} ORDER BY date, sort_key, ref_id`,
    )
    .all(...args)
    .map((r, i) => {
      running += r.amount;
      if (r.amount > 0) debit += r.amount;
      else credit -= r.amount;
      return {
        key: `${r.entry_type}-${r.ref_id ?? i}`,
        ...r,
        label: ENTRY_LABELS[r.entry_type] || r.entry_type,
        debit: r.amount > 0 ? r.amount : 0,
        credit: r.amount < 0 ? -r.amount : 0,
        balance: running,
      };
    });
  return {
    party: {
      id: p.id,
      type: p.type,
      name: p.name,
      firm_name: p.firm_name,
      phone_display: id.formatPhone(p.phone),
      address: p.address,
      city: p.city,
      gstin: p.gstin,
    },
    from,
    to,
    opening,
    debit,
    credit,
    closing: running,
    rows,
  };
}

// ---------------------------------------------------------------- detail tabs

function bills(db, { id: partyId, vehicle_id: vehicleId }) {
  const args = [partyId];
  let vehicleSql = '';
  if (Number.isInteger(vehicleId)) {
    const plate = db.prepare('SELECT plate_no FROM vehicles WHERE id = ?').pluck().get(vehicleId);
    vehicleSql = ' AND (s.vehicle_id = ? OR s.vehicle_no_key = ?)';
    args.push(vehicleId, plate || '');
  }
  return db
    .prepare(
      `SELECT s.id, s.invoice_no, s.invoice_date, s.bill_type, s.grand_total, s.status, s.cancel_reason,
         s.vehicle_no, s.vehicle_id,
         (SELECT COUNT(*) FROM sale_items si WHERE si.sale_id = s.id) AS item_count,
         COALESCE(d.paid, 0) AS paid, COALESCE(d.due, 0) AS due,
         COALESCE(d.pay_status, 'cancelled') AS pay_status
       FROM sales s LEFT JOIN v_sale_dues d ON d.sale_id = s.id
       WHERE s.party_id = ? AND s.is_deleted = 0${vehicleSql}
       ORDER BY s.invoice_date DESC, s.id DESC LIMIT 1000`,
    )
    .all(...args);
}

function payments(db, { id: partyId }) {
  return db
    .prepare(
      `SELECT p.id, p.payment_no, p.date, p.direction, p.amount, p.ref_type, p.notes, p.status,
         a.name AS account_name
       FROM payments p JOIN accounts a ON a.id = p.account_id
       WHERE p.party_id = ? AND p.is_deleted = 0 ORDER BY p.date DESC, p.id DESC LIMIT 1000`,
    )
    .all(partyId);
}

function purchases(db, { id: partyId }) {
  const bills = db
    .prepare(
      `SELECT pu.id, pu.entry_no, pu.bill_no, pu.bill_date, pu.bill_type, pu.grand_total, pu.status,
         pu.cancel_reason, pu.due_date, pu.total_mismatch,
         COALESCE(d.paid, 0) AS paid, COALESCE(d.due, 0) AS due,
         COALESCE(d.pay_status, 'cancelled') AS pay_status,
         (SELECT COUNT(*) FROM purchase_items pi WHERE pi.purchase_id = pu.id AND pi.revision = pu.revision) AS item_count
       FROM purchases pu LEFT JOIN v_purchase_dues d ON d.purchase_id = pu.id
       WHERE pu.party_id = ? AND pu.is_deleted = 0
       ORDER BY pu.bill_date DESC, pu.id DESC LIMIT 1000`,
    )
    .all(partyId);
  const returns = db
    .prepare(
      `SELECT r.id, r.return_no, r.date, r.bill_type, r.total, r.status, r.settlement, pu.entry_no
       FROM purchase_returns r LEFT JOIN purchases pu ON pu.id = r.purchase_id
       WHERE r.party_id = ? AND r.is_deleted = 0 ORDER BY r.date DESC, r.id DESC LIMIT 1000`,
    )
    .all(partyId);
  return { bills, returns };
}

/** Serial-number warranties and non-serial bill-line warranties sold to this customer. */
function warranties(db, { id: partyId }) {
  return require('./warrantyUnits').forCustomer(db, partyId);
}

/** Claims sent to this supplier, units still with them, recovery totals and turnaround. */
function supplierClaims(db, { id: partyId }) {
  return require('./claims').forSupplier(db, partyId);
}

function suppliedProducts(db, { id: partyId }) {
  return db
    .prepare(
      `SELECT pi.product_id, pi.variant_id, pi.product_name, pi.variant_label, pi.unit,
         COUNT(*) AS times, SUM(pi.qty_milli) AS qty_milli, MAX(pu.bill_date) AS last_date,
         (SELECT x.rate FROM purchase_items x JOIN purchases y ON y.id = x.purchase_id
            WHERE x.variant_id = pi.variant_id AND y.party_id = pu.party_id AND y.status = 'active'
              AND x.revision = y.revision
            ORDER BY y.bill_date DESC, x.id DESC LIMIT 1) AS last_rate
       FROM purchase_items pi JOIN purchases pu ON pu.id = pi.purchase_id
       WHERE pu.party_id = ? AND pu.status = 'active' AND pu.is_deleted = 0 AND pi.revision = pu.revision
       GROUP BY pi.variant_id ORDER BY last_date DESC`,
    )
    .all(partyId);
}

module.exports = {
  TYPES,
  meta,
  listCustomerTypes,
  saveCustomerType,
  deleteCustomerType,
  list,
  stats,
  search,
  summary,
  get,
  create,
  quickAdd,
  update,
  setActive,
  remove,
  insertParty,
  writeParty,
  checkReferences,
  checkDuplicates,
  documentCounts,
  balanceOf,
  link,
  unlink,
  createLinked,
  mergePreview,
  merge,
  ledger,
  bills,
  payments,
  purchases,
  warranties,
  supplierClaims,
  suppliedProducts,
  fyStart,
  ENTRY_LABELS,
};
