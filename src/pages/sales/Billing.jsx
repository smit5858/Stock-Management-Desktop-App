import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import {
  AlertTriangle,
  ArrowLeftRight,
  CheckCircle2,
  Eye,
  EyeOff,
  FileText,
  IdCard,
  List,
  PauseCircle,
  Plus,
  Printer,
  ReceiptText,
  Save,
  Trash2,
  Undo2,
  X,
} from 'lucide-react';
import Button from '../../components/Button';
import { Field, Input, MoneyInput, Segmented, Select } from '../../components/Field';
import { Badge, Kbd, Skeleton } from '../../components/Feedback';
import { anyOverlayOpen } from '../../components/Overlay';
import ConfirmDialog from '../../components/ConfirmDialog';
import CustomerPicker from '../../components/CustomerPicker';
import { useToast } from '../../components/Toast';
import { useHotkeys } from '../../hooks/useHotkeys';
import { partiesApi } from '../../api/parties';
import { quotationsApi, saleDraftsApi, saleReturnsApi, salesApi } from '../../api/sales';
import { claimsApi } from '../../api/warranty';
import { SLIP_FORMATS, cardPrinter } from '../warranty/shared';
import { formatMoney, paiseToInput, parseMoney } from '../../utils/money';
import { formatRateBp, parseQty } from '../../utils/qty';
import { todayISO } from '../../utils/dates';
import { VehicleModal } from '../parties/VehicleModals';
import { ItemSearch, LinesGrid, SerialPickerModal } from './BillLines';
import { PrintPreviewModal, SaleReturnModal } from './SaleModals';
import {
  MAX_TABS,
  advanceValue,
  calcPayload,
  emptyForm,
  fittingLine,
  fromDraft,
  fromPrefill,
  issuesByUid,
  lineFromRow,
  qtyToInput,
  resolvePayments,
  tabStore,
  toDraft,
  toPayload,
  uid,
} from './billForm';

const MODES = { cash: 'Cash', upi: 'UPI', card: 'Card', bank: 'Bank', cheque: 'Cheque' };

function Panel({ title, right, children, className = '' }) {
  return (
    <section className={`rounded-2xl border border-border bg-surface p-3 shadow-sm ${className}`}>
      {title && (
        <div className="mb-2 flex items-center gap-2">
          <h2 className="text-xs font-semibold tracking-wide text-muted uppercase">{title}</h2>
          <div className="ml-auto">{right}</div>
        </div>
      )}
      {children}
    </section>
  );
}

function Row({ label, value, strong, muted, children }) {
  return (
    <div
      className={`flex items-center justify-between gap-3 py-0.5 ${strong ? 'text-base font-bold' : ''} ${muted ? 'text-muted' : ''}`}
    >
      <span>{label}</span>
      {children || <span className="tabular-nums">{value}</span>}
    </div>
  );
}

function tabLabel(f) {
  if (f.saved) return f.saved.number;
  const who =
    f.party?.customer?.name ||
    f.customer_name ||
    (f.kind === 'quotation' ? 'Quotation' : 'New bill');
  return who;
}

/**
 * The billing screen: up to 5 bill tabs (customers waiting), lines on the left, totals and
 * payment on the right. Keyboard-first:
 * F3 item search · F5 customer · F4 GST / non-GST · F8 payment · Ctrl+S save · Ctrl+P save &
 * print · Ctrl+N new bill · Ctrl+Enter add line · Ctrl+Delete remove line · Ctrl+M margin.
 */
export default function Billing() {
  const toast = useToast();
  const navigate = useNavigate();
  const location = useLocation();
  const [meta, setMeta] = useState(null);
  const [tabs, setTabs] = useState(() => tabStore.get()?.tabs || null);
  const [active, setActive] = useState(() => tabStore.get()?.active || null);
  const [calc, setCalc] = useState(null);
  const [info, setInfo] = useState(null); // customer info of the active tab
  const [errors, setErrors] = useState({});
  const [issues, setIssues] = useState({});
  const [serialFor, setSerialFor] = useState(null); // { uid, removeIfEmpty }
  const [confirm, setConfirm] = useState(null); // { code, message, print } | { close: key }
  const [preview, setPreview] = useState(null);
  const [vehicleModal, setVehicleModal] = useState(null);
  const [returnModal, setReturnModal] = useState(false);
  const [showMargin, setShowMargin] = useState(false);
  const [saving, setSaving] = useState(false);
  const [seq, setSeq] = useState(0);
  const searchRef = useRef(null);
  const payRef = useRef(null);
  const customerRef = useRef(null);

  // ------------------------------------------------------------ load + tabs
  useEffect(() => {
    salesApi
      .meta()
      .then((m) => {
        setMeta(m);
        setTabs((t) => {
          if (t && t.length) return t;
          const f = emptyForm(m);
          setActive(f.key);
          return [f];
        });
      })
      .catch(toast.error);
  }, [toast]);

  useEffect(() => {
    if (tabs) tabStore.set({ tabs, active });
  }, [tabs, active]);

  const form = tabs?.find((t) => t.key === active) || tabs?.[0] || null;

  const update = useCallback(
    (patch) => {
      setTabs((list) =>
        list.map((t) =>
          t.key === (form ? form.key : null)
            ? { ...t, ...(typeof patch === 'function' ? patch(t) : patch), dirty: true }
            : t,
        ),
      );
    },
    [form],
  );

  const openTab = useCallback(
    (f) => {
      if (tabs && tabs.filter((t) => !t.saved).length >= MAX_TABS) {
        toast.error(`At most ${MAX_TABS} open bills. Save or hold one first.`);
        return false;
      }
      setTabs((list) => [...(list || []).filter((t) => !(t.saved && t.key !== f.key)), f]);
      setActive(f.key);
      setErrors({});
      return true;
    },
    [tabs, toast],
  );

  function closeTab(key) {
    setTabs((list) => {
      const rest = list.filter((t) => t.key !== key);
      if (rest.length === 0) {
        const f = emptyForm(meta);
        setActive(f.key);
        return [f];
      }
      if (key === active) setActive(rest[rest.length - 1].key);
      return rest;
    });
  }

  function newBill(kind = 'bill') {
    if (form && (form.saved || (!form.dirty && form.lines.length === 0))) {
      const f = emptyForm(meta, kind);
      setTabs((list) => list.map((t) => (t.key === form.key ? f : t)));
      setActive(f.key);
      setErrors({});
      setTimeout(() => searchRef.current?.focus(), 30);
      return;
    }
    if (openTab(emptyForm(meta, kind))) setTimeout(() => searchRef.current?.focus(), 30);
  }

  // Deep links: { reissue, quotation, draft, exchange, customer }.
  const handled = useRef(null);
  useEffect(() => {
    const st = location.state;
    if (!meta || !tabs || !st || handled.current === location.key) return;
    handled.current = location.key;
    navigate(location.pathname, { replace: true, state: null });
    (async () => {
      try {
        if (st.reissue || st.quotation) {
          const pre = await salesApi.prefill(
            st.reissue ? { sale_id: st.reissue } : { quotation_id: st.quotation },
          );
          const party = await summaryOrNull(pre.party_id, meta);
          const f = fromPrefill(meta, pre, party);
          if (st.reissue) {
            f.reissue_of_id = st.reissue;
            // Money received on the cancelled bill became advance: use it on the new one.
            if (party) {
              const [old, cinfo] = await Promise.all([
                salesApi.get(st.reissue),
                salesApi.customerInfo(party.customer.id),
              ]);
              const use = Math.min(cinfo.advance, old.grand_total);
              if (use > 0) {
                f.use_advance = true;
                f.advance_amount = paiseToInput(use);
              }
            }
          } else f.quotation_id = st.quotation;
          f.dirty = true;
          if (openTab(f)) {
            setIssues(issuesByUid(f, Object.fromEntries(pre.lines.map((l, i) => [i, l.issues]))));
            toast.info(`Copied from ${pre.source.no}. Check the lines and save.`);
          }
        } else if (st.claim) {
          // Chargeable warranty repair: parts + repair charge from the claim.
          const pre = await claimsApi.billPrefill(st.claim);
          const party = await summaryOrNull(pre.party_id, meta);
          const f = fromPrefill(meta, pre, party);
          f.claim_id = st.claim;
          f.dirty = true;
          if (openTab(f)) {
            setIssues(issuesByUid(f, Object.fromEntries(pre.lines.map((l, i) => [i, l.issues]))));
            toast.info(
              pre.no_labour_service
                ? `Bill for ${pre.source.no}. Add a repair / labour service line and save.`
                : `Bill for ${pre.source.no}. Check the lines and save.`,
            );
          }
        } else if (st.draft) {
          const d = await saleDraftsApi.get(st.draft);
          const party = d.customer_issue ? null : await summaryOrNull(d.form.party_id, meta);
          const f = fromDraft(meta, d.form, party);
          f.draft_id = d.id;
          if (openTab(f)) {
            setIssues(issuesByUid(f, d.issues));
            if (Object.keys(d.issues).length || d.customer_issue) {
              toast.error(d.customer_issue || 'Some lines of this held bill need attention.');
            }
          }
        } else if (st.exchange) {
          const x = st.exchange;
          const f = emptyForm(meta);
          f.exchange = x;
          f.party = x.customer.is_cash
            ? null
            : { customer: await partiesApi.summary(x.customer.id), vehicle: null };
          f.payments = [{ uid: uid(), mode: 'cash', amount: '', ref_no: '', auto: true }];
          f.dirty = true;
          openTab(f);
        } else if (st.customer) {
          const f = emptyForm(meta, st.kind === 'quotation' ? 'quotation' : 'bill');
          f.party = { customer: await partiesApi.summary(st.customer), vehicle: null };
          openTab(f);
        } else if (st.kind === 'quotation') {
          newBill('quotation');
        }
      } catch (e) {
        toast.error(e);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meta, tabs, location.key]);

  // ------------------------------------------------------------ customer info
  const partyKey = form ? (form.party?.customer?.id ?? meta?.cash_customer_id ?? null) : null;
  useEffect(() => {
    if (!partyKey) return undefined;
    let cancelled = false;
    salesApi
      .customerInfo(partyKey)
      .then((r) => !cancelled && setInfo(r))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [partyKey]);
  const custInfo = info && info.id === partyKey ? info : null;

  // Vehicle on the bill: chosen, else the one matched by plate, else the primary one (unless
  // "No vehicle" was chosen).
  const vehicleId = (() => {
    if (!form || !form.party) return null;
    if (form.vehicle_id !== null || form.vehicle_none) return form.vehicle_id;
    if (form.party.vehicle?.id) return form.party.vehicle.id;
    const primary = custInfo?.vehicles.find((v) => v.is_primary) || custInfo?.vehicles[0];
    return primary ? primary.id : null;
  })();

  const vehicle = custInfo?.vehicles.find((v) => v.id === vehicleId) || null;
  const vehicleName = vehicle
    ? [vehicle.make, vehicle.model].filter(Boolean).join(' ') || vehicle.display
    : '';

  // ------------------------------------------------------------ live calculation
  const calcKey = form && meta && !form.saved ? JSON.stringify(calcPayload(form, meta)) : null;
  useEffect(() => {
    if (!calcKey) return undefined;
    let cancelled = false;
    const t = setTimeout(() => {
      salesApi
        .calculate(JSON.parse(calcKey))
        .then((r) => !cancelled && setCalc({ key: calcKey, ...r }))
        .catch(() => {});
    }, 60);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [calcKey]);
  const live = calc && calc.key === calcKey ? calc : null;
  const shownCalc =
    live || (calc && form && calc.lines?.length === form.lines.length ? calc : null);

  const grand = shownCalc?.totals.grand_total ?? 0;
  const credit = form?.exchange ? form.exchange.credit : 0;
  const advance = form ? advanceValue(form) : 0;
  const payable = Math.max(grand - advance - Math.min(credit, grand), 0);
  const payments = form && form.kind === 'bill' ? resolvePayments(form, payable) : [];
  const paidNow = payments.reduce((s, p) => s + (parseMoney(p.amount || '0') ?? 0), 0);
  const due = Math.max(payable - paidNow, 0);
  const over = paidNow > payable;
  const cashPaid = payments
    .filter((p) => p.mode === 'cash')
    .reduce((s, p) => s + (parseMoney(p.amount || '0') ?? 0), 0);
  const tendered = form?.tendered ? parseMoney(form.tendered) : null;
  const change = tendered != null && tendered > cashPaid ? tendered - cashPaid : 0;
  const exchangeRefund = credit > grand ? credit - grand : 0;

  // ------------------------------------------------------------ lines
  const setLine = useCallback(
    (i, patch) =>
      update((f) => ({ lines: f.lines.map((l, j) => (j === i ? { ...l, ...patch } : l)) })),
    [update],
  );

  function focusQty(index) {
    setTimeout(() => {
      const el = document.querySelector(`[data-cell="${index}:qty"]`);
      el?.focus();
      el?.select();
    }, 30);
  }

  function addRow(row, { scanned }) {
    const gstRates = meta.gst_rates.map((r) => r.rate_bp);
    // Scanning a serial: add that unit (to an existing line of the same item if there is one).
    if (row.serial) {
      const at = form.lines.findIndex((l) => l.variant_id === row.variant_id && !l.fitting_for);
      if (at >= 0) {
        const l = form.lines[at];
        if (l.serials.some((s) => s.id === row.serial.id)) {
          toast.info(`${row.serial.serial_no} is already on this bill.`);
          return;
        }
        const serialsNext = [...l.serials, row.serial];
        setLine(at, { serials: serialsNext, qty: String(serialsNext.length) });
        toast.info(`${row.name}: ${serialsNext.length} unit(s)`);
        return;
      }
      const line = {
        ...lineFromRow(row, form, { discountBp: custInfo?.default_discount_bp || 0, gstRates }),
        serials: [row.serial],
      };
      appendLine(line, row, scanned);
      return;
    }
    // Same barcode again: one more of that item.
    const existing = form.lines.findIndex((l) => l.variant_id === row.variant_id && !l.fitting_for);
    if (existing >= 0 && !row.track_serials && scanned) {
      const l = form.lines[existing];
      const qty = (parseQty(l.qty) ?? 0) + 1000;
      setLine(existing, { qty: qtyToInput(qty) });
      toast.info(`${row.name}: quantity ${qtyToInput(qty)}`);
      return;
    }
    const line = lineFromRow(row, form, {
      discountBp: custInfo?.default_discount_bp || 0,
      gstRates,
    });
    appendLine(line, row, scanned);
  }

  function appendLine(line, row, scanned) {
    const extra =
      row.fitting && line.item_type === 'goods' ? [fittingLine(line, row.fitting, form)] : [];
    const index = form.lines.length;
    update((f) => ({ lines: [...f.lines, line, ...extra] }));
    if (line.track_serials && line.serials.length === 0) {
      setSeq((n) => n + 1);
      setSerialFor({ uid: line.uid, removeIfEmpty: true });
    } else if (!scanned) focusQty(index);
  }

  function removeLine(i) {
    const l = form.lines[i];
    if (!l) return;
    update((f) => ({ lines: f.lines.filter((x) => x.uid !== l.uid && x.fitting_for !== l.uid) }));
    setErrors({});
  }

  function toggleFitting(i) {
    const l = form.lines[i];
    const child = form.lines.find((x) => x.fitting_for === l.uid);
    if (child) {
      update((f) => ({
        lines: f.lines
          .filter((x) => x.uid !== child.uid)
          .map((x) =>
            x.uid === l.uid
              ? { ...x, fitting_template: x.fitting_template || templateOf(child) }
              : x,
          ),
      }));
    } else if (l.fitting_template) {
      const fl = fittingLine(l, l.fitting_template, form);
      update((f) => {
        const at = f.lines.findIndex((x) => x.uid === l.uid);
        const next = [...f.lines];
        next.splice(at + 1, 0, fl);
        return { lines: next };
      });
    }
  }

  // ------------------------------------------------------------ save
  async function save({ print = false, confirmDate = false, confirmCredit = false } = {}) {
    if (saving || !form || form.saved) return;
    const resolved = { ...form, payments, vehicle_id: vehicleId };
    const { payload, errors: local } = toPayload(resolved, meta);
    if (Object.keys(local).length) {
      setErrors(local);
      toast.error(`Please check: ${Object.values(local)[0]}`);
      return;
    }
    const unpicked = form.lines.findIndex((l) => l.track_serials && l.serials.length === 0);
    if (form.kind === 'bill' && unpicked >= 0) {
      toast.error(`Pick the serial numbers for ${form.lines[unpicked].name}.`);
      return;
    }
    if (form.kind === 'bill' && over) {
      toast.error('Payments are more than the amount to pay.');
      return;
    }
    if (form.kind === 'bill' && due > 0 && !form.party) {
      toast.error(
        `${formatMoney(due)} unpaid: credit needs a customer (F5), or take full payment.`,
      );
      return;
    }
    setSaving(true);
    const body = { ...payload, confirm_date: confirmDate, confirm_credit: confirmCredit };
    try {
      let saved;
      if (form.kind === 'quotation') {
        const q = await quotationsApi.create(body);
        saved = { kind: 'quotation', id: q.id, number: q.quote_no, total: q.grand_total };
      } else if (form.exchange) {
        const ret = {
          ...form.exchange.sale_return,
          refund: exchangeRefund > 0 ? { mode: form.refund_mode || 'cash' } : null,
        };
        const r = await saleReturnsApi.exchange(ret, body);
        saved = {
          kind: 'sale',
          id: r.sale.id,
          number: r.sale.invoice_no,
          total: r.sale.grand_total,
          due: r.sale.due,
          change,
          note: `Credit note ${r.sale_return.return_no}`,
        };
      } else {
        const s = await salesApi.create(body);
        saved = {
          kind: 'sale',
          id: s.id,
          number: s.invoice_no,
          total: s.grand_total,
          due: s.due,
          change,
          has_warranty: s.items.some((it) => it.warranty_end),
          note: form.claim_id ? 'Linked to the warranty claim' : undefined,
        };
      }
      update({ saved, dirty: false });
      setErrors({});
      setIssues({});
      toast.success(
        `Saved ${saved.number} · ${formatMoney(saved.total)}${saved.change ? ` · return ${formatMoney(saved.change)}` : ''}`,
      );
      if (print && saved.kind === 'sale') {
        salesApi.print(saved.id, meta.print_format).catch(toast.error);
      } else if (print) {
        setPreview({ kind: 'quotation', id: saved.id });
      }
    } catch (e) {
      if (e.code === 'DATE_CONFIRM' || e.code === 'CREDIT_LIMIT') {
        setConfirm({ code: e.code, message: e.message, print, confirmDate, confirmCredit });
      } else {
        setErrors(e.fields || {});
        toast.error(e);
      }
    } finally {
      setSaving(false);
    }
  }

  async function hold() {
    if (!form || form.saved) return;
    if (form.lines.length === 0) {
      toast.info('Nothing to hold yet.');
      return;
    }
    if (form.exchange) {
      toast.error('An exchange cannot be held. Finish or close it.');
      return;
    }
    try {
      await saleDraftsApi.save(form.draft_id, toDraft(form, grand));
      toast.success(`Held: ${tabLabel(form)}. Resume it from Sales → Held.`);
      closeTab(form.key);
    } catch (e) {
      toast.error(e);
    }
  }

  // ------------------------------------------------------------ keyboard
  const overlayOpen = Boolean(serialFor || confirm || preview || vehicleModal || returnModal);
  useHotkeys(
    {
      F3: () => searchRef.current?.focus(),
      F5: () => customerRef.current?.querySelector('input')?.focus(),
      F4: () => {
        if (!form || form.saved || meta.composition_dealer) return;
        update({ bill_type: form.bill_type === 'gst' ? 'non_gst' : 'gst' });
      },
      F8: () => {
        const el = payRef.current?.querySelector('input');
        el?.focus();
        el?.select?.();
      },
      'Ctrl+S': () => save(),
      'Ctrl+P': () =>
        form?.saved
          ? form.saved.kind === 'sale' &&
            salesApi.print(form.saved.id, meta.print_format).catch(toast.error)
          : save({ print: true }),
      'Ctrl+N': () => newBill(),
      'Ctrl+Enter': () => searchRef.current?.focus(),
      'Ctrl+M': () => setShowMargin((v) => !v),
      'Ctrl+H': () => hold(),
    },
    { enabled: Boolean(form && meta) && !overlayOpen },
  );
  useEffect(() => {
    const onKey = (e) => {
      if (
        e.key === 'Escape' &&
        !anyOverlayOpen() &&
        payRef.current?.contains(document.activeElement)
      ) {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const taxLabel = useMemo(() => {
    if (!form || form.bill_type !== 'gst') return null;
    if (!meta?.business_state_code) return 'CGST + SGST (set your state in Settings)';
    return shownCalc?.is_interstate ? 'IGST · other state' : 'CGST + SGST';
  }, [form, meta, shownCalc]);

  if (!meta || !form) {
    return (
      <div className="space-y-3 p-4">
        <Skeleton className="h-10" />
        <Skeleton className="h-[70vh]" />
      </div>
    );
  }

  const t = shownCalc?.totals;
  const backDays = form.date ? daysFrom(form.date, todayISO()) : 0;
  const dateWarn =
    form.date > todayISO()
      ? 'future date'
      : backDays > meta.backdate_warn_days
        ? `${backDays} days back`
        : null;
  const serialLine = serialFor ? form.lines.find((l) => l.uid === serialFor.uid) : null;
  const bal = custInfo?.balance ?? 0;
  const creditUsed = custInfo && custInfo.credit_limit != null ? bal + due : null;
  const quotation = form.kind === 'quotation';

  return (
    <div className="flex h-[calc(100vh-6rem)] min-h-[36rem] flex-col gap-2 p-3 pt-2">
      {/* Bill tabs */}
      <div className="flex items-center gap-1.5">
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {tabs.map((tb) => (
            <div
              key={tb.key}
              className={`group flex max-w-52 shrink-0 items-center gap-1.5 rounded-lg border px-2.5 py-1 text-sm ${tb.key === form.key ? 'border-primary bg-primary-soft text-primary' : 'border-border bg-surface text-muted hover:text-fg'}`}
            >
              <button
                type="button"
                className="flex min-w-0 items-center gap-1.5"
                onClick={() => {
                  setActive(tb.key);
                  setErrors({});
                }}
              >
                {tb.saved ? (
                  <CheckCircle2 size={13} className="text-success" />
                ) : tb.kind === 'quotation' ? (
                  <FileText size={13} />
                ) : tb.exchange ? (
                  <ArrowLeftRight size={13} />
                ) : (
                  <ReceiptText size={13} />
                )}
                <span className="truncate">{tabLabel(tb)}</span>
              </button>
              <button
                type="button"
                title="Close"
                className="rounded p-0.5 opacity-60 hover:bg-surface-2 hover:opacity-100"
                onClick={() =>
                  tb.dirty && !tb.saved && tb.lines.length
                    ? setConfirm({ close: tb.key })
                    : closeTab(tb.key)
                }
              >
                <X size={12} />
              </button>
            </div>
          ))}
          <Button
            size="icon-sm"
            variant="ghost"
            icon={Plus}
            title="New bill tab (Ctrl+N)"
            onClick={() =>
              openTab(emptyForm(meta)) && setTimeout(() => searchRef.current?.focus(), 30)
            }
          />
        </div>
        <Button size="sm" variant="ghost" icon={Undo2} onClick={() => setReturnModal(true)}>
          Return / exchange
        </Button>
        <Button size="sm" variant="ghost" icon={List} onClick={() => navigate('/sales')}>
          Sales list
        </Button>
      </div>

      {form.saved ? (
        <SavedCard
          saved={form.saved}
          meta={meta}
          onPreview={() => setPreview({ kind: form.saved.kind, id: form.saved.id })}
          onCard={() => setPreview({ kind: 'card', id: form.saved.id })}
          onNew={() => newBill()}
          onOpen={() =>
            navigate(
              form.saved.kind === 'quotation'
                ? `/sales?tab=quotations&open=${form.saved.id}`
                : `/sales?open=${form.saved.id}`,
            )
          }
        />
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_19.5rem] gap-3 2xl:grid-cols-[minmax(0,1fr)_24rem]">
          {/* Left: header + lines */}
          <div className="flex min-h-0 flex-col gap-2">
            <Panel>
              <div className="flex flex-wrap items-center gap-2">
                <Segmented
                  layoutId="bill-kind"
                  value={form.kind}
                  onChange={(v) => !form.exchange && update({ kind: v })}
                  options={[
                    { value: 'bill', label: 'Bill' },
                    { value: 'quotation', label: 'Quotation' },
                  ]}
                />
                {meta.composition_dealer ? (
                  <Badge>Bill of Supply (composition)</Badge>
                ) : (
                  <Segmented
                    layoutId="bill-type"
                    value={form.bill_type}
                    onChange={(v) => update({ bill_type: v })}
                    options={[
                      { value: 'gst', label: 'GST Invoice' },
                      { value: 'non_gst', label: meta.non_gst_bill_title },
                    ]}
                  />
                )}
                <Kbd>F4</Kbd>
                {form.bill_type === 'gst' && (
                  <Select
                    value={form.price_mode}
                    onChange={(e) => update({ price_mode: e.target.value })}
                    className="h-8 w-32! text-sm"
                  >
                    <option value="exclusive">Excl. GST</option>
                    <option value="inclusive">Incl. GST</option>
                  </Select>
                )}
                {taxLabel && <Badge tone="primary">{taxLabel}</Badge>}
                <div className="ml-auto flex items-center gap-2">
                  <Badge tone="neutral">
                    {quotation
                      ? meta.next_numbers.quotation
                      : form.bill_type === 'gst'
                        ? meta.next_numbers.gst
                        : meta.next_numbers.non_gst}{' '}
                    (on save)
                  </Badge>
                  <Input
                    type="date"
                    value={form.date}
                    onChange={(e) => update({ date: e.target.value })}
                    className={`h-8 w-36 text-sm ${dateWarn ? 'border-warning' : ''}`}
                    title="Bill date"
                  />
                  {dateWarn && (
                    <Badge tone="warning">
                      <AlertTriangle size={11} /> {dateWarn}
                    </Badge>
                  )}
                  {quotation && (
                    <label className="flex items-center gap-1 text-xs text-muted">
                      valid till
                      <Input
                        type="date"
                        value={form.valid_till}
                        onChange={(e) => update({ valid_till: e.target.value })}
                        className="h-8 w-36 text-sm"
                      />
                    </label>
                  )}
                </div>
              </div>
              <div className="mt-2 grid grid-cols-12 items-start gap-2">
                <div className="col-span-12 xl:col-span-6" ref={customerRef}>
                  {form.exchange ? (
                    <div className="flex items-center gap-2 rounded-xl border border-primary/40 bg-primary-soft/40 px-3 py-2 text-sm">
                      <ArrowLeftRight size={15} className="text-primary" />
                      Exchange for <strong>{form.exchange.customer.name}</strong> · credit{' '}
                      {formatMoney(form.exchange.credit)} from {form.exchange.label}
                    </div>
                  ) : (
                    <CustomerPicker
                      value={form.party}
                      placeholder="Customer: phone, vehicle no. or name (F5) · empty = Cash Customer"
                      onChange={(v) =>
                        update({
                          party: v,
                          vehicle_id: v?.vehicle?.id ?? null,
                          vehicle_none: false,
                          use_advance: false,
                          advance_amount: '',
                        })
                      }
                    />
                  )}
                  {!form.party && !form.exchange && (
                    <div className="mt-1.5 grid grid-cols-2 gap-2">
                      <Input
                        value={form.customer_name}
                        maxLength={120}
                        placeholder="Cash Customer: name (optional, printed)"
                        onChange={(e) => update({ customer_name: e.target.value })}
                        className="h-8 text-sm"
                      />
                      <Input
                        value={form.customer_phone}
                        maxLength={20}
                        placeholder="Phone (optional)"
                        onChange={(e) => update({ customer_phone: e.target.value })}
                        className="h-8 text-sm"
                      />
                    </div>
                  )}
                </div>
                <div className="col-span-6 xl:col-span-3">
                  {form.party ? (
                    <Select
                      value={vehicleId ?? ''}
                      onChange={(e) => {
                        if (e.target.value === 'add') {
                          setSeq((n) => n + 1);
                          partiesApi
                            .meta()
                            .then((m) => setVehicleModal({ models: m.vehicle_models }))
                            .catch(toast.error);
                        } else
                          update({
                            vehicle_id: e.target.value ? Number(e.target.value) : null,
                            vehicle_none: !e.target.value,
                          });
                      }}
                      className="h-9 text-sm"
                    >
                      <option value="">No vehicle</option>
                      {(custInfo?.vehicles || []).map((v) => (
                        <option key={v.id} value={v.id}>
                          {v.display}
                          {v.make ? ` · ${v.make} ${v.model}` : ''}
                        </option>
                      ))}
                      <option value="add">+ Add vehicle…</option>
                    </Select>
                  ) : (
                    <div className="flex h-9 items-center text-xs text-muted">
                      Vehicle: choose a customer
                    </div>
                  )}
                </div>
                <div className="col-span-6 flex flex-wrap items-center gap-1.5 text-xs xl:col-span-3">
                  {custInfo && !custInfo.is_cash && (
                    <>
                      {bal > 0 && <Badge tone="warning">Pending {formatMoney(bal)}</Badge>}
                      {bal < 0 && <Badge tone="success">Advance {formatMoney(-bal)}</Badge>}
                      {bal === 0 && <Badge>No balance</Badge>}
                      {custInfo.credit_limit != null && (
                        <Badge tone={creditUsed > custInfo.credit_limit ? 'danger' : 'neutral'}>
                          Limit {formatMoney(custInfo.credit_limit)}
                        </Badge>
                      )}
                      {custInfo.default_discount_bp > 0 && (
                        <Badge tone="primary">
                          {custInfo.type_name} −{formatRateBp(custInfo.default_discount_bp)}
                        </Badge>
                      )}
                    </>
                  )}
                </div>
              </div>
            </Panel>

            <Panel className="flex min-h-0 flex-1 flex-col">
              <div className="mb-2 flex items-center gap-2">
                <div className="flex-1">
                  <ItemSearch
                    inputRef={searchRef}
                    vehicleId={vehicleId}
                    vehicleName={vehicleName}
                    onAdd={addRow}
                  />
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  icon={showMargin ? EyeOff : Eye}
                  title="Margin preview (Ctrl+M)"
                  onClick={() => setShowMargin((v) => !v)}
                >
                  <Kbd>Ctrl+M</Kbd>
                </Button>
              </div>
              {errors.items && <p className="mb-1 text-xs text-danger">{errors.items}</p>}
              <div className="min-h-0 flex-1 overflow-auto">
                <LinesGrid
                  form={form}
                  calc={shownCalc}
                  gstRates={meta.gst_rates}
                  errors={errors}
                  issues={issues}
                  showMargin={showMargin}
                  onLineChange={(i, patch) => {
                    setLine(i, patch);
                    setErrors((e) =>
                      Object.keys(e).some((k) => k.startsWith(`items.${i}.`)) ? {} : e,
                    );
                  }}
                  onRemove={removeLine}
                  onSerials={(i) => {
                    setSeq((n) => n + 1);
                    setSerialFor({ uid: form.lines[i].uid, removeIfEmpty: false });
                  }}
                  onToggleFitting={toggleFitting}
                  onFocusSearch={() => searchRef.current?.focus()}
                />
              </div>
              <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 border-t border-border pt-1.5 text-[11px] text-muted">
                <span>
                  <Kbd>F3</Kbd> item
                </span>
                <span>
                  <Kbd>F5</Kbd> customer
                </span>
                <span>
                  <Kbd>F8</Kbd> payment
                </span>
                <span>
                  <Kbd>Enter</Kbd> next cell
                </span>
                <span>
                  <Kbd>Ctrl+Del</Kbd> remove
                </span>
                <span>
                  <Kbd>Ctrl+S</Kbd> save
                </span>
                <span>
                  <Kbd>Ctrl+P</Kbd> save &amp; print
                </span>
                <span>
                  <Kbd>Ctrl+H</Kbd> hold
                </span>
              </div>
            </Panel>
          </div>

          {/* Right: totals + payment */}
          <div className="flex min-h-0 flex-col gap-2">
            <div className="min-h-0 flex-1 space-y-2 overflow-auto">
              <Panel title="Totals">
                {!t ? (
                  <Skeleton className="h-32" />
                ) : (
                  <div className="text-sm">
                    <Row label="Sub total" value={formatMoney(t.sub_total)} />
                    {t.item_discount_total > 0 && (
                      <Row
                        label="Line discounts"
                        value={`-${formatMoney(t.item_discount_total)}`}
                        muted
                      />
                    )}
                    <Row label="Discount">
                      <span className="flex items-center gap-1">
                        <Input
                          value={form.bill_disc}
                          placeholder="0"
                          inputMode="decimal"
                          invalid={Boolean(errors.bill_discount)}
                          onChange={(e) => update({ bill_disc: e.target.value })}
                          className="h-7 w-16 text-right tabular-nums"
                        />
                        <button
                          type="button"
                          onClick={() =>
                            update({
                              bill_disc_mode: form.bill_disc_mode === 'pct' ? 'amt' : 'pct',
                              bill_disc: '',
                            })
                          }
                          className="h-7 w-7 rounded-md border border-border bg-surface-2 text-xs font-semibold text-muted"
                        >
                          {form.bill_disc_mode === 'pct' ? '%' : '₹'}
                        </button>
                        {t.bill_discount > 0 && (
                          <span className="w-20 text-right tabular-nums text-muted">
                            -{formatMoney(t.bill_discount)}
                          </span>
                        )}
                      </span>
                    </Row>
                    {form.bill_type === 'gst' && (
                      <>
                        <Row label="Taxable value" value={formatMoney(t.taxable_total)} />
                        {shownCalc.tax_summary
                          .filter((r) => r.gst_rate_bp > 0)
                          .map((r) =>
                            shownCalc.is_interstate ? (
                              <Row
                                key={r.gst_rate_bp}
                                label={`IGST ${formatRateBp(r.gst_rate_bp)}`}
                                value={formatMoney(r.igst)}
                                muted
                              />
                            ) : (
                              <Row
                                key={r.gst_rate_bp}
                                label={`CGST+SGST ${formatRateBp(r.gst_rate_bp)}`}
                                value={`${formatMoney(r.cgst)} + ${formatMoney(r.sgst)}`}
                                muted
                              />
                            ),
                          )}
                      </>
                    )}
                    <Row label="Round off">
                      <span className="flex items-center gap-2">
                        <button
                          type="button"
                          className="text-xs text-primary hover:underline"
                          onClick={() =>
                            update({
                              round_off:
                                form.round_off == null ? paiseToInput(t.round_off) || '0' : null,
                            })
                          }
                        >
                          {form.round_off == null ? 'edit' : 'auto'}
                        </button>
                        {form.round_off == null ? (
                          <span className="tabular-nums">{formatMoney(t.round_off)}</span>
                        ) : (
                          <Input
                            value={form.round_off}
                            invalid={
                              Boolean(errors.round_off) ||
                              Math.abs(parseMoney(form.round_off) ?? 0) > meta.max_round_off
                            }
                            onChange={(e) => update({ round_off: e.target.value })}
                            className="h-7 w-20 text-right tabular-nums"
                          />
                        )}
                      </span>
                    </Row>
                    <div className="mt-2 flex items-baseline justify-between border-t border-border pt-2">
                      <span className="font-semibold">Grand total</span>
                      <motion.span
                        key={t.grand_total}
                        initial={{ opacity: 0.6 }}
                        animate={{ opacity: 1 }}
                        transition={{ duration: 0.12 }}
                        className="text-3xl font-bold tabular-nums"
                      >
                        {formatMoney(t.grand_total)}
                      </motion.span>
                    </div>
                    {t.services_total > 0 && (
                      <div className="mt-1 flex justify-between text-xs text-muted">
                        <span>Products {formatMoney(t.goods_total)}</span>
                        <span>Fitting / labour {formatMoney(t.services_total)}</span>
                      </div>
                    )}
                    <p className="mt-1 text-xs text-muted italic">{shownCalc.amount_in_words}</p>
                  </div>
                )}
              </Panel>

              {!quotation && (
                <Panel title="Payment" right={<Kbd>F8</Kbd>}>
                  <div ref={payRef} className="space-y-2 text-sm">
                    {form.exchange && (
                      <Row
                        label={`Exchange credit (${form.exchange.label})`}
                        value={`-${formatMoney(Math.min(credit, grand))}`}
                        muted
                      />
                    )}
                    {payments.map((p, i) => (
                      <div
                        key={p.uid}
                        className="grid grid-cols-[7.25rem_minmax(0,1fr)_1.75rem] gap-1.5"
                      >
                        <Select
                          value={p.mode}
                          onChange={(e) =>
                            update((f) => ({
                              payments: f.payments.map((x) =>
                                x.uid === p.uid ? { ...x, mode: e.target.value } : x,
                              ),
                            }))
                          }
                          className="h-9 text-sm"
                        >
                          {Object.entries(MODES).map(([k, l]) => (
                            <option key={k} value={k}>
                              {l}
                            </option>
                          ))}
                        </Select>
                        <MoneyInput
                          value={p.amount}
                          invalid={Boolean(errors[`payments.${i}.amount`])}
                          onFocus={(e) => e.target.select()}
                          onChange={(e) =>
                            update((f) => ({
                              payments: f.payments.map((x) =>
                                x.uid === p.uid ? { ...x, amount: e.target.value, auto: false } : x,
                              ),
                            }))
                          }
                        />
                        {payments.length > 1 ? (
                          <Button
                            size="icon-sm"
                            variant="danger-ghost"
                            icon={Trash2}
                            className="mt-1"
                            onClick={() =>
                              update((f) => ({
                                payments: f.payments.filter((x) => x.uid !== p.uid),
                              }))
                            }
                          />
                        ) : (
                          <span />
                        )}
                        {p.mode !== 'cash' && (
                          <Input
                            value={p.ref_no}
                            maxLength={40}
                            placeholder={
                              p.mode === 'cheque' ? 'Cheque no. (required)' : 'Ref / UTR (optional)'
                            }
                            invalid={Boolean(errors[`payments.${i}.ref_no`])}
                            onChange={(e) =>
                              update((f) => ({
                                payments: f.payments.map((x) =>
                                  x.uid === p.uid ? { ...x, ref_no: e.target.value } : x,
                                ),
                              }))
                            }
                            className="col-span-2 col-start-2 h-8 text-sm"
                          />
                        )}
                      </div>
                    ))}
                    <div className="flex flex-wrap gap-1">
                      {payments.length < 4 && (
                        <Button
                          size="sm"
                          variant="ghost"
                          icon={Plus}
                          onClick={() =>
                            update((f) => ({
                              payments: [
                                ...f.payments.map((x) => ({
                                  ...x,
                                  auto: false,
                                  amount: x.auto
                                    ? payments.find((y) => y.uid === x.uid)?.amount || ''
                                    : x.amount,
                                })),
                                { uid: uid(), mode: 'upi', amount: '', ref_no: '', auto: true },
                              ],
                            }))
                          }
                        >
                          Split
                        </Button>
                      )}
                      {['cash', 'upi', 'card'].map((m) => (
                        <Button
                          key={m}
                          size="sm"
                          onClick={() =>
                            update({
                              payments: [
                                { uid: uid(), mode: m, amount: '', ref_no: '', auto: true },
                              ],
                            })
                          }
                        >
                          Full {MODES[m]}
                        </Button>
                      ))}
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          update({
                            payments: [
                              { uid: uid(), mode: 'cash', amount: '', ref_no: '', auto: false },
                            ],
                          })
                        }
                        title="Nothing paid now (credit)"
                      >
                        Credit
                      </Button>
                    </div>
                    {cashPaid > 0 && (
                      <div className="grid grid-cols-2 items-center gap-2">
                        <Field label="Cash tendered">
                          {(id) => (
                            <MoneyInput
                              id={id}
                              value={form.tendered}
                              onChange={(e) => update({ tendered: e.target.value })}
                            />
                          )}
                        </Field>
                        <div className="text-right">
                          <div className="text-xs text-muted">Change to return</div>
                          <div
                            className={`text-xl font-bold tabular-nums ${change ? 'text-success' : ''}`}
                          >
                            {formatMoney(change)}
                          </div>
                        </div>
                      </div>
                    )}
                    {custInfo && custInfo.advance > 0 && !form.exchange && (
                      <label className="flex flex-wrap items-center gap-2 rounded-lg bg-success-soft/50 px-2 py-1.5">
                        <input
                          type="checkbox"
                          className="h-4 w-4 accent-primary"
                          checked={form.use_advance}
                          onChange={(e) =>
                            update({
                              use_advance: e.target.checked,
                              advance_amount: e.target.checked
                                ? paiseToInput(Math.min(custInfo.advance, grand))
                                : '',
                            })
                          }
                        />
                        Adjust from advance ({formatMoney(custInfo.advance)})
                        {form.use_advance && (
                          <MoneyInput
                            value={form.advance_amount}
                            invalid={Boolean(errors.advance_amount)}
                            onChange={(e) => update({ advance_amount: e.target.value })}
                            className="ml-auto w-32"
                          />
                        )}
                      </label>
                    )}
                    {exchangeRefund > 0 && (
                      <div className="flex items-center gap-2 rounded-lg bg-warning-soft px-2 py-1.5">
                        Refund {formatMoney(exchangeRefund)} by
                        <Select
                          value={form.refund_mode || 'cash'}
                          onChange={(e) => update({ refund_mode: e.target.value })}
                          className="h-8 w-28 text-sm"
                        >
                          <option value="cash">Cash</option>
                          <option value="upi">UPI</option>
                          <option value="bank">Bank</option>
                        </Select>
                      </div>
                    )}
                    <div className="flex items-center justify-between border-t border-border pt-2">
                      <span className="font-semibold">
                        {over ? 'Paid more than total' : due > 0 ? 'Unpaid (credit)' : 'Fully paid'}
                      </span>
                      <span
                        className={`text-lg font-bold tabular-nums ${over ? 'text-danger' : due > 0 ? 'text-warning' : 'text-success'}`}
                      >
                        {formatMoney(due)}
                      </span>
                    </div>
                    {due > 0 &&
                      !over &&
                      (form.party ? (
                        <div className="flex items-center gap-2 text-xs text-muted">
                          Due date
                          <Input
                            type="date"
                            value={form.due_date}
                            min={form.date}
                            onChange={(e) => update({ due_date: e.target.value })}
                            className="h-7 w-36 text-sm"
                          />
                          {creditUsed != null && creditUsed > custInfo.credit_limit && (
                            <Badge tone="danger">over limit</Badge>
                          )}
                        </div>
                      ) : (
                        <p className="text-xs text-danger">Credit needs a customer (F5).</p>
                      ))}
                    {errors.payments && <p className="text-xs text-danger">{errors.payments}</p>}
                  </div>
                </Panel>
              )}
            </div>
            <div className="grid shrink-0 grid-cols-2 gap-2">
              <Button
                icon={PauseCircle}
                onClick={hold}
                disabled={saving || Boolean(form.exchange)}
                title="Hold this bill (Ctrl+H)"
              >
                Hold
              </Button>
              <Button icon={Printer} onClick={() => save({ print: true })} disabled={saving}>
                Save &amp; print
              </Button>
              <Button
                variant="primary"
                icon={Save}
                onClick={() => save()}
                disabled={saving}
                className="col-span-2 h-11 justify-center text-base"
              >
                {saving
                  ? 'Saving…'
                  : quotation
                    ? 'Save quotation'
                    : form.exchange
                      ? 'Save exchange'
                      : 'Save bill'}{' '}
                <Kbd>Ctrl+S</Kbd>
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Overlays */}
      {serialLine && (
        <SerialPickerModal
          key={`serial-${seq}`}
          open
          line={serialLine}
          onCancel={() => {
            if (serialFor.removeIfEmpty && serialLine.serials.length === 0) {
              removeLine(form.lines.findIndex((l) => l.uid === serialLine.uid));
            }
            setSerialFor(null);
            searchRef.current?.focus();
          }}
          onDone={(picked) => {
            const i = form.lines.findIndex((l) => l.uid === serialLine.uid);
            setLine(i, { serials: picked, qty: String(picked.length) });
            setSerialFor(null);
            focusQty(i);
          }}
        />
      )}
      {preview && preview.kind === 'card' && (
        <PrintPreviewModal
          key={`card-${preview.id}`}
          open
          api={cardPrinter}
          formats={SLIP_FORMATS}
          defaultFormat="a4half"
          id={{ sale_id: preview.id }}
          title="Warranty card"
          onClose={() => setPreview(null)}
        />
      )}
      {preview && preview.kind !== 'card' && (
        <PrintPreviewModal
          key={`preview-${preview.kind}-${preview.id}`}
          open
          kind={preview.kind}
          id={preview.id}
          defaultFormat={meta.print_format}
          onClose={() => setPreview(null)}
        />
      )}
      {vehicleModal && form.party && (
        <VehicleModal
          key={`veh-${seq}`}
          open
          customerId={form.party.customer.id}
          models={vehicleModal.models}
          onModelsChanged={() =>
            partiesApi
              .meta()
              .then((m) => setVehicleModal({ models: m.vehicle_models }))
              .catch(() => {})
          }
          onClose={() => setVehicleModal(null)}
          onSaved={(v) => {
            setVehicleModal(null);
            setInfo(null);
            salesApi
              .customerInfo(form.party.customer.id)
              .then(setInfo)
              .catch(() => {});
            update({ vehicle_id: v.id });
          }}
        />
      )}
      {returnModal && (
        <SaleReturnModal
          open
          onClose={() => setReturnModal(false)}
          onDone={() => setReturnModal(false)}
          onExchange={(salePayload, creditAmount, customer, label) => {
            setReturnModal(false);
            const f = emptyForm(meta);
            f.exchange = { sale_return: salePayload, credit: creditAmount, customer, label };
            f.dirty = true;
            (async () => {
              f.party = customer.is_cash
                ? null
                : { customer: await partiesApi.summary(customer.id), vehicle: null };
              if (openTab(f)) setTimeout(() => searchRef.current?.focus(), 30);
            })().catch(toast.error);
          }}
        />
      )}
      <AnimatePresence>
        {confirm?.code && (
          <ConfirmDialog
            title={
              confirm.code === 'CREDIT_LIMIT' ? 'Over the credit limit' : 'Check the bill date'
            }
            confirmLabel={confirm.code === 'CREDIT_LIMIT' ? 'Allow credit' : 'Save with this date'}
            onCancel={() => setConfirm(null)}
            onConfirm={() => {
              const c = confirm;
              setConfirm(null);
              save({
                print: c.print,
                confirmDate: c.confirmDate || c.code === 'DATE_CONFIRM',
                confirmCredit: c.confirmCredit || c.code === 'CREDIT_LIMIT',
              });
            }}
          >
            {confirm.message}
          </ConfirmDialog>
        )}
        {confirm?.close && (
          <ConfirmDialog
            title="Close this bill?"
            confirmLabel="Discard"
            danger
            onCancel={() => setConfirm(null)}
            onConfirm={() => {
              closeTab(confirm.close);
              setConfirm(null);
            }}
          >
            The lines on this bill will be lost. Use Hold (Ctrl+H) to keep it for later.
          </ConfirmDialog>
        )}
      </AnimatePresence>
    </div>
  );
}

function SavedCard({ saved, meta, onPreview, onCard, onNew, onOpen }) {
  const toast = useToast();
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.98 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.18 }}
      className="mx-auto mt-10 w-full max-w-xl rounded-2xl border border-border bg-surface p-6 text-center shadow-sm"
    >
      <CheckCircle2 size={44} className="mx-auto text-success" />
      <h2 className="mt-2 text-xl font-bold">
        {saved.kind === 'quotation' ? 'Quotation' : 'Bill'} {saved.number} saved
      </h2>
      <div className="mt-1 text-3xl font-bold tabular-nums">{formatMoney(saved.total)}</div>
      {saved.note && <p className="text-sm text-muted">{saved.note}</p>}
      {saved.due > 0 && <p className="mt-1 text-warning">{formatMoney(saved.due)} on credit</p>}
      {saved.change > 0 && (
        <p className="mt-2 rounded-xl bg-success-soft py-2 text-lg font-semibold text-success">
          Return change {formatMoney(saved.change)}
        </p>
      )}
      <div className="mt-5 flex flex-wrap justify-center gap-2">
        <Button icon={Eye} onClick={onPreview}>
          Preview
        </Button>
        {saved.kind === 'sale' && (
          <>
            <Button
              icon={Printer}
              onClick={() => salesApi.print(saved.id, 'a4').catch(toast.error)}
            >
              Print A4
            </Button>
            <Button
              icon={Printer}
              onClick={() => salesApi.print(saved.id, 'thermal80').catch(toast.error)}
            >
              Print 80 mm
            </Button>
            {saved.has_warranty && (
              <Button icon={IdCard} onClick={onCard}>
                Warranty card
              </Button>
            )}
          </>
        )}
        <Button icon={List} onClick={onOpen}>
          Open
        </Button>
        <Button variant="primary" icon={Plus} onClick={onNew} autoFocus>
          New bill <Kbd>Ctrl+N</Kbd>
        </Button>
      </div>
      <p className="mt-3 text-xs text-muted">
        Default print: {meta.print_format === 'thermal80' ? 'thermal 80 mm' : 'A4'} (Ctrl+P prints
        it)
      </p>
    </motion.div>
  );
}

function templateOf(fittingLineRow) {
  return {
    variant_id: fittingLineRow.variant_id,
    product_id: fittingLineRow.product_id,
    name: fittingLineRow.name,
    variant_label: fittingLineRow.variant_label,
    hsn_code: fittingLineRow.hsn_code,
    unit: fittingLineRow.unit,
    gst_rate_bp: fittingLineRow.gst_rate_bp,
    selling_price: 0,
    rate_input: fittingLineRow.rate,
    fitted_by: fittingLineRow.fitted_by,
  };
}

function daysFrom(a, b) {
  const [y1, m1, d1] = a.split('-').map(Number);
  const [y2, m2, d2] = b.split('-').map(Number);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000);
}

async function summaryOrNull(partyId, meta) {
  if (!Number.isInteger(partyId) || partyId === meta.cash_customer_id) return null;
  try {
    return { customer: await partiesApi.summary(partyId), vehicle: null };
  } catch {
    return null;
  }
}
