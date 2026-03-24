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

/**
 * Resolves `.` and `..` segments (POSIX-style). Does not touch symlinks.
 * Handles Unix absolute paths, Windows `C:/...`, and relative paths.
 */
export function resolveDotSegments(path: string): string {
  const s = collapseSlashes(path.replace(/\\/g, '/'));
  if (!s) return s;

  // Windows: C:/... or C:...
  const win = /^([A-Za-z]):(\/.*)?$/i.exec(s);
  if (win) {
    const drive = win[1]!.toUpperCase();
    const rest = (win[2] ?? '/').replace(/^\//, '');
    const parts = rest.split('/').filter((p) => p !== '');
    const stack = resolveDotStack(parts, true);
    if (stack.length === 0) return `${drive}:/`;
    return `${drive}:/${stack.join('/')}`;
  }

  // UNC //host/share/...
  if (isUncPath(s)) {
    const body = s.slice(2);
    const segments = body.split('/').filter(Boolean);
    if (segments.length < 2) return s;
    const prefix = `//${segments[0]}/${segments[1]}`;
    const tail = segments.slice(2);
    const stack = resolveDotStack(tail, true);
    return stack.length ? `${prefix}/${stack.join('/')}` : prefix;
  }

  const isAbs = s.startsWith('/');
  const body = isAbs ? s.slice(1) : s;
  const parts = body.split('/').filter((p) => p !== '');
  const stack = resolveDotStack(parts, isAbs);
  if (isAbs) {
    return stack.length ? `/${stack.join('/')}` : '/';
  }
  return stack.length ? stack.join('/') : '.';
}

function resolveDotStack(parts: string[], isAbsolute: boolean): string[] {
  const stack: string[] = [];
  for (const part of parts) {
    if (part === '.' || part === '') continue;
    if (part === '..') {
      if (stack.length > 0) {
        stack.pop();
      } else if (!isAbsolute) {
        stack.push('..');
      }
    } else {
      stack.push(part);
    }
  }
  return stack;
}

export function basename(path: string): string {
  const normalized = normalizePath(path);
  if (!normalized || isRootPath(normalized)) return '';

  const trimmed = normalized.replace(/\/+$/, '');
  const index = trimmed.lastIndexOf('/');
  const result = index < 0 ? trimmed : trimmed.slice(index + 1);
  // Strip the container-path separator (null byte) that appears when the path
  // ends at a container root, e.g. "/path/archive.zip\0" → "archive.zip\0" → "archive.zip".
  return result.endsWith('\0') ? result.slice(0, -1) : result;
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

/** Null-byte separator used by container paths (see containerPath.ts). */
const CONTAINER_SEP = '\0';

/**
 * Returns breadcrumb segments for a path. On Windows, first segment is the drive (e.g. "C:").
 * Each segment has a display label and the full path up to that segment (for navigation).
 * Container paths (real-file\0inner-path) produce a mixed breadcrumb: the real ancestors
 * first, then the container-root segment, then the inner-path segments.
 */
export function getBreadcrumbSegments(path: string): { label: string; path: string }[] {
  // Container path: split on the first null byte.
  const sepIdx = path.indexOf(CONTAINER_SEP);
  if (sepIdx >= 0) {
    const hostFile = path.slice(0, sepIdx);
    const inner = path.slice(sepIdx + 1); // may be empty or '/inner/sub'

    // Build the real-path breadcrumbs up to (but not past) the container file.
    const hostSegments = getBreadcrumbSegments(hostFile);
    // Rewrite the last host segment so it navigates to the container root.
    if (hostSegments.length > 0) {
      hostSegments[hostSegments.length - 1] = {
        label: hostSegments[hostSegments.length - 1].label,
        path: hostFile + CONTAINER_SEP,
      };
    }

    // Append inner-path segments.
    if (inner && inner !== '/') {
      const parts = inner.replace(/^\//, '').split('/').filter(Boolean);
      let acc = '';
      for (const part of parts) {
        acc = acc + '/' + part;
        hostSegments.push({ label: part, path: hostFile + CONTAINER_SEP + acc });
      }
    }
    return hostSegments;
  }

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
