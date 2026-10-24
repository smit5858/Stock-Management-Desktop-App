import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle, ArrowRightLeft, Package } from 'lucide-react';
import Button from '../../components/Button';
import { Field, Input, Segmented, Textarea, Toggle } from '../../components/Field';
import { Badge, EmptyState, Skeleton } from '../../components/Feedback';
import { Modal } from '../../components/Overlay';
import CustomerPicker from '../../components/CustomerPicker';
import VehicleModelPicker from '../../components/VehicleModelPicker';
import { useToast } from '../../components/Toast';
import { vehiclesApi } from '../../api/parties';
import { formatPlate, normalizePlate, plateFormatLabel } from '../../utils/identity';
import { formatMoney } from '../../utils/money';
import { formatQty } from '../../utils/qty';
import { formatDate, todayISO } from '../../utils/dates';
import { ExistsNote } from './PartyForm';
import { FUELS, emptyVehicle, vehiclePayload, vehicleToForm } from './form';

/** Add / edit a vehicle of a customer. Remounted (key) on every open. */
export function VehicleModal({
  open,
  customerId,
  vehicle,
  models,
  onModelsChanged,
  onClose,
  onSaved,
  onOpenParty,
}) {
  const toast = useToast();
  const [form, setForm] = useState(() => (vehicle ? vehicleToForm(vehicle) : emptyVehicle()));
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const [check, setCheck] = useState(null);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const key = normalizePlate(form.plate_no);

  useEffect(() => {
    let cancelled = false;
    if (key.length < 2) return undefined;
    const t = setTimeout(() => {
      vehiclesApi
        .check(key, form.id)
        .then((r) => !cancelled && setCheck(r))
        .catch(() => {});
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [key, form.id]);
  const live = check && check.plate_key === key ? check : null;

  async function save() {
    setBusy(true);
    try {
      const payload = vehiclePayload(form);
      const r = form.id
        ? await vehiclesApi.update(form.id, payload)
        : await vehiclesApi.create(customerId, payload);
      for (const w of r.warnings || []) toast.info(w);
      toast.success(form.id ? 'Vehicle updated.' : `Vehicle ${r.plate_display} added.`);
      onSaved(r);
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
      title={form.id ? 'Edit vehicle' : 'Add vehicle'}
      width="w-[36rem]"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={busy || Boolean(live?.owner)} onClick={save}>
            {busy ? 'Saving…' : form.id ? 'Save' : 'Add vehicle'}
          </Button>
        </>
      }
    >
      <form
        className="grid grid-cols-2 gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <div className="col-span-2">
          <Field label="Number plate" required error={errors.plate_no}>
            {(id) => (
              <Input
                id={id}
                autoFocus
                value={form.plate_no}
                placeholder="GJ 03 AB 1234 or 22 BH 1234 AA"
                className="font-mono text-base uppercase"
                invalid={Boolean(errors.plate_no || live?.owner)}
                onChange={(e) => set('plate_no', e.target.value)}
                onBlur={() => key && set('plate_no', formatPlate(key))}
              />
            )}
          </Field>
          {live?.owner && (
            <ExistsNote
              owner={{
                id: live.owner.customer_id,
                name: live.owner.customer_name,
                phone_display: live.owner.phone_display,
              }}
              prefix={`${live.display} belongs to`}
              onOpen={onOpenParty}
            />
          )}
          {live && !live.owner && key.length >= 4 && live.format === 'other' && (
            <p className="mt-1 flex items-center gap-1.5 text-xs text-warning">
              <AlertTriangle size={12} /> Not a known plate format. It will be saved as typed.
            </p>
          )}
          {live && !live.owner && live.format !== 'other' && key.length >= 4 && (
            <p className="mt-1 text-xs text-success">
              {live.display} · {plateFormatLabel(live.format)}
            </p>
          )}
          <p className="mt-1 text-xs text-muted">
            Standard, BH, old series (MHU 1234), defence, diplomatic (77 CD 12), temporary (T 0124
            GJ 1234 AB) and vintage plates are recognised.
          </p>
        </div>
        <Field label="Make / model" className="col-span-2" error={errors.vehicle_model_id}>
          {() => (
            <VehicleModelPicker
              models={models}
              value={form.vehicle_model_id}
              onChange={(v) => set('vehicle_model_id', v)}
              onCreated={onModelsChanged}
            />
          )}
        </Field>
        <Field label="Variant" error={errors.variant}>
          {(id) => (
            <Input
              id={id}
              value={form.variant}
              placeholder="e.g. VXi, ZXi+"
              onChange={(e) => set('variant', e.target.value)}
            />
          )}
        </Field>
        <Field label="Year" error={errors.year}>
          {(id) => (
            <Input
              id={id}
              inputMode="numeric"
              maxLength={4}
              value={form.year}
              onChange={(e) => set('year', e.target.value.replace(/\D/g, ''))}
            />
          )}
        </Field>
        <Field label="Fuel" className="col-span-2" error={errors.fuel}>
          {() => (
            <Segmented
              layoutId="vehicle-fuel"
              value={form.fuel}
              onChange={(v) => set('fuel', form.fuel === v ? '' : v)}
              options={FUELS}
            />
          )}
        </Field>
        <Field label="Colour" error={errors.color}>
          {(id) => (
            <Input id={id} value={form.color} onChange={(e) => set('color', e.target.value)} />
          )}
        </Field>
        <div className="flex items-end">
          <Toggle
            label="Primary vehicle"
            checked={form.is_primary}
            onChange={(v) => set('is_primary', v)}
          />
        </div>
        <Field label="Notes" className="col-span-2" error={errors.notes}>
          {(id) => (
            <Textarea
              id={id}
              rows={2}
              value={form.notes}
              onChange={(e) => set('notes', e.target.value)}
            />
          )}
        </Field>
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

/** Car sold: move it to another customer. History stays (vehicle_owners). */
export function TransferModal({ open, vehicle, onClose, onDone }) {
  const toast = useToast();
  const [target, setTarget] = useState(null);
  const [date, setDate] = useState(todayISO());
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState(null);

  useEffect(() => {
    if (!vehicle) return;
    vehiclesApi
      .history(vehicle.id)
      .then(setHistory)
      .catch(() => setHistory([]));
  }, [vehicle]);

  async function save() {
    if (!target) return;
    setBusy(true);
    try {
      await vehiclesApi.transfer(vehicle.id, target.customer.id, date, note);
      toast.success(`${vehicle.plate_display} moved to ${target.customer.name}.`);
      onDone(target.customer.id);
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
      title={`Transfer vehicle ${vehicle?.plate_display || ''}`}
      width="w-[38rem]"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" icon={ArrowRightLeft} disabled={!target || busy} onClick={save}>
            {busy ? 'Moving…' : 'Transfer'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <p className="text-sm text-muted">
          Use this when the car is sold. Old bills and warranties stay with the customer who bought
          them; new bills go to the new owner.
        </p>
        <Field label="New owner" required>
          {() => (
            <CustomerPicker
              autoFocus
              value={target}
              excludeId={vehicle?.customer_id}
              onChange={(v) => setTarget(v ? { customer: v.customer, vehicle: null } : null)}
            />
          )}
        </Field>
        <div className="grid grid-cols-[12rem_1fr] gap-3">
          <Field label="Transfer date">
            {(id) => (
              <Input id={id} type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            )}
          </Field>
          <Field label="Note">
            {(id) => (
              <Input
                id={id}
                value={note}
                placeholder="Optional"
                onChange={(e) => setNote(e.target.value)}
              />
            )}
          </Field>
        </div>
        <div>
          <div className="mb-1.5 text-xs font-medium text-muted">Ownership history</div>
          {!history ? (
            <Skeleton className="h-10" />
          ) : (
            <ul className="divide-y divide-border rounded-xl border border-border text-sm">
              {history.map((h) => (
                <li key={h.id} className="flex items-center gap-3 px-3 py-2">
                  <span className="flex-1 font-medium">{h.customer_name}</span>
                  <span className="text-muted">
                    {formatDate(h.from_date)} → {h.to_date ? formatDate(h.to_date) : 'now'}
                  </span>
                  {!h.to_date && <Badge tone="primary">Current</Badge>}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </Modal>
  );
}

/** Products that fit the vehicle (Phase 2 compatibility data). */
export function CompatibleModal({ open, vehicle, onClose }) {
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  useEffect(() => {
    if (!vehicle) return;
    vehiclesApi
      .compatibleProducts(vehicle.id)
      .then(setData)
      .catch(() => setData({ rows: [], universal_count: 0 }));
  }, [vehicle]);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Fits ${vehicle?.plate_display || ''}${vehicle?.model ? ` · ${vehicle.make} ${vehicle.model}` : ''}${vehicle?.year ? ` ${vehicle.year}` : ''}`}
      width="w-[44rem]"
      footer={<Button onClick={onClose}>Close</Button>}
    >
      {!data ? (
        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-12" />
          ))}
        </div>
      ) : data.needs_model ? (
        <EmptyState icon={Package} title="No model set">
          Edit the vehicle and choose its make / model to see matching products.
        </EmptyState>
      ) : data.rows.length === 0 ? (
        <EmptyState icon={Package} title="No vehicle-specific products">
          {data.universal_count} universal products fit every car.
        </EmptyState>
      ) : (
        <div className="space-y-3">
          <ul className="max-h-[55vh] divide-y divide-border overflow-auto rounded-xl border border-border">
            {data.rows.map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-surface-2"
                  onClick={() => navigate(`/products?open=${p.id}`)}
                >
                  {p.image_url ? (
                    <img src={p.image_url} alt="" className="h-9 w-9 rounded-lg object-cover" />
                  ) : (
                    <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary-soft text-primary">
                      <Package size={16} />
                    </div>
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">{p.name}</div>
                    <div className="text-xs text-muted">
                      {[
                        p.brand,
                        p.year_from || p.year_to ? `${p.year_from ?? ''}–${p.year_to ?? ''}` : null,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </div>
                  </div>
                  <span className="text-sm tabular-nums">
                    {p.min_price === p.max_price
                      ? formatMoney(p.min_price)
                      : `${formatMoney(p.min_price)} – ${formatMoney(p.max_price)}`}
                  </span>
                  <Badge tone={p.stock_milli > 0 ? 'success' : 'danger'}>
                    {formatQty(p.stock_milli)} {p.unit}
                  </Badge>
                </button>
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted">Plus {data.universal_count} universal products.</p>
        </div>
      )}
    </Modal>
  );
}
