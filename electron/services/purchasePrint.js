'use strict';

// Printable pages for purchases (rendered in a hidden, script-less window by the IPC layer):
// the internal goods received record (A4) and barcode labels (A4 sheet or 50×25 mm thermal).

const purchases = require('./purchases');
const { money, dmy, esc, businessInfo } = require('./statements');
const { code128Svg } = require('./barcode');
const { AppError } = require('../errors');

function qty(milli) {
  const frac = milli % 1000;
  const whole = (milli - frac) / 1000;
  return `${whole.toLocaleString('en-IN')}${frac ? `.${String(frac).padStart(3, '0').replace(/0+$/, '')}` : ''}`;
}

function pct(bp) {
  const f = bp % 100;
  return `${(bp - f) / 100}${f ? `.${String(f).padStart(2, '0').replace(/0+$/, '')}` : ''}%`;
}

const BASE_CSS = `
  * { box-sizing: border-box; }
  body { font-family: 'Segoe UI', Arial, sans-serif; color: #111; margin: 0; }
`;

/** Goods received record: what came in on this purchase, with taxes and payments. */
function grnHtml(db, id) {
  const p = purchases.get(db, id);
  const b = businessInfo(db);
  const gst = p.bill_type === 'gst';
  const rows = p.items
    .map(
      (it, i) => `<tr>
      <td>${i + 1}</td>
      <td>${esc(it.product_name)}${it.variant_label ? ` <span class="muted">(${esc(it.variant_label)})</span>` : ''}
        <div class="muted">${esc(it.sku || '')}</div>
        ${
          it.serials && it.serials.length
            ? `<div class="sn">S/N: ${it.serials
                .filter((s) => s.status !== 'voided')
                .map((s) => esc(s.serial_no))
                .join(', ')}</div>`
            : ''
        }</td>
      ${gst ? `<td>${esc(it.hsn_code || '')}</td>` : ''}
      <td class="n">${qty(it.qty_milli)} ${esc(it.unit)}</td>
      <td class="n">${it.free_qty_milli ? qty(it.free_qty_milli) : ''}</td>
      <td class="n">${money(it.rate)}</td>
      <td class="n">${it.discount ? money(it.discount) : ''}</td>
      <td class="n">${money(it.taxable)}</td>
      ${gst ? `<td class="n">${pct(it.gst_rate_bp)}</td><td class="n">${money(it.cgst + it.sgst + it.igst)}</td>` : ''}
      <td class="n">${money(it.line_total)}</td>
    </tr>`,
    )
    .join('');
  const charges = p.charges
    .map(
      (c) =>
        `<tr><td>${esc(c.label || purchases.CHARGE_KINDS[c.kind])}${gst && c.gst_rate_bp ? ` (GST ${pct(c.gst_rate_bp)})` : ''}</td><td class="n">${money(c.total)}</td></tr>`,
    )
    .join('');
  const taxRows = gst
    ? p.tax_summary
        .map(
          (t) => `<tr><td>${pct(t.gst_rate_bp)}</td><td class="n">${money(t.taxable)}</td>
          ${p.is_interstate ? `<td class="n">${money(t.igst)}</td>` : `<td class="n">${money(t.cgst)}</td><td class="n">${money(t.sgst)}</td>`}</tr>`,
        )
        .join('')
    : '';
  const pays = p.allocations
    .filter((a) => a.status === 'active')
    .map(
      (a) =>
        `<tr><td>${dmy(a.date)}</td><td>${a.source_type === 'payment' ? `${esc(a.payment_no)} · ${esc(a.mode || '')}${a.ref_no ? ` · ${esc(a.ref_no)}` : ''}` : a.source_type === 'advance' ? 'Adjusted from advance' : `Return ${esc(a.return_no || '')}`}</td><td class="n">${money(a.amount)}</td></tr>`,
    )
    .join('');

  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(p.entry_no)} - Goods received</title>
<style>${BASE_CSS}
  @page { size: A4; margin: 12mm; }
  body { font-size: 11px; }
  h1 { font-size: 18px; margin: 0; } h2 { font-size: 13px; margin: 14px 0 6px; }
  .muted { color: #555; font-size: 10px; }
  .sn { font-size: 9.5px; color: #333; margin-top: 2px; }
  .head { display: flex; justify-content: space-between; border-bottom: 2px solid #222; padding-bottom: 8px; }
  .title { text-align: right; } .title .t { font-size: 15px; font-weight: 700; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin: 10px 0; }
  table { width: 100%; border-collapse: collapse; }
  th, td { border-bottom: 1px solid #ddd; padding: 4px 5px; text-align: left; vertical-align: top; }
  th { background: #f1f3f9; font-weight: 600; }
  .n { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
  .totals { width: 46%; margin-left: auto; margin-top: 8px; }
  .totals td { border: none; padding: 2px 5px; }
  .grand td { font-size: 13px; font-weight: 700; border-top: 2px solid #222; }
  .cancel { color: #b91c1c; font-weight: 700; font-size: 14px; border: 2px solid #b91c1c; padding: 4px 8px; display: inline-block; }
  .sign { display: flex; justify-content: space-between; margin-top: 46px; }
  .sign div { border-top: 1px solid #555; padding-top: 4px; width: 30%; text-align: center; }
</style></head><body>
<div class="head">
  <div><h1>${esc(b.business_name)}</h1>
    <div class="muted">${esc(b.business_address)}</div>
    <div class="muted">${[b.business_phone, b.business_gstin ? `GSTIN ${b.business_gstin}` : ''].filter(Boolean).map(esc).join(' · ')}</div></div>
  <div class="title"><div class="t">Goods Received Note</div>
    <div>${esc(p.entry_no)} · ${dmy(p.entry_date)}</div>
    <div class="muted">Internal record, not a tax invoice</div></div>
</div>
${p.status === 'cancelled' ? `<p class="cancel">CANCELLED: ${esc(p.cancel_reason)}</p>` : ''}
<div class="grid">
  <div><strong>Supplier</strong><br>${esc(p.supplier_name)}<br>
    <span class="muted">${p.supplier_gstin ? `GSTIN ${esc(p.supplier_gstin)}` : ''}</span></div>
  <div><strong>Supplier bill</strong><br>${esc(p.bill_no || '—')} · ${dmy(p.bill_date)}<br>
    <span class="muted">${gst ? `GST bill · ${p.is_interstate ? 'IGST' : 'CGST + SGST'} · rates ${p.price_mode} of GST` : 'Non-GST bill'}${p.due_date ? ` · due ${dmy(p.due_date)}` : ''}</span></div>
</div>
<table><thead><tr><th>#</th><th>Item</th>${gst ? '<th>HSN</th>' : ''}<th class="n">Qty</th><th class="n">Free</th><th class="n">Rate</th>
  <th class="n">Disc.</th><th class="n">Taxable</th>${gst ? '<th class="n">GST</th><th class="n">Tax</th>' : ''}<th class="n">Total</th></tr></thead>
<tbody>${rows}</tbody></table>
${charges ? `<h2>Extra charges (${p.charges_mode === 'cost' ? 'added to product cost' : 'recorded as expense'})</h2><table>${charges}</table>` : ''}
${gst ? `<h2>Tax summary</h2><table><thead><tr><th>Rate</th><th class="n">Taxable</th>${p.is_interstate ? '<th class="n">IGST</th>' : '<th class="n">CGST</th><th class="n">SGST</th>'}</tr></thead><tbody>${taxRows}</tbody></table>` : ''}
<table class="totals">
  <tr><td>Sub total</td><td class="n">${money(p.sub_total)}</td></tr>
  ${p.discount_total ? `<tr><td>Discount</td><td class="n">-${money(p.discount_total)}</td></tr>` : ''}
  <tr><td>Taxable value</td><td class="n">${money(p.taxable_total + p.charges_taxable)}</td></tr>
  ${gst ? `<tr><td>GST</td><td class="n">${money(p.tax_total)}</td></tr>` : ''}
  ${p.round_off ? `<tr><td>Round off</td><td class="n">${money(p.round_off)}</td></tr>` : ''}
  <tr class="grand"><td>Grand total</td><td class="n">${money(p.grand_total)}</td></tr>
  ${p.status === 'active' ? `<tr><td>Paid</td><td class="n">${money(p.paid)}</td></tr><tr><td><strong>Due</strong></td><td class="n"><strong>${money(p.due)}</strong></td></tr>` : ''}
</table>
${pays ? `<h2>Payments</h2><table>${pays}</table>` : ''}
${p.notes ? `<h2>Notes</h2><p>${esc(p.notes)}</p>` : ''}
<div class="sign"><div>Received by</div><div>Checked by</div><div>Authorised signatory</div></div>
</body></html>`;
}

const LABEL_SIZES = {
  a4: { name: 'A4 sheet (3 × 8)', page: 'A4', cols: 3, rows: 8, w: 64, h: 33.9 },
  thermal50x25: { name: '50 × 25 mm thermal', page: '50mm 25mm', w: 50, h: 25 },
};

/**
 * Labels for received items. items = [{ variant_id, copies }]. Each label: barcode (barcode, or
 * SKU when there is none), product name, SKU, MRP.
 */
function labelsHtml(db, { id, size = 'a4', items = [] }) {
  const s = LABEL_SIZES[size];
  if (!s) throw new AppError('Unknown label size.', 'VALIDATION');
  const p = purchases.get(db, id);
  const byVariant = new Map(p.items.map((it) => [it.variant_id, it]));
  const labels = [];
  for (const { variant_id: vid, copies } of items) {
    const it = byVariant.get(vid);
    const n = Number(copies);
    if (!it || !Number.isInteger(n) || n <= 0) continue;
    if (labels.length + n > 2000) throw new AppError('At most 2000 labels at a time.');
    const v = db.prepare('SELECT sku, barcode, mrp FROM product_variants WHERE id = ?').get(vid);
    const code = v.barcode || v.sku;
    let svg;
    try {
      svg = code128Svg(code);
    } catch {
      throw new AppError(`"${code}" cannot be printed as a barcode.`, 'VALIDATION');
    }
    for (let k = 0; k < n; k++) {
      labels.push(`<div class="label">
        <div class="name">${esc(it.product_name)}${it.variant_label ? ` · ${esc(it.variant_label)}` : ''}</div>
        <div class="bc">${svg}</div>
        <div class="code">${esc(code)}</div>
        <div class="row"><span>${esc(v.sku)}</span>${v.mrp ? `<strong>MRP ${money(v.mrp)}</strong>` : ''}</div>
      </div>`);
    }
  }
  if (labels.length === 0) throw new AppError('Choose at least one label to print.', 'VALIDATION');
  const sheet =
    size === 'a4'
      ? `@page { size: A4; margin: 10mm 7mm; }
         .sheet { display: grid; grid-template-columns: repeat(${s.cols}, ${s.w}mm); grid-auto-rows: ${s.h}mm; gap: 0 2mm; }
         .label { border: 0.2mm dashed #bbb; }`
      : `@page { size: ${s.page}; margin: 0; }
         .label { page-break-after: always; break-after: page; }`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>Labels ${esc(p.entry_no)}</title>
<style>${BASE_CSS}
  ${sheet}
  .label { width: ${s.w}mm; height: ${s.h}mm; padding: 1.5mm 2.5mm; overflow: hidden; display: flex; flex-direction: column; }
  .name { font-size: 8pt; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .bc { flex: 1; min-height: 0; padding: 0.8mm 0; } .bc svg { width: 100%; height: 100%; display: block; }
  .code { font-size: 6.5pt; text-align: center; letter-spacing: 0.5px; }
  .row { display: flex; justify-content: space-between; font-size: 7.5pt; }
</style></head><body><div class="sheet">${labels.join('')}</div></body></html>`;
}

module.exports = { grnHtml, labelsHtml, LABEL_SIZES };
