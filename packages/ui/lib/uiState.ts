/**
 * UI State persistence
 *
 * Stores UI state (open tabs, active panel) in ~/.dotdir/ui-state.json.
 * Read once on startup; written with a short debounce. Not watched for
 * external changes.
 */

import { readFileText } from "./fs";
import type { DotDirUiState } from "./extensions";
import { join } from "./path";
import { Bridge } from "./shared/api/bridge";

let currentState: DotDirUiState = {};
let statePath: string | null = null;
let saveDebounceTimer: ReturnType<typeof setTimeout> | null = null;

async function getStatePath(bridge: Bridge): Promise<string> {
  if (!statePath) {
    const home = await bridge.utils.getHomePath();
    statePath = join(home, ".dotdir", "ui-state.json");
  }
  return statePath;
}

export async function initUiState(bridge: Bridge): Promise<DotDirUiState> {
  try {
    const path = await getStatePath(bridge);
    const text = await readFileText(bridge, path);
    const parsed = JSON.parse(text);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      currentState = parsed as DotDirUiState;
    }
  } catch {
    // File missing or parse error — start with empty state
  }
  return currentState;
}

export function updateUiState(bridge: Bridge, partial: Partial<DotDirUiState>): void {
  currentState = { ...currentState, ...partial };
  if (saveDebounceTimer) clearTimeout(saveDebounceTimer);
  saveDebounceTimer = setTimeout(() => {
    saveDebounceTimer = null;
    void saveUiStateToDisk(bridge, currentState);
  }, 500);
}

export function flushUiState(bridge: Bridge): void {
  if (saveDebounceTimer) {
    clearTimeout(saveDebounceTimer);
    saveDebounceTimer = null;
  }
  void saveUiStateToDisk(bridge, currentState);
}

async function saveUiStateToDisk(bridge: Bridge, state: DotDirUiState): Promise<void> {
  try {
    const path = await getStatePath(bridge);
    await bridge.fs.writeFile(path, JSON.stringify(state, null, 2));
  } catch (err) {
    console.error("[uiState] Failed to save:", err);
  }
}
