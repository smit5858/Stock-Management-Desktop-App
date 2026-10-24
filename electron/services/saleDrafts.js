'use strict';

// Held bills ("Hold"): the whole billing form as JSON with a schema version (`v`). A held bill
// has no stock or ledger effect. On resume every line is re-checked against today's data and
// problems are reported per line (never silently dropped).

const { AppError } = require('../errors');
const { str } = require('./parse');
const settings = require('./settings');
const { variantStock } = require('./products');

const DRAFT_VERSION = 1;
const MAX_BYTES = 2 * 1024 * 1024;

function summaryOf(form) {
  const items = Array.isArray(form.items) ? form.items : [];
  return {
    kind: form.kind === 'quotation' ? 'quotation' : 'bill',
    party_id: Number.isInteger(form.party_id) ? form.party_id : null,
    customer_name: str(form.customer_name).slice(0, 120) || null,
    vehicle_no: str(form.vehicle_no).slice(0, 20) || null,
    item_count: items.filter((i) => i && i.variant_id).length,
    total: Number.isSafeInteger(form.total) ? form.total : 0,
  };
}

function save(db, { id = null, form }) {
  if (!form || typeof form !== 'object') throw new AppError('Nothing to hold.', 'VALIDATION');
  const data = JSON.stringify({ ...form, v: DRAFT_VERSION });
  if (data.length > MAX_BYTES) throw new AppError('This bill is too large to hold.', 'VALIDATION');
  const s = summaryOf(form);
  if (s.party_id) {
    const p = db.prepare('SELECT id FROM parties WHERE id = ? AND is_deleted = 0').get(s.party_id);
    if (!p) s.party_id = null;
  }
  if (id != null) {
    const row = db.prepare('SELECT status FROM sale_drafts WHERE id = ?').get(id);
    if (!row) throw new AppError('Held bill not found.', 'NOT_FOUND');
    if (row.status !== 'open') throw new AppError('This held bill was already saved or discarded.');
    db.prepare(
      `UPDATE sale_drafts SET kind = ?, party_id = ?, customer_name = ?, vehicle_no = ?,
         item_count = ?, total = ?, data = ? WHERE id = ?`,
    ).run(s.kind, s.party_id, s.customer_name, s.vehicle_no, s.item_count, s.total, data, id);
    return { id };
  }
  const newId = Number(
    db
      .prepare(
        `INSERT INTO sale_drafts (kind, party_id, customer_name, vehicle_no, item_count, total, data)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(s.kind, s.party_id, s.customer_name, s.vehicle_no, s.item_count, s.total, data)
      .lastInsertRowid,
  );
  return { id: newId };
}

function list(db) {
  return db
    .prepare(
      `SELECT id, kind, party_id, customer_name, vehicle_no, item_count, total, created_at, updated_at
       FROM sale_drafts WHERE status = 'open' ORDER BY updated_at DESC, id DESC`,
    )
    .all();
}

/**
 * Problems with a held line today: product removed / inactive, GST rate removed, not enough
 * stock, picked serial numbers that are no longer in stock. Returns { [index]: [messages] }.
 */
function checkLines(db, form) {
  const issues = {};
  const add = (i, msg) => {
    issues[i] = [...(issues[i] || []), msg];
  };
  const s = settings.getSettings(db);
  const variant = db.prepare(
    `SELECT v.id, v.is_active, v.is_deleted, p.name, p.is_active AS p_active,
       p.is_deleted AS p_deleted, p.track_serials, p.product_type, p.unit
     FROM product_variants v JOIN products p ON p.id = v.product_id WHERE v.id = ?`,
  );
  const serial = db.prepare(
    'SELECT serial_no, status, variant_id FROM product_serials WHERE id = ?',
  );
  (form.items || []).forEach((it, i) => {
    if (!it || !Number.isInteger(it.variant_id)) return;
    const v = variant.get(it.variant_id);
    if (!v || v.p_deleted) return add(i, 'This product was removed.');
    if (v.is_deleted) return add(i, 'This variant was removed.');
    if (!v.p_active || !v.is_active) add(i, `"${v.name}" is now inactive.`);
    if (form.bill_type !== 'non_gst' && Number.isInteger(it.gst_rate_bp) && it.gst_rate_bp !== 0) {
      if (!settings.isActiveGstRate(db, it.gst_rate_bp)) {
        add(i, `GST ${it.gst_rate_bp / 100}% was removed from Settings. Choose another rate.`);
      }
    }
    if (v.product_type === 'service') return;
    if (v.track_serials) {
      const gone = (it.serials || [])
        .map((x) => ({ x, row: serial.get(x.id) }))
        .filter(({ row }) => !row || row.status !== 'in_stock' || row.variant_id !== it.variant_id);
      if (gone.length) {
        add(
          i,
          `No longer in stock: ${gone
            .slice(0, 3)
            .map(({ x }) => x.serial_no)
            .join(', ')}. Pick again.`,
        );
      }
    } else if (form.kind !== 'quotation' && s.allow_negative_stock !== '1') {
      const stock = variantStock(db, it.variant_id);
      if (Number.isSafeInteger(it.qty_milli) && it.qty_milli > stock) {
        add(i, `Only ${Math.max(stock, 0) / 1000} ${v.unit} in stock now.`);
      }
    }
  });
  return issues;
}

function get(db, { id }) {
  const row = db.prepare('SELECT * FROM sale_drafts WHERE id = ?').get(id);
  if (!row || row.status !== 'open') throw new AppError('Held bill not found.', 'NOT_FOUND');
  let form;
  try {
    form = JSON.parse(row.data);
  } catch {
    throw new AppError('This held bill could not be read.', 'DRAFT_DAMAGED');
  }
  if (!Number.isInteger(form.v) || form.v > DRAFT_VERSION) {
    throw new AppError(
      'This held bill was saved by a newer version of Pragati Car and cannot be opened here.',
      'DRAFT_NEWER',
    );
  }
  let customerIssue = null;
  if (Number.isInteger(form.party_id)) {
    const p = db
      .prepare('SELECT is_deleted, is_active FROM parties WHERE id = ?')
      .get(form.party_id);
    if (!p || p.is_deleted) customerIssue = 'The customer was removed. Choose the customer again.';
    else if (!p.is_active) customerIssue = 'This customer is now inactive.';
  }
  return {
    id: row.id,
    updated_at: row.updated_at,
    form,
    issues: checkLines(db, form),
    customer_issue: customerIssue,
  };
}

function discard(db, { id }) {
  const res = db
    .prepare("UPDATE sale_drafts SET status = 'discarded' WHERE id = ? AND status = 'open'")
    .run(id);
  if (res.changes === 0) throw new AppError('Held bill not found.', 'NOT_FOUND');
  return { id };
}

module.exports = { DRAFT_VERSION, save, list, get, discard, checkLines };
