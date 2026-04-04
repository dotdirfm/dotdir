import type { PanelSide } from "@/entities/panel/model/types";
import type { SystemThemeKind } from "@/features/bridge";
import type { LoadedExtension } from "@/features/extensions/extensions";
import { atom } from "jotai";

export const loadedExtensionsAtom = atom<LoadedExtension[]>([]);
export const themesReadyAtom = atom(false);

export const systemThemeAtom = atom<SystemThemeKind>("dark");
export const iconThemeTypeAtom = atom<"fss" | "vscode" | "none">("fss");
export const iconThemeVersionAtom = atom(0);

export const panelsVisibleAtom = atom(true);
export const terminalFocusRequestKeyAtom = atom(0);

export const commandPaletteOpenAtom = atom(false);
export const viewerFileAtom = atom<{ path: string; name: string; size: number; panel: PanelSide } | null>(null);
export const editorFileAtom = atom<{ path: string; name: string; size: number; langId: string } | null>(null);

export const pathAutocompleteRecentAtom = atom<string[]>([]);
