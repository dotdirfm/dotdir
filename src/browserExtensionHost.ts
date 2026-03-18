import { commandRegistry } from './commands';
import { join, normalizePath } from './path';
import { vfsUrl } from './vfs';
import type { LoadedExtension } from './extensions';

export type BrowserDisposable = { dispose: () => void };

export interface BrowserExtensionKeybinding {
  command: string;
  key: string;
  mac?: string;
  when?: string;
}

export interface BrowserExtensionContributions {
  keybindings?: BrowserExtensionKeybinding[];
}

export interface BrowserExtensionContext {
  subscriptions: BrowserDisposable[];
  frdy: {
    commands: {
      registerCommand: (
        commandId: string,
        handler: (...args: unknown[]) => void | Promise<void>,
        options?: { title?: string; category?: string; icon?: string; when?: string }
      ) => BrowserDisposable;
      registerKeybinding: (binding: BrowserExtensionKeybinding) => BrowserDisposable;
    };
  };
}

type BrowserExtensionModule = {
  activate?: (ctx: BrowserExtensionContext) => unknown | Promise<unknown>;
  deactivate?: (ctx: BrowserExtensionContext) => unknown | Promise<unknown>;
  contributes?: BrowserExtensionContributions;
  default?: {
    activate?: (ctx: BrowserExtensionContext) => unknown | Promise<unknown>;
    deactivate?: (ctx: BrowserExtensionContext) => unknown | Promise<unknown>;
    contributes?: BrowserExtensionContributions;
  };
};

interface ActiveActivation {
  module: BrowserExtensionModule;
  ctx: BrowserExtensionContext;
  deactivate?: BrowserExtensionModule['deactivate'];
  // Cache keybindings disposables are stored inside ctx.subscriptions by extension code.
}

function extActivationKey(ext: LoadedExtension): string {
  return `${ext.ref.publisher}.${ext.ref.name}.${ext.ref.version}`;
}

async function loadBrowserModule(scriptUrl: string): Promise<BrowserExtensionModule> {
  // Try ESM first.
  try {
    const bust = `${scriptUrl}${scriptUrl.includes('?') ? '&' : '?'}t=${Date.now()}`;
    const mod = await import(/* @vite-ignore */ bust);
    return mod as BrowserExtensionModule;
  } catch (e) {
    // Fallback: classic script injection. Non-ESM scripts must attach exports via globals.
    return await new Promise<BrowserExtensionModule>((resolve, reject) => {
      const prevReady = (globalThis as any).__faradayBrowserExtensionReady as undefined | ((m: any) => void);
      const prevExports = (globalThis as any).__faradayBrowserExtensionExports;
      const timeoutMs = 10000;
      let done = false;

      const cleanup = () => {
        delete (globalThis as any).__faradayBrowserExtensionReady;
        (globalThis as any).__faradayBrowserExtensionExports = prevExports;
        if (prevReady) (globalThis as any).__faradayBrowserExtensionReady = prevReady;
      };

      (globalThis as any).__faradayBrowserExtensionReady = (m: any) => {
        if (done) return;
        done = true;
        cleanup();
        resolve(m as BrowserExtensionModule);
      };

      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        const exports =
          (globalThis as any).__faradayBrowserExtensionExports ??
          (globalThis as any).__faradayBrowserExports ??
          {};
        cleanup();
        resolve(exports as BrowserExtensionModule);
      }, timeoutMs);

      const script = document.createElement('script');
      script.src = scriptUrl;
      script.async = true;
      script.onerror = () => {
        if (done) return;
        clearTimeout(timer);
        cleanup();
        reject(new Error('Failed to load browser extension script'));
      };
      script.onload = () => {
        if (done) return;
        clearTimeout(timer);
        const exports =
          (globalThis as any).__faradayBrowserExtensionExports ??
          (globalThis as any).__faradayBrowserExports ??
          null;
        if (exports) {
          done = true;
          cleanup();
          resolve(exports as BrowserExtensionModule);
          return;
        }

        // Last resort: allow scripts to set window.activate / window.deactivate.
        if (typeof (globalThis as any).activate === 'function') {
          done = true;
          cleanup();
          resolve({
            activate: (globalThis as any).activate,
            deactivate: (globalThis as any).deactivate,
            contributes: (globalThis as any).contributes,
          } as BrowserExtensionModule);
        } else {
          cleanup();
          reject(new Error('Browser script loaded, but no exports were found'));
        }
      };

      document.head.appendChild(script);
    });
  }
}

export class BrowserExtensionHost {
  private active = new Map<string, ActiveActivation>();
  private queue: Promise<void> = Promise.resolve();

  private frdy = {
    commands: {
      registerCommand: (
        commandId: string,
        handler: (...args: unknown[]) => void | Promise<void>,
        options?: { title?: string; category?: string; icon?: string; when?: string }
      ): BrowserDisposable => {
        const existing = commandRegistry.getCommand(commandId);
        const title = options?.title ?? existing?.title ?? commandId;
        const category = options?.category ?? existing?.category;
        const icon = options?.icon ?? existing?.icon;
        const when = options?.when ?? existing?.when;

        const disposeFn = commandRegistry.registerCommand(commandId, title, handler, { category, icon, when });
        return { dispose: disposeFn };
      },
      registerKeybinding: (binding: BrowserExtensionKeybinding): BrowserDisposable => {
        const disposeFn = commandRegistry.registerKeybinding(
          { command: binding.command, key: binding.key, mac: binding.mac, when: binding.when },
          'extension'
        );
        return { dispose: disposeFn };
      },
    },
  };

  async reconcile(extensions: LoadedExtension[]): Promise<void> {
    this.queue = this.queue
      .then(async () => {
        const nextKeys = new Set(extensions.map(extActivationKey));

        // Deactivate removed extensions first.
        for (const [key, active] of Array.from(this.active.entries())) {
          if (nextKeys.has(key)) continue;
          await this.deactivateOne(key, active);
        }

        // Activate new extensions.
        for (const ext of extensions) {
          const key = extActivationKey(ext);
          if (this.active.has(key)) continue;
          if (!ext.manifest.browser) continue;
          await this.activateOne(ext);
        }
      })
      .catch((err) => {
        console.error('[BrowserExtensionHost] reconcile failed:', err);
      });

    return this.queue;
  }

  private async activateOne(ext: LoadedExtension): Promise<void> {
    const key = extActivationKey(ext);
    const scriptRel = ext.manifest.browser!;
    const absScriptPath = join(ext.dirPath, normalizePath(scriptRel).replace(/^\//, ''));
    const scriptUrl = vfsUrl(absScriptPath);

    const module = await loadBrowserModule(scriptUrl);
    const activateFn = module.activate ?? module.default?.activate;
    const deactivateFn = module.deactivate ?? module.default?.deactivate;

    if (typeof activateFn !== 'function') {
      console.warn(`[BrowserExtensionHost] ${key} has a browser entry but no activate() export`);
      return;
    }

    const ctx: BrowserExtensionContext = { subscriptions: [], frdy: this.frdy as any };

    // Also expose a VS Code-like global (some extensions may rely on it).
    (globalThis as any).frdy = this.frdy;

    const activationResult = await activateFn(ctx);

    const contributes: BrowserExtensionContributions | undefined =
      module.contributes ??
      module.default?.contributes ??
      (activationResult as any)?.contributes;

    if (contributes?.keybindings?.length) {
      for (const kb of contributes.keybindings) {
        const disposable = this.frdy.commands.registerKeybinding(kb);
        ctx.subscriptions.push(disposable);
      }
    }

    this.active.set(key, { module, ctx, deactivate: deactivateFn });
  }

  private async deactivateOne(key: string, active: ActiveActivation): Promise<void> {
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

    this.active.delete(key);
  }

  async dispose(): Promise<void> {
    const entries = Array.from(this.active.entries());
    this.active.clear();
    await Promise.all(entries.map(([key, active]) => this.deactivateOne(key, active)));
  }
}

