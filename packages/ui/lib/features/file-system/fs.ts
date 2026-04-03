import type { Bridge, EntryKind, FsChangeEvent, FsChangeType } from "@/features/bridge";
import { join, normalizePath } from "@/utils/path";
import type { PropsWithChildren} from "react";
import { createContext, createElement, useContext, useRef } from "react";
import { useBridge } from "@/features/bridge/useBridge";

export interface HandleMeta {
  size: number;
  mtimeMs: number;
  mode: number;
  nlink: number;
  kind: EntryKind;
  hidden: boolean;
  linkTarget?: string;
}

export async function readFile(bridge: Bridge, path: string): Promise<ArrayBuffer> {
  return bridge.fs.readFile(normalizePath(path));
}

export async function readFileBuffer(bridge: Bridge, path: string): Promise<ArrayBuffer> {
  return readFile(bridge, path);
}

export async function readFileText(bridge: Bridge, path: string): Promise<string> {
  const buf = await readFile(bridge, path);
  return new TextDecoder().decode(buf);
}

// --- FileSystemObserver ---

export interface FileSystemChangeRecord {
  root: { path: string };
  changedHandle: { path: string; name: string } | null;
  relativePathComponents: string[];
  type: FsChangeType;
}

type ObserverCallback = (records: FileSystemChangeRecord[], observer: FileSystemObserver) => void;
type SharedWatchListener = (record: FileSystemChangeRecord) => void;

type SharedWatchEntry = {
  watchId: string;
  path: string;
  listeners: Set<SharedWatchListener>;
};

class SharedWatchRegistry {
  #entries = new Map<string, SharedWatchEntry>(); // normalized path -> entry
  #watchIdToPath = new Map<string, string>();
  #cleanup: (() => void) | null = null;
  #nextWatchId = 0;

  constructor(private bridge: Bridge) {}

  add(path: string, listener: SharedWatchListener): void {
    this.#ensureListener();
    const normalizedPath = normalizePath(path);
    const existing = this.#entries.get(normalizedPath);
    if (existing) {
      existing.listeners.add(listener);
      return;
    }

    const watchId = `fso-${this.#nextWatchId++}`;
    const entry: SharedWatchEntry = {
      watchId,
      path: normalizedPath,
      listeners: new Set([listener]),
    };
    this.#entries.set(normalizedPath, entry);
    this.#watchIdToPath.set(watchId, normalizedPath);

    void this.bridge.fs.watch(watchId, normalizedPath).then((ok) => {
      if (this.#entries.get(normalizedPath) !== entry) return;
      if (ok) return;

      const record: FileSystemChangeRecord = {
        root: { path: normalizedPath },
        changedHandle: null,
        relativePathComponents: [],
        type: "errored",
      };
      for (const currentListener of entry.listeners) {
        currentListener(record);
      }
    });
  }

  remove(path: string, listener: SharedWatchListener): void {
    const normalizedPath = normalizePath(path);
    const entry = this.#entries.get(normalizedPath);
    if (!entry) return;
    entry.listeners.delete(listener);
    if (entry.listeners.size > 0) return;

    this.#entries.delete(normalizedPath);
    this.#watchIdToPath.delete(entry.watchId);
    void this.bridge.fs.unwatch(entry.watchId);

    if (this.#entries.size === 0 && this.#cleanup) {
      this.#cleanup();
      this.#cleanup = null;
    }
  }

  #ensureListener(): void {
    if (this.#cleanup) return;
    this.#cleanup = this.bridge.fs.onFsChange((event: FsChangeEvent) => {
      this.#handleEvent(event);
    });
  }

  #handleEvent(event: FsChangeEvent): void {
    const root = this.#watchIdToPath.get(event.watchId);
    if (!root) return;
    const entry = this.#entries.get(root);
    if (!entry) return;

    const changedHandle = event.name ? { path: join(root, event.name), name: event.name } : null;
    const relativePathComponents = event.name ? [event.name] : [];
    const record: FileSystemChangeRecord = {
      root: { path: root },
      changedHandle,
      relativePathComponents,
      type: event.type,
    };

    for (const listener of entry.listeners) {
      listener(record);
    }
  }
}

const FileSystemWatchRegistryContext = createContext<SharedWatchRegistry | null>(null);

export function FileSystemWatchRegistryProvider({ children }: PropsWithChildren) {
  const bridge = useBridge();
  const registryRef = useRef<SharedWatchRegistry | null>(null);
  if (!registryRef.current) {
    registryRef.current = new SharedWatchRegistry(bridge);
  }
  return createElement(FileSystemWatchRegistryContext.Provider, { value: registryRef.current }, children);
}

export function useFileSystemWatchRegistry(): SharedWatchRegistry {
  const value = useContext(FileSystemWatchRegistryContext);
  if (!value) {
    throw new Error("useFileSystemWatchRegistry must be used within FileSystemWatchRegistryProvider");
  }
  return value;
}

export class FileSystemObserver {
  #callback: ObserverCallback;
  #paths = new Set<string>();
  #registry: SharedWatchRegistry;
  #listener: SharedWatchListener;

  constructor(
    registry: SharedWatchRegistry,
    callback: ObserverCallback,
  ) {
    this.#callback = callback;
    this.#registry = registry;
    this.#listener = (record) => {
      this.#callback([record], this);
    };
  }

  async observe(path: string): Promise<void> {
    const normalizedPath = normalizePath(path);
    if (this.#paths.has(normalizedPath)) return;
    this.#paths.add(normalizedPath);
    this.#registry.add(normalizedPath, this.#listener);
  }

  unobserve(path: string): void {
    const normalizedPath = normalizePath(path);
    if (!this.#paths.delete(normalizedPath)) return;
    this.#registry.remove(normalizedPath, this.#listener);
  }

  /** Update the set of watched paths, adding/removing only what changed. */
  sync(paths: string[]): void {
    const desired = new Set(paths.map((path) => normalizePath(path)));

    // Remove watches no longer needed
    for (const path of [...this.#paths]) {
      if (!desired.has(path)) {
        this.unobserve(path);
      }
    }

    // Add watches for new paths
    for (const path of desired) {
      if (!this.#paths.has(path)) void this.observe(path);
    }
  }

  disconnect(): void {
    for (const path of [...this.#paths]) {
      this.unobserve(path);
    }
  }
}
