export type PersistedTab =
  | { type: "filelist"; path: string; activeEntryName?: string; topmostEntryName?: string }
  | { type: "preview"; path: string; };

export interface PanelPersistedState {
  tabs?: PersistedTab[];
  activeTabIndex?: number;
}

export interface WindowGeometryState {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  isMaximized?: boolean;
}

export interface PersistedTerminalSession {
  profileId: string;
}

export interface PersistedTerminalState {
  activeSessionId: string | null;
  sessions: PersistedTerminalSession[];
}

/** Per-window UI state persisted across launches. Not watched — read once on startup. */
export interface DotDirWindowLayout {
  leftPanel?: PanelPersistedState;
  rightPanel?: PanelPersistedState;
  activePanel?: "left" | "right";
  terminalSessions?: PersistedTerminalState;
}

export interface DotDirUiLayoutIndex {
  windowIds?: string[];
}

export type DotDirWindowState = WindowGeometryState;
