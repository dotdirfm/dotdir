/**
 * Command System
 *
 * VS Code compatible command registry with support for:
 * - Command registration and execution
 * - Keyboard shortcuts (keybindings) with layered override system
 * - Extension-contributed commands
 * - Command palette integration
 *
 * Keybinding layers (later layers override earlier ones):
 * 1. Default (.dir built-in)
 * 2. Extensions
 * 3. User (from ~/.dotdir/keybindings.json)
 */

import { focusContext } from "./focusContext";

export interface Command {
  id: string;
  title: string;
  shortTitle?: string;
  category?: string;
  icon?: string;
}

export interface Keybinding {
  command: string;
  key: string;
  mac?: string;
  when?: string;
}

export interface CommandContribution {
  command: string;
  title: string;
  shortTitle?: string;
  category?: string;
  icon?: string;
}

export interface KeybindingContribution {
  command: string;
  key: string;
  mac?: string;
  when?: string;
}

export type KeybindingLayer = "default" | "extension" | "user";

type CommandHandler = (...args: unknown[]) => void | Promise<void>;
type ContextGetter = () => Record<string, unknown>;

class CommandRegistry {
  private contributions = new Map<string, CommandContribution>();
  private handlers = new Map<string, CommandHandler>();
  private keybindingLayers: Record<KeybindingLayer, Keybinding[]> = {
    default: [],
    extension: [],
    user: [],
  };
  private contextGetter: ContextGetter = () => ({});
  private contextValues: Record<string, unknown> = {};
  private listeners = new Set<() => void>();

  private batchDepth = 0;
  private batchDirty = false;

  beginBatch(): void {
    this.batchDepth++;
  }

  endBatch(): void {
    this.batchDepth--;
    if (this.batchDepth === 0 && this.batchDirty) {
      this.batchDirty = false;
      this.notifyListeners();
    }
  }

  setContext(key: string, value: unknown): void {
    if (this.contextValues[key] === value) return;
    this.contextValues[key] = value;
    if (this.batchDepth > 0) {
      this.batchDirty = true;
    } else {
      this.notifyListeners();
    }
  }

  getContext(key: string): unknown {
    return this.contextValues[key];
  }

  registerContributions(contributions: CommandContribution[]): () => void {
    for (const c of contributions) {
      this.contributions.set(c.command, c);
    }
    this.notifyListeners();
    return () => {
      for (const c of contributions) {
        this.contributions.delete(c.command);
      }
      this.notifyListeners();
    };
  }

  registerCommand(id: string, handler: CommandHandler): () => void {
    this.handlers.set(id, handler);
    this.notifyListeners();
    return () => {
      this.handlers.delete(id);
      this.notifyListeners();
    };
  }

  registerKeybinding(binding: Keybinding, layer: KeybindingLayer = "default"): () => void {
    this.keybindingLayers[layer].push(binding);
    this.notifyListeners();
    return () => {
      const layerBindings = this.keybindingLayers[layer];
      const idx = layerBindings.indexOf(binding);
      if (idx >= 0) layerBindings.splice(idx, 1);
      this.notifyListeners();
    };
  }

  setLayerKeybindings(layer: KeybindingLayer, bindings: Keybinding[]): void {
    this.keybindingLayers[layer] = bindings;
    this.notifyListeners();
  }

  clearLayerKeybindings(layer: KeybindingLayer): void {
    this.keybindingLayers[layer] = [];
    this.notifyListeners();
  }

  setContextGetter(getter: ContextGetter): void {
    this.contextGetter = getter;
  }

  async executeCommand(id: string, ...args: unknown[]): Promise<void> {
    const handler = this.handlers.get(id);
    if (!handler) {
      console.warn(`Command not found: ${id}`);
      return;
    }
    try {
      await handler(...args);
    } catch (err) {
      console.error(`Command ${id} failed:`, err);
    }
  }

  getCommand(id: string): Command | undefined {
    const c = this.contributions.get(id);
    if (!c) return undefined;
    return { id: c.command, title: c.title, shortTitle: c.shortTitle, category: c.category, icon: c.icon };
  }

  getAllCommands(): Command[] {
    return Array.from(this.contributions.values()).map((c) => ({
      id: c.command,
      title: c.title,
      shortTitle: c.shortTitle,
      category: c.category,
      icon: c.icon,
    }));
  }

  getKeybindings(): Keybinding[] {
    // Merge layers: later layers override earlier ones for the same key
    const merged = new Map<string, Keybinding>();
    const layers: KeybindingLayer[] = ["default", "extension", "user"];

    for (const layer of layers) {
      for (const binding of this.keybindingLayers[layer]) {
        const normalizedKey = this.normalizeKey(this.isMac() ? (binding.mac ?? binding.key) : binding.key);
        // Use key + when as the unique identifier for overriding
        const id = `${normalizedKey}|${binding.when ?? ""}`;
        merged.set(id, binding);
      }
    }

    return Array.from(merged.values());
  }

  getKeybindingsForLayer(layer: KeybindingLayer): Keybinding[] {
    return [...this.keybindingLayers[layer]];
  }

  getKeybindingForCommand(commandId: string): Keybinding | undefined {
    return this.getKeybindings().find((k: Keybinding) => k.command === commandId);
  }

  evaluateWhen(when: string | undefined): boolean {
    if (!when) return true;
    const userContext = this.contextGetter();
    const currentFocus = focusContext.current;
    const context: Record<string, unknown> = {
      ...userContext,
      ...this.contextValues,
      focusPanel: currentFocus === "panel",
      focusViewer: currentFocus === "viewer",
      focusEditor: currentFocus === "editor",
      focusTerminal: currentFocus === "terminal",
      focusCommandPalette: currentFocus === "commandPalette",
      focusModal: currentFocus === "modal",
    };
    return CommandRegistry.evalWhen(when, context);
  }

  /** Evaluate a `when` expression. Supports `&&` and `||`, and `!` negation. */
  private static evalWhen(when: string, context: Record<string, unknown>): boolean {
    try {
      return when.split(/\s*&&\s*/).every((andPart) =>
        andPart
          .trim()
          .split(/\s*\|\|\s*/)
          .some((orPart) => {
            const trimmed = orPart.trim();
            const negated = trimmed.startsWith("!");
            const key = negated ? trimmed.slice(1) : trimmed;
            return negated ? !context[key] : !!context[key];
          }),
      );
    } catch {
      return true;
    }
  }

  handleKeyboardEvent(e: KeyboardEvent): boolean {
    const keyCombo = this.eventToKeyCombo(e);
    if (!keyCombo) return false;

    // Priority: later layers override earlier ones.
    // Evaluate from highest → lowest and stop on first match.
    const layers: KeybindingLayer[] = ["user", "extension", "default"];
    for (const layer of layers) {
      for (const binding of this.keybindingLayers[layer]) {
        const bindingKey = this.normalizeKey(this.isMac() ? (binding.mac ?? binding.key) : binding.key);
        if (bindingKey === keyCombo && this.evaluateWhen(binding.when)) {
          e.preventDefault();
          e.stopPropagation();
          this.executeCommand(binding.command);
          return true;
        }
      }
    }
    return false;
  }

  private isMac(): boolean {
    return navigator.platform.toUpperCase().includes("MAC");
  }

  /**
   * Map physical key position (`KeyboardEvent.code`) to our normalized key id.
   * Layout-independent so shortcuts work with non-Latin / non-QWERTY layouts.
   */
  private physicalCodeToKeyPart(code: string): string | null {
    if (code.startsWith("Key") && code.length === 4) {
      return code[3]!.toLowerCase();
    }
    if (code.startsWith("Digit")) {
      return code.slice(5);
    }
    const numpadDigit = /^Numpad(\d)$/.exec(code);
    if (numpadDigit) return numpadDigit[1]!;

    const fn = /^F(\d{1,2})$/.exec(code);
    if (fn) return `f${fn[1]}`;

    const map: Record<string, string> = {
      Space: "space",
      Enter: "enter",
      NumpadEnter: "enter",
      Tab: "tab",
      Escape: "escape",
      Backspace: "backspace",
      Delete: "delete",
      Insert: "insert",
      ArrowUp: "up",
      ArrowDown: "down",
      ArrowLeft: "left",
      ArrowRight: "right",
      Home: "home",
      End: "end",
      PageUp: "pageup",
      PageDown: "pagedown",
      Minus: "-",
      Equal: "=",
      BracketLeft: "[",
      BracketRight: "]",
      Backslash: "\\",
      Semicolon: ";",
      Quote: "'",
      Comma: ",",
      Period: ".",
      Slash: "/",
      Backquote: "`",
      IntlBackslash: "\\",
    };
    if (map[code]) return map[code];

    return null;
  }

  /**
   * Fallback when `code` is missing (e.g. synthetic events) or unmapped: use `key` (layout-dependent).
   */
  private keyStringToKeyPart(key: string): string | null {
    if (!key) return null;
    if (["Control", "Alt", "Shift", "Meta"].includes(key)) return null;

    if (key.length === 1) {
      const k = key.toLowerCase();
      // Latin letters / digits / ASCII punctuation — keep as-is
      return k;
    }

    let k = key.toLowerCase();
    if (k === " ") k = "space";
    else if (k === "arrowup") k = "up";
    else if (k === "arrowdown") k = "down";
    else if (k === "arrowleft") k = "left";
    else if (k === "arrowright") k = "right";
    else if (k === "escape") k = "escape";
    else if (k === "enter") k = "enter";
    else if (k === "backspace") k = "backspace";
    else if (k === "delete") k = "delete";
    else if (k === "tab") k = "tab";

    return k;
  }

  private eventToKeyCombo(e: KeyboardEvent): string | null {
    if (["Control", "Alt", "Shift", "Meta"].includes(e.key)) return null;

    const parts: string[] = [];
    if (e.ctrlKey || e.metaKey) parts.push("ctrl");
    if (e.altKey) parts.push("alt");
    if (e.shiftKey) parts.push("shift");

    const keyPart = (e.code && this.physicalCodeToKeyPart(e.code)) ?? this.keyStringToKeyPart(e.key);
    if (!keyPart) return null;

    parts.push(keyPart);
    return parts.join("+");
  }

  private normalizeKey(key: string): string {
    return key
      .toLowerCase()
      .replace(/cmd/g, "ctrl")
      .replace(/meta/g, "ctrl")
      .replace(/mod/g, "ctrl")
      .split("+")
      .map((p) => p.trim())
      .sort((a, b) => {
        const order = ["ctrl", "alt", "shift"];
        const ai = order.indexOf(a);
        const bi = order.indexOf(b);
        if (ai >= 0 && bi >= 0) return ai - bi;
        if (ai >= 0) return -1;
        if (bi >= 0) return 1;
        return 0;
      })
      .join("+");
  }

  onChange(callback: () => void): () => void {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  private notifyListeners(): void {
    for (const cb of this.listeners) cb();
  }
}

export const commandRegistry = new CommandRegistry();

export function formatKeybinding(binding: Keybinding): string {
  const isMac = navigator.platform.toUpperCase().includes("MAC");
  const key = isMac ? (binding.mac ?? binding.key) : binding.key;

  return key
    .split("+")
    .map((part) => {
      const p = part.trim().toLowerCase();
      if (isMac) {
        if (p === "ctrl" || p === "cmd" || p === "mod") return "⌘";
        if (p === "alt") return "⌥";
        if (p === "shift") return "⇧";
      } else {
        if (p === "ctrl" || p === "cmd" || p === "mod") return "Ctrl";
        if (p === "alt") return "Alt";
        if (p === "shift") return "Shift";
      }
      if (p === "enter") return "↵";
      if (p === "escape") return "Esc";
      if (p === "backspace") return "⌫";
      if (p === "delete") return "Del";
      if (p === "up") return "↑";
      if (p === "down") return "↓";
      if (p === "left") return "←";
      if (p === "right") return "→";
      if (p === "space") return "Space";
      if (p === "tab") return "Tab";
      return p.toUpperCase();
    })
    .join(isMac ? "" : "+");
}
