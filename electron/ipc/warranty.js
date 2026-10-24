'use strict';

const fs = require('fs');
const path = require('path');
const { BrowserWindow, dialog } = require('electron');
const dbm = require('../db');
const units = require('../services/warrantyUnits');
const claims = require('../services/claims');
const defective = require('../services/defective');
const claimPrint = require('../services/claimPrint');
const warrantyExport = require('../services/warrantyExport');
const products = require('../services/products');
const parties = require('../services/parties');
const settings = require('../services/settings');
const W = require('../services/warranty');
const dataFiles = require('../dataFiles');
const { printHtml, savePdf } = require('../printWindow');
const { todayISO } = require('../services/parse');
const { actor, logoDataUrl, fileSafe } = require('./shared');
const { AppError } = require('../errors');

const int = (v) => (v === null || v === undefined || v === '' ? null : Number(v));

/** Unit reference from the renderer: { serial_id } or { sale_item_id }. */
const unitRef = (p) =>
  p.serial_id != null ? { serial_id: Number(p.serial_id) } : { sale_item_id: int(p.sale_item_id) };

const PDF_OPTIONS = {
  a4half: { pageSize: 'A4' },
  thermal80: {
    pageSize: { width: 80 / 25.4, height: 297 / 25.4 },
    margins: { top: 0, bottom: 0, left: 0, right: 0 },
  },
};

/** Filters shared by the warranty and claim lists. */
function listParams(p = {}) {
  return {
    ...p,
    product_id: int(p.product_id),
    category_id: int(p.category_id),
    supplier_id: int(p.supplier_id),
    customer_id: int(p.customer_id),
  };
}

function register(handle, { paths, getWindow }) {
  const db = () => dbm.getDb();
  const files = {
    commit: (tempPaths, docNo, kind) => dataFiles.commitAttachments(paths, tempPaths, docNo, kind),
    undo: (moves) => dataFiles.undoAttachmentMoves(paths, moves),
  };
  const ctx = () => ({ actor: actor(), files });
  const slipFormat = (f) => {
    if (claimPrint.FORMATS.includes(f)) return f;
    return settings.getSettings(db()).claim_slip_format === 'thermal80' ? 'thermal80' : 'a4half';
  };

  async function saveXlsx(title, defaultName, write) {
    const result = await dialog.showSaveDialog(getWindow(), {
      title,
      defaultPath: path.join(paths.exportsDir, defaultName),
      filters: [{ name: 'Excel', extensions: ['xlsx'] }],
    });
    if (result.canceled || !result.filePath) return { saved: false };
    const info = await write(result.filePath);
    return { saved: true, file_path: result.filePath, ...info };
  }

  async function pdfTo(folder, name, html, fmt) {
    const dir = path.join(paths.exportsDir, folder, todayISO().slice(0, 4));
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${fileSafe(name)}${fmt === 'thermal80' ? '_80mm' : ''}.pdf`);
    return savePdf(paths, html, file, PDF_OPTIONS[fmt]);
  }

  // ------------------------------------------------------------ warranty (read side)
  handle('warranty:meta', () => {
    const s = settings.getSettings(db());
    const m = products.meta(db());
    return {
      expiring_days: units.expiringDays(db()),
      replacement_warranty: s.replacement_warranty === 'fresh' ? 'fresh' : 'remaining',
      claim_slip_format: s.claim_slip_format === 'thermal80' ? 'thermal80' : 'a4half',
      void_reasons: Object.fromEntries(units.MANUAL_VOID.map((k) => [k, W.VOID_REASONS[k]])),
      reject_reasons: claims.REJECT_REASONS,
      statuses: claims.STATUS_LABELS,
      decisions: claims.DECISIONS,
      outcomes: claims.OUTCOMES,
      dispatch_modes: claims.DISPATCH_MODES,
      categories: m.categories,
      brands: m.brands,
      suppliers: parties
        .list(db(), { type: 'supplier', status: 'active' })
        .rows.map((r) => ({ id: r.id, name: r.name })),
    };
  });
  handle('warranty:search', ({ query }) => units.search(db(), { query }));
  handle('warranty:unit', (p) => units.unit(db(), unitRef(p)));
  handle('warranty:list', (p) => units.list(db(), listParams(p)));
  handle('warranty:void', (p) =>
    units.voidWarranty(db(), { ...unitRef(p), reason: p.reason, note: p.note }),
  );
  handle('warranty:alerts', () => units.alerts(db()));
  handle('warranty:export', (p) =>
    saveXlsx('Export warranties', `warranties_${p.tab || 'active'}_${todayISO()}.xlsx`, (file) =>
      warrantyExport.exportWarranties(db(), file, listParams(p)),
    ),
  );

  // Warranty card: { sale_id } (all warranty items of a bill) or one { serial_id | sale_item_id }.
  const cardRef = (p) => (p.sale_id != null ? { sale_id: Number(p.sale_id) } : unitRef(p));
  const cardHtml = (p, fmt) =>
    claimPrint.warrantyCardHtml(db(), cardRef(p), { format: fmt, logo: logoDataUrl(paths) });
  handle('warranty:cardHtml', (p) => cardHtml(p, slipFormat(p.format)));
  handle('warranty:cardPrint', (p) => printHtml(paths, cardHtml(p, slipFormat(p.format))));
  handle('warranty:cardPdf', (p) => {
    const fmt = slipFormat(p.format);
    const name =
      p.sale_id != null ? `card_sale_${p.sale_id}` : `card_${p.serial_id ?? p.sale_item_id}`;
    return pdfTo('warranty-cards', name, cardHtml(p, fmt), fmt);
  });

  // ------------------------------------------------------------ claims
  handle('claims:prepare', (p) => claims.prepare(db(), unitRef(p)));
  handle('claims:create', ({ claim }) => claims.create(db(), claim, ctx()));
  handle('claims:get', ({ id }) => claims.get(db(), Number(id)));
  handle('claims:list', (p) => claims.list(db(), listParams(p)));
  handle('claims:export', (p) =>
    saveXlsx('Export warranty claims', `claims_${p.tab || 'all'}_${todayISO()}.xlsx`, (file) =>
      warrantyExport.exportClaims(db(), file, listParams(p)),
    ),
  );
  const action = (name, fn) =>
    handle(`claims:${name}`, (p) => fn(db(), { ...p, id: Number(p.id) }, ctx()));
  action('inspect', claims.inspect);
  action('decide', claims.decide);
  action('repairDone', claims.repairDone);
  action('dispatch', claims.dispatch);
  action('supplierResult', claims.supplierResult);
  action('replace', claims.replace);
  action('refund', claims.refund);
  action('handover', claims.handover);
  action('close', claims.close);
  action('cancel', claims.cancel);
  handle('claims:billPrefill', ({ id }) => claims.billPrefill(db(), { id: Number(id) }));
  handle('claims:forProduct', ({ product_id: productId }) =>
    claims.forProduct(db(), Number(productId)),
  );

  // Photos: picked files are copied to attachments/tmp at once; saving moves them into
  // attachments/claims/<claim no>/ inside the save transaction.
  handle('claims:pickPhotos', async () => {
    const result = await dialog.showOpenDialog(getWindow(), {
      title: 'Add photos of the item',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Photo or PDF', extensions: dataFiles.ATTACHMENT_EXTS }],
    });
    if (result.canceled) return [];
    return result.filePaths.slice(0, 10).map((file) => {
      const staged = dataFiles.stageAttachment(paths, file);
      return { ...staged, url: `app-data://files/${staged.temp_path}` };
    });
  });
  handle('claims:addAttachments', (p) =>
    claims.addAttachments(db(), { id: Number(p.id), attachments: p.attachments }, ctx()),
  );
  handle('claims:removeAttachment', ({ id }) =>
    claims.removeAttachment(db(), { id: Number(id) }, ctx()),
  );
  handle('claims:openAttachment', ({ id, temp_path: tempPath }) => {
    const rel = id ? claims.attachmentFile(db(), { id: Number(id) }).file_path : tempPath;
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

  // Slips: { id, doc: slip | rejection | handover, format: a4half | thermal80 }
  const slipHtml = (p, fmt) =>
    claimPrint.claimHtml(db(), Number(p.id), { doc: p.doc, format: fmt, logo: logoDataUrl(paths) });
  handle('claims:slipHtml', (p) => slipHtml(p, slipFormat(p.format)));
  handle('claims:slipPrint', (p) => printHtml(paths, slipHtml(p, slipFormat(p.format))));
  handle('claims:slipPdf', (p) => {
    const fmt = slipFormat(p.format);
    const c = claims.claimRow(db(), Number(p.id));
    const doc = claimPrint.DOCS[p.doc] ? p.doc : 'slip';
    return pdfTo('claims', `${c.claim_no}_${doc}`, slipHtml({ ...p, doc }, fmt), fmt);
  });

  // ------------------------------------------------------------ defective stock
  handle('defective:list', (p) => defective.list(db(), p));
  handle('defective:count', () => defective.count(db()));
  handle('defective:writeOff', (p) =>
    defective.writeOff(db(), { ...p, serial_id: int(p.serial_id), variant_id: int(p.variant_id) }),
  );
  handle('defective:repair', (p) =>
    defective.repair(db(), { ...p, serial_id: int(p.serial_id), variant_id: int(p.variant_id) }),
  );
  handle('defective:sendToSupplier', (p) =>
    defective.sendToSupplier(
      db(),
      {
        ...p,
        serial_id: int(p.serial_id),
        variant_id: int(p.variant_id),
        supplier_party_id: int(p.supplier_party_id),
      },
      ctx(),
    ),
  );
}

module.exports = { register };
