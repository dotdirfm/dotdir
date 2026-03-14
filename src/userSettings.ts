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
