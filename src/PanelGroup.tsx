import type { FsNode, LayeredResolver } from "fss-lang";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { ViewerContainer } from "./components/ExtensionContainer";
import { FileList } from "./components/FileList";
import { PanelTabs } from "./components/FileList/PanelTabs";
import { activePanelAtom, showHiddenAtom } from "./atoms";
import { bridge } from "./bridge";
import type { PanelPersistedState } from "./extensions";
import {
  createFilelistTab,
  leftActiveIndexAtom,
  leftActiveTabIdAtom,
  leftTabsAtom,
  rightActiveIndexAtom,
  rightActiveTabIdAtom,
  rightTabsAtom,
} from "./tabsAtoms";
import { setActivePanelGroupHandlers } from "./panelGroupHandlers";
import { viewerRegistry } from "./viewerEditorRegistry";

type PanelSide = "left" | "right";

interface PanelModel {
  currentPath: string;
  parentNode?: FsNode;
  entries: FsNode[];
  navigating: boolean;
  resolver: LayeredResolver;
  navigateTo: (path: string, force?: boolean) => Promise<void>;
}

interface PanelGroupProps {
  side: PanelSide;
  panel: PanelModel;
  onRememberExpectedTerminalCwd: (path: string) => void;
  selectionKey?: number;
  requestedActiveName?: string;
  requestedTopmostName?: string;
  initialPanelState?: PanelPersistedState;
  onStateChange: (selectedName: string | undefined, topmostName: string | undefined) => void;
}

export function PanelGroup({
  side,
  panel,
  onRememberExpectedTerminalCwd,
  selectionKey,
  requestedActiveName,
  requestedTopmostName,
  initialPanelState,
  onStateChange,
}: PanelGroupProps) {
  const activePanel = useAtomValue(activePanelAtom);
  const setActivePanel = useSetAtom(activePanelAtom);
  const active = activePanel === side;

  const [tabs, setTabs] = useAtom(side === "left" ? leftTabsAtom : rightTabsAtom);
  const [activeTabId, setActiveTabId] = useAtom(side === "left" ? leftActiveTabIdAtom : rightActiveTabIdAtom);
  const activeIndex = useAtomValue(side === "left" ? leftActiveIndexAtom : rightActiveIndexAtom);
  const activeTab = tabs[activeIndex];

  const initialTabPersisted = initialPanelState?.tabs?.[activeIndex];

  const showHidden = useAtomValue(showHiddenAtom);
  const filteredEntries = useMemo(() => (showHidden ? panel.entries : panel.entries.filter((e) => !e.meta.hidden)), [showHidden, panel.entries]);

  const panelRef = useRef(panel);
  panelRef.current = panel;

  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const activeTabIdRef = useRef(activeTabId);
  activeTabIdRef.current = activeTabId;

  const handleSelectTab = useCallback((id: string) => setActiveTabId(id), [setActiveTabId]);
  const handlePinTab = useCallback((id: string) => {
    setTabs((prev) => prev.map((t) => (t.id === id && t.type === "preview" && t.isTemp ? { ...t, isTemp: false } : t)));
  }, []);
  const handleCloseTab = useCallback(async (id: string) => {
    const currentTabs = tabsRef.current;
    if (currentTabs.length > 1) {
      const idx = currentTabs.findIndex((t) => t.id === id);
      const next = currentTabs.filter((t) => t.id !== id);
      if (activeTabIdRef.current === id) setActiveTabId(next[Math.min(idx, next.length - 1)]?.id ?? "");
      setTabs(next);
      return;
    }
    const home = await bridge.utils.getHomePath();
    const newTab = createFilelistTab(home);
    setTabs([newTab]);
    setActiveTabId(newTab.id);
    panelRef.current.navigateTo(home);
  }, []);

  const handleReorderTabs = useCallback((fromIndex: number, toIndex: number) => {
    setTabs((prev) => {
      const next = [...prev];
      const [moved] = next.splice(fromIndex, 1);
      next.splice(toIndex, 0, moved);
      return next;
    });
  }, []);

  const handleNewTab = useCallback(() => {
    const path = panelRef.current.currentPath;
    const newTab = createFilelistTab(path);
    setTabs((prev) => [...prev, newTab]);
    setActiveTabId(newTab.id);
    void panelRef.current.navigateTo(path);
  }, [setTabs, setActiveTabId]);

  useEffect(() => {
    if (!active) return;
    setActivePanelGroupHandlers({ newTab: handleNewTab, closeActiveTab: () => handleCloseTab(activeTabIdRef.current) });
    return () => setActivePanelGroupHandlers(null);
  }, [active, handleNewTab, handleCloseTab]);

  return (
    <div className={`panel ${active ? "active" : ""}`} onClick={() => setActivePanel(side)}>
      {panel.navigating && <div className="panel-progress" />}
      <PanelTabs
        tabs={tabs}
        activeTabId={activeTabId}
        onSelectTab={handleSelectTab}
        onDoubleClickTab={handlePinTab}
        onCloseTab={handleCloseTab}
        onNewTab={handleNewTab}
        onReorderTabs={handleReorderTabs}
      />
      <div className="panel-content">
        {activeTab?.type === "filelist" ? (
          <FileList
            key={activeTab.id}
            currentPath={panel.currentPath}
            parentNode={panel.parentNode}
            entries={filteredEntries}
            onNavigate={(path) => {
              setActivePanel(side);
              onRememberExpectedTerminalCwd(path);
              return panel.navigateTo(path);
            }}
            selectionKey={selectionKey}
            active={active}
            resolver={panel.resolver}
            requestedActiveName={requestedActiveName ?? (initialTabPersisted?.type === "filelist" ? initialTabPersisted.selectedName : undefined)}
            requestedTopmostName={requestedTopmostName ?? (initialTabPersisted?.type === "filelist" ? initialTabPersisted.topmostName : undefined)}
            onStateChange={onStateChange}
          />
        ) : activeTab?.type === "preview" ? (
          (() => {
            const tab = activeTab;
            if (tab.type !== "preview") return null;
            const resolved = viewerRegistry.resolve(tab.name);
            if (resolved) {
              return (
                <ViewerContainer
                  extensionDirPath={resolved.extensionDirPath}
                  entry={resolved.contribution.entry}
                  filePath={tab.path}
                  fileName={tab.name}
                  fileSize={tab.size}
                  inline
                  onClose={() => handleCloseTab(tab.id)}
                />
              );
            }
            return (
              <div style={{ padding: 16, color: "var(--fg-muted, #888)", textAlign: "center" }}>
                No viewer extension for this file type. Install viewer extensions from the extensions panel.
              </div>
            );
          })()
        ) : null}
      </div>
    </div>
  );
}
