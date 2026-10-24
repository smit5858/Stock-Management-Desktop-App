'use strict';

// Printable warranty documents: claim slip / job card, rejection slip, handover slip
// (A4 split in two halves: customer copy + shop copy, or thermal 80 mm: both copies one after
// the other) and the warranty card given at sale time. Self-contained HTML (system fonts, logo
// as a data URL), rendered in a hidden script-less window by the IPC layer. No electron imports.

const settings = require('./settings');
const claims = require('./claims');
const { todayISO } = require('./parse');
const units = require('./warrantyUnits');
const { money, dmy, esc } = require('./statements');

const DOCS = {
  slip: 'Warranty Claim / Job Card',
  rejection: 'Warranty Claim Rejected',
  handover: 'Handover Slip',
};
const FORMATS = ['a4half', 'thermal80'];

function business(db) {
  const s = settings.getSettings(db);
  return {
    name: s.business_name || '',
    address: s.business_address || '',
    phone: s.business_phone || '',
    gstin: s.business_gstin || '',
    claim_terms: s.claim_terms || '',
  };
}

function qty(milli) {
  const frac = milli % 1000;
  return `${(milli - frac) / 1000}${frac ? `.${String(frac).padStart(3, '0').replace(/0+$/, '')}` : ''}`;
}

function nl(text) {
  return esc(text).replace(/\n/g, '<br>');
}

/** Rows of [label, value] for a claim document (values are plain text, escaped later). */
function claimRows(c, doc) {
  const rows = [
    [
      'Customer',
      [c.customer_name, c.customer_phone_display].filter(Boolean).join(' · ') ||
        (c.kind === 'stock' ? 'Shop stock (defective)' : ''),
    ],
    c.brought_by_name
      ? ['Brought by', [c.brought_by_name, c.brought_by_phone_display].filter(Boolean).join(' · ')]
      : null,
    c.vehicle_no
      ? ['Vehicle', `${c.vehicle_no}${c.vehicle_model ? ` · ${c.vehicle_model}` : ''}`]
      : null,
    [
      'Product',
      `${c.product.name}${c.product.variant_label ? ` (${c.product.variant_label})` : ''}${c.product.brand ? ` · ${c.product.brand}` : ''}`,
    ],
    c.serial
      ? [
          'Serial no.',
          `${c.serial.serial_no}${c.serial.serial_no_2 ? ` / ${c.serial.serial_no_2}` : ''}`,
        ]
      : ['Quantity', `${qty(c.qty_milli)} ${c.product.unit}`],
    c.sale ? ['Bill', `${c.sale.invoice_no} dated ${dmy(c.sale.invoice_date)}`] : null,
    c.kind === 'customer'
      ? [
          'Warranty',
          c.chargeable
            ? 'Out of warranty: chargeable repair'
            : c.warranty_end
              ? `Valid till ${dmy(c.warranty_end)}`
              : '—',
        ]
      : null,
    ['Complaint', c.complaint],
    c.condition_notes ? ['Condition', c.condition_notes] : null,
    c.accessories.length ? ['Items received', c.accessories.join(', ')] : null,
  ];
  if (doc === 'slip') {
    rows.push(c.expected_date ? ['Expected by', dmy(c.expected_date)] : null);
    rows.push(c.received_by ? ['Received by', c.received_by] : null);
  }
  if (doc === 'rejection') {
    rows.push([
      'Reason',
      `${c.reject_reason_label || 'Rejected'}${c.reject_notes ? `: ${c.reject_notes}` : ''}`,
    ]);
    rows.push(c.inspection_notes ? ['Inspection', c.inspection_notes] : null);
  }
  if (doc === 'handover') {
    rows.push(['Result', c.outcome_label || c.status_label]);
    rows.push(
      c.replacement
        ? [
            'Replacement',
            `S/N ${c.replacement.serial_no}${c.replacement_warranty_end ? ` · warranty till ${dmy(c.replacement_warranty_end)}` : ''}`,
          ]
        : null,
    );
    rows.push(c.repair_notes ? ['Work done', c.repair_notes] : null);
    rows.push(c.bill ? ['Bill', `${c.bill.invoice_no} · ${money(c.bill.grand_total)}`] : null);
    rows.push(
      c.credit_note
        ? ['Credit note', `${c.credit_note.return_no} · ${money(c.credit_note.total)}`]
        : null,
    );
    rows.push([
      'Handed over',
      `${dmy(c.handover_date)}${c.handed_over_by ? ` by ${c.handed_over_by}` : ''}`,
    ]);
    rows.push(c.final_notes ? ['Notes', c.final_notes] : null);
  }
  return rows.filter(Boolean);
}

function termsText(c, b) {
  const t = [];
  if (c.product.terms.covered) t.push(`Covered: ${c.product.terms.covered}`);
  if (c.product.terms.not_covered) t.push(`Not covered: ${c.product.terms.not_covered}`);
  if (b.claim_terms) t.push(b.claim_terms);
  return t.join('\n');
}

const BASE_CSS = `
  * { box-sizing: border-box; }
  body { font-family: 'Segoe UI', Arial, sans-serif; color: #111; margin: 0; }
  .muted { color: #555; }
  table.kv { width: 100%; border-collapse: collapse; }
  table.kv td { padding: 2px 4px; vertical-align: top; border-bottom: 1px solid #eee; }
  table.kv td.k { width: 30%; color: #555; white-space: nowrap; }
`;

function headHtml(b, logo, title, number, date, copy) {
  return `<div class="head">
    ${logo ? `<img class="logo" src="${logo}" alt="">` : ''}
    <div class="biz"><div class="bn">${esc(b.name)}</div>
      <div class="muted">${esc(b.address)}${b.phone ? ` · Ph ${esc(b.phone)}` : ''}</div></div>
    <div class="doc"><div class="t">${esc(title)}</div>
      <div><strong>${esc(number)}</strong> · ${dmy(date)}</div>
      ${copy ? `<div class="copy">${esc(copy)}</div>` : ''}</div>
  </div>`;
}

function halfHtml(c, b, logo, doc, copy) {
  const date =
    doc === 'handover' ? c.handover_date : doc === 'rejection' ? c.updated_at : c.received_date;
  const rows = claimRows(c, doc)
    .map(([k, v]) => `<tr><td class="k">${esc(k)}</td><td>${nl(v)}</td></tr>`)
    .join('');
  const terms = doc === 'slip' ? termsText(c, b) : '';
  const signs =
    doc === 'handover'
      ? ['Received the above in good condition (customer)', `For ${b.name}`]
      : doc === 'rejection'
        ? ['Customer', `For ${b.name}`]
        : ['Customer', `Received by, for ${b.name}`];
  return `<section class="half">
    ${headHtml(b, logo, DOCS[doc], c.claim_no, date, copy)}
    <table class="kv">${rows}</table>
    ${terms ? `<div class="terms">${nl(terms)}</div>` : ''}
    <div class="sign">${signs.map((s) => `<div>${esc(s)}</div>`).join('')}</div>
  </section>`;
}

function a4HalfHtml(c, b, logo, doc) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(c.claim_no)}</title>
<style>${BASE_CSS}
  @page { size: A4; margin: 8mm; }
  body { font-size: 10.5px; }
  .half { height: 136mm; overflow: hidden; display: flex; flex-direction: column; gap: 5px; }
  .cut { border-top: 1px dashed #888; margin: 3mm 0; text-align: center; font-size: 8px; color: #888; }
  .head { display: flex; gap: 10px; align-items: flex-start; border-bottom: 2px solid #222; padding-bottom: 5px; }
  .logo { height: 40px; max-width: 80px; object-fit: contain; }
  .biz { flex: 1; } .bn { font-size: 15px; font-weight: 800; }
  .doc { text-align: right; } .doc .t { font-size: 13px; font-weight: 800; }
  .copy { display: inline-block; border: 1px solid #333; padding: 0 5px; margin-top: 2px; font-weight: 700; font-size: 9px; }
  .terms { font-size: 8.5px; color: #333; white-space: normal; border-top: 1px solid #ddd; padding: 3px 4px 0; }
  .sign { margin-top: auto; display: flex; justify-content: space-between; gap: 20px; padding-top: 26px; }
  .sign div { flex: 1; border-top: 1px solid #555; text-align: center; padding-top: 3px; font-size: 9px; }
</style></head><body>
${halfHtml(c, b, logo, doc, 'CUSTOMER COPY')}
<div class="cut">✂ cut here</div>
${halfHtml(c, b, logo, doc, 'SHOP COPY')}
</body></html>`;
}

function thermalHtml(c, b, logo, doc) {
  const date = doc === 'handover' ? c.handover_date : c.received_date;
  const copyHtml = (copy) => `<div class="c">
      ${logo ? `<img class="logo" src="${logo}" alt="">` : ''}
      <div class="bn">${esc(b.name)}</div>
      ${b.phone ? `<div>Ph ${esc(b.phone)}</div>` : ''}
      <div class="hr"></div><strong>${esc(DOCS[doc].toUpperCase())}</strong><div>${esc(copy)}</div></div>
    <div class="row"><span>${esc(c.claim_no)}</span><span>${dmy(date)}</span></div>
    <div class="hr"></div>
    ${claimRows(c, doc)
      .map(([k, v]) => `<div><span class="k">${esc(k)}:</span> ${nl(v)}</div>`)
      .join('')}
    ${doc === 'slip' && termsText(c, b) ? `<div class="hr"></div><div class="small">${nl(termsText(c, b))}</div>` : ''}
    <div class="sig">Signature</div>`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(c.claim_no)}</title>
<style>${BASE_CSS}
  @page { size: 80mm auto; margin: 0; }
  body { width: 80mm; padding: 3mm 4mm; font-size: 11px; line-height: 1.3; }
  .c { text-align: center; } .bn { font-size: 14px; font-weight: 800; }
  .logo { max-height: 16mm; max-width: 36mm; display: block; margin: 0 auto 2px; }
  .hr { border-top: 1px dashed #000; margin: 4px 0; }
  .row { display: flex; justify-content: space-between; } .k { color: #444; }
  .small { font-size: 9px; } .sig { margin-top: 26px; border-top: 1px solid #000; text-align: center; font-size: 9px; }
  .cut { text-align: center; margin: 8px 0; border-top: 1px dashed #000; font-size: 9px; }
</style></head><body>
${copyHtml('Customer copy')}
<div class="cut">✂</div>
${copyHtml('Shop copy')}
</body></html>`;
}

/** doc: slip | rejection | handover; format: a4half | thermal80. */
function claimHtml(db, claimId, { doc = 'slip', format = 'a4half', logo = null } = {}) {
  const c = claims.get(db, claimId);
  const b = business(db);
  const d = DOCS[doc] ? doc : 'slip';
  return format === 'thermal80' ? thermalHtml(c, b, logo, d) : a4HalfHtml(c, b, logo, d);
}

// ---------------------------------------------------------------- warranty card

/** The units with a warranty on a bill (or one unit / line). */
function cardUnits(db, { sale_id: saleId, serial_id: serialId, sale_item_id: saleItemId }) {
  if (Number.isInteger(serialId) || Number.isInteger(saleItemId)) {
    return [units.unit(db, { serial_id: serialId, sale_item_id: saleItemId })];
  }
  const ctx = { today: todayISO(), days: units.expiringDays(db) };
  return units
    .unitsOfSale(db, saleId, ctx)
    .filter((u) => u.warranty_end && !['void', 'replaced', 'refunded'].includes(u.status.status))
    .map((u) =>
      units.unit(
        db,
        u.kind === 'serial' ? { serial_id: u.serial_id } : { sale_item_id: u.sale_item_id },
      ),
    );
}

function cardHtml(u, b, logo) {
  const rows = [
    [
      'Product',
      `${u.product_name}${u.variant_label ? ` (${u.variant_label})` : ''}${u.brand ? ` · ${u.brand}` : ''}`,
    ],
    u.serial_no
      ? ['Serial no.', `${u.serial_no}${u.serial_no_2 ? ` / ${u.serial_no_2}` : ''}`]
      : ['Quantity', `${qty(u.qty_milli)} ${u.unit}`],
    ['Customer', [u.sale?.customer_name, u.sale?.customer_phone].filter(Boolean).join(' · ')],
    u.sale?.vehicle_no
      ? [
          'Vehicle',
          `${u.sale.vehicle_no}${u.sale.vehicle_model ? ` · ${u.sale.vehicle_model}` : ''}`,
        ]
      : null,
    ['Bill', u.sale ? `${u.sale.invoice_no} dated ${dmy(u.sale.invoice_date)}` : ''],
    ['Warranty', `${dmy(u.warranty_start || u.sale?.invoice_date)} to ${dmy(u.warranty_end)}`],
  ].filter(Boolean);
  const t = [
    u.terms.covered ? `Covered: ${u.terms.covered}` : '',
    u.terms.not_covered ? `Not covered: ${u.terms.not_covered}` : '',
  ]
    .filter(Boolean)
    .join('\n');
  return `<section class="card">
    <div class="head">${logo ? `<img class="logo" src="${logo}" alt="">` : ''}
      <div class="biz"><div class="bn">${esc(b.name)}</div><div class="muted">${esc(b.address)}${b.phone ? ` · Ph ${esc(b.phone)}` : ''}</div></div>
      <div class="badge">WARRANTY CARD</div></div>
    <table class="kv">${rows.map(([k, v]) => `<tr><td class="k">${esc(k)}</td><td>${esc(v)}</td></tr>`).join('')}</table>
    <div class="valid">Valid till <strong>${dmy(u.warranty_end)}</strong></div>
    ${t ? `<div class="terms">${nl(t)}</div>` : ''}
    <div class="foot">Keep this card and the bill. Bring the item with this card for any warranty service.</div>
  </section>`;
}

function warrantyCardHtml(db, ref, { format = 'a4half', logo = null } = {}) {
  const list = cardUnits(db, ref);
  const b = business(db);
  if (format === 'thermal80') {
    return `<!doctype html><html><head><meta charset="utf-8"><title>Warranty card</title>
<style>${BASE_CSS}
  @page { size: 80mm auto; margin: 0; }
  body { width: 80mm; padding: 3mm 4mm; font-size: 11px; }
  .card { border-bottom: 1px dashed #000; padding-bottom: 6px; margin-bottom: 6px; }
  .head { text-align: center; } .logo { max-height: 14mm; display: block; margin: 0 auto; }
  .bn { font-weight: 800; font-size: 14px; } .badge { font-weight: 800; margin: 3px 0; }
  .valid { text-align: center; font-size: 13px; margin: 4px 0; } .terms, .foot { font-size: 9px; }
</style></head><body>${list.map((u) => cardHtml(u, b, logo)).join('') || '<p>No warranty items.</p>'}</body></html>`;
  }
  return `<!doctype html><html><head><meta charset="utf-8"><title>Warranty card</title>
<style>${BASE_CSS}
  @page { size: A4; margin: 10mm; }
  body { font-size: 11px; }
  .card { border: 2px solid #1e3a8a; border-radius: 8px; padding: 10px 12px; margin-bottom: 8mm;
    page-break-inside: avoid; min-height: 120mm; display: flex; flex-direction: column; gap: 6px; }
  .head { display: flex; gap: 10px; align-items: center; border-bottom: 1px solid #ccc; padding-bottom: 6px; }
  .logo { height: 44px; max-width: 90px; object-fit: contain; }
  .biz { flex: 1; } .bn { font-size: 16px; font-weight: 800; }
  .badge { background: #1e3a8a; color: #fff; font-weight: 800; padding: 4px 10px; border-radius: 4px; letter-spacing: 1px; }
  .valid { font-size: 15px; text-align: center; border: 1px dashed #1e3a8a; padding: 6px; border-radius: 6px; }
  .terms { font-size: 9.5px; color: #333; } .foot { margin-top: auto; font-size: 9px; color: #555; text-align: center; }
</style></head><body>${list.map((u) => cardHtml(u, b, logo)).join('') || '<p>No items with a warranty on this bill.</p>'}</body></html>`;
}

module.exports = { DOCS, FORMATS, claimHtml, warrantyCardHtml, cardUnits };
