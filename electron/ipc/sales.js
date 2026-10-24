'use strict';

const fs = require('fs');
const path = require('path');
const { shell } = require('electron');
const dbm = require('../db');
const sales = require('../services/sales');
const saleReturns = require('../services/saleReturns');
const quotations = require('../services/quotations');
const drafts = require('../services/saleDrafts');
const print = require('../services/salePrint');
const settings = require('../services/settings');
const { actor, logoDataUrl, fileSafe } = require('./shared');
const { printHtml, savePdf } = require('../printWindow');
const { AppError } = require('../errors');

const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));

const PDF_OPTIONS = {
  a4: { pageSize: 'A4' },
  // Thermal roll: 80 mm wide (printToPDF sizes are in inches); long receipts continue on the
  // next "page".
  thermal80: {
    pageSize: { width: 80 / 25.4, height: 297 / 25.4 },
    margins: { top: 0, bottom: 0, left: 0, right: 0 },
  },
};

function register(handle, { paths }) {
  const db = () => dbm.getDb();
  const ctx = () => ({ actor: actor() });
  const format = (f) => {
    if (f === 'a4' || f === 'thermal80') return f;
    return settings.getSettings(db()).print_format === 'thermal80' ? 'thermal80' : 'a4';
  };

  /** data/exports/<folder>/<year>/<number>.pdf (temp file + rename inside savePdf). */
  async function docPdf(folder, number, date, html, fmt) {
    const dir = path.join(paths.exportsDir, folder, String(date).slice(0, 4));
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${fileSafe(number)}${fmt === 'thermal80' ? '_80mm' : ''}.pdf`);
    return savePdf(paths, html, file, PDF_OPTIONS[fmt]);
  }

  // ------------------------------------------------------------ bills
  handle('sales:meta', () => sales.meta(db()));
  handle('sales:searchItems', ({ query, vehicle_id: vehicleId, limit }) =>
    sales.searchItems(db(), { query, vehicle_id: num(vehicleId), limit }),
  );
  handle('sales:customerInfo', ({ party_id: partyId }) =>
    sales.customerInfo(db(), { party_id: Number(partyId) }),
  );
  handle('sales:calculate', (payload) => sales.calculate(db(), payload));
  handle('sales:create', ({ sale }) => sales.create(db(), sale, ctx()));
  handle('sales:get', ({ id }) => sales.get(db(), Number(id)));
  handle('sales:list', (params) => sales.list(db(), { ...params, party_id: num(params.party_id) }));
  handle('sales:stats', () => sales.stats(db()));
  handle('sales:recent', ({ limit }) => sales.recent(db(), { limit }));
  handle('sales:cancel', (payload) =>
    sales.cancel(db(), { ...payload, id: Number(payload.id) }, ctx()),
  );
  handle('sales:prefill', ({ sale_id: saleId, quotation_id: quotationId }) =>
    sales.prefill(db(), { sale_id: num(saleId), quotation_id: num(quotationId) }),
  );
  handle('sales:recordPayment', (payload) =>
    sales.recordPayment(db(), { ...payload, id: Number(payload.id) }, ctx()),
  );

  // Print preview (no counter), print (reprints are marked DUPLICATE) and PDF.
  handle('sales:previewHtml', ({ id, format: f }) => {
    const saleId = Number(id);
    const duplicate = sales.saleRow(db(), saleId).print_count > 0;
    return print.invoiceHtml(db(), saleId, {
      format: format(f),
      duplicate,
      logo: logoDataUrl(paths),
    });
  });
  handle('sales:print', async ({ id, format: f, silent }) => {
    const saleId = Number(id);
    const fmt = format(f);
    const duplicate = sales.markPrinted(db(), saleId, { format: fmt }, ctx());
    const html = print.invoiceHtml(db(), saleId, {
      format: fmt,
      duplicate,
      logo: logoDataUrl(paths),
    });
    const s = settings.getSettings(db());
    const quiet = fmt === 'thermal80' && (silent ?? s.thermal_silent_print === '1');
    return printHtml(paths, html, quiet ? { silent: true } : {});
  });
  handle('sales:savePdf', async ({ id, format: f }) => {
    const saleId = Number(id);
    const fmt = format(f);
    const sale = sales.saleRow(db(), saleId);
    const duplicate = sales.markPrinted(db(), saleId, { format: fmt, pdf: true }, ctx());
    const html = print.invoiceHtml(db(), saleId, {
      format: fmt,
      duplicate,
      logo: logoDataUrl(paths),
    });
    return docPdf('invoices', sale.invoice_no, sale.invoice_date, html, fmt);
  });
  handle('sales:showFile', ({ file_path: file }) => {
    // Only files the app wrote into data/exports.
    const rel = path.relative(paths.exportsDir, String(file || ''));
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || !fs.existsSync(file)) {
      throw new AppError('File not found.', 'NOT_FOUND');
    }
    shell.showItemInFolder(file);
    return { shown: true };
  });

  // ------------------------------------------------------------ held bills
  handle('saleDrafts:list', () => drafts.list(db()));
  handle('saleDrafts:get', ({ id }) => drafts.get(db(), { id: Number(id) }));
  handle('saleDrafts:save', ({ id, form }) => drafts.save(db(), { id: num(id), form }));
  handle('saleDrafts:discard', ({ id }) => drafts.discard(db(), { id: Number(id) }));

  // ------------------------------------------------------------ quotations
  handle('quotations:create', ({ quotation }) => quotations.create(db(), quotation, ctx()));
  handle('quotations:get', ({ id }) => quotations.get(db(), Number(id)));
  handle('quotations:list', (params) =>
    quotations.list(db(), { ...params, party_id: num(params.party_id) }),
  );
  handle('quotations:cancel', (payload) =>
    quotations.cancel(db(), { ...payload, id: Number(payload.id) }, ctx()),
  );
  handle('quotations:previewHtml', ({ id, format: f }) =>
    print.quotationHtml(db(), Number(id), { format: format(f), logo: logoDataUrl(paths) }),
  );
  handle('quotations:print', ({ id, format: f }) =>
    printHtml(
      paths,
      print.quotationHtml(db(), Number(id), { format: format(f), logo: logoDataUrl(paths) }),
    ),
  );
  handle('quotations:savePdf', async ({ id, format: f }) => {
    const q = quotations.get(db(), Number(id));
    const fmt = format(f);
    const html = print.quotationHtml(db(), q.id, { format: fmt, logo: logoDataUrl(paths) });
    return docPdf('quotations', q.quote_no, q.quote_date, html, fmt);
  });

  // ------------------------------------------------------------ returns (credit notes)
  handle('saleReturns:find', ({ query }) => saleReturns.find(db(), { query }));
  handle('saleReturns:prepare', ({ sale_id: saleId }) =>
    saleReturns.prepare(db(), { sale_id: Number(saleId) }),
  );
  handle('saleReturns:calculate', (payload) => saleReturns.calculate(db(), payload));
  handle('saleReturns:create', ({ sale_return: payload }) =>
    saleReturns.create(db(), payload, ctx()),
  );
  handle('saleReturns:exchange', (payload) => saleReturns.exchange(db(), payload, ctx()));
  handle('saleReturns:get', ({ id }) => saleReturns.get(db(), Number(id)));
  handle('saleReturns:list', (params) =>
    saleReturns.list(db(), { ...params, party_id: num(params.party_id) }),
  );
  handle('saleReturns:previewHtml', ({ id, format: f }) => {
    const r = saleReturns.get(db(), Number(id));
    return print.creditNoteHtml(db(), r.id, {
      format: format(f),
      duplicate: r.print_count > 0,
      logo: logoDataUrl(paths),
    });
  });
  handle('saleReturns:print', ({ id, format: f }) => {
    const fmt = format(f);
    const duplicate = saleReturns.markPrinted(db(), Number(id), {}, ctx());
    return printHtml(
      paths,
      print.creditNoteHtml(db(), Number(id), { format: fmt, duplicate, logo: logoDataUrl(paths) }),
    );
  });
  handle('saleReturns:savePdf', async ({ id, format: f }) => {
    const fmt = format(f);
    const r = saleReturns.get(db(), Number(id));
    const duplicate = saleReturns.markPrinted(db(), r.id, { pdf: true }, ctx());
    const html = print.creditNoteHtml(db(), r.id, {
      format: fmt,
      duplicate,
      logo: logoDataUrl(paths),
    });
    return docPdf('credit-notes', r.return_no, r.date, html, fmt);
  });
}

module.exports = { register };
