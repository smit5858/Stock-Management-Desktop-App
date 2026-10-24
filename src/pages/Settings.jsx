import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import {
  Hash,
  ImageUp,
  Monitor,
  Moon,
  Music,
  Palette,
  Percent,
  Play,
  ReceiptText,
  RotateCcw,
  ShieldCheck,
  Store,
  Sun,
  Trash2,
  Truck,
  Upload,
} from 'lucide-react';
import Button from '../components/Button';
import { Field, Input, Segmented, Select, Textarea, Toggle } from '../components/Field';
import { Badge, Skeleton } from '../components/Feedback';
import { useToast } from '../components/Toast';
import { usePrefs } from '../components/Prefs';
import { useBranding } from '../components/Branding';
import { playFile, playJingle } from '../components/loader/jingle';
import { brandingApi, settingsApi } from '../api/settings';
import { formatRateBp } from '../utils/qty';
import { GSTIN_RE, STATES } from '../utils/identity';

const TABS = [
  { id: 'branding', label: 'Business & Branding', icon: Store },
  { id: 'billing', label: 'Billing & invoices', icon: ReceiptText },
  { id: 'appearance', label: 'Appearance', icon: Palette },
  { id: 'series', label: 'Number series', icon: Hash },
  { id: 'gst', label: 'GST rates', icon: Percent },
  { id: 'purchases', label: 'Purchases', icon: Truck },
  { id: 'warranty', label: 'Warranty', icon: ShieldCheck },
];

function Card({ title, description, children }) {
  return (
    <motion.section
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2 }}
      className="rounded-2xl border border-border bg-surface p-5 shadow-sm"
    >
      <h3 className="font-semibold">{title}</h3>
      {description && <p className="mb-4 text-sm text-muted">{description}</p>}
      {children}
    </motion.section>
  );
}

function BrandingTab() {
  const toast = useToast();
  const { prefs, setPref } = usePrefs();
  const branding = useBranding();
  const [name, setName] = useState(branding.businessName);
  const [saving, setSaving] = useState(false);

  async function saveName() {
    setSaving(true);
    try {
      const s = await settingsApi.update({ business_name: name });
      branding.setBusinessName(s.business_name);
      toast.success('Business name saved.');
    } catch (err) {
      toast.error(err);
    } finally {
      setSaving(false);
    }
  }

  async function run(action, message) {
    try {
      branding.applyFiles(await action());
      if (message) toast.success(message);
    } catch (err) {
      toast.error(err);
    }
  }

  function preview() {
    if (branding.soundUrl) playFile(branding.soundUrl, prefs.soundVolume);
    else playJingle(prefs.soundVolume);
  }

  return (
    <div className="grid gap-5 xl:grid-cols-2">
      <Card title="Business name" description="Shown in the sidebar and printed on invoices.">
        <div className="flex gap-2">
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} />
          <Button variant="primary" onClick={saveName} disabled={saving || !name.trim()}>
            Save
          </Button>
        </div>
      </Card>

      <Card
        title="Logo"
        description="PNG, JPG or SVG up to 2 MB. Used in the sidebar, startup screen, window icon and invoices."
      >
        <div className="flex items-center gap-5">
          <motion.img
            key={branding.logoUrl}
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            src={branding.logoUrl}
            alt="Logo preview"
            className="h-24 w-24 rounded-2xl border border-border bg-surface-2 object-contain p-1"
          />
          <div className="flex flex-col items-start gap-2">
            <Button icon={ImageUp} onClick={() => run(brandingApi.pickLogo)}>
              Upload logo…
            </Button>
            {branding.isCustomLogo ? (
              <Button
                variant="ghost"
                icon={RotateCcw}
                onClick={() => run(brandingApi.resetLogo, 'Default logo restored.')}
              >
                Reset to default
              </Button>
            ) : (
              <Badge>Default logo</Badge>
            )}
          </div>
        </div>
      </Card>

      <Card title="Startup sound" description="Plays while the startup screen is shown.">
        <Toggle
          label="Play startup sound"
          checked={prefs.startupSound}
          onChange={(v) => setPref('startupSound', v)}
        />
        <div className="mt-3 flex items-center gap-3">
          <span className="w-16 text-xs text-muted">Volume</span>
          <input
            type="range"
            min="0"
            max="1"
            step="0.05"
            value={prefs.soundVolume}
            onChange={(e) => setPref('soundVolume', Number(e.target.value))}
            className="flex-1 accent-primary"
            disabled={!prefs.startupSound}
          />
          <span className="w-10 text-right text-xs text-muted">
            {Math.round(prefs.soundVolume * 100)}%
          </span>
          <Button size="sm" icon={Play} onClick={preview}>
            Preview
          </Button>
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-border pt-4">
          <Music size={16} className="text-muted" />
          <span className="text-sm">
            {branding.soundUrl ? 'Custom sound file' : 'Built-in jingle'}
          </span>
          <div className="ml-auto flex gap-2">
            <Button
              size="sm"
              icon={Upload}
              onClick={() => run(brandingApi.pickSound, 'Startup sound updated.')}
            >
              Use my own (MP3/WAV/OGG)…
            </Button>
            {branding.soundUrl && (
              <Button
                size="sm"
                variant="ghost"
                icon={RotateCcw}
                onClick={() => run(brandingApi.resetSound)}
              >
                Built-in
              </Button>
            )}
          </div>
        </div>
      </Card>
    </div>
  );
}

function AppearanceTab() {
  const { prefs, setPref } = usePrefs();
  return (
    <div className="grid gap-5 xl:grid-cols-2">
      <Card title="Theme" description="System follows the Windows light/dark setting.">
        <Segmented
          layoutId="theme-seg"
          value={prefs.theme}
          onChange={(v) => setPref('theme', v)}
          options={[
            { value: 'light', label: 'Light', icon: Sun },
            { value: 'dark', label: 'Dark', icon: Moon },
            { value: 'system', label: 'System', icon: Monitor },
          ]}
        />
      </Card>
      <Card title="Motion & layout">
        <Toggle
          label="Reduce animations"
          description="Turns off movement effects. Useful on slow PCs."
          checked={prefs.reduceMotion}
          onChange={(v) => setPref('reduceMotion', v)}
        />
        <Toggle
          label="Collapsed sidebar"
          description="Icons only. Shortcut: Ctrl+B"
          checked={prefs.sidebarCollapsed}
          onChange={(v) => setPref('sidebarCollapsed', v)}
        />
      </Card>
    </div>
  );
}

const SERIES_LABELS = {
  sale_gst: 'GST invoices',
  sale_non_gst: 'Non-GST bills',
  sale_return_gst: 'Credit notes (GST invoices)',
  sale_return_non_gst: 'Credit notes (non-GST bills)',
  purchase: 'Purchase entries',
  purchase_return_gst: 'Debit notes (GST purchases)',
  purchase_return_non_gst: 'Debit notes (non-GST purchases)',
  warranty_claim: 'Warranty claims',
  payment_in: 'Payments received',
  payment_out: 'Payments made',
  product_sku: 'Auto product SKU',
};

function SeriesTab() {
  const toast = useToast();
  const [rows, setRows] = useState(null);
  const [draft, setDraft] = useState({});

  useEffect(() => {
    settingsApi.sequences().then(setRows).catch(toast.error);
  }, [toast]);

  async function save(name) {
    try {
      setRows(await settingsApi.updateSequence(name, draft[name]));
      setDraft((d) => ({ ...d, [name]: undefined }));
      toast.success('Prefix saved.');
    } catch (err) {
      toast.error(err);
    }
  }

  return (
    <Card
      title="Number series"
      description="Prefixes can be changed at any time. Numbers continue from where they are and are never reused."
    >
      {!rows ? (
        <Skeleton className="h-64" />
      ) : (
        <table className="w-full">
          <thead className="text-left text-xs text-muted">
            <tr>
              <th className="py-2 font-medium">Series</th>
              <th className="py-2 font-medium">Prefix</th>
              <th className="py-2 font-medium">Next number</th>
              <th />
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((r) => {
              const value = draft[r.name] ?? r.prefix;
              const next = `${value}${String(r.next_value).padStart(r.pad_width, '0')}`;
              return (
                <tr key={r.name}>
                  <td className="py-2 pr-4">{SERIES_LABELS[r.name] || r.name}</td>
                  <td className="w-44 py-2 pr-4">
                    <Input
                      value={value}
                      maxLength={12}
                      onChange={(e) =>
                        setDraft((d) => ({ ...d, [r.name]: e.target.value.toUpperCase() }))
                      }
                      onKeyDown={(e) => e.key === 'Enter' && value !== r.prefix && save(r.name)}
                    />
                  </td>
                  <td className="py-2 pr-4 font-mono text-muted">{next}</td>
                  <td className="w-20 py-2 text-right">
                    {value !== r.prefix && (
                      <Button size="sm" variant="primary" onClick={() => save(r.name)}>
                        Save
                      </Button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </Card>
  );
}

function SettingRow({ title, hint, children }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div>
        <div className="font-medium">{title}</div>
        {hint && <div className="text-xs text-muted">{hint}</div>}
      </div>
      {children}
    </div>
  );
}

/**
 * Business details printed on invoices, billing defaults and printing. Stored in the DB
 * settings table, so they are part of every backup.
 */
function BillingTab() {
  const toast = useToast();
  const [values, setValues] = useState(null);
  const [draft, setDraft] = useState(null);
  useEffect(() => {
    settingsApi
      .get()
      .then((v) => {
        setValues(v);
        setDraft(v);
      })
      .catch(toast.error);
  }, [toast]);

  async function save(patch, message = 'Saved.') {
    try {
      const next = await settingsApi.update(patch);
      setValues(next);
      setDraft((d) => ({ ...d, ...patch }));
      toast.success(message);
    } catch (err) {
      toast.error(err);
    }
  }

  if (!values || !draft) return <Skeleton className="h-60" />;
  const text = (key) => ({
    value: draft[key] ?? '',
    onChange: (e) => setDraft((d) => ({ ...d, [key]: e.target.value })),
  });
  const businessKeys = [
    'business_address',
    'business_phone',
    'business_email',
    'business_gstin',
    'business_state_code',
    'upi_id',
    'invoice_terms',
    'invoice_footer',
    'non_gst_bill_title',
    'quotation_valid_days',
  ];
  const changed = businessKeys.filter((k) => (draft[k] ?? '') !== (values[k] ?? ''));
  const gstinError =
    draft.business_gstin && !GSTIN_RE.test(draft.business_gstin)
      ? 'Check the GSTIN (15 characters).'
      : null;

  return (
    <div className="space-y-5">
      <Card
        title="Business details on invoices"
        description="Printed on every invoice, quotation and credit note. The state decides CGST+SGST (same state) or IGST."
      >
        <div className="grid grid-cols-2 gap-3">
          <Field label="Address" className="col-span-2">
            {(id) => <Textarea id={id} rows={2} maxLength={500} {...text('business_address')} />}
          </Field>
          <Field label="Phone">
            {(id) => <Input id={id} maxLength={50} {...text('business_phone')} />}
          </Field>
          <Field label="Email">
            {(id) => <Input id={id} maxLength={100} {...text('business_email')} />}
          </Field>
          <Field label="GSTIN" error={gstinError}>
            {(id) => (
              <Input
                id={id}
                maxLength={15}
                className="uppercase"
                value={draft.business_gstin ?? ''}
                onChange={(e) =>
                  setDraft((d) => ({
                    ...d,
                    business_gstin: e.target.value.toUpperCase().replace(/\s/g, ''),
                  }))
                }
              />
            )}
          </Field>
          <Field label="State (GST)">
            {(id) => (
              <Select id={id} {...text('business_state_code')}>
                <option value="">Choose…</option>
                {STATES.map((s) => (
                  <option key={s.code} value={s.code}>
                    {s.code} · {s.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field
            label="UPI ID for the payment QR"
            hint="e.g. pragaticar@okaxis. Empty = no QR on invoices."
          >
            {(id) => <Input id={id} maxLength={130} {...text('upi_id')} />}
          </Field>
          <Field label="Non-GST bill title" hint="Bill of Supply / Estimate">
            {(id) => <Input id={id} maxLength={40} {...text('non_gst_bill_title')} />}
          </Field>
          <Field label="Terms & conditions (printed)" className="col-span-2">
            {(id) => <Textarea id={id} rows={3} maxLength={1500} {...text('invoice_terms')} />}
          </Field>
          <Field label="Footer line">
            {(id) => <Input id={id} maxLength={500} {...text('invoice_footer')} />}
          </Field>
          <Field label="Quotations valid for (days)">
            {(id) => (
              <Input id={id} inputMode="numeric" maxLength={3} {...text('quotation_valid_days')} />
            )}
          </Field>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          {changed.length > 0 && (
            <Button variant="ghost" onClick={() => setDraft(values)}>
              Undo changes
            </Button>
          )}
          <Button
            variant="primary"
            disabled={changed.length === 0 || Boolean(gstinError)}
            onClick={() => save(Object.fromEntries(changed.map((k) => [k, draft[k] ?? ''])))}
          >
            Save details
          </Button>
        </div>
      </Card>

      <Card
        title="Billing defaults"
        description="Used for every new bill; each bill can still be changed."
      >
        <div className="space-y-4">
          <SettingRow
            title="Composition dealer"
            hint="Every sale becomes a Bill of Supply without tax (the GST / non-GST switch is hidden)."
          >
            <Toggle
              checked={values.composition_dealer === '1'}
              onChange={(v) => save({ composition_dealer: v ? '1' : '0' })}
            />
          </SettingRow>
          {values.composition_dealer !== '1' && (
            <SettingRow title="New bills are" hint="F4 switches on the billing screen.">
              <Segmented
                layoutId="set-bill-type"
                value={values.default_bill_type || 'gst'}
                onChange={(v) => save({ default_bill_type: v })}
                options={[
                  { value: 'gst', label: 'GST Invoice' },
                  { value: 'non_gst', label: values.non_gst_bill_title || 'Non-GST bill' },
                ]}
              />
            </SettingRow>
          )}
          <SettingRow title="Selling rates are typed" hint="On GST invoices.">
            <Segmented
              layoutId="set-sale-price-mode"
              value={values.default_price_mode || 'exclusive'}
              onChange={(v) => save({ default_price_mode: v })}
              options={[
                { value: 'inclusive', label: 'Incl. GST' },
                { value: 'exclusive', label: 'Excl. GST' },
              ]}
            />
          </SettingRow>
          <SettingRow
            title="Allow negative stock"
            hint="Sell items that are not in stock yet (not for serial-numbered items). Off is safer."
          >
            <Toggle
              checked={values.allow_negative_stock === '1'}
              onChange={(v) => save({ allow_negative_stock: v ? '1' : '0' })}
            />
          </SettingRow>
        </div>
      </Card>

      <Card title="Printing">
        <div className="space-y-4">
          <SettingRow title="Default invoice format" hint="You can switch at print time.">
            <Segmented
              layoutId="set-print-format"
              value={values.print_format || 'a4'}
              onChange={(v) => save({ print_format: v })}
              options={[
                { value: 'a4', label: 'A4' },
                { value: 'thermal80', label: 'Thermal 80 mm' },
              ]}
            />
          </SettingRow>
          <SettingRow
            title="Thermal: print without the dialog"
            hint="Sends receipts straight to the default printer."
          >
            <Toggle
              checked={values.thermal_silent_print === '1'}
              onChange={(v) => save({ thermal_silent_print: v ? '1' : '0' })}
            />
          </SettingRow>
          <SettingRow
            title='Print "Previous balance" and "Total due"'
            hint="For named customers (never for Cash Customer)."
          >
            <Toggle
              checked={values.print_previous_balance === '1'}
              onChange={(v) => save({ print_previous_balance: v ? '1' : '0' })}
            />
          </SettingRow>
        </div>
      </Card>
    </div>
  );
}

/** Defaults for new purchase bills (stored in the DB settings, so they are backed up). */
function PurchasesTab() {
  const toast = useToast();
  const [values, setValues] = useState(null);
  useEffect(() => {
    settingsApi.get().then(setValues).catch(toast.error);
  }, [toast]);

  async function set(key, value) {
    try {
      setValues(await settingsApi.update({ [key]: value }));
      toast.success('Saved.');
    } catch (err) {
      toast.error(err);
    }
  }

  if (!values) return <Skeleton className="h-40" />;
  return (
    <Card
      title="Purchase defaults"
      description="Used for every new purchase bill; each bill can still be changed. The entry number prefix (PUR-) is under Number series."
    >
      <div className="space-y-4">
        <div className="flex items-center justify-between gap-4">
          <div>
            <div className="font-medium">Supplier rates are usually</div>
            <div className="text-xs text-muted">
              How rates are typed from the supplier&apos;s bill.
            </div>
          </div>
          <Segmented
            layoutId="set-purchase-price-mode"
            value={values.purchase_price_mode || 'exclusive'}
            onChange={(v) => set('purchase_price_mode', v)}
            options={[
              { value: 'exclusive', label: 'Excl. GST' },
              { value: 'inclusive', label: 'Incl. GST' },
            ]}
          />
        </div>
        <div className="flex items-center justify-between gap-4">
          <div>
            <div className="font-medium">Extra charges (freight, packing)</div>
            <div className="text-xs text-muted">
              Adding them to product cost spreads them across the lines, so stock value and profit
              use the landed cost.
            </div>
          </div>
          <Segmented
            layoutId="set-purchase-charges"
            value={values.purchase_charges_mode || 'cost'}
            onChange={(v) => set('purchase_charges_mode', v)}
            options={[
              { value: 'cost', label: 'Add to product cost' },
              { value: 'expense', label: 'Record as expense' },
            ]}
          />
        </div>
      </div>
    </Card>
  );
}

function GstTab() {
  const toast = useToast();
  const [rates, setRates] = useState(null);
  const [input, setInput] = useState('');

  useEffect(() => {
    settingsApi.gstRates().then(setRates).catch(toast.error);
  }, [toast]);

  async function add() {
    const m = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(input.trim());
    if (!m) return toast.error('Enter a rate like 18 or 2.5');
    const bp = Number(m[1]) * 100 + Number((m[2] || '').padEnd(2, '0'));
    try {
      setRates(await settingsApi.addGstRate(bp));
      setInput('');
    } catch (err) {
      toast.error(err);
    }
  }

  async function remove(id) {
    try {
      setRates(await settingsApi.removeGstRate(id));
    } catch (err) {
      toast.error(err);
    }
  }

  return (
    <Card
      title="GST rates"
      description="Rates offered on products and bill lines. Removing a rate never changes existing bills."
    >
      <div className="mb-4 flex flex-wrap gap-2">
        {!rates && <Skeleton className="h-8 w-64" />}
        {rates?.map((r) => (
          <motion.span
            key={r.id}
            layout
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1 }}
            className="inline-flex items-center gap-1 rounded-full border border-border bg-surface-2 py-1 pr-1 pl-3 font-medium"
          >
            {formatRateBp(r.rate_bp)}
            <button
              type="button"
              onClick={() => remove(r.id)}
              className="rounded-full p-1 text-muted hover:bg-danger-soft hover:text-danger"
              title="Remove"
            >
              <Trash2 size={13} />
            </button>
          </motion.span>
        ))}
      </div>
      <Field label="Add rate (%)">
        {(id) => (
          <div className="flex max-w-xs gap-2">
            <Input
              id={id}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && add()}
              placeholder="e.g. 12"
            />
            <Button variant="primary" onClick={add}>
              Add
            </Button>
          </div>
        )}
      </Field>
    </Card>
  );
}

/** Warranty & claims: expiring window, replacement warranty, claim slip, common complaints. */
function WarrantyTab() {
  const toast = useToast();
  const [values, setValues] = useState(null);
  const [draft, setDraft] = useState(null);
  useEffect(() => {
    settingsApi
      .get()
      .then((v) => {
        setValues(v);
        setDraft({ ...v, issues_text: issuesText(v.claim_issue_presets) });
      })
      .catch(toast.error);
  }, [toast]);

  async function save(patch, message = 'Saved.') {
    try {
      const next = await settingsApi.update(patch);
      setValues(next);
      setDraft((d) => ({ ...d, ...patch }));
      toast.success(message);
    } catch (err) {
      toast.error(err);
    }
  }

  if (!values || !draft) return <Skeleton className="h-60" />;
  const changedText =
    draft.warranty_expiring_days !== values.warranty_expiring_days ||
    draft.claim_terms !== values.claim_terms ||
    draft.issues_text !== issuesText(values.claim_issue_presets);

  function saveText() {
    const lines = draft.issues_text
      .split('\n')
      .map((s) => s.trim().slice(0, 60))
      .filter(Boolean)
      .slice(0, 30);
    let presets = {};
    try {
      presets = values.claim_issue_presets ? JSON.parse(values.claim_issue_presets) : {};
    } catch {
      presets = {};
    }
    if (lines.length) presets['*'] = lines;
    else delete presets['*'];
    save({
      warranty_expiring_days: draft.warranty_expiring_days,
      claim_terms: draft.claim_terms,
      claim_issue_presets: Object.keys(presets).length ? JSON.stringify(presets) : '',
    });
  }

  return (
    <div className="space-y-5">
      <Card
        title="Warranty"
        description="Status is worked out from the dates every time; nothing here changes saved bills."
      >
        <div className="space-y-4">
          <SettingRow
            title="“Expiring soon” window"
            hint="Warranties ending within this many days are shown in amber."
          >
            <Input
              className="w-24! text-right"
              inputMode="numeric"
              maxLength={3}
              value={draft.warranty_expiring_days ?? ''}
              onChange={(e) =>
                setDraft((d) => ({
                  ...d,
                  warranty_expiring_days: e.target.value.replace(/\D/g, ''),
                }))
              }
            />
          </SettingRow>
          <SettingRow
            title="Warranty of a replacement unit"
            hint="Default for replacements; a claim can override it with a reason."
          >
            <Segmented
              layoutId="repl-warranty"
              value={values.replacement_warranty}
              onChange={(v) => save({ replacement_warranty: v })}
              options={[
                { value: 'remaining', label: 'Remaining of old unit' },
                { value: 'fresh', label: 'Fresh warranty' },
              ]}
            />
          </SettingRow>
          <SettingRow
            title="Claim slip printer"
            hint="A4 prints a customer copy and a shop copy on one page."
          >
            <Segmented
              layoutId="slip-format"
              value={values.claim_slip_format}
              onChange={(v) => save({ claim_slip_format: v })}
              options={[
                { value: 'a4half', label: 'A4 · 2 copies' },
                { value: 'thermal80', label: 'Thermal 80 mm' },
              ]}
            />
          </SettingRow>
        </div>
      </Card>
      <Card
        title="Claim slips"
        description="Printed on every claim slip / job card, after the product's own warranty terms."
      >
        <div className="grid grid-cols-2 gap-3">
          <Field label="Claim terms">
            {(id) => (
              <Textarea
                id={id}
                rows={5}
                maxLength={1500}
                value={draft.claim_terms ?? ''}
                onChange={(e) => setDraft((d) => ({ ...d, claim_terms: e.target.value }))}
              />
            )}
          </Field>
          <Field
            label="More common complaints (one per line)"
            hint="Shown as quick picks on every new claim, after the built-in ones for the category."
          >
            {(id) => (
              <Textarea
                id={id}
                rows={5}
                value={draft.issues_text}
                onChange={(e) => setDraft((d) => ({ ...d, issues_text: e.target.value }))}
              />
            )}
          </Field>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          {changedText && (
            <Button
              variant="ghost"
              onClick={() =>
                setDraft({ ...values, issues_text: issuesText(values.claim_issue_presets) })
              }
            >
              Undo changes
            </Button>
          )}
          <Button variant="primary" disabled={!changedText} onClick={saveText}>
            Save
          </Button>
        </div>
      </Card>
    </div>
  );
}

function issuesText(json) {
  try {
    return ((json ? JSON.parse(json) : {})['*'] || []).join('\n');
  } catch {
    return '';
  }
}

export default function Settings() {
  const [tab, setTab] = useState('branding');
  return (
    <div className="mx-auto max-w-6xl space-y-5 p-6">
      <div className="flex flex-wrap gap-1 rounded-xl border border-border bg-surface p-1">
        {TABS.map((t) => {
          const Icon = t.icon;
          const active = t.id === tab;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={`relative flex h-9 items-center gap-2 rounded-lg px-4 font-medium ${active ? 'text-primary' : 'text-muted hover:text-fg'}`}
            >
              {active && (
                <motion.span
                  layoutId="settings-tab"
                  transition={{ type: 'spring', stiffness: 500, damping: 40 }}
                  className="absolute inset-0 rounded-lg bg-primary-soft"
                />
              )}
              <Icon size={16} className="relative" />
              <span className="relative">{t.label}</span>
            </button>
          );
        })}
      </div>
      {tab === 'branding' && <BrandingTab />}
      {tab === 'billing' && <BillingTab />}
      {tab === 'appearance' && <AppearanceTab />}
      {tab === 'series' && <SeriesTab />}
      {tab === 'gst' && <GstTab />}
      {tab === 'purchases' && <PurchasesTab />}
      {tab === 'warranty' && <WarrantyTab />}
    </div>
  );
}
