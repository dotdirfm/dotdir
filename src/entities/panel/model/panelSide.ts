import type { PanelSide } from "./types";

/** The other file-manager pane. */
export const OPPOSITE_PANEL: Record<PanelSide, PanelSide> = {
  left: "right",
  right: "left",
};

/** Keys under `DotDirUiState` for each pane. */
export const PANEL_SETTINGS_KEY = {
  left: "leftPanel",
  right: "rightPanel",
} as const satisfies Record<PanelSide, "leftPanel" | "rightPanel">;

export const PANEL_SIDES: PanelSide[] = ["left", "right"];
