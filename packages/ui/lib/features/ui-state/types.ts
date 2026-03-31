export type PersistedTab =
  | { type: "filelist"; path: string; activeEntryName?: string; topmostEntryName?: string }
  | { type: "preview"; path: string; };

export interface PanelPersistedState {
  tabs?: PersistedTab[];
  activeTabIndex?: number;
}

/** UI state persisted across launches (tabs, active panel). Not watched — read once on startup. */
export interface DotDirUiState {
  leftPanel?: PanelPersistedState;
  rightPanel?: PanelPersistedState;
  activePanel?: "left" | "right";
}
