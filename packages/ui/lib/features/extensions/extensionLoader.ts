/**
 * Extension loader — reads the extension entry script from disk and returns a blob URL.
 * No iframes, no custom protocols. The host loads the script in the main window and
 * the extension renders into a provided mount root.
 */

import type { Bridge } from "@dotdirfm/ui-bridge";
import { readFileText } from "@/features/file-system/fs";
import { join, normalizePath } from "@dotdirfm/ui-utils";

/** Normalize entry to a relative path (e.g. "./viewer.js" -> "viewer.js"). */
function normalizeEntryPath(entry: string): string {
  const n = normalizePath(entry.replace(/^\.\//, ""));
  return n || "index.js";
}

/**
 * Read the extension entry file and return a blob URL for the script.
 * Caller must revoke the URL when done (e.g. when extension is disposed or cache cleared).
 */
export async function getExtensionScriptUrl(bridge: Bridge, extensionDirPath: string, entry: string): Promise<{ scriptUrl: string }> {
  const entryRel = normalizeEntryPath(entry);
  const fullPath = join(extensionDirPath, entryRel);
  const content = await readFileText(bridge, fullPath);
  const blob = new Blob([content], { type: "application/javascript" });
  const scriptUrl = URL.createObjectURL(blob);
  return { scriptUrl };
}
