import { useEffect, useRef } from 'react';
import Button from './Button';

/** Modal confirm. The confirm button has focus (Enter confirms); Escape cancels. */
export default function ConfirmDialog({
  title,
  children,
  confirmLabel = 'Confirm',
  danger = false,
  busy = false,
  onConfirm,
  onCancel,
}) {
  const confirmRef = useRef(null);
  useEffect(() => confirmRef.current?.focus(), []);

  function onKeyDown(event) {
    if (event.key === 'Escape' && !busy) onCancel();
  }

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-slate-900/40"
      onKeyDown={onKeyDown}
    >
      <div role="dialog" aria-modal="true" className="w-[28rem] rounded-lg bg-white p-5 shadow-xl">
        <h2 className="mb-2 text-base font-semibold">{title}</h2>
        <div className="mb-5 text-slate-600">{children}</div>
        <div className="flex justify-end gap-2">
          <Button onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button
            ref={confirmRef}
            variant={danger ? 'danger' : 'primary'}
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? 'Please wait…' : confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
