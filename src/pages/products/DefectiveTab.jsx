import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { PackageX, Search, Truck, Wrench, XCircle } from 'lucide-react';
import Button from '../../components/Button';
import { Modal } from '../../components/Overlay';
import { Field, Input, Textarea } from '../../components/Field';
import { Badge, EmptyState, Skeleton } from '../../components/Feedback';
import { useToast } from '../../components/Toast';
import { defectiveApi, warrantyApi } from '../../api/warranty';
import { formatMoney } from '../../utils/money';
import { formatQty, parseQty } from '../../utils/qty';
import { formatDate } from '../../utils/dates';
import { DispatchFields } from '../warranty/ClaimModals';

const ACTIONS = {
  write_off: { title: 'Write off', label: 'Write off', icon: XCircle, danger: true },
  repair: { title: 'Repaired: back to sellable stock', label: 'Back to stock', icon: Wrench },
  send: { title: 'Send to supplier (claim)', label: 'Send', icon: Truck },
};

/** Write off / repair / send to supplier for one defective unit or a quantity. */
function ActionModal({ action, row, serial, suppliers, onClose, onDone }) {
  const toast = useToast();
  const navigate = useNavigate();
  const a = ACTIONS[action];
  const [qty, setQty] = useState(formatQty(row.qty_milli));
  const [reason, setReason] = useState('');
  const [dispatch, setDispatch] = useState({
    supplier_party_id: String(serial?.supplier_party_id || row.last_supplier_id || ''),
    mode: 'hand',
    courier: '',
    docket_no: '',
    expected_date: '',
  });
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState({});

  async function save() {
    const ref = serial
      ? { serial_id: serial.id }
      : { variant_id: row.variant_id, qty_milli: parseQty(qty) };
    if (!serial && !ref.qty_milli) {
      toast.error('Enter the quantity.');
      return;
    }
    setBusy(true);
    setErrors({});
    try {
      if (action === 'send') {
        const c = await defectiveApi.sendToSupplier({
          ...ref,
          complaint: reason,
          supplier_party_id: dispatch.supplier_party_id ? Number(dispatch.supplier_party_id) : null,
          mode: dispatch.mode,
          courier: dispatch.courier,
          docket_no: dispatch.docket_no,
          expected_date: dispatch.expected_date || null,
        });
        toast.success(`Claim ${c.claim_no}: sent to the supplier.`);
        onDone();
        navigate(`/warranty?claim=${c.id}`);
        return;
      }
      await (action === 'write_off' ? defectiveApi.writeOff : defectiveApi.repair)({
        ...ref,
        reason,
      });
      toast.success(action === 'write_off' ? 'Written off.' : 'Back in sellable stock.');
      onDone();
    } catch (e) {
      if (e.fields) setErrors(e.fields);
      toast.error(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={a.title}
      width="w-[38rem]"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant={a.danger ? 'danger' : 'primary'}
            icon={a.icon}
            disabled={busy}
            onClick={save}
          >
            {a.label}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="rounded-lg bg-surface-2 px-3 py-2 text-sm">
          <strong>{row.product_name}</strong>
          {row.variant_label ? ` · ${row.variant_label}` : ''}
          {serial
            ? ` · S/N ${serial.serial_no}`
            : ` · ${formatQty(row.qty_milli)} ${row.unit} defective`}
        </p>
        {!serial && (
          <Field label={`Quantity (${row.unit})`} error={errors.qty_milli}>
            {(id) => (
              <Input
                id={id}
                className="w-32"
                value={qty}
                onChange={(e) => setQty(e.target.value)}
              />
            )}
          </Field>
        )}
        <Field
          label={action === 'send' ? 'Fault' : 'Reason'}
          required
          error={errors.reason || errors.complaint}
        >
          {(id) => (
            <Textarea
              id={id}
              autoFocus
              rows={2}
              maxLength={action === 'send' ? 500 : 200}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          )}
        </Field>
        {action === 'send' && (
          <DispatchFields
            value={dispatch}
            onChange={setDispatch}
            suppliers={suppliers}
            errors={errors}
          />
        )}
        {action === 'write_off' && (
          <p className="text-xs text-muted">Its cost is recorded as a loss.</p>
        )}
      </div>
    </Modal>
  );
}

/** Products & Stock → Defective: units kept out of sellable stock. */
export default function DefectiveTab({ onChanged }) {
  const toast = useToast();
  const [search, setSearch] = useState('');
  const [result, setResult] = useState({ key: null, data: null });
  const [reload, setReload] = useState(0);
  const [suppliers, setSuppliers] = useState([]);
  const [action, setAction] = useState(null); // { action, row, serial }
  const key = JSON.stringify([search.trim(), reload]);
  const data = result.data;

  useEffect(() => {
    warrantyApi
      .meta()
      .then((m) => setSuppliers(m.suppliers))
      .catch(() => {});
  }, []);
  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(() => {
      defectiveApi
        .list(search.trim())
        .then((d) => !cancelled && setResult({ key, data: d }))
        .catch(toast.error);
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, toast]);

  const [seq, setSeq] = useState(0);
  const act = (a, row, serial = null) => {
    setSeq((n) => n + 1);
    setAction({ action: a, row, serial });
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative min-w-60 flex-1">
          <Search
            size={16}
            className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted"
          />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search product, SKU or serial…"
            className="pl-9"
          />
        </div>
        {data && (
          <div className="text-sm text-muted">
            {formatQty(data.total_units)} unit(s) · value {formatMoney(data.total_value)}
          </div>
        )}
      </div>
      <p className="text-xs text-muted">
        Defective units never count as sellable stock. Faulty units taken back on a warranty claim
        come in at no value (the replacement is the loss).
      </p>

      {!data ? (
        <Skeleton className="h-48" />
      ) : data.rows.length === 0 ? (
        <div className="rounded-2xl border border-border bg-surface">
          <EmptyState icon={PackageX} title="No defective stock">
            Units marked defective, returned faulty or taken back on a warranty claim appear here.
          </EmptyState>
        </div>
      ) : (
        <div className={`space-y-3 transition-opacity ${result.key !== key ? 'opacity-60' : ''}`}>
          {data.rows.map((r) => (
            <section
              key={r.variant_id}
              className="rounded-2xl border border-border bg-surface p-4 shadow-sm"
            >
              <div className="flex flex-wrap items-center gap-3">
                <div className="min-w-0 flex-1">
                  <div className="font-semibold">
                    {r.product_name}
                    {r.variant_label && (
                      <span className="font-normal text-muted"> · {r.variant_label}</span>
                    )}
                  </div>
                  <div className="text-xs text-muted">
                    {r.sku}
                    {r.brand ? ` · ${r.brand}` : ''}
                  </div>
                </div>
                <Badge tone="danger">
                  {formatQty(r.qty_milli)} {r.unit} defective
                </Badge>
                <span className="text-sm text-muted tabular-nums">{formatMoney(r.value)}</span>
                {!r.track_serials && (
                  <div className="flex gap-1">
                    <Button size="sm" icon={Truck} onClick={() => act('send', r)}>
                      Send to supplier
                    </Button>
                    <Button size="sm" icon={Wrench} onClick={() => act('repair', r)}>
                      Repaired
                    </Button>
                    <Button
                      size="sm"
                      variant="danger-ghost"
                      icon={XCircle}
                      onClick={() => act('write_off', r)}
                    >
                      Write off
                    </Button>
                  </div>
                )}
              </div>
              {r.serials.length > 0 && (
                <table className="mt-3 w-full text-sm">
                  <tbody className="divide-y divide-border">
                    {r.serials.map((s) => (
                      <tr key={s.id}>
                        <td className="py-1.5 font-mono">{s.serial_no}</td>
                        <td className="py-1.5 text-xs text-muted">
                          {s.since && `since ${formatDate(s.since)}`}
                          {s.claim_no ? ` · from ${s.claim_no}` : ''}
                          {s.last_note ? ` · ${s.last_note}` : ''}
                        </td>
                        <td className="py-1.5 text-xs">
                          {s.supplier_name ? (
                            <span
                              className={s.supplier_warranty_active ? 'text-success' : 'text-muted'}
                            >
                              {s.supplier_name}
                              {s.supplier_warranty_end
                                ? ` · supplier warranty till ${formatDate(s.supplier_warranty_end)}`
                                : ''}
                            </span>
                          ) : (
                            <span className="text-muted">No supplier</span>
                          )}
                        </td>
                        <td className="py-1.5">
                          <div className="flex justify-end gap-1">
                            <Button size="sm" icon={Truck} onClick={() => act('send', r, s)}>
                              Send
                            </Button>
                            <Button size="sm" icon={Wrench} onClick={() => act('repair', r, s)}>
                              Repaired
                            </Button>
                            <Button
                              size="sm"
                              variant="danger-ghost"
                              icon={XCircle}
                              onClick={() => act('write_off', r, s)}
                            >
                              Write off
                            </Button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>
          ))}
        </div>
      )}

      {action && (
        <ActionModal
          key={seq}
          action={action.action}
          row={action.row}
          serial={action.serial}
          suppliers={suppliers}
          onClose={() => setAction(null)}
          onDone={() => {
            setAction(null);
            setReload((n) => n + 1);
            onChanged?.();
          }}
        />
      )}
    </div>
  );
}
