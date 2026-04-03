import { commandPaletteOpenAtom } from "@/atoms";
import { OverlayDialog } from "@/dialogs/OverlayDialog";
import {
  formatKeybinding,
  useCommandRegistry,
  type Command as CommandType,
  type Keybinding,
} from "@/features/commands/commands";
import { useFocusContext } from "@/focusContext";
import { useInteractionContext } from "@/interactionContext";
import { INPUT_NO_ASSIST } from "@/utils/inputNoAssist";
import { useAtom } from "jotai";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import paletteStyles from "./command-palette.module.css";

interface CommandItem {
  command: CommandType;
  keybinding?: Keybinding;
  keybindings: Keybinding[];
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
  const focusContext = useFocusContext();
  const interactionContext = useInteractionContext();
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
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
      const matchingKeybindings = keybindings.filter((k) => k.command === cmd.id);
      const kb = matchingKeybindings[0];
      const displayTitle = cmd.category ? `${cmd.category}: ${cmd.title}` : cmd.title;
      return { command: cmd, keybinding: kb, keybindings: matchingKeybindings, displayTitle };
    });
  }, [commands, keybindings]);

  const filteredItems = useMemo(() => {
    const focusState = focusContext.state;
    const visibilityFocusLayer =
      focusState.current === "commandPalette"
        ? focusState.stack[focusState.stack.length - 1]?.restoreTo ?? "panel"
        : focusState.current;
    return items
      .filter((item) => item.command.palette !== false)
      .filter((item) => {
        const commandVisible = commandRegistry.evaluateWhenForFocus(
          item.command.when,
          visibilityFocusLayer,
        );
        if (!commandVisible) return false;
        if (item.keybindings.length === 0) return true;
        return item.keybindings.some((binding) =>
          commandRegistry.evaluateWhenForFocus(binding.when, visibilityFocusLayer),
        );
      })
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
  }, [commandRegistry, focusContext, items, search]);

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
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          void commandRegistry.executeCommand(commandId);
        });
      });
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
    return interactionContext.registerController({
      contains(node) {
        const container = containerRef.current;
        return node instanceof Node && !!container?.contains(node);
      },
      isActive() {
        return open;
      },
      handleIntent(intent, event) {
        setKeyboardNavigationActive(true);
        hoverSelectionEnabledRef.current = false;
        lastPointerPositionRef.current = null;
        lastHoverSelectionPointerRef.current = null;
        switch (intent) {
          case "cancel":
            paletteStateRef.current.closePalette();
            return true;
          case "cursorDown":
            setSelectedIndex((current) => {
              if (orderedItemsRef.current.length === 0) return 0;
              return Math.max(0, Math.min(orderedItemsRef.current.length - 1, current + 1));
            });
            return true;
          case "cursorUp":
            setSelectedIndex((current) => {
              if (orderedItemsRef.current.length === 0) return 0;
              return Math.max(0, Math.min(orderedItemsRef.current.length - 1, current - 1));
            });
            return true;
          case "cursorPageDown":
            setSelectedIndex((current) => {
              if (orderedItemsRef.current.length === 0) return 0;
              return Math.max(0, Math.min(orderedItemsRef.current.length - 1, current + PAGE_STEP));
            });
            return true;
          case "cursorPageUp":
            setSelectedIndex((current) => {
              if (orderedItemsRef.current.length === 0) return 0;
              return Math.max(0, Math.min(orderedItemsRef.current.length - 1, current - PAGE_STEP));
            });
            return true;
          case "cursorHome":
            if (orderedItemsRef.current.length === 0) return false;
            setSelectedIndex(0);
            return true;
          case "cursorEnd":
            if (orderedItemsRef.current.length === 0) return false;
            setSelectedIndex(orderedItemsRef.current.length - 1);
            return true;
          case "accept": {
            if (event.key !== "Enter") return false;
            const selected = orderedItemsRef.current[selectedIndexRef.current];
            if (!selected) return false;
            executePaletteCommandRef.current(selected.command.id);
            return true;
          }
          default:
            return false;
        }
      },
    });
  }, [open, interactionContext]);

  if (!open) return null;

  return (
    <OverlayDialog
      className={paletteStyles["command-palette-dialog"]}
      onClose={closePalette}
      initialFocusRef={inputRef}
      placement="top"
      focusLayer="commandPalette"
    >
      <div ref={containerRef} className={paletteStyles["command-palette"]}>
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
