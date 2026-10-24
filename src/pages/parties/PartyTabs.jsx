import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  FileDown,
  FileText,
  Package,
  Printer,
  ReceiptText,
  ShieldCheck,
  Truck,
  Wallet,
  Wrench,
} from 'lucide-react';
import Button from '../../components/Button';
import { Input, Select } from '../../components/Field';
import { Badge, EmptyState, Skeleton } from '../../components/Feedback';
import { useToast } from '../../components/Toast';
import { partiesApi } from '../../api/parties';
import { ClaimBadge, WarrantyBadge, daysText } from '../warranty/shared';
import PayStatus from '../purchases/PayStatus';
import { formatMoney } from '../../utils/money';
import { formatQty } from '../../utils/qty';
import { formatDate, todayISO } from '../../utils/dates';

/** Loads `fn()` whenever `deps` change; returns { data, error, reload }. */
function useLoad(fn, deps) {
  const [state, setState] = useState({ key: null, data: null });
  const key = JSON.stringify(deps);
  useEffect(() => {
    let cancelled = false;
    fn()
      .then((data) => !cancelled && setState({ key, data }))
      .catch((e) => !cancelled && setState({ key, data: null, error: e }));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return state.key === key ? state : { data: null };
}

function Loading() {
  return (
    <div className="space-y-2">
      {[0, 1, 2, 3].map((i) => (
        <Skeleton key={i} className="h-10" />
      ))}
    </div>
  );
}

function Table({ head, children }) {
  return (
    <div className="overflow-hidden rounded-xl border border-border">
      <table className="w-full text-sm">
        <thead className="bg-surface-2 text-left text-xs text-muted">
          <tr>{head}</tr>
        </thead>
        <tbody className="divide-y divide-border">{children}</tbody>
      </table>
    </div>
  );
}

const th = 'px-3 py-2 font-medium';
const thr = 'px-3 py-2 text-right font-medium';
const td = 'px-3 py-2';
const tdr = 'px-3 py-2 text-right tabular-nums whitespace-nowrap';

function StatusBadge({ status }) {
  return status === 'cancelled' ? (
    <Badge tone="danger">Cancelled</Badge>
  ) : (
    <Badge tone="success">Active</Badge>
  );
}

// ---------------------------------------------------------------- ledger

function fyRange(offset = 0) {
  const t = todayISO();
  const [y, m] = t.split('-').map(Number);
  const start = (m >= 4 ? y : y - 1) + offset;
  return { from: `${start}-04-01`, to: `${start + 1}-03-31` };
}

const PRESETS = {
  all: { label: 'All', range: () => ({ from: '', to: '' }) },
  fy: { label: 'This FY', range: () => fyRange(0) },
  last_fy: { label: 'Last FY', range: () => fyRange(-1) },
  custom: { label: 'Custom', range: null },
};

export function LedgerTab({ party }) {
  const toast = useToast();
  const [preset, setPreset] = useState('all');
  const [range, setRange] = useState({ from: '', to: '' });
  const [busy, setBusy] = useState(false);
  const { data } = useLoad(
    () => partiesApi.ledger(party.id, range.from, range.to),
    [party.id, range, party.balance],
  );
  const supplier = party.type === 'supplier';

  function choose(p) {
    setPreset(p);
    if (PRESETS[p].range) setRange(PRESETS[p].range());
  }

  async function run(fn, done) {
    setBusy(true);
    try {
      const r = await fn(party.id, range.from, range.to);
      if (r && r.saved) toast.success(`${done}: ${r.file_path}`);
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  }

  const sign = (v) => (v === 0 ? '' : supplier ? (v < 0 ? ' Cr' : ' Dr') : v > 0 ? ' Dr' : ' Cr');

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex rounded-lg border border-border bg-surface-2 p-0.5">
          {Object.entries(PRESETS).map(([k, p]) => (
            <button
              key={k}
              type="button"
              onClick={() => choose(k)}
              className={`h-8 rounded-md px-3 text-sm font-medium ${preset === k ? 'bg-surface text-fg shadow-sm' : 'text-muted hover:text-fg'}`}
            >
              {p.label}
            </button>
          ))}
        </div>
        <Input
          type="date"
          className="w-40!"
          value={range.from}
          onChange={(e) => {
            setPreset('custom');
            setRange((r) => ({ ...r, from: e.target.value }));
          }}
        />
        <span className="text-muted">to</span>
        <Input
          type="date"
          className="w-40!"
          value={range.to}
          onChange={(e) => {
            setPreset('custom');
            setRange((r) => ({ ...r, to: e.target.value }));
          }}
        />
        <div className="ml-auto flex gap-1.5">
          <Button
            size="sm"
            icon={Printer}
            disabled={busy}
            onClick={() => run(partiesApi.statementPrint, 'Printed')}
          >
            Print
          </Button>
          <Button
            size="sm"
            icon={FileText}
            disabled={busy}
            onClick={() => run(partiesApi.statementPdf, 'PDF saved')}
          >
            PDF
          </Button>
          <Button
            size="sm"
            icon={FileDown}
            disabled={busy}
            onClick={() => run(partiesApi.ledgerExport, 'Exported')}
          >
            Excel
          </Button>
        </div>
      </div>
      {!data ? (
        <Loading />
      ) : (
        <>
          <Table
            head={
              <>
                <th className={th}>Date</th>
                <th className={th}>Particulars</th>
                <th className={th}>Ref. no.</th>
                <th className={thr}>Debit</th>
                <th className={thr}>Credit</th>
                <th className={thr}>Balance</th>
              </>
            }
          >
            <tr className="bg-surface-2/40 text-muted">
              <td className={td}>{range.from ? formatDate(range.from) : ''}</td>
              <td className={td} colSpan={4}>
                Balance brought forward
              </td>
              <td className={tdr}>
                {formatMoney(Math.abs(data.opening))}
                {sign(data.opening)}
              </td>
            </tr>
            {data.rows.map((r) => (
              <tr key={r.key}>
                <td className={`${td} whitespace-nowrap`}>{formatDate(r.date)}</td>
                <td className={td}>{r.label}</td>
                <td className={`${td} font-mono text-xs text-muted`}>{r.ref_no || ''}</td>
                <td className={tdr}>{r.debit ? formatMoney(r.debit) : ''}</td>
                <td className={tdr}>{r.credit ? formatMoney(r.credit) : ''}</td>
                <td className={`${tdr} font-medium`}>
                  {formatMoney(Math.abs(r.balance))}
                  {sign(r.balance)}
                </td>
              </tr>
            ))}
            <tr className="bg-surface-2 font-semibold">
              <td className={td} colSpan={3}>
                Total
              </td>
              <td className={tdr}>{formatMoney(data.debit)}</td>
              <td className={tdr}>{formatMoney(data.credit)}</td>
              <td className={tdr}>
                {formatMoney(Math.abs(data.closing))}
                {sign(data.closing)}
              </td>
            </tr>
          </Table>
          {data.rows.length === 0 && (
            <p className="text-center text-sm text-muted">No entries in this period.</p>
          )}
          <p className="text-xs text-muted">
            Dr = {supplier ? 'advance paid to the supplier' : 'customer owes us'} · Cr ={' '}
            {supplier ? 'we owe the supplier' : 'advance / paid'}. Balances come from bills, returns
            and payments; nothing is stored separately.
          </p>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- bills / purchases / payments

export function BillsTab({ party }) {
  const navigate = useNavigate();
  const [vehicleId, setVehicleId] = useState('');
  const { data } = useLoad(
    () => partiesApi.bills(party.id, vehicleId ? Number(vehicleId) : null),
    [party.id, vehicleId],
  );
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="primary"
          icon={ReceiptText}
          onClick={() => navigate('/billing', { state: { customer: party.id } })}
        >
          New bill
        </Button>
        {party.vehicles.length > 0 && (
          <Select
            value={vehicleId}
            onChange={(e) => setVehicleId(e.target.value)}
            className="w-64!"
          >
            <option value="">All vehicles</option>
            {party.vehicles.map((v) => (
              <option key={v.id} value={v.id}>
                {v.plate_display}
                {v.model ? ` · ${v.model}` : ''}
              </option>
            ))}
          </Select>
        )}
      </div>
      {!data ? (
        <Loading />
      ) : data.length === 0 ? (
        <EmptyState icon={ReceiptText} title="No bills yet">
          Bills made for this customer will appear here.
        </EmptyState>
      ) : (
        <Table
          head={
            <>
              <th className={th}>Date</th>
              <th className={th}>Bill no.</th>
              <th className={th}>Type</th>
              <th className={th}>Vehicle</th>
              <th className={thr}>Items</th>
              <th className={thr}>Total</th>
              <th className={thr}>Due</th>
              <th className={th}>Status</th>
            </>
          }
        >
          {data.map((b) => (
            <tr
              key={b.id}
              onClick={() => navigate(`/sales?open=${b.id}`)}
              className={`cursor-pointer hover:bg-surface-2 ${b.status === 'cancelled' ? 'opacity-60' : ''}`}
            >
              <td className={td}>{formatDate(b.invoice_date)}</td>
              <td className={`${td} font-mono text-xs`}>{b.invoice_no}</td>
              <td className={td}>{b.bill_type === 'gst' ? 'GST' : 'Non-GST'}</td>
              <td className={td}>{b.vehicle_no || '—'}</td>
              <td className={tdr}>{b.item_count}</td>
              <td className={tdr}>{formatMoney(b.grand_total)}</td>
              <td className={tdr}>
                {b.status === 'active' && b.due > 0 ? formatMoney(b.due) : '—'}
              </td>
              <td className={td}>
                {b.status === 'active' ? (
                  <PayStatus status={b.pay_status} />
                ) : (
                  <StatusBadge status={b.status} />
                )}
              </td>
            </tr>
          ))}
        </Table>
      )}
    </div>
  );
}

export function PurchasesTab({ party }) {
  const navigate = useNavigate();
  const { data } = useLoad(() => partiesApi.purchases(party.id), [party.id]);
  if (!data) return <Loading />;
  const { bills, returns } = data;
  const newButton = (
    <Button
      size="sm"
      variant="primary"
      icon={Truck}
      onClick={() => navigate(`/purchases/new?supplier=${party.id}`)}
    >
      New purchase
    </Button>
  );
  if (bills.length === 0 && returns.length === 0) {
    return (
      <EmptyState icon={Truck} title="No purchases yet">
        <div className="mb-3">Purchase bills from this supplier will appear here.</div>
        {newButton}
      </EmptyState>
    );
  }
  const open = (id) => navigate(`/purchases?open=${id}`);
  return (
    <div className="space-y-4">
      <div className="flex justify-end">{newButton}</div>
      <Table
        head={
          <>
            <th className={th}>Bill date</th>
            <th className={th}>Entry / bill no.</th>
            <th className={thr}>Items</th>
            <th className={thr}>Total</th>
            <th className={thr}>Due</th>
            <th className={th}>Status</th>
          </>
        }
      >
        {bills.map((b) => (
          <tr
            key={b.id}
            onClick={() => open(b.id)}
            className={`cursor-pointer hover:bg-surface-2/60 ${b.status === 'cancelled' ? 'opacity-60' : ''}`}
          >
            <td className={td}>{formatDate(b.bill_date)}</td>
            <td className={td}>
              <div className="font-medium">{b.entry_no}</div>
              <div className="font-mono text-xs text-muted">
                {b.bill_no || '—'} · {b.bill_type === 'gst' ? 'GST' : 'Non-GST'}
              </div>
            </td>
            <td className={tdr}>{b.item_count}</td>
            <td className={tdr}>{formatMoney(b.grand_total)}</td>
            <td className={tdr}>{b.status === 'active' && b.due > 0 ? formatMoney(b.due) : '—'}</td>
            <td className={td}>
              <PayStatus status={b.pay_status} />
            </td>
          </tr>
        ))}
      </Table>
      {returns.length > 0 && (
        <>
          <h3 className="text-sm font-semibold">Purchase returns (debit notes)</h3>
          <Table
            head={
              <>
                <th className={th}>Date</th>
                <th className={th}>Debit note</th>
                <th className={th}>Against</th>
                <th className={thr}>Credit</th>
                <th className={th}>Status</th>
              </>
            }
          >
            {returns.map((r) => (
              <tr key={r.id} className={r.status === 'cancelled' ? 'opacity-60' : ''}>
                <td className={td}>{formatDate(r.date)}</td>
                <td className={`${td} font-medium`}>{r.return_no}</td>
                <td className={td}>{r.entry_no || 'Standalone'}</td>
                <td className={tdr}>{formatMoney(r.total)}</td>
                <td className={td}>
                  <StatusBadge status={r.status} />
                </td>
              </tr>
            ))}
          </Table>
        </>
      )}
    </div>
  );
}

export function PaymentsTab({ party }) {
  const { data } = useLoad(() => partiesApi.payments(party.id), [party.id]);
  if (!data) return <Loading />;
  if (data.length === 0) {
    return (
      <EmptyState icon={Wallet} title="No payments yet">
        Payments {party.type === 'supplier' ? 'made to' : 'received from'} this{' '}
        {party.type === 'supplier' ? 'supplier' : 'customer'} will appear here (Phase 6).
      </EmptyState>
    );
  }
  return (
    <Table
      head={
        <>
          <th className={th}>Date</th>
          <th className={th}>Receipt no.</th>
          <th className={th}>Account</th>
          <th className={th}>Notes</th>
          <th className={thr}>Amount</th>
          <th className={th}>Status</th>
        </>
      }
    >
      {data.map((p) => (
        <tr key={p.id} className={p.status === 'cancelled' ? 'opacity-60' : ''}>
          <td className={td}>{formatDate(p.date)}</td>
          <td className={`${td} font-mono text-xs`}>{p.payment_no}</td>
          <td className={td}>{p.account_name}</td>
          <td className={`${td} text-muted`}>{p.notes || ''}</td>
          <td className={tdr}>
            {p.direction === 'in' ? '' : '−'}
            {formatMoney(p.amount)}
          </td>
          <td className={td}>
            <StatusBadge status={p.status} />
          </td>
        </tr>
      ))}
    </Table>
  );
}

// ---------------------------------------------------------------- warranty

/** Units / lines with a warranty sold to this customer, and their claims. */
export function WarrantiesTab({ party }) {
  const navigate = useNavigate();
  const { data } = useLoad(() => partiesApi.warranties(party.id), [party.id]);
  if (!data) return <Loading />;
  const openUnit = (w) =>
    navigate(`/warranty?unit=${w.kind === 'serial' ? `s${w.serial_id}` : `l${w.sale_item_id}`}`);
  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <Button size="sm" icon={ShieldCheck} onClick={() => navigate('/warranty')}>
          Open Warranty page
        </Button>
      </div>
      {data.items.length === 0 ? (
        <EmptyState icon={ShieldCheck} title="No warranties yet">
          Items with a warranty sold to this customer will appear here.
        </EmptyState>
      ) : (
        <Table
          head={
            <>
              <th className={th}>Product</th>
              <th className={th}>Serial / bill</th>
              <th className={th}>Vehicle</th>
              <th className={th}>Warranty</th>
              <th className={th}>Claim</th>
            </>
          }
        >
          {data.items.map((w) => (
            <tr
              key={w.key}
              className="cursor-pointer hover:bg-surface-2/60"
              onClick={() => openUnit(w)}
            >
              <td className={td}>
                {w.product_name}
                {w.variant_label ? <span className="text-muted"> · {w.variant_label}</span> : null}
                {w.is_replacement && <div className="text-xs text-info">warranty replacement</div>}
              </td>
              <td className={`${td} font-mono text-xs`}>
                {w.kind === 'serial' ? w.serial_no : `${formatQty(w.qty_milli)} ${w.unit}`}
                {w.invoice_no ? <div className="text-muted">{w.invoice_no}</div> : null}
              </td>
              <td className={td}>{w.vehicle_no || '—'}</td>
              <td className={td}>
                <WarrantyBadge status={w.status} />
                {w.warranty_end && (
                  <div className="mt-0.5 text-xs text-muted">
                    {formatDate(w.warranty_end)} · {daysText(w.status)}
                  </div>
                )}
              </td>
              <td className={`${td} font-mono text-xs`}>
                {w.open_claim ? w.open_claim.claim_no : '—'}
              </td>
            </tr>
          ))}
        </Table>
      )}
      {data.claims.length > 0 && (
        <>
          <div className="pt-2 text-sm font-semibold">Warranty claims</div>
          <ClaimsTable rows={data.claims} />
        </>
      )}
    </div>
  );
}

const CLAIM_STATUS = {
  received: 'Received',
  inspecting: 'Under inspection',
  repairing: 'Repairing',
  at_supplier: 'Sent to supplier',
  awaiting_replacement: 'Awaiting replacement',
  ready: 'Ready for pickup',
  returned: 'Returned',
  closed: 'Closed',
  rejected: 'Rejected',
  cancelled: 'Cancelled',
};

function ClaimsTable({ rows, supplier }) {
  const navigate = useNavigate();
  return (
    <Table
      head={
        <>
          <th className={th}>Claim</th>
          <th className={th}>Product</th>
          {supplier && <th className={th}>Customer</th>}
          <th className={th}>Complaint</th>
          <th className={th}>Received</th>
          <th className={th}>Status</th>
        </>
      }
    >
      {rows.map((c) => (
        <tr
          key={c.id}
          className="cursor-pointer hover:bg-surface-2/60"
          onClick={() => navigate(`/warranty?claim=${c.id}`)}
        >
          <td className={`${td} font-mono text-xs`}>{c.claim_no}</td>
          <td className={td}>
            {c.product_name}
            {c.serial_no ? <div className="font-mono text-xs text-muted">{c.serial_no}</div> : null}
          </td>
          {supplier && (
            <td className={td}>{c.kind === 'stock' ? 'Shop stock' : c.customer_name || '—'}</td>
          )}
          <td className={`${td} text-muted`}>{c.complaint}</td>
          <td className={td}>{formatDate(c.received_date)}</td>
          <td className={td}>
            <ClaimBadge
              status={c.status}
              label={CLAIM_STATUS[c.status] || c.status}
              overdue={c.overdue}
            />
          </td>
        </tr>
      ))}
    </Table>
  );
}

/** Supplier: claims sent, units still with them, recovery totals and turnaround. */
export function ClaimsTab({ party }) {
  const navigate = useNavigate();
  const { data } = useLoad(() => partiesApi.claims(party.id), [party.id]);
  if (!data) return <Loading />;
  if (data.claims.length === 0) {
    return (
      <EmptyState icon={Wrench} title="No warranty claims">
        Units sent to this supplier for warranty will appear here.
      </EmptyState>
    );
  }
  const t = data.totals;
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-4 gap-3 text-sm">
        {[
          ['Units sent', t.sent],
          ['Still with supplier', `${t.pending}${t.overdue ? ` (${t.overdue} overdue)` : ''}`],
          ['Recovered', formatMoney(t.recovered)],
          [
            'Avg. turnaround',
            t.avg_turnaround_days == null ? '—' : `${t.avg_turnaround_days} days`,
          ],
        ].map(([l, v]) => (
          <div key={l} className="rounded-xl border border-border p-3">
            <div className="text-xs text-muted">{l}</div>
            <div className="font-semibold">{v}</div>
          </div>
        ))}
      </div>
      {data.pending.length > 0 && (
        <div className="rounded-xl border border-border p-3">
          <div className="mb-1 text-xs font-semibold text-muted uppercase">Pending returns</div>
          {data.pending.map((d) => (
            <button
              key={d.id}
              type="button"
              onClick={() => navigate(`/warranty?claim=${d.claim_id}`)}
              className={`flex w-full justify-between rounded-lg px-2 py-1 text-left text-sm hover:bg-surface-2 ${d.overdue ? 'text-danger' : ''}`}
            >
              <span>
                {d.claim_no} · {d.product_name}
                {d.serial_no ? ` · ${d.serial_no}` : ''}
              </span>
              <span>
                sent {formatDate(d.dispatch_date)}
                {d.expected_date ? ` · expected ${formatDate(d.expected_date)}` : ''}
              </span>
            </button>
          ))}
        </div>
      )}
      <ClaimsTable rows={data.claims} supplier />
    </div>
  );
}

export function SuppliedTab({ party }) {
  const navigate = useNavigate();
  const { data } = useLoad(() => partiesApi.suppliedProducts(party.id), [party.id]);
  if (!data) return <Loading />;
  if (data.length === 0) {
    return (
      <EmptyState icon={Package} title="No products yet">
        Products bought from this supplier will appear here once purchases are entered (Phase 4).
        {party.supplies ? ` Noted: ${party.supplies}.` : ''}
      </EmptyState>
    );
  }
  return (
    <Table
      head={
        <>
          <th className={th}>Product</th>
          <th className={thr}>Times</th>
          <th className={thr}>Total qty</th>
          <th className={thr}>Last rate</th>
          <th className={th}>Last bought</th>
        </>
      }
    >
      {data.map((p) => (
        <tr
          key={p.variant_id}
          className="cursor-pointer hover:bg-surface-2/60"
          onClick={() => navigate(`/products?open=${p.product_id}`)}
        >
          <td className={td}>
            {p.product_name}
            {p.variant_label ? <span className="text-muted"> · {p.variant_label}</span> : null}
          </td>
          <td className={tdr}>{p.times}</td>
          <td className={tdr}>
            {formatQty(p.qty_milli)} {p.unit}
          </td>
          <td className={tdr}>{p.last_rate == null ? '—' : formatMoney(p.last_rate)}</td>
          <td className={td}>{formatDate(p.last_date)}</td>
        </tr>
      ))}
    </Table>
  );
}
