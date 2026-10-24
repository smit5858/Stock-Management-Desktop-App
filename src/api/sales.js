import { invoke } from './client';

export const salesApi = {
  meta: () => invoke('sales:meta'),
  searchItems: (query, vehicle_id = null, limit = 15) =>
    invoke('sales:searchItems', { query, vehicle_id, limit }),
  customerInfo: (party_id) => invoke('sales:customerInfo', { party_id }),
  calculate: (payload) => invoke('sales:calculate', payload),
  create: (sale) => invoke('sales:create', { sale }),
  get: (id) => invoke('sales:get', { id }),
  list: (params) => invoke('sales:list', params),
  stats: () => invoke('sales:stats'),
  recent: (limit = 8) => invoke('sales:recent', { limit }),
  cancel: (id, reason, refund = null) => invoke('sales:cancel', { id, reason, refund }),
  prefill: (ref) => invoke('sales:prefill', ref),
  recordPayment: (payload) => invoke('sales:recordPayment', payload),
  previewHtml: (id, format) => invoke('sales:previewHtml', { id, format }),
  print: (id, format, silent) => invoke('sales:print', { id, format, silent }),
  savePdf: (id, format) => invoke('sales:savePdf', { id, format }),
  showFile: (file_path) => invoke('sales:showFile', { file_path }),
};

export const saleDraftsApi = {
  list: () => invoke('saleDrafts:list'),
  get: (id) => invoke('saleDrafts:get', { id }),
  save: (id, form) => invoke('saleDrafts:save', { id, form }),
  discard: (id) => invoke('saleDrafts:discard', { id }),
};

export const quotationsApi = {
  create: (quotation) => invoke('quotations:create', { quotation }),
  get: (id) => invoke('quotations:get', { id }),
  list: (params) => invoke('quotations:list', params),
  cancel: (id, reason) => invoke('quotations:cancel', { id, reason }),
  previewHtml: (id, format) => invoke('quotations:previewHtml', { id, format }),
  print: (id, format) => invoke('quotations:print', { id, format }),
  savePdf: (id, format) => invoke('quotations:savePdf', { id, format }),
};

export const saleReturnsApi = {
  find: (query) => invoke('saleReturns:find', { query }),
  prepare: (sale_id) => invoke('saleReturns:prepare', { sale_id }),
  calculate: (payload) => invoke('saleReturns:calculate', payload),
  create: (sale_return) => invoke('saleReturns:create', { sale_return }),
  exchange: (sale_return, sale) => invoke('saleReturns:exchange', { sale_return, sale }),
  get: (id) => invoke('saleReturns:get', { id }),
  list: (params) => invoke('saleReturns:list', params),
  previewHtml: (id, format) => invoke('saleReturns:previewHtml', { id, format }),
  print: (id, format) => invoke('saleReturns:print', { id, format }),
  savePdf: (id, format) => invoke('saleReturns:savePdf', { id, format }),
};
