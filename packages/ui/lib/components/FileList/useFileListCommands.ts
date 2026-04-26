import type { ActionQueue } from "@/components/FileList/actionQueue";
import { useBridge } from "@/features/bridge/useBridge";
import { useCommandRegistry } from "@dotdirfm/commands";
import {
  CURSOR_DOWN,
  CURSOR_END,
  CURSOR_HOME,
  CURSOR_LEFT,
  CURSOR_PAGE_DOWN,
  CURSOR_PAGE_UP,
  CURSOR_RIGHT,
  CURSOR_UP,
  FILELIST_GO_HOME,
  FILELIST_GO_TO_PARENT,
  FILELIST_REFRESH,
  LIST_COPY,
  LIST_EDIT_FILE,
  LIST_EXECUTE,
  LIST_MOVE,
  LIST_MOVE_TO_TRASH,
  LIST_OPEN,
  LIST_PERMANENT_DELETE,
  LIST_RENAME,
  LIST_VIEW_FILE,
  PASTE_FILENAME,
  PASTE_PATH,
  SELECT_DOWN,
  SELECT_END,
  SELECT_HOME,
  SELECT_LEFT,
  SELECT_PAGE_DOWN,
  SELECT_PAGE_UP,
  SELECT_RIGHT,
  SELECT_UP,
} from "@dotdirfm/commands";
import { isContainerPath, parseContainerPath } from "@/utils/containerPath";
import { dirname } from "@/utils/path";
import { useEffect, useMemo, useRef, type RefObject } from "react";
import type { UseFileListActionHandlersReturn } from "./fileListActions";

interface UseFileListCommandsArgs {
  active: boolean;
  actionQueue: ActionQueue;
  fileActions: UseFileListActionHandlersReturn;
  markKeyboardNav: () => void;
  applySelection: (oldIndex: number, newIndex: number, selectType: "include-active" | "exclude-active", topmostIndex?: number) => void;
  updateCursor: (updater: (current: { activeIndex: number; topmostIndex: number }) => { activeIndex: number; topmostIndex: number }) => void;
  activeIndexRef: RefObject<number>;
  topmostIndexRef: RefObject<number>;
  maxItemsPerColumnRef: RefObject<number>;
  displayedItemsRef: RefObject<number>;
  displayEntriesRef: RefObject<Array<{ entry: { name: string } }>>;
  currentPathRef: RefObject<string>;
  navigateTo: (path: string) => Promise<void>;
}

type CommandHandler = (...args: unknown[]) => void;

const COMMAND_KEYS = {
  cursorUp: CURSOR_UP,
  cursorDown: CURSOR_DOWN,
  cursorLeft: CURSOR_LEFT,
  cursorRight: CURSOR_RIGHT,
  cursorHome: CURSOR_HOME,
  cursorEnd: CURSOR_END,
  cursorPageUp: CURSOR_PAGE_UP,
  cursorPageDown: CURSOR_PAGE_DOWN,
  selectUp: SELECT_UP,
  selectDown: SELECT_DOWN,
  selectLeft: SELECT_LEFT,
  selectRight: SELECT_RIGHT,
  selectHome: SELECT_HOME,
  selectEnd: SELECT_END,
  selectPageUp: SELECT_PAGE_UP,
  selectPageDown: SELECT_PAGE_DOWN,
  goToParent: FILELIST_GO_TO_PARENT,
  goHome: FILELIST_GO_HOME,
  refresh: FILELIST_REFRESH,
  execute: LIST_EXECUTE,
  open: LIST_OPEN,
  viewFile: LIST_VIEW_FILE,
  editFile: LIST_EDIT_FILE,
  moveToTrash: LIST_MOVE_TO_TRASH,
  permanentDelete: LIST_PERMANENT_DELETE,
  copy: LIST_COPY,
  move: LIST_MOVE,
  rename: LIST_RENAME,
  pasteFilename: PASTE_FILENAME,
  pastePath: PASTE_PATH,
} as const;

export function useFileListCommands({
  active,
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
  navigateTo,
}: UseFileListCommandsArgs): void {
  const bridge = useBridge();
  const commandRegistry = useCommandRegistry();
  const argsRef = useRef({
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
    navigateTo,
  });
  argsRef.current = {
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
    navigateTo,
  };

  const handlers = useMemo<Record<string, CommandHandler>>(
    () => ({
      [COMMAND_KEYS.cursorUp]: () =>
        actionQueue.enqueue(() => {
          argsRef.current.markKeyboardNav();
          argsRef.current.updateCursor(({ activeIndex, topmostIndex }) => ({
            activeIndex: Math.max(0, activeIndex - 1),
            topmostIndex,
          }));
        }),
      [COMMAND_KEYS.cursorDown]: () =>
        actionQueue.enqueue(() => {
          argsRef.current.markKeyboardNav();
          argsRef.current.updateCursor(({ activeIndex, topmostIndex }) => ({
            activeIndex: Math.min(argsRef.current.displayEntriesRef.current.length - 1, activeIndex + 1),
            topmostIndex,
          }));
        }),
      [COMMAND_KEYS.cursorLeft]: () =>
        actionQueue.enqueue(() => {
          argsRef.current.markKeyboardNav();
          const step = argsRef.current.maxItemsPerColumnRef.current;
          const current = argsRef.current.activeIndexRef.current;
          const next = Math.max(0, current - step);
          const totalVisible = argsRef.current.displayedItemsRef.current;
          const firstVisible = argsRef.current.topmostIndexRef.current;
          let nextTopmost = firstVisible;
          if (current < firstVisible + step) {
            const maxTopmost = Math.max(0, argsRef.current.displayEntriesRef.current.length - totalVisible);
            nextTopmost = Math.max(0, Math.min(maxTopmost, firstVisible - step));
          }
          argsRef.current.updateCursor(() => ({
            activeIndex: next,
            topmostIndex: nextTopmost,
          }));
        }),
      [COMMAND_KEYS.cursorRight]: () =>
        actionQueue.enqueue(() => {
          argsRef.current.markKeyboardNav();
          const step = argsRef.current.maxItemsPerColumnRef.current;
          const current = argsRef.current.activeIndexRef.current;
          const next = Math.min(argsRef.current.displayEntriesRef.current.length - 1, current + step);
          const totalVisible = argsRef.current.displayedItemsRef.current;
          const firstVisible = argsRef.current.topmostIndexRef.current;
          let nextTopmost = firstVisible;
          if (current >= firstVisible + totalVisible - step) {
            const maxTopmost = Math.max(0, argsRef.current.displayEntriesRef.current.length - totalVisible);
            nextTopmost = Math.max(0, Math.min(maxTopmost, firstVisible + step));
          }
          argsRef.current.updateCursor(() => ({
            activeIndex: next,
            topmostIndex: nextTopmost,
          }));
        }),
      [COMMAND_KEYS.cursorHome]: () =>
        actionQueue.enqueue(() => {
          argsRef.current.markKeyboardNav();
          argsRef.current.updateCursor(({ topmostIndex }) => ({ activeIndex: 0, topmostIndex }));
        }),
      [COMMAND_KEYS.cursorEnd]: () =>
        actionQueue.enqueue(() => {
          argsRef.current.markKeyboardNav();
          argsRef.current.updateCursor(({ topmostIndex }) => ({
            activeIndex: argsRef.current.displayEntriesRef.current.length - 1,
            topmostIndex,
          }));
        }),
      [COMMAND_KEYS.cursorPageUp]: () =>
        actionQueue.enqueue(() => {
          argsRef.current.markKeyboardNav();
          argsRef.current.updateCursor(({ activeIndex, topmostIndex }) => ({
            activeIndex: Math.max(0, activeIndex - argsRef.current.displayedItemsRef.current + 1),
            topmostIndex,
          }));
        }),
      [COMMAND_KEYS.cursorPageDown]: () =>
        actionQueue.enqueue(() => {
          argsRef.current.markKeyboardNav();
          argsRef.current.updateCursor(({ activeIndex, topmostIndex }) => ({
            activeIndex: Math.min(
              argsRef.current.displayEntriesRef.current.length - 1,
              activeIndex + argsRef.current.displayedItemsRef.current - 1,
            ),
            topmostIndex,
          }));
        }),
      [COMMAND_KEYS.selectUp]: () =>
        actionQueue.enqueue(() => {
          argsRef.current.markKeyboardNav();
          const cur = argsRef.current.activeIndexRef.current;
          const target = Math.max(0, cur - 1);
          argsRef.current.applySelection(cur, target, target === cur ? "include-active" : "exclude-active");
        }),
      [COMMAND_KEYS.selectDown]: () =>
        actionQueue.enqueue(() => {
          argsRef.current.markKeyboardNav();
          const cur = argsRef.current.activeIndexRef.current;
          const target = Math.min(argsRef.current.displayEntriesRef.current.length - 1, cur + 1);
          argsRef.current.applySelection(cur, target, target === cur ? "include-active" : "exclude-active");
        }),
      [COMMAND_KEYS.selectLeft]: () =>
        actionQueue.enqueue(() => {
          argsRef.current.markKeyboardNav();
          const cur = argsRef.current.activeIndexRef.current;
          const step = argsRef.current.maxItemsPerColumnRef.current;
          const target = Math.max(0, cur - step);
          const totalVisible = argsRef.current.displayedItemsRef.current;
          const firstVisible = argsRef.current.topmostIndexRef.current;
          let nextTopmost = firstVisible;
          if (cur < firstVisible + step) {
            const maxTopmost = Math.max(0, argsRef.current.displayEntriesRef.current.length - totalVisible);
            nextTopmost = Math.max(0, Math.min(maxTopmost, firstVisible - step));
          }
          argsRef.current.applySelection(cur, target, "include-active", nextTopmost);
        }),
      [COMMAND_KEYS.selectRight]: () =>
        actionQueue.enqueue(() => {
          argsRef.current.markKeyboardNav();
          const cur = argsRef.current.activeIndexRef.current;
          const step = argsRef.current.maxItemsPerColumnRef.current;
          const target = Math.min(argsRef.current.displayEntriesRef.current.length - 1, cur + step);
          const totalVisible = argsRef.current.displayedItemsRef.current;
          const firstVisible = argsRef.current.topmostIndexRef.current;
          let nextTopmost = firstVisible;
          if (cur >= firstVisible + totalVisible - step) {
            const maxTopmost = Math.max(0, argsRef.current.displayEntriesRef.current.length - totalVisible);
            nextTopmost = Math.max(0, Math.min(maxTopmost, firstVisible + step));
          }
          argsRef.current.applySelection(
            cur,
            target,
            "include-active",
            nextTopmost,
          );
        }),
      [COMMAND_KEYS.selectHome]: () =>
        actionQueue.enqueue(() => {
          argsRef.current.markKeyboardNav();
          argsRef.current.applySelection(argsRef.current.activeIndexRef.current, 0, "include-active");
        }),
      [COMMAND_KEYS.selectEnd]: () =>
        actionQueue.enqueue(() => {
          argsRef.current.markKeyboardNav();
          argsRef.current.applySelection(
            argsRef.current.activeIndexRef.current,
            argsRef.current.displayEntriesRef.current.length - 1,
            "include-active",
          );
        }),
      [COMMAND_KEYS.selectPageUp]: () =>
        actionQueue.enqueue(() => {
          argsRef.current.markKeyboardNav();
          const cur = argsRef.current.activeIndexRef.current;
          argsRef.current.applySelection(cur, Math.max(0, cur - argsRef.current.displayedItemsRef.current + 1), "include-active");
        }),
      [COMMAND_KEYS.selectPageDown]: () =>
        actionQueue.enqueue(() => {
          argsRef.current.markKeyboardNav();
          const cur = argsRef.current.activeIndexRef.current;
          argsRef.current.applySelection(
            cur,
            Math.min(argsRef.current.displayEntriesRef.current.length - 1, cur + argsRef.current.displayedItemsRef.current - 1),
            "include-active",
          );
        }),
      [COMMAND_KEYS.goToParent]: () => {
        const currentPath = argsRef.current.currentPathRef.current;
        if (isContainerPath(currentPath)) {
          const { containerFile, innerPath } = parseContainerPath(currentPath);
          if (innerPath === "/" || innerPath === "") {
            void argsRef.current.navigateTo(dirname(containerFile));
            return;
          }
        }
        const parent = dirname(currentPath);
        if (parent !== currentPath) void argsRef.current.navigateTo(parent);
      },
      [COMMAND_KEYS.goHome]: async () => {
        const home = await bridge.utils.getHomePath();
        await argsRef.current.navigateTo(home);
      },
      [COMMAND_KEYS.refresh]: () => {
        void argsRef.current.navigateTo(argsRef.current.currentPathRef.current);
      },
      [COMMAND_KEYS.execute]: () => argsRef.current.fileActions.execute(),
      [COMMAND_KEYS.open]: () => argsRef.current.fileActions.open(),
      [COMMAND_KEYS.viewFile]: () => argsRef.current.fileActions.viewFile(),
      [COMMAND_KEYS.editFile]: () => argsRef.current.fileActions.editFile(),
      [COMMAND_KEYS.moveToTrash]: () => argsRef.current.fileActions.moveToTrash(),
      [COMMAND_KEYS.permanentDelete]: () => argsRef.current.fileActions.permanentDelete(),
      [COMMAND_KEYS.copy]: () => argsRef.current.fileActions.copy(),
      [COMMAND_KEYS.move]: () => argsRef.current.fileActions.move(),
      [COMMAND_KEYS.rename]: () => argsRef.current.fileActions.rename(),
      [COMMAND_KEYS.pasteFilename]: () => argsRef.current.fileActions.pasteFilename(),
      [COMMAND_KEYS.pastePath]: () => argsRef.current.fileActions.pastePath(),
    }),
    [actionQueue, bridge],
  );

  useEffect(() => {
    if (!active) return;
    const disposables = Object.entries(handlers)
      .map(([commandId, handler]) => commandRegistry.registerCommand(commandId, handler));
    return () => {
      for (const dispose of disposables) dispose();
    };
  }, [active, commandRegistry, handlers]);
}
