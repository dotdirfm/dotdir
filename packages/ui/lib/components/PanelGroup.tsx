import { activePanelAtom, showHiddenAtom } from "@/atoms";
import { EditorContainer, ViewerContainer } from "@/components/ExtensionContainer";
import { FileList } from "@/components/FileList";
import { PanelTabs } from "@/components/FileList/PanelTabs";
import { useDialog } from "@/dialogs/dialogContext";
import type { PanelSide } from "@/entities/panel/model/types";
import {
  createFilelistTab,
  leftActiveIndexAtom,
  leftActiveTabIdAtom,
  leftTabsAtom,
  rightActiveIndexAtom,
  rightActiveTabIdAtom,
  rightTabsAtom,
} from "@/entities/tab/model/tabsAtoms";
import { useBridge } from "@/features/bridge/useBridge";
import type { PanelPersistedState } from "@/features/ui-state/types";
import { setActivePanelGroupHandlers } from "@/panelGroupHandlers";
import { editorRegistry, viewerRegistry } from "@/viewerEditorRegistry";
import type { FsNode, LayeredResolver } from "fss-lang";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { useCallback, useEffect, useMemo, useRef } from "react";
import styles from "../styles/panels.module.css";
import { cx } from "../utils/cssModules";

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
  const { showDialog } = useDialog();
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
  const closeTabNow = useCallback(async (id: string) => {
    const currentTabs = tabsRef.current;
    if (currentTabs.length > 1) {
      const idx = currentTabs.findIndex((t) => t.id === id);
      const next = currentTabs.filter((t) => t.id !== id);
      if (activeTabIdRef.current === id) setActiveTabId(next[Math.min(idx, next.length - 1)]?.id ?? "");
      setTabs(next);
      return;
    }
    const home = await useBridge().utils.getHomePath();
    const newTab = createFilelistTab(home);
    setTabs([newTab]);
    setActiveTabId(newTab.id);
    panelRef.current.navigateTo(home);
  }, []);
  const handleCloseTab = useCallback(async (id: string) => {
    const tab = tabsRef.current.find((t) => t.id === id);
    if (tab?.type === "preview" && tab.mode === "editor" && tab.dirty) {
      showDialog({
        type: "message",
        title: "Unsaved Changes",
        message: `Close "${tab.name}" and discard unsaved changes?`,
        buttons: [
          {
            label: "Cancel",
            default: true,
          },
          {
            label: "Discard",
            onClick: () => {
              void closeTabNow(id);
            },
          },
        ],
      });
      return;
    }
    await closeTabNow(id);
  }, [closeTabNow, showDialog]);

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
    <div className={cx(styles, "panel", active && "active")} onClick={() => setActivePanel(side)}>
      {panel.navigating && <div className={styles["panel-progress"]} />}
      <PanelTabs
        tabs={tabs}
        activeTabId={activeTabId}
        onSelectTab={handleSelectTab}
        onDoubleClickTab={handlePinTab}
        onCloseTab={handleCloseTab}
        onNewTab={handleNewTab}
        onReorderTabs={handleReorderTabs}
      />
      <div className={styles["panel-content"]}>
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
            if (tab.mode === "editor") {
              const resolvedEditor = editorRegistry.resolve(tab.name);
              if (!resolvedEditor) {
                return (
                  <div style={{ padding: 16, color: "var(--fg-muted, #888)", textAlign: "center" }}>
                    No editor extension for this file type. Install editor extensions from the extensions panel.
                  </div>
                );
              }
              const langId = tab.langId ?? "plaintext";
              return (
                <EditorContainer
                  extensionDirPath={resolvedEditor.extensionDirPath}
                  entry={resolvedEditor.contribution.entry}
                  filePath={tab.path}
                  fileName={tab.name}
                  langId={langId}
                  inline
                  onClose={() => handleCloseTab(tab.id)}
                  onDirtyChange={(dirty) => {
                    setTabs((prev) =>
                      prev.map((t) =>
                        t.id === tab.id && t.type === "preview"
                          ? {
                              ...t,
                              dirty,
                              isTemp: dirty ? false : t.isTemp,
                            }
                          : t,
                      ),
                    );
                  }}
                />
              );
            }
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
