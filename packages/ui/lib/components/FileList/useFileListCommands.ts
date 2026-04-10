import type { ActionQueue } from "@/components/FileList/actionQueue";
import { useBridge } from "@/features/bridge/useBridge";
import { useCommandRegistry } from "@/features/commands/commands";
import {
  CURSOR_DOWN,
  CURSOR_END,
  CURSOR_HOME,
  CURSOR_LEFT,
  CURSOR_PAGE_DOWN,
  CURSOR_PAGE_UP,
  CURSOR_RIGHT,
  CURSOR_UP,
  FILELIST_CURSOR_DOWN,
  FILELIST_CURSOR_END,
  FILELIST_CURSOR_HOME,
  FILELIST_CURSOR_LEFT,
  FILELIST_CURSOR_PAGE_DOWN,
  FILELIST_CURSOR_PAGE_UP,
  FILELIST_CURSOR_RIGHT,
  FILELIST_CURSOR_UP,
  FILELIST_GO_HOME,
  FILELIST_GO_TO_PARENT,
  FILELIST_REFRESH,
  FILELIST_SELECT_DOWN,
  FILELIST_SELECT_END,
  FILELIST_SELECT_HOME,
  FILELIST_SELECT_LEFT,
  FILELIST_SELECT_PAGE_DOWN,
  FILELIST_SELECT_PAGE_UP,
  FILELIST_SELECT_RIGHT,
  FILELIST_SELECT_UP,
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
} from "@/features/commands/commandIds";
import { useFocusContext } from "@/focusContext";
import { useInteractionContext, type InteractionIntent } from "@/interactionContext";
import { isContainerPath, parseContainerPath } from "@/utils/containerPath";
import { dirname } from "@/utils/path";
import { useCallback, useEffect, useMemo, useRef, type RefObject } from "react";
import type { UseFileListActionHandlersReturn } from "./fileListActions";

interface UseFileListCommandsArgs {
  active: boolean;
  containerRef: RefObject<HTMLElement | null>;
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

const INTERACTION_COMMAND_IDS = new Set<string>([
  COMMAND_KEYS.cursorUp,
  COMMAND_KEYS.cursorDown,
  COMMAND_KEYS.cursorLeft,
  COMMAND_KEYS.cursorRight,
  COMMAND_KEYS.cursorHome,
  COMMAND_KEYS.cursorEnd,
  COMMAND_KEYS.cursorPageUp,
  COMMAND_KEYS.cursorPageDown,
  COMMAND_KEYS.selectUp,
  COMMAND_KEYS.selectDown,
  COMMAND_KEYS.selectLeft,
  COMMAND_KEYS.selectRight,
  COMMAND_KEYS.selectHome,
  COMMAND_KEYS.selectEnd,
  COMMAND_KEYS.selectPageUp,
  COMMAND_KEYS.selectPageDown,
  FILELIST_CURSOR_UP,
  FILELIST_CURSOR_DOWN,
  FILELIST_CURSOR_LEFT,
  FILELIST_CURSOR_RIGHT,
  FILELIST_CURSOR_HOME,
  FILELIST_CURSOR_END,
  FILELIST_CURSOR_PAGE_UP,
  FILELIST_CURSOR_PAGE_DOWN,
  FILELIST_SELECT_UP,
  FILELIST_SELECT_DOWN,
  FILELIST_SELECT_LEFT,
  FILELIST_SELECT_RIGHT,
  FILELIST_SELECT_HOME,
  FILELIST_SELECT_END,
  FILELIST_SELECT_PAGE_UP,
  FILELIST_SELECT_PAGE_DOWN,
]);

export function useFileListCommands({
  active,
  containerRef,
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
  const focusContext = useFocusContext();
  const interactionContext = useInteractionContext();
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

  const intentToCommandId = useMemo<Record<InteractionIntent, string | null>>(
    () => ({
      cursorUp: COMMAND_KEYS.cursorUp,
      cursorDown: COMMAND_KEYS.cursorDown,
      cursorLeft: COMMAND_KEYS.cursorLeft,
      cursorRight: COMMAND_KEYS.cursorRight,
      cursorHome: COMMAND_KEYS.cursorHome,
      cursorEnd: COMMAND_KEYS.cursorEnd,
      cursorPageUp: COMMAND_KEYS.cursorPageUp,
      cursorPageDown: COMMAND_KEYS.cursorPageDown,
      selectUp: COMMAND_KEYS.selectUp,
      selectDown: COMMAND_KEYS.selectDown,
      selectLeft: COMMAND_KEYS.selectLeft,
      selectRight: COMMAND_KEYS.selectRight,
      selectHome: COMMAND_KEYS.selectHome,
      selectEnd: COMMAND_KEYS.selectEnd,
      selectPageUp: COMMAND_KEYS.selectPageUp,
      selectPageDown: COMMAND_KEYS.selectPageDown,
      accept: null,
      cancel: null,
    }),
    [],
  );

  const runIfPanelFocused = useMemo(
    () => (handler: CommandHandler): CommandHandler =>
      (...handlerArgs) => {
        if (!focusContext.is("panel")) return;
        handler(...handlerArgs);
      },
    [focusContext],
  );
  const getContainer = useCallback(() => containerRef.current, [containerRef]);

  const handlers = useMemo<Record<string, CommandHandler>>(
    () => ({
      [COMMAND_KEYS.cursorUp]: runIfPanelFocused(() =>
        actionQueue.enqueue(() => {
          argsRef.current.markKeyboardNav();
          argsRef.current.updateCursor(({ activeIndex, topmostIndex }) => ({
            activeIndex: Math.max(0, activeIndex - 1),
            topmostIndex,
          }));
        })),
      [COMMAND_KEYS.cursorDown]: runIfPanelFocused(() =>
        actionQueue.enqueue(() => {
          argsRef.current.markKeyboardNav();
          argsRef.current.updateCursor(({ activeIndex, topmostIndex }) => ({
            activeIndex: Math.min(argsRef.current.displayEntriesRef.current.length - 1, activeIndex + 1),
            topmostIndex,
          }));
        })),
      [COMMAND_KEYS.cursorLeft]: runIfPanelFocused(() =>
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
        })),
      [COMMAND_KEYS.cursorRight]: runIfPanelFocused(() =>
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
        })),
      [COMMAND_KEYS.cursorHome]: runIfPanelFocused(() =>
        actionQueue.enqueue(() => {
          argsRef.current.markKeyboardNav();
          argsRef.current.updateCursor(({ topmostIndex }) => ({ activeIndex: 0, topmostIndex }));
        })),
      [COMMAND_KEYS.cursorEnd]: runIfPanelFocused(() =>
        actionQueue.enqueue(() => {
          argsRef.current.markKeyboardNav();
          argsRef.current.updateCursor(({ topmostIndex }) => ({
            activeIndex: argsRef.current.displayEntriesRef.current.length - 1,
            topmostIndex,
          }));
        })),
      [COMMAND_KEYS.cursorPageUp]: runIfPanelFocused(() =>
        actionQueue.enqueue(() => {
          argsRef.current.markKeyboardNav();
          argsRef.current.updateCursor(({ activeIndex, topmostIndex }) => ({
            activeIndex: Math.max(0, activeIndex - argsRef.current.displayedItemsRef.current + 1),
            topmostIndex,
          }));
        })),
      [COMMAND_KEYS.cursorPageDown]: runIfPanelFocused(() =>
        actionQueue.enqueue(() => {
          argsRef.current.markKeyboardNav();
          argsRef.current.updateCursor(({ activeIndex, topmostIndex }) => ({
            activeIndex: Math.min(
              argsRef.current.displayEntriesRef.current.length - 1,
              activeIndex + argsRef.current.displayedItemsRef.current - 1,
            ),
            topmostIndex,
          }));
        })),
      [COMMAND_KEYS.selectUp]: runIfPanelFocused(() =>
        actionQueue.enqueue(() => {
          argsRef.current.markKeyboardNav();
          const cur = argsRef.current.activeIndexRef.current;
          const target = Math.max(0, cur - 1);
          argsRef.current.applySelection(cur, target, target === cur ? "include-active" : "exclude-active");
        })),
      [COMMAND_KEYS.selectDown]: runIfPanelFocused(() =>
        actionQueue.enqueue(() => {
          argsRef.current.markKeyboardNav();
          const cur = argsRef.current.activeIndexRef.current;
          const target = Math.min(argsRef.current.displayEntriesRef.current.length - 1, cur + 1);
          argsRef.current.applySelection(cur, target, target === cur ? "include-active" : "exclude-active");
        })),
      [COMMAND_KEYS.selectLeft]: runIfPanelFocused(() =>
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
        })),
      [COMMAND_KEYS.selectRight]: runIfPanelFocused(() =>
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
        })),
      [COMMAND_KEYS.selectHome]: runIfPanelFocused(() =>
        actionQueue.enqueue(() => {
          argsRef.current.markKeyboardNav();
          argsRef.current.applySelection(argsRef.current.activeIndexRef.current, 0, "include-active");
        })),
      [COMMAND_KEYS.selectEnd]: runIfPanelFocused(() =>
        actionQueue.enqueue(() => {
          argsRef.current.markKeyboardNav();
          argsRef.current.applySelection(
            argsRef.current.activeIndexRef.current,
            argsRef.current.displayEntriesRef.current.length - 1,
            "include-active",
          );
        })),
      [COMMAND_KEYS.selectPageUp]: runIfPanelFocused(() =>
        actionQueue.enqueue(() => {
          argsRef.current.markKeyboardNav();
          const cur = argsRef.current.activeIndexRef.current;
          argsRef.current.applySelection(cur, Math.max(0, cur - argsRef.current.displayedItemsRef.current + 1), "include-active");
        })),
      [COMMAND_KEYS.selectPageDown]: runIfPanelFocused(() =>
        actionQueue.enqueue(() => {
          argsRef.current.markKeyboardNav();
          const cur = argsRef.current.activeIndexRef.current;
          argsRef.current.applySelection(
            cur,
            Math.min(argsRef.current.displayEntriesRef.current.length - 1, cur + argsRef.current.displayedItemsRef.current - 1),
            "include-active",
          );
        })),
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
    [actionQueue, bridge, runIfPanelFocused],
  );

  useEffect(() => {
    if (!active) return;
    const disposables = Object.entries(handlers)
      .filter(([commandId]) => !INTERACTION_COMMAND_IDS.has(commandId))
      .map(([commandId, handler]) => commandRegistry.registerCommand(commandId, handler));
    return () => {
      for (const dispose of disposables) dispose();
    };
  }, [active, commandRegistry, handlers]);

  useEffect(() => {
    return interactionContext.registerController({
      contains(node) {
        const container = getContainer();
        return node instanceof Node && !!container?.contains(node);
      },
      isActive() {
        return active && focusContext.is("panel");
      },
      handleIntent(intent) {
        const commandId = intentToCommandId[intent];
        if (!commandId) return false;
        const handler = handlers[commandId];
        if (!handler) return false;
        handler();
        return true;
      },
    });
  }, [active, focusContext, getContainer, handlers, interactionContext, intentToCommandId]);
}
