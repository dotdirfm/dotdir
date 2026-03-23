/**
 * User Settings Watcher
 * 
 * Watches ~/.faraday/settings.json for changes and notifies listeners.
 */

import { bridge } from './bridge';
import { createJsoncFileWatcher, type JsoncFileWatcher } from './jsoncFileWatcher';
import { join } from './path';
import type { FaradaySettings } from './extensions';

let watcher: JsoncFileWatcher<FaradaySettings> | null = null;
let settingsPath: string | null = null;
let saveDebounceTimer: ReturnType<typeof setTimeout> | null = null;

function validateSettings(parsed: unknown): FaradaySettings | null {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    console.error('[userSettings] settings.json must be an object');
    return null;
  }
  return parsed as FaradaySettings;
}

export function getSettings(): FaradaySettings {
  return watcher?.getValue() ?? {};
}

export function updateSettings(partial: Partial<FaradaySettings>): void {
  if (!watcher) return;
  const current = watcher.getValue();
  const updated = { ...current, ...partial };
  // Update watcher's internal value immediately
  watcher.setValue(updated);
  // Debounce save to disk
  if (saveDebounceTimer) clearTimeout(saveDebounceTimer);
  saveDebounceTimer = setTimeout(() => {
    saveDebounceTimer = null;
    saveSettingsToDisk(updated);
  }, 500);
}

async function saveSettingsToDisk(settings: FaradaySettings): Promise<void> {
  try {
    if (!settingsPath) {
      const homePath = await bridge.utils.getHomePath();
      settingsPath = join(homePath, '.faraday', 'settings.json');
    }
    await bridge.fs.writeFile(settingsPath, JSON.stringify(settings, null, 2));
  } catch (err) {
    console.error('[userSettings] Failed to save settings:', err);
  }
}

export function onSettingsChange(callback: (settings: FaradaySettings) => void): () => void {
  return watcher?.onChange(callback) ?? (() => {});
}

export async function initUserSettings(): Promise<FaradaySettings> {
  watcher = await createJsoncFileWatcher<FaradaySettings>({
    name: 'userSettings',
    getPath: async () => {
      const homePath = await bridge.utils.getHomePath();
      return join(homePath, '.faraday', 'settings.json');
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
