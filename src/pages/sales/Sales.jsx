import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import {
  ArrowLeftRight,
  CalendarDays,
  CalendarRange,
  FileText,
  IndianRupee,
  PauseCircle,
  Plus,
  ReceiptText,
  Search,
  SlidersHorizontal,
  Trash2,
  Undo2,
  Wallet,
} from 'lucide-react';
import Button from '../../components/Button';
import { Input, Segmented, Select } from '../../components/Field';
import { AnimatedNumber, Badge, EmptyState, Kbd, Skeleton } from '../../components/Feedback';
import VirtualList from '../../components/VirtualList';
import ConfirmDialog from '../../components/ConfirmDialog';
import { anyOverlayOpen } from '../../components/Overlay';
import { useToast } from '../../components/Toast';
import { useHotkeys } from '../../hooks/useHotkeys';
import { quotationsApi, saleDraftsApi, saleReturnsApi, salesApi } from '../../api/sales';
import { formatMoney } from '../../utils/money';
import { formatDate, formatDateTime } from '../../utils/dates';
import PayStatus from '../purchases/PayStatus';
import SaleDrawer from './SaleDrawer';
import { CreditNoteModal, QuotationModal, SaleReturnModal } from './SaleModals';

const ROW_HEIGHT = 56;
const EMPTY_FILTERS = {
  from: '',
  to: '',
  bill_type: '',
  pay_status: '',
  pay_mode: '',
  status: 'all',
  technician: '',
};
const GRID =
  'grid grid-cols-[7rem_6.5rem_minmax(0,1fr)_9rem_3.5rem_7.5rem_7.5rem_7.5rem_7rem] gap-3 px-4';
const QGRID = 'grid grid-cols-[7rem_6.5rem_minmax(0,1fr)_7rem_3.5rem_8rem_8rem] gap-3 px-4';
const RGRID = 'grid grid-cols-[8rem_6.5rem_minmax(0,1fr)_9rem_3.5rem_8rem_7rem] gap-3 px-4';
const TABS = ['bills', 'quotations', 'returns', 'held'];
const Q_STATUS = {
  open: ['primary', 'Open'],
  expired: ['warning', 'Expired'],
  converted: ['success', 'Converted'],
  cancelled: ['danger', 'Cancelled'],
};

function StatCard({ icon: Icon, label, value, format, tone, sub, onClick, active }) {
  return (
    <motion.button
      type="button"
      onClick={onClick}
      whileHover={{ y: -2 }}
      whileTap={{ scale: 0.98 }}
      className={`flex items-center gap-4 rounded-2xl border bg-surface p-4 text-left shadow-sm ${active ? 'border-primary ring-2 ring-primary/20' : 'border-border'}`}
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

export default function Sales() {
  const toast = useToast();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const tab = TABS.includes(params.get('tab')) ? params.get('tab') : 'bills';
  const searchRef = useRef(null);
  const [stats, setStats] = useState(null);
  const [result, setResult] = useState({ key: null, data: null });
  const [reloadSeq, setReloadSeq] = useState(0);
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [showFilters, setShowFilters] = useState(false);
  const [selected, setSelected] = useState(0);
  const [drawer, setDrawer] = useState({ open: false, id: null });
  const [quoteView, setQuoteView] = useState(null);
  const [creditView, setCreditView] = useState(null);
  const [newReturn, setNewReturn] = useState(false);
  const [discard, setDiscard] = useState(null);
  const [seq, setSeq] = useState(0);

  const loadStats = useCallback(
    () =>
      salesApi
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

  const query = { tab, search: debounced, ...filters };
  const queryKey = JSON.stringify([query, reloadSeq]);
  const loading = result.key !== queryKey;
  useEffect(() => {
    let cancelled = false;
    const [q] = JSON.parse(queryKey);
    const run =
      q.tab === 'held'
        ? saleDraftsApi.list().then((rows) => ({ rows, total: rows.length }))
        : q.tab === 'quotations'
          ? quotationsApi.list(q)
          : q.tab === 'returns'
            ? saleReturnsApi.list(q)
            : salesApi.list(q);
    run.then((d) => !cancelled && setResult({ key: queryKey, data: d })).catch(toast.error);
    return () => {
      cancelled = true;
    };
  }, [queryKey, toast]);

  // Deep link /sales?open=<id> (dashboard, Ctrl+K, customer bills): open it once.
  const deepLink = params.get('open');
  const [linkSeen, setLinkSeen] = useState(null);
  if (deepLink && deepLink !== linkSeen) {
    setLinkSeen(deepLink);
    const id = Number(deepLink);
    if (id && tab === 'quotations') setQuoteView(id);
    else if (id) setDrawer({ open: true, id });
  }
  useEffect(() => {
    if (!deepLink) return;
    const next = new URLSearchParams(params);
    next.delete('open');
    setParams(next, { replace: true });
  }, [deepLink, params, setParams]);

  function refreshAll() {
    setReloadSeq((n) => n + 1);
    loadStats();
  }

  const data = result.data;
  const rows = useMemo(() => data?.rows || [], [data]);
  const current = Math.max(0, Math.min(selected, rows.length - 1));

  function openRow(r) {
    if (!r) return;
    setSeq((n) => n + 1);
    if (tab === 'held') navigate('/billing', { state: { draft: r.id } });
    else if (tab === 'quotations') setQuoteView(r.id);
    else if (tab === 'returns') setCreditView(r.id);
    else setDrawer({ open: true, id: r.id });
  }

  const overlay = drawer.open || quoteView || creditView || newReturn || discard;
  useHotkeys(
    {
      N: () => navigate('/billing'),
      '/': () => searchRef.current?.focus(),
      ArrowDown: () => setSelected(Math.min(current + 1, rows.length - 1)),
      ArrowUp: () => setSelected(Math.max(current - 1, 0)),
      Enter: () => !anyOverlayOpen() && openRow(rows[current]),
    },
    { enabled: !overlay },
  );

  function switchTab(next) {
    setParams(next === 'bills' ? {} : { tab: next }, { replace: true });
    setSelected(0);
  }
  function setFilter(k, v) {
    setFilters((f) => ({ ...f, [k]: v }));
    setSelected(0);
  }
  const activeFilterCount = Object.entries(filters).filter(
    ([k, v]) => v && !(k === 'status' && v === 'all'),
  ).length;

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

  const modes = stats?.today_by_mode;
  return (
    <div className="mx-auto flex max-w-[1600px] flex-col gap-4 p-6">
      <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
        <StatCard
          icon={CalendarDays}
          label="Today's sales"
          value={stats?.today_amount}
          format={formatMoney}
          sub={
            stats
              ? `${stats.today_bills} bill${stats.today_bills === 1 ? '' : 's'} (after returns)`
              : null
          }
          tone="bg-primary-soft text-primary"
          onClick={() => {
            switchTab('bills');
            setFilters({ ...EMPTY_FILTERS, from: stats?.today || '', to: stats?.today || '' });
          }}
        />
        <StatCard
          icon={ReceiptText}
          label="This month"
          value={stats?.month_amount}
          format={formatMoney}
          sub={stats ? `${stats.month_bills} bills since ${formatDate(stats.month_from)}` : null}
          tone="bg-success-soft text-success"
          onClick={() => switchTab('bills')}
        />
        <StatCard
          icon={Wallet}
          label="Today: cash · UPI · credit"
          value={modes ? modes.cash : null}
          format={formatMoney}
          sub={
            modes
              ? `UPI ${formatMoney(modes.upi)} · card/bank ${formatMoney(modes.card + modes.bank + modes.cheque)} · credit ${formatMoney(stats.today_credit)}`
              : null
          }
          tone="bg-warning-soft text-warning"
          onClick={() => switchTab('bills')}
        />
        <StatCard
          icon={IndianRupee}
          label="Pending from customers"
          value={stats?.receivable}
          format={formatMoney}
          sub="Click: unpaid bills"
          tone="bg-danger-soft text-danger"
          active={filters.pay_status === 'unpaid'}
          onClick={() => {
            switchTab('bills');
            setFilter('pay_status', filters.pay_status === 'unpaid' ? '' : 'unpaid');
          }}
        />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Segmented
          layoutId="sales-tab"
          value={tab}
          onChange={switchTab}
          options={[
            { value: 'bills', label: 'Bills', icon: ReceiptText },
            {
              value: 'quotations',
              label: `Quotations${stats?.open_quotations ? ` (${stats.open_quotations})` : ''}`,
              icon: FileText,
            },
            { value: 'returns', label: 'Credit notes', icon: Undo2 },
            {
              value: 'held',
              label: `Held${stats?.held ? ` (${stats.held})` : ''}`,
              icon: PauseCircle,
            },
          ]}
        />
        {tab !== 'held' ? (
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
              placeholder="Invoice no., customer, phone, vehicle no., serial, product…"
              className="pr-10 pl-9"
            />
            <span className="absolute top-1/2 right-2 -translate-y-1/2">
              <Kbd>/</Kbd>
            </span>
          </div>
        ) : (
          <div className="flex-1" />
        )}
        {tab !== 'held' && (
          <Button
            icon={SlidersHorizontal}
            onClick={() => setShowFilters((s) => !s)}
            className={showFilters ? 'border-primary text-primary' : ''}
          >
            Filters{activeFilterCount ? ` (${activeFilterCount})` : ''}
          </Button>
        )}
        <Button
          icon={Undo2}
          onClick={() => {
            setSeq((n) => n + 1);
            setNewReturn(true);
          }}
        >
          Return / exchange
        </Button>
        {tab === 'quotations' && (
          <Button
            icon={FileText}
            onClick={() => navigate('/billing', { state: { kind: 'quotation' } })}
          >
            New quotation
          </Button>
        )}
        <Button variant="primary" icon={Plus} onClick={() => navigate('/billing')}>
          New bill <Kbd>N</Kbd>
        </Button>
      </div>

      <AnimatePresence initial={false}>
        {showFilters && tab !== 'held' && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.18 }}
            className="shrink-0 overflow-hidden"
          >
            <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-border bg-surface p-4">
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
              <Select
                value={filters.bill_type}
                onChange={(e) => setFilter('bill_type', e.target.value)}
                className="w-40"
              >
                <option value="">GST + Non-GST</option>
                <option value="gst">GST invoices</option>
                <option value="non_gst">Non-GST bills</option>
              </Select>
              {tab === 'bills' && (
                <>
                  <Select
                    value={filters.pay_status}
                    onChange={(e) => setFilter('pay_status', e.target.value)}
                    className="w-44"
                  >
                    <option value="">Any payment status</option>
                    <option value="paid">Paid</option>
                    <option value="partial">Partly paid</option>
                    <option value="unpaid">Unpaid</option>
                    <option value="overdue">Overdue</option>
                  </Select>
                  <Select
                    value={filters.pay_mode}
                    onChange={(e) => setFilter('pay_mode', e.target.value)}
                    className="w-40"
                  >
                    <option value="">Any payment mode</option>
                    <option value="cash">Cash</option>
                    <option value="upi">UPI</option>
                    <option value="card">Card</option>
                    <option value="bank">Bank</option>
                    <option value="cheque">Cheque</option>
                    <option value="credit">On credit</option>
                  </Select>
                  <Select
                    value={filters.status}
                    onChange={(e) => setFilter('status', e.target.value)}
                    className="w-40"
                  >
                    <option value="all">Active + cancelled</option>
                    <option value="active">Active only</option>
                    <option value="cancelled">Cancelled only</option>
                  </Select>
                  <Input
                    value={filters.technician}
                    placeholder="Fitted by…"
                    onChange={(e) => setFilter('technician', e.target.value)}
                    className="w-40"
                  />
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
        {tab === 'bills' && (
          <div
            className={`${GRID} shrink-0 border-b border-border bg-surface-2 py-2.5 text-xs font-medium text-muted`}
          >
            <span>No.</span>
            <span>Date</span>
            <span>Customer</span>
            <span>Vehicle</span>
            <span className="text-right">Items</span>
            <span className="text-right">Total</span>
            <span className="text-right">Paid</span>
            <span className="text-right">Due</span>
            <span>Status</span>
          </div>
        )}
        {tab === 'quotations' && (
          <div
            className={`${QGRID} shrink-0 border-b border-border bg-surface-2 py-2.5 text-xs font-medium text-muted`}
          >
            <span>No.</span>
            <span>Date</span>
            <span>Customer</span>
            <span>Valid till</span>
            <span className="text-right">Items</span>
            <span className="text-right">Total</span>
            <span>Status</span>
          </div>
        )}
        {tab === 'returns' && (
          <div
            className={`${RGRID} shrink-0 border-b border-border bg-surface-2 py-2.5 text-xs font-medium text-muted`}
          >
            <span>Credit note</span>
            <span>Date</span>
            <span>Customer</span>
            <span>Against</span>
            <span className="text-right">Items</span>
            <span className="text-right">Credit</span>
            <span>Settled</span>
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
            icon={
              tab === 'held'
                ? PauseCircle
                : tab === 'returns'
                  ? Undo2
                  : tab === 'quotations'
                    ? FileText
                    : ReceiptText
            }
            title={
              debounced || activeFilterCount
                ? 'No matches'
                : {
                    bills: 'No bills yet',
                    quotations: 'No quotations',
                    returns: 'No credit notes',
                    held: 'No held bills',
                  }[tab]
            }
          >
            {debounced || activeFilterCount
              ? 'Try a different search or clear the filters.'
              : {
                  bills: 'Press N to make the first bill.',
                  quotations: 'Switch the billing screen to Quotation to make one.',
                  returns: 'Use "Return / exchange" to make a credit note.',
                  held: 'Use Hold (Ctrl+H) on the billing screen to park a bill.',
                }[tab]}
          </EmptyState>
        ) : (
          <VirtualList
            items={rows}
            rowHeight={ROW_HEIGHT}
            selected={current}
            className={`flex-1 transition-opacity ${loading ? 'opacity-60' : ''}`}
            renderRow={(r, i) => {
              const base = `h-full cursor-pointer items-center border-b border-border text-sm transition-colors ${i === current ? 'bg-primary-soft/50' : 'hover:bg-surface-2/60'}`;
              const common = {
                role: 'button',
                tabIndex: -1,
                onClick: () => openRow(r),
                onMouseEnter: () => setSelected(i),
              };
              if (tab === 'held') {
                return (
                  <div {...common} className={`${base} flex gap-4 px-4`}>
                    <PauseCircle size={18} className="text-warning" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium">
                        {r.customer_name || 'Cash Customer'}
                        {r.vehicle_no ? (
                          <span className="font-normal text-muted"> · {r.vehicle_no}</span>
                        ) : null}
                        {r.kind === 'quotation' && <Badge className="ml-2">quotation</Badge>}
                      </div>
                      <div className="text-xs text-muted">
                        {r.item_count} item{r.item_count === 1 ? '' : 's'} · held{' '}
                        {formatDateTime(r.updated_at)}
                      </div>
                    </div>
                    <span className="font-semibold tabular-nums">{formatMoney(r.total)}</span>
                    <Button
                      size="icon-sm"
                      variant="danger-ghost"
                      icon={Trash2}
                      title="Discard"
                      onClick={(e) => {
                        e.stopPropagation();
                        setDiscard(r);
                      }}
                    />
                  </div>
                );
              }
              if (tab === 'quotations') {
                const st = Q_STATUS[r.display_status];
                return (
                  <div
                    {...common}
                    className={`${QGRID} ${base} ${r.status === 'cancelled' ? 'opacity-60' : ''}`}
                  >
                    <span className="font-medium">{r.quote_no}</span>
                    <span className="text-muted">{formatDate(r.quote_date)}</span>
                    <span className="truncate">
                      {r.customer_name}
                      {r.vehicle_no ? <span className="text-muted"> · {r.vehicle_no}</span> : null}
                    </span>
                    <span className="text-muted">{formatDate(r.valid_till)}</span>
                    <span className="text-right tabular-nums">{r.item_count}</span>
                    <span className="text-right font-medium tabular-nums">
                      {formatMoney(r.grand_total)}
                    </span>
                    <span>
                      <Badge tone={st[0]}>
                        {st[1]}
                        {r.converted_invoice_no ? ` · ${r.converted_invoice_no}` : ''}
                      </Badge>
                    </span>
                  </div>
                );
              }
              if (tab === 'returns') {
                return (
                  <div
                    {...common}
                    className={`${RGRID} ${base} ${r.status !== 'active' ? 'opacity-60' : ''}`}
                  >
                    <span className="font-medium">{r.return_no}</span>
                    <span className="text-muted">{formatDate(r.date)}</span>
                    <span className="truncate">{r.customer_name}</span>
                    <span className="truncate text-muted">
                      {r.invoice_no || 'Standalone'}
                      {r.exchange_invoice_no ? ` → ${r.exchange_invoice_no}` : ''}
                    </span>
                    <span className="text-right tabular-nums">{r.item_count}</span>
                    <span className="text-right tabular-nums">{formatMoney(r.total)}</span>
                    <span>
                      <Badge tone={r.settlement === 'refund' ? 'success' : 'primary'}>
                        {r.settlement === 'exchange' ? (
                          <>
                            <ArrowLeftRight size={11} /> Exchange
                          </>
                        ) : r.settlement === 'refund' ? (
                          'Refunded'
                        ) : (
                          'Adjusted'
                        )}
                      </Badge>
                    </span>
                  </div>
                );
              }
              return (
                <div
                  {...common}
                  className={`${GRID} ${base} ${r.status !== 'active' ? 'opacity-60' : ''}`}
                >
                  <span className="font-medium">
                    {r.invoice_no}
                    <span className="block text-[11px] font-normal text-muted">
                      {r.bill_type === 'gst' ? 'GST' : 'Non-GST'}
                    </span>
                  </span>
                  <span className="text-muted">{formatDate(r.invoice_date)}</span>
                  <span className="min-w-0">
                    <span className="block truncate">{r.customer_name}</span>
                    <span className="block truncate text-xs text-muted">
                      {r.customer_phone_display || ''}
                    </span>
                  </span>
                  <span className="truncate text-xs">
                    {r.vehicle_no || '—'}
                    {r.vehicle_model && (
                      <span className="block truncate text-muted">{r.vehicle_model}</span>
                    )}
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
                  <span className="flex flex-col items-start gap-0.5">
                    <PayStatus status={r.pay_status} />
                    {r.return_count > 0 && <Badge tone="warning">returned</Badge>}
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
            {
              {
                bills: 'bills',
                quotations: 'quotations',
                returns: 'credit notes',
                held: 'held bills',
              }[tab]
            }
            {data.truncated ? ' (showing the first 5,000; refine the search)' : ''}
          </span>
          <span className="hidden xl:inline">
            <Kbd>↑</Kbd> <Kbd>↓</Kbd> select · <Kbd>Enter</Kbd> open · <Kbd>N</Kbd> new bill ·{' '}
            <Kbd>/</Kbd> search
          </span>
        </div>
      )}

      {drawer.id && (
        <SaleDrawer
          key={`drawer-${seq}`}
          open={drawer.open}
          saleId={drawer.id}
          onChanged={refreshAll}
          onOpenReturn={(id) => {
            setSeq((n) => n + 1);
            setCreditView(id);
          }}
          onClose={() => setDrawer((d) => ({ ...d, open: false }))}
        />
      )}
      {quoteView && (
        <QuotationModal
          key={`q-${seq}`}
          open
          quotationId={quoteView}
          onClose={() => setQuoteView(null)}
          onChanged={refreshAll}
        />
      )}
      {creditView && (
        <CreditNoteModal
          key={`cn-${seq}`}
          open
          returnId={creditView}
          onClose={() => setCreditView(null)}
        />
      )}
      {newReturn && (
        <SaleReturnModal
          key={`ret-${seq}`}
          open
          onClose={() => setNewReturn(false)}
          onDone={() => {
            setNewReturn(false);
            refreshAll();
          }}
          onExchange={(payload, credit, customer, label) => {
            setNewReturn(false);
            navigate('/billing', {
              state: { exchange: { sale_return: payload, credit, customer, label } },
            });
          }}
        />
      )}
      {discard && (
        <ConfirmDialog
          title="Discard this held bill?"
          confirmLabel="Discard"
          danger
          onCancel={() => setDiscard(null)}
          onConfirm={() =>
            saleDraftsApi
              .discard(discard.id)
              .then(() => {
                setDiscard(null);
                refreshAll();
              })
              .catch(toast.error)
          }
        >
          {discard.customer_name || 'This bill'} ({discard.item_count} items) will be removed from
          the held list.
        </ConfirmDialog>
      )}
    </div>
  );
}
