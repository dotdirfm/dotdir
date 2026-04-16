/**
 * Extension Host Client
 *
 * Manages the Extension Host worker lifecycle from the main thread.
 * Provides start/restart/dispose, proxies file I/O from worker to bridge,
 * and notifies listeners when extensions finish loading.
 */

import type { Bridge } from "@/features/bridge";
import { readAppDirs } from "@/features/bridge/appDirs";
import { useBridge } from "@/features/bridge/useBridge";
import { readFileText } from "@/features/file-system/fs";
import { normalizePath } from "@/utils/path";
import { createContext, createElement, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import worker2 from "./extensionHost.worker.ts?worker&inline";
import { extensionIconThemes, extensionRef, type LoadedExtension } from "./types";

type ExtensionsLoadedCallback = (extensions: LoadedExtension[]) => void;

function normalizeLoadedExtensionPayload(raw: unknown): LoadedExtension {
  const value = raw as Record<string, unknown>;
  if ("identity" in value && "location" in value && "assets" in value && "contributions" in value) {
    return raw as unknown as LoadedExtension;
  }
  return {
    identity: {
      ref: value.ref as LoadedExtension["identity"]["ref"],
      manifest: value.manifest as LoadedExtension["identity"]["manifest"],
    },
    location: {
      dirPath: String(value.dirPath ?? ""),
    },
    assets: {
      iconThemes: value.iconThemes as LoadedExtension["assets"]["iconThemes"],
      colorThemes: value.colorThemes as LoadedExtension["assets"]["colorThemes"],
    },
    contributions: {
      languages: value.languages as LoadedExtension["contributions"]["languages"],
      grammarRefs: value.grammarRefs as LoadedExtension["contributions"]["grammarRefs"],
      commands: value.commands as LoadedExtension["contributions"]["commands"],
      keybindings: value.keybindings as LoadedExtension["contributions"]["keybindings"],
      viewers: value.viewers as LoadedExtension["contributions"]["viewers"],
      editors: value.editors as LoadedExtension["contributions"]["editors"],
      fsProviders: value.fsProviders as LoadedExtension["contributions"]["fsProviders"],
      shellIntegrations: value.shellIntegrations as LoadedExtension["contributions"]["shellIntegrations"],
    },
  };
}

export class ExtensionHostClient {
  private worker: Worker | null = null;
  private listeners: ExtensionsLoadedCallback[] = [];
  private starting = false;
  private nextRequestId = 1;
  private pendingRequests = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();

  constructor(
    private bridge: Bridge,
    private dataDir: string,
  ) {}

  /** Subscribe to extension load events. Returns an unsubscribe function. */
  onLoaded(cb: ExtensionsLoadedCallback): () => void {
    this.listeners.push(cb);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== cb);
    };
  }

  /** Start the extension host worker. Non-blocking — extensions load in background. */
  async start(): Promise<void> {
    if (this.worker || this.starting) return;
    this.starting = true;
    try {
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
      pending.reject(new Error("Extension host restarted"));
    }
    this.pendingRequests.clear();
    await this.start();
  }

  /** Terminate the worker and clean up. */
  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
    for (const [, pending] of this.pendingRequests) {
      pending.reject(new Error("Extension host disposed"));
    }
    this.pendingRequests.clear();
    this.listeners = [];
  }

  async activateByEvent(event: string): Promise<void> {
    await this.request<void>({ type: "activateByEvent", event });
  }

  async executeCommand(command: string, args: unknown[] = []): Promise<void> {
    await this.request<void>({ type: "executeCommand", command, args });
  }

  private spawnWorker(): void {
    const worker = new worker2();

    worker.onmessage = (e: MessageEvent) => {
      const msg = e.data;

      if (msg.type === "readFile") {
        this.handleFileRead(worker, msg.id, msg.path);
      } else if (msg.type === "loaded") {
        const extensions: LoadedExtension[] = Array.isArray(msg.extensions)
          ? msg.extensions.map(normalizeLoadedExtensionPayload)
          : [];
        const fss = extensions.flatMap((e) => extensionIconThemes(e).filter((theme) => theme.kind === "fss").map((theme) => `${extensionRef(e).publisher}.${extensionRef(e).name}:${theme.id}`));
        const vscode = extensions.flatMap((e) => extensionIconThemes(e).filter((theme) => theme.kind === "vscode").map((theme) => `${extensionRef(e).publisher}.${extensionRef(e).name}:${theme.id}`));
        console.log("[ExtHost] loaded", extensions.length, "extensions; FSS:", fss, "vscode:", vscode);
        for (const cb of this.listeners) {
          cb(extensions);
        }
      } else if (msg.type === "error") {
        console.error("[ExtensionHost] Worker error:", msg.message);
        void this.bridge.utils.debugLog?.(`[ExtensionHost] worker error: ${String(msg.message ?? "unknown")}`);
      } else if (msg.type === "activationLog") {
        const level = String(msg.level ?? "info");
        const extension = String(msg.extension ?? "unknown-extension");
        const event = msg.event ? String(msg.event) : "";
        const message = String(msg.message ?? "");
        const text = `[ExtensionHost:${level}] ${extension}${event ? ` event=${event}` : ""} ${message}`.trim();
        if (level === "error") {
          console.error(text);
        } else if (level === "warn") {
          console.warn(text);
        } else {
          console.log(text);
        }
        void this.bridge.utils.debugLog?.(text);
      } else if (msg.type === "requestResult") {
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
      console.error("[ExtensionHost] Worker runtime error:", e);
    };

    this.worker = worker;
    void (async () => {
      worker.postMessage({ type: "start", dataDir: this.dataDir });
    })();
  }

  private async request<T>(message: Record<string, unknown>): Promise<T> {
    if (!this.worker) {
      await this.start();
    }
    if (!this.worker) {
      throw new Error("Extension host is not running");
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
      const text = await readFileText(this.bridge, normalizedPath);
      worker.postMessage({ type: "readFileResult", id, data: text });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("Not a file:") || message.includes("ENOENT")) {
        worker.postMessage({ type: "readFileResult", id, data: null });
        return;
      }
      worker.postMessage({ type: "readFileResult", id, data: null, error: "read failed" });
    }
  }
}

const ExtensionHostClientContext = createContext<ExtensionHostClient | null>(null);

export function ExtensionHostClientProvider({ children }: { children: ReactNode }) {
  const bridge = useBridge();
  const [dataDir, setDataDir] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const dirs = await readAppDirs(bridge);
      if (!cancelled) {
        setDataDir(dirs.dataDir);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [bridge]);

  const client = useMemo(() => {
    if (!dataDir) return null;
    return new ExtensionHostClient(bridge, dataDir);
  }, [bridge, dataDir]);

  useEffect(() => {
    if (!client) return;
    return () => {
      client.dispose();
    };
  }, [client]);

  if (!client) {
    return null;
  }

  return createElement(ExtensionHostClientContext.Provider, { value: client }, children);
}

export function useExtensionHostClient(): ExtensionHostClient {
  const value = useContext(ExtensionHostClientContext);
  if (!value) {
    throw new Error("useExtensionHostClient must be used within ExtensionHostClientProvider");
  }
  return value;
}
