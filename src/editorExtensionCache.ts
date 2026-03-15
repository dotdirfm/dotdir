/**
 * Cache for editor extension API so we don't reload the script when the dialog closes.
 * Cleared when extensions are reloaded.
 */

import type { EditorExtensionApi } from './extensionApi';
import { normalizePath } from './path';

export interface CachedEditorExtension {
  api: EditorExtensionApi;
  scriptUrl: string;
}

export const cache = new Map<string, CachedEditorExtension>();

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
    if (cached.scriptUrl.startsWith('blob:')) URL.revokeObjectURL(cached.scriptUrl);
    cache.delete(key);
  }
}

/** Take cached editor from cache; removes from cache. Call when reopening the same editor. */
export function takeCachedEditorExtension(
  extensionDirPath: string,
  entry: string,
): CachedEditorExtension | undefined {
  const key = getEditorExtensionCacheKey(extensionDirPath, entry);
  const cached = cache.get(key);
  if (!cached) return undefined;
  cache.delete(key);
  return cached;
}

/** Clear all cached editor extensions (e.g. when extension host restarts). */
export function clearEditorExtensionCache(): void {
  for (const [, cached] of cache) {
    if (cached.scriptUrl.startsWith('blob:')) URL.revokeObjectURL(cached.scriptUrl);
  }
  cache.clear();
}
