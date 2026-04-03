import type { Bridge } from "@/features/bridge";
import { readFileBuffer } from "@/features/file-system/fs";
import { normalizePath } from "@/utils/path";

const MAX_SIZE = 200;

const cache = new Map<string, string>();
const pending = new Map<string, Promise<void>>();

function isAbsolutePath(path: string): boolean {
  return path.startsWith("/") || /^[A-Za-z]:/.test(path);
}

function svgToDataUrl(svg: string): string {
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

function touchKey(key: string): void {
  const value = cache.get(key);
  if (value !== undefined) {
    cache.delete(key);
    cache.set(key, value);
  }
}

function evictIfNeeded(): void {
  while (cache.size > MAX_SIZE) {
    const oldest = cache.keys().next().value!;
    cache.delete(oldest);
  }
}

async function loadIconAbsolute(bridge: Bridge, path: string): Promise<void> {
  const normalized = normalizePath(path);
  try {
    const content = new Uint8Array(await readFileBuffer(bridge, normalized));
    const ext = normalized.split(".").pop()?.toLowerCase() ?? "";
    let url: string;
    if (ext === "svg") {
      url = svgToDataUrl(new TextDecoder().decode(content));
    } else {
      const mime =
        ext === "png"
          ? "image/png"
          : ext === "jpg" || ext === "jpeg"
            ? "image/jpeg"
            : ext === "webp"
              ? "image/webp"
              : "application/octet-stream";
      const base64 = btoa(String.fromCharCode(...content));
      url = `data:${mime};base64,${base64}`;
    }
    cache.set(path, url);
    evictIfNeeded();
  } catch (err) {
    console.warn("[IconCache] loadIconAbsolute failed", normalized, err);
    throw err;
  }
}

async function loadIconViaHttp(name: string): Promise<void> {
  const resp = await fetch(`/icons/${name}`);
  if (!resp.ok) return;
  const svg = await resp.text();
  cache.set(name, svgToDataUrl(svg));
  evictIfNeeded();
}

/** Sentinel paths that are fallbacks, not real icon files - skip loading to avoid ENOENT. */
function isSentinelIconPath(name: string): boolean {
  return name === "_default" || name.startsWith("_default_");
}

export async function loadIcons(bridge: Bridge, names: string[]): Promise<void> {
  const promises: Promise<void>[] = [];

  for (const name of names) {
    if (isSentinelIconPath(name)) continue;
    if (cache.has(name)) continue;

    if (pending.has(name)) {
      promises.push(pending.get(name)!);
      continue;
    }

    const p = (async () => {
      try {
        if (isAbsolutePath(name)) {
          await loadIconAbsolute(bridge, name);
        } else {
          await loadIconViaHttp(name);
        }
      } catch (err) {
        console.warn("[IconCache] loadIcons failed for", name.slice(-60), err);
      } finally {
        pending.delete(name);
      }
    })();
    pending.set(name, p);
    promises.push(p);
  }

  await Promise.all(promises);
}

export function getCachedIconUrl(name: string): string | undefined {
  const url = cache.get(name);
  if (url !== undefined) {
    touchKey(name);
  }
  return url;
}
