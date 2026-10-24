'use strict';

// Purchase bills (stock in): validation, live calculation, save, edit (reverse + re-apply),
// cancel, payments and the read side (list, detail, stats). No electron imports.
// Every write runs in ONE transaction: purchase, lines, charges, stock movements, serials,
// average cost, payment, allocations, price updates and the audit row.

const { AppError } = require('../errors');
const { isISODate, todayISO, str } = require('./parse');
const settings = require('./settings');
const serials = require('./serials');
const payments = require('./payments');
const { variantLabel, variantStock } = require('./products');
const { warrantyEnd } = require('./warranty');
const billing = require('./billing');
const { normaliseSerialInput } = require('../validation/products');

const MAX_LINES = 500;
const MAX_CHARGES = 10;
const MAX_QTY = 1e9; // milli-units
const MAX_RATE = 1e11; // paise
const CHARGE_KINDS = { freight: 'Transport / freight', packing: 'Packing', other: 'Other' };
// Serial statuses that block editing / cancelling a purchase (the unit has left our hands).
const LOCKED_SERIAL = ['sold', 'under_claim', 'replaced', 'returned_to_supplier', 'written_off'];

// ---------------------------------------------------------------- small helpers

function billNoKey(billNo) {
  const k = str(billNo).toUpperCase().replace(/\s+/g, '');
  return k || null;
}

function addDays(iso, days) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

function fail(errors, fallback = 'Please check the bill.') {
  const keys = Object.keys(errors);
  if (keys.length) {
    throw new AppError(`Please check: ${errors[keys[0]] || fallback}`, 'VALIDATION', errors);
  }
}

function settingsMap(db) {
  return settings.getSettings(db);
}

function supplierRow(db, partyId) {
  const p = db.prepare('SELECT * FROM parties WHERE id = ?').get(partyId);
  if (!p || p.is_deleted) throw new AppError('Supplier not found.', 'NOT_FOUND');
  if (p.type !== 'supplier')
    throw new AppError('Choose a supplier (not a customer).', 'VALIDATION');
  return p;
}

/** CGST+SGST when the supplier is in our state (or either state is unknown), else IGST. */
function placeOfSupply(supplier, s) {
  const business = s.business_state_code || '';
  const pos = (supplier && supplier.state_code) || business;
  return { pos, interstate: Boolean(business && pos && pos !== business) };
}

function audit(db, { purchase_id, purchase_return_id = null, action, actor, summary, details }) {
  db.prepare(
    `INSERT INTO purchase_audit (purchase_id, purchase_return_id, action, actor, summary, details)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    purchase_id ?? null,
    purchase_return_id,
    action,
    actor || 'This computer',
    summary,
    details ? JSON.stringify(details) : null,
  );
}

function money(paise) {
  const neg = paise < 0;
  const a = Math.abs(paise);
  return `${neg ? '-' : ''}₹${((a - (a % 100)) / 100).toLocaleString('en-IN')}.${String(a % 100).padStart(2, '0')}`;
}

function loadVariantInfo(db, variantId) {
  return db
    .prepare(
      `SELECT v.*, p.name AS product_name, p.product_type, p.unit, p.hsn_code, p.track_serials,
         p.supplier_warranty_months, p.is_active AS product_active, p.is_deleted AS product_deleted
       FROM product_variants v JOIN products p ON p.id = v.product_id WHERE v.id = ?`,
    )
    .get(variantId);
}

// ---------------------------------------------------------------- meta & calculation

function meta(db) {
  const s = settingsMap(db);
  const seq = db
    .prepare("SELECT prefix, next_value, pad_width FROM sequences WHERE name = 'purchase'")
    .get();
  return {
    business_state_code: s.business_state_code || '',
    composition_dealer: s.composition_dealer === '1',
    default_bill_type: s.default_bill_type || 'gst',
    default_price_mode: s.purchase_price_mode || 'exclusive',
    default_charges_mode: s.purchase_charges_mode || 'cost',
    gst_rates: settings.listGstRates(db),
    next_entry_no: `${seq.prefix}${String(seq.next_value).padStart(seq.pad_width, '0')}`,
    charge_kinds: CHARGE_KINDS,
    payment_modes: payments.MODE_LABELS,
    max_round_off: billing.MAX_ROUND_OFF,
  };
}

const int = (v, fallback = 0) => (Number.isSafeInteger(v) ? v : fallback);

/** Live totals for the entry screen. Lenient: bad numbers count as 0 (save validates). */
function calculate(db, payload = {}) {
  const s = settingsMap(db);
  const supplier = Number.isInteger(payload.party_id)
    ? db.prepare('SELECT state_code FROM parties WHERE id = ?').get(payload.party_id)
    : null;
  const { interstate } = placeOfSupply(supplier, s);
  const items = (payload.items || []).map((it) => ({
    qty_milli: Math.max(int(it.qty_milli), 0),
    free_qty_milli: Math.max(int(it.free_qty_milli), 0),
    rate: Math.max(int(it.rate), 0),
    discount_bp: it.discount_bp == null ? null : Math.min(Math.max(int(it.discount_bp), 0), 10000),
    discount: Math.max(int(it.discount), 0),
    gst_rate_bp: Math.max(int(it.gst_rate_bp), 0),
  }));
  // Lines with no quantity yet cannot carry cost; keep them out of the spread.
  const usable = items.map((it) => (it.qty_milli + it.free_qty_milli > 0 ? it : null));
  const calc = billing.calculatePurchase({
    bill_type: payload.bill_type === 'non_gst' ? 'non_gst' : 'gst',
    price_mode: payload.price_mode === 'inclusive' ? 'inclusive' : 'exclusive',
    is_interstate: interstate,
    charges_mode: payload.charges_mode === 'expense' ? 'expense' : 'cost',
    gst_in_cost: s.composition_dealer === '1',
    round_off:
      payload.round_off == null ? null : Math.max(Math.min(int(payload.round_off), 500), -500),
    items: usable.filter(Boolean),
    charges: (payload.charges || [])
      .map((c) => ({ ...c, amount: Math.max(int(c.amount), 0), gst_rate_bp: int(c.gst_rate_bp) }))
      .filter((c) => c.amount > 0),
  });
  let k = 0;
  const lines = usable.map((u) => (u ? calc.items[k++] : null));
  const printed = Number.isSafeInteger(payload.printed_total) ? payload.printed_total : null;
  return {
    is_interstate: interstate,
    lines,
    charges: calc.charges,
    totals: calc.totals,
    tax_summary: calc.tax_summary,
    mismatch: printed == null ? 0 : printed - calc.totals.grand_total,
  };
}

// ---------------------------------------------------------------- validation

/**
 * Validates a purchase payload and resolves products, supplier and settings.
 * `current` = the stored purchase when editing ({ row, items, serialIds }).
 */
function validate(db, payload, current = null) {
  const p = payload || {};
  const errors = {};
  const s = settingsMap(db);

  let supplier = null;
  if (!Number.isInteger(p.party_id)) errors.party_id = 'Choose the supplier.';
  else {
    try {
      supplier = supplierRow(db, p.party_id);
      if (!supplier.is_active && !(current && current.row.party_id === supplier.id)) {
        errors.party_id = 'This supplier is inactive.';
      }
    } catch (e) {
      errors.party_id = e.message;
    }
  }

  const billNo = str(p.bill_no);
  if (billNo.length > 40) errors.bill_no = 'Bill number is too long (max 40).';
  const billDate = p.bill_date;
  const entryDate = p.entry_date || todayISO();
  if (!isISODate(billDate)) errors.bill_date = 'Enter the supplier bill date.';
  if (!isISODate(entryDate)) errors.entry_date = 'Invalid entry date.';
  if (isISODate(billDate) && billDate > addDays(todayISO(), 1)) {
    errors.bill_date = 'The bill date is in the future.';
  }
  const billType = p.bill_type === 'non_gst' ? 'non_gst' : 'gst';
  const priceMode = p.price_mode === 'inclusive' ? 'inclusive' : 'exclusive';
  const chargesMode = p.charges_mode === 'expense' ? 'expense' : 'cost';
  if (p.round_off != null && (!Number.isInteger(p.round_off) || Math.abs(p.round_off) > 500)) {
    errors.round_off = 'Round-off must be within ±₹5.';
  }
  if (p.printed_total != null && (!Number.isSafeInteger(p.printed_total) || p.printed_total < 0)) {
    errors.printed_total = 'Invalid amount.';
  }
  const notes = str(p.notes);
  if (notes.length > 500) errors.notes = 'Notes are too long (max 500).';

  // Lines that were on the bill before an edit may keep a GST rate that has since been removed.
  const oldRates = new Set((current ? current.items : []).map((i) => i.gst_rate_bp));
  const oldVariants = new Set((current ? current.items : []).map((i) => i.variant_id));
  const rateOk = (bp) =>
    Number.isInteger(bp) && (settings.isActiveGstRate(db, bp) || oldRates.has(bp));

  const rawItems = Array.isArray(p.items) ? p.items : [];
  if (rawItems.length === 0) errors.items = 'Add at least one item.';
  if (rawItems.length > MAX_LINES) errors.items = `At most ${MAX_LINES} lines per bill.`;
  const items = rawItems.slice(0, MAX_LINES).map((it, i) => {
    const f = (k) => `items.${i}.${k}`;
    const v = Number.isInteger(it.variant_id) ? loadVariantInfo(db, it.variant_id) : null;
    const line = {
      index: i,
      variant: v,
      variant_id: it.variant_id,
      qty_milli: it.qty_milli,
      free_qty_milli: it.free_qty_milli == null ? 0 : it.free_qty_milli,
      rate: it.rate,
      discount_bp: it.discount_bp == null ? null : it.discount_bp,
      discount: it.discount == null ? 0 : it.discount,
      gst_rate_bp: billType === 'gst' ? it.gst_rate_bp : 0,
      serials: null,
      update_purchase_price: Boolean(it.update_purchase_price),
      new_mrp: it.new_mrp == null ? null : it.new_mrp,
      new_selling_price: it.new_selling_price == null ? null : it.new_selling_price,
    };
    if (!v || v.is_deleted || v.product_deleted) {
      errors[f('variant_id')] = 'Product not found (it may have been removed).';
      return line;
    }
    const known = oldVariants.has(v.id);
    if (!known && (!v.is_active || !v.product_active)) {
      errors[f('variant_id')] = `"${v.product_name}" is inactive.`;
    }
    if (v.product_type === 'service') errors[f('variant_id')] = 'Services cannot be purchased.';
    if (!Number.isSafeInteger(line.qty_milli) || line.qty_milli <= 0 || line.qty_milli > MAX_QTY)
      errors[f('qty_milli')] = 'Enter the quantity.';
    if (
      !Number.isSafeInteger(line.free_qty_milli) ||
      line.free_qty_milli < 0 ||
      line.free_qty_milli > MAX_QTY
    )
      errors[f('free_qty_milli')] = 'Invalid free quantity.';
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

    for (const k of ['new_mrp', 'new_selling_price']) {
      if (line[k] != null && (!Number.isSafeInteger(line[k]) || line[k] < 0 || line[k] > MAX_RATE))
        errors[f(k)] = 'Invalid price.';
    }
    const mrp = line.new_mrp ?? v.mrp;
    const sp = line.new_selling_price ?? v.selling_price;
    if ((line.new_mrp != null || line.new_selling_price != null) && mrp > 0 && sp > mrp) {
      errors[f('new_selling_price')] = 'Selling price cannot be more than MRP.';
    }

    if (v.track_serials) {
      line.serials = normaliseSerialInput(it.serials);
      const units = line.qty_milli + line.free_qty_milli;
      if (Number.isSafeInteger(units) && units % 1000 !== 0) {
        errors[f('qty_milli')] = 'Serial-numbered items are counted in whole units.';
      } else if (Number.isSafeInteger(units) && line.serials.count !== units / 1000) {
        errors[f('serials')] =
          `Enter ${units / 1000} serial number${units === 1000 ? '' : 's'} (qty + free); ${line.serials.count} entered.`;
      }
    }
    return line;
  });

  // The same serial twice on one bill (two lines of one product).
  const seenSerial = new Map();
  items.forEach((l) => {
    if (!l.serials) return;
    l.serials.entries.forEach((e, j) => {
      const key = `${l.variant.product_id}:${serials.serialKey(e.serial_no)}`;
      if (seenSerial.has(key) && seenSerial.get(key) !== l.index) {
        errors[`items.${l.index}.serials`] = `Serial ${e.serial_no} is on two lines of this bill.`;
      }
      seenSerial.set(key, l.index);
      void j;
    });
  });

  const rawCharges = Array.isArray(p.charges) ? p.charges : [];
  if (rawCharges.length > MAX_CHARGES) errors.charges = `At most ${MAX_CHARGES} extra charges.`;
  const charges = rawCharges.slice(0, MAX_CHARGES).map((c, i) => {
    const f = (k) => `charges.${i}.${k}`;
    const out = {
      kind: CHARGE_KINDS[c.kind] ? c.kind : 'other',
      label: str(c.label),
      amount: c.amount,
      gst_rate_bp: billType === 'gst' ? (c.gst_rate_bp ?? 0) : 0,
    };
    if (!Number.isSafeInteger(out.amount) || out.amount <= 0 || out.amount > MAX_RATE)
      errors[f('amount')] = 'Enter the amount.';
    if (out.label.length > 60) errors[f('label')] = 'Too long (max 60).';
    if (billType === 'gst' && !rateOk(out.gst_rate_bp))
      errors[f('gst_rate_bp')] = 'Choose a GST rate from the list.';
    return out;
  });

  let payment = null;
  if (p.payment && p.payment.amount) {
    const r = payments.validatePayment(p.payment, 'payment');
    Object.assign(errors, r.errors);
    payment = r.data;
  }
  const advance = p.advance_amount == null ? 0 : p.advance_amount;
  if (!Number.isSafeInteger(advance) || advance < 0) errors.advance_amount = 'Invalid amount.';

  const attachments = (Array.isArray(p.attachments) ? p.attachments : []).slice(0, 10).map((a) => ({
    temp_path: a.temp_path,
    original_name: str(a.original_name).slice(0, 120) || 'attachment',
    size_bytes: Number.isSafeInteger(a.size_bytes) ? a.size_bytes : 0,
  }));

  fail(errors);

  const { pos, interstate } = placeOfSupply(supplier, s);
  const calc = billing.calculatePurchase({
    bill_type: billType,
    price_mode: priceMode,
    is_interstate: interstate,
    charges_mode: chargesMode,
    gst_in_cost: s.composition_dealer === '1',
    round_off: p.round_off == null ? null : p.round_off,
    items,
    charges,
  });
  const totals = calc.totals;
  if (totals.grand_total < 0) fail({ round_off: 'The total cannot be negative.' });
  if (payment && payment.amount > totals.grand_total) {
    fail({ 'payment.amount': 'Paid now is more than the bill total.' });
  }
  if (payment && advance && payment.amount + advance > totals.grand_total) {
    fail({ advance_amount: 'Paid + advance is more than the bill total.' });
  }
  const printed = p.printed_total == null ? null : p.printed_total;
  const mismatch = printed == null ? 0 : printed - totals.grand_total;

  return {
    supplier,
    header: {
      party_id: supplier.id,
      supplier_name: supplier.name,
      supplier_gstin: supplier.gstin || null,
      supplier_state_code: supplier.state_code || null,
      bill_no: billNo || null,
      bill_no_key: billNoKey(billNo),
      bill_date: billDate,
      entry_date: entryDate,
      bill_type: billType,
      price_mode: priceMode,
      place_of_supply_code: pos,
      is_interstate: interstate ? 1 : 0,
      charges_mode: chargesMode,
      printed_total: printed,
      total_mismatch: mismatch !== 0 ? 1 : 0,
      mismatch_amount: mismatch,
      due_date:
        supplier.payment_terms_days != null ? addDays(billDate, supplier.payment_terms_days) : null,
      notes: notes || null,
      ...pick(totals, [
        'sub_total',
        'discount_total',
        'taxable_total',
        'charges_taxable',
        'cgst_total',
        'sgst_total',
        'igst_total',
        'tax_total',
        'round_off',
        'grand_total',
      ]),
    },
    items: calc.items,
    charges: calc.charges,
    totals,
    tax_summary: calc.tax_summary,
    payment,
    advance,
    attachments,
    mismatch,
    confirm_mismatch: Boolean(p.confirm_mismatch),
  };
}

function pick(obj, keys) {
  return Object.fromEntries(keys.map((k) => [k, obj[k]]));
}

/** "Already entered: PUR-0004" check. */
function findDuplicate(db, { party_id: partyId, bill_no: billNo, exclude_id: excludeId = null }) {
  const key = billNoKey(billNo);
  if (!key || !Number.isInteger(partyId)) return null;
  return (
    db
      .prepare(
        `SELECT id, entry_no, bill_date, grand_total FROM purchases
         WHERE party_id = ? AND bill_no_key = ? AND status = 'active' AND is_deleted = 0 AND id IS NOT ?`,
      )
      .get(partyId, key, excludeId) || null
  );
}

function checkBillNo(db, payload) {
  return { duplicate: findDuplicate(db, payload) };
}

function assertNoDuplicate(db, header, excludeId) {
  const dup = findDuplicate(db, {
    party_id: header.party_id,
    bill_no: header.bill_no,
    exclude_id: excludeId,
  });
  if (dup) {
    throw new AppError(
      `Already entered: ${dup.entry_no} has this supplier's bill no. ${header.bill_no}.`,
      'DUPLICATE_BILL',
      { bill_no: `Already entered as ${dup.entry_no}.`, duplicate_id: String(dup.id) },
    );
  }
}

function assertMismatchConfirmed(v) {
  if (v.mismatch !== 0 && !v.confirm_mismatch) {
    throw new AppError(
      `The total (${money(v.totals.grand_total)}) differs from the printed bill total by ${money(v.mismatch)}.`,
      'TOTAL_MISMATCH',
      { printed_total: 'Does not match the calculated total.' },
    );
  }
}

// ---------------------------------------------------------------- stock in / out

/**
 * Writes the current line set (revision) of a purchase: items, stock movements, serials,
 * average cost and price updates. `own` = serial rows of this purchase kept from the previous
 * revision (edit), matched by serial key per variant.
 */
function applyLines(db, pur, items, revision, own = new Map()) {
  const insertItem = db.prepare(
    `INSERT INTO purchase_items (purchase_id, revision, product_id, variant_id, product_name,
       variant_label, sku, unit, hsn_code, qty_milli, free_qty_milli, rate, discount_bp, discount,
       gst_rate_bp, taxable, cgst, sgst, igst, line_total, charges_share, landed_total, unit_cost,
       sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const setAvg = db.prepare('UPDATE product_variants SET avg_cost = ? WHERE id = ?');
  const keepSerial = db.prepare(
    `UPDATE product_serials SET purchase_item_id = ?, purchase_date = ?, supplier_party_id = ?,
       supplier_warranty_end = ? WHERE id = ?`,
  );

  items.forEach((l, i) => {
    const v = loadVariantInfo(db, l.variant_id);
    const itemId = Number(
      insertItem.run(
        pur.id,
        revision,
        v.product_id,
        v.id,
        v.product_name,
        variantLabel(v) || null,
        v.sku,
        v.unit,
        v.hsn_code || null,
        l.qty_milli,
        l.free_qty_milli,
        l.rate,
        l.discount_bp,
        l.discount,
        l.gst_rate_bp,
        l.taxable,
        l.cgst,
        l.sgst,
        l.igst,
        l.line_total,
        l.charges_share,
        l.landed_total,
        l.unit_cost,
        i,
      ).lastInsertRowid,
    );
    l.item_id = itemId;
    const units = l.qty_milli + l.free_qty_milli;

    let inMilli = units;
    let newSerials = null;
    if (v.track_serials) {
      const pool = own.get(v.id) || [];
      const fresh = [];
      let keptInStock = 0;
      for (const e of l.serials.entries) {
        const key = serials.serialKey(e.serial_no);
        const idx = pool.findIndex((s) => s.serial_key === key);
        if (idx >= 0) {
          const s = pool.splice(idx, 1)[0];
          keepSerial.run(
            itemId,
            pur.bill_date,
            pur.party_id,
            warrantyEnd(pur.bill_date, v.supplier_warranty_months),
            s.id,
          );
          serials.insertEvent(db, s.id, {
            date: pur.entry_date,
            type: 'purchase_edited',
            from_status: s.status,
            to_status: s.status,
            ref_type: 'purchase',
            ref_id: pur.id,
            note: `${pur.entry_no} edited (unit kept)`,
          });
          if (s.status === 'in_stock') keptInStock++;
        } else fresh.push(e);
      }
      newSerials = { entries: fresh, auto: l.serials.auto };
      const newCount = fresh.length + (l.serials.auto ? l.serials.auto.count : 0);
      inMilli = (keptInStock + newCount) * 1000;
    }

    if (inMilli > 0) {
      const before = { stock_milli: variantStock(db, v.id), avg_cost: v.avg_cost };
      const value = billing.divRound(l.landed_total * inMilli, units);
      const movementId = serials.insertMovement(db, {
        variant_id: v.id,
        date: pur.entry_date,
        type: 'purchase',
        qty_milli: inMilli,
        unit_cost: l.unit_cost,
        ref_type: 'purchase_item',
        ref_id: itemId,
        reason: pur.entry_no,
      });
      setAvg.run(billing.averageIn(before, inMilli, value), v.id);
      void movementId;
    }
    if (newSerials && newSerials.entries.length + (newSerials.auto ? newSerials.auto.count : 0)) {
      serials.addSerials(db, {
        variant_id: v.id,
        input: newSerials,
        source_type: 'purchase',
        date: pur.entry_date,
        event: 'received_purchase',
        fieldPrefix: `items.${l.index}.serials`,
        ref: {
          ref_type: 'purchase',
          ref_id: pur.id,
          purchase_id: pur.id,
          purchase_item_id: itemId,
          supplier_party_id: pur.party_id,
          warranty_date: pur.bill_date,
        },
      });
    }
    updatePrices(db, v, l, pur);
  });
}

function updatePrices(db, v, l, pur) {
  const changes = [];
  if (l.update_purchase_price && l.unit_cost !== v.purchase_price) {
    changes.push(['purchase_price', v.purchase_price, l.unit_cost]);
  }
  if (l.new_mrp != null && l.new_mrp !== v.mrp) changes.push(['mrp', v.mrp, l.new_mrp]);
  if (l.new_selling_price != null && l.new_selling_price !== v.selling_price) {
    changes.push(['selling_price', v.selling_price, l.new_selling_price]);
  }
  const log = db.prepare(
    `INSERT INTO price_changes (variant_id, field, old_value, new_value, source, ref_id, date)
     VALUES (?, ?, ?, ?, 'purchase', ?, ?)`,
  );
  for (const [field, oldValue, newValue] of changes) {
    db.prepare(`UPDATE product_variants SET ${field} = ? WHERE id = ?`).run(newValue, v.id);
    log.run(v.id, field, oldValue, newValue, pur.id, pur.entry_date);
  }
}

/** Takes the current line set out of stock (edit / cancel). Returns per-variant quantities. */
function reverseLines(db, pur, items, label) {
  const setAvg = db.prepare('UPDATE product_variants SET avg_cost = ? WHERE id = ?');
  for (const it of items) {
    const v = loadVariantInfo(db, it.variant_id);
    const outMilli = v.track_serials
      ? db
          .prepare(
            "SELECT COUNT(*) FROM product_serials WHERE purchase_item_id = ? AND status = 'in_stock'",
          )
          .pluck()
          .get(it.id) * 1000
      : it.qty_milli + it.free_qty_milli;
    if (outMilli <= 0) continue;
    const before = { stock_milli: variantStock(db, v.id), avg_cost: v.avg_cost };
    serials.insertMovement(db, {
      variant_id: v.id,
      date: todayISO(),
      type: 'purchase',
      qty_milli: -outMilli,
      unit_cost: it.unit_cost,
      ref_type: 'purchase_item',
      ref_id: it.id,
      reason: `${pur.entry_no}: ${label}`,
    });
    setAvg.run(billing.averageOut(before, outMilli, it.unit_cost), v.id);
  }
}

function voidSerial(db, s, pur, note) {
  if (s.status === 'defective') {
    // It leaves the defective location too (in-stock units leave with the line reversal).
    const v = db.prepare('SELECT variant_id FROM product_serials WHERE id = ?').get(s.id);
    serials.insertMovement(db, {
      variant_id: v.variant_id,
      date: todayISO(),
      type: 'purchase',
      location: 'defective',
      qty_milli: -1000,
      unit_cost: serials.defectiveUnitCost(db, v.variant_id),
      ref_type: 'serial',
      ref_id: s.id,
      reason: note,
    });
  }
  db.prepare("UPDATE product_serials SET status = 'voided' WHERE id = ?").run(s.id);
  serials.insertEvent(db, s.id, {
    type: 'voided',
    from_status: s.status,
    to_status: 'voided',
    ref_type: 'purchase',
    ref_id: pur.id,
    note,
  });
}

// ---------------------------------------------------------------- reading one

function purchaseRow(db, id) {
  const row = db.prepare('SELECT * FROM purchases WHERE id = ? AND is_deleted = 0').get(id);
  if (!row) throw new AppError('Purchase not found.', 'NOT_FOUND');
  return row;
}

function currentItems(db, pur) {
  return db
    .prepare(
      'SELECT * FROM purchase_items WHERE purchase_id = ? AND revision = ? ORDER BY sort_order, id',
    )
    .all(pur.id, pur.revision);
}

function currentCharges(db, pur) {
  return db
    .prepare(
      'SELECT * FROM purchase_charges WHERE purchase_id = ? AND revision = ? ORDER BY sort_order, id',
    )
    .all(pur.id, pur.revision);
}

function paidOf(db, purchaseId) {
  return db
    .prepare(
      `SELECT COALESCE(SUM(amount), 0) FROM bill_allocations
       WHERE doc_type = 'purchase' AND doc_id = ? AND status = 'active'`,
    )
    .pluck()
    .get(purchaseId);
}

/**
 * Can this purchase still be edited / cancelled? Reasons are user-facing.
 * Blocks when a unit from it has been sold / claimed / returned, or a debit note exists.
 * (The stock check happens inside the transaction, against the real result.)
 */
function modifyCheck(db, pur) {
  const reasons = [];
  if (pur.status !== 'active') reasons.push('This purchase is cancelled.');
  const returns = db
    .prepare(
      "SELECT return_no FROM purchase_returns WHERE purchase_id = ? AND status = 'active' AND is_deleted = 0",
    )
    .pluck()
    .all(pur.id);
  if (returns.length) {
    reasons.push(`It has a purchase return (${returns.join(', ')}). Cancel the return first.`);
  }
  const locked = db
    .prepare(
      `SELECT serial_no, status FROM product_serials
       WHERE purchase_id = ? AND status IN (${LOCKED_SERIAL.map(() => '?').join(',')}) LIMIT 5`,
    )
    .all(pur.id, ...LOCKED_SERIAL);
  for (const s of locked) {
    reasons.push(`Serial ${s.serial_no} is ${serials.STATUS_LABELS[s.status].toLowerCase()}.`);
  }
  // Non-serial stock: cancelling must not take stock below zero.
  const neg = [];
  const byVariant = new Map();
  for (const it of currentItems(db, pur)) {
    const v = loadVariantInfo(db, it.variant_id);
    if (v.track_serials) continue;
    byVariant.set(v.id, {
      name: it.product_name,
      unit: it.unit,
      qty: (byVariant.get(v.id)?.qty || 0) + it.qty_milli + it.free_qty_milli,
    });
  }
  for (const [vid, x] of byVariant) {
    const stock = variantStock(db, vid);
    if (stock - x.qty < 0) neg.push(`${x.name} (only ${stock / 1000} ${x.unit} left in stock)`);
  }
  return { reasons, stock_reasons: neg };
}

function editCheck(db, { id }) {
  const pur = purchaseRow(db, id);
  const c = modifyCheck(db, pur);
  return {
    can_edit: c.reasons.length === 0,
    can_cancel: c.reasons.length === 0 && c.stock_reasons.length === 0,
    reasons: c.reasons,
    stock_reasons: c.stock_reasons,
  };
}

function get(db, id) {
  const pur = purchaseRow(db, id);
  const items = currentItems(db, pur).map((it) => {
    const v = loadVariantInfo(db, it.variant_id);
    const returned = db
      .prepare(
        `SELECT COALESCE(SUM(ri.qty_milli), 0) FROM purchase_return_items ri
         JOIN purchase_returns r ON r.id = ri.purchase_return_id
         WHERE ri.purchase_item_id = ? AND r.status = 'active' AND r.is_deleted = 0`,
      )
      .pluck()
      .get(it.id);
    const units = v.track_serials
      ? db
          .prepare(
            `SELECT id, serial_no, serial_no_2, is_auto, status, supplier_warranty_end
             FROM product_serials WHERE purchase_item_id = ? ORDER BY id`,
          )
          .all(it.id)
          .map((s) => ({ ...s, status_label: serials.STATUS_LABELS[s.status] }))
      : null;
    return {
      ...it,
      track_serials: v.track_serials,
      product_active: Boolean(v.product_active && v.is_active && !v.is_deleted),
      returned_milli: returned,
      serials: units,
      current: {
        mrp: v.mrp,
        selling_price: v.selling_price,
        purchase_price: v.purchase_price,
        avg_cost: v.avg_cost,
        barcode: v.barcode,
      },
    };
  });
  const charges = currentCharges(db, pur);
  const allocations = db
    .prepare(
      `SELECT a.id, a.source_type, a.source_id, a.amount, a.date, a.status, a.note,
         pm.payment_no, pm.mode, pm.ref_no, pm.status AS payment_status, pr.return_no
       FROM bill_allocations a
       LEFT JOIN payments pm ON a.source_type = 'payment' AND pm.id = a.source_id
       LEFT JOIN purchase_returns pr ON a.source_type = 'purchase_return' AND pr.id = a.source_id
       WHERE a.doc_type = 'purchase' AND a.doc_id = ? ORDER BY a.id`,
    )
    .all(pur.id);
  const refunds = db
    .prepare(
      `SELECT id, payment_no, date, amount, mode, ref_no, status FROM payments
       WHERE ref_type = 'purchase' AND ref_id = ? AND direction = 'in' ORDER BY id`,
    )
    .all(pur.id);
  const returns = db
    .prepare(
      `SELECT id, return_no, date, total, status, settlement FROM purchase_returns
       WHERE purchase_id = ? AND is_deleted = 0 ORDER BY id`,
    )
    .all(pur.id);
  const attachments = db
    .prepare(
      'SELECT id, file_path, original_name, size_bytes, created_at FROM purchase_attachments WHERE purchase_id = ? AND is_deleted = 0 ORDER BY id',
    )
    .all(pur.id)
    .map((a) => ({ ...a, url: `app-data://files/${a.file_path}` }));
  const auditRows = db
    .prepare('SELECT * FROM purchase_audit WHERE purchase_id = ? ORDER BY id DESC')
    .all(pur.id)
    .map((a) => ({ ...a, details: a.details ? JSON.parse(a.details) : null }));
  const supplier = db
    .prepare(
      'SELECT id, name, phone, gstin, state_code, payment_terms_days FROM parties WHERE id = ?',
    )
    .get(pur.party_id);

  const summary = new Map();
  for (const x of [...items, ...charges]) {
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
  const paid = pur.status === 'active' ? paidOf(db, pur.id) : 0;
  const due = pur.status === 'active' ? pur.grand_total - paid : 0;
  const check = modifyCheck(db, pur);
  return {
    ...pur,
    supplier,
    items,
    charges,
    tax_summary: [...summary.values()].sort((a, b) => a.gst_rate_bp - b.gst_rate_bp),
    allocations,
    refunds,
    returns,
    attachments,
    audit: auditRows,
    paid,
    due,
    pay_status: payStatus(pur, paid),
    can_edit: check.reasons.length === 0,
    can_cancel: check.reasons.length === 0 && check.stock_reasons.length === 0,
    lock_reasons: [...check.reasons, ...check.stock_reasons],
  };
}

function payStatus(pur, paid) {
  if (pur.status !== 'active') return 'cancelled';
  const due = pur.grand_total - paid;
  if (due <= 0) return 'paid';
  if (pur.due_date && pur.due_date < todayISO()) return 'overdue';
  return paid > 0 ? 'partial' : 'unpaid';
}

// ---------------------------------------------------------------- create

function insertHeader(db, h, entry) {
  return Number(
    db
      .prepare(
        `INSERT INTO purchases (entry_no, series, seq_no, entry_date, party_id, supplier_name,
           supplier_gstin, supplier_state_code, bill_no, bill_no_key, bill_date, bill_type, price_mode,
           place_of_supply_code, is_interstate, sub_total, discount_total, taxable_total,
           charges_taxable, charges_mode, cgst_total, sgst_total, igst_total, tax_total, round_off,
           grand_total, printed_total, total_mismatch, mismatch_amount, due_date, notes)
         VALUES (@entry_no, 'purchase', @seq_no, @entry_date, @party_id, @supplier_name,
           @supplier_gstin, @supplier_state_code, @bill_no, @bill_no_key, @bill_date, @bill_type,
           @price_mode, @place_of_supply_code, @is_interstate, @sub_total, @discount_total,
           @taxable_total, @charges_taxable, @charges_mode, @cgst_total, @sgst_total, @igst_total,
           @tax_total, @round_off, @grand_total, @printed_total, @total_mismatch, @mismatch_amount,
           @due_date, @notes)`,
      )
      .run({ ...h, entry_no: entry.number, seq_no: entry.seq_no }).lastInsertRowid,
  );
}

function insertCharges(db, purchaseId, revision, charges) {
  const ins = db.prepare(
    `INSERT INTO purchase_charges (purchase_id, revision, kind, label, amount, gst_rate_bp, taxable,
       cgst, sgst, igst, total, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  charges.forEach((c, i) =>
    ins.run(
      purchaseId,
      revision,
      c.kind,
      c.label || null,
      c.amount,
      c.gst_rate_bp,
      c.taxable,
      c.cgst,
      c.sgst,
      c.igst,
      c.total,
      i,
    ),
  );
}

/**
 * Supplier credit available for "Adjust from advance": the balance as if this bill (and the
 * money paid with it) did not exist, less what was already adjusted from advance onto it.
 */
function advanceAvailable(db, partyId, purchaseId = null) {
  const balance = db
    .prepare('SELECT COALESCE(SUM(amount), 0) FROM v_party_ledger WHERE party_id = ?')
    .pluck()
    .get(partyId);
  if (!purchaseId) return Math.max(balance, 0);
  const own =
    db
      .prepare(
        "SELECT grand_total FROM purchases WHERE id = ? AND status = 'active' AND is_deleted = 0",
      )
      .pluck()
      .get(purchaseId) || 0;
  const ownPaid = db
    .prepare(
      `SELECT COALESCE(SUM(CASE direction WHEN 'out' THEN amount ELSE -amount END), 0) FROM payments
       WHERE ref_type = 'purchase' AND ref_id = ? AND status = 'active' AND is_deleted = 0`,
    )
    .pluck()
    .get(purchaseId);
  const adjusted = db
    .prepare(
      `SELECT COALESCE(SUM(amount), 0) FROM bill_allocations WHERE doc_type = 'purchase'
         AND doc_id = ? AND source_type = 'advance' AND status = 'active'`,
    )
    .pluck()
    .get(purchaseId);
  return Math.max(balance + own - ownPaid - adjusted, 0);
}

function settleAtPurchase(db, pur, v, actor) {
  if (v.payment) {
    const pay = payments.insertPayment(db, {
      direction: 'out',
      party_id: pur.party_id,
      date: pur.entry_date,
      amount: v.payment.amount,
      mode: v.payment.mode,
      ref_no: v.payment.ref_no,
      ref_type: 'purchase',
      ref_id: pur.id,
      notes: `Paid with ${pur.entry_no}`,
    });
    payments.allocate(db, {
      party_id: pur.party_id,
      doc_type: 'purchase',
      doc_id: pur.id,
      source_type: 'payment',
      source_id: pay.id,
      amount: v.payment.amount,
      date: pur.entry_date,
    });
    audit(db, {
      purchase_id: pur.id,
      action: 'payment',
      actor,
      summary: `Paid ${money(v.payment.amount)} by ${payments.MODE_LABELS[v.payment.mode]} (${pay.payment_no})`,
    });
  }
  if (v.advance > 0) {
    const available = advanceAvailable(db, pur.party_id, pur.id);
    const due = pur.grand_total - paidOf(db, pur.id);
    if (v.advance > available) {
      fail({ advance_amount: `Only ${money(available)} advance is available.` });
    }
    if (v.advance > due) fail({ advance_amount: 'More than the amount due on this bill.' });
    payments.allocate(db, {
      party_id: pur.party_id,
      doc_type: 'purchase',
      doc_id: pur.id,
      source_type: 'advance',
      amount: v.advance,
      date: pur.entry_date,
      note: 'Adjusted from advance',
    });
    audit(db, {
      purchase_id: pur.id,
      action: 'payment',
      actor,
      summary: `Adjusted ${money(v.advance)} from the supplier's advance`,
    });
  }
}

function insertAttachments(db, purchaseId, list, moves) {
  const ins = db.prepare(
    'INSERT INTO purchase_attachments (purchase_id, file_path, original_name, size_bytes) VALUES (?, ?, ?, ?)',
  );
  list.forEach((a, i) => ins.run(purchaseId, moves[i].to, a.original_name, a.size_bytes));
}

/**
 * Saves a new purchase. ctx = { actor, files } where files.commit(tempPaths, entryNo) moves
 * staged attachments into place (returns moves) and files.undo(moves) moves them back.
 */
function create(db, payload, ctx = {}) {
  let moves = [];
  try {
    const id = db.transaction(() => {
      const v = validate(db, payload);
      assertNoDuplicate(db, v.header, null);
      assertMismatchConfirmed(v);
      const entry = settings.takeNextNumber(db, 'purchase');
      const purchaseId = insertHeader(db, v.header, entry);
      const pur = { ...v.header, id: purchaseId, entry_no: entry.number };
      applyLines(db, pur, v.items, 1);
      insertCharges(db, purchaseId, 1, v.charges);
      settleAtPurchase(db, pur, v, ctx.actor);
      if (v.attachments.length) {
        if (!ctx.files) throw new Error('Attachments need a file handler');
        moves = ctx.files.commit(
          v.attachments.map((a) => a.temp_path),
          entry.number,
        );
        insertAttachments(db, purchaseId, v.attachments, moves);
      }
      audit(db, {
        purchase_id: purchaseId,
        action: 'created',
        actor: ctx.actor,
        summary: `Entered ${entry.number}: ${v.items.length} line${v.items.length === 1 ? '' : 's'}, ${money(v.header.grand_total)}${
          v.mismatch ? ` (differs from printed total by ${money(v.mismatch)})` : ''
        }`,
      });
      if (Number.isInteger(payload.draft_id)) {
        db.prepare(
          "UPDATE purchase_drafts SET status = 'saved', purchase_id = ? WHERE id = ? AND status = 'open'",
        ).run(purchaseId, payload.draft_id);
      }
      return purchaseId;
    })();
    return get(db, id);
  } catch (err) {
    if (moves.length && ctx.files) ctx.files.undo(moves);
    if (err && err.code === 'SQLITE_CONSTRAINT_UNIQUE' && /bill_no_key/.test(err.message)) {
      throw new AppError('Already entered: this supplier bill number exists.', 'DUPLICATE_BILL');
    }
    throw err;
  }
}

// ---------------------------------------------------------------- edit

function diffSummary(oldRow, oldItems, v) {
  const header = {};
  for (const k of [
    'bill_no',
    'bill_date',
    'entry_date',
    'bill_type',
    'price_mode',
    'charges_mode',
    'party_id',
    'grand_total',
    'round_off',
    'printed_total',
    'notes',
  ]) {
    const a = oldRow[k] ?? null;
    const b = v.header[k] ?? null;
    if (a !== b) header[k] = [a, b];
  }
  const key = (x) => `${x.variant_id}`;
  const before = new Map(oldItems.map((i) => [key(i), i]));
  const after = new Map(v.items.map((i) => [key(i), i]));
  const lines = { added: [], removed: [], changed: [] };
  for (const [k, n] of after) {
    const o = before.get(k);
    const name = o ? o.product_name : n.variant ? n.variant.product_name : k;
    if (!o) lines.added.push({ name, qty_milli: n.qty_milli, rate: n.rate });
    else {
      const ch = {};
      for (const f of ['qty_milli', 'free_qty_milli', 'rate', 'discount', 'gst_rate_bp']) {
        if (o[f] !== n[f]) ch[f] = [o[f], n[f]];
      }
      if (Object.keys(ch).length) lines.changed.push({ name, ...ch });
    }
  }
  for (const [k, o] of before) {
    if (!after.has(k)) lines.removed.push({ name: o.product_name, qty_milli: o.qty_milli });
  }
  const parts = [];
  if (lines.added.length) parts.push(`${lines.added.length} line(s) added`);
  if (lines.removed.length) parts.push(`${lines.removed.length} removed`);
  if (lines.changed.length) parts.push(`${lines.changed.length} changed`);
  const fieldNames = Object.keys(header).filter((k) => k !== 'grand_total');
  if (fieldNames.length) parts.push(`changed ${fieldNames.join(', ').replace(/_/g, ' ')}`);
  if (header.grand_total) {
    parts.push(`total ${money(header.grand_total[0])} → ${money(header.grand_total[1])}`);
  }
  return { header, lines, text: parts.join('; ') || 'no changes to lines or totals' };
}

/** Edit = reverse the current lines + apply the new ones, in one transaction, with audit. */
function update(db, id, payload, ctx = {}) {
  let moves = [];
  try {
    db.transaction(() => {
      const pur = purchaseRow(db, id);
      const check = modifyCheck(db, pur);
      if (check.reasons.length) {
        throw new AppError(`This purchase cannot be edited: ${check.reasons[0]}`, 'LOCKED');
      }
      const oldItems = currentItems(db, pur);
      const v = validate(db, payload, { row: pur, items: oldItems });
      const paid = paidOf(db, pur.id);
      if (v.header.party_id !== pur.party_id && paid > 0) {
        fail({
          party_id:
            'Payments are recorded against this bill; cancel it and re-enter for the other supplier.',
        });
      }
      if (v.payment || v.advance) {
        fail({ payment: 'Record payments from the purchase screen after saving the edit.' });
      }
      if (paid > v.header.grand_total) {
        fail({
          items: `${money(paid)} is already paid against this bill: the new total cannot be less.`,
        });
      }
      assertNoDuplicate(db, v.header, pur.id);
      assertMismatchConfirmed(v);

      const stockBefore = new Map();
      const variants = new Set([...oldItems, ...v.items].map((i) => i.variant_id));
      for (const vid of variants) stockBefore.set(vid, variantStock(db, vid));

      // 1. reverse
      reverseLines(db, pur, oldItems, 'edited (reversed)');
      // Units of this purchase that stay usable for matching (in stock / defective).
      const ownRows = db
        .prepare(
          `SELECT id, variant_id, serial_key, serial_no, status, supplier_warranty_end
           FROM product_serials WHERE purchase_id = ? AND status IN ('in_stock','defective')`,
        )
        .all(pur.id);
      const wanted = new Map(); // variant → keys in the new bill
      for (const l of v.items) {
        if (!l.serials) continue;
        const set = wanted.get(l.variant_id) || new Set();
        for (const e of l.serials.entries) set.add(serials.serialKey(e.serial_no));
        wanted.set(l.variant_id, set);
      }
      const own = new Map();
      for (const s of ownRows) {
        if (wanted.get(s.variant_id)?.has(s.serial_key)) {
          own.set(s.variant_id, [...(own.get(s.variant_id) || []), s]);
        } else voidSerial(db, s, pur, `Removed when ${pur.entry_no} was edited`);
      }
      // Kept in-stock units were taken out by the reversal: their movement comes back below.

      // 2. re-apply
      const revision = pur.revision + 1;
      db.prepare(
        `UPDATE purchases SET party_id = @party_id, supplier_name = @supplier_name,
           supplier_gstin = @supplier_gstin, supplier_state_code = @supplier_state_code,
           bill_no = @bill_no, bill_no_key = @bill_no_key, bill_date = @bill_date,
           entry_date = @entry_date, bill_type = @bill_type, price_mode = @price_mode,
           place_of_supply_code = @place_of_supply_code, is_interstate = @is_interstate,
           sub_total = @sub_total, discount_total = @discount_total, taxable_total = @taxable_total,
           charges_taxable = @charges_taxable, charges_mode = @charges_mode, cgst_total = @cgst_total,
           sgst_total = @sgst_total, igst_total = @igst_total, tax_total = @tax_total,
           round_off = @round_off, grand_total = @grand_total, printed_total = @printed_total,
           total_mismatch = @total_mismatch, mismatch_amount = @mismatch_amount,
           due_date = @due_date, notes = @notes, revision = @revision
         WHERE id = @id`,
      ).run({ ...v.header, revision, id: pur.id });
      const next = { ...pur, ...v.header, revision };
      applyLines(db, next, v.items, revision, own);
      insertCharges(db, pur.id, revision, v.charges);
      if (v.header.party_id !== pur.party_id) {
        db.prepare(
          "UPDATE bill_allocations SET party_id = ? WHERE doc_type = 'purchase' AND doc_id = ?",
        ).run(v.header.party_id, pur.id);
      }

      // 3. stock guard on the real result
      for (const vid of variants) {
        const after = variantStock(db, vid);
        if (after < 0 && after < stockBefore.get(vid)) {
          const info = loadVariantInfo(db, vid);
          throw new AppError(
            `This edit would make the stock of "${info.product_name}" negative (${after / 1000} ${info.unit}). Those units were already sold.`,
            'NEGATIVE_STOCK',
          );
        }
      }

      if (v.attachments.length) {
        moves = ctx.files.commit(
          v.attachments.map((a) => a.temp_path),
          pur.entry_no,
        );
        insertAttachments(db, pur.id, v.attachments, moves);
      }
      const diff = diffSummary(pur, oldItems, v);
      audit(db, {
        purchase_id: pur.id,
        action: 'edited',
        actor: ctx.actor,
        summary: `Edited (revision ${revision}): ${diff.text}`,
        details: {
          header: diff.header,
          lines: diff.lines,
          reason: str(payload.edit_reason) || null,
        },
      });
    })();
    return get(db, id);
  } catch (err) {
    if (moves.length && ctx.files) ctx.files.undo(moves);
    throw err;
  }
}

// ---------------------------------------------------------------- cancel

/**
 * Cancels a purchase: reverses stock, voids its serial numbers, takes it out of the ledger.
 * Money paid against it stays with the supplier as an advance, unless `refund` records
 * that the supplier gave it back.
 */
function cancel(db, { id, reason, refund = null }, ctx = {}) {
  const why = str(reason);
  if (!why) fail({ reason: 'A reason is required.' });
  if (why.length > 200) fail({ reason: 'Reason is too long (max 200).' });
  db.transaction(() => {
    const pur = purchaseRow(db, id);
    const check = modifyCheck(db, pur);
    if (check.reasons.length) {
      throw new AppError(`This purchase cannot be cancelled: ${check.reasons[0]}`, 'LOCKED');
    }
    if (check.stock_reasons.length) {
      throw new AppError(
        `Cancelling would make stock negative: ${check.stock_reasons[0]}.`,
        'NEGATIVE_STOCK',
      );
    }
    const paid = db
      .prepare(
        `SELECT COALESCE(SUM(amount), 0) FROM bill_allocations
         WHERE doc_type = 'purchase' AND doc_id = ? AND status = 'active' AND source_type = 'payment'`,
      )
      .pluck()
      .get(pur.id);
    let refundRow = null;
    if (refund && refund.amount) {
      const r = payments.validatePayment(refund, 'refund');
      fail(r.errors);
      if (r.data.amount > paid) {
        fail({ 'refund.amount': `Only ${money(paid)} was paid against this bill.` });
      }
      refundRow = r.data;
    }

    reverseLines(db, pur, currentItems(db, pur), 'cancelled');
    const units = db
      .prepare(
        "SELECT id, status FROM product_serials WHERE purchase_id = ? AND status IN ('in_stock','defective')",
      )
      .all(pur.id);
    for (const s of units) voidSerial(db, s, pur, `${pur.entry_no} cancelled: ${why}`);
    db.prepare(
      `UPDATE purchases SET status = 'cancelled', cancel_reason = ?,
         cancelled_at = strftime('%Y-%m-%d %H:%M:%S','now','localtime') WHERE id = ?`,
    ).run(why, pur.id);
    payments.releaseAllocations(db, { doc_type: 'purchase', doc_id: pur.id });
    audit(db, {
      purchase_id: pur.id,
      action: 'cancelled',
      actor: ctx.actor,
      summary: `Cancelled: ${why}${paid && !refundRow ? `. ${money(paid)} paid stays as supplier advance` : ''}`,
    });
    if (refundRow) {
      const pay = payments.insertPayment(db, {
        direction: 'in',
        party_id: pur.party_id,
        date: todayISO(),
        amount: refundRow.amount,
        mode: refundRow.mode,
        ref_no: refundRow.ref_no,
        ref_type: 'purchase',
        ref_id: pur.id,
        notes: `Refund for cancelled ${pur.entry_no}`,
      });
      audit(db, {
        purchase_id: pur.id,
        action: 'refund',
        actor: ctx.actor,
        summary: `Refund received ${money(refundRow.amount)} by ${payments.MODE_LABELS[refundRow.mode]} (${pay.payment_no})`,
      });
    }
  })();
  return get(db, id);
}

// ---------------------------------------------------------------- payments after saving

/** Pay (or adjust from advance) against a saved purchase. mode 'advance' = no money moves. */
function recordPayment(db, { id, amount, mode, ref_no: refNo, date }, ctx = {}) {
  db.transaction(() => {
    const pur = purchaseRow(db, id);
    if (pur.status !== 'active') throw new AppError('This purchase is cancelled.');
    const due = pur.grand_total - paidOf(db, pur.id);
    const day = date || todayISO();
    if (!isISODate(day)) fail({ date: 'Invalid date.' });
    if (!Number.isSafeInteger(amount) || amount <= 0) fail({ amount: 'Enter the amount.' });
    if (amount > due) fail({ amount: `Only ${money(due)} is due on this bill.` });
    if (mode === 'advance') {
      settleAtPurchase(
        db,
        { ...pur, entry_date: day },
        { payment: null, advance: amount },
        ctx.actor,
      );
      return;
    }
    const r = payments.validatePayment({ amount, mode, ref_no: refNo }, 'payment');
    fail(
      Object.fromEntries(
        Object.entries(r.errors).map(([k, val]) => [k.replace('payment.', ''), val]),
      ),
    );
    settleAtPurchase(db, { ...pur, entry_date: day }, { payment: r.data, advance: 0 }, ctx.actor);
  })();
  return get(db, id);
}

// ---------------------------------------------------------------- attachments

function addAttachments(db, { id, attachments }, ctx = {}) {
  let moves = [];
  try {
    db.transaction(() => {
      const pur = purchaseRow(db, id);
      const list = (attachments || []).slice(0, 10);
      const count = db
        .prepare(
          'SELECT COUNT(*) FROM purchase_attachments WHERE purchase_id = ? AND is_deleted = 0',
        )
        .pluck()
        .get(pur.id);
      if (count + list.length > 20) throw new AppError('At most 20 attachments per purchase.');
      moves = ctx.files.commit(
        list.map((a) => a.temp_path),
        pur.entry_no,
      );
      insertAttachments(
        db,
        pur.id,
        list.map((a) => ({
          original_name: str(a.original_name).slice(0, 120) || 'attachment',
          size_bytes: Number.isSafeInteger(a.size_bytes) ? a.size_bytes : 0,
        })),
        moves,
      );
      audit(db, {
        purchase_id: pur.id,
        action: 'attachment_added',
        actor: ctx.actor,
        summary: `Attached ${list.map((a) => str(a.original_name)).join(', ')}`,
      });
    })();
  } catch (err) {
    if (moves.length && ctx.files) ctx.files.undo(moves);
    throw err;
  }
  return get(db, id);
}

/** Soft-removes an attachment (the file stays in the data folder). */
function removeAttachment(db, { id }, ctx = {}) {
  const a = db
    .prepare('SELECT * FROM purchase_attachments WHERE id = ? AND is_deleted = 0')
    .get(id);
  if (!a) throw new AppError('Attachment not found.', 'NOT_FOUND');
  db.transaction(() => {
    db.prepare('UPDATE purchase_attachments SET is_deleted = 1 WHERE id = ?').run(id);
    audit(db, {
      purchase_id: a.purchase_id,
      action: 'attachment_removed',
      actor: ctx.actor,
      summary: `Removed attachment ${a.original_name}`,
    });
  })();
  return get(db, a.purchase_id);
}

function attachmentFile(db, { id }) {
  const a = db
    .prepare('SELECT * FROM purchase_attachments WHERE id = ? AND is_deleted = 0')
    .get(id);
  if (!a) throw new AppError('Attachment not found.', 'NOT_FOUND');
  return a;
}

// ---------------------------------------------------------------- lists & stats

function likeArg(word) {
  return `%${word.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

const PAY_FILTERS = ['paid', 'partial', 'unpaid', 'overdue'];

function list(db, params = {}) {
  const where = ['pu.is_deleted = 0'];
  const args = [];
  const status = params.status || 'all';
  if (status === 'active') where.push("pu.status = 'active'");
  else if (status === 'cancelled') where.push("pu.status = 'cancelled'");
  if (params.from && isISODate(params.from)) {
    where.push('pu.bill_date >= ?');
    args.push(params.from);
  }
  if (params.to && isISODate(params.to)) {
    where.push('pu.bill_date <= ?');
    args.push(params.to);
  }
  if (Number.isInteger(params.party_id)) {
    where.push('pu.party_id = ?');
    args.push(params.party_id);
  }
  if (params.bill_type === 'gst' || params.bill_type === 'non_gst') {
    where.push('pu.bill_type = ?');
    args.push(params.bill_type);
  }
  if (PAY_FILTERS.includes(params.pay_status)) {
    where.push('d.pay_status = ?');
    args.push(params.pay_status);
  }
  if (params.mismatched) where.push("pu.total_mismatch = 1 AND pu.status = 'active'");
  const q = str(params.search);
  if (q) {
    const like = likeArg(q);
    const key = likeArg(serials.serialKey(q));
    where.push(`(pu.entry_no LIKE ? ESCAPE '\\' OR pu.bill_no LIKE ? ESCAPE '\\'
      OR pu.supplier_name LIKE ? ESCAPE '\\'
      OR EXISTS (SELECT 1 FROM purchase_items i WHERE i.purchase_id = pu.id AND i.revision = pu.revision
        AND (i.product_name LIKE ? ESCAPE '\\' OR i.sku LIKE ? ESCAPE '\\'))
      OR EXISTS (SELECT 1 FROM product_serials s WHERE s.purchase_id = pu.id AND s.status <> 'voided'
        AND s.serial_key LIKE ? ESCAPE '\\'))`);
    args.push(like, like, like, like, like, key);
  }
  const rows = db
    .prepare(
      `SELECT pu.id, pu.entry_no, pu.entry_date, pu.bill_no, pu.bill_date, pu.party_id,
         pu.supplier_name, pu.bill_type, pu.grand_total, pu.status, pu.total_mismatch,
         pu.mismatch_amount, pu.due_date, pu.cancel_reason,
         (SELECT COUNT(*) FROM purchase_items i WHERE i.purchase_id = pu.id AND i.revision = pu.revision) AS item_count,
         COALESCE(d.paid, 0) AS paid, COALESCE(d.due, 0) AS due,
         COALESCE(d.pay_status, 'cancelled') AS pay_status
       FROM purchases pu LEFT JOIN v_purchase_dues d ON d.purchase_id = pu.id
       WHERE ${where.join(' AND ')}
       ORDER BY pu.bill_date DESC, pu.id DESC LIMIT 5000`,
    )
    .all(...args);
  return { rows, total: rows.length, truncated: rows.length === 5000 };
}

function monthRange(today = todayISO()) {
  const [y, m] = today.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const mm = String(m).padStart(2, '0');
  return [`${y}-${mm}-01`, `${y}-${mm}-${String(last).padStart(2, '0')}`];
}

/** Total supplier payable (all suppliers we owe) and the overdue part (bill-wise). */
function payables(db) {
  const total = db
    .prepare(
      `SELECT COALESCE(SUM(-b.balance), 0) FROM v_party_balance b JOIN parties p ON p.id = b.party_id
       WHERE p.type = 'supplier' AND p.is_deleted = 0 AND b.balance < 0`,
    )
    .pluck()
    .get();
  const overdue = db
    .prepare(
      "SELECT COALESCE(SUM(due), 0) AS amount, COUNT(*) AS bills FROM v_purchase_dues WHERE pay_status = 'overdue'",
    )
    .get();
  return { total_payable: total, overdue_payable: overdue.amount, overdue_bills: overdue.bills };
}

function stats(db) {
  const [from, to] = monthRange();
  const month = db
    .prepare(
      `SELECT COALESCE(SUM(grand_total), 0) AS amount, COUNT(*) AS bills FROM purchases
       WHERE status = 'active' AND is_deleted = 0 AND bill_date BETWEEN ? AND ?`,
    )
    .get(from, to);
  const counts = db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM purchases WHERE status = 'active' AND is_deleted = 0) AS bills,
         (SELECT COUNT(*) FROM purchase_drafts WHERE status = 'open') AS drafts,
         (SELECT COUNT(*) FROM purchases WHERE status = 'active' AND is_deleted = 0 AND total_mismatch = 1) AS mismatched,
         (SELECT COUNT(*) FROM purchase_returns WHERE status = 'active' AND is_deleted = 0) AS returns`,
    )
    .get();
  return {
    month_amount: month.amount,
    month_bills: month.bills,
    month_from: from,
    ...counts,
    ...payables(db),
  };
}

// ---------------------------------------------------------------- per-product helpers

/** Entry grid: last 3 purchase rates, prices and stock for one variant. */
function lineInfo(db, { variant_id: variantId }) {
  const v = loadVariantInfo(db, variantId);
  if (!v) throw new AppError('Product not found.', 'NOT_FOUND');
  const last = db
    .prepare(
      `SELECT pu.id AS purchase_id, pu.entry_no, pu.bill_date, pu.supplier_name, i.rate, i.discount,
         i.qty_milli, i.free_qty_milli, i.unit_cost, i.gst_rate_bp, pu.price_mode
       FROM purchase_items i JOIN purchases pu ON pu.id = i.purchase_id
       WHERE i.variant_id = ? AND i.revision = pu.revision AND pu.status = 'active' AND pu.is_deleted = 0
       ORDER BY pu.bill_date DESC, pu.id DESC LIMIT 3`,
    )
    .all(variantId);
  return {
    variant_id: v.id,
    mrp: v.mrp,
    selling_price: v.selling_price,
    purchase_price: v.purchase_price,
    avg_cost: v.avg_cost,
    stock_milli: variantStock(db, v.id),
    last,
  };
}

/** Product drawer: every purchase line of the product + logged price changes. */
function priceHistory(db, { product_id: productId }) {
  const lines = db
    .prepare(
      `SELECT pu.id AS purchase_id, pu.entry_no, pu.bill_no, pu.bill_date, pu.supplier_name,
         pu.party_id, i.variant_id, i.variant_label, i.qty_milli, i.free_qty_milli, i.rate,
         i.discount, i.unit_cost, i.gst_rate_bp, pu.price_mode
       FROM purchase_items i JOIN purchases pu ON pu.id = i.purchase_id
       WHERE i.product_id = ? AND i.revision = pu.revision AND pu.status = 'active' AND pu.is_deleted = 0
       ORDER BY pu.bill_date DESC, pu.id DESC LIMIT 500`,
    )
    .all(productId);
  const changes = db
    .prepare(
      `SELECT c.*, v.color, v.size, v.variant_type, pu.entry_no FROM price_changes c
       JOIN product_variants v ON v.id = c.variant_id
       LEFT JOIN purchases pu ON c.source = 'purchase' AND pu.id = c.ref_id
       WHERE v.product_id = ? ORDER BY c.id DESC LIMIT 200`,
    )
    .all(productId)
    .map((c) => ({ ...c, variant_label: variantLabel(c) }));
  return { lines, changes };
}

module.exports = {
  CHARGE_KINDS,
  meta,
  calculate,
  validate,
  checkBillNo,
  findDuplicate,
  create,
  update,
  cancel,
  editCheck,
  recordPayment,
  addAttachments,
  removeAttachment,
  attachmentFile,
  get,
  list,
  stats,
  payables,
  lineInfo,
  priceHistory,
  advanceAvailable,
  paidOf,
  billNoKey,
  addDays,
  audit,
  money,
  loadVariantInfo,
  placeOfSupply,
  purchaseRow,
  currentItems,
};
