'use strict';

const { AppError } = require('../errors');
const { validateProduct, UNITS } = require('../validation/products');
const settings = require('./settings');
const { todayISO, str } = require('./parse');
const serials = require('./serials');

const STOCK_BY_VARIANT =
  "(SELECT variant_id, SUM(qty_milli) AS stock FROM stock_movements WHERE location = 'main' GROUP BY variant_id)";

function variantLabel(v) {
  return [v.color, v.size, v.variant_type].filter(Boolean).join(' / ');
}

function imageUrl(rel) {
  return rel ? `app-data://files/${rel}` : null;
}

function likeArg(word) {
  return `%${word.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

// ---------------------------------------------------------------- reference data

function meta(db) {
  return {
    categories: db
      .prepare(
        'SELECT id, parent_id, name FROM product_categories WHERE is_deleted = 0 ORDER BY sort_order, name COLLATE NOCASE',
      )
      .all(),
    brands: db
      .prepare(
        "SELECT DISTINCT brand FROM products WHERE is_deleted = 0 AND brand <> '' ORDER BY brand COLLATE NOCASE",
      )
      .pluck()
      .all(),
    vehicles: db
      .prepare(
        'SELECT id, make, model FROM vehicle_models WHERE is_deleted = 0 ORDER BY make COLLATE NOCASE, model COLLATE NOCASE',
      )
      .all(),
    units: UNITS,
    gst_rates: settings.listGstRates(db),
    // For the "default fitting" picker on stock products.
    services: db
      .prepare(
        `SELECT v.id AS variant_id, p.id AS product_id, p.name, v.selling_price,
           v.color, v.size, v.variant_type
         FROM product_variants v JOIN products p ON p.id = v.product_id
         WHERE p.product_type = 'service' AND p.is_deleted = 0 AND p.is_active = 1
           AND v.is_deleted = 0 AND v.is_active = 1
         ORDER BY p.name COLLATE NOCASE`,
      )
      .all()
      .map((r) => ({ ...r, variant_label: variantLabel(r) })),
  };
}

function createCategory(db, { name, parent_id }) {
  const clean = str(name);
  if (!clean || clean.length > 60) {
    throw new AppError('Category name: 1–60 characters.', 'VALIDATION', { name: 'Required.' });
  }
  const parentId = parent_id == null || parent_id === '' ? null : Number(parent_id);
  if (parentId !== null) {
    const parent = db
      .prepare('SELECT parent_id FROM product_categories WHERE id = ? AND is_deleted = 0')
      .get(parentId);
    if (!parent) throw new AppError('Parent category not found.', 'NOT_FOUND');
    if (parent.parent_id !== null)
      throw new AppError('Sub-categories cannot have their own sub-categories.');
  }
  const existing = db
    .prepare(
      'SELECT id FROM product_categories WHERE COALESCE(parent_id, 0) = ? AND name = ? COLLATE NOCASE AND is_deleted = 0',
    )
    .get(parentId ?? 0, clean);
  if (existing) return { id: existing.id, created: false };
  const id = db
    .prepare('INSERT INTO product_categories (parent_id, name, sort_order) VALUES (?, ?, 100)')
    .run(parentId, clean).lastInsertRowid;
  return { id: Number(id), created: true };
}

function createVehicle(db, { make, model }) {
  const m = str(make);
  const mo = str(model);
  if (!m || !mo || m.length > 40 || mo.length > 60) {
    throw new AppError('Enter the make (e.g. Maruti Suzuki) and model (e.g. Swift).', 'VALIDATION');
  }
  const existing = db
    .prepare(
      'SELECT id, make, model FROM vehicle_models WHERE make = ? COLLATE NOCASE AND model = ? COLLATE NOCASE AND is_deleted = 0',
    )
    .get(m, mo);
  if (existing) return existing;
  const id = db
    .prepare('INSERT INTO vehicle_models (make, model) VALUES (?, ?)')
    .run(m, mo).lastInsertRowid;
  return { id: Number(id), make: m, model: mo };
}

// ---------------------------------------------------------------- list / stats

const BASE_SELECT = `
  SELECT p.id, p.product_type, p.name, p.brand, p.unit, p.gst_rate_bp, p.has_variants, p.track_serials,
    p.is_universal, p.image_path, p.rack_location, p.is_active, p.updated_at, p.category_id,
    c.name AS category_name, pc.name AS parent_category_name,
    agg.variant_count, agg.stock_milli, agg.min_milli, agg.min_price, agg.max_price, agg.mrp,
    agg.stock_value, agg.sku,
    (SELECT group_concat(vm.make || ' ' || vm.model, ', ') FROM product_vehicles pv
       JOIN vehicle_models vm ON vm.id = pv.vehicle_model_id WHERE pv.product_id = p.id) AS vehicles_text,
    CASE
      WHEN p.product_type = 'service' THEN 'service'
      WHEN agg.stock_milli <= 0 THEN 'out'
      WHEN agg.min_milli > 0 AND agg.stock_milli <= agg.min_milli THEN 'low'
      ELSE 'in'
    END AS stock_status
  FROM products p
  JOIN (
    SELECT v.product_id, COUNT(*) AS variant_count,
      COALESCE(SUM(s.stock), 0) AS stock_milli,
      SUM(v.min_stock_milli) AS min_milli,
      MIN(v.selling_price) AS min_price, MAX(v.selling_price) AS max_price, MAX(v.mrp) AS mrp,
      (SUM(MAX(COALESCE(s.stock, 0), 0) * v.purchase_price) + 500) / 1000 AS stock_value,
      CASE WHEN COUNT(*) = 1 THEN MIN(v.sku) END AS sku
    FROM product_variants v LEFT JOIN ${STOCK_BY_VARIANT} s ON s.variant_id = v.id
    WHERE v.is_deleted = 0
    GROUP BY v.product_id
  ) agg ON agg.product_id = p.id
  LEFT JOIN product_categories c ON c.id = p.category_id
  LEFT JOIN product_categories pc ON pc.id = c.parent_id`;

const SORTS = {
  name: 't.name COLLATE NOCASE',
  stock: 't.stock_milli',
  price: 't.min_price',
  value: 't.stock_value',
  updated: 't.updated_at',
};

function buildFilter(params = {}) {
  const where = ['p.is_deleted = 0'];
  const args = [];

  const active = params.active || 'active';
  if (active === 'active') where.push('p.is_active = 1');
  else if (active === 'inactive') where.push('p.is_active = 0');

  if (params.product_type === 'stock' || params.product_type === 'service') {
    where.push('p.product_type = ?');
    args.push(params.product_type);
  }
  if (Number.isInteger(params.category_id)) {
    where.push(
      'p.category_id IN (SELECT id FROM product_categories WHERE id = ? OR parent_id = ?)',
    );
    args.push(params.category_id, params.category_id);
  }
  if (params.brand) {
    where.push('p.brand = ? COLLATE NOCASE');
    args.push(String(params.brand));
  }
  if (Number.isInteger(params.vehicle_model_id)) {
    where.push(
      '(p.is_universal = 1 OR EXISTS (SELECT 1 FROM product_vehicles pv WHERE pv.product_id = p.id AND pv.vehicle_model_id = ?))',
    );
    args.push(params.vehicle_model_id);
  }

  const words = str(params.search).split(/\s+/).filter(Boolean).slice(0, 6);
  for (const word of words) {
    const like = likeArg(word);
    where.push(`(
      p.name LIKE ? ESCAPE '\\' OR p.brand LIKE ? ESCAPE '\\' OR c.name LIKE ? ESCAPE '\\'
      OR EXISTS (SELECT 1 FROM product_variants v2 WHERE v2.product_id = p.id AND v2.is_deleted = 0
        AND (v2.sku LIKE ? ESCAPE '\\' OR v2.barcode LIKE ? ESCAPE '\\' OR v2.color LIKE ? ESCAPE '\\'
             OR v2.size LIKE ? ESCAPE '\\' OR v2.variant_type LIKE ? ESCAPE '\\'))
      OR EXISTS (SELECT 1 FROM product_vehicles pv JOIN vehicle_models vm ON vm.id = pv.vehicle_model_id
        WHERE pv.product_id = p.id AND (vm.make || ' ' || vm.model) LIKE ? ESCAPE '\\')
    )`);
    args.push(like, like, like, like, like, like, like, like, like);
  }

  const outer = [];
  const outerArgs = [];
  if (['in', 'low', 'out', 'service'].includes(params.stock_status)) {
    outer.push('t.stock_status = ?');
    outerArgs.push(params.stock_status);
  }

  return {
    sql: `SELECT * FROM (${BASE_SELECT} WHERE ${where.join(' AND ')}) t${outer.length ? ` WHERE ${outer.join(' AND ')}` : ''}`,
    args: [...args, ...outerArgs],
  };
}

function list(db, params = {}) {
  const { sql, args } = buildFilter(params);
  const sort = SORTS[params.sort] || SORTS.name;
  const dir = params.dir === 'desc' ? 'DESC' : 'ASC';
  const pageSize = Math.min(Math.max(Number(params.page_size) || 50, 1), 200);
  const page = Math.max(Number(params.page) || 1, 1);

  const total = db
    .prepare(`SELECT COUNT(*) FROM (${sql})`)
    .pluck()
    .get(...args);
  const rows = db
    .prepare(`${sql} ORDER BY ${sort} ${dir}, t.id ${dir} LIMIT ? OFFSET ?`)
    .all(...args, pageSize, (page - 1) * pageSize)
    .map((r) => ({ ...r, image_url: imageUrl(r.image_path) }));
  return { rows, total, page, page_size: pageSize };
}

function stats(db) {
  const { sql, args } = buildFilter({ active: 'active' });
  return db
    .prepare(
      `SELECT COUNT(*) AS total_products,
         COALESCE(SUM(stock_value), 0) AS stock_value,
         COALESCE(SUM(stock_status = 'low'), 0) AS low_count,
         COALESCE(SUM(stock_status = 'out'), 0) AS out_count
       FROM (${sql})`,
    )
    .get(...args);
}

// ---------------------------------------------------------------- read one

function variantStock(db, variantId) {
  return db
    .prepare(
      "SELECT COALESCE(SUM(qty_milli), 0) FROM stock_movements WHERE variant_id = ? AND location = 'main'",
    )
    .pluck()
    .get(variantId);
}

function get(db, id) {
  const product = db
    .prepare(
      `SELECT p.*, c.name AS category_name, c.parent_id AS category_parent_id
       FROM products p LEFT JOIN product_categories c ON c.id = p.category_id
       WHERE p.id = ? AND p.is_deleted = 0`,
    )
    .get(id);
  if (!product) throw new AppError('Product not found.', 'NOT_FOUND');

  const variants = db
    .prepare(
      `SELECT v.*, COALESCE(s.stock, 0) AS stock_milli
       FROM product_variants v LEFT JOIN ${STOCK_BY_VARIANT} s ON s.variant_id = v.id
       WHERE v.product_id = ? AND v.is_deleted = 0 ORDER BY v.sort_order, v.id`,
    )
    .all(id)
    .map((v) => ({ ...v, label: variantLabel(v) }));
  const serialCounts = Object.fromEntries(
    db
      .prepare(
        "SELECT variant_id, COUNT(*) AS n FROM product_serials WHERE product_id = ? AND status = 'in_stock' GROUP BY variant_id",
      )
      .all(id)
      .map((r) => [r.variant_id, r.n]),
  );
  for (const v of variants) v.serials_in_stock = serialCounts[v.id] || 0;
  const serialsTotal = db
    .prepare('SELECT COUNT(*) FROM product_serials WHERE product_id = ?')
    .pluck()
    .get(id);

  const vehicles = db
    .prepare(
      `SELECT pv.vehicle_model_id, pv.year_from, pv.year_to, vm.make, vm.model
       FROM product_vehicles pv JOIN vehicle_models vm ON vm.id = pv.vehicle_model_id
       WHERE pv.product_id = ? ORDER BY vm.make, vm.model`,
    )
    .all(id);

  return {
    ...product,
    image_url: imageUrl(product.image_path),
    variants,
    vehicles,
    serials_total: serialsTotal,
  };
}

// ---------------------------------------------------------------- write

function nextFreeSku(db) {
  for (;;) {
    const { number } = settings.takeNextNumber(db, 'product_sku');
    const taken = db
      .prepare('SELECT 1 FROM product_variants WHERE sku = ? COLLATE NOCASE AND is_deleted = 0')
      .get(number);
    if (!taken) return number;
  }
}

/** DB-dependent checks. `current` is the stored product when updating. */
function checkReferences(db, data, current) {
  const errors = {};
  if (data.category_id !== null) {
    const ok = db
      .prepare('SELECT 1 FROM product_categories WHERE id = ? AND is_deleted = 0')
      .get(data.category_id);
    if (!ok) errors.category_id = 'Category not found.';
  }
  const keepsOldRate = current && current.gst_rate_bp === data.gst_rate_bp;
  // 0 = "No GST": always allowed, even if 0% is removed from the Settings list.
  if (data.gst_rate_bp !== 0 && !keepsOldRate && !settings.isActiveGstRate(db, data.gst_rate_bp)) {
    errors.gst_rate_bp = 'This GST rate is not in the Settings list.';
  }
  if (data.fitting_variant_id !== null) {
    const fit = db
      .prepare(
        `SELECT p.product_type, p.is_active, v.is_active AS v_active FROM product_variants v
         JOIN products p ON p.id = v.product_id
         WHERE v.id = ? AND v.is_deleted = 0 AND p.is_deleted = 0`,
      )
      .get(data.fitting_variant_id);
    if (!fit || fit.product_type !== 'service') {
      errors.fitting_variant_id = 'Choose a service (fitting / installation charge).';
    } else if (
      (!fit.is_active || !fit.v_active) &&
      !(current && current.fitting_variant_id === data.fitting_variant_id)
    ) {
      errors.fitting_variant_id = 'This service is inactive.';
    }
  }
  data.vehicles.forEach((v, i) => {
    const ok = db
      .prepare('SELECT 1 FROM vehicle_models WHERE id = ? AND is_deleted = 0')
      .get(v.vehicle_model_id);
    if (!ok) errors[`vehicles.${i}`] = 'Vehicle not found.';
  });

  const skuOwner = db.prepare(
    `SELECT v.id, p.name FROM product_variants v JOIN products p ON p.id = v.product_id
     WHERE v.sku = ? COLLATE NOCASE AND v.is_deleted = 0`,
  );
  const barcodeOwner = db.prepare(
    `SELECT v.id, p.name FROM product_variants v JOIN products p ON p.id = v.product_id
     WHERE v.barcode = ? AND v.is_deleted = 0`,
  );
  const seenSku = new Set();
  const seenBarcode = new Set();
  data.variants.forEach((v, i) => {
    if (v.sku) {
      const key = v.sku.toLowerCase();
      const owner = skuOwner.get(v.sku);
      if (seenSku.has(key)) errors[`variants.${i}.sku`] = 'Same SKU used twice.';
      else if (owner && owner.id !== v.id)
        errors[`variants.${i}.sku`] = `SKU already used by "${owner.name}".`;
      seenSku.add(key);
    }
    if (v.barcode) {
      const owner = barcodeOwner.get(v.barcode);
      if (seenBarcode.has(v.barcode)) errors[`variants.${i}.barcode`] = 'Same barcode used twice.';
      else if (owner && owner.id !== v.id) {
        errors[`variants.${i}.barcode`] = `Barcode already used by "${owner.name}".`;
      }
      seenBarcode.add(v.barcode);
    }
  });

  if (Object.keys(errors).length) {
    throw new AppError(`Please check the form: ${Object.values(errors)[0]}`, 'VALIDATION', errors);
  }
}

function insertVariant(db, productId, v, sortOrder, date, tracked) {
  const sku = v.sku || nextFreeSku(db);
  const variantId = Number(
    db
      .prepare(
        `INSERT INTO product_variants (product_id, sku, barcode, color, size, variant_type,
           purchase_price, mrp, selling_price, min_stock_milli, avg_cost, sort_order, is_active)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        productId,
        sku,
        v.barcode || null,
        v.color || null,
        v.size || null,
        v.variant_type || null,
        v.purchase_price,
        v.mrp,
        v.selling_price,
        v.min_stock_milli,
        v.purchase_price, // starting average cost
        sortOrder,
        v.is_active ? 1 : 0,
      ).lastInsertRowid,
  );
  if (v.opening_stock_milli > 0) {
    const movementId = serials.insertMovement(db, {
      variant_id: variantId,
      date,
      type: 'opening',
      qty_milli: v.opening_stock_milli,
      unit_cost: v.purchase_price,
      reason: 'Opening stock',
    });
    if (tracked) {
      serials.addSerials(db, {
        variant_id: variantId,
        input: v.serials,
        source_type: 'opening',
        date,
        event: 'received_opening',
        ref: { ref_type: 'stock_movement', ref_id: movementId },
        fieldPrefix: `variants.${sortOrder}.serials`,
      });
    }
  }
  return variantId;
}

function writeVehicles(db, productId, vehicles) {
  // Compatibility rows are configuration, not business records: replaced as a set.
  db.prepare('DELETE FROM product_vehicles WHERE product_id = ?').run(productId);
  const insert = db.prepare(
    'INSERT INTO product_vehicles (product_id, vehicle_model_id, year_from, year_to) VALUES (?, ?, ?, ?)',
  );
  for (const v of vehicles) insert.run(productId, v.vehicle_model_id, v.year_from, v.year_to);
}

/** Inserts a validated product. Must be called inside a transaction. Returns the new id. */
function insertProduct(db, data, { date = todayISO() } = {}) {
  checkReferences(db, data, null);
  const id = Number(
    db
      .prepare(
        `INSERT INTO products (product_type, name, category_id, brand, unit, hsn_code, gst_rate_bp,
           price_includes_gst, has_variants, is_universal, rack_location, customer_warranty_months,
           supplier_warranty_months, warranty_start_basis, track_serials, image_path, notes, is_active,
           fitting_variant_id, fitting_charge, warranty_covered, warranty_not_covered)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        data.product_type,
        data.name,
        data.category_id,
        data.brand || null,
        data.unit,
        data.hsn_code || null,
        data.gst_rate_bp,
        data.price_includes_gst ? 1 : 0,
        data.has_variants ? 1 : 0,
        data.is_universal ? 1 : 0,
        data.rack_location || null,
        data.customer_warranty_months,
        data.supplier_warranty_months,
        data.warranty_start_basis,
        data.track_serials ? 1 : 0,
        data.image_path,
        data.notes || null,
        data.is_active ? 1 : 0,
        data.fitting_variant_id ?? null,
        data.fitting_charge ?? null,
        data.warranty_covered || null,
        data.warranty_not_covered || null,
      ).lastInsertRowid,
  );
  data.variants.forEach((v, i) => insertVariant(db, id, v, i, date, data.track_serials));
  writeVehicles(db, id, data.vehicles);
  return id;
}

function create(db, payload) {
  const data = validateProduct(payload, { isNew: true });
  const id = db.transaction(() => insertProduct(db, data))();
  return get(db, id);
}

/**
 * Turning serial tracking on for a variant that already has stock: exactly one serial per
 * unit in stock must be supplied (typed, pasted or auto-generated). No stock movement: the
 * stock already exists, it just gets identities.
 */
function enableSerialsForVariant(db, v, index) {
  const stock = variantStock(db, v.id);
  const field = `variants.${index}.serials`;
  if (stock < 0 || stock % 1000 !== 0) {
    throw new AppError(
      'Stock must be a whole number of units before turning on serial numbers. Adjust it first.',
      'VALIDATION',
      { [field]: 'Stock is not a whole number.' },
    );
  }
  const needed = stock / 1000;
  const given = v.serials ? v.serials.count : 0;
  if (given !== needed) {
    throw new AppError(
      `Enter exactly ${needed} serial number(s) for the units in stock (${given} entered).`,
      'VALIDATION',
      { [field]: `${needed} needed, ${given} entered.` },
    );
  }
  if (needed > 0) {
    serials.addSerials(db, {
      variant_id: v.id,
      input: v.serials,
      source_type: 'opening',
      date: todayISO(),
      event: 'tracking_enabled',
      fieldPrefix: field,
    });
  }
}

function update(db, id, payload) {
  const data = validateProduct(payload, { isNew: false });
  db.transaction(() => {
    const current = db.prepare('SELECT * FROM products WHERE id = ? AND is_deleted = 0').get(id);
    if (!current) throw new AppError('Product not found.', 'NOT_FOUND');

    const existing = db
      .prepare('SELECT id FROM product_variants WHERE product_id = ? AND is_deleted = 0')
      .pluck()
      .all(id);

    if (current.product_type !== data.product_type) {
      const moved = db
        .prepare(
          `SELECT 1 FROM stock_movements m JOIN product_variants v ON v.id = m.variant_id
           WHERE v.product_id = ? LIMIT 1`,
        )
        .get(id);
      if (moved)
        throw new AppError('Stock has been recorded for this product, so its type cannot change.');
    }
    for (const v of data.variants) {
      if (v.id !== null && !existing.includes(v.id))
        throw new AppError('Variant does not belong to this product.');
    }
    checkReferences(db, data, current);
    const enablingSerials = !current.track_serials && data.track_serials;
    if (current.track_serials && !data.track_serials) {
      const inStock = db
        .prepare(
          "SELECT COUNT(*) FROM product_serials WHERE product_id = ? AND status = 'in_stock'",
        )
        .pluck()
        .get(id);
      if (inStock > 0) {
        throw new AppError(
          `Serial tracking can only be turned off when no units are in stock (${inStock} in stock).`,
          'VALIDATION',
          { track_serials: 'Units still in stock.' },
        );
      }
    }

    db.prepare(
      `UPDATE products SET product_type = ?, name = ?, category_id = ?, brand = ?, unit = ?, hsn_code = ?,
         gst_rate_bp = ?, price_includes_gst = ?, has_variants = ?, is_universal = ?, rack_location = ?,
         customer_warranty_months = ?, supplier_warranty_months = ?, warranty_start_basis = ?,
         track_serials = ?, image_path = ?, notes = ?, is_active = ?, fitting_variant_id = ?,
         fitting_charge = ?, warranty_covered = ?, warranty_not_covered = ?
       WHERE id = ?`,
    ).run(
      data.product_type,
      data.name,
      data.category_id,
      data.brand || null,
      data.unit,
      data.hsn_code || null,
      data.gst_rate_bp,
      data.price_includes_gst ? 1 : 0,
      data.has_variants ? 1 : 0,
      data.is_universal ? 1 : 0,
      data.rack_location || null,
      data.customer_warranty_months,
      data.supplier_warranty_months,
      data.warranty_start_basis,
      data.track_serials ? 1 : 0,
      data.image_path,
      data.notes || null,
      data.is_active ? 1 : 0,
      data.fitting_variant_id,
      data.fitting_charge,
      data.warranty_covered || null,
      data.warranty_not_covered || null,
      id,
    );

    const updateVariant = db.prepare(
      `UPDATE product_variants SET sku = ?, barcode = ?, color = ?, size = ?, variant_type = ?,
         purchase_price = ?, mrp = ?, selling_price = ?, min_stock_milli = ?, sort_order = ?, is_active = ?
       WHERE id = ?`,
    );
    const kept = new Set();
    data.variants.forEach((v, i) => {
      if (v.id === null) {
        insertVariant(db, id, v, i, todayISO(), data.track_serials);
        return;
      }
      kept.add(v.id);
      if (enablingSerials) enableSerialsForVariant(db, v, i);
      updateVariant.run(
        v.sku || nextFreeSku(db),
        v.barcode || null,
        v.color || null,
        v.size || null,
        v.variant_type || null,
        v.purchase_price,
        v.mrp,
        v.selling_price,
        v.min_stock_milli,
        i,
        v.is_active ? 1 : 0,
        v.id,
      );
    });

    // Removed variants are soft-deleted, and only when they hold no stock.
    for (const variantId of existing) {
      if (kept.has(variantId)) continue;
      if (variantStock(db, variantId) !== 0) {
        throw new AppError(
          'A variant you removed still has stock. Adjust its stock to zero first, or deactivate it instead.',
        );
      }
      db.prepare('UPDATE product_variants SET is_deleted = 1 WHERE id = ?').run(variantId);
    }

    writeVehicles(db, id, data.vehicles);
  })();
  return get(db, id);
}

function setActive(db, { id, is_active }) {
  const res = db
    .prepare('UPDATE products SET is_active = ? WHERE id = ? AND is_deleted = 0')
    .run(is_active ? 1 : 0, id);
  if (res.changes === 0) throw new AppError('Product not found.', 'NOT_FOUND');
  return get(db, id);
}

/** Fast lookup for billing and Ctrl+K: active variants by name, SKU, barcode or vehicle. */
function search(db, { query, limit = 20 }) {
  const q = str(query);
  if (!q) return [];
  const exact = db
    .prepare(
      `SELECT v.id FROM product_variants v JOIN products p ON p.id = v.product_id
       WHERE (v.barcode = ? OR v.sku = ? COLLATE NOCASE) AND v.is_deleted = 0 AND v.is_active = 1
         AND p.is_deleted = 0 AND p.is_active = 1`,
    )
    .pluck()
    .all(q, q);

  const { sql, args } = buildFilter({ search: q, active: 'active' });
  const productIds = db
    .prepare(`SELECT id FROM (${sql}) ORDER BY name COLLATE NOCASE LIMIT ?`)
    .pluck()
    .all(...args, Math.min(Number(limit) || 20, 50));

  const ids = [...new Set([...exact])];
  const byProduct = db.prepare(
    'SELECT id FROM product_variants WHERE product_id = ? AND is_deleted = 0 AND is_active = 1 ORDER BY sort_order, id',
  );
  for (const pid of productIds)
    ids.push(
      ...byProduct
        .pluck()
        .all(pid)
        .filter((x) => !ids.includes(x)),
    );

  return ids
    .slice(0, Number(limit) || 20)
    .map((vid) => ({ ...searchRow(db, vid), exact: exact.includes(vid) }));
}

/** One variant shaped like a search result. */
function searchRow(db, variantId) {
  const r = db
    .prepare(
      `SELECT v.id AS variant_id, v.product_id, p.name, p.product_type, p.unit, p.gst_rate_bp,
         p.price_includes_gst, p.hsn_code, p.has_variants, p.track_serials, p.supplier_warranty_months,
         v.sku, v.barcode, v.color, v.size, v.variant_type, v.selling_price, v.mrp, v.purchase_price,
         v.avg_cost,
         (SELECT COALESCE(SUM(qty_milli), 0) FROM stock_movements
           WHERE variant_id = v.id AND location = 'main') AS stock_milli
       FROM product_variants v JOIN products p ON p.id = v.product_id WHERE v.id = ?`,
    )
    .get(variantId);
  return r ? { ...r, variant_label: variantLabel(r) } : null;
}

/** Scanner: the one active variant whose barcode or SKU is exactly `code` (or null). */
function lookupCode(db, { code }) {
  const q = str(code);
  if (!q) return null;
  const hit = search(db, { query: q, limit: 5 }).filter((r) => r.exact);
  return hit.length === 1 ? hit[0] : null;
}

module.exports = {
  meta,
  createCategory,
  createVehicle,
  list,
  stats,
  get,
  create,
  update,
  setActive,
  search,
  lookupCode,
  searchRow,
  insertProduct,
  variantStock,
  variantLabel,
};
