import { useDialogButtonNav } from "@/dialogs/useDialogButtonNav";
import type { ConflictPolicy, CopyOptions, SymlinkMode } from "@/features/bridge";
import { useCommandRegistry } from "@/features/commands/commands";
import { cx } from "@/utils/cssModules";
import { INPUT_NO_ASSIST } from "@/utils/inputNoAssist";
import { useCallback, useRef, useState } from "react";
import { PathAutocompleteInput } from "./PathAutocompleteInput";
import { SmartLabel } from "./dialogHotkeys";
import styles from "./dialogs.module.css";
import { OverlayDialog } from "./OverlayDialog";

export interface CopyConfigDialogProps {
  itemCount: number;
  destPath: string;
  suggestionRoots: Array<{ id: string; label: string; path: string }>;
  onConfirm: (options: CopyOptions, destDir: string) => void;
  onCancel: () => void;
}

export function CopyConfigDialog({ itemCount, destPath, suggestionRoots, onConfirm, onCancel }: CopyConfigDialogProps) {
  const commandRegistry = useCommandRegistry();
  const buttonsRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [destValue, setDestValue] = useState(destPath);
  const [conflictPolicy, setConflictPolicy] = useState<ConflictPolicy>("ask");
  const [symlinkMode, setSymlinkMode] = useState<SymlinkMode>("smart");
  const [copyPermissions, setCopyPermissions] = useState(true);
  const [copyXattrs, setCopyXattrs] = useState(false);
  const [sparseFiles, setSparseFiles] = useState(false);
  const [useCow, setUseCow] = useState(false);
  const [disableWriteCache, setDisableWriteCache] = useState(false);
  const { onKeyDown } = useDialogButtonNav(buttonsRef, { defaultIndex: 1 });

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

  const allowCommandRouting = useCallback(
    (event: KeyboardEvent) => {
      if (!commandRegistry.getContext("autocompleteFocused")) return false;
      const key = event.key.toLowerCase();
      const autocompleteOpen = Boolean(commandRegistry.getContext("autocompleteOpen"));
      const autocompleteHasSelection = Boolean(commandRegistry.getContext("autocompleteHasSelection"));
      if (key === "home" || key === "end") return true;
      if (!autocompleteOpen) return false;
      if ((key === "tab" || key === "enter") && !autocompleteHasSelection) return false;
      return (
        key === "escape" ||
        key === "enter" ||
        key === "tab" ||
        key === "arrowup" ||
        key === "arrowdown" ||
        key === "pageup" ||
        key === "pagedown"
      );
    },
    [commandRegistry],
  );

  return (
    <OverlayDialog
      className={cx(styles, "modal-dialog", "copy-config-dialog")}
      onClose={onCancel}
      onKeyDown={onKeyDown}
      allowCommandRouting={allowCommandRouting}
    >
      <div className={styles["modal-dialog-header"]}>
        Copy {itemCount} item{itemCount !== 1 ? "s" : ""}
      </div>
      <form className={styles["modal-dialog-form"]} onSubmit={handleSubmit}>
        <div className={styles["modal-dialog-body"]}>
          <div className={styles["copy-config-field"]}>
            <label htmlFor="copy-dest">
              <SmartLabel>Destination</SmartLabel>
            </label>
            <PathAutocompleteInput
              id="copy-dest"
              value={destValue}
              onChange={setDestValue}
              roots={suggestionRoots}
              mode="directories"
              inputRef={inputRef}
              inputClassName={styles["open-create-file-field"] ? undefined : undefined}
              {...INPUT_NO_ASSIST}
            />
          </div>

          <div className={styles["copy-config-field"]}>
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

          <div className={styles["copy-config-field"]}>
            <label htmlFor="copy-symlink">
              <SmartLabel>Symlinks</SmartLabel>
            </label>
            <select id="copy-symlink" value={symlinkMode} onChange={(e) => setSymlinkMode(e.target.value as SymlinkMode)}>
              <option value="smart">Smart</option>
              <option value="alwaysLink">Copy link</option>
              <option value="alwaysTarget">Copy target</option>
            </select>
          </div>

          <fieldset className={styles["copy-config-section"]}>
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
        <div className={styles["modal-dialog-buttons"]} ref={buttonsRef}>
          <button type="button" onClick={onCancel}>
            <SmartLabel>Cancel</SmartLabel>
          </button>
          <button type="submit" disabled={!destValue.trim()}>
            <SmartLabel>Copy</SmartLabel>
          </button>
        </div>
      </form>
    </OverlayDialog>
  );
}
