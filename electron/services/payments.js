'use strict';

// Payment rows and bill-wise allocations. Purchases (Phase 4) use these; Phase 6 adds the
// Accounts screens on top. Every function here runs inside the caller's transaction.

const { AppError } = require('../errors');
const { str } = require('./parse');
const settings = require('./settings');

const MODES = ['cash', 'upi', 'card', 'bank', 'cheque'];
const MODE_LABELS = { cash: 'Cash', upi: 'UPI', card: 'Card', bank: 'Bank', cheque: 'Cheque' };
// Card payments are settled into the bank account.
const ACCOUNT_TYPE = { cash: 'cash', upi: 'upi', card: 'bank', bank: 'bank', cheque: 'bank' };

/** Validates { amount, mode, ref_no } and returns a clean copy. `field` prefixes error keys. */
function validatePayment(p, field = 'payment') {
  const errors = {};
  const amount = p && p.amount;
  const mode = p && p.mode;
  const refNo = str(p && p.ref_no);
  if (!Number.isSafeInteger(amount) || amount <= 0) errors[`${field}.amount`] = 'Enter the amount.';
  if (!MODES.includes(mode)) errors[`${field}.mode`] = 'Choose Cash, UPI, Card, Bank or Cheque.';
  if (refNo.length > 40) errors[`${field}.ref_no`] = 'Too long (max 40).';
  if (mode === 'cheque' && !refNo) errors[`${field}.ref_no`] = 'Enter the cheque number.';
  return { errors, data: { amount, mode, ref_no: refNo || null } };
}

/** The account a payment mode goes to (system accounts first). */
function accountFor(db, mode) {
  const id = db
    .prepare(
      'SELECT id FROM accounts WHERE type = ? AND is_deleted = 0 ORDER BY is_system DESC, id LIMIT 1',
    )
    .pluck()
    .get(ACCOUNT_TYPE[mode]);
  if (!id) throw new AppError(`There is no ${MODE_LABELS[mode]} account.`, 'VALIDATION');
  return id;
}

/** Inserts a payment (in = received, out = paid). Returns { id, payment_no }. */
function insertPayment(db, p) {
  const { number } = settings.takeNextNumber(
    db,
    p.direction === 'in' ? 'payment_in' : 'payment_out',
  );
  const id = Number(
    db
      .prepare(
        `INSERT INTO payments (payment_no, date, direction, party_id, account_id, amount, ref_type,
           ref_id, notes, mode, ref_no)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        number,
        p.date,
        p.direction,
        p.party_id,
        accountFor(db, p.mode),
        p.amount,
        p.ref_type || 'on_account',
        p.ref_id ?? null,
        p.notes || null,
        p.mode,
        p.ref_no || null,
      ).lastInsertRowid,
  );
  return { id, payment_no: number };
}

function allocate(db, a) {
  if (!(a.amount > 0)) return null;
  return Number(
    db
      .prepare(
        `INSERT INTO bill_allocations (party_id, doc_type, doc_id, source_type, source_id, amount, date, note)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        a.party_id,
        a.doc_type,
        a.doc_id,
        a.source_type,
        a.source_id ?? null,
        a.amount,
        a.date,
        a.note || null,
      ).lastInsertRowid,
  );
}

/** Cancels the active allocations matching `where` (e.g. all for one bill). */
function releaseAllocations(db, { doc_type: docType, doc_id: docId, source_type, source_id }) {
  const where = ["status = 'active'"];
  const args = [];
  if (docType) {
    where.push('doc_type = ? AND doc_id = ?');
    args.push(docType, docId);
  }
  if (source_type) {
    where.push('source_type = ? AND source_id = ?');
    args.push(source_type, source_id);
  }
  return db
    .prepare(
      `UPDATE bill_allocations SET status = 'cancelled',
         cancelled_at = strftime('%Y-%m-%d %H:%M:%S','now','localtime')
       WHERE ${where.join(' AND ')}`,
    )
    .run(...args).changes;
}

function cancelPayment(db, paymentId, reason) {
  db.prepare(
    `UPDATE payments SET status = 'cancelled', cancel_reason = ?,
       cancelled_at = strftime('%Y-%m-%d %H:%M:%S','now','localtime')
     WHERE id = ? AND status = 'active'`,
  ).run(reason, paymentId);
  releaseAllocations(db, { source_type: 'payment', source_id: paymentId });
}

module.exports = {
  MODES,
  MODE_LABELS,
  validatePayment,
  accountFor,
  insertPayment,
  allocate,
  releaseAllocations,
  cancelPayment,
};
