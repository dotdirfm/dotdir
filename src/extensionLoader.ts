/**
 * Extension loader — reads the extension entry script from disk and returns a blob URL.
 * No iframes, no custom protocols. The host loads the script in the main window and
 * the extension renders into a provided mount root.
 */

import { bridge } from './bridge';
import { join, normalizePath } from './path';

/** Normalize entry to a relative path (e.g. "./viewer.js" -> "viewer.js"). */
function normalizeEntryPath(entry: string): string {
  const n = normalizePath(entry.replace(/^\.\//, ''));
  return n || 'index.js';
}

/**
 * Read the extension entry file and return a blob URL for the script.
 * Caller must revoke the URL when done (e.g. when extension is disposed or cache cleared).
 */
export async function getExtensionScriptUrl(
  extensionDirPath: string,
  entry: string,
): Promise<{ scriptUrl: string }> {
  const entryRel = normalizeEntryPath(entry);
  const fullPath = join(extensionDirPath, entryRel);
  const fd = await bridge.fsa.open(fullPath);
  try {
    const stat = await bridge.fsa.stat(fullPath);
    const buf = await bridge.fsa.read(fd, 0, Math.max(0, Math.floor(stat.size)));
    const content = new TextDecoder().decode(buf);
    const blob = new Blob([content], { type: 'application/javascript' });
    const scriptUrl = URL.createObjectURL(blob);
    return { scriptUrl };
  } finally {
    await bridge.fsa.close(fd);
  }
}
