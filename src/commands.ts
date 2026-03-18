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
 * 1. Default (Faraday built-in)
 * 2. Extensions
 * 3. User (from ~/.faraday/keybindings.json)
 */

import { focusContext } from './focusContext';

export interface Command {
  id: string;
  title: string;
  category?: string;
  icon?: string;
  when?: string;
  handler: (...args: unknown[]) => void | Promise<void>;
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
  category?: string;
  icon?: string;
}

export interface KeybindingContribution {
  command: string;
  key: string;
  mac?: string;
  when?: string;
}

export type KeybindingLayer = 'default' | 'extension' | 'user';

type CommandHandler = (...args: unknown[]) => void | Promise<void>;
type ContextGetter = () => Record<string, unknown>;

class CommandRegistry {
  private commands = new Map<string, Command>();
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

  registerCommand(id: string, title: string, handler: CommandHandler, options?: { category?: string; icon?: string; when?: string }): () => void {
    const command: Command = {
      id,
      title,
      category: options?.category,
      icon: options?.icon,
      when: options?.when,
      handler,
    };
    this.commands.set(id, command);
    this.notifyListeners();
    return () => {
      this.commands.delete(id);
      this.notifyListeners();
    };
  }

  registerKeybinding(binding: Keybinding, layer: KeybindingLayer = 'default'): () => void {
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
    const command = this.commands.get(id);
    if (!command) {
      console.warn(`Command not found: ${id}`);
      return;
    }
    try {
      await command.handler(...args);
    } catch (err) {
      console.error(`Command ${id} failed:`, err);
    }
  }

  getCommand(id: string): Command | undefined {
    return this.commands.get(id);
  }

  getAllCommands(): Command[] {
    return Array.from(this.commands.values());
  }

  getVisibleCommands(): Command[] {
    return Array.from(this.commands.values()).filter(cmd => this.evaluateWhen(cmd.when));
  }

  getVisibleCommandsForContext(contextOverride: string): Command[] {
    return Array.from(this.commands.values()).filter(cmd => 
      this.evaluateWhenWithContext(cmd.when, contextOverride)
    );
  }

  private evaluateWhenWithContext(when: string | undefined, focusOverride: string): boolean {
    if (!when) return true;
    const userContext = this.contextGetter();
    const context: Record<string, unknown> = {
      ...userContext,
      ...this.contextValues,
      focusPanel: focusOverride === 'panel',
      focusViewer: focusOverride === 'viewer',
      focusEditor: focusOverride === 'editor',
      focusTerminal: focusOverride === 'terminal',
      focusCommandPalette: focusOverride === 'commandPalette',
      focusModal: focusOverride === 'modal',
    };
    try {
      const parts = when.split(/\s*&&\s*/);
      return parts.every(part => {
        const negated = part.startsWith('!');
        const key = negated ? part.slice(1).trim() : part.trim();
        const value = !!context[key];
        return negated ? !value : value;
      });
    } catch {
      return true;
    }
  }

  getKeybindings(): Keybinding[] {
    // Merge layers: later layers override earlier ones for the same key
    const merged = new Map<string, Keybinding>();
    const layers: KeybindingLayer[] = ['default', 'extension', 'user'];
    
    for (const layer of layers) {
      for (const binding of this.keybindingLayers[layer]) {
        const normalizedKey = this.normalizeKey(this.isMac() ? (binding.mac ?? binding.key) : binding.key);
        // Use key + when as the unique identifier for overriding
        const id = `${normalizedKey}|${binding.when ?? ''}`;
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
      focusPanel: currentFocus === 'panel',
      focusViewer: currentFocus === 'viewer',
      focusEditor: currentFocus === 'editor',
      focusTerminal: currentFocus === 'terminal',
      focusCommandPalette: currentFocus === 'commandPalette',
      focusModal: currentFocus === 'modal',
    };
    try {
      const parts = when.split(/\s*&&\s*/);
      return parts.every(part => {
        const negated = part.startsWith('!');
        const key = negated ? part.slice(1).trim() : part.trim();
        const value = !!context[key];
        return negated ? !value : value;
      });
    } catch {
      return true;
    }
  }

  handleKeyboardEvent(e: KeyboardEvent): boolean {
    const keyCombo = this.eventToKeyCombo(e);
    if (!keyCombo) return false;

    // Priority: later layers override earlier ones.
    // Evaluate from highest → lowest and stop on first match.
    const layers: KeybindingLayer[] = ['user', 'extension', 'default'];
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
    return navigator.platform.toUpperCase().includes('MAC');
  }

  private eventToKeyCombo(e: KeyboardEvent): string | null {
    if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return null;

    const parts: string[] = [];
    if (e.ctrlKey || e.metaKey) parts.push('ctrl');
    if (e.altKey) parts.push('alt');
    if (e.shiftKey) parts.push('shift');

    let key = e.key.toLowerCase();
    if (key === ' ') key = 'space';
    else if (key === 'arrowup') key = 'up';
    else if (key === 'arrowdown') key = 'down';
    else if (key === 'arrowleft') key = 'left';
    else if (key === 'arrowright') key = 'right';
    else if (key === 'escape') key = 'escape';
    else if (key === 'enter') key = 'enter';
    else if (key === 'backspace') key = 'backspace';
    else if (key === 'delete') key = 'delete';
    else if (key === 'tab') key = 'tab';

    parts.push(key);
    return parts.join('+');
  }

  private normalizeKey(key: string): string {
    return key
      .toLowerCase()
      .replace(/cmd/g, 'ctrl')
      .replace(/meta/g, 'ctrl')
      .replace(/mod/g, 'ctrl')
      .split('+')
      .map(p => p.trim())
      .sort((a, b) => {
        const order = ['ctrl', 'alt', 'shift'];
        const ai = order.indexOf(a);
        const bi = order.indexOf(b);
        if (ai >= 0 && bi >= 0) return ai - bi;
        if (ai >= 0) return -1;
        if (bi >= 0) return 1;
        return 0;
      })
      .join('+');
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
  const isMac = navigator.platform.toUpperCase().includes('MAC');
  const key = isMac ? (binding.mac ?? binding.key) : binding.key;
  
  return key
    .split('+')
    .map(part => {
      const p = part.trim().toLowerCase();
      if (isMac) {
        if (p === 'ctrl' || p === 'cmd' || p === 'mod') return '⌘';
        if (p === 'alt') return '⌥';
        if (p === 'shift') return '⇧';
      } else {
        if (p === 'ctrl' || p === 'cmd' || p === 'mod') return 'Ctrl';
        if (p === 'alt') return 'Alt';
        if (p === 'shift') return 'Shift';
      }
      if (p === 'enter') return '↵';
      if (p === 'escape') return 'Esc';
      if (p === 'backspace') return '⌫';
      if (p === 'delete') return 'Del';
      if (p === 'up') return '↑';
      if (p === 'down') return '↓';
      if (p === 'left') return '←';
      if (p === 'right') return '→';
      if (p === 'space') return 'Space';
      if (p === 'tab') return 'Tab';
      return p.toUpperCase();
    })
    .join(isMac ? '' : '+');
}
