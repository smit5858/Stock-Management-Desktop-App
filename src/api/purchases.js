import { invoke } from './client';

export const purchasesApi = {
  meta: () => invoke('purchases:meta'),
  list: (params) => invoke('purchases:list', params),
  stats: () => invoke('purchases:stats'),
  payables: () => invoke('purchases:payables'),
  get: (id) => invoke('purchases:get', { id }),
  calculate: (payload) => invoke('purchases:calculate', payload),
  checkBillNo: (party_id, bill_no, exclude_id = null) =>
    invoke('purchases:checkBillNo', { party_id, bill_no, exclude_id }),
  supplierInfo: (party_id, purchase_id = null) =>
    invoke('purchases:supplierInfo', { party_id, purchase_id }),
  lineInfo: (variant_id) => invoke('purchases:lineInfo', { variant_id }),
  priceHistory: (product_id) => invoke('purchases:priceHistory', { product_id }),
  create: (purchase) => invoke('purchases:create', { purchase }),
  editCheck: (id) => invoke('purchases:editCheck', { id }),
  update: (id, purchase) => invoke('purchases:update', { id, purchase }),
  cancel: (id, reason, refund = null) => invoke('purchases:cancel', { id, reason, refund }),
  recordPayment: (payload) => invoke('purchases:recordPayment', payload),
  lookupCode: (code) => invoke('products:lookupCode', { code }),
  pickAttachments: () => invoke('purchases:pickAttachments'),
  addAttachments: (id, attachments) => invoke('purchases:addAttachments', { id, attachments }),
  removeAttachment: (id) => invoke('purchases:removeAttachment', { id }),
  openAttachment: (ref) => invoke('purchases:openAttachment', ref),
  print: (id) => invoke('purchases:print', { id }),
  savePdf: (id) => invoke('purchases:savePdf', { id }),
  printLabels: (id, size, items, pdf = false) =>
    invoke('purchases:printLabels', { id, size, items, pdf }),
};

export const purchaseDraftsApi = {
  list: () => invoke('purchaseDrafts:list'),
  get: (id) => invoke('purchaseDrafts:get', { id }),
  save: (id, form) => invoke('purchaseDrafts:save', { id, form }),
  discard: (id) => invoke('purchaseDrafts:discard', { id }),
};

export const purchaseReturnsApi = {
  prepare: (purchase_id) => invoke('purchaseReturns:prepare', { purchase_id }),
  calculate: (payload) => invoke('purchaseReturns:calculate', payload),
  create: (purchase_return) => invoke('purchaseReturns:create', { purchase_return }),
  list: (params) => invoke('purchaseReturns:list', params),
  get: (id) => invoke('purchaseReturns:get', { id }),
  cancel: (id, reason) => invoke('purchaseReturns:cancel', { id, reason }),
};
