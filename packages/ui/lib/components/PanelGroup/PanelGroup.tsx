import type { NestedPopoverMenuHandle, NestedPopoverMenuItem } from "@/components/NestedPopoverMenu/NestedPopoverMenu";
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
import { useShowHidden, useUserSettings } from "@/features/settings/useUserSettings";
import { useFocusContext } from "@/focusContext";
import { cx } from "@/utils/cssModules";
import { basename, dirname } from "@/utils/path";
import { useEditorRegistry, useViewerRegistry } from "@/viewerEditorRegistry";
import type { FsNode } from "fss-lang";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { VscArrowDown, VscArrowUp, VscChevronLeft, VscRegex } from "react-icons/vsc";
import { FileListTabPane } from "../FileListTabPane";
import styles from "./PanelGroup.module.css";
import { usePanelCommands } from "./usePanelCommands";

interface PanelGroupProps {
  side: PanelSide;
}

type ParkedPreviewSurface = {
  reuseKey: string;
  surfaceKey: string;
  mode: "viewer" | "editor";
  extensionDirPath: string;
  entry: string;
  path: string;
  name: string;
  size: number;
  langId?: string;
};

export function PanelGroup({ side }: PanelGroupProps) {
  const bridge = useBridge();
  const editorRegistry = useEditorRegistry();
  const commandRegistry = useCommandRegistry();
  const viewerRegistry = useViewerRegistry();
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
  const { settings } = useUserSettings();

  const { showHidden } = useShowHidden();
  const [activeFileListNavigating, setActiveFileListNavigating] = useState(false);
  const [parkedPreviews, setParkedPreviews] = useState<ParkedPreviewSurface[]>([]);
  const [mountedRoots, setMountedRoots] = useState<string[]>([]);
  const bookmarkEntries = useMemo(
    () =>
      Object.entries(settings.pathAliases ?? {})
        .filter(([, path]) => typeof path === "string" && path.length > 0)
        .sort(([leftAlias], [rightAlias]) => leftAlias.localeCompare(rightAlias)),
    [settings.pathAliases],
  );
  const visibleSortedActiveEntries = useMemo(() => {
    if (!activeTab || activeTab.type !== "filelist") return [];
    const visibleEntries = showHidden ? activeTab.entries : activeTab.entries.filter((entry) => !entry.meta.hidden);
    return [...visibleEntries].sort((left, right) => {
      if (left.type !== right.type) return left.type === "folder" ? -1 : 1;
      return left.name.localeCompare(right.name);
    });
  }, [activeTab, showHidden]);

  const tabsRef = useRef(tabs);
  const menuRef = useRef<NestedPopoverMenuHandle | null>(null);
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
  const parkedPreviewsRef = useRef(parkedPreviews);
  parkedPreviewsRef.current = parkedPreviews;
  const nextPreviewSurfaceIdRef = useRef(0);

  const getResolvedPreviewTarget = useCallback(
    (mode: "viewer" | "editor", name: string) => {
      return mode === "editor" ? editorRegistry.resolve(name) : viewerRegistry.resolve(name);
    },
    [editorRegistry, viewerRegistry],
  );

  const getPreviewReuseKey = useCallback(
    (mode: "viewer" | "editor", extensionDirPath: string, entry: string) => `${mode}:${extensionDirPath}:${entry}`,
    [],
  );

  const getReusablePreviewSurfaceKey = useCallback(
    (mode: "viewer" | "editor", name: string) => {
      const resolved = getResolvedPreviewTarget(mode, name);
      if (!resolved) return undefined;
      const reuseKey = getPreviewReuseKey(mode, resolved.extensionDirPath, resolved.contribution.entry);
      return parkedPreviewsRef.current.find((item) => item.reuseKey === reuseKey)?.surfaceKey;
    },
    [getPreviewReuseKey, getResolvedPreviewTarget],
  );

  const handleSelectTab = useCallback((id: string) => setActiveTabId(id), [setActiveTabId]);
  const handlePinTab = useCallback((id: string) => {
    setTabs((prev) => prev.map((t) => (t.id === id && t.type === "preview" && t.isTemp ? { ...t, isTemp: false } : t)));
  }, [setTabs]);
  const closeTabNow = useCallback(async (id: string) => {
    const currentTabs = tabsRef.current;
    const closingTab = currentTabs.find((tab) => tab.id === id);
    if (closingTab?.type === "preview") {
      const mode = closingTab.mode ?? "viewer";
      const resolved = getResolvedPreviewTarget(mode, closingTab.name);
      if (resolved) {
        const reuseKey = getPreviewReuseKey(mode, resolved.extensionDirPath, resolved.contribution.entry);
        const surfaceKey = closingTab.surfaceKey ?? `preview-surface-${++nextPreviewSurfaceIdRef.current}`;
        setParkedPreviews((prev) => [
          {
            reuseKey,
            surfaceKey,
            mode,
            extensionDirPath: resolved.extensionDirPath,
            entry: resolved.contribution.entry,
            path: closingTab.path,
            name: closingTab.name,
            size: closingTab.size,
            langId: closingTab.langId,
          },
          ...prev.filter((item) => item.reuseKey !== reuseKey && item.surfaceKey !== surfaceKey),
        ]);
      }
    }
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
  }, [bridge, getPreviewReuseKey, getResolvedPreviewTarget, setActiveTabId, setTabs]);
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

  const openFileListTab = useCallback((path: string) => {
    const newTab = createFilelistTab(path);
    setTabs((prev) => [...prev, newTab]);
    setActiveTabId(newTab.id);
  }, [setActiveTabId, setTabs]);

  const openPathInCurrentTab = useCallback((path: string) => {
    setTabs((prev) => {
      const index = prev.findIndex((tab) => tab.id === activeTabIdRef.current);
      if (index < 0) return prev;
      const current = prev[index];
      const next = [...prev];
      next[index] = {
        id: current.id,
        type: "filelist",
        path,
        entries: [],
        selectedEntryNames: [],
      };
      return next;
    });
  }, [setTabs]);

  const quickSearchTo = useCallback((query: string, matchIndex = 0, regexp = false) => {
    const normalizedQuery = query.trim();
    if (!normalizedQuery) return;
    const currentTab = activeTabRef.current;
    if (!currentTab || currentTab.type !== "filelist") return;

    const visibleEntries = (showHidden ? currentTab.entries : currentTab.entries.filter((entry) => !entry.meta.hidden)).slice();
    visibleEntries.sort((left, right) => {
      if (left.type !== right.type) return left.type === "folder" ? -1 : 1;
      return left.name.localeCompare(right.name);
    });
    const matches = regexp
      ? (() => {
          try {
            const re = new RegExp(normalizedQuery, "i");
            return visibleEntries.filter((entry) => re.test(entry.name));
          } catch {
            return [];
          }
        })()
      : visibleEntries.filter((entry) => entry.name.toLowerCase().includes(normalizedQuery.toLowerCase()));
    const match = matches[matchIndex];
    if (!match) return;

    setTabs((prev) => {
      const index = prev.findIndex((tab) => tab.id === activeTabIdRef.current);
      if (index < 0) return prev;
      const tab = prev[index];
      if (!tab || tab.type !== "filelist") return prev;
      const next = [...prev];
      next[index] = {
        ...tab,
        activeEntryName: match.name,
        selectedEntryNames: [],
      };
      return next;
    });
  }, [setTabs, showHidden]);

  const handleNewTab = useCallback(() => {
    const path = getPanelTabDirectoryPath(activeTabRef.current) ?? "";
    openFileListTab(path);
  }, [openFileListTab]);

  const duplicateCurrentTab = useCallback(() => {
    const currentTab = activeTabRef.current;
    if (!currentTab) return;
    const duplicatedTab: PanelTab =
      currentTab.type === "filelist"
        ? {
            ...currentTab,
            id: createFilelistTab(currentTab.path).id,
            entries: [...currentTab.entries],
            selectedEntryNames: [...(currentTab.selectedEntryNames ?? [])],
          }
        : {
            ...currentTab,
            id: createFilelistTab("").id,
          };
    setTabs((prev) => [...prev, duplicatedTab]);
    setActiveTabId(duplicatedTab.id);
  }, [setActiveTabId, setTabs]);

  useEffect(() => {
    let cancelled = false;
    bridge.utils.getMountedRoots()
      .then((roots) => {
        if (!cancelled) setMountedRoots(roots);
      })
      .catch(() => {
        if (!cancelled) setMountedRoots([]);
      });
    return () => {
      cancelled = true;
    };
  }, [bridge]);

  const activatePanelFocus = useCallback(() => {
    setActivePanel(side);
    focusContext.request("panel");
    focusFileList(side);
    requestAnimationFrame(() => {
      focusFileList(side);
    });
  }, [focusContext, focusFileList, setActivePanel, side]);

  const openPanelMenu = useCallback(() => {
    setActivePanel(side);
    menuRef.current?.open();
  }, [setActivePanel, side]);

  useEffect(() => {
    const commandId = side === "left" ? "dotdir.openLeftPanelMenu" : "dotdir.openRightPanelMenu";
    return commandRegistry.registerCommand(commandId, () => {
      openPanelMenu();
    });
  }, [commandRegistry, openPanelMenu, side]);

  const oppositePanelPath = useMemo(() => {
    const oppositeTab =
      side === "left"
        ? rightTabs.find((tab) => tab.id === rightActiveTabId) ?? null
        : leftTabs.find((tab) => tab.id === leftActiveTabId) ?? null;
    return getPanelTabDirectoryPath(oppositeTab);
  }, [leftActiveTabId, leftTabs, rightActiveTabId, rightTabs, side]);

  const menuItems = useMemo<NestedPopoverMenuItem[]>(
    () => [
      {
        id: "duplicate",
        label: "Duplicate Tab",
        onSelect: duplicateCurrentTab,
      },
      {
        id: "go-to",
        label: "Go To",
        items: [
          {
            id: "go-to-opposite",
            label: "Same Path as Opposite Panel",
            disabled: !oppositePanelPath,
            onSelect: oppositePanelPath ? () => openPathInCurrentTab(oppositePanelPath) : undefined,
            onOpenInNewTab: oppositePanelPath ? () => openFileListTab(oppositePanelPath) : undefined,
          },
          {
            id: "go-to-home",
            label: "Home Directory",
            onSelect: async () => {
              openPathInCurrentTab(await bridge.utils.getHomePath());
            },
            onOpenInNewTab: async () => {
              openFileListTab(await bridge.utils.getHomePath());
            },
          },
          ...(bookmarkEntries.length > 0
            ? [
                {
                  id: "go-to-bookmarks-label",
                  label: "Bookmarks",
                  sectionLabel: true,
                } satisfies NestedPopoverMenuItem,
                ...bookmarkEntries.map(
                  ([alias, path]) =>
                    ({
                      id: `go-to-bookmark-${alias}`,
                      label: alias,
                      onSelect: () => openPathInCurrentTab(path),
                      onOpenInNewTab: () => openFileListTab(path),
                    }) satisfies NestedPopoverMenuItem,
                ),
              ]
            : []),
          ...(mountedRoots.length > 0
            ? [
                {
                  id: "go-to-mounted-roots-label",
                  label: "Mounted Drives",
                  sectionLabel: true,
                } satisfies NestedPopoverMenuItem,
                ...mountedRoots.map(
                  (root) =>
                    ({
                      id: `go-to-root-${root}`,
                      label: root,
                      onSelect: () => openPathInCurrentTab(root),
                      onOpenInNewTab: () => openFileListTab(root),
                    }) satisfies NestedPopoverMenuItem,
                ),
              ]
            : []),
        ],
      },
      {
        id: "quick-search",
        label: "Jump To...",
        showHeader: false,
        disabled: activeTab?.type !== "filelist",
        renderView: ({ close, goBack }) => (
          <QuickSearchView
            onBack={goBack}
            entries={visibleSortedActiveEntries}
            onSelectMatch={quickSearchTo}
            onConfirm={() => {
              close();
              requestAnimationFrame(() => {
                void commandRegistry.executeCommand("list.open");
              });
            }}
          />
        ),
      },
    ],
    [activeTab?.type, bookmarkEntries, bridge, commandRegistry, duplicateCurrentTab, mountedRoots, openFileListTab, openPathInCurrentTab, oppositePanelPath, quickSearchTo, visibleSortedActiveEntries],
  );

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
    getReusablePreviewSurfaceKey,
  });

  const livePreviewSurfaceKeys = useMemo(
    () => new Set(tabs.filter((tab): tab is Extract<(typeof tabs)[number], { type: "preview" }> => tab.type === "preview").map((tab) => tab.surfaceKey ?? tab.id)),
    [tabs],
  );

  const renderPreviewTab = useCallback(
    (tab: Extract<(typeof tabs)[number], { type: "preview" }>) => {
      const isVisible = tab.id === activeTabId;
      const surfaceKey = tab.surfaceKey ?? tab.id;
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
            key={surfaceKey}
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
                focusContext.request("panel");
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
            key={surfaceKey}
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
                focusContext.request("panel");
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
    [activeTabId, editorRegistry, focusContext, focusFileList, handleCloseTab, setActivePanel, setActiveTabId, setTabs, side, viewerRegistry],
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
        onReorderTabs={handleReorderTabs}
        menuItems={menuItems}
        menuRef={menuRef}
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
        {parkedPreviews
          .filter((slot) => !livePreviewSurfaceKeys.has(slot.surfaceKey))
          .map((slot) =>
            slot.mode === "editor" ? (
              <div
                key={slot.surfaceKey}
                inert
                style={{ visibility: "hidden", position: "absolute", inset: 0, opacity: 0, pointerEvents: "none" }}
              >
                <EditorContainer
                  extensionDirPath={slot.extensionDirPath}
                  entry={slot.entry}
                  filePath={slot.path}
                  fileName={slot.name}
                  langId={slot.langId ?? "plaintext"}
                  inline
                  visible={false}
                  onClose={() => {}}
                />
              </div>
            ) : (
              <div
                key={slot.surfaceKey}
                inert
                style={{ visibility: "hidden", position: "absolute", inset: 0, opacity: 0, pointerEvents: "none" }}
              >
                <ViewerContainer
                  extensionDirPath={slot.extensionDirPath}
                  entry={slot.entry}
                  filePath={slot.path}
                  fileName={slot.name}
                  fileSize={slot.size}
                  inline
                  visible={false}
                  onClose={() => {}}
                />
              </div>
            ),
          )}
      </div>
    </div>
  );
}

function getSelectedEntry(tab: PanelTab | null | undefined): FsNode | undefined {
  if (!tab || tab.type !== "filelist") return undefined;
  const selectedName = tab.selectedEntryNames?.[0] ?? tab.activeEntryName;
  return selectedName ? tab.entries?.find((entry) => entry.name === selectedName) : undefined;
}

function getPanelTabDirectoryPath(tab: PanelTab | null | undefined): string | null {
  if (!tab) return null;
  if (tab.type === "filelist") return tab.path;
  return dirname(tab.path);
}

function QuickSearchView({
  onBack,
  entries,
  onSelectMatch,
  onConfirm,
}: {
  onBack: () => void;
  entries: FsNode[];
  onSelectMatch: (query: string, matchIndex?: number, regexp?: boolean) => void;
  onConfirm: () => void;
}) {
  const [value, setValue] = useState("");
  const [matchIndex, setMatchIndex] = useState(0);
  const [regexp, setRegexp] = useState(false);

  const getMatches = useCallback(
    (query: string) => {
      const normalized = query.trim();
      if (!normalized) return [];
      if (regexp) {
        try {
          const re = new RegExp(normalized, "i");
          return entries.filter((entry) => re.test(entry.name));
        } catch {
          return [];
        }
      }
      const lower = normalized.toLowerCase();
      return entries.filter((entry) => entry.name.toLowerCase().includes(lower));
    },
    [entries, regexp],
  );

  const moveMatch = useCallback((delta: 1 | -1, query: string, currentIndex: number, useRegexp: boolean) => {
    const matches = getMatches(query);
    if (matches.length === 0) return;
    const nextIndex = (currentIndex + delta + matches.length) % matches.length;
    setMatchIndex(nextIndex);
    onSelectMatch(query, nextIndex, useRegexp);
  }, [getMatches, onSelectMatch]);

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "auto minmax(0, 1fr) auto auto auto",
        gap: 6,
        alignItems: "stretch",
      }}
    >
      <button
        type="button"
        aria-label="Back"
        title="Back"
        style={jumpButtonStyle}
        onClick={onBack}
      >
        <VscChevronLeft aria-hidden />
      </button>
      <input
        autoFocus
        type="text"
        value={value}
        placeholder="Type filename..."
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        style={{
          width: "100%",
          minHeight: 26,
          padding: "4px 6px",
          border: "1px solid var(--border)",
          borderRadius: 2,
          background: "var(--input-bg, var(--bg))",
          color: "var(--fg)",
          boxSizing: "border-box",
        }}
        onChange={(event) => {
          const nextValue = event.target.value;
          setValue(nextValue);
          setMatchIndex(0);
          onSelectMatch(nextValue, 0, regexp);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            onConfirm();
            return;
          }
          if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
          event.preventDefault();
          moveMatch(event.key === "ArrowDown" ? 1 : -1, value, matchIndex, regexp);
        }}
      />
      <button
        type="button"
        aria-label="Previous match"
        title="Previous match"
        style={jumpButtonStyle}
        onClick={() => {
          moveMatch(-1, value, matchIndex, regexp);
        }}
      >
        <VscArrowUp aria-hidden />
      </button>
      <button
        type="button"
        aria-label="Next match"
        title="Next match"
        style={jumpButtonStyle}
        onClick={() => {
          moveMatch(1, value, matchIndex, regexp);
        }}
      >
        <VscArrowDown aria-hidden />
      </button>
      <button
        type="button"
        aria-label="Use regular expression"
        title="Regexp"
        aria-pressed={regexp}
        style={{
          ...jumpButtonStyle,
          background: regexp ? "var(--entry-hover, rgba(255, 255, 255, 0.08))" : "transparent",
        }}
        onClick={() => {
          setRegexp((current) => {
            const next = !current;
            setMatchIndex(0);
            onSelectMatch(value, 0, next);
            return next;
          });
        }}
      >
        <VscRegex aria-hidden />
      </button>
    </div>
  );
}

const jumpButtonStyle: CSSProperties = {
  minWidth: 26,
  minHeight: 26,
  padding: 0,
  border: "1px solid var(--border)",
  borderRadius: 2,
  background: "transparent",
  color: "var(--fg)",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  cursor: "pointer",
};
