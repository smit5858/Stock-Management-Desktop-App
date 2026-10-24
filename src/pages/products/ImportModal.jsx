import { useState } from 'react';
import { motion } from 'framer-motion';
import { CheckCircle2, FileDown, FileSpreadsheet, TriangleAlert, Upload } from 'lucide-react';
import Button from '../../components/Button';
import { Modal } from '../../components/Overlay';
import { Badge } from '../../components/Feedback';
import { Toggle as Switch } from '../../components/Field';
import { useToast } from '../../components/Toast';
import { productsApi } from '../../api/products';
import { formatMoney } from '../../utils/money';
import { formatQty } from '../../utils/qty';

/** Remounted (key) on every open. Two steps: choose file → preview (with error report) → import valid rows in one transaction. */
export default function ImportModal({ open, onClose, onImported }) {
  const toast = useToast();
  const [preview, setPreview] = useState(null);
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [busy, setBusy] = useState(false);

  async function choose() {
    setBusy(true);
    try {
      const p = await productsApi.importPreview();
      if (p) {
        setPreview(p);
        setErrorsOnly(p.summary.error_rows > 0);
      }
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  }

  async function template() {
    try {
      const r = await productsApi.template();
      if (r.saved) toast.success(`Template saved: ${r.file_path}`);
    } catch (e) {
      toast.error(e);
    }
  }

  async function commit() {
    setBusy(true);
    try {
      const r = await productsApi.importCommit(preview.token);
      toast.success(`Imported ${r.products} products (${r.variants} items).`);
      onImported();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  }

  const s = preview?.summary;
  const rows = preview ? preview.rows.filter((r) => !errorsOnly || !r.ok) : [];

  return (
    <Modal
      open={open}
      onClose={onClose}
      dismissable={!busy}
      title="Import products from Excel / CSV"
      width="w-[60rem]"
      footer={
        preview ? (
          <>
            <Button onClick={() => setPreview(null)} disabled={busy}>
              Choose another file
            </Button>
            <Button variant="primary" icon={Upload} onClick={commit} disabled={busy || !s.products}>
              {busy ? 'Importing…' : `Import ${s.products} products`}
            </Button>
          </>
        ) : (
          <Button onClick={onClose}>Close</Button>
        )
      }
    >
      {!preview ? (
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
              <li>
                One row per product. Repeat the name on several rows for colour / size variants.
              </li>
              <li>Empty SKU = generated automatically.</li>
              <li>
                Vehicles: &ldquo;Universal&rdquo; or e.g. &ldquo;Maruti Suzuki Swift 2018-2024;
                Hyundai Creta&rdquo;.
              </li>
              <li>Missing categories are created. Existing products are never changed.</li>
            </ul>
            <Button size="sm" icon={FileDown} onClick={template}>
              Download template
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <Badge tone="neutral">{preview.file_name}</Badge>
            <Badge tone="success" dot>
              {s.ok_rows} rows ready
            </Badge>
            {s.error_rows > 0 && (
              <Badge tone="danger" dot>
                {s.error_rows} rows with errors (skipped)
              </Badge>
            )}
            <div className="ml-auto">
              <Switch label="Show only errors" checked={errorsOnly} onChange={setErrorsOnly} />
            </div>
          </div>
          {(s.new_categories.length > 0 || s.new_vehicles.length > 0) && (
            <div className="rounded-xl bg-primary-soft/50 px-4 py-2 text-sm">
              {s.new_categories.length > 0 && (
                <div>New categories: {s.new_categories.join(', ')}</div>
              )}
              {s.new_vehicles.length > 0 && <div>New vehicles: {s.new_vehicles.join(', ')}</div>}
            </div>
          )}
          <div className="max-h-[50vh] overflow-auto rounded-xl border border-border">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-surface-2 text-left text-xs text-muted">
                <tr>
                  <th className="px-3 py-2 font-medium">Row</th>
                  <th className="px-3 py-2 font-medium">Product</th>
                  <th className="px-3 py-2 font-medium">SKU</th>
                  <th className="px-3 py-2 text-right font-medium">Price</th>
                  <th className="px-3 py-2 text-right font-medium">Stock</th>
                  <th className="px-3 py-2 font-medium">Result</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rows.map((r) => (
                  <tr key={r.row_no} className={r.ok ? '' : 'bg-danger-soft/40'}>
                    <td className="px-3 py-2 text-muted">{r.row_no}</td>
                    <td className="px-3 py-2">
                      <div className="font-medium">{r.name || '—'}</div>
                      {r.variant_label && (
                        <div className="text-xs text-muted">{r.variant_label}</div>
                      )}
                    </td>
                    <td className="px-3 py-2 text-muted">{r.sku || 'auto'}</td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {formatMoney(r.selling_price)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {r.type === 'service' ? '—' : formatQty(r.opening_stock_milli)}
                    </td>
                    <td className="px-3 py-2">
                      {r.ok ? (
                        <CheckCircle2 size={16} className="text-success" />
                      ) : (
                        <div className="flex gap-1.5 text-xs text-danger">
                          <TriangleAlert size={14} className="mt-px shrink-0" />
                          <span>{r.errors.join(' ')}</span>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </Modal>
  );
}
