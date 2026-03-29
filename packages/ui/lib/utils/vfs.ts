import { createContext, useContext } from "react";

export type VfsUrlKind = "file" | "extension-directory";
export type VfsUrlResolver = (absPath: string, kind?: VfsUrlKind) => string;

const resolverStack: VfsUrlResolver[] = [];
export const VfsUrlResolverContext = createContext<VfsUrlResolver | null>(null);

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

function buildVirtualPath(absPath: string, kind: VfsUrlKind): string {
  const p = absPath.startsWith("/") ? absPath : `/${absPath}`;
  return kind === "extension-directory" ? `/_ext${p}` : p;
}

/** Build a URL that serves an absolute VFS path. */
export const defaultResolveVfsUrl: VfsUrlResolver = (absPath, kind = "file") => {
  const vfsPath = buildVirtualPath(absPath, kind);

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
      const forUrl = windowsDrivePathToSlashSegments(vfsPath);
      return `http://vfs.localhost${encodePathPreservingSlashes(forUrl)}`;
    }
    return `vfs://vfs${encodePathPreservingSlashes(vfsPath)}`;
  }

  // Web / headless server:
  // `http://localhost:1420/vfs/Users/...` serves `/Users/...`
  const origin = window.location.origin;
  const withoutLeading = vfsPath.replace(/^\/+/, "");
  return `${origin}/vfs/${encodePathPreservingSlashes(withoutLeading)}`;
};

function getVfsUrlResolver(): VfsUrlResolver {
  return resolverStack[resolverStack.length - 1] ?? defaultResolveVfsUrl;
}

export function pushVfsUrlResolver(resolver: VfsUrlResolver): () => void {
  resolverStack.push(resolver);
  return () => {
    const idx = resolverStack.lastIndexOf(resolver);
    if (idx >= 0) resolverStack.splice(idx, 1);
  };
}

export function resolveVfsUrl(absPath: string, kind: VfsUrlKind = "file"): string {
  return getVfsUrlResolver()(absPath, kind);
}

export function resolveExtensionDirVfsUrl(absPath: string): string {
  return resolveVfsUrl(absPath, "extension-directory");
}

export function useVfsUrlResolver(): VfsUrlResolver {
  return useContext(VfsUrlResolverContext) ?? defaultResolveVfsUrl;
}
