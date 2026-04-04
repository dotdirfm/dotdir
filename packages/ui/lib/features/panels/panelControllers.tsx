import type { PanelSide } from "@/entities/panel/model/types";
import { activePanelSideAtom } from "@/entities/tab/model/tabsAtoms";
import type { FileListPanelController } from "@/features/panels/useFileListPanel";
import { useAtomValue } from "jotai";
import { createContext, createElement, type ReactNode, useCallback, useContext, useMemo, useRef } from "react";

type PanelControllersRegistry = {
  registerPanel(side: PanelSide, panel: FileListPanelController): () => void;
  registerVisibleFileListFocus(side: PanelSide, tabId: string, focus: () => void): () => void;
  setVisibleFileListTab(side: PanelSide, tabId: string | null): void;
  clearVisibleFileListTab(side: PanelSide, tabId: string): void;
  getPanel(side: PanelSide): FileListPanelController | undefined;
  focusFileList(side: PanelSide): void;
  refreshAll(): void;
};

const PanelControllersContext = createContext<PanelControllersRegistry | null>(null);

export function PanelControllersProvider({ children }: { children: ReactNode }) {
  const leftRef = useRef<FileListPanelController | undefined>(undefined);
  const rightRef = useRef<FileListPanelController | undefined>(undefined);
  const focusBySideRef = useRef<Record<PanelSide, Map<string, () => void>>>({
    left: new Map(),
    right: new Map(),
  });
  const visibleTabsBySideRef = useRef<Record<PanelSide, string | null>>({
    left: null,
    right: null,
  });

  const registerPanel = useCallback((side: PanelSide, panel: FileListPanelController) => {
    const targetRef = side === "left" ? leftRef : rightRef;
    targetRef.current = panel;
    return () => {
      if (targetRef.current === panel) {
        targetRef.current = undefined;
      }
    };
  }, []);

  const getPanel = useCallback(
    (side: PanelSide) => (side === "left" ? leftRef.current : rightRef.current),
    [],
  );

  const registerVisibleFileListFocus = useCallback((side: PanelSide, tabId: string, focus: () => void) => {
    const target = focusBySideRef.current[side];
    target.set(tabId, focus);
    return () => {
      if (target.get(tabId) === focus) {
        target.delete(tabId);
      }
    };
  }, []);

  const setVisibleFileListTab = useCallback((side: PanelSide, tabId: string | null) => {
    visibleTabsBySideRef.current[side] = tabId;
  }, []);

  const clearVisibleFileListTab = useCallback((side: PanelSide, tabId: string) => {
    if (visibleTabsBySideRef.current[side] === tabId) {
      visibleTabsBySideRef.current[side] = null;
    }
  }, []);

  const focusFileList = useCallback((side: PanelSide) => {
    const tabId = visibleTabsBySideRef.current[side];
    if (!tabId) return;
    focusBySideRef.current[side].get(tabId)?.();
  }, []);

  const refreshAll = useCallback(() => {
    leftRef.current?.refresh();
    rightRef.current?.refresh();
  }, []);

  const value = useMemo<PanelControllersRegistry>(
    () => ({
      registerPanel,
      registerVisibleFileListFocus,
      setVisibleFileListTab,
      clearVisibleFileListTab,
      getPanel,
      focusFileList,
      refreshAll,
    }),
    [clearVisibleFileListTab, focusFileList, getPanel, refreshAll, registerPanel, registerVisibleFileListFocus, setVisibleFileListTab],
  );

  return createElement(PanelControllersContext.Provider, { value }, children);
}

function usePanelControllersRegistry(): PanelControllersRegistry {
  const value = useContext(PanelControllersContext);
  if (!value) {
    throw new Error("usePanelControllersRegistry must be used within PanelControllersProvider");
  }
  return value;
}

export function usePanelControllerRegistry() {
  return usePanelControllersRegistry();
}

export function useActivePanelNavigation() {
  const activePanelSide = useAtomValue(activePanelSideAtom);
  const registry = usePanelControllersRegistry();

  const navigateTo = useCallback(
    (path: string) => registry.getPanel(activePanelSide)?.navigateTo(path),
    [activePanelSide, registry],
  );

  const cancelNavigation = useCallback(
    () => registry.getPanel(activePanelSide)?.cancelNavigation(),
    [activePanelSide, registry],
  );

  const refresh = useCallback(
    () => registry.getPanel(activePanelSide)?.refresh(),
    [activePanelSide, registry],
  );

  const focusFileList = useCallback(
    (side: PanelSide) => registry.focusFileList(side),
    [registry],
  );

  const focusActiveFileList = useCallback(
    () => registry.focusFileList(activePanelSide),
    [activePanelSide, registry],
  );

  return useMemo(
    () => ({
      navigateTo,
      cancelNavigation,
      refresh,
      focusFileList,
      focusActiveFileList,
      activePanelSide,
      refreshAll: registry.refreshAll,
      getPanel: registry.getPanel,
    }),
    [activePanelSide, cancelNavigation, focusActiveFileList, focusFileList, navigateTo, refresh, registry],
  );
}
