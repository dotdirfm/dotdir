import type { PanelSide } from "@/entities/panel/model/types";
import { TerminalProfile } from "@/features/bridge";
import type { LoadedExtension } from "@/features/extensions/extensions";
import type { ThemeKind } from "fss-lang";
import { atom } from "jotai";

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

export const activePanelAtom = atom<PanelSide>("left");
export const showHiddenAtom = atom(false);
export const commandPaletteOpenAtom = atom(false);
export const viewerFileAtom = atom<{ path: string; name: string; size: number; panel: PanelSide } | null>(null);
export const editorFileAtom = atom<{ path: string; name: string; size: number; langId: string } | null>(null);

export const commandLineCwdAtom = atom("");
export const commandLineOnExecuteAtom = atom<((cmd: string) => void) | null>(null);
export const commandLinePasteFnAtom = atom<((text: string) => void) | null>(null);
