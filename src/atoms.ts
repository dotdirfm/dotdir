import { atom } from "jotai";
import type { LoadedExtension } from "./extensions";
import type { TerminalProfile } from "./bridge";
import type { ThemeKind } from "fss-lang";

export const showExtensionsAtom = atom(false);
export const activeIconThemeAtom = atom<string | undefined>(undefined);
export const activeColorThemeAtom = atom<string | undefined>(undefined);

export const loadedExtensionsAtom = atom<LoadedExtension[]>([]);
export const themesReadyAtom = atom(false);
export const resolvedProfilesAtom = atom<TerminalProfile[]>([]);
export const terminalProfilesLoadedAtom = atom(false);

export const osThemeAtom = atom<ThemeKind>("dark");

export const panelsVisibleAtom = atom(true);
export const promptActiveAtom = atom(true);
export const terminalFocusRequestKeyAtom = atom(0);
export const requestedTerminalCwdAtom = atom<string | null>(null);

export const commandLineCwdAtom = atom("");
export const commandLineVisibleAtom = atom((get) => get(panelsVisibleAtom) && get(promptActiveAtom));
export const commandLineOnExecuteAtom = atom<((cmd: string) => void) | null>(null);
export const commandLinePasteFnAtom = atom<((text: string) => void) | null>(null);
