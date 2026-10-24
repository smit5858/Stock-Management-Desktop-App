import { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  Ban,
  Camera,
  CheckCircle2,
  ClipboardCheck,
  PackageCheck,
  Send,
  Trash2,
  Truck,
  Wrench,
  X,
} from 'lucide-react';
import Button from '../../components/Button';
import { Modal } from '../../components/Overlay';
import {
  Field,
  Input,
  MoneyInput,
  Segmented,
  Select,
  Textarea,
  Toggle,
} from '../../components/Field';
import { Kbd, Skeleton } from '../../components/Feedback';
import { useToast } from '../../components/Toast';
import { claimsApi, warrantyApi } from '../../api/warranty';
import { serialsApi } from '../../api/products';
import { ItemSearch } from '../sales/BillLines';
import { parseMoney } from '../../utils/money';
import { formatQty, parseQty } from '../../utils/qty';
import { formatDate, todayISO } from '../../utils/dates';
import { WarrantyBadge } from './shared';

const REFUND_MODES = { cash: 'Cash', upi: 'UPI', bank: 'Bank' };

function errorOf(errors, ...keys) {
  for (const k of keys) if (errors[k]) return errors[k];
  return undefined;
}

/** Ctrl+Enter saves the open form. */
function useCtrlEnter(onSave) {
  const ref = useRef(onSave);
  useEffect(() => {
    ref.current = onSave;
  });
  useEffect(() => {
    const onKey = (e) => {
      if (e.ctrlKey && e.key === 'Enter') {
        e.preventDefault();
        ref.current?.();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

/** Runs an API call with busy state, field errors and a toast. */
function useSubmit() {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState({});
  async function run(fn, onOk) {
    if (busy) return;
    setBusy(true);
    setErrors({});
    try {
      const r = await fn();
      onOk(r);
    } catch (e) {
      if (e.fields) setErrors(e.fields);
      toast.error(e);
    } finally {
      setBusy(false);
    }
  }
  return { busy, errors, run, setErrors };
}

function Footer({ busy, onClose, onSave, label, icon, danger }) {
  return (
    <>
      <span className="mr-auto self-center text-xs text-muted">
        <Kbd>Ctrl</Kbd> + <Kbd>Enter</Kbd> to save
      </span>
      <Button onClick={onClose}>Cancel</Button>
      <Button variant={danger ? 'danger' : 'primary'} icon={icon} disabled={busy} onClick={onSave}>
        {busy ? 'Saving…' : label}
      </Button>
    </>
  );
}

function Chips({ options, value, onToggle }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((o) => {
        const on = value.includes(o);
        return (
          <button
            key={o}
            type="button"
            onClick={() => onToggle(o)}
            className={`rounded-full border px-2.5 py-1 text-xs font-medium transition-colors ${
              on
                ? 'border-transparent bg-primary text-on-primary'
                : 'border-border text-muted hover:text-fg'
            }`}
          >
            {on && <CheckCircle2 size={11} className="mr-1 inline" />}
            {o}
          </button>
        );
      })}
    </div>
  );
}

const toggle = (list, v) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

// ---------------------------------------------------------------- photos

function Photos({ list, onChange }) {
  const toast = useToast();
  async function add() {
    try {
      const picked = await claimsApi.pickPhotos();
      if (picked.length) onChange([...list, ...picked].slice(0, 10));
    } catch (e) {
      toast.error(e);
    }
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      {list.map((a, i) => (
        <div key={a.temp_path} className="group relative">
          {/\.(png|jpe?g|webp)$/i.test(a.temp_path) ? (
            <img
              src={a.url}
              alt=""
              className="h-16 w-16 rounded-lg border border-border object-cover"
            />
          ) : (
            <div className="flex h-16 w-16 items-center justify-center rounded-lg border border-border text-xs text-muted">
              PDF
            </div>
          )}
          <button
            type="button"
            title="Remove"
            onClick={() => onChange(list.filter((_, j) => j !== i))}
            className="absolute -top-1.5 -right-1.5 rounded-full bg-danger p-0.5 text-white opacity-0 group-hover:opacity-100"
          >
            <X size={12} />
          </button>
        </div>
      ))}
      <Button size="sm" icon={Camera} onClick={add}>
        Add photos
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------- new claim

/** Opens a claim for a unit / bill line. `unitRef` = { serial_id } | { sale_item_id }. */
export function NewClaimModal({ open, unitRef, meta, onClose, onCreated }) {
  const toast = useToast();
  const { busy, errors, run } = useSubmit();
  const [prep, setPrep] = useState(null);
  const [f, setF] = useState(null);
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));

  useEffect(() => {
    let cancelled = false;
    claimsApi
      .prepare(unitRef)
      .then((p) => {
        if (cancelled) return;
        setPrep(p);
        setF({
          received_date: p.defaults.received_date,
          received_by: '',
          expected_date: p.defaults.expected_date,
          qty: formatQty(p.defaults.qty_milli),
          tags: [],
          complaint: '',
          condition_notes: '',
          accessories: [],
          extra_accessory: '',
          brought_by: Boolean(p.unit.owner_note),
          brought_by_name: '',
          brought_by_phone: '',
          supplier_party_id: p.defaults.supplier_party_id
            ? String(p.defaults.supplier_party_id)
            : '',
          chargeable: !p.in_warranty,
          attachments: [],
          notes: '',
        });
      })
      .catch((e) => {
        toast.error(e);
        onClose();
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function save() {
    if (!f) return;
    const qty = prep.unit.kind === 'line' ? parseQty(f.qty) : 1000;
    if (qty === null) {
      toast.error('Enter the quantity.');
      return;
    }
    run(
      () =>
        claimsApi.create({
          ...unitRef,
          qty_milli: qty,
          received_date: f.received_date,
          received_by: f.received_by,
          expected_date: f.expected_date || null,
          complaint: f.complaint,
          complaint_tags: f.tags,
          condition_notes: f.condition_notes,
          accessories: f.extra_accessory.trim()
            ? [...f.accessories, f.extra_accessory.trim()]
            : f.accessories,
          brought_by_name: f.brought_by ? f.brought_by_name : '',
          brought_by_phone: f.brought_by ? f.brought_by_phone : '',
          supplier_party_id: f.supplier_party_id ? Number(f.supplier_party_id) : null,
          chargeable: f.chargeable,
          attachments: f.attachments,
          notes: f.notes,
        }),
      (c) => {
        toast.success(`Claim ${c.claim_no} opened.`);
        onCreated(c);
      },
    );
  }
  useCtrlEnter(save);

  const u = prep?.unit;
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New warranty claim"
      width="w-[46rem]"
      footer={
        <Footer
          busy={busy}
          onClose={onClose}
          onSave={save}
          label="Open claim"
          icon={ClipboardCheck}
        />
      }
    >
      {!f ? (
        <Skeleton className="h-96" />
      ) : (
        <div className="space-y-4">
          <div className="flex items-start gap-3 rounded-xl bg-surface-2 px-3 py-2.5 text-sm">
            <div className="min-w-0 flex-1">
              <div className="font-semibold">
                {u.product_name}
                {u.variant_label && (
                  <span className="font-normal text-muted"> · {u.variant_label}</span>
                )}
              </div>
              <div className="text-xs text-muted">
                {[
                  u.serial_no
                    ? `S/N ${u.serial_no}`
                    : `${formatQty(u.qty_milli)} ${u.unit} on the bill`,
                  u.invoice_no,
                  u.customer_name,
                  u.vehicle_no,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </div>
            </div>
            <WarrantyBadge status={u.status} showDays />
          </div>
          {prep.warnings.map((w) => (
            <div
              key={w}
              className="flex gap-2 rounded-xl bg-warning-soft px-3 py-2 text-sm text-warning"
            >
              <AlertTriangle size={16} className="mt-0.5 shrink-0" /> {w}
            </div>
          ))}

          <div className="grid grid-cols-3 gap-3">
            <Field label="Received on" error={errors.received_date}>
              {(id) => (
                <Input
                  id={id}
                  type="date"
                  value={f.received_date}
                  max={todayISO()}
                  onChange={(e) => set('received_date', e.target.value)}
                />
              )}
            </Field>
            <Field label="Received by" error={errors.received_by}>
              {(id) => (
                <Input
                  id={id}
                  value={f.received_by}
                  maxLength={60}
                  placeholder="Staff name"
                  onChange={(e) => set('received_by', e.target.value)}
                />
              )}
            </Field>
            <Field label="Expected ready by" error={errors.expected_date}>
              {(id) => (
                <Input
                  id={id}
                  type="date"
                  value={f.expected_date}
                  onChange={(e) => set('expected_date', e.target.value)}
                />
              )}
            </Field>
          </div>

          {u.kind === 'line' && (
            <Field
              label={`Quantity (${u.unit})`}
              hint={`Up to ${formatQty(u.claimable_milli)} can be claimed.`}
              error={errors.qty_milli}
            >
              {(id) => (
                <Input
                  id={id}
                  className="w-32"
                  value={f.qty}
                  onChange={(e) => set('qty', e.target.value)}
                />
              )}
            </Field>
          )}

          <Field label="Complaint" required error={errors.complaint}>
            {(id) => (
              <div className="space-y-2">
                <Chips
                  options={prep.presets}
                  value={f.tags}
                  onToggle={(o) => set('tags', toggle(f.tags, o))}
                />
                <Textarea
                  id={id}
                  rows={2}
                  autoFocus
                  maxLength={500}
                  value={f.complaint}
                  placeholder="What the customer says (optional if a common issue is picked)"
                  onChange={(e) => set('complaint', e.target.value)}
                />
              </div>
            )}
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Physical condition" error={errors.condition_notes}>
              {(id) => (
                <Textarea
                  id={id}
                  rows={2}
                  maxLength={500}
                  value={f.condition_notes}
                  placeholder="Scratches, dents, seal intact…"
                  onChange={(e) => set('condition_notes', e.target.value)}
                />
              )}
            </Field>
            <Field label="Items received with it">
              {() => (
                <div className="space-y-2">
                  <Chips
                    options={prep.accessories}
                    value={f.accessories}
                    onToggle={(o) => set('accessories', toggle(f.accessories, o))}
                  />
                  <Input
                    value={f.extra_accessory}
                    maxLength={60}
                    placeholder="Other item…"
                    onChange={(e) => set('extra_accessory', e.target.value)}
                  />
                </div>
              )}
            </Field>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Field
              label="Supplier (for a supplier claim)"
              hint="Filled from the purchase when known."
            >
              {(id) => (
                <Select
                  id={id}
                  value={f.supplier_party_id}
                  onChange={(e) => set('supplier_party_id', e.target.value)}
                >
                  <option value="">—</option>
                  {meta.suppliers.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <div className="space-y-1 pt-4">
              <Toggle
                checked={f.chargeable}
                disabled={!prep.in_warranty}
                onChange={(v) => set('chargeable', v)}
                label="Chargeable repair"
                description={
                  prep.in_warranty
                    ? 'Customer pays (e.g. damage not covered).'
                    : 'Out of warranty: the customer pays.'
                }
              />
            </div>
          </div>

          <div>
            <Toggle
              checked={f.brought_by}
              onChange={(v) => set('brought_by', v)}
              label="Brought in by someone else"
              description="The warranty follows the unit: the original buyer stays on the claim."
            />
            {f.brought_by && (
              <div className="mt-2 grid grid-cols-2 gap-3">
                <Input
                  value={f.brought_by_name}
                  maxLength={100}
                  placeholder="Name"
                  onChange={(e) => set('brought_by_name', e.target.value)}
                />
                <Input
                  value={f.brought_by_phone}
                  maxLength={20}
                  placeholder="Phone"
                  onChange={(e) => set('brought_by_phone', e.target.value)}
                />
              </div>
            )}
          </div>

          <Field label="Photos">
            {() => <Photos list={f.attachments} onChange={(v) => set('attachments', v)} />}
          </Field>
        </div>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------- decision branches

export function DispatchFields({ value, onChange, suppliers, errors = {} }) {
  const set = (k, v) => onChange({ ...value, [k]: v });
  return (
    <div className="grid grid-cols-2 gap-3">
      <Field
        label="Supplier"
        required
        error={errorOf(errors, 'supplier_party_id', 'dispatch.supplier_party_id')}
      >
        {(id) => (
          <Select
            id={id}
            value={value.supplier_party_id}
            onChange={(e) => set('supplier_party_id', e.target.value)}
          >
            <option value="">Choose…</option>
            {suppliers.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field label="Sent by">
        {() => (
          <Segmented
            layoutId="dispatch-mode"
            value={value.mode}
            onChange={(v) => set('mode', v)}
            options={[
              { value: 'hand', label: 'Hand delivery' },
              { value: 'courier', label: 'Courier' },
            ]}
          />
        )}
      </Field>
      {value.mode === 'courier' && (
        <>
          <Field label="Courier" error={errors['dispatch.courier']}>
            {(id) => (
              <Input
                id={id}
                value={value.courier}
                maxLength={60}
                onChange={(e) => set('courier', e.target.value)}
              />
            )}
          </Field>
          <Field label="Docket no." required error={errors['dispatch.docket_no']}>
            {(id) => (
              <Input
                id={id}
                value={value.docket_no}
                maxLength={60}
                onChange={(e) => set('docket_no', e.target.value)}
              />
            )}
          </Field>
        </>
      )}
      <Field label="Expected back by" error={errors['dispatch.expected_date']}>
        {(id) => (
          <Input
            id={id}
            type="date"
            value={value.expected_date}
            onChange={(e) => set('expected_date', e.target.value)}
          />
        )}
      </Field>
    </div>
  );
}

function emptyDispatch(claim) {
  return {
    supplier_party_id: claim.supplier_party_id ? String(claim.supplier_party_id) : '',
    mode: 'hand',
    courier: '',
    docket_no: '',
    expected_date: '',
  };
}

function dispatchPayload(d) {
  return {
    supplier_party_id: d.supplier_party_id ? Number(d.supplier_party_id) : null,
    mode: d.mode,
    courier: d.courier,
    docket_no: d.docket_no,
    expected_date: d.expected_date || null,
  };
}

/** Warranty of a replacement unit: remaining of the old one (default setting) or fresh. */
function WarrantyModeFields({ value, onChange, defaultMode, errors = {} }) {
  const set = (k, v) => onChange({ ...value, [k]: v });
  return (
    <>
      <Field label="Warranty of the replacement">
        {() => (
          <div className="flex flex-wrap items-center gap-3">
            <Segmented
              layoutId="repl-mode"
              value={value.mode}
              onChange={(v) => set('mode', v)}
              options={[
                { value: 'remaining', label: 'Remaining of old unit' },
                { value: 'fresh', label: 'Fresh warranty' },
              ]}
            />
            {value.mode === defaultMode && <span className="text-xs text-muted">(default)</span>}
          </div>
        )}
      </Field>
      {value.mode !== defaultMode && (
        <Field label="Reason for this warranty" required error={errors.reason}>
          {(id) => (
            <Input
              id={id}
              value={value.reason}
              maxLength={200}
              onChange={(e) => set('reason', e.target.value)}
            />
          )}
        </Field>
      )}
    </>
  );
}

/** Pick the unit given to the customer + its warranty (remaining / fresh). */
export function ReplaceFields({
  claim,
  value,
  onChange,
  defaultMode,
  allowPending = true,
  errors = {},
}) {
  const toast = useToast();
  const set = (k, v) => onChange({ ...value, [k]: v });
  const [stock, setStock] = useState(null);
  useEffect(() => {
    if (!claim.serial) return undefined;
    let cancelled = false;
    serialsApi
      .inStock(claim.variant_id, value.search || '')
      .then((rows) => !cancelled && setStock(rows))
      .catch(toast.error);
    return () => {
      cancelled = true;
    };
  }, [claim.serial, claim.variant_id, value.search, toast]);
  return (
    <div className="space-y-3">
      {claim.serial ? (
        <Field label="Replacement unit from stock" required error={errors.replacement_serial_id}>
          {() => (
            <div className="space-y-2">
              <Input
                value={value.search || ''}
                placeholder="Scan / search serial no."
                onChange={(e) => set('search', e.target.value)}
              />
              <div className="max-h-40 overflow-auto rounded-lg border border-border">
                {!stock ? (
                  <Skeleton className="h-16" />
                ) : stock.length === 0 ? (
                  <p className="px-3 py-2 text-sm text-muted">No unit of this item in stock.</p>
                ) : (
                  stock.map((s) => (
                    <label
                      key={s.id}
                      className={`flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm hover:bg-surface-2 ${value.replacement_serial_id === s.id ? 'bg-primary-soft' : ''}`}
                    >
                      <input
                        type="radio"
                        name="repl"
                        checked={value.replacement_serial_id === s.id}
                        onChange={() => set('replacement_serial_id', s.id)}
                      />
                      <span className="font-mono">{s.serial_no}</span>
                      {s.serial_no_2 && (
                        <span className="font-mono text-xs text-muted">/ {s.serial_no_2}</span>
                      )}
                    </label>
                  ))
                )}
              </div>
            </div>
          )}
        </Field>
      ) : (
        <p className="rounded-lg bg-surface-2 px-3 py-2 text-sm">
          {formatQty(claim.qty_milli)} {claim.product.unit} of {claim.product.name} will be taken
          from stock; the faulty goods go to defective stock.
        </p>
      )}
      <WarrantyModeFields
        value={value}
        onChange={onChange}
        defaultMode={defaultMode}
        errors={errors}
      />
      {allowPending && claim.serial && (
        <Toggle
          checked={Boolean(value.pending)}
          onChange={(v) => set('pending', v)}
          label="None in stock now: wait for stock"
          description="The claim waits as “Awaiting replacement”."
        />
      )}
    </div>
  );
}

function RefundFields({ value, onChange }) {
  const set = (k, v) => onChange({ ...value, [k]: v });
  return (
    <div className="grid grid-cols-2 gap-3">
      <Field label="Settle as">
        {() => (
          <Segmented
            layoutId="refund-settle"
            value={value.settlement}
            onChange={(v) => set('settlement', v)}
            options={[
              { value: 'refund', label: 'Refund money' },
              { value: 'adjust', label: 'Credit / advance' },
            ]}
          />
        )}
      </Field>
      {value.settlement === 'refund' && (
        <Field label="Refund by">
          {(id) => (
            <Select
              id={id}
              value={value.refund_mode}
              onChange={(e) => set('refund_mode', e.target.value)}
            >
              {Object.entries(REFUND_MODES).map(([k, l]) => (
                <option key={k} value={k}>
                  {l}
                </option>
              ))}
            </Select>
          )}
        </Field>
      )}
      <p className="col-span-2 text-xs text-muted">
        A credit note is made against the bill; the unit goes to defective stock.
      </p>
    </div>
  );
}

const DECISION_ICONS = {
  repair: Wrench,
  supplier: Truck,
  replace: PackageCheck,
  refund: Send,
  reject: Ban,
};

/** The inspection decision: repair / supplier / replace / refund / reject. */
export function DecideModal({ open, claim, meta, onClose, onDone }) {
  const toast = useToast();
  const { busy, errors, run } = useSubmit();
  const allowed = Object.keys(meta.decisions).filter(
    (d) => !claim.chargeable || ['repair', 'supplier', 'reject'].includes(d),
  );
  const [decision, setDecision] = useState(allowed[0]);
  const [notes, setNotes] = useState(claim.inspection_notes || '');
  const [dispatch, setDispatch] = useState(() => emptyDispatch(claim));
  const [repl, setRepl] = useState({
    mode: meta.replacement_warranty,
    reason: '',
    replacement_serial_id: null,
    pending: false,
  });
  const [refund, setRefund] = useState({ settlement: 'refund', refund_mode: 'cash' });
  const [reject, setReject] = useState({ reject_reason: '', reject_notes: '' });

  function save() {
    const base = { id: claim.id, decision, inspection_notes: notes };
    const extra =
      decision === 'supplier'
        ? { dispatch: dispatchPayload(dispatch) }
        : decision === 'replace'
          ? { ...repl }
          : decision === 'refund'
            ? refund
            : decision === 'reject'
              ? reject
              : {};
    run(
      () => claimsApi.decide({ ...base, ...extra }),
      (c) => {
        toast.success(`${c.claim_no}: ${c.status_label}.`);
        onDone(c);
      },
    );
  }
  useCtrlEnter(save);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Decision · ${claim.claim_no}`}
      width="w-[44rem]"
      footer={
        <Footer
          busy={busy}
          onClose={onClose}
          onSave={save}
          label="Save decision"
          icon={CheckCircle2}
          danger={decision === 'reject'}
        />
      }
    >
      <div className="space-y-4">
        <Field label="Inspection notes">
          {(id) => (
            <Textarea
              id={id}
              rows={2}
              maxLength={500}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="What was found"
            />
          )}
        </Field>
        <div className="grid grid-cols-5 gap-2">
          {allowed.map((d) => {
            const Icon = DECISION_ICONS[d];
            const on = d === decision;
            return (
              <button
                key={d}
                type="button"
                onClick={() => setDecision(d)}
                className={`flex flex-col items-center gap-1.5 rounded-xl border px-2 py-3 text-xs font-medium transition-colors ${
                  on
                    ? 'border-primary bg-primary-soft text-primary'
                    : 'border-border text-muted hover:text-fg'
                }`}
              >
                <Icon size={18} />
                {meta.decisions[d]}
              </button>
            );
          })}
        </div>
        {claim.chargeable ? (
          <p className="rounded-lg bg-warning-soft px-3 py-2 text-sm text-warning">
            Chargeable claim: repair (billed), send to the supplier, or reject.
          </p>
        ) : null}
        {decision === 'repair' && (
          <p className="text-sm text-muted">
            The claim goes to “Repairing”. Record the parts used when the repair is done.
          </p>
        )}
        {decision === 'supplier' && (
          <DispatchFields
            value={dispatch}
            onChange={setDispatch}
            suppliers={meta.suppliers}
            errors={errors}
          />
        )}
        {decision === 'replace' && (
          <ReplaceFields
            claim={claim}
            value={repl}
            onChange={setRepl}
            defaultMode={meta.replacement_warranty}
            errors={errors}
          />
        )}
        {decision === 'refund' && <RefundFields value={refund} onChange={setRefund} />}
        {decision === 'reject' && (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Reason" required error={errors.reject_reason}>
              {(id) => (
                <Select
                  id={id}
                  value={reject.reject_reason}
                  onChange={(e) => setReject({ ...reject, reject_reason: e.target.value })}
                >
                  <option value="">Choose…</option>
                  {Object.entries(meta.reject_reasons).map(([k, l]) => (
                    <option key={k} value={k}>
                      {l}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Notes" error={errors.reject_notes}>
              {(id) => (
                <Input
                  id={id}
                  value={reject.reject_notes}
                  maxLength={500}
                  onChange={(e) => setReject({ ...reject, reject_notes: e.target.value })}
                />
              )}
            </Field>
          </div>
        )}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- small action modals

export function InspectModal({ open, claim, onClose, onDone }) {
  const toast = useToast();
  const { busy, run } = useSubmit();
  const [notes, setNotes] = useState(claim.inspection_notes || '');
  const save = () =>
    run(
      () => claimsApi.inspect({ id: claim.id, notes }),
      (c) => {
        toast.success('Under inspection.');
        onDone(c);
      },
    );
  useCtrlEnter(save);
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Inspect · ${claim.claim_no}`}
      footer={<Footer busy={busy} onClose={onClose} onSave={save} label="Start inspection" />}
    >
      <Field label="Inspection notes">
        {(id) => (
          <Textarea
            id={id}
            autoFocus
            rows={3}
            maxLength={500}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        )}
      </Field>
    </Modal>
  );
}

export function DispatchModal({ open, claim, meta, onClose, onDone }) {
  const toast = useToast();
  const { busy, errors, run } = useSubmit();
  const [d, setD] = useState(() => emptyDispatch(claim));
  const save = () =>
    run(
      () => claimsApi.dispatch({ id: claim.id, ...dispatchPayload(d) }),
      (c) => {
        toast.success('Sent to the supplier.');
        onDone(c);
      },
    );
  useCtrlEnter(save);
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Send to supplier · ${claim.claim_no}`}
      width="w-[38rem]"
      footer={<Footer busy={busy} onClose={onClose} onSave={save} label="Send" icon={Truck} />}
    >
      <DispatchFields value={d} onChange={setD} suppliers={meta.suppliers} errors={errors} />
    </Modal>
  );
}

/** Parts used + labour. In warranty: parts leave stock as warranty loss; chargeable: for the bill. */
export function RepairDoneModal({ open, claim, onClose, onDone }) {
  const toast = useToast();
  const { busy, errors, run } = useSubmit();
  const searchRef = useRef(null);
  const [notes, setNotes] = useState(claim.repair_notes || '');
  const [parts, setParts] = useState([]);
  const [labour, setLabour] = useState('');

  function add(row) {
    if (row.product_type === 'service') {
      toast.error('Choose a stock item as a part.');
      return;
    }
    if (row.track_serials) {
      toast.error('Parts with serial numbers cannot be used here.');
      return;
    }
    setParts((list) =>
      list.some((p) => p.variant_id === row.variant_id)
        ? list
        : [
            ...list,
            {
              variant_id: row.variant_id,
              name: row.variant_label ? `${row.name} · ${row.variant_label}` : row.name,
              unit: row.unit,
              qty: '1',
              stock_milli: row.stock_milli,
            },
          ],
    );
  }

  function save() {
    const labourPaise = labour.trim() ? parseMoney(labour) : 0;
    if (labourPaise === null || labourPaise < 0) {
      toast.error('Enter a valid labour amount.');
      return;
    }
    const payload = parts.map((p) => ({ variant_id: p.variant_id, qty_milli: parseQty(p.qty) }));
    if (payload.some((p) => !p.qty_milli || p.qty_milli <= 0)) {
      toast.error('Enter the quantity of each part.');
      return;
    }
    run(
      () =>
        claimsApi.repairDone({
          id: claim.id,
          repair_notes: notes,
          parts: payload,
          labour_amount: labourPaise,
        }),
      (c) => {
        toast.success('Repair recorded: ready for pickup.');
        onDone(c);
      },
    );
  }
  useCtrlEnter(save);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Repair done · ${claim.claim_no}`}
      width="w-[44rem]"
      footer={
        <Footer
          busy={busy}
          onClose={onClose}
          onSave={save}
          label="Ready for pickup"
          icon={Wrench}
        />
      }
    >
      <div className="space-y-4">
        <p
          className={`rounded-lg px-3 py-2 text-sm ${claim.chargeable ? 'bg-warning-soft text-warning' : 'bg-surface-2 text-muted'}`}
        >
          {claim.chargeable
            ? 'Chargeable repair: parts and labour are noted for the bill (stock goes out when the bill is saved).'
            : 'In warranty: parts leave stock now and, with labour, count as warranty loss (at average cost).'}
        </p>
        <Field label="Work done" error={errors.repair_notes}>
          {(id) => (
            <Textarea
              id={id}
              autoFocus
              rows={2}
              maxLength={500}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          )}
        </Field>
        <Field label="Parts used" error={errors.parts}>
          {() => (
            <div className="space-y-2">
              <ItemSearch inputRef={searchRef} vehicleId={null} onAdd={add} />
              {parts.map((p, i) => (
                <div
                  key={p.variant_id}
                  className="flex items-center gap-2 rounded-lg border border-border px-3 py-1.5 text-sm"
                >
                  <span className="min-w-0 flex-1 truncate">{p.name}</span>
                  <span className="text-xs text-muted">stock {formatQty(p.stock_milli)}</span>
                  <Input
                    className="w-20! text-right"
                    value={p.qty}
                    onChange={(e) =>
                      setParts((l) =>
                        l.map((x, j) => (j === i ? { ...x, qty: e.target.value } : x)),
                      )
                    }
                  />
                  <span className="w-8 text-xs text-muted">{p.unit}</span>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    icon={Trash2}
                    onClick={() => setParts((l) => l.filter((_, j) => j !== i))}
                  />
                </div>
              ))}
            </div>
          )}
        </Field>
        <Field
          label={claim.chargeable ? 'Repair charge (labour)' : 'Labour cost (optional)'}
          error={errors.labour_amount}
        >
          {(id) => (
            <MoneyInput
              id={id}
              className="w-48"
              value={labour}
              onChange={(e) => setLabour(e.target.value)}
            />
          )}
        </Field>
      </div>
    </Modal>
  );
}

/** The supplier's answer: repaired / replaced / credit note / rejected. */
export function SupplierResultModal({ open, claim, meta, onClose, onDone }) {
  const toast = useToast();
  const { busy, errors, run } = useSubmit();
  const stockClaim = claim.kind === 'stock';
  const [f, setF] = useState({
    result: 'repaired',
    date: todayISO(),
    notes: '',
    serial_no: '',
    serial_no_2: '',
    new_to: 'customer',
    mode: meta.replacement_warranty,
    reason: '',
    credit: '',
    credit_ref: '',
    rejected_action: 'return_as_is',
  });
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));

  function save() {
    const credit = f.result === 'credit' ? parseMoney(f.credit || '') : null;
    if (f.result === 'credit' && (credit === null || credit < 0)) {
      toast.error('Enter the credit amount.');
      return;
    }
    run(
      () =>
        claimsApi.supplierResult({
          id: claim.id,
          result: f.result,
          date: f.date,
          notes: f.notes,
          new_serial: { serial_no: f.serial_no, serial_no_2: f.serial_no_2 },
          new_to: stockClaim ? 'stock' : f.new_to,
          mode: f.mode,
          reason: f.reason,
          credit_amount: credit,
          credit_ref: f.credit_ref,
          rejected_action: f.rejected_action,
        }),
      (c) => {
        toast.success(`${c.claim_no}: ${c.status_label}.`);
        onDone(c);
      },
    );
  }
  useCtrlEnter(save);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Supplier result · ${claim.claim_no}`}
      width="w-[42rem]"
      footer={
        <Footer
          busy={busy}
          onClose={onClose}
          onSave={save}
          label="Save result"
          icon={CheckCircle2}
        />
      }
    >
      <div className="space-y-4">
        {claim.at_supplier && (
          <p className="text-sm text-muted">
            Sent to <strong className="text-fg">{claim.at_supplier.supplier_name}</strong> on{' '}
            {formatDate(claim.at_supplier.dispatch_date)}
            {claim.at_supplier.expected_date
              ? `, expected ${formatDate(claim.at_supplier.expected_date)}`
              : ''}
            .
          </p>
        )}
        <Segmented
          layoutId="supplier-result"
          value={f.result}
          onChange={(v) => set('result', v)}
          options={[
            { value: 'repaired', label: 'Repaired' },
            { value: 'replaced', label: 'Replaced' },
            { value: 'credit', label: 'Credit note' },
            { value: 'rejected', label: 'Rejected' },
          ]}
        />
        <div className="grid grid-cols-2 gap-3">
          <Field label="Date" error={errors.date}>
            {(id) => (
              <Input
                id={id}
                type="date"
                value={f.date}
                max={todayISO()}
                onChange={(e) => set('date', e.target.value)}
              />
            )}
          </Field>
          <Field label="Notes">
            {(id) => (
              <Input
                id={id}
                value={f.notes}
                maxLength={500}
                onChange={(e) => set('notes', e.target.value)}
              />
            )}
          </Field>
        </div>
        {f.result === 'repaired' && (
          <p className="text-sm text-muted">
            {stockClaim
              ? 'The unit goes back into sellable stock.'
              : 'The unit is ready to hand back to the customer.'}
          </p>
        )}
        {f.result === 'replaced' && (
          <div className="space-y-3">
            {claim.serial && (
              <div className="grid grid-cols-2 gap-3">
                <Field
                  label="Serial no. of the new unit"
                  required
                  error={errorOf(errors, 'new_serial.serial_no')}
                >
                  {(id) => (
                    <Input
                      id={id}
                      autoFocus
                      className="font-mono"
                      value={f.serial_no}
                      onChange={(e) => set('serial_no', e.target.value)}
                    />
                  )}
                </Field>
                <Field label="Second number (optional)">
                  {(id) => (
                    <Input
                      id={id}
                      className="font-mono"
                      value={f.serial_no_2}
                      onChange={(e) => set('serial_no_2', e.target.value)}
                    />
                  )}
                </Field>
              </div>
            )}
            {!stockClaim && (
              <Field label="The new unit goes">
                {() => (
                  <Segmented
                    layoutId="new-to"
                    value={f.new_to}
                    onChange={(v) => set('new_to', v)}
                    options={[
                      { value: 'customer', label: 'To the customer' },
                      { value: 'stock', label: 'Into my stock' },
                    ]}
                  />
                )}
              </Field>
            )}
            {!stockClaim && f.new_to === 'customer' && claim.serial && (
              <WarrantyModeFields
                value={f}
                onChange={setF}
                defaultMode={meta.replacement_warranty}
                errors={errors}
              />
            )}
            {!stockClaim && f.new_to === 'stock' && (
              <p className="text-xs text-muted">
                Counts as recovered from the supplier. The customer then gets a replacement from
                stock.
              </p>
            )}
          </div>
        )}
        {f.result === 'credit' && (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Credit amount" required error={errors.credit_amount}>
              {(id) => (
                <MoneyInput
                  id={id}
                  autoFocus
                  value={f.credit}
                  onChange={(e) => set('credit', e.target.value)}
                />
              )}
            </Field>
            <Field label="Supplier's credit note no.">
              {(id) => (
                <Input
                  id={id}
                  value={f.credit_ref}
                  maxLength={60}
                  onChange={(e) => set('credit_ref', e.target.value)}
                />
              )}
            </Field>
            <p className="col-span-2 text-xs text-muted">
              Reduces what you owe this supplier (shown in the supplier ledger).
            </p>
          </div>
        )}
        {f.result === 'rejected' &&
          (stockClaim ? (
            <p className="text-sm text-muted">The unit comes back into defective stock.</p>
          ) : (
            <Field label="Now" error={errors.rejected_action}>
              {() => (
                <div className="space-y-1.5 text-sm">
                  {[
                    ['return_as_is', 'Return it to the customer as it is'],
                    ['chargeable', 'Chargeable repair (customer pays)'],
                    ['absorb', 'Shop absorbs the loss (repair / replace / refund at my cost)'],
                  ].map(([k, l]) => (
                    <label key={k} className="flex cursor-pointer items-center gap-2">
                      <input
                        type="radio"
                        name="rej"
                        checked={f.rejected_action === k}
                        onChange={() => set('rejected_action', k)}
                      />{' '}
                      {l}
                    </label>
                  ))}
                </div>
              )}
            </Field>
          ))}
      </div>
    </Modal>
  );
}

/** Replacement (or refund) for a claim waiting for one. */
export function ReplaceModal({ open, claim, meta, onClose, onDone }) {
  const toast = useToast();
  const { busy, errors, run } = useSubmit();
  const [tab, setTab] = useState('replace');
  const [repl, setRepl] = useState({
    mode: meta.replacement_warranty,
    reason: '',
    replacement_serial_id: null,
  });
  const [refund, setRefund] = useState({ settlement: 'refund', refund_mode: 'cash' });
  const save = () =>
    run(
      () =>
        tab === 'replace'
          ? claimsApi.replace({ id: claim.id, ...repl })
          : claimsApi.refund({ id: claim.id, ...refund }),
      (c) => {
        toast.success(`${c.claim_no}: ${c.status_label}.`);
        onDone(c);
      },
    );
  useCtrlEnter(save);
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Replacement · ${claim.claim_no}`}
      width="w-[42rem]"
      footer={
        <Footer
          busy={busy}
          onClose={onClose}
          onSave={save}
          label={tab === 'replace' ? 'Give replacement' : 'Refund'}
          icon={PackageCheck}
        />
      }
    >
      <div className="space-y-4">
        {claim.can.refund && (
          <Segmented
            layoutId="repl-or-refund"
            value={tab}
            onChange={setTab}
            options={[
              { value: 'replace', label: 'Replace from stock' },
              { value: 'refund', label: 'Refund instead' },
            ]}
          />
        )}
        {tab === 'replace' ? (
          <ReplaceFields
            claim={claim}
            value={repl}
            onChange={setRepl}
            defaultMode={meta.replacement_warranty}
            allowPending={false}
            errors={errors}
          />
        ) : (
          <RefundFields value={refund} onChange={setRefund} />
        )}
      </div>
    </Modal>
  );
}

export function HandoverModal({ open, claim, onClose, onDone }) {
  const toast = useToast();
  const { busy, errors, run } = useSubmit();
  const [f, setF] = useState({
    date: todayISO(),
    handed_over_by: '',
    final_notes: '',
    close: true,
  });
  const [unbilled, setUnbilled] = useState(false);
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const save = () =>
    run(
      () => claimsApi.handover({ id: claim.id, ...f, confirm_unbilled: unbilled }),
      (c) => {
        toast.success(`${c.claim_no} handed over.`);
        onDone(c);
      },
    );
  useCtrlEnter(save);
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Hand over · ${claim.claim_no}`}
      footer={
        <Footer busy={busy} onClose={onClose} onSave={save} label="Hand over" icon={CheckCircle2} />
      }
    >
      <div className="space-y-3">
        <p className="text-sm text-muted">
          {claim.replacement
            ? `Give replacement S/N ${claim.replacement.serial_no}.`
            : claim.status === 'rejected'
              ? 'Return the unit as it is (claim rejected).'
              : 'Return the unit to the customer.'}
        </p>
        {claim.unbilled && (
          <div className="rounded-lg bg-warning-soft px-3 py-2 text-sm text-warning">
            This chargeable repair has no bill yet.
            <label className="mt-1 flex items-center gap-2">
              <input
                type="checkbox"
                checked={unbilled}
                onChange={(e) => setUnbilled(e.target.checked)}
              />{' '}
              Hand over without a bill
            </label>
          </div>
        )}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Date" error={errors.date}>
            {(id) => (
              <Input
                id={id}
                type="date"
                value={f.date}
                max={todayISO()}
                onChange={(e) => set('date', e.target.value)}
              />
            )}
          </Field>
          <Field label="Handed over by">
            {(id) => (
              <Input
                id={id}
                autoFocus
                value={f.handed_over_by}
                maxLength={60}
                onChange={(e) => set('handed_over_by', e.target.value)}
              />
            )}
          </Field>
        </div>
        <Field label="Final notes">
          {(id) => (
            <Textarea
              id={id}
              rows={2}
              maxLength={500}
              value={f.final_notes}
              onChange={(e) => set('final_notes', e.target.value)}
            />
          )}
        </Field>
        <Toggle
          checked={f.close}
          onChange={(v) => set('close', v)}
          label="Close the claim"
          description="Off: it stays “Returned to customer” until closed."
        />
      </div>
    </Modal>
  );
}

export function ReasonModal({
  open,
  title,
  label = 'Reason',
  confirmLabel,
  danger,
  onClose,
  onSubmit,
}) {
  const { busy, errors, run } = useSubmit();
  const [reason, setReason] = useState('');
  const save = () =>
    run(
      () => onSubmit(reason),
      () => {},
    );
  useCtrlEnter(save);
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      footer={
        <Footer busy={busy} onClose={onClose} onSave={save} label={confirmLabel} danger={danger} />
      }
    >
      <Field label={label} required error={errors.reason}>
        {(id) => (
          <Input
            id={id}
            autoFocus
            value={reason}
            maxLength={200}
            onChange={(e) => setReason(e.target.value)}
          />
        )}
      </Field>
    </Modal>
  );
}

/** Void a customer warranty with a reason. */
export function VoidModal({ open, unitRef, meta, onClose, onDone }) {
  const toast = useToast();
  const { busy, errors, run } = useSubmit();
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const save = () =>
    run(
      () => warrantyApi.voidWarranty(unitRef, reason, note),
      (u) => {
        toast.success('Warranty voided.');
        onDone(u);
      },
    );
  useCtrlEnter(save);
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Void warranty"
      footer={
        <Footer
          busy={busy}
          onClose={onClose}
          onSave={save}
          label="Void warranty"
          icon={Ban}
          danger
        />
      }
    >
      <div className="space-y-3">
        <Field label="Reason" required error={errors.reason}>
          {(id) => (
            <Select id={id} autoFocus value={reason} onChange={(e) => setReason(e.target.value)}>
              <option value="">Choose…</option>
              {Object.entries(meta.void_reasons).map(([k, l]) => (
                <option key={k} value={k}>
                  {l}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Details" error={errors.note}>
          {(id) => (
            <Input id={id} value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} />
          )}
        </Field>
      </div>
    </Modal>
  );
}
