import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import {
  AlarmClock,
  AlertTriangle,
  CalendarRange,
  FileStack,
  IndianRupee,
  PauseCircle,
  Plus,
  ReceiptText,
  Search,
  SlidersHorizontal,
  Trash2,
  Truck,
  Undo2,
} from 'lucide-react';
import Button from '../../components/Button';
import { Input, Segmented, Select } from '../../components/Field';
import { AnimatedNumber, Badge, EmptyState, Kbd, Skeleton } from '../../components/Feedback';
import VirtualList from '../../components/VirtualList';
import ConfirmDialog from '../../components/ConfirmDialog';
import SupplierPicker from '../../components/SupplierPicker';
import { anyOverlayOpen } from '../../components/Overlay';
import { useToast } from '../../components/Toast';
import { useHotkeys } from '../../hooks/useHotkeys';
import { purchaseDraftsApi, purchaseReturnsApi, purchasesApi } from '../../api/purchases';
import { formatMoney } from '../../utils/money';
import { formatDate, formatDateTime } from '../../utils/dates';
import PayStatus from './PayStatus';
import PurchaseDrawer, { ReturnDetailModal } from './PurchaseDrawer';
import { ReturnModal } from './PurchaseModals';

const ROW_HEIGHT = 56;
const EMPTY_FILTERS = {
  from: '',
  to: '',
  supplier: null,
  bill_type: '',
  pay_status: '',
  mismatched: false,
};
const GRID = 'grid grid-cols-[8rem_9rem_7rem_minmax(0,1fr)_4rem_8rem_8rem_8rem_7.5rem] gap-3 px-4';
const RGRID = 'grid grid-cols-[8rem_7rem_minmax(0,1fr)_9rem_5rem_8rem_7rem] gap-3 px-4';

function StatCard({ icon: Icon, label, value, format, tone, sub, active, onClick }) {
  return (
    <motion.button
      type="button"
      onClick={onClick}
      whileHover={{ y: -2 }}
      whileTap={{ scale: 0.98 }}
      className={`flex items-center gap-4 rounded-2xl border bg-surface p-4 text-left shadow-sm transition-colors ${active ? 'border-primary ring-2 ring-primary/20' : 'border-border'}`}
    >
      <div className={`rounded-xl p-3 ${tone}`}>
        <Icon size={20} />
      </div>
      <div className="min-w-0">
        <div className="text-xs font-medium text-muted">{label}</div>
        <div className="truncate text-xl font-bold tabular-nums">
          {value == null ? (
            <Skeleton className="mt-1 h-6 w-20" />
          ) : (
            <AnimatedNumber value={value} format={format} />
          )}
        </div>
        {sub && <div className="truncate text-xs text-muted">{sub}</div>}
      </div>
    </motion.button>
  );
}

export default function Purchases() {
  const toast = useToast();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const tab = ['drafts', 'returns'].includes(params.get('tab')) ? params.get('tab') : 'all';
  const searchRef = useRef(null);

  const [stats, setStats] = useState(null);
  const [result, setResult] = useState({ key: null, data: null });
  const [reloadSeq, setReloadSeq] = useState(0);
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [showFilters, setShowFilters] = useState(false);
  const [selected, setSelected] = useState(0);
  // Deep link /purchases?open=<id> (from the entry screen, supplier tabs, product history).
  const [drawer, setDrawer] = useState(() => {
    const id = Number(params.get('open'));
    return id ? { open: true, id } : { open: false, id: null };
  });
  const [returnView, setReturnView] = useState(null);
  const [newReturn, setNewReturn] = useState(false);
  const [discard, setDiscard] = useState(null);
  const [seq, setSeq] = useState(0);

  const loadStats = useCallback(
    () =>
      purchasesApi
        .stats()
        .then(setStats)
        .catch(() => {}),
    [],
  );
  useEffect(() => {
    loadStats();
  }, [loadStats]);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(search.trim()), 180);
    return () => clearTimeout(t);
  }, [search]);

  const query = {
    tab,
    search: debounced,
    from: filters.from,
    to: filters.to,
    party_id: filters.supplier?.id ?? null,
    bill_type: filters.bill_type,
    pay_status: filters.pay_status,
    mismatched: filters.mismatched,
  };
  const queryKey = JSON.stringify([query, reloadSeq]);
  const loading = result.key !== queryKey;
  useEffect(() => {
    let cancelled = false;
    const [q] = JSON.parse(queryKey);
    const run =
      q.tab === 'drafts'
        ? purchaseDraftsApi.list().then((rows) => ({ rows, total: rows.length }))
        : q.tab === 'returns'
          ? purchaseReturnsApi.list(q).then((rows) => ({ rows, total: rows.length }))
          : purchasesApi.list(q);
    run.then((d) => !cancelled && setResult({ key: queryKey, data: d })).catch(toast.error);
    return () => {
      cancelled = true;
    };
  }, [queryKey, toast]);

  function refreshAll() {
    setReloadSeq((n) => n + 1);
    loadStats();
  }

  function openPurchase(id) {
    setSeq((n) => n + 1);
    setDrawer({ open: true, id });
  }

  const deepLink = params.get('open');
  useEffect(() => {
    if (!deepLink) return;
    const next = new URLSearchParams(params);
    next.delete('open');
    setParams(next, { replace: true });
  }, [deepLink, params, setParams]);

  const data = result.data;
  const rows = useMemo(() => data?.rows || [], [data]);
  const current = Math.max(0, Math.min(selected, rows.length - 1));

  function openRow(r) {
    if (!r) return;
    if (tab === 'drafts') navigate(`/purchases/new?draft=${r.id}`);
    else if (tab === 'returns') {
      setSeq((n) => n + 1);
      setReturnView(r.id);
    } else openPurchase(r.id);
  }

  const overlay = drawer.open || returnView || newReturn || discard;
  useHotkeys(
    {
      N: () => navigate('/purchases/new'),
      '/': () => searchRef.current?.focus(),
      ArrowDown: () => setSelected(Math.min(current + 1, rows.length - 1)),
      ArrowUp: () => setSelected(Math.max(current - 1, 0)),
      Enter: () => !anyOverlayOpen() && openRow(rows[current]),
    },
    { enabled: !overlay },
  );

  function switchTab(next) {
    setParams(next === 'all' ? {} : { tab: next }, { replace: true });
    setSelected(0);
  }

  function setFilter(k, v) {
    setFilters((f) => ({ ...f, [k]: v }));
    setSelected(0);
  }

  const activeFilterCount =
    ['from', 'to', 'bill_type', 'pay_status'].filter((k) => filters[k]).length +
    (filters.supplier ? 1 : 0) +
    (filters.mismatched ? 1 : 0);

  function onSearchKey(e) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setSelected(
        e.key === 'ArrowDown' ? Math.min(current + 1, rows.length - 1) : Math.max(current - 1, 0),
      );
    } else if (e.key === 'Enter') {
      e.preventDefault();
      openRow(rows[current]);
    } else if (e.key === 'Escape') {
      setSearch('');
      e.currentTarget.blur();
    }
  }

  return (
    <div className="mx-auto flex max-w-[1600px] flex-col gap-4 p-6">
      <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
        <StatCard
          icon={ReceiptText}
          label="Purchases this month"
          value={stats?.month_amount}
          format={formatMoney}
          sub={stats ? `${stats.month_bills} bill${stats.month_bills === 1 ? '' : 's'}` : null}
          tone="bg-primary-soft text-primary"
          onClick={() => switchTab('all')}
        />
        <StatCard
          icon={IndianRupee}
          label="Total payable"
          value={stats?.total_payable}
          format={formatMoney}
          tone="bg-warning-soft text-warning"
          active={filters.pay_status === 'unpaid'}
          onClick={() => {
            switchTab('all');
            setFilter('pay_status', filters.pay_status === 'unpaid' ? '' : 'unpaid');
          }}
        />
        <StatCard
          icon={AlarmClock}
          label="Overdue payable"
          value={stats?.overdue_payable}
          format={formatMoney}
          sub={
            stats
              ? `${stats.overdue_bills} bill${stats.overdue_bills === 1 ? '' : 's'} past due`
              : null
          }
          tone="bg-danger-soft text-danger"
          active={filters.pay_status === 'overdue'}
          onClick={() => {
            switchTab('all');
            setFilter('pay_status', filters.pay_status === 'overdue' ? '' : 'overdue');
          }}
        />
        <StatCard
          icon={FileStack}
          label="Purchase bills"
          value={stats?.bills}
          sub={
            stats
              ? `${stats.drafts} draft${stats.drafts === 1 ? '' : 's'} · ${stats.mismatched} mismatched`
              : null
          }
          tone="bg-success-soft text-success"
          active={filters.mismatched}
          onClick={() => {
            switchTab('all');
            setFilter('mismatched', !filters.mismatched);
          }}
        />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Segmented
          layoutId="purchases-tab"
          value={tab}
          onChange={switchTab}
          options={[
            { value: 'all', label: 'Purchases', icon: Truck },
            {
              value: 'drafts',
              label: `Drafts${stats?.drafts ? ` (${stats.drafts})` : ''}`,
              icon: PauseCircle,
            },
            { value: 'returns', label: 'Returns', icon: Undo2 },
          ]}
        />
        {tab !== 'drafts' && (
          <div className="relative min-w-60 flex-1">
            <Search
              size={16}
              className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted"
            />
            <Input
              ref={searchRef}
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setSelected(0);
              }}
              onKeyDown={onSearchKey}
              placeholder={
                tab === 'returns'
                  ? 'Search debit note, supplier, bill, product…'
                  : 'Search entry no., bill no., supplier, product, serial…'
              }
              className="pr-10 pl-9"
            />
            <span className="absolute top-1/2 right-2 -translate-y-1/2">
              <Kbd>/</Kbd>
            </span>
          </div>
        )}
        {tab === 'drafts' && <div className="flex-1" />}
        {tab !== 'drafts' && (
          <Button
            icon={SlidersHorizontal}
            onClick={() => setShowFilters((s) => !s)}
            className={showFilters ? 'border-primary text-primary' : ''}
          >
            Filters{activeFilterCount ? ` (${activeFilterCount})` : ''}
          </Button>
        )}
        {tab === 'returns' && (
          <Button
            icon={Undo2}
            onClick={() => {
              setSeq((n) => n + 1);
              setNewReturn(true);
            }}
          >
            Standalone return
          </Button>
        )}
        <Button variant="primary" icon={Plus} onClick={() => navigate('/purchases/new')}>
          New purchase <Kbd>N</Kbd>
        </Button>
      </div>

      <AnimatePresence initial={false}>
        {showFilters && tab !== 'drafts' && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.18 }}
            className="shrink-0 overflow-hidden"
          >
            <div className="grid grid-cols-2 items-center gap-3 rounded-2xl border border-border bg-surface p-4 xl:grid-cols-[auto_auto_minmax(16rem,1fr)_auto_auto_auto_auto]">
              <label className="flex items-center gap-2 text-sm text-muted">
                <CalendarRange size={15} /> From
                <Input
                  type="date"
                  value={filters.from}
                  onChange={(e) => setFilter('from', e.target.value)}
                  className="w-40"
                />
              </label>
              <label className="flex items-center gap-2 text-sm text-muted">
                to
                <Input
                  type="date"
                  value={filters.to}
                  onChange={(e) => setFilter('to', e.target.value)}
                  className="w-40"
                />
              </label>
              <SupplierPicker value={filters.supplier} onChange={(s) => setFilter('supplier', s)} />
              <Select
                value={filters.bill_type}
                onChange={(e) => setFilter('bill_type', e.target.value)}
              >
                <option value="">GST + Non-GST</option>
                <option value="gst">GST bills</option>
                <option value="non_gst">Non-GST bills</option>
              </Select>
              {tab === 'all' && (
                <>
                  <Select
                    value={filters.pay_status}
                    onChange={(e) => setFilter('pay_status', e.target.value)}
                  >
                    <option value="">Any payment status</option>
                    <option value="paid">Paid</option>
                    <option value="partial">Partly paid</option>
                    <option value="unpaid">Unpaid</option>
                    <option value="overdue">Overdue</option>
                  </Select>
                  <label className="flex items-center gap-2 text-sm whitespace-nowrap">
                    <input
                      type="checkbox"
                      className="h-4 w-4 accent-primary"
                      checked={filters.mismatched}
                      onChange={(e) => setFilter('mismatched', e.target.checked)}
                    />
                    Mismatched bills
                  </label>
                </>
              )}
              {activeFilterCount > 0 && (
                <Button variant="ghost" size="sm" onClick={() => setFilters(EMPTY_FILTERS)}>
                  Clear
                </Button>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="flex h-[calc(100vh-24.5rem)] min-h-64 flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-sm">
        {tab === 'all' && (
          <div
            className={`${GRID} shrink-0 border-b border-border bg-surface-2 py-2.5 text-xs font-medium text-muted`}
          >
            <span>Entry no.</span>
            <span>Supplier bill</span>
            <span>Bill date</span>
            <span>Supplier</span>
            <span className="text-right">Items</span>
            <span className="text-right">Total</span>
            <span className="text-right">Paid</span>
            <span className="text-right">Due</span>
            <span>Status</span>
          </div>
        )}
        {tab === 'returns' && (
          <div
            className={`${RGRID} shrink-0 border-b border-border bg-surface-2 py-2.5 text-xs font-medium text-muted`}
          >
            <span>Debit note</span>
            <span>Date</span>
            <span>Supplier</span>
            <span>Against</span>
            <span className="text-right">Items</span>
            <span className="text-right">Credit</span>
            <span>Status</span>
          </div>
        )}
        {!data && loading ? (
          <div className="space-y-2 p-3">
            {Array.from({ length: 8 }, (_, i) => (
              <Skeleton key={i} className="h-10" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <EmptyState
            icon={tab === 'drafts' ? PauseCircle : tab === 'returns' ? Undo2 : Truck}
            title={
              debounced || activeFilterCount
                ? 'No matches'
                : tab === 'drafts'
                  ? 'No drafts'
                  : tab === 'returns'
                    ? 'No purchase returns'
                    : 'No purchases yet'
            }
          >
            {debounced || activeFilterCount
              ? 'Try a different search or clear the filters.'
              : tab === 'drafts'
                ? 'Use "Save draft" on a purchase to hold it and finish later.'
                : tab === 'returns'
                  ? 'Open a purchase and choose Return, or make a standalone return.'
                  : 'Press N to enter your first supplier bill.'}
          </EmptyState>
        ) : (
          <VirtualList
            items={rows}
            rowHeight={ROW_HEIGHT}
            selected={current}
            className={`flex-1 transition-opacity ${loading ? 'opacity-60' : ''}`}
            renderRow={(r, i) => {
              const base = `h-full cursor-pointer items-center border-b border-border text-sm transition-colors ${i === current ? 'bg-primary-soft/50' : 'hover:bg-surface-2/60'}`;
              if (tab === 'drafts') {
                return (
                  <div
                    role="button"
                    tabIndex={-1}
                    onClick={() => openRow(r)}
                    onMouseEnter={() => setSelected(i)}
                    className={`${base} flex gap-4 px-4`}
                  >
                    <PauseCircle size={18} className="text-warning" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium">
                        {r.supplier_name || 'No supplier yet'}
                      </div>
                      <div className="text-xs text-muted">
                        {r.bill_no ? `Bill ${r.bill_no} · ` : ''}
                        {r.item_count} item{r.item_count === 1 ? '' : 's'} · saved{' '}
                        {formatDateTime(r.updated_at)}
                      </div>
                    </div>
                    <span className="font-semibold tabular-nums">{formatMoney(r.total)}</span>
                    <Button
                      size="icon-sm"
                      variant="danger-ghost"
                      icon={Trash2}
                      title="Discard draft"
                      onClick={(e) => {
                        e.stopPropagation();
                        setDiscard(r);
                      }}
                    />
                  </div>
                );
              }
              if (tab === 'returns') {
                return (
                  <div
                    role="button"
                    tabIndex={-1}
                    onClick={() => openRow(r)}
                    onMouseEnter={() => setSelected(i)}
                    className={`${RGRID} ${base} ${r.status !== 'active' ? 'opacity-60' : ''}`}
                  >
                    <span className="font-medium">{r.return_no}</span>
                    <span className="text-muted">{formatDate(r.date)}</span>
                    <span className="truncate">{r.supplier_name}</span>
                    <span className="truncate text-muted">
                      {r.entry_no
                        ? `${r.entry_no}${r.bill_no ? ` / ${r.bill_no}` : ''}`
                        : 'Standalone'}
                    </span>
                    <span className="text-right tabular-nums">{r.item_count}</span>
                    <span className="text-right tabular-nums">{formatMoney(r.total)}</span>
                    <span>
                      {r.status === 'active' ? (
                        <Badge tone={r.settlement === 'refund' ? 'success' : 'primary'}>
                          {r.settlement === 'refund' ? 'Refunded' : 'Adjusted'}
                        </Badge>
                      ) : (
                        <Badge tone="danger">Cancelled</Badge>
                      )}
                    </span>
                  </div>
                );
              }
              return (
                <div
                  role="button"
                  tabIndex={-1}
                  onClick={() => openRow(r)}
                  onMouseEnter={() => setSelected(i)}
                  className={`${GRID} ${base} ${r.status !== 'active' ? 'opacity-60' : ''}`}
                >
                  <span className="flex items-center gap-1.5 font-medium">
                    {r.entry_no}
                    {r.total_mismatch && r.status === 'active' ? (
                      <span
                        title={`Differs from printed total by ${formatMoney(Math.abs(r.mismatch_amount))}`}
                      >
                        <AlertTriangle size={13} className="text-warning" />
                      </span>
                    ) : null}
                  </span>
                  <span className="truncate font-mono text-xs">{r.bill_no || '—'}</span>
                  <span className="text-muted">{formatDate(r.bill_date)}</span>
                  <span className="min-w-0">
                    <span className="block truncate">{r.supplier_name}</span>
                    <span className="block text-xs text-muted">
                      {r.bill_type === 'gst' ? 'GST' : 'Non-GST'}
                    </span>
                  </span>
                  <span className="text-right tabular-nums">{r.item_count}</span>
                  <span className="text-right font-medium tabular-nums">
                    {formatMoney(r.grand_total)}
                  </span>
                  <span className="text-right tabular-nums">
                    {r.status === 'active' ? formatMoney(r.paid) : '—'}
                  </span>
                  <span className="text-right tabular-nums">
                    {r.status === 'active' && r.due > 0 ? formatMoney(r.due) : '—'}
                    {r.status === 'active' && r.due > 0 && r.due_date && (
                      <span className="block text-[11px] text-muted">
                        by {formatDate(r.due_date)}
                      </span>
                    )}
                  </span>
                  <span>
                    <PayStatus status={r.pay_status} />
                  </span>
                </div>
              );
            }}
          />
        )}
      </div>

      {data && data.total > 0 && (
        <div className="flex shrink-0 items-center justify-between text-sm text-muted">
          <span>
            {data.total.toLocaleString('en-IN')}{' '}
            {tab === 'drafts' ? 'drafts' : tab === 'returns' ? 'returns' : 'bills'}
            {data.truncated ? ' (showing the first 5,000; refine the search)' : ''}
          </span>
          <span className="hidden xl:inline">
            <Kbd>↑</Kbd> <Kbd>↓</Kbd> select · <Kbd>Enter</Kbd> open · <Kbd>N</Kbd> new ·{' '}
            <Kbd>/</Kbd> search
          </span>
        </div>
      )}

      {drawer.id && (
        <PurchaseDrawer
          key={`drawer-${seq}`}
          open={drawer.open}
          purchaseId={drawer.id}
          onChanged={refreshAll}
          onOpenReturn={(id) => {
            setSeq((n) => n + 1);
            setReturnView(id);
          }}
          onClose={() => setDrawer((d) => ({ ...d, open: false }))}
        />
      )}
      {returnView && (
        <ReturnDetailModal
          key={`ret-${seq}`}
          open
          returnId={returnView}
          onClose={() => setReturnView(null)}
          onChanged={refreshAll}
        />
      )}
      {newReturn && (
        <ReturnModal
          key={`newret-${seq}`}
          open
          onClose={() => setNewReturn(false)}
          onDone={() => {
            setNewReturn(false);
            refreshAll();
          }}
        />
      )}
      {discard && (
        <ConfirmDialog
          title="Discard this draft?"
          confirmLabel="Discard"
          danger
          onCancel={() => setDiscard(null)}
          onConfirm={() =>
            purchaseDraftsApi
              .discard(discard.id)
              .then(() => {
                setDiscard(null);
                refreshAll();
              })
              .catch(toast.error)
          }
        >
          {discard.supplier_name || 'This draft'} ({discard.item_count} items) will be removed from
          the drafts list.
        </ConfirmDialog>
      )}
    </div>
  );
}
