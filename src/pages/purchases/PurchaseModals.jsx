import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Barcode, FileDown, Printer, Undo2 } from 'lucide-react';
import Button from '../../components/Button';
import { Modal } from '../../components/Overlay';
import { Field, Input, MoneyInput, Segmented, Select, Toggle } from '../../components/Field';
import { Badge } from '../../components/Feedback';
import SupplierPicker from '../../components/SupplierPicker';
import { useToast } from '../../components/Toast';
import { purchaseReturnsApi, purchasesApi } from '../../api/purchases';
import { serialsApi } from '../../api/products';
import { formatMoney, paiseToInput, parseMoney } from '../../utils/money';
import { formatQty, formatRateBp, parseQty } from '../../utils/qty';
import { todayISO } from '../../utils/dates';
import { ProductAdder } from './ItemGrid';

const MODES = { cash: 'Cash', upi: 'UPI', bank: 'Bank', cheque: 'Cheque' };

function PayFields({ value, onChange, errors = {}, prefix = '' }) {
  return (
    <div className="grid grid-cols-2 gap-3">
      <Field label="Mode">
        {(id) => (
          <Select
            id={id}
            value={value.mode}
            onChange={(e) => onChange({ ...value, mode: e.target.value })}
          >
            {Object.entries(MODES).map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </Select>
        )}
      </Field>
      {value.mode !== 'cash' && (
        <Field
          label={value.mode === 'cheque' ? 'Cheque no.' : 'Reference / UTR'}
          error={errors[`${prefix}ref_no`]}
        >
          {(id) => (
            <Input
              id={id}
              value={value.ref_no}
              maxLength={40}
              onChange={(e) => onChange({ ...value, ref_no: e.target.value })}
            />
          )}
        </Field>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- cancel

export function CancelPurchaseModal({ open, purchase, onClose, onDone }) {
  const toast = useToast();
  const [reason, setReason] = useState('');
  const [refund, setRefund] = useState(false);
  const paidCash = purchase.allocations
    .filter((a) => a.status === 'active' && a.source_type === 'payment')
    .reduce((s, a) => s + a.amount, 0);
  const [pay, setPay] = useState({ amount: paiseToInput(paidCash), mode: 'cash', ref_no: '' });
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const blocked = !purchase.can_cancel;

  async function submit() {
    setBusy(true);
    try {
      const r = refund
        ? { amount: parseMoney(pay.amount), mode: pay.mode, ref_no: pay.ref_no }
        : null;
      const p = await purchasesApi.cancel(purchase.id, reason, r);
      toast.success(`${p.entry_no} cancelled. Stock and the supplier ledger were reversed.`);
      onDone(p);
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
      title={`Cancel ${purchase.entry_no}`}
      width="w-[34rem]"
      footer={
        <>
          <Button onClick={onClose}>Keep it</Button>
          <Button variant="danger" disabled={busy || blocked || !reason.trim()} onClick={submit}>
            {busy ? 'Cancelling…' : 'Cancel purchase'}
          </Button>
        </>
      }
    >
      {blocked ? (
        <div className="space-y-2 text-sm">
          <p className="flex items-center gap-2 font-medium text-danger">
            <AlertTriangle size={16} /> This purchase cannot be cancelled:
          </p>
          <ul className="list-disc space-y-1 pl-6 text-muted">
            {purchase.lock_reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </div>
      ) : (
        <div className="space-y-4 text-sm">
          <p className="text-muted">
            Stock comes out, serial numbers from this bill are voided and the bill leaves the
            supplier ledger. The bill number can then be entered again.
          </p>
          <Field label="Reason" required error={errors.reason}>
            {(id) => (
              <Input
                id={id}
                autoFocus
                value={reason}
                maxLength={200}
                placeholder="e.g. entered twice / wrong supplier"
                onChange={(e) => setReason(e.target.value)}
              />
            )}
          </Field>
          {paidCash > 0 && (
            <div className="space-y-3 rounded-xl border border-border bg-surface-2/40 p-3">
              <p>
                <strong>{formatMoney(paidCash)}</strong> was paid against this bill. By default it
                stays with the supplier as an <strong>advance</strong>.
              </p>
              <Toggle
                label="Record refund received"
                description="The supplier gave the money back."
                checked={refund}
                onChange={setRefund}
              />
              {refund && (
                <>
                  <Field label="Amount refunded" error={errors['refund.amount']}>
                    {(id) => (
                      <MoneyInput
                        id={id}
                        value={pay.amount}
                        onChange={(e) => setPay({ ...pay, amount: e.target.value })}
                      />
                    )}
                  </Field>
                  <PayFields value={pay} onChange={setPay} errors={errors} prefix="refund." />
                </>
              )}
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------- payment

export function PaymentModal({ open, purchase, onClose, onDone }) {
  const toast = useToast();
  const [advance, setAdvance] = useState(0);
  const [form, setForm] = useState({
    amount: paiseToInput(purchase.due),
    mode: 'cash',
    ref_no: '',
    date: todayISO(),
  });
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    purchasesApi
      .supplierInfo(purchase.party_id, purchase.id)
      .then((r) => setAdvance(r.advance))
      .catch(() => {});
  }, [purchase.party_id, purchase.id]);

  async function submit() {
    setBusy(true);
    try {
      const p = await purchasesApi.recordPayment({
        id: purchase.id,
        amount: parseMoney(form.amount),
        mode: form.mode,
        ref_no: form.ref_no,
        date: form.date,
      });
      toast.success(form.mode === 'advance' ? 'Adjusted from advance.' : 'Payment recorded.');
      onDone(p);
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
      title={`Pay ${purchase.supplier_name}`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={busy} onClick={submit}>
            {busy ? 'Saving…' : 'Record payment'}
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-sm">
        <p className="text-muted">
          {purchase.entry_no} · due <strong className="text-fg">{formatMoney(purchase.due)}</strong>
        </p>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Amount" error={errors.amount}>
            {(id) => (
              <MoneyInput
                id={id}
                autoFocus
                value={form.amount}
                invalid={Boolean(errors.amount)}
                onChange={(e) => setForm({ ...form, amount: e.target.value })}
              />
            )}
          </Field>
          <Field label="Date" error={errors.date}>
            {(id) => (
              <Input
                id={id}
                type="date"
                value={form.date}
                onChange={(e) => setForm({ ...form, date: e.target.value })}
              />
            )}
          </Field>
          <Field label="Mode">
            {(id) => (
              <Select
                id={id}
                value={form.mode}
                onChange={(e) => setForm({ ...form, mode: e.target.value })}
              >
                {Object.entries(MODES).map(([k, l]) => (
                  <option key={k} value={k}>
                    {l}
                  </option>
                ))}
                {advance > 0 && (
                  <option value="advance">Adjust from advance ({formatMoney(advance)})</option>
                )}
              </Select>
            )}
          </Field>
          {form.mode !== 'cash' && form.mode !== 'advance' && (
            <Field
              label={form.mode === 'cheque' ? 'Cheque no.' : 'Reference / UTR'}
              error={errors.ref_no}
            >
              {(id) => (
                <Input
                  id={id}
                  value={form.ref_no}
                  maxLength={40}
                  onChange={(e) => setForm({ ...form, ref_no: e.target.value })}
                />
              )}
            </Field>
          )}
        </div>
        <p className="text-xs text-muted">
          Full payment screens with cash and bank books come with Accounts.
        </p>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- labels

export function LabelsModal({ open, purchase, onClose }) {
  const toast = useToast();
  const [size, setSize] = useState('a4');
  const [copies, setCopies] = useState(() =>
    Object.fromEntries(
      purchase.items.map((it) => [
        it.variant_id,
        String(Math.ceil((it.qty_milli + it.free_qty_milli) / 1000)),
      ]),
    ),
  );
  const [busy, setBusy] = useState(false);
  const items = Object.entries(copies)
    .map(([vid, n]) => ({ variant_id: Number(vid), copies: Number(n) || 0 }))
    .filter((x) => x.copies > 0);
  const total = items.reduce((s, x) => s + x.copies, 0);

  async function run(pdf) {
    setBusy(true);
    try {
      const r = await purchasesApi.printLabels(purchase.id, size, items, pdf);
      if (pdf && r.saved) toast.success(`Saved ${r.file_path}`);
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
      title="Print barcode labels"
      width="w-[38rem]"
      footer={
        <>
          <span className="mr-auto text-sm text-muted">
            {total} label{total === 1 ? '' : 's'}
          </span>
          <Button icon={FileDown} disabled={busy || total === 0} onClick={() => run(true)}>
            Save PDF
          </Button>
          <Button
            variant="primary"
            icon={Printer}
            disabled={busy || total === 0}
            onClick={() => run(false)}
          >
            Print
          </Button>
        </>
      }
    >
      <div className="space-y-4 text-sm">
        <Segmented
          layoutId="label-size"
          value={size}
          onChange={setSize}
          options={[
            { value: 'a4', label: 'A4 sheet (3 × 8)' },
            { value: 'thermal50x25', label: '50 × 25 mm thermal' },
          ]}
        />
        <p className="text-xs text-muted">
          Each label: product name, barcode (or SKU when there is none), SKU and MRP.
        </p>
        <ul className="divide-y divide-border rounded-xl border border-border">
          {purchase.items.map((it) => (
            <li key={it.id} className="flex items-center gap-3 px-3 py-2">
              <Barcode size={15} className="text-muted" />
              <span className="min-w-0 flex-1 truncate">
                {it.product_name}
                {it.variant_label ? ` · ${it.variant_label}` : ''}
                <span className="block text-xs text-muted">{it.current.barcode || it.sku}</span>
              </span>
              <Input
                className="h-8 w-20 text-right"
                inputMode="numeric"
                value={copies[it.variant_id] ?? ''}
                onChange={(e) =>
                  setCopies((c) => ({ ...c, [it.variant_id]: e.target.value.replace(/\D/g, '') }))
                }
              />
            </li>
          ))}
        </ul>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- return (debit note)

/**
 * From a purchase (`purchase` set): pick lines / serials, qty ≤ purchased − returned.
 * Standalone (`purchase` null): choose the supplier and items.
 * The credit amount per line defaults to the proportional value (free units included) and can
 * be changed to what the supplier agreed. Stock always leaves at the original cost.
 */
export function ReturnModal({ open, purchase = null, onClose, onDone }) {
  const toast = useToast();
  const [prep, setPrep] = useState(null);
  const [supplier, setSupplier] = useState(null);
  const [billType, setBillType] = useState('gst');
  const [lines, setLines] = useState([]); // { key, ...source, qty, serial_ids, credit (string|null), rate }
  const [settlement, setSettlement] = useState('adjust');
  const [refund, setRefund] = useState({ mode: 'cash', ref_no: '' });
  const [date, setDate] = useState(todayISO());
  const [reason, setReason] = useState('');
  const [calc, setCalc] = useState(null);
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const fromBill = Boolean(purchase);

  useEffect(() => {
    if (!purchase) return;
    purchaseReturnsApi
      .prepare(purchase.id)
      .then((p) => {
        setPrep(p);
        setLines(
          p.lines.map((l) => ({
            key: `i${l.purchase_item_id}`,
            ...l,
            qty: '',
            serial_ids: [],
            credit: null,
          })),
        );
      })
      .catch(toast.error);
  }, [purchase, toast]);

  const payload = useMemo(() => {
    const out = lines
      .map((l) => {
        const qty = l.track_serials ? l.serial_ids.length * 1000 : (parseQty(l.qty || '0') ?? 0);
        if (!qty) return null;
        const credit = l.credit == null || l.credit === '' ? null : parseMoney(l.credit);
        return {
          purchase_item_id: l.purchase_item_id,
          variant_id: l.variant_id,
          qty_milli: qty,
          serial_ids: l.serial_ids,
          taxable: credit,
          rate: fromBill ? undefined : parseMoney(l.rate || '0'),
          gst_rate_bp: l.gst_rate_bp,
        };
      })
      .filter(Boolean);
    return {
      purchase_id: purchase ? purchase.id : null,
      party_id: purchase ? purchase.party_id : (supplier?.id ?? null),
      bill_type: purchase ? purchase.bill_type : billType,
      date,
      reason,
      settlement,
      refund,
      lines: out,
    };
  }, [lines, purchase, supplier, billType, date, reason, settlement, refund, fromBill]);

  const key = JSON.stringify(payload.lines) + payload.party_id + payload.bill_type;
  useEffect(() => {
    if (payload.lines.length === 0 || !payload.party_id) return undefined;
    let cancelled = false;
    const t = setTimeout(() => {
      purchaseReturnsApi
        .calculate(payload)
        .then((r) => {
          if (cancelled) return;
          setCalc({ key, ...r });
          setErrors({});
        })
        .catch((e) => !cancelled && setErrors(e.fields || { lines: e.message }));
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const live = calc && calc.key === key ? calc : null;

  function setLine(i, patch) {
    setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  }

  async function addStandalone(row) {
    if (lines.some((l) => l.variant_id === row.variant_id)) return;
    const serials = row.track_serials
      ? await serialsApi.inStock(row.variant_id).catch(() => [])
      : null;
    setLines((ls) => [
      ...ls,
      {
        key: `v${row.variant_id}`,
        variant_id: row.variant_id,
        product_name: row.name,
        variant_label: row.variant_label,
        unit: row.unit,
        gst_rate_bp: row.gst_rate_bp,
        track_serials: Boolean(row.track_serials),
        serials: serials
          ? serials.map((s) => ({ ...s, status: 'in_stock', status_label: 'In stock' }))
          : null,
        returnable_milli: row.stock_milli,
        rate: paiseToInput(row.avg_cost || row.purchase_price || 0),
        qty: '',
        serial_ids: [],
        credit: null,
      },
    ]);
  }

  async function submit() {
    setBusy(true);
    try {
      const r = await purchaseReturnsApi.create(payload);
      toast.success(`Debit note ${r.return_no} saved (${formatMoney(r.total)}).`);
      onDone(r);
    } catch (e) {
      setErrors(e.fields || {});
      toast.error(e);
    } finally {
      setBusy(false);
    }
  }

  let k = -1; // index into payload.lines / live.lines for the rows that have a qty
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={
        fromBill ? `Purchase return from ${purchase.entry_no}` : 'Purchase return (debit note)'
      }
      width="w-[60rem]"
      footer={
        <>
          <span className="mr-auto text-sm">
            Credit{' '}
            <strong className="tabular-nums">{live ? formatMoney(live.totals.total) : '—'}</strong>
            {live && live.totals.tax_total > 0 && (
              <span className="text-muted">
                {' '}
                (GST {formatMoney(live.totals.tax_total)} reversed)
              </span>
            )}
          </span>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            icon={Undo2}
            disabled={busy || payload.lines.length === 0 || !payload.party_id}
            onClick={submit}
          >
            {busy ? 'Saving…' : 'Save debit note'}
          </Button>
        </>
      }
    >
      <div className="space-y-4 text-sm">
        {!fromBill && (
          <div className="grid grid-cols-[1fr_auto] items-end gap-3">
            <Field label="Supplier" required>
              {() => <SupplierPicker value={supplier} onChange={setSupplier} autoFocus />}
            </Field>
            <Segmented
              layoutId="ret-bill-type"
              value={billType}
              onChange={setBillType}
              options={[
                { value: 'gst', label: 'GST' },
                { value: 'non_gst', label: 'Non-GST' },
              ]}
            />
          </div>
        )}
        {!fromBill && (
          <ProductAdder
            onAdd={(row) => addStandalone(row)}
            onNewProduct={() => toast.info('Choose an existing product to return.')}
          />
        )}
        {fromBill && !prep && <p className="text-muted">Loading…</p>}
        {errors.lines && <p className="text-danger">{errors.lines}</p>}
        <div className="divide-y divide-border rounded-xl border border-border">
          {lines.map((l, i) => {
            const hasQty = l.track_serials
              ? l.serial_ids.length > 0
              : (parseQty(l.qty || '0') ?? 0) > 0;
            if (hasQty) k++;
            const c = hasQty && live ? live.lines[k] : null;
            const e = hasQty ? (f) => errors[`lines.${k}.${f}`] : () => null;
            return (
              <div key={l.key} className="space-y-2 px-3 py-2.5">
                <div className="grid grid-cols-[minmax(0,1fr)_6rem_8rem_8rem_6rem] items-center gap-3">
                  <div className="min-w-0">
                    <div className="truncate font-medium">
                      {l.product_name}
                      {l.variant_label ? (
                        <span className="font-normal text-muted"> · {l.variant_label}</span>
                      ) : null}
                    </div>
                    <div className="text-xs text-muted">
                      {fromBill ? (
                        <>
                          Bought {formatQty(l.qty_milli)}
                          {l.free_qty_milli ? ` + ${formatQty(l.free_qty_milli)} free` : ''} ·
                          returned {formatQty(l.returned_milli)} · can return{' '}
                          {formatQty(l.returnable_milli)} {l.unit} · {formatMoney(l.effective_rate)}
                          /unit
                        </>
                      ) : (
                        <>
                          In stock {formatQty(l.returnable_milli)} {l.unit}
                        </>
                      )}
                      {l.gst_rate_bp ? ` · GST ${formatRateBp(l.gst_rate_bp)}` : ''}
                    </div>
                  </div>
                  {l.track_serials ? (
                    <span className="text-right">{l.serial_ids.length} unit(s)</span>
                  ) : (
                    <Input
                      value={l.qty}
                      inputMode="decimal"
                      placeholder="Qty"
                      invalid={Boolean(e('qty_milli'))}
                      onChange={(ev) => setLine(i, { qty: ev.target.value, credit: null })}
                      className="h-8 text-right"
                    />
                  )}
                  {!fromBill ? (
                    <MoneyInput
                      value={l.rate}
                      placeholder="Rate"
                      onChange={(ev) => setLine(i, { rate: ev.target.value, credit: null })}
                    />
                  ) : (
                    <span />
                  )}
                  <MoneyInput
                    value={l.credit ?? (c ? paiseToInput(c.taxable) : '')}
                    placeholder="Credit"
                    title="Credit agreed with the supplier (before GST)"
                    disabled={!hasQty}
                    onChange={(ev) => setLine(i, { credit: ev.target.value })}
                  />
                  <span className="text-right font-semibold tabular-nums">
                    {c ? formatMoney(c.line_total) : '—'}
                  </span>
                </div>
                {hasQty && c && c.taxable !== c.default_taxable && (
                  <p className="text-xs text-warning">
                    Agreed credit differs from the bill value {formatMoney(c.default_taxable)}.
                    Stock still leaves at its original cost.
                  </p>
                )}
                {e('serial_ids') && <p className="text-xs text-danger">{e('serial_ids')}</p>}
                {e('qty_milli') && <p className="text-xs text-danger">{e('qty_milli')}</p>}
                {Boolean(l.track_serials) && l.serials && (
                  <div className="flex flex-wrap gap-1.5">
                    {l.serials.length === 0 && (
                      <span className="text-xs text-muted">
                        No units in stock / defective from this bill.
                      </span>
                    )}
                    {l.serials.map((s) => {
                      const on = l.serial_ids.includes(s.id);
                      return (
                        <button
                          key={s.id}
                          type="button"
                          onClick={() =>
                            setLine(i, {
                              serial_ids: on
                                ? l.serial_ids.filter((x) => x !== s.id)
                                : [...l.serial_ids, s.id],
                              credit: null,
                            })
                          }
                          className={`rounded-md border px-2 py-0.5 font-mono text-xs ${on ? 'border-primary bg-primary-soft text-primary' : 'border-border hover:bg-surface-2'}`}
                        >
                          {s.serial_no}
                          {s.status === 'defective' && (
                            <Badge tone="warning" className="ml-1">
                              defective
                            </Badge>
                          )}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
          {lines.length === 0 && !fromBill && (
            <p className="px-3 py-6 text-center text-muted">Add the items you are sending back.</p>
          )}
        </div>

        <div className="grid grid-cols-3 gap-3">
          <Field label="Date" error={errors.date}>
            {(id) => (
              <Input id={id} type="date" value={date} onChange={(ev) => setDate(ev.target.value)} />
            )}
          </Field>
          <Field label="Reason" className="col-span-2">
            {(id) => (
              <Input
                id={id}
                value={reason}
                maxLength={200}
                placeholder="e.g. damaged in transit"
                onChange={(ev) => setReason(ev.target.value)}
              />
            )}
          </Field>
        </div>
        <div className="space-y-3 rounded-xl border border-border bg-surface-2/40 p-3">
          <Segmented
            layoutId="ret-settlement"
            value={settlement}
            onChange={setSettlement}
            options={[
              {
                value: 'adjust',
                label: fromBill ? 'Reduce what we owe on this bill' : 'Reduce supplier payable',
              },
              { value: 'refund', label: 'Refund received' },
            ]}
          />
          {settlement === 'refund' && (
            <PayFields value={refund} onChange={setRefund} errors={errors} prefix="refund." />
          )}
        </div>
        {live && (
          <p className="text-xs text-muted">
            Taxable {formatMoney(live.totals.taxable_total)}
            {live.totals.cgst_total
              ? ` · CGST ${formatMoney(live.totals.cgst_total)} · SGST ${formatMoney(live.totals.sgst_total)}`
              : ''}
            {live.totals.igst_total ? ` · IGST ${formatMoney(live.totals.igst_total)}` : ''}
            {live.totals.round_off ? ` · round off ${formatMoney(live.totals.round_off)}` : ''}
          </p>
        )}
        <p className="text-xs text-muted">
          Units under a warranty claim go back to the supplier through the claim, not a purchase
          return.
        </p>
      </div>
    </Modal>
  );
}
