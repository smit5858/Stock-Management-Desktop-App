'use strict';

const { AppError } = require('../errors');

// Keys the Settings screen may change. pin_* are handled separately (Phase 8).
const EDITABLE_KEYS = {
  business_name: (v) => typeof v === 'string' && v.trim().length > 0 && v.length <= 100,
  business_address: (v) => typeof v === 'string' && v.length <= 500,
  business_phone: (v) => typeof v === 'string' && v.length <= 50,
  business_email: (v) => typeof v === 'string' && v.length <= 100,
  business_gstin: (v) => typeof v === 'string' && /^([0-9A-Z]{15})?$/.test(v),
  business_state_code: (v) => typeof v === 'string' && /^(\d{2})?$/.test(v),
  invoice_footer: (v) => typeof v === 'string' && v.length <= 500,
  default_bill_type: (v) => ['gst', 'non_gst'].includes(v),
  default_price_mode: (v) => ['inclusive', 'exclusive'].includes(v),
  non_gst_bill_title: (v) => typeof v === 'string' && v.trim().length > 0 && v.length <= 40,
  composition_dealer: (v) => ['0', '1'].includes(v),
  purchase_price_mode: (v) => ['inclusive', 'exclusive'].includes(v),
  purchase_charges_mode: (v) => ['cost', 'expense'].includes(v),
  allow_negative_stock: (v) => ['0', '1'].includes(v),
  print_format: (v) => ['a4', 'thermal80'].includes(v),
  thermal_silent_print: (v) => ['0', '1'].includes(v),
  invoice_terms: (v) => typeof v === 'string' && v.length <= 1500,
  print_previous_balance: (v) => ['0', '1'].includes(v),
  // UPI VPA: name@bank (letters, digits, . - _). Empty = no QR on invoices.
  upi_id: (v) => typeof v === 'string' && /^([A-Za-z0-9._-]{2,64}@[A-Za-z0-9.-]{2,64})?$/.test(v),
  quotation_valid_days: (v) => typeof v === 'string' && /^\d{1,3}$/.test(v) && Number(v) <= 365,
  // Warranty (Phase 5.5)
  warranty_expiring_days: (v) =>
    typeof v === 'string' && /^\d{1,3}$/.test(v) && Number(v) >= 1 && Number(v) <= 365,
  replacement_warranty: (v) => ['remaining', 'fresh'].includes(v),
  claim_slip_format: (v) => ['a4half', 'thermal80'].includes(v),
  claim_terms: (v) => typeof v === 'string' && v.length <= 1500,
  claim_issue_presets: (v) => typeof v === 'string' && v.length <= 8000 && validPresets(v),
};

/** '' or JSON { "<category id>" | "*": ["No sound", …] } with short strings. */
function validPresets(v) {
  if (v === '') return true;
  try {
    const o = JSON.parse(v);
    return (
      o !== null &&
      typeof o === 'object' &&
      !Array.isArray(o) &&
      Object.entries(o).every(
        ([k, list]) =>
          (k === '*' || /^\d+$/.test(k)) &&
          Array.isArray(list) &&
          list.length <= 30 &&
          list.every((s) => typeof s === 'string' && s.length > 0 && s.length <= 60),
      )
    );
  } catch {
    return false;
  }
}

function getSettings(db) {
  const rows = db.prepare("SELECT key, value FROM settings WHERE key NOT LIKE 'pin_%'").all();
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

function updateSettings(db, values) {
  if (!values || typeof values !== 'object') throw new AppError('Nothing to save.', 'VALIDATION');
  const entries = Object.entries(values);
  for (const [key, value] of entries) {
    const valid = EDITABLE_KEYS[key];
    if (!valid) throw new AppError(`Unknown setting: ${key}`, 'VALIDATION');
    if (!valid(value))
      throw new AppError(`Invalid value for ${key.replace(/_/g, ' ')}.`, 'VALIDATION');
  }
  const upsert = db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  );
  db.transaction(() => {
    for (const [key, value] of entries)
      upsert.run(key, typeof value === 'string' ? value.trim() : value);
  })();
  return getSettings(db);
}

// ---------------------------------------------------------------- number series

function listSequences(db) {
  return db
    .prepare('SELECT id, name, prefix, next_value, pad_width FROM sequences ORDER BY id')
    .all();
}

function updateSequencePrefix(db, { name, prefix }) {
  if (typeof prefix !== 'string' || !/^[A-Za-z0-9/-]{1,12}$/.test(prefix)) {
    throw new AppError('Prefix: 1–12 letters, digits, "-" or "/".', 'VALIDATION');
  }
  const seq = db.prepare('SELECT id FROM sequences WHERE name = ?').get(name);
  if (!seq) throw new AppError('Unknown number series.', 'NOT_FOUND');
  const clash = db
    .prepare('SELECT name FROM sequences WHERE prefix = ? COLLATE NOCASE AND name <> ?')
    .get(prefix, name);
  if (clash) throw new AppError('Another number series already uses this prefix.', 'VALIDATION');
  db.prepare('UPDATE sequences SET prefix = ? WHERE id = ?').run(prefix, seq.id);
  return listSequences(db);
}

/**
 * Takes the next number of a series. Call inside the transaction that saves the document,
 * so a rolled-back save does not use up the number.
 */
function takeNextNumber(db, name) {
  const seq = db
    .prepare('SELECT id, prefix, next_value, pad_width FROM sequences WHERE name = ?')
    .get(name);
  if (!seq) throw new Error(`Missing sequence ${name}`);
  db.prepare('UPDATE sequences SET next_value = next_value + 1 WHERE id = ?').run(seq.id);
  return {
    seq_no: seq.next_value,
    number: `${seq.prefix}${String(seq.next_value).padStart(seq.pad_width, '0')}`,
  };
}

// ---------------------------------------------------------------- GST rates

function listGstRates(db) {
  return db
    .prepare('SELECT id, rate_bp FROM gst_rates WHERE is_deleted = 0 ORDER BY rate_bp')
    .all();
}

function addGstRate(db, { rate_bp }) {
  if (!Number.isInteger(rate_bp) || rate_bp < 0 || rate_bp > 10000) {
    throw new AppError('GST rate must be between 0% and 100% (max 2 decimals).', 'VALIDATION');
  }
  // Re-adding a removed rate brings the old row back (rate_bp is UNIQUE).
  db.prepare(
    `INSERT INTO gst_rates (rate_bp, sort_order) VALUES (?, ?)
     ON CONFLICT(rate_bp) DO UPDATE SET is_deleted = 0`,
  ).run(rate_bp, rate_bp);
  return listGstRates(db);
}

function removeGstRate(db, { id }) {
  const active = listGstRates(db);
  if (active.length <= 1) throw new AppError('At least one GST rate must remain.', 'VALIDATION');
  db.prepare('UPDATE gst_rates SET is_deleted = 1 WHERE id = ?').run(id);
  return listGstRates(db);
}

function isActiveGstRate(db, rateBp) {
  return Boolean(
    db.prepare('SELECT 1 FROM gst_rates WHERE rate_bp = ? AND is_deleted = 0').get(rateBp),
  );
}

module.exports = {
  getSettings,
  updateSettings,
  listSequences,
  updateSequencePrefix,
  takeNextNumber,
  listGstRates,
  addGstRate,
  removeGstRate,
  isActiveGstRate,
};
