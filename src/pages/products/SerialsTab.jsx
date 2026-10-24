import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { CalendarClock, ChevronDown, History, Search } from 'lucide-react';
import Button from '../../components/Button';
import { Field, Input } from '../../components/Field';
import { Badge, EmptyState, Skeleton } from '../../components/Feedback';
import { useToast } from '../../components/Toast';
import { serialsApi } from '../../api/products';
import { formatDate } from '../../utils/dates';

export const SERIAL_STATUS = {
  in_stock: { label: 'In stock', tone: 'success' },
  sold: { label: 'Sold', tone: 'primary' },
  returned_to_supplier: { label: 'Returned to supplier', tone: 'neutral' },
  under_claim: { label: 'Under claim', tone: 'info' },
  replaced: { label: 'Replaced', tone: 'neutral' },
  defective: { label: 'Defective', tone: 'danger' },
  written_off: { label: 'Written off', tone: 'neutral' },
  voided: { label: 'Voided', tone: 'neutral' },
};

const WARRANTY = {
  active: { label: 'Active', tone: 'success' },
  expiring: { label: 'Expiring soon', tone: 'warning' },
  expired: { label: 'Expired', tone: 'danger' },
};

const EVENT_LABELS = {
  received_opening: 'Added (opening stock)',
  tracking_enabled: 'Serial recorded for existing stock',
  adjusted_in: 'Added (stock adjustment)',
  purchased: 'Purchased',
  sold: 'Sold',
  sale_returned: 'Returned by customer',
  sale_cancelled: 'Sale cancelled',
  returned_to_supplier: 'Returned to supplier',
  marked_defective: 'Marked defective',
  written_off: 'Written off',
  repaired_to_stock: 'Repaired, back in stock',
  warranty_changed: 'Warranty changed',
  claim_received: 'Warranty claim received',
  claim_sent: 'Sent to supplier',
  claim_repaired: 'Repaired under warranty',
  claim_replaced: 'Replaced under warranty',
  claim_rejected: 'Claim rejected',
  claim_returned: 'Returned to customer',
  replacement_issued: 'Issued as replacement',
  claim_back: 'Back from supplier',
  claim_refunded: 'Refunded under warranty',
  claim_cancelled: 'Claim cancelled',
  warranty_voided: 'Warranty voided',
  supplier_replacement_received: 'Received from supplier (replacement)',
  returned_by_customer: 'Returned by customer',
  received_purchase: 'Purchased',
  purchase_edited: 'Purchase edited',
  return_cancelled: 'Supplier return cancelled',
  voided: 'Removed from purchase',
};

// Status changes allowed by hand here; sales, purchases and claims use their own screens.
const ACTIONS = {
  in_stock: [
    { to: 'defective', label: 'Mark defective' },
    { to: 'written_off', label: 'Write off' },
  ],
  defective: [
    { to: 'in_stock', label: 'Repaired: back to stock' },
    { to: 'written_off', label: 'Write off' },
  ],
};

function SerialDetail({ id, onChanged }) {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [form, setForm] = useState(null); // { kind: 'status', to } | { kind: 'warranty' }
  const [reason, setReason] = useState('');
  const [end, setEnd] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    serialsApi
      .get(id)
      .then((d) => !cancelled && setData(d))
      .catch(toast.error);
    return () => {
      cancelled = true;
    };
  }, [id, toast]);

  async function submit() {
    setBusy(true);
    try {
      const d =
        form.kind === 'status'
          ? await serialsApi.setStatus(id, form.to, reason)
          : await serialsApi.setWarranty(id, end, reason);
      setData(d);
      setForm(null);
      setReason('');
      toast.success('Saved.');
      onChanged();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  }

  if (!data) return <Skeleton className="m-3 h-24" />;
  return (
    <div className="grid gap-4 bg-surface-2/50 px-4 py-3 md:grid-cols-2">
      <div className="space-y-2 text-sm">
        <div className="grid grid-cols-[10rem_1fr] gap-x-2 gap-y-1">
          <span className="text-muted">Added</span>
          <span>
            {formatDate(data.purchase_date)} ·{' '}
            {data.supplier_name ||
              (data.source_type === 'opening' ? 'Opening stock' : 'Stock adjustment')}
          </span>
          <span className="text-muted">Supplier warranty</span>
          <span>
            {data.supplier_warranty_end ? `till ${formatDate(data.supplier_warranty_end)}` : '—'}
          </span>
          <span className="text-muted">Customer warranty</span>
          <span>
            {data.warranty_end ? `till ${formatDate(data.warranty_end)}` : 'Starts when sold'}
            {data.warranty_overridden ? ' (changed by hand)' : ''}
          </span>
          {data.customer_name && (
            <>
              <span className="text-muted">Customer</span>
              <span>
                {data.customer_name} {data.customer_phone && `· ${data.customer_phone}`}
              </span>
            </>
          )}
        </div>
        <div className="flex flex-wrap gap-2 pt-1">
          {(ACTIONS[data.status] || []).map((a) => (
            <Button
              key={a.to}
              size="sm"
              onClick={() => setForm({ kind: 'status', to: a.to, label: a.label })}
            >
              {a.label}
            </Button>
          ))}
          <Button
            size="sm"
            variant="ghost"
            icon={CalendarClock}
            onClick={() => {
              setEnd(data.warranty_end || '');
              setForm({ kind: 'warranty', label: 'Change warranty end' });
            }}
          >
            Change warranty
          </Button>
        </div>
        <AnimatePresence>
          {form && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              className="overflow-hidden"
            >
              <div className="mt-2 space-y-2 rounded-xl border border-border bg-surface p-3">
                <div className="font-medium">{form.label}</div>
                {form.kind === 'warranty' && (
                  <Field label="Warranty valid till">
                    {(fid) => (
                      <Input
                        id={fid}
                        type="date"
                        value={end}
                        onChange={(e) => setEnd(e.target.value)}
                      />
                    )}
                  </Field>
                )}
                <Field label="Reason" required>
                  {(fid) => (
                    <Input
                      id={fid}
                      autoFocus
                      value={reason}
                      maxLength={200}
                      onChange={(e) => setReason(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && reason.trim() && submit()}
                    />
                  )}
                </Field>
                <div className="flex justify-end gap-2">
                  <Button size="sm" onClick={() => setForm(null)}>
                    Cancel
                  </Button>
                  <Button
                    size="sm"
                    variant="primary"
                    disabled={busy || !reason.trim()}
                    onClick={submit}
                  >
                    Save
                  </Button>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
      <div>
        <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-muted">
          <History size={13} /> History
        </div>
        <ol className="relative space-y-2 border-l border-border pl-4">
          {data.events.map((e) => (
            <li key={e.id} className="text-sm">
              <span className="absolute -left-[5px] mt-1.5 h-2.5 w-2.5 rounded-full bg-primary" />
              <div className="font-medium">{EVENT_LABELS[e.type] || e.type}</div>
              <div className="text-xs text-muted">
                {formatDate(e.date)}
                {e.note && ` · ${e.note}`}
              </div>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}

/** Every unit of a serial-tracked product, with status, warranty and history. */
export default function SerialsTab({ productId, variants, initialSearch = '', onChanged }) {
  const toast = useToast();
  const [status, setStatus] = useState('');
  const [variantId, setVariantId] = useState('');
  const [search, setSearch] = useState(initialSearch);
  const [result, setResult] = useState({ key: null, data: null });
  const [reload, setReload] = useState(0);
  const [openId, setOpenId] = useState(null);

  const key = JSON.stringify([status, variantId, search.trim(), reload]);
  const data = result.data;
  const loading = result.key !== key;

  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(() => {
      serialsApi
        .list({
          product_id: productId,
          status: status || undefined,
          variant_id: variantId ? Number(variantId) : undefined,
          search: search.trim(),
          page_size: 500,
        })
        .then((d) => !cancelled && setResult({ key, data: d }))
        .catch(toast.error);
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, productId, toast]);

  const counts = data?.counts || {};
  const totalAll = Object.values(counts).reduce((a, b) => a + b, 0);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {[
          { value: '', label: 'All', n: totalAll },
          ...Object.entries(SERIAL_STATUS).map(([value, s]) => ({
            value,
            label: s.label,
            n: counts[value] || 0,
          })),
        ]
          .filter((c) => c.value === '' || c.n > 0)
          .map((c) => (
            <button
              key={c.value || 'all'}
              type="button"
              onClick={() => setStatus(c.value)}
              className={`relative rounded-full border px-3 py-1 text-xs font-medium ${status === c.value ? 'border-transparent text-on-primary' : 'border-border text-muted hover:text-fg'}`}
            >
              {status === c.value && (
                <motion.span
                  layoutId="serial-status"
                  className="absolute inset-0 rounded-full bg-primary"
                  transition={{ type: 'spring', stiffness: 500, damping: 40 }}
                />
              )}
              <span className="relative">
                {c.label} · {c.n}
              </span>
            </button>
          ))}
      </div>
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Search
            size={15}
            className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted"
          />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search serial number…"
            className="pl-9"
          />
        </div>
        {variants.length > 1 && (
          <select
            value={variantId}
            onChange={(e) => setVariantId(e.target.value)}
            className="h-9 rounded-lg border border-border bg-surface px-3"
          >
            <option value="">All variants</option>
            {variants.map((v) => (
              <option key={v.id} value={v.id}>
                {v.label || v.sku}
              </option>
            ))}
          </select>
        )}
      </div>

      {!data ? (
        <Skeleton className="h-48" />
      ) : data.rows.length === 0 ? (
        <EmptyState title="No serial numbers">
          {totalAll === 0
            ? 'Units appear here when stock is added with serial numbers.'
            : 'Nothing matches this filter.'}
        </EmptyState>
      ) : (
        <div
          className={`overflow-hidden rounded-xl border border-border transition-opacity ${loading ? 'opacity-60' : ''}`}
        >
          <table className="w-full text-sm">
            <thead className="bg-surface-2 text-left text-xs text-muted">
              <tr>
                <th className="px-3 py-2 font-medium">Serial no.</th>
                {variants.length > 1 && <th className="px-3 py-2 font-medium">Variant</th>}
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Added</th>
                <th className="px-3 py-2 font-medium">Warranty</th>
                <th className="w-8" />
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {data.rows.map((r) => {
                const st = SERIAL_STATUS[r.status];
                const w = WARRANTY[r.warranty.status];
                const isOpen = openId === r.id;
                return (
                  <FragmentRow key={r.id}>
                    <tr
                      className={`cursor-pointer hover:bg-surface-2/60 ${isOpen ? 'bg-surface-2/60' : ''}`}
                      onClick={() => setOpenId(isOpen ? null : r.id)}
                    >
                      <td className="px-3 py-2">
                        <span className="font-mono">{r.serial_no}</span>
                        {r.serial_no_2 && (
                          <span className="ml-2 font-mono text-xs text-muted">
                            / {r.serial_no_2}
                          </span>
                        )}
                        {r.is_auto === 1 && (
                          <Badge tone="primary" className="ml-2">
                            Auto
                          </Badge>
                        )}
                      </td>
                      {variants.length > 1 && (
                        <td className="px-3 py-2 text-muted">{r.variant_label || r.sku}</td>
                      )}
                      <td className="px-3 py-2">
                        <Badge tone={st.tone} dot>
                          {st.label}
                        </Badge>
                      </td>
                      <td className="px-3 py-2 text-muted">{formatDate(r.purchase_date)}</td>
                      <td className="px-3 py-2">
                        {w ? (
                          <Badge tone={w.tone}>
                            {w.label} · {formatDate(r.warranty_end)}
                          </Badge>
                        ) : (
                          <span className="text-muted">—</span>
                        )}
                      </td>
                      <td className="px-2 py-2 text-muted">
                        <ChevronDown
                          size={15}
                          className={`transition-transform ${isOpen ? 'rotate-180' : ''}`}
                        />
                      </td>
                    </tr>
                    {isOpen && (
                      <tr>
                        <td colSpan={variants.length > 1 ? 6 : 5} className="p-0">
                          <SerialDetail
                            id={r.id}
                            onChanged={() => {
                              setReload((n) => n + 1);
                              onChanged?.();
                            }}
                          />
                        </td>
                      </tr>
                    )}
                  </FragmentRow>
                );
              })}
            </tbody>
          </table>
          {data.total > data.rows.length && (
            <p className="px-3 py-2 text-xs text-muted">
              Showing {data.rows.length} of {data.total}. Use search to find a specific unit.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function FragmentRow({ children }) {
  return <>{children}</>;
}
