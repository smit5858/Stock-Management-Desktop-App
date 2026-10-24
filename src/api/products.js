import { invoke } from './client';

export const productsApi = {
  meta: () => invoke('products:meta'),
  list: (params) => invoke('products:list', params),
  stats: () => invoke('products:stats'),
  get: (id) => invoke('products:get', { id }),
  create: (product) => invoke('products:create', { product }),
  update: (id, product) => invoke('products:update', { id, product }),
  setActive: (id, is_active) => invoke('products:setActive', { id, is_active }),
  search: (query, limit = 20) => invoke('products:search', { query, limit }),
  pickImage: () => invoke('products:pickImage'),
  createCategory: (name, parent_id = null) => invoke('categories:create', { name, parent_id }),
  createVehicle: (make, model) => invoke('vehicleModels:create', { make, model }),
  importPreview: () => invoke('products:importPreview'),
  importCommit: (token) => invoke('products:importCommit', { token }),
  exportXlsx: () => invoke('products:exportXlsx'),
  template: () => invoke('products:template'),
};

export const stockApi = {
  adjust: (payload) => invoke('stock:adjust', payload),
  ledger: (variant_id, from, to) => invoke('stock:ledger', { variant_id, from, to }),
};

export const serialsApi = {
  list: (params) => invoke('serials:list', params),
  get: (id) => invoke('serials:get', { id }),
  check: (product_id, entries, allow_ids = []) =>
    invoke('serials:check', { product_id, entries, allow_ids }),
  previewAuto: (prefix, count, product_id) =>
    invoke('serials:previewAuto', { prefix, count, product_id }),
  inStock: (variant_id, search) => invoke('serials:inStock', { variant_id, search }),
  search: (query, limit = 8) => invoke('serials:search', { query, limit }),
  setStatus: (id, to_status, reason) => invoke('serials:setStatus', { id, to_status, reason }),
  setWarranty: (id, warranty_end, reason) =>
    invoke('serials:setWarranty', { id, warranty_end, reason }),
};
