import { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  Box,
  Car,
  ClipboardList,
  ImagePlus,
  Layers,
  Package,
  Plus,
  ScanBarcode,
  ShieldCheck,
  ReceiptIndianRupee,
  Trash2,
  Truck,
  Warehouse,
  Wrench,
  X,
} from 'lucide-react';
import Button from '../../components/Button';
import { Drawer, Modal } from '../../components/Overlay';
import {
  Field,
  Input,
  MoneyInput,
  Segmented,
  Select,
  Textarea,
  Toggle,
} from '../../components/Field';
import { Badge } from '../../components/Feedback';
import { useToast } from '../../components/Toast';
import { productsApi } from '../../api/products';
import { formatQty, formatRateBp } from '../../utils/qty';
import { formatMoney } from '../../utils/money';
import { emptyForm, emptyVariant, serialCount, toPayload } from './form';
import SerialEntryModal from './SerialEntryModal';
import SerialsTab from './SerialsTab';
import PurchaseHistoryTab from './PurchaseHistoryTab';
import ClaimsTab from './ClaimsTab';

function Section({ icon: Icon, title, right, children }) {
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

/** Enter in the barcode box moves on instead of submitting (scanners send Enter). */
function nextOnEnter(e) {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  const inputs = [...e.currentTarget.closest('form').querySelectorAll('input:not([disabled])')];
  inputs[inputs.indexOf(e.currentTarget) + 1]?.focus();
}

function NameModal({ open, title, fields, onClose, onSave }) {
  const [values, setValues] = useState({});
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      width="w-[26rem]"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => onSave(values)}>
            Add
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {fields.map((f, i) => (
          <Field key={f.key} label={f.label} required>
            {(id) => (
              <Input
                id={id}
                autoFocus={i === 0}
                placeholder={f.placeholder}
                value={values[f.key] || ''}
                onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                onKeyDown={(e) => e.key === 'Enter' && onSave(values)}
              />
            )}
          </Field>
        ))}
      </div>
    </Modal>
  );
}

/** Remounted (key) on every open, so the form always starts from `initial`. */
export default function ProductDrawer({
  open,
  initial,
  initialTab = 'details',
  initialSerialSearch = '',
  meta,
  onClose,
  onSaved,
  onMetaChange,
  onStockChanged,
}) {
  const toast = useToast();
  const [form, setForm] = useState(() => initial || emptyForm(meta));
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);
  const [adding, setAdding] = useState(null); // 'category' | 'subcategory' | 'vehicle'
  const [tab, setTab] = useState(initialTab);
  // Serial entry: { purpose: 'opening', index } or { purpose: 'enable', queue: [index…], pos }
  const [serialModal, setSerialModal] = useState(null);
  const [serialSeq, setSerialSeq] = useState(0);
  const nameRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const t = setTimeout(() => nameRef.current?.focus(), 250);
    return () => clearTimeout(t);
  }, [open]);

  const isEdit = Boolean(form.id);
  const service = form.product_type === 'service';
  const set = (key, value) => setForm((f) => ({ ...f, [key]: value }));
  const setVariant = (i, key, value) =>
    setForm((f) => ({
      ...f,
      variants: f.variants.map((v, j) => (j === i ? { ...v, [key]: value } : v)),
    }));
  const setVehicle = (i, key, value) =>
    setForm((f) => ({
      ...f,
      vehicles: f.vehicles.map((v, j) => (j === i ? { ...v, [key]: value } : v)),
    }));

  // Category select: top-level category + optional sub-category.
  const topCategories = meta.categories.filter((c) => c.parent_id === null);
  const selected = meta.categories.find((c) => String(c.id) === form.category_id);
  const topId = selected ? String(selected.parent_id ?? selected.id) : '';
  const subId = selected && selected.parent_id ? String(selected.id) : '';
  const subCategories = meta.categories.filter((c) => String(c.parent_id) === topId);

  const vehiclesByMake = useMemo(() => {
    const groups = {};
    for (const v of meta.vehicles) (groups[v.make] ||= []).push(v);
    return groups;
  }, [meta.vehicles]);

  const err = (key) => errors[key];
  const serialErr = (i) => {
    const k = Object.keys(errors).find((key) => key.startsWith(`variants.${i}.serials`));
    return k ? errors[k] : null;
  };
  const showSerialsTab = isEdit && (form.was_tracked || form.serials_total > 0);

  function openSerialModal(next) {
    setSerialSeq((n) => n + 1);
    setSerialModal(next);
  }

  /**
   * Turning tracking on for saved variants that already hold stock asks for exactly one
   * serial per unit, variant by variant. Cancelling leaves tracking off.
   */
  function toggleTracking(on) {
    if (!on) {
      setForm((f) => ({
        ...f,
        track_serials: false,
        variants: f.variants.map((v) => ({ ...v, serials: null })),
      }));
      return;
    }
    if (form.was_tracked) {
      set('track_serials', true);
      return;
    }
    const withStock = form.variants
      .map((v, i) => ({ v, i }))
      .filter(({ v }) => v.id && v.stock_milli !== 0);
    const bad = withStock.find(({ v }) => v.stock_milli < 0 || v.stock_milli % 1000 !== 0);
    if (bad) {
      toast.error(
        'Stock must be a whole number of units first. Use Stock adjustment to correct it.',
      );
      return;
    }
    if (withStock.length === 0) {
      set('track_serials', true);
      return;
    }
    openSerialModal({ purpose: 'enable', queue: withStock.map(({ i }) => i), pos: 0 });
  }

  function serialDone(value) {
    const m = serialModal;
    const index = m.purpose === 'opening' ? m.index : m.queue[m.pos];
    setVariant(index, 'serials', value);
    if (m.purpose === 'enable' && m.pos + 1 < m.queue.length) {
      openSerialModal({ ...m, pos: m.pos + 1 });
      return;
    }
    if (m.purpose === 'enable') set('track_serials', true);
    setSerialModal(null);
  }

  function serialCancel() {
    if (serialModal?.purpose === 'enable') {
      setForm((f) => ({
        ...f,
        variants: f.variants.map((v) => (v.id ? { ...v, serials: null } : v)),
      }));
    }
    setSerialModal(null);
  }

  const modalIndex = serialModal
    ? serialModal.purpose === 'opening'
      ? serialModal.index
      : serialModal.queue[serialModal.pos]
    : null;
  const modalVariant = modalIndex != null ? form.variants[modalIndex] : null;
  const variantName = (v) => [v.color, v.size, v.variant_type].filter(Boolean).join(' / ');

  async function save() {
    const { payload, errors: local } = toPayload(form);
    if (!payload.is_universal && payload.vehicles.length === 0) {
      local.vehicles = 'Add at least one vehicle, or mark it universal.';
    }
    if (Object.keys(local).length) {
      setErrors(local);
      toast.error('Please fix the highlighted fields.');
      return;
    }
    setSaving(true);
    try {
      const saved = isEdit
        ? await productsApi.update(form.id, payload)
        : await productsApi.create(payload);
      toast.success(isEdit ? 'Product updated.' : 'Product added.');
      onSaved(saved);
    } catch (e) {
      setErrors(e.fields || {});
      toast.error(e);
    } finally {
      setSaving(false);
    }
  }

  async function pickImage() {
    try {
      const img = await productsApi.pickImage();
      if (img) setForm((f) => ({ ...f, image_path: img.image_path, image_url: img.image_url }));
    } catch (e) {
      toast.error(e);
    }
  }

  async function addReference(values) {
    try {
      if (adding === 'vehicle') {
        const v = await productsApi.createVehicle(values.make, values.model);
        await onMetaChange();
        setForm((f) => ({
          ...f,
          is_universal: false,
          vehicles: [
            ...f.vehicles,
            {
              key: crypto.randomUUID(),
              vehicle_model_id: String(v.id),
              year_from: '',
              year_to: '',
            },
          ],
        }));
      } else {
        const parent = adding === 'subcategory' ? Number(topId) : null;
        const c = await productsApi.createCategory(values.name, parent);
        await onMetaChange();
        set('category_id', String(c.id));
      }
      setAdding(null);
    } catch (e) {
      toast.error(e);
    }
  }

  return (
    <Drawer
      open={open}
      onClose={onClose}
      width="w-[56rem]"
      title={isEdit ? 'Edit product' : 'New product'}
      subtitle={isEdit ? form.name : 'Fields marked * are required'}
      footer={
        <>
          <span className="mr-auto text-xs text-muted">Ctrl+S to save · Esc to close</span>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={save} disabled={saving}>
            {saving ? 'Saving…' : isEdit ? 'Save changes' : 'Add product'}
          </Button>
        </>
      }
    >
      {isEdit && (
        <div className="mb-4 flex gap-1 rounded-xl border border-border bg-surface-2/50 p-1">
          {[
            ['details', 'Details', Package],
            showSerialsTab && ['serials', `Serials (${form.serials_total})`, ScanBarcode],
            ['purchases', 'Purchase history', Truck],
            !service && ['claims', 'Warranty claims', ClipboardList],
          ]
            .filter(Boolean)
            .map(([id, label, Icon]) => (
              <button
                key={id}
                type="button"
                onClick={() => setTab(id)}
                className={`relative flex h-8 flex-1 items-center justify-center gap-2 rounded-lg text-sm font-medium ${
                  tab === id ? 'text-primary' : 'text-muted hover:text-fg'
                }`}
              >
                {tab === id && (
                  <motion.span
                    layoutId="drawer-tab"
                    className="absolute inset-0 rounded-lg bg-surface shadow-sm"
                    transition={{ type: 'spring', stiffness: 500, damping: 40 }}
                  />
                )}
                <Icon size={15} className="relative" />
                <span className="relative">{label}</span>
              </button>
            ))}
        </div>
      )}
      {isEdit && tab === 'purchases' && <PurchaseHistoryTab productId={form.id} />}
      {isEdit && tab === 'claims' && <ClaimsTab productId={form.id} />}
      {showSerialsTab && tab === 'serials' && (
        <SerialsTab
          productId={form.id}
          initialSearch={initialSerialSearch}
          variants={form.variants
            .filter((v) => v.id)
            .map((v) => ({ id: v.id, sku: v.sku, label: variantName(v) }))}
          onChanged={onStockChanged}
        />
      )}
      <form
        hidden={
          (showSerialsTab && tab === 'serials') ||
          (isEdit && (tab === 'purchases' || tab === 'claims'))
        }
        className="space-y-4"
        onSubmit={(e) => e.preventDefault()}
        onKeyDown={(e) => {
          if (e.ctrlKey && e.key.toLowerCase() === 's') {
            e.preventDefault();
            save();
          }
        }}
      >
        <Section
          icon={Package}
          title="Basic details"
          right={
            <Segmented
              layoutId="ptype"
              value={form.product_type}
              onChange={(v) => !isEdit && set('product_type', v)}
              options={[
                { value: 'stock', label: 'Stock item', icon: Box },
                { value: 'service', label: 'Service', icon: Wrench },
              ]}
            />
          }
        >
          <div className="flex gap-4">
            <button
              type="button"
              onClick={pickImage}
              className="group relative flex h-28 w-28 shrink-0 items-center justify-center overflow-hidden rounded-xl border-2 border-dashed border-border bg-surface text-muted transition-colors hover:border-primary hover:text-primary"
              title="Choose photo"
            >
              {form.image_url ? (
                <>
                  <img src={form.image_url} alt="" className="h-full w-full object-cover" />
                  <span
                    role="button"
                    tabIndex={-1}
                    onClick={(e) => {
                      e.stopPropagation();
                      setForm((f) => ({ ...f, image_path: null, image_url: null }));
                    }}
                    className="absolute top-1 right-1 rounded-full bg-surface/90 p-1 opacity-0 group-hover:opacity-100"
                  >
                    <X size={12} />
                  </span>
                </>
              ) : (
                <span className="flex flex-col items-center gap-1 text-xs">
                  <ImagePlus size={22} />
                  Photo
                </span>
              )}
            </button>
            <div className="grid flex-1 grid-cols-2 gap-3">
              <Field label="Name" required error={err('name')} className="col-span-2">
                {(id) => (
                  <Input
                    id={id}
                    ref={nameRef}
                    value={form.name}
                    invalid={Boolean(err('name'))}
                    onChange={(e) => set('name', e.target.value)}
                    placeholder={
                      service ? 'e.g. Seat cover fitting' : 'e.g. Premium leather seat cover'
                    }
                  />
                )}
              </Field>
              <Field label="Category" error={err('category_id')}>
                {(id) => (
                  <div className="flex gap-1">
                    <Select
                      id={id}
                      value={topId}
                      onChange={(e) => set('category_id', e.target.value)}
                    >
                      <option value="">— None —</option>
                      {topCategories.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </Select>
                    <Button
                      size="icon"
                      icon={Plus}
                      title="New category"
                      onClick={() => setAdding('category')}
                    />
                  </div>
                )}
              </Field>
              <Field label="Sub-category">
                {(id) => (
                  <div className="flex gap-1">
                    <Select
                      id={id}
                      value={subId}
                      disabled={!topId}
                      onChange={(e) => set('category_id', e.target.value || topId)}
                    >
                      <option value="">— None —</option>
                      {subCategories.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </Select>
                    <Button
                      size="icon"
                      icon={Plus}
                      title="New sub-category"
                      disabled={!topId}
                      onClick={() => setAdding('subcategory')}
                    />
                  </div>
                )}
              </Field>
            </div>
          </div>
          <div className="mt-3 grid grid-cols-3 gap-3">
            <Field label="Brand" error={err('brand')}>
              {(id) => (
                <>
                  <Input
                    id={id}
                    list="brand-list"
                    value={form.brand}
                    onChange={(e) => set('brand', e.target.value)}
                  />
                  <datalist id="brand-list">
                    {meta.brands.map((b) => (
                      <option key={b} value={b} />
                    ))}
                  </datalist>
                </>
              )}
            </Field>
            <Field label="Unit" error={err('unit')}>
              {(id) => (
                <Select id={id} value={form.unit} onChange={(e) => set('unit', e.target.value)}>
                  {meta.units.map((u) => (
                    <option key={u} value={u}>
                      {u}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Status">
              {() => (
                <Segmented
                  layoutId="pactive"
                  value={form.is_active ? 'on' : 'off'}
                  onChange={(v) => set('is_active', v === 'on')}
                  options={[
                    { value: 'on', label: 'Active' },
                    { value: 'off', label: 'Inactive' },
                  ]}
                />
              )}
            </Field>
          </div>
        </Section>

        <Section icon={ReceiptIndianRupee} title="Tax">
          <div className="grid grid-cols-3 gap-3">
            <Field label="GST %" error={err('gst_rate_bp')}>
              {(id) => (
                <Select
                  id={id}
                  value={form.gst_rate_bp}
                  onChange={(e) => set('gst_rate_bp', e.target.value)}
                >
                  <option value="0">No GST</option>
                  {form.gst_rate_bp !== '0' &&
                    !meta.gst_rates.some((r) => String(r.rate_bp) === form.gst_rate_bp) && (
                      <option value={form.gst_rate_bp}>
                        {formatRateBp(Number(form.gst_rate_bp))} (removed)
                      </option>
                    )}
                  {meta.gst_rates
                    .filter((r) => r.rate_bp !== 0)
                    .map((r) => (
                      <option key={r.id} value={r.rate_bp}>
                        {formatRateBp(r.rate_bp)}
                      </option>
                    ))}
                </Select>
              )}
            </Field>
            <Field
              label={service ? 'SAC code' : 'HSN code'}
              error={err('hsn_code')}
              hint="Printed on GST invoices"
            >
              {(id) => (
                <Input
                  id={id}
                  inputMode="numeric"
                  value={form.hsn_code}
                  invalid={Boolean(err('hsn_code'))}
                  onChange={(e) => set('hsn_code', e.target.value.replace(/\D/g, ''))}
                  placeholder={service ? 'e.g. 998714' : 'e.g. 8708'}
                />
              )}
            </Field>
            <Field label="Prices entered">
              {() => (
                <Segmented
                  layoutId="pincl"
                  value={form.price_includes_gst ? 'incl' : 'excl'}
                  onChange={(v) => set('price_includes_gst', v === 'incl')}
                  options={[
                    { value: 'incl', label: 'Incl. GST' },
                    { value: 'excl', label: 'Excl. GST' },
                  ]}
                />
              )}
            </Field>
          </div>
        </Section>

        <Section
          icon={Layers}
          title={service ? 'Charge' : 'Prices & stock'}
          right={
            !service && (
              <Toggle
                label="Has variants (colour / size / type)"
                checked={form.has_variants}
                onChange={(v) =>
                  setForm((f) => ({
                    ...f,
                    has_variants: v,
                    variants: v ? f.variants : f.variants.slice(0, 1),
                  }))
                }
              />
            )
          }
        >
          {!service && (
            <div className="mb-3 rounded-xl border border-border bg-surface px-3 py-2">
              <Toggle
                label="Track serial numbers"
                description="One serial / warranty number per unit (speakers, music systems, cameras…)."
                checked={form.track_serials}
                onChange={toggleTracking}
              />
              {err('track_serials') && (
                <p className="text-xs text-danger">{err('track_serials')}</p>
              )}
            </div>
          )}
          {err('variants') && <p className="mb-2 text-xs text-danger">{err('variants')}</p>}
          <div className="space-y-3">
            <AnimatePresence initial={false}>
              {form.variants.map((v, i) => {
                const f = (k) => err(`variants.${i}.${k}`);
                return (
                  <motion.div
                    key={v.key}
                    layout
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    exit={{ opacity: 0, height: 0 }}
                    transition={{ duration: 0.18 }}
                    className="overflow-hidden"
                  >
                    <div className="rounded-xl border border-border bg-surface p-3">
                      {form.has_variants && (
                        <div className="mb-3 grid grid-cols-[1fr_1fr_1fr_auto] items-end gap-3">
                          <Field label="Colour" error={f('color')}>
                            {(id) => (
                              <Input
                                id={id}
                                value={v.color}
                                invalid={Boolean(f('color'))}
                                onChange={(e) => setVariant(i, 'color', e.target.value)}
                                placeholder="Black"
                              />
                            )}
                          </Field>
                          <Field label="Size">
                            {(id) => (
                              <Input
                                id={id}
                                value={v.size}
                                onChange={(e) => setVariant(i, 'size', e.target.value)}
                                placeholder="Standard"
                              />
                            )}
                          </Field>
                          <Field label="Type">
                            {(id) => (
                              <Input
                                id={id}
                                value={v.variant_type}
                                onChange={(e) => setVariant(i, 'variant_type', e.target.value)}
                                placeholder="Leatherette"
                              />
                            )}
                          </Field>
                          <Button
                            variant="danger-ghost"
                            size="icon"
                            icon={Trash2}
                            title={
                              v.stock_milli ? 'Has stock: adjust to zero first' : 'Remove variant'
                            }
                            disabled={form.variants.length === 1 || v.stock_milli !== 0}
                            onClick={() =>
                              set(
                                'variants',
                                form.variants.filter((_, j) => j !== i),
                              )
                            }
                          />
                        </div>
                      )}
                      <div className={`grid gap-3 ${service ? 'grid-cols-3' : 'grid-cols-4'}`}>
                        <Field
                          label="SKU / code"
                          error={f('sku')}
                          hint={!v.sku ? 'Auto if empty' : undefined}
                        >
                          {(id) => (
                            <Input
                              id={id}
                              value={v.sku}
                              invalid={Boolean(f('sku'))}
                              onChange={(e) =>
                                setVariant(i, 'sku', e.target.value.replace(/\s/g, ''))
                              }
                            />
                          )}
                        </Field>
                        {!service && (
                          <Field label="Barcode" error={f('barcode')}>
                            {(id) => (
                              <Input
                                id={id}
                                value={v.barcode}
                                invalid={Boolean(f('barcode'))}
                                onKeyDown={nextOnEnter}
                                onChange={(e) => setVariant(i, 'barcode', e.target.value.trim())}
                                placeholder="Scan or type"
                              />
                            )}
                          </Field>
                        )}
                        <Field label="MRP" error={f('mrp')}>
                          {(id) => (
                            <MoneyInput
                              id={id}
                              value={v.mrp}
                              invalid={Boolean(f('mrp'))}
                              onChange={(e) => setVariant(i, 'mrp', e.target.value)}
                            />
                          )}
                        </Field>
                        <Field label="Selling price" required error={f('selling_price')}>
                          {(id) => (
                            <MoneyInput
                              id={id}
                              value={v.selling_price}
                              invalid={Boolean(f('selling_price'))}
                              onChange={(e) => setVariant(i, 'selling_price', e.target.value)}
                            />
                          )}
                        </Field>
                        {!service && (
                          <>
                            <Field label="Purchase price" error={f('purchase_price')}>
                              {(id) => (
                                <MoneyInput
                                  id={id}
                                  value={v.purchase_price}
                                  invalid={Boolean(f('purchase_price'))}
                                  onChange={(e) => setVariant(i, 'purchase_price', e.target.value)}
                                />
                              )}
                            </Field>
                            {v.id ? (
                              <Field
                                label="Current stock"
                                error={serialErr(i)}
                                hint={
                                  v.serials
                                    ? `${serialCount(v.serials)} serials ready to save`
                                    : 'Change with Stock adjustment'
                                }
                              >
                                {() => (
                                  <div className="flex h-9 items-center rounded-lg bg-surface-2 px-3 font-medium tabular-nums">
                                    {formatQty(v.stock_milli)} {form.unit}
                                  </div>
                                )}
                              </Field>
                            ) : form.track_serials ? (
                              <Field label="Opening stock (serials)" error={serialErr(i)}>
                                {() => (
                                  <Button
                                    icon={ScanBarcode}
                                    className={`w-full justify-center ${serialErr(i) ? 'border-danger' : ''}`}
                                    onClick={() =>
                                      openSerialModal({ purpose: 'opening', index: i })
                                    }
                                  >
                                    {serialCount(v.serials)
                                      ? `${serialCount(v.serials)} serial${serialCount(v.serials) === 1 ? '' : 's'}`
                                      : 'Enter serials'}
                                  </Button>
                                )}
                              </Field>
                            ) : (
                              <Field label="Opening stock" error={f('opening_stock_milli')}>
                                {(id) => (
                                  <Input
                                    id={id}
                                    inputMode="decimal"
                                    value={v.opening_stock}
                                    invalid={Boolean(f('opening_stock_milli'))}
                                    onChange={(e) => setVariant(i, 'opening_stock', e.target.value)}
                                    placeholder="0"
                                  />
                                )}
                              </Field>
                            )}
                            <Field label="Min stock (alert)" error={f('min_stock_milli')}>
                              {(id) => (
                                <Input
                                  id={id}
                                  inputMode="decimal"
                                  value={v.min_stock}
                                  invalid={Boolean(f('min_stock_milli'))}
                                  onChange={(e) => setVariant(i, 'min_stock', e.target.value)}
                                  placeholder="0"
                                />
                              )}
                            </Field>
                          </>
                        )}
                      </div>
                    </div>
                  </motion.div>
                );
              })}
            </AnimatePresence>
            {form.has_variants && (
              <Button
                size="sm"
                icon={Plus}
                onClick={() => set('variants', [...form.variants, emptyVariant()])}
              >
                Add variant
              </Button>
            )}
          </div>
        </Section>

        {!service && (
          <Section
            icon={Car}
            title="Vehicle compatibility"
            right={
              <Toggle
                label="Universal (fits all cars)"
                checked={form.is_universal}
                onChange={(v) => set('is_universal', v)}
              />
            }
          >
            {form.is_universal ? (
              <p className="text-sm text-muted">Shown for every vehicle in search and filters.</p>
            ) : (
              <div className="space-y-2">
                {err('vehicles') && <p className="text-xs text-danger">{err('vehicles')}</p>}
                <AnimatePresence initial={false}>
                  {form.vehicles.map((v, i) => (
                    <motion.div
                      key={v.key}
                      initial={{ opacity: 0, x: -8 }}
                      animate={{ opacity: 1, x: 0 }}
                      exit={{ opacity: 0, x: 8 }}
                      className="grid grid-cols-[1fr_7rem_7rem_auto] items-start gap-2"
                    >
                      <div>
                        <Select
                          value={v.vehicle_model_id}
                          onChange={(e) => setVehicle(i, 'vehicle_model_id', e.target.value)}
                          className={err(`vehicles.${i}`) ? 'border-danger' : ''}
                        >
                          <option value="">Choose make / model…</option>
                          {Object.entries(vehiclesByMake).map(([make, models]) => (
                            <optgroup key={make} label={make}>
                              {models.map((m) => (
                                <option key={m.id} value={m.id}>
                                  {make} {m.model}
                                </option>
                              ))}
                            </optgroup>
                          ))}
                        </Select>
                        {err(`vehicles.${i}`) && (
                          <p className="mt-1 text-xs text-danger">{err(`vehicles.${i}`)}</p>
                        )}
                      </div>
                      <Input
                        placeholder="From year"
                        inputMode="numeric"
                        maxLength={4}
                        value={v.year_from}
                        onChange={(e) =>
                          setVehicle(i, 'year_from', e.target.value.replace(/\D/g, ''))
                        }
                      />
                      <Input
                        placeholder="To year"
                        inputMode="numeric"
                        maxLength={4}
                        value={v.year_to}
                        onChange={(e) =>
                          setVehicle(i, 'year_to', e.target.value.replace(/\D/g, ''))
                        }
                      />
                      <Button
                        variant="danger-ghost"
                        size="icon"
                        icon={Trash2}
                        onClick={() =>
                          set(
                            'vehicles',
                            form.vehicles.filter((_, j) => j !== i),
                          )
                        }
                      />
                    </motion.div>
                  ))}
                </AnimatePresence>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    icon={Plus}
                    onClick={() =>
                      set('vehicles', [
                        ...form.vehicles,
                        {
                          key: crypto.randomUUID(),
                          vehicle_model_id: '',
                          year_from: '',
                          year_to: '',
                        },
                      ])
                    }
                  >
                    Add vehicle
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setAdding('vehicle')}>
                    Model not in list?
                  </Button>
                </div>
              </div>
            )}
          </Section>
        )}

        <Section icon={ShieldCheck} title="Warranty">
          <div className="grid grid-cols-3 gap-3">
            <Field
              label="Customer warranty (months)"
              error={err('customer_warranty_months')}
              hint="Default for units sold"
            >
              {(id) => (
                <Input
                  id={id}
                  inputMode="numeric"
                  value={form.customer_warranty_months}
                  onChange={(e) =>
                    set('customer_warranty_months', e.target.value.replace(/\D/g, ''))
                  }
                  placeholder="0"
                />
              )}
            </Field>
            {!service && (
              <Field
                label="Supplier warranty (months)"
                error={err('supplier_warranty_months')}
                hint="From purchase date"
              >
                {(id) => (
                  <Input
                    id={id}
                    inputMode="numeric"
                    value={form.supplier_warranty_months}
                    onChange={(e) =>
                      set('supplier_warranty_months', e.target.value.replace(/\D/g, ''))
                    }
                    placeholder="0"
                  />
                )}
              </Field>
            )}
            {!service && (
              <Field label="Warranty starts from">
                {() => (
                  <Segmented
                    layoutId="wbasis"
                    value={form.warranty_start_basis}
                    onChange={(v) => set('warranty_start_basis', v)}
                    options={[
                      { value: 'sale', label: 'Sale date' },
                      { value: 'purchase', label: 'Purchase date' },
                    ]}
                  />
                )}
              </Field>
            )}
          </div>
          {!service && (
            <div className="mt-3 grid grid-cols-2 gap-3">
              <Field
                label="What's covered"
                error={err('warranty_covered')}
                hint="Printed on claim slips and warranty cards"
              >
                {(id) => (
                  <Textarea
                    id={id}
                    rows={2}
                    maxLength={600}
                    value={form.warranty_covered}
                    onChange={(e) => set('warranty_covered', e.target.value)}
                    placeholder="Manufacturing defects, no sound, display failure…"
                  />
                )}
              </Field>
              <Field label="Not covered" error={err('warranty_not_covered')}>
                {(id) => (
                  <Textarea
                    id={id}
                    rows={2}
                    maxLength={600}
                    value={form.warranty_not_covered}
                    onChange={(e) => set('warranty_not_covered', e.target.value)}
                    placeholder="Physical / water damage, burnt, seal broken, wrong fitting…"
                  />
                )}
              </Field>
            </div>
          )}
        </Section>

        {!service && (
          <Section icon={Wrench} title="Fitting">
            <div className="grid grid-cols-3 gap-3">
              <Field
                label="Default fitting service"
                error={err('fitting_variant_id')}
                hint="Added below this product on a bill"
                className="col-span-2"
              >
                {(id) => (
                  <Select
                    id={id}
                    value={form.fitting_variant_id}
                    onChange={(e) => set('fitting_variant_id', e.target.value)}
                  >
                    <option value="">No fitting</option>
                    {(meta.services || []).map((s) => (
                      <option key={s.variant_id} value={s.variant_id}>
                        {s.name}
                        {s.variant_label ? ` · ${s.variant_label}` : ''} (
                        {formatMoney(s.selling_price)})
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              {form.fitting_variant_id && (
                <Field
                  label="Fitting charge"
                  error={err('fitting_charge')}
                  hint="Empty = the service's price; 0 = free fitting"
                >
                  {(id) => (
                    <MoneyInput
                      id={id}
                      value={form.fitting_charge}
                      onChange={(e) => set('fitting_charge', e.target.value)}
                    />
                  )}
                </Field>
              )}
              {(meta.services || []).length === 0 && (
                <p className="col-span-3 text-xs text-muted">
                  Add a product of type &ldquo;Service&rdquo; (e.g. &ldquo;Seat cover
                  fitting&rdquo;) to choose it here.
                </p>
              )}
            </div>
          </Section>
        )}

        <Section icon={Warehouse} title="Other details">
          <div className="grid grid-cols-3 gap-3">
            {!service && (
              <Field label="Rack / shelf" error={err('rack_location')}>
                {(id) => (
                  <Input
                    id={id}
                    value={form.rack_location}
                    onChange={(e) => set('rack_location', e.target.value)}
                    placeholder="e.g. A-3"
                  />
                )}
              </Field>
            )}
            {isEdit && form.variants.some((v) => v.stock_milli) && (
              <div className="flex items-end">
                <Badge tone="primary">Stock changes only via Stock adjustment</Badge>
              </div>
            )}
          </div>
          <Field label="Notes" className="mt-3" error={err('notes')}>
            {(id) => (
              <Textarea id={id} value={form.notes} onChange={(e) => set('notes', e.target.value)} />
            )}
          </Field>
        </Section>
      </form>

      <SerialEntryModal
        key={`serials-${serialSeq}`}
        open={Boolean(serialModal)}
        productId={form.id}
        title={
          modalVariant && variantName(modalVariant)
            ? `Serial numbers · ${variantName(modalVariant)}`
            : 'Serial numbers'
        }
        required={serialModal?.purpose === 'enable' ? modalVariant.stock_milli / 1000 : null}
        initial={modalVariant?.serials}
        onDone={serialDone}
        onCancel={serialCancel}
      />
      <NameModal
        key={`cat-${adding}`}
        open={adding === 'category' || adding === 'subcategory'}
        title={adding === 'subcategory' ? 'New sub-category' : 'New category'}
        fields={[
          {
            key: 'name',
            label: 'Name',
            placeholder: adding === 'subcategory' ? 'e.g. Leather' : 'e.g. Tyres',
          },
        ]}
        onClose={() => setAdding(null)}
        onSave={addReference}
      />
      <NameModal
        key={`veh-${adding}`}
        open={adding === 'vehicle'}
        title="Add vehicle model"
        fields={[
          { key: 'make', label: 'Make', placeholder: 'e.g. Maruti Suzuki' },
          { key: 'model', label: 'Model', placeholder: 'e.g. Swift' },
        ]}
        onClose={() => setAdding(null)}
        onSave={addReference}
      />
    </Drawer>
  );
}
