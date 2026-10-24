// Converts between the API party shape (integers, normalised phones) and the form (strings).
import { paiseToInput, parseMoney } from '../../utils/money';
import { todayISO } from '../../utils/dates';

export const FUELS = [
  { value: 'petrol', label: 'Petrol' },
  { value: 'diesel', label: 'Diesel' },
  { value: 'cng', label: 'CNG' },
  { value: 'ev', label: 'EV' },
  { value: 'hybrid', label: 'Hybrid' },
];

export const OPENING_TYPES = {
  customer: [
    { value: 'receivable', label: 'Receivable (customer owes us)' },
    { value: 'advance', label: 'Advance from customer' },
  ],
  supplier: [
    { value: 'payable', label: 'Payable (we owe supplier)' },
    { value: 'advance', label: 'Advance paid to supplier' },
  ],
};

export function emptyForm(type) {
  return {
    id: null,
    type,
    is_system: 0,
    name: '',
    phone: '',
    alt_phone: '',
    whatsapp_same: true,
    email: '',
    firm_name: '',
    contact_person: '',
    is_business: false,
    address: '',
    city: '',
    state_code: '',
    pincode: '',
    gstin: '',
    customer_type_id: '',
    credit_limit: '',
    payment_terms_days: '',
    supplies: '',
    bank_details: '',
    opening_amount: '',
    opening_type: type === 'supplier' ? 'payable' : 'receivable',
    opening_balance_date: todayISO(),
    notes: '',
    is_active: true,
    gst_bill_count: 0,
    original_state_code: '',
  };
}

export function toForm(p) {
  return {
    ...emptyForm(p.type),
    id: p.id,
    is_system: p.is_system,
    name: p.name || '',
    phone: p.phone || '', // stored form; PhoneInput formats it
    alt_phone: p.alt_phone || '',
    whatsapp_same: Boolean(p.whatsapp_same),
    email: p.email || '',
    firm_name: p.firm_name || '',
    contact_person: p.contact_person || '',
    is_business: Boolean(p.firm_name || p.gstin),
    address: p.address || '',
    city: p.city || '',
    state_code: p.state_code || '',
    pincode: p.pincode || '',
    gstin: p.gstin || '',
    customer_type_id: p.customer_type_id ? String(p.customer_type_id) : '',
    credit_limit: p.credit_limit == null ? '' : paiseToInput(p.credit_limit),
    payment_terms_days: p.payment_terms_days == null ? '' : String(p.payment_terms_days),
    supplies: p.supplies || '',
    bank_details: p.bank_details || '',
    opening_amount: p.opening_amount ? paiseToInput(p.opening_amount) : '',
    opening_type: p.opening_type,
    opening_balance_date: p.opening_balance_date || todayISO(),
    notes: p.notes || '',
    is_active: Boolean(p.is_active),
    gst_bill_count: p.gst_bill_count || 0,
    original_state_code: p.state_code || '',
  };
}

/** Returns { payload, errors } (field keys as the server uses them). */
export function toPayload(form) {
  const errors = {};
  const money = (value, key) => {
    if (value === '' || value == null) return null;
    const v = parseMoney(value);
    if (v === null || v < 0) errors[key] = 'Invalid amount.';
    return v;
  };
  if (!form.name.trim()) errors.name = 'Required.';
  const business = form.type === 'customer' ? form.is_business : true;
  const payload = {
    name: form.name.trim(),
    phone: form.phone,
    alt_phone: form.alt_phone,
    whatsapp_same: form.whatsapp_same,
    email: form.email.trim(),
    firm_name: business ? form.firm_name.trim() : '',
    contact_person: form.contact_person.trim(),
    address: form.address.trim(),
    city: form.city.trim(),
    state_code: form.state_code,
    pincode: form.pincode.trim(),
    gstin: business ? form.gstin.trim() : '',
    customer_type_id: form.customer_type_id ? Number(form.customer_type_id) : null,
    credit_limit: money(form.credit_limit, 'credit_limit'),
    payment_terms_days: form.payment_terms_days === '' ? null : Number(form.payment_terms_days),
    supplies: form.supplies.trim(),
    bank_details: form.bank_details.trim(),
    opening_amount: money(form.opening_amount, 'opening_amount') ?? 0,
    opening_type: form.opening_type,
    opening_balance_date: form.opening_balance_date,
    notes: form.notes.trim(),
    is_active: form.is_active,
  };
  return { payload, errors };
}

export function emptyVehicle() {
  return {
    id: null,
    plate_no: '',
    make: '',
    vehicle_model_id: '',
    variant: '',
    year: '',
    fuel: '',
    color: '',
    notes: '',
    is_primary: false,
  };
}

export function vehicleToForm(v) {
  return {
    id: v.id,
    plate_no: v.plate_display || v.plate_no,
    make: v.make || '',
    vehicle_model_id: v.vehicle_model_id ? String(v.vehicle_model_id) : '',
    variant: v.variant || '',
    year: v.year ? String(v.year) : '',
    fuel: v.fuel || '',
    color: v.color || '',
    notes: v.notes || '',
    is_primary: Boolean(v.is_primary),
  };
}

export function vehiclePayload(f) {
  return {
    plate_no: f.plate_no,
    vehicle_model_id: f.vehicle_model_id ? Number(f.vehicle_model_id) : null,
    variant: f.variant.trim(),
    year: f.year ? Number(f.year) : null,
    fuel: f.fuel || null,
    color: f.color.trim(),
    notes: f.notes.trim(),
    is_primary: f.is_primary,
  };
}

/** Balance meaning per party type: tone + label. */
export function balanceInfo(type, balance) {
  if (!balance) return { tone: 'neutral', label: 'Settled', amount: 0 };
  const amount = Math.abs(balance);
  if (type === 'supplier') {
    return balance < 0
      ? { tone: 'danger', label: 'Payable', amount }
      : { tone: 'success', label: 'Advance', amount };
  }
  return balance > 0
    ? { tone: 'warning', label: 'Pending', amount }
    : { tone: 'success', label: 'Advance', amount };
}
