import { commandPaletteOpenAtom } from "@/atoms";
import { OverlayDialog } from "@/dialogs/OverlayDialog";
import {
  formatKeybinding,
  useCommandRegistry,
  type Command as CommandType,
  type Keybinding,
} from "@/features/commands/commands";
import { INPUT_NO_ASSIST } from "@/utils/inputNoAssist";
import { useAtom } from "jotai";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import paletteStyles from "./command-palette.module.css";

interface CommandItem {
  command: CommandType;
  keybinding?: Keybinding;
  displayTitle: string;
}

interface OrderedCommandItem extends CommandItem {
  filteredIndex: number;
}

const PAGE_STEP = 10;
const RECENT_COMMAND_LIMIT = 8;

function fuzzyMatch(haystack: string, needle: string): boolean {
  const query = needle.trim().toLowerCase();
  if (!query) return true;
  const text = haystack.toLowerCase();
  return text.includes(query);
}

export function CommandPalette() {
  const [open, setOpen] = useAtom(commandPaletteOpenAtom);
  const commandRegistry = useCommandRegistry();
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [search, setSearch] = useState("");
  const [commands, setCommands] = useState<CommandType[]>([]);
  const [keybindings, setKeybindings] = useState<Keybinding[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [keyboardNavigationActive, setKeyboardNavigationActive] = useState(false);
  const [recentCommandIds, setRecentCommandIds] = useState<string[]>([]);
  const filteredItemsRef = useRef<CommandItem[]>([]);
  const orderedItemsRef = useRef<OrderedCommandItem[]>([]);
  const selectedIndexRef = useRef(0);
  const hoverSelectionEnabledRef = useRef(true);
  const lastPointerPositionRef = useRef<{ x: number; y: number } | null>(null);
  const lastHoverSelectionPointerRef = useRef<{ x: number; y: number } | null>(null);
  selectedIndexRef.current = selectedIndex;

  useEffect(() => {
    if (!open) return;
    const t = requestAnimationFrame(() => {
      inputRef.current?.focus();
    });
    return () => cancelAnimationFrame(t);
  }, [open]);

  useEffect(() => {
    const updateCommands = () => {
      setCommands(commandRegistry.getAllCommands());
      setKeybindings(commandRegistry.getKeybindings());
    };
    updateCommands();
    if (!open) return;
    return commandRegistry.onChange(updateCommands);
  }, [open, commandRegistry]);

  const items = useMemo<CommandItem[]>(() => {
    return commands.map((cmd) => {
      const kb = keybindings.find((k) => k.command === cmd.id);
      const displayTitle = cmd.category ? `${cmd.category}: ${cmd.title}` : cmd.title;
      return { command: cmd, keybinding: kb, displayTitle };
    });
  }, [commands, keybindings]);

  const filteredItems = useMemo(() => {
    return items
      .filter((item) =>
        fuzzyMatch(
          `${item.command.title}\n${item.command.category ?? ""}\n${item.command.id}\n${item.displayTitle}`,
          search,
        ),
      )
      .sort((a, b) => {
        const categoryCompare = (a.command.category ?? "General").localeCompare(
          b.command.category ?? "General",
        );
        if (categoryCompare !== 0) return categoryCompare;
        return a.command.title.localeCompare(b.command.title);
      });
  }, [items, search]);

  const groupedItems = useMemo(() => {
    const recentById = new Map(
      recentCommandIds
        .map((commandId) => {
          const filteredIndex = filteredItems.findIndex((item) => item.command.id === commandId);
          if (filteredIndex < 0) return null;
          return [commandId, { ...filteredItems[filteredIndex], filteredIndex }] as const;
        })
        .filter((item): item is readonly [string, OrderedCommandItem] => item !== null),
    );
    const groups = new Map<string, OrderedCommandItem[]>();
    filteredItems.forEach((item, filteredIndex) => {
      if (recentById.has(item.command.id)) return;
      const category = item.command.category ?? "General";
      if (!groups.has(category)) groups.set(category, []);
      groups.get(category)!.push({ ...item, filteredIndex });
    });
    const orderedGroups = Array.from(groups.entries()).sort((a, b) => a[0].localeCompare(b[0]));
    const recentItems = recentCommandIds
      .map((commandId) => recentById.get(commandId))
      .filter((item): item is OrderedCommandItem => item != null);
    if (recentItems.length > 0) {
      orderedGroups.unshift(["Recent", recentItems]);
    }
    return orderedGroups;
  }, [filteredItems, recentCommandIds]);

  const orderedItems = useMemo(
    () => groupedItems.flatMap(([, categoryItems]) => categoryItems),
    [groupedItems],
  );

  const closePalette = useCallback(() => {
    setOpen(false);
    setSearch("");
    setSelectedIndex(0);
    setKeyboardNavigationActive(false);
    hoverSelectionEnabledRef.current = true;
    lastPointerPositionRef.current = null;
    lastHoverSelectionPointerRef.current = null;
  }, [setOpen]);

  const paletteStateRef = useRef({
    closePalette,
    commandRegistry,
  });
  paletteStateRef.current = {
    closePalette,
    commandRegistry,
  };

  useEffect(() => {
    setSelectedIndex((current) => {
      if (orderedItems.length === 0) return 0;
      return Math.min(current, orderedItems.length - 1);
    });
  }, [orderedItems.length]);

  filteredItemsRef.current = filteredItems;
  orderedItemsRef.current = orderedItems;

  const executePaletteCommand = useCallback(
    (commandId: string) => {
      setRecentCommandIds((current) => {
        const next = [commandId, ...current.filter((id) => id !== commandId)];
        return next.slice(0, RECENT_COMMAND_LIMIT);
      });
      closePalette();
      void commandRegistry.executeCommand(commandId);
    },
    [closePalette, commandRegistry],
  );

  const executePaletteCommandRef = useRef(executePaletteCommand);
  executePaletteCommandRef.current = executePaletteCommand;

  useEffect(() => {
    if (!open) {
      setSearch("");
      setSelectedIndex(0);
      setKeyboardNavigationActive(false);
      lastPointerPositionRef.current = null;
      lastHoverSelectionPointerRef.current = null;
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const selectedEl = listRef.current?.querySelector<HTMLElement>(
      `[data-command-index="${selectedIndex}"]`,
    );
    selectedEl?.scrollIntoView({ block: "nearest" });
  }, [open, selectedIndex]);

  useEffect(() => {
    if (!open) return;
    const disposables = [
      commandRegistry.registerCommand("commandPalette.close", () => {
        paletteStateRef.current.closePalette();
      }),
      commandRegistry.registerCommand("commandPalette.selectNext", () => {
        setKeyboardNavigationActive(true);
        hoverSelectionEnabledRef.current = false;
        lastPointerPositionRef.current = null;
        lastHoverSelectionPointerRef.current = null;
        setSelectedIndex((current) => {
          if (orderedItemsRef.current.length === 0) return 0;
          return Math.max(0, Math.min(orderedItemsRef.current.length - 1, current + 1));
        });
      }),
      commandRegistry.registerCommand("commandPalette.selectPrevious", () => {
        setKeyboardNavigationActive(true);
        hoverSelectionEnabledRef.current = false;
        lastPointerPositionRef.current = null;
        lastHoverSelectionPointerRef.current = null;
        setSelectedIndex((current) => {
          if (orderedItemsRef.current.length === 0) return 0;
          return Math.max(0, Math.min(orderedItemsRef.current.length - 1, current - 1));
        });
      }),
      commandRegistry.registerCommand("commandPalette.selectPageDown", () => {
        setKeyboardNavigationActive(true);
        hoverSelectionEnabledRef.current = false;
        lastPointerPositionRef.current = null;
        lastHoverSelectionPointerRef.current = null;
        setSelectedIndex((current) => {
          if (orderedItemsRef.current.length === 0) return 0;
          return Math.max(0, Math.min(orderedItemsRef.current.length - 1, current + PAGE_STEP));
        });
      }),
      commandRegistry.registerCommand("commandPalette.selectPageUp", () => {
        setKeyboardNavigationActive(true);
        hoverSelectionEnabledRef.current = false;
        lastPointerPositionRef.current = null;
        lastHoverSelectionPointerRef.current = null;
        setSelectedIndex((current) => {
          if (orderedItemsRef.current.length === 0) return 0;
          return Math.max(0, Math.min(orderedItemsRef.current.length - 1, current - PAGE_STEP));
        });
      }),
      commandRegistry.registerCommand("commandPalette.selectFirst", () => {
        setKeyboardNavigationActive(true);
        hoverSelectionEnabledRef.current = false;
        lastPointerPositionRef.current = null;
        lastHoverSelectionPointerRef.current = null;
        setSelectedIndex(() => {
          if (orderedItemsRef.current.length === 0) return 0;
          return 0;
        });
      }),
      commandRegistry.registerCommand("commandPalette.selectLast", () => {
        setKeyboardNavigationActive(true);
        hoverSelectionEnabledRef.current = false;
        lastPointerPositionRef.current = null;
        lastHoverSelectionPointerRef.current = null;
        setSelectedIndex(() => {
          if (orderedItemsRef.current.length === 0) return 0;
          return orderedItemsRef.current.length - 1;
        });
      }),
      commandRegistry.registerCommand("commandPalette.execute", () => {
        const selected = orderedItemsRef.current[selectedIndexRef.current];
        if (!selected) return;
        executePaletteCommandRef.current(selected.command.id);
      }),
    ];
    return () => {
      disposables.forEach((dispose) => dispose());
    };
  }, [commandRegistry, open]);

  useEffect(() => {
    if (!open) return;
    const disposables = [
      commandRegistry.registerKeybinding({ command: "commandPalette.close", key: "escape", when: "focusCommandPalette" }),
      commandRegistry.registerKeybinding({ command: "commandPalette.selectNext", key: "down", when: "focusCommandPalette" }),
      commandRegistry.registerKeybinding({ command: "commandPalette.selectPrevious", key: "up", when: "focusCommandPalette" }),
      commandRegistry.registerKeybinding({ command: "commandPalette.selectPageDown", key: "pagedown", when: "focusCommandPalette" }),
      commandRegistry.registerKeybinding({ command: "commandPalette.selectPageUp", key: "pageup", when: "focusCommandPalette" }),
      commandRegistry.registerKeybinding({ command: "commandPalette.selectFirst", key: "home", when: "focusCommandPalette" }),
      commandRegistry.registerKeybinding({ command: "commandPalette.selectLast", key: "end", when: "focusCommandPalette" }),
      commandRegistry.registerKeybinding({ command: "commandPalette.execute", key: "enter", when: "focusCommandPalette" }),
    ];
    return () => {
      disposables.forEach((dispose) => dispose());
    };
  }, [commandRegistry, open]);

  const allowCommandRouting = useCallback((event: KeyboardEvent) => {
    const key = event.key.toLowerCase();
    if ((event.ctrlKey || event.metaKey) && key === "p") return true;
    if (event.ctrlKey || event.metaKey || event.altKey) return false;
    return (
      key === "escape" ||
      key === "enter" ||
      key === "arrowup" ||
      key === "arrowdown" ||
      key === "home" ||
      key === "end" ||
      key === "pageup" ||
      key === "pagedown"
    );
  }, []);

  if (!open) return null;

  return (
    <OverlayDialog
      className={paletteStyles["command-palette-dialog"]}
      onClose={closePalette}
      initialFocusRef={inputRef}
      placement="top"
      focusLayer="commandPalette"
      allowCommandRouting={allowCommandRouting}
    >
      <div className={paletteStyles["command-palette"]}>
        <input
          ref={inputRef}
          className={paletteStyles["command-palette-input"]}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Type a command or search..."
          {...INPUT_NO_ASSIST}
        />
        <div
          ref={listRef}
          className={paletteStyles["command-palette-list"]}
          data-keyboard-nav={keyboardNavigationActive ? "true" : "false"}
          onMouseMove={(event) => {
            const prev = lastPointerPositionRef.current;
            const next = { x: event.clientX, y: event.clientY };
            lastPointerPositionRef.current = next;
            if (!prev) return;
            if (prev.x === next.x && prev.y === next.y) return;
            setKeyboardNavigationActive(false);
            hoverSelectionEnabledRef.current = true;
            lastHoverSelectionPointerRef.current = null;
          }}
        >
          {filteredItems.length === 0 ? (
            <div className={paletteStyles["command-palette-empty"]}>No results found.</div>
          ) : (
            groupedItems.map(([category, categoryItems]) => (
              <section key={category}>
                <div className={paletteStyles["command-palette-group-heading"]}>{category}</div>
                <ul className={paletteStyles["command-palette-group-list"]}>
                  {categoryItems.map(({ command, keybinding, filteredIndex }) => {
                    const renderedIndex = orderedItems.findIndex((item) => item.filteredIndex === filteredIndex);
                    const isSelected = renderedIndex === selectedIndex;
                    return (
                      <li
                        key={command.id}
                        data-command-index={renderedIndex}
                        className={paletteStyles["command-palette-item"]}
                        data-selected={isSelected ? "true" : "false"}
                        onMouseMove={(event) => {
                          if (!hoverSelectionEnabledRef.current) return;
                          const next = { x: event.clientX, y: event.clientY };
                          const prev = lastHoverSelectionPointerRef.current;
                          if (prev && prev.x === next.x && prev.y === next.y) return;
                          lastHoverSelectionPointerRef.current = next;
                          if (selectedIndexRef.current === renderedIndex) return;
                          setSelectedIndex(renderedIndex);
                        }}
                        onClick={() => {
                          setSelectedIndex(renderedIndex);
                          executePaletteCommand(command.id);
                        }}
                      >
                        <span className={paletteStyles["command-item-title"]}>{command.title}</span>
                        {keybinding && (
                          <span className={paletteStyles["command-item-keybinding"]}>
                            {formatKeybinding(keybinding)}
                          </span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))
          )}
        </div>
      </div>
    </OverlayDialog>
  );
}
