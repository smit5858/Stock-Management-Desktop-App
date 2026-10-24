// Identity rules for customers, suppliers and vehicles (renderer copy).
// Mirrors electron/validation/identity.js: keep both in sync (tests/parties.test.js compares them).

import {
  getCountryCallingCode,
  parsePhoneNumberFromString,
  validatePhoneNumberLength,
} from 'libphonenumber-js/max';

/** GST state / UT codes (first two digits of a GSTIN). */
export const STATES = [
  ['01', 'Jammu and Kashmir'],
  ['02', 'Himachal Pradesh'],
  ['03', 'Punjab'],
  ['04', 'Chandigarh'],
  ['05', 'Uttarakhand'],
  ['06', 'Haryana'],
  ['07', 'Delhi'],
  ['08', 'Rajasthan'],
  ['09', 'Uttar Pradesh'],
  ['10', 'Bihar'],
  ['11', 'Sikkim'],
  ['12', 'Arunachal Pradesh'],
  ['13', 'Nagaland'],
  ['14', 'Manipur'],
  ['15', 'Mizoram'],
  ['16', 'Tripura'],
  ['17', 'Meghalaya'],
  ['18', 'Assam'],
  ['19', 'West Bengal'],
  ['20', 'Jharkhand'],
  ['21', 'Odisha'],
  ['22', 'Chhattisgarh'],
  ['23', 'Madhya Pradesh'],
  ['24', 'Gujarat'],
  ['26', 'Dadra and Nagar Haveli and Daman and Diu'],
  ['27', 'Maharashtra'],
  ['29', 'Karnataka'],
  ['30', 'Goa'],
  ['31', 'Lakshadweep'],
  ['32', 'Kerala'],
  ['33', 'Tamil Nadu'],
  ['34', 'Puducherry'],
  ['35', 'Andaman and Nicobar Islands'],
  ['36', 'Telangana'],
  ['37', 'Andhra Pradesh'],
  ['38', 'Ladakh'],
  ['97', 'Other Territory'],
].map(([code, name]) => ({ code, name }));

export const STATE_CODES = new Set(STATES.map((s) => s.code));

export function stateName(code) {
  const s = STATES.find((x) => x.code === code);
  return s ? s.name : '';
}

/** "Gujarat" / "gujarat" / "24" / "GJ"-less input → '24'. '' when unknown. */
export function stateCodeFrom(input) {
  const v = String(input ?? '')
    .trim()
    .toLowerCase();
  if (!v) return '';
  if (/^\d{1,2}$/.test(v)) {
    const code = v.padStart(2, '0');
    return STATE_CODES.has(code) ? code : '';
  }
  const s = STATES.find((x) => x.name.toLowerCase() === v);
  return s ? s.code : '';
}

// ---------------------------------------------------------------- phone numbers

// Stored form: Indian numbers as 10 national digits ('9876543210'); any other country in
// international E.164 form ('+971501234567'). Validation of foreign numbers uses
// libphonenumber-js (bundled metadata, works offline).

export const INDIA_DIGITS = 10;

export function parseIntl(value) {
  try {
    return parsePhoneNumberFromString(value) || null;
  } catch {
    return null;
  }
}

/**
 * Typed / pasted / imported number → stored form. Indian: spaces, dashes, brackets and the
 * +91 / 0091 / 0 prefix removed ('+91 98765-43210' → '9876543210', '0281 245 1234' →
 * '2812451234'). Other countries need the + (or 00) prefix: '+971 50 123 4567' →
 * '+971501234567'. The result may still be invalid (see isMobile / isPhone).
 */
export function normalizePhone(input) {
  const raw = String(input ?? '').trim();
  if (/^(\+|00)/.test(raw)) {
    const intl = `+${raw.replace(/\D/g, '').replace(/^00/, '')}`;
    if (!intl.startsWith('+91')) {
      const p = parseIntl(intl);
      return p ? p.number : intl === '+' ? '' : intl;
    }
  }
  let d = raw.replace(/\D/g, '');
  if (d.length === 14 && d.startsWith('0091')) d = d.slice(4);
  else if (d.length === 13 && d.startsWith('091')) d = d.slice(3);
  else if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
  else if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  return d;
}

const MOBILE_TYPES = ['MOBILE', 'FIXED_LINE_OR_MOBILE', 'PERSONAL_NUMBER', undefined];

/** Indian mobile (10 digits starting with 6–9), or a valid foreign mobile number. */
export function isMobile(stored) {
  if (!stored) return false;
  if (stored.startsWith('+')) {
    const p = parseIntl(stored);
    return Boolean(p && p.isValid() && MOBILE_TYPES.includes(p.getType()));
  }
  return /^[6-9]\d{9}$/.test(stored);
}

/** Mobile or landline: Indian 10 digits (landline with STD code, no leading 0) or valid foreign. */
export function isPhone(stored) {
  if (!stored) return false;
  if (stored.startsWith('+')) {
    const p = parseIntl(stored);
    return Boolean(p && p.isValid());
  }
  return /^[1-9]\d{9}$/.test(stored);
}

/** Country of a stored number: 'IN' for Indian numbers, else the ISO code (or ''). */
export function phoneCountry(stored) {
  if (!stored) return 'IN';
  if (!stored.startsWith('+')) return 'IN';
  const p = parseIntl(stored);
  return (p && p.country) || '';
}

/** Without the country code: '9876543210' → '98765 43210'; foreign → national format. */
export function formatLocalPhone(stored) {
  if (!stored) return '';
  if (stored.startsWith('+')) {
    const p = parseIntl(stored);
    return p ? p.formatNational() : stored;
  }
  if (isMobile(stored)) return `${stored.slice(0, 5)} ${stored.slice(5)}`;
  return stored;
}

/** With the country code: '+91 98765 43210', '+91 2812451234', '+971 50 123 4567'. */
export function formatPhone(stored) {
  if (!stored) return '';
  if (stored.startsWith('+')) {
    const p = parseIntl(stored);
    return p && p.isValid() ? p.formatInternational() : stored;
  }
  if (isPhone(stored)) return `+91 ${formatLocalPhone(stored)}`;
  return stored;
}

/**
 * Typing guard for the phone input: may `digits` (national number, no prefix) be typed for
 * `country`? India: at most 10 digits. Elsewhere: not longer than the country allows, and no
 * extra digit once the number is already complete.
 */
export function phoneDigitsAllowed(digits, country, previous = '') {
  if (!digits) return true;
  if (country === 'IN') return digits.length <= INDIA_DIGITS;
  if (validatePhoneNumberLength(digits, country) === 'TOO_LONG') return false;
  if (digits.length > previous.length && previous) {
    const before = parseIntl(`+${getCountryCallingCode(country)}${previous}`);
    const after = parseIntl(`+${getCountryCallingCode(country)}${digits}`);
    if (before && before.isValid() && !(after && after.isValid())) return false;
  }
  return true;
}

/** Digits to search with (partial numbers allowed): '+91 98765' → '98765'. */
export function phoneSearchDigits(input) {
  const d = String(input ?? '').replace(/\D/g, '');
  return d.length > 10 ? normalizePhone(d) : d;
}

// ---------------------------------------------------------------- number plates

/** Upper-case, letters and digits only: 'gj-03 ab.1234' → 'GJ03AB1234'. */
export function normalizePlate(input) {
  return String(input ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

// Known Indian plate formats, tried in order. The key is always the normalised plate; these
// only decide the display and the label. Anything else is accepted with a soft warning.
export const PLATE_FORMATS = [
  // 22 BH 1234 AA (Bharat series)
  {
    id: 'bh',
    label: 'BH series',
    re: /^(\d{2})BH(\d{4})([A-Z]{1,2})$/,
    show: (m) => [m[1], 'BH', m[2], m[3]],
  },
  // T 0124 GJ 1234 AB (temporary registration: T + month/year + state + number)
  {
    id: 'temporary',
    label: 'Temporary',
    re: /^T(\d{4})([A-Z]{2})(\d{4})([A-Z]{1,2})$/,
    show: (m) => ['T', m[1], m[2], m[3], m[4]],
  },
  // GJ VA AB 1234 (vintage, 50+ years old)
  {
    id: 'vintage',
    label: 'Vintage',
    re: /^([A-Z]{2})VA([A-Z]{2})(\d{1,4})$/,
    show: (m) => [m[1], 'VA', m[2], m[3]],
  },
  // 15 B 123456 K (defence / military: year, class, serial, check letter)
  {
    id: 'defence',
    label: 'Defence',
    re: /^(\d{2})([A-Z])(\d{5,6})([A-Z])$/,
    show: (m) => [m[1], m[2], m[3], m[4]],
  },
  // 77 CD 12 (diplomatic: CD / CC / UN)
  {
    id: 'diplomatic',
    label: 'Diplomatic',
    re: /^(\d{1,3})(CD|CC|UN)(\d{1,4})$/,
    show: (m) => [m[1], m[2], m[3]],
  },
  // DL 3C AB 1234 (Delhi: vehicle-class letter after the RTO number)
  {
    id: 'standard',
    label: 'Standard',
    re: /^DL(\d{1,2})([A-Z])([A-Z]{0,2})(\d{1,4})$/,
    show: (m) => ['DL', m[1] + m[2], m[3], m[4]],
  },
  // GJ 03 AB 1234 / GJ 18 G 1234 (government series are standard plates too)
  {
    id: 'standard',
    label: 'Standard',
    re: /^([A-Z]{2})(\d{1,2})([A-Z]{1,3})(\d{1,4})$/,
    show: (m) => [m[1], m[2], m[3], m[4]],
  },
  // GJ 01 1234 (no series letters)
  {
    id: 'standard',
    label: 'Standard',
    re: /^([A-Z]{2})(\d{1,2})(\d{4})$/,
    show: (m) => [m[1], m[2], m[3]],
  },
  // MHU 1234 / DL 1234 (old series, before state + RTO codes)
  { id: 'old', label: 'Old series', re: /^([A-Z]{2,3})(\d{1,4})$/, show: (m) => [m[1], m[2]] },
];

export function plateMatch(key) {
  for (const f of PLATE_FORMATS) {
    const m = f.re.exec(key || '');
    if (m) return { f, m };
  }
  return null;
}

/** 'standard' | 'bh' | 'temporary' | 'vintage' | 'defence' | 'diplomatic' | 'old' | 'other'. */
export function plateFormat(key) {
  const hit = plateMatch(key);
  return hit ? hit.f.id : 'other';
}

export const PLATE_LABELS = Object.fromEntries(PLATE_FORMATS.map((f) => [f.id, f.label]));
PLATE_LABELS.other = 'Unusual format';

export function plateFormatLabel(format) {
  return PLATE_LABELS[format] || '';
}

/** 'GJ03AB1234' → 'GJ 03 AB 1234', '22BH1234AA' → '22 BH 1234 AA'. Unknown formats as stored. */
export function formatPlate(key) {
  if (!key) return '';
  const hit = plateMatch(key);
  return hit ? hit.f.show(hit.m).filter(Boolean).join(' ') : key;
}

/** A stored plate must be 4–12 letters/digits; anything else is a typing mistake. */
export function isPlateKey(key) {
  return /^[A-Z0-9]{4,12}$/.test(key) && /\d/.test(key);
}

// ---------------------------------------------------------------- GSTIN

export const GSTIN_RE = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
export const GSTIN_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

export function normalizeGstin(input) {
  return String(input ?? '')
    .toUpperCase()
    .replace(/\s/g, '');
}

/** The 15th character is a mod-36 check digit over the first 14. */
export function gstinCheckChar(first14) {
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const product = GSTIN_CHARS.indexOf(first14[i]) * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(product / 36) + (product % 36);
  }
  return GSTIN_CHARS[(36 - (sum % 36)) % 36];
}

/**
 * { valid, error, warnings: [], state_code } for a normalised GSTIN.
 * Format problems are errors. A wrong check digit, an unknown state, or a state that differs
 * from the party's state are warnings only (the user may know better).
 */
export function checkGstin(gstin, stateCode = '') {
  const out = { valid: false, error: null, warnings: [], state_code: '' };
  if (!gstin) return { ...out, valid: true };
  if (gstin.length !== 15) return { ...out, error: 'GSTIN must be 15 characters.' };
  if (!GSTIN_RE.test(gstin))
    return { ...out, error: 'GSTIN format looks wrong (e.g. 24ABCDE1234F1Z5).' };
  out.valid = true;
  out.state_code = gstin.slice(0, 2);
  if (!STATE_CODES.has(out.state_code)) out.warnings.push(`Unknown state code ${out.state_code}.`);
  if (gstinCheckChar(gstin.slice(0, 14)) !== gstin[14]) {
    out.warnings.push(
      'The last character (check digit) does not match. Please re-check the GSTIN.',
    );
  }
  if (stateCode && stateCode !== out.state_code) {
    out.warnings.push(
      `GSTIN is from ${stateName(out.state_code) || out.state_code}, but the state is ${stateName(stateCode) || stateCode}.`,
    );
  }
  return out;
}
