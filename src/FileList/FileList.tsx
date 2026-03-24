import { FsNode } from "fss-lang";
import type { LayeredResolver } from "fss-lang";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { actionQueue } from "../actionQueue";
import { commandRegistry } from "../commands";
import { viewerRegistry, editorRegistry } from "../viewerEditorRegistry";
import { resolveEntryStyle } from "../fss";
import type { ResolvedEntryStyle } from "../types";
import { resolveIcon, loadIconsForPaths, getCachedIcon, onIconThemeChange } from "../iconResolver";
import { dirname, join } from "../path";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { Breadcrumbs } from "./Breadcrumbs";
import { ColumnsScroller, type ColumnsScrollerProps } from "./ColumnsScroller";

const ROW_HEIGHT = 26;

interface FileListProps {
  currentPath: string;
  parentNode?: FsNode;
  entries: FsNode[];
  onNavigate: (path: string) => Promise<void>;
  onViewFile?: (filePath: string, fileName: string, fileSize: number) => void;
  onEditFile?: (filePath: string, fileName: string, fileSize: number, langId: string) => void;
  /** Move selected items to trash. Receives (sourcePaths, refresh). */
  onMoveToTrash?: (sourcePaths: string[], refresh: () => void) => void;
  /** Permanently delete selected items. Receives (sourcePaths, refresh). */
  onPermanentDelete?: (sourcePaths: string[], refresh: () => void) => void;
  /** Copy selected items. Receives (sourcePaths, refresh). */
  onCopy?: (sourcePaths: string[], refresh: () => void) => void;
  /** Move selected items. Receives (sourcePaths, refresh). */
  onMove?: (sourcePaths: string[], refresh: () => void) => void;
  /** Rename item under cursor. Receives (sourcePath, currentName, refresh). */
  onRename?: (sourcePath: string, currentName: string, refresh: () => void) => void;
  /** Run executable in terminal: receives (command) and should write command + newline to terminal. */
  onExecuteInTerminal?: (command: string) => Promise<void>;
  /** Paste filename or path into the command line. */
  onPasteToCommandLine?: (text: string) => void;
  editorFileSizeLimit?: number;
  selectionKey?: number;
  active: boolean;
  resolver: LayeredResolver;
  requestedActiveName?: string;
  requestedTopmostName?: string;
  onStateChange?: (selectedName: string | undefined, topmostName: string | undefined) => void;
}

interface NavigationState {
  path: string;
  selectedName: string;
  topmostName: string;
}

interface DisplayEntry {
  entry: FsNode;
  style: ResolvedEntryStyle;
  iconPath: string | null;
  iconFallbackUrl: string;
}

function formatSize(sizeValue: unknown): string {
  let size: number;
  if (typeof sizeValue === "number") size = sizeValue;
  else if (typeof sizeValue === "bigint") size = Number(sizeValue);
  else return "";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} K`;
  if (size < 1024 * 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} M`;
  return `${(size / (1024 * 1024 * 1024)).toFixed(1)} G`;
}

function formatDate(ms: number): string {
  if (!ms) return "";
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function getIconUrl(iconPath: string | null): string | undefined {
  if (iconPath) {
    return getCachedIcon(iconPath) ?? undefined;
  }
  return undefined;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export const FileList = memo(
  function FileList({
    currentPath,
    parentNode,
    entries,
    onNavigate,
    onViewFile,
    onEditFile,
    onMoveToTrash,
    onPermanentDelete,
    onCopy,
    onMove,
    onRename,
    onExecuteInTerminal,
    onPasteToCommandLine,
    editorFileSizeLimit = 0,
    selectionKey,
    active,
    resolver,
    requestedActiveName,
    requestedTopmostName,
    onStateChange,
  }: FileListProps) {
    const [activeIndex, setActiveIndex] = useState(0);
    const [topmostIndex, setTopmostIndex] = useState(0);
    const [maxItemsPerColumn, setMaxItemsPerColumn] = useState(1);
    const [columnCount, setColumnCount] = useState(1);
    const [iconsVersion, setIconsVersion] = useState(0);
    const [selectedNames, setSelectedNames] = useState<ReadonlySet<string>>(new Set());
    const [keyboardNavMode, setKeyboardNavMode] = useState(false);
    const keyboardNavModeRef = useRef(keyboardNavMode);
    keyboardNavModeRef.current = keyboardNavMode;
    const isTouchscreen = useMediaQuery("(pointer: coarse)");
    const selectedNamesRef = useRef(selectedNames);
    selectedNamesRef.current = selectedNames;
    /** true = selecting, false = deselecting, undefined = no shift selection in progress */
    const prevSelectRef = useRef<boolean | undefined>(undefined);
    const prevPathRef = useRef(currentPath);
    const navStackRef = useRef<NavigationState[]>([]);

    const activeIndexRef = useRef(activeIndex);
    activeIndexRef.current = activeIndex;
    const topmostIndexRef = useRef(topmostIndex);
    topmostIndexRef.current = topmostIndex;
    const currentPathRef = useRef(currentPath);
    currentPathRef.current = currentPath;
    const onNavigateRef = useRef(onNavigate);
    onNavigateRef.current = onNavigate;
    const onViewFileRef = useRef(onViewFile);
    onViewFileRef.current = onViewFile;
    const onEditFileRef = useRef(onEditFile);
    onEditFileRef.current = onEditFile;
    const onExecuteInTerminalRef = useRef(onExecuteInTerminal);
    onExecuteInTerminalRef.current = onExecuteInTerminal;
    const onPasteToCommandLineRef = useRef(onPasteToCommandLine);
    onPasteToCommandLineRef.current = onPasteToCommandLine;
    const onMoveToTrashRef = useRef(onMoveToTrash);
    onMoveToTrashRef.current = onMoveToTrash;
    const onPermanentDeleteRef = useRef(onPermanentDelete);
    onPermanentDeleteRef.current = onPermanentDelete;
    const onCopyRef = useRef(onCopy);
    onCopyRef.current = onCopy;
    const onMoveRef = useRef(onMove);
    onMoveRef.current = onMove;
    const onRenameRef = useRef(onRename);
    onRenameRef.current = onRename;
    const editorFileSizeLimitRef = useRef(editorFileSizeLimit);
    editorFileSizeLimitRef.current = editorFileSizeLimit;

    const markKeyboardNav = useCallback(() => {
      if (!keyboardNavModeRef.current) setKeyboardNavMode(true);
    }, []);
    const clearKeyboardNav = useCallback(() => {
      if (keyboardNavModeRef.current) setKeyboardNavMode(false);
    }, []);

    const sorted = useMemo(() => {
      const withStyle = entries.map((entry) => {
        entry = { ...entry, parent: parentNode };
        const style = resolveEntryStyle(resolver, entry);
        const isDir = entry.type === "folder";
        const resolved = resolveIcon(entry.name, isDir, false, false, entry.lang, style.icon);
        return { entry, style, iconPath: resolved.path, iconFallbackUrl: resolved.fallbackUrl };
      });
      withStyle.sort((a, b) => {
        if (a.style.groupFirst !== b.style.groupFirst) return a.style.groupFirst ? -1 : 1;
        if (a.style.sortPriority !== b.style.sortPriority) return b.style.sortPriority - a.style.sortPriority;
        return a.entry.name.localeCompare(b.entry.name);
      });
      return withStyle;
    }, [entries, currentPath]);

    const displayEntries: DisplayEntry[] = useMemo(() => {
      const result: DisplayEntry[] = [];
      if (parentNode) {
        const expandedParentNode = { ...parentNode, stateFlags: 1 };
        const style = resolveEntryStyle(resolver, expandedParentNode);
        const resolved = resolveIcon("..", true, true, false, "", style.icon);
        result.push({
          entry: { ...expandedParentNode, name: ".." },
          style,
          iconPath: resolved.path,
          iconFallbackUrl: resolved.fallbackUrl,
        });
      }
      for (const item of sorted) result.push(item);
      return result;
    }, [sorted, parentNode]);

    const displayEntriesRef = useRef(displayEntries);
    displayEntriesRef.current = displayEntries;

    const neededIcons = useMemo(() => {
      const paths = new Set<string>();
      for (const { iconPath } of displayEntries) {
        if (iconPath) paths.add(iconPath);
      }
      return [...paths];
    }, [displayEntries]);

    useEffect(() => {
      let cancelled = false;
      loadIconsForPaths(neededIcons).then(() => {
        if (!cancelled) setIconsVersion((n) => n + 1);
      });
      return () => {
        cancelled = true;
      };
    }, [neededIcons]);

    // Re-render when icon theme changes
    useEffect(() => {
      return onIconThemeChange(() => {
        setIconsVersion((n) => n + 1);
      });
    }, []);

    useEffect(() => {
      const prevPath = prevPathRef.current;
      prevPathRef.current = currentPath;

      if (prevPath === currentPath) {
        setActiveIndex((i) => Math.min(i, displayEntries.length - 1));
        return;
      }

      // Navigating to parent - check if we have stored state
      if (prevPath.startsWith(currentPath)) {
        const stack = navStackRef.current;
        // Pop states until we find one for current path or stack is empty
        while (stack.length > 0 && stack[stack.length - 1].path !== currentPath) {
          stack.pop();
        }
        const savedState = stack.pop();

        if (savedState) {
          // Restore from stack
          const selectedIdx = displayEntries.findIndex((d) => d.entry.name === savedState.selectedName);
          const topmostIdx = displayEntries.findIndex((d) => d.entry.name === savedState.topmostName);
          setActiveIndex(selectedIdx >= 0 ? selectedIdx : 0);
          setTopmostIndex(topmostIdx >= 0 ? topmostIdx : 0);
          return;
        }

        // Fallback: select the child folder we came from.
        // Strip the container-path separator (null byte) that may appear when prevPath
        // was a container root, e.g. "archive.zip\0" → "archive.zip".
        const remainder = prevPath.slice(currentPath.length).replace(/^\//, "");
        // oxlint-disable-next-line no-control-regex
        const childName = remainder.split("/")[0].replace(/\0.*$/, "");
        if (childName) {
          const idx = displayEntries.findIndex((d) => d.entry.name === childName);
          if (idx >= 0) {
            setActiveIndex(idx);
            setTopmostIndex(Math.max(0, idx - 5)); // Show some context above
            return;
          }
        }
      }

      setActiveIndex(0);
      setTopmostIndex(0);
    }, [currentPath, displayEntries]);

    useEffect(() => {
      if (!requestedActiveName) return;
      const entries = displayEntriesRef.current;
      const idx = entries.findIndex((d) => d.entry.name === requestedActiveName);
      if (idx >= 0) setActiveIndex(idx);
    }, [requestedActiveName]);

    useEffect(() => {
      if (!requestedTopmostName) return;
      const entries = displayEntriesRef.current;
      const idx = entries.findIndex((d) => d.entry.name === requestedTopmostName);
      if (idx >= 0) setTopmostIndex(idx);
    }, [requestedTopmostName]);

    const onStateChangeRef = useRef(onStateChange);
    onStateChangeRef.current = onStateChange;

    // Report state changes to parent (debounced to avoid per-tick overhead during scroll)
    const stateChangeTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
    useEffect(() => {
      if (!onStateChangeRef.current) return;
      clearTimeout(stateChangeTimerRef.current);
      stateChangeTimerRef.current = setTimeout(() => {
        const selectedName = displayEntriesRef.current[activeIndexRef.current]?.entry.name;
        const topmostName = displayEntriesRef.current[topmostIndexRef.current]?.entry.name;
        onStateChangeRef.current?.(selectedName, topmostName);
      }, 150);
    }, [activeIndex, topmostIndex, displayEntries]);

    const handleBreadcrumbNavigate = useCallback((path: string) => {
      void onNavigateRef.current(path);
    }, []);

    // Selection helpers
    type SelectionType = "include-active" | "exclude-active";

    const applySelection = useCallback((oldIndex: number, newIndex: number, selectType: SelectionType) => {
      const entries = displayEntriesRef.current;
      if (prevSelectRef.current === undefined) {
        const currentName = entries[oldIndex]?.entry.name;
        prevSelectRef.current = currentName ? !selectedNamesRef.current.has(currentName) : true;
      }
      const selecting = prevSelectRef.current;
      const lo = Math.min(oldIndex, newIndex);
      const hi = Math.max(oldIndex, newIndex);

      setSelectedNames((prev) => {
        const next = new Set(prev);
        for (let i = lo; i <= hi; i++) {
          if (selectType === "exclude-active" && i === newIndex) continue;
          const name = entries[i]?.entry.name;
          if (!name) continue;
          if (selecting) next.add(name);
          else next.delete(name);
        }
        return next;
      });

      setActiveIndex(clamp(newIndex, 0, entries.length - 1));
    }, []);

    // Reset shift selection state on keyup
    useEffect(() => {
      if (!active) return;
      const handleKeyUp = (e: KeyboardEvent) => {
        if (!e.shiftKey && prevSelectRef.current !== undefined) {
          prevSelectRef.current = undefined;
        }
      };
      window.addEventListener("keyup", handleKeyUp);
      return () => window.removeEventListener("keyup", handleKeyUp);
    }, [active]);

    // Clear selection when navigating to a new directory or after copy/move
    useEffect(() => {
      setSelectedNames(new Set());
      prevSelectRef.current = undefined;
    }, [currentPath, selectionKey]);

    const navigateToEntry = useCallback(async (entry: FsNode): Promise<void> => {
      if (entry.name === "..") {
        await onNavigateRef.current(dirname(currentPathRef.current));
      } else if (entry.type === "folder") {
        // Save current state to navigation stack before entering folder
        const selectedName = displayEntriesRef.current[activeIndexRef.current]?.entry.name;
        const topmostName = displayEntriesRef.current[topmostIndexRef.current]?.entry.name;
        if (selectedName) {
          navStackRef.current.push({
            path: currentPathRef.current,
            selectedName,
            topmostName: topmostName ?? selectedName,
          });
        }
        await onNavigateRef.current(join(currentPathRef.current, entry.name));
      } else if (entry.type === "file" && onViewFileRef.current) {
        onViewFileRef.current(entry.path as string, entry.name, Number(entry.meta.size));
      }
    }, []);

    const displayedItems = Math.min(displayEntries.length, maxItemsPerColumn * columnCount);
    const maxItemsPerColumnRef = useRef(maxItemsPerColumn);
    maxItemsPerColumnRef.current = maxItemsPerColumn;
    const displayedItemsRef = useRef(displayedItems);
    displayedItemsRef.current = displayedItems;

    useEffect(() => {
      setTopmostIndex((t) => {
        const totalVisible = maxItemsPerColumn * columnCount;
        if (activeIndex < t) return activeIndex;
        if (activeIndex > t + totalVisible - 1) return activeIndex - totalVisible + 1;
        return t;
      });
    }, [activeIndex, maxItemsPerColumn, columnCount]);

    // Update context when selection changes or registries update
    const updateSelectionContext = useCallback(() => {
      const item = displayEntriesRef.current[activeIndexRef.current];
      const isFile = item?.entry.type === "file";
      const isExecutable = isFile && item != null && !!(item.entry.meta as { executable?: boolean }).executable;
      const fileName = item?.entry.name ?? "";
      commandRegistry.beginBatch();
      commandRegistry.setContext("listItemIsFile", isFile);
      commandRegistry.setContext("listItemIsFolder", !isFile && item != null);
      commandRegistry.setContext("listItemIsExecutable", isExecutable);
      commandRegistry.setContext("listItemHasViewer", isFile && viewerRegistry.resolve(fileName) !== null);
      commandRegistry.setContext("listItemHasEditor", isFile && editorRegistry.resolve(fileName) !== null);
      commandRegistry.endBatch();
    }, []);

    useEffect(() => {
      if (!active) return;
      updateSelectionContext();
    }, [active, activeIndex, displayEntries, updateSelectionContext]);

    useEffect(() => {
      if (!active) return;
      const unsubViewer = viewerRegistry.onChange(updateSelectionContext);
      const unsubEditor = editorRegistry.onChange(updateSelectionContext);
      return () => {
        unsubViewer();
        unsubEditor();
      };
    }, [active, updateSelectionContext]);

    // Register navigation commands when panel is active
    useEffect(() => {
      if (!active) return;

      const disposables: (() => void)[] = [];
      const category = "Navigation";
      const whenFocusPanel = "focusPanel";
      const options = { category, when: whenFocusPanel };

      disposables.push(
        commandRegistry.registerCommand(
          "list.cursorUp",
          "Cursor Up",
          () =>
            actionQueue.enqueue(() => {
              markKeyboardNav();
              setActiveIndex((i) => Math.max(0, i - 1));
            }),
          options,
        ),
      );
      disposables.push(
        commandRegistry.registerKeybinding({
          command: "list.cursorUp",
          key: "up",
          when: whenFocusPanel,
        }),
      );

      disposables.push(
        commandRegistry.registerCommand(
          "list.cursorDown",
          "Cursor Down",
          () =>
            actionQueue.enqueue(() => {
              markKeyboardNav();
              setActiveIndex((i) => Math.min(displayEntriesRef.current.length - 1, i + 1));
            }),
          options,
        ),
      );
      disposables.push(
        commandRegistry.registerKeybinding({
          command: "list.cursorDown",
          key: "down",
          when: whenFocusPanel,
        }),
      );

      disposables.push(
        commandRegistry.registerCommand(
          "list.cursorLeft",
          "Cursor Left (Previous Column)",
          () =>
            actionQueue.enqueue(() => {
              markKeyboardNav();
              setActiveIndex((i) => Math.max(0, i - maxItemsPerColumnRef.current));
            }),
          options,
        ),
      );
      disposables.push(
        commandRegistry.registerKeybinding({
          command: "list.cursorLeft",
          key: "left",
          when: whenFocusPanel,
        }),
      );

      disposables.push(
        commandRegistry.registerCommand(
          "list.cursorRight",
          "Cursor Right (Next Column)",
          () =>
            actionQueue.enqueue(() => {
              markKeyboardNav();
              setActiveIndex((i) => Math.min(displayEntriesRef.current.length - 1, i + maxItemsPerColumnRef.current));
            }),
          options,
        ),
      );
      disposables.push(
        commandRegistry.registerKeybinding({
          command: "list.cursorRight",
          key: "right",
          when: whenFocusPanel,
        }),
      );

      disposables.push(
        commandRegistry.registerCommand(
          "list.cursorHome",
          "Cursor to First",
          () =>
            actionQueue.enqueue(() => {
              markKeyboardNav();
              setActiveIndex(0);
            }),
          options,
        ),
      );
      disposables.push(
        commandRegistry.registerKeybinding({
          command: "list.cursorHome",
          key: "home",
          when: whenFocusPanel,
        }),
      );

      disposables.push(
        commandRegistry.registerCommand(
          "list.cursorEnd",
          "Cursor to Last",
          () =>
            actionQueue.enqueue(() => {
              markKeyboardNav();
              setActiveIndex(displayEntriesRef.current.length - 1);
            }),
          options,
        ),
      );
      disposables.push(
        commandRegistry.registerKeybinding({
          command: "list.cursorEnd",
          key: "end",
          when: whenFocusPanel,
        }),
      );

      disposables.push(
        commandRegistry.registerCommand(
          "list.cursorPageUp",
          "Cursor Page Up",
          () =>
            actionQueue.enqueue(() => {
              markKeyboardNav();
              setActiveIndex((i) => Math.max(0, i - displayedItemsRef.current + 1));
            }),
          options,
        ),
      );
      disposables.push(
        commandRegistry.registerKeybinding({
          command: "list.cursorPageUp",
          key: "pageup",
          when: whenFocusPanel,
        }),
      );

      disposables.push(
        commandRegistry.registerCommand(
          "list.cursorPageDown",
          "Cursor Page Down",
          () =>
            actionQueue.enqueue(() => {
              markKeyboardNav();
              setActiveIndex((i) => Math.min(displayEntriesRef.current.length - 1, i + displayedItemsRef.current - 1));
            }),
          options,
        ),
      );
      disposables.push(
        commandRegistry.registerKeybinding({
          command: "list.cursorPageDown",
          key: "pagedown",
          when: whenFocusPanel,
        }),
      );

      // Selection commands (Shift+Arrow)
      disposables.push(
        commandRegistry.registerCommand(
          "list.selectUp",
          "Select Up",
          () =>
            actionQueue.enqueue(() => {
              markKeyboardNav();
              const cur = activeIndexRef.current;
              const target = Math.max(0, cur - 1);
              applySelection(cur, target, cur === 0 ? "include-active" : "exclude-active");
            }),
          options,
        ),
      );
      disposables.push(
        commandRegistry.registerKeybinding({
          command: "list.selectUp",
          key: "shift+up",
          when: whenFocusPanel,
        }),
      );

      disposables.push(
        commandRegistry.registerCommand(
          "list.selectDown",
          "Select Down",
          () =>
            actionQueue.enqueue(() => {
              markKeyboardNav();
              const cur = activeIndexRef.current;
              const last = displayEntriesRef.current.length - 1;
              const target = Math.min(last, cur + 1);
              applySelection(cur, target, cur === last ? "include-active" : "exclude-active");
            }),
          options,
        ),
      );
      disposables.push(
        commandRegistry.registerKeybinding({
          command: "list.selectDown",
          key: "shift+down",
          when: whenFocusPanel,
        }),
      );

      disposables.push(
        commandRegistry.registerCommand(
          "list.selectLeft",
          "Select Left",
          () =>
            actionQueue.enqueue(() => {
              markKeyboardNav();
              const cur = activeIndexRef.current;
              applySelection(cur, Math.max(0, cur - maxItemsPerColumnRef.current), "include-active");
            }),
          options,
        ),
      );
      disposables.push(
        commandRegistry.registerKeybinding({
          command: "list.selectLeft",
          key: "shift+left",
          when: whenFocusPanel,
        }),
      );

      disposables.push(
        commandRegistry.registerCommand(
          "list.selectRight",
          "Select Right",
          () =>
            actionQueue.enqueue(() => {
              markKeyboardNav();
              const cur = activeIndexRef.current;
              applySelection(cur, Math.min(displayEntriesRef.current.length - 1, cur + maxItemsPerColumnRef.current), "include-active");
            }),
          options,
        ),
      );
      disposables.push(
        commandRegistry.registerKeybinding({
          command: "list.selectRight",
          key: "shift+right",
          when: whenFocusPanel,
        }),
      );

      disposables.push(
        commandRegistry.registerCommand(
          "list.selectHome",
          "Select to First",
          () =>
            actionQueue.enqueue(() => {
              markKeyboardNav();
              applySelection(activeIndexRef.current, 0, "include-active");
            }),
          options,
        ),
      );
      disposables.push(
        commandRegistry.registerKeybinding({
          command: "list.selectHome",
          key: "shift+home",
          when: whenFocusPanel,
        }),
      );

      disposables.push(
        commandRegistry.registerCommand(
          "list.selectEnd",
          "Select to Last",
          () =>
            actionQueue.enqueue(() => {
              markKeyboardNav();
              applySelection(activeIndexRef.current, displayEntriesRef.current.length - 1, "include-active");
            }),
          options,
        ),
      );
      disposables.push(
        commandRegistry.registerKeybinding({
          command: "list.selectEnd",
          key: "shift+end",
          when: whenFocusPanel,
        }),
      );

      disposables.push(
        commandRegistry.registerCommand(
          "list.selectPageUp",
          "Select Page Up",
          () =>
            actionQueue.enqueue(() => {
              markKeyboardNav();
              const cur = activeIndexRef.current;
              applySelection(cur, Math.max(0, cur - displayedItemsRef.current + 1), "include-active");
            }),
          options,
        ),
      );
      disposables.push(
        commandRegistry.registerKeybinding({
          command: "list.selectPageUp",
          key: "shift+pageup",
          when: whenFocusPanel,
        }),
      );

      disposables.push(
        commandRegistry.registerCommand(
          "list.selectPageDown",
          "Select Page Down",
          () =>
            actionQueue.enqueue(() => {
              markKeyboardNav();
              const cur = activeIndexRef.current;
              applySelection(cur, Math.min(displayEntriesRef.current.length - 1, cur + displayedItemsRef.current - 1), "include-active");
            }),
          options,
        ),
      );
      disposables.push(
        commandRegistry.registerKeybinding({
          command: "list.selectPageDown",
          key: "shift+pagedown",
          when: whenFocusPanel,
        }),
      );

      disposables.push(
        commandRegistry.registerCommand(
          "list.execute",
          "Execute in Terminal",
          () =>
            actionQueue.enqueue(async () => {
              const item = displayEntriesRef.current[activeIndexRef.current];
              const write = onExecuteInTerminalRef.current;
              if (!item || item.entry.type !== "file" || !write) return;
              const executable = (item.entry.meta as { executable?: boolean }).executable;
              if (!executable) return;
              const name = item.entry.name;
              const arg = /^[a-zA-Z0-9._+-]+$/.test(name) ? `./${name}` : `./${JSON.stringify(name)}`;
              await write(`${arg}\r`);
            }),
          { category, when: "focusPanel && listItemIsExecutable" },
        ),
      );
      disposables.push(
        commandRegistry.registerKeybinding({
          command: "list.execute",
          key: "enter",
          when: "focusPanel && listItemIsExecutable && !commandLineHasText",
        }),
      );

      disposables.push(
        commandRegistry.registerCommand(
          "list.open",
          "Open",
          () =>
            actionQueue.enqueue(async () => {
              const item = displayEntriesRef.current[activeIndexRef.current];
              if (item) await navigateToEntry(item.entry);
            }),
          options,
        ),
      );
      disposables.push(
        commandRegistry.registerKeybinding({
          command: "list.open",
          key: "enter",
          when: "focusPanel && !listItemIsExecutable && !commandLineHasText",
        }),
      );
      disposables.push(
        commandRegistry.registerKeybinding({
          command: "list.open",
          key: "alt+pagedown",
          when: whenFocusPanel,
        }),
      );

      disposables.push(
        commandRegistry.registerCommand(
          "list.viewFile",
          "View File",
          () =>
            actionQueue.enqueue(() => {
              const item = displayEntriesRef.current[activeIndexRef.current];
              if (item && item.entry.type === "file" && onViewFileRef.current) {
                onViewFileRef.current(item.entry.path as string, item.entry.name, Number(item.entry.meta.size));
              }
            }),
          { category, when: "focusPanel && listItemHasViewer" },
        ),
      );
      disposables.push(
        commandRegistry.registerKeybinding({
          command: "list.viewFile",
          key: "f3",
          when: "focusPanel && listItemHasViewer",
        }),
      );

      disposables.push(
        commandRegistry.registerCommand(
          "list.editFile",
          "Edit File",
          () =>
            actionQueue.enqueue(() => {
              const item = displayEntriesRef.current[activeIndexRef.current];
              if (item && item.entry.type === "file" && onEditFileRef.current) {
                const fileSize = Number(item.entry.meta.size);
                const limit = editorFileSizeLimitRef.current;
                if (limit <= 0 || fileSize <= limit) {
                  const langId = typeof item.entry.lang === "string" && item.entry.lang ? item.entry.lang : "plaintext";
                  onEditFileRef.current(item.entry.path as string, item.entry.name, fileSize, langId);
                }
              }
            }),
          { category, when: "focusPanel && listItemHasEditor" },
        ),
      );
      disposables.push(
        commandRegistry.registerKeybinding({
          command: "list.editFile",
          key: "f4",
          when: "focusPanel && listItemHasEditor",
        }),
      );

      disposables.push(
        commandRegistry.registerCommand(
          "list.moveToTrash",
          "Move to Trash",
          () =>
            actionQueue.enqueue(() => {
              const onTrash = onMoveToTrashRef.current;
              if (!onTrash) return;
              const selected = selectedNamesRef.current;
              const all = displayEntriesRef.current;
              const refresh = () => onNavigateRef.current(currentPathRef.current);

              let sourcePaths: string[];
              if (selected.size > 0) {
                sourcePaths = all.filter((d) => selected.has(d.entry.name)).map((d) => d.entry.path as string);
              } else {
                const item = all[activeIndexRef.current];
                if (!item) return;
                sourcePaths = [item.entry.path as string];
              }
              if (sourcePaths.length === 0) return;
              onTrash(sourcePaths, refresh);
            }),
          options,
        ),
      );
      disposables.push(
        commandRegistry.registerKeybinding({
          command: "list.moveToTrash",
          key: "f8",
          when: whenFocusPanel,
        }),
      );

      disposables.push(
        commandRegistry.registerCommand(
          "list.permanentDelete",
          "Permanently Delete",
          () =>
            actionQueue.enqueue(() => {
              const onDelete = onPermanentDeleteRef.current;
              if (!onDelete) return;
              const selected = selectedNamesRef.current;
              const all = displayEntriesRef.current;
              const refresh = () => onNavigateRef.current(currentPathRef.current);

              let sourcePaths: string[];
              if (selected.size > 0) {
                sourcePaths = all.filter((d) => selected.has(d.entry.name)).map((d) => d.entry.path as string);
              } else {
                const item = all[activeIndexRef.current];
                if (!item) return;
                sourcePaths = [item.entry.path as string];
              }
              if (sourcePaths.length === 0) return;
              onDelete(sourcePaths, refresh);
            }),
          options,
        ),
      );
      disposables.push(
        commandRegistry.registerKeybinding({
          command: "list.permanentDelete",
          key: "shift+delete",
          when: whenFocusPanel,
        }),
      );

      disposables.push(
        commandRegistry.registerCommand(
          "list.copy",
          "Copy",
          () =>
            actionQueue.enqueue(() => {
              const onCopyCb = onCopyRef.current;
              if (!onCopyCb) return;
              const selected = selectedNamesRef.current;
              const all = displayEntriesRef.current;
              const refresh = () => onNavigateRef.current(currentPathRef.current);

              let sourcePaths: string[];
              if (selected.size > 0) {
                // Copy selected items
                sourcePaths = all.filter((d) => selected.has(d.entry.name)).map((d) => d.entry.path as string);
              } else {
                // Copy cursor item
                const item = all[activeIndexRef.current];
                if (!item) return;
                sourcePaths = [item.entry.path as string];
              }
              if (sourcePaths.length === 0) return;
              onCopyCb(sourcePaths, refresh);
            }),
          options,
        ),
      );
      disposables.push(
        commandRegistry.registerKeybinding({
          command: "list.copy",
          key: "f5",
          when: whenFocusPanel,
        }),
      );

      disposables.push(
        commandRegistry.registerCommand(
          "list.move",
          "Move",
          () =>
            actionQueue.enqueue(() => {
              const onMoveCb = onMoveRef.current;
              if (!onMoveCb) return;
              const selected = selectedNamesRef.current;
              const all = displayEntriesRef.current;
              const refresh = () => onNavigateRef.current(currentPathRef.current);

              let sourcePaths: string[];
              if (selected.size > 0) {
                sourcePaths = all.filter((d) => selected.has(d.entry.name)).map((d) => d.entry.path as string);
              } else {
                const item = all[activeIndexRef.current];
                if (!item) return;
                sourcePaths = [item.entry.path as string];
              }
              if (sourcePaths.length === 0) return;
              onMoveCb(sourcePaths, refresh);
            }),
          options,
        ),
      );
      disposables.push(
        commandRegistry.registerKeybinding({
          command: "list.move",
          key: "f6",
          when: whenFocusPanel,
        }),
      );

      disposables.push(
        commandRegistry.registerCommand(
          "list.rename",
          "Rename",
          () =>
            actionQueue.enqueue(() => {
              const onRenameCb = onRenameRef.current;
              if (!onRenameCb) return;
              const item = displayEntriesRef.current[activeIndexRef.current];
              if (!item) return;
              const refresh = () => onNavigateRef.current(currentPathRef.current);
              onRenameCb(item.entry.path as string, item.entry.name, refresh);
            }),
          options,
        ),
      );
      disposables.push(
        commandRegistry.registerKeybinding({
          command: "list.rename",
          key: "shift+f6",
          when: whenFocusPanel,
        }),
      );

      disposables.push(
        commandRegistry.registerCommand(
          "list.pasteFilename",
          "Paste Filename to Command Line",
          () =>
            actionQueue.enqueue(() => {
              const item = displayEntriesRef.current[activeIndexRef.current];
              const paste = onPasteToCommandLineRef.current;
              if (!item || !paste) return;
              const name = item.entry.name;
              const arg = /^[a-zA-Z0-9._+-]+$/.test(name) ? name : JSON.stringify(name);
              paste(arg);
            }),
          options,
        ),
      );
      disposables.push(
        commandRegistry.registerKeybinding({
          command: "list.pasteFilename",
          key: "ctrl+enter",
          when: whenFocusPanel,
        }),
      );

      disposables.push(
        commandRegistry.registerCommand(
          "list.pastePath",
          "Paste Path to Command Line",
          () =>
            actionQueue.enqueue(() => {
              const item = displayEntriesRef.current[activeIndexRef.current];
              const paste = onPasteToCommandLineRef.current;
              if (!item || !paste) return;
              const path = ((item.entry.path as string) ?? "").split("\0")[0];
              const arg = /^[a-zA-Z0-9._+/:-]+$/.test(path) ? path : JSON.stringify(path);
              paste(arg);
            }),
          options,
        ),
      );
      disposables.push(
        commandRegistry.registerKeybinding({
          command: "list.pastePath",
          key: "ctrl+f",
          when: whenFocusPanel,
        }),
      );

      return () => {
        for (const dispose of disposables) dispose();
      };
    }, [active, navigateToEntry, applySelection, onExecuteInTerminal, onPasteToCommandLine, onMoveToTrash, onPermanentDelete, onCopy]);

    const columnCountRef = useRef(columnCount);
    columnCountRef.current = columnCount;

    const handleItemsPerColumnChanged = useCallback((count: number) => {
      setMaxItemsPerColumn(count);
      setTopmostIndex((t) => Math.max(0, Math.min(t, displayEntriesRef.current.length - count * columnCountRef.current)));
    }, []);

    const handleColumnCountChanged = useCallback((count: number) => {
      setColumnCount(count);
    }, []);

    const handlePosChange: ColumnsScrollerProps["onPosChange"] = useCallback((topmost: number, active: number) => {
      const len = displayEntriesRef.current.length;
      setActiveIndex(clamp(active, 0, len - 1));
      setTopmostIndex(clamp(topmost, 0, len - 1));
    }, []);

    const getItemKey = useCallback((index: number) => {
      return displayEntriesRef.current[index]?.entry.name ?? index;
    }, []);

    const lastClickTimeRef = useRef(0);

    const renderItem = useCallback(
      (index: number, isActive: boolean, isSelected: boolean) => {
        const item = displayEntriesRef.current[index];
        if (!item) return null;
        const { entry, style, iconPath, iconFallbackUrl } = item;
        const iconUrl = getIconUrl(iconPath) ?? iconFallbackUrl;

        const isExecutable = entry.type === "file" && !!(entry.meta as { executable?: boolean }).executable;
        return (
          <div
            className={`entry${isActive ? " selected" : ""}${isSelected ? " marked" : ""}`}
            style={{ height: ROW_HEIGHT, opacity: style.opacity }}
            onMouseDown={(e) => {
              e.stopPropagation();
              clearKeyboardNav();
              const now = Date.now();
              if (now - lastClickTimeRef.current < 300) {
                lastClickTimeRef.current = 0;
                if (isExecutable && onExecuteInTerminalRef.current) {
                  const name = entry.name;
                  const arg = /^[a-zA-Z0-9._+-]+$/.test(name) ? `./${name}` : `./${JSON.stringify(name)}`;
                  actionQueue.enqueue(() => onExecuteInTerminalRef.current!(`${arg}\r`));
                } else {
                  actionQueue.enqueue(() => navigateToEntry(entry));
                }
              } else {
                lastClickTimeRef.current = now;
                actionQueue.enqueue(() => setActiveIndex(index));
              }
            }}
          >
            <span className="entry-icon">
              <img src={iconUrl} width={16} height={16} alt="" />
            </span>
            <span
              className="entry-name"
              style={{
                color: style.color,
                fontWeight: style.fontWeight,
                fontStyle: style.fontStyle,
                fontStretch: style.fontStretch,
                fontVariant: style.fontVariant,
                textDecoration: style.textDecoration,
              }}
            >
              {entry.name}
            </span>
            {"size" in entry.meta && entry.type === "file" && <span className="entry-size">{formatSize(entry.meta.size)}</span>}
          </div>
        );
      },
      [navigateToEntry, iconsVersion, clearKeyboardNav],
    );

    const activeEntry = displayEntries[activeIndex];
    const footerName = activeEntry?.entry.name ?? "";
    const footerDate = activeEntry ? formatDate(Number(activeEntry.entry.meta.mtimeMs ?? 0)) : "";
    const footerInfo = (() => {
      if (!activeEntry) return "";
      const entry = activeEntry.entry;
      if (entry.name === "..") return "Up";
      const kind: string = (entry.meta.entryKind as string | undefined) ?? (entry.type === "folder" ? "directory" : "file");
      const nlink: number = (entry.meta.nlink as number | undefined) ?? 1;
      switch (kind) {
        case "directory":
          return nlink > 1 ? `DIR [${nlink}]` : "DIR";
        case "symlink":
          return "";
        case "block_device":
          return "BLK DEV";
        case "char_device":
          return "CHR DEV";
        case "named_pipe":
          return "FIFO";
        case "socket":
          return "SOCK";
        case "whiteout":
          return "WHT";
        case "door":
          return "DOOR";
        case "event_port":
          return "EVT PORT";
        case "unknown":
          return "?";
        default: {
          const s = formatSize(entry.meta.size);
          return nlink > 1 ? `${s} [${nlink}]` : s;
        }
      }
    })();
    const footerLink = (() => {
      if (!activeEntry) return "";
      const kind: string = (activeEntry.entry.meta.entryKind as string | undefined) ?? "";
      if (kind !== "symlink") return "";
      const target = activeEntry.entry.meta.linkTarget as string | undefined;
      return `\u2192 ${target ?? "?"}`;
    })();

    const totalFiles = useMemo(() => displayEntries.filter((d) => d.entry.type === "file").length, [displayEntries]);
    const totalSize = useMemo(
      () =>
        displayEntries.reduce((acc, d) => {
          if (d.entry.type === "file" && typeof d.entry.meta.size === "number") return acc + d.entry.meta.size;
          return acc;
        }, 0),
      [displayEntries],
    );

    const selectionSummary = useMemo(() => {
      if (selectedNames.size === 0) return null;
      let count = 0;
      let size = 0;
      for (const d of displayEntries) {
        if (!selectedNames.has(d.entry.name)) continue;
        count++;
        if (d.entry.type === "file" && typeof d.entry.meta.size === "number") size += d.entry.meta.size;
      }
      return { count, size };
    }, [selectedNames, displayEntries]);

    return (
      <div
        className={`file-list${isTouchscreen || keyboardNavMode ? " no-hover" : ""}`}
        onMouseMoveCapture={clearKeyboardNav}
        onMouseDownCapture={clearKeyboardNav}
      >
        <div className="path-bar">
          <Breadcrumbs currentPath={currentPath} onNavigate={handleBreadcrumbNavigate} />
        </div>
        <div className="file-list-body">
          <ColumnsScroller
            topmostIndex={topmostIndex}
            activeIndex={activeIndex}
            totalCount={displayEntries.length}
            itemHeight={ROW_HEIGHT}
            minColumnWidth={250}
            far
            selectedKeys={selectedNames}
            getItemKey={getItemKey}
            renderItem={renderItem}
            onPosChange={handlePosChange}
            onItemsPerColumnChanged={handleItemsPerColumnChanged}
            onColumnCountChanged={handleColumnCountChanged}
          />
        </div>
        <div className="file-info-footer">
          <span className="file-info-name">{footerName}</span>
          {footerLink && <span className="file-info-link">{footerLink}</span>}
          <span className="file-info-size">{footerInfo}</span>
          <span className="file-info-date">{footerDate}</span>
        </div>
        <div className="panel-summary">
          {selectionSummary
            ? `${selectionSummary.count} selected, ${formatSize(selectionSummary.size)}`
            : `${totalFiles.toLocaleString()} file${totalFiles !== 1 ? "s" : ""}, ${formatSize(totalSize)}`}
        </div>
      </div>
    );
  },
  (prev, next) => {
    // Only compare data props — callbacks are stored in refs inside the component
    return (
      prev.currentPath === next.currentPath &&
      prev.parentNode === next.parentNode &&
      prev.entries === next.entries &&
      prev.active === next.active &&
      prev.resolver === next.resolver &&
      prev.requestedActiveName === next.requestedActiveName &&
      prev.requestedTopmostName === next.requestedTopmostName &&
      prev.editorFileSizeLimit === next.editorFileSizeLimit
    );
  },
);
