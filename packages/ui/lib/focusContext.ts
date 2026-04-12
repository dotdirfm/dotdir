import { createContext, createElement, useContext, useEffect, useRef, type ReactNode } from "react";

export type FocusLayer =
  | "panel"
  | "autocomplete"
  | "searchResults"
  | "menu"
  | "commandPalette"
  | "modal"
  | "terminal"
  | "editor"
  | "viewer";

type FocusChangeCallback = (layer: FocusLayer) => void;
type FocusStateChangeCallback = (state: FocusState) => void;

type FocusAdapter = {
  focus: () => void;
  blur?: () => void;
  contains?: (node: EventTarget | null) => boolean;
  isEditableTarget?: (node: EventTarget | null) => boolean;
  allowCommandRouting?: boolean | ((event: KeyboardEvent) => boolean);
};

type FocusStackEntry = {
  layer: FocusLayer;
  restoreTo?: FocusLayer;
};

export type FocusState = {
  current: FocusLayer;
  stack: FocusStackEntry[];
};

export class FocusContextManager {
  // Focus is modeled as a stack so temporary surfaces like modals or the command
  // palette can override the current layer and then restore the previous target.
  private stack: FocusStackEntry[] = [{ layer: "panel" }];
  private listeners = new Set<FocusChangeCallback>();
  private stateListeners = new Set<FocusStateChangeCallback>();
  // Adapters bridge abstract focus layers to concrete DOM focus/containment logic.
  private adapters = new Map<FocusLayer, FocusAdapter>();

  get current(): FocusLayer {
    return this.stack[this.stack.length - 1]?.layer ?? "panel";
  }

  get state(): FocusState {
    return {
      current: this.current,
      stack: [...this.stack],
    };
  }

  push(layer: FocusLayer): void {
    // Remember where this layer should return when it is later dismissed.
    this.stack.push({ layer, restoreTo: this.current });
    this.notify();
  }

  pop(layer: FocusLayer): void {
    const idx = this.findLastIndex(layer);
    if (idx >= 0) {
      this.stack.splice(idx, 1);
      if (this.stack.length === 0) this.stack.push({ layer: "panel" });
      this.notify();
    }
  }

  set(layer: FocusLayer): void {
    // `set` replaces the full stack and is used for explicit mode switches.
    if (this.stack.length === 1 && this.stack[0]?.layer === layer) return;
    this.stack = [{ layer }];
    this.notify();
  }

  is(layer: FocusLayer): boolean {
    return this.current === layer;
  }

  registerAdapter(layer: FocusLayer, adapter: FocusAdapter): () => void {
    this.adapters.set(layer, adapter);
    return () => {
      if (this.adapters.get(layer) === adapter) this.adapters.delete(layer);
    };
  }

  request(layer: FocusLayer): void {
    // A focus request both changes logical focus state and asks the owning UI
    // surface to move DOM focus immediately.
    this.set(layer);
    this.focusCurrent();
  }

  restore(): void {
    // Restores to the layer remembered by the top-most stack entry, falling back
    // to the panel when there is no explicit restore target.
    const restoreTo = this.stack[this.stack.length - 1]?.restoreTo ?? "panel";
    this.set(restoreTo);
    this.focusCurrent();
  }

  focusCurrent(): void {
    this.adapters.get(this.current)?.focus();
  }

  blurCurrent(): void {
    this.adapters.get(this.current)?.blur?.();
  }

  containsActiveTarget(node: EventTarget | null): boolean {
    return this.adapters.get(this.current)?.contains?.(node) ?? false;
  }

  isEditableTarget(node: EventTarget | null): boolean {
    const adapter = this.adapters.get(this.current);
    if (adapter?.isEditableTarget?.(node)) return true;
    const el = node as HTMLElement | null;
    if (!el) return false;
    const tag = el.tagName?.toLowerCase();
    return tag === "input" || tag === "textarea" || tag === "select" || el.isContentEditable;
  }

  allowsCommandRouting(event: KeyboardEvent, layer = this.current): boolean {
    const adapter = this.adapters.get(layer);
    if (typeof adapter?.allowCommandRouting === "function") {
      return adapter.allowCommandRouting(event);
    }
    if (adapter?.allowCommandRouting === false) return false;
    return layer === "panel" || layer === "menu" || layer === "searchResults" || layer === "viewer" || layer === "editor";
  }

  shouldRouteCommandEvent(event: KeyboardEvent, root: HTMLElement): boolean {
    // Command routing is intentionally conservative: only route events that
    // originate inside the app, avoid editable controls/dialogs by default,
    // and then allow the active layer to further opt in/out via its adapter.
    const target = event.target as Node | null;
    if (!target || !root.contains(target)) return false;

    const active = document.activeElement as HTMLElement | null;
    const activeLayer = this.current;
    const activeAdapter = this.adapters.get(activeLayer);
    if (typeof activeAdapter?.allowCommandRouting === "function") {
      return activeAdapter.allowCommandRouting(event);
    }
    if (activeAdapter?.allowCommandRouting === true) {
      return true;
    }

    if (this.isEditableTarget(event.target) || this.isEditableTarget(document.activeElement)) return false;

    const isDialogTarget = (node: EventTarget | null) => {
      const el = node as HTMLElement | null;
      return Boolean(el?.closest?.('[role="dialog"], [aria-modal="true"], dialog'));
    };

    if (isDialogTarget(event.target) || isDialogTarget(active)) return false;
    return this.allowsCommandRouting(event, activeLayer);
  }

  onChange(callback: FocusChangeCallback): () => void {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  onStateChange(callback: FocusStateChangeCallback): () => void {
    this.stateListeners.add(callback);
    return () => this.stateListeners.delete(callback);
  }

  private findLastIndex(layer: FocusLayer): number {
    for (let i = this.stack.length - 1; i >= 0; i--) {
      if (this.stack[i]?.layer === layer) return i;
    }
    return -1;
  }

  private notify(): void {
    // Notify both legacy "current layer" listeners and richer state listeners.
    const current = this.current;
    for (const cb of this.listeners) cb(current);
    const state = this.state;
    for (const cb of this.stateListeners) cb(state);
  }
}

const FocusContextReact = createContext<FocusContextManager | null>(null);

export function FocusProvider({ children }: { children: ReactNode }) {
  const managerRef = useRef<FocusContextManager | null>(null);
  if (!managerRef.current) {
    managerRef.current = new FocusContextManager();
  }
  return createElement(FocusContextReact.Provider, { value: managerRef.current }, children);
}

export function useFocusContext(): FocusContextManager {
  const value = useContext(FocusContextReact);
  if (!value) throw new Error("useFocusContext must be used within FocusProvider");
  return value;
}

export function useManagedFocusLayer(layer: FocusLayer, active = true): void {
  const focusContext = useFocusContext();
  const previousFocusedRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!active) return;
    previousFocusedRef.current = document.activeElement as HTMLElement | null;
    focusContext.push(layer);
    const frame = requestAnimationFrame(() => {
      focusContext.focusCurrent();
    });

    return () => {
      cancelAnimationFrame(frame);
      focusContext.pop(layer);
      requestAnimationFrame(() => {
        focusContext.focusCurrent();
        const activeElement = document.activeElement as HTMLElement | null;
        if (activeElement && activeElement !== document.body) return;
        previousFocusedRef.current?.focus?.();
      });
    };
  }, [active, focusContext, layer]);
}
