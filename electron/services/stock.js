'use strict';

const { AppError } = require('../errors');
const { isISODate, todayISO, str } = require('./parse');
const { variantStock, variantLabel } = require('./products');
const serials = require('./serials');
const { normaliseSerialInput } = require('../validation/products');

const TYPE_LABELS = {
  opening: 'Opening stock',
  purchase: 'Purchase',
  purchase_return: 'Purchase return',
  sale: 'Sale',
  sale_return: 'Sale return',
  adjustment: 'Adjustment',
  warranty_return_in: 'Warranty: faulty unit taken back',
  warranty_replacement_out: 'Warranty replacement given',
  warranty_parts_used: 'Warranty repair parts',
  supplier_claim_out: 'Sent to supplier (claim)',
  supplier_claim_in: 'Received from supplier (claim)',
  write_off: 'Written off',
};

function loadVariant(db, variantId) {
  const v = db
    .prepare(
      `SELECT v.*, p.name AS product_name, p.product_type, p.unit, p.track_serials
       FROM product_variants v JOIN products p ON p.id = v.product_id
       WHERE v.id = ? AND v.is_deleted = 0 AND p.is_deleted = 0`,
    )
    .get(variantId);
  if (!v) throw new AppError('Product not found.', 'NOT_FOUND');
  return v;
}

/**
 * Adjustment for a serial-tracked variant.
 *  add:    payload.serials = { entries, auto } → one movement of +N and N new in_stock units
 *  remove: payload.serial_ids + to_status ('defective' | 'written_off') → one movement of −N
 */
function adjustSerials(db, v, payload, reason, date) {
  const cost = v.avg_cost || v.purchase_price;
  if (payload.serial_ids) {
    const ids = [...new Set(payload.serial_ids.map(Number))];
    const toStatus = payload.to_status === 'defective' ? 'defective' : 'written_off';
    if (ids.length === 0) {
      throw new AppError('Choose the units to remove.', 'VALIDATION', {
        serial_ids: 'Choose units.',
      });
    }
    const rows = ids.map((id) =>
      db
        .prepare('SELECT id, serial_no, status, variant_id FROM product_serials WHERE id = ?')
        .get(id),
    );
    for (const r of rows) {
      if (!r || r.variant_id !== v.id || r.status !== 'in_stock') {
        throw new AppError(
          `Serial ${r ? r.serial_no : ''} is not in stock for this item.`,
          'VALIDATION',
        );
      }
    }
    const movementId = serials.insertMovement(db, {
      variant_id: v.id,
      date,
      type: 'adjustment',
      qty_milli: -ids.length * 1000,
      unit_cost: cost,
      reason,
    });
    if (toStatus === 'defective') {
      // Kept out of sale, but still counted (and valued) at the defective location.
      serials.insertMovement(db, {
        variant_id: v.id,
        date,
        type: 'adjustment',
        location: 'defective',
        qty_milli: ids.length * 1000,
        unit_cost: cost,
        ref_type: 'stock_movement',
        ref_id: movementId,
        reason,
      });
    }
    for (const r of rows) {
      db.prepare('UPDATE product_serials SET status = ? WHERE id = ?').run(toStatus, r.id);
      serials.insertEvent(db, r.id, {
        date,
        type: toStatus === 'defective' ? 'marked_defective' : 'written_off',
        from_status: 'in_stock',
        to_status: toStatus,
        ref_type: 'stock_movement',
        ref_id: movementId,
        note: reason,
      });
    }
    return -ids.length * 1000;
  }

  const input = normaliseSerialInput(payload.serials);
  if (input.count === 0) {
    throw new AppError('Enter the serial numbers of the units you are adding.', 'VALIDATION', {
      serials: 'Required.',
    });
  }
  const movementId = serials.insertMovement(db, {
    variant_id: v.id,
    date,
    type: 'adjustment',
    qty_milli: input.count * 1000,
    unit_cost: cost,
    reason,
  });
  serials.addSerials(db, {
    variant_id: v.id,
    input,
    source_type: 'adjustment',
    date,
    event: 'adjusted_in',
    ref: { ref_type: 'stock_movement', ref_id: movementId },
  });
  return input.count * 1000;
}

/**
 * Manual stock adjustment (+ add / − remove) with a reason. Stock can never be typed in
 * directly; this adds a movement row. Removing more than is in stock is refused.
 * Serial-tracked items use serial numbers instead of a quantity (see adjustSerials).
 */
function adjust(db, payload) {
  const variantId = Number(payload.variant_id);
  const bySerial = Boolean(payload.serials || payload.serial_ids);
  const qty = bySerial ? 1 : payload.qty_milli;
  const reason = str(payload.reason);
  const date = payload.date || todayISO();
  const errors = {};
  if (!Number.isInteger(qty) || qty === 0 || Math.abs(qty) > 1e12)
    errors.qty_milli = 'Enter a quantity.';
  if (!reason) errors.reason = 'A reason is required.';
  else if (reason.length > 200) errors.reason = 'Reason is too long (max 200).';
  if (!isISODate(date)) errors.date = 'Invalid date.';
  if (Object.keys(errors).length) {
    throw new AppError(`Please check: ${Object.values(errors)[0]}`, 'VALIDATION', errors);
  }

  return db.transaction(() => {
    const v = loadVariant(db, variantId);
    if (v.product_type === 'service') throw new AppError('Services do not have stock.');
    const before = variantStock(db, variantId);
    if (v.track_serials) {
      if (!bySerial) throw new AppError('This item tracks serial numbers: add or pick the units.');
      const change = adjustSerials(db, v, payload, reason, date);
      return { variant_id: variantId, stock_milli: before + change };
    }
    if (bySerial) throw new AppError('This item does not track serial numbers.');
    if (qty < 0 && before + qty < 0) {
      throw new AppError(
        `Only ${before / 1000} ${v.unit} in stock; cannot remove ${-qty / 1000}.`,
        'VALIDATION',
        { qty_milli: 'More than the current stock.' },
      );
    }
    db.prepare(
      `INSERT INTO stock_movements (variant_id, date, type, qty_milli, unit_cost, reason)
       VALUES (?, ?, 'adjustment', ?, ?, ?)`,
    ).run(variantId, date, qty, v.avg_cost || v.purchase_price, reason);
    return { variant_id: variantId, stock_milli: before + qty };
  })();
}

/**
 * Date-wise in / out / running balance for one variant, optionally within [from, to].
 * location: 'main' (sellable stock, default) or 'defective'.
 */
function ledger(db, { variant_id, from, to, location = 'main' }) {
  const loc = location === 'defective' ? 'defective' : 'main';
  const v = loadVariant(db, Number(variant_id));
  if (from && !isISODate(from)) throw new AppError('Invalid "from" date.', 'VALIDATION');
  if (to && !isISODate(to)) throw new AppError('Invalid "to" date.', 'VALIDATION');

  const all = db
    .prepare(
      `SELECT id, date, type, qty_milli, reason, ref_type, ref_id, created_at,
         SUM(qty_milli) OVER (ORDER BY date, id ROWS UNBOUNDED PRECEDING) AS balance_milli
       FROM stock_movements WHERE variant_id = ? AND location = ? ORDER BY date, id`,
    )
    .all(v.id, loc);

  const opening = from
    ? all.filter((r) => r.date < from).reduce((sum, r) => sum + r.qty_milli, 0)
    : 0;
  const rows = all
    .filter((r) => (!from || r.date >= from) && (!to || r.date <= to))
    .map((r) => ({
      ...r,
      type_label: TYPE_LABELS[r.type] || r.type,
      in_milli: r.qty_milli > 0 ? r.qty_milli : 0,
      out_milli: r.qty_milli < 0 ? -r.qty_milli : 0,
    }));

  return {
    variant: {
      id: v.id,
      product_id: v.product_id,
      product_name: v.product_name,
      label: variantLabel(v),
      sku: v.sku,
      unit: v.unit,
    },
    location: loc,
    opening_milli: opening,
    closing_milli: rows.length ? rows[rows.length - 1].balance_milli : opening,
    total_in_milli: rows.reduce((s, r) => s + r.in_milli, 0),
    total_out_milli: rows.reduce((s, r) => s + r.out_milli, 0),
    rows,
  };
}

module.exports = { adjust, ledger };
