import type { SystemThemeKind } from "@/features/bridge";
import { atom } from "jotai";

export const themesReadyAtom = atom(false);

export const systemThemeAtom = atom<SystemThemeKind>("dark");

export const panelsVisibleAtom = atom(true);

export const commandPaletteOpenAtom = atom(false);

export const pathAutocompleteRecentAtom = atom<string[]>([]);
