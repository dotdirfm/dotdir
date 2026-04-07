/**
 * User Settings helpers
 *
 * Watches settings.json in the host-provided config directory.
 */

import type { Bridge } from "@/features/bridge";
import { getAppDirs } from "@/features/bridge/appDirs";
import { readFileText } from "@/features/file-system/fs";
import { createJsoncFileWatcher, type JsoncFileWatcher } from "@/features/file-system/jsoncFileWatcher";
import { dirname, join } from "@/utils/path";
import { applyEdits, modify, parse as parseJsonc, printParseErrorCode, type FormattingOptions, type ModificationOptions, type ParseError } from "jsonc-parser";
import type { DotDirSettings } from "./types";

// 0 disables the limit (allows editing any size file).
export const DEFAULT_EDITOR_FILE_SIZE_LIMIT = 0;

function validateSettings(parsed: unknown): DotDirSettings | null {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    console.error("[userSettings] settings.json must be an object");
    return null;
  }
  return parsed as DotDirSettings;
}

export async function getSettingsPath(bridge: Bridge): Promise<string> {
  const { configDir } = await getAppDirs(bridge);
  return join(configDir, "settings.json");
}

export async function loadUserSettings(bridge: Bridge): Promise<DotDirSettings> {
  try {
    const path = await getSettingsPath(bridge);
    const text = await readFileText(bridge, path);
    const errors: ParseError[] = [];
    const parsed = parseJsonc(text, errors, { allowTrailingComma: true });
    if (errors.length > 0) {
      console.error("[userSettings] Parse errors:");
      for (const err of errors) {
        console.error(`  - ${printParseErrorCode(err.error)} at offset ${err.offset}`);
      }
      return {};
    }
    return validateSettings(parsed) ?? {};
  } catch {
    return {};
  }
}

function getFormattingOptions(text: string): FormattingOptions {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const indentMatch = text.match(/^(?<indent>[ \t]+)\S/m);
  const indent = indentMatch?.groups?.indent ?? "  ";
  const insertSpaces = !indent.includes("\t");
  const tabSize = insertSpaces ? Math.max(indent.length, 1) : 2;
  return { insertSpaces, tabSize, eol };
}

function applySettingsPatch(text: string, partial: Partial<DotDirSettings>): string {
  let nextText = text.trim() ? text : "{}";
  const options: ModificationOptions = { formattingOptions: getFormattingOptions(nextText) };
  for (const [key, value] of Object.entries(partial)) {
    const edits = modify(nextText, [key], value, options);
    nextText = applyEdits(nextText, edits);
  }
  return nextText;
}

export async function saveSettingsPatchToDisk(bridge: Bridge, partial: Partial<DotDirSettings>): Promise<void> {
  try {
    const path = await getSettingsPath(bridge);
    let currentText = "{}";
    try {
      currentText = await readFileText(bridge, path);
    } catch {
      // ignore read errors and start with empty settings
    }
    let nextText: string;
    try {
      nextText = applySettingsPatch(currentText, partial);
    } catch {
      nextText = applySettingsPatch("{}", partial);
    }
    await bridge.fs.createDir(dirname(path));
    await bridge.fs.writeFile(path, nextText);
  } catch (err) {
    console.error("[userSettings] Failed to save settings:", err);
  }
}

export async function createUserSettingsWatcher(bridge: Bridge): Promise<JsoncFileWatcher<DotDirSettings>> {
  return createJsoncFileWatcher<DotDirSettings>(bridge, {
    name: "userSettings",
    getPath: async () => getSettingsPath(bridge),
    validate: validateSettings,
    defaultValue: {},
  });
}
