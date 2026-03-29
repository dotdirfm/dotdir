import { Bridge, EntryKind, FsChangeEvent, FsChangeType } from "@/features/bridge";
import { join, normalizePath } from "@/utils/path";

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

let nextWatchId = 0;

export class FileSystemObserver {
  #callback: ObserverCallback;
  #watches = new Map<string, string>(); // watchId → normalized path
  #pathToId = new Map<string, string>(); // path → watchId (reverse lookup)
  #cleanup: (() => void) | null = null;
  #generation = 0; // incremented on disconnect to discard stale observe() results

  constructor(
    private bridge: Bridge,
    callback: ObserverCallback,
  ) {
    this.#callback = callback;
  }

  #ensureListener(): void {
    if (!this.#cleanup) {
      this.#cleanup = this.bridge.fs.onFsChange((event: FsChangeEvent) => {
        this.#handleEvent(event);
      });
    }
  }

  async observe(path: string): Promise<void> {
    this.#ensureListener();
    const normalizedPath = normalizePath(path);

    // Already watching this path — skip
    if (this.#pathToId.has(normalizedPath)) return;

    const gen = this.#generation;
    const watchId = `fso-${nextWatchId++}`;

    // Register synchronously so concurrent sync() calls see this path as watched
    this.#watches.set(watchId, normalizedPath);
    this.#pathToId.set(normalizedPath, watchId);

    const ok = await this.bridge.fs.watch(watchId, normalizedPath);

    // Discard if observer was disconnected/updated while awaiting IPC
    if (gen !== this.#generation) {
      if (ok) this.bridge.fs.unwatch(watchId);
      return;
    }

    if (!ok) {
      this.#watches.delete(watchId);
      this.#pathToId.delete(normalizedPath);
      this.#callback(
        [
          {
            root: { path: normalizedPath },
            changedHandle: null,
            relativePathComponents: [],
            type: "errored",
          },
        ],
        this,
      );
    }
  }

  unobserve(path: string): void {
    const normalizedPath = normalizePath(path);
    const watchId = this.#pathToId.get(normalizedPath);
    if (watchId != null) {
      this.bridge.fs.unwatch(watchId);
      this.#watches.delete(watchId);
      this.#pathToId.delete(normalizedPath);
    }
  }

  /** Update the set of watched paths, adding/removing only what changed. */
  sync(paths: string[]): void {
    this.#ensureListener();

    const desired = new Set(paths);

    // Remove watches no longer needed
    for (const [path, watchId] of this.#pathToId) {
      if (!desired.has(path)) {
        this.bridge.fs.unwatch(watchId);
        this.#watches.delete(watchId);
        this.#pathToId.delete(path);
      }
    }

    // Add watches for new paths
    for (const path of desired) {
      if (!this.#pathToId.has(path)) {
        this.observe(path);
      }
    }
  }

  disconnect(): void {
    this.#generation++;
    for (const watchId of this.#watches.keys()) {
      this.bridge.fs.unwatch(watchId);
    }
    this.#watches.clear();
    this.#pathToId.clear();
    if (this.#cleanup) {
      this.#cleanup();
      this.#cleanup = null;
    }
  }

  #handleEvent(event: FsChangeEvent): void {
    const root = this.#watches.get(event.watchId);
    if (!root) return;

    const changedHandle = event.name ? { path: join(root, event.name), name: event.name } : null;
    const relativePathComponents = event.name ? [event.name] : [];

    this.#callback([{ root: { path: root }, changedHandle, relativePathComponents, type: event.type }], this);
  }
}
