import { useState } from "react";
import { Button } from "./Button";
import "./ConfirmDialog.css";

interface ConfirmDialogProps {
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
  destructive?: boolean;
  requireReason?: boolean;
  reasonLabel?: string;
  busy?: boolean;
  onConfirm: (reason?: string) => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  cancelLabel,
  destructive,
  requireReason,
  reasonLabel,
  busy,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const [reason, setReason] = useState("");
  const reasonMissing = requireReason && !reason.trim();

  return (
    <div className="confirm-dialog-overlay" onClick={busy ? undefined : onCancel}>
      <div className="confirm-dialog" role="alertdialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
        <h3>{title}</h3>
        <p className="body-s confirm-dialog-message">{message}</p>

        {requireReason && (
          <label className="confirm-dialog-reason">
            <span className="caption">{reasonLabel}</span>
            <textarea
              rows={3}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              disabled={busy}
              autoFocus
            />
          </label>
        )}

        <div className="confirm-dialog-actions">
          <Button variant="tertiary" onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </Button>
          <Button
            variant={destructive ? "destructive" : "primary"}
            loading={busy}
            disabled={reasonMissing}
            onClick={() => onConfirm(requireReason ? reason.trim() : undefined)}
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
