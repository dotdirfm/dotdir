/// Browser-side bridge over WebSocket - connects to the faraday-server headless backend.
///
/// Implements the same Bridge interface as tauriBridge.ts, using JSON-RPC 2.0
/// over WebSocket. Binary frames are used for fs.read responses.
/// Automatically reconnects on disconnection with exponential backoff.
import type { Bridge, PtyLaunchInfo, TerminalProfile, CopyOptions, ConflictResolution, CopyProgressEvent, MoveOptions, MoveProgressEvent, DeleteProgressEvent, FspEntry } from './bridge';
import type { FsaRawEntry, FsChangeEvent, FsChangeType } from './types';

type Pending = {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
};

type PtyDataCallback = (ptyId: number, data: Uint8Array) => void;
type PtyExitCallback = (ptyId: number) => void;

const BINARY_TYPE_PTY = 0x01;

export async function createWsBridge(wsUrl: string): Promise<Bridge> {
  let ws: WebSocket;
  let nextId = 0;
  const pending = new Map<number, Pending>();
  const changeListeners = new Set<(event: FsChangeEvent) => void>();
  const ptyDataListeners = new Set<PtyDataCallback>();
  const ptyExitListeners = new Set<PtyExitCallback>();
  const copyProgressListeners = new Set<(event: CopyProgressEvent) => void>();
  const moveProgressListeners = new Set<(event: MoveProgressEvent) => void>();
  const deleteProgressListeners = new Set<(event: DeleteProgressEvent) => void>();
  const reconnectCallbacks = new Set<() => void>();

  let wsReady: Promise<void>;
  let resolveReady: () => void = () => {};
  let reconnectDelay = 1000;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  function newReadyPromise() {
    wsReady = new Promise((resolve) => {
      resolveReady = resolve;
    });
  }

  function handleMessage(event: MessageEvent) {
    if (typeof event.data === 'string') {
      handleText(event.data);
    } else {
      handleBinary(event.data as ArrayBuffer);
    }
  }

  function handleText(text: string): void {
    const msg = JSON.parse(text);
    if (!('id' in msg)) {
      if (msg.method === 'fs.change') {
        const event: FsChangeEvent = {
          watchId: msg.params.watchId as string,
          type: msg.params.type as FsChangeType,
          name: (msg.params.name as string) ?? null,
        };
        for (const cb of changeListeners) cb(event);
      } else if (msg.method === 'pty.exit') {
        for (const cb of ptyExitListeners) cb(msg.params.ptyId);
      } else if (msg.method === 'copy.progress') {
        const event: CopyProgressEvent = { copyId: msg.params.copyId, event: msg.params.event };
        for (const cb of copyProgressListeners) cb(event);
      } else if (msg.method === 'move.progress') {
        const event: MoveProgressEvent = { moveId: msg.params.moveId, event: msg.params.event };
        for (const cb of moveProgressListeners) cb(event);
      } else if (msg.method === 'delete.progress') {
        const event: DeleteProgressEvent = { deleteId: msg.params.deleteId, event: msg.params.event };
        for (const cb of deleteProgressListeners) cb(event);
      }
      return;
    }

    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);

    if (msg.error) {
      const err = new Error(msg.error.message);
      (err as Error & { code?: string }).code = msg.error.data?.errno;
      p.reject(err);
    } else {
      p.resolve(msg.result);
    }
  }

  function handleBinary(data: ArrayBuffer): void {
    const view = new DataView(data);
    const type = view.getUint8(0);

    if (type === BINARY_TYPE_PTY) {
      const ptyId = view.getUint32(1, true);
      const payload = new Uint8Array(data, 5);
      for (const cb of ptyDataListeners) cb(ptyId, payload);
      return;
    }

    // BINARY_TYPE_RPC: [0x00][request_id: u32 LE][payload]
    const requestId = view.getUint32(1, true);
    const payload = data.slice(5);
    const p = pending.get(requestId);
    if (!p) return;
    pending.delete(requestId);
    p.resolve(payload);
  }

  function rejectPending() {
    for (const { reject } of pending.values()) {
      reject(new Error('WebSocket closed'));
    }
    pending.clear();
  }

  function startHeartbeat() {
    stopHeartbeat();
    heartbeatTimer = setInterval(() => {
      const timeout = setTimeout(() => {
        ws.close();
      }, 5000);
      rpc('ping', {})
        .then(() => clearTimeout(timeout))
        .catch(() => clearTimeout(timeout));
    }, 30000);
  }

  function stopHeartbeat() {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  function connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(wsUrl);
      socket.binaryType = 'arraybuffer';
      let opened = false;

      socket.addEventListener('open', () => {
        opened = true;
        ws = socket;
        resolve();
      }, { once: true });

      socket.addEventListener('error', () => {
        if (!opened) reject(new Error('WebSocket connection failed'));
      }, { once: true });

      socket.addEventListener('message', handleMessage);
      socket.addEventListener('close', () => {
        if (!opened) return;
        stopHeartbeat();
        rejectPending();
        newReadyPromise();
        reconnect();
      });
    });
  }

  async function reconnect() {
    while (true) {
      await new Promise((r) => setTimeout(r, reconnectDelay));
      try {
        await connect();
        reconnectDelay = 1000;
        resolveReady();
        startHeartbeat();
        for (const cb of reconnectCallbacks) cb();
        return;
      } catch {
        reconnectDelay = Math.min(reconnectDelay * 2, 30000);
      }
    }
  }

  function rpc(method: string, params: Record<string, unknown>): Promise<unknown> {
    return wsReady.then(
      () => new Promise((resolve, reject) => {
        if (ws.readyState !== WebSocket.OPEN) {
          reject(new Error('WebSocket is not connected'));
          return;
        }
        const id = nextId++;
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
      }),
    );
  }

  newReadyPromise();
  await connect();
  resolveReady();
  startHeartbeat();

  return {
    fsa: {
      entries: (dirPath: string) => rpc('fs.entries', { path: dirPath }) as Promise<FsaRawEntry[]>,
      stat: (filePath: string) => rpc('fs.stat', { path: filePath }) as Promise<{ size: number; mtimeMs: number }>,
      exists: (filePath: string) => rpc('fs.exists', { path: filePath }) as Promise<boolean>,
      open: (filePath: string) => rpc('fs.open', { path: filePath }) as Promise<number>,
      read: (fd: number, offset: number, length: number) =>
        rpc('fs.read', { handle: fd, offset, length }) as Promise<ArrayBuffer>,
      close: (fd: number) => rpc('fs.close', { handle: fd }) as Promise<void>,
      watch: (watchId: string, dirPath: string) => rpc('fs.watch', { watchId, path: dirPath }) as Promise<boolean>,
      unwatch: (watchId: string) => rpc('fs.unwatch', { watchId }) as Promise<void>,
      writeFile: (filePath: string, data: string) => rpc('fs.writeFile', { path: filePath, data }) as Promise<void>,
      writeBinaryFile: (filePath: string, data: Uint8Array) => rpc('fs.writeBinary', { path: filePath, data: Array.from(data) }) as Promise<void>,
      createDir: (dirPath: string) => rpc('fs.createDir', { path: dirPath }) as Promise<void>,
      moveToTrash: (paths: string[]) => rpc('fs.moveToTrash', { paths }) as Promise<void>,
      deletePath: (path: string) => rpc('fs.deletePath', { path }) as Promise<void>,
      onFsChange(callback: (event: FsChangeEvent) => void): () => void {
        changeListeners.add(callback);
        return () => {
          changeListeners.delete(callback);
        };
      },
    },
    pty: {
      spawn: (cwd: string, profileId?: string) => rpc('pty.spawn', { cwd, profileId }) as Promise<PtyLaunchInfo>,
      write: (ptyId: number, data: string) => rpc('pty.write', { ptyId, data }) as Promise<void>,
      resize: (ptyId: number, cols: number, rows: number) =>
        rpc('pty.resize', {
          ptyId,
          cols: Math.max(2, Math.floor(cols)),
          rows: Math.max(1, Math.floor(rows)),
        }) as Promise<void>,
      close: (ptyId: number) => rpc('pty.close', { ptyId }) as Promise<void>,
      onData(callback: PtyDataCallback): () => void {
        ptyDataListeners.add(callback);
        return () => { ptyDataListeners.delete(callback); };
      },
      onExit(callback: PtyExitCallback): () => void {
        ptyExitListeners.add(callback);
        return () => { ptyExitListeners.delete(callback); };
      },
    },
    utils: {
      getHomePath: () => rpc('utils.getHomePath', {}) as Promise<string>,
      getTerminalProfiles: () => rpc('utils.getTerminalProfiles', {}) as Promise<TerminalProfile[]>,
    },
    copy: {
      start: (sources: string[], destDir: string, options: CopyOptions) =>
        rpc('copy.start', { sources, destDir, options }) as Promise<number>,
      cancel: (copyId: number) => rpc('copy.cancel', { copyId }) as Promise<void>,
      resolveConflict: (copyId: number, resolution: ConflictResolution) => {
        let rustRes: unknown;
        switch (resolution.type) {
          case 'overwrite': rustRes = 'overwrite'; break;
          case 'skip': rustRes = 'skip'; break;
          case 'rename': rustRes = { rename: resolution.newName }; break;
          case 'overwriteAll': rustRes = 'overwriteAll'; break;
          case 'skipAll': rustRes = 'skipAll'; break;
          case 'cancel': rustRes = 'cancel'; break;
        }
        return rpc('copy.resolveConflict', { copyId, resolution: rustRes }) as Promise<void>;
      },
      onProgress(callback: (event: CopyProgressEvent) => void): () => void {
        copyProgressListeners.add(callback);
        return () => { copyProgressListeners.delete(callback); };
      },
    },
    move: {
      start: (sources: string[], destDir: string, options: MoveOptions) =>
        rpc('move.start', { sources, destDir, options }) as Promise<number>,
      cancel: (moveId: number) => rpc('move.cancel', { moveId }) as Promise<void>,
      resolveConflict: (moveId: number, resolution: ConflictResolution) => {
        let rustRes: unknown;
        switch (resolution.type) {
          case 'overwrite': rustRes = 'overwrite'; break;
          case 'skip': rustRes = 'skip'; break;
          case 'rename': rustRes = { rename: resolution.newName }; break;
          case 'overwriteAll': rustRes = 'overwriteAll'; break;
          case 'skipAll': rustRes = 'skipAll'; break;
          case 'cancel': rustRes = 'cancel'; break;
        }
        return rpc('move.resolveConflict', { moveId, resolution: rustRes }) as Promise<void>;
      },
      onProgress(callback: (event: MoveProgressEvent) => void): () => void {
        moveProgressListeners.add(callback);
        return () => { moveProgressListeners.delete(callback); };
      },
    },
    delete: {
      start: (paths: string[]) => rpc('delete.start', { paths }) as Promise<number>,
      cancel: (deleteId: number) => rpc('delete.cancel', { deleteId }) as Promise<void>,
      onProgress(callback: (event: DeleteProgressEvent) => void): () => void {
        deleteProgressListeners.add(callback);
        return () => { deleteProgressListeners.delete(callback); };
      },
    },
    rename: {
      rename: (source: string, newName: string) => rpc('fs.rename', { source, newName }) as Promise<void>,
    },
    theme: {
      get: () => Promise.resolve(window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'),
      onChange(callback: (theme: string) => void): () => void {
        const mq = window.matchMedia('(prefers-color-scheme: dark)');
        const handler = (e: MediaQueryListEvent) => callback(e.matches ? 'dark' : 'light');
        mq.addEventListener('change', handler);
        return () => mq.removeEventListener('change', handler);
      },
    },
    onReconnect(callback: () => void): () => void {
      reconnectCallbacks.add(callback);
      return () => { reconnectCallbacks.delete(callback); };
    },
    fsProvider: {
      load: (wasmPath: string) =>
        rpc('fsp.load', { wasmPath }) as Promise<void>,
      listEntries: async (wasmPath: string, containerPath: string, innerPath: string) => {
        const raw = await rpc('fsp.listEntries', { wasmPath, containerPath, innerPath }) as Array<{
          name: string; kind: string; size?: number; mtimeMs?: number;
        }>;
        return raw.map((e) => ({
          name: e.name,
          kind: e.kind as FspEntry['kind'],
          size: e.size,
          mtimeMs: e.mtimeMs,
        }));
      },
      readFileRange: async (wasmPath: string, containerPath: string, innerPath: string, offset: number, length: number) => {
        const bytes = await rpc('fsp.readFileRange', { wasmPath, containerPath, innerPath, offset, length }) as number[];
        return new Uint8Array(bytes).buffer;
      },
    },
  };
}
