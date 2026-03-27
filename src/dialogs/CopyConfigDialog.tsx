import { useEffect, useRef, useState } from "react";
import { focusContext } from "../focusContext";
import { useDialogButtonNav } from "../hooks/useDialogButtonNav";
import type { ConflictPolicy, CopyOptions, SymlinkMode } from "../bridge";
import { SmartLabel } from "./dialogHotkeys";
import { INPUT_NO_ASSIST } from "../inputNoAssist";

export interface CopyConfigDialogProps {
  itemCount: number;
  destPath: string;
  onConfirm: (options: CopyOptions, destDir: string) => void;
  onCancel: () => void;
}

export function CopyConfigDialog({ itemCount, destPath, onConfirm, onCancel }: CopyConfigDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const buttonsRef = useRef<HTMLDivElement>(null);
  const [destValue, setDestValue] = useState(destPath);
  const [conflictPolicy, setConflictPolicy] = useState<ConflictPolicy>("ask");
  const [symlinkMode, setSymlinkMode] = useState<SymlinkMode>("smart");
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
    focusContext.push("modal");
    return () => {
      focusContext.pop("modal");
    };
  }, []);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = destValue.trim();
    if (!trimmed) return;
    onConfirm(
      {
        conflictPolicy,
        copyPermissions,
        copyXattrs,
        sparseFiles,
        useCow,
        symlinkMode,
        disableWriteCache,
      },
      trimmed,
    );
  };

  return (
    <dialog
      ref={dialogRef}
      className="modal-dialog copy-config-dialog"
      onCancel={(e) => {
        e.preventDefault();
        onCancel();
      }}
      onKeyDown={onKeyDown}
    >
      <div className="modal-dialog-header">
        Copy {itemCount} item{itemCount !== 1 ? "s" : ""}
      </div>
      <form onSubmit={handleSubmit}>
        <div className="modal-dialog-body">
          <div className="copy-config-field">
            <label htmlFor="copy-dest">
              <SmartLabel>Destination</SmartLabel>
            </label>
            <input id="copy-dest" type="text" value={destValue} onChange={(e) => setDestValue(e.target.value)} {...INPUT_NO_ASSIST} />
          </div>

          <div className="copy-config-field">
            <label htmlFor="copy-conflict">
              <SmartLabel>Conflict handling</SmartLabel>
            </label>
            <select id="copy-conflict" value={conflictPolicy} onChange={(e) => setConflictPolicy(e.target.value as ConflictPolicy)}>
              <option value="ask">Ask</option>
              <option value="overwrite">Overwrite</option>
              <option value="skip">Skip</option>
              <option value="rename">Auto-rename</option>
              <option value="onlyNewer">Only newer</option>
            </select>
          </div>

          <div className="copy-config-field">
            <label htmlFor="copy-symlink">
              <SmartLabel>Symlinks</SmartLabel>
            </label>
            <select id="copy-symlink" value={symlinkMode} onChange={(e) => setSymlinkMode(e.target.value as SymlinkMode)}>
              <option value="smart">Smart</option>
              <option value="alwaysLink">Copy link</option>
              <option value="alwaysTarget">Copy target</option>
            </select>
          </div>

          <fieldset className="copy-config-section">
            <legend>Options</legend>
            <label>
              <input type="checkbox" checked={copyPermissions} onChange={(e) => setCopyPermissions(e.target.checked)} />{" "}
              <SmartLabel>Copy permissions</SmartLabel>
            </label>
            <label>
              <input type="checkbox" checked={copyXattrs} onChange={(e) => setCopyXattrs(e.target.checked)} /> <SmartLabel>Copy extended attributes</SmartLabel>
            </label>
            <label>
              <input type="checkbox" checked={sparseFiles} onChange={(e) => setSparseFiles(e.target.checked)} /> <SmartLabel>Sparse files</SmartLabel>
            </label>
            <label>
              <input type="checkbox" checked={useCow} onChange={(e) => setUseCow(e.target.checked)} /> <SmartLabel>Use CoW (copy-on-write)</SmartLabel>
            </label>
            <label>
              <input type="checkbox" checked={disableWriteCache} onChange={(e) => setDisableWriteCache(e.target.checked)} />{" "}
              <SmartLabel>Disable write cache</SmartLabel>
            </label>
          </fieldset>
        </div>
        <div className="modal-dialog-buttons" ref={buttonsRef}>
          <button type="button" onClick={onCancel}>
            <SmartLabel>Cancel</SmartLabel>
          </button>
          <button type="submit" disabled={!destValue.trim()}>
            <SmartLabel>Copy</SmartLabel>
          </button>
        </div>
      </form>
    </dialog>
  );
}
