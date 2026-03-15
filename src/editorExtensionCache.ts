/**
 * Cache for editor extension iframes so we don't unload when the dialog closes.
 * Iframe is removed from DOM and stashed; re-attached with new document (mount) when opened again.
 * Cleared when extensions are reloaded.
 */

import type { Remote } from 'comlink';
import type { EditorExtensionApi } from './extensionApi';
import { normalizePath } from './path';

export interface CachedEditorExtension {
  iframe: HTMLIFrameElement;
  api: Remote<EditorExtensionApi>;
  scriptUrl: string;
  htmlUrl: string;
}

export const cache = new Map<string, CachedEditorExtension>();

/** Hidden container to keep cached iframes in the document (avoid GC). */
let parking: HTMLDivElement | null = null;

function getParking(): HTMLDivElement {
  if (!parking) {
    parking = document.createElement('div');
    parking.style.setProperty('position', 'fixed');
    parking.style.setProperty('left', '-99999px');
    parking.style.setProperty('top', '0');
    parking.style.setProperty('width', '1px');
    parking.style.setProperty('height', '1px');
    parking.style.setProperty('overflow', 'hidden');
    parking.style.setProperty('visibility', 'hidden');
    parking.style.setProperty('pointer-events', 'none');
    document.body.appendChild(parking);
  }
  return parking;
}

/** Normalize path so cache key is stable across Windows/Unix and trailing-slash differences. */
export function getEditorExtensionCacheKey(extensionDirPath: string, entry: string): string {
  return `${normalizePath(extensionDirPath)}\0${entry}`;
}

export function getCachedEditorExtension(
  extensionDirPath: string,
  entry: string,
): CachedEditorExtension | undefined {
  return cache.get(getEditorExtensionCacheKey(extensionDirPath, entry));
}

export function setCachedEditorExtension(
  extensionDirPath: string,
  entry: string,
  value: CachedEditorExtension,
): void {
  cache.set(getEditorExtensionCacheKey(extensionDirPath, entry), value);
}

export function removeEditorExtensionFromCache(extensionDirPath: string, entry: string): void {
  const key = getEditorExtensionCacheKey(extensionDirPath, entry);
  const cached = cache.get(key);
  if (cached) {
    cached.iframe.remove();
    URL.revokeObjectURL(cached.scriptUrl);
    URL.revokeObjectURL(cached.htmlUrl);
    cache.delete(key);
  }
}

/** Stash iframe in parking and store in cache. Call when closing editor (unmount). */
export function stashEditorExtension(
  extensionDirPath: string,
  entry: string,
  iframe: HTMLIFrameElement,
  api: Remote<EditorExtensionApi>,
  scriptUrl: string,
  htmlUrl: string,
): void {
  iframe.remove();
  getParking().appendChild(iframe);
  setCachedEditorExtension(extensionDirPath, entry, {
    iframe,
    api,
    scriptUrl,
    htmlUrl,
  });
}

/** Take iframe out of parking and return cached entry; removes from cache. */
export function takeCachedEditorExtension(
  extensionDirPath: string,
  entry: string,
): CachedEditorExtension | undefined {
  const key = getEditorExtensionCacheKey(extensionDirPath, entry);
  const cached = cache.get(key);
  if (!cached) return undefined;
  cache.delete(key);
  cached.iframe.remove();
  return cached;
}

/** Clear all cached editor extensions (e.g. when extension host restarts). */
export function clearEditorExtensionCache(): void {
  for (const [, cached] of cache) {
    cached.iframe.remove();
    URL.revokeObjectURL(cached.scriptUrl);
    URL.revokeObjectURL(cached.htmlUrl);
  }
  cache.clear();
}
