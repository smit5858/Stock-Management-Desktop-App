import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  AlarmClock,
  Barcode,
  ClipboardList,
  FileDown,
  PackageCheck,
  ReceiptText,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Truck,
} from 'lucide-react';
import Button from '../../components/Button';
import { Input, Select } from '../../components/Field';
import { Badge, EmptyState, Kbd, Skeleton } from '../../components/Feedback';
import { useToast } from '../../components/Toast';
import { useHotkeys } from '../../hooks/useHotkeys';
import { claimsApi, warrantyApi } from '../../api/warranty';
import { formatMoney } from '../../utils/money';
import { formatQty } from '../../utils/qty';
import { formatDate } from '../../utils/dates';
import UnitDrawer from './UnitDrawer';
import ClaimDrawer from './ClaimDrawer';
import { ClaimBadge, WarrantyBadge, daysText } from './shared';

const TABS = [
  { id: 'search', label: 'Search', icon: Search },
  { id: 'open', label: 'Open claims', icon: ClipboardList, claims: true },
  { id: 'active', label: 'Active warranties', icon: ShieldCheck },
  { id: 'expiring', label: 'Expiring soon', icon: AlarmClock },
  { id: 'expired', label: 'Expired (90 days)', icon: ShieldCheck },
  { id: 'closed', label: 'Closed claims', icon: PackageCheck, claims: true },
];
const EMPTY_FILTERS = {
  brand: '',
  category_id: '',
  supplier_id: '',
  from: '',
  to: '',
  technician: '',
  status: '',
  overdue: false,
};

const th = 'px-3 py-2 font-medium';
const td = 'px-3 py-2 align-top';

/** Ref for a unit summary row. */
const refOf = (u) => (u.serial_id ? { serial_id: u.serial_id } : { sale_item_id: u.sale_item_id });

function UnitRow({ u, onOpen, onOpenClaim }) {
  return (
    <tr
      className={`cursor-pointer hover:bg-surface-2/60 ${u.matched ? 'bg-primary-soft/40' : ''}`}
      onClick={() => onOpen(refOf(u))}
    >
      <td className={td}>
        <div className="font-medium">
          {u.product_name}
          {u.variant_label && <span className="font-normal text-muted"> · {u.variant_label}</span>}
        </div>
        <div className="text-xs text-muted">
          {u.serial_no ? (
            <span className="inline-flex items-center gap-1 font-mono">
              <Barcode size={11} /> {u.serial_no}
            </span>
          ) : (
            `${formatQty(u.qty_milli)} ${u.unit}`
          )}
          {u.is_replacement && <span className="ml-2 text-info">replacement</span>}
          {u.brand ? ` · ${u.brand}` : ''}
        </div>
      </td>
      <td className={td}>
        <WarrantyBadge status={u.status} />
        {u.warranty_end && (
          <div className="mt-0.5 text-xs text-muted">
            till {formatDate(u.warranty_end)} · {daysText(u.status)}
          </div>
        )}
      </td>
      <td className={td} onClick={(e) => u.open_claim && e.stopPropagation()}>
        {u.open_claim ? (
          <button
            type="button"
            onClick={() => onOpenClaim(u.open_claim.id)}
            className="font-mono text-xs text-info hover:underline"
          >
            {u.open_claim.claim_no}
          </button>
        ) : (
          <span className="text-muted">—</span>
        )}
      </td>
    </tr>
  );
}

function SearchResults({ result, loading, onOpen, onOpenClaim, meta }) {
  if (!result) {
    return (
      <EmptyState icon={Search} title="Find a warranty">
        Scan or type a serial number, invoice no., customer name / phone, vehicle number or claim
        no.
      </EmptyState>
    );
  }
  if (result.groups.length === 0 && result.claims.length === 0) {
    return (
      <EmptyState icon={Search} title={`Nothing found for “${result.query}”`}>
        Check the number, or try the phone or vehicle number.
      </EmptyState>
    );
  }
  return (
    <div className={`space-y-4 transition-opacity ${loading ? 'opacity-60' : ''}`}>
      {result.claims.length > 0 && (
        <section className="rounded-2xl border border-border bg-surface p-3 shadow-sm">
          <h3 className="mb-2 text-xs font-semibold tracking-wide text-muted uppercase">Claims</h3>
          <div className="flex flex-wrap gap-2">
            {result.claims.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => onOpenClaim(c.id)}
                className="flex items-center gap-2 rounded-xl border border-border px-3 py-2 text-left text-sm hover:border-primary/50"
              >
                <span className="font-mono text-xs">{c.claim_no}</span>
                <span className="text-muted">{c.product_name}</span>
                <ClaimBadge status={c.status} label={meta.statuses[c.status]} />
              </button>
            ))}
          </div>
        </section>
      )}
      {result.groups.map((g, i) => (
        <motion.section
          key={g.key}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: Math.min(i * 0.03, 0.2), duration: 0.15 }}
          className="overflow-hidden rounded-2xl border border-border bg-surface shadow-sm"
        >
          <header className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-border bg-surface-2/60 px-4 py-2.5 text-sm">
            {g.sale ? (
              <>
                <span className="flex items-center gap-1.5 font-semibold">
                  <ReceiptText size={15} className="text-muted" /> {g.sale.invoice_no}
                </span>
                <span className="text-muted">{formatDate(g.sale.invoice_date)}</span>
                <span className="font-medium">{g.sale.customer_name}</span>
                {g.sale.customer_phone && (
                  <span className="text-muted">{g.sale.customer_phone}</span>
                )}
                {g.sale.vehicle_no && <Badge>{g.sale.vehicle_no}</Badge>}
                {g.sale.status === 'cancelled' && <Badge tone="danger">Bill cancelled</Badge>}
              </>
            ) : (
              <span className="font-semibold">Not sold yet (in the shop / with the supplier)</span>
            )}
          </header>
          {g.units.length === 0 ? (
            <p className="px-4 py-3 text-sm text-muted">No goods on this bill.</p>
          ) : (
            <table className="w-full text-sm">
              <tbody className="divide-y divide-border">
                {g.units.map((u) => (
                  <UnitRow key={u.key} u={u} onOpen={onOpen} onOpenClaim={onOpenClaim} />
                ))}
              </tbody>
            </table>
          )}
        </motion.section>
      ))}
    </div>
  );
}

function WarrantyTable({ data, loading, onOpen, onOpenClaim }) {
  if (!data) return <Skeleton className="h-64" />;
  if (data.rows.length === 0) return <EmptyState icon={ShieldCheck} title="Nothing in this list" />;
  return (
    <div
      className={`overflow-hidden rounded-2xl border border-border bg-surface shadow-sm transition-opacity ${loading ? 'opacity-60' : ''}`}
    >
      <table className="w-full text-sm">
        <thead className="bg-surface-2 text-left text-xs text-muted">
          <tr>
            <th className={th}>Product</th>
            <th className={th}>Customer</th>
            <th className={th}>Bill</th>
            <th className={th}>Warranty</th>
            <th className={th}>Claim</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {data.rows.map((u) => (
            <tr
              key={u.key}
              className="cursor-pointer hover:bg-surface-2/60"
              onClick={() => onOpen(refOf(u))}
            >
              <td className={td}>
                <div className="font-medium">{u.product_name}</div>
                <div className="font-mono text-xs text-muted">
                  {u.serial_no || `${formatQty(u.qty_milli)} ${u.unit}`}
                </div>
              </td>
              <td className={td}>
                <div>{u.customer_name}</div>
                <div className="text-xs text-muted">
                  {[u.customer_phone, u.vehicle_no].filter(Boolean).join(' · ')}
                </div>
              </td>
              <td className={td}>
                <div>{u.invoice_no}</div>
                <div className="text-xs text-muted">{formatDate(u.invoice_date)}</div>
              </td>
              <td className={td}>
                <WarrantyBadge status={u.status} />
                <div className="mt-0.5 text-xs text-muted">
                  {formatDate(u.warranty_end)} · {daysText(u.status)}
                </div>
              </td>
              <td className={td} onClick={(e) => u.open_claim && e.stopPropagation()}>
                {u.open_claim ? (
                  <button
                    type="button"
                    onClick={() => onOpenClaim(u.open_claim.id)}
                    className="font-mono text-xs text-info hover:underline"
                  >
                    {u.open_claim.claim_no}
                  </button>
                ) : (
                  '—'
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {data.truncated && (
        <p className="px-3 py-2 text-xs text-muted">
          Showing the first rows only. Narrow the filters.
        </p>
      )}
    </div>
  );
}

function ClaimsTable({ data, loading, onOpenClaim }) {
  if (!data) return <Skeleton className="h-64" />;
  if (data.rows.length === 0) return <EmptyState icon={ClipboardList} title="No claims here" />;
  return (
    <div
      className={`overflow-hidden rounded-2xl border border-border bg-surface shadow-sm transition-opacity ${loading ? 'opacity-60' : ''}`}
    >
      <table className="w-full text-sm">
        <thead className="bg-surface-2 text-left text-xs text-muted">
          <tr>
            <th className={th}>Claim</th>
            <th className={th}>Product</th>
            <th className={th}>Customer</th>
            <th className={th}>Status</th>
            <th className={th}>Supplier</th>
            <th className={`${th} text-right`}>Net loss</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {data.rows.map((c) => (
            <tr
              key={c.id}
              className={`cursor-pointer hover:bg-surface-2/60 ${c.overdue ? 'bg-danger-soft/40' : ''}`}
              onClick={() => onOpenClaim(c.id)}
            >
              <td className={td}>
                <div className="font-mono text-xs font-semibold">{c.claim_no}</div>
                <div className="text-xs text-muted">
                  {formatDate(c.received_date)} · {c.days_open}d
                </div>
              </td>
              <td className={td}>
                <div className="font-medium">{c.product_name}</div>
                <div className="text-xs text-muted">
                  {c.serial_no ? (
                    <span className="font-mono">{c.serial_no}</span>
                  ) : (
                    `${formatQty(c.qty_milli)} ${c.unit}`
                  )}{' '}
                  · {c.complaint}
                </div>
              </td>
              <td className={td}>
                {c.kind === 'stock' ? (
                  <span className="text-muted">Shop stock</span>
                ) : (
                  <>
                    <div>{c.customer_name}</div>
                    <div className="text-xs text-muted">
                      {[c.customer_phone_display, c.vehicle_no].filter(Boolean).join(' · ')}
                    </div>
                  </>
                )}
              </td>
              <td className={td}>
                <ClaimBadge status={c.status} label={c.status_label} overdue={c.overdue} />
                {c.chargeable ? (
                  <div className="mt-0.5 text-xs text-warning">chargeable</div>
                ) : null}
                {c.outcome_label && (
                  <div className="mt-0.5 text-xs text-muted">{c.outcome_label}</div>
                )}
              </td>
              <td className={td}>
                {c.supplier_name || '—'}
                {c.supplier_expected && (
                  <div className={`text-xs ${c.overdue ? 'text-danger' : 'text-muted'}`}>
                    <Truck size={11} className="mr-1 inline" />
                    back by {formatDate(c.supplier_expected)}
                  </div>
                )}
              </td>
              <td className={`${td} text-right tabular-nums`}>
                {c.net_loss ? formatMoney(c.net_loss) : '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function Warranty() {
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const searchRef = useRef(null);
  const [meta, setMeta] = useState(null);
  const [alerts, setAlerts] = useState(null);
  const [tab, setTab] = useState('open');
  const [query, setQuery] = useState('');
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [showFilters, setShowFilters] = useState(false);
  const [found, setFound] = useState({ q: '', data: null });
  const [list, setList] = useState({ key: null, data: null });
  const [reload, setReload] = useState(0);
  const [seq, setSeq] = useState(0);
  const [unit, setUnit] = useState(null); // { ref }
  const [claim, setClaim] = useState(null); // { id, printSlip }

  const isClaims = TABS.find((t) => t.id === tab)?.claims;
  const loadAlerts = useCallback(
    () =>
      warrantyApi
        .alerts()
        .then(setAlerts)
        .catch(() => {}),
    [],
  );

  useEffect(() => {
    warrantyApi.meta().then(setMeta).catch(toast.error);
    loadAlerts();
  }, [toast, loadAlerts]);

  // Deep links (Ctrl+K, dashboard, bell, other pages): ?claim=<id> | ?unit=s<id> / l<id> |
  // ?tab=… &overdue=1 &status=… | ?q=<search>. Applied once, then removed from the URL.
  const linkText = params.toString();
  useEffect(() => {
    if (!linkText) return;
    const p = new URLSearchParams(linkText);
    setParams({}, { replace: true });
    Promise.resolve().then(() => {
      if (p.get('q')) {
        setQuery(p.get('q'));
        setTab('search');
      } else if (p.get('tab')) {
        setTab(p.get('tab'));
        setFilters({
          ...EMPTY_FILTERS,
          overdue: p.get('overdue') === '1',
          status: p.get('status') || '',
        });
      }
      const unitId = p.get('unit');
      if (p.get('claim')) {
        setSeq((n) => n + 1);
        setClaim({ id: Number(p.get('claim')) });
      } else if (unitId) {
        const id = Number(unitId.slice(1));
        setSeq((n) => n + 1);
        setUnit({ ref: unitId[0] === 's' ? { serial_id: id } : { sale_item_id: id } });
      }
    });
  }, [linkText, setParams]);

  // Search as you type (scanner friendly: Enter opens a single match).
  const q = query.trim();
  useEffect(() => {
    if (q.length < 2) return undefined;
    let cancelled = false;
    const t = setTimeout(() => {
      warrantyApi
        .search(q)
        .then((d) => !cancelled && setFound({ q, data: d }))
        .catch(toast.error);
    }, 180);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [q, toast, reload]);

  const filterParams = useMemo(
    () => ({
      brand: filters.brand || undefined,
      category_id: filters.category_id ? Number(filters.category_id) : undefined,
      supplier_id: filters.supplier_id ? Number(filters.supplier_id) : undefined,
      from: filters.from || undefined,
      to: filters.to || undefined,
      technician: filters.technician || undefined,
    }),
    [filters],
  );
  const listKey = JSON.stringify([tab, filterParams, filters.status, filters.overdue, reload]);
  useEffect(() => {
    if (tab === 'search') return undefined;
    let cancelled = false;
    const call = isClaims
      ? claimsApi.list({
          tab,
          ...filterParams,
          status: filters.status || undefined,
          overdue: filters.overdue || undefined,
        })
      : warrantyApi.list({ tab, ...filterParams });
    call.then((d) => !cancelled && setList({ key: listKey, tab, data: d })).catch(toast.error);
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listKey, toast]);

  const changed = () => {
    setReload((n) => n + 1);
    loadAlerts();
  };
  const openUnit = (ref) => {
    setSeq((n) => n + 1);
    setUnit({ ref });
  };
  const openClaim = (id, opts = {}) => {
    setSeq((n) => n + 1);
    setClaim({ id, printSlip: Boolean(opts.printSlip) });
  };

  function onSearchKey(e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      const data = found.q === q ? found.data : null;
      if (!data) return;
      const matched = data.groups.flatMap((g) => g.units).filter((u) => u.matched);
      const all = data.groups.flatMap((g) => g.units);
      if (matched.length === 1) openUnit(refOf(matched[0]));
      else if (all.length === 1) openUnit(refOf(all[0]));
      else if (data.claims.length === 1 && all.length === 0) openClaim(data.claims[0].id);
    } else if (e.key === 'Escape') {
      setQuery('');
    }
  }

  useHotkeys(
    {
      '/': () => {
        setTab('search');
        searchRef.current?.focus();
      },
    },
    { enabled: !unit && !claim },
  );

  async function exportXlsx() {
    try {
      const r = isClaims
        ? await claimsApi.exportXlsx({
            tab,
            ...filterParams,
            status: filters.status || undefined,
            overdue: filters.overdue || undefined,
          })
        : await warrantyApi.exportXlsx({ tab: tab === 'search' ? 'active' : tab, ...filterParams });
      if (r.saved) toast.success(`Exported ${r.rows} rows to ${r.file_path}`);
    } catch (e) {
      toast.error(e);
    }
  }

  const setFilter = (k, v) => setFilters((f) => ({ ...f, [k]: v }));
  const activeFilters = Object.entries(filters).filter(([, v]) => v).length;
  const counts = {
    open: alerts?.open_claims,
    expiring: alerts?.expiring_this_month,
  };
  const searchData = q.length >= 2 ? found.data : null;
  // A list of another tab has another shape: show it only for its own tab.
  const listData = list.tab === tab ? list.data : null;

  return (
    <div className="mx-auto max-w-[1500px] space-y-4 p-6">
      {/* Big scanner-friendly search box */}
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search
            size={20}
            className="pointer-events-none absolute top-1/2 left-4 -translate-y-1/2 text-muted"
          />
          <Input
            ref={searchRef}
            autoFocus
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              if (tab !== 'search') setTab('search');
            }}
            onKeyDown={onSearchKey}
            placeholder="Scan or type serial no., invoice no., customer, phone, vehicle no. or claim no."
            className="h-12! rounded-xl! pr-12 pl-12 text-base"
          />
          <span className="absolute top-1/2 right-3 -translate-y-1/2">
            <Kbd>/</Kbd>
          </span>
        </div>
        <Button
          icon={SlidersHorizontal}
          onClick={() => setShowFilters((s) => !s)}
          className={showFilters ? 'border-primary text-primary' : ''}
        >
          Filters{activeFilters ? ` (${activeFilters})` : ''}
        </Button>
        <Button icon={FileDown} onClick={exportXlsx}>
          Export
        </Button>
      </div>

      {alerts && (alerts.overdue_at_supplier > 0 || alerts.ready_for_pickup > 0) && (
        <div className="flex flex-wrap gap-2 text-sm">
          {alerts.overdue_at_supplier > 0 && (
            <button
              type="button"
              onClick={() => {
                setTab('open');
                setFilters({ ...EMPTY_FILTERS, overdue: true });
              }}
              className="rounded-full bg-danger-soft px-3 py-1 font-medium text-danger"
            >
              {alerts.overdue_at_supplier} overdue at supplier
            </button>
          )}
          {alerts.ready_for_pickup > 0 && (
            <button
              type="button"
              onClick={() => {
                setTab('open');
                setFilters({ ...EMPTY_FILTERS, status: 'ready' });
              }}
              className="rounded-full bg-success-soft px-3 py-1 font-medium text-success"
            >
              {alerts.ready_for_pickup} ready for pickup
            </button>
          )}
        </div>
      )}

      <div className="no-scrollbar flex gap-1 overflow-x-auto rounded-xl border border-border bg-surface-2/50 p-1">
        {TABS.map((t) => {
          const Icon = t.icon;
          const on = t.id === tab;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={`relative flex h-9 shrink-0 items-center gap-2 rounded-lg px-3 text-sm font-medium whitespace-nowrap ${on ? 'text-primary' : 'text-muted hover:text-fg'}`}
            >
              {on && (
                <motion.span
                  layoutId="warranty-tab"
                  className="absolute inset-0 rounded-lg bg-surface shadow-sm"
                  transition={{ type: 'spring', stiffness: 500, damping: 40 }}
                />
              )}
              <Icon size={15} className="relative" />
              <span className="relative">{t.label}</span>
              {counts[t.id] > 0 && (
                <span className="relative rounded-full bg-primary-soft px-1.5 text-xs text-primary">
                  {counts[t.id]}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {showFilters && meta && (
        <motion.div
          initial={{ opacity: 0, y: -4 }}
          animate={{ opacity: 1, y: 0 }}
          className="grid grid-cols-2 gap-3 rounded-2xl border border-border bg-surface p-4 xl:grid-cols-4"
        >
          <Select value={filters.brand} onChange={(e) => setFilter('brand', e.target.value)}>
            <option value="">All brands</option>
            {meta.brands.map((b) => (
              <option key={b}>{b}</option>
            ))}
          </Select>
          <Select
            value={filters.category_id}
            onChange={(e) => setFilter('category_id', e.target.value)}
          >
            <option value="">All categories</option>
            {meta.categories
              .filter((c) => c.parent_id === null)
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
          </Select>
          <Select
            value={filters.supplier_id}
            onChange={(e) => setFilter('supplier_id', e.target.value)}
          >
            <option value="">All suppliers</option>
            {meta.suppliers.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
          <Input
            value={filters.technician}
            placeholder="Technician / staff"
            onChange={(e) => setFilter('technician', e.target.value)}
          />
          <label className="flex items-center gap-2 text-xs text-muted">
            From{' '}
            <Input
              type="date"
              value={filters.from}
              onChange={(e) => setFilter('from', e.target.value)}
            />
          </label>
          <label className="flex items-center gap-2 text-xs text-muted">
            To{' '}
            <Input
              type="date"
              value={filters.to}
              onChange={(e) => setFilter('to', e.target.value)}
            />
          </label>
          {isClaims && (
            <Select value={filters.status} onChange={(e) => setFilter('status', e.target.value)}>
              <option value="">Any claim status</option>
              {Object.entries(meta.statuses).map(([k, l]) => (
                <option key={k} value={k}>
                  {l}
                </option>
              ))}
            </Select>
          )}
          <div className="flex items-center gap-3">
            {isClaims && (
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={filters.overdue}
                  onChange={(e) => setFilter('overdue', e.target.checked)}
                />{' '}
                Overdue at supplier
              </label>
            )}
            <Button size="sm" variant="ghost" onClick={() => setFilters(EMPTY_FILTERS)}>
              Clear
            </Button>
          </div>
        </motion.div>
      )}

      {!meta ? (
        <Skeleton className="h-64" />
      ) : tab === 'search' ? (
        <SearchResults
          result={searchData}
          loading={q.length >= 2 && found.q !== q}
          onOpen={openUnit}
          onOpenClaim={openClaim}
          meta={meta}
        />
      ) : isClaims ? (
        <ClaimsTable data={listData} loading={list.key !== listKey} onOpenClaim={openClaim} />
      ) : (
        <WarrantyTable
          data={listData}
          loading={list.key !== listKey}
          onOpen={openUnit}
          onOpenClaim={openClaim}
        />
      )}

      {meta && unit && (
        <UnitDrawer
          key={`u${seq}`}
          open
          unitRef={unit.ref}
          meta={meta}
          onClose={() => setUnit(null)}
          onChanged={changed}
          onOpenClaim={(id, opts) => {
            setUnit(null);
            openClaim(id, opts);
          }}
        />
      )}
      {meta && claim && (
        <ClaimDrawer
          key={`c${seq}`}
          open
          claimId={claim.id}
          printSlip={claim.printSlip}
          meta={meta}
          onClose={() => setClaim(null)}
          onChanged={changed}
          onOpenUnit={(ref) => {
            setClaim(null);
            openUnit(ref);
          }}
        />
      )}
    </div>
  );
}
