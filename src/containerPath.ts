/**
 * Container path utilities.
 *
 * A "container path" represents a location inside a file that can be browsed
 * like a directory (e.g. a ZIP archive). The null byte '\0' is used as the
 * separator between the real filesystem path and the inner path, because '\0'
 * cannot appear in real file names on any supported platform.
 *
 * Examples:
 *   /home/user/archive.zip\0           → root of archive.zip
 *   /home/user/archive.zip\0/sub/dir   → /sub/dir inside archive.zip
 *   C:/Users/user/arch.zip\0/inner     → /inner inside arch.zip (Windows)
 *
 * The existing dirname/join/basename functions in path.ts work correctly with
 * container paths because they only manipulate '/' separators — the '\0' passes
 * through untouched.  The only addition required is getBreadcrumbSegments, which
 * splits on '\0' to produce the mixed real-path + inner-path breadcrumb.
 */

export const CONTAINER_SEP = '\0';

/** Returns true if the path refers to a location inside a container file. */
export function isContainerPath(path: string): boolean {
  return path.includes(CONTAINER_SEP);
}

/**
 * Parse a container path into the real container-file path and the inner path.
 * @returns containerFile — real FS path; innerPath — always starts with '/'.
 */
export function parseContainerPath(path: string): { containerFile: string; innerPath: string } {
  const sep = path.indexOf(CONTAINER_SEP);
  if (sep < 0) throw new Error('Not a container path: ' + JSON.stringify(path));
  const containerFile = path.slice(0, sep);
  const after = path.slice(sep + 1);
  const innerPath = after.startsWith('/') ? after : '/' + after;
  return { containerFile, innerPath };
}

/**
 * Build a container path.
 * @param containerFile — real FS path of the container file.
 * @param innerPath — path within the container; '/' means the root.
 */
export function buildContainerPath(containerFile: string, innerPath: string): string {
  // Normalise inner path: always starts with '/', strip trailing '/' unless root.
  let inner = innerPath.startsWith('/') ? innerPath : '/' + innerPath;
  if (inner.length > 1 && inner.endsWith('/')) inner = inner.slice(0, -1);
  return containerFile + CONTAINER_SEP + inner;
}

/**
 * Return the real filesystem path of the outermost container file.
 * For a plain path, returns the path unchanged.
 */
export function containerFile(path: string): string {
  const sep = path.indexOf(CONTAINER_SEP);
  return sep < 0 ? path : path.slice(0, sep);
}

/**
 * Return the inner path from a container path.
 * Returns '/' when at the container root, or the path unchanged for plain paths.
 */
export function containerInner(path: string): string {
  const sep = path.indexOf(CONTAINER_SEP);
  if (sep < 0) return '/';
  const after = path.slice(sep + 1);
  return after || '/';
}
