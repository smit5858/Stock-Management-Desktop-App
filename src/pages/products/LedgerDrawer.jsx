import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { ArrowDownLeft, ArrowUpRight, History } from 'lucide-react';
import { Drawer } from '../../components/Overlay';
import { Field, Input, Select } from '../../components/Field';
import { Badge, EmptyState, Skeleton } from '../../components/Feedback';
import { useToast } from '../../components/Toast';
import { stockApi } from '../../api/products';
import { formatQty } from '../../utils/qty';
import { formatDate } from '../../utils/dates';

const TONES = {
  opening: 'primary',
  purchase: 'success',
  sale: 'warning',
  sale_return: 'success',
  purchase_return: 'warning',
  adjustment: 'neutral',
  warranty_return_in: 'neutral',
  warranty_replacement_out: 'warning',
  warranty_parts_used: 'warning',
  supplier_claim_out: 'warning',
  supplier_claim_in: 'success',
  write_off: 'danger',
};

/** Remounted (key) per open. Date-wise in / out / balance for one variant of a product. */
export default function LedgerDrawer({ product, onClose }) {
  const toast = useToast();
  const [variantId, setVariantId] = useState(() => String(product?.variants[0]?.id ?? ''));
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [result, setResult] = useState({ key: null, data: null });
  const requestKey = `${variantId}|${from}|${to}`;
  const data = result.key === requestKey ? result.data : null;

  useEffect(() => {
    if (!variantId) return undefined;
    let cancelled = false;
    stockApi
      .ledger(Number(variantId), from || undefined, to || undefined)
      .then((d) => !cancelled && setResult({ key: `${variantId}|${from}|${to}`, data: d }))
      .catch(toast.error);
    return () => {
      cancelled = true;
    };
  }, [variantId, from, to, toast]);

  return (
    <Drawer
      open={Boolean(product)}
      onClose={onClose}
      title="Stock ledger"
      subtitle={product?.name}
      width="w-[50rem]"
    >
      {product && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-end gap-3">
            {product.variants.length > 1 && (
              <Field label="Variant" className="min-w-56 flex-1">
                {(id) => (
                  <Select id={id} value={variantId} onChange={(e) => setVariantId(e.target.value)}>
                    {product.variants.map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.label || v.sku}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
            )}
            <Field label="From">
              {(id) => (
                <Input id={id} type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
              )}
            </Field>
            <Field label="To">
              {(id) => (
                <Input id={id} type="date" value={to} onChange={(e) => setTo(e.target.value)} />
              )}
            </Field>
          </div>

          {!data ? (
            <Skeleton className="h-64" />
          ) : (
            <>
              <div className="grid grid-cols-4 gap-3">
                {[
                  ['Opening', data.opening_milli],
                  ['In', data.total_in_milli],
                  ['Out', data.total_out_milli],
                  ['Closing', data.closing_milli],
                ].map(([label, value]) => (
                  <div
                    key={label}
                    className="rounded-xl border border-border bg-surface-2/50 px-4 py-3"
                  >
                    <div className="text-xs text-muted">{label}</div>
                    <div className="text-lg font-semibold tabular-nums">
                      {formatQty(value)}{' '}
                      <span className="text-xs font-normal text-muted">{data.variant.unit}</span>
                    </div>
                  </div>
                ))}
              </div>

              {data.rows.length === 0 ? (
                <EmptyState icon={History} title="No stock movements">
                  Nothing was recorded for this period.
                </EmptyState>
              ) : (
                <div className="overflow-hidden rounded-xl border border-border">
                  <table className="w-full text-sm">
                    <thead className="bg-surface-2 text-left text-xs text-muted">
                      <tr>
                        <th className="px-3 py-2 font-medium">Date</th>
                        <th className="px-3 py-2 font-medium">Type</th>
                        <th className="px-3 py-2 font-medium">Details</th>
                        <th className="px-3 py-2 text-right font-medium">In</th>
                        <th className="px-3 py-2 text-right font-medium">Out</th>
                        <th className="px-3 py-2 text-right font-medium">Balance</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {data.rows.map((r, i) => (
                        <motion.tr
                          key={r.id}
                          initial={{ opacity: 0 }}
                          animate={{ opacity: 1 }}
                          transition={{ delay: Math.min(i * 0.015, 0.3) }}
                          className="hover:bg-surface-2/60"
                        >
                          <td className="px-3 py-2 whitespace-nowrap">{formatDate(r.date)}</td>
                          <td className="px-3 py-2">
                            <Badge tone={TONES[r.type]}>{r.type_label}</Badge>
                          </td>
                          <td
                            className="max-w-64 truncate px-3 py-2 text-muted"
                            title={r.reason || ''}
                          >
                            {r.reason || '—'}
                          </td>
                          <td className="px-3 py-2 text-right text-success tabular-nums">
                            {r.in_milli ? (
                              <span className="inline-flex items-center gap-1">
                                <ArrowDownLeft size={12} />
                                {formatQty(r.in_milli)}
                              </span>
                            ) : (
                              ''
                            )}
                          </td>
                          <td className="px-3 py-2 text-right text-danger tabular-nums">
                            {r.out_milli ? (
                              <span className="inline-flex items-center gap-1">
                                <ArrowUpRight size={12} />
                                {formatQty(r.out_milli)}
                              </span>
                            ) : (
                              ''
                            )}
                          </td>
                          <td className="px-3 py-2 text-right font-medium tabular-nums">
                            {formatQty(r.balance_milli)}
                          </td>
                        </motion.tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </Drawer>
  );
}
