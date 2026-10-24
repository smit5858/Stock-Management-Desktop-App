'use strict';

const path = require('path');
const { dialog } = require('electron');
const dbm = require('../db');
const products = require('../services/products');
const stock = require('../services/stock');
const productImport = require('../services/productImport');
const dataFiles = require('../dataFiles');
const { todayISO } = require('../services/parse');

function register(handle, { paths, getWindow }) {
  const db = () => dbm.getDb();

  handle('products:meta', () => products.meta(db()));
  handle('products:list', (params) => products.list(db(), params));
  handle('products:stats', () => products.stats(db()));
  handle('products:get', ({ id }) => products.get(db(), Number(id)));
  handle('products:create', ({ product }) => products.create(db(), product));
  handle('products:update', ({ id, product }) => products.update(db(), Number(id), product));
  handle('products:setActive', (payload) => products.setActive(db(), payload));
  handle('products:search', ({ query, limit }) => products.search(db(), { query, limit }));

  handle('categories:create', (payload) => products.createCategory(db(), payload));
  handle('vehicleModels:create', (payload) => products.createVehicle(db(), payload));

  handle('stock:adjust', (payload) => stock.adjust(db(), payload));
  handle('stock:ledger', (payload) => stock.ledger(db(), payload));

  handle('products:pickImage', async () => {
    const result = await dialog.showOpenDialog(getWindow(), {
      title: 'Choose a product photo',
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: dataFiles.IMAGE_EXTS }],
    });
    if (result.canceled) return null;
    const rel = dataFiles.saveImage(paths, result.filePaths[0]);
    return { image_path: rel, image_url: `app-data://files/${rel}` };
  });

  handle('products:importPreview', async () => {
    const result = await dialog.showOpenDialog(getWindow(), {
      title: 'Import products',
      properties: ['openFile'],
      filters: [{ name: 'Excel or CSV', extensions: ['xlsx', 'csv'] }],
    });
    if (result.canceled) return null;
    return productImport.preview(db(), result.filePaths[0]);
  });

  handle('products:importCommit', (payload) => productImport.commit(db(), payload));

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

  handle('products:exportXlsx', () =>
    saveXlsx('Export products', `products_${todayISO()}.xlsx`, (file) =>
      productImport.exportXlsx(db(), file),
    ),
  );
  handle(
    'products:template',
    () =>
      saveXlsx('Save import template', 'products_import_template.xlsx', (file) =>
        productImport.writeTemplate(file),
      ),
    { waitForDb: false },
  );
}

module.exports = { register };
