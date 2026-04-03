import { createContext, createElement, useContext, useRef, type ReactNode } from "react";

export type InteractionIntent =
  | "cursorUp"
  | "cursorDown"
  | "cursorLeft"
  | "cursorRight"
  | "cursorHome"
  | "cursorEnd"
  | "cursorPageUp"
  | "cursorPageDown"
  | "selectUp"
  | "selectDown"
  | "selectLeft"
  | "selectRight"
  | "selectHome"
  | "selectEnd"
  | "selectPageUp"
  | "selectPageDown"
  | "accept"
  | "cancel";

type InteractionController = {
  contains?: (node: EventTarget | null) => boolean;
  isActive?: () => boolean;
  handleIntent: (intent: InteractionIntent, event: KeyboardEvent) => boolean;
};

export class InteractionContextManager {
  private controllers: InteractionController[] = [];

  registerController(controller: InteractionController): () => void {
    this.controllers.push(controller);
    return () => {
      const idx = this.controllers.lastIndexOf(controller);
      if (idx >= 0) this.controllers.splice(idx, 1);
    };
  }

  handleKeyboardEvent(event: KeyboardEvent, root: HTMLElement): boolean {
    const target = event.target as Node | null;
    if (!target || !root.contains(target)) return false;

    const intent = this.toIntent(event);
    if (!intent) return false;

    const handled = this.dispatchIntentInternal(intent, event, {
      target,
      active: document.activeElement,
      requireContainment: true,
    });
    if (!handled) return false;
    event.preventDefault();
    event.stopPropagation();
    return true;
  }

  dispatchIntent(intent: InteractionIntent, event?: KeyboardEvent | null): boolean {
    return this.dispatchIntentInternal(intent, event ?? null, {
      target: null,
      active: document.activeElement,
      requireContainment: false,
    });
  }

  private dispatchIntentInternal(
    intent: InteractionIntent,
    event: KeyboardEvent | null,
    options: { target: EventTarget | null; active: Element | null; requireContainment: boolean },
  ): boolean {
    const { target, active, requireContainment } = options;
    for (let i = this.controllers.length - 1; i >= 0; i--) {
      const controller = this.controllers[i]!;
      if (controller.isActive && !controller.isActive()) continue;
      if (
        requireContainment &&
        controller.contains &&
        !controller.contains(target) &&
        !controller.contains(active)
      ) {
        continue;
      }
      if (!event) {
        event = new KeyboardEvent("keydown");
      }
      if (!controller.handleIntent(intent, event)) continue;
      return true;
    }

    return false;
  }

  private toIntent(event: KeyboardEvent): InteractionIntent | null {
    if (event.ctrlKey || event.metaKey || event.altKey) return null;

    switch (event.key) {
      case "ArrowUp":
        return event.shiftKey ? "selectUp" : "cursorUp";
      case "ArrowDown":
        return event.shiftKey ? "selectDown" : "cursorDown";
      case "ArrowLeft":
        return event.shiftKey ? "selectLeft" : "cursorLeft";
      case "ArrowRight":
        return event.shiftKey ? "selectRight" : "cursorRight";
      case "Home":
        return event.shiftKey ? "selectHome" : "cursorHome";
      case "End":
        return event.shiftKey ? "selectEnd" : "cursorEnd";
      case "PageUp":
        return event.shiftKey ? "selectPageUp" : "cursorPageUp";
      case "PageDown":
        return event.shiftKey ? "selectPageDown" : "cursorPageDown";
      case "Enter":
      case "Tab":
        return "accept";
      case "Escape":
        return "cancel";
      default:
        return null;
    }
  }
}

const InteractionContextReact = createContext<InteractionContextManager | null>(null);

export function InteractionProvider({ children }: { children: ReactNode }) {
  const managerRef = useRef<InteractionContextManager | null>(null);
  if (!managerRef.current) {
    managerRef.current = new InteractionContextManager();
  }
  return createElement(InteractionContextReact.Provider, { value: managerRef.current }, children);
}

export function useInteractionContext(): InteractionContextManager {
  const value = useContext(InteractionContextReact);
  if (!value) throw new Error("useInteractionContext must be used within InteractionProvider");
  return value;
}
