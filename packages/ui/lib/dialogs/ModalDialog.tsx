import { focusContext } from "@/focusContext";
import { useDialogButtonNav } from "@/hooks/useDialogButtonNav";
import { useEffect, useRef } from "react";
import styles from "../styles/dialogs.module.css";
import { cx } from "../utils/cssModules";
import { SmartLabel } from "./dialogHotkeys";

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
  const dialogRef = useRef<HTMLDialogElement>(null);
  const buttonsRef = useRef<HTMLDivElement>(null);
  const resolvedButtons = buttons ?? [{ label: "OK", default: true }];
  const defaultIdx = resolvedButtons.findIndex((b) => b.default);
  const { onKeyDown } = useDialogButtonNav(buttonsRef, {
    defaultIndex: defaultIdx >= 0 ? defaultIdx : resolvedButtons.length - 1,
  });

  useEffect(() => {
    const dialog = dialogRef.current!;
    if (!dialog.open) dialog.showModal();
    focusContext.push("modal");
    const handleClose = () => onClose();
    dialog.addEventListener("close", handleClose);
    return () => {
      dialog.removeEventListener("close", handleClose);
      focusContext.pop("modal");
    };
  }, [onClose]);

  return (
    <dialog ref={dialogRef} className={cx(styles, "modal-dialog", variant)} onKeyDown={onKeyDown}>
      {title && <div className={styles["modal-dialog-header"]}>{title}</div>}
      <div className={styles["modal-dialog-body"]}>{message}</div>
      <div className={styles["modal-dialog-buttons"]} ref={buttonsRef}>
        {resolvedButtons.map((btn) => (
          <button
            key={btn.label}
            onClick={() => {
              btn.onClick?.();
              dialogRef.current?.close();
            }}
          >
            <SmartLabel>{btn.label}</SmartLabel>
          </button>
        ))}
      </div>
    </dialog>
  );
}
