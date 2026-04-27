import { activePanelSideAtom, genTabId, leftActiveIndexAtom, leftActiveTabIdAtom, leftTabsAtom, rightActiveIndexAtom, rightActiveTabIdAtom, rightTabsAtom } from "@/entities/tab/model/tabsAtoms";
import type { PanelTab } from "@/entities/tab/model/types";
import { useBridge } from "@/features/bridge/useBridge";
import type { DotDirWindowLayout, PanelPersistedState, PersistedTab } from "@/features/ui-state/types";
import { useUiState } from "@/features/ui-state/uiState";
import { basename, dirname, join } from "@/utils/path";
import type { FsNode } from "@dotdirfm/fss-lang";
import { useAtomValue, useSetAtom } from "jotai";
import type { Dispatch, SetStateAction } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";

export function useWorkspaceRestoreProcess() {
  const bridge = useBridge();
  const { loadCurrentWindowLayout } = useUiState();

  const setLeftTabs = useSetAtom(leftTabsAtom);
  const setRightTabs = useSetAtom(rightTabsAtom);
  const setLeftActiveTabId = useSetAtom(leftActiveTabIdAtom);
  const setRightActiveTabId = useSetAtom(rightActiveTabIdAtom);

  const [uiStateLoaded, setUiStateLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const state = await loadCurrentWindowLayout();
      if (cancelled) return;

      const home = await bridge.utils.getHomePath();
      if (cancelled) return;

      const setTabsForPanel = (
        panelState: PanelPersistedState | undefined,
        setTabs: Dispatch<SetStateAction<PanelTab[]>>,
        setActiveTabId: Dispatch<SetStateAction<string>>,
      ) => {
        if (!panelState?.tabs?.length) {
          const fallbackTab: PanelTab = {
            id: genTabId(),
            type: "filelist",
            path: home,
            entries: [] as FsNode[],
            selectedEntryNames: [],
          };
          setTabs([fallbackTab]);
          setActiveTabId(fallbackTab.id);
          return;
        }

        const tabs: PanelTab[] = [];
        for (const t of panelState.tabs) {
          if (t.type === "filelist") {
            tabs.push({
              id: genTabId(),
              type: "filelist",
              path: t.path || home,
              entries: [] as FsNode[],
              topmostEntryName: t.topmostEntryName,
              activeEntryName: t.activeEntryName,
              selectedEntryNames: [],
            });
            continue;
          }

          if (t.type === "preview") {
            tabs.push({
              id: genTabId(),
              type: "preview",
              isTemp: false,
              path: dirname(t.path),
              name: basename(t.path),
              size: 0,
            });
          }
        }

        if (!tabs.length) {
          const fallbackTab: PanelTab = {
            id: genTabId(),
            type: "filelist",
            path: home,
            entries: [] as FsNode[],
            selectedEntryNames: [],
          };
          setTabs([fallbackTab]);
          setActiveTabId(fallbackTab.id);
          return;
        }

        setTabs(tabs);
        const activeTabId = tabs[panelState.activeTabIndex ?? 0]?.id ?? tabs[0]?.id;
        if (activeTabId) setActiveTabId(activeTabId);
      };

      setTabsForPanel(state.leftPanel, setLeftTabs, setLeftActiveTabId);
      setTabsForPanel(state.rightPanel, setRightTabs, setRightActiveTabId);
      setUiStateLoaded(true);
    })();

    return () => {
      cancelled = true;
    };
  }, [bridge, loadCurrentWindowLayout, setLeftActiveTabId, setLeftTabs, setRightActiveTabId, setRightTabs]);

  return {
    uiStateLoaded,
  };
}

export function useWorkspacePersistenceProcess() {
  const { flushCurrentWindowLayout, flushCurrentWindowState, updateCurrentWindowLayout, updateCurrentWindowState } = useUiState();
  const bridge = useBridge();

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

  const persistedLayout = useMemo<DotDirWindowLayout>(
    () => ({
      activePanel: activePanelSide,
      leftPanel: buildPersistedTabs(leftTabs, leftActiveIndex),
      rightPanel: buildPersistedTabs(rightTabs, rightActiveIndex),
    }),
    [activePanelSide, buildPersistedTabs, leftActiveIndex, leftTabs, rightActiveIndex, rightTabs],
  );

  const saveWindowStateSnapshot = useCallback(async () => {
    if (!bridge.window) return;
    try {
      const state = await bridge.window.getCurrentState();
      updateCurrentWindowState({
        x: state.x,
        y: state.y,
        width: state.width,
        height: state.height,
        isMaximized: state.isMaximized,
      });
    } catch (err) {
      console.error("[workspace] Failed to capture window state:", err);
    }
  }, [bridge.window, updateCurrentWindowState]);

  useEffect(() => {
    if (!bridge.window?.onStateChanged) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = bridge.window.onStateChanged(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void saveWindowStateSnapshot();
      }, 200);
    });
    return () => {
      if (timer) clearTimeout(timer);
      unsubscribe();
    };
  }, [bridge.window, saveWindowStateSnapshot]);

  const flushPanelState = useCallback(() => {
    updateCurrentWindowLayout(persistedLayout);
    void flushCurrentWindowLayout();
    void saveWindowStateSnapshot().finally(() => {
      void flushCurrentWindowState();
    });
  }, [flushCurrentWindowLayout, flushCurrentWindowState, persistedLayout, saveWindowStateSnapshot, updateCurrentWindowLayout]);

  useEffect(() => {
    const timer = setTimeout(() => {
      updateCurrentWindowLayout(persistedLayout);
      void saveWindowStateSnapshot();
    }, 10_000);
    return () => clearTimeout(timer);
  }, [persistedLayout, saveWindowStateSnapshot, updateCurrentWindowLayout]);

  useEffect(() => {
    const handleBeforeUnload = () => {
      flushPanelState();
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [flushPanelState]);
}
