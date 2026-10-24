import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import {
  AlertTriangle,
  Building2,
  Car,
  IndianRupee,
  MapPin,
  Plus,
  Settings2,
  StickyNote,
  Trash2,
  User,
} from 'lucide-react';
import Button from '../../components/Button';
import {
  Field,
  Input,
  MoneyInput,
  Segmented,
  Select,
  Textarea,
  Toggle,
} from '../../components/Field';
import PhoneInput from '../../components/PhoneInput';
import VehicleModelPicker from '../../components/VehicleModelPicker';
import { partiesApi, vehiclesApi } from '../../api/parties';
import {
  STATES,
  checkGstin,
  formatPlate,
  isPhone,
  normalizeGstin,
  normalizePhone,
  normalizePlate,
  stateName,
} from '../../utils/identity';
import { OPENING_TYPES, emptyVehicle } from './form';

export function Section({ icon: Icon, title, right, children }) {
  return (
    <section className="rounded-2xl border border-border bg-surface-2/40 p-4">
      <div className="mb-3 flex items-center gap-2">
        <Icon size={16} className="text-primary" />
        <h3 className="font-semibold">{title}</h3>
        <div className="ml-auto">{right}</div>
      </div>
      {children}
    </section>
  );
}

/** "Already exists: <name>" with an Open button (blocking) or a softer warning. */
export function ExistsNote({ owner, tone = 'danger', prefix = 'Already exists:', onOpen }) {
  if (!owner) return null;
  return (
    <motion.div
      initial={{ opacity: 0, y: -3 }}
      animate={{ opacity: 1, y: 0 }}
      className={`mt-1.5 flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs ${
        tone === 'danger' ? 'bg-danger-soft text-danger' : 'bg-warning-soft text-warning'
      }`}
    >
      <AlertTriangle size={13} className="shrink-0" />
      <span className="min-w-0 flex-1 truncate">
        {prefix} <strong>{owner.name}</strong>
        {owner.phone_display ? ` (${owner.phone_display})` : ''}
      </span>
      {onOpen && (
        <button type="button" className="font-semibold underline" onClick={() => onOpen(owner.id)}>
          Open
        </button>
      )}
    </motion.div>
  );
}

function useDebounced(value, ms = 300) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** Live checks: duplicate phone / alternate phone / GSTIN for this party type. */
const NO_DUPES = { phone: null, gstin: null, phone_alt: [], alt_phone: [] };

function useDuplicates(form) {
  const [result, setResult] = useState({ key: '', dupes: NO_DUPES });
  const phone = useDebounced(normalizePhone(form.phone));
  const alt = useDebounced(normalizePhone(form.alt_phone));
  const gstin = useDebounced(normalizeGstin(form.gstin));
  const key = JSON.stringify([phone, alt, gstin, form.type, form.id]);
  const active = isPhone(phone) || isPhone(alt) || gstin.length === 15;
  useEffect(() => {
    if (!active) return undefined;
    let cancelled = false;
    partiesApi
      .checkDuplicates({ type: form.type, id: form.id, phone, alt_phone: alt, gstin })
      .then((dupes) => !cancelled && setResult({ key, dupes }))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [active, key, phone, alt, gstin, form.type, form.id]);
  // Only results for what is typed now (never a stale "already exists").
  return active && result.key === key ? result.dupes : NO_DUPES;
}

/** One vehicle row of a new customer's form (saved with the customer). */
function NewVehicleRow({
  vehicle,
  index,
  models,
  errors,
  onChange,
  onRemove,
  onModelsChanged,
  onOpen,
}) {
  const [check, setCheck] = useState({ plate: '', owner: null });
  const plate = useDebounced(normalizePlate(vehicle.plate_no), 250);
  useEffect(() => {
    if (plate.length < 4) return undefined;
    let cancelled = false;
    vehiclesApi
      .check(plate)
      .then((r) => !cancelled && setCheck({ plate, owner: r.owner }))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [plate]);
  const owner = plate.length >= 4 && check.plate === plate ? check.owner : null;
  const err = (k) => errors[`vehicles.${index}.${k}`];
  return (
    <div className="grid grid-cols-[12rem_1fr_6rem_auto] items-start gap-2">
      <div>
        <Input
          value={vehicle.plate_no}
          placeholder="GJ 03 AB 1234"
          className="uppercase"
          invalid={Boolean(err('plate_no') || owner)}
          onChange={(e) => onChange({ ...vehicle, plate_no: e.target.value })}
          onBlur={() => {
            const k = normalizePlate(vehicle.plate_no);
            if (k) onChange({ ...vehicle, plate_no: formatPlate(k) });
          }}
        />
        {err('plate_no') && <p className="mt-1 text-xs text-danger">{err('plate_no')}</p>}
        {owner && (
          <ExistsNote
            owner={{
              id: owner.customer_id,
              name: owner.customer_name,
              phone_display: owner.phone_display,
            }}
            prefix="Belongs to"
            onOpen={onOpen}
          />
        )}
      </div>
      <VehicleModelPicker
        models={models}
        value={vehicle.vehicle_model_id}
        onChange={(v) => onChange({ ...vehicle, vehicle_model_id: v })}
        onCreated={onModelsChanged}
      />
      <Input
        value={vehicle.year}
        placeholder="Year"
        inputMode="numeric"
        maxLength={4}
        onChange={(e) => onChange({ ...vehicle, year: e.target.value.replace(/\D/g, '') })}
      />
      <Button size="icon" variant="danger-ghost" icon={Trash2} title="Remove" onClick={onRemove} />
    </div>
  );
}

/**
 * Customer / supplier fields. `form` is the string form (see form.js). New customers can add
 * vehicles here too (`vehicles` / `setVehicles`), saved in the same transaction.
 */
export default function PartyForm({
  form,
  setForm,
  errors,
  meta,
  onOpenParty,
  onManageTypes,
  onModelsChanged,
  vehicles,
  setVehicles,
}) {
  const customer = form.type === 'customer';
  const set = (key, value) => setForm((f) => ({ ...f, [key]: value }));
  const dupes = useDuplicates(form);
  const gst = checkGstin(normalizeGstin(form.gstin), form.state_code);
  const gstinLen = normalizeGstin(form.gstin).length;
  const stateChanged =
    form.id && form.gst_bill_count > 0 && form.state_code !== form.original_state_code;
  const business = !customer || form.is_business;
  const altWarn = [...dupes.alt_phone];
  const err = (k) => errors[k];

  function onGstinBlur() {
    const g = normalizeGstin(form.gstin);
    const check = checkGstin(g, '');
    setForm((f) => ({
      ...f,
      gstin: g,
      state_code:
        !f.state_code && check.valid && stateName(check.state_code)
          ? check.state_code
          : f.state_code,
    }));
  }

  return (
    <div className="space-y-4">
      <Section
        icon={customer ? User : Building2}
        title={customer ? 'Customer' : 'Supplier'}
        right={
          customer &&
          !form.is_system && (
            <Segmented
              layoutId="party-kind"
              value={form.is_business ? 'business' : 'person'}
              onChange={(v) => set('is_business', v === 'business')}
              options={[
                { value: 'person', label: 'Individual' },
                { value: 'business', label: 'Business' },
              ]}
            />
          )
        }
      >
        <div className="grid grid-cols-2 gap-3">
          <Field label={customer ? 'Name' : 'Firm name'} required error={err('name')}>
            {(id) => (
              <Input
                id={id}
                autoFocus
                value={form.name}
                invalid={Boolean(err('name'))}
                onChange={(e) => set('name', e.target.value)}
              />
            )}
          </Field>
          {customer ? (
            business && (
              <Field label="Firm name" error={err('firm_name')}>
                {(id) => (
                  <Input
                    id={id}
                    value={form.firm_name}
                    onChange={(e) => set('firm_name', e.target.value)}
                  />
                )}
              </Field>
            )
          ) : (
            <Field label="Contact person" error={err('contact_person')}>
              {(id) => (
                <Input
                  id={id}
                  value={form.contact_person}
                  onChange={(e) => set('contact_person', e.target.value)}
                />
              )}
            </Field>
          )}

          {!form.is_system && (
            <div>
              <Field
                label={customer ? 'Mobile' : 'Phone'}
                required={customer}
                error={err('phone')}
                hint={
                  !err('phone') && !dupes.phone
                    ? customer
                      ? 'Pick the country for numbers outside India'
                      : 'Mobile, or landline with STD code'
                    : null
                }
              >
                {(id) => (
                  <PhoneInput
                    id={id}
                    value={form.phone}
                    invalid={Boolean(err('phone') || dupes.phone)}
                    onChange={(v) => set('phone', v)}
                  />
                )}
              </Field>
              <ExistsNote owner={dupes.phone} onOpen={onOpenParty} />
              {!dupes.phone && dupes.phone_alt[0] && (
                <ExistsNote
                  owner={dupes.phone_alt[0]}
                  tone="warning"
                  prefix="Alternate number of"
                  onOpen={onOpenParty}
                />
              )}
            </div>
          )}
          {!form.is_system && (
            <div>
              <Field label="Alternate phone" error={err('alt_phone')}>
                {(id) => (
                  <PhoneInput
                    id={id}
                    value={form.alt_phone}
                    onChange={(v) => set('alt_phone', v)}
                  />
                )}
              </Field>
              {altWarn[0] && (
                <ExistsNote
                  owner={altWarn[0]}
                  tone="warning"
                  prefix="Also used by"
                  onOpen={onOpenParty}
                />
              )}
            </div>
          )}
          {customer && !form.is_system && (
            <label className="col-span-2 flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="h-4 w-4 accent-primary"
                checked={form.whatsapp_same}
                onChange={(e) => set('whatsapp_same', e.target.checked)}
              />
              WhatsApp on the same number
            </label>
          )}
          <Field label="Email" error={err('email')}>
            {(id) => (
              <Input
                id={id}
                type="email"
                value={form.email}
                onChange={(e) => set('email', e.target.value)}
              />
            )}
          </Field>
          {customer && !form.is_system && (
            <Field label="Customer type" error={err('customer_type_id')}>
              {(id) => (
                <div className="flex gap-2">
                  <Select
                    id={id}
                    value={form.customer_type_id}
                    onChange={(e) => set('customer_type_id', e.target.value)}
                  >
                    <option value="">—</option>
                    {meta.customer_types.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                        {t.default_discount_bp ? ` (${t.default_discount_bp / 100}% off)` : ''}
                      </option>
                    ))}
                  </Select>
                  <Button
                    size="icon"
                    icon={Settings2}
                    title="Edit the list of types"
                    onClick={onManageTypes}
                  />
                </div>
              )}
            </Field>
          )}
        </div>
      </Section>

      <Section icon={MapPin} title={business ? 'Address & GST' : 'Address'}>
        <div className="grid grid-cols-3 gap-3">
          <Field label="Address" className="col-span-3" error={err('address')}>
            {(id) => (
              <Input
                id={id}
                value={form.address}
                onChange={(e) => set('address', e.target.value)}
              />
            )}
          </Field>
          <Field label="City" error={err('city')}>
            {(id) => (
              <Input id={id} value={form.city} onChange={(e) => set('city', e.target.value)} />
            )}
          </Field>
          <Field
            label="State"
            error={err('state_code')}
            hint={!stateChanged ? 'Decides CGST+SGST or IGST' : null}
          >
            {(id) => (
              <Select
                id={id}
                value={form.state_code}
                onChange={(e) => set('state_code', e.target.value)}
              >
                <option value="">Same as shop</option>
                {STATES.map((s) => (
                  <option key={s.code} value={s.code}>
                    {s.code} · {s.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="PIN code" error={err('pincode')}>
            {(id) => (
              <Input
                id={id}
                inputMode="numeric"
                maxLength={6}
                value={form.pincode}
                onChange={(e) => set('pincode', e.target.value.replace(/\D/g, ''))}
              />
            )}
          </Field>
          {stateChanged && (
            <div className="col-span-3 flex items-center gap-2 rounded-lg bg-warning-soft px-3 py-2 text-xs text-warning">
              <AlertTriangle size={14} />
              {form.gst_bill_count} GST bill(s) exist. A new state only affects new bills; saved
              bills keep their GST split.
            </div>
          )}
          {business && (
            <div className="col-span-3">
              <Field label="GSTIN" error={err('gstin') || (gstinLen === 15 ? gst.error : null)}>
                {(id) => (
                  <Input
                    id={id}
                    value={form.gstin}
                    maxLength={15}
                    placeholder="24ABCDE1234F1Z5"
                    className="font-mono uppercase"
                    invalid={Boolean(err('gstin') || dupes.gstin || (gstinLen === 15 && gst.error))}
                    onChange={(e) => set('gstin', e.target.value.toUpperCase())}
                    onBlur={onGstinBlur}
                  />
                )}
              </Field>
              <ExistsNote owner={dupes.gstin} prefix="GSTIN used by" onOpen={onOpenParty} />
              {gstinLen === 15 &&
                gst.valid &&
                gst.warnings.map((w) => (
                  <p key={w} className="mt-1 flex items-center gap-1.5 text-xs text-warning">
                    <AlertTriangle size={12} /> {w}
                  </p>
                ))}
            </div>
          )}
        </div>
      </Section>

      {!form.is_system && (
        <Section
          icon={IndianRupee}
          title={customer ? 'Credit & opening balance' : 'Terms & opening balance'}
        >
          <div className="grid grid-cols-3 gap-3">
            {customer ? (
              <Field
                label="Credit limit"
                error={err('credit_limit')}
                hint="Billing warns above this"
              >
                {(id) => (
                  <MoneyInput
                    id={id}
                    value={form.credit_limit}
                    placeholder="No limit"
                    invalid={Boolean(err('credit_limit'))}
                    onChange={(e) => set('credit_limit', e.target.value)}
                  />
                )}
              </Field>
            ) : (
              <Field label="Payment terms (days)" error={err('payment_terms_days')}>
                {(id) => (
                  <Input
                    id={id}
                    inputMode="numeric"
                    value={form.payment_terms_days}
                    placeholder="e.g. 30"
                    onChange={(e) => set('payment_terms_days', e.target.value.replace(/\D/g, ''))}
                  />
                )}
              </Field>
            )}
            <Field label="Opening balance" error={err('opening_amount')}>
              {(id) => (
                <MoneyInput
                  id={id}
                  value={form.opening_amount}
                  placeholder="0"
                  invalid={Boolean(err('opening_amount'))}
                  onChange={(e) => set('opening_amount', e.target.value)}
                />
              )}
            </Field>
            <Field label="As of" error={err('opening_balance_date')}>
              {(id) => (
                <Input
                  id={id}
                  type="date"
                  value={form.opening_balance_date}
                  onChange={(e) => set('opening_balance_date', e.target.value)}
                />
              )}
            </Field>
            <Field label="Balance type" className="col-span-3" error={err('opening_type')}>
              {() => (
                <Segmented
                  layoutId={`opening-${form.type}`}
                  value={form.opening_type}
                  onChange={(v) => set('opening_type', v)}
                  options={OPENING_TYPES[form.type]}
                />
              )}
            </Field>
            {!customer && (
              <>
                <Field
                  label="Brands / categories supplied"
                  className="col-span-3"
                  error={err('supplies')}
                >
                  {(id) => (
                    <Input
                      id={id}
                      value={form.supplies}
                      placeholder="e.g. Blaupunkt, seat covers, floor mats"
                      onChange={(e) => set('supplies', e.target.value)}
                    />
                  )}
                </Field>
                <Field
                  label="Bank / UPI details (for your reference)"
                  className="col-span-3"
                  error={err('bank_details')}
                >
                  {(id) => (
                    <Textarea
                      id={id}
                      rows={2}
                      value={form.bank_details}
                      placeholder="A/c no., IFSC, UPI ID…"
                      onChange={(e) => set('bank_details', e.target.value)}
                    />
                  )}
                </Field>
              </>
            )}
          </div>
        </Section>
      )}

      {customer && !form.id && setVehicles && (
        <Section
          icon={Car}
          title="Vehicles"
          right={
            <Button
              size="sm"
              icon={Plus}
              onClick={() =>
                setVehicles((list) => [...list, { ...emptyVehicle(), key: crypto.randomUUID() }])
              }
            >
              Add vehicle
            </Button>
          }
        >
          {vehicles.length === 0 ? (
            <p className="text-sm text-muted">Optional. You can add vehicles later too.</p>
          ) : (
            <div className="space-y-2">
              {vehicles.map((v, i) => (
                <NewVehicleRow
                  key={v.key}
                  vehicle={v}
                  index={i}
                  models={meta.vehicle_models}
                  errors={errors}
                  onModelsChanged={onModelsChanged}
                  onOpen={onOpenParty}
                  onChange={(next) =>
                    setVehicles((list) => list.map((x, j) => (j === i ? next : x)))
                  }
                  onRemove={() => setVehicles((list) => list.filter((_, j) => j !== i))}
                />
              ))}
            </div>
          )}
        </Section>
      )}

      <Section icon={StickyNote} title="Notes">
        <Textarea value={form.notes} onChange={(e) => set('notes', e.target.value)} rows={2} />
        {!form.is_system && (
          <div className="mt-3">
            <Toggle
              label="Active"
              description="Inactive records are hidden from billing and lists, but keep their history."
              checked={form.is_active}
              onChange={(v) => set('is_active', v)}
            />
          </div>
        )}
      </Section>
    </div>
  );
}
