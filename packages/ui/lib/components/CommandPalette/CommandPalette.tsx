import { commandPaletteOpenAtom } from "@/atoms";
import { OverlayDialog } from "@/dialogs/OverlayDialog";
import { commandRegistry, formatKeybinding, type Command as CommandType, type Keybinding } from "@/features/commands/commands";
import { INPUT_NO_ASSIST } from "@/utils/inputNoAssist";
import { Command } from "cmdk";
import { useAtom } from "jotai";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import paletteStyles from "./command-palette.module.css";

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
  const inputRef = useRef<HTMLInputElement>(null);
  const [search, setSearch] = useState("");
  const [commands, setCommands] = useState<CommandType[]>([]);
  const [keybindings, setKeybindings] = useState<Keybinding[]>([]);

  // Focus search input when palette opens
  useEffect(() => {
    if (open) {
      const t = requestAnimationFrame(() => {
        inputRef.current?.focus();
      });
      return () => cancelAnimationFrame(t);
    }
  }, [open]);

  useEffect(() => {
    const updateCommands = () => {
      setCommands(commandRegistry.getAllCommands());
      setKeybindings(commandRegistry.getKeybindings());
    };
    updateCommands();
    if (!open) return;
    return commandRegistry.onChange(updateCommands);
  }, [open]);

  const items = useMemo<CommandItem[]>(() => {
    return commands.map((cmd) => {
      const kb = keybindings.find((k) => k.command === cmd.id);
      const displayTitle = cmd.category ? `${cmd.category}: ${cmd.title}` : cmd.title;
      return { command: cmd, keybinding: kb, displayTitle };
    });
  }, [commands, keybindings]);

  const groupedItems = useMemo(() => {
    const groups = new Map<string, CommandItem[]>();
    for (const item of items) {
      const category = item.command.category ?? "General";
      if (!groups.has(category)) groups.set(category, []);
      groups.get(category)!.push(item);
    }
    return Array.from(groups.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [items]);

  const handleSelect = useCallback(
    (commandId: string) => {
      onOpenChange(false);
      setSearch("");
      commandRegistry.executeCommand(commandId);
    },
    [onOpenChange],
  );

  useEffect(() => {
    if (!open) setSearch("");
  }, [open]);

  // Stop all keyboard events from propagating to panels
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    e.stopPropagation();
  }, []);

  if (!open) return null;

  return (
    <OverlayDialog
      className={paletteStyles["command-palette-dialog"]}
      onClose={() => onOpenChange(false)}
      initialFocusRef={inputRef}
      placement="top"
      focusLayer="commandPalette"
    >
      <Command className={paletteStyles["command-palette"]} onKeyDown={handleKeyDown} shouldFilter={true}>
        <Command.Input ref={inputRef} value={search} onValueChange={setSearch} placeholder="Type a command or search..." {...INPUT_NO_ASSIST} />
        <Command.List>
          <Command.Empty>No results found.</Command.Empty>
          {groupedItems.map(([category, categoryItems]) => (
            <Command.Group key={category} heading={category}>
              {categoryItems.map(({ command, keybinding, displayTitle }) => (
                <Command.Item key={command.id} value={displayTitle} onSelect={() => handleSelect(command.id)}>
                  <span className={paletteStyles["command-item-title"]}>{command.title}</span>
                  {keybinding && <span className={paletteStyles["command-item-keybinding"]}>{formatKeybinding(keybinding)}</span>}
                </Command.Item>
              ))}
            </Command.Group>
          ))}
        </Command.List>
      </Command>
    </OverlayDialog>
  );
}

export function useCommandPalette() {
  const [open, setOpen] = useAtom(commandPaletteOpenAtom);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Escape closes palette
      if (open && e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setOpen(false);
        return;
      }

      // When palette is already open, Ctrl/Cmd+P (and Ctrl/Cmd+Shift+P) should close it.
      if (open && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "p") {
        e.preventDefault();
        e.stopPropagation();
        setOpen((o) => !o);
        return;
      }
    };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [open]);

  return { open, setOpen };
}
