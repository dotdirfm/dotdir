import { useEffect, useRef } from 'react';
import { focusContext } from './focusContext';
import { useDialogButtonNav } from './useDialogButtonNav';

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
  const buttonsRef = useRef<HTMLDivElement>(null);
  const resolvedButtons = buttons ?? [{ label: 'OK', default: true }];
  const defaultIdx = resolvedButtons.findIndex((b) => b.default);
  const { onKeyDown } = useDialogButtonNav(buttonsRef, {
    defaultIndex: defaultIdx >= 0 ? defaultIdx : resolvedButtons.length - 1,
  });

  useEffect(() => {
    const dialog = dialogRef.current!;
    if (!dialog.open) dialog.showModal();
    focusContext.push('modal');
    const handleClose = () => onClose();
    dialog.addEventListener('close', handleClose);
    return () => {
      dialog.removeEventListener('close', handleClose);
      focusContext.pop('modal');
    };
  }, [onClose]);

  return (
    <dialog ref={dialogRef} className={`modal-dialog ${variant}`} onKeyDown={onKeyDown}>
      {title && <div className="modal-dialog-header">{title}</div>}
      <div className="modal-dialog-body">{message}</div>
      <div className="modal-dialog-buttons" ref={buttonsRef}>
        {resolvedButtons.map((btn) => (
          <button
            key={btn.label}
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
