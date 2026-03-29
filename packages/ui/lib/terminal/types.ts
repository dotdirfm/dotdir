import { TerminalProfile } from "@/features/bridge";
import type { TerminalSession } from "./TerminalSession";

export type TerminalSessionStatus = "idle" | "starting" | "running" | "exited" | "error";

export interface ManagedTerminalSession {
  id: string;
  session: TerminalSession;
  profile: TerminalProfile;
  profileId: string;
  profileLabel: string;
  cwd: string;
  cwdUserInitiated: boolean;
  status: TerminalSessionStatus;
  error?: string;
}

export interface PtyLaunchInfo {
  ptyId: number;
  cwd: string;
  shell: string;
}

export interface TerminalCapabilities {
  cwd: string;
  profileId: string | null;
  hasOsc7Cwd: boolean;
  /** .dir OSC 779 (prompt / command finished) seen at least once. */
  hasDotDirOsc: boolean;
  promptReady: boolean;
  commandRunning: boolean;
  lastCommand: string | null;
}

export type TerminalSessionEvent =
  | { type: "data"; data: string }
  | { type: "launch"; launch: PtyLaunchInfo }
  | { type: "cwd"; cwd: string; userInitiated: boolean }
  | { type: "status"; status: TerminalSessionStatus; error?: string }
  | { type: "capabilities"; capabilities: TerminalCapabilities }
  | { type: "command-start"; command: string }
  | { type: "command-finish"; command: string | null };
