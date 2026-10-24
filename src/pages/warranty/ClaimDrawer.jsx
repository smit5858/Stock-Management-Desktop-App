import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AlertTriangle,
  Ban,
  Camera,
  CheckCircle2,
  ClipboardCheck,
  FileText,
  PackageCheck,
  Printer,
  ReceiptText,
  Search,
  Trash2,
  Truck,
  Wrench,
} from 'lucide-react';
import Button from '../../components/Button';
import { Drawer } from '../../components/Overlay';
import { Badge, Skeleton } from '../../components/Feedback';
import { useToast } from '../../components/Toast';
import { claimsApi } from '../../api/warranty';
import { formatMoney } from '../../utils/money';
import { formatQty } from '../../utils/qty';
import { formatDate, formatDateTime } from '../../utils/dates';
import { PrintPreviewModal } from '../sales/SaleModals';
import {
  DecideModal,
  DispatchModal,
  HandoverModal,
  InspectModal,
  ReasonModal,
  RepairDoneModal,
  ReplaceModal,
  SupplierResultModal,
} from './ClaimModals';
import { Card, ClaimBadge, Info, SLIP_FORMATS, Timeline, slipPrinter, useLoad } from './shared';

const KIND_LABEL = {
  replacement: 'Replacement given',
  parts: 'Parts used',
  labour: 'Labour',
  write_off: 'Written off',
  supplier_replacement: 'Good unit from supplier',
  supplier_credit: 'Supplier credit note',
  repaired_to_stock: 'Repaired back to stock',
};

/** What to do next, by status (shown as a hint above the details). */
function nextStep(c) {
  if (c.overdue)
    return `Overdue at ${c.at_supplier.supplier_name}: expected ${formatDate(c.at_supplier.expected_date)}. Follow up with the supplier.`;
  return {
    received: 'Inspect the item, then decide: repair, send to supplier, replace, refund or reject.',
    inspecting: 'Take a decision for this claim.',
    repairing: c.chargeable
      ? 'Repair it, record parts and labour, then create the bill.'
      : 'Repair it and record the parts used.',
    at_supplier:
      'Waiting for the supplier. Record the result when the unit (or a credit) comes back.',
    awaiting_replacement: 'Give the customer a replacement from stock (or refund).',
    ready: c.unbilled
      ? 'Create the bill, then hand it over to the customer.'
      : 'Ready for pickup: hand it over to the customer.',
    rejected: 'Claim rejected: return the unit to the customer (print the rejection slip).',
    returned: 'Handed over. Close the claim.',
  }[c.status];
}

export default function ClaimDrawer({
  open,
  claimId,
  meta,
  printSlip = false,
  onClose,
  onChanged,
  onOpenUnit,
}) {
  const toast = useToast();
  const navigate = useNavigate();
  const { data: c, setData, reload } = useLoad(() => claimsApi.get(claimId), [claimId]);
  const [modal, setModal] = useState(printSlip ? { kind: 'print', doc: 'slip' } : null);
  const [seq, setSeq] = useState(0);
  const [printMenu, setPrintMenu] = useState(false);

  const show = (kind, extra = {}) => {
    setSeq((n) => n + 1);
    setPrintMenu(false);
    setModal({ kind, ...extra });
  };
  const done = (next) => {
    setModal(null);
    if (next && next.claim_no) setData(next);
    else reload();
    onChanged();
  };

  useEffect(() => {
    if (!printMenu) return undefined;
    const close = () => setPrintMenu(false);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [printMenu]);

  async function addPhotos() {
    try {
      const picked = await claimsApi.pickPhotos();
      if (picked.length) done(await claimsApi.addAttachments(c.id, picked));
    } catch (e) {
      toast.error(e);
    }
  }
  async function removePhoto(id) {
    try {
      done(await claimsApi.removeAttachment(id));
    } catch (e) {
      toast.error(e);
    }
  }

  const can = c?.can || {};
  return (
    <Drawer
      open={open}
      onClose={onClose}
      width="w-[60rem]"
      title={c ? `Claim ${c.claim_no}` : 'Claim'}
      subtitle={
        c
          ? [
              c.product.name,
              c.serial
                ? `S/N ${c.serial.serial_no}`
                : `${formatQty(c.qty_milli)} ${c.product.unit}`,
              c.kind === 'stock' ? 'Shop stock' : c.customer_name,
              c.vehicle_no,
            ]
              .filter(Boolean)
              .join(' · ')
          : 'Loading…'
      }
      footer={
        c && (
          <>
            <div className="relative">
              <Button
                icon={Printer}
                onClick={(e) => {
                  e.stopPropagation();
                  setPrintMenu((v) => !v);
                }}
              >
                Print
              </Button>
              {printMenu && (
                <div className="absolute bottom-11 left-0 z-10 w-56 rounded-xl border border-border bg-surface p-1 shadow-xl">
                  {[
                    ['slip', 'Claim slip / job card', true],
                    ['rejection', 'Rejection slip', can.print_rejection],
                    ['handover', 'Handover slip', can.print_handover],
                  ]
                    .filter((x) => x[2])
                    .map(([doc, label]) => (
                      <button
                        key={doc}
                        type="button"
                        className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-surface-2"
                        onClick={() => show('print', { doc })}
                      >
                        <FileText size={14} /> {label}
                      </button>
                    ))}
                </div>
              )}
            </div>
            {can.cancel && (
              <Button variant="danger-ghost" icon={Ban} onClick={() => show('cancel')}>
                Cancel claim
              </Button>
            )}
            <span className="mr-auto" />
            {can.bill && (
              <Button
                icon={ReceiptText}
                onClick={() => navigate('/billing', { state: { claim: c.id } })}
              >
                Create bill
              </Button>
            )}
            {can.dispatch && c.status === 'repairing' && (
              <Button icon={Truck} onClick={() => show('dispatch')}>
                Send to supplier
              </Button>
            )}
            {can.inspect && (
              <Button icon={Search} onClick={() => show('inspect')}>
                Inspect
              </Button>
            )}
            {can.decide && (
              <Button variant="primary" icon={ClipboardCheck} onClick={() => show('decide')}>
                Decide
              </Button>
            )}
            {can.repair_done && (
              <Button variant="primary" icon={Wrench} onClick={() => show('repair')}>
                Repair done
              </Button>
            )}
            {can.supplier_result && (
              <Button variant="primary" icon={Truck} onClick={() => show('result')}>
                Supplier result
              </Button>
            )}
            {can.replace && (
              <Button variant="primary" icon={PackageCheck} onClick={() => show('replace')}>
                Give replacement
              </Button>
            )}
            {can.handover && (
              <Button variant="primary" icon={CheckCircle2} onClick={() => show('handover')}>
                Hand over
              </Button>
            )}
            {can.close && (
              <Button
                variant="primary"
                icon={CheckCircle2}
                onClick={() =>
                  claimsApi
                    .close({ id: c.id })
                    .then((n) => {
                      toast.success('Claim closed.');
                      done(n);
                    })
                    .catch(toast.error)
                }
              >
                Close claim
              </Button>
            )}
          </>
        )
      }
    >
      {!c ? (
        <div className="space-y-3">
          <Skeleton className="h-20" />
          <Skeleton className="h-72" />
        </div>
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <ClaimBadge status={c.status} label={c.status_label} overdue={c.overdue} />
            {c.kind === 'stock' && <Badge tone="info">Defective stock → supplier</Badge>}
            {c.kind === 'customer' &&
              (c.chargeable ? (
                <Badge tone="warning">Chargeable repair</Badge>
              ) : (
                <Badge tone="success">In warranty</Badge>
              ))}
            {c.decision_label && <Badge>{c.decision_label}</Badge>}
            {c.outcome_label && <Badge tone="primary">{c.outcome_label}</Badge>}
            <span className="ml-auto text-xs text-muted">
              {c.days_open} day{c.days_open === 1 ? '' : 's'} {c.closed_date ? 'to close' : 'open'}
            </span>
          </div>
          {nextStep(c) && (
            <div
              className={`flex gap-2 rounded-xl px-3 py-2.5 text-sm ${c.overdue ? 'bg-danger-soft text-danger' : 'bg-primary-soft text-primary'}`}
            >
              {c.overdue && <AlertTriangle size={16} className="mt-0.5 shrink-0" />}
              {nextStep(c)}
            </div>
          )}
          {c.status === 'cancelled' && (
            <div className="rounded-xl bg-danger-soft px-3 py-2.5 text-sm text-danger">
              Cancelled {formatDateTime(c.cancelled_at)}: {c.cancel_reason}
            </div>
          )}
          {c.ownership_note && (
            <div className="rounded-xl bg-warning-soft px-3 py-2.5 text-sm text-warning">
              {c.ownership_note}
            </div>
          )}

          <div className="grid grid-cols-4 gap-4 rounded-xl border border-border p-3 text-sm">
            <Info label="Customer (buyer)">
              {c.kind === 'stock' ? 'Shop stock' : c.customer_name}
            </Info>
            <Info label="Phone">{c.customer_phone_display}</Info>
            <Info label="Vehicle">
              {c.vehicle_no
                ? `${c.vehicle_no}${c.vehicle_model ? ` · ${c.vehicle_model}` : ''}`
                : null}
            </Info>
            <Info label="Brought by">
              {c.brought_by_name
                ? `${c.brought_by_name}${c.brought_by_phone_display ? ` · ${c.brought_by_phone_display}` : ''}`
                : null}
            </Info>
            <Info label="Product">
              <button
                type="button"
                className="hover:text-primary hover:underline"
                onClick={() =>
                  c.serial || c.sale_item_id
                    ? onOpenUnit(
                        c.serial ? { serial_id: c.serial.id } : { sale_item_id: c.sale_item_id },
                      )
                    : null
                }
              >
                {c.product.name}
              </button>
            </Info>
            <Info label={c.serial ? 'Serial no.' : 'Quantity'}>
              {c.serial ? c.serial.serial_no : `${formatQty(c.qty_milli)} ${c.product.unit}`}
            </Info>
            <Info label="Bill">
              {c.sale ? (
                <button
                  type="button"
                  className="hover:text-primary hover:underline"
                  onClick={() => navigate(`/sales?open=${c.sale.id}`)}
                >
                  {c.sale.invoice_no}
                </button>
              ) : null}
            </Info>
            <Info label="Warranty at receipt">
              {c.warranty_end
                ? `till ${formatDate(c.warranty_end)}`
                : c.kind === 'stock'
                  ? 'Supplier'
                  : 'None'}
            </Info>
            <Info label="Received">{`${formatDate(c.received_date)}${c.received_by ? ` · ${c.received_by}` : ''}`}</Info>
            <Info label="Expected">{c.expected_date && formatDate(c.expected_date)}</Info>
            <Info label="Supplier">{c.supplier?.name}</Info>
            <Info label="Fitted by">{c.fitted_by}</Info>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <Card title="Complaint">
              <p className="text-sm whitespace-pre-wrap">{c.complaint}</p>
              {c.complaint_tags.length > 0 && c.complaint !== c.complaint_tags.join(', ') && (
                <div className="mt-2 flex flex-wrap gap-1">
                  {c.complaint_tags.map((t) => (
                    <Badge key={t}>{t}</Badge>
                  ))}
                </div>
              )}
              {c.condition_notes && (
                <p className="mt-2 text-sm text-muted">Condition: {c.condition_notes}</p>
              )}
              {c.accessories.length > 0 && (
                <p className="mt-1 text-sm text-muted">Received with: {c.accessories.join(', ')}</p>
              )}
            </Card>
            <Card title="Inspection & result">
              <div className="space-y-1 text-sm">
                {c.inspection_notes ? (
                  <p>{c.inspection_notes}</p>
                ) : (
                  <p className="text-muted">Not inspected yet.</p>
                )}
                {c.reject_reason_label && (
                  <p className="text-danger">
                    Rejected: {c.reject_reason_label}
                    {c.reject_notes ? ` · ${c.reject_notes}` : ''}
                  </p>
                )}
                {c.repair_notes && <p>Work done: {c.repair_notes}</p>}
                {c.replacement && (
                  <p>
                    Replacement S/N <span className="font-mono">{c.replacement.serial_no}</span>
                    {c.replacement_warranty_end
                      ? ` · warranty till ${formatDate(c.replacement_warranty_end)} (${c.replacement_mode})`
                      : ''}
                    {c.replacement_reason ? ` · ${c.replacement_reason}` : ''}
                  </p>
                )}
                {c.credit_note && (
                  <p>
                    Credit note {c.credit_note.return_no} · {formatMoney(c.credit_note.total)}
                  </p>
                )}
                {c.bill && (
                  <button
                    type="button"
                    className="text-primary hover:underline"
                    onClick={() => navigate(`/sales?open=${c.bill.id}`)}
                  >
                    Bill {c.bill.invoice_no} · {formatMoney(c.bill.grand_total)}
                    {c.bill.status === 'cancelled' ? ' (cancelled)' : ''}
                  </button>
                )}
                {c.handover_date && (
                  <p className="text-muted">
                    Handed over {formatDate(c.handover_date)}
                    {c.handed_over_by ? ` by ${c.handed_over_by}` : ''}
                    {c.final_notes ? ` · ${c.final_notes}` : ''}
                  </p>
                )}
              </div>
            </Card>
          </div>

          {c.dispatches.length > 0 && (
            <Card title="Supplier">
              <table className="w-full text-sm">
                <thead className="text-left text-xs text-muted">
                  <tr>
                    <th className="py-1 font-medium">Supplier</th>
                    <th className="py-1 font-medium">Sent</th>
                    <th className="py-1 font-medium">By</th>
                    <th className="py-1 font-medium">Expected</th>
                    <th className="py-1 font-medium">Result</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {c.dispatches.map((d) => (
                    <tr key={d.id} className={d.overdue ? 'text-danger' : ''}>
                      <td className="py-1.5">{d.supplier_name}</td>
                      <td className="py-1.5">{formatDate(d.dispatch_date)}</td>
                      <td className="py-1.5">
                        {d.mode_label}
                        {d.courier ? ` · ${d.courier}` : ''}
                        {d.docket_no ? ` #${d.docket_no}` : ''}
                      </td>
                      <td className="py-1.5">
                        {d.expected_date ? formatDate(d.expected_date) : '—'}
                      </td>
                      <td className="py-1.5">
                        {d.status === 'at_supplier' ? (
                          <Badge tone={d.overdue ? 'danger' : 'info'}>
                            {d.overdue ? 'Overdue' : 'At supplier'}
                          </Badge>
                        ) : (
                          <span>
                            {
                              {
                                repaired: 'Repaired',
                                replaced: 'Replaced',
                                credit: 'Credit note',
                                rejected: 'Rejected',
                              }[d.result]
                            }{' '}
                            · {formatDate(d.result_date)}
                            {d.new_serial_no ? ` · new S/N ${d.new_serial_no}` : ''}
                            {d.credit_amount != null ? ` · ${formatMoney(d.credit_amount)}` : ''}
                            {d.credit_ref ? ` (${d.credit_ref})` : ''}
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          )}

          {c.parts.length > 0 && (
            <Card title={c.chargeable ? 'Parts (to bill)' : 'Parts used'}>
              <ul className="space-y-1 text-sm">
                {c.parts.map((p) => (
                  <li key={p.id} className="flex justify-between">
                    <span>
                      {p.product_name}
                      {p.variant_label ? ` · ${p.variant_label}` : ''} × {formatQty(p.qty_milli)}{' '}
                      {p.unit}
                    </span>
                    <span className="text-muted tabular-nums">
                      {formatMoney(Math.round((p.qty_milli * p.unit_cost) / 1000))} cost
                    </span>
                  </li>
                ))}
              </ul>
              {c.labour_amount > 0 && (
                <p className="mt-1 text-sm">Labour {formatMoney(c.labour_amount)}</p>
              )}
            </Card>
          )}

          <div className="grid grid-cols-2 gap-4">
            <Card title="Money">
              <div className="grid grid-cols-3 gap-2 text-center">
                <div className="rounded-lg bg-danger-soft p-2">
                  <div className="text-xs text-danger">Cost to me</div>
                  <div className="font-semibold text-danger tabular-nums">
                    {formatMoney(c.money.cost)}
                  </div>
                </div>
                <div className="rounded-lg bg-success-soft p-2">
                  <div className="text-xs text-success">Recovered</div>
                  <div className="font-semibold text-success tabular-nums">
                    {formatMoney(c.money.recovered)}
                  </div>
                </div>
                <div className="rounded-lg bg-surface-2 p-2">
                  <div className="text-xs text-muted">Net loss</div>
                  <div className="font-semibold tabular-nums">{formatMoney(c.money.net_loss)}</div>
                </div>
              </div>
              {c.money.rows.length > 0 && (
                <ul className="mt-2 space-y-0.5 text-xs text-muted">
                  {c.money.rows.map((r) => (
                    <li key={r.id} className="flex justify-between">
                      <span>
                        {formatDate(r.date)} · {KIND_LABEL[r.kind]}
                        {r.ref_no ? ` (${r.ref_no})` : ''}
                      </span>
                      <span
                        className={`tabular-nums ${r.direction === 'cost' ? 'text-danger' : 'text-success'}`}
                      >
                        {r.direction === 'cost' ? '−' : '+'}
                        {formatMoney(r.amount)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
            <Card
              title={`Photos (${c.attachments.length})`}
              right={
                c.status !== 'cancelled' && (
                  <Button size="sm" variant="ghost" icon={Camera} onClick={addPhotos}>
                    Add
                  </Button>
                )
              }
            >
              {c.attachments.length === 0 ? (
                <p className="text-sm text-muted">No photos.</p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {c.attachments.map((a) => (
                    <div key={a.id} className="group relative">
                      <button
                        type="button"
                        title={a.original_name}
                        onClick={() => claimsApi.openAttachment({ id: a.id }).catch(toast.error)}
                      >
                        {/\.(png|jpe?g|webp)$/i.test(a.file_path) ? (
                          <img
                            src={a.url}
                            alt=""
                            className="h-16 w-16 rounded-lg border border-border object-cover"
                          />
                        ) : (
                          <div className="flex h-16 w-16 items-center justify-center rounded-lg border border-border text-xs text-muted">
                            PDF
                          </div>
                        )}
                      </button>
                      <button
                        type="button"
                        title="Remove"
                        onClick={() => removePhoto(a.id)}
                        className="absolute -top-1.5 -right-1.5 rounded-full bg-danger p-0.5 text-white opacity-0 group-hover:opacity-100"
                      >
                        <Trash2 size={11} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          </div>

          <Card title="Timeline">
            <Timeline items={c.events.map((e) => ({ ...e, key: e.id, source: 'claim' }))} />
          </Card>
        </div>
      )}

      {c && modal?.kind === 'inspect' && (
        <InspectModal key={`i${seq}`} open claim={c} onClose={() => setModal(null)} onDone={done} />
      )}
      {c && modal?.kind === 'decide' && (
        <DecideModal
          key={`d${seq}`}
          open
          claim={c}
          meta={meta}
          onClose={() => setModal(null)}
          onDone={done}
        />
      )}
      {c && modal?.kind === 'repair' && (
        <RepairDoneModal
          key={`r${seq}`}
          open
          claim={c}
          onClose={() => setModal(null)}
          onDone={done}
        />
      )}
      {c && modal?.kind === 'dispatch' && (
        <DispatchModal
          key={`s${seq}`}
          open
          claim={c}
          meta={meta}
          onClose={() => setModal(null)}
          onDone={done}
        />
      )}
      {c && modal?.kind === 'result' && (
        <SupplierResultModal
          key={`x${seq}`}
          open
          claim={c}
          meta={meta}
          onClose={() => setModal(null)}
          onDone={done}
        />
      )}
      {c && modal?.kind === 'replace' && (
        <ReplaceModal
          key={`p${seq}`}
          open
          claim={c}
          meta={meta}
          onClose={() => setModal(null)}
          onDone={done}
        />
      )}
      {c && modal?.kind === 'handover' && (
        <HandoverModal
          key={`h${seq}`}
          open
          claim={c}
          onClose={() => setModal(null)}
          onDone={done}
        />
      )}
      {c && modal?.kind === 'cancel' && (
        <ReasonModal
          key={`k${seq}`}
          open
          title={`Cancel claim ${c.claim_no}`}
          confirmLabel="Cancel claim"
          danger
          onClose={() => setModal(null)}
          onSubmit={(reason) =>
            claimsApi.cancel(c.id, reason).then((n) => {
              toast.success('Claim cancelled. Its number is kept.');
              done(n);
            })
          }
        />
      )}
      {c && modal?.kind === 'print' && (
        <PrintPreviewModal
          key={`v${seq}`}
          open
          api={slipPrinter(modal.doc)}
          formats={SLIP_FORMATS}
          defaultFormat={meta.claim_slip_format}
          id={c.id}
          title={`${{ slip: 'Claim slip', rejection: 'Rejection slip', handover: 'Handover slip' }[modal.doc]} · ${c.claim_no}`}
          onClose={() => setModal(null)}
        />
      )}
    </Drawer>
  );
}
