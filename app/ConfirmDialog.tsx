import type { RefObject } from "react";

type ConfirmDialogProps = {
  title: string;
  message: string;
  confirmLabel: string;
  busy: boolean;
  cancelRef: RefObject<HTMLButtonElement | null>;
  onCancel: () => void;
  onConfirm: () => void;
};

export default function ConfirmDialog({ title, message, confirmLabel, busy, cancelRef, onCancel, onConfirm }: ConfirmDialogProps) {
  return (
    <div className="queue-conflict-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && !busy && onCancel()}>
      <section className="queue-conflict-dialog closure-confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="confirm-dialog-title" aria-describedby="confirm-dialog-message">
        <span className="queue-conflict-icon delete-icon" aria-hidden="true">×</span>
        <div className="queue-conflict-heading">
          <h3 id="confirm-dialog-title">{title}</h3>
          <p id="confirm-dialog-message">{message}</p>
        </div>
        <div className="closure-confirm-actions">
          <button ref={cancelRef} type="button" onClick={onCancel} disabled={busy}>ยกเลิก</button>
          <button type="button" onClick={onConfirm} disabled={busy}>{busy ? "กำลังลบ…" : confirmLabel}</button>
        </div>
      </section>
    </div>
  );
}
