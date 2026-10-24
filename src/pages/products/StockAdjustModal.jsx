import { useEffect, useState } from 'react';
import { Minus, Plus, ScanBarcode, Search } from 'lucide-react';
import Button from '../../components/Button';
import { Modal } from '../../components/Overlay';
import { Field, Input, Segmented, Select } from '../../components/Field';
import { Badge } from '../../components/Feedback';
import { useToast } from '../../components/Toast';
import { serialsApi, stockApi } from '../../api/products';
import { formatQty, parseQty } from '../../utils/qty';
import { todayISO } from '../../utils/dates';
import SerialEntryModal from './SerialEntryModal';
import { serialCount } from './form';

const REASONS = {
  add: [
    'Stock count correction',
    'Found in godown',
    'Received without bill',
    'Customer returned (no bill)',
  ],
  remove: [
    'Damaged',
    'Stock count correction',
    'Used for display / demo',
    'Lost / theft',
    'Expired',
  ],
};

/** Pick in-stock units (by serial) to remove. */
function SerialPicker({ variantId, selected, onChange }) {
  const toast = useToast();
  const [search, setSearch] = useState('');
  const [result, setResult] = useState({ key: null, rows: [] });
  const key = `${variantId}|${search.trim()}`;

  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(() => {
      serialsApi
        .inStock(Number(variantId), search.trim())
        .then((rows) => !cancelled && setResult({ key, rows }))
        .catch(toast.error);
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, toast]);

  const toggle = (id) =>
    onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);

  return (
    <div className="space-y-2">
      <div className="relative">
        <Search
          size={15}
          className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted"
        />
        <Input
          autoFocus
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => {
            // Scanner: Enter selects the exact match.
            if (e.key === 'Enter') {
              e.preventDefault();
              e.stopPropagation();
              const hit = result.rows.find(
                (r) => r.serial_no.toUpperCase() === search.trim().toUpperCase(),
              );
              if (hit && !selected.includes(hit.id)) onChange([...selected, hit.id]);
              setSearch('');
            }
          }}
          placeholder="Scan or search serial…"
          className="pl-9"
        />
      </div>
      <ul className="max-h-48 divide-y divide-border overflow-auto rounded-xl border border-border">
        {result.rows.length === 0 && (
          <li className="px-3 py-4 text-center text-sm text-muted">No units in stock.</li>
        )}
        {result.rows.map((r) => (
          <li key={r.id}>
            <label className="flex cursor-pointer items-center gap-3 px-3 py-1.5 text-sm hover:bg-surface-2">
              <input
                type="checkbox"
                checked={selected.includes(r.id)}
                onChange={() => toggle(r.id)}
                className="accent-primary"
              />
              <span className="font-mono">{r.serial_no}</span>
              {r.serial_no_2 && <span className="font-mono text-muted">/ {r.serial_no_2}</span>}
              {r.is_auto === 1 && <Badge tone="primary">Auto</Badge>}
            </label>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Remounted (key) per open. Add or remove stock with a reason; creates an 'adjustment'
 * movement, nothing is overwritten. Serial-tracked items add units by serial number and
 * remove chosen units (marked Defective or Written off).
 */
export default function StockAdjustModal({ product, onClose, onDone }) {
  const toast = useToast();
  const [variantId, setVariantId] = useState(() => String(product?.variants[0]?.id ?? ''));
  const [mode, setMode] = useState('add');
  const [qty, setQty] = useState('');
  const [serials, setSerials] = useState(null);
  const [serialModalOpen, setSerialModalOpen] = useState(false);
  const [picked, setPicked] = useState([]);
  const [toStatus, setToStatus] = useState('defective');
  const [reason, setReason] = useState('');
  const [date, setDate] = useState(todayISO());
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);

  const tracked = Boolean(product?.track_serials);
  const variant = product?.variants.find((v) => String(v.id) === variantId);
  const qtyMilli = tracked
    ? (mode === 'add' ? serialCount(serials) : picked.length) * 1000
    : parseQty(qty);
  const after =
    variant && qtyMilli ? variant.stock_milli + (mode === 'add' ? qtyMilli : -qtyMilli) : null;

  function changeVariant(id) {
    setVariantId(id);
    setSerials(null);
    setPicked([]);
  }

  async function submit() {
    const local = {};
    if (!qtyMilli || qtyMilli <= 0) {
      local.qty_milli = tracked
        ? mode === 'add'
          ? 'Enter serial numbers.'
          : 'Choose units.'
        : 'Enter a quantity.';
    }
    if (!reason.trim()) local.reason = 'A reason is required.';
    if (Object.keys(local).length) return setErrors(local);
    setBusy(true);
    try {
      const base = { variant_id: Number(variantId), reason: reason.trim(), date };
      if (!tracked)
        await stockApi.adjust({ ...base, qty_milli: mode === 'add' ? qtyMilli : -qtyMilli });
      else if (mode === 'add') await stockApi.adjust({ ...base, serials });
      else await stockApi.adjust({ ...base, serial_ids: picked, to_status: toStatus });
      toast.success('Stock updated.');
      onDone();
    } catch (e) {
      setErrors(e.fields || {});
      toast.error(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={Boolean(product)}
      onClose={onClose}
      title="Stock adjustment"
      width={tracked ? 'w-[36rem]' : 'w-[32rem]'}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={submit} disabled={busy}>
            {busy ? 'Saving…' : 'Save adjustment'}
          </Button>
        </>
      }
    >
      {product && (
        <div
          className="space-y-4"
          onKeyDown={(e) =>
            !tracked && e.key === 'Enter' && e.target.tagName === 'INPUT' && submit()
          }
        >
          <div className="flex items-center gap-2 font-medium">
            {product.name}
            {tracked && <Badge tone="primary">Serial numbers</Badge>}
          </div>
          {product.variants.length > 1 && (
            <Field label="Variant">
              {(id) => (
                <Select id={id} value={variantId} onChange={(e) => changeVariant(e.target.value)}>
                  {product.variants.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.label || v.sku} · in stock {formatQty(v.stock_milli)}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          )}
          <div className="flex items-end gap-3">
            <Segmented
              layoutId="adj-mode"
              value={mode}
              onChange={(m) => {
                setMode(m);
                setErrors({});
              }}
              options={[
                { value: 'add', label: 'Add', icon: Plus },
                { value: 'remove', label: 'Remove', icon: Minus },
              ]}
            />
            {!tracked && (
              <Field
                label={`Quantity (${product.unit})`}
                error={errors.qty_milli}
                className="flex-1"
              >
                {(id) => (
                  <Input
                    id={id}
                    autoFocus
                    inputMode="decimal"
                    value={qty}
                    invalid={Boolean(errors.qty_milli)}
                    onChange={(e) => setQty(e.target.value)}
                  />
                )}
              </Field>
            )}
            {tracked && mode === 'add' && (
              <Field label="Units" error={errors.qty_milli || errors.serials} className="flex-1">
                {() => (
                  <Button
                    icon={ScanBarcode}
                    className="w-full justify-center"
                    onClick={() => setSerialModalOpen(true)}
                  >
                    {serialCount(serials)
                      ? `${serialCount(serials)} serial number(s)`
                      : 'Enter serial numbers'}
                  </Button>
                )}
              </Field>
            )}
            {tracked && mode === 'remove' && (
              <Field label="Mark removed units as" className="flex-1">
                {() => (
                  <Segmented
                    layoutId="adj-to"
                    value={toStatus}
                    onChange={setToStatus}
                    options={[
                      { value: 'defective', label: 'Defective' },
                      { value: 'written_off', label: 'Written off' },
                    ]}
                  />
                )}
              </Field>
            )}
            <Field label="Date" error={errors.date}>
              {(id) => (
                <Input
                  id={id}
                  type="date"
                  value={date}
                  max={todayISO()}
                  onChange={(e) => setDate(e.target.value)}
                />
              )}
            </Field>
          </div>

          {tracked && mode === 'remove' && variant && (
            <Field label={`Units to remove (${picked.length} chosen)`} error={errors.qty_milli}>
              {() => <SerialPicker variantId={variantId} selected={picked} onChange={setPicked} />}
            </Field>
          )}

          {variant && (
            <div className="flex gap-6 rounded-xl bg-surface-2 px-4 py-3 text-sm">
              <span>
                Now: <strong className="tabular-nums">{formatQty(variant.stock_milli)}</strong>
              </span>
              <span>
                After:{' '}
                <strong
                  className={`tabular-nums ${after !== null && after < 0 ? 'text-danger' : 'text-primary'}`}
                >
                  {after === null ? '—' : formatQty(after)}
                </strong>
              </span>
            </div>
          )}
          <Field label="Reason" required error={errors.reason}>
            {(id) => (
              <>
                <Input
                  id={id}
                  value={reason}
                  invalid={Boolean(errors.reason)}
                  maxLength={200}
                  onChange={(e) => setReason(e.target.value)}
                />
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {REASONS[mode].map((r) => (
                    <button
                      key={r}
                      type="button"
                      onClick={() => setReason(r)}
                      className="rounded-full border border-border px-2.5 py-0.5 text-xs text-muted hover:border-primary hover:text-primary"
                    >
                      {r}
                    </button>
                  ))}
                </div>
              </>
            )}
          </Field>
        </div>
      )}
      {tracked && (
        <SerialEntryModal
          key={`adj-serials-${serialModalOpen}`}
          open={serialModalOpen}
          title="Serial numbers of units to add"
          productId={product.id}
          required={null}
          initial={serials}
          onDone={(value) => {
            setSerials(value);
            setSerialModalOpen(false);
          }}
          onCancel={() => setSerialModalOpen(false)}
        />
      )}
    </Modal>
  );
}
