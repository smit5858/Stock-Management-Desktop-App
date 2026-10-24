'use strict';

const { AppError } = require('../errors');
const { str, isISODate, todayISO } = require('../services/parse');
const id = require('./identity');

const MAX_MONEY = 1e11; // ₹100 crore in paise
const FUELS = ['petrol', 'diesel', 'cng', 'ev', 'hybrid'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const isInt = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;
const optInt = (v) => (v == null || v === '' ? null : Number(v));

function fail(errors) {
  if (Object.keys(errors).length) {
    throw new AppError(`Please check the form: ${Object.values(errors)[0]}`, 'VALIDATION', errors);
  }
}

/**
 * Opening balance direction per party type, stored signed (+ = they owe us).
 * Customer: receivable (+) / advance received (−). Supplier: payable (−) / advance paid (+).
 */
const OPENING_TYPES = {
  customer: { receivable: 1, advance: -1 },
  supplier: { payable: -1, advance: 1 },
};

/** Signed opening balance → { opening_amount, opening_type } for the form. */
function splitOpening(type, signed) {
  if (type === 'supplier') {
    return { opening_amount: Math.abs(signed), opening_type: signed > 0 ? 'advance' : 'payable' };
  }
  return { opening_amount: Math.abs(signed), opening_type: signed < 0 ? 'advance' : 'receivable' };
}

/**
 * Validates and normalises a customer or supplier payload. Throws AppError with `fields`.
 * DB checks (unique phone / GSTIN, customer type exists) happen in services/parties.js.
 * Returns { data, warnings } — warnings never block saving.
 */
function validateParty(input, { type, isSystem = false }) {
  const p = input || {};
  const errors = {};
  const warnings = [];
  const customer = type === 'customer';

  const data = {
    type,
    name: str(p.name),
    phone: id.normalizePhone(p.phone),
    alt_phone: id.normalizePhone(p.alt_phone),
    whatsapp_same: p.whatsapp_same !== false,
    email: str(p.email),
    firm_name: customer ? str(p.firm_name) : '',
    contact_person: customer ? '' : str(p.contact_person),
    address: str(p.address),
    city: str(p.city),
    state_code: str(p.state_code),
    pincode: str(p.pincode).replace(/\s/g, ''),
    gstin: id.normalizeGstin(p.gstin),
    customer_type_id: customer ? optInt(p.customer_type_id) : null,
    credit_limit: customer ? (p.credit_limit ?? null) : null,
    payment_terms_days: customer ? null : optInt(p.payment_terms_days),
    supplies: customer ? '' : str(p.supplies),
    bank_details: customer ? '' : str(p.bank_details),
    notes: str(p.notes),
    is_active: p.is_active !== false,
    opening_balance: 0,
    opening_balance_date: null,
  };

  if (!data.name) errors.name = customer ? 'Name is required.' : 'Firm name is required.';
  else if (data.name.length > 100) errors.name = 'Too long (max 100).';

  // Phones
  if (isSystem) {
    data.phone = '';
  } else if (!data.phone) {
    if (customer) errors.phone = 'Phone number is required.';
  } else if (customer && !id.isMobile(data.phone)) {
    errors.phone = data.phone.startsWith('+')
      ? 'This is not a valid mobile number for that country.'
      : 'Enter a 10-digit mobile number starting with 6–9.';
  } else if (!customer && !id.isPhone(data.phone)) {
    errors.phone = data.phone.startsWith('+')
      ? 'This is not a valid number for that country.'
      : 'Enter a 10-digit mobile, or a landline with its STD code.';
  }
  if (data.alt_phone) {
    if (!id.isPhone(data.alt_phone))
      errors.alt_phone = data.alt_phone.startsWith('+')
        ? 'This is not a valid number for that country.'
        : 'Enter a 10-digit number (landline with STD code).';
    else if (data.alt_phone === data.phone) errors.alt_phone = 'Same as the main phone.';
  }

  if (data.email && (data.email.length > 100 || !EMAIL_RE.test(data.email))) {
    errors.email = 'Email looks wrong.';
  }
  if (data.firm_name.length > 100) errors.firm_name = 'Too long (max 100).';
  if (data.contact_person.length > 100) errors.contact_person = 'Too long (max 100).';
  if (data.address.length > 300) errors.address = 'Too long (max 300).';
  if (data.city.length > 60) errors.city = 'Too long (max 60).';
  if (data.state_code && !id.STATE_CODES.has(data.state_code))
    errors.state_code = 'Choose a state.';
  if (data.pincode && !/^[1-9]\d{5}$/.test(data.pincode)) errors.pincode = 'PIN code is 6 digits.';

  // GSTIN: format is an error; check digit / state mismatch are warnings.
  if (data.gstin) {
    const g = id.checkGstin(data.gstin, data.state_code);
    if (g.error) errors.gstin = g.error;
    else {
      warnings.push(...g.warnings);
      if (!data.state_code && id.STATE_CODES.has(g.state_code)) data.state_code = g.state_code;
    }
  }

  if (data.customer_type_id !== null && !Number.isInteger(data.customer_type_id)) {
    errors.customer_type_id = 'Invalid type.';
  }
  if (data.credit_limit !== null && !isInt(data.credit_limit, 0, MAX_MONEY)) {
    errors.credit_limit = 'Invalid amount.';
  }
  if (data.payment_terms_days !== null && !isInt(data.payment_terms_days, 0, 365)) {
    errors.payment_terms_days = 'Days: 0–365.';
  }
  if (data.supplies.length > 300) errors.supplies = 'Too long (max 300).';
  if (data.bank_details.length > 500) errors.bank_details = 'Too long (max 500).';
  if (data.notes.length > 1000) errors.notes = 'Too long (max 1000).';

  // Opening balance: amount + direction + as-of date.
  const amount = p.opening_amount ?? 0;
  const signs = OPENING_TYPES[type];
  if (!isInt(amount, 0, MAX_MONEY)) errors.opening_amount = 'Invalid amount.';
  else if (amount > 0) {
    const sign = signs[p.opening_type];
    if (!sign) errors.opening_type = 'Choose the balance type.';
    else data.opening_balance = sign * amount;
    const date = str(p.opening_balance_date) || todayISO();
    if (!isISODate(date)) errors.opening_balance_date = 'Invalid date.';
    data.opening_balance_date = date;
  }

  fail(errors);
  return { data, warnings };
}

/** Validates a vehicle payload. Plate format is a soft warning; length / characters are not. */
function validateVehicle(input) {
  const v = input || {};
  const errors = {};
  const warnings = [];
  const data = {
    plate_no: id.normalizePlate(v.plate_no),
    vehicle_model_id: optInt(v.vehicle_model_id),
    variant: str(v.variant),
    year: optInt(v.year),
    fuel: str(v.fuel).toLowerCase() || null,
    color: str(v.color),
    notes: str(v.notes),
    is_primary: Boolean(v.is_primary),
  };
  if (!data.plate_no) errors.plate_no = 'Number plate is required.';
  else if (!id.isPlateKey(data.plate_no))
    errors.plate_no = 'Number plate: 4–12 letters and digits.';
  else if (id.plateFormat(data.plate_no) === 'other') {
    warnings.push(`"${data.plate_no}" is not a usual Indian number plate format. Saved as typed.`);
  }
  if (data.vehicle_model_id !== null && !Number.isInteger(data.vehicle_model_id)) {
    errors.vehicle_model_id = 'Choose a model.';
  }
  if (data.variant.length > 60) errors.variant = 'Too long (max 60).';
  if (data.year !== null && !isInt(data.year, 1950, new Date().getFullYear() + 1)) {
    errors.year = 'Year looks wrong.';
  }
  if (data.fuel !== null && !FUELS.includes(data.fuel)) errors.fuel = 'Choose a fuel type.';
  if (data.color.length > 30) errors.color = 'Too long (max 30).';
  if (data.notes.length > 500) errors.notes = 'Too long (max 500).';
  fail(errors);
  return { data, warnings };
}

module.exports = { validateParty, validateVehicle, splitOpening, OPENING_TYPES, FUELS };
