import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { Bell, ClipboardList, PackageCheck, ShieldAlert, Truck } from 'lucide-react';
import { warrantyApi } from '../../api/warranty';
import { formatDate } from '../../utils/dates';

const REFRESH_MS = 60_000;

/**
 * In-app alerts (offline): claims ready for pickup, units overdue at the supplier, warranties
 * ending this month. Refreshed on every page change and once a minute; a click opens the list.
 */
export default function Notifications() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [data, setData] = useState(null);
  // The list is open only on the page it was opened on (a new page closes it).
  const [openOn, setOpenOn] = useState(null);
  const open = openOn === pathname;
  const boxRef = useRef(null);

  const load = useCallback(
    () =>
      warrantyApi
        .alerts()
        .then(setData)
        .catch(() => {}),
    [],
  );
  // A new page: refresh the counts.
  useEffect(() => {
    load();
  }, [load, pathname]);
  useEffect(() => {
    const t = setInterval(load, REFRESH_MS);
    return () => clearInterval(t);
  }, [load]);
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => boxRef.current && !boxRef.current.contains(e.target) && setOpenOn(null);
    const onKey = (e) => e.key === 'Escape' && setOpenOn(null);
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const go = (to) => {
    setOpenOn(null);
    navigate(to);
  };
  const total = data ? data.total : 0;

  return (
    <div ref={boxRef} className="relative">
      <button
        type="button"
        title="Alerts"
        onClick={() => {
          if (!open) load();
          setOpenOn(open ? null : pathname);
        }}
        className="relative flex h-9 w-9 items-center justify-center rounded-lg text-muted transition-colors hover:bg-surface-2 hover:text-fg"
      >
        <Bell size={18} />
        {total > 0 && (
          <motion.span
            key={total}
            initial={{ scale: 0.6 }}
            animate={{ scale: 1 }}
            className="absolute top-1 right-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-danger px-1 text-[10px] font-bold text-white"
          >
            {total > 99 ? '99+' : total}
          </motion.span>
        )}
      </button>
      <AnimatePresence>
        {open && data && (
          <motion.div
            initial={{ opacity: 0, y: -6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, transition: { duration: 0.1 } }}
            transition={{ duration: 0.14 }}
            className="absolute top-11 right-0 z-50 w-96 overflow-hidden rounded-2xl border border-border bg-surface shadow-2xl"
          >
            <div className="border-b border-border px-4 py-2.5 text-sm font-semibold">Alerts</div>
            <div className="max-h-[60vh] overflow-auto p-2 text-sm">
              {data.overdue.map((c) => (
                <button
                  key={`o${c.id}`}
                  type="button"
                  onClick={() => go(`/warranty?claim=${c.id}`)}
                  className="flex w-full items-start gap-3 rounded-lg px-3 py-2 text-left hover:bg-surface-2"
                >
                  <Truck size={16} className="mt-0.5 shrink-0 text-danger" />
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium">
                      {c.claim_no} overdue at {c.supplier_name}
                    </span>
                    <span className="block truncate text-xs text-muted">
                      {c.product_name} · expected {formatDate(c.expected_date)}
                    </span>
                  </span>
                </button>
              ))}
              {data.ready.map((c) => (
                <button
                  key={`r${c.id}`}
                  type="button"
                  onClick={() => go(`/warranty?claim=${c.id}`)}
                  className="flex w-full items-start gap-3 rounded-lg px-3 py-2 text-left hover:bg-surface-2"
                >
                  <PackageCheck size={16} className="mt-0.5 shrink-0 text-success" />
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium">
                      {c.claim_no}{' '}
                      {c.status === 'rejected' ? 'to return (rejected)' : 'ready for pickup'}
                    </span>
                    <span className="block truncate text-xs text-muted">
                      {c.product_name}
                      {c.customer_name ? ` · ${c.customer_name}` : ''}
                    </span>
                  </span>
                </button>
              ))}
              <button
                type="button"
                onClick={() => go('/warranty?tab=open')}
                className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left hover:bg-surface-2"
              >
                <ClipboardList size={16} className="shrink-0 text-info" />
                <span className="flex-1">
                  {data.open_claims} open warranty claim{data.open_claims === 1 ? '' : 's'}
                </span>
              </button>
              <button
                type="button"
                onClick={() => go('/warranty?tab=expiring')}
                className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left hover:bg-surface-2"
              >
                <ShieldAlert size={16} className="shrink-0 text-warning" />
                <span className="flex-1">
                  {data.expiring_this_month} warrant
                  {data.expiring_this_month === 1 ? 'y ends' : 'ies end'} this month
                </span>
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
