import { useEffect, useRef, useState } from 'react';
import { focusContext } from './focusContext';
import { SmartLabel } from './dialogHotkeys';

export interface RenameDialogProps {
  currentName: string;
  onConfirm: (newName: string) => void;
  onCancel: () => void;
}

export function RenameDialog({ currentName, onConfirm, onCancel }: RenameDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [newName, setNewName] = useState(currentName);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
    focusContext.push('modal');
    // Select the filename without extension
    const input = inputRef.current;
    if (input) {
      input.focus();
      const dotIndex = currentName.lastIndexOf('.');
      if (dotIndex > 0) {
        input.setSelectionRange(0, dotIndex);
      } else {
        input.select();
      }
    }
    const handleClose = () => onCancel();
    dialog.addEventListener('close', handleClose);
    return () => {
      dialog.removeEventListener('close', handleClose);
      focusContext.pop('modal');
    };
  }, [onCancel, currentName]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = newName.trim();
    if (!trimmed || trimmed === currentName) return;
    dialogRef.current?.close();
    onConfirm(trimmed);
  };

  const handleCancel = () => {
    dialogRef.current?.close();
    onCancel();
  };

  return (
    <dialog ref={dialogRef} className="modal-dialog rename-dialog" onCancel={handleCancel}>
      <div className="modal-dialog-header">Rename</div>
      <form className="rename-form" onSubmit={handleSubmit}>
        <div className="modal-dialog-body">
          <div className="rename-field">
            <label htmlFor="rename-input"><SmartLabel>New name</SmartLabel></label>
            <input
              ref={inputRef}
              id="rename-input"
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              autoComplete="off"
            />
          </div>
        </div>
        <div className="modal-dialog-buttons">
          <button type="button" onClick={handleCancel}><SmartLabel>Cancel</SmartLabel></button>
          <button type="submit" disabled={!newName.trim() || newName.trim() === currentName}>
            <SmartLabel>Rename</SmartLabel>
          </button>
        </div>
      </form>
    </dialog>
  );
}
