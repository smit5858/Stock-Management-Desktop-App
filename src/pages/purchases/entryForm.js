// Purchase entry form: state shape, parsing to integers (paise / milli / basis points) and
// conversion to the save payload and the draft JSON. No floats anywhere.
import { paiseToInput, parseMoney } from '../../utils/money';
import { parseQty } from '../../utils/qty';
import { todayISO } from '../../utils/dates';

let uidSeq = 1;
export const uid = () => `l${Date.now().toString(36)}${uidSeq++}`;

/** '12.5' / '12.5%' → 1250 basis points (null if invalid). */
export function parseBp(input) {
  const m = /^(\d{1,3})(?:\.(\d{0,2}))?$/.exec(String(input ?? '').replace(/[%\s]/g, ''));
  if (!m) return null;
  const v = Number(m[1]) * 100 + Number((m[2] || '').padEnd(2, '0'));
  return v <= 10000 ? v : null;
}

export function bpToInput(bp) {
  if (bp == null) return '';
  const f = bp % 100;
  return `${(bp - f) / 100}${f ? `.${String(f).padStart(2, '0').replace(/0+$/, '')}` : ''}`;
}

export function qtyToInput(milli) {
  if (milli == null) return '';
  const f = milli % 1000;
  return `${(milli - f) / 1000}${f ? `.${String(f).padStart(3, '0').replace(/0+$/, '')}` : ''}`;
}

export function emptyForm(meta, supplier = null) {
  return {
    party: supplier,
    bill_no: '',
    bill_date: todayISO(),
    entry_date: todayISO(),
    bill_type: meta.composition_dealer ? 'gst' : meta.default_bill_type || 'gst',
    price_mode: meta.default_price_mode || 'exclusive',
    charges_mode: meta.default_charges_mode || 'cost',
    lines: [],
    charges: [],
    round_off: null, // null = automatic; string when typed
    printed_total: '',
    notes: '',
    pay_mode: 'none', // none | full | partial
    pay_amount: '',
    pay_method: 'cash',
    pay_ref: '',
    use_advance: false,
    advance_amount: '',
    attachments: [],
  };
}

/** A grid line from a product search row (products:search). */
export function lineFromProduct(p, rate = null) {
  return {
    uid: uid(),
    variant_id: p.variant_id,
    product_id: p.product_id,
    name: p.name,
    variant_label: p.variant_label || '',
    sku: p.sku,
    hsn_code: p.hsn_code || '',
    unit: p.unit,
    track_serials: Boolean(p.track_serials),
    qty: '1',
    free: '',
    rate: paiseToInput(rate ?? p.purchase_price ?? 0),
    disc: '',
    disc_mode: 'pct',
    gst_rate_bp: p.gst_rate_bp ?? 0,
    serials: null,
    update_purchase_price: false,
    price_update: false,
    new_mrp: paiseToInput(p.mrp || 0),
    new_selling: paiseToInput(p.selling_price || 0),
    mrp: p.mrp || 0,
    selling_price: p.selling_price || 0,
  };
}

export function serialCount(s) {
  if (!s) return 0;
  return (s.entries ? s.entries.length : 0) + (s.auto ? s.auto.count : 0);
}

/** Parsed numbers of one line; `errors` keys are the column names. */
export function parseLine(l) {
  const errors = {};
  const qty = parseQty(l.qty);
  const free = l.free === '' ? 0 : parseQty(l.free);
  const rate = parseMoney(l.rate === '' ? '0' : l.rate);
  let discountBp = null;
  let discount = 0;
  if (l.disc !== '') {
    if (l.disc_mode === 'pct') discountBp = parseBp(l.disc);
    else discount = parseMoney(l.disc);
    if (discountBp === null && discount === null) errors.disc = 'Invalid';
    if (l.disc_mode === 'pct' && discountBp === null) errors.disc = 'Invalid';
  }
  if (qty === null || qty <= 0) errors.qty = 'Qty';
  if (free === null || free < 0) errors.free = 'Invalid';
  if (rate === null || rate < 0) errors.rate = 'Rate';
  return {
    errors,
    values: {
      variant_id: l.variant_id,
      qty_milli: qty ?? 0,
      free_qty_milli: free ?? 0,
      rate: rate ?? 0,
      discount_bp: discountBp,
      discount: discount ?? 0,
      gst_rate_bp: l.gst_rate_bp,
    },
  };
}

/** Payload for purchases:calculate (bad numbers count as 0). */
export function calcPayload(form) {
  return {
    party_id: form.party ? form.party.id : null,
    bill_type: form.bill_type,
    price_mode: form.price_mode,
    charges_mode: form.charges_mode,
    round_off: roundOffValue(form),
    printed_total: form.printed_total === '' ? null : parseMoney(form.printed_total),
    items: form.lines.map((l) => parseLine(l).values),
    charges: form.charges.map((c) => ({
      kind: c.kind,
      amount: parseMoney(c.amount || '0') ?? 0,
      gst_rate_bp: c.gst_rate_bp,
    })),
  };
}

export function roundOffValue(form) {
  if (form.round_off == null) return null;
  const v = parseMoney(form.round_off);
  return v === null ? null : v;
}

/**
 * The save payload, plus client-side errors keyed like the server's ('items.0.qty_milli').
 * `grandTotal` (from the live calculation) decides "Paid now: full".
 */
export function toPayload(form, { grandTotal = 0, draftId = null, editing = false } = {}) {
  const errors = {};
  if (!form.party) errors.party_id = 'Choose the supplier.';
  if (!form.bill_date) errors.bill_date = 'Enter the bill date.';
  if (form.lines.length === 0) errors.items = 'Add at least one item.';
  const items = form.lines.map((l, i) => {
    const { values, errors: e } = parseLine(l);
    for (const [k, msg] of Object.entries(e)) {
      errors[
        `items.${i}.${k === 'qty' ? 'qty_milli' : k === 'free' ? 'free_qty_milli' : k === 'disc' ? 'discount' : k}`
      ] = msg;
    }
    const out = { ...values };
    if (l.track_serials) out.serials = l.serials || { entries: [], auto: null };
    if (l.update_purchase_price) out.update_purchase_price = true;
    if (l.price_update) {
      const mrp = parseMoney(l.new_mrp || '0');
      const sp = parseMoney(l.new_selling || '0');
      if (mrp === null) errors[`items.${i}.new_mrp`] = 'Invalid MRP';
      if (sp === null) errors[`items.${i}.new_selling_price`] = 'Invalid price';
      out.new_mrp = mrp;
      out.new_selling_price = sp;
    }
    return out;
  });
  const charges = form.charges
    .filter((c) => c.amount !== '')
    .map((c, i) => {
      const amount = parseMoney(c.amount);
      if (amount === null || amount <= 0) errors[`charges.${i}.amount`] = 'Invalid amount';
      return { kind: c.kind, label: c.label, amount, gst_rate_bp: c.gst_rate_bp };
    });
  const printed = form.printed_total === '' ? null : parseMoney(form.printed_total);
  if (form.printed_total !== '' && printed === null) errors.printed_total = 'Invalid amount';
  if (form.round_off != null && roundOffValue(form) === null) errors.round_off = 'Invalid';

  let payment = null;
  if (!editing && form.pay_mode !== 'none') {
    const amount =
      form.pay_mode === 'full' ? grandTotal - advanceValue(form) : parseMoney(form.pay_amount);
    if (amount === null || amount <= 0) errors['payment.amount'] = 'Enter the amount paid.';
    payment = { amount, mode: form.pay_method, ref_no: form.pay_ref };
  }
  const advance = !editing && form.use_advance ? advanceValue(form) : 0;
  return {
    errors,
    payload: {
      party_id: form.party ? form.party.id : null,
      bill_no: form.bill_no,
      bill_date: form.bill_date,
      entry_date: form.entry_date,
      bill_type: form.bill_type,
      price_mode: form.price_mode,
      charges_mode: form.charges_mode,
      round_off: roundOffValue(form),
      printed_total: printed,
      notes: form.notes,
      items,
      charges,
      payment,
      advance_amount: advance,
      attachments: form.attachments
        .filter((a) => a.temp_path)
        .map(({ temp_path, original_name, size_bytes }) => ({
          temp_path,
          original_name,
          size_bytes,
        })),
      draft_id: draftId,
    },
  };
}

export function advanceValue(form) {
  if (!form.use_advance) return 0;
  return parseMoney(form.advance_amount || '0') ?? 0;
}

/** Draft JSON (the server adds the schema version). */
export function toDraft(form, total) {
  return {
    ...form,
    party_id: form.party ? form.party.id : null,
    supplier_name: form.party ? form.party.name : '',
    total,
    lines: undefined,
    items: form.lines.map((l) => ({ ...l, info: undefined })),
  };
}

export function fromDraft(meta, data, supplier) {
  const base = emptyForm(meta, supplier);
  const { items = [], ...rest } = data;
  const form = { ...base };
  for (const k of Object.keys(base)) if (k in rest && k !== 'party') form[k] = rest[k];
  form.party = supplier;
  form.lines = items.map((l) => ({ ...l, uid: l.uid || uid() }));
  form.charges = (data.charges || []).map((c) => ({ ...c, uid: c.uid || uid() }));
  return form;
}

/** Edit: a saved purchase (purchases:get) back into the form. */
export function fromPurchase(meta, p, supplier) {
  return {
    ...emptyForm(meta, supplier),
    bill_no: p.bill_no || '',
    bill_date: p.bill_date,
    entry_date: p.entry_date,
    bill_type: p.bill_type,
    price_mode: p.price_mode,
    charges_mode: p.charges_mode,
    round_off: p.round_off === autoRoundOff(p) ? null : paiseToInput(p.round_off),
    printed_total: p.printed_total == null ? '' : paiseToInput(p.printed_total),
    notes: p.notes || '',
    lines: p.items.map((it) => ({
      uid: uid(),
      variant_id: it.variant_id,
      product_id: it.product_id,
      name: it.product_name,
      variant_label: it.variant_label || '',
      sku: it.sku,
      hsn_code: it.hsn_code || '',
      unit: it.unit,
      track_serials: Boolean(it.track_serials),
      qty: qtyToInput(it.qty_milli),
      free: it.free_qty_milli ? qtyToInput(it.free_qty_milli) : '',
      rate: paiseToInput(it.rate),
      disc:
        it.discount_bp != null
          ? bpToInput(it.discount_bp)
          : it.discount
            ? paiseToInput(it.discount)
            : '',
      disc_mode: it.discount_bp != null || !it.discount ? 'pct' : 'amt',
      gst_rate_bp: it.gst_rate_bp,
      serials: it.track_serials
        ? {
            entries: (it.serials || [])
              .filter((s) => s.status === 'in_stock' || s.status === 'defective')
              .map((s) => ({ serial_no: s.serial_no, serial_no_2: s.serial_no_2 || '' })),
            auto: null,
          }
        : null,
      update_purchase_price: false,
      price_update: false,
      new_mrp: paiseToInput(it.current.mrp),
      new_selling: paiseToInput(it.current.selling_price),
      mrp: it.current.mrp,
      selling_price: it.current.selling_price,
    })),
    charges: p.charges.map((c) => ({
      uid: uid(),
      kind: c.kind,
      label: c.label || '',
      amount: paiseToInput(c.amount),
      gst_rate_bp: c.gst_rate_bp,
    })),
  };
}

function autoRoundOff(p) {
  const raw = p.grand_total - p.round_off;
  const rounded = Math.floor((raw + 50) / 100) * 100;
  return rounded - raw;
}

/** Selling price for a margin % over cost: cost × (1 + m/100), to the paisa. */
export function priceForMargin(costPaise, marginBp) {
  return Math.floor((costPaise * (10000 + marginBp) + 5000) / 10000);
}

/** Margin (basis points) of `price` over `cost`. */
export function marginOf(costPaise, pricePaise) {
  if (!costPaise) return null;
  return Math.round(((pricePaise - costPaise) * 10000) / costPaise);
}
