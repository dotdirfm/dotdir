/**
 * Extension Virtual Filesystem — stable URLs for extension entry scripts
 * so the browser can resolve relative ES module imports without rewriting.
 *
 * - Tauri: custom protocol faraday-resources://vfs/<key>/ serves files from disk.
 * - Web: service worker intercepts /vfs/<key>/ and serves from an in-memory map.
 */

import { bridge } from './bridge';
import { join, normalizePath } from './path';

const VFS_PREFIX = '/vfs/';

/** Stable key for an extension dir (hash of normalized path). */
async function extensionVfsKey(extensionDirPath: string): Promise<string> {
  const normalized = normalizePath(extensionDirPath);
  const enc = new TextEncoder();
  const buf = await crypto.subtle.digest('SHA-256', enc.encode(normalized));
  const hex = Array.from(new Uint8Array(buf))
    .slice(0, 12)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return hex;
}

/** Normalize entry to a relative path (e.g. "./viewer.js" -> "viewer.js"). */
function normalizeEntryPath(entry: string): string {
  const n = normalizePath(entry.replace(/^\.\//, ''));
  return n || 'index.js';
}

/** Check if we're running in Tauri (has register_extension_vfs). */
function isTauriVfs(): boolean {
  return 'extensionVfs' in bridge && typeof (bridge as { extensionVfs?: { register: (k: string, d: string) => Promise<void> } }).extensionVfs?.register === 'function';
}

/** Extensions we mount as text (for Web VFS). Covers entry scripts and assets (e.g. ./assets/*.js). */
const MOUNT_EXTENSIONS = ['.js', '.json', '.css', '.html'];

function shouldMountFile(name: string): boolean {
  const lower = name.toLowerCase();
  return MOUNT_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/** List all mountable files under dir recursively (Web: for mounting in SW). Returns full paths. */
async function listExtensionFiles(dirPath: string): Promise<string[]> {
  const entries = await bridge.fsa.entries(dirPath);
  const out: string[] = [];
  for (const e of entries) {
    const full = join(dirPath, e.name);
    if (e.kind === 'file') {
      if (shouldMountFile(e.name)) out.push(full);
    } else if (e.kind === 'directory') {
      const sub = await listExtensionFiles(full);
      out.push(...sub);
    }
  }
  return out;
}

/** Read file as text using bridge (open/read/close). */
async function readFileText(filePath: string): Promise<string> {
  const fd = await bridge.fsa.open(filePath);
  try {
    const stat = await bridge.fsa.stat(filePath);
    const buf = await bridge.fsa.read(fd, 0, Math.max(0, Math.floor(stat.size)));
    return new TextDecoder().decode(buf);
  } finally {
    await bridge.fsa.close(fd);
  }
}

/** Ensure the VFS service worker is registered and ready (Web only). */
let swReady: Promise<ServiceWorkerRegistration | null> | null = null;

function ensureSwReady(): Promise<ServiceWorkerRegistration | null> {
  if (swReady !== null) return swReady;
  if (typeof navigator === 'undefined' || !navigator.serviceWorker) {
    swReady = Promise.resolve(null);
    return swReady;
  }
  swReady = navigator.serviceWorker
    .register('/sw.js', { scope: '/' })
    .then((reg) => reg)
    .catch(() => null);
  return swReady;
}

/** Mount files into the service worker VFS (Web only). */
function mountWebVfs(key: string, files: Record<string, string>): void {
  const controller = navigator.serviceWorker?.controller;
  if (!controller) return;
  const base = `${VFS_PREFIX}${key}/`;
  controller.postMessage({ type: 'faraday-vfs-mount', base, files });
}

export interface ExtensionVfsResult {
  baseUrl: string;
  entryUrl: string;
}

/**
 * Prepare the extension VFS and return URLs to use for the entry script.
 * - Tauri: registers the extension dir with the backend; entry is loaded from faraday-resources://vfs/<key>/...
 * - Web: lists .js/.json under extension dir, reads them, mounts in SW; entry is loaded from /vfs/<key>/...
 */
export async function prepareExtensionVfs(
  extensionDirPath: string,
  entry: string,
): Promise<ExtensionVfsResult> {
  const key = await extensionVfsKey(extensionDirPath);
  const entryRel = normalizeEntryPath(entry);

  if (isTauriVfs()) {
    const tauriVfs = (bridge as { extensionVfs: { register: (k: string, d: string) => Promise<void> } }).extensionVfs;
    await tauriVfs.register(key, extensionDirPath);
    const baseUrl = `http://faraday-resources.local/vfs/${key}/`;
    return { baseUrl, entryUrl: baseUrl + entryRel };
  }

  const reg = await ensureSwReady();
  if (!reg) {
    throw new Error('Service worker not available for extension VFS');
  }
  await reg.update();
  const filePaths = await listExtensionFiles(extensionDirPath);
  const files: Record<string, string> = {};
  const basePath = normalizePath(extensionDirPath).replace(/\/$/, '') + '/';
  for (const full of filePaths) {
    const norm = normalizePath(full);
    const rel = norm.startsWith(basePath) ? norm.slice(basePath.length) : norm.replace(/^\/+/, '');
    if (!rel) continue;
    try {
      files[rel] = await readFileText(full);
    } catch {
      // skip unreadable
    }
  }
  if (!files[entryRel]) {
    throw new Error(`Extension entry not found: ${entryRel}`);
  }
  mountWebVfs(key, files);
  const origin = window.location.origin;
  const baseUrl = `${origin}${VFS_PREFIX}${key}/`;
  return { baseUrl, entryUrl: baseUrl + entryRel };
}
