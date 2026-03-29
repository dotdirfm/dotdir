import { focusContext } from "@/focusContext";
import { marked } from "marked";
import { useEffect, useRef } from "react";
import styles from "../styles/help-dialog.module.css";
import { OverlayDialog } from "./OverlayDialog";

interface HelpDialogProps {
  content: string;
  onClose: () => void;
}

export function HelpDialog({ content, onClose }: HelpDialogProps) {
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Focus the body so arrow/page keys scroll immediately.
    focusContext.push("modal");
    return () => {
      focusContext.pop("modal");
    };
  }, []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" || e.key === "F1") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", handleKeyDown, { capture: true });
    return () => document.removeEventListener("keydown", handleKeyDown, { capture: true });
  }, [onClose]);

  const html = marked.parse(content) as string;

  return (
    <OverlayDialog className={styles["help-dialog"]} onClose={onClose} initialFocusRef={bodyRef}>
      <div className={styles["help-dialog-header"]}>Help</div>
      <div
        ref={bodyRef}
        className={styles["help-dialog-body"]}
        // tabIndex makes the div focusable so the browser scrolls it with keyboard.
        tabIndex={0}
        // Content is internal static strings — not user-provided.
        // eslint-disable-next-line react/no-danger
        dangerouslySetInnerHTML={{ __html: html }}
      />
      <div className={styles["help-dialog-buttons"]}>
        <button onClick={onClose}>Close</button>
      </div>
    </OverlayDialog>
  );
}
