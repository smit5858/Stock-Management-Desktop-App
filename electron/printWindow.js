'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { BrowserWindow } = require('electron');
const { AppError } = require('./errors');

/**
 * Renders HTML in a hidden, script-less window (from a temp file in data/exports, removed
 * afterwards) and hands its webContents to `fn` (print / printToPDF).
 */
async function withPrintWindow(paths, html, fn) {
  const tmp = path.join(paths.exportsDir, `.print-${crypto.randomBytes(6).toString('hex')}.html`);
  fs.writeFileSync(tmp, html, 'utf8');
  const win = new BrowserWindow({
    show: false,
    webPreferences: { javascript: false, sandbox: true, contextIsolation: true, spellcheck: false },
  });
  try {
    await win.loadFile(tmp);
    return await fn(win.webContents);
  } finally {
    win.destroy();
    fs.rmSync(tmp, { force: true });
  }
}

/**
 * Opens the system print dialog for `html`. `options` go to webContents.print (e.g.
 * { silent: true } prints straight to the default printer: thermal receipts).
 */
function printHtml(paths, html, options = {}) {
  return withPrintWindow(
    paths,
    html,
    (wc) =>
      new Promise((resolve, reject) => {
        wc.print({ printBackground: true, ...options }, (ok, reason) => {
          if (ok || reason === 'cancelled') resolve({ printed: ok });
          else reject(new AppError(`Could not print: ${reason}`, 'PRINT_FAILED'));
        });
      }),
  );
}

/** Writes `html` as a PDF to `file` (temp file + rename). */
async function savePdf(paths, html, file, pdfOptions = { pageSize: 'A4' }) {
  const pdf = await withPrintWindow(paths, html, (wc) =>
    wc.printToPDF({ printBackground: true, ...pdfOptions }),
  );
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, pdf);
  fs.renameSync(tmp, file);
  return { saved: true, file_path: file };
}

module.exports = { withPrintWindow, printHtml, savePdf };
