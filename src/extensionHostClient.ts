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

type ExtensionsLoadedCallback = (extensions: LoadedExtension[]) => void;

/**
 * Discover built-in extension directories.
 * In dev: resolve from the repo `extensions/` dir (via import.meta.url).
 * In production: Tauri bundles them into the app resources.
 */
async function discoverBuiltInExtensionDirs(): Promise<string[]> {
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const dirs: string[] = await invoke('get_builtin_extension_dirs');
    return dirs;
  } catch {
    // Not Tauri or command not available — try to resolve from well-known path
    // In dev, the extensions/ dir is at the repo root; the bridge can check existence.
    const homePath = await bridge.utils.getHomePath();
    // Try a few well-known dev paths
    const candidates = [
      // Vite dev server can resolve relative to root
      '/extensions/faraday-viewers-basic',
      '/extensions/faraday-editor-monaco',
    ];
    // For web/headless mode, we don't have filesystem access to the repo root.
    // Built-in dirs are only supported in Tauri mode for now.
    void candidates;
    void homePath;
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
      const name = path.split('/').pop() ?? path;
      const handle = new FileHandle(path, name);
      const file = await handle.getFile();
      const text = await file.text();
      worker.postMessage({ type: 'readFileResult', id, data: text });
    } catch {
      worker.postMessage({ type: 'readFileResult', id, data: null, error: 'read failed' });
    }
  }
}

/** Singleton extension host instance. */
export const extensionHost = new ExtensionHostClient();
