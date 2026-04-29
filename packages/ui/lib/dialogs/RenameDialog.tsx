import { cx } from "@dotdirfm/ui-utils";
import { INPUT_NO_ASSIST } from "@dotdirfm/ui-utils";
import { useEffect, useRef, useState } from "react";
import { SmartLabel } from "./dialogHotkeys";
import styles from "./dialogs.module.css";
import { OverlayDialog } from "./OverlayDialog";

export interface RenameDialogProps {
  currentName: string;
  onConfirm: (newName: string) => void;
  onCancel: () => void;
}

export function RenameDialog({ currentName, onConfirm, onCancel }: RenameDialogProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [newName, setNewName] = useState(currentName);

  useEffect(() => {
    // Select the filename without extension
    const input = inputRef.current;
    if (input) {
      input.focus();
      const dotIndex = currentName.lastIndexOf(".");
      if (dotIndex > 0) {
        input.setSelectionRange(0, dotIndex);
      } else {
        input.select();
      }
    }
  }, [currentName]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = newName.trim();
    if (!trimmed || trimmed === currentName) return;
    onConfirm(trimmed);
  };

  return (
    <OverlayDialog className={cx(styles, "modal-dialog", "rename-dialog")} onClose={onCancel} initialFocusRef={inputRef}>
      <div className={styles["modal-dialog-header"]}>Rename</div>
      <form onSubmit={handleSubmit}>
        <div className={styles["modal-dialog-body"]}>
          <div className={styles["rename-field"]}>
            <label htmlFor="rename-input">
              <SmartLabel>New name</SmartLabel>
            </label>
            <input ref={inputRef} id="rename-input" type="text" value={newName} onChange={(e) => setNewName(e.target.value)} {...INPUT_NO_ASSIST} />
          </div>
        </div>
        <div className={styles["modal-dialog-buttons"]}>
          <button type="button" onClick={onCancel}>
            <SmartLabel>Cancel</SmartLabel>
          </button>
          <button type="submit" disabled={!newName.trim() || newName.trim() === currentName}>
            <SmartLabel>Rename</SmartLabel>
          </button>
        </div>
      </form>
    </OverlayDialog>
  );
}
