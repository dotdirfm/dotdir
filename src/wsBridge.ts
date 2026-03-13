/// Browser-side bridge over WebSocket — connects to the faraday-server headless backend.
///
/// Implements the same Bridge interface as tauriBridge.ts, using JSON-RPC 2.0
/// over WebSocket. Binary frames are used for fs.read responses.
/// Automatically reconnects on disconnection with exponential backoff.
import type { Bridge } from './bridge';
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
  const reconnectCallbacks = new Set<() => void>();

  // Connection readiness gate — rpc() awaits this before sending
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

    // JSON-RPC notifications
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
      }
      return;
    }

    // JSON-RPC response
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
        ws.close(); // force close → triggers reconnect
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
        if (!opened) return; // connect() rejection handles this
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
      () =>
        new Promise((resolve, reject) => {
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

  // Initial connection
  newReadyPromise();
  await connect();
  resolveReady();
  startHeartbeat();

  return {
    fsa: {
      entries: (dirPath: string) =>
        rpc('fs.entries', { path: dirPath }) as Promise<FsaRawEntry[]>,
      stat: (filePath: string) =>
        rpc('fs.stat', { path: filePath }) as Promise<{ size: number; mtimeMs: number }>,
      exists: (filePath: string) => rpc('fs.exists', { path: filePath }) as Promise<boolean>,
      open: (filePath: string) => rpc('fs.open', { path: filePath }) as Promise<number>,
      read: (fd: number, offset: number, length: number) =>
        rpc('fs.read', { handle: fd, offset, length }) as Promise<ArrayBuffer>,
      close: (fd: number) => rpc('fs.close', { handle: fd }) as Promise<void>,
      watch: (watchId: string, dirPath: string) =>
        rpc('fs.watch', { watchId, path: dirPath }) as Promise<boolean>,
      unwatch: (watchId: string) => rpc('fs.unwatch', { watchId }) as Promise<void>,
      writeFile: (filePath: string, data: string) =>
        rpc('fs.writeFile', { path: filePath, data }) as Promise<void>,
      onFsChange(callback: (event: FsChangeEvent) => void): () => void {
        changeListeners.add(callback);
        return () => {
          changeListeners.delete(callback);
        };
      },
    },
    pty: {
      spawn: (cwd: string, cols?: number, rows?: number) =>
        rpc('pty.spawn', { cwd, ...(cols != null && rows != null ? { cols, rows } : {}) }) as Promise<number>,
      write: (ptyId: number, data: string) =>
        rpc('pty.write', { ptyId, data }) as Promise<void>,
      resize: (ptyId: number, cols: number, rows: number) =>
        rpc('pty.resize', { ptyId, cols: Math.floor(cols), rows: Math.floor(rows) }) as Promise<void>,
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
      getIconsPath: () => rpc('utils.getIconsPath', {}) as Promise<string>,
    },
    theme: {
      get: () =>
        Promise.resolve(
          window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
        ),
      onChange(callback: (theme: string) => void): () => void {
        const mq = window.matchMedia('(prefers-color-scheme: dark)');
        const handler = (e: MediaQueryListEvent) =>
          callback(e.matches ? 'dark' : 'light');
        mq.addEventListener('change', handler);
        return () => mq.removeEventListener('change', handler);
      },
    },
    onReconnect(callback: () => void): () => void {
      reconnectCallbacks.add(callback);
      return () => { reconnectCallbacks.delete(callback); };
    },
  };
}
