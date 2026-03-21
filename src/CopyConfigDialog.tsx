import { useEffect, useRef, useState } from 'react';
import { focusContext } from './focusContext';
import { useDialogButtonNav } from './useDialogButtonNav';
import type { ConflictPolicy, CopyOptions, SymlinkMode } from './bridge';

export interface CopyConfigDialogProps {
  itemCount: number;
  destPath: string;
  onConfirm: (options: CopyOptions) => void;
  onCancel: () => void;
}

export function CopyConfigDialog({ itemCount, destPath, onConfirm, onCancel }: CopyConfigDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const buttonsRef = useRef<HTMLDivElement>(null);
  const [conflictPolicy, setConflictPolicy] = useState<ConflictPolicy>('ask');
  const [symlinkMode, setSymlinkMode] = useState<SymlinkMode>('smart');
  const [copyPermissions, setCopyPermissions] = useState(true);
  const [copyXattrs, setCopyXattrs] = useState(false);
  const [sparseFiles, setSparseFiles] = useState(false);
  const [useCow, setUseCow] = useState(false);
  const [disableWriteCache, setDisableWriteCache] = useState(false);
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
    onConfirm({
      conflictPolicy,
      copyPermissions,
      copyXattrs,
      sparseFiles,
      useCow,
      symlinkMode,
      disableWriteCache,
    });
  };

  return (
    <dialog ref={dialogRef} className="modal-dialog copy-config-dialog" onCancel={(e) => { e.preventDefault(); onCancel(); }} onKeyDown={onKeyDown}>
      <div className="modal-dialog-header">
        Copy {itemCount} item{itemCount !== 1 ? 's' : ''} to
      </div>
      <form onSubmit={handleSubmit}>
        <div className="modal-dialog-body">
          <div className="copy-config-dest" title={destPath}>{destPath}</div>

          <div className="copy-config-grid">
            <fieldset className="copy-config-section">
              <legend>Conflict handling</legend>
              <label><input type="radio" name="conflict" value="ask" checked={conflictPolicy === 'ask'} onChange={() => setConflictPolicy('ask')} /> Ask</label>
              <label><input type="radio" name="conflict" value="overwrite" checked={conflictPolicy === 'overwrite'} onChange={() => setConflictPolicy('overwrite')} /> Overwrite</label>
              <label><input type="radio" name="conflict" value="skip" checked={conflictPolicy === 'skip'} onChange={() => setConflictPolicy('skip')} /> Skip</label>
              <label><input type="radio" name="conflict" value="rename" checked={conflictPolicy === 'rename'} onChange={() => setConflictPolicy('rename')} /> Auto-rename</label>
              <label><input type="radio" name="conflict" value="onlyNewer" checked={conflictPolicy === 'onlyNewer'} onChange={() => setConflictPolicy('onlyNewer')} /> Only newer</label>
            </fieldset>

            <fieldset className="copy-config-section">
              <legend>Symlinks</legend>
              <label><input type="radio" name="symlink" value="smart" checked={symlinkMode === 'smart'} onChange={() => setSymlinkMode('smart')} /> Smart</label>
              <label><input type="radio" name="symlink" value="alwaysLink" checked={symlinkMode === 'alwaysLink'} onChange={() => setSymlinkMode('alwaysLink')} /> Copy link</label>
              <label><input type="radio" name="symlink" value="alwaysTarget" checked={symlinkMode === 'alwaysTarget'} onChange={() => setSymlinkMode('alwaysTarget')} /> Copy target</label>
            </fieldset>

            <fieldset className="copy-config-section">
              <legend>Options</legend>
              <label><input type="checkbox" checked={copyPermissions} onChange={(e) => setCopyPermissions(e.target.checked)} /> Copy permissions</label>
              <label><input type="checkbox" checked={copyXattrs} onChange={(e) => setCopyXattrs(e.target.checked)} /> Copy extended attributes</label>
              <label><input type="checkbox" checked={sparseFiles} onChange={(e) => setSparseFiles(e.target.checked)} /> Sparse files</label>
              <label><input type="checkbox" checked={useCow} onChange={(e) => setUseCow(e.target.checked)} /> Use CoW (copy-on-write)</label>
              <label><input type="checkbox" checked={disableWriteCache} onChange={(e) => setDisableWriteCache(e.target.checked)} /> Disable write cache</label>
            </fieldset>
          </div>
        </div>
        <div className="modal-dialog-buttons" ref={buttonsRef}>
          <button type="button" onClick={onCancel}>Cancel</button>
          <button type="submit">Copy</button>
        </div>
      </form>
    </dialog>
  );
}
