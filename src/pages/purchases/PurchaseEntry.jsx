import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import {
  AlertTriangle,
  ArrowLeft,
  ExternalLink,
  FileText,
  Image as ImageIcon,
  Paperclip,
  PauseCircle,
  Plus,
  Save,
  Trash2,
  Truck,
  X,
} from 'lucide-react';
import Button from '../../components/Button';
import { Field, Input, MoneyInput, Segmented, Select, Textarea } from '../../components/Field';
import { Badge, Kbd, Skeleton } from '../../components/Feedback';
import { Modal, anyOverlayOpen } from '../../components/Overlay';
import ConfirmDialog from '../../components/ConfirmDialog';
import SupplierPicker from '../../components/SupplierPicker';
import { useToast } from '../../components/Toast';
import { useHotkeys } from '../../hooks/useHotkeys';
import { partiesApi } from '../../api/parties';
import { productsApi } from '../../api/products';
import { purchaseDraftsApi, purchasesApi } from '../../api/purchases';
import { formatMoney, paiseToInput, parseMoney } from '../../utils/money';
import { formatRateBp, parseQty } from '../../utils/qty';
import { formatBytes, formatDate } from '../../utils/dates';
import { stateName } from '../../utils/identity';
import SerialEntryModal from '../products/SerialEntryModal';
import ProductDrawer from '../products/ProductDrawer';
import { emptyForm as emptyProductForm } from '../products/form';
import ItemGrid, { ProductAdder } from './ItemGrid';
import {
  advanceValue,
  calcPayload,
  emptyForm,
  fromDraft,
  fromPurchase,
  lineFromProduct,
  qtyToInput,
  toDraft,
  toPayload,
  uid,
} from './entryForm';

function addDays(iso, days) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

function Card({ title, icon: Icon, right, children, className = '' }) {
  return (
    <section className={`rounded-2xl border border-border bg-surface p-4 shadow-sm ${className}`}>
      {title && (
        <div className="mb-3 flex items-center gap-2">
          {Icon && <Icon size={16} className="text-primary" />}
          <h2 className="text-sm font-semibold">{title}</h2>
          <div className="ml-auto">{right}</div>
        </div>
      )}
      {children}
    </section>
  );
}

function Row({ label, value, strong, muted, children }) {
  return (
    <div
      className={`flex items-center justify-between gap-3 py-1 ${strong ? 'text-base font-bold' : ''} ${muted ? 'text-muted' : ''}`}
    >
      <span>{label}</span>
      {children || <span className="tabular-nums">{value}</span>}
    </div>
  );
}

/**
 * New purchase (/purchases/new[?supplier=&draft=]) and edit (/purchases/:id/edit).
 * Keyboard: Ctrl+S save · Ctrl+Enter add line · Enter next cell · Ctrl+Delete remove line ·
 * F2 edit cell · Esc close the open panel.
 */
export default function PurchaseEntry() {
  const toast = useToast();
  const navigate = useNavigate();
  const { id: editParam } = useParams();
  const [params] = useSearchParams();
  const editId = editParam ? Number(editParam) : null;
  const draftParam = params.get('draft');
  const supplierParam = params.get('supplier');

  const [meta, setMeta] = useState(null);
  const [form, setForm] = useState(null);
  const [original, setOriginal] = useState(null); // edit: the saved purchase
  const [draftId, setDraftId] = useState(draftParam ? Number(draftParam) : null);
  const [issues, setIssues] = useState({});
  const [supplierIssue, setSupplierIssue] = useState(null);
  const [errors, setErrors] = useState({});
  const [calc, setCalc] = useState(null);
  const [dup, setDup] = useState(null);
  const [advance, setAdvance] = useState(0);
  const [expanded, setExpanded] = useState(null);
  const [serialModal, setSerialModal] = useState(null);
  const [productDrawer, setProductDrawer] = useState(null);
  const [productMeta, setProductMeta] = useState(null);
  const [confirm, setConfirm] = useState(null); // 'mismatch' | 'leave'
  const [preview, setPreview] = useState(null);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [editReason, setEditReason] = useState('');
  const [seq, setSeq] = useState(0);
  const adderRef = useRef(null);
  const editing = Boolean(editId);

  // ------------------------------------------------------------ load
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const m = await purchasesApi.meta();
        if (cancelled) return;
        setMeta(m);
        if (editId) {
          const p = await purchasesApi.get(editId);
          if (!p.can_edit) {
            toast.error(`This purchase cannot be edited: ${p.lock_reasons[0] || ''}`);
            navigate(`/purchases?open=${editId}`, { replace: true });
            return;
          }
          const sup = await partiesApi.summary(p.party_id);
          if (cancelled) return;
          setOriginal(p);
          setForm(fromPurchase(m, p, sup));
        } else if (draftParam) {
          const d = await purchaseDraftsApi.get(Number(draftParam));
          let sup = null;
          if (Number.isInteger(d.form.party_id) && !d.supplier_issue) {
            sup = await partiesApi.summary(d.form.party_id).catch(() => null);
          }
          if (cancelled) return;
          const f = fromDraft(m, d.form, sup);
          const byUid = {};
          Object.entries(d.issues).forEach(([i, msgs]) => {
            if (f.lines[i]) byUid[f.lines[i].uid] = msgs;
          });
          setIssues(byUid);
          setSupplierIssue(d.supplier_issue);
          setForm(f);
          if (Object.keys(byUid).length) {
            toast.error('Some lines of this draft need attention (highlighted in red).');
          }
        } else {
          const sup = supplierParam
            ? await partiesApi.summary(Number(supplierParam)).catch(() => null)
            : null;
          if (!cancelled) setForm(emptyForm(m, sup));
        }
      } catch (e) {
        toast.error(e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [editId, draftParam, supplierParam, navigate, toast]);

  const update = useCallback((patch) => {
    setDirty(true);
    setForm((f) => ({ ...f, ...(typeof patch === 'function' ? patch(f) : patch) }));
  }, []);

  // ------------------------------------------------------------ live calculation
  const calcKey = form ? JSON.stringify(calcPayload(form)) : null;
  useEffect(() => {
    if (!calcKey) return undefined;
    let cancelled = false;
    const t = setTimeout(() => {
      purchasesApi
        .calculate(JSON.parse(calcKey))
        .then((r) => !cancelled && setCalc(r))
        .catch(() => {});
    }, 90);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [calcKey]);

  // Duplicate supplier bill number (live).
  const partyId = form?.party?.id ?? null;
  const billNo = form?.bill_no.trim() ?? '';
  useEffect(() => {
    if (!partyId || !billNo) return undefined;
    let cancelled = false;
    const t = setTimeout(() => {
      purchasesApi
        .checkBillNo(partyId, billNo, editId)
        .then((r) => !cancelled && setDup({ key: `${partyId}|${billNo}`, row: r.duplicate }))
        .catch(() => {});
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [partyId, billNo, editId]);
  const duplicate = dup && dup.key === `${partyId}|${billNo}` ? dup.row : null;

  useEffect(() => {
    if (!partyId || editing) return undefined;
    let cancelled = false;
    purchasesApi
      .supplierInfo(partyId)
      .then((r) => !cancelled && setAdvance(r.advance))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [partyId, editing]);

  // ------------------------------------------------------------ lines
  const setLine = useCallback(
    (i, patch) =>
      update((f) => ({ lines: f.lines.map((l, j) => (j === i ? { ...l, ...patch } : l)) })),
    [update],
  );

  function addProduct(row, { scanned }) {
    const existing = form.lines.findIndex((l) => l.variant_id === row.variant_id);
    if (existing >= 0) {
      const l = form.lines[existing];
      const qty = (parseQty(l.qty) ?? 0) + 1000;
      setLine(existing, { qty: qtyToInput(qty) });
      if (scanned) toast.info(`${row.name}: quantity ${qtyToInput(qty)}`);
      setTimeout(() => {
        const el = document.querySelector(`[data-cell="${existing}:qty"]`);
        if (!scanned && el) {
          el.focus();
          el.select();
        }
      }, 0);
      return;
    }
    const gstRates = meta.gst_rates.map((r) => r.rate_bp);
    const line = lineFromProduct(row);
    if (!gstRates.includes(line.gst_rate_bp)) line.gst_rate_bp = gstRates[0] ?? 0;
    const index = form.lines.length;
    update((f) => ({ lines: [...f.lines, line] }));
    if (!scanned) {
      setTimeout(() => {
        const el = document.querySelector(`[data-cell="${index}:qty"]`);
        el?.focus();
        el?.select();
      }, 30);
    }
  }

  function removeLine(i) {
    const l = form.lines[i];
    if (!l) return;
    update((f) => ({ lines: f.lines.filter((_, j) => j !== i) }));
    setIssues((s) => {
      const n = { ...s };
      delete n[l.uid];
      return n;
    });
    setErrors({});
  }

  async function openNewProduct(name) {
    try {
      const m = productMeta || (await productsApi.meta());
      setProductMeta(m);
      setSeq((n) => n + 1);
      setProductDrawer({ ...emptyProductForm(m), name });
    } catch (e) {
      toast.error(e);
    }
  }

  // ------------------------------------------------------------ attachments
  async function attach() {
    try {
      const files = await purchasesApi.pickAttachments();
      if (files.length) update((f) => ({ attachments: [...f.attachments, ...files] }));
    } catch (e) {
      toast.error(e);
    }
  }

  function openAttachment(a) {
    if (/\.pdf$/i.test(a.temp_path || a.file_path)) {
      purchasesApi.openAttachment({ temp_path: a.temp_path }).catch(toast.error);
    } else setPreview(a);
  }

  // ------------------------------------------------------------ save
  const grand = calc?.totals.grand_total ?? 0;

  async function save({ confirmMismatch = false } = {}) {
    if (saving) return;
    const { payload, errors: local } = toPayload(form, { grandTotal: grand, draftId, editing });
    if (Object.keys(local).length) {
      setErrors(local);
      toast.error(`Please check: ${Object.values(local)[0]}`);
      return;
    }
    if (duplicate) {
      toast.error(`Already entered: ${duplicate.entry_no} has this bill number.`);
      return;
    }
    if (calc && calc.mismatch !== 0 && payload.printed_total != null && !confirmMismatch) {
      setConfirm('mismatch');
      return;
    }
    setSaving(true);
    try {
      const body = { ...payload, confirm_mismatch: confirmMismatch, edit_reason: editReason };
      const saved = editing
        ? await purchasesApi.update(editId, body)
        : await purchasesApi.create(body);
      setDirty(false);
      toast.success(editing ? `${saved.entry_no} updated.` : `Saved ${saved.entry_no}.`);
      navigate(`/purchases?open=${saved.id}`);
    } catch (e) {
      if (e.code === 'TOTAL_MISMATCH') setConfirm('mismatch');
      setErrors(e.fields || {});
      toast.error(e);
    } finally {
      setSaving(false);
    }
  }

  async function saveDraft() {
    try {
      const r = await purchaseDraftsApi.save(draftId, toDraft(form, grand));
      setDraftId(r.id);
      setDirty(false);
      toast.success('Draft saved. Find it under Purchases → Drafts.');
      navigate('/purchases?tab=drafts');
    } catch (e) {
      toast.error(e);
    }
  }

  function leave() {
    if (dirty) setConfirm('leave');
    else navigate(-1);
  }

  useHotkeys(
    {
      'Ctrl+S': () => save(),
      'Ctrl+Enter': () => adderRef.current?.focus(),
    },
    { enabled: Boolean(form) && !serialModal && !productDrawer && !confirm },
  );
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape' && expanded && !anyOverlayOpen()) {
        e.preventDefault();
        setExpanded(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [expanded]);

  const taxLabel = useMemo(() => {
    if (!form || form.bill_type !== 'gst') return 'No GST';
    if (!meta?.business_state_code) return 'CGST + SGST (set your state in Settings)';
    return calc?.is_interstate
      ? `IGST · supplier in ${stateName(form.party?.state_code) || 'another state'}`
      : 'CGST + SGST · same state';
  }, [form, meta, calc]);

  if (!meta || !form) {
    return (
      <div className="mx-auto max-w-[1600px] space-y-4 p-6">
        <Skeleton className="h-12" />
        <Skeleton className="h-32" />
        <Skeleton className="h-72" />
      </div>
    );
  }

  const t = calc?.totals;
  const mismatch = calc && form.printed_total !== '' ? calc.mismatch : 0;
  const dueDate =
    form.party && form.party.payment_terms_days != null && form.bill_date
      ? addDays(form.bill_date, form.party.payment_terms_days)
      : null;
  const advanceUsed = advanceValue(form);
  const paidNow =
    form.pay_mode === 'full'
      ? Math.max(grand - advanceUsed, 0)
      : form.pay_mode === 'partial'
        ? (parseMoney(form.pay_amount || '0') ?? 0)
        : 0;
  const balanceDue = Math.max(grand - paidNow - advanceUsed, 0);
  const tracked = serialModal != null ? form.lines[serialModal.index] : null;

  return (
    <div className="mx-auto flex max-w-[1600px] flex-col gap-4 p-6 pt-0">
      {/* Sticky action bar */}
      <div className="sticky top-0 z-20 -mx-6 flex items-center gap-3 border-b border-border bg-bg/90 px-6 py-3 backdrop-blur">
        <Button variant="ghost" size="icon" icon={ArrowLeft} onClick={leave} aria-label="Back" />
        <div className="min-w-0">
          <h1 className="flex items-center gap-2 text-lg font-semibold">
            <Truck size={18} className="text-primary" />
            {editing ? `Edit ${original?.entry_no}` : 'New purchase'}
            {!editing && <Badge tone="neutral">{meta.next_entry_no}</Badge>}
            {draftId && !editing && <Badge tone="warning">Draft</Badge>}
          </h1>
          <p className="text-xs text-muted">
            <Kbd>Ctrl</Kbd>+<Kbd>S</Kbd> save · <Kbd>Ctrl</Kbd>+<Kbd>Enter</Kbd> add line ·{' '}
            <Kbd>Enter</Kbd> next cell · <Kbd>F2</Kbd> edit · <Kbd>Ctrl</Kbd>+<Kbd>Del</Kbd> remove
            line
          </p>
        </div>
        <div className="ml-auto flex items-center gap-3">
          <div className="text-right">
            <div className="text-xs text-muted">Grand total</div>
            <div className="text-xl font-bold tabular-nums">{formatMoney(grand)}</div>
          </div>
          {!editing && (
            <Button icon={PauseCircle} onClick={saveDraft} disabled={saving}>
              Save draft
            </Button>
          )}
          <Button variant="primary" icon={Save} onClick={() => save()} disabled={saving}>
            {saving ? 'Saving…' : editing ? 'Save changes' : 'Save purchase'}
          </Button>
        </div>
      </div>

      {/* Header */}
      <Card>
        <div className="grid grid-cols-12 gap-3">
          <Field
            label="Supplier"
            required
            error={errors.party_id || supplierIssue}
            className="col-span-12 xl:col-span-5"
          >
            {() => (
              <SupplierPicker
                value={form.party}
                autoFocus={!form.party && !editing}
                invalid={Boolean(errors.party_id)}
                onChange={(p) => {
                  setSupplierIssue(null);
                  update({ party: p, use_advance: false, advance_amount: '' });
                }}
              />
            )}
          </Field>
          <Field
            label="Supplier bill no."
            error={errors.bill_no && !duplicate ? errors.bill_no : null}
            className="col-span-4 xl:col-span-2"
          >
            {(id) => (
              <Input
                id={id}
                value={form.bill_no}
                maxLength={40}
                invalid={Boolean(duplicate || errors.bill_no)}
                placeholder="As printed"
                onChange={(e) => update({ bill_no: e.target.value })}
              />
            )}
          </Field>
          <Field
            label="Bill date"
            required
            error={errors.bill_date}
            className="col-span-4 xl:col-span-2"
          >
            {(id) => (
              <Input
                id={id}
                type="date"
                value={form.bill_date}
                onChange={(e) => update({ bill_date: e.target.value })}
              />
            )}
          </Field>
          <Field
            label="Entry date (received)"
            error={errors.entry_date}
            className="col-span-4 xl:col-span-2"
          >
            {(id) => (
              <Input
                id={id}
                type="date"
                value={form.entry_date}
                onChange={(e) => update({ entry_date: e.target.value })}
              />
            )}
          </Field>
          <div className="col-span-12 xl:col-span-1" />
          {duplicate && (
            <div className="col-span-12 flex items-center gap-3 rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
              <AlertTriangle size={16} />
              <span className="flex-1">
                Already entered: <strong>{duplicate.entry_no}</strong> (
                {formatDate(duplicate.bill_date)}, {formatMoney(duplicate.grand_total)}) has this
                supplier&apos;s bill no.
              </span>
              <Button
                size="sm"
                icon={ExternalLink}
                onClick={() => navigate(`/purchases?open=${duplicate.id}`)}
              >
                Open
              </Button>
            </div>
          )}
          <div className="col-span-12 flex flex-wrap items-center gap-3">
            <Segmented
              layoutId="pur-bill-type"
              value={form.bill_type}
              onChange={(v) => update({ bill_type: v })}
              options={[
                { value: 'gst', label: 'GST bill' },
                { value: 'non_gst', label: 'Non-GST bill' },
              ]}
            />
            {form.bill_type === 'gst' && (
              <Segmented
                layoutId="pur-price-mode"
                value={form.price_mode}
                onChange={(v) => update({ price_mode: v })}
                options={[
                  { value: 'exclusive', label: 'Rates excl. GST' },
                  { value: 'inclusive', label: 'Rates incl. GST' },
                ]}
              />
            )}
            <Badge tone={form.bill_type === 'gst' ? 'primary' : 'neutral'}>{taxLabel}</Badge>
            {meta.composition_dealer && form.bill_type === 'gst' && (
              <span className="text-xs text-muted">
                Composition dealer: GST is added to stock cost.
              </span>
            )}
            {dueDate && (
              <span className="ml-auto text-sm text-muted">Due {formatDate(dueDate)}</span>
            )}
          </div>
          {editing && (
            <Field label="Reason for this edit (kept in the audit log)" className="col-span-12">
              {(id) => (
                <Input
                  id={id}
                  value={editReason}
                  maxLength={200}
                  onChange={(e) => setEditReason(e.target.value)}
                  placeholder="e.g. rate corrected as per supplier"
                />
              )}
            </Field>
          )}
        </div>
      </Card>

      {/* Items */}
      <Card
        title={`Items (${form.lines.length})`}
        icon={Plus}
        right={errors.items && <span className="text-xs text-danger">{errors.items}</span>}
      >
        <div className="mb-3">
          <ProductAdder inputRef={adderRef} onAdd={addProduct} onNewProduct={openNewProduct} />
        </div>
        <div className="overflow-x-auto">
          <ItemGrid
            form={form}
            calc={calc}
            gstRates={meta.gst_rates}
            errors={errors}
            issues={issues}
            expanded={expanded}
            setExpanded={setExpanded}
            onLineChange={(i, patch) => {
              setLine(i, patch);
              setErrors((e) => (Object.keys(e).some((k) => k.startsWith(`items.${i}.`)) ? {} : e));
            }}
            onRemove={removeLine}
            onDismissIssue={(u) =>
              setIssues((s) => {
                const n = { ...s };
                delete n[u];
                return n;
              })
            }
            onSerials={(i) => {
              setSeq((n) => n + 1);
              setSerialModal({ index: i });
            }}
            onFocusAdder={() => adderRef.current?.focus()}
          />
        </div>
      </Card>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[1fr_26rem]">
        <div className="space-y-4">
          {/* Charges */}
          <Card
            title="Extra charges"
            right={
              <Button
                size="sm"
                icon={Plus}
                onClick={() =>
                  update((f) => ({
                    charges: [
                      ...f.charges,
                      {
                        uid: uid(),
                        kind: 'freight',
                        label: '',
                        amount: '',
                        gst_rate_bp: f.bill_type === 'gst' ? defaultChargeRate(meta) : 0,
                      },
                    ],
                  }))
                }
              >
                Add charge
              </Button>
            }
          >
            {form.charges.length === 0 ? (
              <p className="text-sm text-muted">
                Transport / freight, packing or other charges on the supplier&apos;s bill.
              </p>
            ) : (
              <div className="space-y-2">
                {form.charges.map((c, i) => (
                  <div
                    key={c.uid}
                    className="grid grid-cols-[11rem_minmax(0,1fr)_8rem_6.5rem_auto] items-center gap-2"
                  >
                    <Select
                      value={c.kind}
                      onChange={(e) =>
                        update((f) => ({
                          charges: f.charges.map((x, j) =>
                            j === i ? { ...x, kind: e.target.value } : x,
                          ),
                        }))
                      }
                    >
                      {Object.entries(meta.charge_kinds).map(([k, label]) => (
                        <option key={k} value={k}>
                          {label}
                        </option>
                      ))}
                    </Select>
                    <Input
                      value={c.label}
                      placeholder="Description (optional)"
                      maxLength={60}
                      onChange={(e) =>
                        update((f) => ({
                          charges: f.charges.map((x, j) =>
                            j === i ? { ...x, label: e.target.value } : x,
                          ),
                        }))
                      }
                    />
                    <MoneyInput
                      value={c.amount}
                      invalid={Boolean(errors[`charges.${i}.amount`])}
                      onChange={(e) =>
                        update((f) => ({
                          charges: f.charges.map((x, j) =>
                            j === i ? { ...x, amount: e.target.value } : x,
                          ),
                        }))
                      }
                    />
                    <Select
                      value={c.gst_rate_bp}
                      disabled={form.bill_type !== 'gst'}
                      onChange={(e) =>
                        update((f) => ({
                          charges: f.charges.map((x, j) =>
                            j === i ? { ...x, gst_rate_bp: Number(e.target.value) } : x,
                          ),
                        }))
                      }
                    >
                      {meta.gst_rates.map((r) => (
                        <option key={r.id} value={r.rate_bp}>
                          {formatRateBp(r.rate_bp)} GST
                        </option>
                      ))}
                    </Select>
                    <Button
                      size="icon-sm"
                      variant="danger-ghost"
                      icon={Trash2}
                      onClick={() =>
                        update((f) => ({ charges: f.charges.filter((_, j) => j !== i) }))
                      }
                    />
                  </div>
                ))}
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pt-1">
                  <Segmented
                    layoutId="pur-charges-mode"
                    value={form.charges_mode}
                    onChange={(v) => update({ charges_mode: v })}
                    options={[
                      { value: 'cost', label: 'Add to product cost' },
                      { value: 'expense', label: 'Record as expense' },
                    ]}
                  />
                  <span className="text-xs text-muted">
                    {form.charges_mode === 'cost'
                      ? 'Spread across the lines by value, so the landed cost is correct.'
                      : 'Still payable to the supplier; shown under expenses (Accounts).'}
                  </span>
                </div>
              </div>
            )}
          </Card>

          {/* Attachments & notes */}
          <Card
            title="Bill photo / PDF"
            icon={Paperclip}
            right={
              <Button size="sm" icon={Paperclip} onClick={attach}>
                Attach
              </Button>
            }
          >
            {form.attachments.length === 0 && (!original || original.attachments.length === 0) ? (
              <p className="text-sm text-muted">
                Optional. Photos or PDFs are copied into the data folder.
              </p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {(original?.attachments || []).map((a) => (
                  <span
                    key={a.id}
                    className="flex items-center gap-2 rounded-lg border border-border bg-surface-2/50 px-2 py-1 text-sm"
                  >
                    <FileText size={14} className="text-muted" /> {a.original_name}
                    <Badge>saved</Badge>
                  </span>
                ))}
                {form.attachments.map((a, i) => (
                  <span
                    key={a.temp_path}
                    className="flex items-center gap-2 rounded-lg border border-border bg-surface-2/50 px-2 py-1 text-sm"
                  >
                    <button
                      type="button"
                      className="flex items-center gap-2 hover:text-primary"
                      onClick={() => openAttachment(a)}
                    >
                      {/\.pdf$/i.test(a.temp_path) ? (
                        <FileText size={14} />
                      ) : (
                        <ImageIcon size={14} />
                      )}
                      {a.original_name}
                      <span className="text-xs text-muted">{formatBytes(a.size_bytes)}</span>
                    </button>
                    <button
                      type="button"
                      title="Remove"
                      className="rounded p-0.5 text-muted hover:text-danger"
                      onClick={() =>
                        update((f) => ({ attachments: f.attachments.filter((_, j) => j !== i) }))
                      }
                    >
                      <X size={13} />
                    </button>
                  </span>
                ))}
              </div>
            )}
            <Field label="Notes" className="mt-3">
              {(id) => (
                <Textarea
                  id={id}
                  rows={2}
                  value={form.notes}
                  maxLength={500}
                  onChange={(e) => update({ notes: e.target.value })}
                />
              )}
            </Field>
          </Card>
        </div>

        {/* Totals & payment */}
        <div className="space-y-4">
          <Card title="Totals">
            {!t ? (
              <Skeleton className="h-40" />
            ) : (
              <div className="text-sm">
                <Row label="Sub total" value={formatMoney(t.sub_total)} />
                {t.discount_total > 0 && (
                  <Row label="Discount" value={`-${formatMoney(t.discount_total)}`} muted />
                )}
                <Row label="Taxable value" value={formatMoney(t.taxable_total)} />
                {calc.tax_summary
                  .filter((r) => r.gst_rate_bp > 0)
                  .map((r) =>
                    calc.is_interstate ? (
                      <Row
                        key={r.gst_rate_bp}
                        label={`IGST ${formatRateBp(r.gst_rate_bp)} on ${formatMoney(r.taxable)}`}
                        value={formatMoney(r.igst)}
                        muted
                      />
                    ) : (
                      <div key={r.gst_rate_bp}>
                        <Row
                          label={`CGST ${formatRateBp(r.gst_rate_bp / 2)} on ${formatMoney(r.taxable)}`}
                          value={formatMoney(r.cgst)}
                          muted
                        />
                        <Row
                          label={`SGST ${formatRateBp(r.gst_rate_bp / 2)}`}
                          value={formatMoney(r.sgst)}
                          muted
                        />
                      </div>
                    ),
                  )}
                {t.charges_total > 0 && (
                  <Row label="Extra charges (incl. GST)" value={formatMoney(t.charges_total)} />
                )}
                <Row label="Round off">
                  <span className="flex items-center gap-2">
                    {form.round_off == null ? (
                      <button
                        type="button"
                        className="text-xs text-primary hover:underline"
                        onClick={() => update({ round_off: paiseToInput(t.round_off) || '0' })}
                      >
                        edit
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="text-xs text-primary hover:underline"
                        onClick={() => update({ round_off: null })}
                      >
                        auto
                      </button>
                    )}
                    {form.round_off == null ? (
                      <span className="tabular-nums">{formatMoney(t.round_off)}</span>
                    ) : (
                      <Input
                        value={form.round_off}
                        invalid={Boolean(errors.round_off)}
                        onChange={(e) => update({ round_off: e.target.value })}
                        className="h-7 w-24 text-right tabular-nums"
                      />
                    )}
                  </span>
                </Row>
                {Math.abs(roundOffInput(form) ?? 0) > meta.max_round_off && (
                  <p className="text-right text-xs text-danger">Round-off must be within ±₹5.</p>
                )}
                <div className="my-2 border-t border-border" />
                <Row label="Grand total" value={formatMoney(t.grand_total)} strong />
                <div className="mt-3">
                  <Field label="Bill total as printed" error={errors.printed_total}>
                    {(id) => (
                      <MoneyInput
                        id={id}
                        value={form.printed_total}
                        placeholder="Optional: type it to compare"
                        invalid={mismatch !== 0}
                        onChange={(e) => update({ printed_total: e.target.value })}
                      />
                    )}
                  </Field>
                  <AnimatePresence>
                    {form.printed_total !== '' && calc && (
                      <motion.p
                        initial={{ opacity: 0, y: -2 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0 }}
                        className={`mt-1 rounded-lg px-2 py-1 text-xs ${mismatch === 0 ? 'bg-success-soft text-success' : 'bg-warning-soft text-warning'}`}
                      >
                        {mismatch === 0
                          ? 'Matches the printed bill.'
                          : `Differs by ${formatMoney(Math.abs(mismatch))} (${mismatch > 0 ? 'printed is higher' : 'printed is lower'}). Check rates, discounts and charges.`}
                      </motion.p>
                    )}
                  </AnimatePresence>
                </div>
              </div>
            )}
          </Card>

          {!editing && (
            <Card title="Payment">
              <div className="space-y-3 text-sm">
                <Segmented
                  layoutId="pur-pay-mode"
                  value={form.pay_mode}
                  onChange={(v) => update({ pay_mode: v })}
                  options={[
                    { value: 'none', label: 'Not paid' },
                    { value: 'full', label: 'Paid full' },
                    { value: 'partial', label: 'Partly paid' },
                  ]}
                />
                {form.pay_mode !== 'none' && (
                  <div className="grid grid-cols-2 gap-2">
                    {form.pay_mode === 'partial' ? (
                      <Field label="Amount paid" error={errors['payment.amount']}>
                        {(id) => (
                          <MoneyInput
                            id={id}
                            value={form.pay_amount}
                            invalid={Boolean(errors['payment.amount'])}
                            onChange={(e) => update({ pay_amount: e.target.value })}
                          />
                        )}
                      </Field>
                    ) : (
                      <Field label="Amount paid">
                        {() => (
                          <div className="flex h-9 items-center justify-end px-1 font-semibold tabular-nums">
                            {formatMoney(paidNow)}
                          </div>
                        )}
                      </Field>
                    )}
                    <Field label="Mode">
                      {(id) => (
                        <Select
                          id={id}
                          value={form.pay_method}
                          onChange={(e) => update({ pay_method: e.target.value })}
                        >
                          {Object.entries(meta.payment_modes).map(([k, label]) => (
                            <option key={k} value={k}>
                              {label}
                            </option>
                          ))}
                        </Select>
                      )}
                    </Field>
                    {form.pay_method !== 'cash' && (
                      <Field
                        label={form.pay_method === 'cheque' ? 'Cheque no.' : 'Reference / UTR'}
                        error={errors['payment.ref_no']}
                        className="col-span-2"
                      >
                        {(id) => (
                          <Input
                            id={id}
                            value={form.pay_ref}
                            maxLength={40}
                            onChange={(e) => update({ pay_ref: e.target.value })}
                          />
                        )}
                      </Field>
                    )}
                  </div>
                )}
                {advance > 0 && (
                  <div className="rounded-xl border border-success/30 bg-success-soft/40 p-3">
                    <label className="flex items-center gap-2 font-medium">
                      <input
                        type="checkbox"
                        className="h-4 w-4 accent-primary"
                        checked={form.use_advance}
                        onChange={(e) =>
                          update({
                            use_advance: e.target.checked,
                            advance_amount: e.target.checked
                              ? paiseToInput(Math.min(advance, grand))
                              : '',
                          })
                        }
                      />
                      Adjust from advance ({formatMoney(advance)} available)
                    </label>
                    {form.use_advance && (
                      <MoneyInput
                        className="mt-2"
                        value={form.advance_amount}
                        invalid={Boolean(errors.advance_amount)}
                        onChange={(e) => update({ advance_amount: e.target.value })}
                      />
                    )}
                    {errors.advance_amount && (
                      <p className="mt-1 text-xs text-danger">{errors.advance_amount}</p>
                    )}
                  </div>
                )}
                <div className="flex justify-between border-t border-border pt-2 font-semibold">
                  <span>Supplier payable from this bill</span>
                  <span className="tabular-nums">{formatMoney(balanceDue)}</span>
                </div>
                {dueDate && balanceDue > 0 && (
                  <p className="text-xs text-muted">
                    Due on {formatDate(dueDate)} ({form.party.payment_terms_days} days).
                  </p>
                )}
              </div>
            </Card>
          )}
        </div>
      </div>

      {/* Overlays */}
      {tracked && (
        <SerialEntryModal
          key={`serials-${seq}`}
          open
          title={`Serial numbers: ${tracked.name}`}
          productId={tracked.product_id}
          required={(() => {
            const units = (parseQtySafe(tracked.qty) || 0) + (parseQtySafe(tracked.free) || 0);
            return units % 1000 === 0 && units > 0 ? units / 1000 : null;
          })()}
          initial={tracked.serials}
          allowIds={editing ? serialIdsOf(original, tracked.variant_id) : []}
          onCancel={() => setSerialModal(null)}
          onDone={(value) => {
            setLine(serialModal.index, { serials: value });
            setSerialModal(null);
          }}
        />
      )}
      {productDrawer && productMeta && (
        <ProductDrawer
          key={`product-${seq}`}
          open
          initial={productDrawer}
          meta={productMeta}
          onMetaChange={() =>
            productsApi
              .meta()
              .then(setProductMeta)
              .catch(() => {})
          }
          onClose={() => setProductDrawer(null)}
          onSaved={(saved) => {
            setProductDrawer(null);
            const v = saved.variants[0];
            if (v) {
              addProduct(
                {
                  variant_id: v.id,
                  product_id: saved.id,
                  name: saved.name,
                  variant_label: v.label,
                  sku: v.sku,
                  hsn_code: saved.hsn_code,
                  unit: saved.unit,
                  track_serials: saved.track_serials,
                  gst_rate_bp: saved.gst_rate_bp,
                  purchase_price: v.purchase_price,
                  mrp: v.mrp,
                  selling_price: v.selling_price,
                },
                { scanned: false },
              );
              if (saved.variants.length > 1)
                toast.info('Added the first variant; search to add the others.');
            }
          }}
        />
      )}
      <Modal
        open={Boolean(preview)}
        onClose={() => setPreview(null)}
        title={preview?.original_name}
        width="w-[60rem]"
      >
        {preview && (
          <img
            src={preview.url}
            alt={preview.original_name}
            className="mx-auto max-h-[75vh] rounded-lg"
          />
        )}
      </Modal>
      {confirm === 'mismatch' && (
        <ConfirmDialog
          title="Total does not match the printed bill"
          confirmLabel="Save anyway"
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            setConfirm(null);
            save({ confirmMismatch: true });
          }}
        >
          The calculated total is <strong>{formatMoney(grand)}</strong> but the bill says{' '}
          <strong>{formatMoney(parseMoney(form.printed_total) ?? 0)}</strong> (difference{' '}
          {formatMoney(Math.abs(mismatch))}). The bill will be flagged under &ldquo;Mismatched
          bills&rdquo; so you can review it later.
        </ConfirmDialog>
      )}
      {confirm === 'leave' && (
        <ConfirmDialog
          title="Leave without saving?"
          confirmLabel="Discard changes"
          danger
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            setConfirm(null);
            setDirty(false);
            navigate('/purchases');
          }}
        >
          The changes on this bill will be lost. Use &ldquo;Save draft&rdquo; to keep them for
          later.
        </ConfirmDialog>
      )}
    </div>
  );
}

/** Freight / packing usually carry 18% GST; else the first active rate. */
function defaultChargeRate(meta) {
  const rates = meta.gst_rates.map((r) => r.rate_bp);
  return rates.includes(1800) ? 1800 : (rates[0] ?? 0);
}

function parseQtySafe(text) {
  return parseQty(text || '0') ?? 0;
}

function roundOffInput(form) {
  return form.round_off == null ? null : parseMoney(form.round_off);
}

/** Serial rows of the purchase being edited (they may be "entered again"). */
function serialIdsOf(purchase, variantId) {
  if (!purchase) return [];
  return purchase.items
    .filter((it) => it.variant_id === variantId)
    .flatMap((it) => (it.serials || []).map((s) => s.id));
}
