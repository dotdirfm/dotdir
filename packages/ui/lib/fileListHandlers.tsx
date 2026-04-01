import type { PanelSide } from "@/entities/panel/model/types";
import { activePanelSideAtom } from "@/entities/tab/model/tabsAtoms";
import { useAtomValue } from "jotai";
import { createContext, createElement, type ReactNode, useCallback, useContext, useMemo, useRef } from "react";

export interface ActiveFileListHandlers {
  focus(): void;
  cursorUp(): void;
  cursorDown(): void;
  cursorLeft(): void;
  cursorRight(): void;
  cursorHome(): void;
  cursorEnd(): void;
  cursorPageUp(): void;
  cursorPageDown(): void;
  selectUp(): void;
  selectDown(): void;
  selectLeft(): void;
  selectRight(): void;
  selectHome(): void;
  selectEnd(): void;
  selectPageUp(): void;
  selectPageDown(): void;
  execute(): void;
  open(): void;
  viewFile(): void;
  editFile(): void;
  moveToTrash(): void;
  permanentDelete(): void;
  copy(): void;
  move(): void;
  rename(): void;
  pasteFilename(): void;
  pastePath(): void;
}

type SideEntries = Map<string, ActiveFileListHandlers>;
type ActiveTabsBySide = Record<PanelSide, string | null>;

interface FileListHandlersRegistry {
  registerFileListHandlers(side: PanelSide, tabId: string, handlers: ActiveFileListHandlers): () => void;
  setVisibleFileListTab(side: PanelSide, tabId: string | null): void;
  clearVisibleFileListTab(side: PanelSide, tabId: string): void;
  getFileListHandlers(side: PanelSide): ActiveFileListHandlers | null;
}

const FileListHandlersContext = createContext<FileListHandlersRegistry | null>(null);

export function FileListHandlersProvider({ children }: { children: ReactNode }) {
  const handlersBySideRef = useRef<Record<PanelSide, SideEntries>>({
    left: new Map(),
    right: new Map(),
  });
  const activeTabsBySideRef = useRef<ActiveTabsBySide>({
    left: null,
    right: null,
  });

  const registerFileListHandlers = useCallback((side: PanelSide, tabId: string, handlers: ActiveFileListHandlers) => {
    const sideEntries = handlersBySideRef.current[side];
    sideEntries.set(tabId, handlers);
    return () => {
      if (sideEntries.get(tabId) === handlers) {
        sideEntries.delete(tabId);
      }
    };
  }, []);

  const setVisibleFileListTab = useCallback((side: PanelSide, tabId: string | null) => {
    activeTabsBySideRef.current[side] = tabId;
  }, []);

  const clearVisibleFileListTab = useCallback((side: PanelSide, tabId: string) => {
    if (activeTabsBySideRef.current[side] === tabId) {
      activeTabsBySideRef.current[side] = null;
    }
  }, []);

  const getFileListHandlers = useCallback((side: PanelSide) => {
    const tabId = activeTabsBySideRef.current[side];
    if (!tabId) return null;
    return handlersBySideRef.current[side].get(tabId) ?? null;
  }, []);

  const value = useMemo<FileListHandlersRegistry>(
    () => ({
      registerFileListHandlers,
      setVisibleFileListTab,
      clearVisibleFileListTab,
      getFileListHandlers,
    }),
    [clearVisibleFileListTab, getFileListHandlers, registerFileListHandlers, setVisibleFileListTab],
  );

  return createElement(FileListHandlersContext.Provider, { value }, children);
}

function useFileListHandlersRegistry(): FileListHandlersRegistry {
  const value = useContext(FileListHandlersContext);
  if (!value) {
    throw new Error("useFileListHandlersRegistry must be used within FileListHandlersProvider");
  }
  return value;
}

export function useGetFileListHandlers() {
  return useFileListHandlersRegistry().getFileListHandlers;
}

export function useRegisterFileListHandlers() {
  return useFileListHandlersRegistry().registerFileListHandlers;
}

export function useSetVisibleFileListTab() {
  return useFileListHandlersRegistry().setVisibleFileListTab;
}

export function useClearVisibleFileListTab() {
  return useFileListHandlersRegistry().clearVisibleFileListTab;
}

export function useFileListHandlers(side: PanelSide): ActiveFileListHandlers | null {
  return useFileListHandlersRegistry().getFileListHandlers(side);
}

export function useActiveFileListHandlers(): ActiveFileListHandlers | null {
  const activePanelSide = useAtomValue(activePanelSideAtom);
  return useFileListHandlersRegistry().getFileListHandlers(activePanelSide);
}

export function useGetActiveFileListHandlers() {
  const activePanelSide = useAtomValue(activePanelSideAtom);
  const registry = useFileListHandlersRegistry();
  return useCallback(() => registry.getFileListHandlers(activePanelSide), [activePanelSide, registry]);
}
