/**
 * User Settings Watcher
 *
 * Watches ~/.dotdir/settings.json for changes and notifies listeners.
 */

import { Bridge } from "@/features/bridge";
import { createJsoncFileWatcher, type JsoncFileWatcher } from "@/jsoncFileWatcher";
import { join } from "@/utils/path";
import type { DotDirSettings } from "./types";

let watcher: JsoncFileWatcher<DotDirSettings> | null = null;
let settingsPath: string | null = null;
let saveDebounceTimer: ReturnType<typeof setTimeout> | null = null;

// 0 disables the limit (allows editing any size file).
export const DEFAULT_EDITOR_FILE_SIZE_LIMIT = 0;

function validateSettings(parsed: unknown): DotDirSettings | null {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    console.error("[userSettings] settings.json must be an object");
    return null;
  }
  return parsed as DotDirSettings;
}

export function getSettings(): DotDirSettings {
  return watcher?.getValue() ?? {};
}

export function updateSettings(bridge: Bridge, partial: Partial<DotDirSettings>): void {
  if (!watcher) return;
  const current = watcher.getValue();
  const updated = { ...current, ...partial };
  // Update watcher's internal value immediately
  watcher.setValue(updated);
  // Debounce save to disk
  if (saveDebounceTimer) clearTimeout(saveDebounceTimer);
  saveDebounceTimer = setTimeout(() => {
    saveDebounceTimer = null;
    saveSettingsToDisk(bridge, updated);
  }, 500);
}

async function saveSettingsToDisk(bridge: Bridge, settings: DotDirSettings): Promise<void> {
  try {
    if (!settingsPath) {
      const homePath = await bridge.utils.getHomePath();
      settingsPath = join(homePath, ".dotdir", "settings.json");
    }
    await bridge.fs.writeFile(settingsPath, JSON.stringify(settings, null, 2));
  } catch (err) {
    console.error("[userSettings] Failed to save settings:", err);
  }
}

export function onSettingsChange(callback: (settings: DotDirSettings) => void): () => void {
  return watcher?.onChange(callback) ?? (() => {});
}

export async function initUserSettings(bridge: Bridge): Promise<DotDirSettings> {
  watcher = await createJsoncFileWatcher<DotDirSettings>(bridge, {
    name: "userSettings",
    getPath: async () => {
      const homePath = await bridge.utils.getHomePath();
      return join(homePath, ".dotdir", "settings.json");
    },
    validate: validateSettings,
    defaultValue: {},
  });
  return watcher.getValue();
}

export async function disposeUserSettings(): Promise<void> {
  await watcher?.dispose();
  watcher = null;
}
