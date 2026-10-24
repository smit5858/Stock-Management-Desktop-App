import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { animate, motion, useReducedMotion } from 'framer-motion';

export function Skeleton({ className = '' }) {
  return <div className={`skeleton rounded-md ${className}`} />;
}

const BADGE = {
  success: 'bg-success-soft text-success',
  warning: 'bg-warning-soft text-warning',
  danger: 'bg-danger-soft text-danger',
  primary: 'bg-primary-soft text-primary',
  info: 'bg-info-soft text-info',
  neutral: 'bg-surface-2 text-muted',
};

export function Badge({ tone = 'neutral', dot, children, className = '' }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap ${BADGE[tone]} ${className}`}
    >
      {dot && <span className="h-1.5 w-1.5 rounded-full bg-current" />}
      {children}
    </span>
  );
}

export function Kbd({ children }) {
  return (
    <kbd className="rounded border border-border bg-surface-2 px-1.5 py-px font-sans text-[11px] text-muted">
      {children}
    </kbd>
  );
}

export function EmptyState({ icon: Icon, title, children }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      className="flex flex-col items-center justify-center px-6 py-14 text-center"
    >
      {Icon && (
        <div className="mb-3 rounded-2xl bg-primary-soft p-4 text-primary">
          <Icon size={28} />
        </div>
      )}
      <div className="font-semibold">{title}</div>
      {children && <div className="mt-1 max-w-sm text-muted">{children}</div>}
    </motion.div>
  );
}

/** Counts up to `value` (integers). `format` turns the number into display text. */
export function AnimatedNumber({ value, format = (n) => n.toLocaleString('en-IN') }) {
  const reduce = useReducedMotion();
  const [display, setDisplay] = useState(value);
  const from = useRef(0);

  useEffect(() => {
    if (reduce) return undefined;
    const controls = animate(from.current, value, {
      duration: 0.6,
      ease: 'easeOut',
      onUpdate: (v) => setDisplay(Math.round(v)),
    });
    from.current = value;
    return () => controls.stop();
  }, [value, reduce]);

  return <>{format(reduce ? value : display)}</>;
}

/**
 * Hover tooltip to the right of the trigger (used by the collapsed sidebar). Rendered in a
 * portal so containers with overflow:hidden do not clip it.
 */
export function Tooltip({ label, show = true, children }) {
  const [pos, setPos] = useState(null);
  const open = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    setPos({ left: r.right + 10, top: r.top + r.height / 2 });
  };
  return (
    <div onMouseEnter={show ? open : undefined} onMouseLeave={() => setPos(null)}>
      {children}
      {show &&
        pos &&
        createPortal(
          <motion.div
            initial={{ opacity: 0, x: -4 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.12, delay: 0.1 }}
            style={{ left: pos.left, top: pos.top }}
            className="pointer-events-none fixed z-80 -translate-y-1/2 rounded-md bg-fg px-2 py-1 text-xs whitespace-nowrap text-bg shadow-lg"
          >
            {label}
          </motion.div>,
          document.body,
        )}
    </div>
  );
}
