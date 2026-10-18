// Money is always integer paise. These helpers are the only place ₹ formatting happens.

/** 12345678 → "₹1,23,456.78" (Indian digit grouping). */
export function formatMoney(paise, { symbol = true } = {}) {
  if (paise == null || !Number.isInteger(paise)) return '';
  const negative = paise < 0;
  const abs = Math.abs(paise);
  const p = abs % 100;
  const rupees = (abs - p) / 100;
  const text = `${rupees.toLocaleString('en-IN')}.${String(p).padStart(2, '0')}`;
  return `${negative ? '-' : ''}${symbol ? '₹' : ''}${text}`;
}

/**
 * Parses user input like "1,234.5", "₹ 99", "-12.05" into integer paise without floating point.
 * Returns null when the input is not a valid amount (including more than 2 decimals).
 */
export function parseMoney(input) {
  if (typeof input === 'number') input = String(input);
  if (typeof input !== 'string') return null;
  const cleaned = input.replace(/[₹,\s]/g, '');
  const m = /^(-)?(\d*)(?:\.(\d{0,2}))?$/.exec(cleaned);
  if (!m || (m[2] === '' && !m[3])) return null;
  const rupees = m[2] === '' ? 0 : Number(m[2]);
  const paise = Number((m[3] || '').padEnd(2, '0'));
  const value = rupees * 100 + paise;
  if (!Number.isSafeInteger(value)) return null;
  return m[1] && value !== 0 ? -value : value;
}

/** For pre-filling an input: 12345 → "123.45", 12300 → "123". */
export function paiseToInput(paise) {
  if (paise == null || !Number.isInteger(paise)) return '';
  return formatMoney(paise, { symbol: false }).replace(/,/g, '').replace(/\.00$/, '');
}
