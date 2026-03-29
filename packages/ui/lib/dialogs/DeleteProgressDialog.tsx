import { focusContext } from "@/focusContext";
import { useEffect } from "react";
import styles from "../styles/dialogs.module.css";
import { cx } from "../utils/cssModules";
import { SmartLabel } from "./dialogHotkeys";
import { OverlayDialog } from "./OverlayDialog";

export interface DeleteProgressDialogProps {
  filesDone: number;
  currentFile: string;
  onCancel: () => void;
}

export function DeleteProgressDialog({ filesDone, currentFile, onCancel }: DeleteProgressDialogProps) {
  useEffect(() => {
    focusContext.push("modal");
    return () => {
      focusContext.pop("modal");
    };
  }, []);

  return (
    <OverlayDialog className={cx(styles, "modal-dialog", "delete-progress-dialog")} onClose={onCancel}>
      <div className={styles["modal-dialog-header"]}>Permanently deleting</div>
      <div className={styles["modal-dialog-body"]}>
        <div className={styles["delete-progress-text"]}>{filesDone.toLocaleString()} items deleted</div>
        <div className={styles["delete-progress-path"]} title={currentFile}>
          {currentFile}
        </div>
        <p className={styles["delete-progress-hint"]}>Already deleted items cannot be recovered.</p>
      </div>
      <div className={styles["modal-dialog-buttons"]}>
        <button type="button" onClick={onCancel}>
          <SmartLabel>Cancel</SmartLabel>
        </button>
      </div>
    </OverlayDialog>
  );
}
