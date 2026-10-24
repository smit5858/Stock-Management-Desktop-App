import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { X } from 'lucide-react';
import Button from './Button';

const FAST = { duration: 0.18, ease: [0.2, 0.8, 0.2, 1] };

// Open overlays, topmost last: Escape only closes the topmost one (e.g. a modal over a drawer).
const stack = [];

export function useEscape(open, onClose) {
  const ref = useRef(onClose);
  useEffect(() => {
    ref.current = onClose;
  });
  useEffect(() => {
    if (!open) return undefined;
    const token = {};
    stack.push(token);
    const onKey = (e) => {
      if (e.key === 'Escape' && stack[stack.length - 1] === token) {
        e.stopPropagation();
        e.preventDefault();
        ref.current?.();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      stack.splice(stack.indexOf(token), 1);
    };
  }, [open]);
}

/** True while any modal or drawer is open (pages pause their single-key shortcuts). */
export function anyOverlayOpen() {
  return stack.length > 0;
}

/** Centered dialog. Escape and backdrop click close it (unless `dismissable` is false). */
export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  width = 'w-[30rem]',
  dismissable = true,
}) {
  useEscape(open && dismissable, onClose);
  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-50 flex items-center justify-center bg-overlay p-4"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={FAST}
          onMouseDown={(e) => dismissable && e.target === e.currentTarget && onClose()}
        >
          <motion.div
            role="dialog"
            aria-modal="true"
            className={`${width} max-h-full overflow-auto rounded-2xl border border-border bg-surface shadow-2xl`}
            initial={{ opacity: 0, scale: 0.96, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.97, y: 4 }}
            transition={FAST}
          >
            {title && (
              <div className="flex items-center justify-between border-b border-border px-5 py-3.5">
                <h2 className="text-base font-semibold">{title}</h2>
                {dismissable && (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    icon={X}
                    onClick={onClose}
                    aria-label="Close"
                  />
                )}
              </div>
            )}
            <div className="px-5 py-4">{children}</div>
            {footer && (
              <div className="flex justify-end gap-2 border-t border-border px-5 py-3">
                {footer}
              </div>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}

/** Panel that slides in from the right. */
export function Drawer({ open, onClose, title, subtitle, children, footer, width = 'w-[44rem]' }) {
  useEscape(open, onClose);
  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-40 flex justify-end bg-overlay"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={FAST}
          onMouseDown={(e) => e.target === e.currentTarget && onClose()}
        >
          <motion.aside
            role="dialog"
            aria-modal="true"
            className={`${width} flex h-full max-w-full flex-col border-l border-border bg-surface shadow-2xl`}
            initial={{ x: 48, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: 48, opacity: 0 }}
            transition={{ duration: 0.22, ease: [0.2, 0.8, 0.2, 1] }}
          >
            <header className="flex items-start justify-between gap-4 border-b border-border px-6 py-4">
              <div className="min-w-0">
                <h2 className="truncate text-lg font-semibold">{title}</h2>
                {subtitle && <p className="truncate text-sm text-muted">{subtitle}</p>}
              </div>
              <Button
                variant="ghost"
                size="icon"
                icon={X}
                onClick={onClose}
                aria-label="Close (Esc)"
              />
            </header>
            <div className="min-h-0 flex-1 overflow-auto px-6 py-5">{children}</div>
            {footer && (
              <footer className="flex items-center justify-end gap-2 border-t border-border bg-surface-2/50 px-6 py-3">
                {footer}
              </footer>
            )}
          </motion.aside>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
