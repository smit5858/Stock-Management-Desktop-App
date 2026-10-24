'use strict';

// Spreadsheet helpers shared by the importers / exporters: read .xlsx / .csv into a grid,
// write a workbook atomically (temp file, then rename).

const fs = require('fs');
const path = require('path');
const { AppError } = require('../errors');

// exceljs is ~220 files (≈0.5 s warm, several seconds on a cold start with antivirus scanning):
// load it on the first import / export instead of at app start.
let excel = null;
function newWorkbook() {
  if (!excel) excel = require('exceljs');
  return new excel.Workbook();
}

const HEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE0E7FF' } };

function cellValue(v) {
  if (v == null) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    if ('result' in v) return cellValue(v.result);
    if ('text' in v) return String(v.text);
    if (Array.isArray(v.richText)) return v.richText.map((t) => t.text).join('');
    return '';
  }
  return v;
}

/** Minimal RFC 4180 CSV parser (quotes, escaped quotes, CRLF). */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** Excel saves UTF-8 CSV with a byte-order mark (code 0xFEFF) at the start. */
function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** First sheet of an .xlsx, or a .csv, as an array of rows (arrays of cell values). */
async function readGrid(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.csv') return parseCsv(stripBom(fs.readFileSync(file, 'utf8')));
  if (ext !== '.xlsx') throw new AppError('Choose an Excel (.xlsx) or CSV file.', 'VALIDATION');
  const wb = newWorkbook();
  await wb.xlsx.readFile(file);
  const ws = wb.worksheets[0];
  if (!ws) throw new AppError('The Excel file has no sheets.', 'VALIDATION');
  const table = [];
  ws.eachRow({ includeEmpty: true }, (r, n) => {
    const values = [];
    for (let c = 1; c <= ws.columnCount; c++) values.push(cellValue(r.getCell(c).value));
    table[n - 1] = values;
  });
  for (let i = 0; i < table.length; i++) table[i] = table[i] || [];
  return table;
}

/** Writes to `<file>.tmp` first, then renames, so a pulled USB never leaves half a file. */
async function writeWorkbook(wb, file) {
  const tmp = `${file}.tmp`;
  await wb.xlsx.writeFile(tmp);
  fs.renameSync(tmp, file);
}

/** Bold, tinted, frozen header row. */
function styleHeader(ws) {
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).fill = HEADER_FILL;
  ws.views = [{ state: 'frozen', ySplit: 1 }];
}

module.exports = {
  newWorkbook,
  cellValue,
  parseCsv,
  stripBom,
  readGrid,
  writeWorkbook,
  styleHeader,
};
