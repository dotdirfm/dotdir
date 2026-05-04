import { useDialogButtonNav } from "@/dialogs/useDialogButtonNav";
import type { ConflictResolution } from "@dotdirfm/ui-bridge";
import { basename, cx, INPUT_NO_ASSIST } from "@dotdirfm/ui-utils";
import { useRef, useState } from "react";
import { SmartLabel } from "./dialogHotkeys";
import styles from "./dialogs.module.css";
import { OverlayDialog } from "./OverlayDialog";

export interface ConflictDialogProps {
  src: string;
  dest: string;
  srcSize: number;
  srcMtimeMs: number;
  destSize: number;
  destMtimeMs: number;
  onResolve: (resolution: ConflictResolution) => void;
}

function formatSize(bytes: number): string {
  if (bytes == null || !Number.isFinite(bytes)) return "unknown size";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatDate(ms: number): string {
  if (ms == null || !Number.isFinite(ms) || ms === 0) return "—";
  return new Date(ms).toLocaleString();
}

export function ConflictDialog({ src, dest, srcSize, srcMtimeMs, destSize, destMtimeMs, onResolve }: ConflictDialogProps) {
  const buttonsRef = useRef<HTMLDivElement>(null);
  const renameButtonsRef = useRef<HTMLDivElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const [renaming, setRenaming] = useState(false);
  const [newName, setNewName] = useState(basename(dest));
  const { onKeyDown: mainKeyDown } = useDialogButtonNav(buttonsRef, { defaultIndex: 0 });
  const { onKeyDown: renameKeyDown } = useDialogButtonNav(renameButtonsRef, { defaultIndex: 1 });

  if (renaming) {
    return (
      <OverlayDialog
        className={cx(styles, "modal-dialog", "conflict-dialog")}
        onClose={() => onResolve({ type: "cancel" })}
        onKeyDown={renameKeyDown}
        initialFocusRef={renameInputRef}
      >
        <div className={styles["modal-dialog-header"]}>Rename</div>
        <div className={styles["modal-dialog-body"]}>
          <div className={styles["conflict-rename-field"]}>
            <label htmlFor="conflict-rename-input">
              <SmartLabel>New name</SmartLabel>
            </label>
            <input
              ref={renameInputRef}
              id="conflict-rename-input"
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              {...INPUT_NO_ASSIST}
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter" && newName.trim()) {
                  onResolve({ type: "rename", newName: newName.trim() });
                }
              }}
            />
          </div>
        </div>
        <div className={styles["modal-dialog-buttons"]} ref={renameButtonsRef}>
          <button type="button" onClick={() => setRenaming(false)}>
            <SmartLabel>Back</SmartLabel>
          </button>
          <button type="button" onClick={() => onResolve({ type: "rename", newName: newName.trim() })} disabled={!newName.trim()}>
            <SmartLabel>OK</SmartLabel>
          </button>
        </div>
      </OverlayDialog>
    );
  }

  return (
    <OverlayDialog
      className={cx(styles, "modal-dialog", "conflict-dialog")}
      onClose={() => onResolve({ type: "cancel" })}
      onKeyDown={mainKeyDown}
    >
      <div className={styles["modal-dialog-header"]}>File already exists</div>
      <div className={styles["modal-dialog-body"]}>
        <div className={styles["conflict-file-info"]}>
          <div className={styles["conflict-file-label"]}>Source:</div>
          <div className={styles["conflict-file-path"]} title={src}>
            {src}
          </div>
          <div className={styles["conflict-file-meta"]}>
            {formatSize(srcSize)}, {formatDate(srcMtimeMs)}
          </div>
        </div>
        <div className={styles["conflict-file-info"]}>
          <div className={styles["conflict-file-label"]}>Destination:</div>
          <div className={styles["conflict-file-path"]} title={dest}>
            {dest}
          </div>
          <div className={styles["conflict-file-meta"]}>
            {formatSize(destSize)}, {formatDate(destMtimeMs)}
          </div>
        </div>
      </div>
      <div className={cx(styles, "modal-dialog-buttons", "conflict-buttons")} ref={buttonsRef}>
        <button type="button" onClick={() => onResolve({ type: "overwrite" })}>
          <SmartLabel>Overwrite</SmartLabel>
        </button>
        <button type="button" onClick={() => onResolve({ type: "skip" })}>
          <SmartLabel>Skip</SmartLabel>
        </button>
        <button type="button" onClick={() => setRenaming(true)}>
          <SmartLabel>Rename</SmartLabel>
        </button>
        <button type="button" onClick={() => onResolve({ type: "overwriteAll" })}>
          <SmartLabel>Overwrite All</SmartLabel>
        </button>
        <button type="button" onClick={() => onResolve({ type: "skipAll" })}>
          <SmartLabel>Skip All</SmartLabel>
        </button>
        <button type="button" onClick={() => onResolve({ type: "cancel" })}>
          <SmartLabel>Cancel</SmartLabel>
        </button>
      </div>
    </OverlayDialog>
  );
}
