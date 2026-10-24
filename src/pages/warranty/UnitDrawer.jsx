import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle, Ban, ClipboardPlus, IdCard, ReceiptText } from 'lucide-react';
import Button from '../../components/Button';
import { Drawer } from '../../components/Overlay';
import { Skeleton } from '../../components/Feedback';
import { warrantyApi } from '../../api/warranty';
import { formatQty } from '../../utils/qty';
import { formatDate } from '../../utils/dates';
import { PrintPreviewModal } from '../sales/SaleModals';
import { NewClaimModal, VoidModal } from './ClaimModals';
import {
  Card,
  ClaimBadge,
  Info,
  SLIP_FORMATS,
  Timeline,
  WarrantyBadge,
  WarrantyBar,
  cardPrinter,
  daysText,
  useLoad,
} from './shared';

/**
 * Detail card of one unit (serial) or bill line: product, customer, vehicle, bill, customer
 * and supplier warranty, terms, claims and the full timeline. Remounted (key) per open.
 */
export default function UnitDrawer({ open, unitRef, meta, onClose, onChanged, onOpenClaim }) {
  const navigate = useNavigate();
  const { data: u, setData } = useLoad(() => warrantyApi.unit(unitRef), [unitRef]);
  const [modal, setModal] = useState(null);
  const [seq, setSeq] = useState(0);
  const show = (m) => {
    setSeq((n) => n + 1);
    setModal(m);
  };

  return (
    <Drawer
      open={open}
      onClose={onClose}
      width="w-[54rem]"
      title={u ? u.product_name : 'Warranty'}
      subtitle={
        u
          ? [
              u.serial_no
                ? `S/N ${u.serial_no}${u.serial_no_2 ? ` / ${u.serial_no_2}` : ''}`
                : `${formatQty(u.qty_milli)} ${u.unit}`,
              u.variant_label,
              u.brand,
            ]
              .filter(Boolean)
              .join(' · ')
          : 'Loading…'
      }
      footer={
        u && (
          <>
            {u.sale && (
              <Button icon={ReceiptText} onClick={() => navigate(`/sales?open=${u.sale.id}`)}>
                Open bill
              </Button>
            )}
            {u.can.card && (
              <Button icon={IdCard} onClick={() => show('card')}>
                Warranty card
              </Button>
            )}
            <span className="mr-auto" />
            {u.can.void && (
              <Button variant="danger-ghost" icon={Ban} onClick={() => show('void')}>
                Void warranty
              </Button>
            )}
            {u.can.claim && (
              <Button variant="primary" icon={ClipboardPlus} onClick={() => show('claim')}>
                New claim
              </Button>
            )}
          </>
        )
      }
    >
      {!u ? (
        <div className="space-y-3">
          <Skeleton className="h-24" />
          <Skeleton className="h-64" />
        </div>
      ) : (
        <div className="space-y-4">
          <div className="rounded-xl border border-border p-4">
            <div className="flex flex-wrap items-center gap-3">
              <WarrantyBadge status={u.status} />
              {u.is_replacement && (
                <span className="text-xs text-info">Given as a warranty replacement</span>
              )}
              <span className="text-sm text-muted">
                {u.warranty_end
                  ? `${formatDate(u.warranty_start || u.invoice_date)} → ${formatDate(u.warranty_end)} · ${daysText(u.status)}`
                  : 'No customer warranty'}
              </span>
              {u.open_claim && (
                <button
                  type="button"
                  className="ml-auto"
                  onClick={() => onOpenClaim(u.open_claim.id)}
                >
                  <ClaimBadge
                    status={u.open_claim.status}
                    label={`Open claim ${u.open_claim.claim_no}`}
                  />
                </button>
              )}
            </div>
            <div className="mt-3">
              <WarrantyBar status={u.status} />
            </div>
            {u.status.status === 'void' && u.void_note && (
              <p className="mt-2 text-sm text-muted">Void: {u.void_note}</p>
            )}
            {u.replaced_by && (
              <p className="mt-2 text-sm text-muted">Replaced by S/N {u.replaced_by.serial_no}.</p>
            )}
            {u.replaces && (
              <p className="mt-2 text-sm text-muted">Replacement for S/N {u.replaces.serial_no}.</p>
            )}
          </div>

          {u.owner_note && (
            <div className="flex gap-2 rounded-xl bg-warning-soft px-3 py-2.5 text-sm text-warning">
              <AlertTriangle size={16} className="mt-0.5 shrink-0" />
              {u.owner_note.text}
            </div>
          )}

          <div className="grid grid-cols-4 gap-4 rounded-xl border border-border p-3 text-sm">
            <Info label="Customer (buyer)">
              {u.sale ? (
                <button
                  type="button"
                  className="hover:text-primary hover:underline"
                  onClick={() => navigate(`/parties?open=${u.sale.party_id}`)}
                >
                  {u.sale.customer_name}
                </button>
              ) : (
                'Not sold'
              )}
            </Info>
            <Info label="Phone">{u.sale?.customer_phone}</Info>
            <Info label="Vehicle">
              {u.sale?.vehicle_no
                ? `${u.sale.vehicle_no}${u.sale.vehicle_model ? ` · ${u.sale.vehicle_model}` : ''}`
                : null}
            </Info>
            <Info label="Fitted by">{u.fitted_by}</Info>
            <Info label="Bill">
              {u.sale ? (
                <button
                  type="button"
                  className="hover:text-primary hover:underline"
                  onClick={() => navigate(`/sales?open=${u.sale.id}`)}
                >
                  {u.sale.invoice_no}
                </button>
              ) : null}
            </Info>
            <Info label="Sale date">{u.sale && formatDate(u.sale.invoice_date)}</Info>
            <Info label="Category">{u.category_name}</Info>
            <Info label={u.kind === 'line' ? 'Qty (returned / claimed)' : 'SKU'}>
              {u.kind === 'line'
                ? `${formatQty(u.qty_milli)} ${u.unit} (${formatQty(u.returned_milli)} / ${formatQty(u.claimed_milli)})`
                : u.sku}
            </Info>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <Card title="Supplier warranty">
              {u.supplier_warranty && u.supplier_warranty.supplier_name ? (
                <div className="space-y-1 text-sm">
                  <div className="font-medium">{u.supplier_warranty.supplier_name}</div>
                  <div className="text-muted">
                    {[
                      u.supplier_warranty.purchase_entry_no,
                      u.supplier_warranty.purchase_bill_no &&
                        `bill ${u.supplier_warranty.purchase_bill_no}`,
                      u.supplier_warranty.purchase_date &&
                        formatDate(u.supplier_warranty.purchase_date),
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </div>
                  <div className="flex items-center gap-2">
                    {u.supplier_warranty.end ? (
                      <>
                        <WarrantyBadge
                          status={{
                            status: u.supplier_warranty.status,
                            label: {
                              active: 'Active',
                              expiring: 'Expiring soon',
                              expired: 'Expired',
                            }[u.supplier_warranty.status],
                          }}
                        />
                        <span className="text-muted">
                          till {formatDate(u.supplier_warranty.end)}
                        </span>
                      </>
                    ) : (
                      <span className="text-muted">No supplier warranty</span>
                    )}
                  </div>
                </div>
              ) : (
                <p className="text-sm text-muted">
                  {u.kind === 'line'
                    ? 'Not tracked for items without serial numbers.'
                    : 'Opening stock / adjustment: no supplier recorded.'}
                </p>
              )}
            </Card>
            <Card title="Warranty terms">
              {u.terms.covered || u.terms.not_covered ? (
                <div className="space-y-1.5 text-sm whitespace-pre-wrap">
                  {u.terms.covered && (
                    <p>
                      <span className="font-medium text-success">Covered: </span>
                      {u.terms.covered}
                    </p>
                  )}
                  {u.terms.not_covered && (
                    <p>
                      <span className="font-medium text-danger">Not covered: </span>
                      {u.terms.not_covered}
                    </p>
                  )}
                </div>
              ) : (
                <p className="text-sm text-muted">
                  No terms on this product (Products → Warranty).
                </p>
              )}
            </Card>
          </div>

          {u.claims.length > 0 && (
            <Card title={`Claims (${u.claims.length})`}>
              <ul className="divide-y divide-border text-sm">
                {u.claims.map((c) => (
                  <li key={c.id}>
                    <button
                      type="button"
                      onClick={() => onOpenClaim(c.id)}
                      className="flex w-full items-center gap-3 px-1 py-1.5 text-left hover:bg-surface-2"
                    >
                      <span className="w-20 font-mono text-xs">{c.claim_no}</span>
                      <span className="w-24 text-muted">{formatDate(c.received_date)}</span>
                      <span className="min-w-0 flex-1 truncate">{c.complaint}</span>
                      <ClaimBadge status={c.status} label={meta.statuses[c.status]} />
                    </button>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          <Card title="History">
            <Timeline items={u.timeline} />
          </Card>
        </div>
      )}

      {u && modal === 'claim' && (
        <NewClaimModal
          key={`c${seq}`}
          open
          unitRef={unitRef}
          meta={meta}
          onClose={() => setModal(null)}
          onCreated={(c) => {
            setModal(null);
            onChanged();
            onOpenClaim(c.id, { printSlip: true });
          }}
        />
      )}
      {u && modal === 'void' && (
        <VoidModal
          key={`v${seq}`}
          open
          unitRef={unitRef}
          meta={meta}
          onClose={() => setModal(null)}
          onDone={(next) => {
            setModal(null);
            setData(next);
            onChanged();
          }}
        />
      )}
      {u && modal === 'card' && (
        <PrintPreviewModal
          key={`p${seq}`}
          open
          api={cardPrinter}
          formats={SLIP_FORMATS}
          defaultFormat={meta.claim_slip_format}
          id={unitRef}
          title={`Warranty card · ${u.product_name}`}
          onClose={() => setModal(null)}
        />
      )}
    </Drawer>
  );
}
