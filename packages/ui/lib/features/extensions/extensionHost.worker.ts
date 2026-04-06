/**
 * Extension Host Worker
 *
 * Runs in a Web Worker to isolate extension loading from the main thread.
 * Can be safely terminated and restarted to pick up extension changes.
 *
 * Communication protocol with main thread:
 *   Main → Worker:
 *     { type: 'start', dataDir: string }            — begin loading extensions
 *     { type: 'readFileResult', id, data, error? }   — response to a file read request
 *   Worker → Main:
 *     { type: 'readFile', id, path }                 — request file contents
 *     { type: 'loaded', extensions }                 — all extensions loaded
 *     { type: 'error', message }                     — fatal loading error
 */

import { dirname, join, normalizePath } from "../../utils/path";

// ── Types (duplicated subset to avoid importing DOM-dependent modules) ──

interface ExtensionIconTheme {
  id: string;
  label: string;
  path: string;
}

interface ExtensionLanguage {
  id: string;
  aliases?: string[];
  extensions?: string[];
  filenames?: string[];
  configuration?: string;
}

interface ExtensionGrammar {
  language: string;
  scopeName: string;
  path: string;
  embeddedLanguages?: Record<string, string>;
}

interface LoadedGrammar {
  contribution: ExtensionGrammar;
  content: object;
}

interface LoadedGrammarRef {
  contribution: ExtensionGrammar;
  /** Absolute path to the grammar JSON file on disk. */
  path: string;
}

interface ExtensionViewerContribution {
  id: string;
  label: string;
  patterns: string[];
  mimeTypes?: string[];
  entry: string;
  priority?: number;
}

interface ExtensionEditorContribution {
  id: string;
  label: string;
  patterns: string[];
  mimeTypes?: string[];
  langId?: string;
  entry: string;
  priority?: number;
}

interface ExtensionColorTheme {
  id?: string;
  label: string;
  uiTheme: string;
  path: string;
}

interface ExtensionCommand {
  command: string;
  title: string;
  category?: string;
  icon?: string;
}

interface ExtensionKeybinding {
  command: string;
  key: string;
  mac?: string;
  when?: string;
  args?: unknown;
}

interface ExtensionFsProviderContribution {
  id: string;
  label: string;
  patterns: string[];
  entry: string;
  priority?: number;
  runtime?: "frontend" | "backend";
}

interface ExtensionShellIntegration {
  shell: string;
  label: string;
  scriptPath: string;
  executableCandidates: string[];
  platforms?: ("darwin" | "linux" | "unix" | "windows")[];
  hiddenCdTemplate?: string;
  cwdEscape?: "posix" | "powershell" | "cmd";
  lineEnding?: "\n" | "\r\n";
  spawnArgs?: string[];
  scriptArg?: boolean;
}

interface ExtensionContributions {
  iconTheme?: ExtensionIconTheme;
  iconThemes?: ExtensionIconTheme[];
  themes?: ExtensionColorTheme[];
  languages?: ExtensionLanguage[];
  grammars?: ExtensionGrammar[];
  viewers?: ExtensionViewerContribution[];
  editors?: ExtensionEditorContribution[];
  commands?: ExtensionCommand[];
  keybindings?: ExtensionKeybinding[];
  fsProviders?: ExtensionFsProviderContribution[];
  shellIntegrations?: ExtensionShellIntegration[];
}

interface ExtensionManifest {
  name: string;
  version: string;
  publisher: string;
  displayName?: string;
  description?: string;
  icon?: string;
  activationEvents?: string[];
  /**
   * Optional browser activation script entry.
   * If present, the host will load it and call exported `activate()` / `deactivate()`.
   */
  browser?: string;
  contributes?: ExtensionContributions;
}

interface ExtensionRef {
  publisher: string;
  name: string;
  version: string;
  source?: "dotdir-marketplace" | "open-vsx-marketplace";
  autoUpdate?: boolean;
  /** Optional absolute path for development; when set, load from this dir instead of extensionsDir. */
  path?: string;
}

interface WorkerLoadedColorTheme {
  id: string;
  label: string;
  uiTheme: string;
  jsonPath: string;
}

export interface WorkerLoadedExtension {
  ref: ExtensionRef;
  manifest: ExtensionManifest;
  dirPath: string;
  iconUrl?: string;
  iconThemeFss?: string;
  iconThemeFssPath?: string;
  iconThemeBasePath?: string;
  vscodeIconThemePath?: string;
  vscodeIconThemeId?: string;
  colorThemes?: WorkerLoadedColorTheme[];
  languages?: ExtensionLanguage[];
  /** Grammar contributions (lazy JSON loading for editor). */
  grammarRefs?: LoadedGrammarRef[];
  /** Previously loaded grammars (kept for compatibility). */
  grammars?: LoadedGrammar[];
  viewers?: ExtensionViewerContribution[];
  editors?: ExtensionEditorContribution[];
  /** Command contributions from this extension */
  commands?: ExtensionCommand[];
  /** Keybinding contributions from this extension */
  keybindings?: ExtensionKeybinding[];
  /** FsProvider contributions from this extension */
  fsProviders?: ExtensionFsProviderContribution[];
  /** Shell integration contributions (scripts fully loaded). */
  shellIntegrations?: Array<{
    shell: string;
    label: string;
    script: string;
    executableCandidates: string[];
    platforms?: ("darwin" | "linux" | "unix" | "windows")[];
    hiddenCdTemplate?: string;
    cwdEscape?: "posix" | "powershell" | "cmd";
    lineEnding?: "\n" | "\r\n";
    spawnArgs?: string[];
    scriptArg?: boolean;
  }>;
}

// ── File reading via RPC to main thread ─────────────────────────────

let nextRequestId = 0;
const pendingReads = new Map<number, { resolve: (data: string | null) => void; reject: (err: Error) => void }>();
const loadedExtensions = new Map<string, WorkerLoadedExtension>();
const activeExtensions = new Map<
  string,
  {
    subscriptions: Array<{ dispose: () => void }>;
    deactivate?: (ctx: BrowserExtensionContext) => unknown | Promise<unknown>;
  }
>();
const commandHandlers = new Map<string, (...args: unknown[]) => void | Promise<void>>();

type BrowserDisposable = { dispose: () => void };

interface BrowserExtensionContext {
  subscriptions: BrowserDisposable[];
  dotdir: {
    commands: {
      registerCommand: (commandId: string, handler: (...args: unknown[]) => void | Promise<void>) => BrowserDisposable;
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

function readTextFile(path: string): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const id = nextRequestId++;
    pendingReads.set(id, { resolve, reject });
    self.postMessage({ type: "readFile", id, path });
  });
}

function activationKey(ext: WorkerLoadedExtension): string {
  return `${ext.ref.publisher}.${ext.ref.name}.${ext.ref.version}`;
}

function extensionWantsEvent(ext: WorkerLoadedExtension, event: string): boolean {
  const events = ext.manifest.activationEvents ?? [];
  if (events.length === 0) {
    return event === "*";
  }
  return events.includes("*") || events.includes(event);
}

async function importBrowserModule(absScriptPath: string): Promise<BrowserExtensionModule> {
  const script = await readTextFile(absScriptPath);
  if (script == null) {
    throw new Error(`Browser script not found: ${absScriptPath}`);
  }
  const blobUrl = URL.createObjectURL(new Blob([script], { type: "text/javascript" }));
  try {
    const mod = await import(/* @vite-ignore */ blobUrl);
    return mod as BrowserExtensionModule;
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
}

async function activateExtension(ext: WorkerLoadedExtension): Promise<void> {
  const key = activationKey(ext);
  if (activeExtensions.has(key)) return;
  if (!ext.manifest.browser) return;

  const relScript = normalizePath(ext.manifest.browser).replace(/^\/+/, "");
  const absScriptPath = join(ext.dirPath, relScript);
  const mod = await importBrowserModule(absScriptPath);
  const activate = mod.activate ?? mod.default?.activate;
  const deactivate = mod.deactivate ?? mod.default?.deactivate;
  if (typeof activate !== "function") {
    console.warn(`[ExtHost] ${key} browser entry has no activate() export`);
    return;
  }

  const localDisposables: BrowserDisposable[] = [];
  const dotdir = {
    commands: {
      registerCommand: (commandId: string, handler: (...args: unknown[]) => void | Promise<void>): BrowserDisposable => {
        commandHandlers.set(commandId, handler);
        const disposable = {
          dispose: () => {
            const current = commandHandlers.get(commandId);
            if (current === handler) {
              commandHandlers.delete(commandId);
            }
          },
        };
        localDisposables.push(disposable);
        return disposable;
      },
    },
  };

  const ctx: BrowserExtensionContext = {
    subscriptions: localDisposables,
    dotdir,
  };

  (self as unknown as { dotdir?: unknown }).dotdir = dotdir;
  await activate(ctx);
  activeExtensions.set(key, { subscriptions: localDisposables, deactivate });
}

async function activateByEvent(event: string): Promise<void> {
  for (const ext of loadedExtensions.values()) {
    if (!ext.manifest.browser) continue;
    if (!extensionWantsEvent(ext, event)) continue;
    try {
      await activateExtension(ext);
    } catch (err) {
      console.error("[ExtHost] activate failed:", activationKey(ext), err);
    }
  }
}

async function runCommand(command: string, args: unknown[]): Promise<void> {
  await activateByEvent(`onCommand:${command}`);
  const handler = commandHandlers.get(command);
  if (!handler) return;
  await handler(...args);
}

// ── Extension loading logic ─────────────────────────────────────────

function extensionDirName(ref: ExtensionRef): string {
  return `${ref.publisher}-${ref.name}-${ref.version}`;
}

async function loadExtensionFromDir(extDir: string): Promise<WorkerLoadedExtension | null> {
  try {
    const manifestText = await readTextFile(join(extDir, "package.json"));
    if (manifestText === null) return null;
    const manifest: ExtensionManifest = JSON.parse(manifestText);

    const ref: ExtensionRef = {
      publisher: manifest.publisher || "unknown",
      name: manifest.name || "unknown",
      version: manifest.version || "0.0.0",
    };

    let iconThemeFssPath: string | undefined;
    let iconThemeBasePath: string | undefined;
    let vscodeIconThemePath: string | undefined;
    let vscodeIconThemeId: string | undefined;
    if (manifest.contributes?.iconTheme?.path) {
      const themePath = join(extDir, manifest.contributes.iconTheme.path);
      if (themePath.endsWith(".json")) {
        vscodeIconThemePath = themePath;
        vscodeIconThemeId = manifest.contributes.iconTheme.id;
      } else {
        iconThemeFssPath = themePath;
        iconThemeBasePath = dirname(themePath);
      }
    }

    if (manifest.contributes?.iconThemes?.length && !vscodeIconThemePath) {
      const firstTheme = manifest.contributes.iconThemes[0];
      vscodeIconThemePath = join(extDir, firstTheme.path);
      vscodeIconThemeId = firstTheme.id;
    }

    const languages = manifest.contributes?.languages;

    let grammarRefs: LoadedGrammarRef[] | undefined;
    if (manifest.contributes?.grammars?.length) {
      grammarRefs = [];
      for (const grammarContrib of manifest.contributes.grammars) {
        try {
          const grammarPath = join(extDir, grammarContrib.path);
          // Lazy: don't parse JSON yet; Monaco will load per-language on demand.
          grammarRefs.push({ contribution: grammarContrib, path: grammarPath });
        } catch {
          // Skip grammars that fail to load
        }
      }
    }

    let colorThemes: WorkerLoadedColorTheme[] | undefined;
    if (manifest.contributes?.themes?.length) {
      colorThemes = manifest.contributes.themes.map((t, i) => ({
        id: t.id || `${t.label}#${i}`,
        label: t.label,
        uiTheme: t.uiTheme,
        jsonPath: join(extDir, t.path),
      }));
    }

    const viewers = manifest.contributes?.viewers;
    const editors = manifest.contributes?.editors;
    const commands = manifest.contributes?.commands;
    const keybindings = manifest.contributes?.keybindings;
    const fsProviders = manifest.contributes?.fsProviders;

    let shellIntegrations: WorkerLoadedExtension["shellIntegrations"];
    if (manifest.contributes?.shellIntegrations?.length) {
      shellIntegrations = [];
      for (const si of manifest.contributes.shellIntegrations) {
        const script = await readTextFile(join(extDir, si.scriptPath));
        if (script !== null) {
          shellIntegrations.push({
            shell: si.shell,
            label: si.label,
            script,
            executableCandidates: si.executableCandidates ?? [],
            platforms: si.platforms,
            hiddenCdTemplate: si.hiddenCdTemplate,
            cwdEscape: si.cwdEscape,
            lineEnding: si.lineEnding,
            spawnArgs: si.spawnArgs,
            scriptArg: si.scriptArg,
          });
        }
      }
    }

    return {
      ref,
      manifest,
      dirPath: extDir,
      iconUrl: manifest.icon ? join(extDir, normalizePath(manifest.icon).replace(/^\/+/, "")) : undefined,
      iconThemeFssPath,
      iconThemeBasePath,
      vscodeIconThemePath,
      vscodeIconThemeId,
      colorThemes,
      languages,
      grammarRefs,
      viewers,
      editors,
      commands,
      keybindings,
      fsProviders,
      shellIntegrations,
    };
  } catch {
    return null;
  }
}

async function loadExtensions(dataDir: string): Promise<WorkerLoadedExtension[]> {
  const loaded: WorkerLoadedExtension[] = [];

  const extensionsDir = join(dataDir, "extensions");
  let refs: ExtensionRef[];
  try {
    const text = await readTextFile(join(extensionsDir, "extensions.json"));
    if (text === null) return loaded;
    const parsed = JSON.parse(text);
    refs = Array.isArray(parsed) ? parsed : [];
  } catch {
    return loaded;
  }

  for (const ref of refs) {
    if (!ref.publisher || !ref.name || !ref.version) continue;
    const extDir = ref.path ? normalizePath(ref.path) : join(extensionsDir, extensionDirName(ref));
    const ext = await loadExtensionFromDir(extDir);
    if (ext) loaded.push(ext);
  }

  console.log(
    "[ExtHost] loaded",
    loaded.length,
    "extensions; FSS:",
    loaded.filter((e) => e.iconThemeFss).map((e) => `${e.ref.publisher}.${e.ref.name}`),
    "vscode:",
    loaded.filter((e) => e.vscodeIconThemePath).map((e) => `${e.ref.publisher}.${e.ref.name}`),
  );
  loadedExtensions.clear();
  for (const ext of loaded) {
    loadedExtensions.set(activationKey(ext), ext);
  }
  return loaded;
}

// ── Message handler ─────────────────────────────────────────────────

self.onmessage = (e: MessageEvent) => {
  const msg = e.data;

  if (msg.type === "start") {
    loadExtensions(msg.dataDir)
      .then(async (extensions) => {
        await activateByEvent("*");
        self.postMessage({ type: "loaded", extensions });
      })
      .catch((err: unknown) => {
        const msg =
          err instanceof Error ? err.message : err && typeof err === "object" && "message" in err ? String((err as { message: unknown }).message) : String(err);
        self.postMessage({ type: "error", message: msg });
      });
  } else if (msg.type === "activateByEvent") {
    const requestId = Number(msg.requestId);
    activateByEvent(String(msg.event ?? ""))
      .then(() => {
        self.postMessage({ type: "requestResult", requestId, result: null });
      })
      .catch((err: unknown) => {
        const errMsg = err instanceof Error ? err.message : String(err);
        self.postMessage({ type: "requestResult", requestId, error: errMsg });
      });
  } else if (msg.type === "executeCommand") {
    const requestId = Number(msg.requestId);
    const command = String(msg.command ?? "");
    const args = Array.isArray(msg.args) ? msg.args : [];
    runCommand(command, args)
      .then(() => {
        self.postMessage({ type: "requestResult", requestId, result: null });
      })
      .catch((err: unknown) => {
        const errMsg = err instanceof Error ? err.message : String(err);
        self.postMessage({ type: "requestResult", requestId, error: errMsg });
      });
  } else if (msg.type === "readFileResult") {
    const pending = pendingReads.get(msg.id);
    if (pending) {
      pendingReads.delete(msg.id);
      if (msg.error) {
        pending.resolve(null);
      } else {
        pending.resolve(msg.data);
      }
    }
  }
};
