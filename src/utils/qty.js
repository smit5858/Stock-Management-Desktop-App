// Quantities are integer milli-units (3 decimal places): 1.25 kg → 1250.

/** 1250 → "1.25", 3000 → "3". */
export function formatQty(milli) {
  if (milli == null || !Number.isInteger(milli)) return '';
  const negative = milli < 0;
  const abs = Math.abs(milli);
  const frac = abs % 1000;
  const whole = (abs - frac) / 1000;
  const fracText = frac ? `.${String(frac).padStart(3, '0').replace(/0+$/, '')}` : '';
  return `${negative ? '-' : ''}${whole.toLocaleString('en-IN')}${fracText}`;
}

/** "1.25" → 1250. Returns null for invalid input or more than 3 decimals. */
export function parseQty(input) {
  if (typeof input === 'number') input = String(input);
  if (typeof input !== 'string') return null;
  const m = /^(-)?(\d*)(?:\.(\d{0,3}))?$/.exec(input.replace(/[,\s]/g, ''));
  if (!m || (m[2] === '' && !m[3])) return null;
  const value = (m[2] === '' ? 0 : Number(m[2])) * 1000 + Number((m[3] || '').padEnd(3, '0'));
  if (!Number.isSafeInteger(value)) return null;
  return m[1] && value !== 0 ? -value : value;
}

/** GST rate in basis points → "18%", 250 → "2.5%". */
export function formatRateBp(bp) {
  if (bp == null || !Number.isInteger(bp)) return '';
  const frac = bp % 100;
  const whole = (bp - frac) / 100;
  return `${whole}${frac ? `.${String(frac).padStart(2, '0').replace(/0+$/, '')}` : ''}%`;
}
