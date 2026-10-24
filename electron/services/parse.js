'use strict';

// Integer parsing for values typed by users or read from Excel/CSV.
// Mirrors src/utils/money.js and src/utils/qty.js (renderer is ESM, main is CJS).

function parseDecimal(input, decimals) {
  if (input == null || input === '') return null;
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) return null;
    const scaled = Math.round(input * 10 ** decimals);
    return Number.isSafeInteger(scaled) ? scaled : null;
  }
  if (typeof input !== 'string') return null;
  const cleaned = input.replace(/[₹,\s]/g, '').replace(/^rs\.?/i, '');
  const re = new RegExp(`^(-)?(\\d*)(?:\\.(\\d{0,${decimals}}))?$`);
  const m = re.exec(cleaned);
  if (!m || (m[2] === '' && !m[3])) return null;
  const value = Number(m[2] || 0) * 10 ** decimals + Number((m[3] || '').padEnd(decimals, '0'));
  if (!Number.isSafeInteger(value)) return null;
  return m[1] && value !== 0 ? -value : value;
}

/** '1,234.50' / 1234.5 → 123450 paise. null if invalid. */
const parseMoney = (v) => parseDecimal(v, 2);

/** '1.25' → 1250 milli-units. null if invalid. */
const parseQty = (v) => parseDecimal(v, 3);

/** '18' / '2.5' / '18%' → basis points. */
function parseRateBp(v) {
  if (typeof v === 'string') v = v.replace('%', '');
  return parseDecimal(v, 2);
}

function parseBool(v, fallback) {
  if (v == null || v === '') return fallback;
  if (typeof v === 'boolean') return v;
  const s = String(v).trim().toLowerCase();
  if (['yes', 'y', 'true', '1', 'incl', 'inclusive'].includes(s)) return true;
  if (['no', 'n', 'false', '0', 'excl', 'exclusive'].includes(s)) return false;
  return fallback;
}

function isISODate(v) {
  const m = typeof v === 'string' && /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!m) return false;
  // UTC on both sides so the local timezone (IST) can never shift the day.
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toISOString().slice(0, 10) === v;
}

function todayISO(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Trimmed string or '' for null/undefined/numbers. */
function str(v) {
  if (v == null) return '';
  return String(v).trim();
}

module.exports = { parseMoney, parseQty, parseRateBp, parseBool, isISODate, todayISO, str };
