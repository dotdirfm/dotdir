/**
 * Workspace-root detection + `workspaceContains:<glob>` activation support.
 *
 * A "workspace" in DotDir is the nearest current-or-parent directory whose
 * `.dir/settings.json` opts in with `{ "workspace": true }`.
 *
 * The extension host's `workspaceContains:<glob>` activation event matches the
 * same VS Code semantics: the glob is evaluated relative to the workspace
 * root; if any file/folder in the root matches, the event fires verbatim so
 * extensions can use it as their activation trigger.
 *
 * We keep glob support intentionally narrow but sufficient for the common
 * real-world patterns (e.g. `Cargo.toml`, `*`/`Cargo.toml`, `**`/`*.sln`).
 */

import type { Bridge } from "@/features/bridge";
import { readFileText } from "@/features/file-system/fs";
import { dirname, isRootPath, join, normalizePath } from "@/utils/path";
import { parse as parseJsonc, type ParseError } from "jsonc-parser";

const WORKSPACE_MARKER = ".dir";
const WORKSPACE_SETTINGS = "settings.json";
const workspaceRootCache = new Map<string, string | null>();

/** Max directories visited while evaluating a glob to bound worst-case cost. */
const MAX_DIR_VISITS = 2000;

/**
 * Walk up from `startPath` and return the nearest opted-in workspace root, or
 * null if none is found. For files, pass `kind: "file"` so the search starts
 * from the parent directory.
 */
export async function findWorkspaceRoot(bridge: Bridge, startPath: string, kind: "file" | "directory" = "directory"): Promise<string | null> {
  if (!startPath) return null;
  const normalizedStart = normalizePath(startPath);
  const cacheKey = `${kind}:${normalizedStart}`;
  const cached = workspaceRootCache.get(cacheKey);
  if (cached !== undefined) return cached;
  let cur = kind === "file" ? dirname(normalizedStart) : normalizedStart;
  const visited: string[] = [];
  while (true) {
    visited.push(cur);
    const hit = workspaceRootCache.get(`directory:${cur}`);
    if (hit !== undefined) {
      for (const p of visited) workspaceRootCache.set(`directory:${p}`, hit);
      workspaceRootCache.set(cacheKey, hit);
      return hit;
    }
    try {
      if (await isWorkspaceRoot(bridge, cur)) {
        for (const p of visited) workspaceRootCache.set(`directory:${p}`, cur);
        workspaceRootCache.set(cacheKey, cur);
        return cur;
      }
    } catch {
      // Treat errors as "not a workspace here" and keep walking up.
    }
    const parent = dirname(cur);
    if (parent === cur || isRootPath(cur)) {
      for (const p of visited) workspaceRootCache.set(`directory:${p}`, null);
      workspaceRootCache.set(cacheKey, null);
      return null;
    }
    cur = parent;
  }
}

export function clearWorkspaceRootCache(): void {
  workspaceRootCache.clear();
}

async function isWorkspaceRoot(bridge: Bridge, dir: string): Promise<boolean> {
  const settingsPath = join(dir, WORKSPACE_MARKER, WORKSPACE_SETTINGS);
  const text = await readFileText(bridge, settingsPath);
  const errors: ParseError[] = [];
  const parsed = parseJsonc(text, errors, { allowTrailingComma: true });
  if (errors.length > 0 || !parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
  return (parsed as { workspace?: unknown }).workspace === true;
}

/**
 * Parse a `workspaceContains:<glob>` activation event value and evaluate the
 * glob against the given workspace root. Supports common VS Code-style
 * patterns: `*`, `?`, `**`, and simple brace groups like `*.{js,ts}`.
 */
export async function workspaceContainsMatch(bridge: Bridge, root: string, pattern: string): Promise<boolean> {
  const segments = pattern.split("/").filter((s) => s.length > 0);
  if (segments.length === 0) return false;
  const visits = { count: 0 };
  return matchSegments(bridge, root, segments, 0, visits);
}

async function matchSegments(
  bridge: Bridge,
  dir: string,
  segments: string[],
  index: number,
  visits: { count: number },
): Promise<boolean> {
  if (visits.count++ > MAX_DIR_VISITS) return false;
  if (index >= segments.length) return false;
  const seg = segments[index]!;
  const isLast = index === segments.length - 1;

  if (seg === "**") {
    // `**` matches zero or more path segments. First try "zero" (skip it),
    // then descend into each subdirectory with the `**` still in play.
    if (await matchSegments(bridge, dir, segments, index + 1, visits)) return true;
    let entries;
    try {
      entries = await bridge.fs.entries(dir);
    } catch {
      return false;
    }
    for (const entry of entries) {
      if (entry.kind !== "directory" && entry.kind !== "symlink") continue;
      if (await matchSegments(bridge, join(dir, entry.name), segments, index, visits)) return true;
    }
    return false;
  }

  const re = segmentToRegex(seg);
  let entries;
  try {
    entries = await bridge.fs.entries(dir);
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (!re.test(entry.name)) continue;
    if (isLast) return true;
    if (entry.kind === "directory" || entry.kind === "symlink") {
      if (await matchSegments(bridge, join(dir, entry.name), segments, index + 1, visits)) return true;
    }
  }
  return false;
}

function segmentToRegex(seg: string): RegExp {
  let source = "";
  for (let i = 0; i < seg.length; i++) {
    const ch = seg[i]!;
    if (ch === "*") {
      source += ".*";
    } else if (ch === "?") {
      source += ".";
    } else if (ch === "{") {
      const end = seg.indexOf("}", i + 1);
      if (end > i + 1) {
        const alts = seg
          .slice(i + 1, end)
          .split(",")
          .filter(Boolean)
          .map(escapeRegex);
        source += alts.length ? `(?:${alts.join("|")})` : "\\{";
        i = end;
      } else {
        source += "\\{";
      }
    } else {
      source += escapeRegex(ch);
    }
  }
  return new RegExp(`^${source}$`);
}

function escapeRegex(value: string): string {
  return value.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}
