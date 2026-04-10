import type { Bridge } from "@/features/bridge";
import { bridgeAtom } from "@/features/bridge/useBridge";
import { readFileBuffer } from "@/features/file-system/fs";
import { normalizePath } from "@/utils/path";
import { atom, useAtomValue } from "jotai";
import { useCallback, useSyncExternalStore } from "react";

const MAX_SIZE = 200;

function isAbsolutePath(path: string): boolean {
  return path.startsWith("/") || /^[A-Za-z]:/.test(path);
}

function svgToDataUrl(svg: string): string {
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

export class IconAssetStore {
  private cache = new Map<string, string>();
  private pending = new Map<string, Promise<void>>();
  private listeners = new Map<string, Set<() => void>>();

  constructor(private bridge: Bridge) {}

  private touchKey(key: string): void {
    const value = this.cache.get(key);
    if (value !== undefined) {
      this.cache.delete(key);
      this.cache.set(key, value);
    }
  }

  private evictIfNeeded(): void {
    while (this.cache.size > MAX_SIZE) {
      const oldest = this.cache.keys().next().value!;
      this.cache.delete(oldest);
      this.emit(oldest);
    }
  }

  private emit(key: string): void {
    const listeners = this.listeners.get(key);
    if (!listeners) return;
    for (const listener of listeners) {
      listener();
    }
  }

  private async loadIconAbsolute(path: string): Promise<void> {
    const normalized = normalizePath(path);
    try {
      const content = new Uint8Array(await readFileBuffer(this.bridge, normalized));
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
      this.cache.set(path, url);
      this.evictIfNeeded();
      this.emit(path);
    } catch (err) {
      console.warn("[IconCache] loadIconAbsolute failed", normalized, err);
      throw err;
    }
  }

  private async loadIconViaHttp(name: string): Promise<void> {
    const resp = await fetch(`/icons/${name}`);
    if (!resp.ok) return;
    const svg = await resp.text();
    this.cache.set(name, svgToDataUrl(svg));
    this.evictIfNeeded();
    this.emit(name);
  }

  /** Sentinel paths that are fallbacks, not real icon files - skip loading to avoid ENOENT. */
  private isSentinelIconPath(name: string): boolean {
    return name === "_default" || name.startsWith("_default_");
  }

  async loadIcons(names: string[]): Promise<void> {
    const promises: Promise<void>[] = [];

    for (const name of names) {
      if (this.isSentinelIconPath(name)) continue;
      if (this.cache.has(name)) continue;

      if (this.pending.has(name)) {
        promises.push(this.pending.get(name)!);
        continue;
      }

      const p = (async () => {
        try {
          if (isAbsolutePath(name)) {
            await this.loadIconAbsolute(name);
          } else {
            await this.loadIconViaHttp(name);
          }
        } catch (err) {
          console.warn("[IconCache] loadIcons failed for", name.slice(-60), err);
        } finally {
          this.pending.delete(name);
        }
      })();
      this.pending.set(name, p);
      promises.push(p);
    }

    await Promise.all(promises);
  }

  getCachedIconUrl(name: string): string | undefined {
    const url = this.cache.get(name);
    if (url !== undefined) {
      this.touchKey(name);
    }
    return url;
  }

  setCachedIconUrl(name: string, url: string): void {
    this.cache.set(name, url);
    this.evictIfNeeded();
    this.emit(name);
  }

  subscribe(name: string, listener: () => void): () => void {
    const listeners = this.listeners.get(name) ?? new Set<() => void>();
    listeners.add(listener);
    this.listeners.set(name, listeners);
    return () => {
      const current = this.listeners.get(name);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) {
        this.listeners.delete(name);
      }
    };
  }
}

const iconAssetStoreAtom = atom((get) => {
  const bridge = get(bridgeAtom);
  if (!bridge) {
    throw new Error("Bridge not initialized.");
  }
  return new IconAssetStore(bridge);
});

export function useIconAssetStore(): IconAssetStore {
  return useAtomValue(iconAssetStoreAtom);
}

export function useIconAssetUrl(path: string | null): string | null {
  const iconAssets = useIconAssetStore();
  const subscribe = useCallback(
    (listener: () => void) => {
      if (!path) return () => {};
      return iconAssets.subscribe(path, listener);
    },
    [iconAssets, path],
  );
  const getSnapshot = useCallback(() => {
    if (!path) return null;
    return iconAssets.getCachedIconUrl(path) ?? null;
  }, [iconAssets, path]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
