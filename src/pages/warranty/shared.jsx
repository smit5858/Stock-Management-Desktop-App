import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { Badge } from '../../components/Feedback';
import { useToast } from '../../components/Toast';
import { claimsApi, warrantyApi } from '../../api/warranty';
import { formatDate } from '../../utils/dates';

export const UNIT_TONE = {
  active: 'success',
  expiring: 'warning',
  expired: 'danger',
  under_claim: 'info',
  replaced: 'neutral',
  refunded: 'neutral',
  void: 'neutral',
  none: 'neutral',
};

const BAR = {
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-danger',
  info: 'bg-info',
  neutral: 'bg-muted',
};

export const CLAIM_TONE = {
  received: 'primary',
  inspecting: 'primary',
  repairing: 'warning',
  at_supplier: 'info',
  awaiting_replacement: 'warning',
  ready: 'success',
  returned: 'success',
  closed: 'neutral',
  rejected: 'danger',
  cancelled: 'neutral',
};

export const SLIP_FORMATS = [
  { value: 'a4half', label: 'A4 · 2 copies' },
  { value: 'thermal80', label: 'Thermal 80 mm' },
];

/** Print adapters for PrintPreviewModal (id = claim id / card reference). */
export const slipPrinter = (doc) => ({
  previewHtml: (id, f) => claimsApi.slipHtml(id, doc, f),
  print: (id, f) => claimsApi.slipPrint(id, doc, f),
  savePdf: (id, f) => claimsApi.slipPdf(id, doc, f),
});
export const cardPrinter = {
  previewHtml: (ref, f) => warrantyApi.cardHtml(ref, f),
  print: (ref, f) => warrantyApi.cardPrint(ref, f),
  savePdf: (ref, f) => warrantyApi.cardPdf(ref, f),
};

export function daysText(status) {
  const d = status?.days_left;
  if (d == null) return '';
  if (d < 0) return `expired ${-d} day${d === -1 ? '' : 's'} ago`;
  if (d === 0) return 'last day today';
  return `${d} day${d === 1 ? '' : 's'} left`;
}

/** Unit / bill-line warranty status ({ status, label, days_left, void_label }). */
export function WarrantyBadge({ status, showDays = false }) {
  if (!status) return null;
  const tone = UNIT_TONE[status.status] || 'neutral';
  return (
    <Badge tone={tone} dot>
      {status.label}
      {status.status === 'void' && status.void_label ? ` · ${status.void_label}` : ''}
      {showDays && ['active', 'expiring'].includes(status.status) && status.days_left != null
        ? ` · ${status.days_left}d`
        : ''}
    </Badge>
  );
}

export function ClaimBadge({ status, label, overdue }) {
  if (overdue) {
    return (
      <Badge tone="danger" dot>
        {label} · overdue
      </Badge>
    );
  }
  return (
    <Badge tone={CLAIM_TONE[status] || 'neutral'} dot>
      {label}
    </Badge>
  );
}

/** Share of the warranty used up. */
export function WarrantyBar({ status }) {
  if (!status || status.progress_bp == null) return null;
  const tone = UNIT_TONE[status.status] || 'neutral';
  const pct = Math.min(100, status.progress_bp / 100);
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-surface-3">
      <motion.div
        initial={{ width: 0 }}
        animate={{ width: `${pct}%` }}
        transition={{ duration: 0.25, ease: 'easeOut' }}
        className={`h-full rounded-full ${BAR[tone]}`}
      />
    </div>
  );
}

export function Info({ label, children, className = '' }) {
  return (
    <div className={`min-w-0 ${className}`}>
      <div className="text-xs text-muted">{label}</div>
      <div className="truncate font-medium">{children || '—'}</div>
    </div>
  );
}

export function Card({ title, right, children, className = '' }) {
  return (
    <section className={`rounded-xl border border-border p-3 ${className}`}>
      {(title || right) && (
        <div className="mb-2 flex items-center justify-between gap-2">
          <h3 className="text-xs font-semibold tracking-wide text-muted uppercase">{title}</h3>
          {right}
        </div>
      )}
      {children}
    </section>
  );
}

/** Vertical history list: [{ key, date, label, note }]. */
export function Timeline({ items }) {
  if (!items || items.length === 0) return <p className="text-sm text-muted">No history yet.</p>;
  return (
    <ol className="relative space-y-2.5 border-l border-border pl-4">
      {items.map((e) => (
        <li key={e.key || e.id} className="text-sm">
          <span
            className={`absolute -left-[5px] mt-1.5 h-2.5 w-2.5 rounded-full ${e.source === 'claim' ? 'bg-info' : 'bg-primary'}`}
          />
          <div className="font-medium">{e.label}</div>
          <div className="text-xs text-muted">
            {formatDate(e.date)}
            {e.actor ? ` · ${e.actor}` : ''}
            {e.note ? ` · ${e.note}` : ''}
          </div>
        </li>
      ))}
    </ol>
  );
}

/** Loads on mount and whenever `deps` change; keeps the last data while reloading. */
export function useLoad(fn, deps) {
  const toast = useToast();
  const [state, setState] = useState({ key: null, data: null });
  const [seq, setSeq] = useState(0);
  const key = JSON.stringify([deps, seq]);
  useEffect(() => {
    let cancelled = false;
    fn()
      .then((d) => !cancelled && setState({ key, data: d }))
      .catch((e) => !cancelled && toast.error(e));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return {
    data: state.data,
    loading: state.key !== key,
    reload: () => setSeq((n) => n + 1),
    setData: (d) => setState({ key, data: d }),
  };
}
