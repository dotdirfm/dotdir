/**
 * Focus Context System
 * 
 * Tracks which component currently has focus for keyboard handling.
 * Components push/pop themselves onto the focus stack.
 */

export type FocusLayer =
  | 'panel'           // File panels (default)
  | 'commandPalette'  // Command palette overlay
  | 'commandLine'     // Command line input has focus
  | 'modal'           // Modal dialogs
  | 'terminal'        // Terminal has focus
  | 'editor'          // File editor has focus
  | 'viewer';         // File viewer has focus

type FocusChangeCallback = (layer: FocusLayer) => void;

class FocusContextManager {
  private stack: FocusLayer[] = ['panel'];
  private listeners = new Set<FocusChangeCallback>();

  get current(): FocusLayer {
    return this.stack[this.stack.length - 1] ?? 'panel';
  }

  push(layer: FocusLayer): void {
    this.stack.push(layer);
    this.notify();
  }

  pop(layer: FocusLayer): void {
    const idx = this.stack.lastIndexOf(layer);
    if (idx >= 0) {
      this.stack.splice(idx, 1);
      this.notify();
    }
  }

  is(layer: FocusLayer): boolean {
    return this.current === layer;
  }

  onChange(callback: FocusChangeCallback): () => void {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  private notify(): void {
    const current = this.current;
    for (const cb of this.listeners) cb(current);
  }
}

export const focusContext = new FocusContextManager();
