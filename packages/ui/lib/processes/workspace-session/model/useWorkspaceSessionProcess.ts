import type { PanelTab } from "@/components/FileList/PanelTabs";
import {
  OPPOSITE_PANEL,
  PANEL_SETTINGS_KEY,
  PANEL_SIDES,
} from "@/entities/panel/model/panelSide";
import type { PanelSide } from "@/entities/panel/model/types";
import {
  createFilelistTab,
  genTabId,
} from "@/entities/tab/model/tabsAtoms";
import { DotDirUiState, PanelPersistedState, PersistedTab } from "@/features/ui-state/types";
import { flushUiState, initUiState, updateUiState } from "@/features/ui-state/uiState";
import { useBridge } from "@/hooks/useBridge";
import type { FsNode } from "fss-lang";
import type { Dispatch, RefObject, SetStateAction } from "react";
import { useCallback, useEffect, useRef, useState } from "react";

type TabSelectionRef = RefObject<
  Record<string, { selectedName?: string; topmostName?: string }>
>;
type NameRef = RefObject<string | undefined>;
type IdRef = RefObject<string>;
type TabsRef = RefObject<PanelTab[]>;

interface PanelModel {
  currentPath: string;
  entries: FsNode[];
}

interface RestoreParams {
  ready: boolean;
  setLeftTabs: Dispatch<SetStateAction<PanelTab[]>>;
  setRightTabs: Dispatch<SetStateAction<PanelTab[]>>;
  setLeftActiveTabId: Dispatch<SetStateAction<string>>;
  setRightActiveTabId: Dispatch<SetStateAction<string>>;
  leftTabSelectionRef: TabSelectionRef;
  rightTabSelectionRef: TabSelectionRef;
  prevLeftActiveTabIdRef: RefObject<string>;
  prevRightActiveTabIdRef: RefObject<string>;
  onAfterRestore: () => void;
}

export function useWorkspaceRestoreProcess({
  ready,
  setLeftTabs,
  setRightTabs,
  setLeftActiveTabId,
  setRightActiveTabId,
  leftTabSelectionRef,
  rightTabSelectionRef,
  prevLeftActiveTabIdRef,
  prevRightActiveTabIdRef,
  onAfterRestore,
}: RestoreParams) {
  const bridge = useBridge();
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const uiStateRef = useRef<DotDirUiState>({});
  const [uiStateLoaded, setUiStateLoaded] = useState(false);
  const [initialLeftPanel, setInitialLeftPanel] = useState<
    PanelPersistedState | undefined
  >(undefined);
  const [initialRightPanel, setInitialRightPanel] = useState<
    PanelPersistedState | undefined
  >(undefined);
  const [initialActivePanel, setInitialActivePanel] = useState<
    PanelSide | undefined
  >(undefined);

  useEffect(() => {
    initUiState(bridge).then((state) => {
      uiStateRef.current = state;
      setUiStateLoaded(true);
    });
  }, []);

  useEffect(() => {
    if (!ready || !uiStateLoaded) return;

    const ui = uiStateRef.current;

    const restoreTabs = (
      panel: PanelPersistedState | undefined,
    ): PanelTab[] | null => {
      if (panel?.tabs?.length) {
        return panel.tabs.map((t) => {
          if (t.type === "filelist") return createFilelistTab(t.path);
          return {
            id: genTabId(),
            type: "preview" as const,
            path: t.path,
            name: t.name,
            size: t.size,
            isTemp: false,
          };
        });
      }
      if (panel?.currentPath) {
        return [createFilelistTab(panel.currentPath)];
      }
      return null;
    };

    const seedTabSelections = (
      refs: TabSelectionRef,
      restored: PanelTab[] | null,
      persisted: PanelPersistedState | undefined,
    ) => {
      if (!restored?.length || !persisted?.tabs?.length) return;
      for (let i = 0; i < restored.length && i < persisted.tabs.length; i++) {
        const t = restored[i];
        const p = persisted.tabs[i];
        if (
          t.type === "filelist" &&
          p.type === "filelist" &&
          (p.selectedName != null || p.topmostName != null)
        ) {
          refs.current[t.id] = {
            selectedName: p.selectedName,
            topmostName: p.topmostName,
          };
        }
      }
    };

    const restoredLeftTabs = restoreTabs(ui.leftPanel);
    const restoredRightTabs = restoreTabs(ui.rightPanel);
    if (restoredLeftTabs)
      seedTabSelections(leftTabSelectionRef, restoredLeftTabs, ui.leftPanel);
    if (restoredRightTabs)
      seedTabSelections(rightTabSelectionRef, restoredRightTabs, ui.rightPanel);
    const restoredLeftIndex = restoredLeftTabs
      ? Math.min(ui.leftPanel?.activeTabIndex ?? 0, restoredLeftTabs.length - 1)
      : 0;
    const restoredRightIndex = restoredRightTabs
      ? Math.min(
          ui.rightPanel?.activeTabIndex ?? 0,
          restoredRightTabs.length - 1,
        )
      : 0;
    const restoredLeftActiveId = restoredLeftTabs?.[restoredLeftIndex]?.id;
    const restoredRightActiveId = restoredRightTabs?.[restoredRightIndex]?.id;

    if (restoredLeftActiveId)
      prevLeftActiveTabIdRef.current = restoredLeftActiveId;
    if (restoredRightActiveId)
      prevRightActiveTabIdRef.current = restoredRightActiveId;

    if (restoredLeftTabs) setLeftTabs(restoredLeftTabs);
    if (restoredRightTabs) setRightTabs(restoredRightTabs);
    if (restoredLeftActiveId) setLeftActiveTabId(restoredLeftActiveId);
    if (restoredRightActiveId) setRightActiveTabId(restoredRightActiveId);

    if (ui.leftPanel) setInitialLeftPanel(ui.leftPanel);
    if (ui.rightPanel) setInitialRightPanel(ui.rightPanel);
    if (ui.activePanel) setInitialActivePanel(ui.activePanel);
    setSettingsLoaded(true);
    onAfterRestore();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally runs once when both files are loaded
  }, [ready, uiStateLoaded]);

  return {
    settingsLoaded,
    initialLeftPanel,
    initialRightPanel,
    initialActivePanel,
    setInitialLeftPanel,
    setInitialRightPanel,
    setInitialActivePanel,
  };
}

interface PersistParams {
  activePanel: PanelSide;
  settingsLoaded: boolean;
  left: PanelModel;
  right: PanelModel;
  leftTabsRef: TabsRef;
  rightTabsRef: TabsRef;
  leftActiveTabIdRef: IdRef;
  rightActiveTabIdRef: IdRef;
  leftTabSelectionRef: TabSelectionRef;
  rightTabSelectionRef: TabSelectionRef;
  leftSelectedNameRef: NameRef;
  rightSelectedNameRef: NameRef;
  setLeftTabs: Dispatch<SetStateAction<PanelTab[]>>;
  setRightTabs: Dispatch<SetStateAction<PanelTab[]>>;
  setLeftActiveTabId: Dispatch<SetStateAction<string>>;
  setRightActiveTabId: Dispatch<SetStateAction<string>>;
}

export function useWorkspacePersistenceProcess({
  activePanel,
  settingsLoaded,
  left,
  right,
  leftTabsRef,
  rightTabsRef,
  leftActiveTabIdRef,
  rightActiveTabIdRef,
  leftTabSelectionRef,
  rightTabSelectionRef,
  leftSelectedNameRef,
  rightSelectedNameRef,
  setLeftTabs,
  setRightTabs,
  setLeftActiveTabId,
  setRightActiveTabId,
}: PersistParams) {
  const bridge = useBridge();

  const panelStateSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const pendingPanelStateRef = useRef<Partial<DotDirUiState>>({});

  const buildPersistedTabs = useCallback(
    (
      side: PanelSide,
      tabs: PanelTab[],
      activeTabId: string,
    ): { tabs: PersistedTab[]; activeTabIndex: number } => {
      const selectionRef =
        side === "left" ? leftTabSelectionRef : rightTabSelectionRef;
      const persisted: PersistedTab[] = tabs.map((tab) => {
        if (tab.type === "filelist") {
          const sel = selectionRef.current[tab.id];
          const pt: PersistedTab = { type: "filelist", path: tab.path };
          if (sel?.selectedName != null) pt.selectedName = sel.selectedName;
          if (sel?.topmostName != null) pt.topmostName = sel.topmostName;
          return pt;
        }
        return {
          type: "preview",
          path: tab.path,
          name: tab.name,
          size: tab.size,
        };
      });
      const activeTabIndex = Math.max(
        0,
        tabs.findIndex((t) => t.id === activeTabId),
      );
      return { tabs: persisted, activeTabIndex };
    },
    [leftTabSelectionRef, rightTabSelectionRef],
  );

  const flushPanelState = useCallback(() => {
    if (panelStateSaveTimerRef.current) {
      clearTimeout(panelStateSaveTimerRef.current);
      panelStateSaveTimerRef.current = null;
    }
    const pending = pendingPanelStateRef.current;
    for (const side of PANEL_SIDES) {
      const key = PANEL_SETTINGS_KEY[side];
      if (!pending[key]) {
        pending[key] = {
          currentPath: side === "left" ? left.currentPath : right.currentPath,
        };
      }
      const tabsRef = side === "left" ? leftTabsRef : rightTabsRef;
      const activeTabIdRef =
        side === "left" ? leftActiveTabIdRef : rightActiveTabIdRef;
      Object.assign(
        pending[key]!,
        buildPersistedTabs(side, tabsRef.current, activeTabIdRef.current),
      );
    }
    updateUiState(bridge, pending);
    flushUiState(bridge);
    pendingPanelStateRef.current = {};
  }, [
    buildPersistedTabs,
    left.currentPath,
    right.currentPath,
    leftTabsRef,
    rightTabsRef,
    leftActiveTabIdRef,
    rightActiveTabIdRef,
  ]);

  const savePanelStateDebounced = useCallback(() => {
    if (panelStateSaveTimerRef.current) {
      clearTimeout(panelStateSaveTimerRef.current);
    }
    panelStateSaveTimerRef.current = setTimeout(() => {
      panelStateSaveTimerRef.current = null;
      updateUiState(bridge, pendingPanelStateRef.current);
      pendingPanelStateRef.current = {};
    }, 10000);
  }, [bridge]);

  useEffect(() => {
    const handleBeforeUnload = () => {
      flushPanelState();
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [flushPanelState]);

  const handlePanelStateChange = useCallback(
    (
      side: PanelSide,
      selectedName: string | undefined,
      topmostName: string | undefined,
    ) => {
      const selfTabsRef = side === "left" ? leftTabsRef : rightTabsRef;
      const selfActiveTabIdRef =
        side === "left" ? leftActiveTabIdRef : rightActiveTabIdRef;
      const selfTabSelRef =
        side === "left" ? leftTabSelectionRef : rightTabSelectionRef;
      const selfSelectedNameRef =
        side === "left" ? leftSelectedNameRef : rightSelectedNameRef;
      const panel = side === "left" ? left : right;

      const tab = selfTabsRef.current.find(
        (t) => t.id === selfActiveTabIdRef.current,
      );
      if (tab?.type === "filelist") {
        selfTabSelRef.current[tab.id] = { selectedName, topmostName };
      }
      selfSelectedNameRef.current = selectedName;
      pendingPanelStateRef.current[PANEL_SETTINGS_KEY[side]] = {
        currentPath: panel.currentPath,
        ...buildPersistedTabs(
          side,
          selfTabsRef.current,
          selfActiveTabIdRef.current,
        ),
      };
      savePanelStateDebounced();

      const opposite = OPPOSITE_PANEL[side];
      const oppTabsRef = opposite === "left" ? leftTabsRef : rightTabsRef;
      const setOppTabs = opposite === "right" ? setRightTabs : setLeftTabs;
      const setOppActiveId =
        opposite === "right" ? setRightActiveTabId : setLeftActiveTabId;
      const tabs = oppTabsRef.current;
      const tempTab = tabs.find(
        (t) => t.type === "preview" && t.isTemp && t.sourcePanel === side,
      );
      if (!tempTab || !selectedName) return;
      const entry = panel.entries.find((e) => e.name === selectedName);
      if (!entry || entry.type !== "file") return;
      const path = entry.path as string;
      const name = entry.name;
      const size = Number(entry.meta.size);
      if (
        tempTab.type === "preview" &&
        tempTab.path === path &&
        tempTab.name === name
      )
        return;
      setOppTabs((prev) =>
        prev.map((t) =>
          t.id === tempTab.id
            ? {
                id: t.id,
                type: "preview" as const,
                path,
                name,
                size,
                isTemp: true,
                sourcePanel: side,
              }
            : t,
        ),
      );
      setOppActiveId(tempTab.id);
    },
    [
      left,
      right,
      buildPersistedTabs,
      savePanelStateDebounced,
      leftTabsRef,
      rightTabsRef,
      leftActiveTabIdRef,
      rightActiveTabIdRef,
      leftTabSelectionRef,
      rightTabSelectionRef,
      leftSelectedNameRef,
      rightSelectedNameRef,
      setRightTabs,
      setLeftTabs,
      setRightActiveTabId,
      setLeftActiveTabId,
    ],
  );

  useEffect(() => {
    if (!settingsLoaded) return;
    updateUiState(bridge, { activePanel });
  }, [activePanel, settingsLoaded]);

  return { handlePanelStateChange };
}
