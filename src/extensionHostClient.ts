/**
 * Extension Host Client
 *
 * Manages the Extension Host worker lifecycle from the main thread.
 * Provides start/restart/dispose, proxies file I/O from worker to bridge,
 * and notifies listeners when extensions finish loading.
 */

import { bridge } from './bridge';
import { FileHandle } from './fsa';
import type { LoadedExtension } from './extensions';
import { normalizePath } from './path';

type ExtensionsLoadedCallback = (extensions: LoadedExtension[]) => void;

/**
 * Discover built-in extension directories.
 * Tauri: uses bundled resources. Headless (faraday serve): uses bridge RPC so the server
 * can return paths to its extensions dir.
 */
async function discoverBuiltInExtensionDirs(): Promise<string[]> {
  try {
    const { isTauri } = await import('@tauri-apps/api/core');
    if (isTauri()) {
      const { invoke } = await import('@tauri-apps/api/core');
      return await invoke<string[]>('get_builtin_extension_dirs');
    }
  } catch {
    // Tauri not available (e.g. not in Tauri env)
  }
  // Headless / serve: ask the backend for built-in extension dirs
  try {
    return await bridge.utils.getBuiltinExtensionDirs();
  } catch {
    return [];
  }
}

export class ExtensionHostClient {
  private worker: Worker | null = null;
  private homePath: string | null = null;
  private builtInDirs: string[] | null = null;
  private listeners: ExtensionsLoadedCallback[] = [];
  private starting = false;

  /** Subscribe to extension load events. Returns an unsubscribe function. */
  onLoaded(cb: ExtensionsLoadedCallback): () => void {
    this.listeners.push(cb);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== cb);
    };
  }

  /** Start the extension host worker. Non-blocking — extensions load in background. */
  async start(): Promise<void> {
    if (this.starting) return;
    this.starting = true;
    try {
      if (!this.homePath) {
        this.homePath = await bridge.utils.getHomePath();
      }
      if (!this.builtInDirs) {
        this.builtInDirs = await discoverBuiltInExtensionDirs();
      }
      this.spawnWorker();
    } finally {
      this.starting = false;
    }
  }

  /** Terminate the current worker and start a fresh one. */
  async restart(): Promise<void> {
    this.worker?.terminate();
    this.worker = null;
    await this.start();
  }

  /** Terminate the worker and clean up. */
  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
    this.listeners = [];
  }

  private spawnWorker(): void {
    const worker = new Worker(
      new URL('./extensionHost.worker.ts', import.meta.url),
      { type: 'module' },
    );

    worker.onmessage = (e: MessageEvent) => {
      const msg = e.data;

      if (msg.type === 'readFile') {
        this.handleFileRead(worker, msg.id, msg.path);
      } else if (msg.type === 'loaded') {
        const extensions: LoadedExtension[] = msg.extensions;
        const fss = extensions.filter((e) => e.iconThemeFss).map((e) => `${e.ref.publisher}.${e.ref.name}`);
        const vscode = extensions.filter((e) => e.vscodeIconThemePath).map((e) => `${e.ref.publisher}.${e.ref.name}`);
        console.log('[ExtHost] loaded', extensions.length, 'extensions; FSS:', fss, 'vscode:', vscode);
        for (const cb of this.listeners) {
          cb(extensions);
        }
      } else if (msg.type === 'error') {
        console.error('[ExtensionHost] Worker error:', msg.message);
      }
    };

    worker.onerror = (e) => {
      console.error('[ExtensionHost] Worker runtime error:', e);
    };

    this.worker = worker;
    worker.postMessage({
      type: 'start',
      homePath: this.homePath,
      builtInDirs: this.builtInDirs ?? [],
    });
  }

  private async handleFileRead(worker: Worker, id: number, path: string): Promise<void> {
    try {
      const normalizedPath = normalizePath(path);
      const name = normalizedPath.split('/').pop() ?? normalizedPath;
      const handle = new FileHandle(normalizedPath, name);
      const file = await handle.getFile();
      const text = await file.text();
      console.log('[ExtHost] readFile ok', normalizedPath);
      worker.postMessage({ type: 'readFileResult', id, data: text });
    } catch (err) {
      console.error('[ExtHost] readFile failed', path, err);
      worker.postMessage({ type: 'readFileResult', id, data: null, error: 'read failed' });
    }
  }
}

/** Singleton extension host instance. */
export const extensionHost = new ExtensionHostClient();
