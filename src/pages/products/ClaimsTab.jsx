import { useNavigate } from 'react-router-dom';
import { ClipboardList } from 'lucide-react';
import { EmptyState, Skeleton } from '../../components/Feedback';
import { claimsApi } from '../../api/warranty';
import { formatMoney } from '../../utils/money';
import { formatQty } from '../../utils/qty';
import { formatDate } from '../../utils/dates';
import { ClaimBadge, useLoad } from '../warranty/shared';

/** Product detail: warranty claims history and claim rate (claims ÷ quantity sold). */
export default function ClaimsTab({ productId }) {
  const navigate = useNavigate();
  const { data } = useLoad(() => claimsApi.forProduct(productId), [productId]);
  if (!data) return <Skeleton className="h-48" />;
  const loss = data.claims.reduce((s, c) => s + (c.net_loss || 0), 0);
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-4 gap-3 text-sm">
        {[
          ['Sold', formatQty(data.sold_milli)],
          ['Claimed', formatQty(data.claimed_milli)],
          [
            'Claim rate',
            data.claim_rate_bp == null ? '—' : `${(data.claim_rate_bp / 100).toFixed(1)}%`,
          ],
          ['Net warranty loss', formatMoney(loss)],
        ].map(([l, v]) => (
          <div key={l} className="rounded-xl border border-border p-3">
            <div className="text-xs text-muted">{l}</div>
            <div className="font-semibold tabular-nums">{v}</div>
          </div>
        ))}
      </div>
      {data.claims.length === 0 ? (
        <EmptyState icon={ClipboardList} title="No warranty claims for this product" />
      ) : (
        <div className="overflow-hidden rounded-xl border border-border">
          <table className="w-full text-sm">
            <thead className="bg-surface-2 text-left text-xs text-muted">
              <tr>
                <th className="px-3 py-2 font-medium">Claim</th>
                <th className="px-3 py-2 font-medium">Unit</th>
                <th className="px-3 py-2 font-medium">Customer</th>
                <th className="px-3 py-2 font-medium">Complaint</th>
                <th className="px-3 py-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {data.claims.map((c) => (
                <tr
                  key={c.id}
                  className="cursor-pointer hover:bg-surface-2/60"
                  onClick={() => navigate(`/warranty?claim=${c.id}`)}
                >
                  <td className="px-3 py-2">
                    <div className="font-mono text-xs">{c.claim_no}</div>
                    <div className="text-xs text-muted">{formatDate(c.received_date)}</div>
                  </td>
                  <td className="px-3 py-2 font-mono text-xs">
                    {c.serial_no || `${formatQty(c.qty_milli)} ${c.unit}`}
                  </td>
                  <td className="px-3 py-2">
                    {c.kind === 'stock' ? 'Shop stock' : c.customer_name}
                  </td>
                  <td className="px-3 py-2 text-muted">{c.complaint}</td>
                  <td className="px-3 py-2">
                    <ClaimBadge status={c.status} label={c.status_label} overdue={c.overdue} />
                    {c.outcome_label && (
                      <div className="mt-0.5 text-xs text-muted">{c.outcome_label}</div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
