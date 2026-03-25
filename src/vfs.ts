function encodePathPreservingSlashes(path: string): string {
  // Encode each segment but keep '/' separators.
  return path
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
}

/**
 * Turn `C:/path` into `/C/path` in the slash-separated form (no `:` inside a segment).
 * Otherwise `encodeURIComponent` turns `C:` into `C%3A`, which is ugly and some stacks
 * pass the encoded segment through to the host without decoding.
 */
function windowsDrivePathToSlashSegments(path: string): string {
  const s = path.replace(/\\/g, "/");
  return s.replace(/(^|\/)([A-Za-z]):(?=\/|$)/g, "$1$2/");
}

/** Build a URL that serves an absolute VFS path. */
export function vfsUrl(absPath: string): string {
  const p = absPath.startsWith("/") ? absPath : `/${absPath}`;

  // Tauri runtime detection (same as main.tsx boot logic).
  const isTauri = "__TAURI_INTERNALS__" in window;

  if (isTauri) {
    // macOS/Linux: `vfs://vfs/<abs path>`
    // Windows (WebView2): use `http://vfs.localhost/...` — the engine maps the registered
    // `vfs` protocol to this host; raw `vfs://` can fail ("no registered handler") for
    // iframe navigations and confuse the OS protocol launcher.
    const isWindows =
      typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent);
    if (isWindows) {
      const forUrl = windowsDrivePathToSlashSegments(p);
      return `http://vfs.localhost${encodePathPreservingSlashes(forUrl)}`;
    }
    return `vfs://vfs${encodePathPreservingSlashes(p)}`;
  }

  // Web / headless server:
  // `http://localhost:1420/vfs/Users/...` serves `/Users/...`
  const origin = window.location.origin;
  const withoutLeading = p.replace(/^\/+/, "");
  return `${origin}/vfs/${encodePathPreservingSlashes(withoutLeading)}`;
}
