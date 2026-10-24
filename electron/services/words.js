'use strict';

// Amount in words with Indian numbering (thousand, lakh, crore), for invoices.
//   12345678 paise → "Rupees One Lakh Twenty Three Thousand Four Hundred Fifty Six and
//   Seventy Eight Paise Only"

const ONES = [
  '',
  'One',
  'Two',
  'Three',
  'Four',
  'Five',
  'Six',
  'Seven',
  'Eight',
  'Nine',
  'Ten',
  'Eleven',
  'Twelve',
  'Thirteen',
  'Fourteen',
  'Fifteen',
  'Sixteen',
  'Seventeen',
  'Eighteen',
  'Nineteen',
];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

/** 0–99 */
function twoDigits(n) {
  if (n < 20) return ONES[n];
  return [TENS[Math.floor(n / 10)], ONES[n % 10]].filter(Boolean).join(' ');
}

/** 0–999 */
function threeDigits(n) {
  const h = Math.floor(n / 100);
  const rest = n % 100;
  return [h ? `${ONES[h]} Hundred` : '', rest ? twoDigits(rest) : ''].filter(Boolean).join(' ');
}

/** Whole number in words, Indian system. 0 → "Zero". Works up to Number.MAX_SAFE_INTEGER. */
function numberToWords(value) {
  let n = Math.floor(Math.abs(value));
  if (n === 0) return 'Zero';
  const parts = [];
  // Above 99 crore the crore count itself is spelled in the Indian system ("One Hundred Crore").
  const crore = Math.floor(n / 1e7);
  n %= 1e7;
  if (crore) parts.push(`${numberToWords(crore)} Crore`);
  const lakh = Math.floor(n / 1e5);
  n %= 1e5;
  if (lakh) parts.push(`${twoDigits(lakh)} Lakh`);
  const thousand = Math.floor(n / 1000);
  n %= 1000;
  if (thousand) parts.push(`${twoDigits(thousand)} Thousand`);
  if (n) parts.push(threeDigits(n));
  return parts.join(' ');
}

/** Paise → "Rupees … and … Paise Only" ("Rupees Zero Only" for 0). */
function amountInWords(paise) {
  const neg = paise < 0;
  const abs = Math.abs(paise);
  const rupees = Math.floor(abs / 100);
  const p = abs % 100;
  const text = `Rupees ${numberToWords(rupees)}${p ? ` and ${twoDigits(p)} Paise` : ''} Only`;
  return neg ? `Minus ${text}` : text;
}

module.exports = { numberToWords, amountInWords };
