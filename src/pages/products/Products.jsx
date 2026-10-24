import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import {
  AlertTriangle,
  ArrowDownAZ,
  ArrowUpAZ,
  Ban,
  Boxes,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Copy,
  FileDown,
  FileUp,
  History,
  IndianRupee,
  LayoutGrid,
  List,
  Package,
  PackageX,
  Pencil,
  Plus,
  Search,
  SlidersHorizontal,
  Wrench,
} from 'lucide-react';
import Button from '../../components/Button';
import ConfirmDialog from '../../components/ConfirmDialog';
import { Input, Segmented, Select } from '../../components/Field';
import { AnimatedNumber, Badge, EmptyState, Kbd, Skeleton } from '../../components/Feedback';
import { useToast } from '../../components/Toast';
import { useHotkeys } from '../../hooks/useHotkeys';
import { productsApi } from '../../api/products';
import { defectiveApi } from '../../api/warranty';
import { formatMoney } from '../../utils/money';
import { formatQty } from '../../utils/qty';
import ProductDrawer from './ProductDrawer';
import StockAdjustModal from './StockAdjustModal';
import LedgerDrawer from './LedgerDrawer';
import ImportModal from './ImportModal';
import { toForm } from './form';
import DefectiveTab from './DefectiveTab';

const PAGE_SIZE = 50;
const STATUS = {
  in: { tone: 'success', label: 'In stock' },
  low: { tone: 'warning', label: 'Low' },
  out: { tone: 'danger', label: 'Out of stock' },
  service: { tone: 'primary', label: 'Service' },
};

function readView() {
  try {
    return localStorage.getItem('products.view') || 'table';
  } catch {
    return 'table';
  }
}

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

function Thumb({ row, size = 'h-10 w-10' }) {
  if (row.image_url)
    return (
      <img src={row.image_url} alt="" className={`${size} shrink-0 rounded-lg object-cover`} />
    );
  const Icon = row.product_type === 'service' ? Wrench : Package;
  return (
    <div
      className={`${size} flex shrink-0 items-center justify-center rounded-lg bg-primary-soft text-primary`}
    >
      <Icon size={18} />
    </div>
  );
}

function priceText(r) {
  return r.min_price === r.max_price
    ? formatMoney(r.min_price)
    : `${formatMoney(r.min_price)} – ${formatMoney(r.max_price)}`;
}

export default function Products() {
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const searchRef = useRef(null);

  const [meta, setMeta] = useState(null);
  const [stats, setStats] = useState(null);
  const [result, setResult] = useState({ key: null, data: null });
  const [reloadSeq, setReloadSeq] = useState(0);
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [filters, setFilters] = useState({
    category_id: null,
    brand: '',
    vehicle_model_id: null,
    stock_status: '',
    product_type: '',
    active: 'active',
  });
  const [sort, setSort] = useState({ sort: 'name', dir: 'asc' });
  const [page, setPage] = useState(1);
  const [view, setView] = useState(readView);
  const [showFilters, setShowFilters] = useState(false);
  const [selected, setSelected] = useState(0);

  // Overlays are remounted (key = seq) each time they open, so they start fresh.
  const [seq, setSeq] = useState(0);
  const [drawer, setDrawer] = useState({ open: false, initial: null });
  const [adjusting, setAdjusting] = useState(null);
  const [ledger, setLedger] = useState(null);
  const [importOpen, setImportOpen] = useState(false);
  const [deactivating, setDeactivating] = useState(null);
  // Products & stock | Defective (units kept out of sellable stock). ?view=defective opens it.
  const [section, setSection] = useState(() =>
    params.get('view') === 'defective' ? 'defective' : 'stock',
  );
  const [defectiveMilli, setDefectiveMilli] = useState(0);
  const loadDefective = useCallback(
    () =>
      defectiveApi
        .count()
        .then(setDefectiveMilli)
        .catch(() => {}),
    [],
  );
  useEffect(() => {
    loadDefective();
  }, [loadDefective]);

  const overlayOpen = drawer.open || adjusting || ledger || importOpen || deactivating;

  const loadMeta = useCallback(() => productsApi.meta().then(setMeta).catch(toast.error), [toast]);
  const loadStats = useCallback(
    () =>
      productsApi
        .stats()
        .then(setStats)
        .catch(() => {}),
    [],
  );

  useEffect(() => {
    loadMeta();
    loadStats();
  }, [loadMeta, loadStats]);

  useEffect(() => {
    const t = setTimeout(() => {
      setDebounced(search.trim());
      setPage(1);
    }, 200);
    return () => clearTimeout(t);
  }, [search]);

  // The list shows the last result while a new one loads (dimmed), never an empty flash.
  const query = { ...filters, search: debounced, ...sort, page, page_size: PAGE_SIZE };
  const queryKey = JSON.stringify([query, reloadSeq]);
  const data = result.data;
  const loading = result.key !== queryKey;

  useEffect(() => {
    let cancelled = false;
    const [q] = JSON.parse(queryKey);
    productsApi
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
    loadMeta();
  }, [loadStats, loadMeta]);

  const openDrawer = useCallback((initial, extra = {}) => {
    setSeq((n) => n + 1);
    setDrawer({ open: true, initial, tab: extra.tab || 'details', serial: extra.serial || '' });
  }, []);

  const openProduct = useCallback(
    async (id, { duplicate = false } = {}) => {
      try {
        const p = await productsApi.get(id);
        openDrawer(toForm(p, { duplicate }));
      } catch (e) {
        toast.error(e);
      }
    },
    [toast, openDrawer],
  );

  // Deep link from Ctrl+K: /products?open=<id>[&serial=<serial no>] (opens the Serials tab)
  const deepLinkId = params.get('open');
  const deepLinkSerial = params.get('serial') || '';
  useEffect(() => {
    if (!deepLinkId || !meta) return;
    setParams({}, { replace: true });
    productsApi
      .get(Number(deepLinkId))
      .then((p) =>
        openDrawer(toForm(p), deepLinkSerial ? { tab: 'serials', serial: deepLinkSerial } : {}),
      )
      .catch(toast.error);
  }, [deepLinkId, deepLinkSerial, meta, setParams, openDrawer, toast]);

  async function withProduct(id, setter) {
    try {
      const p = await productsApi.get(id);
      setSeq((n) => n + 1);
      setter(p);
    } catch (e) {
      toast.error(e);
    }
  }

  async function toggleActive(row) {
    try {
      await productsApi.setActive(row.id, !row.is_active);
      toast.success(row.is_active ? 'Product deactivated.' : 'Product activated.');
      setDeactivating(null);
      refreshAll();
    } catch (e) {
      toast.error(e);
    }
  }

  async function exportXlsx() {
    try {
      const r = await productsApi.exportXlsx();
      if (r.saved) toast.success(`Exported ${r.rows} rows to ${r.file_path}`);
    } catch (e) {
      toast.error(e);
    }
  }

  const rows = useMemo(() => data?.rows || [], [data]);
  const current = Math.max(0, Math.min(selected, rows.length - 1));

  useHotkeys(
    {
      N: () => openDrawer(null),
      '/': () => searchRef.current?.focus(),
      ArrowDown: () => setSelected(Math.min(current + 1, rows.length - 1)),
      ArrowUp: () => setSelected(Math.max(current - 1, 0)),
      Enter: () => rows[current] && openProduct(rows[current].id),
    },
    { enabled: !overlayOpen && section === 'stock' },
  );

  function setFilter(key, value) {
    setFilters((f) => ({ ...f, [key]: value }));
    setPage(1);
  }

  function changeSort(patch) {
    setSort((s) => ({ ...s, ...patch }));
    setPage(1);
  }

  function onSearchKey(e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      // A barcode scan ends with Enter: open the product straight away when it is the only match.
      if (rows.length === 1) openProduct(rows[0].id);
      else e.currentTarget.blur();
    } else if (e.key === 'Escape') {
      setSearch('');
      e.currentTarget.blur();
    }
  }

  const topCategories = meta?.categories.filter((c) => c.parent_id === null) || [];
  const activeFilterCount =
    ['brand', 'vehicle_model_id', 'product_type'].filter((k) => filters[k]).length +
    (filters.active !== 'active' ? 1 : 0);
  const totalPages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;

  const sectionBar = (
    <Segmented
      layoutId="products-section"
      value={section}
      onChange={setSection}
      options={[
        { value: 'stock', label: 'Products & stock', icon: Boxes },
        {
          value: 'defective',
          label: `Defective${defectiveMilli > 0 ? ` (${formatQty(defectiveMilli)})` : ''}`,
          icon: PackageX,
        },
      ]}
    />
  );
  if (section === 'defective') {
    return (
      <div className="mx-auto max-w-[1600px] space-y-5 p-6">
        {sectionBar}
        <DefectiveTab
          onChanged={() => {
            loadDefective();
            refreshAll();
          }}
        />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[1600px] space-y-5 p-6">
      {sectionBar}
      {/* Stats */}
      <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
        <StatCard
          icon={Boxes}
          label="Total products"
          value={stats?.total_products}
          tone="bg-primary-soft text-primary"
          active={false}
          onClick={() => setFilter('stock_status', '')}
        />
        <StatCard
          icon={IndianRupee}
          label="Stock value"
          value={stats?.stock_value}
          format={formatMoney}
          tone="bg-success-soft text-success"
          active={false}
          onClick={() => {}}
        />
        <StatCard
          icon={AlertTriangle}
          label="Low stock"
          value={stats?.low_count}
          tone="bg-warning-soft text-warning"
          active={filters.stock_status === 'low'}
          onClick={() => setFilter('stock_status', filters.stock_status === 'low' ? '' : 'low')}
        />
        <StatCard
          icon={PackageX}
          label="Out of stock"
          value={stats?.out_count}
          tone="bg-danger-soft text-danger"
          active={filters.stock_status === 'out'}
          onClick={() => setFilter('stock_status', filters.stock_status === 'out' ? '' : 'out')}
        />
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
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={onSearchKey}
            placeholder="Search name, SKU, barcode, brand, vehicle…"
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
        <Select
          value={sort.sort}
          onChange={(e) => changeSort({ sort: e.target.value })}
          className="w-44!"
        >
          <option value="name">Sort: Name</option>
          <option value="stock">Sort: Stock</option>
          <option value="price">Sort: Price</option>
          <option value="value">Sort: Stock value</option>
          <option value="updated">Sort: Recently edited</option>
        </Select>
        <Button
          size="icon"
          icon={sort.dir === 'asc' ? ArrowDownAZ : ArrowUpAZ}
          title="Sort direction"
          onClick={() => changeSort({ dir: sort.dir === 'asc' ? 'desc' : 'asc' })}
        />
        <div className="flex rounded-lg border border-border bg-surface p-0.5">
          {[
            ['table', List],
            ['grid', LayoutGrid],
          ].map(([v, Icon]) => (
            <button
              key={v}
              type="button"
              title={v === 'table' ? 'Table view' : 'Grid view'}
              onClick={() => {
                setView(v);
                try {
                  localStorage.setItem('products.view', v);
                } catch {
                  // view preference is optional
                }
              }}
              className={`rounded-md p-1.5 ${view === v ? 'bg-primary-soft text-primary' : 'text-muted hover:text-fg'}`}
            >
              <Icon size={16} />
            </button>
          ))}
        </div>
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
        <Button variant="primary" icon={Plus} onClick={() => openDrawer(null)}>
          New product <Kbd>N</Kbd>
        </Button>
      </div>

      <AnimatePresence initial={false}>
        {showFilters && meta && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.18 }}
            className="overflow-hidden"
          >
            <div className="grid grid-cols-2 gap-3 rounded-2xl border border-border bg-surface p-4 xl:grid-cols-5">
              <Select value={filters.brand} onChange={(e) => setFilter('brand', e.target.value)}>
                <option value="">All brands</option>
                {meta.brands.map((b) => (
                  <option key={b}>{b}</option>
                ))}
              </Select>
              <Select
                value={filters.vehicle_model_id ?? ''}
                onChange={(e) =>
                  setFilter('vehicle_model_id', e.target.value ? Number(e.target.value) : null)
                }
              >
                <option value="">All vehicles</option>
                {meta.vehicles.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.make} {v.model}
                  </option>
                ))}
              </Select>
              <Select
                value={filters.stock_status}
                onChange={(e) => setFilter('stock_status', e.target.value)}
              >
                <option value="">Any stock status</option>
                <option value="in">In stock</option>
                <option value="low">Low stock</option>
                <option value="out">Out of stock</option>
              </Select>
              <Select
                value={filters.product_type}
                onChange={(e) => setFilter('product_type', e.target.value)}
              >
                <option value="">Items & services</option>
                <option value="stock">Stock items only</option>
                <option value="service">Services only</option>
              </Select>
              <Select value={filters.active} onChange={(e) => setFilter('active', e.target.value)}>
                <option value="active">Active</option>
                <option value="inactive">Inactive</option>
                <option value="all">Active + inactive</option>
              </Select>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Category chips */}
      <div className="no-scrollbar -mx-1 flex gap-1.5 overflow-x-auto px-1">
        {[{ id: null, name: 'All' }, ...topCategories].map((c) => {
          const active = filters.category_id === c.id;
          return (
            <button
              key={c.id ?? 'all'}
              type="button"
              onClick={() => setFilter('category_id', c.id)}
              className={`relative shrink-0 rounded-full border px-3.5 py-1.5 text-sm font-medium whitespace-nowrap transition-colors ${
                active
                  ? 'border-transparent text-on-primary'
                  : 'border-border bg-surface text-muted hover:text-fg'
              }`}
            >
              {active && (
                <motion.span
                  layoutId="cat-chip"
                  transition={{ type: 'spring', stiffness: 500, damping: 40 }}
                  className="absolute inset-0 rounded-full bg-primary"
                />
              )}
              <span className="relative">{c.name}</span>
            </button>
          );
        })}
      </div>

      {/* Results */}
      {!data && loading ? (
        <div className="space-y-2">
          {Array.from({ length: 8 }, (_, i) => (
            <Skeleton key={i} className="h-14" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-2xl border border-border bg-surface">
          <EmptyState
            icon={Package}
            title={
              debounced || filters.category_id || filters.stock_status
                ? 'No matching products'
                : 'No products yet'
            }
          >
            {debounced || filters.category_id || filters.stock_status
              ? 'Try a different search or clear the filters.'
              : 'Press N to add your first product, or import a list from Excel.'}
          </EmptyState>
        </div>
      ) : view === 'table' ? (
        <div
          className={`overflow-x-auto rounded-2xl border border-border bg-surface shadow-sm transition-opacity ${loading ? 'opacity-60' : ''}`}
        >
          <table className="w-full text-sm">
            <thead className="bg-surface-2 text-left text-xs text-muted">
              <tr>
                <th className="px-4 py-2.5 font-medium">Product</th>
                <th className="px-3 py-2.5 font-medium">SKU</th>
                <th className="hidden px-3 py-2.5 font-medium xl:table-cell">Fits</th>
                <th className="px-3 py-2.5 text-right font-medium">Price</th>
                <th className="px-3 py-2.5 text-right font-medium">Stock</th>
                <th className="px-3 py-2.5 font-medium">Status</th>
                <th className="w-44 px-3 py-2.5" />
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((r, i) => {
                const status = STATUS[r.stock_status];
                return (
                  <motion.tr
                    key={r.id}
                    initial={{ opacity: 0, y: 4 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: Math.min(i * 0.012, 0.25), duration: 0.15 }}
                    onClick={() => openProduct(r.id)}
                    onMouseEnter={() => setSelected(i)}
                    className={`group cursor-pointer transition-colors ${i === current ? 'bg-primary-soft/50' : 'hover:bg-surface-2/60'} ${r.is_active ? '' : 'opacity-60'}`}
                  >
                    <td className="px-4 py-2">
                      <div className="flex items-center gap-3">
                        <Thumb row={r} />
                        <div className="min-w-0">
                          <div className="truncate font-medium">{r.name}</div>
                          <div className="truncate text-xs text-muted">
                            {[
                              r.brand,
                              r.parent_category_name
                                ? `${r.parent_category_name} › ${r.category_name}`
                                : r.category_name,
                              r.variant_count > 1 ? `${r.variant_count} variants` : null,
                              r.track_serials ? 'Serial nos.' : null,
                            ]
                              .filter(Boolean)
                              .join(' · ')}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="px-3 py-2 font-mono text-xs whitespace-nowrap text-muted">
                      {r.sku || '—'}
                    </td>
                    <td
                      className="hidden max-w-48 truncate px-3 py-2 text-muted xl:table-cell"
                      title={r.vehicles_text || ''}
                    >
                      {r.product_type === 'service'
                        ? '—'
                        : r.is_universal
                          ? 'Universal'
                          : r.vehicles_text}
                    </td>
                    <td className="px-3 py-2 text-right whitespace-nowrap tabular-nums">
                      {priceText(r)}
                    </td>
                    <td className="px-3 py-2 text-right whitespace-nowrap tabular-nums">
                      {r.product_type === 'service' ? '—' : `${formatQty(r.stock_milli)} ${r.unit}`}
                    </td>
                    <td className="px-3 py-2">
                      <Badge tone={status.tone} dot>
                        {status.label}
                      </Badge>
                    </td>
                    <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
                      <div className="flex justify-end gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          icon={Pencil}
                          title="Edit"
                          onClick={() => openProduct(r.id)}
                        />
                        {r.product_type === 'stock' && (
                          <>
                            <Button
                              size="icon-sm"
                              variant="ghost"
                              icon={SlidersHorizontal}
                              title="Stock adjustment"
                              onClick={() => withProduct(r.id, setAdjusting)}
                            />
                            <Button
                              size="icon-sm"
                              variant="ghost"
                              icon={History}
                              title="Stock ledger"
                              onClick={() => withProduct(r.id, setLedger)}
                            />
                          </>
                        )}
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          icon={Copy}
                          title="Duplicate"
                          onClick={() => openProduct(r.id, { duplicate: true })}
                        />
                        <Button
                          size="icon-sm"
                          variant={r.is_active ? 'danger-ghost' : 'ghost'}
                          icon={r.is_active ? Ban : CheckCircle2}
                          title={r.is_active ? 'Deactivate' : 'Activate'}
                          onClick={() => (r.is_active ? setDeactivating(r) : toggleActive(r))}
                        />
                      </div>
                    </td>
                  </motion.tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <div
          className={`grid grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-4 transition-opacity ${loading ? 'opacity-60' : ''}`}
        >
          {rows.map((r, i) => {
            const status = STATUS[r.stock_status];
            return (
              <motion.button
                type="button"
                key={r.id}
                initial={{ opacity: 0, scale: 0.97 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ delay: Math.min(i * 0.015, 0.3), duration: 0.15 }}
                whileHover={{ y: -3 }}
                onClick={() => openProduct(r.id)}
                className={`flex flex-col gap-3 rounded-2xl border bg-surface p-4 text-left shadow-sm ${i === current ? 'border-primary' : 'border-border'} ${r.is_active ? '' : 'opacity-60'}`}
              >
                <div className="flex items-start gap-3">
                  <Thumb row={r} size="h-14 w-14" />
                  <div className="min-w-0 flex-1">
                    <div className="line-clamp-2 font-semibold">{r.name}</div>
                    <div className="truncate text-xs text-muted">
                      {r.brand || r.category_name || ' '}
                    </div>
                  </div>
                </div>
                <div className="truncate text-xs text-muted">
                  {r.product_type === 'service'
                    ? 'Service'
                    : r.is_universal
                      ? 'Universal fit'
                      : r.vehicles_text}
                </div>
                <div className="mt-auto flex items-center justify-between">
                  <span className="font-semibold tabular-nums">{priceText(r)}</span>
                  <Badge tone={status.tone}>
                    {r.product_type === 'service'
                      ? status.label
                      : `${formatQty(r.stock_milli)} ${r.unit}`}
                  </Badge>
                </div>
              </motion.button>
            );
          })}
        </div>
      )}

      {/* Pagination */}
      {data && data.total > 0 && (
        <div className="flex items-center justify-between text-sm text-muted">
          <span>
            {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, data.total)} of {data.total}
            <span className="ml-3 hidden xl:inline">
              <Kbd>↑</Kbd> <Kbd>↓</Kbd> select · <Kbd>Enter</Kbd> open · <Kbd>N</Kbd> new ·{' '}
              <Kbd>/</Kbd> search
            </span>
          </span>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              icon={ChevronLeft}
              disabled={page <= 1}
              onClick={() => setPage((p) => p - 1)}
            >
              Prev
            </Button>
            <span>
              Page {page} / {totalPages}
            </span>
            <Button size="sm" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>
              Next <ChevronRight size={14} />
            </Button>
          </div>
        </div>
      )}

      {meta && (
        <ProductDrawer
          key={`drawer-${seq}`}
          open={drawer.open}
          initial={drawer.initial}
          initialTab={drawer.tab}
          initialSerialSearch={drawer.serial}
          meta={meta}
          onMetaChange={loadMeta}
          onStockChanged={refreshAll}
          onClose={() => setDrawer((d) => ({ ...d, open: false }))}
          onSaved={() => {
            setDrawer((d) => ({ ...d, open: false }));
            refreshAll();
          }}
        />
      )}
      <StockAdjustModal
        key={`adjust-${seq}`}
        product={adjusting}
        onClose={() => setAdjusting(null)}
        onDone={() => {
          setAdjusting(null);
          refreshAll();
        }}
      />
      <LedgerDrawer key={`ledger-${seq}`} product={ledger} onClose={() => setLedger(null)} />
      <ImportModal
        key={`import-${seq}`}
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onImported={() => {
          setImportOpen(false);
          refreshAll();
        }}
      />
      <ConfirmDialog
        open={Boolean(deactivating)}
        title="Deactivate product?"
        confirmLabel="Deactivate"
        danger
        onCancel={() => setDeactivating(null)}
        onConfirm={() => toggleActive(deactivating)}
      >
        <strong className="text-fg">{deactivating?.name}</strong> will be hidden from billing and
        lists. Its history and stock are kept, and you can activate it again at any time.
      </ConfirmDialog>
    </div>
  );
}
