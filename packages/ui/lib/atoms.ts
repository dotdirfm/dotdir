import type { SystemThemeKind } from "@/features/bridge";
import { atom } from "jotai";

export const themesReadyAtom = atom(false);

export const systemThemeAtom = atom<SystemThemeKind>("dark");
export const iconThemeTypeAtom = atom<"fss" | "vscode" | "none">("fss");
export const iconThemeVersionAtom = atom(0);

export const panelsVisibleAtom = atom(true);
export const terminalFocusRequestKeyAtom = atom(0);

export const commandPaletteOpenAtom = atom(false);

export const pathAutocompleteRecentAtom = atom<string[]>([]);
