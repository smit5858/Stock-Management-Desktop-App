import { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  AlertTriangle,
  Barcode,
  Car,
  Check,
  Plus,
  ScanLine,
  ShieldCheck,
  Trash2,
  Wrench,
  X,
} from 'lucide-react';
import Button from '../../components/Button';
import { Input } from '../../components/Field';
import { Badge, Kbd } from '../../components/Feedback';
import { Modal } from '../../components/Overlay';
import { useToast } from '../../components/Toast';
import { salesApi } from '../../api/sales';
import { serialsApi } from '../../api/products';
import { formatMoney } from '../../utils/money';
import { formatQty, formatRateBp, parseQty } from '../../utils/qty';
import { formatDate } from '../../utils/dates';

function useDebounced(value, ms = 110) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/**
 * Add an item: name / SKU / barcode / vehicle model, or scan a barcode or a unit's serial
 * number (Enter on an exact match adds it at once; scanning the same barcode again adds 1).
 */
export function ItemSearch({ inputRef, vehicleId, onAdd, vehicleName }) {
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
    salesApi
      .searchItems(debounced, vehicleId)
      .then((rows) => !cancelled && setFound({ q: debounced, rows }))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [debounced, vehicleId]);

  const rows = found.q === term ? found.rows : [];
  const active = Math.max(0, Math.min(index, rows.length - 1));
  const open = focused && term.length > 0;

  function choose(row, scanned) {
    if (!row) return;
    onAdd(row, { scanned });
    setQ('');
    setIndex(0);
  }

  async function onKeyDown(e) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setIndex(Math.min(active + 1, rows.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setIndex(Math.max(active - 1, 0));
    } else if (e.key === 'Enter' && !e.ctrlKey) {
      e.preventDefault();
      if (!term) return;
      // Scanners type fast and press Enter: search now, take an exact code / serial match.
      let list = rows;
      if (found.q !== term) {
        try {
          list = await salesApi.searchItems(term, vehicleId);
        } catch (err) {
          toast.error(err);
          return;
        }
      }
      const exact = list.filter((r) => r.exact || r.serial);
      if (exact.length === 1) choose(exact[0], true);
      else if (found.q === term && list[active]) choose(list[active], false);
      else if (list.length) choose(list[0], false);
      else toast.error(`Nothing found for "${term}".`);
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
        onChange={(e) => {
          setQ(e.target.value);
          setIndex(0);
        }}
        onFocus={() => setFocused(true)}
        onBlur={() => setTimeout(() => setFocused(false), 150)}
        onKeyDown={onKeyDown}
        placeholder="Scan barcode / serial, or type name, SKU, car model…"
        className="h-10 pr-20 pl-9 text-base"
      />
      <span className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2">
        <Kbd>F3</Kbd>
      </span>
      <AnimatePresence>
        {open && (
          <motion.ul
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.1 }}
            className="absolute top-full right-0 left-0 z-30 mt-1 max-h-96 overflow-auto rounded-xl border border-border bg-surface p-1 shadow-xl"
          >
            {rows.length === 0 && (
              <li className="px-3 py-3 text-sm text-muted">
                {found.q === term ? 'No match' : 'Searching…'}
              </li>
            )}
            {rows.map((r, i) => {
              const service = r.product_type === 'service';
              const out = !service && r.stock_milli <= 0;
              return (
                <li key={`${r.variant_id}-${r.serial?.id || ''}`}>
                  <button
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onMouseEnter={() => setIndex(i)}
                    onClick={() => choose(r, false)}
                    className={`flex w-full items-center gap-3 rounded-lg px-3 py-1.5 text-left text-sm ${i === active ? 'bg-primary-soft' : ''}`}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium">
                        {r.name}
                        {r.variant_label && (
                          <span className="font-normal text-muted"> · {r.variant_label}</span>
                        )}
                      </div>
                      <div className="flex flex-wrap items-center gap-1 truncate text-xs text-muted">
                        {r.sku}
                        {r.barcode ? ` · ${r.barcode}` : ''}
                        {r.serial && (
                          <Badge tone="primary">
                            <Barcode size={11} /> S/N {r.serial.serial_no}
                          </Badge>
                        )}
                        {r.track_serials && !r.serial ? <Badge>serial no.</Badge> : null}
                        {service && <Badge>service</Badge>}
                        {r.fitting && <Badge>+ fitting</Badge>}
                      </div>
                    </div>
                    {r.fits && (
                      <Badge tone="success">
                        <Car size={11} /> fits {vehicleName || 'car'}
                      </Badge>
                    )}
                    {!service && (
                      <span
                        className={`w-20 text-right text-xs tabular-nums ${out ? 'text-danger' : 'text-muted'}`}
                      >
                        {out ? 'Out of stock' : `Stock ${formatQty(r.stock_milli)}`}
                      </span>
                    )}
                    <span className="w-24 text-right font-medium tabular-nums">
                      {formatMoney(r.selling_price)}
                    </span>
                  </button>
                </li>
              );
            })}
          </motion.ul>
        )}
      </AnimatePresence>
    </div>
  );
}

/** Pick / scan the in-stock units of a serial-tracked line. qty = units picked. */
export function SerialPickerModal({ open, line, onDone, onCancel }) {
  const toast = useToast();
  const [units, setUnits] = useState(null);
  const [picked, setPicked] = useState(() => line.serials || []);
  const [q, setQ] = useState('');
  const scanRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    serialsApi
      .inStock(line.variant_id, '')
      .then((rows) => !cancelled && setUnits(rows))
      .catch(toast.error);
    return () => {
      cancelled = true;
    };
  }, [line.variant_id, toast]);

  const pickedIds = new Set(picked.map((p) => p.id));
  const key = q.trim().toUpperCase().replace(/\s+/g, '');
  const shown = (units || []).filter(
    (u) => !key || u.serial_no.toUpperCase().replace(/\s+/g, '').includes(key),
  );

  function toggle(u) {
    setPicked((list) =>
      list.some((p) => p.id === u.id)
        ? list.filter((p) => p.id !== u.id)
        : [...list, { id: u.id, serial_no: u.serial_no }],
    );
  }

  function onScan(e) {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (!key) {
      if (picked.length) onDone(picked);
      return;
    }
    const exact = (units || []).find((u) => u.serial_no.toUpperCase().replace(/\s+/g, '') === key);
    const hit = exact || (shown.length === 1 ? shown[0] : null);
    if (!hit) toast.error(`${q.trim()} is not in stock for this item.`);
    else if (!pickedIds.has(hit.id)) toggle(hit);
    setQ('');
  }

  return (
    <Modal
      open={open}
      onClose={onCancel}
      title={`Serial numbers: ${line.name}`}
      width="w-[34rem]"
      footer={
        <>
          <span className="mr-auto self-center text-sm text-muted">
            {picked.length} picked · qty {picked.length}
          </span>
          <Button onClick={onCancel}>Cancel</Button>
          <Button variant="primary" disabled={!picked.length} onClick={() => onDone(picked)}>
            Use {picked.length} unit{picked.length === 1 ? '' : 's'}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Input
          ref={scanRef}
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={onScan}
          placeholder="Scan or type a serial number, Enter to pick (Enter on empty = done)"
        />
        {picked.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {picked.map((p) => (
              <span
                key={p.id}
                className="flex items-center gap-1 rounded-md border border-primary/40 bg-primary-soft px-2 py-0.5 font-mono text-xs text-primary"
              >
                {p.serial_no}
                <button type="button" onClick={() => toggle(p)} title="Remove">
                  <X size={12} />
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="max-h-72 overflow-auto rounded-xl border border-border">
          {!units ? (
            <p className="p-3 text-sm text-muted">Loading…</p>
          ) : shown.length === 0 ? (
            <p className="p-3 text-sm text-muted">
              {units.length ? 'No match.' : 'No units of this item are in stock.'}
            </p>
          ) : (
            shown.map((u) => (
              <button
                key={u.id}
                type="button"
                onClick={() => toggle(u)}
                className={`flex w-full items-center gap-3 border-b border-border px-3 py-1.5 text-left text-sm last:border-0 ${pickedIds.has(u.id) ? 'bg-primary-soft/60' : 'hover:bg-surface-2'}`}
              >
                <span
                  className={`flex h-4 w-4 items-center justify-center rounded border ${pickedIds.has(u.id) ? 'border-primary bg-primary text-on-primary' : 'border-border'}`}
                >
                  {pickedIds.has(u.id) && <Check size={11} />}
                </span>
                <span className="flex-1 font-mono">{u.serial_no}</span>
                <span className="text-xs text-muted">
                  {u.purchase_date ? `in ${formatDate(u.purchase_date)}` : ''}
                </span>
              </button>
            ))
          )}
        </div>
      </div>
    </Modal>
  );
}

const COLS = ['qty', 'rate', 'disc', 'gst'];
const cellCls = 'h-8 px-2 text-sm tabular-nums';

/**
 * Lines grid. Keyboard: Enter = next cell, ↑/↓ = same column above / below, F2 = edit the cell
 * without clearing it, Ctrl+Delete = remove the line (and its fitting line).
 */
export function LinesGrid({
  form,
  calc,
  gstRates,
  errors,
  issues,
  showMargin,
  onLineChange,
  onRemove,
  onSerials,
  onToggleFitting,
  onFocusSearch,
}) {
  const ref = useRef(null);
  const gst = form.bill_type === 'gst';
  const grid = gst
    ? 'grid grid-cols-[1.25rem_minmax(8rem,1fr)_3.25rem_5.25rem_4.75rem_3.75rem_5.25rem_5.75rem_1.75rem] items-center gap-x-1'
    : 'grid grid-cols-[1.25rem_minmax(8rem,1fr)_3.25rem_5.25rem_4.75rem_5.75rem_1.75rem] items-center gap-x-1';
  const byUid = useMemo(() => new Map(form.lines.map((l) => [l.uid, l])), [form.lines]);

  function focusCell(row, col) {
    const el = ref.current?.querySelector(`[data-cell="${row}:${col}"]`);
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
      if (!focusCell(row + 1, COLS[0])) onFocusSearch();
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
      setTimeout(() => focusCell(Math.max(0, row - 1), c) || onFocusSearch(), 0);
    }
  }

  const err = (i, k) => errors[`items.${i}.${k}`];

  return (
    <div ref={ref} onKeyDown={onKeyDown}>
      <div className={`${grid} border-b border-border px-2 pb-1.5 text-xs font-medium text-muted`}>
        <span>#</span>
        <span>Item</span>
        <span className="text-right">Qty</span>
        <span className="text-right">Rate</span>
        <span className="text-right">Discount</span>
        {gst && <span className="text-right">GST</span>}
        {gst && <span className="text-right">Taxable / tax</span>}
        <span className="text-right">Total</span>
        <span />
      </div>
      <AnimatePresence initial={false}>
        {form.lines.map((l, i) => {
          const c = calc?.lines?.[i] || null;
          const qty = parseQty(l.qty) || 0;
          const isFitting = Boolean(l.fitting_for);
          const parent = isFitting ? byUid.get(l.fitting_for) : null;
          const fittingChild = form.lines.find((x) => x.fitting_for === l.uid);
          const lineIssues = issues[l.uid];
          // Price checks: incl.-tax unit price above MRP, taxable unit value below cost.
          const unitIncl = c && qty ? Math.round((c.line_total * 1000) / qty) : null;
          const unitNet = c && qty ? Math.round((c.taxable * 1000) / qty) : null;
          const overMrp =
            l.item_type === 'goods' && l.mrp > 0 && unitIncl != null && unitIncl > l.mrp;
          const underCost =
            l.item_type === 'goods' && l.avg_cost > 0 && unitNet != null && unitNet < l.avg_cost;
          const stockShort =
            l.item_type === 'goods' && !l.track_serials && qty > Math.max(l.stock_milli, 0);
          const margin =
            showMargin && c && l.item_type === 'goods' && c.taxable > 0
              ? {
                  cost: Math.round((l.avg_cost * qty) / 1000),
                  pct:
                    Math.round(((c.taxable - (l.avg_cost * qty) / 1000) * 1000) / c.taxable) / 10,
                }
              : null;
          return (
            <motion.div
              key={l.uid}
              layout="position"
              initial={{ opacity: 0, y: -3 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.12 }}
              className={`border-b border-border py-1 ${isFitting ? 'bg-surface-2/40' : ''} ${lineIssues ? 'bg-danger-soft/40' : ''}`}
            >
              <div className={`${grid} px-2`}>
                <span className="text-xs text-muted tabular-nums">{i + 1}</span>
                <div className="min-w-0">
                  <div
                    className={`flex items-center gap-1 truncate text-sm font-medium ${err(i, 'variant_id') ? 'text-danger' : ''} ${isFitting ? 'pl-3' : ''}`}
                  >
                    {isFitting && <Wrench size={12} className="shrink-0 text-muted" />}
                    <span className="truncate">{l.name}</span>
                    {l.variant_label && (
                      <span className="truncate font-normal text-muted">· {l.variant_label}</span>
                    )}
                    {l.fits && (
                      <span title="Fits the customer's car">
                        <Car size={12} className="shrink-0 text-success" />
                      </span>
                    )}
                  </div>
                  <div className={`truncate text-[11px] text-muted ${isFitting ? 'pl-3' : ''}`}>
                    {[
                      l.hsn_code
                        ? `${l.item_type === 'service' ? 'SAC' : 'HSN'} ${l.hsn_code}`
                        : null,
                      l.unit,
                      l.item_type === 'goods' && !l.track_serials
                        ? `stock ${formatQty(l.stock_milli)}`
                        : null,
                      isFitting && parent ? `fitting for ${parent.name}` : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </div>
                </div>
                <Input
                  data-cell={`${i}:qty`}
                  value={l.qty}
                  inputMode="decimal"
                  readOnly={l.track_serials}
                  title={l.track_serials ? 'Pick serial numbers to change the quantity' : undefined}
                  invalid={Boolean(err(i, 'qty_milli')) || stockShort}
                  onFocus={(e) => e.target.select()}
                  onChange={(e) => onLineChange(i, { qty: e.target.value })}
                  onKeyDown={(e) => {
                    if (l.track_serials && (e.key === ' ' || e.key === 'F2')) {
                      e.preventDefault();
                      onSerials(i);
                    }
                  }}
                  className={`${cellCls} text-right`}
                />
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
                    className="h-8 w-6 shrink-0 rounded-r-lg border border-l-0 border-border bg-surface-2 text-xs font-semibold text-muted hover:text-fg"
                  >
                    {l.disc_mode === 'pct' ? '%' : '₹'}
                  </button>
                </div>
                {gst && (
                  <select
                    data-cell={`${i}:gst`}
                    value={l.gst_rate_bp}
                    onChange={(e) => onLineChange(i, { gst_rate_bp: Number(e.target.value) })}
                    className={`h-8 w-full rounded-lg border bg-surface px-1 text-right text-sm focus:border-primary focus:ring-2 focus:ring-primary/20 focus:outline-none ${err(i, 'gst_rate_bp') ? 'border-danger' : 'border-border'}`}
                  >
                    {!gstRates.some((r) => r.rate_bp === l.gst_rate_bp) && (
                      <option value={l.gst_rate_bp}>{formatRateBp(l.gst_rate_bp)}</option>
                    )}
                    {gstRates.map((r) => (
                      <option key={r.id} value={r.rate_bp}>
                        {formatRateBp(r.rate_bp)}
                      </option>
                    ))}
                  </select>
                )}
                {gst && (
                  <span className="text-right text-xs leading-tight tabular-nums">
                    {c ? formatMoney(c.taxable) : '—'}
                    <span className="block text-muted">
                      {c ? `+${formatMoney(c.cgst + c.sgst + c.igst)}` : ''}
                    </span>
                  </span>
                )}
                <span className="text-right text-sm font-semibold tabular-nums">
                  {c ? formatMoney(c.line_total) : '—'}
                </span>
                <Button
                  size="icon-sm"
                  variant="danger-ghost"
                  icon={Trash2}
                  tabIndex={-1}
                  title="Remove line (Ctrl+Delete)"
                  onClick={() => onRemove(i)}
                />
              </div>

              <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 pl-8 text-xs">
                {l.track_serials && (
                  <button
                    type="button"
                    tabIndex={-1}
                    onClick={() => onSerials(i)}
                    className={`flex items-center gap-1 rounded-md border px-1.5 py-0.5 font-medium ${
                      l.serials.length
                        ? 'border-success/40 bg-success-soft text-success'
                        : 'border-danger/40 bg-danger-soft text-danger'
                    }`}
                  >
                    <Barcode size={12} />
                    {l.serials.length
                      ? l.serials
                          .slice(0, 4)
                          .map((s) => s.serial_no)
                          .join(', ') + (l.serials.length > 4 ? ` +${l.serials.length - 4}` : '')
                      : 'Pick serial numbers'}
                  </button>
                )}
                {l.item_type === 'goods' && (
                  <label className="flex items-center gap-1 text-muted" title="Warranty in months">
                    <ShieldCheck size={12} />
                    <input
                      value={l.warranty_months}
                      tabIndex={-1}
                      inputMode="numeric"
                      onChange={(e) =>
                        onLineChange(i, {
                          warranty_months: e.target.value.replace(/\D/g, '').slice(0, 3),
                        })
                      }
                      className="w-8 rounded border border-border bg-surface px-1 text-right"
                    />
                    mo warranty
                  </label>
                )}
                {l.item_type === 'goods' && (l.fitting_template || fittingChild) && (
                  <button
                    type="button"
                    tabIndex={-1}
                    onClick={() => onToggleFitting(i)}
                    className={`flex items-center gap-1 rounded-md border px-1.5 py-0.5 ${fittingChild ? 'border-primary/40 text-primary' : 'border-border text-muted'}`}
                  >
                    <Wrench size={12} /> Fitting {fittingChild ? '✓' : '✗'}
                  </button>
                )}
                {fittingChild && (
                  <label className="flex items-center gap-1 text-muted">
                    <input
                      type="checkbox"
                      tabIndex={-1}
                      className="h-3.5 w-3.5 accent-primary"
                      checked={l.fitting_merged}
                      onChange={(e) => onLineChange(i, { fitting_merged: e.target.checked })}
                    />
                    merge fitting on print
                  </label>
                )}
                {(isFitting || l.item_type === 'service') && (
                  <input
                    value={l.fitted_by}
                    tabIndex={-1}
                    maxLength={60}
                    placeholder="Fitted by…"
                    onChange={(e) => onLineChange(i, { fitted_by: e.target.value })}
                    className="h-6 w-32 rounded border border-border bg-surface px-1.5"
                  />
                )}
                {overMrp && (
                  <span className="text-warning">
                    <AlertTriangle size={12} className="inline" /> above MRP {formatMoney(l.mrp)}
                  </span>
                )}
                {underCost && (
                  <span className="text-warning">
                    <AlertTriangle size={12} className="inline" /> below cost
                  </span>
                )}
                {stockShort && (
                  <span className="text-danger">only {formatQty(l.stock_milli)} in stock</span>
                )}
                {margin && (
                  <span className="text-muted">
                    cost {formatMoney(margin.cost)} · margin{' '}
                    <span className={margin.pct < 0 ? 'text-danger' : 'text-success'}>
                      {margin.pct}%
                    </span>
                  </span>
                )}
                {err(i, 'serials') && <span className="text-danger">{err(i, 'serials')}</span>}
                {err(i, 'variant_id') && (
                  <span className="text-danger">{err(i, 'variant_id')}</span>
                )}
                {err(i, 'qty_milli') && err(i, 'qty_milli').length > 5 && (
                  <span className="text-danger">{err(i, 'qty_milli')}</span>
                )}
                {lineIssues && (
                  <span className="text-danger">
                    <AlertTriangle size={12} className="inline" /> {lineIssues.join(' ')}
                  </span>
                )}
              </div>
            </motion.div>
          );
        })}
      </AnimatePresence>
      {form.lines.length === 0 && (
        <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted">
          <Plus size={16} /> Scan a barcode or search above (F3) to add the first item.
        </div>
      )}
    </div>
  );
}
