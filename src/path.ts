const DRIVE_PREFIX_RE = /^[A-Za-z]:$/;
const DRIVE_ROOT_RE = /^[A-Za-z]:\/$/;

function isUncPath(path: string): boolean {
  return path.startsWith('//');
}

function collapseSlashes(path: string): string {
  if (isUncPath(path)) {
    return `//${path.slice(2).replace(/\/+/g, '/')}`;
  }
  return path.replace(/\/+/g, '/');
}

function isAbsolutePath(path: string): boolean {
  return path.startsWith('/') || isUncPath(path) || /^[A-Za-z]:\//.test(path);
}

export function normalizePath(path: string): string {
  if (!path) return path;

  let normalized = collapseSlashes(path.replace(/\\/g, '/'));

  // Remove . and ./ segments so paths resolve on all platforms (e.g. .../ext/./icons/file.svg)
  normalized = normalized.replace(/\/\.\//g, '/').replace(/^\.\//, '');
  if (normalized.endsWith('/.')) normalized = normalized.slice(0, -2);

  if (DRIVE_PREFIX_RE.test(normalized)) {
    normalized = `${normalized}/`;
  }

  if (normalized.length > 1 && normalized.endsWith('/') && !DRIVE_ROOT_RE.test(normalized)) {
    normalized = normalized.replace(/\/+$/, '');
  }

  return normalized;
}

export function isUncRoot(path: string): boolean {
  const normalized = normalizePath(path);
  if (!isUncPath(normalized)) return false;
  const parts = normalized.slice(2).split('/').filter(Boolean);
  return parts.length === 2;
}

export function isRootPath(path: string): boolean {
  const normalized = normalizePath(path);
  return normalized === '/' || DRIVE_ROOT_RE.test(normalized) || isUncRoot(normalized);
}

export function dirname(path: string): string {
  const normalized = normalizePath(path);
  if (!normalized) return '.';
  if (isRootPath(normalized)) return normalized;

  const trimmed = normalized.replace(/\/+$/, '');
  const index = trimmed.lastIndexOf('/');

  if (index < 0) return '.';
  if (index === 0) return '/';

  const parent = trimmed.slice(0, index);
  if (DRIVE_PREFIX_RE.test(parent)) return `${parent}/`;
  return parent || '/';
}

export function join(...parts: string[]): string {
  let result = '';

  for (const part of parts) {
    if (!part) continue;
    const normalized = normalizePath(part);

    if (!result || isAbsolutePath(normalized)) {
      result = normalized;
      continue;
    }

    result = normalizePath(`${result.replace(/\/+$/, '')}/${normalized.replace(/^\/+/, '')}`);
  }

  return result;
}

export function basename(path: string): string {
  const normalized = normalizePath(path);
  if (!normalized || isRootPath(normalized)) return '';

  const trimmed = normalized.replace(/\/+$/, '');
  const index = trimmed.lastIndexOf('/');
  return index < 0 ? trimmed : trimmed.slice(index + 1);
}

/** Executable extensions when mode has no execute bits (e.g. Windows). */
const EXECUTABLE_EXTENSIONS = new Set([
  '.exe', '.com', '.bat', '.cmd', '.msi', '.scr', '.ps1', '.vbs', '.js', '.wsf',
]);

/**
 * Returns whether a file should be treated as executable.
 * Uses mode bits (Unix) and/or executable extension (Windows and fallback).
 */
export function isFileExecutable(mode: number, fileName: string): boolean {
  if ((mode & 0o111) !== 0) return true;
  const i = fileName.lastIndexOf('.');
  if (i < 0) return false;
  const ext = fileName.slice(i).toLowerCase();
  return EXECUTABLE_EXTENSIONS.has(ext);
}

/**
 * Returns breadcrumb segments for a path. On Windows, first segment is the drive (e.g. "C:").
 * Each segment has a display label and the full path up to that segment (for navigation).
 */
export function getBreadcrumbSegments(path: string): { label: string; path: string }[] {
  const normalized = normalizePath(path);
  if (!normalized) return [];

  const segments: { label: string; path: string }[] = [];

  // Windows: drive root as first segment (label "C:" so separator adds backslash; "C:\" when alone)
  if (/^[A-Za-z]:\//.test(normalized)) {
    const driveRoot = normalized.slice(0, 3); // "C:/"
    const rest = normalized.slice(3);
    const driveLabel = rest ? normalized.slice(0, 2) : driveRoot.replace('/', '\\'); // "C:" or "C:\"
    segments.push({ label: driveLabel, path: driveRoot });
    if (!rest) return segments;
    const names = rest.split('/').filter(Boolean);
    let acc = driveRoot;
    for (const name of names) {
      acc = acc.replace(/\/?$/, '') + '/' + name;
      segments.push({ label: name, path: acc });
    }
    return segments;
  }

  // UNC: //host/share/...
  if (isUncPath(normalized)) {
    const afterSlash = normalized.slice(2).replace(/\/+$/, '');
    const parts = afterSlash.split('/').filter(Boolean);
    if (parts.length >= 2) {
      segments.push({ label: '\\\\' + parts[0] + '\\' + parts[1], path: '//' + parts[0] + '/' + parts[1] });
      let acc = '//' + parts[0] + '/' + parts[1];
      for (let i = 2; i < parts.length; i++) {
        acc = acc + '/' + parts[i];
        segments.push({ label: parts[i], path: acc });
      }
    }
    return segments;
  }

  // Unix absolute
  if (normalized.startsWith('/')) {
    segments.push({ label: '/', path: '/' });
    const names = normalized.slice(1).split('/').filter(Boolean);
    let acc = '/';
    for (const name of names) {
      acc = acc.replace(/\/?$/, '') + '/' + name;
      segments.push({ label: name, path: acc });
    }
    return segments;
  }

  // Relative path
  const names = normalized.split('/').filter(Boolean);
  let acc = '';
  for (const name of names) {
    acc = acc ? acc + '/' + name : name;
    segments.push({ label: name, path: acc });
  }
  return segments;
}
