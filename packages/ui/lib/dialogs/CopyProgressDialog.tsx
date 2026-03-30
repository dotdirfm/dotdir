import { cx } from "@/utils/cssModules";
import { SmartLabel } from "./dialogHotkeys";
import styles from "./dialogs.module.css";
import { OverlayDialog } from "./OverlayDialog";

export interface CopyProgressDialogProps {
  bytesCopied: number;
  bytesTotal: number;
  filesDone: number;
  filesTotal: number;
  currentFile: string;
  onCancel: () => void;
}

function formatSize(bytes: number): string {
  if (bytes == null || !Number.isFinite(bytes)) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function CopyProgressDialog({ bytesCopied, bytesTotal, filesDone, filesTotal, currentFile, onCancel }: CopyProgressDialogProps) {
  const pct = bytesTotal > 0 ? Math.min(100, (bytesCopied / bytesTotal) * 100) : 0;

  return (
    <OverlayDialog className={cx(styles, "modal-dialog", "copy-progress-dialog")} onClose={onCancel}>
      <div className={styles["modal-dialog-header"]}>Copying</div>
      <div className={styles["modal-dialog-body"]}>
        <div className={styles["copy-progress-bar-container"]}>
          <div className={styles["copy-progress-bar"]} style={{ width: `${pct}%` }} />
        </div>
        <div className={styles["copy-progress-stats"]}>
          <span>
            {formatSize(bytesCopied)} / {formatSize(bytesTotal)}
          </span>
          <span>
            {filesDone} / {filesTotal} files
          </span>
        </div>
        <div className={styles["copy-progress-current"]} title={currentFile}>
          {currentFile}
        </div>
      </div>
      <div className={styles["modal-dialog-buttons"]}>
        <button type="button" onClick={onCancel}>
          <SmartLabel>Cancel</SmartLabel>
        </button>
      </div>
    </OverlayDialog>
  );
}
