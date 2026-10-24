'use strict';

const fs = require('fs');
const path = require('path');
const { dialog } = require('electron');
const { withPrintWindow } = require('../printWindow');
const dbm = require('../db');
const parties = require('../services/parties');
const vehicles = require('../services/vehicles');
const statements = require('../services/statements');
const partyImport = require('../services/partyImport');
const { todayISO } = require('../services/parse');
const { AppError } = require('../errors');

const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));

function safeName(text) {
  return (
    String(text || 'party')
      .replace(/[^A-Za-z0-9 _-]/g, '')
      .trim()
      .replace(/\s+/g, '_')
      .slice(0, 40) || 'party'
  );
}

function register(handle, { paths, getWindow }) {
  const db = () => dbm.getDb();

  async function saveDialog(title, defaultName, name, extensions) {
    const result = await dialog.showSaveDialog(getWindow(), {
      title,
      defaultPath: path.join(paths.exportsDir, defaultName),
      filters: [{ name, extensions }],
    });
    return result.canceled || !result.filePath ? null : result.filePath;
  }

  async function saveXlsx(title, defaultName, write) {
    const file = await saveDialog(title, defaultName, 'Excel', ['xlsx']);
    if (!file) return { saved: false };
    const info = await write(file);
    return { saved: true, file_path: file, ...info };
  }

  // ------------------------------------------------------------ parties
  handle('parties:meta', () => parties.meta(db()));
  handle('parties:list', (params) =>
    parties.list(db(), {
      ...params,
      customer_type_id: num(params.customer_type_id),
      vehicle_model_id: num(params.vehicle_model_id),
    }),
  );
  handle('parties:stats', ({ type }) => parties.stats(db(), { type }));
  handle('parties:get', ({ id }) => parties.get(db(), Number(id)));
  handle('parties:create', ({ type, party, vehicles: list }) =>
    parties.create(db(), { type, party, vehicles: list }),
  );
  handle('parties:update', ({ id, party }) => parties.update(db(), Number(id), party));
  handle('parties:setActive', ({ id, is_active }) =>
    parties.setActive(db(), { id: Number(id), is_active }),
  );
  handle('parties:delete', ({ id }) => parties.remove(db(), { id: Number(id) }));
  handle('parties:checkDuplicates', (payload) => parties.checkDuplicates(db(), payload));
  handle('parties:search', ({ query, type, limit }) =>
    parties.search(db(), { query, type: type || null, limit }),
  );
  handle('parties:summary', ({ id }) => parties.summary(db(), Number(id)));
  handle('parties:quickAdd', (payload) =>
    parties.quickAdd(db(), { ...payload, vehicle_model_id: num(payload.vehicle_model_id) }),
  );
  handle('parties:createLinked', ({ id }) => parties.createLinked(db(), { id: Number(id) }));
  handle('parties:link', ({ id, other_id }) =>
    parties.link(db(), { id: Number(id), other_id: Number(other_id) }),
  );
  handle('parties:unlink', ({ id }) => parties.unlink(db(), { id: Number(id) }));
  handle('parties:mergePreview', ({ keep_id, merge_id }) =>
    parties.mergePreview(db(), { keep_id: Number(keep_id), merge_id: Number(merge_id) }),
  );
  handle('parties:merge', ({ keep_id, merge_id, note }) =>
    parties.merge(db(), { keep_id: Number(keep_id), merge_id: Number(merge_id), note }),
  );

  handle('parties:ledger', ({ id, from, to }) =>
    parties.ledger(db(), { id: Number(id), from, to }),
  );
  handle('parties:bills', ({ id, vehicle_id }) =>
    parties.bills(db(), { id: Number(id), vehicle_id: num(vehicle_id) }),
  );
  handle('parties:payments', ({ id }) => parties.payments(db(), { id: Number(id) }));
  handle('parties:purchases', ({ id }) => parties.purchases(db(), { id: Number(id) }));
  handle('parties:warranties', ({ id }) => parties.warranties(db(), { id: Number(id) }));
  handle('parties:claims', ({ id }) => parties.supplierClaims(db(), { id: Number(id) }));
  handle('parties:suppliedProducts', ({ id }) =>
    parties.suppliedProducts(db(), { id: Number(id) }),
  );

  handle('parties:ledgerExport', async ({ id, from, to }) => {
    const p = parties.get(db(), Number(id));
    return saveXlsx('Export ledger', `ledger_${safeName(p.name)}_${todayISO()}.xlsx`, (file) =>
      statements.exportLedger(db(), { id: p.id, from, to }, file),
    );
  });

  handle('parties:statementPdf', async ({ id, from, to }) => {
    const p = parties.get(db(), Number(id));
    const file = await saveDialog(
      'Save statement as PDF',
      `statement_${safeName(p.name)}_${todayISO()}.pdf`,
      'PDF',
      ['pdf'],
    );
    if (!file) return { saved: false };
    const html = statements.statementHtml(db(), { id: p.id, from, to });
    const pdf = await withPrintWindow(paths, html, (wc) =>
      wc.printToPDF({ pageSize: 'A4', printBackground: true }),
    );
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, pdf);
    fs.renameSync(tmp, file);
    return { saved: true, file_path: file };
  });

  handle('parties:statementPrint', async ({ id, from, to }) => {
    const html = statements.statementHtml(db(), { id: Number(id), from, to });
    return withPrintWindow(
      paths,
      html,
      (wc) =>
        new Promise((resolve, reject) => {
          wc.print({ printBackground: true }, (ok, reason) => {
            if (ok || reason === 'cancelled') resolve({ printed: ok });
            else reject(new AppError(`Could not print: ${reason}`, 'PRINT_FAILED'));
          });
        }),
    );
  });

  handle('parties:exportXlsx', (params) => {
    const type = params.type === 'supplier' ? 'supplier' : 'customer';
    return saveXlsx(
      type === 'supplier' ? 'Export suppliers' : 'Export customers',
      `${type}s_${todayISO()}.xlsx`,
      (file) =>
        statements.exportList(
          db(),
          {
            ...params,
            type,
            customer_type_id: num(params.customer_type_id),
            vehicle_model_id: num(params.vehicle_model_id),
          },
          file,
        ),
    );
  });

  // ------------------------------------------------------------ import
  handle(
    'parties:importTemplate',
    ({ type }) =>
      saveXlsx(
        'Save import template',
        `${type === 'supplier' ? 'suppliers' : 'customers'}_import_template.xlsx`,
        (file) => partyImport.writeTemplate(type === 'supplier' ? 'supplier' : 'customer', file),
      ),
    { waitForDb: false },
  );
  handle('parties:importOpen', async ({ type }) => {
    const result = await dialog.showOpenDialog(getWindow(), {
      title: type === 'supplier' ? 'Import suppliers' : 'Import customers',
      properties: ['openFile'],
      filters: [{ name: 'Excel or CSV', extensions: ['xlsx', 'csv'] }],
    });
    if (result.canceled) return null;
    return partyImport.open(db(), { type, file: result.filePaths[0] });
  });
  handle('parties:importPreview', (payload) => partyImport.preview(db(), payload));
  handle('parties:importCommit', ({ token }) => partyImport.commit(db(), { token }));

  // ------------------------------------------------------------ customer types
  handle('customerTypes:list', () => parties.listCustomerTypes(db()));
  handle('customerTypes:save', (payload) =>
    parties.saveCustomerType(db(), { ...payload, id: num(payload.id) }),
  );
  handle('customerTypes:delete', ({ id }) => parties.deleteCustomerType(db(), { id: Number(id) }));

  // ------------------------------------------------------------ customer vehicles
  handle('vehicles:check', ({ plate, id }) => vehicles.check(db(), { plate, id }));
  handle('vehicles:create', ({ customer_id, vehicle }) =>
    vehicles.create(db(), { customer_id: Number(customer_id), vehicle }),
  );
  handle('vehicles:update', ({ id, vehicle }) =>
    vehicles.update(db(), { id: Number(id), vehicle }),
  );
  handle('vehicles:setPrimary', ({ id }) => vehicles.setPrimary(db(), { id: Number(id) }));
  handle('vehicles:transfer', ({ id, to_customer_id, date, note }) =>
    vehicles.transfer(db(), { id: Number(id), to_customer_id: Number(to_customer_id), date, note }),
  );
  handle('vehicles:history', ({ id }) => vehicles.history(db(), { id: Number(id) }));
  handle('vehicles:remove', ({ id }) => vehicles.remove(db(), { id: Number(id) }));
  handle('vehicles:compatibleProducts', ({ id }) =>
    vehicles.compatibleProducts(db(), { id: Number(id) }),
  );
}

module.exports = { register };
