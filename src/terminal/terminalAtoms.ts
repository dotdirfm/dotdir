import { atom } from "jotai";
import type { ManagedTerminalSession } from "./types";

export const terminalSessionsAtom = atom<ManagedTerminalSession[]>([]);
export const terminalActiveSessionIdAtom = atom<string | null>(null);
