import { DropdownSelect, type DropdownSelectOption } from "@/components/DropdownSelect/DropdownSelect";
import { useDialogButtonNav } from "@/dialogs/useDialogButtonNav";
import type { ConflictPolicy, MoveOptions } from "@dotdirfm/ui-bridge";
import { cx } from "@dotdirfm/ui-utils";
import { INPUT_NO_ASSIST } from "@dotdirfm/ui-utils";
import { useMemo, useRef, useState } from "react";
import { PathAutocompleteInput } from "./PathAutocompleteInput";
import { SmartLabel } from "./dialogHotkeys";
import styles from "./dialogs.module.css";
import { OverlayDialog } from "./OverlayDialog";

export interface MoveConfigDialogProps {
  itemCount: number;
  destPath: string;
  suggestionRoots: Array<{ id: string; label: string; path: string }>;
  onConfirm: (options: MoveOptions, destDir: string) => void;
  onCancel: () => void;
}

export function MoveConfigDialog({ itemCount, destPath, suggestionRoots, onConfirm, onCancel }: MoveConfigDialogProps) {
  const buttonsRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [destValue, setDestValue] = useState(destPath);
  const [conflictPolicy, setConflictPolicy] = useState<ConflictPolicy>("ask");
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

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = destValue.trim();
    if (!trimmed) return;
    onConfirm({ conflictPolicy }, trimmed);
  };

  return (
    <OverlayDialog
      className={cx(styles, "modal-dialog", "move-config-dialog")}
      onClose={onCancel}
      onKeyDown={onKeyDown}
    >
      <div className={styles["modal-dialog-header"]}>
        Move {itemCount} item{itemCount !== 1 ? "s" : ""}
      </div>
      <form className={styles["modal-dialog-form"]} onSubmit={handleSubmit}>
        <div className={styles["modal-dialog-body"]}>
          <div className={styles["copy-config-field"]}>
            <label htmlFor="move-dest">
              <SmartLabel>Destination</SmartLabel>
            </label>
            <PathAutocompleteInput
              id="move-dest"
              value={destValue}
              onChange={setDestValue}
              roots={suggestionRoots}
              mode="directories"
              inputRef={inputRef}
              inputClassName={styles["dialog-input"]}
              {...INPUT_NO_ASSIST}
            />
          </div>

          <div className={styles["copy-config-field"]}>
            <label htmlFor="move-conflict">
              <SmartLabel>Conflict handling</SmartLabel>
            </label>
            <DropdownSelect
              value={conflictPolicy}
              options={conflictOptions}
              onChange={(value) => setConflictPolicy(value as ConflictPolicy)}
              triggerClassName={styles["dialog-select"]}
            />
          </div>
        </div>
        <div className={styles["modal-dialog-buttons"]} ref={buttonsRef}>
          <button type="button" onClick={onCancel}>
            <SmartLabel>Cancel</SmartLabel>
          </button>
          <button type="submit" disabled={!destValue.trim()}>
            <SmartLabel>Move</SmartLabel>
          </button>
        </div>
      </form>
    </OverlayDialog>
  );
}
