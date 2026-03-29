import { useEffect, useRef } from "react";
import styles from "../styles/dialogs.module.css";
import { cx } from "../utils/cssModules";

type Placement = "center" | "top";

export interface OverlayDialogProps {
  className?: string;
  children: React.ReactNode;
  onClose: () => void;
  onKeyDown?: React.KeyboardEventHandler<HTMLElement>;
  dismissible?: boolean;
  placement?: Placement;
  initialFocusRef?: React.RefObject<HTMLElement | null>;
}

const FOCUSABLE =
  'a[href],button,input,select,textarea,iframe,[tabindex]:not([tabindex="-1"])';

function getFocusable(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => !el.hasAttribute("disabled") && el.tabIndex !== -1,
  );
}

export function OverlayDialog({
  className,
  children,
  onClose,
  onKeyDown,
  dismissible = true,
  placement = "center",
  initialFocusRef,
}: OverlayDialogProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const frame = requestAnimationFrame(() => {
      const explicit = initialFocusRef?.current;
      const container = containerRef.current;
      if (explicit) {
        explicit.focus();
        return;
      }
      if (!container) return;
      const [first] = getFocusable(container);
      (first ?? container).focus();
    });
    return () => {
      cancelAnimationFrame(frame);
      previous?.focus?.();
    };
  }, [initialFocusRef]);

  const handleKeyDownCapture: React.KeyboardEventHandler<HTMLDivElement> = (e) => {
    onKeyDown?.(e);
    if (e.defaultPrevented) return;

    if (e.key === "Escape" && dismissible) {
      e.preventDefault();
      e.stopPropagation();
      onClose();
      return;
    }

    if (e.key !== "Tab") return;

    const container = containerRef.current;
    if (!container) return;
    const focusable = getFocusable(container);
    if (focusable.length === 0) {
      e.preventDefault();
      container.focus();
      return;
    }

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement as HTMLElement | null;

    if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    } else if (e.shiftKey && active === first) {
      e.preventDefault();
      last.focus();
    }
  };

  return (
    <div
      className={cx(styles, "overlay-backdrop", placement === "top" && "overlay-backdrop-top")}
      onMouseDown={(e) => {
        if (dismissible && e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={containerRef}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        className={className}
        onKeyDownCapture={handleKeyDownCapture}
      >
        {children}
      </div>
    </div>
  );
}
