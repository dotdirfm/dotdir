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

/** Per-window UI state persisted across launches. Not watched — read once on startup. */
export interface DotDirWindowLayout {
  leftPanel?: PanelPersistedState;
  rightPanel?: PanelPersistedState;
  activePanel?: "left" | "right";
}

export interface DotDirUiLayoutIndex {
  windowIds?: string[];
}

export type DotDirWindowState = WindowGeometryState;
