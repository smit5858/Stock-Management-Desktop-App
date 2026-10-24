'use strict';

const { AppError } = require('../errors');
const { isISODate, todayISO, str } = require('./parse');
const { warrantyEnd, warrantyStatus } = require('./warranty');

const MAX_SERIAL = 60;
const DEFAULT_AUTO_PREFIX = 'SN-';
const AUTO_PAD = 4;

const STATUS_LABELS = {
  in_stock: 'In stock',
  sold: 'Sold',
  returned_to_supplier: 'Returned to supplier',
  under_claim: 'Under claim',
  replaced: 'Replaced',
  defective: 'Defective',
  written_off: 'Written off',
  voided: 'Voided (purchase changed)',
};

/** Matching key: upper-case with all whitespace removed ("ab 12-x" → "AB12-X"). */
function serialKey(value) {
  return str(value).toUpperCase().replace(/\s+/g, '');
}

function likeArg(word) {
  return `%${word.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

function insertEvent(db, serialId, e) {
  db.prepare(
    `INSERT INTO serial_events (serial_id, date, type, from_status, to_status, ref_type, ref_id, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    serialId,
    e.date || todayISO(),
    e.type,
    e.from_status ?? null,
    e.to_status ?? null,
    e.ref_type ?? null,
    e.ref_id ?? null,
    e.note ?? null,
  );
}

/** Appends a stock movement. location 'main' = sellable stock, 'defective' = kept out of sale. */
function insertMovement(db, m) {
  return Number(
    db
      .prepare(
        `INSERT INTO stock_movements (variant_id, date, type, location, qty_milli, unit_cost, ref_type, ref_id, reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        m.variant_id,
        m.date || todayISO(),
        m.type,
        m.location || 'main',
        m.qty_milli,
        m.unit_cost ?? 0,
        m.ref_type ?? null,
        m.ref_id ?? null,
        m.reason ?? null,
      ).lastInsertRowid,
  );
}

/** Quantity and value (Σ qty × cost) of a variant's defective stock. */
function defectiveStock(db, variantId) {
  const r = db
    .prepare(
      `SELECT COALESCE(SUM(qty_milli), 0) AS qty_milli, COALESCE(SUM(qty_milli * unit_cost), 0) AS value_milli
       FROM stock_movements WHERE variant_id = ? AND location = 'defective'`,
    )
    .get(variantId);
  return { qty_milli: r.qty_milli, value: Math.max(0, Math.round(r.value_milli / 1000)) };
}

/**
 * Records warranty money (append-only): a cost (replacement given, parts, labour, write-off)
 * or a recovery (supplier replacement / credit, repaired back to stock).
 */
function insertCost(db, c) {
  return Number(
    db
      .prepare(
        `INSERT INTO warranty_costs (claim_id, date, kind, direction, amount, variant_id, serial_id,
           qty_milli, party_id, ref_no, note)
         VALUES (@claim_id, @date, @kind, @direction, @amount, @variant_id, @serial_id, @qty_milli,
           @party_id, @ref_no, @note)`,
      )
      .run({
        claim_id: null,
        variant_id: null,
        serial_id: null,
        qty_milli: null,
        party_id: null,
        ref_no: null,
        note: null,
        ...c,
        date: c.date || todayISO(),
      }).lastInsertRowid,
  );
}

/** Weighted-average cost of one unit of defective stock (what leaves it is valued at this). */
function defectiveUnitCost(db, variantId) {
  const d = defectiveStock(db, variantId);
  if (d.qty_milli <= 0) return 0;
  return Math.floor((d.value * 1000 * 2 + d.qty_milli) / (2 * d.qty_milli)); // half up
}

// ---------------------------------------------------------------- checking

/**
 * Checks a list of serials before saving.
 * errors (block saving): empty, too long, repeated in the list, already on THIS product.
 * warnings (soft): the same number exists on a DIFFERENT product (probably a typo).
 * `productId` may be null for a product that is not saved yet.
 * `allowIds`: serial rows that may be "entered again" (a purchase being edited keeps its units).
 * Voided units (removed from a purchase) do not count.
 */
function checkSerials(
  db,
  { product_id: productId = null, entries = [], allow_ids: allowIds = [] },
) {
  const allowed = new Set((allowIds || []).map(Number));
  const onProduct = db.prepare(
    "SELECT id, status FROM product_serials WHERE product_id = ? AND serial_key = ? AND status <> 'voided'",
  );
  const elsewhere = db.prepare(
    `SELECT p.name, s.status FROM product_serials s JOIN products p ON p.id = s.product_id
     WHERE s.serial_key = ? AND s.product_id IS NOT ? AND s.status <> 'voided' LIMIT 3`,
  );
  const seen = new Map();
  return entries.map((e, index) => {
    const serialNo = str(e.serial_no);
    const key = serialKey(serialNo);
    const result = { index, serial_no: serialNo, key, error: null, warning: null };
    if (!key) result.error = 'Empty serial number.';
    else if (serialNo.length > MAX_SERIAL) result.error = `Too long (max ${MAX_SERIAL}).`;
    else if (str(e.serial_no_2).length > MAX_SERIAL) result.error = 'Second number is too long.';
    else if (seen.has(key)) result.error = `Repeated (same as #${seen.get(key) + 1}).`;
    else {
      const own = productId ? onProduct.get(productId, key) : null;
      if (own && allowed.has(own.id)) result.existing_id = own.id;
      else if (own) result.error = `Already exists on this product (${STATUS_LABELS[own.status]}).`;
      else {
        const other = elsewhere.all(key, productId);
        if (other.length) {
          result.warning = `Also used on ${other.map((o) => `"${o.name}"`).join(', ')}. Check for a typo.`;
        }
      }
    }
    if (key && !seen.has(key)) seen.set(key, index);
    return result;
  });
}

/** Next `count` free numbers for a prefix (OLD-0001, OLD-0002…), numbered after the highest used. */
function previewAuto(db, { prefix, count, product_id: productId = null }) {
  const p = str(prefix) || DEFAULT_AUTO_PREFIX;
  if (!/^[A-Za-z0-9/-]{1,12}$/.test(p)) {
    throw new AppError('Prefix: 1–12 letters, digits, "-" or "/".', 'VALIDATION', {
      prefix: 'Invalid prefix.',
    });
  }
  const n = Number(count);
  if (!Number.isInteger(n) || n < 1 || n > 5000) {
    throw new AppError('Count must be between 1 and 5000.', 'VALIDATION', {
      count: 'Invalid count.',
    });
  }
  const keyPrefix = serialKey(p);
  const used = db
    .prepare("SELECT serial_key FROM product_serials WHERE serial_key LIKE ? ESCAPE '\\'")
    .pluck()
    .all(`${keyPrefix.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
  let max = 0;
  for (const k of used) {
    const rest = k.slice(keyPrefix.length);
    if (/^\d+$/.test(rest)) max = Math.max(max, Number(rest));
  }
  const taken = productId
    ? new Set(
        db
          .prepare('SELECT serial_key FROM product_serials WHERE product_id = ?')
          .pluck()
          .all(productId),
      )
    : new Set();
  const out = [];
  for (let i = max + 1; out.length < n; i++) {
    const serial = `${p}${String(i).padStart(AUTO_PAD, '0')}`;
    if (!taken.has(serialKey(serial))) out.push(serial);
  }
  return out;
}

// ---------------------------------------------------------------- adding units

/**
 * Inserts new in_stock units for a variant. Must run inside the caller's transaction; the caller
 * writes the matching stock movement (or none, when the stock already exists).
 * input = { entries: [{serial_no, serial_no_2}], auto: {prefix, count} | null }
 * Throws AppError with fields 'serials.<i>' for invalid entries.
 */
function addSerials(
  db,
  {
    variant_id: variantId,
    input,
    source_type: sourceType,
    date,
    event,
    ref,
    fieldPrefix = 'serials',
  },
) {
  const v = db
    .prepare(
      `SELECT v.id, v.product_id, p.supplier_warranty_months
       FROM product_variants v JOIN products p ON p.id = v.product_id WHERE v.id = ?`,
    )
    .get(variantId);
  if (!v) throw new AppError('Product not found.', 'NOT_FOUND');

  const checks = checkSerials(db, { product_id: v.product_id, entries: input.entries });
  const errors = {};
  checks.forEach((c) => {
    if (c.error) errors[`${fieldPrefix}.${c.index}`] = `${c.serial_no || '(empty)'}: ${c.error}`;
  });
  if (Object.keys(errors).length) {
    throw new AppError(`Serial numbers: ${Object.values(errors)[0]}`, 'VALIDATION', errors);
  }

  const rows = input.entries.map((e) => ({
    serial_no: str(e.serial_no),
    serial_no_2: str(e.serial_no_2),
    is_auto: 0,
  }));
  if (input.auto) {
    const existing = new Set(rows.map((r) => serialKey(r.serial_no)));
    const generated = previewAuto(db, {
      prefix: input.auto.prefix,
      count: input.auto.count + existing.size, // room in case typed entries use the same prefix
      product_id: v.product_id,
    }).filter((s) => !existing.has(serialKey(s)));
    for (const s of generated.slice(0, input.auto.count))
      rows.push({ serial_no: s, serial_no_2: '', is_auto: 1 });
  }

  // Purchases: supplier warranty runs from the supplier's bill date.
  const supplierEnd = warrantyEnd(ref?.warranty_date || date, v.supplier_warranty_months);
  const insert = db.prepare(
    `INSERT INTO product_serials (product_id, variant_id, serial_no, serial_key, serial_no_2, serial_key_2,
       is_auto, status, source_type, purchase_id, purchase_item_id, purchase_date, supplier_party_id,
       supplier_warranty_end)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'in_stock', ?, ?, ?, ?, ?, ?)`,
  );
  const ids = [];
  for (const r of rows) {
    const id = Number(
      insert.run(
        v.product_id,
        variantId,
        r.serial_no,
        serialKey(r.serial_no),
        r.serial_no_2 || null,
        r.serial_no_2 ? serialKey(r.serial_no_2) : null,
        r.is_auto,
        sourceType,
        ref?.purchase_id ?? null,
        ref?.purchase_item_id ?? null,
        ref?.warranty_date || date,
        ref?.supplier_party_id ?? null,
        supplierEnd,
      ).lastInsertRowid,
    );
    insertEvent(db, id, {
      date,
      type: event,
      to_status: 'in_stock',
      ref_type: ref?.ref_type,
      ref_id: ref?.ref_id,
      note: r.is_auto ? 'Auto-generated number' : null,
    });
    ids.push(id);
  }
  return ids;
}

// ---------------------------------------------------------------- manual status / warranty

// Manual changes allowed from the Serials tab. Sales, purchases and claims change status
// through their own documents (Phase 4/5).
const MANUAL = {
  in_stock: { defective: -1, written_off: -1 },
  defective: { in_stock: +1, written_off: 0 },
};
const EVENT_FOR = {
  defective: 'marked_defective',
  written_off: 'written_off',
  in_stock: 'repaired_to_stock',
};

function loadSerial(db, id) {
  const s = db.prepare('SELECT * FROM product_serials WHERE id = ?').get(id);
  if (!s) throw new AppError('Serial number not found.', 'NOT_FOUND');
  return s;
}

/** Changes one unit's status with a reason, writing the stock movement when stock changes. */
function changeStatus(db, { id, to_status: toStatus, reason, date = todayISO(), ref }) {
  const s = loadSerial(db, id);
  const delta = MANUAL[s.status]?.[toStatus];
  if (delta === undefined) {
    throw new AppError(
      `A unit that is "${STATUS_LABELS[s.status]}" cannot be changed to "${STATUS_LABELS[toStatus] || toStatus}" here.`,
    );
  }
  const note = str(reason);
  if (!note) throw new AppError('A reason is required.', 'VALIDATION', { reason: 'Required.' });
  if (!isISODate(date)) throw new AppError('Invalid date.', 'VALIDATION');

  const v = db
    .prepare('SELECT avg_cost, purchase_price FROM product_variants WHERE id = ?')
    .get(s.variant_id);
  const avg = v.avg_cost || v.purchase_price;
  const base = { variant_id: s.variant_id, date, ref_type: 'serial', ref_id: s.id };
  const reasonText = `${s.serial_no}: ${note}`;
  let movementId = null;
  if (s.status === 'defective') {
    // Leaves the defective location at its weighted-average cost.
    const poolCost = defectiveUnitCost(db, s.variant_id);
    movementId = insertMovement(db, {
      ...base,
      type: toStatus === 'written_off' ? 'write_off' : 'adjustment',
      location: 'defective',
      qty_milli: -1000,
      unit_cost: poolCost,
      reason: reasonText,
    });
    if (toStatus === 'written_off' && poolCost > 0) {
      insertCost(db, {
        claim_id: ref?.claim_id ?? null,
        date,
        kind: 'write_off',
        direction: 'cost',
        amount: poolCost,
        variant_id: s.variant_id,
        serial_id: s.id,
        qty_milli: 1000,
        note: reasonText,
      });
    }
    if (toStatus === 'in_stock') {
      movementId = insertMovement(db, {
        ...base,
        type: 'adjustment',
        qty_milli: 1000,
        unit_cost: avg,
        reason: reasonText,
      });
      // A unit that came in at no value (e.g. taken back on a claim) is worth the average
      // cost again once repaired: that difference is recovered.
      if (avg > poolCost) {
        insertCost(db, {
          claim_id: ref?.claim_id ?? null,
          date,
          kind: 'repaired_to_stock',
          direction: 'recovery',
          amount: avg - poolCost,
          variant_id: s.variant_id,
          serial_id: s.id,
          qty_milli: 1000,
          note: reasonText,
        });
      }
    }
  } else if (delta !== 0) {
    movementId = insertMovement(db, {
      ...base,
      type: 'adjustment',
      qty_milli: delta * 1000,
      unit_cost: avg,
      reason: reasonText,
    });
    if (toStatus === 'defective') {
      insertMovement(db, {
        ...base,
        type: 'adjustment',
        location: 'defective',
        qty_milli: 1000,
        unit_cost: avg,
        reason: reasonText,
      });
    }
  }
  db.prepare('UPDATE product_serials SET status = ? WHERE id = ?').run(toStatus, s.id);
  insertEvent(db, s.id, {
    date,
    type: EVENT_FOR[toStatus],
    from_status: s.status,
    to_status: toStatus,
    ref_type: ref?.ref_type ?? (movementId ? 'stock_movement' : null),
    ref_id: ref?.ref_id ?? movementId,
    note,
  });
  return movementId;
}

function setStatus(db, payload) {
  db.transaction(() => changeStatus(db, payload))();
  return get(db, payload.id);
}

/** Overrides one unit's customer warranty end date, with a reason (kept in its history). */
function setWarranty(db, { id, warranty_end: end, reason }) {
  const note = str(reason);
  const errors = {};
  if (!isISODate(end)) errors.warranty_end = 'Choose a valid date.';
  if (!note) errors.reason = 'A reason is required.';
  if (Object.keys(errors).length)
    throw new AppError(`Please check: ${Object.values(errors)[0]}`, 'VALIDATION', errors);
  db.transaction(() => {
    const s = loadSerial(db, id);
    db.prepare(
      'UPDATE product_serials SET warranty_end = ?, warranty_overridden = 1 WHERE id = ?',
    ).run(end, id);
    insertEvent(db, id, {
      type: 'warranty_changed',
      from_status: s.status,
      to_status: s.status,
      note: `Warranty end ${s.warranty_end || 'none'} → ${end}: ${note}`,
    });
  })();
  return get(db, id);
}

// ---------------------------------------------------------------- reading

function decorate(row, today) {
  return {
    ...row,
    status_label: STATUS_LABELS[row.status],
    variant_label: [row.color, row.size, row.variant_type].filter(Boolean).join(' / '),
    warranty: warrantyStatus(row.warranty_end, today),
    supplier_warranty: warrantyStatus(row.supplier_warranty_end, today),
  };
}

const SERIAL_SELECT = `
  SELECT s.*, p.name AS product_name, v.sku, v.color, v.size, v.variant_type,
    cu.name AS customer_name, cu.phone AS customer_phone, su.name AS supplier_name
  FROM product_serials s
  JOIN products p ON p.id = s.product_id
  JOIN product_variants v ON v.id = s.variant_id
  LEFT JOIN parties cu ON cu.id = s.customer_party_id
  LEFT JOIN parties su ON su.id = s.supplier_party_id`;

function list(db, params = {}) {
  const where = [];
  const args = [];
  if (Number.isInteger(params.product_id)) {
    where.push('s.product_id = ?');
    args.push(params.product_id);
  }
  if (Number.isInteger(params.variant_id)) {
    where.push('s.variant_id = ?');
    args.push(params.variant_id);
  }
  if (params.status && STATUS_LABELS[params.status]) {
    where.push('s.status = ?');
    args.push(params.status);
  }
  const q = serialKey(params.search);
  if (q) {
    where.push("(s.serial_key LIKE ? ESCAPE '\\' OR s.serial_key_2 LIKE ? ESCAPE '\\')");
    args.push(likeArg(q), likeArg(q));
  }
  const sql = `${SERIAL_SELECT}${where.length ? ` WHERE ${where.join(' AND ')}` : ''}`;
  const pageSize = Math.min(Math.max(Number(params.page_size) || 100, 1), 500);
  const page = Math.max(Number(params.page) || 1, 1);
  const today = todayISO();
  const total = db
    .prepare(`SELECT COUNT(*) FROM (${sql})`)
    .pluck()
    .get(...args);
  const rows = db
    .prepare(`${sql} ORDER BY s.status = 'in_stock' DESC, s.id DESC LIMIT ? OFFSET ?`)
    .all(...args, pageSize, (page - 1) * pageSize)
    .map((r) => decorate(r, today));

  const counts = Number.isInteger(params.product_id)
    ? Object.fromEntries(
        db
          .prepare(
            'SELECT status, COUNT(*) AS n FROM product_serials WHERE product_id = ? GROUP BY status',
          )
          .all(params.product_id)
          .map((r) => [r.status, r.n]),
      )
    : null;
  return { rows, total, page, page_size: pageSize, counts };
}

function get(db, id) {
  const row = db.prepare(`${SERIAL_SELECT} WHERE s.id = ?`).get(id);
  if (!row) throw new AppError('Serial number not found.', 'NOT_FOUND');
  const events = db
    .prepare('SELECT * FROM serial_events WHERE serial_id = ? ORDER BY date, id')
    .all(id);
  return { ...decorate(row, todayISO()), events };
}

/** Ctrl+K and the Warranty page: every product that has this serial (or second number). */
function search(db, { query, limit = 10 }) {
  const q = serialKey(query);
  if (q.length < 2) return [];
  const today = todayISO();
  return db
    .prepare(
      `${SERIAL_SELECT}
       WHERE s.serial_key LIKE ? ESCAPE '\\' OR s.serial_key_2 LIKE ? ESCAPE '\\'
       ORDER BY (s.serial_key = ?) DESC, s.id DESC LIMIT ?`,
    )
    .all(likeArg(q), likeArg(q), q, Math.min(Number(limit) || 10, 50))
    .map((r) => decorate(r, today));
}

/** In-stock units of a variant (for removing stock, and the billing picker later). */
function inStock(db, { variant_id: variantId, search: query = '' }) {
  const q = serialKey(query);
  return db
    .prepare(
      `SELECT id, serial_no, serial_no_2, is_auto, purchase_date FROM product_serials
       WHERE variant_id = ? AND status = 'in_stock' ${q ? "AND serial_key LIKE ? ESCAPE '\\'" : ''}
       ORDER BY id LIMIT 500`,
    )
    .all(...(q ? [variantId, likeArg(q)] : [variantId]));
}

/**
 * For tests and diagnostics: sellable stock from movements must equal the in_stock unit count,
 * and defective stock the defective unit count.
 */
function consistency(db, variantId) {
  const sum = db.prepare(
    'SELECT COALESCE(SUM(qty_milli), 0) FROM stock_movements WHERE variant_id = ? AND location = ?',
  );
  const count = db.prepare(
    'SELECT COUNT(*) FROM product_serials WHERE variant_id = ? AND status = ?',
  );
  const movements = sum.pluck().get(variantId, 'main');
  const units = count.pluck().get(variantId, 'in_stock');
  const defectiveMilli = sum.pluck().get(variantId, 'defective');
  const defectiveUnits = count.pluck().get(variantId, 'defective');
  return {
    movements_milli: movements,
    in_stock_units: units,
    defective_milli: defectiveMilli,
    defective_units: defectiveUnits,
    ok: movements === units * 1000 && defectiveMilli === defectiveUnits * 1000,
  };
}

module.exports = {
  STATUS_LABELS,
  serialKey,
  checkSerials,
  previewAuto,
  addSerials,
  changeStatus,
  setStatus,
  setWarranty,
  insertMovement,
  insertEvent,
  insertCost,
  defectiveStock,
  defectiveUnitCost,
  loadSerial,
  list,
  get,
  search,
  inStock,
  consistency,
};
