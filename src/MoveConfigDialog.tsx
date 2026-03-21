import { useEffect, useRef, useState } from 'react';
import { focusContext } from './focusContext';
import { useDialogButtonNav } from './useDialogButtonNav';
import type { ConflictPolicy, MoveOptions } from './bridge';

export interface MoveConfigDialogProps {
  itemCount: number;
  destPath: string;
  onConfirm: (options: MoveOptions) => void;
  onCancel: () => void;
}

export function MoveConfigDialog({ itemCount, destPath, onConfirm, onCancel }: MoveConfigDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const buttonsRef = useRef<HTMLDivElement>(null);
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
    onConfirm({ conflictPolicy });
  };

  return (
    <dialog ref={dialogRef} className="modal-dialog move-config-dialog" onCancel={(e) => { e.preventDefault(); onCancel(); }} onKeyDown={onKeyDown}>
      <div className="modal-dialog-header">
        Move {itemCount} item{itemCount !== 1 ? 's' : ''} to
      </div>
      <form onSubmit={handleSubmit}>
        <div className="modal-dialog-body">
          <div className="copy-config-dest" title={destPath}>{destPath}</div>

          <fieldset className="copy-config-section">
            <legend>Conflict handling</legend>
            <label><input type="radio" name="conflict" value="ask" checked={conflictPolicy === 'ask'} onChange={() => setConflictPolicy('ask')} /> Ask</label>
            <label><input type="radio" name="conflict" value="overwrite" checked={conflictPolicy === 'overwrite'} onChange={() => setConflictPolicy('overwrite')} /> Overwrite</label>
            <label><input type="radio" name="conflict" value="skip" checked={conflictPolicy === 'skip'} onChange={() => setConflictPolicy('skip')} /> Skip</label>
            <label><input type="radio" name="conflict" value="rename" checked={conflictPolicy === 'rename'} onChange={() => setConflictPolicy('rename')} /> Auto-rename</label>
            <label><input type="radio" name="conflict" value="onlyNewer" checked={conflictPolicy === 'onlyNewer'} onChange={() => setConflictPolicy('onlyNewer')} /> Only newer</label>
          </fieldset>
        </div>
        <div className="modal-dialog-buttons" ref={buttonsRef}>
          <button type="button" onClick={onCancel}>Cancel</button>
          <button type="submit">Move</button>
        </div>
      </form>
    </dialog>
  );
}
