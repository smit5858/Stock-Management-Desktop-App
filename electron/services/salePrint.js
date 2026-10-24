'use strict';

// Printable invoices, quotations and credit notes: A4 and thermal 80 mm. Self-contained HTML
// (system fonts, the logo as a data URL, the UPI QR as inline SVG): it is rendered in a hidden
// script-less window by the IPC layer, or shown in the preview iframe. No electron imports.

const sales = require('./sales');
const quotations = require('./quotations');
const saleReturns = require('./saleReturns');
const settings = require('./settings');
const { money, dmy, esc } = require('./statements');
const id = require('../validation/identity');
const { qrSvg, upiLink } = require('./qr');

const FORMATS = ['a4', 'thermal80'];

function qty(milli) {
  const frac = milli % 1000;
  const whole = (milli - frac) / 1000;
  return `${whole.toLocaleString('en-IN')}${frac ? `.${String(frac).padStart(3, '0').replace(/0+$/, '')}` : ''}`;
}

function pct(bp) {
  const f = bp % 100;
  return `${(bp - f) / 100}${f ? `.${String(f).padStart(2, '0').replace(/0+$/, '')}` : ''}%`;
}

function business(db) {
  const s = settings.getSettings(db);
  return {
    name: s.business_name || '',
    address: s.business_address || '',
    phone: s.business_phone || '',
    email: s.business_email || '',
    gstin: s.business_gstin || '',
    state: s.business_state_code
      ? `${id.stateName(s.business_state_code)} (${s.business_state_code})`
      : '',
    terms: s.invoice_terms || '',
    footer: s.invoice_footer || '',
    upi_id: s.upi_id || '',
    print_previous_balance: s.print_previous_balance === '1',
    composition: s.composition_dealer === '1',
  };
}

/**
 * Display lines: fitting lines marked "merged" are folded into their product line (they stay
 * separate rows in the database and in the tax summary).
 */
function displayLines(items) {
  const byId = new Map(items.map((it) => [it.id, it]));
  const merged = new Set(
    items
      .filter((it) => it.fitting_for_item_id && byId.get(it.fitting_for_item_id)?.fitting_merged)
      .map((it) => it.id),
  );
  return items
    .filter((it) => !merged.has(it.id))
    .map((it) => {
      const extra = items.filter((f) => merged.has(f.id) && f.fitting_for_item_id === it.id);
      const sum = (k) => it[k] + extra.reduce((s, f) => s + f[k], 0);
      return {
        ...it,
        is_fitting: Boolean(it.fitting_for_item_id) || it.item_type === 'service',
        merged_fitting: extra,
        taxable: sum('taxable'),
        tax: sum('cgst') + sum('sgst') + sum('igst'),
        line_total: sum('line_total'),
        fitted_by: it.fitted_by || extra.map((f) => f.fitted_by).find(Boolean) || null,
      };
    });
}

/** Common document model for the three kinds. */
function invoiceModel(db, saleId, { duplicate = false } = {}) {
  const s = sales.get(db, saleId);
  const b = business(db);
  const gst = s.bill_type === 'gst';
  const fittedBy = [...new Set(s.items.map((i) => i.fitted_by).filter(Boolean))];
  const qr =
    b.upi_id && s.status === 'active' && s.due > 0
      ? qrSvg(upiLink({ vpa: b.upi_id, name: b.name, amountPaise: s.due, note: s.invoice_no }))
      : null;
  return {
    kind: 'invoice',
    b,
    gst,
    title: s.bill_title,
    number_label: gst ? 'Invoice no.' : 'Bill no.',
    number: s.invoice_no,
    date: s.invoice_date,
    extra: [s.due_date && s.due > 0 ? ['Due date', dmy(s.due_date)] : null].filter(Boolean),
    customer: {
      name: s.customer_name,
      phone: id.formatPhone(s.customer_phone),
      address: s.customer_address,
      gstin: s.customer_gstin,
    },
    vehicle: s.vehicle_no
      ? `${s.vehicle_no}${s.vehicle_model ? ` · ${s.vehicle_model}` : ''}`
      : null,
    pos: gst ? `${id.stateName(s.place_of_supply_code) || ''} (${s.place_of_supply_code})` : null,
    interstate: Boolean(s.is_interstate),
    lines: displayLines(s.items),
    tax_summary: s.tax_summary,
    totals: [
      ['Sub total', s.sub_total],
      s.item_discount_total ? ['Discount', -s.item_discount_total] : null,
      s.bill_discount ? ['Bill discount', -s.bill_discount] : null,
      gst ? ['Taxable value', s.taxable_total] : null,
      gst && !s.is_interstate ? ['CGST', s.cgst_total] : null,
      gst && !s.is_interstate ? ['SGST', s.sgst_total] : null,
      gst && s.is_interstate ? ['IGST', s.igst_total] : null,
      s.round_off ? ['Round off', s.round_off] : null,
    ].filter(Boolean),
    split:
      s.services_total > 0 && s.goods_total > 0
        ? `Products ${money(s.goods_total)} · Fitting / labour ${money(s.services_total)}`
        : null,
    grand_total: s.grand_total,
    words: s.amount_in_words,
    payment:
      s.status === 'active'
        ? [
            ['Paid', s.paid],
            ['Balance on this bill', s.due],
            ...(b.print_previous_balance && !s.customer?.is_system
              ? [
                  ['Previous balance', s.previous_balance],
                  ['Total due', s.previous_balance + s.due],
                ]
              : []),
          ]
        : [],
    paid_modes: s.allocations
      .filter((a) => a.status === 'active' && a.source_type === 'payment')
      .map((a) => `${(a.mode || '').toUpperCase()} ${money(a.amount)}`)
      .join(' · '),
    fitted_by: fittedBy.join(', '),
    notes: s.notes,
    qr,
    qr_amount: s.due,
    cancelled: s.status === 'cancelled' ? s.cancel_reason : null,
    duplicate,
    terms: b.terms,
    signature: true,
  };
}

function quotationModel(db, quotationId) {
  const q = quotations.get(db, quotationId);
  const b = business(db);
  const gst = q.bill_type === 'gst';
  return {
    kind: 'quotation',
    b,
    gst,
    title: 'Quotation',
    number_label: 'Quotation no.',
    number: q.quote_no,
    date: q.quote_date,
    extra: [['Valid till', dmy(q.valid_till)]],
    customer: {
      name: q.customer_name,
      phone: id.formatPhone(q.customer_phone),
      address: q.customer_address,
      gstin: q.customer_gstin,
    },
    vehicle: q.vehicle_no
      ? `${q.vehicle_no}${q.vehicle_model ? ` · ${q.vehicle_model}` : ''}`
      : null,
    pos: gst ? `${id.stateName(q.place_of_supply_code) || ''} (${q.place_of_supply_code})` : null,
    interstate: Boolean(q.is_interstate),
    lines: displayLines(q.items.map((it) => ({ ...it, warranty_end: null }))).map((l) => ({
      ...l,
      warranty_note: l.warranty_months ? `Warranty ${l.warranty_months} months` : null,
    })),
    tax_summary: q.tax_summary,
    totals: [
      ['Sub total', q.sub_total],
      q.item_discount_total ? ['Discount', -q.item_discount_total] : null,
      q.bill_discount ? ['Bill discount', -q.bill_discount] : null,
      gst ? ['Taxable value', q.taxable_total] : null,
      gst && !q.is_interstate ? ['CGST', q.cgst_total] : null,
      gst && !q.is_interstate ? ['SGST', q.sgst_total] : null,
      gst && q.is_interstate ? ['IGST', q.igst_total] : null,
      q.round_off ? ['Round off', q.round_off] : null,
    ].filter(Boolean),
    split: null,
    grand_total: q.grand_total,
    words: q.amount_in_words,
    payment: [],
    paid_modes: '',
    fitted_by: '',
    notes: q.notes,
    qr: null,
    cancelled: q.status === 'cancelled' ? q.cancel_reason : null,
    duplicate: false,
    terms: `This is a quotation, not a bill. Prices and stock are subject to change after ${dmy(q.valid_till)}.`,
    signature: true,
  };
}

function creditNoteModel(db, returnId, { duplicate = false } = {}) {
  const r = saleReturns.get(db, returnId);
  const b = business(db);
  const gst = r.bill_type === 'gst';
  const refunded = r.refunds.filter((p) => p.status === 'active').reduce((s, p) => s + p.amount, 0);
  const adjusted = r.allocations.reduce((s, a) => s + a.amount, 0);
  return {
    kind: 'credit_note',
    b,
    gst,
    title: 'Credit Note',
    number_label: 'Credit note no.',
    number: r.return_no,
    date: r.date,
    extra: [
      r.sale ? ['Against', `${r.sale.invoice_no} dated ${dmy(r.sale.invoice_date)}`] : null,
      r.exchange_sale ? ['Exchanged for', r.exchange_sale.invoice_no] : null,
    ].filter(Boolean),
    customer: {
      name: r.customer_name,
      phone: id.formatPhone(r.customer_phone),
      gstin: r.customer_gstin,
    },
    vehicle: null,
    pos: gst ? `${id.stateName(r.place_of_supply_code) || ''} (${r.place_of_supply_code})` : null,
    interstate: Boolean(r.is_interstate),
    lines: r.lines.map((l) => ({
      ...l,
      tax: l.cgst + l.sgst + l.igst,
      discount: 0,
      merged_fitting: [],
      is_fitting: l.item_type === 'service',
      serials: l.serials.map((x) => ({
        serial_no: x.serial_no,
        note: x.to_status === 'defective' ? 'returned defective' : null,
      })),
    })),
    tax_summary: r.tax_summary,
    totals: [
      gst ? ['Taxable value', r.taxable_total] : null,
      gst && !r.is_interstate ? ['CGST', r.cgst_total] : null,
      gst && !r.is_interstate ? ['SGST', r.sgst_total] : null,
      gst && r.is_interstate ? ['IGST', r.igst_total] : null,
      r.round_off ? ['Round off', r.round_off] : null,
    ].filter(Boolean),
    split: null,
    grand_total: r.total,
    words: r.amount_in_words,
    payment: [
      adjusted ? ['Adjusted against bill', adjusted] : null,
      refunded ? ['Refunded', refunded] : null,
      r.total - adjusted - refunded > 0 && r.settlement !== 'exchange'
        ? ['Kept as advance', r.total - adjusted - refunded]
        : null,
    ].filter(Boolean),
    paid_modes: '',
    fitted_by: '',
    notes: r.reason ? `Reason: ${r.reason}` : null,
    qr: null,
    cancelled: r.status === 'cancelled' ? r.cancel_reason : null,
    duplicate,
    terms: '',
    signature: true,
  };
}

// ---------------------------------------------------------------- A4

const BASE_CSS = `
  * { box-sizing: border-box; }
  body { font-family: 'Segoe UI', Arial, sans-serif; color: #111; margin: 0; }
  .n { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
  .muted { color: #555; }
  .watermark { position: fixed; top: 38%; left: 0; right: 0; text-align: center; font-size: 96px;
    font-weight: 800; color: rgba(185, 28, 28, 0.16); transform: rotate(-24deg); pointer-events: none; }
`;

function lineCells(l) {
  const serialsHtml = (l.serials || []).length
    ? `<div class="sn">S/N: ${l.serials
        .filter((x) => x.link_status !== 'cancelled')
        .map(
          (x) =>
            `${esc(x.serial_no)}${x.note ? ` (${esc(x.note)})` : x.warranty_end ? ` · warranty till ${dmy(x.warranty_end)}` : ''}`,
        )
        .join(', ')}</div>`
    : '';
  const warranty =
    !(l.serials || []).length && l.warranty_end
      ? `<div class="sn">Warranty valid till ${dmy(l.warranty_end)}</div>`
      : l.warranty_note
        ? `<div class="sn">${esc(l.warranty_note)}</div>`
        : '';
  const mergedNote =
    l.merged_fitting && l.merged_fitting.length
      ? `<div class="sn">incl. ${l.merged_fitting.map((f) => esc(f.product_name)).join(', ')} ${money(l.merged_fitting.reduce((s, f) => s + f.line_total, 0))}</div>`
      : '';
  const fitted = l.fitted_by ? `<div class="sn">Fitted by ${esc(l.fitted_by)}</div>` : '';
  return { serialsHtml, warranty, mergedNote, fitted };
}

function a4Html(m) {
  const { b, gst } = m;
  const rows = m.lines
    .map((l, i) => {
      const c = lineCells(l);
      return `<tr class="${l.is_fitting ? 'fit' : ''}">
        <td>${i + 1}</td>
        <td><strong>${esc(l.product_name)}</strong>${l.variant_label ? ` <span class="muted">(${esc(l.variant_label)})</span>` : ''}
          ${c.serialsHtml}${c.warranty}${c.mergedNote}${c.fitted}</td>
        ${gst ? `<td>${esc(l.hsn_code || '')}</td>` : ''}
        <td class="n">${qty(l.qty_milli)} ${esc(l.unit)}</td>
        <td class="n">${money(l.rate)}</td>
        ${m.kind === 'credit_note' ? '' : `<td class="n">${l.discount + (l.bill_discount_share || 0) ? money(l.discount + (l.bill_discount_share || 0)) : ''}</td>`}
        ${gst ? `<td class="n">${money(l.taxable)}</td><td class="n">${pct(l.gst_rate_bp)}</td><td class="n">${money(l.tax)}</td>` : ''}
        <td class="n"><strong>${money(l.line_total)}</strong></td>
      </tr>`;
    })
    .join('');
  const taxRows = m.tax_summary
    .filter((t) => t.taxable || t.cgst || t.igst)
    .map(
      (t) => `<tr><td>${pct(t.gst_rate_bp)}</td><td class="n">${money(t.taxable)}</td>
        ${m.interstate ? `<td class="n">${money(t.igst)}</td>` : `<td class="n">${money(t.cgst)}</td><td class="n">${money(t.sgst)}</td>`}
        <td class="n">${money(t.cgst + t.sgst + t.igst)}</td></tr>`,
    )
    .join('');
  const logo = m.logo ? `<img class="logo" src="${m.logo}" alt="">` : '';
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(m.number)}</title>
<style>${BASE_CSS}
  @page { size: A4; margin: 10mm; }
  body { font-size: 11px; }
  .head { display: flex; gap: 14px; align-items: flex-start; border-bottom: 2px solid #222; padding-bottom: 8px; }
  .logo { height: 64px; max-width: 120px; object-fit: contain; }
  .biz { flex: 1; } .biz h1 { font-size: 20px; margin: 0 0 2px; }
  .doc { text-align: right; } .doc .t { font-size: 17px; font-weight: 800; letter-spacing: 0.5px; }
  .copy { display: inline-block; border: 1px solid #b91c1c; color: #b91c1c; font-weight: 700; padding: 1px 6px; margin-top: 3px; }
  .grid { display: grid; grid-template-columns: 1.3fr 1fr; gap: 16px; margin: 10px 0; }
  .box { border: 1px solid #ccc; border-radius: 4px; padding: 6px 8px; }
  .lbl { font-size: 9.5px; text-transform: uppercase; color: #666; letter-spacing: 0.4px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { border-bottom: 1px solid #ddd; padding: 4px 5px; text-align: left; vertical-align: top; }
  th { background: #f1f3f9; font-weight: 600; font-size: 10px; }
  tr.fit td { background: #fafafa; }
  .sn { font-size: 9.5px; color: #333; margin-top: 2px; }
  .bottom { display: grid; grid-template-columns: 1fr 44%; gap: 16px; margin-top: 10px; }
  .totals td { border: none; padding: 2px 5px; }
  .grand td { font-size: 14px; font-weight: 800; border-top: 2px solid #222; padding-top: 4px; }
  .words { margin-top: 6px; font-weight: 600; }
  .qr { display: flex; gap: 10px; align-items: center; margin-top: 8px; }
  .terms { margin-top: 10px; font-size: 9.5px; white-space: pre-wrap; color: #333; }
  .sign { display: flex; justify-content: space-between; margin-top: 40px; }
  .sign div { width: 32%; text-align: center; border-top: 1px solid #555; padding-top: 4px; }
  .footer { text-align: center; margin-top: 10px; font-size: 10px; color: #555; }
</style></head><body>
${m.cancelled ? '<div class="watermark">CANCELLED</div>' : ''}
<div class="head">
  ${logo}
  <div class="biz"><h1>${esc(b.name)}</h1>
    <div>${esc(b.address).replace(/\n/g, '<br>')}</div>
    <div class="muted">${[b.phone ? `Ph ${b.phone}` : '', b.email, gst && b.gstin ? `GSTIN ${b.gstin}` : '', gst ? b.state : ''].filter(Boolean).map(esc).join(' · ')}</div>
    ${b.composition && m.kind === 'invoice' ? '<div class="muted">Composition taxable person, not eligible to collect tax on supplies</div>' : ''}</div>
  <div class="doc"><div class="t">${esc(m.title.toUpperCase())}</div>
    <div>${esc(m.number_label)} <strong>${esc(m.number)}</strong></div>
    <div>Date ${dmy(m.date)}</div>
    ${m.extra.map(([k, v]) => `<div>${esc(k)}: ${esc(v)}</div>`).join('')}
    ${m.duplicate ? '<div class="copy">DUPLICATE</div>' : ''}</div>
</div>
${m.cancelled ? `<p style="color:#b91c1c;font-weight:700">CANCELLED: ${esc(m.cancelled)}</p>` : ''}
<div class="grid">
  <div class="box"><div class="lbl">${m.kind === 'quotation' ? 'Quotation for' : 'Bill to'}</div>
    <strong>${esc(m.customer.name)}</strong>
    ${m.customer.phone ? `<div>${esc(m.customer.phone)}</div>` : ''}
    ${m.customer.address ? `<div>${esc(m.customer.address)}</div>` : ''}
    ${gst && m.customer.gstin ? `<div>GSTIN ${esc(m.customer.gstin)}</div>` : ''}</div>
  <div class="box">
    ${m.vehicle ? `<div class="lbl">Vehicle</div><strong>${esc(m.vehicle)}</strong>` : ''}
    ${m.pos ? `<div class="lbl" style="margin-top:4px">Place of supply</div>${esc(m.pos)} · ${m.interstate ? 'IGST' : 'CGST + SGST'}` : ''}
    ${!m.vehicle && !m.pos ? '<div class="muted">—</div>' : ''}</div>
</div>
<table><thead><tr><th>#</th><th>Item</th>${gst ? '<th>HSN/SAC</th>' : ''}<th class="n">Qty</th><th class="n">Rate</th>
  ${m.kind === 'credit_note' ? '' : '<th class="n">Disc.</th>'}${gst ? '<th class="n">Taxable</th><th class="n">GST</th><th class="n">Tax</th>' : ''}<th class="n">Amount</th></tr></thead>
<tbody>${rows}</tbody></table>
<div class="bottom">
  <div>
    ${gst && taxRows ? `<table><thead><tr><th>GST rate</th><th class="n">Taxable</th>${m.interstate ? '<th class="n">IGST</th>' : '<th class="n">CGST</th><th class="n">SGST</th>'}<th class="n">Total tax</th></tr></thead><tbody>${taxRows}</tbody></table>` : ''}
    ${m.split ? `<p class="muted">${esc(m.split)}</p>` : ''}
    <div class="words">${esc(m.words)}</div>
    ${m.paid_modes ? `<div class="muted">Received: ${esc(m.paid_modes)}</div>` : ''}
    ${m.fitted_by ? `<div class="muted">Fitted by: ${esc(m.fitted_by)}</div>` : ''}
    ${m.notes ? `<div class="muted">${esc(m.notes)}</div>` : ''}
    ${m.qr ? `<div class="qr">${m.qr}<div><strong>Scan to pay ${money(m.qr_amount)}</strong><br><span class="muted">UPI: ${esc(b.upi_id)}</span></div></div>` : ''}
  </div>
  <table class="totals">
    ${m.totals.map(([k, v]) => `<tr><td>${esc(k)}</td><td class="n">${money(v)}</td></tr>`).join('')}
    <tr class="grand"><td>${m.kind === 'credit_note' ? 'Total credit' : 'Grand total'}</td><td class="n">${money(m.grand_total)}</td></tr>
    ${m.payment.map(([k, v]) => `<tr><td>${esc(k)}</td><td class="n">${money(v)}</td></tr>`).join('')}
  </table>
</div>
${m.terms ? `<div class="terms"><strong>Terms &amp; conditions</strong>\n${esc(m.terms)}</div>` : ''}
${m.signature ? `<div class="sign"><div>Customer's signature</div><div></div><div>For ${esc(b.name)}<br>Authorised signatory</div></div>` : ''}
${b.footer ? `<div class="footer">${esc(b.footer)}</div>` : ''}
</body></html>`;
}

// ---------------------------------------------------------------- thermal 80 mm

function thermalHtml(m) {
  const { b, gst } = m;
  const rows = m.lines
    .map((l) => {
      const c = lineCells(l);
      return `<div class="item"><div>${esc(l.product_name)}${l.variant_label ? ` (${esc(l.variant_label)})` : ''}</div>
        <div class="row"><span>${qty(l.qty_milli)} × ${money(l.rate)}${gst ? ` · ${pct(l.gst_rate_bp)}` : ''}</span><span>${money(l.line_total)}</span></div>
        ${c.serialsHtml}${c.warranty}${c.mergedNote}${c.fitted}</div>`;
    })
    .join('');
  const taxRows =
    gst && !m.b.composition
      ? m.tax_summary
          .filter((t) => t.cgst || t.igst)
          .map(
            (t) =>
              `<div class="row"><span>${pct(t.gst_rate_bp)} on ${money(t.taxable)}</span><span>${m.interstate ? `IGST ${money(t.igst)}` : `C ${money(t.cgst)} S ${money(t.sgst)}`}</span></div>`,
          )
          .join('')
      : '';
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(m.number)}</title>
<style>${BASE_CSS}
  @page { size: 80mm auto; margin: 0; }
  body { width: 80mm; padding: 3mm 4mm; font-size: 11px; line-height: 1.3; }
  .c { text-align: center; } h1 { font-size: 15px; margin: 0; }
  .logo { max-height: 18mm; max-width: 40mm; display: block; margin: 0 auto 2px; }
  .hr { border-top: 1px dashed #000; margin: 4px 0; }
  .row { display: flex; justify-content: space-between; gap: 6px; }
  .item { margin: 3px 0; } .sn { font-size: 9.5px; }
  .grand { font-size: 14px; font-weight: 800; }
  .qr { text-align: center; margin-top: 4px; }
  .watermark { font-size: 40px; }
</style></head><body>
${m.cancelled ? '<div class="watermark">CANCELLED</div>' : ''}
<div class="c">
  ${m.logo ? `<img class="logo" src="${m.logo}" alt="">` : ''}
  <h1>${esc(b.name)}</h1>
  <div>${esc(b.address)}</div>
  ${b.phone ? `<div>Ph ${esc(b.phone)}</div>` : ''}
  ${gst && b.gstin ? `<div>GSTIN ${esc(b.gstin)}</div>` : ''}
  <div class="hr"></div>
  <strong>${esc(m.title.toUpperCase())}</strong>${m.duplicate ? ' · DUPLICATE' : ''}
</div>
<div class="row"><span>${esc(m.number)}</span><span>${dmy(m.date)}</span></div>
${m.extra.map(([k, v]) => `<div>${esc(k)}: ${esc(v)}</div>`).join('')}
<div>${esc(m.customer.name)}${m.customer.phone ? ` · ${esc(m.customer.phone)}` : ''}</div>
${gst && m.customer.gstin ? `<div>GSTIN ${esc(m.customer.gstin)}</div>` : ''}
${m.vehicle ? `<div>Vehicle: ${esc(m.vehicle)}</div>` : ''}
${m.cancelled ? `<div><strong>CANCELLED: ${esc(m.cancelled)}</strong></div>` : ''}
<div class="hr"></div>
${rows}
<div class="hr"></div>
${m.totals.map(([k, v]) => `<div class="row"><span>${esc(k)}</span><span>${money(v)}</span></div>`).join('')}
<div class="row grand"><span>${m.kind === 'credit_note' ? 'CREDIT' : 'TOTAL'}</span><span>${money(m.grand_total)}</span></div>
${m.payment.map(([k, v]) => `<div class="row"><span>${esc(k)}</span><span>${money(v)}</span></div>`).join('')}
<div class="sn">${esc(m.words)}</div>
${taxRows ? `<div class="hr"></div>${taxRows}` : ''}
${m.paid_modes ? `<div class="sn">Received: ${esc(m.paid_modes)}</div>` : ''}
${m.qr ? `<div class="qr">${m.qr.replace(/width="[^"]+" height="[^"]+"/, 'width="36mm" height="36mm"')}<div>Scan to pay ${money(m.qr_amount)}</div></div>` : ''}
<div class="hr"></div>
${b.footer ? `<div class="c">${esc(b.footer)}</div>` : ''}
</body></html>`;
}

function render(model, { format = 'a4', logo = null } = {}) {
  const m = { ...model, logo };
  return format === 'thermal80' ? thermalHtml(m) : a4Html(m);
}

function invoiceHtml(db, saleId, opts = {}) {
  return render(invoiceModel(db, saleId, opts), opts);
}

function quotationHtml(db, quotationId, opts = {}) {
  return render(quotationModel(db, quotationId), opts);
}

function creditNoteHtml(db, returnId, opts = {}) {
  return render(creditNoteModel(db, returnId, opts), opts);
}

module.exports = { FORMATS, invoiceHtml, quotationHtml, creditNoteHtml, displayLines };
