/**
 * Workspace configuration reading.
 *
 * Reads `.dir/settings.json` from workspace roots. A directory is a
 * "workspace" if it contains a `.dir` subfolder, and the workspace
 * config lives at `<root>/.dir/settings.json`.
 *
 * The config is a DotDirSettings object (JSONC) placed inside the
 * `.dir` marker directory. It can declare `"workspace": true` to
 * explicitly signal workspace intent, and `"languages"` to configure
 * per-language LSP server options.
 */

import type { Bridge } from "@dotdirfm/ui-bridge";
import { join } from "@dotdirfm/ui-utils";
import { parse as parseJsonc, type ParseError } from "jsonc-parser";
import type { DotDirSettings, WorkspaceLanguageConfig } from "@/features/settings/types";

/** Name of the dotdir marker folder. */
export const WORKSPACE_MARKER = ".dir";
/** Name of the workspace settings file within `.dir`. */
const SETTINGS_FILE = "settings.json";

/**
 * Cached parse of the workspace config so multiple callers
 * (workspace-sync, settings dialog, lsp manager) don't re-read.
 */
const configCache = new Map<string, DotDirSettings | null>();

export function clearWorkspaceConfigCache(): void {
  configCache.clear();
}

/** Invalidate cache for a single root */
export function invalidateWorkspaceConfig(root: string): void {
  configCache.delete(root);
}

/**
 * Read and parse `.dir/settings.json` at a given workspace root.
 * Returns null if the file doesn't exist or can't be parsed.
 */
export async function readWorkspaceConfig(
  bridge: Bridge,
  root: string,
): Promise<DotDirSettings | null> {
  const cached = configCache.get(root);
  if (cached !== undefined) return cached;

  const settingsPath = join(root, WORKSPACE_MARKER, SETTINGS_FILE);
  try {
    const buf = await bridge.fs.readFile(settingsPath);
    const text = new TextDecoder().decode(buf);
    const errors: ParseError[] = [];
    const parsed = parseJsonc(text, errors, { allowTrailingComma: true });
    if (errors.length > 0) {
      console.warn("[workspaceConfig] parse errors in", settingsPath, errors);
    }
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const cfg = parsed as DotDirSettings;
      configCache.set(root, cfg);
      return cfg;
    }
    configCache.set(root, null);
    return null;
  } catch {
    configCache.set(root, null);
    return null;
  }
}

/**
 * True when the config explicitly declares `"workspace": true`.
 */
export function isWorkspace(config: DotDirSettings | null): boolean {
  return config?.workspace === true;
}

/**
 * Resolve the language config for a given language ID from the
 * workspace config. Falls back to `{ enabled: true }` when the
 * language is listed without specific options.
 */
export function resolveLanguageConfig(
  config: DotDirSettings | null,
  languageId: string,
): WorkspaceLanguageConfig | undefined {
  const langMap = config?.languages;
  if (!langMap) return undefined;
  const entry = langMap[languageId];
  if (!entry) {
    // Check for wildcard pattern: "typescript.*" should match "typescriptreact"
    for (const [key, val] of Object.entries(langMap)) {
      if (key.endsWith(".*")) {
        const prefix = key.slice(0, -2);
        if (languageId === prefix || languageId.startsWith(prefix + ".")) {
          return val;
        }
      }
    }
    return undefined;
  }
  return entry;
}

/**
 * Check whether the workspace config enables LSP for the given language.
 */
export function isLanguageEnabled(
  config: DotDirSettings | null,
  languageId: string,
): boolean {
  const lang = resolveLanguageConfig(config, languageId);
  if (!lang) return false;
  return lang.enabled !== false;
}

/**
 * Get all explicitly configured language IDs from the workspace config.
 */
export function configuredLanguages(
  config: DotDirSettings | null,
): string[] {
  if (!config?.languages) return [];
  return Object.keys(config.languages).filter(
    (k) => config.languages![k]?.enabled !== false,
  );
}
