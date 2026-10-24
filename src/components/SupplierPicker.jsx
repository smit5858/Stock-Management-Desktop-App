import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Building2, Phone, Plus, Search, X } from 'lucide-react';
import Button from './Button';
import { Field, Input, Select } from './Field';
import PhoneInput from './PhoneInput';
import { Badge, Kbd } from './Feedback';
import { useToast } from './Toast';
import { partiesApi } from '../api/parties';
import { formatMoney } from '../utils/money';
import { STATES, normalizeGstin, normalizePhone, stateName } from '../utils/identity';

function useDebounced(value, ms = 150) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** What was typed decides the first field of the quick-add form. */
function guess(q) {
  const t = q.trim();
  if (/^\d{2}[A-Za-z]{5}/.test(t)) return { gstin: t.toUpperCase() };
  if (/^[\d\s+\-()]+$/.test(t) && normalizePhone(t).length >= 5) return { phone: t };
  return { name: t };
}

/** Inline "new supplier": firm, phone, GSTIN, state. The state comes from the GSTIN if empty. */
function QuickAdd({ initial, onDone, onCancel }) {
  const toast = useToast();
  const [form, setForm] = useState({
    name: initial.name || '',
    phone: initial.phone || '',
    gstin: initial.gstin || '',
    state_code: initial.gstin ? initial.gstin.slice(0, 2) : '',
    payment_terms_days: '',
  });
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  async function save() {
    setBusy(true);
    try {
      const terms = form.payment_terms_days.trim();
      const r = await partiesApi.create('supplier', {
        name: form.name,
        phone: form.phone,
        gstin: normalizeGstin(form.gstin),
        state_code: form.state_code,
        payment_terms_days: terms === '' ? null : Number(terms),
      });
      for (const w of r.warnings || []) toast.info(w);
      toast.success(`Supplier "${r.name}" added.`);
      onDone(await partiesApi.summary(r.id));
    } catch (e) {
      setErrors(e.fields || {});
      toast.error(e);
    } finally {
      setBusy(false);
    }
  }

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
        } else if (e.key === 'Escape') {
          e.stopPropagation();
          onCancel();
        }
      }}
    >
      <div className="flex items-center gap-2 text-sm font-semibold">
        <Building2 size={15} className="text-primary" /> New supplier
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Firm name" required error={errors.name}>
          {(id) => (
            <Input
              id={id}
              autoFocus
              value={form.name}
              invalid={Boolean(errors.name)}
              onChange={(e) => set('name', e.target.value)}
            />
          )}
        </Field>
        <Field label="Phone" error={errors.phone}>
          {(id) => (
            <PhoneInput
              id={id}
              value={form.phone}
              invalid={Boolean(errors.phone)}
              onChange={(v) => set('phone', v)}
            />
          )}
        </Field>
        <Field label="GSTIN" error={errors.gstin}>
          {(id) => (
            <Input
              id={id}
              value={form.gstin}
              maxLength={15}
              className="font-mono uppercase"
              invalid={Boolean(errors.gstin)}
              onChange={(e) => {
                const g = e.target.value.toUpperCase();
                set('gstin', g);
                if (/^\d{2}/.test(g) && !form.state_code) set('state_code', g.slice(0, 2));
              }}
            />
          )}
        </Field>
        <Field label="State" error={errors.state_code}>
          {(id) => (
            <Select
              id={id}
              value={form.state_code}
              onChange={(e) => set('state_code', e.target.value)}
            >
              <option value="">Same as my business</option>
              {STATES.map((s) => (
                <option key={s.code} value={s.code}>
                  {s.code} · {s.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Payment terms (days)" error={errors.payment_terms_days}>
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
      </div>
      <div className="flex justify-end gap-2">
        <Button size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" variant="primary" disabled={busy} onClick={save}>
          {busy ? 'Saving…' : 'Add supplier'} <Kbd>Enter</Kbd>
        </Button>
      </div>
    </motion.div>
  );
}

/**
 * Find a supplier by firm / contact name, phone or GSTIN; not found → inline quick-add.
 * `value`: supplier row (from parties:search / parties:summary) or null. `onChange(row | null)`.
 */
export default function SupplierPicker({
  value,
  onChange,
  autoFocus = false,
  invalid = false,
  disabled = false,
  inputRef: outerRef,
}) {
  const [query, setQuery] = useState('');
  const [found, setFound] = useState({ q: '', rows: [] });
  const [index, setIndex] = useState(0);
  const [focused, setFocused] = useState(false);
  const [adding, setAdding] = useState(null);
  const innerRef = useRef(null);
  const inputRef = outerRef || innerRef;
  const q = query.trim();
  const debounced = useDebounced(q);

  useEffect(() => {
    if (debounced.length < 2) return undefined;
    let cancelled = false;
    partiesApi
      .search(debounced, { type: 'supplier', limit: 8 })
      .then((rows) => !cancelled && setFound({ q: debounced, rows }))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [debounced]);

  const rows = found.q === q && q.length >= 2 ? found.rows : [];
  const options = [
    ...rows.map((r) => ({ kind: 'row', row: r })),
    ...(q.length >= 2 ? [{ kind: 'add' }] : []),
  ];
  const active = Math.max(0, Math.min(index, options.length - 1));
  const open = focused && !value && !adding && q.length >= 2;

  function pick(o) {
    if (!o) return;
    if (o.kind === 'add') {
      setAdding(guess(q));
      return;
    }
    onChange(o.row);
    setQuery('');
  }

  function onKeyDown(e) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setIndex(Math.min(active + 1, options.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setIndex(Math.max(active - 1, 0));
    } else if (e.key === 'Enter' && open) {
      e.preventDefault();
      e.stopPropagation();
      pick(options[active]);
    }
  }

  if (value) {
    return (
      <div
        className={`flex items-center gap-3 rounded-xl border bg-surface-2/50 px-3 py-1.5 ${invalid ? 'border-danger' : 'border-border'}`}
      >
        <Building2 size={16} className="shrink-0 text-muted" />
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium">{value.name}</div>
          <div className="flex flex-wrap items-center gap-x-2 text-xs text-muted">
            {value.phone_display && (
              <span className="flex items-center gap-1">
                <Phone size={11} /> {value.phone_display}
              </span>
            )}
            {value.gstin && <span className="font-mono">{value.gstin}</span>}
            <span>{value.state_code ? stateName(value.state_code) : 'Same state'}</span>
            {value.payment_terms_days != null && (
              <span>{value.payment_terms_days} days credit</span>
            )}
          </div>
        </div>
        {value.balance < 0 && <Badge tone="danger">Payable {formatMoney(-value.balance)}</Badge>}
        {value.balance > 0 && <Badge tone="success">Advance {formatMoney(value.balance)}</Badge>}
        {!disabled && (
          <Button
            size="icon-sm"
            variant="ghost"
            icon={X}
            title="Change supplier"
            onClick={() => {
              onChange(null);
              setTimeout(() => inputRef.current?.focus(), 0);
            }}
          />
        )}
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
          invalid={invalid}
          onChange={(e) => {
            setQuery(e.target.value);
            setIndex(0);
            setAdding(null);
          }}
          onFocus={() => setFocused(true)}
          onBlur={() => setTimeout(() => setFocused(false), 150)}
          onKeyDown={onKeyDown}
          placeholder="Supplier: firm, phone or GSTIN…"
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
              {options.map((o, i) => (
                <li key={o.kind === 'row' ? o.row.id : 'add'}>
                  <button
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onMouseEnter={() => setIndex(i)}
                    onClick={() => pick(o)}
                    className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left ${i === active ? 'bg-primary-soft' : ''}`}
                  >
                    {o.kind === 'add' ? (
                      <span className="flex items-center gap-2 font-medium text-primary">
                        <Plus size={16} /> New supplier “{q}”
                      </span>
                    ) : (
                      <>
                        <div className="min-w-0 flex-1">
                          <div className="truncate font-medium">{o.row.name}</div>
                          <div className="truncate text-xs text-muted">
                            {[o.row.phone_display, o.row.gstin, o.row.city]
                              .filter(Boolean)
                              .join(' · ') || ' '}
                          </div>
                        </div>
                        {o.row.balance < 0 && (
                          <Badge tone="danger">Payable {formatMoney(-o.row.balance)}</Badge>
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
          onCancel={() => setAdding(null)}
          onDone={(row) => {
            setAdding(null);
            setQuery('');
            onChange(row);
          }}
        />
      )}
    </div>
  );
}
