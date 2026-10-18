import { useEffect, useState } from 'react';

/** Shown while the main process makes the closing backup and closes the database. */
export default function ClosingOverlay() {
  const [closing, setClosing] = useState(false);
  useEffect(() => window.api.onAppClosing(() => setClosing(true)), []);
  if (!closing) return null;
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-900/70">
      <div className="rounded-lg bg-white px-8 py-6 text-center shadow-xl">
        <div className="text-base font-semibold">Closing safely…</div>
        <div className="mt-1 text-slate-600">
          Saving a backup. Do not remove the USB drive until this window disappears.
        </div>
      </div>
    </div>
  );
}
