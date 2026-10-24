'use strict';

// Import customers (with vehicles) and suppliers from Excel / CSV:
//   open (read file, suggest a column mapping) → preview (mapping + what to do with
//   duplicates; nothing saved) → commit (all planned rows in ONE transaction).
// Duplicates are found by normalised phone, then GSTIN; plates by normalised plate.

const crypto = require('crypto');
const path = require('path');
const { AppError } = require('../errors');
const { validateParty, validateVehicle, splitOpening } = require('../validation/parties');
const id = require('../validation/identity');
const parties = require('./parties');
const { insertVehicle } = require('./vehicles');
const products = require('./products');
const { parseMoney, isISODate, str } = require('./parse');
const { newWorkbook, readGrid, writeWorkbook, styleHeader } = require('./sheets');

const MAX_ROWS = 5000;

const PHONE_FIELDS = [
  {
    key: 'phone',
    label: 'Phone',
    aliases: [
      'phone',
      'mobile',
      'mobileno',
      'phoneno',
      'contactno',
      'mobilenumber',
      'phonenumber',
      'whatsapp',
    ],
  },
  {
    key: 'alt_phone',
    label: 'Alternate phone',
    aliases: [
      'alternatephone',
      'altphone',
      'phone2',
      'mobile2',
      'alternatemobile',
      'alternatenumber',
      'otherphone',
    ],
  },
  { key: 'email', label: 'Email', aliases: ['email', 'emailid', 'mail'] },
];
const ADDRESS_FIELDS = [
  { key: 'address', label: 'Address', aliases: ['address', 'addr', 'fulladdress'] },
  { key: 'city', label: 'City', aliases: ['city', 'town', 'village', 'district'] },
  { key: 'state', label: 'State', aliases: ['state', 'statename', 'statecode'] },
  { key: 'pincode', label: 'PIN code', aliases: ['pincode', 'pin', 'zip', 'postalcode'] },
  { key: 'gstin', label: 'GSTIN', aliases: ['gstin', 'gst', 'gstno', 'gstnumber', 'gstinno'] },
];
const OPENING_FIELDS = [
  {
    key: 'opening_balance',
    label: 'Opening balance',
    aliases: ['openingbalance', 'opening', 'balance', 'due', 'outstanding', 'openingamount'],
  },
  {
    key: 'opening_type',
    label: 'Balance type',
    aliases: ['balancetype', 'openingtype', 'drcr', 'typeofbalance'],
  },
  {
    key: 'opening_date',
    label: 'Balance as of',
    aliases: ['openingdate', 'asofdate', 'balancedate', 'asof'],
  },
  { key: 'notes', label: 'Notes', aliases: ['notes', 'remarks', 'note', 'remark'] },
];

const FIELDS = {
  customer: [
    {
      key: 'name',
      label: 'Name',
      required: true,
      aliases: ['name', 'customername', 'customer', 'partyname', 'fullname'],
    },
    ...PHONE_FIELDS.map((f) => (f.key === 'phone' ? { ...f, required: true } : f)),
    {
      key: 'firm_name',
      label: 'Firm name',
      aliases: ['firmname', 'firm', 'businessname', 'companyname', 'company'],
    },
    ...ADDRESS_FIELDS,
    {
      key: 'customer_type',
      label: 'Customer type',
      aliases: ['customertype', 'type', 'category', 'group'],
    },
    { key: 'credit_limit', label: 'Credit limit', aliases: ['creditlimit', 'limit'] },
    ...OPENING_FIELDS,
    {
      key: 'plate',
      label: 'Vehicle number',
      aliases: [
        'vehicleno',
        'vehiclenumber',
        'plate',
        'plateno',
        'numberplate',
        'registrationno',
        'regno',
        'carno',
        'vehicle',
      ],
    },
    { key: 'make', label: 'Make', aliases: ['make', 'carmake', 'manufacturer'] },
    { key: 'model', label: 'Model', aliases: ['model', 'carmodel', 'vehiclemodel'] },
    { key: 'year', label: 'Year', aliases: ['year', 'modelyear', 'mfgyear'] },
    { key: 'fuel', label: 'Fuel', aliases: ['fuel', 'fueltype'] },
    { key: 'color', label: 'Colour', aliases: ['color', 'colour'] },
  ],
  supplier: [
    {
      key: 'name',
      label: 'Firm name',
      required: true,
      aliases: [
        'firmname',
        'name',
        'suppliername',
        'supplier',
        'firm',
        'company',
        'companyname',
        'partyname',
      ],
    },
    {
      key: 'contact_person',
      label: 'Contact person',
      aliases: ['contactperson', 'contact', 'contactname', 'person'],
    },
    ...PHONE_FIELDS,
    ...ADDRESS_FIELDS,
    {
      key: 'payment_terms',
      label: 'Payment terms (days)',
      aliases: ['paymentterms', 'terms', 'creditdays', 'days'],
    },
    {
      key: 'supplies',
      label: 'Supplies',
      aliases: ['supplies', 'brands', 'categories', 'items', 'brandscategories'],
    },
    {
      key: 'bank_details',
      label: 'Bank / UPI',
      aliases: ['bank', 'bankdetails', 'upi', 'bankupi', 'account'],
    },
    ...OPENING_FIELDS,
  ],
};

const norm = (h) =>
  String(h ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');

function suggestMapping(type, headers) {
  const mapping = {};
  const used = new Set();
  for (const f of FIELDS[type]) {
    const j = headers.findIndex((h, i) => {
      const n = norm(h);
      return n && !used.has(i) && (n === norm(f.label) || f.aliases.includes(n));
    });
    mapping[f.key] = j >= 0 ? j : null;
    if (j >= 0) used.add(j);
  }
  return mapping;
}

// ---------------------------------------------------------------- value parsing

function openingType(type, text, amount) {
  const t = str(text).toLowerCase();
  if (type === 'supplier') {
    if (/adv|^dr|debit/.test(t)) return 'advance';
    if (/pay|^cr|credit/.test(t)) return 'payable';
    return amount < 0 ? 'advance' : 'payable';
  }
  if (/adv|^cr|credit/.test(t)) return 'advance';
  if (/rec|^dr|debit|due/.test(t)) return 'receivable';
  return amount < 0 ? 'advance' : 'receivable';
}

function parseFuel(v) {
  const t = str(v).toLowerCase();
  if (!t) return '';
  if (t.startsWith('pet')) return 'petrol';
  if (t.startsWith('die')) return 'diesel';
  if (t.includes('cng')) return 'cng';
  if (t === 'ev' || t.startsWith('elec')) return 'ev';
  if (t.startsWith('hyb')) return 'hybrid';
  return t; // validator reports it
}

/** 'DD-MM-YYYY', 'DD/MM/YYYY' or 'YYYY-MM-DD' → ISO, '' when empty, null when invalid. */
function parseDate(v) {
  const t = str(v);
  if (!t) return '';
  if (isISODate(t)) return t;
  const m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(t);
  if (!m) return null;
  const iso = `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return isISODate(iso) ? iso : null;
}

// ---------------------------------------------------------------- open / preview / commit

const pending = new Map(); // token → { type, file_name, grid, plan, at }

function cleanup() {
  for (const [t, p] of pending) if (Date.now() - p.at > 30 * 60 * 1000) pending.delete(t);
}

async function open(db, { type, file }) {
  if (!FIELDS[type]) throw new AppError('Unknown import type.', 'VALIDATION');
  const grid = await readGrid(file);
  const headers = (grid[0] || []).map((h) => str(h));
  if (!headers.some(Boolean))
    throw new AppError('The first row must contain column names.', 'VALIDATION');
  const body = grid.slice(1).filter((r) => r.some((c) => str(c) !== ''));
  if (body.length === 0) throw new AppError('The file has no rows to import.', 'VALIDATION');
  if (body.length > MAX_ROWS)
    throw new AppError(`Too many rows (max ${MAX_ROWS} per import).`, 'VALIDATION');
  cleanup();
  const token = crypto.randomBytes(12).toString('hex');
  pending.set(token, { type, file_name: path.basename(file), grid, plan: null, at: Date.now() });
  return {
    token,
    type,
    file_name: path.basename(file),
    headers,
    sample: body.slice(0, 5).map((r) => headers.map((_, i) => str(r[i]))),
    row_count: body.length,
    fields: FIELDS[type].map(({ key, label, required }) => ({
      key,
      label,
      required: Boolean(required),
    })),
    mapping: suggestMapping(type, headers),
  };
}

/** Form-shaped payload of a stored party (for "update existing"). */
function payloadOf(row) {
  return {
    ...row,
    whatsapp_same: Boolean(row.whatsapp_same),
    is_active: Boolean(row.is_active),
    ...splitOpening(row.type, row.opening_balance),
  };
}

/**
 * Builds the plan. Customer rows with the same phone become one customer with several
 * vehicles. `on_duplicate`: 'skip' (default) or 'update' (fill in / overwrite the fields the
 * file has; existing values stay when the file cell is empty).
 */
function buildPlan(db, type, grid, mapping, onDuplicate) {
  const fields = FIELDS[type];
  for (const f of fields) {
    if (f.required && !Number.isInteger(mapping[f.key])) {
      throw new AppError(`Choose the column for "${f.label}".`, 'VALIDATION', {
        [f.key]: 'Required.',
      });
    }
  }
  const cell = (r, key) => (Number.isInteger(mapping[key]) ? str(r[mapping[key]]) : '');

  const rows = [];
  for (let i = 1; i < grid.length; i++) {
    const r = grid[i] || [];
    if (r.every((c) => str(c) === '')) continue;
    const values = {};
    for (const f of fields) values[f.key] = cell(r, f.key);
    rows.push({ row_no: i + 1, values });
  }

  // Group customers by phone (rows without a valid phone stay on their own and fail validation).
  const groups = [];
  const byPhone = new Map();
  for (const row of rows) {
    const phone = id.normalizePhone(row.values.phone);
    const key = phone && id.isPhone(phone) ? phone : null;
    if (key && byPhone.has(key)) {
      const g = byPhone.get(key);
      if (type === 'customer') g.rows.push(row);
      else groups.push({ rows: [row], dupOf: g.rows[0].row_no });
      continue;
    }
    const g = { rows: [row] };
    if (key) byPhone.set(key, g);
    groups.push(g);
  }

  const types = new Map(parties.listCustomerTypes(db).map((t) => [t.name.toLowerCase(), t.id]));
  const models = db
    .prepare('SELECT id, make, model FROM vehicle_models WHERE is_deleted = 0')
    .all();
  const findModel = (make, model) =>
    models.find(
      (m) =>
        m.make.toLowerCase() === make.toLowerCase() &&
        m.model.toLowerCase() === model.toLowerCase(),
    ) || models.find((m) => !make && m.model.toLowerCase() === model.toLowerCase());
  const byPhoneStmt = db.prepare(
    'SELECT * FROM parties WHERE type = ? AND phone = ? AND is_deleted = 0',
  );
  const byGstinStmt = db.prepare(
    'SELECT * FROM parties WHERE type = ? AND gstin = ? AND is_deleted = 0',
  );
  const plateOwner = db.prepare(
    `SELECT v.customer_id, p.name FROM vehicles v JOIN parties p ON p.id = v.customer_id
     WHERE v.plate_no = ? AND v.is_deleted = 0`,
  );

  const newTypes = new Set();
  const newModels = new Map();
  const platesInFile = new Map(); // plate → row_no
  const items = [];
  const preview = [];
  const counts = { create: 0, update: 0, skip: 0, error: 0, vehicles: 0 };

  for (const g of groups) {
    const errors = [];
    const warnings = [];
    const first = (key) => g.rows.map((r) => r.values[key]).find(Boolean) || '';
    const rowNos = g.rows.map((r) => r.row_no);
    if (g.dupOf) errors.push(`Same phone as row ${g.dupOf}.`);

    // Party fields from the file (first non-empty value in the group).
    const file = {};
    for (const f of fields) file[f.key] = first(f.key);
    const amount = file.opening_balance ? parseMoney(file.opening_balance) : null;
    if (file.opening_balance && amount === null) errors.push('Opening balance is not a number.');
    const date = parseDate(file.opening_date);
    if (date === null) errors.push('Balance date: use DD-MM-YYYY.');
    let stateCode = '';
    if (file.state) {
      stateCode = id.stateCodeFrom(file.state);
      if (!stateCode) errors.push(`Unknown state "${file.state}".`);
    }
    let creditLimit = null;
    if (file.credit_limit) {
      creditLimit = parseMoney(file.credit_limit);
      if (creditLimit === null || creditLimit < 0) errors.push('Credit limit is not a number.');
    }
    let typeName = null;
    let typeId = null;
    if (file.customer_type) {
      typeId = types.get(file.customer_type.toLowerCase()) ?? null;
      if (typeId === null) {
        typeName = file.customer_type;
        newTypes.add(typeName);
      }
    }
    const filePayload = {
      name: file.name,
      phone: file.phone,
      alt_phone: file.alt_phone,
      email: file.email,
      firm_name: file.firm_name,
      contact_person: file.contact_person,
      address: file.address,
      city: file.city,
      state_code: stateCode,
      pincode: file.pincode,
      gstin: file.gstin,
      customer_type_id: typeId,
      credit_limit: creditLimit,
      payment_terms_days: file.payment_terms ? Number(file.payment_terms) : null,
      supplies: file.supplies,
      bank_details: file.bank_details,
      notes: file.notes,
      opening_amount: amount === null ? 0 : Math.abs(amount),
      opening_type: openingType(type, file.opening_type, amount ?? 0),
      opening_balance_date: date || '',
    };

    // Existing record?
    const phoneKey = id.normalizePhone(file.phone);
    const gstinKey = id.normalizeGstin(file.gstin);
    const existing =
      (phoneKey && byPhoneStmt.get(type, phoneKey)) ||
      (gstinKey && byGstinStmt.get(type, gstinKey)) ||
      null;
    let action = existing ? (onDuplicate === 'update' ? 'update' : 'skip') : 'create';
    if (existing && existing.is_system) action = 'skip';

    let data = null;
    if (action !== 'skip') {
      let payload = filePayload;
      if (action === 'update') {
        const base = payloadOf(existing);
        payload = { ...base };
        for (const [k, v] of Object.entries(filePayload)) {
          if (k.startsWith('opening_')) continue;
          if (v !== '' && v !== null && v !== undefined) payload[k] = v;
        }
        if (amount !== null) {
          payload.opening_amount = filePayload.opening_amount;
          payload.opening_type = filePayload.opening_type;
          payload.opening_balance_date =
            filePayload.opening_balance_date || base.opening_balance_date;
        }
      }
      try {
        const v = validateParty(payload, { type });
        data = v.data;
        warnings.push(...v.warnings);
        // Unique GSTIN against other records (phone was matched above).
        if (data.gstin) {
          const o = byGstinStmt.get(type, data.gstin);
          if (o && (!existing || o.id !== existing.id))
            errors.push(`GSTIN already used by ${o.name}.`);
        }
      } catch (e) {
        if (!(e instanceof AppError)) throw e;
        errors.push(...Object.values(e.fields || { _: e.message }));
      }
    }

    // Vehicles (customers only): one per row that has a plate.
    const vehicles = [];
    if (type === 'customer') {
      for (const r of g.rows) {
        const v = r.values;
        if (!v.plate) {
          if (v.make || v.model)
            warnings.push(`Row ${r.row_no}: make / model without a vehicle number (ignored).`);
          continue;
        }
        let model = null;
        if (v.model) {
          model = findModel(v.make, v.model);
          if (!model) {
            if (!v.make) {
              errors.push(`Row ${r.row_no}: unknown model "${v.model}" (add the Make column).`);
              continue;
            }
            const key = `${v.make}|${v.model}`.toLowerCase();
            if (!newModels.has(key)) newModels.set(key, { make: v.make, model: v.model });
          }
        }
        let vehicle;
        try {
          vehicle = validateVehicle({
            plate_no: v.plate,
            year: v.year || null,
            fuel: parseFuel(v.fuel),
            color: v.color,
          });
        } catch (e) {
          if (!(e instanceof AppError)) throw e;
          errors.push(`Row ${r.row_no}: ${Object.values(e.fields || { _: e.message }).join(' ')}`);
          continue;
        }
        warnings.push(...vehicle.warnings);
        const plate = vehicle.data.plate_no;
        if (platesInFile.has(plate) && platesInFile.get(plate) !== rowNos[0]) {
          errors.push(
            `Row ${r.row_no}: vehicle ${id.formatPlate(plate)} is also in row ${platesInFile.get(plate)}.`,
          );
          continue;
        }
        platesInFile.set(plate, rowNos[0]);
        const owner = plateOwner.get(plate);
        if (owner) {
          if (existing && owner.customer_id === existing.id) continue; // already there
          errors.push(
            `Row ${r.row_no}: vehicle ${id.formatPlate(plate)} belongs to ${owner.name}.`,
          );
          continue;
        }
        vehicles.push({
          data: vehicle.data,
          model: model ? { id: model.id } : v.model ? { make: v.make, model: v.model } : null,
        });
      }
    }

    if (errors.length) action = 'error';
    counts[action] += 1;
    if (action === 'create' || action === 'update') {
      counts.vehicles += vehicles.length;
      items.push({
        action,
        existing_id: existing ? existing.id : null,
        data,
        type_name: typeName,
        vehicles,
      });
    }
    preview.push({
      key: rowNos.join(','),
      rows: rowNos,
      name: file.name,
      phone_display: id.formatPhone(phoneKey) || file.phone,
      plates: vehicles.map((v) => id.formatPlate(v.data.plate_no)),
      action,
      existing_name: existing ? existing.name : null,
      errors,
      warnings,
    });
  }

  return {
    items,
    preview,
    summary: {
      ...counts,
      rows: rows.length,
      new_types: [...newTypes],
      new_models: [...newModels.values()].map((m) => `${m.make} ${m.model}`),
    },
  };
}

function previewImport(db, { token, mapping, on_duplicate: onDuplicate = 'skip' }) {
  const entry = pending.get(token);
  if (!entry)
    throw new AppError('This import has expired. Please choose the file again.', 'EXPIRED');
  const clean = {};
  for (const f of FIELDS[entry.type]) {
    const v = mapping ? mapping[f.key] : null;
    clean[f.key] = v === null || v === undefined || v === '' ? null : Number(v);
  }
  const plan = buildPlan(
    db,
    entry.type,
    entry.grid,
    clean,
    onDuplicate === 'update' ? 'update' : 'skip',
  );
  entry.plan = plan;
  entry.at = Date.now();
  return { token, summary: plan.summary, rows: plan.preview };
}

/** Everything planned in ONE transaction: all rows are imported, or none. */
function commit(db, { token }) {
  const entry = pending.get(token);
  if (!entry || !entry.plan) {
    throw new AppError('This import has expired. Please choose the file again.', 'EXPIRED');
  }
  const { items } = entry.plan;
  if (items.length === 0) throw new AppError('There is nothing to import.', 'VALIDATION');
  const result = db.transaction(() => {
    const typeIds = new Map();
    const out = { created: 0, updated: 0, vehicles: 0 };
    for (const item of items) {
      const data = { ...item.data };
      if (item.type_name) {
        const k = item.type_name.toLowerCase();
        if (!typeIds.has(k)) {
          const list = parties.saveCustomerType(db, { name: item.type_name });
          typeIds.set(k, list.find((t) => t.name.toLowerCase() === k).id);
        }
        data.customer_type_id = typeIds.get(k);
      }
      let partyId = item.existing_id;
      if (item.action === 'create') {
        partyId = parties.insertParty(db, data);
        out.created += 1;
      } else {
        parties.writeParty(db, partyId, data);
        out.updated += 1;
      }
      for (const v of item.vehicles) {
        const vehicle = { ...v.data };
        if (v.model)
          vehicle.vehicle_model_id = v.model.id ?? products.createVehicle(db, v.model).id;
        insertVehicle(db, partyId, vehicle);
        out.vehicles += 1;
      }
    }
    return out;
  })();
  pending.delete(token);
  return result;
}

async function writeTemplate(type, file) {
  if (!FIELDS[type]) throw new AppError('Unknown import type.', 'VALIDATION');
  const wb = newWorkbook();
  const ws = wb.addWorksheet(type === 'supplier' ? 'Suppliers' : 'Customers');
  ws.columns = FIELDS[type].map((f) => ({
    header: f.label,
    key: f.key,
    width: Math.max(12, f.label.length + 4),
  }));
  styleHeader(ws);
  if (type === 'customer') {
    ws.addRow({
      name: 'Ramesh Patel',
      phone: '98765 43210',
      city: 'Rajkot',
      state: 'Gujarat',
      customer_type: 'Retail',
      opening_balance: 1500,
      opening_type: 'Receivable',
      opening_date: '01-04-2026',
      plate: 'GJ 03 AB 1234',
      make: 'Maruti Suzuki',
      model: 'Swift',
      year: 2021,
      fuel: 'Petrol',
      color: 'Red',
    });
    ws.addRow({
      name: 'Ramesh Patel',
      phone: '98765 43210',
      plate: 'GJ 03 CD 5678',
      make: 'Hyundai',
      model: 'Creta',
    });
    ws.addRow({
      name: 'Shree Auto Garage',
      phone: '+91 99099 88776',
      firm_name: 'Shree Auto Garage',
      gstin: '24ABCDE1234F1Z5',
      city: 'Rajkot',
      state: 'Gujarat',
      customer_type: 'Garage/Mechanic',
      credit_limit: 25000,
    });
  } else {
    ws.addRow({
      name: 'Shree Auto Accessories',
      contact_person: 'Mahesh Shah',
      phone: '98250 12345',
      city: 'Ahmedabad',
      state: 'Gujarat',
      gstin: '24ABCDE1234F1Z5',
      payment_terms: 30,
      supplies: 'Seat covers, mats',
      opening_balance: 12000,
      opening_type: 'Payable',
      opening_date: '01-04-2026',
    });
  }
  const notes = wb.addWorksheet('How to fill');
  notes.columns = [{ width: 110 }];
  [
    'Column names do not have to match exactly: you choose which column is which after picking the file.',
    type === 'customer'
      ? 'Phone is required (10-digit mobile; spaces, dashes and +91 are fine). Rows with the same phone become one customer.'
      : 'Phone is optional (mobile, or landline with STD code).',
    type === 'customer'
      ? 'Several vehicles: repeat the customer on another row with the next vehicle number.'
      : 'Supplies: brands or categories you buy from this supplier.',
    'State: name (Gujarat) or GST code (24). GSTIN: 15 characters; the state is taken from it when empty.',
    type === 'customer'
      ? "Balance type: Receivable (customer owes you) or Advance (you hold the customer's money)."
      : 'Balance type: Payable (you owe the supplier) or Advance (you paid in advance).',
    'Balance as of: DD-MM-YYYY. Amounts in rupees (e.g. 1500 or 1500.50).',
    'Existing records are found by phone (then GSTIN). You choose to skip them or update them in the preview.',
    'Nothing is saved until you confirm the preview, and then all rows are saved together.',
  ].forEach((t) => notes.addRow([t]));
  await writeWorkbook(wb, file);
}

module.exports = {
  open,
  preview: previewImport,
  commit,
  writeTemplate,
  buildPlan,
  suggestMapping,
  FIELDS,
};
