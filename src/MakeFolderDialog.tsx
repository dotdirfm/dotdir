import { useEffect, useRef, useState } from 'react';
import { focusContext } from './focusContext';

export interface MakeFolderDialogProps {
  currentPath: string;
  onConfirm: (folderName: string) => void;
  onCancel: () => void;
}

export function MakeFolderDialog({
  currentPath: _currentPath,
  onConfirm,
  onCancel,
}: MakeFolderDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [folderName, setFolderName] = useState('');

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    dialog.showModal();
    focusContext.push('modal');
    inputRef.current?.focus();
    const handleClose = () => onCancel();
    dialog.addEventListener('close', handleClose);
    return () => {
      dialog.removeEventListener('close', handleClose);
      focusContext.pop('modal');
    };
  }, [onCancel]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const name = folderName.trim();
    if (!name) return;
    dialogRef.current?.close();
    onConfirm(name);
  };

  const handleCancel = () => {
    dialogRef.current?.close();
    onCancel();
  };

  return (
    <dialog ref={dialogRef} className="modal-dialog make-folder-dialog" onCancel={handleCancel}>
      <div className="modal-dialog-header">Make Folder</div>
      <form className="make-folder-form" onSubmit={handleSubmit}>
        <div className="modal-dialog-body">
          <div className="make-folder-field">
            <label htmlFor="make-folder-name">Folder name</label>
            <input
              ref={inputRef}
              id="make-folder-name"
              type="text"
              value={folderName}
              onChange={(e) => setFolderName(e.target.value)}
              placeholder="e.g. my-folder"
              autoComplete="off"
            />
          </div>
        </div>
        <div className="modal-dialog-buttons">
          <button type="button" onClick={handleCancel}>
            Cancel
          </button>
          <button type="submit" disabled={!folderName.trim()}>
            OK
          </button>
        </div>
      </form>
    </dialog>
  );
}
