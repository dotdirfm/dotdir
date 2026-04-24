/**
 * Loads frontend fsProvider extension bundles in an isolated Web Worker.
 *
 * The provider registration shape stays source-compatible with existing bundles:
 * the bundle assigns `window.__dotdirProviderReady = (hostApi) => providerApi`.
 * Inside this loader, `window` is a worker-global shim, not the app document.
 */

import type { Bridge } from "@/features/bridge";
import type { FsProviderEntry, FsProviderExtensionApi } from "@/features/extensions/extensionApi";
import { readFileText } from "@/features/file-system/fs";
import { join } from "@/utils/path";

type ProviderWorkerReadyMsg = { type: "ready" };
type ProviderWorkerErrorMsg = { type: "error"; message: string };
type ProviderWorkerResultMsg = { type: "result"; id: number; result?: unknown; bytes?: ArrayBuffer; error?: string };
type ProviderWorkerHostCallMsg = { type: "host:call"; id: number; method: "readFile" | "readFileRange"; args: unknown[] };
type ProviderWorkerMessage = ProviderWorkerReadyMsg | ProviderWorkerErrorMsg | ProviderWorkerResultMsg | ProviderWorkerHostCallMsg;

/** Cache: key -> settled Promise<FsProviderExtensionApi> */
const cache = new Map<string, Promise<FsProviderExtensionApi>>();

function buildProviderWorkerSource(providerCode: string): string {
  return `
const window = globalThis;
globalThis.window = globalThis;
let __nextHostCallId = 1;
const __pendingHostCalls = new Map();
const __hostApi = {
  readFile(realPath) {
    return __callHost("readFile", [realPath]);
  },
  readFileRange(realPath, offset, length) {
    return __callHost("readFileRange", [realPath, offset, length]);
  },
};
function __callHost(method, args) {
  const id = __nextHostCallId++;
  return new Promise((resolve, reject) => {
    __pendingHostCalls.set(id, { resolve, reject });
    postMessage({ type: "host:call", id, method, args });
  });
}
onmessage = (event) => {
  const data = event.data || {};
  if (data.type === "host:result") {
    const pending = __pendingHostCalls.get(data.id);
    if (!pending) return;
    __pendingHostCalls.delete(data.id);
    if (data.error) pending.reject(new Error(String(data.error)));
    else pending.resolve(data.bytes ?? data.result);
    return;
  }
  if (data.type === "provider:call") {
    const { id, method, args } = data;
    Promise.resolve()
      .then(() => {
        if (!__provider || typeof __provider[method] !== "function") {
          throw new Error("Provider method not found: " + method);
        }
        return __provider[method](...(Array.isArray(args) ? args : []));
      })
      .then((result) => {
        if (result instanceof ArrayBuffer) {
          postMessage({ type: "result", id, bytes: result }, [result]);
        } else {
          postMessage({ type: "result", id, result });
        }
      })
      .catch((error) => {
        postMessage({ type: "result", id, error: error instanceof Error ? error.message : String(error) });
      });
  }
};
let __provider = null;
try {
${providerCode}
  const factory = globalThis.__dotdirProviderReady;
  if (typeof factory !== "function") throw new Error("Provider did not set window.__dotdirProviderReady");
  __provider = factory(__hostApi);
  postMessage({ type: "ready" });
} catch (error) {
  postMessage({ type: "error", message: error instanceof Error ? error.message : String(error) });
}
`;
}

function createProviderProxy(bridge: Bridge, worker: Worker): Promise<FsProviderExtensionApi> {
  let nextCallId = 1;
  const pendingProviderCalls = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();

  const callProvider = async <T>(method: "listEntries" | "readFileRange", args: unknown[]): Promise<T> => {
    const id = nextCallId++;
    return await new Promise<T>((resolve, reject) => {
      pendingProviderCalls.set(id, { resolve: resolve as (value: unknown) => void, reject });
      worker.postMessage({ type: "provider:call", id, method, args });
    });
  };

  return new Promise<FsProviderExtensionApi>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("fsProvider did not register within 5 s"));
    }, 5000);

    worker.onmessage = (event: MessageEvent<ProviderWorkerMessage>) => {
      const data = event.data;
      if (data.type === "ready") {
        clearTimeout(timeout);
        resolve({
          async listEntries(containerPath: string, innerPath: string): Promise<FsProviderEntry[]> {
            return await callProvider<FsProviderEntry[]>("listEntries", [containerPath, innerPath]);
          },
          async readFileRange(containerPath: string, innerPath: string, offset: number, length: number): Promise<ArrayBuffer> {
            return await callProvider<ArrayBuffer>("readFileRange", [containerPath, innerPath, offset, length]);
          },
        });
        return;
      }
      if (data.type === "error") {
        clearTimeout(timeout);
        reject(new Error(data.message));
        return;
      }
      if (data.type === "result") {
        const pending = pendingProviderCalls.get(data.id);
        if (!pending) return;
        pendingProviderCalls.delete(data.id);
        if (data.error) pending.reject(new Error(data.error));
        else pending.resolve(data.bytes ?? data.result);
        return;
      }
      if (data.type === "host:call") {
        void (async () => {
          try {
            let result: unknown;
            let transfer: Transferable[] | undefined;
            if (data.method === "readFile") {
              const bytes = await bridge.fs.readFile(String(data.args[0] ?? ""));
              result = bytes;
              transfer = [bytes];
            } else {
              const realPath = String(data.args[0] ?? "");
              const offset = Number(data.args[1] ?? 0);
              const length = Number(data.args[2] ?? 0);
              const fd = await bridge.fs.open(realPath);
              try {
                const bytes = await bridge.fs.read(fd, offset, length);
                result = bytes;
                transfer = [bytes];
              } finally {
                await bridge.fs.close(fd);
              }
            }
            worker.postMessage({ type: "host:result", id: data.id, bytes: result }, transfer);
          } catch (error) {
            worker.postMessage({ type: "host:result", id: data.id, error: error instanceof Error ? error.message : String(error) });
          }
        })();
      }
    };

    worker.onerror = (event) => {
      clearTimeout(timeout);
      reject(new Error(event.message || "fsProvider worker failed"));
    };
  });
}

export function loadFsProvider(bridge: Bridge, extensionDirPath: string, entry: string): Promise<FsProviderExtensionApi> {
  const key = extensionDirPath + "\x1f" + entry;
  const cached = cache.get(key);
  if (cached) return cached;

  const promise = (async (): Promise<FsProviderExtensionApi> => {
    const scriptPath = join(extensionDirPath, entry);
    const code = await readFileText(bridge, scriptPath);
    const blob = new Blob([buildProviderWorkerSource(code)], { type: "application/javascript" });
    const url = URL.createObjectURL(blob);
    try {
      const worker = new Worker(url);
      return await createProviderProxy(bridge, worker);
    } finally {
      URL.revokeObjectURL(url);
    }
  })();

  // On failure, remove from cache so a retry is possible.
  promise.catch(() => cache.delete(key));
  cache.set(key, promise);
  return promise;
}

/** Evict all cached providers (e.g. when extensions reload). */
export function clearFsProviderCache(): void {
  cache.clear();
}
