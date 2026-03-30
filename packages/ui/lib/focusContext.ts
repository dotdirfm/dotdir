export type FocusLayer =
  | "panel" // File panels (default)
  | "commandPalette" // Command palette overlay
  | "modal" // Modal dialogs
  | "terminal" // Terminal has focus
  | "editor" // File editor has focus
  | "viewer"; // File viewer has focus

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

class FocusContextManager {
  private stack: FocusStackEntry[] = [{ layer: "panel" }];
  private listeners = new Set<FocusChangeCallback>();
  private stateListeners = new Set<FocusStateChangeCallback>();
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
    this.set(layer);
    this.focusCurrent();
  }

  restore(): void {
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

  shouldRouteCommandEvent(event: KeyboardEvent, root: HTMLElement): boolean {
    const target = event.target as Node | null;
    if (!target || !root.contains(target)) return false;

    const active = document.activeElement as HTMLElement | null;
    const activeLayer = this.current;
    const activeAdapter = this.adapters.get(activeLayer);
    if (typeof activeAdapter?.allowCommandRouting === "function") {
      return activeAdapter.allowCommandRouting(event);
    }

    if (this.isEditableTarget(event.target) || this.isEditableTarget(document.activeElement)) return false;

    const isDialogTarget = (node: EventTarget | null) => {
      const el = node as HTMLElement | null;
      return Boolean(el?.closest?.('[role="dialog"], [aria-modal="true"], dialog'));
    };

    if (isDialogTarget(event.target) || isDialogTarget(active)) return false;
    if (activeAdapter?.allowCommandRouting === false) return false;
    return activeLayer === "panel" || activeLayer === "viewer" || activeLayer === "editor";
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
    const current = this.current;
    for (const cb of this.listeners) cb(current);
    const state = this.state;
    for (const cb of this.stateListeners) cb(state);
  }
}

export const focusContext = new FocusContextManager();
