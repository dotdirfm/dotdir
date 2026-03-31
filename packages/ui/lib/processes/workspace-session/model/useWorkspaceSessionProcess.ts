import { activePanelSideAtom, genTabId, leftActiveIndexAtom, leftActiveTabIdAtom, leftTabsAtom, rightActiveIndexAtom, rightActiveTabIdAtom, rightTabsAtom } from "@/entities/tab/model/tabsAtoms";
import { PanelTab } from "@/entities/tab/model/types";
import { useBridge } from "@/features/bridge/useBridge";
import { DotDirUiState, PanelPersistedState, PersistedTab } from "@/features/ui-state/types";
import { flushUiState, initUiState, updateUiState } from "@/features/ui-state/uiState";
import { basename, dirname, join } from "@/utils/path";
import { FsNode } from "fss-lang";
import { useAtomValue, useSetAtom } from "jotai";
import type { Dispatch, SetStateAction } from "react";
import { useCallback, useEffect, useRef, useState } from "react";

export function useWorkspaceRestoreProcess() {
  const bridge = useBridge();

  const setLeftTabs = useSetAtom(leftTabsAtom);
  const setRightTabs = useSetAtom(rightTabsAtom);
  const setLeftActiveTabId = useSetAtom(leftActiveTabIdAtom);
  const setRightActiveTabId = useSetAtom(rightActiveTabIdAtom);

  const uiStateRef = useRef<DotDirUiState>({});
  const [uiStateLoaded, setUiStateLoaded] = useState(false);

  useEffect(() => {
    initUiState(bridge).then((state) => {
      const setTabsForPanel = (
        panelState: PanelPersistedState | undefined,
        setTabs: Dispatch<SetStateAction<PanelTab[]>>,
        setActiveTabId: Dispatch<SetStateAction<string>>,
      ) => {
        if (panelState?.tabs) {
          const tabs: PanelTab[] = panelState.tabs
            .map((t) => {
              if (t.type === "filelist")
                return {
                  id: genTabId(),
                  type: "filelist",
                  path: t.path,
                  entries: [] as FsNode[],
                  topmostEntryName: t.topmostEntryName,
                  activeEntryName: t.activeEntryName,
                };
              if (t.type === "preview") {
                return {
                  id: genTabId(),
                  type: "preview" as const,
                  isTemp: false,
                  path: dirname(t.path),
                  name: basename(t.path),
                };
              }
              return null;
            })
            .filter((t): t is PanelTab => t !== null);
          setTabs(tabs);
          const activeTabId = tabs[panelState.activeTabIndex ?? 0]?.id;
          if (activeTabId) setActiveTabId(activeTabId);
        }
      };

      setTabsForPanel(state.leftPanel, setLeftTabs, setLeftActiveTabId);
      setTabsForPanel(state.rightPanel, setRightTabs, setRightActiveTabId);
      uiStateRef.current = state;
      setUiStateLoaded(true);
    });
  }, []);

  return {
    uiStateLoaded,
  };
}

export function useWorkspacePersistenceProcess() {
  const bridge = useBridge();

  const panelStateSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingPanelStateRef = useRef<Partial<DotDirUiState>>({});

  const activePanelSide = useAtomValue(activePanelSideAtom);
  const leftTabs = useAtomValue(leftTabsAtom);
  const rightTabs = useAtomValue(rightTabsAtom);
  const leftActiveIndex = useAtomValue(leftActiveIndexAtom);
  const rightActiveIndex = useAtomValue(rightActiveIndexAtom);

  const buildPersistedTabs = useCallback(
    (tabs: PanelTab[], activeTabIndex: number) => {
      const persisted: PersistedTab[] = tabs.map((tab) => {
        if (tab.type === "filelist") {
          const pt: PersistedTab = { type: "filelist", path: tab.path };
          if (tab.activeEntryName != null) pt.activeEntryName = tab.activeEntryName;
          if (tab.topmostEntryName != null) pt.topmostEntryName = tab.topmostEntryName;
          return pt;
        }
        return {
          type: "preview",
          path: join(tab.path, tab.name),
        };
      });
      return { tabs: persisted, activeTabIndex };
    },
    [],
  );

  const flushPanelState = useCallback(() => {
    if (panelStateSaveTimerRef.current) {
      clearTimeout(panelStateSaveTimerRef.current);
      panelStateSaveTimerRef.current = null;
    }
    const state: DotDirUiState = {
      activePanel: activePanelSide,
      leftPanel: buildPersistedTabs(leftTabs, leftActiveIndex),
      rightPanel: buildPersistedTabs(rightTabs, rightActiveIndex),
    };
    updateUiState(bridge, state);
    flushUiState(bridge);
    pendingPanelStateRef.current = {};
  }, [buildPersistedTabs]);

  useEffect(() => {
    const handleBeforeUnload = () => {
      flushPanelState();
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [flushPanelState]);
}
