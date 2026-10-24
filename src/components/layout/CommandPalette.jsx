import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import {
  Car,
  ClipboardList,
  CornerDownLeft,
  Package,
  ReceiptText,
  ScanBarcode,
  Search,
  Truck,
  User,
} from 'lucide-react';
import { NAV_ITEMS } from '../../navigation';
import { productsApi, serialsApi } from '../../api/products';
import { partiesApi } from '../../api/parties';
import { salesApi } from '../../api/sales';
import { claimsApi } from '../../api/warranty';
import { formatMoney } from '../../utils/money';
import { Kbd } from '../Feedback';

/**
 * Ctrl+K: jump to a page or open a product. Arrow keys + Enter, Esc closes.
 * The parent remounts it (key) on every open, so it always starts empty.
 */
export default function CommandPalette({ open, onClose }) {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [found, setFound] = useState({ q: '', rows: [] });
  const [index, setIndex] = useState(0);
  const inputRef = useRef(null);
  const q = query.trim();
  // Only show results that belong to the current query.
  const products = useMemo(() => (q.length >= 2 && found.q === q ? found.rows : []), [q, found]);

  useEffect(() => {
    if (!open || q.length < 2) return undefined;
    let cancelled = false;
    const timer = setTimeout(() => {
      Promise.all([
        productsApi.search(q, 8).catch(() => []),
        serialsApi.search(q, 6).catch(() => []),
        partiesApi.search(q, { limit: 6 }).catch(() => []),
        /\d/.test(q)
          ? salesApi
              .list({ search: q })
              .then((r) => r.rows.slice(0, 5))
              .catch(() => [])
          : [],
        /\d/.test(q)
          ? claimsApi
              .list({ search: q })
              .then((r) => r.rows.slice(0, 5))
              .catch(() => [])
          : [],
      ]).then(
        ([rows, units, people, bills, claims]) =>
          !cancelled && setFound({ q, rows, units, people, bills, claims }),
      );
    }, 120);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [q, open]);

  const items = useMemo(() => {
    const q = query.trim().toLowerCase();
    const pages = NAV_ITEMS.filter((p) => !q || p.label.toLowerCase().includes(q)).map((p) => ({
      key: `page-${p.path}`,
      icon: p.icon,
      title: p.label,
      hint: `Alt+${p.key}`,
      run: () => navigate(p.path),
    }));
    const units = (found.q === query.trim() ? found.units || [] : []).map((s) => ({
      key: `serial-${s.id}`,
      icon: ScanBarcode,
      title: `${s.serial_no} · ${s.product_name}`,
      hint: s.status_label,
      // Sold units open their warranty card; units in the shop open the product's serials.
      run: () =>
        ['sold', 'under_claim', 'replaced'].includes(s.status)
          ? navigate(`/warranty?unit=s${s.id}`)
          : navigate(`/products?open=${s.product_id}&serial=${encodeURIComponent(s.serial_no)}`),
    }));
    const claims = (found.q === query.trim() ? found.claims || [] : []).map((c) => ({
      key: `claim-${c.id}`,
      icon: ClipboardList,
      title: `${c.claim_no} · ${c.product_name}${c.customer_name ? ` · ${c.customer_name}` : ''}`,
      hint: c.status_label,
      run: () => navigate(`/warranty?claim=${c.id}`),
    }));
    // Customers / suppliers by name, phone (any format) or number plate.
    const people = (found.q === query.trim() ? found.people || [] : []).map((p) => ({
      key: `party-${p.id}`,
      icon: p.matched_vehicle ? Car : p.type === 'supplier' ? Truck : User,
      title: p.matched_vehicle
        ? `${p.matched_vehicle.display} · ${p.name}`
        : `${p.name}${p.phone_display ? ` · ${p.phone_display}` : ''}`,
      hint:
        p.type === 'supplier'
          ? 'Supplier'
          : p.plates
              .slice(0, 2)
              .map((x) => x.display)
              .join(', ') || 'Customer',
      run: () => navigate(`/parties?open=${p.id}${p.type === 'supplier' ? '&tab=suppliers' : ''}`),
    }));
    const prods = products.map((v) => ({
      key: `variant-${v.variant_id}`,
      icon: Package,
      title: v.variant_label ? `${v.name} — ${v.variant_label}` : v.name,
      hint: `${v.sku} · ${formatMoney(v.selling_price)}`,
      run: () => navigate(`/products?open=${v.product_id}`),
    }));
    // Bills by invoice no., phone or vehicle number.
    const bills = (found.q === query.trim() ? found.bills || [] : []).map((b) => ({
      key: `bill-${b.id}`,
      icon: ReceiptText,
      title: `${b.invoice_no} · ${b.customer_name}${b.vehicle_no ? ` · ${b.vehicle_no}` : ''}`,
      hint: `${formatMoney(b.grand_total)}${b.status === 'cancelled' ? ' · cancelled' : ''}`,
      run: () => navigate(`/sales?open=${b.id}`),
    }));
    return [...claims, ...bills, ...people, ...units, ...prods, ...pages];
  }, [query, products, found, navigate]);

  const active = Math.max(0, Math.min(index, items.length - 1));

  function onKeyDown(e) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setIndex(Math.min(active + 1, items.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setIndex(Math.max(active - 1, 0));
    } else if (e.key === 'Enter' && items[active]) {
      e.preventDefault();
      items[active].run();
      onClose();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  }

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-50 flex items-start justify-center bg-overlay pt-[12vh]"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.12 }}
          onMouseDown={(e) => e.target === e.currentTarget && onClose()}
        >
          <motion.div
            initial={{ opacity: 0, y: -10, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.98 }}
            transition={{ duration: 0.15 }}
            onAnimationComplete={() => inputRef.current?.focus()}
            className="w-[36rem] overflow-hidden rounded-2xl border border-border bg-surface shadow-2xl"
          >
            <div className="flex items-center gap-3 border-b border-border px-4">
              <Search size={18} className="text-muted" />
              <input
                ref={inputRef}
                autoFocus
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setIndex(0);
                }}
                onKeyDown={onKeyDown}
                placeholder="Search customers (phone, vehicle no.), products, serials, claims… or a page"
                className="h-14 flex-1 bg-transparent text-base outline-none placeholder:text-muted"
              />
              <Kbd>Esc</Kbd>
            </div>
            <ul className="max-h-96 overflow-auto p-2">
              {items.length === 0 && (
                <li className="px-3 py-6 text-center text-muted">No results</li>
              )}
              {items.map((item, i) => {
                const Icon = item.icon;
                const isActive = i === active;
                return (
                  <li key={item.key}>
                    <button
                      type="button"
                      onMouseEnter={() => setIndex(i)}
                      onClick={() => {
                        item.run();
                        onClose();
                      }}
                      className={`relative flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left ${
                        isActive ? 'text-fg' : 'text-muted'
                      }`}
                    >
                      {isActive && (
                        <motion.span
                          layoutId="palette-pill"
                          transition={{ duration: 0.12 }}
                          className="absolute inset-0 rounded-lg bg-primary-soft"
                        />
                      )}
                      <Icon size={17} className="relative shrink-0" />
                      <span className="relative flex-1 truncate font-medium">{item.title}</span>
                      <span className="relative text-xs text-muted">{item.hint}</span>
                      {isActive && <CornerDownLeft size={14} className="relative text-muted" />}
                    </button>
                  </li>
                );
              })}
            </ul>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
