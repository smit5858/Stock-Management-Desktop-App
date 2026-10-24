import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  ArrowLeftRight,
  Ban,
  Barcode,
  FileDown,
  History,
  IdCard,
  IndianRupee,
  Printer,
  ReceiptText,
  RotateCcw,
  ShieldCheck,
  Undo2,
  Wrench,
} from 'lucide-react';
import Button from '../../components/Button';
import { Drawer } from '../../components/Overlay';
import { Badge, Skeleton } from '../../components/Feedback';
import { useToast } from '../../components/Toast';
import { salesApi } from '../../api/sales';
import { formatMoney } from '../../utils/money';
import { formatQty, formatRateBp } from '../../utils/qty';
import { formatDate, formatDateTime } from '../../utils/dates';
import PayStatus from '../purchases/PayStatus';
import {
  CancelSaleModal,
  PrintPreviewModal,
  SalePaymentModal,
  SaleReturnModal,
} from './SaleModals';
import { SLIP_FORMATS, cardPrinter } from '../warranty/shared';

const th = 'px-2.5 py-2 font-medium';
const thr = 'px-2.5 py-2 text-right font-medium';
const td = 'px-2.5 py-2 align-top';
const tdr = 'px-2.5 py-2 text-right tabular-nums whitespace-nowrap align-top';

const SOURCE_LABEL = { payment: 'Payment', advance: 'From advance', sale_return: 'Credit note' };
const ACTION_TONE = {
  created: 'success',
  cancelled: 'danger',
  payment: 'success',
  refund: 'warning',
  return: 'warning',
  exchange: 'primary',
  printed: 'neutral',
  pdf: 'neutral',
};
const W_TONE = { active: 'success', expiring: 'warning', expired: 'danger', none: 'neutral' };

function Tabs({ value, onChange, tabs }) {
  return (
    <div className="mb-4 flex gap-1 rounded-xl border border-border bg-surface-2/50 p-1">
      {tabs.map(([id, label, Icon]) => (
        <button
          key={id}
          type="button"
          onClick={() => onChange(id)}
          className={`relative flex h-8 flex-1 items-center justify-center gap-2 rounded-lg text-sm font-medium ${value === id ? 'text-primary' : 'text-muted hover:text-fg'}`}
        >
          {value === id && (
            <motion.span
              layoutId="sale-tab"
              className="absolute inset-0 rounded-lg bg-surface shadow-sm"
              transition={{ type: 'spring', stiffness: 500, damping: 40 }}
            />
          )}
          <Icon size={15} className="relative" />
          <span className="relative">{label}</span>
        </button>
      ))}
    </div>
  );
}

function Info({ label, children }) {
  return (
    <div className="min-w-0">
      <div className="text-xs text-muted">{label}</div>
      <div className="truncate font-medium">{children}</div>
    </div>
  );
}

/** Bill detail: lines, serials + warranty, fitting, tax, payments, returns, cancel info, audit. */
export default function SaleDrawer({ open, saleId, onClose, onChanged, onOpenReturn }) {
  const toast = useToast();
  const navigate = useNavigate();
  const [s, setS] = useState(null);
  const [tab, setTab] = useState('bill');
  const [modal, setModal] = useState(null); // cancel | pay | return | preview
  const [advance, setAdvance] = useState(0);
  const [seq, setSeq] = useState(0);

  const load = useCallback(
    () =>
      salesApi
        .get(saleId)
        .then(setS)
        .catch((e) => {
          toast.error(e);
          onClose();
        }),
    [saleId, toast, onClose],
  );
  useEffect(() => {
    if (saleId) load();
  }, [saleId, load]);
  useEffect(() => {
    if (!s || s.status !== 'active' || s.due <= 0) return;
    salesApi
      .customerInfo(s.party_id)
      .then((r) => setAdvance(r.advance))
      .catch(() => {});
  }, [s]);

  const show = (m) => {
    setSeq((n) => n + 1);
    setModal(m);
  };
  const changed = (next) => {
    setModal(null);
    if (next && next.invoice_no) setS(next);
    else load();
    onChanged();
  };

  const active = s && s.status === 'active';
  return (
    <Drawer
      open={open}
      onClose={onClose}
      width="w-[62rem]"
      title={s ? `${s.bill_title} ${s.invoice_no}` : 'Bill'}
      subtitle={
        s
          ? `${s.customer_name}${s.vehicle_no ? ` · ${s.vehicle_no}` : ''} · ${formatDate(s.invoice_date)}`
          : 'Loading…'
      }
      footer={
        s && (
          <>
            <Button icon={Printer} onClick={() => show('preview')}>
              Print / PDF
            </Button>
            <Button
              icon={FileDown}
              onClick={() =>
                salesApi
                  .savePdf(s.id, 'a4')
                  .then((r) => r.saved && toast.success(`Saved ${r.file_path}`))
                  .catch(toast.error)
              }
            >
              PDF
            </Button>
            {active && s.items.some((it) => it.warranty_end) && (
              <Button icon={IdCard} onClick={() => show('card')}>
                Warranty card
              </Button>
            )}
            <span className="mr-auto" />
            {s.status === 'cancelled' && !s.reissued_as && (
              <Button
                variant="primary"
                icon={RotateCcw}
                onClick={() => navigate('/billing', { state: { reissue: s.id } })}
              >
                Re-issue
              </Button>
            )}
            {active && (
              <>
                <Button
                  variant="danger-ghost"
                  icon={Ban}
                  disabled={!s.can_cancel}
                  title={s.can_cancel ? 'Cancel this bill' : s.lock_reasons[0]}
                  onClick={() => show('cancel')}
                >
                  Cancel
                </Button>
                <Button icon={Undo2} onClick={() => show('return')}>
                  Return / exchange
                </Button>
                {s.due > 0 && (
                  <Button variant="primary" icon={IndianRupee} onClick={() => show('pay')}>
                    Receive payment
                  </Button>
                )}
              </>
            )}
          </>
        )
      }
    >
      {!s ? (
        <div className="space-y-3">
          <Skeleton className="h-20" />
          <Skeleton className="h-64" />
        </div>
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <PayStatus status={s.pay_status} />
            <Badge tone={s.bill_type === 'gst' ? 'primary' : 'neutral'}>
              {s.bill_type === 'gst'
                ? `GST · ${s.is_interstate ? 'IGST' : 'CGST + SGST'}`
                : s.bill_title}
            </Badge>
            <Badge>Rates {s.price_mode === 'inclusive' ? 'incl.' : 'excl.'} GST</Badge>
            {s.print_count > 0 && <Badge>Printed {s.print_count}×</Badge>}
            {s.quotation && <Badge tone="primary">From {s.quotation.quote_no}</Badge>}
            {s.reissue_of && <Badge tone="primary">Re-issue of {s.reissue_of.invoice_no}</Badge>}
          </div>
          {s.status === 'cancelled' && (
            <div className="rounded-xl bg-danger-soft px-4 py-3 text-sm text-danger">
              Cancelled on {formatDateTime(s.cancelled_at)}: {s.cancel_reason}
              {s.reissued_as && (
                <button
                  type="button"
                  className="ml-2 underline"
                  onClick={() => navigate(`/sales?open=${s.reissued_as.id}`)}
                >
                  Re-issued as {s.reissued_as.invoice_no}
                </button>
              )}
            </div>
          )}
          {active && !s.can_cancel && (
            <div className="rounded-xl bg-warning-soft px-4 py-2.5 text-sm text-warning">
              Cannot be cancelled: {s.lock_reasons.join(' ')}
            </div>
          )}

          <div className="grid grid-cols-4 gap-4 rounded-xl border border-border p-3 text-sm">
            <Info label="Customer">
              <button
                type="button"
                className="hover:text-primary hover:underline"
                onClick={() => navigate(`/parties?open=${s.party_id}`)}
              >
                {s.customer_name}
              </button>
            </Info>
            <Info label="Phone">{s.customer?.phone_display || s.customer_phone || '—'}</Info>
            <Info label="Vehicle">
              {s.vehicle_no
                ? `${s.vehicle_no}${s.vehicle_model ? ` · ${s.vehicle_model}` : ''}`
                : '—'}
            </Info>
            <Info label="GSTIN">{s.customer_gstin || '—'}</Info>
            <Info label="Grand total">{formatMoney(s.grand_total)}</Info>
            <Info label="Paid">{formatMoney(s.paid)}</Info>
            <Info label="Due">{active ? formatMoney(s.due) : '—'}</Info>
            <Info label="Due date">{s.due_date ? formatDate(s.due_date) : '—'}</Info>
          </div>

          <Tabs
            value={tab}
            onChange={setTab}
            tabs={[
              ['bill', `Items (${s.items.length})`, ReceiptText],
              [
                'money',
                `Payments & returns (${s.allocations.length + s.returns.length + s.refunds.length})`,
                IndianRupee,
              ],
              ['audit', `History (${s.audit.length})`, History],
            ]}
          />

          {tab === 'bill' && (
            <div className="space-y-4">
              <div className="overflow-hidden rounded-xl border border-border">
                <table className="w-full text-sm">
                  <thead className="bg-surface-2 text-left text-xs text-muted">
                    <tr>
                      <th className={th}>Item</th>
                      <th className={thr}>Qty</th>
                      <th className={thr}>Rate</th>
                      <th className={thr}>Disc.</th>
                      <th className={thr}>Taxable</th>
                      <th className={thr}>GST</th>
                      <th className={thr}>Total</th>
                      <th className={thr}>Cost</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {s.items.map((it) => (
                      <tr key={it.id} className={it.fitting_for_item_id ? 'bg-surface-2/40' : ''}>
                        <td className={td}>
                          <div className="flex items-center gap-1 font-medium">
                            {it.fitting_for_item_id && <Wrench size={12} className="text-muted" />}
                            {it.product_name}
                            {it.variant_label && (
                              <span className="font-normal text-muted"> · {it.variant_label}</span>
                            )}
                          </div>
                          <div className="text-xs text-muted">
                            {[
                              it.sku,
                              it.hsn_code ? `HSN ${it.hsn_code}` : null,
                              it.fitted_by ? `fitted by ${it.fitted_by}` : null,
                            ]
                              .filter(Boolean)
                              .join(' · ')}
                            {it.returned_milli > 0 && (
                              <span className="text-warning">
                                {' '}
                                · returned {formatQty(it.returned_milli)}
                              </span>
                            )}
                          </div>
                          {it.serials.length > 0 && (
                            <div className="mt-1 flex flex-wrap gap-1">
                              {it.serials.map((u) => (
                                <button
                                  type="button"
                                  key={u.link_id}
                                  onClick={() => navigate(`/warranty?unit=s${u.id}`)}
                                  title={`${u.status_label}${u.warranty_end ? ` · warranty till ${formatDate(u.warranty_end)}` : ''}${u.replaced_by_serial_no ? ` · replaced by ${u.replaced_by_serial_no}` : ''}`}
                                  className={`flex items-center gap-1 rounded border px-1.5 font-mono text-[11px] hover:border-primary/50 ${u.link_status !== 'sold' ? 'border-warning/40 text-warning line-through' : u.replaced_by_serial_id ? 'border-border text-muted line-through' : u.is_replacement ? 'border-info/50 text-info' : 'border-border'}`}
                                >
                                  <Barcode size={10} /> {u.serial_no}
                                  {u.is_replacement ? (
                                    <span className="font-sans">
                                      replacement
                                      {u.replacement_claim_no ? ` · ${u.replacement_claim_no}` : ''}
                                    </span>
                                  ) : null}
                                  {u.link_status === 'sold' &&
                                    !u.replaced_by_serial_id &&
                                    u.warranty_end && (
                                      <span className="font-sans text-muted">
                                        → {formatDate(u.warranty_end)}
                                      </span>
                                    )}
                                </button>
                              ))}
                            </div>
                          )}
                          {it.claims.length > 0 && (
                            <div className="mt-1 flex flex-wrap gap-1">
                              {it.claims.map((c) => (
                                <button
                                  key={c.id}
                                  type="button"
                                  onClick={() => navigate(`/warranty?claim=${c.id}`)}
                                >
                                  <Badge
                                    tone={
                                      ['closed', 'cancelled'].includes(c.status)
                                        ? 'neutral'
                                        : 'info'
                                    }
                                  >
                                    <ShieldCheck size={11} /> {c.claim_no}
                                  </Badge>
                                </button>
                              ))}
                            </div>
                          )}
                          {!it.serials.length && it.warranty_end && (
                            <div className="mt-0.5 text-xs">
                              <Badge tone={W_TONE[it.warranty.status]}>
                                <ShieldCheck size={11} /> Warranty till{' '}
                                {formatDate(it.warranty_end)}
                              </Badge>
                            </div>
                          )}
                        </td>
                        <td className={tdr}>
                          {formatQty(it.qty_milli)} {it.unit}
                        </td>
                        <td className={tdr}>{formatMoney(it.rate)}</td>
                        <td className={tdr}>
                          {it.discount + it.bill_discount_share
                            ? formatMoney(it.discount + it.bill_discount_share)
                            : '—'}
                        </td>
                        <td className={tdr}>{formatMoney(it.taxable)}</td>
                        <td className={tdr}>
                          {s.bill_type === 'gst' ? (
                            <>
                              {formatMoney(it.cgst + it.sgst + it.igst)}
                              <div className="text-xs text-muted">
                                {formatRateBp(it.gst_rate_bp)}
                              </div>
                            </>
                          ) : (
                            '—'
                          )}
                        </td>
                        <td className={`${tdr} font-semibold`}>{formatMoney(it.line_total)}</td>
                        <td className={`${tdr} text-muted`}>
                          {it.item_type === 'goods' ? formatMoney(it.unit_cost) : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="grid grid-cols-2 gap-4 text-sm">
                <div className="space-y-3">
                  {s.bill_type === 'gst' && (
                    <div className="rounded-xl border border-border p-3">
                      <div className="mb-1 text-xs font-semibold text-muted uppercase">
                        Tax summary
                      </div>
                      <table className="w-full">
                        <thead className="text-xs text-muted">
                          <tr>
                            <th className="text-left font-medium">Rate</th>
                            <th className="text-right font-medium">Taxable</th>
                            {s.is_interstate ? (
                              <th className="text-right font-medium">IGST</th>
                            ) : (
                              <>
                                <th className="text-right font-medium">CGST</th>
                                <th className="text-right font-medium">SGST</th>
                              </>
                            )}
                          </tr>
                        </thead>
                        <tbody className="tabular-nums">
                          {s.tax_summary.map((r) => (
                            <tr key={r.gst_rate_bp}>
                              <td>{formatRateBp(r.gst_rate_bp)}</td>
                              <td className="text-right">{formatMoney(r.taxable)}</td>
                              {s.is_interstate ? (
                                <td className="text-right">{formatMoney(r.igst)}</td>
                              ) : (
                                <>
                                  <td className="text-right">{formatMoney(r.cgst)}</td>
                                  <td className="text-right">{formatMoney(r.sgst)}</td>
                                </>
                              )}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                  <div className="rounded-xl border border-border p-3 text-xs text-muted">
                    Profit (at average cost): {formatMoney(s.taxable_total - s.cost_total)} on
                    products and fitting · cost {formatMoney(s.cost_total)}
                  </div>
                  {s.notes && (
                    <p className="rounded-xl border border-border p-3 whitespace-pre-wrap">
                      {s.notes}
                    </p>
                  )}
                </div>
                <div className="rounded-xl border border-border p-3">
                  {[
                    ['Sub total', s.sub_total],
                    s.item_discount_total ? ['Line discounts', -s.item_discount_total] : null,
                    s.bill_discount ? ['Bill discount', -s.bill_discount] : null,
                    ['Taxable value', s.taxable_total],
                    s.tax_total ? ['GST', s.tax_total] : null,
                    s.round_off ? ['Round off', s.round_off] : null,
                  ]
                    .filter(Boolean)
                    .map(([l, v]) => (
                      <div key={l} className="flex justify-between py-0.5">
                        <span className="text-muted">{l}</span>
                        <span className="tabular-nums">{formatMoney(v)}</span>
                      </div>
                    ))}
                  <div className="mt-1 flex justify-between border-t border-border pt-2 text-base font-bold">
                    <span>Grand total</span>
                    <span className="tabular-nums">{formatMoney(s.grand_total)}</span>
                  </div>
                  {s.services_total > 0 && (
                    <div className="mt-1 flex justify-between text-xs text-muted">
                      <span>Products {formatMoney(s.goods_total)}</span>
                      <span>Fitting / labour {formatMoney(s.services_total)}</span>
                    </div>
                  )}
                  <p className="mt-1 text-xs text-muted italic">{s.amount_in_words}</p>
                </div>
              </div>
            </div>
          )}

          {tab === 'money' && (
            <div className="space-y-4 text-sm">
              <div className="overflow-hidden rounded-xl border border-border">
                <table className="w-full">
                  <thead className="bg-surface-2 text-left text-xs text-muted">
                    <tr>
                      <th className={th}>Date</th>
                      <th className={th}>Settled by</th>
                      <th className={th}>Reference</th>
                      <th className={thr}>Amount</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {s.allocations.length === 0 && (
                      <tr>
                        <td className={`${td} text-muted`} colSpan={4}>
                          Nothing received against this bill yet.
                        </td>
                      </tr>
                    )}
                    {s.allocations.map((a) => (
                      <tr
                        key={a.id}
                        className={a.status !== 'active' ? 'line-through opacity-50' : ''}
                      >
                        <td className={td}>{formatDate(a.date)}</td>
                        <td className={td}>
                          {SOURCE_LABEL[a.source_type]}
                          {a.mode ? ` · ${a.mode.toUpperCase()}` : ''}
                        </td>
                        <td className={`${td} text-muted`}>
                          {[a.payment_no, a.ref_no, a.return_no, a.note]
                            .filter(Boolean)
                            .join(' · ')}
                        </td>
                        <td className={tdr}>{formatMoney(a.amount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {s.refunds.length > 0 && (
                <div className="rounded-xl border border-border p-3">
                  <div className="mb-1 text-xs font-semibold text-muted uppercase">
                    Refunds given
                  </div>
                  {s.refunds.map((r) => (
                    <div key={r.id} className="flex justify-between py-0.5">
                      <span>
                        {formatDate(r.date)} · {r.payment_no} · {r.mode}
                      </span>
                      <span className="tabular-nums">{formatMoney(r.amount)}</span>
                    </div>
                  ))}
                </div>
              )}
              <div className="rounded-xl border border-border p-3">
                <div className="mb-1 text-xs font-semibold text-muted uppercase">
                  Returns (credit notes)
                </div>
                {s.returns.length === 0 ? (
                  <p className="text-muted">None.</p>
                ) : (
                  s.returns.map((r) => (
                    <button
                      key={r.id}
                      type="button"
                      onClick={() => onOpenReturn(r.id)}
                      className="flex w-full justify-between rounded-lg px-2 py-1 text-left hover:bg-surface-2"
                    >
                      <span className="flex items-center gap-2">
                        {r.is_exchange_credit && (
                          <ArrowLeftRight size={13} className="text-primary" />
                        )}
                        {r.return_no} · {formatDate(r.date)}
                        {r.is_exchange_credit && <Badge tone="primary">exchange</Badge>}
                      </span>
                      <span className="tabular-nums">{formatMoney(r.total)}</span>
                    </button>
                  ))
                )}
              </div>
            </div>
          )}

          {tab === 'audit' && (
            <ol className="relative space-y-3 border-l border-border pl-5 text-sm">
              {s.audit.map((a) => (
                <li key={a.id}>
                  <span className="absolute -left-1.5 mt-1.5 h-3 w-3 rounded-full border-2 border-surface bg-primary" />
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={ACTION_TONE[a.action] || 'neutral'}>
                      {a.action.replace(/_/g, ' ')}
                    </Badge>
                    <span className="text-xs text-muted">
                      {formatDateTime(a.created_at)} · {a.actor}
                    </span>
                  </div>
                  <p className="mt-0.5">{a.summary}</p>
                </li>
              ))}
            </ol>
          )}
        </div>
      )}

      {s && modal === 'cancel' && (
        <CancelSaleModal
          key={`c${seq}`}
          open
          sale={s}
          onClose={() => setModal(null)}
          onDone={(next, reissue) => {
            changed(next);
            if (reissue) navigate('/billing', { state: { reissue: next.id } });
          }}
        />
      )}
      {s && modal === 'pay' && (
        <SalePaymentModal
          key={`p${seq}`}
          open
          sale={s}
          advance={advance}
          onClose={() => setModal(null)}
          onDone={changed}
        />
      )}
      {s && modal === 'return' && (
        <SaleReturnModal
          key={`r${seq}`}
          open
          saleId={s.id}
          onClose={() => setModal(null)}
          onDone={() => changed(null)}
          onExchange={(payload, credit, customer, label) => {
            setModal(null);
            navigate('/billing', {
              state: { exchange: { sale_return: payload, credit, customer, label } },
            });
          }}
        />
      )}
      {s && modal === 'card' && (
        <PrintPreviewModal
          key={`w${seq}`}
          open
          api={cardPrinter}
          formats={SLIP_FORMATS}
          defaultFormat="a4half"
          id={{ sale_id: s.id }}
          title={`Warranty card · ${s.invoice_no}`}
          onClose={() => setModal(null)}
        />
      )}
      {s && modal === 'preview' && (
        <PrintPreviewModal
          key={`v${seq}`}
          open
          kind="sale"
          id={s.id}
          title={`${s.bill_title} ${s.invoice_no}`}
          onClose={() => {
            setModal(null);
            load();
          }}
        />
      )}
    </Drawer>
  );
}
