import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Building2,
  FileDown,
  FileUp,
  HandCoins,
  IndianRupee,
  Plus,
  Search,
  SlidersHorizontal,
  Truck,
  Users,
  Wallet,
} from 'lucide-react';
import Button from '../../components/Button';
import { Input, Segmented, Select } from '../../components/Field';
import { AnimatedNumber, Badge, EmptyState, Kbd, Skeleton } from '../../components/Feedback';
import VirtualList from '../../components/VirtualList';
import { useToast } from '../../components/Toast';
import { useHotkeys } from '../../hooks/useHotkeys';
import { partiesApi } from '../../api/parties';
import { formatMoney } from '../../utils/money';
import { formatDate } from '../../utils/dates';
import PartyDrawer from './PartyDrawer';
import { ImportPartiesModal } from './PartyModals';
import { balanceInfo } from './form';

const ROW_HEIGHT = 56;
const EMPTY_FILTERS = {
  customer_type_id: '',
  balance: '',
  make: '',
  vehicle_model_id: '',
  active: 'active',
};

function StatCard({ icon: Icon, label, value, format, tone, active, onClick }) {
  return (
    <motion.button
      type="button"
      onClick={onClick}
      whileHover={{ y: -2 }}
      whileTap={{ scale: 0.98 }}
      className={`flex items-center gap-4 rounded-2xl border bg-surface p-4 text-left shadow-sm transition-colors ${
        active ? 'border-primary ring-2 ring-primary/20' : 'border-border'
      }`}
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
      </div>
    </motion.button>
  );
}

function columns(type) {
  return type === 'supplier'
    ? [
        { key: 'name', label: 'Supplier', cls: 'min-w-0' },
        { key: 'phone', label: 'Phone', cls: 'w-36' },
        { key: 'city', label: 'City / GSTIN', cls: 'w-56' },
        { key: 'balance', label: 'Payable / advance', cls: 'w-44 justify-end' },
        { key: 'last_date', label: 'Last purchase', cls: 'w-32' },
      ]
    : [
        { key: 'name', label: 'Customer', cls: 'min-w-0' },
        { key: 'phone', label: 'Phone', cls: 'w-36' },
        { key: 'vehicles', label: 'Vehicles', cls: 'w-64' },
        { key: 'balance', label: 'Pending / advance', cls: 'w-44 justify-end' },
        { key: 'last_date', label: 'Last bill', cls: 'w-32' },
      ];
}

const GRID = 'grid grid-cols-[minmax(0,1fr)_9rem_14rem_11rem_8rem] gap-3 px-4';
const GRID_CUSTOMER = 'grid grid-cols-[minmax(0,1fr)_9rem_16rem_11rem_8rem] gap-3 px-4';

export default function Parties() {
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const type = params.get('tab') === 'suppliers' ? 'supplier' : 'customer';
  const searchRef = useRef(null);

  const [meta, setMeta] = useState(null);
  const [stats, setStats] = useState(null);
  const [result, setResult] = useState({ key: null, data: null });
  const [reloadSeq, setReloadSeq] = useState(0);
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [sort, setSort] = useState({ sort: 'name', dir: 'asc' });
  const [showFilters, setShowFilters] = useState(false);
  const [selected, setSelected] = useState(0);
  const [seq, setSeq] = useState(0);
  const [drawer, setDrawer] = useState({
    open: false,
    id: null,
    type: 'customer',
    tab: 'overview',
  });
  const [importOpen, setImportOpen] = useState(false);
  const overlayOpen = drawer.open || importOpen;
  const gridCls = type === 'supplier' ? GRID : GRID_CUSTOMER;

  const loadMeta = useCallback(() => partiesApi.meta().then(setMeta).catch(toast.error), [toast]);
  const loadStats = useCallback(
    () =>
      partiesApi
        .stats(type)
        .then(setStats)
        .catch(() => {}),
    [type],
  );
  useEffect(() => {
    loadMeta();
  }, [loadMeta]);
  useEffect(() => {
    loadStats();
  }, [loadStats]);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search.trim()), 180);
    return () => clearTimeout(t);
  }, [search]);

  const query = { ...filters, type, search: debounced, ...sort };
  const queryKey = JSON.stringify([query, reloadSeq]);
  const data = result.data;
  const loading = result.key !== queryKey;
  useEffect(() => {
    let cancelled = false;
    const [q] = JSON.parse(queryKey);
    partiesApi
      .list(q)
      .then((d) => !cancelled && setResult({ key: queryKey, data: d }))
      .catch(toast.error);
    return () => {
      cancelled = true;
    };
  }, [queryKey, toast]);

  const refreshAll = useCallback(() => {
    setReloadSeq((n) => n + 1);
    loadStats();
  }, [loadStats]);

  // The drawer keeps the type it was opened with, even if the list switches underneath it.
  const openParty = useCallback((id, partyType, tab = 'overview') => {
    setSeq((n) => n + 1);
    setDrawer({ open: true, id, type: partyType, tab });
  }, []);

  // Deep link (Ctrl+K): /parties?open=<id>[&tab=suppliers]
  const deepLink = params.get('open');
  useEffect(() => {
    if (!deepLink || !meta) return;
    const next = new URLSearchParams(params);
    next.delete('open');
    setParams(next, { replace: true });
    partiesApi
      .summary(Number(deepLink))
      .then((p) => {
        if (p.type !== type)
          setParams(p.type === 'supplier' ? { tab: 'suppliers' } : {}, { replace: true });
        openParty(p.id, p.type);
      })
      .catch(toast.error);
  }, [deepLink, meta, params, setParams, openParty, toast, type]);

  function switchType(next) {
    setParams(next === 'supplier' ? { tab: 'suppliers' } : {}, { replace: true });
    setFilters(EMPTY_FILTERS);
    setSearch('');
    setSelected(0);
    setStats(null);
    setDrawer((d) => ({ ...d, open: false }));
  }

  const rows = useMemo(() => data?.rows || [], [data]);
  const current = Math.max(0, Math.min(selected, rows.length - 1));

  useHotkeys(
    {
      N: () => openParty(null, type),
      '/': () => searchRef.current?.focus(),
      ArrowDown: () => setSelected(Math.min(current + 1, rows.length - 1)),
      ArrowUp: () => setSelected(Math.max(current - 1, 0)),
      Enter: () => rows[current] && openParty(rows[current].id, type),
    },
    { enabled: !overlayOpen },
  );

  function onSearchKey(e) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setSelected(
        e.key === 'ArrowDown' ? Math.min(current + 1, rows.length - 1) : Math.max(current - 1, 0),
      );
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (rows[current]) openParty(rows[current].id, type);
    } else if (e.key === 'Escape') {
      setSearch('');
      e.currentTarget.blur();
    }
  }

  function setFilter(key, value) {
    setFilters((f) => ({
      ...f,
      [key]: value,
      ...(key === 'make' ? { vehicle_model_id: '' } : {}),
    }));
    setSelected(0);
  }

  function toggleSort(key) {
    setSort((s) =>
      s.sort === key
        ? { sort: key, dir: s.dir === 'asc' ? 'desc' : 'asc' }
        : { sort: key, dir: key === 'balance' || key === 'last_date' ? 'desc' : 'asc' },
    );
  }

  async function exportXlsx() {
    try {
      const r = await partiesApi.exportXlsx({ ...filters, type, search: debounced, ...sort });
      if (r.saved) toast.success(`Exported ${r.rows} rows to ${r.file_path}`);
    } catch (e) {
      toast.error(e);
    }
  }

  const makes = useMemo(
    () => (meta ? [...new Set(meta.vehicle_models.map((m) => m.make))] : []),
    [meta],
  );
  const models = meta ? meta.vehicle_models.filter((m) => m.make === filters.make) : [];
  const activeFilterCount =
    ['customer_type_id', 'balance', 'make'].filter((k) => filters[k]).length +
    (filters.active !== 'active' ? 1 : 0);
  const customer = type === 'customer';
  const balanceFilter = (v) => setFilter('balance', filters.balance === v ? '' : v);

  return (
    <div className="mx-auto flex max-w-[1600px] flex-col gap-4 p-6">
      <div className="flex items-center gap-3">
        <Segmented
          layoutId="parties-type"
          value={type}
          onChange={switchType}
          options={[
            { value: 'customer', label: 'Customers', icon: Users },
            { value: 'supplier', label: 'Suppliers', icon: Truck },
          ]}
        />
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
        <StatCard
          icon={customer ? Users : Building2}
          label={customer ? 'Total customers' : 'Total suppliers'}
          value={stats?.total}
          tone="bg-primary-soft text-primary"
          active={false}
          onClick={() => setFilter('balance', '')}
        />
        <StatCard
          icon={IndianRupee}
          label={customer ? 'Total receivable' : 'Total payable'}
          value={stats ? (customer ? stats.positive : stats.negative) : null}
          format={formatMoney}
          tone={customer ? 'bg-warning-soft text-warning' : 'bg-danger-soft text-danger'}
          active={filters.balance === 'pending'}
          onClick={() => balanceFilter('pending')}
        />
        <StatCard
          icon={Wallet}
          label={customer ? 'Advance received' : 'Advance paid'}
          value={stats ? (customer ? stats.negative : stats.positive) : null}
          format={formatMoney}
          tone="bg-success-soft text-success"
          active={filters.balance === 'advance'}
          onClick={() => balanceFilter('advance')}
        />
        {customer ? (
          <StatCard
            icon={AlertTriangle}
            label="Over credit limit"
            value={stats?.over_limit}
            tone="bg-danger-soft text-danger"
            active={filters.balance === 'over_limit'}
            onClick={() => balanceFilter('over_limit')}
          />
        ) : (
          <StatCard
            icon={HandCoins}
            label="Suppliers to pay"
            value={stats?.negative_count}
            tone="bg-warning-soft text-warning"
            active={filters.balance === 'pending'}
            onClick={() => balanceFilter('pending')}
          />
        )}
      </div>

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2">
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
              customer
                ? 'Search name, phone, vehicle number, GSTIN, city…'
                : 'Search firm, contact person, phone, GSTIN, city…'
            }
            className="pr-10 pl-9"
          />
          <span className="absolute top-1/2 right-2 -translate-y-1/2">
            <Kbd>/</Kbd>
          </span>
        </div>
        <Button
          icon={SlidersHorizontal}
          onClick={() => setShowFilters((s) => !s)}
          className={showFilters ? 'border-primary text-primary' : ''}
        >
          Filters{activeFilterCount ? ` (${activeFilterCount})` : ''}
        </Button>
        <Button
          icon={FileUp}
          onClick={() => {
            setSeq((n) => n + 1);
            setImportOpen(true);
          }}
        >
          Import
        </Button>
        <Button icon={FileDown} onClick={exportXlsx}>
          Export
        </Button>
        <Button variant="primary" icon={Plus} onClick={() => openParty(null, type)}>
          New {type} <Kbd>N</Kbd>
        </Button>
      </div>

      <AnimatePresence initial={false}>
        {showFilters && meta && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.18 }}
            className="shrink-0 overflow-hidden"
          >
            <div className="grid grid-cols-2 gap-3 rounded-2xl border border-border bg-surface p-4 xl:grid-cols-5">
              {customer && (
                <Select
                  value={filters.customer_type_id}
                  onChange={(e) => setFilter('customer_type_id', e.target.value)}
                >
                  <option value="">All types</option>
                  {meta.customer_types.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </Select>
              )}
              <Select
                value={filters.balance}
                onChange={(e) => setFilter('balance', e.target.value)}
              >
                <option value="">Any balance</option>
                <option value="pending">{customer ? 'Has pending' : 'Payable'}</option>
                <option value="advance">Has advance</option>
                <option value="settled">Settled (zero)</option>
                {customer && <option value="over_limit">Over credit limit</option>}
              </Select>
              {customer && (
                <>
                  <Select value={filters.make} onChange={(e) => setFilter('make', e.target.value)}>
                    <option value="">Any vehicle make</option>
                    {makes.map((m) => (
                      <option key={m}>{m}</option>
                    ))}
                  </Select>
                  <Select
                    value={filters.vehicle_model_id}
                    disabled={!filters.make}
                    onChange={(e) => setFilter('vehicle_model_id', e.target.value)}
                  >
                    <option value="">Any model</option>
                    {models.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.model}
                      </option>
                    ))}
                  </Select>
                </>
              )}
              <Select value={filters.active} onChange={(e) => setFilter('active', e.target.value)}>
                <option value="active">Active</option>
                <option value="inactive">Inactive</option>
                <option value="all">Active + inactive</option>
              </Select>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* List */}
      {/* Fixed height (viewport minus the shell and the rows above) so the list virtualises. */}
      <div className="flex h-[calc(100vh-24.5rem)] min-h-64 flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-sm">
        <div
          className={`${gridCls} shrink-0 border-b border-border bg-surface-2 py-2.5 text-xs text-muted`}
        >
          {columns(type).map((c) => (
            <button
              key={c.key}
              type="button"
              onClick={() => toggleSort(c.key)}
              className={`flex items-center gap-1 font-medium hover:text-fg ${c.cls} ${sort.sort === c.key ? 'text-fg' : ''}`}
            >
              {c.label}
              {sort.sort === c.key &&
                (sort.dir === 'asc' ? <ArrowUp size={12} /> : <ArrowDown size={12} />)}
            </button>
          ))}
        </div>
        {!data && loading ? (
          <div className="space-y-2 p-3">
            {Array.from({ length: 8 }, (_, i) => (
              <Skeleton key={i} className="h-10" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <EmptyState
            icon={customer ? Users : Truck}
            title={debounced || activeFilterCount ? 'No matches' : `No ${type}s yet`}
          >
            {debounced || activeFilterCount
              ? 'Try a different search or clear the filters.'
              : `Press N to add your first ${type}, or import a list from Excel.`}
          </EmptyState>
        ) : (
          <VirtualList
            items={rows}
            rowHeight={ROW_HEIGHT}
            selected={current}
            className={`flex-1 transition-opacity ${loading ? 'opacity-60' : ''}`}
            renderRow={(r, i) => {
              const b = balanceInfo(type, r.balance);
              const over = customer && r.credit_limit != null && r.balance > r.credit_limit;
              return (
                <div
                  role="button"
                  tabIndex={-1}
                  onClick={() => openParty(r.id, type)}
                  onMouseEnter={() => setSelected(i)}
                  className={`${gridCls} h-full cursor-pointer items-center border-b border-border text-sm transition-colors ${
                    i === current ? 'bg-primary-soft/50' : 'hover:bg-surface-2/60'
                  } ${r.is_active ? '' : 'opacity-60'}`}
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 truncate font-medium">
                      <span className="truncate">{r.name}</span>
                      {r.is_system ? <Badge>Walk-in</Badge> : null}
                      {r.type_name && <Badge tone="primary">{r.type_name}</Badge>}
                      {r.linked_party_id ? (
                        <Badge>Also {customer ? 'supplier' : 'customer'}</Badge>
                      ) : null}
                    </div>
                    <div className="truncate text-xs text-muted">
                      {[customer ? r.firm_name : r.contact_person, customer ? r.city : null]
                        .filter(Boolean)
                        .join(' · ') || ' '}
                    </div>
                  </div>
                  <div className="truncate tabular-nums">
                    {r.phone_display || <span className="text-muted">—</span>}
                  </div>
                  {customer ? (
                    <div className="flex min-w-0 gap-1 overflow-hidden">
                      {r.plates.slice(0, 3).map((p) => (
                        <span
                          key={p.plate_no}
                          className="shrink-0 rounded-md border border-border bg-surface-2 px-1.5 py-0.5 font-mono text-[11px] font-semibold"
                        >
                          {p.display}
                        </span>
                      ))}
                      {r.plates.length > 3 && (
                        <span className="text-xs text-muted">+{r.plates.length - 3}</span>
                      )}
                    </div>
                  ) : (
                    <div className="min-w-0 truncate text-muted">
                      {[r.city, r.gstin].filter(Boolean).join(' · ') || '—'}
                    </div>
                  )}
                  <div className="flex justify-end">
                    {r.balance ? (
                      <Badge tone={over ? 'danger' : b.tone} dot>
                        {b.label} {formatMoney(b.amount)}
                      </Badge>
                    ) : (
                      <span className="text-muted">—</span>
                    )}
                  </div>
                  <div className="text-muted">{r.last_date ? formatDate(r.last_date) : '—'}</div>
                </div>
              );
            }}
          />
        )}
      </div>

      {data && data.total > 0 && (
        <div className="flex shrink-0 items-center justify-between text-sm text-muted">
          <span>
            {data.total.toLocaleString('en-IN')} {type}s
            {data.truncated ? ' (showing the first 20,000; refine the search)' : ''}
          </span>
          <span className="hidden xl:inline">
            <Kbd>↑</Kbd> <Kbd>↓</Kbd> select · <Kbd>Enter</Kbd> open · <Kbd>N</Kbd> new ·{' '}
            <Kbd>/</Kbd> search
          </span>
        </div>
      )}

      {meta && (
        <PartyDrawer
          key={`drawer-${seq}`}
          open={drawer.open}
          partyId={drawer.id}
          type={drawer.type}
          initialTab={drawer.tab}
          meta={meta}
          onMetaChange={loadMeta}
          onChanged={refreshAll}
          onOpenParty={(id) => {
            // The other record may be of the other type (linked party): switch lists too.
            partiesApi
              .summary(id)
              .then((p) => {
                if (p.type !== type)
                  setParams(p.type === 'supplier' ? { tab: 'suppliers' } : {}, { replace: true });
                openParty(id, p.type);
              })
              .catch(toast.error);
          }}
          onClose={() => setDrawer((d) => ({ ...d, open: false }))}
        />
      )}
      <ImportPartiesModal
        key={`import-${type}-${seq}`}
        open={importOpen}
        type={type}
        onClose={() => setImportOpen(false)}
        onImported={() => {
          setImportOpen(false);
          refreshAll();
          loadMeta();
        }}
      />
    </div>
  );
}
