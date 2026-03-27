import { atom } from "jotai";
import { activePanelAtom } from "./atoms";
import type { PanelTab } from "./components/FileList/PanelTabs";
import type { PanelSide } from "./hooks/useFileOperations";

let nextTabId = 0;
export function genTabId(): string {
  return `tab-${++nextTabId}`;
}

export function createFilelistTab(path: string): PanelTab {
  return { id: genTabId(), type: "filelist", path };
}

export function createPreviewTab(path: string, name: string, size: number, sourcePanel: PanelSide): PanelTab {
  return { id: genTabId(), type: "preview", path, name, size, isTemp: true, sourcePanel };
}

const defaultLeftTab = createFilelistTab("");
const defaultRightTab = createFilelistTab("");

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
export const activeTabsAtom = atom((get) => (get(activePanelAtom) === "left" ? get(leftTabsAtom) : get(rightTabsAtom)));
export const activeTabIdAtom = atom((get) => (get(activePanelAtom) === "left" ? get(leftActiveTabIdAtom) : get(rightActiveTabIdAtom)));
export const activeTabIndexAtom = atom((get) => (get(activePanelAtom) === "left" ? get(leftActiveIndexAtom) : get(rightActiveIndexAtom)));
export const activeTabAtom = atom((get) => (get(activePanelAtom) === "left" ? get(leftActiveTabAtom) : get(rightActiveTabAtom)));
