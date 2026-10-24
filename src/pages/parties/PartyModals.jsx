import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import {
  CheckCircle2,
  FileDown,
  FileSpreadsheet,
  GitMerge,
  Pencil,
  Plus,
  Trash2,
  TriangleAlert,
  Upload,
} from 'lucide-react';
import Button from '../../components/Button';
import { Field, Input, Segmented, Select, Toggle } from '../../components/Field';
import { Badge, Skeleton } from '../../components/Feedback';
import { Modal } from '../../components/Overlay';
import CustomerPicker from '../../components/CustomerPicker';
import { useToast } from '../../components/Toast';
import { customerTypesApi, partiesApi } from '../../api/parties';
import { formatMoney } from '../../utils/money';
import { balanceInfo } from './form';

// ---------------------------------------------------------------- merge

const MOVE_LABELS = {
  'sales.party_id': 'Bills',
  'sale_returns.party_id': 'Sale returns',
  'payments.party_id': 'Payments',
  'purchases.party_id': 'Purchases',
  'purchase_returns.party_id': 'Purchase returns',
  'product_serials.customer_party_id': 'Serial-number warranties',
  'product_serials.supplier_party_id': 'Serial numbers supplied',
  'warranty_claims.customer_party_id': 'Warranty claims',
  'warranty_claims.supplier_party_id': 'Claims sent',
  'claim_dispatches.supplier_party_id': 'Units sent for claims',
  'warranty_costs.party_id': 'Warranty recoveries',
  'vehicles.customer_id': 'Vehicles',
  'vehicle_owners.customer_id': 'Ownership history rows',
};

function Balance({ type, value }) {
  const b = balanceInfo(type, value);
  return (
    <Badge tone={b.tone}>
      {b.label}
      {b.amount ? ` ${formatMoney(b.amount)}` : ''}
    </Badge>
  );
}

/** Merge two duplicate records: everything moves to the one kept (one transaction). */
export function MergeModal({ open, party, onClose, onMerged }) {
  const toast = useToast();
  const [other, setOther] = useState(null);
  const [keep, setKeep] = useState('this');
  const [note, setNote] = useState('');
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const ids = other
    ? keep === 'this'
      ? [party.id, other.customer.id]
      : [other.customer.id, party.id]
    : null;

  useEffect(() => {
    if (!ids) return undefined;
    let cancelled = false;
    partiesApi
      .mergePreview(ids[0], ids[1])
      .then((p) => !cancelled && setPreview(p))
      .catch((e) => {
        toast.error(e);
        setOther(null);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids?.[0], ids?.[1]]);
  const current =
    preview && ids && preview.keep.id === ids[0] && preview.merge.id === ids[1] ? preview : null;

  async function merge() {
    setBusy(true);
    try {
      const kept = await partiesApi.merge(ids[0], ids[1], note);
      toast.success(`Merged into ${kept.name}.`);
      onMerged(kept.id);
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  }

  const label = party.type === 'supplier' ? 'supplier' : 'customer';
  return (
    <Modal
      open={open}
      onClose={onClose}
      dismissable={!busy}
      title={`Merge ${label}s`}
      width="w-[40rem]"
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="danger" icon={GitMerge} disabled={!current || busy} onClick={merge}>
            {busy ? 'Merging…' : 'Merge'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <p className="text-sm text-muted">
          For duplicates of the same {label}. Bills, payments, vehicles, warranties and the opening
          balance of one record move to the other in one step; the merged record is hidden and the
          merge is logged.
        </p>
        <Field label={`Duplicate ${label}`} required>
          {() => (
            <CustomerPicker
              autoFocus
              type={party.type}
              allowQuickAdd={false}
              excludeId={party.id}
              value={other}
              onChange={(v) => {
                setOther(v);
                setPreview(null);
              }}
            />
          )}
        </Field>
        {other && (
          <Field label="Keep">
            {() => (
              <Segmented
                layoutId="merge-keep"
                value={keep}
                onChange={setKeep}
                options={[
                  { value: 'this', label: party.name },
                  { value: 'other', label: other.customer.name },
                ]}
              />
            )}
          </Field>
        )}
        {other && !current && <Skeleton className="h-24" />}
        {current && (
          <div className="space-y-3 rounded-xl border border-border p-3 text-sm">
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-lg bg-success-soft/50 p-2">
                <div className="text-xs text-muted">Kept</div>
                <div className="font-semibold">{current.keep.name}</div>
                <div className="text-xs text-muted">{current.keep.phone_display}</div>
                <Balance type={party.type} value={current.keep.balance} />
              </div>
              <div className="rounded-lg bg-danger-soft/50 p-2">
                <div className="text-xs text-muted">Merged and hidden</div>
                <div className="font-semibold">{current.merge.name}</div>
                <div className="text-xs text-muted">{current.merge.phone_display}</div>
                <Balance type={party.type} value={current.merge.balance} />
              </div>
            </div>
            <div>
              <div className="mb-1 text-xs font-medium text-muted">Moves</div>
              {Object.keys(current.moves).length === 0 ? (
                <div className="text-muted">Nothing to move (no bills, payments or vehicles).</div>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {Object.entries(current.moves).map(([k, n]) => (
                    <Badge key={k} tone="primary">
                      {MOVE_LABELS[k] || k}: {n}
                    </Badge>
                  ))}
                </div>
              )}
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted">Balance after merge</span>
              <Balance type={party.type} value={current.combined_balance} />
            </div>
          </div>
        )}
        <Field label="Reason (saved in the merge log)">
          {(id) => <Input id={id} value={note} onChange={(e) => setNote(e.target.value)} />}
        </Field>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- customer types

export function TypesModal({ open, onClose, onChanged }) {
  const toast = useToast();
  const [types, setTypes] = useState(null);
  const [edit, setEdit] = useState(null); // { id, name, discount }

  useEffect(() => {
    customerTypesApi.list().then(setTypes).catch(toast.error);
  }, [toast]);

  async function save() {
    try {
      const pct = edit.discount === '' ? 0 : Math.round(Number(edit.discount) * 100);
      const list = await customerTypesApi.save({
        id: edit.id,
        name: edit.name,
        default_discount_bp: pct,
      });
      setTypes(list);
      setEdit(null);
      onChanged();
    } catch (e) {
      toast.error(e);
    }
  }

  async function remove(t) {
    try {
      setTypes(await customerTypesApi.remove(t.id));
      onChanged();
      toast.success(
        `"${t.name}" removed${t.customer_count ? ` (cleared from ${t.customer_count} customers)` : ''}.`,
      );
    } catch (e) {
      toast.error(e);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Customer types"
      width="w-[32rem]"
      footer={<Button onClick={onClose}>Done</Button>}
    >
      <div className="space-y-3">
        <p className="text-sm text-muted">
          Tags such as Retail or Garage. The default discount is offered when billing this type.
        </p>
        {!types ? (
          <Skeleton className="h-32" />
        ) : (
          <ul className="divide-y divide-border rounded-xl border border-border">
            {types.map((t) =>
              edit?.id === t.id ? null : (
                <li key={t.id} className="flex items-center gap-2 px-3 py-2">
                  <span className="flex-1 font-medium">{t.name}</span>
                  {t.default_discount_bp > 0 && (
                    <Badge tone="primary">{t.default_discount_bp / 100}% off</Badge>
                  )}
                  <span className="text-xs text-muted">{t.customer_count} customers</span>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    icon={Pencil}
                    title="Edit"
                    onClick={() =>
                      setEdit({
                        id: t.id,
                        name: t.name,
                        discount: t.default_discount_bp ? String(t.default_discount_bp / 100) : '',
                      })
                    }
                  />
                  <Button
                    size="icon-sm"
                    variant="danger-ghost"
                    icon={Trash2}
                    title="Remove"
                    onClick={() => remove(t)}
                  />
                </li>
              ),
            )}
          </ul>
        )}
        {edit ? (
          <div className="flex items-end gap-2 rounded-xl border border-primary/40 p-3">
            <Field label="Name" className="flex-1">
              {(id) => (
                <Input
                  id={id}
                  autoFocus
                  value={edit.name}
                  onChange={(e) => setEdit({ ...edit, name: e.target.value })}
                />
              )}
            </Field>
            <Field label="Discount %" className="w-28">
              {(id) => (
                <Input
                  id={id}
                  inputMode="decimal"
                  value={edit.discount}
                  onChange={(e) =>
                    setEdit({ ...edit, discount: e.target.value.replace(/[^\d.]/g, '') })
                  }
                />
              )}
            </Field>
            <Button variant="primary" onClick={save}>
              Save
            </Button>
            <Button onClick={() => setEdit(null)}>Cancel</Button>
          </div>
        ) : (
          <Button
            size="sm"
            icon={Plus}
            onClick={() => setEdit({ id: null, name: '', discount: '' })}
          >
            Add type
          </Button>
        )}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- import

const ACTION = {
  create: { tone: 'success', label: 'New' },
  update: { tone: 'primary', label: 'Update' },
  skip: { tone: 'neutral', label: 'Skip (exists)' },
  error: { tone: 'danger', label: 'Error' },
};

/** Choose file → map columns + duplicate handling → preview (error report) → import (one transaction). */
export function ImportPartiesModal({ open, type, onClose, onImported }) {
  const toast = useToast();
  const [file, setFile] = useState(null); // result of importOpen
  const [mapping, setMapping] = useState({});
  const [onDuplicate, setOnDuplicate] = useState('skip');
  const [preview, setPreview] = useState(null);
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [busy, setBusy] = useState(false);
  const label = type === 'supplier' ? 'suppliers' : 'customers';

  async function choose() {
    setBusy(true);
    try {
      const f = await partiesApi.importOpen(type);
      if (f) {
        setFile(f);
        setMapping(f.mapping);
        setPreview(null);
      }
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  }

  async function template() {
    try {
      const r = await partiesApi.importTemplate(type);
      if (r.saved) toast.success(`Template saved: ${r.file_path}`);
    } catch (e) {
      toast.error(e);
    }
  }

  async function check() {
    setBusy(true);
    try {
      const p = await partiesApi.importPreview(file.token, mapping, onDuplicate);
      setPreview(p);
      setErrorsOnly(p.summary.error > 0);
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  }

  async function commit() {
    setBusy(true);
    try {
      const r = await partiesApi.importCommit(file.token);
      toast.success(
        `Imported: ${r.created} new, ${r.updated} updated${type === 'customer' ? `, ${r.vehicles} vehicles` : ''}.`,
      );
      onImported();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  }

  const s = preview?.summary;
  const rows = preview ? preview.rows.filter((r) => !errorsOnly || r.action === 'error') : [];
  const ready = s ? s.create + s.update : 0;

  let footer = <Button onClick={onClose}>Close</Button>;
  if (file && !preview) {
    footer = (
      <>
        <Button onClick={() => setFile(null)} disabled={busy}>
          Choose another file
        </Button>
        <Button variant="primary" onClick={check} disabled={busy}>
          {busy ? 'Checking…' : 'Preview'}
        </Button>
      </>
    );
  } else if (preview) {
    footer = (
      <>
        <Button onClick={() => setPreview(null)} disabled={busy}>
          Back to columns
        </Button>
        <Button variant="primary" icon={Upload} onClick={commit} disabled={busy || ready === 0}>
          {busy ? 'Importing…' : `Import ${ready} ${label}`}
        </Button>
      </>
    );
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      dismissable={!busy}
      title={`Import ${label} from Excel / CSV`}
      width="w-[62rem]"
      footer={footer}
    >
      {!file ? (
        <div className="grid grid-cols-2 gap-4">
          <motion.button
            type="button"
            whileHover={{ y: -2 }}
            onClick={choose}
            disabled={busy}
            className="flex flex-col items-center gap-3 rounded-2xl border-2 border-dashed border-primary/40 bg-primary-soft/40 p-8 text-center hover:border-primary"
          >
            <FileSpreadsheet size={36} className="text-primary" />
            <span className="font-semibold">
              {busy ? 'Reading file…' : 'Choose Excel or CSV file'}
            </span>
            <span className="text-xs text-muted">
              Nothing is saved until you confirm the preview.
            </span>
          </motion.button>
          <div className="space-y-3 rounded-2xl border border-border p-5 text-sm">
            <div className="font-semibold">How it works</div>
            <ul className="list-disc space-y-1 pl-5 text-muted">
              <li>You pick which column is the name, phone, and so on.</li>
              <li>Existing {label} are found by phone (any format), then GSTIN.</li>
              {type === 'customer' && (
                <li>Several rows with the same phone = one customer with several vehicles.</li>
              )}
              <li>Rows with errors are listed and skipped; the rest are saved together.</li>
            </ul>
            <Button size="sm" icon={FileDown} onClick={template}>
              Download template
            </Button>
          </div>
        </div>
      ) : !preview ? (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <Badge>{file.file_name}</Badge>
            <Badge tone="primary">{file.row_count} rows</Badge>
            <div className="ml-auto flex items-center gap-2 text-sm">
              <span className="text-muted">Already existing:</span>
              <Segmented
                layoutId="import-dupes"
                value={onDuplicate}
                onChange={setOnDuplicate}
                options={[
                  { value: 'skip', label: 'Skip' },
                  { value: 'update', label: 'Update' },
                ]}
              />
            </div>
          </div>
          <div className="grid grid-cols-3 gap-x-4 gap-y-2 rounded-xl border border-border p-4">
            {file.fields.map((f) => (
              <label key={f.key} className="flex items-center gap-2 text-sm">
                <span className="w-36 shrink-0 text-muted">
                  {f.label}
                  {f.required && <span className="text-danger"> *</span>}
                </span>
                <Select
                  value={mapping[f.key] ?? ''}
                  onChange={(e) =>
                    setMapping((m) => ({
                      ...m,
                      [f.key]: e.target.value === '' ? null : Number(e.target.value),
                    }))
                  }
                >
                  <option value="">— not in file —</option>
                  {file.headers.map((h, i) => (
                    <option key={i} value={i}>
                      {h || `Column ${i + 1}`}
                    </option>
                  ))}
                </Select>
              </label>
            ))}
          </div>
          <div className="max-h-56 overflow-auto rounded-xl border border-border">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-surface-2 text-left text-muted">
                <tr>
                  {file.headers.map((h, i) => (
                    <th key={i} className="px-2 py-1.5 font-medium whitespace-nowrap">
                      {h || `Column ${i + 1}`}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {file.sample.map((r, i) => (
                  <tr key={i}>
                    {r.map((c, j) => (
                      <td key={j} className="px-2 py-1.5 whitespace-nowrap">
                        {c}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="success" dot>
              {s.create} new
            </Badge>
            {s.update > 0 && (
              <Badge tone="primary" dot>
                {s.update} to update
              </Badge>
            )}
            {s.skip > 0 && <Badge dot>{s.skip} existing (skipped)</Badge>}
            {s.error > 0 && (
              <Badge tone="danger" dot>
                {s.error} with errors (skipped)
              </Badge>
            )}
            {type === 'customer' && <Badge tone="primary">{s.vehicles} vehicles</Badge>}
            <div className="ml-auto">
              <Toggle label="Show only errors" checked={errorsOnly} onChange={setErrorsOnly} />
            </div>
          </div>
          {(s.new_types.length > 0 || s.new_models.length > 0) && (
            <div className="rounded-xl bg-primary-soft/50 px-4 py-2 text-sm">
              {s.new_types.length > 0 && <div>New customer types: {s.new_types.join(', ')}</div>}
              {s.new_models.length > 0 && <div>New vehicle models: {s.new_models.join(', ')}</div>}
            </div>
          )}
          <div className="max-h-[50vh] overflow-auto rounded-xl border border-border">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-surface-2 text-left text-xs text-muted">
                <tr>
                  <th className="px-3 py-2 font-medium">Row</th>
                  <th className="px-3 py-2 font-medium">Name</th>
                  <th className="px-3 py-2 font-medium">Phone</th>
                  {type === 'customer' && <th className="px-3 py-2 font-medium">Vehicles</th>}
                  <th className="px-3 py-2 font-medium">Result</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rows.map((r) => {
                  const a = ACTION[r.action];
                  return (
                    <tr key={r.key} className={r.action === 'error' ? 'bg-danger-soft/40' : ''}>
                      <td className="px-3 py-2 text-muted">{r.rows.join(', ')}</td>
                      <td className="px-3 py-2 font-medium">
                        {r.name || '—'}
                        {r.existing_name && r.existing_name !== r.name && (
                          <div className="text-xs font-normal text-muted">
                            existing: {r.existing_name}
                          </div>
                        )}
                      </td>
                      <td className="px-3 py-2">{r.phone_display}</td>
                      {type === 'customer' && (
                        <td className="px-3 py-2 text-xs">{r.plates.join(', ')}</td>
                      )}
                      <td className="px-3 py-2">
                        <div className="flex items-center gap-2">
                          {r.action === 'error' ? (
                            <TriangleAlert size={14} className="shrink-0 text-danger" />
                          ) : (
                            <CheckCircle2 size={14} className="shrink-0 text-success" />
                          )}
                          <Badge tone={a.tone}>{a.label}</Badge>
                        </div>
                        {r.errors.length > 0 && (
                          <div className="mt-1 text-xs text-danger">{r.errors.join(' ')}</div>
                        )}
                        {r.warnings.length > 0 && (
                          <div className="mt-1 text-xs text-warning">{r.warnings.join(' ')}</div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </Modal>
  );
}
