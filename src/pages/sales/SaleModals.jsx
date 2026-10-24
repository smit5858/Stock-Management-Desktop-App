import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowLeftRight,
  Ban,
  FileDown,
  FolderOpen,
  Printer,
  ReceiptText,
  RotateCcw,
  Search,
  Undo2,
} from 'lucide-react';
import Button from '../../components/Button';
import { Modal } from '../../components/Overlay';
import { Field, Input, MoneyInput, Segmented, Select, Textarea } from '../../components/Field';
import { Badge, Skeleton } from '../../components/Feedback';
import CustomerPicker from '../../components/CustomerPicker';
import { useToast } from '../../components/Toast';
import { quotationsApi, saleReturnsApi, salesApi } from '../../api/sales';
import { formatMoney, paiseToInput, parseMoney } from '../../utils/money';
import { formatQty, formatRateBp, parseQty } from '../../utils/qty';
import { formatDate, formatDateTime, todayISO } from '../../utils/dates';
import { ItemSearch } from './BillLines';
import { rateFor } from './billForm';

const MODES = { cash: 'Cash', upi: 'UPI', card: 'Card', bank: 'Bank', cheque: 'Cheque' };
const REFUND_MODES = { cash: 'Cash', upi: 'UPI', bank: 'Bank' };

const API = { sale: salesApi, quotation: quotationsApi, return: saleReturnsApi };

const DEFAULT_FORMATS = [
  { value: 'a4', label: 'A4' },
  { value: 'thermal80', label: 'Thermal 80 mm' },
];

/**
 * Print preview (no print counter) with a format switch, Print and Save PDF.
 * `kind` picks a built-in document API; `api` = { previewHtml(id, f), print(id, f),
 * savePdf(id, f) } prints anything else (warranty slips, cards) with its own `formats`.
 */
export function PrintPreviewModal({
  open,
  kind = 'sale',
  api: customApi = null,
  formats = DEFAULT_FORMATS,
  id,
  defaultFormat = 'a4',
  title,
  onClose,
}) {
  const toast = useToast();
  const [format, setFormat] = useState(defaultFormat);
  const [html, setHtml] = useState({ key: '', text: '' });
  const [saved, setSaved] = useState(null);
  const [busy, setBusy] = useState(false);
  // Kept stable for the modal's life (a custom api object may be created inline).
  const [api] = useState(() => customApi || API[kind]);
  const key = `${kind}:${id}:${format}`;

  useEffect(() => {
    let cancelled = false;
    api
      .previewHtml(id, format)
      .then((text) => !cancelled && setHtml({ key, text }))
      .catch(toast.error);
    return () => {
      cancelled = true;
    };
  }, [api, id, format, key, toast]);

  async function doPrint() {
    setBusy(true);
    try {
      await api.print(id, format);
      setHtml((h) => ({ ...h, key: '' }));
      api
        .previewHtml(id, format)
        .then((text) => setHtml({ key, text }))
        .catch(() => {});
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  }

  async function doPdf() {
    setBusy(true);
    try {
      const r = await api.savePdf(id, format);
      if (r.saved) {
        setSaved(r.file_path);
        toast.success('PDF saved in the data folder.');
      }
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title || 'Print preview'}
      width="w-[60rem]"
      footer={
        <>
          <div className="mr-auto flex items-center gap-2">
            <Segmented
              layoutId={`print-format-${kind}`}
              value={format}
              onChange={setFormat}
              options={formats}
            />
            {saved && (
              <Button
                size="sm"
                variant="ghost"
                icon={FolderOpen}
                onClick={() => salesApi.showFile(saved).catch(toast.error)}
              >
                Show PDF
              </Button>
            )}
          </div>
          <Button icon={FileDown} disabled={busy} onClick={doPdf}>
            Save PDF
          </Button>
          <Button variant="primary" icon={Printer} disabled={busy} onClick={doPrint} autoFocus>
            Print
          </Button>
        </>
      }
    >
      <div
        className={`mx-auto overflow-hidden rounded-lg border border-border bg-white ${format === 'thermal80' ? 'w-[22rem]' : 'w-full'}`}
      >
        {html.key === key ? (
          <iframe
            title="Preview"
            sandbox=""
            srcDoc={html.text}
            className="h-[68vh] w-full bg-white"
          />
        ) : (
          <Skeleton className="h-[68vh]" />
        )}
      </div>
    </Modal>
  );
}

/** Cancel with a reason. Money received → advance (default) or record a refund. */
export function CancelSaleModal({ open, sale, onClose, onDone }) {
  const toast = useToast();
  const received = sale.allocations
    .filter((a) => a.status === 'active' && a.source_type === 'payment')
    .reduce((s, a) => s + a.amount, 0);
  const isCash = Boolean(sale.customer?.is_system);
  const [reason, setReason] = useState('');
  const [refund, setRefund] = useState(isCash && received > 0);
  const [mode, setMode] = useState('cash');
  const [amount, setAmount] = useState(paiseToInput(received));
  const [refNo, setRefNo] = useState('');
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState({});

  async function go(reissue) {
    setBusy(true);
    try {
      const r = refund && received > 0 ? { amount: parseMoney(amount), mode, ref_no: refNo } : null;
      const next = await salesApi.cancel(sale.id, reason, r);
      toast.success(`${sale.invoice_no} cancelled. Stock and serials are back.`);
      onDone(next, reissue);
    } catch (e) {
      setErrors(e.fields || {});
      toast.error(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Cancel ${sale.invoice_no}`}
      width="w-[34rem]"
      footer={
        <>
          <Button onClick={onClose}>Back</Button>
          <Button icon={RotateCcw} disabled={busy || !reason.trim()} onClick={() => go(true)}>
            Cancel &amp; re-issue
          </Button>
          <Button
            variant="danger"
            icon={Ban}
            disabled={busy || !reason.trim()}
            onClick={() => go(false)}
          >
            Cancel bill
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-sm">
        <p className="text-muted">
          Saved bills are never edited. Cancelling keeps the number {sale.invoice_no} (marked
          CANCELLED), puts the stock and serial numbers back and voids their warranty.
        </p>
        <Field label="Reason" required error={errors.reason}>
          {(id) => (
            <Input
              id={id}
              autoFocus
              value={reason}
              maxLength={200}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. wrong item billed, customer changed mind"
            />
          )}
        </Field>
        {received > 0 && (
          <div className="space-y-2 rounded-xl border border-border p-3">
            <div>
              {formatMoney(received)} was received on this bill.{' '}
              {isCash
                ? 'Cash Customer: record the refund.'
                : 'By default it stays as customer advance.'}
            </div>
            <label className="flex items-center gap-2 font-medium">
              <input
                type="checkbox"
                className="h-4 w-4 accent-primary"
                checked={refund}
                disabled={isCash}
                onChange={(e) => setRefund(e.target.checked)}
              />
              Record refund given
            </label>
            {refund && (
              <div className="grid grid-cols-3 gap-2">
                <MoneyInput
                  value={amount}
                  invalid={Boolean(errors['refund.amount'])}
                  onChange={(e) => setAmount(e.target.value)}
                />
                <Select value={mode} onChange={(e) => setMode(e.target.value)}>
                  {Object.entries(REFUND_MODES).map(([k, l]) => (
                    <option key={k} value={k}>
                      {l}
                    </option>
                  ))}
                </Select>
                <Input
                  value={refNo}
                  placeholder="Ref / UTR"
                  onChange={(e) => setRefNo(e.target.value)}
                />
              </div>
            )}
            {errors['refund.amount'] && (
              <p className="text-xs text-danger">{errors['refund.amount']}</p>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}

/** Receive a payment against a saved bill (Phase 6 adds the full Accounts screens). */
export function SalePaymentModal({ open, sale, advance = 0, onClose, onDone }) {
  const toast = useToast();
  const [amount, setAmount] = useState(paiseToInput(sale.due));
  const [mode, setMode] = useState('cash');
  const [refNo, setRefNo] = useState('');
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    try {
      const next = await salesApi.recordPayment({
        id: sale.id,
        amount: parseMoney(amount),
        mode,
        ref_no: refNo,
      });
      toast.success('Payment recorded.');
      onDone(next);
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Receive payment · ${sale.invoice_no}`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={busy} onClick={save}>
            Save payment
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-3 text-sm">
        <p className="col-span-2 text-muted">Due on this bill: {formatMoney(sale.due)}</p>
        <Field label="Amount">
          {(id) => (
            <MoneyInput
              id={id}
              autoFocus
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          )}
        </Field>
        <Field label="Mode">
          {(id) => (
            <Select id={id} value={mode} onChange={(e) => setMode(e.target.value)}>
              {Object.entries(MODES).map(([k, l]) => (
                <option key={k} value={k}>
                  {l}
                </option>
              ))}
              {advance > 0 && (
                <option value="advance">From advance ({formatMoney(advance)})</option>
              )}
            </Select>
          )}
        </Field>
        {mode !== 'cash' && mode !== 'advance' && (
          <Field
            label={mode === 'cheque' ? 'Cheque no.' : 'Reference / UTR'}
            className="col-span-2"
          >
            {(id) => (
              <Input
                id={id}
                value={refNo}
                maxLength={40}
                onChange={(e) => setRefNo(e.target.value)}
              />
            )}
          </Field>
        )}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- returns

function FindBill({ onPick, onStandalone }) {
  const [q, setQ] = useState('');
  const [rows, setRows] = useState(null);
  const toast = useToast();
  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) return undefined;
    let cancelled = false;
    const t = setTimeout(() => {
      saleReturnsApi
        .find(term)
        .then((r) => !cancelled && setRows(r))
        .catch(toast.error);
    }, 180);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [q, toast]);
  return (
    <div className="space-y-3">
      <div className="relative">
        <Search
          size={16}
          className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted"
        />
        <Input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Invoice no., serial number, phone or vehicle number…"
          className="pl-9"
        />
      </div>
      <div className="max-h-80 overflow-auto rounded-xl border border-border">
        {q.trim().length < 2 || !rows ? (
          <p className="p-3 text-sm text-muted">Type at least 2 characters.</p>
        ) : rows.length === 0 ? (
          <p className="p-3 text-sm text-muted">No active bill found.</p>
        ) : (
          rows.map((r) => (
            <button
              key={r.id}
              type="button"
              onClick={() => onPick(r.id)}
              className="flex w-full items-center gap-3 border-b border-border px-3 py-2 text-left text-sm last:border-0 hover:bg-surface-2"
            >
              <span className="w-24 font-medium">{r.invoice_no}</span>
              <span className="w-24 text-muted">{formatDate(r.invoice_date)}</span>
              <span className="min-w-0 flex-1 truncate">
                {r.customer_name}
                {r.vehicle_no ? <span className="text-muted"> · {r.vehicle_no}</span> : null}
              </span>
              <span className="tabular-nums">{formatMoney(r.grand_total)}</span>
            </button>
          ))
        )}
      </div>
      <button type="button" className="text-sm text-primary hover:underline" onClick={onStandalone}>
        No bill? Make a standalone return with a customer →
      </button>
    </div>
  );
}

/**
 * Sale return (credit note) from a bill, or standalone. `onExchange(returnPayload, credit,
 * customer)` continues on the billing screen with a new bill (exchange).
 */
export function SaleReturnModal({
  open,
  saleId: initialSaleId = null,
  onClose,
  onDone,
  onExchange,
}) {
  const toast = useToast();
  const [saleId, setSaleId] = useState(initialSaleId);
  const [standalone, setStandalone] = useState(false);
  const [prep, setPrep] = useState(null);
  const [lines, setLines] = useState({}); // sale_item_id → { qty, serials: { id: to_status } }
  const [party, setParty] = useState(null);
  const [meta, setMeta] = useState(null);
  const [extra, setExtra] = useState([]); // standalone lines
  const [reason, setReason] = useState('');
  const [settlement, setSettlement] = useState('adjust');
  const [refundMode, setRefundMode] = useState('cash');
  const [refundRef, setRefundRef] = useState('');
  const [calc, setCalc] = useState(null);
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!saleId) return undefined;
    let cancelled = false;
    saleReturnsApi
      .prepare(saleId)
      .then((p) => {
        if (cancelled) return;
        setPrep(p);
        setSettlement(p.sale.is_cash ? 'refund' : 'adjust');
        const init = {};
        for (const l of p.lines) init[l.sale_item_id] = { qty: '', serials: {} };
        setLines(init);
      })
      .catch((e) => {
        toast.error(e);
        onClose();
      });
    return () => {
      cancelled = true;
    };
  }, [saleId, toast, onClose]);

  useEffect(() => {
    if (!standalone || meta) return;
    salesApi.meta().then(setMeta).catch(toast.error);
  }, [standalone, meta, toast]);

  const payload = useMemo(() => {
    const base = {
      date: todayISO(),
      reason,
      settlement,
      refund: settlement === 'refund' ? { mode: refundMode, ref_no: refundRef } : null,
    };
    if (prep) {
      return {
        ...base,
        sale_id: prep.sale.id,
        lines: prep.lines
          .map((l) => {
            const st = lines[l.sale_item_id] || { qty: '', serials: {} };
            if (l.track_serials) {
              const ids = Object.keys(st.serials);
              return {
                sale_item_id: l.sale_item_id,
                qty_milli: ids.length * 1000,
                serials: ids.map((sid) => ({ id: Number(sid), to_status: st.serials[sid] })),
              };
            }
            return { sale_item_id: l.sale_item_id, qty_milli: parseQty(st.qty || '0') ?? 0 };
          })
          .filter((l) => l.qty_milli > 0),
      };
    }
    return {
      ...base,
      party_id: party?.customer?.id ?? null,
      bill_type: meta?.default_bill_type || 'gst',
      price_mode: 'inclusive',
      lines: extra
        .map((l) => ({
          variant_id: l.variant_id,
          qty_milli: parseQty(l.qty || '0') ?? 0,
          rate: parseMoney(l.rate || '0') ?? 0,
          gst_rate_bp: l.gst_rate_bp,
        }))
        .filter((l) => l.qty_milli > 0),
    };
  }, [prep, lines, party, extra, meta, reason, settlement, refundMode, refundRef]);

  const payloadKey = JSON.stringify(payload);
  useEffect(() => {
    const p = JSON.parse(payloadKey);
    if (!p.lines.length || (!p.sale_id && !p.party_id)) return undefined;
    let cancelled = false;
    const t = setTimeout(() => {
      saleReturnsApi
        .calculate({ ...p, settlement: p.settlement })
        .then((r) => {
          if (cancelled) return;
          setCalc({ key: payloadKey, ...r });
          setErrors({});
        })
        .catch((e) => !cancelled && setErrors(e.fields || { lines: e.message }));
    }, 120);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [payloadKey]);
  const live = calc && calc.key === payloadKey ? calc : null;

  async function create() {
    setBusy(true);
    try {
      const r = await saleReturnsApi.create(payload);
      toast.success(`Credit note ${r.return_no} saved (${formatMoney(r.total)}).`);
      onDone(r);
    } catch (e) {
      setErrors(e.fields || {});
      toast.error(e);
    } finally {
      setBusy(false);
    }
  }

  function exchange() {
    const customer = prep
      ? { id: prep.sale.party_id, name: prep.sale.customer_name, is_cash: prep.sale.is_cash }
      : { id: party.customer.id, name: party.customer.name };
    onExchange(
      { ...payload, settlement: 'exchange' },
      live ? live.totals.total : 0,
      customer,
      prep ? prep.sale.invoice_no : 'standalone return',
    );
  }

  const setLine = (sid, patch) => setLines((s) => ({ ...s, [sid]: { ...s[sid], ...patch } }));
  const isCash = prep ? prep.sale.is_cash : Boolean(party?.customer?.is_system);
  const ready = payload.lines.length > 0 && live;

  let body;
  if (!saleId && !standalone) {
    body = <FindBill onPick={setSaleId} onStandalone={() => setStandalone(true)} />;
  } else if (saleId && !prep) {
    body = <Skeleton className="h-48" />;
  } else {
    body = (
      <div className="space-y-3 text-sm">
        {prep ? (
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="primary">{prep.sale.invoice_no}</Badge>
            <span>
              {prep.sale.customer_name} · {formatDate(prep.sale.invoice_date)}
              {prep.sale.vehicle_no ? ` · ${prep.sale.vehicle_no}` : ''}
            </span>
            <span className="ml-auto text-muted">
              Bill {formatMoney(prep.sale.grand_total)} · due {formatMoney(prep.sale.due)}
            </span>
          </div>
        ) : (
          <Field label="Customer" error={errors.party_id}>
            {() => <CustomerPicker value={party} onChange={setParty} />}
          </Field>
        )}

        {prep && (
          <div className="max-h-[22rem] overflow-auto rounded-xl border border-border">
            {prep.lines.map((l) => {
              const st = lines[l.sale_item_id] || { qty: '', serials: {} };
              const parent = l.fitting_for_item_id
                ? prep.lines.find((x) => x.sale_item_id === l.fitting_for_item_id)
                : null;
              return (
                <div
                  key={l.sale_item_id}
                  className="border-b border-border px-3 py-2 last:border-0"
                >
                  <div className="flex items-center gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium">
                        {l.product_name}
                        {l.variant_label && (
                          <span className="font-normal text-muted"> · {l.variant_label}</span>
                        )}
                      </div>
                      <div className="text-xs text-muted">
                        Sold {formatQty(l.qty_milli)} {l.unit} · {formatMoney(l.unit_value)}/unit
                        {l.returned_milli > 0 && ` · returned ${formatQty(l.returned_milli)}`}
                        {parent &&
                          ` · fitting for ${parent.product_name} (no refund unless chosen)`}
                      </div>
                    </div>
                    {!l.track_serials && (
                      <Input
                        value={st.qty}
                        placeholder="0"
                        disabled={l.returnable_milli <= 0}
                        inputMode="decimal"
                        invalid={Boolean(errors[`lines.${prep.lines.indexOf(l)}.qty_milli`])}
                        onChange={(e) => setLine(l.sale_item_id, { qty: e.target.value })}
                        className="h-8 w-20 text-right"
                      />
                    )}
                    <span className="w-24 text-right text-xs text-muted">
                      max {formatQty(l.returnable_milli)}
                    </span>
                  </div>
                  {l.track_serials && (
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {l.serials.length === 0 && (
                        <span className="text-xs text-muted">All units already returned.</span>
                      )}
                      {l.serials.map((u) => {
                        const on = u.id in st.serials;
                        return (
                          <span
                            key={u.id}
                            className={`flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs ${on ? 'border-primary bg-primary-soft' : 'border-border'}`}
                          >
                            <label className="flex items-center gap-1 font-mono">
                              <input
                                type="checkbox"
                                className="h-3.5 w-3.5 accent-primary"
                                checked={on}
                                onChange={(e) => {
                                  const next = { ...st.serials };
                                  if (e.target.checked) next[u.id] = 'in_stock';
                                  else delete next[u.id];
                                  setLine(l.sale_item_id, { serials: next });
                                }}
                              />
                              {u.serial_no}
                            </label>
                            {u.warranty && u.warranty.status !== 'none' && (
                              <span
                                title={
                                  u.warranty_end
                                    ? `Warranty till ${formatDate(u.warranty_end)}`
                                    : ''
                                }
                                className={`rounded px-1 text-[10px] font-medium ${
                                  {
                                    active: 'bg-success-soft text-success',
                                    expiring: 'bg-warning-soft text-warning',
                                    expired: 'bg-danger-soft text-danger',
                                  }[u.warranty.status] || 'bg-surface-2 text-muted'
                                }`}
                              >
                                {u.warranty.status === 'void'
                                  ? 'warranty void'
                                  : u.warranty.status === 'expired'
                                    ? 'warranty expired'
                                    : `warranty ${u.warranty.days_left}d`}
                              </span>
                            )}
                            {u.open_claim_no && (
                              <span className="rounded bg-info-soft px-1 text-[10px] font-medium text-info">
                                claim {u.open_claim_no}
                              </span>
                            )}
                            {on && (
                              <select
                                value={st.serials[u.id]}
                                onChange={(e) =>
                                  setLine(l.sale_item_id, {
                                    serials: { ...st.serials, [u.id]: e.target.value },
                                  })
                                }
                                className="rounded border border-border bg-surface px-1"
                              >
                                <option value="in_stock">back to stock</option>
                                <option value="defective">defective</option>
                              </select>
                            )}
                          </span>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {!prep && party && meta && (
          <div className="space-y-2">
            <ItemSearch
              onAdd={(row) => {
                if (row.track_serials) {
                  toast.error(
                    'Serial-numbered items are returned from their bill (search by serial number).',
                  );
                  return;
                }
                setExtra((x) => [
                  ...x,
                  {
                    key: `${row.variant_id}-${x.length}`,
                    variant_id: row.variant_id,
                    name: row.name,
                    qty: '1',
                    rate: paiseToInput(
                      rateFor(row, { bill_type: meta.default_bill_type, price_mode: 'inclusive' }),
                    ),
                    gst_rate_bp: row.gst_rate_bp,
                  },
                ]);
              }}
            />
            {extra.map((l, i) => (
              <div key={l.key} className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate">{l.name}</span>
                <Input
                  value={l.qty}
                  className="h-8 w-16 text-right"
                  onChange={(e) =>
                    setExtra((x) => x.map((y, j) => (j === i ? { ...y, qty: e.target.value } : y)))
                  }
                />
                <MoneyInput
                  value={l.rate}
                  className="w-28"
                  title="Price incl. GST"
                  onChange={(e) =>
                    setExtra((x) => x.map((y, j) => (j === i ? { ...y, rate: e.target.value } : y)))
                  }
                />
                <span className="w-12 text-xs text-muted">{formatRateBp(l.gst_rate_bp)}</span>
                <Button
                  size="icon-sm"
                  variant="danger-ghost"
                  icon={Ban}
                  onClick={() => setExtra((x) => x.filter((_, j) => j !== i))}
                />
              </div>
            ))}
          </div>
        )}

        <div className="grid grid-cols-2 gap-3">
          <Field label="Reason (printed on the credit note)">
            {(id) => (
              <Textarea
                id={id}
                rows={2}
                value={reason}
                maxLength={200}
                onChange={(e) => setReason(e.target.value)}
              />
            )}
          </Field>
          <div className="space-y-2">
            <Segmented
              layoutId="return-settlement"
              value={settlement}
              onChange={setSettlement}
              options={[
                ...(isCash ? [] : [{ value: 'adjust', label: 'Adjust to balance' }]),
                { value: 'refund', label: 'Refund' },
              ]}
            />
            {settlement === 'refund' && (
              <div className="flex gap-2">
                <Select value={refundMode} onChange={(e) => setRefundMode(e.target.value)}>
                  {Object.entries(REFUND_MODES).map(([k, l]) => (
                    <option key={k} value={k}>
                      {l}
                    </option>
                  ))}
                </Select>
                <Input
                  value={refundRef}
                  placeholder="Ref / UTR"
                  onChange={(e) => setRefundRef(e.target.value)}
                />
              </div>
            )}
          </div>
        </div>

        <div className="rounded-xl bg-surface-2/60 p-3">
          {live ? (
            <div className="space-y-0.5">
              <div className="flex justify-between text-base font-bold">
                <span>Credit note total</span>
                <span className="tabular-nums">{formatMoney(live.totals.total)}</span>
              </div>
              {live.totals.tax_total > 0 && (
                <div className="flex justify-between text-xs text-muted">
                  <span>incl. GST reversed at the original rate</span>
                  <span className="tabular-nums">{formatMoney(live.totals.tax_total)}</span>
                </div>
              )}
              {live.to_bill > 0 && (
                <div className="flex justify-between text-xs">
                  <span>Reduces the bill&apos;s due</span>
                  <span className="tabular-nums">{formatMoney(live.to_bill)}</span>
                </div>
              )}
              {live.refund_amount > 0 && (
                <div className="flex justify-between text-xs">
                  <span>Refund to give</span>
                  <span className="tabular-nums">{formatMoney(live.refund_amount)}</span>
                </div>
              )}
              {live.to_advance > 0 && (
                <div className="flex justify-between text-xs">
                  <span>Kept as customer advance</span>
                  <span className="tabular-nums">{formatMoney(live.to_advance)}</span>
                </div>
              )}
            </div>
          ) : (
            <span className="text-muted">
              {Object.values(errors)[0] || 'Choose the quantities / serial numbers being returned.'}
            </span>
          )}
        </div>
      </div>
    );
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={
        prep
          ? `Return from ${prep.sale.invoice_no}`
          : standalone
            ? 'Standalone return'
            : 'Sale return'
      }
      width="w-[48rem]"
      footer={
        (prep || standalone) && (
          <>
            <Button onClick={onClose}>Cancel</Button>
            {onExchange && (
              <Button
                icon={ArrowLeftRight}
                disabled={!ready || busy}
                onClick={exchange}
                title="Return these and bill new items; only the difference is paid / refunded"
              >
                Exchange…
              </Button>
            )}
            <Button variant="primary" icon={Undo2} disabled={!ready || busy} onClick={create}>
              Save credit note
            </Button>
          </>
        )
      }
    >
      {body}
    </Modal>
  );
}

/** Credit note detail. */
export function CreditNoteModal({ open, returnId, onClose }) {
  const toast = useToast();
  const [r, setR] = useState(null);
  const [preview, setPreview] = useState(false);
  useEffect(() => {
    saleReturnsApi.get(returnId).then(setR).catch(toast.error);
  }, [returnId, toast]);
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={r ? `Credit note ${r.return_no}` : 'Credit note'}
      width="w-[44rem]"
      footer={
        <>
          <Button icon={Printer} disabled={!r} onClick={() => setPreview(true)}>
            Print / PDF
          </Button>
          <Button onClick={onClose}>Close</Button>
        </>
      }
    >
      {!r ? (
        <Skeleton className="h-32" />
      ) : (
        <div className="space-y-3 text-sm">
          <div className="flex flex-wrap gap-2">
            <Badge tone={r.status === 'active' ? 'success' : 'danger'}>
              {r.status === 'active' ? 'Active' : 'Cancelled'}
            </Badge>
            <Badge>
              {
                { refund: 'Refunded', adjust: 'Adjusted to balance', exchange: 'Exchange' }[
                  r.settlement
                ]
              }
            </Badge>
            {r.sale && <Badge tone="primary">Against {r.sale.invoice_no}</Badge>}
            {r.exchange_sale && <Badge tone="primary">New bill {r.exchange_sale.invoice_no}</Badge>}
          </div>
          <p className="text-muted">
            {r.customer_name} · {formatDate(r.date)}
            {r.reason ? ` · ${r.reason}` : ''}
          </p>
          <ul className="divide-y divide-border rounded-xl border border-border">
            {r.lines.map((l) => (
              <li key={l.id} className="flex items-start justify-between gap-3 px-3 py-2">
                <div>
                  <div className="font-medium">{l.product_name}</div>
                  <div className="text-xs text-muted">
                    {formatQty(l.qty_milli)} {l.unit} · taxable {formatMoney(l.taxable)}
                    {l.gst_rate_bp ? ` + GST ${formatRateBp(l.gst_rate_bp)}` : ''}
                  </div>
                  {l.serials.length > 0 && (
                    <div className="mt-1 font-mono text-xs">
                      {l.serials
                        .map(
                          (s) =>
                            `${s.serial_no}${s.to_status === 'defective' ? ' (defective)' : ''}`,
                        )
                        .join(', ')}
                    </div>
                  )}
                </div>
                <span className="font-semibold tabular-nums">{formatMoney(l.line_total)}</span>
              </li>
            ))}
          </ul>
          <div className="flex justify-between text-base font-bold">
            <span>Total credit</span>
            <span className="tabular-nums">{formatMoney(r.total)}</span>
          </div>
          {r.refunds.map((p) => (
            <div key={p.id} className="flex justify-between text-xs text-muted">
              <span>
                Refund {p.payment_no} · {p.mode}
              </span>
              <span className="tabular-nums">{formatMoney(p.amount)}</span>
            </div>
          ))}
        </div>
      )}
      {preview && r && (
        <PrintPreviewModal
          open
          kind="return"
          id={r.id}
          title={`Credit note ${r.return_no}`}
          onClose={() => setPreview(false)}
        />
      )}
    </Modal>
  );
}

/** Quotation detail: print, convert to bill, cancel. */
export function QuotationModal({ open, quotationId, onClose, onChanged }) {
  const toast = useToast();
  const navigate = useNavigate();
  const [q, setQ] = useState(null);
  const [preview, setPreview] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState('');
  useEffect(() => {
    quotationsApi.get(quotationId).then(setQ).catch(toast.error);
  }, [quotationId, toast]);
  async function cancel() {
    try {
      setQ(await quotationsApi.cancel(q.id, reason));
      setCancelling(false);
      onChanged?.();
    } catch (e) {
      toast.error(e);
    }
  }
  const STATUS = {
    open: ['primary', 'Open'],
    expired: ['warning', 'Expired'],
    converted: ['success', 'Converted'],
    cancelled: ['danger', 'Cancelled'],
  };
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={q ? `Quotation ${q.quote_no}` : 'Quotation'}
      width="w-[46rem]"
      footer={
        q &&
        (cancelling ? (
          <>
            <Input
              autoFocus
              value={reason}
              placeholder="Reason"
              onChange={(e) => setReason(e.target.value)}
              className="mr-auto w-72"
            />
            <Button onClick={() => setCancelling(false)}>Back</Button>
            <Button variant="danger" disabled={!reason.trim()} onClick={cancel}>
              Cancel quotation
            </Button>
          </>
        ) : (
          <>
            {q.status === 'open' && (
              <Button
                variant="danger-ghost"
                icon={Ban}
                onClick={() => setCancelling(true)}
                className="mr-auto"
              >
                Cancel
              </Button>
            )}
            <Button icon={Printer} onClick={() => setPreview(true)}>
              Print / PDF
            </Button>
            {q.status === 'open' && (
              <Button
                variant="primary"
                icon={ReceiptText}
                onClick={() => navigate('/billing', { state: { quotation: q.id } })}
              >
                Convert to bill
              </Button>
            )}
          </>
        ))
      }
    >
      {!q ? (
        <Skeleton className="h-32" />
      ) : (
        <div className="space-y-3 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={STATUS[q.display_status][0]}>{STATUS[q.display_status][1]}</Badge>
            <span className="text-muted">
              {q.customer_name}
              {q.vehicle_no ? ` · ${q.vehicle_no}` : ''} · {formatDate(q.quote_date)} · valid till{' '}
              {formatDate(q.valid_till)}
            </span>
            {q.converted_sale && <Badge tone="success">Bill {q.converted_sale.invoice_no}</Badge>}
          </div>
          <ul className="divide-y divide-border rounded-xl border border-border">
            {q.items.map((it) => (
              <li key={it.id} className="flex justify-between gap-3 px-3 py-2">
                <span>
                  {it.fitting_for_item_id ? '↳ ' : ''}
                  {it.product_name}
                  <span className="text-muted">
                    {' '}
                    · {formatQty(it.qty_milli)} {it.unit} × {formatMoney(it.rate)}
                  </span>
                </span>
                <span className="tabular-nums">{formatMoney(it.line_total)}</span>
              </li>
            ))}
          </ul>
          <div className="flex justify-between text-base font-bold">
            <span>Total</span>
            <span className="tabular-nums">{formatMoney(q.grand_total)}</span>
          </div>
          {q.cancel_reason && <p className="text-danger">Cancelled: {q.cancel_reason}</p>}
          {q.audit.length > 0 && (
            <p className="text-xs text-muted">
              Last: {q.audit[0].summary} ({formatDateTime(q.audit[0].created_at)})
            </p>
          )}
        </div>
      )}
      {preview && q && (
        <PrintPreviewModal
          open
          kind="quotation"
          id={q.id}
          title={`Quotation ${q.quote_no}`}
          onClose={() => setPreview(false)}
        />
      )}
    </Modal>
  );
}
