import type { PanelSide } from "@/entities/panel/model/types";
import { useCommandRegistry } from "@/features/commands/commands";
import {
  CLOSE_TAB,
  EDIT_IN_OPPOSITE_PANEL,
  NEW_TAB,
  OPEN_CURRENT_DIR_IN_OPPOSITE_PANEL_CURRENT_TAB,
  OPEN_CURRENT_DIR_IN_OPPOSITE_PANEL_NEW_TAB,
  OPEN_SELECTED_DIR_IN_OPPOSITE_PANEL_CURRENT_TAB,
  OPEN_SELECTED_DIR_IN_OPPOSITE_PANEL_NEW_TAB,
  PREVIEW_IN_OPPOSITE_PANEL,
} from "@/features/commands/commandIds";
import { OPPOSITE_PANEL } from "@/entities/panel/model/panelSide";
import { createFilelistTab, createPreviewTab } from "@/entities/tab/model/tabsAtoms";
import type { PanelTab } from "@/entities/tab/model/types";
import type { FsNode } from "fss-lang";
import { useEffect, useRef, type Dispatch, type RefObject, type SetStateAction } from "react";

interface UsePanelCommandsArgs {
  active: boolean;
  side: PanelSide;
  activeTabRef: RefObject<PanelTab | null>;
  leftTabsRef: RefObject<PanelTab[]>;
  rightTabsRef: RefObject<PanelTab[]>;
  leftActiveTabIdRef: RefObject<string>;
  rightActiveTabIdRef: RefObject<string>;
  setLeftTabs: Dispatch<SetStateAction<PanelTab[]>>;
  setRightTabs: Dispatch<SetStateAction<PanelTab[]>>;
  setLeftActiveTabId: Dispatch<SetStateAction<string>>;
  setRightActiveTabId: Dispatch<SetStateAction<string>>;
  setActivePanel: Dispatch<SetStateAction<PanelSide>>;
  handleNewTab: () => void;
  handleCloseActiveTab: () => Promise<void>;
  getReusablePreviewSurfaceKey: (mode: "viewer" | "editor", name: string) => string | undefined;
}

export function usePanelCommands(args: UsePanelCommandsArgs): void {
  const commandRegistry = useCommandRegistry();
  const argsRef = useRef(args);
  argsRef.current = args;

  useEffect(() => {
    if (!args.active) return;

    const disposables = [commandRegistry.registerCommand(NEW_TAB, () => argsRef.current.handleNewTab()), commandRegistry.registerCommand(CLOSE_TAB, () => void argsRef.current.handleCloseActiveTab())];

    const register = (id: string, fn: () => void | Promise<void>) => {
      disposables.push(commandRegistry.registerCommand(id, fn));
    };

    register(OPEN_CURRENT_DIR_IN_OPPOSITE_PANEL_CURRENT_TAB, () => {
      const opposite = OPPOSITE_PANEL[argsRef.current.side];
      const fileListTab = argsRef.current.activeTabRef.current?.type === "filelist" ? argsRef.current.activeTabRef.current : null;
      if (!fileListTab) return;
      const path = fileListTab.path;
      const activeOppositeTabIdRef = opposite === "left" ? argsRef.current.leftActiveTabIdRef : argsRef.current.rightActiveTabIdRef;
      const setOppositeTabs = opposite === "left" ? argsRef.current.setLeftTabs : argsRef.current.setRightTabs;
      setOppositeTabs((prev) =>
        prev.map((tab) => (tab.id === activeOppositeTabIdRef.current && tab.type === "filelist" ? { ...tab, path } : tab)),
      );
      argsRef.current.setActivePanel(opposite);
    });

    register(OPEN_CURRENT_DIR_IN_OPPOSITE_PANEL_NEW_TAB, () => {
      const opposite = OPPOSITE_PANEL[argsRef.current.side];
      const fileListTab = argsRef.current.activeTabRef.current?.type === "filelist" ? argsRef.current.activeTabRef.current : null;
      if (!fileListTab) return;
      const newTab = createFilelistTab(fileListTab.path);
      const setOppositeTabs = opposite === "left" ? argsRef.current.setLeftTabs : argsRef.current.setRightTabs;
      const setOppositeActiveTabId = opposite === "left" ? argsRef.current.setLeftActiveTabId : argsRef.current.setRightActiveTabId;
      setOppositeTabs((prev) => [...prev, newTab as PanelTab]);
      setOppositeActiveTabId(newTab.id);
      argsRef.current.setActivePanel(opposite);
    });

    register(OPEN_SELECTED_DIR_IN_OPPOSITE_PANEL_CURRENT_TAB, () => {
      const entry = getSelectedEntry(argsRef.current.activeTabRef.current);
      if (!entry || entry.type !== "folder") return;
      const opposite = OPPOSITE_PANEL[argsRef.current.side];
      const activeOppositeTabIdRef = opposite === "left" ? argsRef.current.leftActiveTabIdRef : argsRef.current.rightActiveTabIdRef;
      const setOppositeTabs = opposite === "left" ? argsRef.current.setLeftTabs : argsRef.current.setRightTabs;
      setOppositeTabs((prev) =>
        prev.map((tab) => (tab.id === activeOppositeTabIdRef.current && tab.type === "filelist" ? { ...tab, path: entry.path as string } : tab)),
      );
      argsRef.current.setActivePanel(opposite);
    });

    register(OPEN_SELECTED_DIR_IN_OPPOSITE_PANEL_NEW_TAB, () => {
      const entry = getSelectedEntry(argsRef.current.activeTabRef.current);
      if (!entry || entry.type !== "folder") return;
      const opposite = OPPOSITE_PANEL[argsRef.current.side];
      const newTab = createFilelistTab(entry.path as string);
      const setOppositeTabs = opposite === "left" ? argsRef.current.setLeftTabs : argsRef.current.setRightTabs;
      const setOppositeActiveTabId = opposite === "left" ? argsRef.current.setLeftActiveTabId : argsRef.current.setRightActiveTabId;
      setOppositeTabs((prev) => [...prev, newTab as PanelTab]);
      setOppositeActiveTabId(newTab.id);
      argsRef.current.setActivePanel(opposite);
    });

    register(PREVIEW_IN_OPPOSITE_PANEL, () => {
      const side = argsRef.current.side;
      const entry = getSelectedEntry(argsRef.current.activeTabRef.current);
      if (!entry || entry.type !== "file") return;
      const opposite = OPPOSITE_PANEL[side];
      const tabs = (opposite === "left" ? argsRef.current.leftTabsRef : argsRef.current.rightTabsRef).current;
      const setOppositeTabs = opposite === "left" ? argsRef.current.setLeftTabs : argsRef.current.setRightTabs;
      const setOppositeActiveTabId = opposite === "left" ? argsRef.current.setLeftActiveTabId : argsRef.current.setRightActiveTabId;
      const tempTab = tabs.find((tab) => tab.type === "preview" && tab.isTemp);
      const path = entry.path as string;
      const name = entry.name;
      const size = Number(entry.meta.size);
      const surfaceKey = argsRef.current.getReusablePreviewSurfaceKey("viewer", name);
      if (tempTab && tempTab.type === "preview") {
        setOppositeTabs((prev) =>
          prev.map((tab) =>
            tab.id === tempTab.id && tab.type === "preview"
              ? { ...tab, path, name, size, surfaceKey: tab.surfaceKey ?? surfaceKey, sourcePanel: side, mode: "viewer", dirty: false }
              : tab,
          ),
        );
        setOppositeActiveTabId(tempTab.id);
      } else {
        const newTab = createPreviewTab(path, name, size, side, { mode: "viewer", surfaceKey });
        setOppositeTabs((prev) => [...prev, newTab as PanelTab]);
        setOppositeActiveTabId(newTab.id);
      }
      argsRef.current.setActivePanel(opposite);
    });

    register(EDIT_IN_OPPOSITE_PANEL, () => {
      const side = argsRef.current.side;
      const entry = getSelectedEntry(argsRef.current.activeTabRef.current);
      if (!entry || entry.type !== "file") return;
      const opposite = OPPOSITE_PANEL[side];
      const tabs = (opposite === "left" ? argsRef.current.leftTabsRef : argsRef.current.rightTabsRef).current;
      const setOppositeTabs = opposite === "left" ? argsRef.current.setLeftTabs : argsRef.current.setRightTabs;
      const setOppositeActiveTabId = opposite === "left" ? argsRef.current.setLeftActiveTabId : argsRef.current.setRightActiveTabId;
      const tempTab = tabs.find((tab) => tab.type === "preview" && tab.isTemp);
      const path = entry.path as string;
      const name = entry.name;
      const size = Number(entry.meta.size);
      const langId = typeof entry.lang === "string" && entry.lang ? entry.lang : "plaintext";
      const surfaceKey = argsRef.current.getReusablePreviewSurfaceKey("editor", name);
      if (tempTab && tempTab.type === "preview") {
        setOppositeTabs((prev) =>
          prev.map((tab) =>
            tab.id === tempTab.id && tab.type === "preview"
              ? { ...tab, path, name, size, surfaceKey: tab.surfaceKey ?? surfaceKey, sourcePanel: side, mode: "editor", langId, dirty: false }
              : tab,
          ),
        );
        setOppositeActiveTabId(tempTab.id);
      } else {
        const newTab = createPreviewTab(path, name, size, side, { mode: "editor", langId, surfaceKey });
        setOppositeTabs((prev) => [...prev, newTab as PanelTab]);
        setOppositeActiveTabId(newTab.id);
      }
      argsRef.current.setActivePanel(opposite);
    });

    return () => {
      for (const dispose of disposables) dispose();
    };
  }, [args.active, commandRegistry]);
}

function getSelectedEntry(tab: PanelTab | null | undefined): FsNode | undefined {
  if (!tab || tab.type !== "filelist") return undefined;
  const selectedName = tab.selectedEntryNames?.[0] ?? tab.activeEntryName;
  return selectedName ? tab.entries?.find((entry) => entry.name === selectedName) : undefined;
}
