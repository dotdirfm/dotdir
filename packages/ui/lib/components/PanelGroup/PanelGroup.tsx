import { PanelTabs } from "@/components/PanelTabs/PanelTabs";
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
import type { PanelTab } from "@/entities/tab/model/types";
import { useBridge } from "@/features/bridge/useBridge";
import { useCommandRegistry } from "@/features/commands/commands";
import { EditorContainer, ViewerContainer } from "@/features/extensions/ExtensionContainer";
import { usePanelControllerRegistry } from "@/features/panels/panelControllers";
import { type FileListPanelController } from "@/features/panels/useFileListPanel";
import { showHiddenAtom } from "@/features/settings/useUserSettings";
import { useFocusContext } from "@/focusContext";
import { cx } from "@/utils/cssModules";
import { basename, dirname } from "@/utils/path";
import { editorRegistry, viewerRegistry } from "@/viewerEditorRegistry";
import type { FsNode } from "fss-lang";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { useCallback, useEffect, useRef, useState } from "react";
import { FileListTabPane } from "../FileListTabPane";
import styles from "./PanelGroup.module.css";
import { usePanelCommands } from "./usePanelCommands";

interface PanelGroupProps {
  side: PanelSide;
}

export function PanelGroup({ side }: PanelGroupProps) {
  const bridge = useBridge();
  const commandRegistry = useCommandRegistry();
  const focusContext = useFocusContext();
  const { focusFileList, registerPanel } = usePanelControllerRegistry();
  const activePanel = useAtomValue(activePanelSideAtom);
  const setActivePanel = useSetAtom(activePanelSideAtom);
  const { showDialog } = useDialog();
  const active = activePanel === side;
  const activeContextKey = side === "left" ? "leftPanelActive" : "rightPanelActive";

  useEffect(() => {
    commandRegistry.setContext(activeContextKey, active);
    return () => {
      commandRegistry.setContext(activeContextKey, false);
    };
  }, [active, activeContextKey, commandRegistry]);

  const [leftTabs, setLeftTabs] = useAtom(leftTabsAtom);
  const [rightTabs, setRightTabs] = useAtom(rightTabsAtom);
  const [leftActiveTabId, setLeftActiveTabId] = useAtom(leftActiveTabIdAtom);
  const [rightActiveTabId, setRightActiveTabId] = useAtom(rightActiveTabIdAtom);
  const [tabs, setTabs] = useAtom(side === "left" ? leftTabsAtom : rightTabsAtom);
  const [activeTabId, setActiveTabId] = useAtom(side === "left" ? leftActiveTabIdAtom : rightActiveTabIdAtom);
  const activeIndex = useAtomValue(side === "left" ? leftActiveIndexAtom : rightActiveIndexAtom);
  const activeTab = tabs[activeIndex];

  const showHidden = useAtomValue(showHiddenAtom);
  const [activeFileListNavigating, setActiveFileListNavigating] = useState(false);

  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const leftTabsRef = useRef(leftTabs);
  leftTabsRef.current = leftTabs;
  const rightTabsRef = useRef(rightTabs);
  rightTabsRef.current = rightTabs;
  const activeTabIdRef = useRef(activeTabId);
  activeTabIdRef.current = activeTabId;
  const leftActiveTabIdRef = useRef(leftActiveTabId);
  leftActiveTabIdRef.current = leftActiveTabId;
  const rightActiveTabIdRef = useRef(rightActiveTabId);
  rightActiveTabIdRef.current = rightActiveTabId;
  const activeTabRef = useRef(activeTab);
  activeTabRef.current = activeTab;

  const handleSelectTab = useCallback((id: string) => setActiveTabId(id), [setActiveTabId]);
  const handlePinTab = useCallback((id: string) => {
    setTabs((prev) => prev.map((t) => (t.id === id && t.type === "preview" && t.isTemp ? { ...t, isTemp: false } : t)));
  }, [setTabs]);
  const closeTabNow = useCallback(async (id: string) => {
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
  }, [bridge, setActiveTabId, setTabs]);
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
  }, [setTabs]);

  useEffect(() => {
    if (activeTab?.type !== "filelist") {
      setActiveFileListNavigating(false);
    }
  }, [activeTab?.type]);

  useEffect(() => {
    if (activeTab?.type !== "filelist") return;

    const entry = getSelectedEntry(activeTab);
    if (!entry || entry.type !== "file") return;

    const opposite = side === "left" ? "right" : "left";
    const setOppositeTabs = opposite === "left" ? setLeftTabs : setRightTabs;
    const oppositeTabsRef = opposite === "left" ? leftTabsRef : rightTabsRef;
    const tempPreview = oppositeTabsRef.current.find(
      (tab) => tab.type === "preview" && tab.isTemp && tab.sourcePanel === side,
    );
    if (!tempPreview || tempPreview.type !== "preview") return;

    const path = entry.path as string;
    const name = entry.name;
    const size = Number(entry.meta.size);
    const langId = typeof entry.lang === "string" && entry.lang ? entry.lang : "plaintext";

    if (
      tempPreview.path === path &&
      tempPreview.name === name &&
      tempPreview.size === size &&
      (tempPreview.mode !== "editor" || tempPreview.langId === langId)
    ) {
      return;
    }

    setOppositeTabs((prev) =>
      prev.map((tab) =>
        tab.id === tempPreview.id && tab.type === "preview"
          ? {
              ...tab,
              path,
              name,
              size,
              langId: tab.mode === "editor" ? langId : tab.langId,
            }
          : tab,
      ),
    );
  }, [activeTab, leftTabsRef, rightTabsRef, setLeftTabs, setRightTabs, side]);

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
          } else if (dirname(tab.path) === path) {
            nextParent = undefined;
            nextActiveEntryName = basename(tab.path);
            nextTopmostEntryName = undefined;
            nextSelectedEntryNames = [];
          } else if (tab.path === dirname(path)) {
            nextParent = {
              ...tab,
              activeEntryName: basename(path),
            };
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
      registerPanel(side, panel);
    },
    [registerPanel, setTabs, side],
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
    focusFileList(side);
    requestAnimationFrame(() => {
      focusFileList(side);
    });
  }, [focusContext, focusFileList, setActivePanel, side]);

  usePanelCommands({
    active,
    side,
    activeTabRef,
    leftTabsRef,
    rightTabsRef,
    leftActiveTabIdRef,
    rightActiveTabIdRef,
    setLeftTabs,
    setRightTabs,
    setLeftActiveTabId,
    setRightActiveTabId,
    setActivePanel,
    handleNewTab,
    handleCloseActiveTab: () => handleCloseTab(activeTabIdRef.current),
  });

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
              onInteract={() => {
                setActivePanel(side);
                setActiveTabId(tab.id);
                focusContext.request("editor");
              }}
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
              onInteract={() => {
                setActivePanel(side);
                setActiveTabId(tab.id);
                focusContext.request("viewer");
              }}
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
                      focusFileList(quickViewSourcePanel);
                      requestAnimationFrame(() => {
                        focusFileList(quickViewSourcePanel);
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
    [activeTabId, focusContext, focusFileList, handleCloseTab, setActivePanel, setActiveTabId, setTabs, side],
  );

  return (
    <div className={cx(styles, "panel", active && "active")} onPointerDownCapture={activatePanelFocus}>
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
                tabState={{
                  activeEntryName: tab.activeEntryName,
                  topmostEntryName: tab.topmostEntryName,
                  selectedEntryNames: tab.selectedEntryNames,
                }}
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

function getSelectedEntry(tab: PanelTab | null | undefined): FsNode | undefined {
  if (!tab || tab.type !== "filelist") return undefined;
  const selectedName = tab.selectedEntryNames?.[0] ?? tab.activeEntryName;
  return selectedName ? tab.entries?.find((entry) => entry.name === selectedName) : undefined;
}
