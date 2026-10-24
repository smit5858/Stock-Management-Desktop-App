import { useEffect, useRef } from 'react';
import Button from './Button';
import { Modal } from './Overlay';

/** Confirm dialog. The confirm button has focus (Enter confirms); Escape cancels. */
export default function ConfirmDialog({
  open = true,
  title,
  children,
  confirmLabel = 'Confirm',
  danger = false,
  busy = false,
  onConfirm,
  onCancel,
}) {
  const confirmRef = useRef(null);
  useEffect(() => {
    if (open) setTimeout(() => confirmRef.current?.focus(), 30);
  }, [open]);

  return (
    <Modal
      open={open}
      onClose={busy ? () => {} : onCancel}
      title={title}
      footer={
        <>
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
        </>
      }
    >
      <div className="text-muted">{children}</div>
    </Modal>
  );
}
