import { ActionQueue } from "@/components/FileList/actionQueue";
import type { PanelSide } from "@/entities/panel/model/types";
import type { FileListTabState } from "@/entities/tab/model/types";
import { TERMINAL_EXECUTE, VIEW_FILE } from "@/features/commands/commandIds";
import { useCommandRegistry } from "@/features/commands/commands";
import { useFileStyleResolver } from "@/features/fss/fileStyleResolver";
import { usePanelControllerRegistry } from "@/features/panels/panelControllers";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { cx } from "@/utils/cssModules";
import { dirname, join } from "@/utils/path";
import { useEditorRegistry, useViewerRegistry } from "@/viewerEditorRegistry";
import type { FsNode } from "fss-lang";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Breadcrumbs } from "../Breadcrumbs/Breadcrumbs";
import { ColumnsScroller, type ColumnsScrollerProps } from "./ColumnsScroller";
import { FileInfoFooter } from "./FileInfoFooter";
import styles from "./FileList.module.css";
import { useFileListActionHandlers } from "./fileListActions";
import { FileListEntryRow } from "./FileListEntryRow";
import type { DisplayEntry } from "./types";
import { useFileListCommands } from "./useFileListCommands";
import { clamp, formatSize, getRequestedIndex } from "./utils";

const ROW_HEIGHT = 26;

interface FileListProps {
  side: PanelSide;
  tabId: string;
  state: FileListTabState;
  showHidden: boolean;
  onNavigate: (path: string) => Promise<void>;
  active: boolean;
  onStateChange?: (selectedName: string | undefined, topmostName: string | undefined, selectedNames: string[]) => void;
}

export const FileList = memo(function FileList({ side, tabId, state, showHidden, onNavigate, active, onStateChange }: FileListProps) {
  const commandRegistry = useCommandRegistry();
  const viewerRegistry = useViewerRegistry();
  const editorRegistry = useEditorRegistry();
  const { registerVisibleFileListFocus } = usePanelControllerRegistry();
  const entries = useMemo(() => (showHidden ? state.entries : state.entries.filter((e) => !e.meta.hidden)), [showHidden, state.entries]);

  const [actionQueue] = useState(() => new ActionQueue());
  const rootRef = useRef<HTMLDivElement>(null);
  const [maxItemsPerColumn, setMaxItemsPerColumn] = useState(1);
  const [columnCount, setColumnCount] = useState(1);
  const [keyboardNavMode, setKeyboardNavMode] = useState(false);
  const keyboardNavModeRef = useRef(keyboardNavMode);
  keyboardNavModeRef.current = keyboardNavMode;
  const isTouchscreen = useMediaQuery("(pointer: coarse)");
  /** true = selecting, false = deselecting, undefined = no shift selection in progress */
  const prevSelectRef = useRef<boolean | undefined>(undefined);
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

  const { resolve } = useFileStyleResolver();

  const comparer = useCallback((a: DisplayEntry, b: DisplayEntry) => {
    if (a.presentation.style.groupFirst !== b.presentation.style.groupFirst) return a.presentation.style.groupFirst ? -1 : 1;
    if (a.presentation.style.sortPriority !== b.presentation.style.sortPriority) return b.presentation.style.sortPriority - a.presentation.style.sortPriority;
    return a.entry.name.localeCompare(b.entry.name);
  }, []);

  const toDisplayEntry = useCallback((entry: FsNode): DisplayEntry => ({ entry, presentation: resolve(entry) }), [resolve]);

  const sorted = useMemo(() => {
    const withStyle = entries.map((entry) => toDisplayEntry(entry));
    withStyle.sort(comparer);
    return withStyle;
  }, [entries, comparer, toDisplayEntry]);

  const displayEntries = useMemo(() => {
    const result: DisplayEntry[] = [];
    if (state.entry) {
      const expandedParentNode = { ...state.entry, name: "..", stateFlags: 1 };
      result.push(toDisplayEntry(expandedParentNode));
    }
    for (const item of sorted) result.push(item);
    return result;
  }, [sorted, state.entry, toDisplayEntry]);

  const displayEntriesRef = useRef(displayEntries);
  displayEntriesRef.current = displayEntries;
  const displayEntriesNameSet = useMemo(() => new Set(displayEntries.map((entry) => entry.entry.name)), [displayEntries]);

  const activeIndex = useMemo(() => {
    if (displayEntries.length === 0) return 0;
    if (state.activeEntryName) return getRequestedIndex(displayEntries, state.activeEntryName, comparer);
    return 0;
  }, [comparer, displayEntries, state.activeEntryName]);

  const topmostIndex = useMemo(() => {
    if (displayEntries.length === 0) return 0;
    if (state.topmostEntryName) return getRequestedIndex(displayEntries, state.topmostEntryName, comparer);
    return activeIndex;
  }, [activeIndex, comparer, displayEntries, state.topmostEntryName]);

  const selectedNames = useMemo(() => {
    const nextSelected = state.selectedEntryNames ?? [];
    return new Set(nextSelected.filter((name) => displayEntriesNameSet.has(name)));
  }, [displayEntriesNameSet, state.selectedEntryNames]);
  const selectedNamesRef = useRef(selectedNames);
  selectedNamesRef.current = selectedNames;
  const activeIndexRef = useRef(activeIndex);
  activeIndexRef.current = activeIndex;
  const topmostIndexRef = useRef(topmostIndex);
  topmostIndexRef.current = topmostIndex;

  const onStateChangeRef = useRef(onStateChange);
  onStateChangeRef.current = onStateChange;

  const emitCursorChange = useCallback((nextActiveIndex: number, nextTopmostIndex: number, nextSelectedNames: Iterable<string>) => {
    if (!onStateChangeRef.current) return;
    const entries = displayEntriesRef.current;
    const maxIndex = Math.max(0, entries.length - 1);
    const clampedActiveIndex = clamp(nextActiveIndex, 0, maxIndex);
    const clampedTopmostIndex = clamp(nextTopmostIndex, 0, maxIndex);
    const selectedName = entries[clampedActiveIndex]?.entry.name;
    const topmostName = entries[clampedTopmostIndex]?.entry.name;
    const selectedArray = [...new Set(nextSelectedNames)].filter((name) => entries.some((entry) => entry.entry.name === name));
    onStateChangeRef.current(selectedName, topmostName, selectedArray);
  }, []);

  useEffect(() => {
    if (!onStateChangeRef.current) return;
    const nextActiveName = displayEntries[activeIndex]?.entry.name;
    const nextTopmostName = displayEntries[topmostIndex]?.entry.name;
    const nextSelected = [...selectedNames];
    const sameSelected =
      (state.selectedEntryNames ?? []).length === nextSelected.length && (state.selectedEntryNames ?? []).every((name, idx) => name === nextSelected[idx]);
    if (state.activeEntryName === nextActiveName && state.topmostEntryName === nextTopmostName && sameSelected) {
      return;
    }
    emitCursorChange(activeIndex, topmostIndex, selectedNames);
  }, [activeIndex, topmostIndex, displayEntries, emitCursorChange, selectedNames, state.activeEntryName, state.selectedEntryNames, state.topmostEntryName]);

  // Flush selection when unmounting so the parent keeps the latest cursor state.
  useEffect(() => {
    return () => {
      if (!onStateChangeRef.current) return;
      emitCursorChange(activeIndexRef.current, topmostIndexRef.current, selectedNamesRef.current);
    };
  }, [commandRegistry, emitCursorChange]);

  const handleBreadcrumbNavigate = useCallback((path: string) => {
    void onNavigateRef.current(path);
  }, []);

  // Selection helpers
  type SelectionType = "include-active" | "exclude-active";

  const applySelection = useCallback(
    (oldIndex: number, newIndex: number, selectType: SelectionType, nextTopmostIndex?: number) => {
      const entries = displayEntriesRef.current;
      if (prevSelectRef.current === undefined) {
        const currentName = entries[oldIndex]?.entry.name;
        prevSelectRef.current = currentName ? !selectedNamesRef.current.has(currentName) : true;
      }
      const selecting = prevSelectRef.current;
      const lo = Math.min(oldIndex, newIndex);
      const hi = Math.max(oldIndex, newIndex);

      const next = new Set(selectedNamesRef.current);
      for (let i = lo; i <= hi; i++) {
        if (selectType === "exclude-active" && i === newIndex) continue;
        const name = entries[i]?.entry.name;
        if (!name) continue;
        if (selecting) next.add(name);
        else next.delete(name);
      }

      emitCursorChange(clamp(newIndex, 0, entries.length - 1), nextTopmostIndex ?? topmostIndexRef.current, next);
    },
    [emitCursorChange],
  );

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

  useEffect(() => {
    prevSelectRef.current = undefined;
  }, [state.path]);

  const navigateToEntry = useCallback(
    async (entry: FsNode): Promise<void> => {
      if (entry.name === "..") {
        await onNavigateRef.current(dirname(currentPathRef.current));
      } else if (entry.type === "folder") {
        await onNavigateRef.current(join(currentPathRef.current, entry.name));
      } else if (entry.type === "file") {
        void commandRegistry.executeCommand(VIEW_FILE, entry.path as string, entry.name, Number(entry.meta.size));
      }
    },
    [commandRegistry],
  );

  const displayedItems = Math.min(displayEntries.length, maxItemsPerColumn * columnCount);
  const maxItemsPerColumnRef = useRef(maxItemsPerColumn);
  maxItemsPerColumnRef.current = maxItemsPerColumn;
  const displayedItemsRef = useRef(displayedItems);
  displayedItemsRef.current = displayedItems;

  // Update context when selection changes or registries update
  const updateSelectionContext = useCallback(() => {
    const item = displayEntriesRef.current[activeIndexRef.current];
    const isFile = item?.entry.type === "file";
    const isExecutable = isFile && item != null && !!(item.entry.meta as { executable?: boolean }).executable;
    const fileName = item?.entry.name ?? "";
    commandRegistry.beginBatch();
    commandRegistry.setContext("listItemIsFile", isFile);
    commandRegistry.setContext("listItemIsDir", !isFile && item != null);
    commandRegistry.setContext("listItemIsExecutable", isExecutable);
    commandRegistry.setContext("listItemHasViewer", isFile && viewerRegistry.resolve(fileName) !== null);
    commandRegistry.setContext("listItemHasEditor", isFile && editorRegistry.resolve(fileName) !== null);
    commandRegistry.endBatch();
  }, [commandRegistry, editorRegistry, viewerRegistry]);

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
  }, [active, editorRegistry, updateSelectionContext, viewerRegistry]);

  const fileActions = useFileListActionHandlers({
    actionQueue,
    getDisplayEntries: () => displayEntriesRef.current,
    getActiveIndex: () => activeIndexRef.current,
    getSelectedNames: () => selectedNamesRef.current,
    navigateToEntry,
    refresh: () => onNavigateRef.current(currentPathRef.current),
  });

  const updateCursor = useCallback(
    (updater: (current: { activeIndex: number; topmostIndex: number }) => { activeIndex: number; topmostIndex: number }) => {
      const next = updater({
        activeIndex: activeIndexRef.current,
        topmostIndex: topmostIndexRef.current,
      });
      emitCursorChange(next.activeIndex, next.topmostIndex, selectedNamesRef.current);
    },
    [emitCursorChange],
  );

  useFileListCommands({
    active,
    containerRef: rootRef,
    actionQueue,
    fileActions,
    markKeyboardNav,
    applySelection,
    updateCursor,
    activeIndexRef,
    topmostIndexRef,
    maxItemsPerColumnRef,
    displayedItemsRef,
    displayEntriesRef,
    currentPathRef,
    navigateTo: onNavigate,
  });

  useEffect(() => {
    return registerVisibleFileListFocus(side, tabId, () => {
      rootRef.current?.focus({ preventScroll: true });
    });
  }, [registerVisibleFileListFocus, side, tabId]);

  const handleItemsPerColumnChanged = useCallback((count: number) => {
    setMaxItemsPerColumn(count);
  }, []);

  const handleColumnCountChanged = useCallback((count: number) => {
    setColumnCount(count);
  }, []);

  const handlePosChange: ColumnsScrollerProps["onPosChange"] = useCallback(
    (topmost: number, active: number) => {
      const len = displayEntriesRef.current.length;
      emitCursorChange(clamp(active, 0, len - 1), clamp(topmost, 0, len - 1), selectedNamesRef.current);
    },
    [emitCursorChange],
  );

  const getItemKey = useCallback((index: number) => {
    return displayEntriesRef.current[index]?.entry.name ?? index;
  }, []);

  const lastClickTimeRef = useRef(0);
  const handleItemPointerDown = useCallback(
    (index: number) => {
      const item = displayEntriesRef.current[index];
      if (!item) return;
      const { entry } = item;
      const executable = entry.type === "file" && !!(entry.meta as { executable?: boolean }).executable;

      clearKeyboardNav();
      const now = Date.now();
      if (now - lastClickTimeRef.current < 300) {
        lastClickTimeRef.current = 0;
        if (executable) {
          actionQueue.enqueue(() => commandRegistry.executeCommand(TERMINAL_EXECUTE, entry.path as string));
        } else {
          actionQueue.enqueue(() => navigateToEntry(entry));
        }
        return;
      }

      lastClickTimeRef.current = now;
      actionQueue.enqueue(() => emitCursorChange(index, topmostIndexRef.current, selectedNamesRef.current));
    },
    [actionQueue, clearKeyboardNav, commandRegistry, emitCursorChange, navigateToEntry],
  );

  const renderItem = useCallback(
    (index: number, isActive: boolean, isSelected: boolean) => {
      const item = displayEntries[index];
      if (!item) return null;

      return (
        <FileListEntryRow item={item} rowHeight={ROW_HEIGHT} active={isActive} selected={isSelected} onPointerDown={() => handleItemPointerDown(index)} />
      );
    },
    [displayEntries, handleItemPointerDown],
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
      tabIndex={-1}
      className={cx(styles, "file-list", isTouchscreen || keyboardNavMode ? "no-hover" : null, active ? "active-panel" : "inactive-panel")}
      onMouseMoveCapture={clearKeyboardNav}
      onWheelCapture={markKeyboardNav}
      onPointerDownCapture={() => {
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
