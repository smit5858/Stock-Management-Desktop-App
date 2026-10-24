'use strict';

const crypto = require('crypto');
const path = require('path');
const { newWorkbook, parseCsv, readGrid, writeWorkbook } = require('./sheets');
const { AppError } = require('../errors');
const { validateProduct } = require('../validation/products');
const products = require('./products');
const settings = require('./settings');
const { parseMoney, parseQty, parseRateBp, parseBool, str } = require('./parse');

const MAX_ROWS = 5000;

// Column order for the template and the export. Import matches headers loosely (aliases).
const COLUMNS = [
  { key: 'name', header: 'Name', width: 34, aliases: ['product', 'productname', 'itemname'] },
  { key: 'type', header: 'Type (Stock/Service)', width: 12, aliases: ['type', 'producttype'] },
  { key: 'sku', header: 'SKU', width: 14, aliases: ['code', 'itemcode', 'skucode'] },
  { key: 'barcode', header: 'Barcode', width: 16 },
  { key: 'category', header: 'Category', width: 22 },
  { key: 'sub_category', header: 'Sub-category', width: 18 },
  { key: 'brand', header: 'Brand', width: 14 },
  { key: 'unit', header: 'Unit', width: 8 },
  { key: 'hsn_code', header: 'HSN/SAC', width: 10, aliases: ['hsn', 'sac', 'hsncode'] },
  { key: 'gst', header: 'GST %', width: 8, aliases: ['gst', 'gstrate', 'gstpercent'] },
  {
    key: 'price_includes_gst',
    header: 'Price includes GST (Yes/No)',
    width: 12,
    aliases: ['inclusive', 'priceincludesgst'],
  },
  { key: 'purchase_price', header: 'Purchase price', width: 12, aliases: ['cost', 'costprice'] },
  { key: 'mrp', header: 'MRP', width: 10 },
  {
    key: 'selling_price',
    header: 'Selling price',
    width: 12,
    aliases: ['price', 'saleprice', 'rate'],
  },
  {
    key: 'opening_stock',
    header: 'Opening stock',
    width: 11,
    aliases: ['currentstock', 'stock', 'qty', 'quantity'],
  },
  { key: 'min_stock', header: 'Min stock', width: 10, aliases: ['minimumstock', 'reorderlevel'] },
  { key: 'color', header: 'Colour', width: 10, aliases: ['color'] },
  { key: 'size', header: 'Size', width: 8 },
  { key: 'variant_type', header: 'Variant type', width: 12, aliases: ['varianttype'] },
  { key: 'vehicles', header: 'Vehicles', width: 40, aliases: ['vehicle', 'compatibility', 'fits'] },
  { key: 'rack', header: 'Rack', width: 8, aliases: ['racklocation', 'location', 'shelf'] },
  {
    key: 'warranty',
    header: 'Customer warranty (months)',
    width: 12,
    aliases: ['warranty', 'warrantymonths', 'customerwarranty'],
  },
  {
    key: 'supplier_warranty',
    header: 'Supplier warranty (months)',
    width: 12,
    aliases: ['supplierwarranty', 'supplierwarrantymonths'],
  },
  {
    key: 'warranty_from',
    header: 'Warranty from (Sale/Purchase)',
    width: 14,
    aliases: ['warrantyfrom', 'warrantystart'],
  },
  {
    key: 'track_serials',
    header: 'Track serials (Yes/No)',
    width: 10,
    aliases: ['trackserials', 'serials', 'serialtracking'],
  },
  { key: 'notes', header: 'Notes', width: 30 },
  { key: 'active', header: 'Active (Yes/No)', width: 9, aliases: ['active'] },
];

const norm = (h) =>
  String(h || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');

function columnFor(header) {
  const n = norm(header);
  if (!n) return null;
  return COLUMNS.find((c) => norm(c.header) === n || (c.aliases || []).includes(n)) || null;
}

// ---------------------------------------------------------------- reading files

async function readTable(file) {
  const table = await readGrid(file);
  const header = (table[0] || []).map(columnFor);
  if (!header.some((c) => c && c.key === 'name')) {
    throw new AppError(
      'No "Name" column found. Download the template to see the expected columns.',
      'VALIDATION',
    );
  }
  const rows = [];
  for (let i = 1; i < table.length; i++) {
    const cells = table[i] || [];
    if (cells.every((c) => str(c) === '')) continue;
    const values = {};
    header.forEach((col, j) => {
      if (col) values[col.key] = cells[j];
    });
    rows.push({ row_no: i + 1, values });
  }
  if (rows.length > MAX_ROWS)
    throw new AppError(`Too many rows (max ${MAX_ROWS} per import).`, 'VALIDATION');
  return rows;
}

// ---------------------------------------------------------------- planning

/** "Maruti Suzuki Swift 2018-2024; Make: New Model 2020" → [{make, model, id?, year_from, year_to}] */
function parseVehicles(text, known) {
  const items = str(text)
    .split(/[;\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
  const out = [];
  const errors = [];
  for (const item of items) {
    let name = item;
    let yearFrom = null;
    let yearTo = null;
    const ym = /\s+(\d{4})?\s*-\s*(\d{4})?$/.exec(name) || /\s+(\d{4})$/.exec(name);
    if (ym && (ym[1] || ym[2])) {
      name = name.slice(0, ym.index).trim();
      if (ym[0].includes('-')) {
        yearFrom = ym[1] ? Number(ym[1]) : null;
        yearTo = ym[2] ? Number(ym[2]) : null;
      } else {
        yearFrom = Number(ym[1]);
      }
    }
    let make;
    let model;
    if (name.includes(':')) {
      [make, model] = name.split(':').map((s) => s.trim());
    } else {
      const match = known
        .filter((k) => `${k.make} ${k.model}`.toLowerCase() === name.toLowerCase())
        .at(0);
      if (!match) {
        errors.push(`Unknown vehicle "${name}". Write new ones as "Make: Model".`);
        continue;
      }
      ({ make, model } = match);
    }
    if (!make || !model) {
      errors.push(`Vehicle "${item}" needs a make and a model.`);
      continue;
    }
    out.push({ make, model, year_from: yearFrom, year_to: yearTo });
  }
  return { vehicles: out, errors };
}

function rowProblems(values) {
  const errors = [];
  const money = (k, label, required) => {
    const raw = values[k];
    if (raw === undefined || str(raw) === '') {
      if (required) errors.push(`${label} is required.`);
      return 0;
    }
    const v = parseMoney(raw);
    if (v === null || v < 0) errors.push(`${label} "${raw}" is not a valid amount.`);
    return v ?? 0;
  };
  const qty = (k, label) => {
    const raw = values[k];
    if (raw === undefined || str(raw) === '') return 0;
    const v = parseQty(raw);
    if (v === null || v < 0) errors.push(`${label} "${raw}" is not a valid quantity.`);
    return v ?? 0;
  };
  const variant = {
    sku: str(values.sku),
    barcode: str(values.barcode),
    color: str(values.color),
    size: str(values.size),
    variant_type: str(values.variant_type),
    purchase_price: money('purchase_price', 'Purchase price'),
    mrp: money('mrp', 'MRP'),
    selling_price: money('selling_price', 'Selling price', true),
    opening_stock_milli: qty('opening_stock', 'Opening stock'),
    min_stock_milli: qty('min_stock', 'Min stock'),
  };
  return { variant, errors };
}

function buildPlan(db, rows) {
  const known = db.prepare('SELECT id, make, model FROM vehicle_models WHERE is_deleted = 0').all();
  const activeRates = new Set(settings.listGstRates(db).map((r) => r.rate_bp));
  const existingNames = new Set(
    db.prepare('SELECT lower(name) FROM products WHERE is_deleted = 0').pluck().all(),
  );

  // Group rows into products by name + type.
  const groups = new Map();
  for (const r of rows) {
    const name = str(r.values.name);
    const type = /service/i.test(str(r.values.type)) ? 'service' : 'stock';
    const key = `${name.toLowerCase()}|${type}`;
    if (!groups.has(key)) groups.set(key, { name, type, rows: [] });
    groups.get(key).rows.push(r);
  }

  const preview = [];
  const valid = [];
  const newCategories = new Set();
  const newVehicles = new Set();
  const fileSkus = new Map();
  const fileBarcodes = new Map();

  for (const g of groups.values()) {
    const first = g.rows[0].values;
    const groupErrors = [];
    const rowErrors = g.rows.map(() => []);

    if (!g.name) groupErrors.push('Name is required.');
    else if (existingNames.has(g.name.toLowerCase()))
      groupErrors.push('A product with this name already exists.');

    const gstRaw = first.gst;
    // Blank or "No" = no GST.
    const gst = str(gstRaw) === '' || /^no/i.test(str(gstRaw)) ? 0 : parseRateBp(gstRaw);
    if (gst === null) groupErrors.push(`GST % "${gstRaw}" is not valid (e.g. 18, or leave empty).`);
    else if (gst !== 0 && !activeRates.has(gst))
      groupErrors.push(`GST ${gst / 100}% is not in the Settings rate list.`);

    const vehiclesText = str(first.vehicles);
    const universal = !vehiclesText || /^universal$/i.test(vehiclesText);
    let vehicles = [];
    if (!universal) {
      const parsed = parseVehicles(vehiclesText, known);
      groupErrors.push(...parsed.errors);
      vehicles = parsed.vehicles;
    }

    const variants = g.rows.map((r, i) => {
      const { variant, errors } = rowProblems(r.values);
      rowErrors[i].push(...errors);
      for (const [map, field, label] of [
        [fileSkus, 'sku', 'SKU'],
        [fileBarcodes, 'barcode', 'Barcode'],
      ]) {
        const v = variant[field];
        if (!v) continue;
        const k = v.toLowerCase();
        if (map.has(k)) rowErrors[i].push(`${label} ${v} repeats row ${map.get(k)}.`);
        else map.set(k, r.row_no);
      }
      return variant;
    });

    const hasVariants =
      g.type === 'stock' &&
      (g.rows.length > 1 || variants.some((v) => v.color || v.size || v.variant_type));

    const payload = {
      product_type: g.type,
      name: g.name,
      category_id: null,
      brand: str(first.brand),
      unit: str(first.unit).toLowerCase() || 'pcs',
      hsn_code: str(first.hsn_code),
      gst_rate_bp: gst ?? 0,
      price_includes_gst: parseBool(first.price_includes_gst, true),
      has_variants: hasVariants,
      is_universal: universal,
      // Temporary negative ids: resolved (or created) when the import is committed.
      vehicles: vehicles.map((v, i) => ({
        vehicle_model_id: -(i + 1),
        year_from: v.year_from,
        year_to: v.year_to,
      })),
      rack_location: str(first.rack),
      customer_warranty_months: str(first.warranty) === '' ? 0 : Number(first.warranty),
      supplier_warranty_months:
        str(first.supplier_warranty) === '' ? 0 : Number(first.supplier_warranty),
      warranty_start_basis: /^purchase/i.test(str(first.warranty_from)) ? 'purchase' : 'sale',
      track_serials: g.type === 'stock' && parseBool(first.track_serials, false),
      notes: str(first.notes),
      is_active: parseBool(first.active, true),
      variants,
    };

    // Serial numbers cannot come from a spreadsheet row: import with stock 0, then add the
    // units (with their serials) through Stock adjustment.
    if (payload.track_serials && variants.some((v) => v.opening_stock_milli > 0)) {
      groupErrors.push(
        'Serial-tracked items must be imported with stock 0. Add the units and their serial numbers afterwards with Stock adjustment.',
      );
    }

    let data = null;
    if (g.name) {
      try {
        data = validateProduct(payload, { isNew: true });
      } catch (err) {
        if (!(err instanceof AppError) || !err.fields) throw err;
        for (const [field, message] of Object.entries(err.fields)) {
          const m = /^variants\.(\d+)/.exec(field);
          if (m) rowErrors[Number(m[1])].push(message);
          else groupErrors.push(message);
        }
      }
    }

    // SKU / barcode already in the database.
    variants.forEach((v, i) => {
      if (
        v.sku &&
        db
          .prepare('SELECT 1 FROM product_variants WHERE sku = ? COLLATE NOCASE AND is_deleted = 0')
          .get(v.sku)
      ) {
        rowErrors[i].push(`SKU ${v.sku} already exists.`);
      }
      if (
        v.barcode &&
        db
          .prepare('SELECT 1 FROM product_variants WHERE barcode = ? AND is_deleted = 0')
          .get(v.barcode)
      ) {
        rowErrors[i].push(`Barcode ${v.barcode} already exists.`);
      }
    });

    const ok = groupErrors.length === 0 && rowErrors.every((e) => e.length === 0) && data;
    const category = str(first.category);
    const sub = str(first.sub_category);
    if (ok) {
      valid.push({ data, category, sub, vehicles });
      if (category) newCategories.add(sub ? `${category} › ${sub}` : category);
      vehicles.forEach((v) => newVehicles.add(`${v.make} ${v.model}`));
    }

    g.rows.forEach((r, i) => {
      const v = variants[i];
      preview.push({
        row_no: r.row_no,
        name: g.name,
        type: g.type,
        variant_label: products.variantLabel(v),
        sku: v.sku,
        selling_price: v.selling_price,
        opening_stock_milli: v.opening_stock_milli,
        ok: Boolean(ok),
        errors: [
          ...(i === 0
            ? groupErrors
            : groupErrors.length
              ? ['See the first row of this product.']
              : []),
          ...rowErrors[i],
        ],
      });
    });
  }

  // Report only categories / vehicles that do not exist yet.
  const existingCategory = (label) => {
    const [c, s] = label.split(' › ');
    const top = db
      .prepare(
        'SELECT id FROM product_categories WHERE parent_id IS NULL AND name = ? COLLATE NOCASE AND is_deleted = 0',
      )
      .get(c);
    if (!top) return false;
    if (!s) return true;
    return Boolean(
      db
        .prepare(
          'SELECT 1 FROM product_categories WHERE parent_id = ? AND name = ? COLLATE NOCASE AND is_deleted = 0',
        )
        .get(top.id, s),
    );
  };
  const knownNames = new Set(known.map((k) => `${k.make} ${k.model}`.toLowerCase()));

  return {
    valid,
    summary: {
      total_rows: rows.length,
      ok_rows: preview.filter((p) => p.ok).length,
      error_rows: preview.filter((p) => !p.ok).length,
      products: valid.length,
      variants: valid.reduce((n, v) => n + v.data.variants.length, 0),
      new_categories: [...newCategories].filter((c) => !existingCategory(c)),
      new_vehicles: [...newVehicles].filter((v) => !knownNames.has(v.toLowerCase())),
    },
    preview,
  };
}

// ---------------------------------------------------------------- preview / commit

const pending = new Map(); // token → { plan, at }

async function preview(db, file) {
  const rows = await readTable(file);
  const plan = buildPlan(db, rows);
  for (const [t, p] of pending) if (Date.now() - p.at > 30 * 60 * 1000) pending.delete(t);
  const token = crypto.randomBytes(12).toString('hex');
  pending.set(token, { plan, at: Date.now() });
  return { token, file_name: path.basename(file), summary: plan.summary, rows: plan.preview };
}

/** Creates all valid products in ONE transaction: everything is imported, or nothing. */
function commit(db, { token }) {
  const entry = pending.get(token);
  if (!entry)
    throw new AppError('This import preview has expired. Please choose the file again.', 'EXPIRED');
  const { valid } = entry.plan;
  if (valid.length === 0) throw new AppError('There are no valid rows to import.', 'VALIDATION');

  const result = db.transaction(() => {
    for (const item of valid) {
      const data = structuredClone(item.data);
      if (item.category) {
        const top = products.createCategory(db, { name: item.category });
        data.category_id = item.sub
          ? products.createCategory(db, { name: item.sub, parent_id: top.id }).id
          : top.id;
      }
      data.vehicles = data.vehicles.map((v, i) => ({
        ...v,
        vehicle_model_id: products.createVehicle(db, item.vehicles[i]).id,
      }));
      products.insertProduct(db, data);
    }
    return {
      products: valid.length,
      variants: valid.reduce((n, v) => n + v.data.variants.length, 0),
    };
  })();
  pending.delete(token);
  return result;
}

// ---------------------------------------------------------------- export / template

function styleSheet(ws) {
  ws.columns = COLUMNS.map((c) => ({ header: c.header, key: c.key, width: c.width }));
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE0E7FF' } };
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  for (const key of ['purchase_price', 'mrp', 'selling_price']) ws.getColumn(key).numFmt = '0.00';
}

async function exportXlsx(db, file) {
  const rows = db
    .prepare(
      `SELECT p.id, p.product_type, p.name, p.brand, p.unit, p.hsn_code, p.gst_rate_bp,
         p.price_includes_gst, p.is_universal, p.rack_location, p.customer_warranty_months, p.supplier_warranty_months,
         p.warranty_start_basis, p.track_serials, p.notes, p.is_active,
         c.name AS category, pc.name AS parent_category,
         v.sku, v.barcode, v.color, v.size, v.variant_type, v.purchase_price, v.mrp, v.selling_price,
         v.min_stock_milli,
         (SELECT COALESCE(SUM(qty_milli), 0) FROM stock_movements
           WHERE variant_id = v.id AND location = 'main') AS stock_milli
       FROM products p JOIN product_variants v ON v.product_id = p.id AND v.is_deleted = 0
       LEFT JOIN product_categories c ON c.id = p.category_id
       LEFT JOIN product_categories pc ON pc.id = c.parent_id
       WHERE p.is_deleted = 0 ORDER BY p.name COLLATE NOCASE, v.sort_order`,
    )
    .all();
  const vehiclesOf = db.prepare(
    `SELECT vm.make, vm.model, pv.year_from, pv.year_to FROM product_vehicles pv
     JOIN vehicle_models vm ON vm.id = pv.vehicle_model_id WHERE pv.product_id = ?`,
  );

  const wb = newWorkbook();
  const ws = wb.addWorksheet('Products');
  styleSheet(ws);
  ws.getCell('O1').value = 'Current stock'; // imported back as opening stock
  for (const r of rows) {
    const years = (v) =>
      v.year_from || v.year_to ? ` ${v.year_from ?? ''}-${v.year_to ?? ''}` : '';
    ws.addRow({
      name: r.name,
      type: r.product_type === 'service' ? 'Service' : 'Stock',
      sku: r.sku,
      barcode: r.barcode || '',
      category: r.parent_category || r.category || '',
      sub_category: r.parent_category ? r.category : '',
      brand: r.brand || '',
      unit: r.unit,
      hsn_code: r.hsn_code || '',
      gst: r.gst_rate_bp / 100,
      price_includes_gst: r.price_includes_gst ? 'Yes' : 'No',
      purchase_price: r.purchase_price / 100,
      mrp: r.mrp / 100,
      selling_price: r.selling_price / 100,
      opening_stock: r.stock_milli / 1000,
      min_stock: r.min_stock_milli / 1000,
      color: r.color || '',
      size: r.size || '',
      variant_type: r.variant_type || '',
      vehicles: r.is_universal
        ? 'Universal'
        : vehiclesOf
            .all(r.id)
            .map((v) => `${v.make} ${v.model}${years(v)}`)
            .join('; '),
      rack: r.rack_location || '',
      warranty: r.customer_warranty_months,
      supplier_warranty: r.supplier_warranty_months,
      warranty_from: r.warranty_start_basis === 'purchase' ? 'Purchase' : 'Sale',
      track_serials: r.track_serials ? 'Yes' : 'No',
      notes: r.notes || '',
      active: r.is_active ? 'Yes' : 'No',
    });
  }
  await writeWorkbook(wb, file);
  return { rows: rows.length };
}

async function writeTemplate(file) {
  const wb = newWorkbook();
  const ws = wb.addWorksheet('Products');
  styleSheet(ws);
  const base = {
    type: 'Stock',
    category: 'Seat Covers',
    brand: 'Autoform',
    unit: 'set',
    hsn_code: '8708',
    gst: 18,
    price_includes_gst: 'Yes',
    vehicles: 'Maruti Suzuki Swift 2018-2024; Hyundai Creta',
    rack: 'A-3',
    warranty: 6,
    warranty_from: 'Sale',
    track_serials: 'No',
    active: 'Yes',
  };
  ws.addRow({
    ...base,
    name: 'Premium Seat Cover',
    color: 'Black',
    purchase_price: 2200,
    mrp: 3999,
    selling_price: 3499,
    opening_stock: 5,
    min_stock: 2,
  });
  ws.addRow({
    ...base,
    name: 'Premium Seat Cover',
    color: 'Beige',
    purchase_price: 2200,
    mrp: 3999,
    selling_price: 3499,
    opening_stock: 3,
    min_stock: 2,
  });
  ws.addRow({
    name: 'Android Music System 9 inch',
    type: 'Stock',
    category: 'Music Systems & Speakers',
    brand: 'Blaupunkt',
    unit: 'pcs',
    hsn_code: '8527',
    gst: 18,
    price_includes_gst: 'Yes',
    purchase_price: 6500,
    mrp: 11999,
    selling_price: 9999,
    opening_stock: 0,
    vehicles: 'Maruti Suzuki Swift 2018-',
    warranty: 12,
    supplier_warranty: 12,
    warranty_from: 'Sale',
    track_serials: 'Yes',
    active: 'Yes',
  });
  ws.addRow({
    name: 'Seat Cover Fitting',
    type: 'Service',
    category: 'Fitting Charges',
    unit: 'pcs',
    hsn_code: '998714',
    gst: 18,
    price_includes_gst: 'Yes',
    selling_price: 300,
    vehicles: 'Universal',
    active: 'Yes',
  });
  const notes = wb.addWorksheet('How to fill');
  notes.columns = [{ width: 110 }];
  [
    'One row per product. For variants (colour/size/type), repeat the same Name on several rows.',
    'Type: Stock (default) or Service (fitting / installation charges, no stock).',
    'SKU: leave empty to generate one automatically.',
    'GST %: leave empty (or write No) for items without GST; otherwise one of the rates in Settings → GST rates.',
    'Prices are in rupees (e.g. 3499 or 3499.50). Selling price cannot be more than MRP.',
    'Vehicles: "Universal", or a list separated by ";" e.g. "Maruti Suzuki Swift 2018-2024; Hyundai Creta".',
    'A vehicle that is not in the app yet: write it as "Make: Model", e.g. "Tata: Sierra 2025".',
    'Missing categories and sub-categories are created automatically.',
    'Track serials = Yes: import with Opening stock 0, then add the units and their serial numbers with Stock adjustment.',
    'Warranty from: Sale (default) or Purchase. Supplier warranty is counted from the purchase date.',
  ].forEach((t) => notes.addRow([t]));
  await writeWorkbook(wb, file);
}

module.exports = {
  preview,
  commit,
  exportXlsx,
  writeTemplate,
  parseCsv,
  parseVehicles,
  buildPlan,
  COLUMNS,
};
