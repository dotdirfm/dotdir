import { EditorContainer, ViewerContainer } from "@/components/ExtensionContainer";
import { PanelTabs } from "@/components/FileList/PanelTabs";
import { useDialog } from "@/dialogs/dialogContext";
import type { PanelSide } from "@/entities/panel/model/types";
import {
  activePanelSideAtom,
  createFilelistTab,
  leftActiveIndexAtom,
  leftActiveTabIdAtom,
  leftTabsAtom,
  rightActiveIndexAtom,
  rightActiveTabIdAtom,
  rightTabsAtom,
} from "@/entities/tab/model/tabsAtoms";
import { useBridge } from "@/features/bridge/useBridge";
import { showHiddenAtom } from "@/features/settings/useUserSettings";
import { getFileListHandlers } from "@/fileListHandlers";
import { useFocusContext } from "@/focusContext";
import { type FileListPanelController } from "@/hooks/useFileListPanel";
import { setActivePanelGroupHandlers } from "@/panelGroupHandlers";
import styles from "@/styles/panels.module.css";
import { cx } from "@/utils/cssModules";
import { dirname } from "@/utils/path";
import { editorRegistry, viewerRegistry } from "@/viewerEditorRegistry";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { useCallback, useEffect, useRef, useState } from "react";
import { FileListTabPane } from "./FileListTabPane";

interface PanelGroupProps {
  side: PanelSide;
  selectionKey?: number;
  requestedActiveName?: string;
  requestedTopmostName?: string;
  onActivePanelChange: (panel: FileListPanelController) => void;
}

export function PanelGroup({ side, selectionKey, requestedActiveName, requestedTopmostName, onActivePanelChange }: PanelGroupProps) {
  const focusContext = useFocusContext();
  const activePanel = useAtomValue(activePanelSideAtom);
  const setActivePanel = useSetAtom(activePanelSideAtom);
  const { showDialog } = useDialog();
  const active = activePanel === side;

  const [tabs, setTabs] = useAtom(side === "left" ? leftTabsAtom : rightTabsAtom);
  const [activeTabId, setActiveTabId] = useAtom(side === "left" ? leftActiveTabIdAtom : rightActiveTabIdAtom);
  const activeIndex = useAtomValue(side === "left" ? leftActiveIndexAtom : rightActiveIndexAtom);
  const activeTab = tabs[activeIndex];

  const showHidden = useAtomValue(showHiddenAtom);
  const [activeFileListNavigating, setActiveFileListNavigating] = useState(false);

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
  }, []);
  const handleCloseTab = useCallback(
    async (id: string) => {
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
    },
    [closeTabNow, showDialog],
  );

  const handleReorderTabs = useCallback((fromIndex: number, toIndex: number) => {
    setTabs((prev) => {
      const next = [...prev];
      const [moved] = next.splice(fromIndex, 1);
      next.splice(toIndex, 0, moved);
      return next;
    });
  }, []);

  useEffect(() => {
    if (activeTab?.type !== "filelist") {
      setActiveFileListNavigating(false);
    }
  }, [activeTab?.type]);

  const handleActiveFileListChange = useCallback(
    (panel: FileListPanelController) => {
      setTabs((prev) => {
        const index = prev.findIndex((tab) => tab.id === activeTabIdRef.current);
        if (index < 0) return prev;
        const tab = prev[index];
        if (!tab || tab.type !== "filelist") return prev;

        const { path, entry, entries } = panel.state;
        if (tab.path === path && tab.entry === entry && tab.entries === entries) {
          return prev;
        }

        const pathChanged = tab.path !== path;
        let nextParent = tab.parent;
        let nextActiveEntryName = tab.activeEntryName;
        let nextTopmostEntryName = tab.topmostEntryName;
        let nextSelectedEntryNames = tab.selectedEntryNames;

        if (pathChanged) {
          if (tab.parent?.path === path) {
            nextParent = tab.parent.parent;
            nextActiveEntryName = tab.parent.activeEntryName;
            nextTopmostEntryName = tab.parent.topmostEntryName;
            nextSelectedEntryNames = tab.parent.selectedEntryNames;
          } else if (tab.path === dirname(path)) {
            nextParent = tab;
            nextActiveEntryName = undefined;
            nextTopmostEntryName = undefined;
            nextSelectedEntryNames = [];
          } else {
            nextParent = undefined;
            nextActiveEntryName = undefined;
            nextTopmostEntryName = undefined;
            nextSelectedEntryNames = [];
          }
        }

        const next = [...prev];
        next[index] = {
          ...tab,
          path,
          entry,
          entries,
          parent: nextParent,
          activeEntryName: nextActiveEntryName,
          topmostEntryName: nextTopmostEntryName,
          selectedEntryNames: nextSelectedEntryNames,
        };
        return next;
      });
      setActiveFileListNavigating(panel.navigating);
      onActivePanelChange(panel);
    },
    [onActivePanelChange, setTabs],
  );

  const handleFileListStateChange = useCallback(
    (selectedName: string | undefined, topmostName: string | undefined, selectedNames: string[]) => {
      setTabs((prev) => {
        const index = prev.findIndex((tab) => tab.id === activeTabIdRef.current);
        if (index < 0) return prev;
        const tab = prev[index];
        if (!tab || tab.type !== "filelist") return prev;
        const currentSelected = tab.selectedEntryNames ?? [];
        const sameSelected =
          currentSelected.length === selectedNames.length && currentSelected.every((name, idx) => name === selectedNames[idx]);
        if (tab.activeEntryName === selectedName && tab.topmostEntryName === topmostName && sameSelected) {
          return prev;
        }
        const next = [...prev];
        next[index] = {
          ...tab,
          activeEntryName: selectedName,
          topmostEntryName: topmostName,
          selectedEntryNames: selectedNames,
        };
        return next;
      });
    },
    [setTabs],
  );

  const handleNewTab = useCallback(() => {
    const path = activeTab?.type === "filelist" ? activeTab.path : "";
    const newTab = createFilelistTab(path);
    setTabs((prev) => [...prev, newTab]);
    setActiveTabId(newTab.id);
  }, [activeTab, setTabs, setActiveTabId]);

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
          <div
            key={tab.id}
            inert={!isVisible}
            style={{
              visibility: isVisible ? "visible" : "hidden",
              position: "absolute",
              inset: 0,
              opacity: isVisible ? 1 : 0,
              pointerEvents: isVisible ? "auto" : "none",
            }}
          >
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
          <div
            key={tab.id}
            inert={!isVisible}
            style={{
              visibility: isVisible ? "visible" : "hidden",
              position: "absolute",
              inset: 0,
              opacity: isVisible ? 1 : 0,
              pointerEvents: isVisible ? "auto" : "none",
            }}
          >
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
    <div className={cx(styles, "panel", active && "active")} onMouseDown={activatePanelFocus} onClick={activatePanelFocus}>
      {activeFileListNavigating && <div className={styles["panel-progress"]} />}
      <PanelTabs
        tabs={tabs}
        activeTabId={activeTabId}
        onSelectTab={handleSelectTab}
        onDoubleClickTab={handlePinTab}
        onCloseTab={handleCloseTab}
        onNewTab={handleNewTab}
        onReorderTabs={handleReorderTabs}
      />
      <div className={styles["panel-content"]} style={{ position: "relative" }}>
        {tabs
          .filter((tab): tab is Extract<(typeof tabs)[number], { type: "filelist" }> => tab.type === "filelist")
          .map((tab) => {
            const isVisible = tab.id === activeTabId;
            return (
              <FileListTabPane
                key={tab.id}
                side={side}
                tabId={tab.id}
                path={tab.path}
                visible={isVisible}
                focused={active && isVisible}
                showHidden={showHidden}
                selectionKey={selectionKey}
                requestedActiveName={isVisible ? requestedActiveName : undefined}
                requestedTopmostName={isVisible ? requestedTopmostName : undefined}
                onStateChange={isVisible ? handleFileListStateChange : undefined}
                onActivatePanelFocus={activatePanelFocus}
                onActivePanelChange={handleActiveFileListChange}
              />
            );
          })}
        {tabs.filter((tab): tab is Extract<(typeof tabs)[number], { type: "preview" }> => tab.type === "preview").map(renderPreviewTab)}
      </div>
    </div>
  );
}
