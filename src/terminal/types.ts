export type TerminalShellType = 'bash' | 'zsh' | 'sh' | 'cmd' | 'powershell' | 'unknown';

export type TerminalSessionStatus = 'idle' | 'starting' | 'running' | 'exited' | 'error';

export interface PtyLaunchInfo {
  ptyId: number;
  cwd: string;
  shell: string;
  profileId: string;
  profileLabel: string;
}

export interface TerminalCapabilities {
  shellType: TerminalShellType;
  cwd: string;
  profileId: string | null;
  hasOsc7Cwd: boolean;
  promptReady: boolean;
  commandRunning: boolean;
  lastCommand: string | null;
}

export type TerminalSessionEvent =
  | { type: 'data'; data: string }
  | { type: 'launch'; launch: PtyLaunchInfo }
  | { type: 'cwd'; cwd: string }
  | { type: 'sync-start'; cwd: string }
  | { type: 'sync-complete'; cwd: string | null }
  | { type: 'status'; status: TerminalSessionStatus; error?: string }
  | { type: 'capabilities'; capabilities: TerminalCapabilities }
  | { type: 'command-start'; command: string }
  | { type: 'command-finish'; command: string | null };
