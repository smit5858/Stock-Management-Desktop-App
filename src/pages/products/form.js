// Converts between the API product shape (integers) and the drawer form (strings in inputs).
import { paiseToInput, parseMoney } from '../../utils/money';
import { formatQty, parseQty } from '../../utils/qty';

export function emptyVariant() {
  return {
    key: crypto.randomUUID(),
    id: null,
    color: '',
    size: '',
    variant_type: '',
    sku: '',
    barcode: '',
    purchase_price: '',
    mrp: '',
    selling_price: '',
    opening_stock: '',
    min_stock: '',
    stock_milli: 0,
    serials: null, // { entries: [{serial_no, serial_no_2}], auto: {prefix, count} | null }
    is_active: true,
  };
}

export function emptyForm() {
  return {
    id: null,
    product_type: 'stock',
    name: '',
    category_id: '',
    brand: '',
    unit: 'pcs',
    hsn_code: '',
    gst_rate_bp: '0', // No GST unless chosen (many items are sold without GST)
    price_includes_gst: true,
    has_variants: false,
    is_universal: true,
    vehicles: [],
    rack_location: '',
    customer_warranty_months: '',
    supplier_warranty_months: '',
    warranty_start_basis: 'sale',
    warranty_covered: '',
    warranty_not_covered: '',
    fitting_variant_id: '',
    fitting_charge: '',
    track_serials: false,
    image_path: null,
    image_url: null,
    notes: '',
    is_active: true,
    variants: [emptyVariant()],
  };
}

const qtyInput = (milli) => (milli ? formatQty(milli).replace(/,/g, '') : '');

export function toForm(p, { duplicate = false } = {}) {
  return {
    id: duplicate ? null : p.id,
    product_type: p.product_type,
    name: duplicate ? `${p.name} (copy)` : p.name,
    category_id: p.category_id ? String(p.category_id) : '',
    brand: p.brand || '',
    unit: p.unit,
    hsn_code: p.hsn_code || '',
    gst_rate_bp: String(p.gst_rate_bp),
    price_includes_gst: Boolean(p.price_includes_gst),
    has_variants: Boolean(p.has_variants),
    is_universal: Boolean(p.is_universal),
    vehicles: p.vehicles.map((v) => ({
      key: crypto.randomUUID(),
      vehicle_model_id: String(v.vehicle_model_id),
      year_from: v.year_from ? String(v.year_from) : '',
      year_to: v.year_to ? String(v.year_to) : '',
    })),
    rack_location: p.rack_location || '',
    customer_warranty_months: p.customer_warranty_months ? String(p.customer_warranty_months) : '',
    supplier_warranty_months: p.supplier_warranty_months ? String(p.supplier_warranty_months) : '',
    warranty_start_basis: p.warranty_start_basis || 'sale',
    warranty_covered: p.warranty_covered || '',
    warranty_not_covered: p.warranty_not_covered || '',
    fitting_variant_id: p.fitting_variant_id ? String(p.fitting_variant_id) : '',
    fitting_charge: p.fitting_charge == null ? '' : paiseToInput(p.fitting_charge),
    // A duplicate starts without serials (they belong to the original's units).
    track_serials: Boolean(p.track_serials),
    serials_total: duplicate ? 0 : p.serials_total || 0,
    was_tracked: duplicate ? false : Boolean(p.track_serials),
    image_path: p.image_path,
    image_url: p.image_url,
    notes: p.notes || '',
    is_active: duplicate ? true : Boolean(p.is_active),
    variants: p.variants.map((v) => ({
      key: crypto.randomUUID(),
      id: duplicate ? null : v.id,
      color: v.color || '',
      size: v.size || '',
      variant_type: v.variant_type || '',
      sku: duplicate ? '' : v.sku,
      barcode: duplicate ? '' : v.barcode || '',
      purchase_price: paiseToInput(v.purchase_price),
      mrp: v.mrp ? paiseToInput(v.mrp) : '',
      selling_price: paiseToInput(v.selling_price),
      opening_stock: '',
      min_stock: qtyInput(v.min_stock_milli),
      stock_milli: duplicate ? 0 : v.stock_milli,
      serials: null,
      is_active: Boolean(v.is_active),
    })),
  };
}

/** Returns { payload, errors }. Errors use the same keys as the server ('variants.0.mrp'). */
export function toPayload(form) {
  const errors = {};
  const money = (value, key, required) => {
    if (value === '' || value == null) {
      if (required) errors[key] = 'Required.';
      return 0;
    }
    const v = parseMoney(value);
    if (v === null || v < 0) errors[key] = 'Invalid amount.';
    return v ?? 0;
  };
  const qty = (value, key) => {
    if (value === '' || value == null) return 0;
    const v = parseQty(value);
    if (v === null || v < 0) errors[key] = 'Invalid quantity.';
    return v ?? 0;
  };

  if (!form.name.trim()) errors.name = 'Name is required.';
  const service = form.product_type === 'service';

  const payload = {
    product_type: form.product_type,
    name: form.name.trim(),
    category_id: form.category_id ? Number(form.category_id) : null,
    brand: form.brand.trim(),
    unit: form.unit,
    hsn_code: form.hsn_code.trim(),
    gst_rate_bp: Number(form.gst_rate_bp),
    price_includes_gst: form.price_includes_gst,
    has_variants: !service && form.has_variants,
    is_universal: service || form.is_universal,
    vehicles: form.vehicles.map((v) => ({
      vehicle_model_id: v.vehicle_model_id ? Number(v.vehicle_model_id) : null,
      year_from: v.year_from ? Number(v.year_from) : null,
      year_to: v.year_to ? Number(v.year_to) : null,
    })),
    rack_location: form.rack_location.trim(),
    customer_warranty_months:
      form.customer_warranty_months === '' ? 0 : Number(form.customer_warranty_months),
    supplier_warranty_months:
      form.supplier_warranty_months === '' ? 0 : Number(form.supplier_warranty_months),
    warranty_start_basis: form.warranty_start_basis,
    warranty_covered: form.warranty_covered.trim(),
    warranty_not_covered: form.warranty_not_covered.trim(),
    fitting_variant_id:
      !service && form.fitting_variant_id ? Number(form.fitting_variant_id) : null,
    fitting_charge:
      !service && form.fitting_variant_id && form.fitting_charge !== ''
        ? money(form.fitting_charge, 'fitting_charge')
        : null,
    track_serials: !service && form.track_serials,
    image_path: form.image_path,
    notes: form.notes.trim(),
    is_active: form.is_active,
    variants: form.variants.map((v, i) => ({
      id: v.id,
      color: v.color.trim(),
      size: v.size.trim(),
      variant_type: v.variant_type.trim(),
      sku: v.sku.trim(),
      barcode: v.barcode.trim(),
      purchase_price: money(v.purchase_price, `variants.${i}.purchase_price`),
      mrp: money(v.mrp, `variants.${i}.mrp`),
      selling_price: money(v.selling_price, `variants.${i}.selling_price`, true),
      opening_stock_milli: v.id ? 0 : qty(v.opening_stock, `variants.${i}.opening_stock_milli`),
      serials: v.serials,
      min_stock_milli: qty(v.min_stock, `variants.${i}.min_stock_milli`),
      is_active: v.is_active,
    })),
  };
  payload.variants.forEach((v, i) => {
    if (!errors[`variants.${i}.selling_price`] && v.mrp > 0 && v.selling_price > v.mrp) {
      errors[`variants.${i}.selling_price`] = 'Cannot be more than MRP.';
    }
  });
  return { payload, errors };
}

/** Number of units a serial input stands for (typed/pasted + auto-generated). */
export function serialCount(serials) {
  if (!serials) return 0;
  return serials.entries.length + (serials.auto ? serials.auto.count : 0);
}
