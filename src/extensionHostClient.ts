/**
 * Extension Host Client
 *
 * Manages the Extension Host worker lifecycle from the main thread.
 * Provides start/restart/dispose, proxies file I/O from worker to bridge,
 * and notifies listeners when extensions finish loading.
 */

import { bridge } from './bridge';
import { readFileText } from './fs';
import type { LoadedExtension } from './extensions';
import { normalizePath } from './path';

type ExtensionsLoadedCallback = (extensions: LoadedExtension[]) => void;

export class ExtensionHostClient {
  private worker: Worker | null = null;
  private homePath: string | null = null;
  private listeners: ExtensionsLoadedCallback[] = [];
  private starting = false;
  private nextRequestId = 1;
  private pendingRequests = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();

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
      this.spawnWorker();
    } finally {
      this.starting = false;
    }
  }

  /** Terminate the current worker and start a fresh one. */
  async restart(): Promise<void> {
    this.worker?.terminate();
    this.worker = null;
    for (const [, pending] of this.pendingRequests) {
      pending.reject(new Error('Extension host restarted'));
    }
    this.pendingRequests.clear();
    await this.start();
  }

  /** Terminate the worker and clean up. */
  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
    for (const [, pending] of this.pendingRequests) {
      pending.reject(new Error('Extension host disposed'));
    }
    this.pendingRequests.clear();
    this.listeners = [];
  }

  async activateByEvent(event: string): Promise<void> {
    await this.request<void>({ type: 'activateByEvent', event });
  }

  async executeCommand(command: string, args: unknown[] = []): Promise<void> {
    await this.request<void>({ type: 'executeCommand', command, args });
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
      } else if (msg.type === 'requestResult') {
        const requestId = Number(msg.requestId);
        const pending = this.pendingRequests.get(requestId);
        if (!pending) return;
        this.pendingRequests.delete(requestId);
        if (msg.error) {
          pending.reject(new Error(String(msg.error)));
        } else {
          pending.resolve(msg.result);
        }
      }
    };

    worker.onerror = (e) => {
      console.error('[ExtensionHost] Worker runtime error:', e);
    };

    this.worker = worker;
    void (async () => {
      worker.postMessage({ type: 'start', homePath: this.homePath, });
    })();
  }

  private async request<T>(message: Record<string, unknown>): Promise<T> {
    if (!this.worker) {
      await this.start();
    }
    if (!this.worker) {
      throw new Error('Extension host is not running');
    }
    const requestId = this.nextRequestId++;
    return await new Promise<T>((resolve, reject) => {
      this.pendingRequests.set(requestId, { resolve: resolve as (value: unknown) => void, reject });
      this.worker!.postMessage({ ...message, requestId });
    });
  }

  private async handleFileRead(worker: Worker, id: number, path: string): Promise<void> {
    try {
      const normalizedPath = normalizePath(path);
      const text = await readFileText(normalizedPath);
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
