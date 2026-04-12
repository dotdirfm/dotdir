import { DropdownSelect, type DropdownSelectOption } from "@/components/DropdownSelect/DropdownSelect";
import { useDialogButtonNav } from "@/dialogs/useDialogButtonNav";
import type { ConflictPolicy, CopyOptions, SymlinkMode } from "@/features/bridge";
import { cx } from "@/utils/cssModules";
import { INPUT_NO_ASSIST } from "@/utils/inputNoAssist";
import { useMemo, useRef, useState } from "react";
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
  const conflictOptions = useMemo<DropdownSelectOption[]>(
    () => [
      { value: "ask", label: "Ask" },
      { value: "overwrite", label: "Overwrite" },
      { value: "skip", label: "Skip" },
      { value: "rename", label: "Auto-rename" },
      { value: "onlyNewer", label: "Only newer" },
    ],
    [],
  );
  const symlinkOptions = useMemo<DropdownSelectOption[]>(
    () => [
      { value: "smart", label: "Smart" },
      { value: "alwaysLink", label: "Copy link" },
      { value: "alwaysTarget", label: "Copy target" },
    ],
    [],
  );

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
    <OverlayDialog
      className={cx(styles, "modal-dialog", "copy-config-dialog")}
      onClose={onCancel}
      onKeyDown={onKeyDown}
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
            <DropdownSelect
              value={conflictPolicy}
              options={conflictOptions}
              onChange={(value) => setConflictPolicy(value as ConflictPolicy)}
              triggerClassName={styles["dialog-select"]}
            />
          </div>

          <div className={styles["copy-config-field"]}>
            <label htmlFor="copy-symlink">
              <SmartLabel>Symlinks</SmartLabel>
            </label>
            <DropdownSelect
              value={symlinkMode}
              options={symlinkOptions}
              onChange={(value) => setSymlinkMode(value as SymlinkMode)}
              triggerClassName={styles["dialog-select"]}
            />
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
