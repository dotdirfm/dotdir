/**
 * Parse and resolve `cd` commands from the command line (handled in-app, not sent to shell).
 *
 * - `cd` / `cd path` — change active panel directory
 * - `cd::name` — save alias `name` → current folder (settings.json)
 * - `cd:name` — navigate to folder saved under alias `name`
 */

import { join, normalizePath, resolveDotSegments } from "@/path";
import { Bridge } from "@/shared/api/bridge";
import { normalizeTerminalPath } from "@/terminal/path";

export type ParsedCdCommand =
  | { kind: "setAlias"; alias: string }
  | { kind: "goAlias"; alias: string }
  | { kind: "chdir"; pathArg: string }
  | { kind: "error"; message: string };

/** Returns null if this is not a `cd` command (should run in terminal). */
export function parseCdCommand(cmd: string): ParsedCdCommand | null {
  const t = cmd.trim();
  if (!t) return null;

  // Must check `cd::` before `cd:`
  if (/^cd::/i.test(t)) {
    const m = t.match(/^cd::\s*(\S+)\s*$/i);
    if (!m) {
      return { kind: "error", message: "Usage: cd::alias — save current folder as alias" };
    }
    return { kind: "setAlias", alias: m[1]! };
  }

  if (/^cd:/i.test(t)) {
    const m = t.match(/^cd:\s*(\S+)\s*$/i);
    if (!m) {
      return { kind: "error", message: "Usage: cd:alias — go to folder saved under alias" };
    }
    return { kind: "goAlias", alias: m[1]! };
  }

  if (/^cd(?:\s|$)/i.test(t) || /^cd$/i.test(t)) {
    const m = t.match(/^cd(?:\s+(.*))?$/i);
    if (!m) return null;
    let pathArg = (m[1] ?? "").trim();
    if ((pathArg.startsWith('"') && pathArg.endsWith('"')) || (pathArg.startsWith("'") && pathArg.endsWith("'"))) {
      pathArg = pathArg.slice(1, -1);
    }
    return { kind: "chdir", pathArg };
  }

  return null;
}

/** Resolve `cd` path argument relative to cwd (empty → home). */
export async function resolveCdPath(bridge: Bridge, pathArg: string, cwd: string): Promise<string> {
  const t = pathArg.trim();
  if (!t) {
    return normalizeTerminalPath(await bridge.utils.getHomePath());
  }

  let p = t;
  if (p.startsWith("~")) {
    const home = await bridge.utils.getHomePath();
    const nh = normalizeTerminalPath(home);
    if (p === "~" || p === "~/") {
      return nh;
    }
    const rest = p.slice(1).replace(/^\//, "");
    p = rest ? join(home, rest) : home;
  }

  const combined = p.startsWith("/") || p.startsWith("//") || /^[A-Za-z]:\//.test(p) || /^[A-Za-z]:$/i.test(p) ? p : join(cwd, p);
  const resolved = resolveDotSegments(normalizePath(combined));
  return normalizeTerminalPath(resolved);
}

/** True if path exists and can be listed as a directory. */
export async function isExistingDirectory(bridge: Bridge, path: string): Promise<boolean> {
  if (!(await bridge.fs.exists(path))) return false;
  try {
    await bridge.fs.entries(path);
    return true;
  } catch {
    return false;
  }
}
