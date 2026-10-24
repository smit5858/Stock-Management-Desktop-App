import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  AlertTriangle,
  Barcode,
  ChevronDown,
  ChevronRight,
  PackagePlus,
  Plus,
  ScanLine,
  Trash2,
} from 'lucide-react';
import Button from '../../components/Button';
import { Input } from '../../components/Field';
import { Badge, Kbd } from '../../components/Feedback';
import { useToast } from '../../components/Toast';
import { productsApi } from '../../api/products';
import { purchasesApi } from '../../api/purchases';
import { formatMoney, paiseToInput, parseMoney } from '../../utils/money';
import { formatQty, formatRateBp, parseQty } from '../../utils/qty';
import { formatDate } from '../../utils/dates';
import { bpToInput, marginOf, parseBp, priceForMargin, serialCount } from './entryForm';

// Editable columns, in Enter order.
export const COLS = ['qty', 'free', 'rate', 'disc', 'gst'];
const GRID =
  'grid grid-cols-[1.25rem_minmax(9rem,1fr)_3.5rem_4.25rem_3.5rem_2.5rem_5.75rem_5.75rem_5.75rem_4.5rem_5rem_6rem_1.75rem] items-center gap-x-1';

function useDebounced(value, ms = 120) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** Name / SKU / barcode search. A scanned barcode (exact match + Enter) adds at once. */
export function ProductAdder({ inputRef, onAdd, onNewProduct, disabled }) {
  const toast = useToast();
  const [q, setQ] = useState('');
  const [found, setFound] = useState({ q: '', rows: [] });
  const [index, setIndex] = useState(0);
  const [focused, setFocused] = useState(false);
  const term = q.trim();
  const debounced = useDebounced(term);

  useEffect(() => {
    if (!debounced) return undefined;
    let cancelled = false;
    productsApi
      .search(debounced, 12)
      .then(
        (rows) =>
          !cancelled &&
          setFound({ q: debounced, rows: rows.filter((r) => r.product_type !== 'service') }),
      )
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [debounced]);

  const rows = found.q === term ? found.rows : [];
  const options = [
    ...rows.map((r) => ({ kind: 'row', row: r })),
    ...(term ? [{ kind: 'new' }] : []),
  ];
  const active = Math.max(0, Math.min(index, options.length - 1));
  const open = focused && term.length > 0;

  function choose(o) {
    if (!o) return;
    if (o.kind === 'new') onNewProduct(term);
    else onAdd(o.row, { scanned: false });
    setQ('');
    setIndex(0);
  }

  async function onKeyDown(e) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setIndex(Math.min(active + 1, options.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setIndex(Math.max(active - 1, 0));
    } else if (e.key === 'Enter' && !e.ctrlKey) {
      e.preventDefault();
      if (!term) return;
      // Scanners type fast and press Enter: look the code up directly.
      try {
        const hit = await purchasesApi.lookupCode(term);
        if (hit) {
          onAdd(hit, { scanned: true });
          setQ('');
          return;
        }
      } catch (err) {
        toast.error(err);
        return;
      }
      if (found.q === term) choose(options[active]);
      else {
        const list = (await productsApi.search(term, 12)).filter(
          (r) => r.product_type !== 'service',
        );
        if (list.length) {
          onAdd(list[0], { scanned: false });
          setQ('');
        } else onNewProduct(term);
      }
    } else if (e.key === 'Escape' && q) {
      e.stopPropagation();
      setQ('');
    }
  }

  return (
    <div className="relative">
      <ScanLine
        size={16}
        className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted"
      />
      <Input
        ref={inputRef}
        value={q}
        disabled={disabled}
        onChange={(e) => {
          setQ(e.target.value);
          setIndex(0);
        }}
        onFocus={() => setFocused(true)}
        onBlur={() => setTimeout(() => setFocused(false), 150)}
        onKeyDown={onKeyDown}
        placeholder="Add item: scan barcode, or type name / SKU…"
        className="pr-28 pl-9"
      />
      <span className="pointer-events-none absolute top-1/2 right-2 flex -translate-y-1/2 gap-1">
        <Kbd>Ctrl</Kbd>
        <Kbd>Enter</Kbd>
      </span>
      <AnimatePresence>
        {open && (
          <motion.ul
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.12 }}
            className="absolute top-full right-0 left-0 z-30 mt-1 max-h-80 overflow-auto rounded-xl border border-border bg-surface p-1 shadow-xl"
          >
            {options.map((o, i) => (
              <li key={o.kind === 'row' ? o.row.variant_id : 'new'}>
                <button
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseEnter={() => setIndex(i)}
                  onClick={() => choose(o)}
                  className={`flex w-full items-center gap-3 rounded-lg px-3 py-1.5 text-left text-sm ${i === active ? 'bg-primary-soft' : ''}`}
                >
                  {o.kind === 'new' ? (
                    <span className="flex items-center gap-2 font-medium text-primary">
                      <PackagePlus size={16} /> New product “{term}”
                    </span>
                  ) : (
                    <>
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-medium">
                          {o.row.name}
                          {o.row.variant_label && (
                            <span className="font-normal text-muted"> · {o.row.variant_label}</span>
                          )}
                        </div>
                        <div className="truncate text-xs text-muted">
                          {o.row.sku}
                          {o.row.barcode ? ` · ${o.row.barcode}` : ''}
                          {o.row.track_serials ? ' · serial no.' : ''}
                        </div>
                      </div>
                      {o.row.exact && (
                        <Badge tone="primary">
                          <Barcode size={12} /> Exact
                        </Badge>
                      )}
                      <span className="w-20 text-right text-xs text-muted tabular-nums">
                        Stock {formatQty(o.row.stock_milli)}
                      </span>
                      <span className="w-24 text-right tabular-nums">
                        {formatMoney(o.row.purchase_price)}
                      </span>
                    </>
                  )}
                </button>
              </li>
            ))}
          </motion.ul>
        )}
      </AnimatePresence>
    </div>
  );
}

const cellCls = 'h-8 px-2 text-sm tabular-nums';

/** Expanded panel under a line: last rates, current prices, price updates with a margin helper. */
function LinePanel({ line, calc, onChange }) {
  const toast = useToast();
  const [info, setInfo] = useState(null);
  const [margin, setMargin] = useState('');
  useEffect(() => {
    let cancelled = false;
    purchasesApi
      .lineInfo(line.variant_id)
      .then((d) => !cancelled && setInfo(d))
      .catch(toast.error);
    return () => {
      cancelled = true;
    };
  }, [line.variant_id, toast]);

  const unitCost = calc ? calc.unit_cost : null;
  const sp = parseMoney(line.new_selling || '0');
  const currentMargin = unitCost && sp != null ? marginOf(unitCost, sp) : null;

  function applyMargin(value) {
    setMargin(value);
    const bp = parseBp(value);
    if (bp == null || !unitCost) return;
    const price = priceForMargin(unitCost, bp);
    onChange({ price_update: true, new_selling: paiseToInput(price) });
  }

  return (
    <motion.div
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: 'auto' }}
      exit={{ opacity: 0, height: 0 }}
      transition={{ duration: 0.15 }}
      className="overflow-hidden"
    >
      <div className="ml-8 grid grid-cols-[1.2fr_1fr] gap-4 rounded-xl border border-border bg-surface-2/40 p-3 text-sm">
        <div>
          <div className="mb-1.5 text-xs font-semibold text-muted uppercase">
            Last purchase rates
          </div>
          {!info ? (
            <div className="text-muted">Loading…</div>
          ) : info.last.length === 0 ? (
            <div className="text-muted">First purchase of this item.</div>
          ) : (
            <table className="w-full">
              <tbody>
                {info.last.map((r) => (
                  <tr key={r.entry_no} className="border-b border-border/60 last:border-0">
                    <td className="py-1 pr-2">{r.supplier_name}</td>
                    <td className="py-1 pr-2 text-muted">{formatDate(r.bill_date)}</td>
                    <td className="py-1 pr-2 text-right tabular-nums">
                      {formatMoney(r.rate)}
                      <span className="text-[11px] text-muted">
                        {' '}
                        {r.price_mode === 'inclusive' ? 'incl' : 'excl'}
                      </span>
                    </td>
                    <td className="py-1 text-right text-xs text-muted tabular-nums">
                      cost {formatMoney(r.unit_cost)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {info && (
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
              <span>
                Stock {formatQty(info.stock_milli)} {line.unit}
              </span>
              <span>Avg cost {formatMoney(info.avg_cost)}</span>
              <span>Purchase price {formatMoney(info.purchase_price)}</span>
              <span>MRP {formatMoney(info.mrp)}</span>
              <span>Selling {formatMoney(info.selling_price)}</span>
            </div>
          )}
        </div>
        <div className="space-y-2">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={line.update_purchase_price}
              onChange={(e) => onChange({ update_purchase_price: e.target.checked })}
              className="h-4 w-4 accent-primary"
            />
            <span>
              Update purchase price to{' '}
              <strong className="tabular-nums">
                {unitCost != null ? formatMoney(unitCost) : '—'}
              </strong>
              <span className="text-xs text-muted"> (landed cost per unit)</span>
            </span>
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={line.price_update}
              onChange={(e) => onChange({ price_update: e.target.checked })}
              className="h-4 w-4 accent-primary"
            />
            <span>Update MRP / selling price</span>
          </label>
          {line.price_update && (
            <div className="grid grid-cols-3 gap-2 pl-6">
              <label className="text-xs text-muted">
                MRP
                <Input
                  value={line.new_mrp}
                  inputMode="decimal"
                  className={cellCls}
                  onChange={(e) => onChange({ new_mrp: e.target.value })}
                />
              </label>
              <label className="text-xs text-muted">
                Margin %
                <Input
                  value={
                    margin !== ''
                      ? margin
                      : currentMargin != null
                        ? bpToInput(Math.max(currentMargin, 0))
                        : ''
                  }
                  inputMode="decimal"
                  placeholder="e.g. 40"
                  className={cellCls}
                  onChange={(e) => applyMargin(e.target.value)}
                />
              </label>
              <label className="text-xs text-muted">
                Selling price
                <Input
                  value={line.new_selling}
                  inputMode="decimal"
                  className={cellCls}
                  onChange={(e) => {
                    setMargin('');
                    onChange({ new_selling: e.target.value });
                  }}
                />
              </label>
              {sp != null &&
                parseMoney(line.new_mrp || '0') > 0 &&
                sp > parseMoney(line.new_mrp || '0') && (
                  <p className="col-span-3 text-xs text-danger">Selling price is more than MRP.</p>
                )}
            </div>
          )}
        </div>
      </div>
    </motion.div>
  );
}

/**
 * The spreadsheet. Keyboard: Enter = next cell, ↑/↓ = same column in the row above/below,
 * F2 = edit the cell without clearing it, Ctrl+Delete = remove the line,
 * Ctrl+Enter = add a line (jumps to the item search).
 */
export default function ItemGrid({
  form,
  calc,
  gstRates,
  errors,
  issues,
  expanded,
  setExpanded,
  onLineChange,
  onRemove,
  onDismissIssue,
  onSerials,
  onFocusAdder,
}) {
  const containerRef = useRef(null);
  const gst = form.bill_type === 'gst';

  function cell(row, col) {
    return containerRef.current?.querySelector(`[data-cell="${row}:${col}"]`);
  }
  function focusCell(row, col) {
    const el = cell(row, col);
    if (el) {
      el.focus();
      if (el.select) el.select();
      return true;
    }
    return false;
  }

  function onKeyDown(e) {
    const at = e.target.dataset?.cell;
    if (!at) return;
    const [r, c] = at.split(':');
    const row = Number(r);
    const ci = COLS.indexOf(c);
    if (e.key === 'Enter' && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      for (let k = ci + 1; k < COLS.length; k++) if (focusCell(row, COLS[k])) return;
      if (!focusCell(row + 1, COLS[0])) onFocusAdder();
    } else if (e.key === 'ArrowDown' && e.target.tagName === 'INPUT') {
      e.preventDefault();
      focusCell(row + 1, c);
    } else if (e.key === 'ArrowUp' && e.target.tagName === 'INPUT') {
      e.preventDefault();
      focusCell(row - 1, c);
    } else if (e.key === 'F2' && e.target.tagName === 'INPUT') {
      e.preventDefault();
      const len = e.target.value.length;
      e.target.setSelectionRange(len, len);
    } else if (e.key === 'Delete' && e.ctrlKey) {
      e.preventDefault();
      onRemove(row);
      setTimeout(() => focusCell(Math.max(0, row - 1), c) || onFocusAdder(), 0);
    }
  }

  const err = (i, k) => errors[`items.${i}.${k}`];

  return (
    <div ref={containerRef} onKeyDown={onKeyDown} className="min-w-[57rem]">
      <div className={`${GRID} border-b border-border px-2 pb-2 text-xs font-medium text-muted`}>
        <span>#</span>
        <span>Product</span>
        <span>HSN</span>
        <span className="text-right">Qty</span>
        <span className="text-right">Free</span>
        <span>Unit</span>
        <span className="text-right">Rate</span>
        <span className="text-right">Discount</span>
        <span className="text-right">Taxable</span>
        <span className="text-right">GST</span>
        <span className="text-right">Tax</span>
        <span className="text-right">Total</span>
        <span />
      </div>
      <AnimatePresence initial={false}>
        {form.lines.map((l, i) => {
          const c = calc?.lines?.[i] || null;
          const lineIssues = issues[l.uid];
          const units = (parseQty(l.qty) || 0) + (l.free === '' ? 0 : parseQty(l.free) || 0);
          const need = units % 1000 === 0 ? units / 1000 : null;
          const have = serialCount(l.serials);
          const serialErr = err(i, 'serials');
          const open = expanded === l.uid;
          return (
            <motion.div
              key={l.uid}
              layout="position"
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.15 }}
              className={`border-b border-border py-1 ${lineIssues ? 'bg-danger-soft/40' : ''}`}
            >
              <div className={`${GRID} px-2`}>
                <span className="text-xs text-muted tabular-nums">{i + 1}</span>
                <button
                  type="button"
                  tabIndex={-1}
                  onClick={() => setExpanded(open ? null : l.uid)}
                  className="flex min-w-0 items-center gap-1 text-left"
                  title="Last rates and price update"
                >
                  {open ? (
                    <ChevronDown size={14} className="shrink-0 text-muted" />
                  ) : (
                    <ChevronRight size={14} className="shrink-0 text-muted" />
                  )}
                  <span className="min-w-0">
                    <span
                      className={`block truncate text-sm font-medium ${err(i, 'variant_id') ? 'text-danger' : ''}`}
                    >
                      {l.name}
                      {l.variant_label && (
                        <span className="font-normal text-muted"> · {l.variant_label}</span>
                      )}
                    </span>
                    <span className="block truncate text-[11px] text-muted">
                      {l.sku}
                      {(l.update_purchase_price || l.price_update) && (
                        <span className="text-primary"> · price update</span>
                      )}
                    </span>
                  </span>
                </button>
                <span className="truncate text-xs text-muted">{l.hsn_code || '—'}</span>
                <Input
                  data-cell={`${i}:qty`}
                  value={l.qty}
                  inputMode="decimal"
                  invalid={Boolean(err(i, 'qty_milli'))}
                  onFocus={(e) => e.target.select()}
                  onChange={(e) => onLineChange(i, { qty: e.target.value })}
                  className={`${cellCls} text-right`}
                />
                <Input
                  data-cell={`${i}:free`}
                  value={l.free}
                  inputMode="decimal"
                  placeholder="0"
                  invalid={Boolean(err(i, 'free_qty_milli'))}
                  onFocus={(e) => e.target.select()}
                  onChange={(e) => onLineChange(i, { free: e.target.value })}
                  className={`${cellCls} text-right`}
                />
                <span className="truncate text-xs text-muted">{l.unit}</span>
                <Input
                  data-cell={`${i}:rate`}
                  value={l.rate}
                  inputMode="decimal"
                  invalid={Boolean(err(i, 'rate'))}
                  onFocus={(e) => e.target.select()}
                  onChange={(e) => onLineChange(i, { rate: e.target.value })}
                  className={`${cellCls} text-right`}
                />
                <div className="flex">
                  <Input
                    data-cell={`${i}:disc`}
                    value={l.disc}
                    inputMode="decimal"
                    placeholder="0"
                    invalid={Boolean(err(i, 'discount'))}
                    onFocus={(e) => e.target.select()}
                    onChange={(e) => onLineChange(i, { disc: e.target.value })}
                    className={`${cellCls} rounded-r-none text-right`}
                  />
                  <button
                    type="button"
                    tabIndex={-1}
                    title="Discount in % or ₹"
                    onClick={() =>
                      onLineChange(i, {
                        disc_mode: l.disc_mode === 'pct' ? 'amt' : 'pct',
                        disc: '',
                      })
                    }
                    className="h-8 w-7 shrink-0 rounded-r-lg border border-l-0 border-border bg-surface-2 text-xs font-semibold text-muted hover:text-fg"
                  >
                    {l.disc_mode === 'pct' ? '%' : '₹'}
                  </button>
                </div>
                <span className="text-right text-sm tabular-nums">
                  {c ? formatMoney(c.taxable) : '—'}
                </span>
                {gst ? (
                  <select
                    data-cell={`${i}:gst`}
                    value={l.gst_rate_bp}
                    onChange={(e) => onLineChange(i, { gst_rate_bp: Number(e.target.value) })}
                    className={`h-8 w-full rounded-lg border bg-surface px-1 text-right text-sm focus:border-primary focus:ring-2 focus:ring-primary/20 focus:outline-none ${err(i, 'gst_rate_bp') ? 'border-danger' : 'border-border'}`}
                  >
                    {!gstRates.some((r) => r.rate_bp === l.gst_rate_bp) && (
                      <option value={l.gst_rate_bp}>{formatRateBp(l.gst_rate_bp)} (removed)</option>
                    )}
                    {gstRates.map((r) => (
                      <option key={r.id} value={r.rate_bp}>
                        {formatRateBp(r.rate_bp)}
                      </option>
                    ))}
                  </select>
                ) : (
                  <span className="text-right text-xs text-muted">—</span>
                )}
                <span className="text-right text-sm text-muted tabular-nums">
                  {c ? formatMoney(c.cgst + c.sgst + c.igst) : '—'}
                </span>
                <span className="text-right text-sm font-semibold tabular-nums">
                  {c ? formatMoney(c.line_total) : '—'}
                </span>
                <span className="flex justify-end gap-0.5">
                  <Button
                    size="icon-sm"
                    variant="danger-ghost"
                    icon={Trash2}
                    tabIndex={-1}
                    title="Remove line (Ctrl+Delete)"
                    onClick={() => onRemove(i)}
                  />
                </span>
              </div>

              {(l.track_serials ||
                c?.free_qty_milli > 0 ||
                lineIssues ||
                serialErr ||
                err(i, 'variant_id')) && (
                <div className="mt-1 flex flex-wrap items-center gap-2 pl-10 text-xs">
                  {l.track_serials && (
                    <button
                      type="button"
                      onClick={() => onSerials(i)}
                      className={`flex items-center gap-1.5 rounded-md border px-2 py-0.5 font-medium ${
                        need != null && have === need
                          ? 'border-success/40 bg-success-soft text-success'
                          : 'border-danger/40 bg-danger-soft text-danger'
                      }`}
                    >
                      <Barcode size={12} /> Serial numbers {have}/{need ?? '?'}
                      {need != null && have !== need && ' · enter'}
                    </button>
                  )}
                  {c?.free_qty_milli > 0 && (
                    <span className="text-success">
                      Free {formatQty(c.free_qty_milli)} {l.unit} at zero cost · landed{' '}
                      {formatMoney(c.unit_cost)}/unit
                    </span>
                  )}
                  {serialErr && <span className="text-danger">{serialErr}</span>}
                  {err(i, 'variant_id') && (
                    <span className="text-danger">{err(i, 'variant_id')}</span>
                  )}
                  {lineIssues && (
                    <span className="flex flex-wrap items-center gap-2 text-danger">
                      <AlertTriangle size={13} /> {lineIssues.join(' ')}
                      <Button size="sm" variant="danger-ghost" onClick={() => onRemove(i)}>
                        Remove line
                      </Button>
                      <Button size="sm" onClick={() => onDismissIssue(l.uid)}>
                        Keep (I fixed it)
                      </Button>
                    </span>
                  )}
                </div>
              )}
              <AnimatePresence>
                {open && (
                  <div className="mt-2 mb-1">
                    <LinePanel line={l} calc={c} onChange={(patch) => onLineChange(i, patch)} />
                  </div>
                )}
              </AnimatePresence>
            </motion.div>
          );
        })}
      </AnimatePresence>
      {form.lines.length === 0 && (
        <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted">
          <Plus size={16} /> Scan a barcode or search above to add the first item.
        </div>
      )}
    </div>
  );
}
