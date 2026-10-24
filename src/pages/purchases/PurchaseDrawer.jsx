import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  AlertTriangle,
  Barcode,
  Ban,
  FileDown,
  FileText,
  History,
  Image as ImageIcon,
  IndianRupee,
  Paperclip,
  Pencil,
  Printer,
  ReceiptText,
  Trash2,
  Undo2,
} from 'lucide-react';
import Button from '../../components/Button';
import { Drawer, Modal } from '../../components/Overlay';
import { Input } from '../../components/Field';
import { Badge, Skeleton } from '../../components/Feedback';
import ConfirmDialog from '../../components/ConfirmDialog';
import { useToast } from '../../components/Toast';
import { purchaseReturnsApi, purchasesApi } from '../../api/purchases';
import { formatMoney } from '../../utils/money';
import { formatQty, formatRateBp } from '../../utils/qty';
import { formatBytes, formatDate, formatDateTime } from '../../utils/dates';
import PayStatus from './PayStatus';
import { CancelPurchaseModal, LabelsModal, PaymentModal, ReturnModal } from './PurchaseModals';

const th = 'px-2.5 py-2 font-medium';
const thr = 'px-2.5 py-2 text-right font-medium';
const td = 'px-2.5 py-2 align-top';
const tdr = 'px-2.5 py-2 text-right tabular-nums whitespace-nowrap align-top';

const SOURCE_LABEL = { payment: 'Payment', advance: 'From advance', purchase_return: 'Debit note' };
const ACTION_TONE = {
  created: 'success',
  edited: 'primary',
  cancelled: 'danger',
  payment: 'success',
  refund: 'warning',
  return: 'warning',
};

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
              layoutId="purchase-tab"
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

/** Purchase detail. Actions: edit, cancel, return, payment, print / PDF, labels, attachments. */
export default function PurchaseDrawer({ open, purchaseId, onClose, onChanged, onOpenReturn }) {
  const toast = useToast();
  const navigate = useNavigate();
  const [p, setP] = useState(null);
  const [tab, setTab] = useState('bill');
  const [modal, setModal] = useState(null); // cancel | pay | labels | return
  const [seq, setSeq] = useState(0);
  const [preview, setPreview] = useState(null);
  const [removeAtt, setRemoveAtt] = useState(null);

  const load = useCallback(
    () =>
      purchasesApi
        .get(purchaseId)
        .then(setP)
        .catch((e) => {
          toast.error(e);
          onClose();
        }),
    [purchaseId, toast, onClose],
  );
  useEffect(() => {
    if (purchaseId) load();
  }, [purchaseId, load]);

  const show = (m) => {
    setSeq((n) => n + 1);
    setModal(m);
  };
  const changed = (next) => {
    setModal(null);
    if (next && next.entry_no) setP(next);
    else load();
    onChanged();
  };

  async function attachMore() {
    try {
      const files = await purchasesApi.pickAttachments();
      if (files.length) {
        setP(await purchasesApi.addAttachments(p.id, files));
        toast.success(`${files.length} file(s) attached.`);
      }
    } catch (e) {
      toast.error(e);
    }
  }

  function openAttachment(a) {
    if (/\.pdf$/i.test(a.file_path)) purchasesApi.openAttachment({ id: a.id }).catch(toast.error);
    else setPreview(a);
  }

  const active = p && p.status === 'active';
  const subtitle = p
    ? `${p.supplier_name} · bill ${p.bill_no || '—'} · ${formatDate(p.bill_date)}`
    : 'Loading…';

  return (
    <Drawer
      open={open}
      onClose={onClose}
      width="w-[62rem]"
      title={p ? `Purchase ${p.entry_no}` : 'Purchase'}
      subtitle={subtitle}
      footer={
        p && (
          <>
            <Button icon={Printer} onClick={() => purchasesApi.print(p.id).catch(toast.error)}>
              Print
            </Button>
            <Button
              icon={FileDown}
              onClick={() =>
                purchasesApi
                  .savePdf(p.id)
                  .then((r) => r.saved && toast.success(`Saved ${r.file_path}`))
                  .catch(toast.error)
              }
            >
              PDF
            </Button>
            <Button icon={Barcode} onClick={() => show('labels')}>
              Labels
            </Button>
            <span className="mr-auto" />
            {active && (
              <>
                <Button variant="danger-ghost" icon={Ban} onClick={() => show('cancel')}>
                  Cancel
                </Button>
                <Button icon={Undo2} onClick={() => show('return')}>
                  Return
                </Button>
                {p.due > 0 && (
                  <Button icon={IndianRupee} onClick={() => show('pay')}>
                    Record payment
                  </Button>
                )}
                <Button
                  variant="primary"
                  icon={Pencil}
                  disabled={!p.can_edit}
                  title={p.can_edit ? 'Edit this purchase' : p.lock_reasons[0]}
                  onClick={() => navigate(`/purchases/${p.id}/edit`)}
                >
                  Edit
                </Button>
              </>
            )}
          </>
        )
      }
    >
      {!p ? (
        <div className="space-y-3">
          <Skeleton className="h-20" />
          <Skeleton className="h-64" />
        </div>
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <PayStatus status={p.pay_status} />
            <Badge tone={p.bill_type === 'gst' ? 'primary' : 'neutral'}>
              {p.bill_type === 'gst'
                ? `GST · ${p.is_interstate ? 'IGST' : 'CGST + SGST'}`
                : 'Non-GST'}
            </Badge>
            <Badge>Rates {p.price_mode === 'inclusive' ? 'incl.' : 'excl.'} GST</Badge>
            {p.total_mismatch ? (
              <Badge tone="warning">
                <AlertTriangle size={12} /> Differs from printed total by{' '}
                {formatMoney(Math.abs(p.mismatch_amount))}
              </Badge>
            ) : null}
            {p.revision > 1 && <Badge>Edited ({p.revision - 1}×)</Badge>}
          </div>
          {p.status === 'cancelled' && (
            <div className="rounded-xl bg-danger-soft px-4 py-3 text-sm text-danger">
              Cancelled on {formatDateTime(p.cancelled_at)}: {p.cancel_reason}
            </div>
          )}
          {active && !p.can_edit && (
            <div className="rounded-xl bg-warning-soft px-4 py-2.5 text-sm text-warning">
              Editing is locked: {p.lock_reasons.join(' ')}
            </div>
          )}

          <div className="grid grid-cols-4 gap-4 rounded-xl border border-border p-3 text-sm">
            <Info label="Supplier">
              <button
                type="button"
                className="hover:text-primary hover:underline"
                onClick={() => navigate(`/parties?tab=suppliers&open=${p.party_id}`)}
              >
                {p.supplier_name}
              </button>
            </Info>
            <Info label="Supplier GSTIN">{p.supplier_gstin || '—'}</Info>
            <Info label="Bill no. / date">
              {p.bill_no || '—'} · {formatDate(p.bill_date)}
            </Info>
            <Info label="Received (entry date)">{formatDate(p.entry_date)}</Info>
            <Info label="Grand total">{formatMoney(p.grand_total)}</Info>
            <Info label="Paid">{formatMoney(p.paid)}</Info>
            <Info label="Due">{p.status === 'active' ? formatMoney(p.due) : '—'}</Info>
            <Info label="Due date">{p.due_date ? formatDate(p.due_date) : 'No terms'}</Info>
          </div>

          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Paperclip size={14} className="text-muted" />
            {p.attachments.length === 0 && <span className="text-muted">No bill photo / PDF.</span>}
            {p.attachments.map((a) => (
              <span
                key={a.id}
                className="flex items-center gap-1 rounded-lg border border-border bg-surface-2/50 px-2 py-1"
              >
                <button
                  type="button"
                  className="flex items-center gap-1.5 hover:text-primary"
                  onClick={() => openAttachment(a)}
                >
                  {/\.pdf$/i.test(a.file_path) ? <FileText size={14} /> : <ImageIcon size={14} />}
                  {a.original_name}
                  <span className="text-xs text-muted">{formatBytes(a.size_bytes)}</span>
                </button>
                <button
                  type="button"
                  title="Remove"
                  className="rounded p-0.5 text-muted hover:text-danger"
                  onClick={() => setRemoveAtt(a)}
                >
                  <Trash2 size={12} />
                </button>
              </span>
            ))}
            <Button size="sm" variant="ghost" icon={Paperclip} onClick={attachMore}>
              Attach
            </Button>
          </div>

          <Tabs
            value={tab}
            onChange={setTab}
            tabs={[
              ['bill', `Items (${p.items.length})`, ReceiptText],
              [
                'money',
                `Payments & returns (${p.allocations.length + p.returns.length + p.refunds.length})`,
                IndianRupee,
              ],
              ['audit', `History (${p.audit.length})`, History],
            ]}
          />

          {tab === 'bill' && (
            <div className="space-y-4">
              <div className="overflow-hidden rounded-xl border border-border">
                <table className="w-full text-sm">
                  <thead className="bg-surface-2 text-left text-xs text-muted">
                    <tr>
                      <th className={th}>Item</th>
                      <th className={th}>HSN</th>
                      <th className={thr}>Qty</th>
                      <th className={thr}>Rate</th>
                      <th className={thr}>Disc.</th>
                      <th className={thr}>Taxable</th>
                      <th className={thr}>GST</th>
                      <th className={thr}>Total</th>
                      <th className={thr}>Cost/unit</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {p.items.map((it) => (
                      <tr key={it.id}>
                        <td className={td}>
                          <div className="font-medium">
                            {it.product_name}
                            {it.variant_label && (
                              <span className="font-normal text-muted"> · {it.variant_label}</span>
                            )}
                          </div>
                          <div className="text-xs text-muted">
                            {it.sku}
                            {it.returned_milli > 0 && (
                              <span className="text-warning">
                                {' '}
                                · returned {formatQty(it.returned_milli)}
                              </span>
                            )}
                          </div>
                          {it.serials && it.serials.length > 0 && (
                            <div className="mt-1 flex flex-wrap gap-1">
                              {it.serials
                                .filter((s) => s.status !== 'voided')
                                .map((s) => (
                                  <span
                                    key={s.id}
                                    title={s.status_label}
                                    className={`rounded border px-1.5 font-mono text-[11px] ${s.status === 'in_stock' ? 'border-border' : 'border-warning/40 text-warning'}`}
                                  >
                                    {s.serial_no}
                                  </span>
                                ))}
                            </div>
                          )}
                        </td>
                        <td className={`${td} text-xs text-muted`}>{it.hsn_code || '—'}</td>
                        <td className={tdr}>
                          {formatQty(it.qty_milli)} {it.unit}
                          {it.free_qty_milli > 0 && (
                            <div className="text-xs text-success">
                              +{formatQty(it.free_qty_milli)} free
                            </div>
                          )}
                        </td>
                        <td className={tdr}>{formatMoney(it.rate)}</td>
                        <td className={tdr}>{it.discount ? formatMoney(it.discount) : '—'}</td>
                        <td className={tdr}>{formatMoney(it.taxable)}</td>
                        <td className={tdr}>
                          {p.bill_type === 'gst' ? (
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
                        <td className={tdr}>
                          {formatMoney(it.unit_cost)}
                          {it.charges_share > 0 && (
                            <div className="text-xs text-muted">incl. charges</div>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-3">
                  {p.charges.length > 0 && (
                    <div className="rounded-xl border border-border p-3 text-sm">
                      <div className="mb-1 text-xs font-semibold text-muted uppercase">
                        Extra charges ·{' '}
                        {p.charges_mode === 'cost'
                          ? 'added to product cost'
                          : 'recorded as expense'}
                      </div>
                      {p.charges.map((c) => (
                        <div key={c.id} className="flex justify-between py-0.5">
                          <span>
                            {c.label ||
                              {
                                freight: 'Transport / freight',
                                packing: 'Packing',
                                other: 'Other',
                              }[c.kind]}
                            {c.gst_rate_bp ? (
                              <span className="text-muted">
                                {' '}
                                · GST {formatRateBp(c.gst_rate_bp)}
                              </span>
                            ) : null}
                          </span>
                          <span className="tabular-nums">{formatMoney(c.total)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                  {p.bill_type === 'gst' && (
                    <div className="rounded-xl border border-border p-3 text-sm">
                      <div className="mb-1 text-xs font-semibold text-muted uppercase">
                        Tax summary (input tax)
                      </div>
                      <table className="w-full">
                        <thead className="text-xs text-muted">
                          <tr>
                            <th className="text-left font-medium">Rate</th>
                            <th className="text-right font-medium">Taxable</th>
                            {p.is_interstate ? (
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
                          {p.tax_summary.map((r) => (
                            <tr key={r.gst_rate_bp}>
                              <td>{formatRateBp(r.gst_rate_bp)}</td>
                              <td className="text-right">{formatMoney(r.taxable)}</td>
                              {p.is_interstate ? (
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
                  {p.notes && (
                    <p className="rounded-xl border border-border p-3 text-sm whitespace-pre-wrap">
                      {p.notes}
                    </p>
                  )}
                </div>
                <div className="rounded-xl border border-border p-3 text-sm">
                  {[
                    ['Sub total', p.sub_total],
                    p.discount_total ? ['Discount', -p.discount_total] : null,
                    ['Taxable value', p.taxable_total + p.charges_taxable],
                    p.tax_total ? ['GST', p.tax_total] : null,
                    p.round_off ? ['Round off', p.round_off] : null,
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
                    <span className="tabular-nums">{formatMoney(p.grand_total)}</span>
                  </div>
                  {p.printed_total != null && (
                    <div className="flex justify-between py-0.5 text-xs text-muted">
                      <span>Printed on the bill</span>
                      <span className="tabular-nums">{formatMoney(p.printed_total)}</span>
                    </div>
                  )}
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
                    {p.allocations.length === 0 && (
                      <tr>
                        <td className={`${td} text-muted`} colSpan={4}>
                          Nothing paid against this bill yet.
                        </td>
                      </tr>
                    )}
                    {p.allocations.map((a) => (
                      <tr
                        key={a.id}
                        className={a.status !== 'active' ? 'opacity-50 line-through' : ''}
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
              {p.refunds.length > 0 && (
                <div className="rounded-xl border border-border p-3">
                  <div className="mb-1 text-xs font-semibold text-muted uppercase">
                    Refunds received
                  </div>
                  {p.refunds.map((r) => (
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
                  Purchase returns (debit notes)
                </div>
                {p.returns.length === 0 ? (
                  <p className="text-muted">None.</p>
                ) : (
                  p.returns.map((r) => (
                    <button
                      key={r.id}
                      type="button"
                      onClick={() => onOpenReturn(r.id)}
                      className={`flex w-full justify-between rounded-lg px-2 py-1 text-left hover:bg-surface-2 ${r.status !== 'active' ? 'opacity-60' : ''}`}
                    >
                      <span>
                        {r.return_no} · {formatDate(r.date)}
                        {r.status !== 'active' && (
                          <Badge tone="danger" className="ml-2">
                            Cancelled
                          </Badge>
                        )}
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
              {p.audit.map((a) => (
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
                  {a.details?.reason && (
                    <p className="text-xs text-muted">Reason: {a.details.reason}</p>
                  )}
                  {a.details?.lines && (
                    <ul className="mt-1 list-disc pl-5 text-xs text-muted">
                      {a.details.lines.added.map((l) => (
                        <li key={`a${l.name}`}>
                          Added {l.name} × {formatQty(l.qty_milli)}
                        </li>
                      ))}
                      {a.details.lines.removed.map((l) => (
                        <li key={`r${l.name}`}>Removed {l.name}</li>
                      ))}
                      {a.details.lines.changed.map((l) => (
                        <li key={`c${l.name}`}>
                          {l.name}:{' '}
                          {Object.entries(l)
                            .filter(([k]) => k !== 'name')
                            .map(([k, [o, n]]) =>
                              k.endsWith('milli')
                                ? `${k.replace('_milli', '').replace(/_/g, ' ')} ${formatQty(o)} → ${formatQty(n)}`
                                : k === 'gst_rate_bp'
                                  ? `GST ${formatRateBp(o)} → ${formatRateBp(n)}`
                                  : `${k} ${formatMoney(o)} → ${formatMoney(n)}`,
                            )
                            .join(', ')}
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ol>
          )}
        </div>
      )}

      {p && modal === 'cancel' && (
        <CancelPurchaseModal
          key={`c${seq}`}
          open
          purchase={p}
          onClose={() => setModal(null)}
          onDone={changed}
        />
      )}
      {p && modal === 'pay' && (
        <PaymentModal
          key={`p${seq}`}
          open
          purchase={p}
          onClose={() => setModal(null)}
          onDone={changed}
        />
      )}
      {p && modal === 'labels' && (
        <LabelsModal key={`l${seq}`} open purchase={p} onClose={() => setModal(null)} />
      )}
      {p && modal === 'return' && (
        <ReturnModal
          key={`r${seq}`}
          open
          purchase={p}
          onClose={() => setModal(null)}
          onDone={() => changed(null)}
        />
      )}
      <Modal
        open={Boolean(preview)}
        onClose={() => setPreview(null)}
        title={preview?.original_name}
        width="w-[60rem]"
      >
        {preview && (
          <img
            src={preview.url}
            alt={preview.original_name}
            className="mx-auto max-h-[75vh] rounded-lg"
          />
        )}
      </Modal>
      {removeAtt && (
        <ConfirmDialog
          title="Remove attachment?"
          confirmLabel="Remove"
          danger
          onCancel={() => setRemoveAtt(null)}
          onConfirm={() =>
            purchasesApi
              .removeAttachment(removeAtt.id)
              .then((next) => {
                setP(next);
                setRemoveAtt(null);
              })
              .catch(toast.error)
          }
        >
          {removeAtt.original_name} will no longer be listed on this purchase (the file stays in the
          data folder).
        </ConfirmDialog>
      )}
    </Drawer>
  );
}

/** Debit note detail with cancel. */
export function ReturnDetailModal({ open, returnId, onClose, onChanged }) {
  const toast = useToast();
  const [r, setR] = useState(null);
  const [reason, setReason] = useState('');
  const [cancelling, setCancelling] = useState(false);
  useEffect(() => {
    purchaseReturnsApi.get(returnId).then(setR).catch(toast.error);
  }, [returnId, toast]);

  async function cancel() {
    try {
      setR(await purchaseReturnsApi.cancel(r.id, reason));
      setCancelling(false);
      toast.success(`${r.return_no} cancelled. Stock and serials are back.`);
      onChanged();
    } catch (e) {
      toast.error(e);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={r ? `Debit note ${r.return_no}` : 'Debit note'}
      width="w-[44rem]"
      footer={
        r && r.status === 'active' ? (
          cancelling ? (
            <>
              <Input
                autoFocus
                value={reason}
                placeholder="Reason for cancelling"
                onChange={(e) => setReason(e.target.value)}
                className="mr-auto w-72"
              />
              <Button onClick={() => setCancelling(false)}>Back</Button>
              <Button variant="danger" disabled={!reason.trim()} onClick={cancel}>
                Cancel debit note
              </Button>
            </>
          ) : (
            <>
              <Button variant="danger-ghost" icon={Ban} onClick={() => setCancelling(true)}>
                Cancel debit note
              </Button>
              <Button onClick={onClose}>Close</Button>
            </>
          )
        ) : (
          <Button onClick={onClose}>Close</Button>
        )
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
              {r.settlement === 'refund' ? 'Refund received' : 'Adjusted against payable'}
            </Badge>
            {r.purchase && <Badge tone="primary">From {r.purchase.entry_no}</Badge>}
          </div>
          <p className="text-muted">
            {r.supplier_name} · {formatDate(r.date)}
            {r.reason ? ` · ${r.reason}` : ''}
          </p>
          <ul className="divide-y divide-border rounded-xl border border-border">
            {r.lines.map((l) => (
              <li key={l.id} className="flex items-start justify-between gap-3 px-3 py-2">
                <div>
                  <div className="font-medium">{l.product_name}</div>
                  <div className="text-xs text-muted">
                    {formatQty(l.qty_milli)} {l.unit} · credit {formatMoney(l.taxable)}
                    {l.gst_rate_bp ? ` + GST ${formatRateBp(l.gst_rate_bp)}` : ''} · stock at{' '}
                    {formatMoney(l.unit_cost)}/unit
                  </div>
                  {l.serials.length > 0 && (
                    <div className="mt-1 font-mono text-xs">
                      {l.serials.map((s) => s.serial_no).join(', ')}
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
          {r.status !== 'active' && <p className="text-danger">Cancelled: {r.cancel_reason}</p>}
        </div>
      )}
    </Modal>
  );
}
