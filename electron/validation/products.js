'use strict';

const { AppError } = require('../errors');
const { isValidImagePath } = require('../dataFiles');
const { str } = require('../services/parse');

const UNITS = ['pcs', 'set', 'pair', 'box', 'meter', 'litre'];
const MAX_PRICE = 1e11; // ₹100 crore in paise: guards against typos and overflow
const MAX_QTY = 1e12;

const isInt = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;
const isBool = (v) => typeof v === 'boolean';
const months = (v) => (v == null || v === '' ? 0 : Number(v));

/**
 * Serial numbers typed / pasted / auto-generated for one variant:
 * { entries: [{ serial_no, serial_no_2 }], auto: { prefix, count } | null } → normalised.
 * Content checks (duplicates, existing) happen in services/serials.js.
 */
function normaliseSerialInput(input) {
  const raw = input || {};
  const entries = (Array.isArray(raw.entries) ? raw.entries : []).map((e) => ({
    serial_no: str(e && e.serial_no),
    serial_no_2: str(e && e.serial_no_2),
  }));
  const auto =
    raw.auto && Number(raw.auto.count) > 0
      ? { prefix: str(raw.auto.prefix), count: Number(raw.auto.count) }
      : null;
  return { entries, auto, count: entries.length + (auto ? auto.count : 0) };
}

/**
 * Validates and normalises a product payload from the drawer (or the importer).
 * Throws AppError with `fields` (keys like 'name', 'variants.0.sku') on problems.
 * DB-dependent checks (category exists, SKU unique, GST rate active) happen in the service.
 */
function validateProduct(input, { isNew }) {
  const errors = {};
  const p = input || {};

  const out = {
    product_type: p.product_type === 'service' ? 'service' : 'stock',
    name: str(p.name),
    category_id: p.category_id == null || p.category_id === '' ? null : Number(p.category_id),
    brand: str(p.brand),
    unit: str(p.unit) || 'pcs',
    hsn_code: str(p.hsn_code),
    gst_rate_bp: p.gst_rate_bp,
    price_includes_gst: p.price_includes_gst !== false,
    has_variants: Boolean(p.has_variants),
    is_universal: p.is_universal !== false,
    rack_location: str(p.rack_location),
    customer_warranty_months: months(p.customer_warranty_months),
    supplier_warranty_months: months(p.supplier_warranty_months),
    warranty_start_basis: p.warranty_start_basis === 'purchase' ? 'purchase' : 'sale',
    // Printed on claim slips and warranty cards.
    warranty_covered: str(p.warranty_covered),
    warranty_not_covered: str(p.warranty_not_covered),
    track_serials: Boolean(p.track_serials),
    // Default fitting service (a service variant) added below this product on a bill.
    fitting_variant_id:
      p.fitting_variant_id == null || p.fitting_variant_id === ''
        ? null
        : Number(p.fitting_variant_id),
    fitting_charge: p.fitting_charge == null || p.fitting_charge === '' ? null : p.fitting_charge,
    image_path: p.image_path ? String(p.image_path) : null,
    notes: str(p.notes),
    is_active: p.is_active !== false,
    vehicles: Array.isArray(p.vehicles) ? p.vehicles : [],
    variants: Array.isArray(p.variants) ? p.variants : [],
  };
  const service = out.product_type === 'service';

  if (!out.name) errors.name = 'Name is required.';
  else if (out.name.length > 150) errors.name = 'Name is too long (max 150).';
  if (out.category_id !== null && !Number.isInteger(out.category_id))
    errors.category_id = 'Invalid category.';
  if (out.brand.length > 60) errors.brand = 'Brand is too long (max 60).';
  if (!UNITS.includes(out.unit)) errors.unit = 'Choose a unit from the list.';
  if (out.hsn_code && !/^\d{4,8}$/.test(out.hsn_code)) {
    errors.hsn_code = `${service ? 'SAC' : 'HSN'} code must be 4–8 digits.`;
  }
  if (!isInt(out.gst_rate_bp, 0, 10000)) errors.gst_rate_bp = 'Choose a GST rate.';
  if (out.rack_location.length > 40) errors.rack_location = 'Too long (max 40).';
  if (!isInt(out.customer_warranty_months, 0, 240)) {
    errors.customer_warranty_months = 'Warranty: 0–240 months.';
  }
  if (!isInt(out.supplier_warranty_months, 0, 240)) {
    errors.supplier_warranty_months = 'Warranty: 0–240 months.';
  }
  if (out.warranty_covered.length > 600) errors.warranty_covered = 'Too long (max 600).';
  if (out.warranty_not_covered.length > 600) errors.warranty_not_covered = 'Too long (max 600).';
  if (out.fitting_variant_id !== null && !Number.isInteger(out.fitting_variant_id)) {
    errors.fitting_variant_id = 'Choose a fitting service.';
  }
  if (out.fitting_charge !== null && !isInt(out.fitting_charge, 0, MAX_PRICE)) {
    errors.fitting_charge = 'Invalid amount.';
  }
  if (out.fitting_variant_id === null) out.fitting_charge = null;
  if (out.image_path && !isValidImagePath(out.image_path)) errors.image_path = 'Invalid image.';
  if (out.notes.length > 1000) errors.notes = 'Notes are too long (max 1000).';
  for (const k of ['price_includes_gst', 'is_universal', 'is_active']) {
    if (!isBool(out[k])) errors[k] = 'Invalid value.';
  }

  if (service) {
    out.has_variants = false;
    out.is_universal = true;
    out.vehicles = [];
    out.track_serials = false;
    out.fitting_variant_id = null;
    out.fitting_charge = null;
    out.unit = UNITS.includes(out.unit) ? out.unit : 'pcs';
  }

  // Vehicles
  if (!out.is_universal) {
    if (out.vehicles.length === 0)
      errors.vehicles = 'Add at least one vehicle, or mark the product as universal.';
    const seen = new Set();
    out.vehicles = out.vehicles.map((v, i) => {
      const row = {
        vehicle_model_id: Number(v.vehicle_model_id),
        year_from: v.year_from === '' || v.year_from == null ? null : Number(v.year_from),
        year_to: v.year_to === '' || v.year_to == null ? null : Number(v.year_to),
      };
      if (!Number.isInteger(row.vehicle_model_id)) errors[`vehicles.${i}`] = 'Choose a vehicle.';
      else if (seen.has(row.vehicle_model_id))
        errors[`vehicles.${i}`] = 'This vehicle is listed twice.';
      seen.add(row.vehicle_model_id);
      for (const k of ['year_from', 'year_to']) {
        if (row[k] !== null && !isInt(row[k], 1900, 2200))
          errors[`vehicles.${i}`] = 'Years must be like 2018.';
      }
      if (row.year_from && row.year_to && row.year_from > row.year_to) {
        errors[`vehicles.${i}`] = '"From" year is after "to" year.';
      }
      return row;
    });
  } else {
    out.vehicles = [];
  }

  // Variants
  if (out.variants.length === 0) errors.variants = 'At least one price row is required.';
  if (!out.has_variants && out.variants.length > 1)
    errors.variants = 'Turn on variants to add more than one.';
  const combos = new Set();
  out.variants = out.variants.map((v, i) => {
    const row = {
      id: v.id == null ? null : Number(v.id),
      sku: str(v.sku),
      barcode: str(v.barcode),
      color: out.has_variants ? str(v.color) : '',
      size: out.has_variants ? str(v.size) : '',
      variant_type: out.has_variants ? str(v.variant_type) : '',
      purchase_price: v.purchase_price ?? 0,
      mrp: v.mrp ?? 0,
      selling_price: v.selling_price,
      min_stock_milli: service ? 0 : (v.min_stock_milli ?? 0),
      opening_stock_milli: service ? 0 : (v.opening_stock_milli ?? 0),
      is_active: v.is_active !== false,
      serials: out.track_serials ? normaliseSerialInput(v.serials) : null,
    };
    const f = (name) => `variants.${i}.${name}`;
    // Serial-tracked: opening stock is exactly the number of serials entered.
    if (row.serials) row.opening_stock_milli = row.serials.count * 1000;
    if (row.sku.length > 40 || /\s/.test(row.sku)) errors[f('sku')] = 'SKU: no spaces, max 40.';
    if (row.barcode && !/^[A-Za-z0-9-]{3,48}$/.test(row.barcode))
      errors[f('barcode')] = 'Barcode: 3–48 letters/digits.';
    for (const k of ['color', 'size', 'variant_type']) {
      if (row[k].length > 40) errors[f(k)] = 'Too long (max 40).';
    }
    if (out.has_variants) {
      if (!row.color && !row.size && !row.variant_type)
        errors[f('color')] = 'Fill colour, size or type.';
      const key = [row.color, row.size, row.variant_type].join('|').toLowerCase();
      if (combos.has(key)) errors[f('color')] = 'Duplicate variant.';
      combos.add(key);
    }
    for (const k of ['purchase_price', 'mrp']) {
      if (!isInt(row[k], 0, MAX_PRICE)) errors[f(k)] = 'Invalid amount.';
    }
    if (!isInt(row.selling_price, 0, MAX_PRICE))
      errors[f('selling_price')] = 'Selling price is required.';
    else if (row.mrp > 0 && row.selling_price > row.mrp)
      errors[f('selling_price')] = 'Cannot be more than MRP.';
    if (!isInt(row.min_stock_milli, 0, MAX_QTY)) errors[f('min_stock_milli')] = 'Invalid quantity.';
    if (!isInt(row.opening_stock_milli, 0, MAX_QTY))
      errors[f('opening_stock_milli')] = 'Invalid quantity.';
    if (row.id !== null && !Number.isInteger(row.id)) errors[f('sku')] = 'Invalid variant.';
    if (isNew && row.id !== null) errors[f('sku')] = 'Invalid variant.';
    return row;
  });

  if (Object.keys(errors).length) {
    const first = Object.values(errors)[0];
    throw new AppError(`Please check the form: ${first}`, 'VALIDATION', errors);
  }
  return out;
}

module.exports = { validateProduct, normaliseSerialInput, UNITS };
