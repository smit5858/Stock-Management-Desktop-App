'use strict';

// Sales bills (Tax Invoice / Bill of Supply / Estimate): validation, live calculation, save,
// cancel, payments and the read side (list, detail, stats). No electron imports.
// A save is ONE transaction: number, header, lines, fitting links, stock movements at the
// average cost, serials → sold (with warranty + history), payments, allocations and audit.
// Saved bills are never edited: cancel (with a reason) and issue a new one.

const { AppError } = require('../errors');
const { isISODate, todayISO, str } = require('./parse');
const settings = require('./settings');
const serials = require('./serials');
const payments = require('./payments');
const billing = require('./billing');
const { variantLabel, variantStock } = require('./products');
const { warrantyEnd, warrantyStatus } = require('./warranty');
const { amountInWords } = require('./words');
const id = require('../validation/identity');

const SERIES = { gst: 'sale_gst', non_gst: 'sale_non_gst' };
const MAX_LINES = 300;
const MAX_PAYMENTS = 6;
const MAX_QTY = 1e9; // milli-units
const MAX_RATE = 1e11; // paise
const BACKDATE_WARN_DAYS = 7;

// ---------------------------------------------------------------- small helpers

function fail(errors, code = 'VALIDATION') {
  const keys = Object.keys(errors);
  if (keys.length) throw new AppError(`Please check: ${errors[keys[0]]}`, code, errors);
}

function addDays(iso, days) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

function money(paise) {
  const neg = paise < 0;
  const a = Math.abs(paise);
  return `${neg ? '-' : ''}₹${((a - (a % 100)) / 100).toLocaleString('en-IN')}.${String(a % 100).padStart(2, '0')}`;
}

const int = (v, fallback = 0) => (Number.isSafeInteger(v) ? v : fallback);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function audit(
  db,
  { sale_id = null, sale_return_id = null, quotation_id = null, action, actor, summary, details },
) {
  db.prepare(
    `INSERT INTO sale_audit (sale_id, sale_return_id, quotation_id, action, actor, summary, details)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    sale_id,
    sale_return_id,
    quotation_id,
    action,
    actor || 'This computer',
    summary,
    details ? JSON.stringify(details) : null,
  );
}

function cashCustomerId(db) {
  return db
    .prepare("SELECT id FROM parties WHERE is_system = 1 AND type = 'customer' ORDER BY id LIMIT 1")
    .pluck()
    .get();
}

function balanceOf(db, partyId) {
  return db
    .prepare('SELECT COALESCE(SUM(amount), 0) FROM v_party_ledger WHERE party_id = ?')
    .pluck()
    .get(partyId);
}

/** Composition dealers issue only Bills of Supply (no tax). */
function effectiveBillType(requested, s) {
  if (s.composition_dealer === '1') return 'non_gst';
  return requested === 'non_gst' ? 'non_gst' : 'gst';
}

function billTitle(billType, s) {
  if (billType === 'gst') return 'Tax Invoice';
  if (s.composition_dealer === '1') return 'Bill of Supply';
  return str(s.non_gst_bill_title) || 'Bill of Supply';
}

/** CGST+SGST when the customer is in our state (or a state is unknown), else IGST. */
function placeOfSupply(customer, s) {
  const business = s.business_state_code || '';
  const pos = (customer && customer.state_code) || business;
  return { pos, interstate: Boolean(business && pos && pos !== business) };
}

function customerRow(db, partyId) {
  const p = db.prepare('SELECT * FROM parties WHERE id = ?').get(partyId);
  if (!p || p.is_deleted) throw new AppError('Customer not found.', 'NOT_FOUND');
  if (p.type !== 'customer')
    throw new AppError('Choose a customer (not a supplier).', 'VALIDATION');
  return p;
}

function loadVariantInfo(db, variantId) {
  return db
    .prepare(
      `SELECT v.*, p.name AS product_name, p.product_type, p.unit, p.hsn_code, p.track_serials,
         p.gst_rate_bp AS product_gst_rate_bp, p.price_includes_gst, p.customer_warranty_months,
         p.warranty_start_basis, p.is_universal, p.fitting_variant_id, p.fitting_charge,
         p.is_active AS product_active, p.is_deleted AS product_deleted
       FROM product_variants v JOIN products p ON p.id = v.product_id WHERE v.id = ?`,
    )
    .get(variantId);
}

function seqPreview(db, name) {
  const s = db
    .prepare('SELECT prefix, next_value, pad_width FROM sequences WHERE name = ?')
    .get(name);
  return s ? `${s.prefix}${String(s.next_value).padStart(s.pad_width, '0')}` : '';
}

function vehicleSnapshot(db, vehicleId) {
  const v = db
    .prepare(
      `SELECT v.*, vm.make, vm.model FROM vehicles v
       LEFT JOIN vehicle_models vm ON vm.id = v.vehicle_model_id WHERE v.id = ?`,
    )
    .get(vehicleId);
  if (!v || v.is_deleted) return null;
  return {
    ...v,
    display: id.formatPlate(v.plate_no),
    model_name: [v.make, v.model].filter(Boolean).join(' ') || null,
  };
}

// ---------------------------------------------------------------- meta & lookups

function meta(db) {
  const s = settings.getSettings(db);
  const cashId = cashCustomerId(db);
  return {
    business_state_code: s.business_state_code || '',
    business_name: s.business_name || '',
    composition_dealer: s.composition_dealer === '1',
    default_bill_type: effectiveBillType(s.default_bill_type, s),
    default_price_mode: s.default_price_mode === 'inclusive' ? 'inclusive' : 'exclusive',
    non_gst_bill_title: billTitle('non_gst', s),
    gst_rates: settings.listGstRates(db),
    next_numbers: {
      gst: seqPreview(db, SERIES.gst),
      non_gst: seqPreview(db, SERIES.non_gst),
      quotation: seqPreview(db, 'quotation'),
    },
    payment_modes: payments.MODE_LABELS,
    allow_negative_stock: s.allow_negative_stock === '1',
    print_format: s.print_format === 'thermal80' ? 'thermal80' : 'a4',
    thermal_silent_print: s.thermal_silent_print === '1',
    has_upi: Boolean(s.upi_id),
    quotation_valid_days: Number(s.quotation_valid_days || 7),
    cash_customer_id: cashId,
    max_round_off: billing.MAX_SALE_ROUND_OFF,
    backdate_warn_days: BACKDATE_WARN_DAYS,
  };
}

/** Header info for the selected customer: balance, advance, credit limit, discount, vehicles. */
function customerInfo(db, { party_id: partyId }) {
  const p = customerRow(db, partyId);
  const type = p.customer_type_id
    ? db
        .prepare('SELECT name, default_discount_bp FROM customer_types WHERE id = ?')
        .get(p.customer_type_id)
    : null;
  const balance = balanceOf(db, p.id);
  const vehicles = db
    .prepare(
      `SELECT v.id, v.plate_no, v.year, v.variant, v.is_primary, v.vehicle_model_id, vm.make, vm.model
       FROM vehicles v LEFT JOIN vehicle_models vm ON vm.id = v.vehicle_model_id
       WHERE v.customer_id = ? AND v.is_deleted = 0 ORDER BY v.is_primary DESC, v.id`,
    )
    .all(p.id)
    .map((v) => ({ ...v, display: id.formatPlate(v.plate_no) }));
  return {
    id: p.id,
    name: p.name,
    is_cash: Boolean(p.is_system),
    state_code: p.state_code,
    gstin: p.gstin,
    balance,
    advance: Math.max(-balance, 0),
    credit_limit: p.credit_limit,
    payment_terms_days: p.payment_terms_days,
    type_name: type ? type.name : null,
    default_discount_bp: type ? type.default_discount_bp : 0,
    vehicles,
  };
}

/** Does the product fit this vehicle (specific compatibility, not universal)? */
function fitsVehicle(db, productId, vehicle) {
  if (!vehicle || !vehicle.vehicle_model_id) return false;
  const row = db
    .prepare(
      'SELECT year_from, year_to FROM product_vehicles WHERE product_id = ? AND vehicle_model_id = ?',
    )
    .get(productId, vehicle.vehicle_model_id);
  if (!row) return false;
  if (!vehicle.year) return true;
  return (
    (row.year_from == null || vehicle.year >= row.year_from) &&
    (row.year_to == null || vehicle.year <= row.year_to)
  );
}

/**
 * Billing search: name / SKU / barcode / vehicle model, plus an exact in-stock serial number
 * (scanning a unit's serial adds that unit). Rows carry stock, prices, "fits", fitting defaults.
 */
function searchItems(db, { query, vehicle_id: vehicleId = null, limit = 15 }) {
  const q = str(query);
  if (!q) return [];
  const products = require('./products');
  const vehicle = Number.isInteger(vehicleId) ? vehicleSnapshot(db, vehicleId) : null;
  const rows = products.search(db, { query: q, limit: Math.min(Number(limit) || 15, 40) });

  const key = serials.serialKey(q);
  const units =
    key.length >= 3
      ? db
          .prepare(
            `SELECT s.id, s.serial_no, s.variant_id FROM product_serials s
             JOIN product_variants v ON v.id = s.variant_id JOIN products p ON p.id = s.product_id
             WHERE (s.serial_key = ? OR s.serial_key_2 = ?) AND s.status = 'in_stock'
               AND v.is_deleted = 0 AND v.is_active = 1 AND p.is_active = 1 AND p.is_deleted = 0
             LIMIT 5`,
          )
          .all(key, key)
      : [];
  const decorate = (r, serial = null) => {
    const v = loadVariantInfo(db, r.variant_id);
    const fit = v.fitting_variant_id ? loadVariantInfo(db, v.fitting_variant_id) : null;
    return {
      ...r,
      price_includes_gst: Boolean(v.price_includes_gst),
      customer_warranty_months: v.customer_warranty_months,
      warranty_start_basis: v.warranty_start_basis,
      fits: fitsVehicle(db, v.product_id, vehicle),
      fitting:
        fit && !fit.is_deleted && !fit.product_deleted && fit.is_active && fit.product_active
          ? {
              variant_id: fit.id,
              product_id: fit.product_id,
              name: fit.product_name,
              variant_label: variantLabel(fit),
              hsn_code: fit.hsn_code,
              unit: fit.unit,
              gst_rate_bp: fit.product_gst_rate_bp,
              price_includes_gst: Boolean(fit.price_includes_gst),
              selling_price: v.fitting_charge ?? fit.selling_price,
            }
          : null,
      serial,
    };
  };
  const out = units.map((u) =>
    decorate(
      { ...products.searchRow(db, u.variant_id), exact: true },
      {
        id: u.id,
        serial_no: u.serial_no,
      },
    ),
  );
  for (const r of rows) out.push(decorate(r));
  // A scanned serial first, then products that fit the customer's vehicle (stable sort).
  return out.sort(
    (a, b) =>
      Number(Boolean(b.serial)) - Number(Boolean(a.serial)) || Number(b.fits) - Number(a.fits),
  );
}

// ---------------------------------------------------------------- calculation

function calcItems(payloadItems) {
  return (payloadItems || []).map((it) => ({
    qty_milli: Math.max(int(it.qty_milli), 0),
    rate: Math.max(int(it.rate), 0),
    discount_bp: it.discount_bp == null ? null : Math.min(Math.max(int(it.discount_bp), 0), 10000),
    discount: Math.max(int(it.discount), 0),
    gst_rate_bp: Math.max(int(it.gst_rate_bp), 0),
    item_type: it.item_type === 'service' ? 'service' : 'goods',
  }));
}

/** Live totals for the billing screen. Lenient: bad numbers count as 0 (save validates). */
function calculate(db, payload = {}) {
  const s = settings.getSettings(db);
  const customer = Number.isInteger(payload.party_id)
    ? db.prepare('SELECT state_code FROM parties WHERE id = ?').get(payload.party_id)
    : null;
  const { interstate } = placeOfSupply(customer, s);
  const billType = effectiveBillType(payload.bill_type, s);
  const calc = billing.calculateSale({
    bill_type: billType,
    price_mode: payload.price_mode === 'inclusive' ? 'inclusive' : 'exclusive',
    is_interstate: interstate,
    round_off:
      payload.round_off == null
        ? null
        : Math.max(
            Math.min(int(payload.round_off), billing.MAX_SALE_ROUND_OFF),
            -billing.MAX_SALE_ROUND_OFF,
          ),
    bill_discount_bp:
      payload.bill_discount_bp == null
        ? null
        : Math.min(Math.max(int(payload.bill_discount_bp), 0), 10000),
    bill_discount: Math.max(int(payload.bill_discount), 0),
    items: calcItems(payload.items),
  });
  return {
    bill_type: billType,
    is_interstate: interstate,
    lines: calc.items,
    totals: calc.totals,
    tax_summary: calc.tax_summary,
    amount_in_words: amountInWords(Math.max(calc.totals.grand_total, 0)),
  };
}

// ---------------------------------------------------------------- validation

/**
 * Validates a bill (kind 'bill') or quotation (kind 'quotation') and resolves everything the
 * save needs. `opts.exchange_credit` = credit from an exchange return (paid towards this bill).
 * Soft warnings that need a confirmation come back as AppError codes DATE_CONFIRM / CREDIT_LIMIT
 * unless `confirm_date` / `confirm_credit` is set.
 */
function validate(db, payload, opts = {}) {
  const p = payload || {};
  const kind = opts.kind || 'bill';
  const errors = {};
  const s = settings.getSettings(db);
  const today = todayISO();

  let customer = null;
  if (!Number.isInteger(p.party_id)) errors.party_id = 'Choose the customer.';
  else {
    try {
      customer = customerRow(db, p.party_id);
      if (!customer.is_active) errors.party_id = 'This customer is inactive.';
    } catch (e) {
      errors.party_id = e.message;
    }
  }

  const date = p.date || today;
  if (!isISODate(date)) errors.date = 'Enter the bill date.';
  const billType = effectiveBillType(p.bill_type, s);
  const priceMode = p.price_mode === 'inclusive' ? 'inclusive' : 'exclusive';
  if (
    p.round_off != null &&
    (!Number.isInteger(p.round_off) || Math.abs(p.round_off) > billing.MAX_SALE_ROUND_OFF)
  ) {
    errors.round_off = 'Round-off must be within ±₹1.';
  }
  const billDiscountBp = p.bill_discount_bp == null ? null : p.bill_discount_bp;
  const billDiscount = p.bill_discount == null ? 0 : p.bill_discount;
  if (
    billDiscountBp != null &&
    !(Number.isInteger(billDiscountBp) && billDiscountBp >= 0 && billDiscountBp <= 10000)
  ) {
    errors.bill_discount = 'Bill discount must be 0–100%.';
  }
  if (!Number.isSafeInteger(billDiscount) || billDiscount < 0)
    errors.bill_discount = 'Invalid discount.';
  const notes = str(p.notes);
  if (notes.length > 500) errors.notes = 'Notes are too long (max 500).';

  // Vehicle: one of the customer's own vehicles.
  let vehicle = null;
  if (p.vehicle_id != null) {
    vehicle = Number.isInteger(p.vehicle_id) ? vehicleSnapshot(db, p.vehicle_id) : null;
    if (!vehicle) errors.vehicle_id = 'Vehicle not found.';
    else if (customer && vehicle.customer_id !== customer.id) {
      errors.vehicle_id = 'This vehicle belongs to another customer.';
    }
  }

  let validTill = null;
  if (kind === 'quotation') {
    validTill = p.valid_till || addDays(date, Number(s.quotation_valid_days || 7));
    if (!isISODate(validTill) || (isISODate(date) && validTill < date)) {
      errors.valid_till = 'Valid till must be on or after the quotation date.';
    }
  }

  const rateOk = (bp) => Number.isInteger(bp) && (bp === 0 || settings.isActiveGstRate(db, bp));
  const rawItems = Array.isArray(p.items) ? p.items : [];
  if (rawItems.length === 0) errors.items = 'Add at least one item.';
  if (rawItems.length > MAX_LINES) errors.items = `At most ${MAX_LINES} lines per bill.`;
  const usedSerials = new Map();
  const items = rawItems.slice(0, MAX_LINES).map((it, i) => {
    const f = (k) => `items.${i}.${k}`;
    const v = Number.isInteger(it.variant_id) ? loadVariantInfo(db, it.variant_id) : null;
    const line = {
      index: i,
      v,
      variant_id: it.variant_id,
      item_type: v && v.product_type === 'service' ? 'service' : 'goods',
      qty_milli: it.qty_milli,
      rate: it.rate,
      discount_bp: it.discount_bp == null ? null : it.discount_bp,
      discount: it.discount == null ? 0 : it.discount,
      gst_rate_bp: billType === 'gst' ? it.gst_rate_bp : 0,
      warranty_months:
        it.warranty_months == null ? (v ? v.customer_warranty_months : 0) : it.warranty_months,
      fitting_for: it.fitting_for == null ? null : it.fitting_for,
      fitting_merged: Boolean(it.fitting_merged),
      fitted_by: str(it.fitted_by) || null,
      serial_rows: [],
    };
    if (!v || v.is_deleted || v.product_deleted) {
      errors[f('variant_id')] = 'Product not found (it may have been removed).';
      return line;
    }
    if (!v.is_active || !v.product_active)
      errors[f('variant_id')] = `"${v.product_name}" is inactive.`;
    if (!Number.isSafeInteger(line.qty_milli) || line.qty_milli <= 0 || line.qty_milli > MAX_QTY)
      errors[f('qty_milli')] = 'Enter the quantity.';
    if (!Number.isSafeInteger(line.rate) || line.rate < 0 || line.rate > MAX_RATE)
      errors[f('rate')] = 'Enter the rate.';
    if (
      line.discount_bp != null &&
      (!Number.isInteger(line.discount_bp) || line.discount_bp < 0 || line.discount_bp > 10000)
    )
      errors[f('discount')] = 'Discount must be 0–100%.';
    if (!Number.isSafeInteger(line.discount) || line.discount < 0)
      errors[f('discount')] = 'Invalid discount.';
    else if (
      line.discount_bp == null &&
      Number.isSafeInteger(line.qty_milli) &&
      Number.isSafeInteger(line.rate) &&
      line.discount > billing.divRound(line.qty_milli * line.rate, 1000)
    )
      errors[f('discount')] = 'Discount is more than the amount.';
    if (billType === 'gst' && !rateOk(line.gst_rate_bp))
      errors[f('gst_rate_bp')] = 'Choose a GST rate from the list.';
    if (
      !Number.isInteger(line.warranty_months) ||
      line.warranty_months < 0 ||
      line.warranty_months > 240
    )
      errors[f('warranty_months')] = 'Warranty: 0–240 months.';
    if (line.item_type === 'service') line.warranty_months = 0;
    if (line.fitted_by && line.fitted_by.length > 60) errors[f('fitted_by')] = 'Too long (max 60).';

    if (line.item_type === 'goods' && v.track_serials) {
      if (Number.isSafeInteger(line.qty_milli) && line.qty_milli % 1000 !== 0) {
        errors[f('qty_milli')] = 'Serial-numbered items are sold in whole units.';
      } else if (kind === 'bill') {
        const ids = Array.isArray(it.serial_ids) ? [...new Set(it.serial_ids.map(Number))] : [];
        if (ids.length * 1000 !== line.qty_milli) {
          errors[f('serials')] =
            `Pick ${plural(line.qty_milli / 1000, 'serial number')} (${ids.length} picked).`;
        }
        for (const sid of ids) {
          const sr = db.prepare('SELECT * FROM product_serials WHERE id = ?').get(sid);
          if (!sr || sr.variant_id !== v.id) {
            errors[f('serials')] = 'A picked serial number is not of this item.';
          } else if (sr.status !== 'in_stock') {
            errors[f('serials')] =
              `Serial ${sr.serial_no} is not in stock (${serials.STATUS_LABELS[sr.status].toLowerCase()}).`;
          } else if (usedSerials.has(sid)) {
            errors[f('serials')] = `Serial ${sr.serial_no} is on two lines.`;
          } else line.serial_rows.push(sr);
          usedSerials.set(sid, i);
        }
      }
    }
    return line;
  });

  // Fitting lines: a service linked to a product line of this bill.
  items.forEach((l) => {
    if (l.fitting_for == null) return;
    const parent = items[l.fitting_for];
    if (
      !Number.isInteger(l.fitting_for) ||
      !parent ||
      parent === l ||
      parent.item_type !== 'goods'
    ) {
      errors[`items.${l.index}.variant_id`] = 'Fitting line is not linked to a product line.';
    } else if (l.item_type !== 'service') {
      errors[`items.${l.index}.variant_id`] = 'Only a service can be a fitting line.';
    }
  });

  // Stock guard (bills only). Serial items never go negative; others unless allowed.
  if (kind === 'bill') {
    const allowNegative = s.allow_negative_stock === '1';
    const need = new Map();
    for (const l of items) {
      if (
        !l.v ||
        l.item_type !== 'goods' ||
        l.v.track_serials ||
        !Number.isSafeInteger(l.qty_milli)
      )
        continue;
      need.set(l.variant_id, (need.get(l.variant_id) || 0) + l.qty_milli);
    }
    if (!allowNegative) {
      for (const l of items) {
        if (!need.has(l.variant_id)) continue;
        const stock = variantStock(db, l.variant_id);
        if (need.get(l.variant_id) > stock) {
          errors[`items.${l.index}.qty_milli`] =
            `Only ${Math.max(stock, 0) / 1000} ${l.v.unit} of "${l.v.product_name}" in stock.`;
        }
      }
    }
  }

  // Payments (bills): split payments + adjust from advance.
  const pays = [];
  if (kind === 'bill') {
    const raw = Array.isArray(p.payments) ? p.payments.filter((x) => x && x.amount) : [];
    if (raw.length > MAX_PAYMENTS) errors.payments = `At most ${MAX_PAYMENTS} payment rows.`;
    raw.slice(0, MAX_PAYMENTS).forEach((x, i) => {
      const r = payments.validatePayment(x, `payments.${i}`);
      Object.assign(errors, r.errors);
      pays.push(r.data);
    });
  }
  const advance = kind === 'bill' && p.advance_amount ? p.advance_amount : 0;
  if (!Number.isSafeInteger(advance) || advance < 0) errors.advance_amount = 'Invalid amount.';
  const dueDate = p.due_date || null;
  if (dueDate && (!isISODate(dueDate) || (isISODate(date) && dueDate < date))) {
    errors.due_date = 'The due date is before the bill date.';
  }

  fail(errors);

  const { pos, interstate } = placeOfSupply(customer, s);
  const calc = billing.calculateSale({
    bill_type: billType,
    price_mode: priceMode,
    is_interstate: interstate,
    round_off: p.round_off == null ? null : p.round_off,
    bill_discount_bp: billDiscountBp,
    bill_discount: billDiscount,
    items,
  });
  const totals = calc.totals;
  if (totals.grand_total < 0) fail({ round_off: 'The total cannot be negative.' });

  // Back-dated / future bills need a confirmation.
  if (!p.confirm_date && (date > today || date < addDays(today, -BACKDATE_WARN_DAYS))) {
    throw new AppError(
      date > today
        ? `The bill date ${date} is in the future. Save anyway?`
        : `The bill date ${date} is more than ${BACKDATE_WARN_DAYS} days ago. Save anyway?`,
      'DATE_CONFIRM',
      { date: date > today ? 'Future date.' : 'Back-dated.' },
    );
  }

  let paidNow = 0;
  let due = 0;
  if (kind === 'bill') {
    const credit = opts.exchange_credit || 0;
    paidNow = pays.reduce((sum, x) => sum + x.amount, 0);
    const available = Math.max(-balanceOf(db, customer.id), 0);
    if (advance > available)
      fail({ advance_amount: `Only ${money(available)} advance is available.` });
    const covered = Math.min(credit, totals.grand_total);
    if (paidNow + advance + covered > totals.grand_total) {
      fail({
        payments: `Payments (${money(paidNow + advance + covered)}) are more than the bill total (${money(totals.grand_total)}).`,
      });
    }
    due = totals.grand_total - paidNow - advance - covered;
    if (due > 0 && customer.is_system) {
      fail({
        payments: `${money(due)} is unpaid. Credit needs a named customer: choose or add the customer, or take full payment.`,
      });
    }
    if (due > 0 && customer.credit_limit != null && !p.confirm_credit) {
      const after = balanceOf(db, customer.id) + due;
      if (after > customer.credit_limit) {
        throw new AppError(
          `${customer.name} will owe ${money(after)}, over the credit limit of ${money(customer.credit_limit)}. Allow this credit?`,
          'CREDIT_LIMIT',
          { payments: 'Over the credit limit.' },
        );
      }
    }
  }

  return {
    kind,
    customer,
    vehicle,
    header: {
      date,
      bill_type: billType,
      bill_title: billTitle(billType, s),
      price_mode: priceMode,
      party_id: customer.id,
      customer_name:
        str(p.customer_name) && customer.is_system
          ? str(p.customer_name).slice(0, 120)
          : customer.name,
      customer_phone:
        customer.phone || (customer.is_system ? str(p.customer_phone).slice(0, 20) || null : null),
      customer_address:
        [customer.address, customer.city, customer.pincode].filter(Boolean).join(', ') || null,
      customer_gstin: customer.gstin || null,
      customer_state_code: customer.state_code || null,
      place_of_supply_code: pos,
      is_interstate: interstate ? 1 : 0,
      vehicle_id: vehicle ? vehicle.id : null,
      vehicle_no: vehicle ? vehicle.display : null,
      vehicle_no_key: vehicle ? vehicle.plate_no : null,
      vehicle_model: vehicle ? vehicle.model_name : null,
      sub_total: totals.sub_total,
      item_discount_total: totals.item_discount_total,
      bill_discount_bp: billDiscountBp,
      bill_discount: totals.bill_discount,
      taxable_total: totals.taxable_total,
      cgst_total: totals.cgst_total,
      sgst_total: totals.sgst_total,
      igst_total: totals.igst_total,
      tax_total: totals.tax_total,
      round_off: totals.round_off,
      grand_total: totals.grand_total,
      goods_total: totals.goods_total,
      services_total: totals.services_total,
      due_date:
        kind === 'bill' && due > 0
          ? dueDate ||
            (customer.payment_terms_days != null
              ? addDays(date, customer.payment_terms_days)
              : null)
          : null,
      valid_till: validTill,
      notes: notes || null,
    },
    items: calc.items.map((c, i) => ({ ...items[i], ...c })),
    totals,
    tax_summary: calc.tax_summary,
    payments: pays,
    advance,
    paid_now: paidNow,
    due,
  };
}

// ---------------------------------------------------------------- save

const INSERT_ITEM = `INSERT INTO sale_items (sale_id, product_id, variant_id, item_type, product_name,
    variant_label, sku, unit, hsn_code, qty_milli, rate, mrp, discount_bp, discount,
    bill_discount_share, gst_rate_bp, taxable, cgst, sgst, igst, line_total, unit_cost,
    warranty_months, warranty_start, warranty_end, fitting_merged, fitted_by, sort_order)
  VALUES (@sale_id, @product_id, @variant_id, @item_type, @product_name, @variant_label, @sku, @unit,
    @hsn_code, @qty_milli, @rate, @mrp, @discount_bp, @discount, @bill_discount_share, @gst_rate_bp,
    @taxable, @cgst, @sgst, @igst, @line_total, @unit_cost, @warranty_months, @warranty_start,
    @warranty_end, @fitting_merged, @fitted_by, @sort_order)`;

/** Writes lines, stock movements and serials of a new sale. Returns the cost total (COGS). */
function applyLines(db, sale, items) {
  const ins = db.prepare(INSERT_ITEM);
  const ids = [];
  let costTotal = 0;
  items.forEach((l, i) => {
    const v = l.v;
    const goods = l.item_type === 'goods';
    const unitCost = goods ? v.avg_cost || v.purchase_price || 0 : 0;
    const wStart = goods && l.warranty_months > 0 ? sale.invoice_date : null;
    const itemId = Number(
      ins.run({
        sale_id: sale.id,
        product_id: v.product_id,
        variant_id: v.id,
        item_type: l.item_type,
        product_name: v.product_name,
        variant_label: variantLabel(v) || null,
        sku: v.sku,
        unit: v.unit,
        hsn_code: v.hsn_code || null,
        qty_milli: l.qty_milli,
        rate: l.rate,
        mrp: v.mrp,
        discount_bp: l.discount_bp,
        discount: l.discount,
        bill_discount_share: l.bill_discount_share,
        gst_rate_bp: l.gst_rate_bp,
        taxable: l.taxable,
        cgst: l.cgst,
        sgst: l.sgst,
        igst: l.igst,
        line_total: l.line_total,
        unit_cost: unitCost,
        warranty_months: l.warranty_months,
        warranty_start: wStart,
        warranty_end: wStart ? warrantyEnd(wStart, l.warranty_months) : null,
        fitting_merged: l.fitting_merged ? 1 : 0,
        fitted_by: l.fitted_by,
        sort_order: i,
      }).lastInsertRowid,
    );
    ids.push(itemId);
    if (!goods) return;
    costTotal += billing.divRound(l.qty_milli * unitCost, 1000);
    serials.insertMovement(db, {
      variant_id: v.id,
      date: sale.invoice_date,
      type: 'sale',
      qty_milli: -l.qty_milli,
      unit_cost: unitCost,
      ref_type: 'sale_item',
      ref_id: itemId,
      reason: sale.invoice_no,
    });
    if (v.track_serials) {
      let lastEnd = null;
      for (const sr of l.serial_rows) {
        const start =
          v.warranty_start_basis === 'purchase' && sr.purchase_date
            ? sr.purchase_date
            : sale.invoice_date;
        const end = l.warranty_months > 0 ? warrantyEnd(start, l.warranty_months) : null;
        if (end && (!lastEnd || end > lastEnd)) lastEnd = end;
        db.prepare(
          `UPDATE product_serials SET status = 'sold', sale_id = ?, sale_item_id = ?, sale_date = ?,
             customer_party_id = ?, warranty_start = ?, warranty_end = ?, warranty_overridden = 0
           WHERE id = ? AND status = 'in_stock'`,
        ).run(sale.id, itemId, sale.invoice_date, sale.party_id, end ? start : null, end, sr.id);
        db.prepare(
          'INSERT INTO sale_item_serials (sale_item_id, serial_id, warranty_start, warranty_end) VALUES (?, ?, ?, ?)',
        ).run(itemId, sr.id, end ? start : null, end);
        serials.insertEvent(db, sr.id, {
          date: sale.invoice_date,
          type: 'sold',
          from_status: 'in_stock',
          to_status: 'sold',
          ref_type: 'sale',
          ref_id: sale.id,
          note: `${sale.invoice_no} · ${sale.customer_name}${sale.vehicle_no ? ` · ${sale.vehicle_no}` : ''}${end ? ` · warranty till ${end}` : ''}`,
        });
      }
      db.prepare('UPDATE sale_items SET warranty_end = ?, warranty_start = ? WHERE id = ?').run(
        lastEnd,
        lastEnd ? sale.invoice_date : null,
        itemId,
      );
    }
  });
  // Fitting links (parents may come after their fitting line in theory).
  const link = db.prepare('UPDATE sale_items SET fitting_for_item_id = ? WHERE id = ?');
  items.forEach((l, i) => {
    if (l.fitting_for != null) link.run(ids[l.fitting_for], ids[i]);
  });
  return costTotal;
}

function settleAtSale(db, sale, v, ctx, { exchange = null } = {}) {
  for (const pay of v.payments) {
    const row = payments.insertPayment(db, {
      direction: 'in',
      party_id: sale.party_id,
      date: sale.invoice_date,
      amount: pay.amount,
      mode: pay.mode,
      ref_no: pay.ref_no,
      ref_type: 'sale',
      ref_id: sale.id,
      notes: `Received with ${sale.invoice_no}`,
    });
    payments.allocate(db, {
      party_id: sale.party_id,
      doc_type: 'sale',
      doc_id: sale.id,
      source_type: 'payment',
      source_id: row.id,
      amount: pay.amount,
      date: sale.invoice_date,
    });
    audit(db, {
      sale_id: sale.id,
      action: 'payment',
      actor: ctx.actor,
      summary: `Received ${money(pay.amount)} by ${payments.MODE_LABELS[pay.mode]} (${row.payment_no})`,
    });
  }
  if (v.advance > 0) {
    payments.allocate(db, {
      party_id: sale.party_id,
      doc_type: 'sale',
      doc_id: sale.id,
      source_type: 'advance',
      amount: v.advance,
      date: sale.invoice_date,
      note: 'Adjusted from advance',
    });
    audit(db, {
      sale_id: sale.id,
      action: 'payment',
      actor: ctx.actor,
      summary: `Adjusted ${money(v.advance)} from the customer's advance`,
    });
  }
  if (exchange) {
    payments.allocate(db, {
      party_id: sale.party_id,
      doc_type: 'sale',
      doc_id: sale.id,
      source_type: 'sale_return',
      source_id: exchange.return_id,
      amount: Math.min(exchange.credit, sale.grand_total),
      date: sale.invoice_date,
      note: `Exchange credit ${exchange.return_no}`,
    });
  }
}

/**
 * Inside a transaction: saves the validated bill `v`. extra = { exchange: { return_id,
 * return_no, credit } , quotation_id, reissue_of_id, draft_id }.
 */
function insertSale(db, v, ctx = {}, extra = {}) {
  const series = SERIES[v.header.bill_type];
  const num = settings.takeNextNumber(db, series);
  const previous = balanceOf(db, v.header.party_id);
  const { valid_till: _validTill, ...h } = v.header;
  void _validTill;
  const saleId = Number(
    db
      .prepare(
        `INSERT INTO sales (invoice_no, series, seq_no, invoice_date, bill_type, price_mode, bill_title,
           party_id, customer_name, customer_phone, customer_address, customer_gstin,
           customer_state_code, place_of_supply_code, is_interstate, vehicle_id, vehicle_no,
           vehicle_no_key, vehicle_model, sub_total, item_discount_total, bill_discount_bp,
           bill_discount, taxable_total, cgst_total, sgst_total, igst_total, tax_total, round_off,
           grand_total, goods_total, services_total, previous_balance, due_date, quotation_id,
           reissue_of_id, notes)
         VALUES (@invoice_no, @series, @seq_no, @date, @bill_type, @price_mode, @bill_title,
           @party_id, @customer_name, @customer_phone, @customer_address, @customer_gstin,
           @customer_state_code, @place_of_supply_code, @is_interstate, @vehicle_id, @vehicle_no,
           @vehicle_no_key, @vehicle_model, @sub_total, @item_discount_total, @bill_discount_bp,
           @bill_discount, @taxable_total, @cgst_total, @sgst_total, @igst_total, @tax_total,
           @round_off, @grand_total, @goods_total, @services_total, @previous_balance, @due_date,
           @quotation_id, @reissue_of_id, @notes)`,
      )
      .run({
        ...h,
        invoice_no: num.number,
        series,
        seq_no: num.seq_no,
        previous_balance: previous,
        quotation_id: extra.quotation_id ?? null,
        reissue_of_id: extra.reissue_of_id ?? null,
      }).lastInsertRowid,
  );
  const sale = {
    ...h,
    id: saleId,
    invoice_no: num.number,
    invoice_date: h.date,
  };
  const cost = applyLines(db, sale, v.items);
  db.prepare('UPDATE sales SET cost_total = ? WHERE id = ?').run(cost, saleId);
  settleAtSale(db, sale, v, ctx, { exchange: extra.exchange || null });

  const fittings = v.items.filter((l) => l.item_type === 'service').length;
  audit(db, {
    sale_id: saleId,
    action: 'created',
    actor: ctx.actor,
    summary: `Billed ${num.number} to ${h.customer_name}: ${plural(v.items.length, 'line')}${
      fittings ? ` (${fittings} fitting/labour)` : ''
    }, ${money(h.grand_total)}${v.due > 0 ? `, ${money(v.due)} on credit` : ''}`,
    details: v.paid_now || v.advance ? { paid: v.paid_now, advance: v.advance, due: v.due } : null,
  });

  if (extra.quotation_id) {
    const res = db
      .prepare(
        "UPDATE quotations SET status = 'converted', converted_sale_id = ? WHERE id = ? AND status = 'open' AND is_deleted = 0",
      )
      .run(saleId, extra.quotation_id);
    if (res.changes === 0) throw new AppError('This quotation was already converted or cancelled.');
    audit(db, {
      sale_id: saleId,
      quotation_id: extra.quotation_id,
      action: 'quotation_converted',
      actor: ctx.actor,
      summary: `Converted to ${num.number}`,
    });
  }
  if (extra.reissue_of_id) {
    const old = db
      .prepare('SELECT status, invoice_no FROM sales WHERE id = ?')
      .get(extra.reissue_of_id);
    if (!old || old.status !== 'cancelled') {
      throw new AppError('A bill can only be re-issued after it is cancelled.');
    }
  }
  if (Number.isInteger(extra.draft_id)) {
    db.prepare(
      "UPDATE sale_drafts SET status = 'saved', sale_id = ? WHERE id = ? AND status = 'open'",
    ).run(saleId, extra.draft_id);
  }
  return saleId;
}

/** Saves a new bill. Returns the saved bill (sales:get shape). */
function create(db, payload, ctx = {}) {
  const p = payload || {};
  const saleId = db.transaction(() => {
    const v = validate(db, p, { kind: 'bill' });
    const saleId = insertSale(db, v, ctx, {
      quotation_id: Number.isInteger(p.quotation_id) ? p.quotation_id : null,
      reissue_of_id: Number.isInteger(p.reissue_of_id) ? p.reissue_of_id : null,
      draft_id: p.draft_id,
    });
    // A chargeable warranty repair billed from its claim.
    if (Number.isInteger(p.claim_id)) require('./claims').linkBill(db, p.claim_id, saleId, ctx);
    return saleId;
  })();
  return get(db, saleId);
}

// ---------------------------------------------------------------- reading one

function saleRow(db, saleId) {
  const row = db.prepare('SELECT * FROM sales WHERE id = ? AND is_deleted = 0').get(saleId);
  if (!row) throw new AppError('Bill not found.', 'NOT_FOUND');
  return row;
}

function itemsOf(db, saleId) {
  return db
    .prepare('SELECT * FROM sale_items WHERE sale_id = ? ORDER BY sort_order, id')
    .all(saleId);
}

function paidOf(db, saleId) {
  return db
    .prepare(
      "SELECT COALESCE(SUM(amount), 0) FROM bill_allocations WHERE doc_type = 'sale' AND doc_id = ? AND status = 'active'",
    )
    .pluck()
    .get(saleId);
}

/** Quantity of a sale line already credited on active credit notes. */
function returnedQty(db, saleItemId) {
  return db
    .prepare(
      `SELECT COALESCE(SUM(ri.qty_milli), 0) FROM sale_return_items ri
       JOIN sale_returns r ON r.id = ri.sale_return_id
       WHERE ri.sale_item_id = ? AND r.status = 'active' AND r.is_deleted = 0`,
    )
    .pluck()
    .get(saleItemId);
}

function payStatus(sale, paid) {
  if (sale.status !== 'active') return 'cancelled';
  const due = sale.grand_total - paid;
  if (due <= 0) return 'paid';
  if (sale.due_date && sale.due_date < todayISO()) return 'overdue';
  return paid > 0 ? 'partial' : 'unpaid';
}

/** Why a bill cannot be cancelled (user-facing), or [] */
function cancelCheck(db, sale) {
  const reasons = [];
  if (sale.status !== 'active') reasons.push('This bill is already cancelled.');
  const returns = db
    .prepare(
      "SELECT return_no FROM sale_returns WHERE sale_id = ? AND status = 'active' AND is_deleted = 0",
    )
    .pluck()
    .all(sale.id);
  if (returns.length) {
    reasons.push(`It has a return (${returns.join(', ')}). Return the remaining items instead.`);
  }
  const exchange = db
    .prepare(
      "SELECT return_no FROM sale_returns WHERE exchange_sale_id = ? AND status = 'active' AND is_deleted = 0",
    )
    .pluck()
    .get(sale.id);
  if (exchange)
    reasons.push(`It is the new bill of exchange ${exchange}. Return its items instead.`);
  const moved = db
    .prepare(
      `SELECT ps.serial_no, ps.status FROM sale_item_serials x
       JOIN sale_items si ON si.id = x.sale_item_id JOIN product_serials ps ON ps.id = x.serial_id
       WHERE si.sale_id = ? AND x.status = 'sold' AND (ps.status <> 'sold' OR ps.sale_item_id <> x.sale_item_id)
       LIMIT 3`,
    )
    .all(sale.id);
  for (const s of moved) {
    reasons.push(`Serial ${s.serial_no} is now ${serials.STATUS_LABELS[s.status].toLowerCase()}.`);
  }
  const claims = db
    .prepare(
      "SELECT claim_no FROM warranty_claims WHERE sale_id = ? AND is_deleted = 0 AND status NOT IN ('closed','cancelled') LIMIT 3",
    )
    .pluck()
    .all(sale.id);
  if (claims.length) reasons.push(`Warranty claim ${claims.join(', ')} is open.`);
  return reasons;
}

function get(db, saleId) {
  const sale = saleRow(db, saleId);
  const today = todayISO();
  const units = db.prepare(
    `SELECT x.id AS link_id, x.status AS link_status, x.warranty_start, x.warranty_end,
       x.is_replacement, wc.claim_no AS replacement_claim_no, ps.id, ps.serial_no, ps.serial_no_2,
       ps.status, ps.replaced_by_serial_id, rb.serial_no AS replaced_by_serial_no
     FROM sale_item_serials x JOIN product_serials ps ON ps.id = x.serial_id
     LEFT JOIN warranty_claims wc ON wc.id = x.claim_id
     LEFT JOIN product_serials rb ON rb.id = ps.replaced_by_serial_id
     WHERE x.sale_item_id = ? ORDER BY x.id`,
  );
  const items = itemsOf(db, sale.id).map((it) => ({
    ...it,
    returned_milli: returnedQty(db, it.id),
    warranty: warrantyStatus(it.warranty_end, today),
    serials: units.all(it.id).map((u) => ({
      ...u,
      status_label: serials.STATUS_LABELS[u.status],
      warranty: warrantyStatus(
        u.link_status === 'sold' && !u.replaced_by_serial_id ? u.warranty_end : null,
        today,
      ),
    })),
    claims: db
      .prepare(
        'SELECT id, claim_no, status, outcome FROM warranty_claims WHERE sale_item_id = ? AND is_deleted = 0 ORDER BY id',
      )
      .all(it.id),
  }));
  const summary = new Map();
  for (const x of items) {
    const r = summary.get(x.gst_rate_bp) || {
      gst_rate_bp: x.gst_rate_bp,
      taxable: 0,
      cgst: 0,
      sgst: 0,
      igst: 0,
    };
    r.taxable += x.taxable;
    r.cgst += x.cgst;
    r.sgst += x.sgst;
    r.igst += x.igst;
    summary.set(x.gst_rate_bp, r);
  }
  const allocations = db
    .prepare(
      `SELECT a.id, a.source_type, a.source_id, a.amount, a.date, a.status, a.note,
         pm.payment_no, pm.mode, pm.ref_no, sr.return_no
       FROM bill_allocations a
       LEFT JOIN payments pm ON a.source_type = 'payment' AND pm.id = a.source_id
       LEFT JOIN sale_returns sr ON a.source_type = 'sale_return' AND sr.id = a.source_id
       WHERE a.doc_type = 'sale' AND a.doc_id = ? ORDER BY a.id`,
    )
    .all(sale.id);
  const refunds = db
    .prepare(
      `SELECT id, payment_no, date, amount, mode, ref_no, status FROM payments
       WHERE ref_type = 'sale' AND ref_id = ? AND direction = 'out' ORDER BY id`,
    )
    .all(sale.id);
  const returns = db
    .prepare(
      `SELECT id, return_no, date, total, status, settlement FROM sale_returns
       WHERE (sale_id = ? OR exchange_sale_id = ?) AND is_deleted = 0 ORDER BY id`,
    )
    .all(sale.id, sale.id)
    .map((r) => ({ ...r, is_exchange_credit: r.settlement === 'exchange' }));
  const auditRows = db
    .prepare('SELECT * FROM sale_audit WHERE sale_id = ? ORDER BY id DESC')
    .all(sale.id)
    .map((a) => ({ ...a, details: a.details ? JSON.parse(a.details) : null }));
  const reissued = db
    .prepare('SELECT id, invoice_no FROM sales WHERE reissue_of_id = ? AND is_deleted = 0')
    .get(sale.id);
  const reissueOf = sale.reissue_of_id
    ? db.prepare('SELECT id, invoice_no FROM sales WHERE id = ?').get(sale.reissue_of_id)
    : null;
  const quotation = sale.quotation_id
    ? db.prepare('SELECT id, quote_no FROM quotations WHERE id = ?').get(sale.quotation_id)
    : null;
  const customer = db
    .prepare('SELECT id, name, phone, is_system, credit_limit FROM parties WHERE id = ?')
    .get(sale.party_id);
  const paid = sale.status === 'active' ? paidOf(db, sale.id) : 0;
  const reasons = cancelCheck(db, sale);
  return {
    ...sale,
    customer: customer ? { ...customer, phone_display: id.formatPhone(customer.phone) } : null,
    items,
    tax_summary: [...summary.values()].sort((a, b) => a.gst_rate_bp - b.gst_rate_bp),
    allocations,
    refunds,
    returns,
    audit: auditRows,
    reissued_as: reissued || null,
    reissue_of: reissueOf || null,
    quotation: quotation || null,
    paid,
    due: sale.status === 'active' ? sale.grand_total - paid : 0,
    pay_status: payStatus(sale, paid),
    can_cancel: reasons.length === 0,
    lock_reasons: reasons,
    can_return: sale.status === 'active',
    amount_in_words: amountInWords(sale.grand_total),
  };
}

// ---------------------------------------------------------------- cancel

/**
 * Cancels a bill: stock comes back at the original cost, serials back to stock (warranty
 * voided), the bill leaves the ledger. Money received stays with the customer as an advance,
 * unless `refund` records that it was given back. Cash Customer is always refunded.
 */
function cancel(db, { id: saleId, reason, refund = null }, ctx = {}) {
  const why = str(reason);
  if (!why) fail({ reason: 'A reason is required.' });
  if (why.length > 200) fail({ reason: 'Reason is too long (max 200).' });
  db.transaction(() => {
    const sale = saleRow(db, saleId);
    const reasons = cancelCheck(db, sale);
    if (reasons.length)
      throw new AppError(`This bill cannot be cancelled: ${reasons[0]}`, 'LOCKED');
    const customer = db.prepare('SELECT * FROM parties WHERE id = ?').get(sale.party_id);
    const received = db
      .prepare(
        `SELECT COALESCE(SUM(amount), 0) FROM bill_allocations
         WHERE doc_type = 'sale' AND doc_id = ? AND status = 'active' AND source_type = 'payment'`,
      )
      .pluck()
      .get(sale.id);
    let refundRow = null;
    if (refund && refund.amount) {
      const r = payments.validatePayment(refund, 'refund');
      fail(r.errors);
      if (r.data.amount > received) {
        fail({ 'refund.amount': `Only ${money(received)} was received against this bill.` });
      }
      refundRow = r.data;
    }
    if (customer.is_system && received > 0 && (!refundRow || refundRow.amount !== received)) {
      fail({
        'refund.amount': `Cash Customer cannot keep an advance: record the refund of ${money(received)}.`,
      });
    }

    const setAvg = db.prepare('UPDATE product_variants SET avg_cost = ? WHERE id = ?');
    for (const it of itemsOf(db, sale.id)) {
      if (it.item_type !== 'goods') continue;
      const v = loadVariantInfo(db, it.variant_id);
      const before = { stock_milli: variantStock(db, v.id), avg_cost: v.avg_cost };
      serials.insertMovement(db, {
        variant_id: v.id,
        date: todayISO(),
        type: 'sale',
        qty_milli: it.qty_milli,
        unit_cost: it.unit_cost,
        ref_type: 'sale_item',
        ref_id: it.id,
        reason: `${sale.invoice_no}: cancelled`,
      });
      setAvg.run(
        billing.averageIn(
          before,
          it.qty_milli,
          billing.divRound(it.unit_cost * it.qty_milli, 1000),
        ),
        v.id,
      );
      const links = db
        .prepare("SELECT * FROM sale_item_serials WHERE sale_item_id = ? AND status = 'sold'")
        .all(it.id);
      for (const x of links) {
        db.prepare(
          `UPDATE product_serials SET status = 'in_stock', sale_id = NULL, sale_item_id = NULL,
             sale_date = NULL, customer_party_id = NULL, warranty_start = NULL, warranty_end = NULL,
             warranty_overridden = 0 WHERE id = ?`,
        ).run(x.serial_id);
        db.prepare("UPDATE sale_item_serials SET status = 'cancelled' WHERE id = ?").run(x.id);
        serials.insertEvent(db, x.serial_id, {
          type: 'sale_cancelled',
          from_status: 'sold',
          to_status: 'in_stock',
          ref_type: 'sale',
          ref_id: sale.id,
          note: `${sale.invoice_no} cancelled: ${why} (warranty voided)`,
        });
      }
    }
    db.prepare(
      `UPDATE sales SET status = 'cancelled', cancel_reason = ?,
         cancelled_at = strftime('%Y-%m-%d %H:%M:%S','now','localtime') WHERE id = ?`,
    ).run(why, sale.id);
    payments.releaseAllocations(db, { doc_type: 'sale', doc_id: sale.id });
    // A cancelled repair bill: its warranty claim can be billed again.
    for (const claim of db
      .prepare('SELECT * FROM warranty_claims WHERE bill_sale_id = ? AND is_deleted = 0')
      .all(sale.id)) {
      const claims = require('./claims');
      db.prepare('UPDATE warranty_claims SET bill_sale_id = NULL WHERE id = ?').run(claim.id);
      claims.event(db, claim, { type: 'note', note: `Bill ${sale.invoice_no} cancelled` }, ctx);
    }
    audit(db, {
      sale_id: sale.id,
      action: 'cancelled',
      actor: ctx.actor,
      summary: `Cancelled: ${why}${received && !refundRow ? `. ${money(received)} received stays as customer advance` : ''}`,
    });
    if (refundRow) {
      const pay = payments.insertPayment(db, {
        direction: 'out',
        party_id: sale.party_id,
        date: todayISO(),
        amount: refundRow.amount,
        mode: refundRow.mode,
        ref_no: refundRow.ref_no,
        ref_type: 'sale',
        ref_id: sale.id,
        notes: `Refund for cancelled ${sale.invoice_no}`,
      });
      audit(db, {
        sale_id: sale.id,
        action: 'refund',
        actor: ctx.actor,
        summary: `Refund given ${money(refundRow.amount)} by ${payments.MODE_LABELS[refundRow.mode]} (${pay.payment_no})`,
      });
    }
  })();
  return get(db, saleId);
}

// ---------------------------------------------------------------- payments after saving

/** Receive (or adjust from advance) against a saved bill. mode 'advance' = no money moves. */
function recordPayment(db, { id: saleId, amount, mode, ref_no: refNo, date }, ctx = {}) {
  db.transaction(() => {
    const sale = saleRow(db, saleId);
    if (sale.status !== 'active') throw new AppError('This bill is cancelled.');
    const due = sale.grand_total - paidOf(db, sale.id);
    const day = date || todayISO();
    if (!isISODate(day)) fail({ date: 'Invalid date.' });
    if (!Number.isSafeInteger(amount) || amount <= 0) fail({ amount: 'Enter the amount.' });
    if (amount > due) fail({ amount: `Only ${money(due)} is due on this bill.` });
    const s = { ...sale, invoice_date: day };
    if (mode === 'advance') {
      const available = Math.max(-balanceOf(db, sale.party_id), 0);
      if (amount > available) fail({ amount: `Only ${money(available)} advance is available.` });
      settleAtSale(db, s, { payments: [], advance: amount }, ctx);
      return;
    }
    const r = payments.validatePayment({ amount, mode, ref_no: refNo }, 'payment');
    fail(
      Object.fromEntries(
        Object.entries(r.errors).map(([k, val]) => [k.replace('payment.', ''), val]),
      ),
    );
    settleAtSale(db, s, { payments: [r.data], advance: 0 }, ctx);
  })();
  return get(db, saleId);
}

// ---------------------------------------------------------------- prefill (re-issue / quotation)

/**
 * Lines for a new bill from a cancelled bill ("cancel & re-issue": same rates and serials) or a
 * quotation (current stock / prices are re-checked; serials must be picked). Problems per line.
 */
function prefill(db, { sale_id: saleId = null, quotation_id: quotationId = null }) {
  let src;
  let srcItems;
  let serialMap = new Map();
  if (Number.isInteger(saleId)) {
    src = saleRow(db, saleId);
    srcItems = itemsOf(db, src.id);
    for (const it of srcItems) {
      serialMap.set(
        it.id,
        db
          .prepare(
            `SELECT ps.id, ps.serial_no, ps.status FROM sale_item_serials x
             JOIN product_serials ps ON ps.id = x.serial_id WHERE x.sale_item_id = ?`,
          )
          .all(it.id),
      );
    }
  } else if (Number.isInteger(quotationId)) {
    src = db.prepare('SELECT * FROM quotations WHERE id = ? AND is_deleted = 0').get(quotationId);
    if (!src) throw new AppError('Quotation not found.', 'NOT_FOUND');
    if (src.status !== 'open')
      throw new AppError('This quotation was already converted or cancelled.');
    srcItems = db
      .prepare('SELECT * FROM quotation_items WHERE quotation_id = ? ORDER BY sort_order, id')
      .all(src.id);
  } else throw new AppError('Nothing to copy.', 'VALIDATION');

  const s = settings.getSettings(db);
  const indexOf = new Map(srcItems.map((it, i) => [it.id, i]));
  const lines = srcItems.map((it) => {
    const v = loadVariantInfo(db, it.variant_id);
    const issues = [];
    if (!v || v.is_deleted || v.product_deleted) issues.push('This product was removed.');
    else if (!v.is_active || !v.product_active) issues.push(`"${v.product_name}" is now inactive.`);
    const stock = v ? variantStock(db, v.id) : 0;
    let serialIds = [];
    if (v && it.item_type === 'goods') {
      if (v.track_serials) {
        const old = serialMap.get(it.id) || [];
        serialIds = old.filter((x) => x.status === 'in_stock').map((x) => x.id);
        if (serialIds.length * 1000 !== it.qty_milli) issues.push('Pick the serial numbers.');
      } else if (stock < it.qty_milli && s.allow_negative_stock !== '1') {
        issues.push(`Only ${Math.max(stock, 0) / 1000} ${v.unit} in stock now.`);
      }
      if (quotationId && v.selling_price !== it.rate && it.rate !== 0) {
        issues.push(`Selling price is now ${money(v.selling_price)} (quoted ${money(it.rate)}).`);
      }
    }
    if (it.gst_rate_bp && !settings.isActiveGstRate(db, it.gst_rate_bp)) {
      issues.push(`GST ${it.gst_rate_bp / 100}% was removed from Settings.`);
    }
    return {
      variant_id: it.variant_id,
      product_id: it.product_id,
      item_type: it.item_type,
      name: it.product_name,
      variant_label: it.variant_label || '',
      sku: it.sku,
      hsn_code: it.hsn_code || '',
      unit: it.unit,
      track_serials: Boolean(v && v.track_serials),
      qty_milli: it.qty_milli,
      rate: it.rate,
      mrp: v ? v.mrp : it.mrp,
      selling_price: v ? v.selling_price : it.rate,
      avg_cost: v ? v.avg_cost || v.purchase_price : 0,
      stock_milli: stock,
      discount_bp: it.discount_bp,
      discount: it.discount,
      gst_rate_bp: it.gst_rate_bp,
      warranty_months: it.warranty_months,
      fitting_for:
        it.fitting_for_item_id != null ? (indexOf.get(it.fitting_for_item_id) ?? null) : null,
      fitting_merged: Boolean(it.fitting_merged),
      fitted_by: it.fitted_by || '',
      serials: serialIds.map((sid) => {
        const r = (serialMap.get(it.id) || []).find((x) => x.id === sid);
        return { id: sid, serial_no: r ? r.serial_no : '' };
      }),
      issues,
    };
  });
  const vehicle = src.vehicle_id ? vehicleSnapshot(db, src.vehicle_id) : null;
  return {
    source: saleId
      ? { type: 'sale', id: src.id, no: src.invoice_no }
      : { type: 'quotation', id: src.id, no: src.quote_no },
    party_id: src.party_id,
    customer_name: src.customer_name,
    vehicle_id: vehicle && vehicle.customer_id === src.party_id ? vehicle.id : null,
    bill_type: src.bill_type,
    price_mode: src.price_mode,
    bill_discount_bp: src.bill_discount_bp,
    bill_discount: src.bill_discount_bp == null ? src.bill_discount : 0,
    notes: src.notes || '',
    lines,
  };
}

// ---------------------------------------------------------------- lists & stats

function likeArg(word) {
  return `%${word.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

const PAY_FILTERS = ['paid', 'partial', 'unpaid', 'overdue'];

function list(db, params = {}) {
  const where = ['s.is_deleted = 0'];
  const args = [];
  const status = params.status || 'all';
  if (status === 'active') where.push("s.status = 'active'");
  else if (status === 'cancelled') where.push("s.status = 'cancelled'");
  if (params.from && isISODate(params.from)) {
    where.push('s.invoice_date >= ?');
    args.push(params.from);
  }
  if (params.to && isISODate(params.to)) {
    where.push('s.invoice_date <= ?');
    args.push(params.to);
  }
  if (Number.isInteger(params.party_id)) {
    where.push('s.party_id = ?');
    args.push(params.party_id);
  }
  if (params.bill_type === 'gst' || params.bill_type === 'non_gst') {
    where.push('s.bill_type = ?');
    args.push(params.bill_type);
  }
  if (PAY_FILTERS.includes(params.pay_status)) {
    where.push('d.pay_status = ?');
    args.push(params.pay_status);
  }
  if (params.pay_mode === 'credit') where.push('COALESCE(d.due, 0) > 0');
  else if (payments.MODES.includes(params.pay_mode)) {
    where.push(
      "EXISTS (SELECT 1 FROM payments pm WHERE pm.ref_type = 'sale' AND pm.ref_id = s.id AND pm.direction = 'in' AND pm.mode = ?)",
    );
    args.push(params.pay_mode);
  }
  const tech = str(params.technician);
  if (tech) {
    where.push(
      "EXISTS (SELECT 1 FROM sale_items i WHERE i.sale_id = s.id AND i.fitted_by LIKE ? ESCAPE '\\')",
    );
    args.push(likeArg(tech));
  }
  const q = str(params.search);
  if (q) {
    const like = likeArg(q);
    const plate = id.normalizePlate(q);
    const phone = id.normalizePhone(q);
    const key = serials.serialKey(q);
    where.push(`(s.invoice_no LIKE ? ESCAPE '\\' OR s.customer_name LIKE ? ESCAPE '\\'
      OR (? <> '' AND s.customer_phone LIKE ? ESCAPE '\\')
      OR (? <> '' AND s.vehicle_no_key LIKE ? ESCAPE '\\')
      OR EXISTS (SELECT 1 FROM sale_items i WHERE i.sale_id = s.id
        AND (i.product_name LIKE ? ESCAPE '\\' OR i.sku LIKE ? ESCAPE '\\' OR i.fitted_by LIKE ? ESCAPE '\\'))
      OR EXISTS (SELECT 1 FROM sale_item_serials x JOIN sale_items i ON i.id = x.sale_item_id
        JOIN product_serials ps ON ps.id = x.serial_id WHERE i.sale_id = s.id AND ps.serial_key LIKE ? ESCAPE '\\'))`);
    const phoneDigits = phone.replace(/\D/g, '').length >= 4 ? phone : '';
    const plateKey = plate.length >= 3 ? plate : '';
    args.push(
      like,
      like,
      phoneDigits,
      likeArg(phoneDigits),
      plateKey,
      likeArg(plateKey),
      like,
      like,
      like,
      likeArg(key),
    );
  }
  const rows = db
    .prepare(
      `SELECT s.id, s.invoice_no, s.invoice_date, s.bill_type, s.party_id, s.customer_name,
         s.customer_phone, s.vehicle_no, s.vehicle_model, s.grand_total, s.status, s.cancel_reason,
         s.due_date, s.services_total,
         (SELECT COUNT(*) FROM sale_items i WHERE i.sale_id = s.id) AS item_count,
         (SELECT COUNT(*) FROM sale_returns r WHERE r.sale_id = s.id AND r.status = 'active') AS return_count,
         COALESCE(d.paid, 0) AS paid, COALESCE(d.due, 0) AS due,
         COALESCE(d.pay_status, 'cancelled') AS pay_status
       FROM sales s LEFT JOIN v_sale_dues d ON d.sale_id = s.id
       WHERE ${where.join(' AND ')}
       ORDER BY s.invoice_date DESC, s.id DESC LIMIT 5000`,
    )
    .all(...args)
    .map((r) => ({ ...r, customer_phone_display: id.formatPhone(r.customer_phone) }));
  return { rows, total: rows.length, truncated: rows.length === 5000 };
}

function monthRange(today = todayISO()) {
  const [y, m] = today.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const mm = String(m).padStart(2, '0');
  return [`${y}-${mm}-01`, `${y}-${mm}-${String(last).padStart(2, '0')}`];
}

function stats(db) {
  const today = todayISO();
  const [from, to] = monthRange(today);
  const sum = db.prepare(
    `SELECT COALESCE(SUM(grand_total), 0) AS amount, COUNT(*) AS bills FROM sales
     WHERE status = 'active' AND is_deleted = 0 AND invoice_date BETWEEN ? AND ?`,
  );
  const returns = db.prepare(
    `SELECT COALESCE(SUM(total), 0) FROM sale_returns
     WHERE status = 'active' AND is_deleted = 0 AND date BETWEEN ? AND ?`,
  );
  const day = sum.get(today, today);
  const month = sum.get(from, to);
  const byMode = Object.fromEntries(payments.MODES.map((m) => [m, 0]));
  for (const r of db
    .prepare(
      `SELECT mode, SUM(amount) AS amount FROM payments
       WHERE direction = 'in' AND status = 'active' AND is_deleted = 0 AND date = ? AND party_id IN
         (SELECT id FROM parties WHERE type = 'customer') GROUP BY mode`,
    )
    .all(today)) {
    if (r.mode) byMode[r.mode] = r.amount;
  }
  const credit = db
    .prepare(
      `SELECT COALESCE(SUM(d.due), 0) FROM v_sale_dues d JOIN sales s ON s.id = d.sale_id
       WHERE s.invoice_date = ? AND d.due > 0`,
    )
    .pluck()
    .get(today);
  const receivable = db
    .prepare(
      `SELECT COALESCE(SUM(b.balance), 0) FROM v_party_balance b JOIN parties p ON p.id = b.party_id
       WHERE p.type = 'customer' AND p.is_deleted = 0 AND b.balance > 0`,
    )
    .pluck()
    .get();
  const counts = db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM sale_drafts WHERE status = 'open') AS held,
         (SELECT COUNT(*) FROM quotations WHERE status = 'open' AND is_deleted = 0) AS open_quotations,
         (SELECT COUNT(*) FROM sale_returns WHERE status = 'active' AND is_deleted = 0) AS returns`,
    )
    .get();
  return {
    today,
    today_amount: day.amount - returns.pluck().get(today, today),
    today_bills: day.bills,
    month_amount: month.amount - returns.pluck().get(from, to),
    month_bills: month.bills,
    month_from: from,
    today_by_mode: byMode,
    today_credit: credit,
    receivable,
    ...counts,
  };
}

function recent(db, { limit = 8 } = {}) {
  return db
    .prepare(
      `SELECT s.id, s.invoice_no, s.invoice_date, s.customer_name, s.vehicle_no, s.grand_total,
         s.status, COALESCE(d.pay_status, 'cancelled') AS pay_status, COALESCE(d.due, 0) AS due
       FROM sales s LEFT JOIN v_sale_dues d ON d.sale_id = s.id
       WHERE s.is_deleted = 0 ORDER BY s.id DESC LIMIT ?`,
    )
    .all(Math.min(Number(limit) || 8, 50));
}

/** Marks a print (reprints say DUPLICATE). Returns the copy label for this print. */
function markPrinted(db, saleId, { format, pdf = false }, ctx = {}) {
  return db.transaction(() => {
    const sale = saleRow(db, saleId);
    const duplicate = sale.print_count > 0;
    if (!pdf) db.prepare('UPDATE sales SET print_count = print_count + 1 WHERE id = ?').run(saleId);
    audit(db, {
      sale_id: saleId,
      action: pdf ? 'pdf' : 'printed',
      actor: ctx.actor,
      summary: `${pdf ? 'Saved PDF' : 'Printed'} (${format === 'thermal80' ? 'thermal 80 mm' : 'A4'})${duplicate ? ' · duplicate' : ''}`,
    });
    return duplicate;
  })();
}

module.exports = {
  SERIES,
  BACKDATE_WARN_DAYS,
  meta,
  customerInfo,
  searchItems,
  calculate,
  validate,
  insertSale,
  create,
  get,
  saleRow,
  itemsOf,
  paidOf,
  returnedQty,
  cancel,
  cancelCheck,
  recordPayment,
  prefill,
  list,
  stats,
  recent,
  markPrinted,
  audit,
  money,
  addDays,
  balanceOf,
  cashCustomerId,
  loadVariantInfo,
  placeOfSupply,
  effectiveBillType,
  billTitle,
  customerRow,
  vehicleSnapshot,
};
