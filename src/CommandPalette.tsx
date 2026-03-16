import { Command } from 'cmdk';
import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { commandRegistry, formatKeybinding, type Command as CommandType, type Keybinding } from './commands';
import { focusContext } from './focusContext';

interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface CommandItem {
  command: CommandType;
  keybinding?: Keybinding;
  displayTitle: string;
}

export function CommandPalette({ open, onOpenChange }: CommandPaletteProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [search, setSearch] = useState('');
  const [commands, setCommands] = useState<CommandType[]>([]);
  const [keybindings, setKeybindings] = useState<Keybinding[]>([]);
  const [capturedContext, setCapturedContext] = useState<string | null>(null);

  // Show/hide dialog
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  // Focus search input when palette opens
  useEffect(() => {
    if (open) {
      const t = requestAnimationFrame(() => {
        inputRef.current?.focus();
      });
      return () => cancelAnimationFrame(t);
    }
  }, [open]);

  // Capture the focus context when palette opens (before we push commandPalette)
  useEffect(() => {
    if (open && capturedContext === null) {
      setCapturedContext(focusContext.current);
    } else if (!open) {
      setCapturedContext(null);
    }
  }, [open, capturedContext]);

  useEffect(() => {
    const updateCommands = () => {
      // Use captured context for filtering, or current if not captured yet
      const contextToUse = capturedContext ?? focusContext.current;
      setCommands(commandRegistry.getVisibleCommandsForContext(contextToUse));
      setKeybindings(commandRegistry.getKeybindings());
    };
    updateCommands();
    if (!open) return;
    return commandRegistry.onChange(updateCommands);
  }, [open, capturedContext]);

  const items = useMemo<CommandItem[]>(() => {
    return commands.map(cmd => {
      const kb = keybindings.find(k => k.command === cmd.id);
      const displayTitle = cmd.category ? `${cmd.category}: ${cmd.title}` : cmd.title;
      return { command: cmd, keybinding: kb, displayTitle };
    });
  }, [commands, keybindings]);

  const groupedItems = useMemo(() => {
    const groups = new Map<string, CommandItem[]>();
    for (const item of items) {
      const category = item.command.category ?? 'General';
      if (!groups.has(category)) groups.set(category, []);
      groups.get(category)!.push(item);
    }
    return Array.from(groups.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [items]);

  const handleSelect = useCallback((commandId: string) => {
    onOpenChange(false);
    setSearch('');
    commandRegistry.executeCommand(commandId);
  }, [onOpenChange]);

  useEffect(() => {
    if (!open) setSearch('');
  }, [open]);

  // Manage focus context
  useEffect(() => {
    if (open) {
      focusContext.push('commandPalette');
      return () => focusContext.pop('commandPalette');
    }
  }, [open]);

  // Stop all keyboard events from propagating to panels
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    e.stopPropagation();
  }, []);

  return (
    <dialog
      ref={dialogRef}
      className="command-palette-dialog"
      onClick={(e) => {
        if (e.target === dialogRef.current) onOpenChange(false);
      }}
      onClose={() => onOpenChange(false)}
    >
      <Command
        className="command-palette"
        onKeyDown={handleKeyDown}
        shouldFilter={true}
      >
        <Command.Input
          ref={inputRef}
          value={search}
          onValueChange={setSearch}
          placeholder="Type a command or search..."
        />
        <Command.List>
          <Command.Empty>No results found.</Command.Empty>
          {groupedItems.map(([category, categoryItems]) => (
            <Command.Group key={category} heading={category}>
              {categoryItems.map(({ command, keybinding, displayTitle }) => (
                <Command.Item
                  key={command.id}
                  value={displayTitle}
                  onSelect={() => handleSelect(command.id)}
                >
                  <span className="command-item-title">{command.title}</span>
                  {keybinding && (
                    <span className="command-item-keybinding">
                      {formatKeybinding(keybinding)}
                    </span>
                  )}
                </Command.Item>
              ))}
            </Command.Group>
          ))}
        </Command.List>
      </Command>
    </dialog>
  );
}

export function useCommandPalette() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Cmd+Shift+P or Ctrl+Shift+P to open command palette
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'p') {
        e.preventDefault();
        setOpen(o => !o);
        return;
      }
      // Cmd+P or Ctrl+P (quick open - for now, same as command palette)
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === 'p') {
        e.preventDefault();
        setOpen(o => !o);
        return;
      }
      // Escape closes palette
      if (open && e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setOpen(false);
        return;
      }
      // Let command registry handle other shortcuts when palette is closed
      if (!open) {
        const target = e.target as HTMLElement;
        const inTerminal = target.closest('.terminal-container');
        
        // When in terminal, only intercept shortcuts with Ctrl/Cmd modifier
        // (but not Ctrl+C/D/Z which are terminal control sequences)
        if (inTerminal) {
          const hasModifier = e.metaKey || e.ctrlKey;
          const isTerminalControl = hasModifier && ['c', 'd', 'z', 'v'].includes(e.key.toLowerCase());
          if (!hasModifier || isTerminalControl) {
            return;
          }
        }
        
        commandRegistry.handleKeyboardEvent(e);
      }
    };

    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [open]);

  return { open, setOpen };
}
