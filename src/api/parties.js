import { invoke } from './client';

export const partiesApi = {
  meta: () => invoke('parties:meta'),
  list: (params) => invoke('parties:list', params),
  stats: (type) => invoke('parties:stats', { type }),
  get: (id) => invoke('parties:get', { id }),
  summary: (id) => invoke('parties:summary', { id }),
  create: (type, party, vehicles = []) => invoke('parties:create', { type, party, vehicles }),
  update: (id, party) => invoke('parties:update', { id, party }),
  setActive: (id, is_active) => invoke('parties:setActive', { id, is_active }),
  remove: (id) => invoke('parties:delete', { id }),
  checkDuplicates: (payload) => invoke('parties:checkDuplicates', payload),
  search: (query, { type = null, limit = 10 } = {}) =>
    invoke('parties:search', { query, type, limit }),
  quickAdd: (payload) => invoke('parties:quickAdd', payload),
  createLinked: (id) => invoke('parties:createLinked', { id }),
  link: (id, other_id) => invoke('parties:link', { id, other_id }),
  unlink: (id) => invoke('parties:unlink', { id }),
  mergePreview: (keep_id, merge_id) => invoke('parties:mergePreview', { keep_id, merge_id }),
  merge: (keep_id, merge_id, note) => invoke('parties:merge', { keep_id, merge_id, note }),
  ledger: (id, from, to) => invoke('parties:ledger', { id, from, to }),
  ledgerExport: (id, from, to) => invoke('parties:ledgerExport', { id, from, to }),
  statementPdf: (id, from, to) => invoke('parties:statementPdf', { id, from, to }),
  statementPrint: (id, from, to) => invoke('parties:statementPrint', { id, from, to }),
  bills: (id, vehicle_id = null) => invoke('parties:bills', { id, vehicle_id }),
  payments: (id) => invoke('parties:payments', { id }),
  purchases: (id) => invoke('parties:purchases', { id }),
  warranties: (id) => invoke('parties:warranties', { id }),
  claims: (id) => invoke('parties:claims', { id }),
  suppliedProducts: (id) => invoke('parties:suppliedProducts', { id }),
  exportXlsx: (params) => invoke('parties:exportXlsx', params),
  importTemplate: (type) => invoke('parties:importTemplate', { type }),
  importOpen: (type) => invoke('parties:importOpen', { type }),
  importPreview: (token, mapping, on_duplicate) =>
    invoke('parties:importPreview', { token, mapping, on_duplicate }),
  importCommit: (token) => invoke('parties:importCommit', { token }),
};

export const customerTypesApi = {
  list: () => invoke('customerTypes:list'),
  save: (type) => invoke('customerTypes:save', type),
  remove: (id) => invoke('customerTypes:delete', { id }),
};

export const vehiclesApi = {
  check: (plate, id = null) => invoke('vehicles:check', { plate, id }),
  create: (customer_id, vehicle) => invoke('vehicles:create', { customer_id, vehicle }),
  update: (id, vehicle) => invoke('vehicles:update', { id, vehicle }),
  setPrimary: (id) => invoke('vehicles:setPrimary', { id }),
  transfer: (id, to_customer_id, date, note) =>
    invoke('vehicles:transfer', { id, to_customer_id, date, note }),
  history: (id) => invoke('vehicles:history', { id }),
  remove: (id) => invoke('vehicles:remove', { id }),
  compatibleProducts: (id) => invoke('vehicles:compatibleProducts', { id }),
};
