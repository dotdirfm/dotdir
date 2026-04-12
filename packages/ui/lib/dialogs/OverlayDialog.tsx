import { cx } from "@/utils/cssModules";
import { useEffect, useRef } from "react";
import { type FocusLayer, useFocusContext, useManagedFocusLayer } from "@/focusContext";
import styles from "./dialogs.module.css";

type Placement = "center" | "top";

export interface OverlayDialogProps {
  className?: string;
  children: React.ReactNode;
  onClose: () => void;
  onKeyDown?: React.KeyboardEventHandler<HTMLElement>;
  dismissible?: boolean;
  placement?: Placement;
  initialFocusRef?: React.RefObject<HTMLElement | null>;
  focusLayer?: FocusLayer;
  allowCommandRouting?: boolean | ((event: KeyboardEvent) => boolean);
  stackIndex?: number;
}

const FOCUSABLE =
  'a[href],button,input,select,textarea,iframe,[tabindex]:not([tabindex="-1"])';

function getFocusable(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => !el.hasAttribute("disabled") && el.tabIndex !== -1 && !el.closest("[inert]"),
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
  focusLayer = "modal",
  allowCommandRouting = false,
  stackIndex = 0,
}: OverlayDialogProps) {
  const focusContext = useFocusContext();
  const containerRef = useRef<HTMLDivElement>(null);
  useManagedFocusLayer(focusLayer);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    return focusContext.registerAdapter(focusLayer, {
      focus() {
        const explicit = initialFocusRef?.current;
        if (explicit) {
          explicit.focus();
          return;
        }
        const [first] = getFocusable(container);
        (first ?? container).focus();
      },
      contains(node) {
        return node instanceof Node ? container.contains(node) : false;
      },
      isEditableTarget(node) {
        const el = node as HTMLElement | null;
        if (!el || !container.contains(el)) return false;
        const tag = el.tagName?.toLowerCase();
        return tag === "input" || tag === "textarea" || tag === "select" || el.isContentEditable;
      },
      allowCommandRouting,
    });
  }, [allowCommandRouting, focusContext, focusLayer, initialFocusRef]);

  const handleKeyDownCapture: React.KeyboardEventHandler<HTMLDivElement> = (e) => {
    onKeyDown?.(e);
    if (e.defaultPrevented) return;

    if (focusContext.current !== focusLayer) {
      return;
    }

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
      style={{ zIndex: 200 + stackIndex * 10 }}
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
