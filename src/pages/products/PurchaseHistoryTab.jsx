import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { History, Truck } from 'lucide-react';
import { EmptyState, Skeleton } from '../../components/Feedback';
import { useToast } from '../../components/Toast';
import { purchasesApi } from '../../api/purchases';
import { formatMoney } from '../../utils/money';
import { formatQty, formatRateBp } from '../../utils/qty';
import { formatDate } from '../../utils/dates';

const FIELD_LABELS = {
  purchase_price: 'Purchase price',
  mrp: 'MRP',
  selling_price: 'Selling price',
};
const th = 'px-3 py-2 font-medium';
const thr = 'px-3 py-2 text-right font-medium';
const td = 'px-3 py-2';
const tdr = 'px-3 py-2 text-right tabular-nums whitespace-nowrap';

/** Product drawer tab: every purchase of this product and the price changes made from bills. */
export default function PurchaseHistoryTab({ productId }) {
  const toast = useToast();
  const navigate = useNavigate();
  const [data, setData] = useState(null);

  useEffect(() => {
    let cancelled = false;
    purchasesApi
      .priceHistory(productId)
      .then((d) => !cancelled && setData(d))
      .catch(toast.error);
    return () => {
      cancelled = true;
    };
  }, [productId, toast]);

  if (!data) {
    return (
      <div className="space-y-2">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-10" />
        ))}
      </div>
    );
  }
  if (data.lines.length === 0 && data.changes.length === 0) {
    return (
      <EmptyState icon={Truck} title="Not purchased yet">
        Purchase bills with this product will appear here, with the rate from each supplier.
      </EmptyState>
    );
  }
  return (
    <div className="space-y-5">
      <div className="overflow-hidden rounded-xl border border-border">
        <table className="w-full text-sm">
          <thead className="bg-surface-2 text-left text-xs text-muted">
            <tr>
              <th className={th}>Bill date</th>
              <th className={th}>Supplier / entry</th>
              <th className={thr}>Qty (+free)</th>
              <th className={thr}>Rate</th>
              <th className={thr}>GST</th>
              <th className={thr}>Landed cost / unit</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {data.lines.map((l, i) => (
              <tr
                key={`${l.purchase_id}-${i}`}
                className="cursor-pointer hover:bg-surface-2/60"
                onClick={() => navigate(`/purchases?open=${l.purchase_id}`)}
              >
                <td className={td}>{formatDate(l.bill_date)}</td>
                <td className={td}>
                  <div className="font-medium">{l.supplier_name}</div>
                  <div className="text-xs text-muted">
                    {l.entry_no}
                    {l.bill_no ? ` · bill ${l.bill_no}` : ''}
                    {l.variant_label ? ` · ${l.variant_label}` : ''}
                  </div>
                </td>
                <td className={tdr}>
                  {formatQty(l.qty_milli)}
                  {l.free_qty_milli ? (
                    <span className="text-success"> +{formatQty(l.free_qty_milli)}</span>
                  ) : null}
                </td>
                <td className={tdr}>
                  {formatMoney(l.rate)}
                  <div className="text-[11px] text-muted">
                    {l.price_mode === 'inclusive' ? 'incl.' : 'excl.'} GST
                  </div>
                </td>
                <td className={tdr}>{formatRateBp(l.gst_rate_bp)}</td>
                <td className={`${tdr} font-semibold`}>{formatMoney(l.unit_cost)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {data.changes.length > 0 && (
        <div>
          <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold">
            <History size={15} className="text-muted" /> Price changes made from purchase bills
          </h3>
          <ul className="divide-y divide-border rounded-xl border border-border text-sm">
            {data.changes.map((c) => (
              <li key={c.id} className="flex items-center gap-3 px-3 py-2">
                <span className="w-24 text-muted">{formatDate(c.date)}</span>
                <span className="flex-1">
                  {FIELD_LABELS[c.field]}
                  {c.variant_label ? ` (${c.variant_label})` : ''}:{' '}
                  <span className="text-muted line-through">{formatMoney(c.old_value)}</span> →{' '}
                  <strong>{formatMoney(c.new_value)}</strong>
                </span>
                <span className="text-xs text-muted">{c.entry_no}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
