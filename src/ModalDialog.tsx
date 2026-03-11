import { useEffect, useRef } from 'react';

interface ModalButton {
  label: string;
  default?: boolean;
  onClick?: () => void;
}

export interface ModalDialogProps {
  title?: string;
  message: string;
  variant?: 'error' | 'default';
  buttons?: ModalButton[];
  onClose: () => void;
}

export function ModalDialog({ title, message, variant = 'default', buttons, onClose }: ModalDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const resolvedButtons = buttons ?? [{ label: 'OK', default: true }];

  useEffect(() => {
    const dialog = dialogRef.current!;
    dialog.showModal();

    const handleClose = () => onClose();
    dialog.addEventListener('close', handleClose);
    return () => dialog.removeEventListener('close', handleClose);
  }, [onClose]);

  return (
    <dialog ref={dialogRef} className={`modal-dialog ${variant}`} onKeyDown={(e) => e.stopPropagation()}>
      {title && <div className="modal-dialog-header">{title}</div>}
      <div className="modal-dialog-body">{message}</div>
      <div className="modal-dialog-buttons">
        {resolvedButtons.map((btn) => (
          <button
            key={btn.label}
            autoFocus={btn.default}
            onClick={() => {
              btn.onClick?.();
              dialogRef.current?.close();
            }}
          >
            {btn.label}
          </button>
        ))}
      </div>
    </dialog>
  );
}
