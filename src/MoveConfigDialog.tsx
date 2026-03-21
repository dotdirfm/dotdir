import { useEffect, useRef, useState } from 'react';
import { focusContext } from './focusContext';
import { useDialogButtonNav } from './useDialogButtonNav';
import type { ConflictPolicy, MoveOptions } from './bridge';
import { SmartLabel } from './dialogHotkeys';

export interface MoveConfigDialogProps {
  itemCount: number;
  destPath: string;
  onConfirm: (options: MoveOptions, destDir: string) => void;
  onCancel: () => void;
}

export function MoveConfigDialog({ itemCount, destPath, onConfirm, onCancel }: MoveConfigDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const buttonsRef = useRef<HTMLDivElement>(null);
  const [destValue, setDestValue] = useState(destPath);
  const [conflictPolicy, setConflictPolicy] = useState<ConflictPolicy>('ask');
  const { onKeyDown } = useDialogButtonNav(buttonsRef, { defaultIndex: 1 });

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
    focusContext.push('modal');
    return () => { focusContext.pop('modal'); };
  }, []);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = destValue.trim();
    if (!trimmed) return;
    onConfirm({ conflictPolicy }, trimmed);
  };

  return (
    <dialog ref={dialogRef} className="modal-dialog move-config-dialog" onCancel={(e) => { e.preventDefault(); onCancel(); }} onKeyDown={onKeyDown}>
      <div className="modal-dialog-header">
        Move {itemCount} item{itemCount !== 1 ? 's' : ''}
      </div>
      <form onSubmit={handleSubmit}>
        <div className="modal-dialog-body">
          <div className="copy-config-field">
            <label htmlFor="move-dest"><SmartLabel>Destination</SmartLabel></label>
            <input
              id="move-dest"
              type="text"
              value={destValue}
              onChange={(e) => setDestValue(e.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
          </div>

          <div className="copy-config-field">
            <label htmlFor="move-conflict"><SmartLabel>Conflict handling</SmartLabel></label>
            <select
              id="move-conflict"
              value={conflictPolicy}
              onChange={(e) => setConflictPolicy(e.target.value as ConflictPolicy)}
            >
              <option value="ask">Ask</option>
              <option value="overwrite">Overwrite</option>
              <option value="skip">Skip</option>
              <option value="rename">Auto-rename</option>
              <option value="onlyNewer">Only newer</option>
            </select>
          </div>
        </div>
        <div className="modal-dialog-buttons" ref={buttonsRef}>
          <button type="button" onClick={onCancel}><SmartLabel>Cancel</SmartLabel></button>
          <button type="submit" disabled={!destValue.trim()}><SmartLabel>Move</SmartLabel></button>
        </div>
      </form>
    </dialog>
  );
}
