'use strict';

const os = require('os');
const path = require('path');
const { BrowserWindow, dialog } = require('electron');
const dbm = require('../db');
const purchases = require('../services/purchases');
const purchaseReturns = require('../services/purchaseReturns');
const drafts = require('../services/purchaseDrafts');
const print = require('../services/purchasePrint');
const products = require('../services/products');
const dataFiles = require('../dataFiles');
const { printHtml, savePdf } = require('../printWindow');
const { AppError } = require('../errors');

const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));

/** Who did it: the computer's name until users / PIN arrive (Phase 8). */
function actor() {
  try {
    return os.hostname() || 'This computer';
  } catch {
    return 'This computer';
  }
}

function register(handle, { paths, getWindow }) {
  const db = () => dbm.getDb();
  const files = {
    commit: (temps, docNo) => dataFiles.commitAttachments(paths, temps, docNo),
    undo: (moves) => dataFiles.undoAttachmentMoves(paths, moves),
  };
  const ctx = () => ({ actor: actor(), files });

  // ------------------------------------------------------------ purchases
  handle('purchases:meta', () => purchases.meta(db()));
  handle('purchases:list', (params) =>
    purchases.list(db(), { ...params, party_id: num(params.party_id) }),
  );
  handle('purchases:stats', () => purchases.stats(db()));
  handle('purchases:payables', () => purchases.payables(db()));
  handle('purchases:get', ({ id }) => purchases.get(db(), Number(id)));
  handle('purchases:calculate', (payload) => purchases.calculate(db(), payload));
  handle('purchases:checkBillNo', (payload) =>
    purchases.checkBillNo(db(), { ...payload, exclude_id: num(payload.exclude_id) }),
  );
  handle('purchases:supplierInfo', ({ party_id: partyId, purchase_id: purchaseId }) => ({
    advance: purchases.advanceAvailable(db(), Number(partyId), num(purchaseId)),
  }));
  handle('purchases:lineInfo', ({ variant_id: variantId }) =>
    purchases.lineInfo(db(), { variant_id: Number(variantId) }),
  );
  handle('purchases:priceHistory', ({ product_id: productId }) =>
    purchases.priceHistory(db(), { product_id: Number(productId) }),
  );
  handle('purchases:create', ({ purchase }) => purchases.create(db(), purchase, ctx()));
  handle('purchases:editCheck', ({ id }) => purchases.editCheck(db(), { id: Number(id) }));
  handle('purchases:update', ({ id, purchase }) =>
    purchases.update(db(), Number(id), purchase, ctx()),
  );
  handle('purchases:cancel', (payload) =>
    purchases.cancel(db(), { ...payload, id: Number(payload.id) }, ctx()),
  );
  handle('purchases:recordPayment', (payload) =>
    purchases.recordPayment(db(), { ...payload, id: Number(payload.id) }, ctx()),
  );
  handle('products:lookupCode', ({ code }) => products.lookupCode(db(), { code }));

  // ------------------------------------------------------------ attachments
  handle('purchases:pickAttachments', async () => {
    const result = await dialog.showOpenDialog(getWindow(), {
      title: 'Attach the supplier bill (photo or PDF)',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Photo or PDF', extensions: dataFiles.ATTACHMENT_EXTS }],
    });
    if (result.canceled) return [];
    return result.filePaths.slice(0, 10).map((file) => {
      const staged = dataFiles.stageAttachment(paths, file);
      return { ...staged, url: `app-data://files/${staged.temp_path}` };
    });
  });
  handle('purchases:addAttachments', (payload) =>
    purchases.addAttachments(db(), { ...payload, id: Number(payload.id) }, ctx()),
  );
  handle('purchases:removeAttachment', ({ id }) =>
    purchases.removeAttachment(db(), { id: Number(id) }, ctx()),
  );
  // PDFs open in their own window (Chromium's built-in viewer); images preview in the app.
  handle('purchases:openAttachment', ({ id, temp_path: tempPath }) => {
    const rel = id ? purchases.attachmentFile(db(), { id: Number(id) }).file_path : tempPath;
    if (!dataFiles.resolveServable(paths, rel)) {
      throw new AppError('The file is missing from the data folder.', 'NOT_FOUND');
    }
    const win = new BrowserWindow({
      width: 900,
      height: 1000,
      parent: getWindow() || undefined,
      title: path.basename(rel),
      autoHideMenuBar: true,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        plugins: true,
      },
    });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (e) => e.preventDefault());
    win.loadURL(`app-data://files/${rel}`);
    return { opened: true };
  });

  // ------------------------------------------------------------ print / PDF / labels
  async function pdfDialog(title, defaultName) {
    const result = await dialog.showSaveDialog(getWindow(), {
      title,
      defaultPath: path.join(paths.exportsDir, defaultName),
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
    return result.canceled || !result.filePath ? null : result.filePath;
  }
  const fileSafe = (s) => dataFiles.docFolder(s);

  handle('purchases:print', ({ id }) => printHtml(paths, print.grnHtml(db(), Number(id))));
  handle('purchases:savePdf', async ({ id }) => {
    const p = purchases.get(db(), Number(id));
    const file = await pdfDialog('Save goods received note', `GRN_${fileSafe(p.entry_no)}.pdf`);
    if (!file) return { saved: false };
    return savePdf(paths, print.grnHtml(db(), p.id), file);
  });
  handle('purchases:printLabels', async ({ id, size, items, pdf }) => {
    const html = print.labelsHtml(db(), { id: Number(id), size, items });
    if (!pdf) return printHtml(paths, html);
    const p = purchases.get(db(), Number(id));
    const file = await pdfDialog('Save labels as PDF', `labels_${fileSafe(p.entry_no)}.pdf`);
    if (!file) return { saved: false };
    const opts =
      size === 'thermal50x25'
        ? {
            // printToPDF sizes are in inches.
            pageSize: { width: 50 / 25.4, height: 25 / 25.4 },
            margins: { top: 0, bottom: 0, left: 0, right: 0 },
          }
        : { pageSize: 'A4' };
    return savePdf(paths, html, file, opts);
  });

  // ------------------------------------------------------------ drafts
  handle('purchaseDrafts:list', () => drafts.list(db()));
  handle('purchaseDrafts:get', ({ id }) => drafts.get(db(), { id: Number(id) }));
  handle('purchaseDrafts:save', ({ id, form }) => drafts.save(db(), { id: num(id), form }));
  handle('purchaseDrafts:discard', ({ id }) => drafts.discard(db(), { id: Number(id) }));

  // ------------------------------------------------------------ returns
  handle('purchaseReturns:prepare', ({ purchase_id: purchaseId }) =>
    purchaseReturns.prepare(db(), { purchase_id: Number(purchaseId) }),
  );
  handle('purchaseReturns:calculate', (payload) => purchaseReturns.calculate(db(), payload));
  handle('purchaseReturns:create', ({ purchase_return: payload }) =>
    purchaseReturns.create(db(), payload, ctx()),
  );
  handle('purchaseReturns:list', (params) =>
    purchaseReturns.list(db(), { ...params, party_id: num(params.party_id) }),
  );
  handle('purchaseReturns:get', ({ id }) => purchaseReturns.get(db(), Number(id)));
  handle('purchaseReturns:cancel', (payload) =>
    purchaseReturns.cancel(db(), { ...payload, id: Number(payload.id) }, ctx()),
  );
}

module.exports = { register };
