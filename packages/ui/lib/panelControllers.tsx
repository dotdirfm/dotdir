import type { PanelSide } from "@/entities/panel/model/types";
import { activePanelSideAtom } from "@/entities/tab/model/tabsAtoms";
import type { FileListPanelController } from "@/hooks/useFileListPanel";
import { useAtomValue } from "jotai";
import { createContext, createElement, type ReactNode, useCallback, useContext, useMemo, useRef } from "react";

type PanelControllersRegistry = {
  registerPanel(side: PanelSide, panel: FileListPanelController): () => void;
  getPanel(side: PanelSide): FileListPanelController | undefined;
  refreshAll(): void;
};

const PanelControllersContext = createContext<PanelControllersRegistry | null>(null);

export function PanelControllersProvider({ children }: { children: ReactNode }) {
  const leftRef = useRef<FileListPanelController | undefined>(undefined);
  const rightRef = useRef<FileListPanelController | undefined>(undefined);

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

  const refreshAll = useCallback(() => {
    leftRef.current?.refresh();
    rightRef.current?.refresh();
  }, []);

  const value = useMemo<PanelControllersRegistry>(
    () => ({
      registerPanel,
      getPanel,
      refreshAll,
    }),
    [getPanel, refreshAll, registerPanel],
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

  return useMemo(
    () => ({
      navigateTo,
      cancelNavigation,
      refresh,
      activePanelSide,
      refreshAll: registry.refreshAll,
      getPanel: registry.getPanel,
    }),
    [activePanelSide, cancelNavigation, navigateTo, refresh, registry],
  );
}
