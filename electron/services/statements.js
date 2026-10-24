'use strict';

// Party statements (printable HTML → print / PDF in the main process) and Excel exports of
// party lists and ledgers. No electron imports here.

const parties = require('./parties');
const id = require('../validation/identity');
const { newWorkbook, writeWorkbook, styleHeader } = require('./sheets');

// ---------------------------------------------------------------- formatting (no floats)

function money(paise) {
  const negative = paise < 0;
  const abs = Math.abs(paise);
  const p = abs % 100;
  const text = `${((abs - p) / 100).toLocaleString('en-IN')}.${String(p).padStart(2, '0')}`;
  return `${negative ? '-' : ''}₹${text}`;
}

function dmy(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || '');
  return m ? `${m[3]}-${m[2]}-${m[1]}` : '';
}

function esc(v) {
  return String(v ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
}

/** Balance with its meaning for this party type: "₹500.00 Dr (receivable)". */
function balanceText(type, paise) {
  if (paise === 0) return '₹0.00';
  const amount = money(Math.abs(paise));
  if (type === 'supplier') return paise < 0 ? `${amount} payable` : `${amount} advance paid`;
  return paise > 0 ? `${amount} receivable` : `${amount} advance`;
}

function businessInfo(db) {
  const rows = db
    .prepare(
      "SELECT key, value FROM settings WHERE key IN ('business_name','business_address','business_phone','business_gstin','business_email')",
    )
    .all();
  return Object.fromEntries(rows.map((r) => [r.key, r.value || '']));
}

/** Self-contained A4 statement page (system fonts; nothing loaded from outside). */
function statementHtml(db, params) {
  const l = parties.ledger(db, params);
  const b = businessInfo(db);
  const p = l.party;
  const period =
    l.from || l.to
      ? `${l.from ? dmy(l.from) : 'Start'} to ${l.to ? dmy(l.to) : 'today'}`
      : 'All entries';
  const row = (r) => `<tr>
      <td>${dmy(r.date)}</td><td>${esc(r.label)}</td><td>${esc(r.ref_no || '')}</td>
      <td class="n">${r.debit ? money(r.debit) : ''}</td><td class="n">${r.credit ? money(r.credit) : ''}</td>
      <td class="n">${money(r.balance)}</td></tr>`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>Statement - ${esc(p.name)}</title>
<style>
  @page { size: A4; margin: 14mm; }
  * { box-sizing: border-box; }
  body { font-family: 'Segoe UI', Arial, sans-serif; font-size: 11px; color: #111; margin: 0; }
  h1 { font-size: 18px; margin: 0; }
  .muted { color: #555; }
  .head { display: flex; justify-content: space-between; border-bottom: 2px solid #222; padding-bottom: 8px; }
  .to { margin: 12px 0; display: flex; justify-content: space-between; gap: 24px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { border-bottom: 1px solid #ddd; padding: 5px 6px; text-align: left; vertical-align: top; }
  th { background: #f1f3f9; font-weight: 600; }
  .n { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
  tfoot td { font-weight: 700; border-top: 2px solid #222; }
  .closing { margin-top: 12px; font-size: 13px; font-weight: 700; text-align: right; }
</style></head><body>
<div class="head">
  <div><h1>${esc(b.business_name)}</h1>
    <div class="muted">${esc(b.business_address)}</div>
    <div class="muted">${[b.business_phone && `Phone: ${esc(b.business_phone)}`, b.business_gstin && `GSTIN: ${esc(b.business_gstin)}`].filter(Boolean).join(' · ')}</div>
  </div>
  <div style="text-align:right"><h1>Statement of Account</h1><div class="muted">${esc(period)}</div></div>
</div>
<div class="to">
  <div><div class="muted">${p.type === 'supplier' ? 'Supplier' : 'Customer'}</div>
    <div style="font-size:13px;font-weight:700">${esc(p.name)}</div>
    ${p.firm_name ? `<div>${esc(p.firm_name)}</div>` : ''}
    <div>${esc([p.address, p.city].filter(Boolean).join(', '))}</div>
    <div>${[p.phone_display && `Phone: ${esc(p.phone_display)}`, p.gstin && `GSTIN: ${esc(p.gstin)}`].filter(Boolean).join(' · ')}</div>
  </div>
  <div style="text-align:right"><div class="muted">Printed on</div><div>${dmy(new Date().toISOString())}</div></div>
</div>
<table>
  <thead><tr><th>Date</th><th>Particulars</th><th>Ref. no.</th><th class="n">Debit</th><th class="n">Credit</th><th class="n">Balance</th></tr></thead>
  <tbody>
    <tr><td>${l.from ? dmy(l.from) : ''}</td><td>Balance brought forward</td><td></td><td></td><td></td><td class="n">${money(l.opening)}</td></tr>
    ${l.rows.map(row).join('')}
  </tbody>
  <tfoot><tr><td colspan="3">Total</td><td class="n">${money(l.debit)}</td><td class="n">${money(l.credit)}</td><td class="n">${money(l.closing)}</td></tr></tfoot>
</table>
<div class="closing">Closing balance: ${esc(balanceText(p.type, l.closing))}</div>
<p class="muted">Debit = amount payable by the ${p.type === 'supplier' ? 'supplier' : 'customer'} to us; credit = amount paid / returned. Positive balance = receivable.</p>
</body></html>`;
}

// ---------------------------------------------------------------- Excel

async function exportLedger(db, params, file) {
  const l = parties.ledger(db, params);
  const wb = newWorkbook();
  const ws = wb.addWorksheet('Ledger');
  ws.columns = [
    { header: 'Date', key: 'date', width: 12 },
    { header: 'Particulars', key: 'label', width: 30 },
    { header: 'Ref. no.', key: 'ref', width: 16 },
    { header: 'Debit', key: 'debit', width: 14 },
    { header: 'Credit', key: 'credit', width: 14 },
    { header: 'Balance', key: 'balance', width: 14 },
  ];
  styleHeader(ws);
  for (const k of ['debit', 'credit', 'balance']) ws.getColumn(k).numFmt = '#,##0.00';
  ws.addRow({
    date: l.from ? dmy(l.from) : '',
    label: 'Balance brought forward',
    balance: l.opening / 100,
  });
  for (const r of l.rows) {
    ws.addRow({
      date: dmy(r.date),
      label: r.label,
      ref: r.ref_no || '',
      debit: r.debit ? r.debit / 100 : null,
      credit: r.credit ? r.credit / 100 : null,
      balance: r.balance / 100,
    });
  }
  const total = ws.addRow({
    label: 'Total',
    debit: l.debit / 100,
    credit: l.credit / 100,
    balance: l.closing / 100,
  });
  total.font = { bold: true };
  ws.addRow({});
  ws.addRow({ label: `${l.party.name} (${l.party.phone_display || 'no phone'})` });
  ws.addRow({ label: `Closing balance: ${balanceText(l.party.type, l.closing)}` });
  await writeWorkbook(wb, file);
  return { rows: l.rows.length };
}

/** Customers (with vehicles) or suppliers, with the current filters. */
async function exportList(db, params, file) {
  const type = params.type;
  const { rows } = parties.list(db, { ...params, sort: params.sort || 'name' });
  const full = db.prepare('SELECT * FROM parties WHERE id = ?');
  const vehicles = db.prepare(
    `SELECT v.plate_no, vm.make, vm.model, v.year, v.fuel FROM vehicles v
     LEFT JOIN vehicle_models vm ON vm.id = v.vehicle_model_id
     WHERE v.customer_id = ? AND v.is_deleted = 0 ORDER BY v.is_primary DESC, v.id`,
  );
  const wb = newWorkbook();
  const ws = wb.addWorksheet(type === 'supplier' ? 'Suppliers' : 'Customers');
  const common = [
    { header: type === 'supplier' ? 'Firm name' : 'Name', key: 'name', width: 28 },
    ...(type === 'supplier'
      ? [{ header: 'Contact person', key: 'contact_person', width: 20 }]
      : [{ header: 'Firm name', key: 'firm_name', width: 22 }]),
    { header: 'Phone', key: 'phone', width: 14 },
    { header: 'Alternate phone', key: 'alt_phone', width: 14 },
    { header: 'Email', key: 'email', width: 22 },
    { header: 'Address', key: 'address', width: 30 },
    { header: 'City', key: 'city', width: 14 },
    { header: 'State', key: 'state', width: 16 },
    { header: 'PIN code', key: 'pincode', width: 9 },
    { header: 'GSTIN', key: 'gstin', width: 17 },
  ];
  const specific =
    type === 'supplier'
      ? [
          { header: 'Payment terms (days)', key: 'terms', width: 10 },
          { header: 'Supplies', key: 'supplies', width: 24 },
          { header: 'Bank / UPI', key: 'bank', width: 24 },
        ]
      : [
          { header: 'Type', key: 'type_name', width: 14 },
          { header: 'Credit limit', key: 'credit_limit', width: 12 },
          { header: 'Vehicles', key: 'vehicles', width: 40 },
        ];
  ws.columns = [
    ...common,
    ...specific,
    { header: 'Balance', key: 'balance', width: 13 },
    { header: 'Balance type', key: 'balance_type', width: 14 },
    { header: type === 'supplier' ? 'Last purchase' : 'Last bill', key: 'last', width: 12 },
    { header: 'Notes', key: 'notes', width: 30 },
    { header: 'Active (Yes/No)', key: 'active', width: 9 },
  ];
  styleHeader(ws);
  for (const k of ['balance', ...(type === 'supplier' ? [] : ['credit_limit'])]) {
    ws.getColumn(k).numFmt = '#,##0.00';
  }
  for (const r of rows) {
    const p = full.get(r.id);
    ws.addRow({
      name: p.name,
      contact_person: p.contact_person || '',
      firm_name: p.firm_name || '',
      phone: id.formatPhone(p.phone),
      alt_phone: id.formatPhone(p.alt_phone),
      email: p.email || '',
      address: p.address || '',
      city: p.city || '',
      state: id.stateName(p.state_code),
      pincode: p.pincode || '',
      gstin: p.gstin || '',
      terms: p.payment_terms_days ?? '',
      supplies: p.supplies || '',
      bank: p.bank_details || '',
      type_name: r.type_name || '',
      credit_limit: p.credit_limit == null ? null : p.credit_limit / 100,
      vehicles: vehicles
        .all(p.id)
        .map((v) => [id.formatPlate(v.plate_no), v.make, v.model, v.year].filter(Boolean).join(' '))
        .join('; '),
      balance: Math.abs(r.balance) / 100,
      balance_type: r.balance === 0 ? '' : balanceText(type, r.balance).replace(/^₹[\d,.]+ /, ''),
      last: dmy(r.last_date),
      notes: p.notes || '',
      active: p.is_active ? 'Yes' : 'No',
    });
  }
  await writeWorkbook(wb, file);
  return { rows: rows.length };
}

module.exports = {
  statementHtml,
  exportLedger,
  exportList,
  balanceText,
  money,
  dmy,
  esc,
  businessInfo,
};
