function encodePathPreservingSlashes(path: string): string {
  // Encode each segment but keep '/' separators.
  return path
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');
}

/** Build a URL that serves an absolute VFS path. */
export function vfsUrl(absPath: string): string {
  const p = absPath.startsWith('/') ? absPath : `/${absPath}`;

  // Tauri runtime detection (same as main.tsx boot logic).
  const isTauri = '__TAURI_INTERNALS__' in window;

  if (isTauri) {
    // macOS/Linux: `vfs://vfs/<abs path>`
    // Windows: runtime will map scheme to `http(s)://vfs.localhost/...`
    return `vfs://vfs${encodePathPreservingSlashes(p)}`;
  }

  // Web / headless server:
  // `http://localhost:1420/vfs/Users/...` serves `/Users/...`
  const origin = window.location.origin;
  const withoutLeading = p.replace(/^\/+/, '');
  return `${origin}/vfs/${encodePathPreservingSlashes(withoutLeading)}`;
}

