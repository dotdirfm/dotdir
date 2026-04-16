/**
 * Extension Settings Store
 *
 * Persists VS Code-style configuration overrides for extensions
 * (the flat `{"yaml.schemas": {...}, "yaml.format.enable": true, ...}`
 * shape produced by `WorkspaceConfiguration.update`) into
 * `dataDir/extensionSettings.json`.
 *
 * On load, the store broadcasts every `(key, value)` pair to the
 * extension host so the worker's configuration cache is populated
 * before any extension activates and reads `workspace.getConfiguration`.
 */

import type { Bridge } from "@/features/bridge";
import { readFileText } from "@/features/file-system/fs";
import { dirname, join } from "@/utils/path";

export type ExtensionSettingsMap = Record<string, unknown>;

export interface ExtensionSettingsTarget {
  target: "global" | "workspace" | "folder";
  section?: string;
  key: string;
  value: unknown;
}

export function getExtensionSettingsPath(dataDir: string): string {
  return join(dataDir, "extensionSettings.json");
}

export class ExtensionSettingsStore {
  private data: ExtensionSettingsMap = {};
  private loaded = false;
  private writeSerializer: Promise<void> = Promise.resolve();

  constructor(
    private bridge: Bridge,
    private dataDir: string,
  ) {}

  async load(): Promise<ExtensionSettingsMap> {
    if (this.loaded) return this.data;
    try {
      const text = await readFileText(this.bridge, getExtensionSettingsPath(this.dataDir));
      const parsed = JSON.parse(text || "{}");
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        this.data = parsed as ExtensionSettingsMap;
      }
    } catch {
      // Missing / unreadable file – start empty.
      this.data = {};
    }
    this.loaded = true;
    return this.data;
  }

  snapshot(): ExtensionSettingsMap {
    return { ...this.data };
  }

  get(fullKey: string): unknown {
    return this.data[fullKey];
  }

  async write({ key, section, value }: ExtensionSettingsTarget): Promise<void> {
    const fullKey = section ? `${section}.${key}` : key;
    if (value === undefined) {
      delete this.data[fullKey];
    } else {
      this.data[fullKey] = value;
    }
    await this.persist();
  }

  private async persist(): Promise<void> {
    const next = (async () => {
      await this.writeSerializer.catch(() => {});
      const path = getExtensionSettingsPath(this.dataDir);
      const text = `${JSON.stringify(this.data, null, 2)}\n`;
      try {
        await this.bridge.fs.createDir(dirname(path));
      } catch {
        // directory may already exist
      }
      await this.bridge.fs.writeFile(path, text);
    })();
    this.writeSerializer = next.catch(() => {});
    await next;
  }
}
