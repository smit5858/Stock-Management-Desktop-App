import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Car, Phone, Search, UserPlus, X } from 'lucide-react';
import Button from './Button';
import { Field, Input } from './Field';
import PhoneInput from './PhoneInput';
import { Badge, Kbd } from './Feedback';
import VehicleModelPicker from './VehicleModelPicker';
import { useToast } from './Toast';
import { partiesApi, vehiclesApi } from '../api/parties';
import { formatMoney } from '../utils/money';
import { formatPlate, isMobile, normalizePhone, normalizePlate } from '../utils/identity';

/** Guess what was typed: a phone number, a number plate or a name. */
function guess(query) {
  const q = query.trim();
  if (/^[\d\s+\-()]+$/.test(q) && normalizePhone(q).length >= 5) return { phone: q };
  const plate = normalizePlate(q);
  if (/[A-Z]/.test(plate) && /\d/.test(plate) && plate.length >= 4) return { plate_no: q };
  return { name: q };
}

function useDebounced(value, ms = 200) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** Inline "new customer": name, phone, optional plate + model. Saved in one transaction. */
function QuickAdd({ initial, models, onModelsChanged, onDone, onCancel, onPickExisting }) {
  const toast = useToast();
  const [form, setForm] = useState({
    name: initial.name || '',
    phone: initial.phone || '',
    plate_no: initial.plate_no || '',
    vehicle_model_id: '',
  });
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const [phoneCheck, setPhoneCheck] = useState({ key: '', owner: null });
  const [plateCheck, setPlateCheck] = useState({ key: '', owner: null });
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const phone = normalizePhone(useDebounced(form.phone, 250));
  const plate = normalizePlate(useDebounced(form.plate_no, 250));

  useEffect(() => {
    if (!isMobile(phone)) return undefined;
    let cancelled = false;
    partiesApi
      .checkDuplicates({ type: 'customer', phone })
      .then((r) => !cancelled && setPhoneCheck({ key: phone, owner: r.phone }))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [phone]);

  useEffect(() => {
    if (plate.length < 4) return undefined;
    let cancelled = false;
    vehiclesApi
      .check(plate)
      .then((r) => !cancelled && setPlateCheck({ key: plate, owner: r.owner }))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [plate]);
  // Only results for what is typed now.
  const dupe = {
    phone: isMobile(phone) && phoneCheck.key === phone ? phoneCheck.owner : null,
    plate: plate.length >= 4 && plateCheck.key === plate ? plateCheck.owner : null,
  };

  async function save() {
    setBusy(true);
    try {
      const r = await partiesApi.quickAdd({
        ...form,
        vehicle_model_id: form.vehicle_model_id || null,
      });
      for (const w of r.warnings || []) toast.info(w);
      toast.success(`Customer "${r.customer.name}" added.`);
      onDone(r.customer);
    } catch (e) {
      setErrors(e.fields || {});
      toast.error(e);
    } finally {
      setBusy(false);
    }
  }

  const existing = dupe.phone || dupe.plate;
  return (
    <motion.div
      initial={{ opacity: 0, y: -4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.15 }}
      className="space-y-3 rounded-xl border border-primary/40 bg-primary-soft/30 p-3"
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          save();
        }
      }}
    >
      <div className="flex items-center gap-2 text-sm font-semibold">
        <UserPlus size={15} className="text-primary" /> New customer
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Name" required error={errors.name}>
          {(id) => (
            <Input
              id={id}
              autoFocus={!initial.name}
              value={form.name}
              invalid={Boolean(errors.name)}
              onChange={(e) => set('name', e.target.value)}
            />
          )}
        </Field>
        <Field label="Mobile" required error={errors.phone}>
          {(id) => (
            <PhoneInput
              id={id}
              value={form.phone}
              invalid={Boolean(errors.phone || dupe.phone)}
              onChange={(v) => set('phone', v)}
            />
          )}
        </Field>
        <Field label="Vehicle number" error={errors.plate_no}>
          {(id) => (
            <Input
              id={id}
              value={form.plate_no}
              placeholder="GJ 03 AB 1234"
              className="uppercase"
              invalid={Boolean(errors.plate_no || dupe.plate)}
              onChange={(e) => set('plate_no', e.target.value)}
              onBlur={() => {
                const k = normalizePlate(form.plate_no);
                if (k) set('plate_no', formatPlate(k));
              }}
            />
          )}
        </Field>
        <Field label="Make / model">
          {() => (
            <VehicleModelPicker
              models={models}
              value={form.vehicle_model_id}
              onChange={(v) => set('vehicle_model_id', v)}
              onCreated={onModelsChanged}
            />
          )}
        </Field>
      </div>
      {existing && (
        <div className="flex items-center gap-2 rounded-lg bg-warning-soft px-3 py-2 text-sm text-warning">
          <span className="flex-1">
            Already exists: <strong>{existing.name || existing.customer_name}</strong>
            {dupe.plate &&
              !dupe.phone &&
              ` (owner of ${formatPlate(normalizePlate(form.plate_no))})`}
          </span>
          <Button
            size="sm"
            onClick={() => onPickExisting(dupe.phone ? dupe.phone.id : dupe.plate.customer_id)}
          >
            Select
          </Button>
        </div>
      )}
      <div className="flex justify-end gap-2">
        <Button size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" variant="primary" disabled={busy} onClick={save}>
          {busy ? 'Saving…' : 'Add customer'} <Kbd>Enter</Kbd>
        </Button>
      </div>
    </motion.div>
  );
}

/**
 * Find a customer (or supplier) by phone, plate or name. Typing a full plate selects that
 * customer AND that vehicle. Not found → inline quick-add (customers).
 * `value`: { customer, vehicle } | null. `onChange(value)`.
 */
export default function CustomerPicker({
  value,
  onChange,
  type = 'customer',
  excludeId = null,
  autoFocus = false,
  allowQuickAdd = type === 'customer',
  placeholder,
  vehicleModels,
}) {
  const toast = useToast();
  const [query, setQuery] = useState('');
  const [found, setFound] = useState({ q: '', rows: [] });
  const [index, setIndex] = useState(0);
  const [focused, setFocused] = useState(false);
  const [adding, setAdding] = useState(null);
  const [models, setModels] = useState(vehicleModels || null);
  const inputRef = useRef(null);
  const q = query.trim();
  const debounced = useDebounced(q, 150);

  useEffect(() => {
    if (debounced.length < 2) return undefined;
    let cancelled = false;
    partiesApi
      .search(debounced, { type, limit: 8 })
      .then((rows) => !cancelled && setFound({ q: debounced, rows }))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [debounced, type]);

  const rows = (found.q === q && q.length >= 2 ? found.rows : []).filter((r) => r.id !== excludeId);
  const options = [
    ...rows.map((r) => ({ kind: 'row', row: r })),
    ...(allowQuickAdd && q.length >= 2 ? [{ kind: 'add' }] : []),
  ];
  const active = Math.max(0, Math.min(index, options.length - 1));
  const open = focused && !value && !adding && q.length >= 2;

  async function loadModels() {
    try {
      const m = await partiesApi.meta();
      setModels(m.vehicle_models);
    } catch (e) {
      toast.error(e);
    }
  }

  function startAdd() {
    setAdding(guess(q));
    if (!models) loadModels();
  }

  function pick(option) {
    if (!option) return;
    if (option.kind === 'add') {
      startAdd();
      return;
    }
    onChange({ customer: option.row, vehicle: option.row.matched_vehicle || null });
    setQuery('');
  }

  async function pickId(customerId) {
    try {
      const row = await partiesApi.summary(customerId);
      setAdding(null);
      onChange({ customer: row, vehicle: null });
      setQuery('');
    } catch (e) {
      toast.error(e);
    }
  }

  function onKeyDown(e) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setIndex(Math.min(active + 1, options.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setIndex(Math.max(active - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      pick(options[active]);
    }
  }

  if (value?.customer) {
    const c = value.customer;
    return (
      <div className="flex items-center gap-3 rounded-xl border border-border bg-surface-2/50 px-3 py-2">
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium">{c.name}</div>
          <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted">
            {c.phone_display && (
              <span className="flex items-center gap-1">
                <Phone size={12} /> {c.phone_display}
              </span>
            )}
            {value.vehicle && (
              <Badge tone="primary">
                <Car size={12} /> {value.vehicle.display}
                {value.vehicle.model ? ` · ${value.vehicle.model}` : ''}
              </Badge>
            )}
          </div>
        </div>
        <Button
          size="icon-sm"
          variant="ghost"
          icon={X}
          title="Change"
          onClick={() => {
            onChange(null);
            setTimeout(() => inputRef.current?.focus(), 0);
          }}
        />
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="relative">
        <Search
          size={16}
          className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted"
        />
        <Input
          ref={inputRef}
          autoFocus={autoFocus}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setIndex(0);
            setAdding(null);
          }}
          onFocus={() => setFocused(true)}
          onBlur={() => setTimeout(() => setFocused(false), 150)}
          onKeyDown={onKeyDown}
          placeholder={
            placeholder ||
            (type === 'customer'
              ? 'Phone, vehicle number or name…'
              : 'Firm, contact, phone or GSTIN…')
          }
          className="pl-9"
        />
        <AnimatePresence>
          {open && (
            <motion.ul
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.12 }}
              className="absolute top-full right-0 left-0 z-30 mt-1 max-h-80 overflow-auto rounded-xl border border-border bg-surface p-1 shadow-xl"
            >
              {options.length === 0 && <li className="px-3 py-3 text-sm text-muted">No match</li>}
              {options.map((o, i) => (
                <li key={o.kind === 'row' ? o.row.id : 'add'}>
                  <button
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onMouseEnter={() => setIndex(i)}
                    onClick={() => pick(o)}
                    className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left ${
                      i === active ? 'bg-primary-soft' : ''
                    }`}
                  >
                    {o.kind === 'add' ? (
                      <span className="flex items-center gap-2 font-medium text-primary">
                        <UserPlus size={16} /> New customer “{q}”
                      </span>
                    ) : (
                      <>
                        <div className="min-w-0 flex-1">
                          <div className="truncate font-medium">
                            {o.row.name}
                            {o.row.firm_name && o.row.firm_name !== o.row.name && (
                              <span className="font-normal text-muted"> · {o.row.firm_name}</span>
                            )}
                          </div>
                          <div className="flex flex-wrap items-center gap-1 text-xs text-muted">
                            {o.row.phone_display || 'No phone'}
                            {o.row.plates.slice(0, 3).map((p) => (
                              <Badge
                                key={p.plate_no}
                                tone={
                                  o.row.matched_vehicle?.plate_no === p.plate_no
                                    ? 'primary'
                                    : 'neutral'
                                }
                              >
                                {p.display}
                              </Badge>
                            ))}
                          </div>
                        </div>
                        {o.row.balance > 0 && type === 'customer' && (
                          <Badge tone="warning">Pending {formatMoney(o.row.balance)}</Badge>
                        )}
                      </>
                    )}
                  </button>
                </li>
              ))}
            </motion.ul>
          )}
        </AnimatePresence>
      </div>
      {adding && (
        <QuickAdd
          key={JSON.stringify(adding)}
          initial={adding}
          models={models || []}
          onModelsChanged={loadModels}
          onCancel={() => setAdding(null)}
          onPickExisting={pickId}
          onDone={(customer) => {
            setAdding(null);
            setQuery('');
            onChange({ customer, vehicle: customer.matched_vehicle || null });
          }}
        />
      )}
    </div>
  );
}
