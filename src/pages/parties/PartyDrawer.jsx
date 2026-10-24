import { useCallback, useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  ArrowRightLeft,
  Ban,
  Car,
  CheckCircle2,
  Copy,
  GitMerge,
  LayoutDashboard,
  Link2,
  Link2Off,
  MoreHorizontal,
  Package,
  Pencil,
  Plus,
  ReceiptText,
  ScrollText,
  ShieldCheck,
  Star,
  Trash2,
  Truck,
  Wallet,
  Wrench,
} from 'lucide-react';
import Button from '../../components/Button';
import ConfirmDialog from '../../components/ConfirmDialog';
import { Badge, Kbd, Skeleton } from '../../components/Feedback';
import { Drawer } from '../../components/Overlay';
import { useToast } from '../../components/Toast';
import { partiesApi, vehiclesApi } from '../../api/parties';
import { appApi } from '../../api/app';
import { formatMoney } from '../../utils/money';
import { formatDate } from '../../utils/dates';
import { plateFormatLabel, stateName } from '../../utils/identity';
import PartyForm from './PartyForm';
import { CompatibleModal, TransferModal, VehicleModal } from './VehicleModals';
import { MergeModal, TypesModal } from './PartyModals';
import {
  BillsTab,
  ClaimsTab,
  LedgerTab,
  PaymentsTab,
  PurchasesTab,
  SuppliedTab,
  WarrantiesTab,
} from './PartyTabs';
import { balanceInfo, emptyForm, toForm, toPayload, vehiclePayload } from './form';

const FUEL_LABEL = { petrol: 'Petrol', diesel: 'Diesel', cng: 'CNG', ev: 'EV', hybrid: 'Hybrid' };

function tabsFor(party) {
  if (party.type === 'supplier') {
    return [
      ['overview', 'Overview', LayoutDashboard],
      ['purchases', 'Purchases', Truck],
      ['payments', 'Payments', Wallet],
      ['ledger', 'Ledger', ScrollText],
      ['supplied', 'Products', Package],
      ['claims', 'Claims', Wrench],
    ];
  }
  return [
    ['overview', 'Overview', LayoutDashboard],
    ['vehicles', `Vehicles (${party.vehicles.length})`, Car],
    ['bills', 'Bills', ReceiptText],
    ['payments', 'Payments', Wallet],
    ['ledger', 'Ledger', ScrollText],
    ['warranties', 'Warranties', ShieldCheck],
  ];
}

function Info({ label, children }) {
  return (
    <div>
      <div className="text-xs text-muted">{label}</div>
      <div className="font-medium break-words">
        {children || <span className="text-muted">—</span>}
      </div>
    </div>
  );
}

function Card({ title, children, className = '' }) {
  return (
    <div className={`rounded-2xl border border-border bg-surface-2/40 p-4 ${className}`}>
      <div className="mb-3 text-sm font-semibold">{title}</div>
      {children}
    </div>
  );
}

function BalanceBadge({ type, balance, large }) {
  const b = balanceInfo(type, balance);
  return (
    <Badge tone={b.tone} dot className={large ? 'px-2.5 py-1 text-sm' : ''}>
      {b.label}
      {b.amount ? ` ${formatMoney(b.amount)}` : ''}
    </Badge>
  );
}

function Overview({ party, onOpenParty }) {
  const customer = party.type === 'customer';
  const t = party.totals;
  const limitUsed =
    party.credit_limit > 0 && party.balance > 0
      ? Math.min(100, Math.round((party.balance * 100) / party.credit_limit))
      : 0;
  return (
    <div className="grid grid-cols-2 gap-4">
      <Card title={customer ? 'Sales' : 'Purchases'} className="col-span-2">
        <div className="grid grid-cols-4 gap-4">
          <Info label="Lifetime">{formatMoney(t.lifetime)}</Info>
          <Info label={`This FY (from ${formatDate(t.fy_start)})`}>{formatMoney(t.this_fy)}</Info>
          <Info label={customer ? 'Last visit' : 'Last purchase'}>
            {t.last_date ? formatDate(t.last_date) : null}
          </Info>
          <Info label="Bills">{String(t.bill_count)}</Info>
        </div>
      </Card>
      <Card title="Contact">
        <div className="grid grid-cols-2 gap-3">
          {!customer && <Info label="Contact person">{party.contact_person}</Info>}
          {customer && party.firm_name && <Info label="Firm">{party.firm_name}</Info>}
          <Info label="Phone">{party.phone_display}</Info>
          <Info label="Alternate phone">{party.alt_phone_display}</Info>
          {customer && (
            <Info label="WhatsApp">{party.whatsapp_same ? 'Same number' : 'Different'}</Info>
          )}
          <Info label="Email">{party.email}</Info>
        </div>
      </Card>
      <Card title="Address & GST">
        <div className="grid grid-cols-2 gap-3">
          <div className="col-span-2">
            <Info label="Address">
              {[party.address, party.city, party.pincode].filter(Boolean).join(', ')}
            </Info>
          </div>
          <Info label="State">
            {party.state_code
              ? `${party.state_code} · ${stateName(party.state_code)}`
              : 'Same as shop'}
          </Info>
          <Info label="GSTIN">
            {party.gstin && <span className="font-mono">{party.gstin}</span>}
          </Info>
        </div>
      </Card>
      <Card title={customer ? 'Credit' : 'Terms'}>
        <div className="grid grid-cols-2 gap-3">
          {customer ? (
            <>
              <Info label="Type">
                {party.type_name &&
                  `${party.type_name}${party.default_discount_bp ? ` (${party.default_discount_bp / 100}% off)` : ''}`}
              </Info>
              <div>
                <Info label="Credit limit">
                  {party.credit_limit == null ? 'No limit' : formatMoney(party.credit_limit)}
                </Info>
                {party.credit_limit > 0 && (
                  <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-3">
                    <motion.div
                      initial={{ width: 0 }}
                      animate={{ width: `${limitUsed}%` }}
                      transition={{ duration: 0.25 }}
                      className={`h-full ${party.balance > party.credit_limit ? 'bg-danger' : limitUsed > 80 ? 'bg-warning' : 'bg-success'}`}
                    />
                  </div>
                )}
              </div>
            </>
          ) : (
            <>
              <Info label="Payment terms">
                {party.payment_terms_days != null ? `${party.payment_terms_days} days` : null}
              </Info>
              <Info label="Supplies">{party.supplies}</Info>
              <div className="col-span-2">
                <Info label="Bank / UPI">
                  {party.bank_details && (
                    <span className="whitespace-pre-line">{party.bank_details}</span>
                  )}
                </Info>
              </div>
            </>
          )}
          <Info label="Opening balance">
            {party.opening_amount
              ? `${formatMoney(party.opening_amount)} ${party.opening_type} (${formatDate(party.opening_balance_date)})`
              : null}
          </Info>
        </div>
      </Card>
      <Card title="Notes">
        <div className="text-sm whitespace-pre-line">
          {party.notes || <span className="text-muted">—</span>}
        </div>
        {party.linked && (
          <button
            type="button"
            onClick={() => onOpenParty(party.linked.id)}
            className="mt-3 flex w-full items-center gap-2 rounded-xl border border-border bg-surface px-3 py-2 text-left text-sm hover:border-primary"
          >
            <Link2 size={15} className="text-primary" />
            <span className="flex-1">
              Also a {party.linked.type}: <strong>{party.linked.name}</strong>
            </span>
            <BalanceBadge type={party.linked.type} balance={party.linked.balance} />
          </button>
        )}
      </Card>
    </div>
  );
}

function VehiclesTab({ party, onAdd, onEdit, onTransfer, onCompatible, onChanged }) {
  const toast = useToast();
  const [removing, setRemoving] = useState(null);

  async function primary(v) {
    try {
      await vehiclesApi.setPrimary(v.id);
      onChanged();
    } catch (e) {
      toast.error(e);
    }
  }
  async function remove() {
    try {
      await vehiclesApi.remove(removing.id);
      toast.success(`${removing.plate_display} removed.`);
      setRemoving(null);
      onChanged();
    } catch (e) {
      toast.error(e);
      setRemoving(null);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <Button size="sm" variant="primary" icon={Plus} onClick={onAdd}>
          Add vehicle
        </Button>
      </div>
      {party.vehicles.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border p-8 text-center text-muted">
          No vehicles yet. Add one so billing can find this customer by number plate.
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3">
          {party.vehicles.map((v, i) => (
            <motion.div
              key={v.id}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: Math.min(i * 0.03, 0.2), duration: 0.15 }}
              className={`rounded-2xl border bg-surface p-4 shadow-sm ${v.is_primary ? 'border-primary/60' : 'border-border'}`}
            >
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <div className="inline-block rounded-md border-2 border-fg/80 bg-surface px-2 py-0.5 font-mono text-base font-bold tracking-wider">
                    {v.plate_display}
                  </div>
                  <div className="mt-2 truncate font-medium">
                    {v.make ? (
                      `${v.make} ${v.model}`
                    ) : (
                      <span className="text-muted">Model not set</span>
                    )}
                    {v.variant ? <span className="text-muted"> · {v.variant}</span> : null}
                  </div>
                  <div className="text-xs text-muted">
                    {[v.year, FUEL_LABEL[v.fuel], v.color].filter(Boolean).join(' · ') || ' '}
                  </div>
                </div>
                {v.is_primary ? (
                  <Badge tone="primary">
                    <Star size={11} /> Primary
                  </Badge>
                ) : (
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    icon={Star}
                    title="Make primary"
                    onClick={() => primary(v)}
                  />
                )}
              </div>
              <div className="mt-2 text-xs text-muted">
                {v.bill_count} bill(s)
                {v.owner_since ? ` · owner since ${formatDate(v.owner_since)}` : ''}
                {v.plate_format === 'other' ? (
                  <span className="text-warning"> · unusual plate format</span>
                ) : v.plate_format !== 'standard' ? (
                  ` · ${plateFormatLabel(v.plate_format)}`
                ) : null}
              </div>
              {v.notes && <div className="mt-1 truncate text-xs text-muted">{v.notes}</div>}
              <div className="mt-3 flex flex-wrap gap-1">
                <Button size="sm" icon={Package} onClick={() => onCompatible(v)}>
                  Compatible products
                </Button>
                <Button size="sm" icon={Pencil} onClick={() => onEdit(v)}>
                  Edit
                </Button>
                <Button size="sm" icon={ArrowRightLeft} onClick={() => onTransfer(v)}>
                  Transfer
                </Button>
                {v.bill_count === 0 && (
                  <Button
                    size="icon-sm"
                    variant="danger-ghost"
                    icon={Trash2}
                    title="Remove (added by mistake)"
                    onClick={() => setRemoving(v)}
                  />
                )}
              </div>
            </motion.div>
          ))}
        </div>
      )}
      <ConfirmDialog
        open={Boolean(removing)}
        title="Remove vehicle?"
        confirmLabel="Remove"
        danger
        onCancel={() => setRemoving(null)}
        onConfirm={remove}
      >
        Only for a vehicle added by mistake. If the car was sold, use{' '}
        <strong className="text-fg">Transfer</strong> instead so its history is kept.
      </ConfirmDialog>
    </div>
  );
}

/** "More" menu (merge, link, deactivate, remove). */
function MoreMenu({ items }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative mr-auto">
      <Button icon={MoreHorizontal} onClick={() => setOpen((o) => !o)}>
        More
      </Button>
      <AnimatePresence>
        {open && (
          <>
            <div className="fixed inset-0 z-40" onMouseDown={() => setOpen(false)} />
            <motion.ul
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.12 }}
              className="absolute bottom-full left-0 z-50 mb-2 w-64 rounded-xl border border-border bg-surface p-1 shadow-xl"
            >
              {items.filter(Boolean).map((it) => (
                <li key={it.label}>
                  <button
                    type="button"
                    onClick={() => {
                      setOpen(false);
                      it.run();
                    }}
                    className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm hover:bg-surface-2 ${it.danger ? 'text-danger' : ''}`}
                  >
                    <it.icon size={15} /> {it.label}
                  </button>
                </li>
              ))}
            </motion.ul>
          </>
        )}
      </AnimatePresence>
    </div>
  );
}

/**
 * Customer / supplier detail (tabs) and edit form. `partyId` null = new record.
 * Remounted (key) every time it opens.
 */
export default function PartyDrawer({
  open,
  partyId: initialId,
  type,
  meta,
  initialTab = 'overview',
  onClose,
  onChanged,
  onOpenParty,
  onMetaChange,
}) {
  const toast = useToast();
  const [partyId, setPartyId] = useState(initialId);
  const [party, setParty] = useState(null);
  const [tab, setTab] = useState(initialTab);
  const [editing, setEditing] = useState(!initialId);
  const [form, setForm] = useState(() => (initialId ? null : emptyForm(type)));
  const [newVehicles, setNewVehicles] = useState([]);
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);
  const [seq, setSeq] = useState(0);
  const [overlay, setOverlay] = useState(null); // { kind, vehicle? }

  const load = useCallback(
    () =>
      partiesApi
        .get(partyId)
        .then(setParty)
        .catch((e) => {
          toast.error(e);
          onClose();
        }),
    [partyId, toast, onClose],
  );
  useEffect(() => {
    if (partyId) load();
  }, [partyId, load]);

  const refresh = () => {
    load();
    onChanged();
  };
  const show = (kind, extra = {}) => {
    setSeq((n) => n + 1);
    setOverlay({ kind, ...extra });
  };

  function startEdit() {
    setForm(toForm(party));
    setErrors({});
    setEditing(true);
  }

  async function save() {
    const { payload, errors: local } = toPayload(form);
    if (Object.keys(local).length) {
      setErrors(local);
      toast.error('Please fix the highlighted fields.');
      return;
    }
    setSaving(true);
    try {
      const saved = form.id
        ? await partiesApi.update(form.id, payload)
        : await partiesApi.create(
            type,
            payload,
            newVehicles.filter((v) => v.plate_no.trim()).map(vehiclePayload),
          );
      for (const w of saved.warnings || []) toast.info(w);
      toast.success(
        form.id
          ? 'Saved.'
          : `${type === 'supplier' ? 'Supplier' : 'Customer'} "${saved.name}" added.`,
      );
      setParty(saved);
      setPartyId(saved.id);
      setEditing(false);
      onChanged();
    } catch (e) {
      setErrors(e.fields || {});
      toast.error(e);
    } finally {
      setSaving(false);
    }
  }

  async function action(fn, message, after) {
    try {
      const r = await fn();
      if (message) toast.success(message);
      if (after) after(r);
      else refresh();
    } catch (e) {
      toast.error(e);
    }
  }

  async function copyPhone() {
    try {
      await appApi.copyText(party.phone_display);
      toast.info(`Copied ${party.phone_display}`);
    } catch (e) {
      toast.error(e);
    }
  }

  const label = type === 'supplier' ? 'supplier' : 'customer';
  const other = type === 'supplier' ? 'customer' : 'supplier';
  const hasHistory = party && Object.values(party.documents).some((n) => n > 0);

  // ------------------------------------------------------------ header / footer
  let title = editing && !partyId ? `New ${label}` : party ? party.name : '';
  let subtitle = editing ? 'Fields marked * are required' : null;
  if (party && !editing) {
    title = (
      <span className="flex items-center gap-2">
        <span className="truncate">{party.name}</span>
        {party.is_system ? (
          <Badge>Walk-in</Badge>
        ) : (
          party.type_name && <Badge tone="primary">{party.type_name}</Badge>
        )}
        {!party.is_active && <Badge tone="danger">Inactive</Badge>}
        <BalanceBadge type={party.type} balance={party.balance} large />
      </span>
    );
    subtitle = party.phone_display ? (
      <button
        type="button"
        onClick={copyPhone}
        className="inline-flex items-center gap-1.5 hover:text-primary"
        title="Copy"
      >
        {party.phone_display} <Copy size={12} />
        {party.firm_name && party.type === 'customer' ? (
          <span className="text-muted"> · {party.firm_name}</span>
        ) : null}
        {party.contact_person ? (
          <span className="text-muted"> · {party.contact_person}</span>
        ) : null}
      </button>
    ) : (
      'No phone'
    );
  }

  const footer = editing ? (
    <>
      <span className="mr-auto text-xs text-muted">
        <Kbd>Ctrl</Kbd>+<Kbd>S</Kbd> save · <Kbd>Esc</Kbd> close
      </span>
      <Button onClick={() => (party ? setEditing(false) : onClose())}>Cancel</Button>
      <Button variant="primary" onClick={save} disabled={saving}>
        {saving ? 'Saving…' : form?.id ? 'Save changes' : `Add ${label}`}
      </Button>
    </>
  ) : party ? (
    <>
      {!party.is_system && (
        <MoreMenu
          items={[
            { icon: GitMerge, label: `Merge with another ${label}…`, run: () => show('merge') },
            party.linked
              ? {
                  icon: Link2,
                  label: `Open linked ${party.linked.type}`,
                  run: () => onOpenParty(party.linked.id),
                }
              : {
                  icon: Link2,
                  label: `Also a ${other} (create linked record)`,
                  run: () =>
                    action(
                      () => partiesApi.createLinked(party.id),
                      `Linked ${other} created.`,
                      (r) => {
                        onChanged();
                        onOpenParty(r.id);
                      },
                    ),
                },
            party.linked && {
              icon: Link2Off,
              label: `Unlink ${party.linked.type}`,
              run: () => action(() => partiesApi.unlink(party.id), 'Unlinked.'),
            },
            {
              icon: party.is_active ? Ban : CheckCircle2,
              label: party.is_active ? 'Deactivate' : 'Activate',
              danger: Boolean(party.is_active),
              run: () =>
                party.is_active
                  ? show('deactivate')
                  : action(() => partiesApi.setActive(party.id, true), 'Activated.'),
            },
            !hasHistory &&
              party.balance === 0 && {
                icon: Trash2,
                label: 'Remove (no history)',
                danger: true,
                run: () => show('remove'),
              },
          ]}
        />
      )}
      <Button onClick={onClose}>Close</Button>
      <Button variant="primary" icon={Pencil} onClick={startEdit}>
        Edit
      </Button>
    </>
  ) : null;

  return (
    <Drawer
      open={open}
      onClose={onClose}
      width="w-[62rem]"
      title={title}
      subtitle={subtitle}
      footer={footer}
    >
      {editing && form ? (
        <form
          onSubmit={(e) => e.preventDefault()}
          onKeyDown={(e) => {
            if (e.ctrlKey && e.key.toLowerCase() === 's') {
              e.preventDefault();
              save();
            }
          }}
        >
          <PartyForm
            form={form}
            setForm={setForm}
            errors={errors}
            meta={meta}
            onOpenParty={onOpenParty}
            onManageTypes={() => show('types')}
            onModelsChanged={onMetaChange}
            vehicles={newVehicles}
            setVehicles={setNewVehicles}
          />
        </form>
      ) : !party ? (
        <div className="space-y-3">
          <Skeleton className="h-10" />
          <Skeleton className="h-40" />
          <Skeleton className="h-40" />
        </div>
      ) : (
        <div className="space-y-4">
          <div className="flex gap-1 rounded-xl border border-border bg-surface-2/50 p-1">
            {tabsFor(party).map(([id, text, Icon]) => (
              <button
                key={id}
                type="button"
                onClick={() => setTab(id)}
                className={`relative flex h-8 flex-1 items-center justify-center gap-1.5 rounded-lg text-sm font-medium whitespace-nowrap ${
                  tab === id ? 'text-primary' : 'text-muted hover:text-fg'
                }`}
              >
                {tab === id && (
                  <motion.span
                    layoutId="party-tab"
                    className="absolute inset-0 rounded-lg bg-surface shadow-sm"
                    transition={{ type: 'spring', stiffness: 500, damping: 40 }}
                  />
                )}
                <Icon size={15} className="relative" />
                <span className="relative">{text}</span>
              </button>
            ))}
          </div>
          <motion.div
            key={tab}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.15 }}
          >
            {tab === 'overview' && <Overview party={party} onOpenParty={onOpenParty} />}
            {tab === 'vehicles' && (
              <VehiclesTab
                party={party}
                onAdd={() => show('vehicle', { vehicle: null })}
                onEdit={(v) => show('vehicle', { vehicle: v })}
                onTransfer={(v) => show('transfer', { vehicle: v })}
                onCompatible={(v) => show('compatible', { vehicle: v })}
                onChanged={refresh}
              />
            )}
            {tab === 'bills' && <BillsTab party={party} />}
            {tab === 'purchases' && <PurchasesTab party={party} />}
            {tab === 'payments' && <PaymentsTab party={party} />}
            {tab === 'ledger' && <LedgerTab party={party} />}
            {tab === 'warranties' && <WarrantiesTab party={party} />}
            {tab === 'supplied' && <SuppliedTab party={party} />}
            {tab === 'claims' && <ClaimsTab party={party} />}
          </motion.div>
        </div>
      )}

      {/* Overlays (remounted by key each time) */}
      {party && (
        <>
          <VehicleModal
            key={`vehicle-${seq}`}
            open={overlay?.kind === 'vehicle'}
            customerId={party.id}
            vehicle={overlay?.vehicle}
            models={meta.vehicle_models}
            onModelsChanged={onMetaChange}
            onOpenParty={onOpenParty}
            onClose={() => setOverlay(null)}
            onSaved={() => {
              setOverlay(null);
              refresh();
            }}
          />
          <TransferModal
            key={`transfer-${seq}`}
            open={overlay?.kind === 'transfer'}
            vehicle={overlay?.kind === 'transfer' ? overlay.vehicle : null}
            onClose={() => setOverlay(null)}
            onDone={() => {
              setOverlay(null);
              refresh();
            }}
          />
          <CompatibleModal
            key={`compatible-${seq}`}
            open={overlay?.kind === 'compatible'}
            vehicle={overlay?.kind === 'compatible' ? overlay.vehicle : null}
            onClose={() => setOverlay(null)}
          />
          <MergeModal
            key={`merge-${seq}`}
            open={overlay?.kind === 'merge'}
            party={party}
            onClose={() => setOverlay(null)}
            onMerged={(keptId) => {
              setOverlay(null);
              onChanged();
              if (keptId === party.id) load();
              else onOpenParty(keptId);
            }}
          />
          <ConfirmDialog
            open={overlay?.kind === 'deactivate'}
            title={`Deactivate ${label}?`}
            confirmLabel="Deactivate"
            danger
            onCancel={() => setOverlay(null)}
            onConfirm={() => {
              setOverlay(null);
              action(() => partiesApi.setActive(party.id, false), 'Deactivated.');
            }}
          >
            <strong className="text-fg">{party.name}</strong> will be hidden from billing and lists.
            Bills, payments and balance are kept, and you can activate it again at any time.
          </ConfirmDialog>
          <ConfirmDialog
            open={overlay?.kind === 'remove'}
            title={`Remove ${label}?`}
            confirmLabel="Remove"
            danger
            onCancel={() => setOverlay(null)}
            onConfirm={() => {
              setOverlay(null);
              action(
                () => partiesApi.remove(party.id),
                'Removed.',
                () => {
                  onChanged();
                  onClose();
                },
              );
            }}
          >
            <strong className="text-fg">{party.name}</strong> has no bills, payments or balance, so
            it can be removed (for example, added by mistake).
          </ConfirmDialog>
        </>
      )}
      {overlay?.kind === 'types' && (
        <TypesModal
          key={`types-${seq}`}
          open
          onClose={() => setOverlay(null)}
          onChanged={onMetaChange}
        />
      )}
    </Drawer>
  );
}
