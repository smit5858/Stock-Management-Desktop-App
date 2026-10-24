import { invoke } from './client';

// ref = { serial_id } (a serial unit) or { sale_item_id } (a non-serial bill line).
export const warrantyApi = {
  meta: () => invoke('warranty:meta'),
  search: (query) => invoke('warranty:search', { query }),
  unit: (ref) => invoke('warranty:unit', ref),
  list: (params) => invoke('warranty:list', params),
  voidWarranty: (ref, reason, note) => invoke('warranty:void', { ...ref, reason, note }),
  alerts: () => invoke('warranty:alerts'),
  exportXlsx: (params) => invoke('warranty:export', params),
  // Warranty card: { sale_id } or a unit ref.
  cardHtml: (ref, format) => invoke('warranty:cardHtml', { ...ref, format }),
  cardPrint: (ref, format) => invoke('warranty:cardPrint', { ...ref, format }),
  cardPdf: (ref, format) => invoke('warranty:cardPdf', { ...ref, format }),
};

export const claimsApi = {
  prepare: (ref) => invoke('claims:prepare', ref),
  create: (claim) => invoke('claims:create', { claim }),
  get: (id) => invoke('claims:get', { id }),
  list: (params) => invoke('claims:list', params),
  exportXlsx: (params) => invoke('claims:export', params),
  inspect: (payload) => invoke('claims:inspect', payload),
  decide: (payload) => invoke('claims:decide', payload),
  repairDone: (payload) => invoke('claims:repairDone', payload),
  dispatch: (payload) => invoke('claims:dispatch', payload),
  supplierResult: (payload) => invoke('claims:supplierResult', payload),
  replace: (payload) => invoke('claims:replace', payload),
  refund: (payload) => invoke('claims:refund', payload),
  handover: (payload) => invoke('claims:handover', payload),
  close: (payload) => invoke('claims:close', payload),
  cancel: (id, reason) => invoke('claims:cancel', { id, reason }),
  billPrefill: (id) => invoke('claims:billPrefill', { id }),
  forProduct: (product_id) => invoke('claims:forProduct', { product_id }),
  pickPhotos: () => invoke('claims:pickPhotos'),
  addAttachments: (id, attachments) => invoke('claims:addAttachments', { id, attachments }),
  removeAttachment: (id) => invoke('claims:removeAttachment', { id }),
  openAttachment: (ref) => invoke('claims:openAttachment', ref),
  // Slips: doc = slip | rejection | handover; format = a4half | thermal80.
  slipHtml: (id, doc, format) => invoke('claims:slipHtml', { id, doc, format }),
  slipPrint: (id, doc, format) => invoke('claims:slipPrint', { id, doc, format }),
  slipPdf: (id, doc, format) => invoke('claims:slipPdf', { id, doc, format }),
};

export const defectiveApi = {
  list: (search = '') => invoke('defective:list', { search }),
  count: () => invoke('defective:count'),
  writeOff: (payload) => invoke('defective:writeOff', payload),
  repair: (payload) => invoke('defective:repair', payload),
  sendToSupplier: (payload) => invoke('defective:sendToSupplier', payload),
};
