import { focusContext } from "@/focusContext";
import { useDialogButtonNav } from "@/hooks/useDialogButtonNav";
import { useEffect, useRef } from "react";
import styles from "../styles/dialogs.module.css";
import { cx } from "../utils/cssModules";
import { SmartLabel } from "./dialogHotkeys";
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

  useEffect(() => {
    focusContext.push("modal");
    return () => {
      focusContext.pop("modal");
    };
  }, []);

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
