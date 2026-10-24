'use strict';

// Held purchase bills. The whole entry form is stored as JSON with a schema version (`v`).
// A draft has no stock or ledger effect. On resume every line is re-checked against today's
// data and problems are reported per line (never silently dropped).

const { AppError } = require('../errors');
const { str } = require('./parse');
const settings = require('./settings');
const serials = require('./serials');

const DRAFT_VERSION = 1;
const MAX_BYTES = 2 * 1024 * 1024;

function summaryOf(form) {
  const items = Array.isArray(form.items) ? form.items : [];
  return {
    party_id: Number.isInteger(form.party_id) ? form.party_id : null,
    supplier_name: str(form.supplier_name).slice(0, 120) || null,
    bill_no: str(form.bill_no).slice(0, 40) || null,
    item_count: items.filter((i) => i && i.variant_id).length,
    total: Number.isSafeInteger(form.total) ? form.total : 0,
  };
}

function save(db, { id = null, form }) {
  if (!form || typeof form !== 'object') throw new AppError('Nothing to save.', 'VALIDATION');
  const data = JSON.stringify({ ...form, v: DRAFT_VERSION });
  if (data.length > MAX_BYTES) throw new AppError('This draft is too large to save.', 'VALIDATION');
  const s = summaryOf(form);
  if (s.party_id) {
    const p = db.prepare('SELECT id FROM parties WHERE id = ? AND is_deleted = 0').get(s.party_id);
    if (!p) s.party_id = null;
  }
  if (id != null) {
    const row = db.prepare('SELECT status FROM purchase_drafts WHERE id = ?').get(id);
    if (!row) throw new AppError('Draft not found.', 'NOT_FOUND');
    if (row.status !== 'open') throw new AppError('This draft was already saved or discarded.');
    db.prepare(
      `UPDATE purchase_drafts SET party_id = ?, supplier_name = ?, bill_no = ?, item_count = ?,
         total = ?, data = ? WHERE id = ?`,
    ).run(s.party_id, s.supplier_name, s.bill_no, s.item_count, s.total, data, id);
    return { id };
  }
  const newId = Number(
    db
      .prepare(
        `INSERT INTO purchase_drafts (party_id, supplier_name, bill_no, item_count, total, data)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(s.party_id, s.supplier_name, s.bill_no, s.item_count, s.total, data).lastInsertRowid,
  );
  return { id: newId };
}

function list(db) {
  return db
    .prepare(
      `SELECT id, party_id, supplier_name, bill_no, item_count, total, created_at, updated_at
       FROM purchase_drafts WHERE status = 'open' ORDER BY updated_at DESC, id DESC`,
    )
    .all();
}

/**
 * Problems with a draft line today: product removed / inactive, variant gone, GST rate removed,
 * serial numbers that are now used. Returns { [index]: [messages] }.
 */
function checkLines(db, form) {
  const issues = {};
  const add = (i, msg) => {
    issues[i] = [...(issues[i] || []), msg];
  };
  const variant = db.prepare(
    `SELECT v.id, v.product_id, v.is_active, v.is_deleted, p.name, p.is_active AS p_active,
       p.is_deleted AS p_deleted, p.track_serials, p.product_type
     FROM product_variants v JOIN products p ON p.id = v.product_id WHERE v.id = ?`,
  );
  (form.items || []).forEach((it, i) => {
    if (!it || !Number.isInteger(it.variant_id)) return;
    const v = variant.get(it.variant_id);
    if (!v || v.p_deleted) return add(i, 'This product was removed.');
    if (v.is_deleted) return add(i, 'This variant was removed.');
    if (!v.p_active || !v.is_active) add(i, `"${v.name}" is now inactive.`);
    if (v.product_type === 'service') add(i, 'This is now a service (no stock).');
    if (form.bill_type !== 'non_gst' && Number.isInteger(it.gst_rate_bp)) {
      if (!settings.isActiveGstRate(db, it.gst_rate_bp)) {
        add(i, `GST ${it.gst_rate_bp / 100}% was removed from Settings. Choose another rate.`);
      }
    }
    if (v.track_serials) {
      const entries = (it.serials && it.serials.entries) || [];
      const checks = serials.checkSerials(db, { product_id: v.product_id, entries });
      const used = checks.filter((c) => c.error && !/Repeated/.test(c.error));
      if (used.length) {
        add(
          i,
          `Serial number${used.length === 1 ? '' : 's'} already in use: ${used
            .slice(0, 3)
            .map((c) => c.serial_no)
            .join(', ')}${used.length > 3 ? '…' : ''}`,
        );
      }
    } else if (it.serials && it.serials.entries && it.serials.entries.length) {
      add(i, 'This product no longer tracks serial numbers.');
    }
  });
  return issues;
}

function get(db, { id }) {
  const row = db.prepare('SELECT * FROM purchase_drafts WHERE id = ?').get(id);
  if (!row || row.status !== 'open') throw new AppError('Draft not found.', 'NOT_FOUND');
  let form;
  try {
    form = JSON.parse(row.data);
  } catch {
    throw new AppError('This draft could not be read.', 'DRAFT_DAMAGED');
  }
  if (!Number.isInteger(form.v) || form.v > DRAFT_VERSION) {
    throw new AppError(
      'This draft was saved by a newer version of Pragati Car and cannot be opened here.',
      'DRAFT_NEWER',
    );
  }
  // Future versions: upgrade older drafts here (form.v < DRAFT_VERSION).
  let supplierIssue = null;
  if (Number.isInteger(form.party_id)) {
    const p = db
      .prepare('SELECT is_deleted, is_active FROM parties WHERE id = ?')
      .get(form.party_id);
    if (!p || p.is_deleted) supplierIssue = 'The supplier was removed. Choose the supplier again.';
    else if (!p.is_active) supplierIssue = 'This supplier is now inactive.';
  }
  return {
    id: row.id,
    updated_at: row.updated_at,
    form,
    issues: checkLines(db, form),
    supplier_issue: supplierIssue,
  };
}

function discard(db, { id }) {
  const res = db
    .prepare("UPDATE purchase_drafts SET status = 'discarded' WHERE id = ? AND status = 'open'")
    .run(id);
  if (res.changes === 0) throw new AppError('Draft not found.', 'NOT_FOUND');
  return { id };
}

module.exports = { DRAFT_VERSION, save, list, get, discard, checkLines };
