/**
 * Command System
 * 
 * VS Code compatible command registry with support for:
 * - Command registration and execution
 * - Keyboard shortcuts (keybindings)
 * - Extension-contributed commands
 * - Command palette integration
 */

export interface Command {
  id: string;
  title: string;
  category?: string;
  icon?: string;
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

type CommandHandler = (...args: unknown[]) => void | Promise<void>;
type ContextGetter = () => Record<string, unknown>;

class CommandRegistry {
  private commands = new Map<string, Command>();
  private keybindings: Keybinding[] = [];
  private contextGetter: ContextGetter = () => ({});
  private listeners = new Set<() => void>();

  registerCommand(id: string, title: string, handler: CommandHandler, options?: { category?: string; icon?: string }): () => void {
    const command: Command = {
      id,
      title,
      category: options?.category,
      icon: options?.icon,
      handler,
    };
    this.commands.set(id, command);
    this.notifyListeners();
    return () => {
      this.commands.delete(id);
      this.notifyListeners();
    };
  }

  registerKeybinding(binding: Keybinding): () => void {
    this.keybindings.push(binding);
    this.notifyListeners();
    return () => {
      const idx = this.keybindings.indexOf(binding);
      if (idx >= 0) this.keybindings.splice(idx, 1);
      this.notifyListeners();
    };
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

  getKeybindings(): Keybinding[] {
    return [...this.keybindings];
  }

  getKeybindingForCommand(commandId: string): Keybinding | undefined {
    return this.keybindings.find(k => k.command === commandId);
  }

  evaluateWhen(when: string | undefined): boolean {
    if (!when) return true;
    const context = this.contextGetter();
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

    for (const binding of this.keybindings) {
      const bindingKey = this.normalizeKey(this.isMac() ? (binding.mac ?? binding.key) : binding.key);
      if (bindingKey === keyCombo && this.evaluateWhen(binding.when)) {
        e.preventDefault();
        e.stopPropagation();
        this.executeCommand(binding.command);
        return true;
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
