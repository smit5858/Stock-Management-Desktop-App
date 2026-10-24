// Billing form: state shape of one bill tab, default rates, parsing to integers (paise / milli /
// basis points) and conversion to the save payload and the held-bill JSON. No floats anywhere.
import { paiseToInput, parseMoney } from '../../utils/money';
import { parseQty } from '../../utils/qty';
import { todayISO } from '../../utils/dates';
import { bpToInput, parseBp, qtyToInput, uid } from '../purchases/entryForm';

export { bpToInput, parseBp, qtyToInput, uid };

export const MAX_TABS = 5;

export function addDays(iso, days) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

export function emptyForm(meta, kind = 'bill') {
  return {
    key: uid(),
    kind, // bill | quotation
    draft_id: null,
    quotation_id: null,
    reissue_of_id: null,
    claim_id: null, // chargeable warranty repair billed from its claim
    exchange: null, // { sale_return (payload), credit, label, party }
    party: null, // { customer, vehicle } from CustomerPicker; null = Cash Customer
    customer_name: '', // typed name / phone for Cash Customer (printed only)
    customer_phone: '',
    vehicle_id: null,
    date: todayISO(),
    valid_till: addDays(todayISO(), meta.quotation_valid_days || 7),
    bill_type: meta.default_bill_type,
    price_mode: meta.default_price_mode,
    lines: [],
    bill_disc: '',
    bill_disc_mode: 'pct',
    round_off: null, // null = automatic; string when typed
    notes: '',
    // `auto` rows follow the amount still to pay until the cashier types an amount.
    payments: [{ uid: uid(), mode: 'cash', amount: '', ref_no: '', auto: true }],
    tendered: '',
    use_advance: false,
    advance_amount: '',
    due_date: '',
    saved: null, // { kind, id, number, total, change } after saving
  };
}

/**
 * Rate for a product row in this bill: the selling price is stored incl. or excl. GST
 * (products.price_includes_gst). GST bills use the bill's price mode; non-GST bills charge the
 * GST-inclusive price.
 */
export function rateFor(row, form) {
  const sp = row.selling_price || 0;
  const bp = row.gst_rate_bp || 0;
  const incl = row.price_includes_gst !== false && row.price_includes_gst !== 0;
  const inclusive = incl ? sp : sp + Math.floor((sp * bp + 5000) / 10000);
  const exclusive = incl ? Math.floor((sp * 20000 + 10000 + bp) / (2 * (10000 + bp))) : sp;
  if (form.bill_type !== 'gst' || form.price_mode === 'inclusive') return inclusive;
  return exclusive;
}

/** A line from a sales:searchItems row. `discountBp` = customer type's default discount. */
export function lineFromRow(row, form, { discountBp = 0, gstRates = [] } = {}) {
  const service = row.product_type === 'service';
  let gst = row.gst_rate_bp ?? 0;
  if (gst !== 0 && gstRates.length && !gstRates.includes(gst)) gst = gstRates[0];
  return {
    uid: uid(),
    variant_id: row.variant_id,
    product_id: row.product_id,
    item_type: service ? 'service' : 'goods',
    name: row.name,
    variant_label: row.variant_label || '',
    sku: row.sku,
    hsn_code: row.hsn_code || '',
    unit: row.unit,
    track_serials: Boolean(row.track_serials) && !service,
    qty: '1',
    rate: paiseToInput(rateFor(row, form)),
    disc: !service && discountBp ? bpToInput(discountBp) : '',
    disc_mode: 'pct',
    gst_rate_bp: gst,
    mrp: row.mrp || 0,
    avg_cost: row.avg_cost || row.purchase_price || 0,
    stock_milli: row.stock_milli ?? 0,
    warranty_months: service ? 0 : (row.customer_warranty_months ?? 0),
    serials: [],
    fits: Boolean(row.fits),
    fitting_for: null, // uid of the product line this fitting belongs to
    fitting_merged: false,
    fitted_by: '',
    fitting_template: row.fitting || null, // to re-add the fitting line ("Fitting ✓")
  };
}

/** The linked fitting line for a product line. */
export function fittingLine(parent, fitting, form) {
  const line = {
    ...lineFromRow(
      {
        ...fitting,
        product_type: 'service',
        sku: '',
        track_serials: 0,
      },
      form,
    ),
    fitting_for: parent.uid,
  };
  // Re-adding a fitting the cashier removed keeps the amount typed before.
  if (fitting.rate_input != null) line.rate = fitting.rate_input;
  if (fitting.fitted_by) line.fitted_by = fitting.fitted_by;
  return line;
}

export function parseLine(l) {
  const errors = {};
  const qty = parseQty(l.qty);
  const rate = parseMoney(l.rate === '' ? '0' : l.rate);
  let discountBp = null;
  let discount = 0;
  if (l.disc !== '') {
    if (l.disc_mode === 'pct') {
      discountBp = parseBp(l.disc);
      if (discountBp === null) errors.disc = 'Invalid';
    } else {
      discount = parseMoney(l.disc);
      if (discount === null || discount < 0) errors.disc = 'Invalid';
    }
  }
  if (qty === null || qty <= 0) errors.qty = 'Qty';
  if (rate === null || rate < 0) errors.rate = 'Rate';
  return {
    errors,
    values: {
      variant_id: l.variant_id,
      item_type: l.item_type,
      qty_milli: qty ?? 0,
      rate: rate ?? 0,
      discount_bp: discountBp,
      discount: discount ?? 0,
      gst_rate_bp: l.gst_rate_bp,
    },
  };
}

export function billDiscount(form) {
  if (form.bill_disc === '') return { bill_discount_bp: null, bill_discount: 0 };
  if (form.bill_disc_mode === 'pct')
    return { bill_discount_bp: parseBp(form.bill_disc), bill_discount: 0 };
  return { bill_discount_bp: null, bill_discount: parseMoney(form.bill_disc) ?? 0 };
}

export function roundOffValue(form) {
  if (form.round_off == null) return null;
  return parseMoney(form.round_off);
}

export function partyId(form, meta) {
  return form.party?.customer?.id ?? meta.cash_customer_id;
}

/** Payload for sales:calculate (bad numbers count as 0). */
export function calcPayload(form, meta) {
  return {
    party_id: partyId(form, meta),
    bill_type: form.bill_type,
    price_mode: form.price_mode,
    round_off: roundOffValue(form),
    ...billDiscount(form),
    items: form.lines.map((l) => parseLine(l).values),
  };
}

/**
 * Fills `auto` payment rows with what is still payable (grand total − advance − exchange
 * credit − typed rows). Returns the payment rows with their effective amounts (strings).
 */
export function resolvePayments(form, payable) {
  const typed = form.payments
    .filter((p) => !p.auto && p.amount !== '')
    .reduce((s, p) => s + (parseMoney(p.amount) ?? 0), 0);
  let left = Math.max(payable - typed, 0);
  return form.payments.map((p) => {
    if (!p.auto) return p;
    const amount = left;
    left = 0;
    return { ...p, amount: amount > 0 ? paiseToInput(amount) : '' };
  });
}

export function paymentRows(form) {
  return form.payments
    .filter((p) => p.amount !== '')
    .map((p) => ({ mode: p.mode, amount: parseMoney(p.amount), ref_no: p.ref_no }));
}

export function advanceValue(form) {
  return form.use_advance ? (parseMoney(form.advance_amount || '0') ?? 0) : 0;
}

/** Save payload + client-side errors keyed like the server's ('items.0.qty_milli'). */
export function toPayload(form, meta) {
  const errors = {};
  if (form.lines.length === 0) errors.items = 'Add at least one item.';
  const index = new Map(form.lines.map((l, i) => [l.uid, i]));
  const items = form.lines.map((l, i) => {
    const { values, errors: e } = parseLine(l);
    for (const [k, msg] of Object.entries(e)) {
      errors[`items.${i}.${k === 'qty' ? 'qty_milli' : k === 'disc' ? 'discount' : k}`] = msg;
    }
    const out = {
      ...values,
      warranty_months: Number(l.warranty_months) || 0,
      fitting_for: l.fitting_for ? (index.get(l.fitting_for) ?? null) : null,
      fitting_merged: l.fitting_merged,
      fitted_by: l.fitted_by,
    };
    if (l.track_serials) out.serial_ids = l.serials.map((s) => s.id);
    return out;
  });
  const disc = billDiscount(form);
  if (form.bill_disc !== '' && disc.bill_discount_bp === null && form.bill_disc_mode === 'pct')
    errors.bill_discount = 'Invalid';
  if (form.round_off != null && roundOffValue(form) === null) errors.round_off = 'Invalid';
  const pays = form.kind === 'bill' ? paymentRows(form) : [];
  pays.forEach((p, i) => {
    if (p.amount === null || p.amount <= 0) errors[`payments.${i}.amount`] = 'Invalid amount';
  });
  return {
    errors,
    payload: {
      party_id: partyId(form, meta),
      customer_name: form.party ? '' : form.customer_name,
      customer_phone: form.party ? '' : form.customer_phone,
      vehicle_id: form.vehicle_id,
      date: form.date,
      valid_till: form.kind === 'quotation' ? form.valid_till : undefined,
      bill_type: form.bill_type,
      price_mode: form.price_mode,
      round_off: roundOffValue(form),
      ...disc,
      notes: form.notes,
      items,
      payments: pays,
      advance_amount: form.kind === 'bill' ? advanceValue(form) : 0,
      due_date: form.due_date || null,
      draft_id: form.draft_id,
      quotation_id: form.quotation_id,
      reissue_of_id: form.reissue_of_id,
      claim_id: form.claim_id || undefined,
    },
  };
}

/** Held-bill JSON (the server adds the schema version). */
export function toDraft(form, total) {
  const { saved: _saved, exchange: _exchange, ...rest } = form;
  void _saved;
  void _exchange;
  return {
    ...rest,
    party_id: form.party?.customer?.id ?? null,
    customer_name: form.party?.customer?.name || form.customer_name || 'Cash Customer',
    vehicle_no: form.party?.vehicle?.display || '',
    total,
    items: form.lines.map((l) => ({ ...l, qty_milli: parseQty(l.qty) ?? 0 })),
    lines: undefined,
  };
}

export function fromDraft(meta, data, party) {
  const base = emptyForm(meta, data.kind === 'quotation' ? 'quotation' : 'bill');
  const form = { ...base };
  for (const k of Object.keys(base)) {
    if (k in data && !['party', 'key', 'saved', 'exchange', 'lines'].includes(k)) form[k] = data[k];
  }
  form.party = party;
  form.lines = (data.items || []).map((l) => ({ ...l, uid: l.uid || uid() }));
  if (!Array.isArray(form.payments) || form.payments.length === 0) form.payments = base.payments;
  return form;
}

/** From sales:prefill (re-issue a cancelled bill / convert a quotation). */
export function fromPrefill(meta, pre, party) {
  const form = emptyForm(meta, 'bill');
  form.party = party;
  form.vehicle_id = pre.vehicle_id;
  form.bill_type = meta.composition_dealer ? 'non_gst' : pre.bill_type;
  form.price_mode = pre.price_mode;
  form.notes = pre.notes || '';
  if (pre.bill_discount_bp != null) {
    form.bill_disc = bpToInput(pre.bill_discount_bp);
    form.bill_disc_mode = 'pct';
  } else if (pre.bill_discount) {
    form.bill_disc = paiseToInput(pre.bill_discount);
    form.bill_disc_mode = 'amt';
  }
  if (!party) form.customer_name = pre.customer_name === 'Cash Customer' ? '' : pre.customer_name;
  const uids = pre.lines.map(() => uid());
  form.lines = pre.lines.map((l, i) => ({
    uid: uids[i],
    variant_id: l.variant_id,
    product_id: l.product_id,
    item_type: l.item_type,
    name: l.name,
    variant_label: l.variant_label,
    sku: l.sku,
    hsn_code: l.hsn_code,
    unit: l.unit,
    track_serials: l.track_serials,
    qty: qtyToInput(l.track_serials ? Math.max(l.serials.length, 1) * 1000 : l.qty_milli),
    rate: paiseToInput(l.rate),
    disc:
      l.discount_bp != null ? bpToInput(l.discount_bp) : l.discount ? paiseToInput(l.discount) : '',
    disc_mode: l.discount_bp != null || !l.discount ? 'pct' : 'amt',
    gst_rate_bp: l.gst_rate_bp,
    mrp: l.mrp,
    avg_cost: l.avg_cost,
    stock_milli: l.stock_milli,
    warranty_months: l.warranty_months,
    serials: l.serials,
    fits: false,
    fitting_for: l.fitting_for != null ? uids[l.fitting_for] : null,
    fitting_merged: l.fitting_merged,
    fitted_by: l.fitted_by,
    fitting_template: null,
  }));
  return form;
}

/** Issues per line uid from a { index: [messages] } map. */
export function issuesByUid(form, byIndex) {
  const out = {};
  Object.entries(byIndex || {}).forEach(([i, msgs]) => {
    const l = form.lines[Number(i)];
    if (l && msgs.length) out[l.uid] = msgs;
  });
  return out;
}

// Open bill tabs survive leaving the billing screen (until the app is closed; use Hold to keep
// a bill across restarts).
let store = null;
export const tabStore = {
  get: () => store,
  set: (next) => {
    store = next;
  },
};
