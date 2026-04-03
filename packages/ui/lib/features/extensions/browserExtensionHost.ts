import { type CommandRegistry, useCommandRegistry } from "@/features/commands/commands";
import type { LoadedExtension } from "@/features/extensions/extensions";
import { useVfsUrlResolver } from "@/features/file-system/vfs";
import { join, normalizePath } from "@/utils/path";
import { useEffect, useMemo, useRef } from "react";

export type BrowserDisposable = { dispose: () => void };

export interface BrowserExtensionContext {
  subscriptions: BrowserDisposable[];
  dotdir: {
    commands: {
      registerCommand: (
        commandId: string,
        handler: (...args: unknown[]) => void | Promise<void>,
      ) => BrowserDisposable;
    };
  };
}

type BrowserExtensionModule = {
  activate?: (ctx: BrowserExtensionContext) => unknown | Promise<unknown>;
  deactivate?: (ctx: BrowserExtensionContext) => unknown | Promise<unknown>;
  default?: {
    activate?: (ctx: BrowserExtensionContext) => unknown | Promise<unknown>;
    deactivate?: (ctx: BrowserExtensionContext) => unknown | Promise<unknown>;
  };
};

interface ActiveActivation {
  module: BrowserExtensionModule;
  ctx: BrowserExtensionContext;
  deactivate?: BrowserExtensionModule["deactivate"];
  // Cache keybindings disposables are stored inside ctx.subscriptions by extension code.
}

export interface BrowserExtensionHost {
  reconcile: (extensions: LoadedExtension[]) => Promise<void>;
  dispose: () => Promise<void>;
}

function extActivationKey(ext: LoadedExtension): string {
  return `${ext.ref.publisher}.${ext.ref.name}.${ext.ref.version}`;
}

async function loadBrowserModule(scriptUrl: string): Promise<BrowserExtensionModule> {
  // Try ESM first.
  try {
    const bust = `${scriptUrl}${scriptUrl.includes("?") ? "&" : "?"}t=${Date.now()}`;
    const mod = await import(/* @vite-ignore */ bust);
    return mod as BrowserExtensionModule;
  } catch {
    // Fallback: classic script injection. Non-ESM scripts must attach exports via globals.
    return await new Promise<BrowserExtensionModule>((resolve, reject) => {
      const prevReady = (globalThis as any).__dotdirBrowserExtensionReady as undefined | ((m: any) => void);
      const prevExports = (globalThis as any).__dotdirBrowserExtensionExports;
      const timeoutMs = 10000;
      let done = false;

      const cleanup = () => {
        delete (globalThis as any).__dotdirBrowserExtensionReady;
        (globalThis as any).__dotdirBrowserExtensionExports = prevExports;
        if (prevReady) (globalThis as any).__dotdirBrowserExtensionReady = prevReady;
      };

      (globalThis as any).__dotdirBrowserExtensionReady = (m: any) => {
        if (done) return;
        done = true;
        cleanup();
        resolve(m as BrowserExtensionModule);
      };

      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        const exports = (globalThis as any).__dotdirBrowserExtensionExports ?? (globalThis as any).__dotdirBrowserExports ?? {};
        cleanup();
        resolve(exports as BrowserExtensionModule);
      }, timeoutMs);

      const script = document.createElement("script");
      script.src = scriptUrl;
      script.async = true;
      script.onerror = () => {
        if (done) return;
        clearTimeout(timer);
        cleanup();
        reject(new Error("Failed to load browser extension script"));
      };
      script.onload = () => {
        if (done) return;
        clearTimeout(timer);
        const exports = (globalThis as any).__dotdirBrowserExtensionExports ?? (globalThis as any).__dotdirBrowserExports ?? null;
        if (exports) {
          done = true;
          cleanup();
          resolve(exports as BrowserExtensionModule);
          return;
        }

        // Last resort: allow scripts to set window.activate / window.deactivate.
        if (typeof (globalThis as any).activate === "function") {
          done = true;
          cleanup();
          resolve({
            activate: (globalThis as any).activate,
            deactivate: (globalThis as any).deactivate,
            contributes: (globalThis as any).contributes,
          } as BrowserExtensionModule);
        } else {
          cleanup();
          reject(new Error("Browser script loaded, but no exports were found"));
        }
      };

      document.head.appendChild(script);
    });
  }
}

function createDotdirApi(commandRegistry: CommandRegistry) {
  return {
    commands: {
      registerCommand: (
        commandId: string,
        handler: (...args: unknown[]) => void | Promise<void>,
      ): BrowserDisposable => {
        return { dispose: commandRegistry.registerCommand(commandId, handler) };
      },
    },
  };
}

export function useBrowserExtensionHost(): BrowserExtensionHost {
  const commandRegistry = useCommandRegistry();
  const resolveVfsUrl = useVfsUrlResolver();
  const activeRef = useRef(new Map<string, ActiveActivation>());
  const queueRef = useRef<Promise<void>>(Promise.resolve());
  const host = useMemo(() => {
    const dotdir = createDotdirApi(commandRegistry);

    const deactivateOne = async (key: string, active: ActiveActivation): Promise<void> => {
      try {
        if (active.deactivate) await active.deactivate(active.ctx);
      } catch (err) {
        console.error(`[BrowserExtensionHost] ${key} deactivate() failed:`, err);
      }

      for (const d of active.ctx.subscriptions) {
        try {
          d.dispose();
        } catch {
          // ignore
        }
      }

      activeRef.current.delete(key);
    };

    const activateOne = async (ext: LoadedExtension): Promise<void> => {
      const key = extActivationKey(ext);
      const scriptRel = ext.manifest.browser!;
      const absScriptPath = join(ext.dirPath, normalizePath(scriptRel).replace(/^\//, ""));
      const scriptUrl = resolveVfsUrl(absScriptPath);

      const module = await loadBrowserModule(scriptUrl);
      const activateFn = module.activate ?? module.default?.activate;
      const deactivateFn = module.deactivate ?? module.default?.deactivate;

      if (typeof activateFn !== "function") {
        console.warn(`[BrowserExtensionHost] ${key} has a browser entry but no activate() export`);
        return;
      }

      const ctx: BrowserExtensionContext = { subscriptions: [], dotdir: dotdir as any };

      // Also expose a VS Code-like global (some extensions may rely on it).
      (globalThis as any).dotdir = dotdir;

      await activateFn(ctx);

      activeRef.current.set(key, { module, ctx, deactivate: deactivateFn });
    };

    return {
      async reconcile(extensions: LoadedExtension[]): Promise<void> {
        queueRef.current = queueRef.current
          .then(async () => {
            const nextKeys = new Set(extensions.map(extActivationKey));

            for (const [key, active] of Array.from(activeRef.current.entries())) {
              if (nextKeys.has(key)) continue;
              await deactivateOne(key, active);
            }

            for (const ext of extensions) {
              const key = extActivationKey(ext);
              if (activeRef.current.has(key)) continue;
              if (!ext.manifest.browser) continue;
              await activateOne(ext);
            }
          })
          .catch((err) => {
            console.error("[BrowserExtensionHost] reconcile failed:", err);
          });

        return queueRef.current;
      },
      async dispose(): Promise<void> {
        const entries = Array.from(activeRef.current.entries());
        activeRef.current.clear();
        await Promise.all(entries.map(([key, active]) => deactivateOne(key, active)));
      },
    };
  }, [commandRegistry, resolveVfsUrl]);

  useEffect(() => {
    return () => {
      void host.dispose();
    };
  }, [host]);

  return host;
}
