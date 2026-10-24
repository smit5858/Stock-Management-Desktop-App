'use strict';

// Code 128 (set B) as an SVG string: no dependency, works offline. Set B covers printable
// ASCII, which is all SKUs and barcodes can contain (letters, digits, '-').

// Bar/space widths for values 0–105 (each sums to 11 modules); STOP is 13 modules.
// prettier-ignore
const PATTERNS = [
  '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213',
  '221312', '231212', '112232', '122132', '122231', '113222', '123122', '123221', '223211', '221132',
  '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211',
  '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
  '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331',
  '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111',
  '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221', '112214',
  '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
  '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141',
  '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141',
  '114131', '311141', '411131', '211412', '211214', '211232',
];
const START_B = 104;
const STOP = '2331112';

/** Symbol values (start, data, checksum) for `text`. Throws for characters outside set B. */
function encode128B(text) {
  const values = [START_B];
  for (const ch of String(text)) {
    const code = ch.charCodeAt(0);
    if (code < 32 || code > 127) throw new Error(`Cannot encode "${ch}" in Code 128`);
    values.push(code - 32);
  }
  let sum = values[0];
  for (let i = 1; i < values.length; i++) sum += values[i] * i;
  values.push(sum % 103);
  return values;
}

/** Module widths (bar, space, bar, …) including the stop pattern. */
function modules(text) {
  const widths = [];
  for (const v of encode128B(text)) for (const c of PATTERNS[v]) widths.push(Number(c));
  for (const c of STOP) widths.push(Number(c));
  return widths;
}

/**
 * SVG barcode. Width scales to its container (viewBox); `height` is in the viewBox's
 * module units. Quiet zone of 10 modules on each side.
 */
function code128Svg(text, { height = 40 } = {}) {
  const widths = modules(text);
  const quiet = 10;
  let x = quiet;
  const rects = [];
  widths.forEach((w, i) => {
    if (i % 2 === 0) rects.push(`<rect x="${x}" y="0" width="${w}" height="${height}"/>`);
    x += w;
  });
  const total = x + quiet;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${height}" preserveAspectRatio="none" shape-rendering="crispEdges"><g fill="#000">${rects.join('')}</g></svg>`;
}

module.exports = { encode128B, modules, code128Svg, PATTERNS };
