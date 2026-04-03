import { useDialogButtonNav } from "@/dialogs/useDialogButtonNav";
import { cx } from "@/utils/cssModules";
import { useRef } from "react";
import { SmartLabel } from "./dialogHotkeys";
import styles from "./dialogs.module.css";
import { OverlayDialog } from "./OverlayDialog";

interface ModalButton {
  label: string;
  default?: boolean;
  onClick?: () => void;
}

export interface ModalDialogProps {
  title?: string;
  message: string;
  variant?: "error" | "default";
  buttons?: ModalButton[];
  onClose: () => void;
}

export function ModalDialog({ title, message, variant = "default", buttons, onClose }: ModalDialogProps) {
  const buttonsRef = useRef<HTMLDivElement>(null);
  const resolvedButtons = buttons ?? [{ label: "OK", default: true }];
  const defaultIdx = resolvedButtons.findIndex((b) => b.default);
  const { onKeyDown } = useDialogButtonNav(buttonsRef, {
    defaultIndex: defaultIdx >= 0 ? defaultIdx : resolvedButtons.length - 1,
  });

  return (
    <OverlayDialog className={cx(styles, "modal-dialog", variant)} onClose={onClose} onKeyDown={onKeyDown}>
      {title && <div className={styles["modal-dialog-header"]}>{title}</div>}
      <div className={styles["modal-dialog-body"]}>{message}</div>
      <div className={styles["modal-dialog-buttons"]} ref={buttonsRef}>
        {resolvedButtons.map((btn) => (
          <button
            key={btn.label}
            onClick={() => {
              btn.onClick?.();
              onClose();
            }}
          >
            <SmartLabel>{btn.label}</SmartLabel>
          </button>
        ))}
      </div>
    </OverlayDialog>
  );
}
