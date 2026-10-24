'use strict';

// Excel exports of the Warranty page lists (warranties by tab, claims). Written atomically
// (temp file + rename). Money in rupees with 2 decimals, dates as dd-mm-yyyy text.

const { newWorkbook, writeWorkbook, styleHeader } = require('./sheets');
const { dmy } = require('./statements');
const units = require('./warrantyUnits');
const claims = require('./claims');

const rupees = (paise) => (paise == null ? '' : Number((paise / 100).toFixed(2)));
const qty = (milli) => (milli == null ? '' : milli / 1000);

function sheet(wb, name, columns, rows) {
  const ws = wb.addWorksheet(name);
  ws.columns = columns.map(([header, key, width]) => ({ header, key, width }));
  for (const r of rows) ws.addRow(r);
  styleHeader(ws);
  return ws;
}

async function exportWarranties(db, file, params = {}) {
  const data = units.list(db, params);
  const wb = newWorkbook();
  sheet(
    wb,
    `Warranties (${data.tab})`,
    [
      ['Product', 'product', 32],
      ['Variant', 'variant', 16],
      ['Brand', 'brand', 14],
      ['Serial no.', 'serial', 20],
      ['Qty', 'qty', 8],
      ['Customer', 'customer', 24],
      ['Phone', 'phone', 16],
      ['Vehicle', 'vehicle', 16],
      ['Bill', 'bill', 14],
      ['Bill date', 'bill_date', 12],
      ['Fitted by', 'fitted_by', 14],
      ['Warranty till', 'end', 13],
      ['Days left', 'days', 10],
      ['Status', 'status', 16],
    ],
    data.rows.map((r) => ({
      product: r.product_name,
      variant: r.variant_label,
      brand: r.brand || '',
      serial: r.serial_no || '',
      qty: qty(r.qty_milli),
      customer: r.customer_name || '',
      phone: r.customer_phone || '',
      vehicle: r.vehicle_no || '',
      bill: r.invoice_no || '',
      bill_date: dmy(r.invoice_date),
      fitted_by: r.fitted_by || '',
      end: dmy(r.warranty_end),
      days: r.status.days_left,
      status: r.status.label,
    })),
  );
  await writeWorkbook(wb, file);
  return { rows: data.rows.length };
}

async function exportClaims(db, file, params = {}) {
  const data = claims.list(db, params);
  const wb = newWorkbook();
  sheet(
    wb,
    'Claims',
    [
      ['Claim no.', 'no', 12],
      ['Received', 'received', 12],
      ['Status', 'status', 18],
      ['Decision', 'decision', 18],
      ['Outcome', 'outcome', 18],
      ['Product', 'product', 30],
      ['Brand', 'brand', 14],
      ['Serial no.', 'serial', 18],
      ['Qty', 'qty', 8],
      ['Customer', 'customer', 22],
      ['Phone', 'phone', 16],
      ['Vehicle', 'vehicle', 14],
      ['Bill', 'bill', 12],
      ['Complaint', 'complaint', 34],
      ['Chargeable', 'chargeable', 11],
      ['Supplier', 'supplier', 22],
      ['Sent on', 'sent', 12],
      ['Expected back', 'expected', 13],
      ['Overdue', 'overdue', 9],
      ['Days open', 'days', 10],
      ['Net warranty loss (₹)', 'loss', 14],
      ['Closed', 'closed', 12],
    ],
    data.rows.map((r) => ({
      no: r.claim_no,
      received: dmy(r.received_date),
      status: r.status_label,
      decision: r.decision_label || '',
      outcome: r.outcome_label || '',
      product: r.product_name,
      brand: r.brand || '',
      serial: r.serial_no || '',
      qty: qty(r.qty_milli),
      customer: r.kind === 'stock' ? '(shop stock)' : r.customer_name || '',
      phone: r.customer_phone_display || '',
      vehicle: r.vehicle_no || '',
      bill: r.invoice_no || '',
      complaint: r.complaint,
      chargeable: r.chargeable ? 'Yes' : '',
      supplier: r.supplier_name || '',
      sent: dmy(r.dispatch_date),
      expected: dmy(r.supplier_expected),
      overdue: r.overdue ? 'Yes' : '',
      days: r.days_open,
      loss: rupees(r.net_loss),
      closed: dmy(r.closed_date),
    })),
  );
  await writeWorkbook(wb, file);
  return { rows: data.rows.length };
}

module.exports = { exportWarranties, exportClaims };
