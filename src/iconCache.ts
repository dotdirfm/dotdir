import { isTauri as isTauriApp } from '@tauri-apps/api/core';
import { DirectoryHandle, FileHandle } from './fsa';
import { bridge } from './bridge';
import { normalizePath } from './path';

const MAX_SIZE = 200;
const isTauri = isTauriApp();

const cache = new Map<string, string>();
const pending = new Map<string, Promise<void>>();
let iconsDirHandle: DirectoryHandle | null = null;

async function ensureIconsDir(): Promise<DirectoryHandle> {
  if (!iconsDirHandle) {
    const iconsPath = await bridge.utils.getIconsPath();
    iconsDirHandle = new DirectoryHandle(iconsPath);
  }
  return iconsDirHandle;
}

function isAbsolutePath(path: string): boolean {
  return path.startsWith('/') || /^[A-Za-z]:/.test(path);
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

async function loadIconAbsolute(path: string): Promise<void> {
  const normalized = normalizePath(path);
  const fileName = normalized.split('/').pop() ?? normalized;
  try {
    const handle = new FileHandle(normalized, fileName);
    const file = await handle.getFile();
    const content = await file.text();
    cache.set(path, svgToDataUrl(content));
    evictIfNeeded();
  } catch (err) {
    console.warn('[IconCache] loadIconAbsolute failed', normalized, err);
    throw err;
  }
}

async function loadIconViaFs(name: string): Promise<void> {
  const dir = await ensureIconsDir();
  const handle = await dir.getFileHandle(name);
  const file = await handle.getFile();
  const content = await file.text();
  cache.set(name, svgToDataUrl(content));
  evictIfNeeded();
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
  return name === '_default' || name.startsWith('_default_');
}

export async function loadIcons(names: string[]): Promise<void> {
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
          await loadIconAbsolute(name);
        } else if (isTauri) {
          await loadIconViaFs(name);
        } else {
          await loadIconViaHttp(name);
        }
      } catch (err) {
        console.warn('[IconCache] loadIcons failed for', name.slice(-60), err);
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

