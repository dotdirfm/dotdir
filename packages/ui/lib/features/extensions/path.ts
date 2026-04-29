// Path utilities for the extension host worker.
// Local copy since the worker can't import from @dotdirfm/ui-utils.

const DRIVE_PREFIX_RE = /^[A-Za-z]:$/;
const DRIVE_ROOT_RE = /^[A-Za-z]:\/$/;

function isUncPath(path: string): boolean {
  return path.startsWith("//");
}

function collapseSlashes(path: string): string {
  if (isUncPath(path)) {
    return `//${path.slice(2).replace(/\/+/g, "/")}`;
  }
  return path.replace(/\/+/g, "/");
}

function isAbsolutePath(path: string): boolean {
  return path.startsWith("/") || isUncPath(path) || /^[A-Za-z]:\//.test(path);
}

function isRootPath(path: string): boolean {
  const normalized = normalizePath(path);
  return normalized === "/" || DRIVE_ROOT_RE.test(normalized) || isUncRoot(normalized);
}

function isUncRoot(path: string): boolean {
  const normalized = normalizePath(path);
  if (!isUncPath(normalized)) return false;
  const parts = normalized.slice(2).split("/").filter(Boolean);
  return parts.length === 2;
}

export function normalizePath(path: string): string {
  if (!path) return path;

  let normalized = collapseSlashes(path.replace(/\\/g, "/"));

  // Remove . and ./ segments
  normalized = normalized.replace(/\/\.\//g, "/").replace(/^\.\//, "");
  if (normalized.endsWith("/.")) normalized = normalized.slice(0, -2);

  if (DRIVE_PREFIX_RE.test(normalized)) {
    normalized = `${normalized}/`;
  }

  if (normalized.length > 1 && normalized.endsWith("/") && !DRIVE_ROOT_RE.test(normalized)) {
    normalized = normalized.replace(/\/+$/, "");
  }

  return normalized;
}

export function dirname(path: string): string {
  const normalized = normalizePath(path);
  if (!normalized) return ".";
  if (isRootPath(normalized)) return normalized;

  const trimmed = normalized.replace(/\/+$/, "");
  const index = trimmed.lastIndexOf("/");

  if (index < 0) return ".";
  if (index === 0) return "/";

  const parent = trimmed.slice(0, index);
  if (DRIVE_PREFIX_RE.test(parent)) return `${parent}/`;
  return parent || "/";
}

export function join(...parts: string[]): string {
  let result = "";

  for (const part of parts) {
    if (!part) continue;
    const normalized = normalizePath(part);

    if (!result || isAbsolutePath(normalized)) {
      result = normalized;
      continue;
    }

    result = normalizePath(`${result.replace(/\/+$/, "")}/${normalized.replace(/^\/+/, "")}`);
  }

  return result;
}