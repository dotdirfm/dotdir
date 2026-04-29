/**
 * Workspace-root detection + `workspaceContains:<glob>` activation support.
 *
 * A "workspace" in dotdir is any directory that contains a `.dir` subfolder.
 * When the user navigates into such a folder (or any descendant of it),
 * that folder is the workspace root for any panel rooted underneath it.
 *
 * The extension host's `workspaceContains:<glob>` activation event matches the
 * same VS Code semantics: the glob is evaluated relative to the workspace
 * root; if any file/folder in the root matches, the event fires verbatim so
 * extensions can use it as their activation trigger.
 *
 * We keep glob support intentionally narrow but sufficient for the common
 * real-world patterns (e.g. `Cargo.toml`, `*`/`Cargo.toml`, `**`/`*.sln`).
 */

import type { Bridge } from "@dotdirfm/ui-bridge";
import { dirname, isRootPath, join } from "@dotdirfm/ui-utils";

const WORKSPACE_MARKER = ".dir";

/** Max directories visited while evaluating a glob to bound worst-case cost. */
const MAX_DIR_VISITS = 2000;

/**
 * Walk up from `startPath` and return the closest ancestor that contains a
 * `.dir` subfolder, or null if none is found. The input path itself is
 * checked first so navigating *to* a workspace root works immediately.
 */
export async function findWorkspaceRoot(bridge: Bridge, startPath: string): Promise<string | null> {
  if (!startPath) return null;
  let cur = startPath;
  while (true) {
    try {
      if (await bridge.fs.exists(join(cur, WORKSPACE_MARKER))) return cur;
    } catch {
      // Treat errors as "not a workspace here" and keep walking up.
    }
    const parent = dirname(cur);
    if (parent === cur || isRootPath(cur)) return null;
    cur = parent;
  }
}

/**
 * Parse a `workspaceContains:<glob>` activation event value and evaluate the
 * glob against the given workspace root. Supports `*` (non-slash wildcard
 * within a single segment) and `**` (any number of path segments).
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
  // Escape regex metacharacters except `*`, then convert `*` to `.*`.
  const escaped = seg.replace(/[.+^${}()|[\]\\?]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}
