import { focusContext } from "@/focusContext";
import { INPUT_NO_ASSIST } from "@/utils/inputNoAssist";
import { useEffect, useRef, useState } from "react";
import styles from "../styles/dialogs.module.css";
import { cx } from "../utils/cssModules";
import { SmartLabel } from "./dialogHotkeys";

export type MakeFolderResult = { mode: "single"; name: string } | { mode: "multiple"; names: string[] };

export interface MakeFolderDialogProps {
  currentPath: string;
  onConfirm: (result: MakeFolderResult) => void;
  onCancel: () => void;
}

export function MakeFolderDialog({ currentPath: _currentPath, onConfirm, onCancel }: MakeFolderDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [folderName, setFolderName] = useState("");
  const [processMultiple, setProcessMultiple] = useState(false);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
    focusContext.push("modal");
    inputRef.current?.focus();
    const handleClose = () => onCancel();
    dialog.addEventListener("close", handleClose);
    return () => {
      dialog.removeEventListener("close", handleClose);
      focusContext.pop("modal");
    };
  }, [onCancel]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const raw = folderName.trim();
    if (!raw) return;

    if (processMultiple) {
      const names = raw
        .split(";")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      if (names.length === 0) return;
      dialogRef.current?.close();
      onConfirm({ mode: "multiple", names });
      return;
    }

    dialogRef.current?.close();
    onConfirm({ mode: "single", name: raw });
  };

  const canSubmit = processMultiple ? folderName.split(";").some((s) => s.trim().length > 0) : folderName.trim().length > 0;

  const handleCancel = () => {
    dialogRef.current?.close();
    onCancel();
  };

  return (
    <dialog ref={dialogRef} className={cx(styles, "modal-dialog", "make-folder-dialog")} onCancel={handleCancel}>
      <div className={styles["modal-dialog-header"]}>Make Folder</div>
      <form className={styles["make-folder-form"]} onSubmit={handleSubmit}>
        <div className={styles["modal-dialog-body"]}>
          <div className={styles["make-folder-field"]}>
            <label htmlFor="make-folder-name">
              <SmartLabel>{processMultiple ? "Folder names" : "Folder name"}</SmartLabel>
            </label>
            <input
              ref={inputRef}
              id="make-folder-name"
              type="text"
              value={folderName}
              onChange={(e) => setFolderName(e.target.value)}
              placeholder={processMultiple ? "e.g. a; b; c" : "e.g. my-folder"}
              {...INPUT_NO_ASSIST}
            />
          </div>
          <label className={styles["make-folder-checkbox"]}>
            <input type="checkbox" checked={processMultiple} onChange={(e) => setProcessMultiple(e.target.checked)} />
            <span>
              <SmartLabel>Process multiple names</SmartLabel>
            </span>
          </label>
        </div>
        <div className={styles["modal-dialog-buttons"]}>
          <button type="button" onClick={handleCancel}>
            <SmartLabel>Cancel</SmartLabel>
          </button>
          <button type="submit" disabled={!canSubmit}>
            <SmartLabel>OK</SmartLabel>
          </button>
        </div>
      </form>
    </dialog>
  );
}
