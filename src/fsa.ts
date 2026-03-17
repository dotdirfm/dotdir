import type { FsaRawEntry, EntryKind, FsChangeEvent, FsChangeType } from './types';
import { bridge } from './bridge';
import { join, normalizePath } from './path';

export interface HandleMeta {
  size: number;
  mtimeMs: number;
  mode: number;
  nlink: number;
  kind: EntryKind;
  hidden: boolean;
  linkTarget?: string;
}

const readonlyError = () => {
  throw new Error('Filesystem is read-only');
};

const CHUNK_SIZE = 65536; // 64 KB

function lazyReadMethods(fd: number, offset: number, length: number) {
  return {
    async arrayBuffer(): Promise<ArrayBuffer> {
      return bridge.fsa.read(fd, offset, length);
    },
    async text(): Promise<string> {
      const buf = await bridge.fsa.read(fd, offset, length);
      return new TextDecoder().decode(buf);
    },
    async bytes(): Promise<Uint8Array<ArrayBuffer>> {
      const buf = await bridge.fsa.read(fd, offset, length);
      return new Uint8Array(buf);
    },
    stream(): ReadableStream<Uint8Array<ArrayBuffer>> {
      let pos = 0;
      return new ReadableStream<Uint8Array<ArrayBuffer>>({
        async pull(controller) {
          const remaining = length - pos;
          if (remaining <= 0) {
            controller.close();
            return;
          }
          const chunkLen = Math.min(CHUNK_SIZE, remaining);
          const buf = await bridge.fsa.read(fd, offset + pos, chunkLen);
          pos += buf.byteLength;
          if (buf.byteLength === 0) {
            controller.close();
          } else {
            controller.enqueue(new Uint8Array(buf));
          }
        },
      });
    },
  };
}

export class LazyBlob extends Blob {
  readonly #fd: number;
  readonly #offset: number;
  readonly #length: number;
  readonly #type: string;

  constructor(fd: number, offset: number, length: number, type = '') {
    super([]);
    this.#fd = fd;
    this.#offset = offset;
    this.#length = length;
    this.#type = type;
  }

  override get size() {
    return this.#length;
  }
  override get type() {
    return this.#type;
  }

  override arrayBuffer() {
    return lazyReadMethods(this.#fd, this.#offset, this.#length).arrayBuffer();
  }
  override text() {
    return lazyReadMethods(this.#fd, this.#offset, this.#length).text();
  }
  override bytes() {
    return lazyReadMethods(this.#fd, this.#offset, this.#length).bytes();
  }
  override stream() {
    return lazyReadMethods(this.#fd, this.#offset, this.#length).stream();
  }

  override slice(start = 0, end = this.#length, contentType = ''): LazyBlob {
    const s = Math.max(0, Math.min(start, this.#length));
    const e = Math.max(s, Math.min(end, this.#length));
    return new LazyBlob(this.#fd, this.#offset + s, e - s, contentType);
  }
}

export class LazyFile extends File {
  readonly #fd: number;
  readonly #size: number;

  constructor(fd: number, size: number, name: string, lastModified: number) {
    super([], name, { lastModified });
    this.#fd = fd;
    this.#size = size;
  }

  override get size() {
    return this.#size;
  }

  override arrayBuffer() {
    return lazyReadMethods(this.#fd, 0, this.#size).arrayBuffer();
  }
  override text() {
    return lazyReadMethods(this.#fd, 0, this.#size).text();
  }
  override bytes() {
    return lazyReadMethods(this.#fd, 0, this.#size).bytes();
  }
  override stream() {
    return lazyReadMethods(this.#fd, 0, this.#size).stream();
  }

  override slice(start = 0, end = this.#size, contentType = ''): LazyBlob {
    const s = Math.max(0, Math.min(start, this.#size));
    const e = Math.max(s, Math.min(end, this.#size));
    return new LazyBlob(this.#fd, s, e - s, contentType);
  }
}

export class DirectoryHandle implements FileSystemDirectoryHandle {
  readonly kind = 'directory' as const;
  readonly name: string;
  readonly path: string;
  readonly meta?: HandleMeta;

  constructor(path: string, name?: string, meta?: HandleMeta) {
    this.path = normalizePath(path);
    this.name = name ?? path.split('/').pop() ?? path;
    this.meta = meta;
  }

  async isSameEntry(other: FileSystemHandle): Promise<boolean> {
    return other instanceof DirectoryHandle && other.path === this.path;
  }

  async *entries(): AsyncIterableIterator<[string, FileSystemHandle]> {
    const raw: FsaRawEntry[] = await bridge.fsa.entries(this.path);
    for (const entry of raw) {
      const childPath = join(this.path, entry.name);
      const meta: HandleMeta = {
        size: entry.size,
        mtimeMs: entry.mtimeMs,
        mode: entry.mode,
        nlink: entry.nlink,
        kind: entry.kind,
        hidden: entry.hidden,
        linkTarget: entry.linkTarget,
      };
      const isDir = entry.kind === 'directory' || (entry.kind === 'symlink' && (entry.mode & 0o170000) === 0o040000);
      if (isDir) {
        yield [entry.name, new DirectoryHandle(childPath, entry.name, meta)] as const;
      } else {
        yield [entry.name, new FileHandle(childPath, entry.name, meta)] as const;
      }
    }
  }

  async *keys(): AsyncIterableIterator<string> {
    for await (const [name] of this.entries()) {
      yield name;
    }
  }

  async *values(): AsyncIterableIterator<FileSystemHandle> {
    for await (const [, handle] of this.entries()) {
      yield handle;
    }
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<[string, FileSystemHandle]> {
    return this.entries();
  }

  async getDirectoryHandle(name: string): Promise<DirectoryHandle> {
    return new DirectoryHandle(join(this.path, name), name);
  }

  async getFileHandle(name: string): Promise<FileHandle> {
    return new FileHandle(join(this.path, name), name);
  }

  async removeEntry(): Promise<never> {
    return readonlyError();
  }

  async resolve(possibleDescendant: FileSystemHandle): Promise<string[] | null> {
    if (!(possibleDescendant instanceof DirectoryHandle || possibleDescendant instanceof FileHandle)) {
      return null;
    }
    const descendantPath = possibleDescendant.path;
    if (!descendantPath.startsWith(this.path)) return null;
    const relative = descendantPath.slice(this.path.length).replace(/^\//, '');
    if (!relative) return [];
    return relative.split('/');
  }
}

export class FileHandle implements FileSystemFileHandle {
  readonly kind = 'file' as const;
  readonly name: string;
  readonly path: string;
  readonly meta?: HandleMeta;

  constructor(path: string, name: string, meta?: HandleMeta) {
    this.path = normalizePath(path);
    this.name = name;
    this.meta = meta;
  }

  async isSameEntry(other: FileSystemHandle): Promise<boolean> {
    return other instanceof FileHandle && other.path === this.path;
  }

  async getFile(): Promise<File> {
    let size = this.meta?.size;
    let mtimeMs = this.meta?.mtimeMs;
    if (size === undefined) {
      const stat = await bridge.fsa.stat(this.path);
      size = stat.size;
      mtimeMs = stat.mtimeMs;
    }
    const fd = await bridge.fsa.open(this.path);
    return new LazyFile(fd, size, this.name, mtimeMs ?? 0);
  }

  async createWritable(): Promise<{ write(data: string): Promise<void>; close(): Promise<void> }> {
    let closed = false;
    const self = this;
    return {
      async write(data: string): Promise<void> {
        if (closed) throw new Error('Writer is closed');
        await bridge.fsa.writeFile(self.path, data);
      },
      async close(): Promise<void> {
        closed = true;
      },
    };
  }
}

// --- FileSystemObserver ---

export interface FileSystemChangeRecord {
  root: DirectoryHandle;
  changedHandle: FileSystemHandle | null;
  relativePathComponents: string[];
  type: FsChangeType;
}

type ObserverCallback = (records: FileSystemChangeRecord[], observer: FileSystemObserver) => void;

let nextWatchId = 0;

export class FileSystemObserver {
  #callback: ObserverCallback;
  #watches = new Map<string, DirectoryHandle>(); // watchId → handle
  #pathToId = new Map<string, string>(); // path → watchId (reverse lookup)
  #cleanup: (() => void) | null = null;
  #generation = 0; // incremented on disconnect to discard stale observe() results

  constructor(callback: ObserverCallback) {
    this.#callback = callback;
  }

  #ensureListener(): void {
    if (!this.#cleanup) {
      this.#cleanup = bridge.fsa.onFsChange((event: FsChangeEvent) => {
        this.#handleEvent(event);
      });
    }
  }

  async observe(handle: DirectoryHandle): Promise<void> {
    this.#ensureListener();

    // Already watching this path — skip
    if (this.#pathToId.has(handle.path)) return;

    const gen = this.#generation;
    const watchId = `fso-${nextWatchId++}`;

    // Register synchronously so concurrent sync() calls see this path as watched
    this.#watches.set(watchId, handle);
    this.#pathToId.set(handle.path, watchId);

    const ok = await bridge.fsa.watch(watchId, handle.path);

    // Discard if observer was disconnected/updated while awaiting IPC
    if (gen !== this.#generation) {
      if (ok) bridge.fsa.unwatch(watchId);
      return;
    }

    if (!ok) {
      this.#watches.delete(watchId);
      this.#pathToId.delete(handle.path);
      this.#callback([{ root: handle, changedHandle: null, relativePathComponents: [], type: 'errored' }], this);
    }
  }

  unobserve(handle: DirectoryHandle): void {
    const watchId = this.#pathToId.get(handle.path);
    if (watchId != null) {
      bridge.fsa.unwatch(watchId);
      this.#watches.delete(watchId);
      this.#pathToId.delete(handle.path);
    }
  }

  /** Update the set of watched paths, adding/removing only what changed. */
  sync(paths: string[]): void {
    this.#ensureListener();

    const desired = new Set(paths);

    // Remove watches no longer needed
    for (const [path, watchId] of this.#pathToId) {
      if (!desired.has(path)) {
        bridge.fsa.unwatch(watchId);
        this.#watches.delete(watchId);
        this.#pathToId.delete(path);
      }
    }

    // Add watches for new paths
    for (const path of desired) {
      if (!this.#pathToId.has(path)) {
        this.observe(new DirectoryHandle(path));
      }
    }
  }

  disconnect(): void {
    this.#generation++;
    for (const watchId of this.#watches.keys()) {
      bridge.fsa.unwatch(watchId);
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

    const changedHandle: FileSystemHandle | null = event.name ? new FileHandle(join(root.path, event.name), event.name) : null;
    const relativePathComponents = event.name ? [event.name] : [];

    this.#callback([{ root, changedHandle, relativePathComponents, type: event.type }], this);
  }
}
