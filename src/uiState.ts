/**
 * UI State persistence
 *
 * Stores UI state (open tabs, active panel) in ~/.faraday/ui-state.json.
 * Read once on startup; written with a short debounce. Not watched for
 * external changes.
 */

import { bridge } from "./bridge";
import { readFileText } from "./fs";
import type { FaradayUiState } from "./extensions";
import { join } from "./path";

let currentState: FaradayUiState = {};
let statePath: string | null = null;
let saveDebounceTimer: ReturnType<typeof setTimeout> | null = null;

async function getStatePath(): Promise<string> {
  if (!statePath) {
    const home = await bridge.utils.getHomePath();
    statePath = join(home, ".faraday", "ui-state.json");
  }
  return statePath;
}

export async function initUiState(): Promise<FaradayUiState> {
  try {
    const path = await getStatePath();
    const text = await readFileText(path);
    const parsed = JSON.parse(text);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      currentState = parsed as FaradayUiState;
    }
  } catch {
    // File missing or parse error — start with empty state
  }
  return currentState;
}

export function updateUiState(partial: Partial<FaradayUiState>): void {
  currentState = { ...currentState, ...partial };
  if (saveDebounceTimer) clearTimeout(saveDebounceTimer);
  saveDebounceTimer = setTimeout(() => {
    saveDebounceTimer = null;
    void saveUiStateToDisk(currentState);
  }, 500);
}

export function flushUiState(): void {
  if (saveDebounceTimer) {
    clearTimeout(saveDebounceTimer);
    saveDebounceTimer = null;
  }
  void saveUiStateToDisk(currentState);
}

async function saveUiStateToDisk(state: FaradayUiState): Promise<void> {
  try {
    const path = await getStatePath();
    await bridge.fs.writeFile(path, JSON.stringify(state, null, 2));
  } catch (err) {
    console.error("[uiState] Failed to save:", err);
  }
}
