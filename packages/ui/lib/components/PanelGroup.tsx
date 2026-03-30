import { activePanelAtom, showHiddenAtom } from "@/atoms";
import { EditorContainer, ViewerContainer } from "@/components/ExtensionContainer";
import { FileList } from "@/components/FileList";
import { PanelTabs } from "@/components/FileList/PanelTabs";
import { useDialog } from "@/dialogs/dialogContext";
import type { PanelSide } from "@/entities/panel/model/types";
import { focusContext } from "@/focusContext";
import { getFileListHandlers } from "@/fileListHandlers";
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
import { useCallback, useEffect, useRef } from "react";
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

interface FileListSnapshot {
  currentPath: string;
  parentNode?: FsNode;
  entries: FsNode[];
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

  const panelRef = useRef(panel);
  panelRef.current = panel;

  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const activeTabIdRef = useRef(activeTabId);
  activeTabIdRef.current = activeTabId;
  const fileListSnapshotsRef = useRef<Record<string, FileListSnapshot>>({});

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

  const activatePanelFocus = useCallback(() => {
    setActivePanel(side);
    focusContext.request("panel");
    getFileListHandlers(side)?.focus();
    requestAnimationFrame(() => {
      getFileListHandlers(side)?.focus();
    });
  }, [setActivePanel, side]);

  useEffect(() => {
    if (!active) return;
    setActivePanelGroupHandlers({ newTab: handleNewTab, closeActiveTab: () => handleCloseTab(activeTabIdRef.current) });
    return () => setActivePanelGroupHandlers(null);
  }, [active, handleNewTab, handleCloseTab]);

  useEffect(() => {
    const tab = activeTab;
    if (!tab || tab.type !== "filelist") return;
    fileListSnapshotsRef.current[tab.id] = {
      currentPath: panel.currentPath,
      parentNode: panel.parentNode,
      entries: panel.entries,
    };
  }, [activeTab, panel.currentPath, panel.parentNode, panel.entries]);

  const renderPreviewTab = useCallback(
    (tab: Extract<(typeof tabs)[number], { type: "preview" }>) => {
      const isVisible = tab.id === activeTabId;
      if (tab.mode === "editor") {
        const resolvedEditor = editorRegistry.resolve(tab.name);
        if (!resolvedEditor) {
          return (
            <div
              key={tab.id}
              style={{
                display: isVisible ? "block" : "none",
                padding: 16,
                color: "var(--fg-muted, #888)",
                textAlign: "center",
                height: "100%",
              }}
            >
              No editor extension for this file type. Install editor extensions from the extensions panel.
            </div>
          );
        }
        const langId = tab.langId ?? "plaintext";
        return (
          <div key={tab.id} style={{ display: isVisible ? "block" : "none", height: "100%" }}>
            <EditorContainer
              extensionDirPath={resolvedEditor.extensionDirPath}
              entry={resolvedEditor.contribution.entry}
              filePath={tab.path}
              fileName={tab.name}
              langId={langId}
              inline
              visible={isVisible}
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
          </div>
        );
      }

      const resolved = viewerRegistry.resolve(tab.name);
      if (resolved) {
        const quickViewSourcePanel = tab.isTemp ? tab.sourcePanel : undefined;
        return (
          <div key={tab.id} style={{ display: isVisible ? "block" : "none", height: "100%" }}>
            <ViewerContainer
              extensionDirPath={resolved.extensionDirPath}
              entry={resolved.contribution.entry}
              filePath={tab.path}
              fileName={tab.name}
              fileSize={tab.size}
              inline
              visible={isVisible}
              inlineFocusMode={tab.isTemp ? "viewer-first" : "panel-first"}
              onClose={() => handleCloseTab(tab.id)}
              onTabBackToPanel={
                quickViewSourcePanel
                  ? () => {
                      const active = document.activeElement as HTMLElement | null;
                      try {
                        active?.blur?.();
                      } catch {
                        // ignore
                      }
                      setActivePanel(quickViewSourcePanel);
                      focusContext.request("panel");
                      getFileListHandlers(quickViewSourcePanel)?.focus();
                      requestAnimationFrame(() => {
                        getFileListHandlers(quickViewSourcePanel)?.focus();
                      });
                    }
                  : undefined
              }
            />
          </div>
        );
      }

      return (
        <div
          key={tab.id}
          style={{
            display: isVisible ? "block" : "none",
            padding: 16,
            color: "var(--fg-muted, #888)",
            textAlign: "center",
            height: "100%",
          }}
        >
          No viewer extension for this file type. Install viewer extensions from the extensions panel.
        </div>
      );
    },
    [activeTabId, handleCloseTab, setActivePanel, setTabs],
  );

  return (
    <div
      className={cx(styles, "panel", active && "active")}
      onMouseDown={activatePanelFocus}
      onClick={activatePanelFocus}
    >
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
        {tabs
          .filter((tab): tab is Extract<(typeof tabs)[number], { type: "filelist" }> => tab.type === "filelist")
          .map((tab) => {
            const isVisible = tab.id === activeTabId;
            const snapshot = fileListSnapshotsRef.current[tab.id];
            const currentPath = isVisible ? panel.currentPath : (snapshot?.currentPath ?? tab.path);
            const parentNode = isVisible ? panel.parentNode : snapshot?.parentNode;
            const rawEntries = isVisible ? panel.entries : (snapshot?.entries ?? []);
            const tabEntries = showHidden ? rawEntries : rawEntries.filter((e) => !e.meta.hidden);
            return (
              <div key={tab.id} style={{ display: isVisible ? "block" : "none", height: "100%" }}>
                <FileList
                  side={side}
                  currentPath={currentPath}
                  parentNode={parentNode}
                  entries={tabEntries}
                  onNavigate={(path) => {
                    activatePanelFocus();
                    onRememberExpectedTerminalCwd(path);
                    return panel.navigateTo(path);
                  }}
                  selectionKey={selectionKey}
                  active={active && isVisible}
                  resolver={panel.resolver}
                  requestedActiveName={
                    isVisible
                      ? requestedActiveName ?? (initialTabPersisted?.type === "filelist" ? initialTabPersisted.selectedName : undefined)
                      : undefined
                  }
                  requestedTopmostName={
                    isVisible
                      ? requestedTopmostName ?? (initialTabPersisted?.type === "filelist" ? initialTabPersisted.topmostName : undefined)
                      : undefined
                  }
                  onStateChange={isVisible ? onStateChange : undefined}
                />
              </div>
            );
          })}
        {tabs
          .filter((tab): tab is Extract<(typeof tabs)[number], { type: "preview" }> => tab.type === "preview")
          .map(renderPreviewTab)}
      </div>
    </div>
  );
}
