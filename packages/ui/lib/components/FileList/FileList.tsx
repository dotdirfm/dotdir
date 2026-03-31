import { ActionQueue } from "@/actionQueue";
import type { PanelSide } from "@/entities/panel/model/types";
import { FileListTabState } from "@/entities/tab/model/types";
import { useCommandRegistry } from "@/features/commands/commands";
import { useGetCachedIcon, useIconThemeVersion, useLoadIconsForPaths, useResolveIcon } from "@/features/file-icons/iconResolver";
import { setActiveFileListHandlers, setFileListHandlers } from "@/fileListHandlers";
import { resolveEntryStyle } from "@/fss";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import type { ResolvedEntryStyle } from "@/types";
import { binarySearch } from "@/utils/binarySearch";
import { cx } from "@/utils/cssModules";
import { dirname, join } from "@/utils/path";
import { editorRegistry, viewerRegistry } from "@/viewerEditorRegistry";
import type { LayeredResolver } from "fss-lang";
import { FsNode } from "fss-lang";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Breadcrumbs } from "./Breadcrumbs";
import { ColumnsScroller, type ColumnsScrollerProps } from "./ColumnsScroller";
import { FileInfoFooter } from "./FileInfoFooter";
import styles from "./FileList.module.css";
import { useFileListActionHandlers } from "./fileListActions";

const ROW_HEIGHT = 26;

interface FileListProps {
  side: PanelSide;
  state: FileListTabState;
  showHidden: boolean;
  onNavigate: (path: string) => Promise<void>;
  active: boolean;
  resolver: LayeredResolver;
  requestedActiveName?: string;
  requestedTopmostName?: string;
  onStateChange?: (selectedName: string | undefined, topmostName: string | undefined, selectedNames: string[]) => void;
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

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function sameNameSet(set: ReadonlySet<string>, arr: readonly string[]): boolean {
  if (set.size !== arr.length) return false;
  for (const value of arr) {
    if (!set.has(value)) return false;
  }
  return true;
}

function getRequestedIndex(entries: DisplayEntry[], requestedName: string, comparer: (a: DisplayEntry, b: DisplayEntry) => number): number {
  const exact = entries.findIndex((item) => item.entry.name === requestedName);
  if (exact >= 0) return exact;
  const requested = {
    entry: { name: requestedName },
    style: { groupFirst: false, sortPriority: 0 },
  } as DisplayEntry;
  let idx = binarySearch(entries, requested, comparer);
  if (idx < 0) idx = ~idx;
  return clamp(idx, 0, Math.max(0, entries.length - 1));
}

export const FileList = memo(function FileList({
  side,
  state,
  showHidden,
  onNavigate,
  active,
  resolver,
  requestedActiveName,
  requestedTopmostName,
  onStateChange,
}: FileListProps) {
  const commandRegistry = useCommandRegistry();
  const entries = useMemo(() => (showHidden ? state.entries : state.entries.filter((e) => !e.meta.hidden)), [showHidden, state.entries]);

  const [actionQueue] = useState(() => new ActionQueue());
  const rootRef = useRef<HTMLDivElement>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [topmostIndex, setTopmostIndex] = useState(0);
  const [maxItemsPerColumn, setMaxItemsPerColumn] = useState(1);
  const [columnCount, setColumnCount] = useState(1);
  const [iconsVersion, setIconsVersion] = useState(0);
  const [selectedNames, setSelectedNames] = useState<ReadonlySet<string>>(new Set(state.selectedEntryNames ?? []));
  const [keyboardNavMode, setKeyboardNavMode] = useState(false);
  const keyboardNavModeRef = useRef(keyboardNavMode);
  keyboardNavModeRef.current = keyboardNavMode;
  const isTouchscreen = useMediaQuery("(pointer: coarse)");
  const selectedNamesRef = useRef(selectedNames);
  selectedNamesRef.current = selectedNames;
  /** true = selecting, false = deselecting, undefined = no shift selection in progress */
  const prevSelectRef = useRef<boolean | undefined>(undefined);
  const prevPathRef = useRef(state.path);
  const activeIndexRef = useRef(activeIndex);
  activeIndexRef.current = activeIndex;
  const topmostIndexRef = useRef(topmostIndex);
  topmostIndexRef.current = topmostIndex;
  const currentPathRef = useRef(state.path);
  currentPathRef.current = state.path;
  const onNavigateRef = useRef(onNavigate);
  onNavigateRef.current = onNavigate;

  const markKeyboardNav = useCallback(() => {
    if (!keyboardNavModeRef.current) setKeyboardNavMode(true);
  }, []);
  const clearKeyboardNav = useCallback(() => {
    if (keyboardNavModeRef.current) setKeyboardNavMode(false);
  }, []);

  const getCachedIcon = useGetCachedIcon();

  const getIconUrl = useCallback(
    (iconPath: string | null): string | undefined => {
      if (iconPath) {
        return getCachedIcon(iconPath) ?? undefined;
      }
      return undefined;
    },
    [getCachedIcon],
  );

  const resolveIcon = useResolveIcon();

  const comparer = useCallback((a: DisplayEntry, b: DisplayEntry) => {
    if (a.style.groupFirst !== b.style.groupFirst) return a.style.groupFirst ? -1 : 1;
    if (a.style.sortPriority !== b.style.sortPriority) return b.style.sortPriority - a.style.sortPriority;
    return a.entry.name.localeCompare(b.entry.name);
  }, []);

  const toDisplayEntry = useCallback(
    (entry: FsNode): DisplayEntry => {
      const style = resolveEntryStyle(resolver, entry);
      const isDir = entry.type === "folder";
      const resolved = resolveIcon(entry.name, isDir, false, false, entry.lang, style.icon);
      return {
        entry,
        style,
        iconPath: resolved.path,
        iconFallbackUrl: resolved.fallbackUrl,
      };
    },
    [resolver, resolveEntryStyle, resolveIcon],
  );

  const sorted = useMemo(() => {
    const withStyle: DisplayEntry[] = entries.map((entry) => toDisplayEntry(entry));
    withStyle.sort(comparer);
    return withStyle;
  }, [entries, state.path, toDisplayEntry]);

  const displayEntries: DisplayEntry[] = useMemo(() => {
    const result: DisplayEntry[] = [];
    if (state.entry) {
      const expandedParentNode = { ...state.entry, name: "..", stateFlags: 1 };
      result.push(toDisplayEntry(expandedParentNode));
    }
    for (const item of sorted) result.push(item);
    return result;
  }, [sorted, state.entry]);

  const displayEntriesRef = useRef(displayEntries);
  displayEntriesRef.current = displayEntries;

  const neededIcons = useMemo(() => {
    const paths = new Set<string>();
    for (const { iconPath } of displayEntries) {
      if (iconPath) paths.add(iconPath);
    }
    return [...paths];
  }, [displayEntries]);
  const neededIconsKey = useMemo(() => neededIcons.join("\0"), [neededIcons]);

  const loadIconsForPaths = useLoadIconsForPaths();
  const iconThemeVersion = useIconThemeVersion();

  useEffect(() => {
    let cancelled = false;
    loadIconsForPaths(neededIcons).then(() => {
      if (!cancelled) setIconsVersion((n) => n + 1);
    });
    return () => {
      cancelled = true;
    };
  }, [loadIconsForPaths, neededIcons, neededIconsKey]);

  useEffect(() => {
    const prevPath = prevPathRef.current;
    prevPathRef.current = state.path;

    if (prevPath === state.path) {
      setActiveIndex((i) => Math.min(i, displayEntries.length - 1));
      return;
    }

    if (state.activeEntryName) {
      const idx = displayEntries.findIndex((d) => d.entry.name === state.activeEntryName);
      if (idx >= 0) {
        setActiveIndex(idx);
        const topmostIdx = state.topmostEntryName
          ? displayEntries.findIndex((d) => d.entry.name === state.topmostEntryName)
          : -1;
        setTopmostIndex(topmostIdx >= 0 ? topmostIdx : Math.max(0, idx - 5));
        return;
      }
    }

    setActiveIndex(0);
    setTopmostIndex(0);
  }, [state.path, displayEntries]);

  useEffect(() => {
    if (!requestedActiveName) return;
    const entries = displayEntriesRef.current;
    const idx = getRequestedIndex(entries, requestedActiveName, comparer);
    setActiveIndex(idx);
  }, [requestedActiveName, comparer]);

  useEffect(() => {
    if (!requestedTopmostName) return;
    const entries = displayEntriesRef.current;
    const idx = getRequestedIndex(entries, requestedTopmostName, comparer);
    setTopmostIndex(idx);
  }, [requestedTopmostName, comparer]);

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
      onStateChangeRef.current?.(selectedName, topmostName, [...selectedNamesRef.current]);
    }, 150);
  }, [activeIndex, topmostIndex, displayEntries]);

  // Flush selection when unmounting (e.g. tab switch) so debounced callback cannot drop it
  useEffect(() => {
    return () => {
      clearTimeout(stateChangeTimerRef.current);
      if (!onStateChangeRef.current) return;
      const selectedName = displayEntriesRef.current[activeIndexRef.current]?.entry.name;
      const topmostName = displayEntriesRef.current[topmostIndexRef.current]?.entry.name;
      onStateChangeRef.current(selectedName, topmostName, [...selectedNamesRef.current]);
    };
  }, []);

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
  }, [state.path]);

  useEffect(() => {
    const nextSelected = state.selectedEntryNames ?? [];
    setSelectedNames((prev) => (sameNameSet(prev, nextSelected) ? prev : new Set(nextSelected)));
  }, [state.selectedEntryNames]);

  const navigateToEntry = useCallback(async (entry: FsNode): Promise<void> => {
    if (entry.name === "..") {
      await onNavigateRef.current(dirname(currentPathRef.current));
    } else if (entry.type === "folder") {
      await onNavigateRef.current(join(currentPathRef.current, entry.name));
    } else if (entry.type === "file") {
      void commandRegistry.executeCommand("viewFile", entry.path as string, entry.name, Number(entry.meta.size));
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

  const fileActions = useFileListActionHandlers({
    actionQueue,
    getDisplayEntries: () => displayEntriesRef.current,
    getActiveIndex: () => activeIndexRef.current,
    getSelectedNames: () => selectedNamesRef.current,
    navigateToEntry,
    refresh: () => onNavigateRef.current(currentPathRef.current),
  });

  // Publish handlers to the module-level registry when this panel is active.
  // Commands are registered once in useBuiltInCommands and read from here at call time.
  useEffect(() => {
    const handlers = {
      focus: () => {
        rootRef.current?.focus({ preventScroll: true });
      },
      cursorUp: () =>
        actionQueue.enqueue(() => {
          markKeyboardNav();
          setActiveIndex((i) => Math.max(0, i - 1));
        }),
      cursorDown: () =>
        actionQueue.enqueue(() => {
          markKeyboardNav();
          setActiveIndex((i) => Math.min(displayEntriesRef.current.length - 1, i + 1));
        }),
      cursorLeft: () =>
        actionQueue.enqueue(() => {
          markKeyboardNav();
          setActiveIndex((i) => Math.max(0, i - maxItemsPerColumnRef.current));
        }),
      cursorRight: () =>
        actionQueue.enqueue(() => {
          markKeyboardNav();
          setActiveIndex((i) => Math.min(displayEntriesRef.current.length - 1, i + maxItemsPerColumnRef.current));
        }),
      cursorHome: () =>
        actionQueue.enqueue(() => {
          markKeyboardNav();
          setActiveIndex(0);
        }),
      cursorEnd: () =>
        actionQueue.enqueue(() => {
          markKeyboardNav();
          setActiveIndex(displayEntriesRef.current.length - 1);
        }),
      cursorPageUp: () =>
        actionQueue.enqueue(() => {
          markKeyboardNav();
          setActiveIndex((i) => Math.max(0, i - displayedItemsRef.current + 1));
        }),
      cursorPageDown: () =>
        actionQueue.enqueue(() => {
          markKeyboardNav();
          setActiveIndex((i) => Math.min(displayEntriesRef.current.length - 1, i + displayedItemsRef.current - 1));
        }),
      selectUp: () =>
        actionQueue.enqueue(() => {
          markKeyboardNav();
          const cur = activeIndexRef.current;
          const target = Math.max(0, cur - 1);
          applySelection(cur, target, cur === 0 ? "include-active" : "exclude-active");
        }),
      selectDown: () =>
        actionQueue.enqueue(() => {
          markKeyboardNav();
          const cur = activeIndexRef.current;
          const last = displayEntriesRef.current.length - 1;
          const target = Math.min(last, cur + 1);
          applySelection(cur, target, cur === last ? "include-active" : "exclude-active");
        }),
      selectLeft: () =>
        actionQueue.enqueue(() => {
          markKeyboardNav();
          const cur = activeIndexRef.current;
          applySelection(cur, Math.max(0, cur - maxItemsPerColumnRef.current), "include-active");
        }),
      selectRight: () =>
        actionQueue.enqueue(() => {
          markKeyboardNav();
          const cur = activeIndexRef.current;
          applySelection(cur, Math.min(displayEntriesRef.current.length - 1, cur + maxItemsPerColumnRef.current), "include-active");
        }),
      selectHome: () =>
        actionQueue.enqueue(() => {
          markKeyboardNav();
          applySelection(activeIndexRef.current, 0, "include-active");
        }),
      selectEnd: () =>
        actionQueue.enqueue(() => {
          markKeyboardNav();
          applySelection(activeIndexRef.current, displayEntriesRef.current.length - 1, "include-active");
        }),
      selectPageUp: () =>
        actionQueue.enqueue(() => {
          markKeyboardNav();
          const cur = activeIndexRef.current;
          applySelection(cur, Math.max(0, cur - displayedItemsRef.current + 1), "include-active");
        }),
      selectPageDown: () =>
        actionQueue.enqueue(() => {
          markKeyboardNav();
          const cur = activeIndexRef.current;
          applySelection(cur, Math.min(displayEntriesRef.current.length - 1, cur + displayedItemsRef.current - 1), "include-active");
        }),
      ...fileActions,
    };
    if (active) {
      setFileListHandlers(side, handlers);
      setActiveFileListHandlers(handlers);
    }
    return () => {
      if (active) {
        setFileListHandlers(side, null);
        setActiveFileListHandlers(null);
      }
    };
  }, [active, side, markKeyboardNav, navigateToEntry, applySelection]);

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
          className={cx(styles, "entry", isActive && "selected", isSelected && "marked")}
          style={{ height: ROW_HEIGHT, opacity: style.opacity }}
          onMouseDown={(e) => {
            e.stopPropagation();
            clearKeyboardNav();
            const now = Date.now();
            if (now - lastClickTimeRef.current < 300) {
              lastClickTimeRef.current = 0;
              if (isExecutable) {
                actionQueue.enqueue(() => commandRegistry.executeCommand("terminal.execute", entry.path as string));
              } else {
                actionQueue.enqueue(() => navigateToEntry(entry));
              }
            } else {
              lastClickTimeRef.current = now;
              actionQueue.enqueue(() => setActiveIndex(index));
            }
          }}
        >
          <span className={styles["entry-icon"]}>
            <img src={iconUrl} width={16} height={16} alt="" />
          </span>
          <span
            className={styles["entry-name"]}
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
          {"size" in entry.meta && entry.type === "file" && <span className={styles["entry-size"]}>{formatSize(entry.meta.size)}</span>}
        </div>
      );
    },
    [navigateToEntry, iconsVersion, iconThemeVersion, clearKeyboardNav],
  );

  const activeEntry = displayEntries[activeIndex];

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
      ref={rootRef}
      className={cx(styles, "file-list", isTouchscreen || keyboardNavMode ? "no-hover" : null, active ? "active-panel" : "inactive-panel")}
      onMouseMoveCapture={clearKeyboardNav}
      onWheelCapture={markKeyboardNav}
      onMouseDownCapture={() => {
        clearKeyboardNav();
        rootRef.current?.focus({ preventScroll: true });
      }}
    >
      <div className={styles["path-bar"]}>
        <Breadcrumbs currentPath={state.path} onNavigate={handleBreadcrumbNavigate} />
      </div>
      <div className={styles["file-list-body"]}>
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
      <FileInfoFooter entry={activeEntry?.entry} />
      <div className={styles["panel-summary"]}>
        {selectionSummary
          ? `${selectionSummary.count} selected, ${formatSize(selectionSummary.size)}`
          : `${totalFiles.toLocaleString()} file${totalFiles !== 1 ? "s" : ""}, ${formatSize(totalSize)}`}
      </div>
    </div>
  );
});
