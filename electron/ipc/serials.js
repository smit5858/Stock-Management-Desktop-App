'use strict';

const dbm = require('../db');
const serials = require('../services/serials');

function register(handle) {
  const db = () => dbm.getDb();

  handle('serials:list', (params) => serials.list(db(), params));
  handle('serials:get', ({ id }) => serials.get(db(), Number(id)));
  handle('serials:check', ({ product_id, entries, allow_ids }) =>
    serials.checkSerials(db(), {
      product_id: product_id ?? null,
      entries: entries || [],
      allow_ids: allow_ids || [],
    }),
  );
  handle('serials:previewAuto', (payload) => serials.previewAuto(db(), payload));
  handle('serials:inStock', (payload) => serials.inStock(db(), payload));
  handle('serials:search', ({ query, limit }) => serials.search(db(), { query, limit }));
  handle('serials:setStatus', (payload) => serials.setStatus(db(), payload));
  handle('serials:setWarranty', (payload) => serials.setWarranty(db(), payload));
}

module.exports = { register };
