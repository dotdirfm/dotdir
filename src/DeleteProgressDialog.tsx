import { useRef } from 'react';
import { focusContext } from './focusContext';
import { useEffect } from 'react';

export interface DeleteProgressDialogProps {
  total: number;
  current: number;
  currentPath: string;
  onCancel: () => void;
}

export function DeleteProgressDialog({
  total,
  current,
  currentPath,
  onCancel,
}: DeleteProgressDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
    focusContext.push('modal');
    return () => {
      focusContext.pop('modal');
    };
  }, []);

  return (
    <dialog ref={dialogRef} className="modal-dialog delete-progress-dialog">
      <div className="modal-dialog-header">Permanently deleting</div>
      <div className="modal-dialog-body">
        <div className="delete-progress-text">
          {current} of {total} items
        </div>
        <div className="delete-progress-path" title={currentPath}>
          {currentPath}
        </div>
        <p className="delete-progress-hint">Already deleted items cannot be recovered.</p>
      </div>
      <div className="modal-dialog-buttons">
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </dialog>
  );
}
