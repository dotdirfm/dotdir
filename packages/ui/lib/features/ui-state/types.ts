export type PersistedTab =
  | { type: "filelist"; path: string; selectedName?: string; topmostName?: string }
  | { type: "preview"; path: string; name: string; size: number };

export interface PanelPersistedState {
  currentPath: string;
  tabs?: PersistedTab[];
  activeTabIndex?: number;
}

/** UI state persisted across launches (tabs, active panel). Not watched — read once on startup. */
export interface DotDirUiState {
  leftPanel?: PanelPersistedState;
  rightPanel?: PanelPersistedState;
  activePanel?: "left" | "right";
}
