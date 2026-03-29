/**
 * Loads fsProvider extension bundles in the main browser context (no iframe isolation).
 *
 * Protocol:
 *   1. The host reads the CJS bundle from disk and creates a blob URL.
 *   2. It injects `window.__dotdirProviderHostApi` with HostApi methods before
 *      the script runs.  (The bundle may call hostApi.readFile() etc. during init
 *      or during listEntries().)
 *   3. The bundle assigns a factory to `window.__dotdirProviderReady`.
 *   4. After the script's `onload`, the host calls the factory with the hostApi
 *      and stores the returned FsProviderExtensionApi.
 *
 * Loaded providers are cached by (extensionDirPath + entry) so the bundle is only
 * evaluated once per extension.
 */

import type { FsProviderExtensionApi, FsProviderHostApi } from "@/features/extensions/extensionApi";
import { readFileBuffer, readFileText } from "@/fs";
import { join } from "@/path";
import { Bridge } from "@/shared/api/bridge";

/** Cache: key → settled Promise<FsProviderExtensionApi> */
const cache = new Map<string, Promise<FsProviderExtensionApi>>();

function makeHostApi(bridge: Bridge): FsProviderHostApi {
  return {
    async readFile(realPath: string): Promise<ArrayBuffer> {
      return readFileBuffer(bridge, realPath);
    },
    async readFileRange(realPath: string, offset: number, length: number): Promise<ArrayBuffer> {
      const fd = await bridge.fs.open(realPath);
      try {
        return await bridge.fs.read(fd, offset, length);
      } finally {
        await bridge.fs.close(fd);
      }
    },
  };
}

export function loadFsProvider(bridge: Bridge, extensionDirPath: string, entry: string): Promise<FsProviderExtensionApi> {
  const key = extensionDirPath + "\x1f" + entry;
  const cached = cache.get(key);
  if (cached) return cached;

  const promise = (async (): Promise<FsProviderExtensionApi> => {
    const scriptPath = join(extensionDirPath, entry);
    const code = await readFileText(bridge, scriptPath);

    const hostApi = makeHostApi(bridge);

    return new Promise<FsProviderExtensionApi>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`fsProvider "${entry}" did not register within 5 s`));
      }, 5000);

      // Inject the blob script; the bundle must assign window.__dotdirProviderReady.
      const blob = new Blob([code], { type: "application/javascript" });
      const url = URL.createObjectURL(blob);
      const script = document.createElement("script");
      script.src = url;

      script.onerror = () => {
        clearTimeout(timeout);
        URL.revokeObjectURL(url);
        reject(new Error(`Failed to load fsProvider script "${entry}"`));
      };

      script.onload = () => {
        URL.revokeObjectURL(url);
        clearTimeout(timeout);
        const factory = window.__dotdirProviderReady;
        if (typeof factory !== "function") {
          reject(new Error(`fsProvider "${entry}" did not set window.__dotdirProviderReady`));
          return;
        }
        // Clear global so the next provider load gets a clean slate.
        window.__dotdirProviderReady = undefined;
        try {
          const api = factory(hostApi);
          resolve(api);
        } catch (err) {
          reject(err);
        }
      };

      document.head.appendChild(script);
    });
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
