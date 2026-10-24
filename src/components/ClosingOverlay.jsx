import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Loader2 } from 'lucide-react';

/** Shown while the main process makes the closing backup and closes the database. */
export default function ClosingOverlay() {
  const [closing, setClosing] = useState(false);
  useEffect(() => window.api.onAppClosing(() => setClosing(true)), []);
  return (
    <AnimatePresence>
      {closing && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="fixed inset-0 z-90 flex items-center justify-center bg-overlay backdrop-blur-sm"
        >
          <div className="flex items-center gap-4 rounded-2xl border border-border bg-surface px-7 py-5 shadow-2xl">
            <Loader2 className="animate-spin text-primary" size={26} />
            <div>
              <div className="text-base font-semibold">Closing safely…</div>
              <div className="text-muted">
                Saving a backup. Do not remove the USB drive until this window disappears.
              </div>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
