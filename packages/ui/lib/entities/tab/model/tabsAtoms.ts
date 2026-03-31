import type { PanelSide } from "@/entities/panel/model/types";
import { atom } from "jotai";
import { dirname, join } from "@/utils/path";
import type { FileListTab, PanelTab } from "./types";

let nextTabId = 0;
export function genTabId(): string {
  return `tab-${++nextTabId}`;
}

export function createFilelistTab(path: string): FileListTab {
  return { id: genTabId(), type: "filelist", path, entries: [], selectedEntryNames: [] };
}

export function createPreviewTab(
  path: string,
  name: string,
  size: number,
  sourcePanel: PanelSide,
  options?: { mode?: "viewer" | "editor"; langId?: string },
): PanelTab {
  return {
    id: genTabId(),
    type: "preview",
    path,
    name,
    size,
    isTemp: true,
    sourcePanel,
    mode: options?.mode ?? "viewer",
    langId: options?.langId,
    dirty: false,
  };
}

const defaultLeftTab = createFilelistTab("");
const defaultRightTab = createFilelistTab("");

export const activePanelSideAtom = atom<PanelSide>("left");

export const leftTabsAtom = atom<PanelTab[]>([defaultLeftTab]);
export const rightTabsAtom = atom<PanelTab[]>([defaultRightTab]);
export const leftActiveTabIdAtom = atom<string>(defaultLeftTab.id);
export const rightActiveTabIdAtom = atom<string>(defaultRightTab.id);

// Derived: active tab index per panel
export const leftActiveIndexAtom = atom((get) => get(leftTabsAtom).findIndex((t) => t.id === get(leftActiveTabIdAtom)));
export const rightActiveIndexAtom = atom((get) => get(rightTabsAtom).findIndex((t) => t.id === get(rightActiveTabIdAtom)));

// Derived: active tab object per panel
export const leftActiveTabAtom = atom((get) => {
  const id = get(leftActiveTabIdAtom);
  return get(leftTabsAtom).find((t) => t.id === id) ?? null;
});
export const rightActiveTabAtom = atom((get) => {
  const id = get(rightActiveTabIdAtom);
  return get(rightTabsAtom).find((t) => t.id === id) ?? null;
});

// Derived: active-panel variants (whichever panel is currently focused)
export const activeTabsAtom = atom((get) => (get(activePanelSideAtom) === "left" ? get(leftTabsAtom) : get(rightTabsAtom)));
export const activeTabIdAtom = atom((get) => (get(activePanelSideAtom) === "left" ? get(leftActiveTabIdAtom) : get(rightActiveTabIdAtom)));
export const activeTabIndexAtom = atom((get) => (get(activePanelSideAtom) === "left" ? get(leftActiveIndexAtom) : get(rightActiveIndexAtom)));

export const activeTabAtom = atom((get) => (get(activePanelSideAtom) === "left" ? get(leftActiveTabAtom) : get(rightActiveTabAtom)));
export const inactiveTabAtom = atom((get) => (get(activePanelSideAtom) === "left" ? get(rightActiveTabAtom) : get(leftActiveTabAtom)));

export const activePathAtom = atom((get) => {
  const tab = get(activeTabAtom);
  if (!tab) return "";
  if (tab.type === "preview") {
    return join(tab.path, tab.name);
  }
  if (!tab.activeEntryName) {
    return tab.path;
  }
  if (tab.activeEntryName === "..") {
    return dirname(tab.path);
  }
  const entry = tab.entries.find((item) => item.name === tab.activeEntryName);
  return ((entry?.path as string | undefined) ?? join(tab.path, tab.activeEntryName));
});

export const activeSelectedPathsAtom = atom((get) => {
  const tab = get(activeTabAtom);
  if (!tab) return [] as string[];
  if (tab.type === "preview") {
    return [join(tab.path, tab.name)];
  }
  const names = tab.selectedEntryNames?.length ? tab.selectedEntryNames : tab.activeEntryName ? [tab.activeEntryName] : [];
  return names.map((name) => {
    if (name === "..") {
      return dirname(tab.path);
    }
    const entry = tab.entries.find((item) => item.name === name);
    return ((entry?.path as string | undefined) ?? join(tab.path, name));
  });
});
