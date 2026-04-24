/**
 * Extension Host Worker
 *
 * Runs in a Web Worker to isolate extension loading from the main thread.
 * Hosts the VS Code API shim (`vscodeShim/*`) and bridges LSP/provider
 * calls over postMessage to the main thread where Monaco lives.
 *
 * See `ehProtocol.ts` for the full set of messages exchanged.
 */

import { dirname, join, normalizePath } from "../../utils/path";
import type {
  HostToMainMessage,
  MainToHostMessage,
  DiagnosticPayload,
  PositionPayload,
  RangePayload,
  TextEditPayload,
  CompletionItemPayload,
  CompletionListPayload,
  HoverPayload,
  DocumentSymbolPayload,
  SymbolInformationPayload,
  FoldingRangePayload,
  SelectionRangePayload,
  LocationPayload,
  DocumentHighlightPayload,
  ColorInformationPayload,
  ColorPresentationPayload,
  DocumentLinkPayload,
  SignatureHelpPayload,
  CodeActionPayload,
  CodeLensPayload,
} from "./ehProtocol";
import {
  createVscodeNamespace,
  installWorkerRpc,
  installCommandAdapter,
  stashCommandArguments,
  resolveStashedCommandArguments,
  setActiveExtensionKey,
  setDataDir,
  setWorkspaceFolders,
  setActiveEditor,
  loadConfigDefaults,
  loadLanguageDefaults,
  updateUserConfigValue,
  textDocuments,
  registerExtension,
  markExtensionActive,
  getProvider,
  logActivation,
  workspace as vscodeWorkspace,
  type WorkerRpc,
  type WorkerRpcHandler,
} from "./vscodeShim";
import { Disposable } from "./vscodeShim/events";
import {
  CompletionList,
  DocumentSymbol,
  MarkdownString,
  Position,
  Range,
  Uri,
  type CompletionItem,
  type CompletionItemLabel,
  type Diagnostic,
  type DocumentLink,
  type FoldingRange,
  type Hover,
  type Location,
  type MarkedString,
  type SelectionRange,
  type SymbolInformation,
  type TextEdit,
} from "./vscodeShim/types";
import { ExtensionMode, registerExtension as _reg } from "./vscodeShim/extensions";
import { extensionDirName, normalizeExtensionManifest } from "./manifestNormalizer";
import type { ExtensionManifest, ExtensionRef, LoadedExtension } from "./types";

void _reg;

export type WorkerLoadedExtension = LoadedExtension;

// ── Mutable worker-scoped state ─────────────────────────────────────

const loadedExtensions = new Map<string, WorkerLoadedExtension>();
const activeExtensions = new Map<
  string,
  { subscriptions: Array<{ dispose: () => void }>; deactivate?: (ctx: unknown) => unknown | Promise<unknown> }
>();

const commandHandlers = new Map<string, (...args: unknown[]) => unknown | Promise<unknown>>();

// ── Low-level RPC plumbing ──────────────────────────────────────────

let nextRequestId = 1;
let nextReadId = 1;
const pendingRequests = new Map<number, { resolve: (value: unknown) => void; reject: (err: Error) => void }>();
const pendingReads = new Map<number, { resolve: (data: string | null) => void; reject: (err: Error) => void }>();
const pendingBinaryReads = new Map<number, { resolve: (data: ArrayBuffer | null) => void; reject: (err: Error) => void }>();
const subscribers = new Map<MainToHostMessage["type"], Set<WorkerRpcHandler>>();

function sendToMain(msg: HostToMainMessage): void {
  (self as unknown as { postMessage: (data: unknown) => void }).postMessage(msg);
}

function requestFromMain<T = unknown>(msg: HostToMainMessage & { requestId: number }): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    pendingRequests.set(msg.requestId, {
      resolve: resolve as (value: unknown) => void,
      reject,
    });
    sendToMain(msg);
  });
}

const rpc: WorkerRpc = {
  send: sendToMain,
  request: requestFromMain,
  nextRequestId: () => nextRequestId++,
  dispatch: (msg: MainToHostMessage): boolean => {
    const set = subscribers.get(msg.type);
    if (!set || set.size === 0) return false;
    for (const handler of set) {
      try {
        handler(msg);
      } catch (err) {
        console.error("[ExtHost] subscriber threw", err);
      }
    }
    return true;
  },
  subscribe: (type, handler) => {
    let set = subscribers.get(type);
    if (!set) {
      set = new Set();
      subscribers.set(type, set);
    }
    set.add(handler);
    return () => {
      set!.delete(handler);
    };
  },
};

installWorkerRpc(rpc);

function readTextFile(path: string): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const id = nextReadId++;
    pendingReads.set(id, { resolve, reject });
    sendToMain({ type: "readFile", id, path });
  });
}

// readBinaryFile helper kept available for future callers; the main-thread
// reads originate from the workspace.fs shim via subscribe()'d messages.
void (function readBinaryFile(path: string): Promise<ArrayBuffer | null> {
  return new Promise((resolve, reject) => {
    const id = nextReadId++;
    pendingBinaryReads.set(id, { resolve, reject });
    sendToMain({ type: "readBinaryFile", id, path });
  });
});

// ── Command adapter for vscode.commands ─────────────────────────────

installCommandAdapter({
  registerCommand(id: string, handler: (...args: unknown[]) => unknown | Promise<unknown>) {
    commandHandlers.set(id, handler);
    return new Disposable(() => {
      if (commandHandlers.get(id) === handler) commandHandlers.delete(id);
    });
  },
  async executeWorkerCommand(id: string, args: unknown[]) {
    const handler = commandHandlers.get(id);
    if (!handler) throw new Error(`Command not found: ${id}`);
    return await handler(...args);
  },
  hasWorkerCommand(id: string): boolean {
    return commandHandlers.has(id);
  },
  listCommands(): string[] {
    return Array.from(commandHandlers.keys());
  },
});

// ── Nested worker + importScripts polyfills ─────────────────────────

type WorkerScriptUrl = { url: string; revokeAfterCreate: boolean };

async function fetchAsWorkerScriptUrl(rawUrl: string): Promise<WorkerScriptUrl> {
  // Try to resolve by reading the script text via our existing readFile RPC.
  // Falls back to fetch() for standard http(s) URLs.
  const path = urlToLocalPath(rawUrl);
  if (path) {
    const text = await readTextFile(path);
    if (text == null) throw new Error(`Script not found: ${rawUrl}`);
    // Rewrite inline nested `new URL(x, import.meta.url)` / `new Worker(x, ...)`
    // relative paths so webpack-chunked LSP servers still resolve siblings
    // from the same extension directory.
    const rewritten = rewriteBundledUrlsToAbsolute(text, path);
    return {
      url: URL.createObjectURL(new Blob([rewritten], { type: "text/javascript" })),
      revokeAfterCreate: true,
    };
  }
  if (
    rawUrl.startsWith("http://") ||
    rawUrl.startsWith("https://") ||
    rawUrl.startsWith("blob:") ||
    rawUrl.startsWith("data:")
  ) {
    return { url: rawUrl, revokeAfterCreate: false };
  }
  const response = await fetch(rawUrl);
  const text = await response.text();
  return {
    url: URL.createObjectURL(new Blob([text], { type: "text/javascript" })),
    revokeAfterCreate: true,
  };
}

function urlToLocalPath(rawUrl: string): string | null {
  if (rawUrl.startsWith("vfs://vfs/_ext/")) {
    const encoded = rawUrl.slice("vfs://vfs/_ext".length);
    return decodeURIComponent(encoded);
  }
  if (rawUrl.startsWith("http://vfs.localhost/_ext/")) {
    const encoded = rawUrl.slice("http://vfs.localhost/_ext".length);
    return decodeURIComponent(encoded.replace(/^\/([A-Za-z])\//, "/$1:/"));
  }
  if (rawUrl.startsWith("file://")) {
    try {
      const u = new URL(rawUrl);
      return decodeURIComponent(u.pathname);
    } catch {
      return null;
    }
  }
  if (rawUrl.startsWith("blob:") || rawUrl.startsWith("data:")) return null;
  return null;
}

// Keep a back-compat alias (older code used this name).
const vfsUrlToPath = urlToLocalPath;
void vfsUrlToPath;

function rewriteBundledUrlsToAbsolute(_source: string, _scriptLocalPath: string): string {
  // Nothing to rewrite right now; the blob wrapper loader for nested workers
  // handles relative URLs via its own Worker polyfill already. Placeholder
  // kept so we can add targeted rewrites (e.g. webpack chunk imports) later.
  return _source;
}

const _OriginalWorker = (globalThis as unknown as { Worker: typeof Worker }).Worker;

class ProxiedWorker {
  private _impl: Worker | null = null;
  private _queue: Array<{ data: unknown; transfer?: Transferable[] }> = [];
  private _listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
  private _onmessage: ((ev: MessageEvent) => unknown) | null = null;
  private _onerror: ((ev: ErrorEvent) => unknown) | null = null;
  private _onmessageerror: ((ev: MessageEvent) => unknown) | null = null;

  constructor(scriptUrl: string | URL, options?: WorkerOptions) {
    const resolved = typeof scriptUrl === "string" ? scriptUrl : scriptUrl.toString();
    void this._bootstrap(resolved, options);
  }

  private async _bootstrap(scriptUrl: string, options?: WorkerOptions): Promise<void> {
    try {
      const resolved = await fetchAsWorkerScriptUrl(scriptUrl);
      const worker = new _OriginalWorker(resolved.url, options);
      if (resolved.revokeAfterCreate) {
        // Worker clones script bytes at construction time, so revoking the
        // temporary blob URL immediately avoids leaking object URLs.
        URL.revokeObjectURL(resolved.url);
      }
      this._impl = worker;

      worker.onmessage = (ev) => {
        this._onmessage?.(ev);
        this._fireListeners("message", ev);
      };
      worker.onerror = (ev) => {
        this._onerror?.(ev);
        this._fireListeners("error", ev);
      };
      worker.onmessageerror = (ev) => {
        this._onmessageerror?.(ev);
        this._fireListeners("messageerror", ev);
      };

      for (const queued of this._queue) {
        worker.postMessage(queued.data, queued.transfer ?? []);
      }
      this._queue = [];
    } catch (err) {
      console.error("[ExtHost] nested worker bootstrap failed", err);
      const ev = new ErrorEvent("error", { error: err, message: err instanceof Error ? err.message : String(err) });
      this._onerror?.(ev);
      this._fireListeners("error", ev);
    }
  }

  postMessage(data: unknown, transfer?: Transferable[] | StructuredSerializeOptions): void {
    const t = Array.isArray(transfer) ? transfer : undefined;
    if (this._impl) {
      this._impl.postMessage(data, t ?? []);
    } else {
      this._queue.push({ data, transfer: t });
    }
  }

  terminate(): void {
    this._impl?.terminate();
    this._queue = [];
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    let set = this._listeners.get(type);
    if (!set) {
      set = new Set();
      this._listeners.set(type, set);
    }
    set.add(listener);
  }

  removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    this._listeners.get(type)?.delete(listener);
  }

  dispatchEvent(_event: Event): boolean {
    return true;
  }

  set onmessage(cb: ((ev: MessageEvent) => unknown) | null) {
    this._onmessage = cb;
  }
  get onmessage(): ((ev: MessageEvent) => unknown) | null {
    return this._onmessage;
  }
  set onerror(cb: ((ev: ErrorEvent) => unknown) | null) {
    this._onerror = cb;
  }
  get onerror(): ((ev: ErrorEvent) => unknown) | null {
    return this._onerror;
  }
  set onmessageerror(cb: ((ev: MessageEvent) => unknown) | null) {
    this._onmessageerror = cb;
  }
  get onmessageerror(): ((ev: MessageEvent) => unknown) | null {
    return this._onmessageerror;
  }

  private _fireListeners(type: string, ev: Event): void {
    const set = this._listeners.get(type);
    if (!set) return;
    for (const l of set) {
      if (typeof l === "function") l.call(this, ev);
      else l.handleEvent(ev);
    }
  }
}

(globalThis as unknown as { Worker: unknown }).Worker = ProxiedWorker;

// Override importScripts so webpack chunks loaded from vfs paths work.
const _originalImportScripts =
  (globalThis as unknown as { importScripts?: (...urls: string[]) => void }).importScripts;
if (_originalImportScripts) {
  (globalThis as unknown as { importScripts: (...urls: string[]) => void }).importScripts = ((
    ...urls: string[]
  ) => {
    // Best effort: synchronously loading VFS scripts is impossible from a
    // Web Worker — importScripts is synchronous. We fall back to the
    // original for non-vfs urls; for vfs urls we'd need a nested worker
    // pre-bundled dependency. vscode-yaml doesn't trip this path after
    // LSP handshake because all chunks are bundled into languageserver-web.js.
    for (const url of urls) {
      if (urlToLocalPath(url)) {
        console.warn(`[ExtHost] importScripts(${url}) not fully supported in worker; skipping`);
        continue;
      }
      _originalImportScripts(url);
    }
  }) as typeof _originalImportScripts;
}

// ── Vscode resolver installed in module loader ──────────────────────

const vscodeNs = createVscodeNamespace();
(self as unknown as { __dotdir_vscode_api?: unknown }).__dotdir_vscode_api = vscodeNs;

// ── Helpers ─────────────────────────────────────────────────────────

function activationKey(ext: WorkerLoadedExtension): string {
  const ref = ext.identity.ref;
  return `${ref.publisher}.${ref.name}.${ref.version}`;
}

function extensionId(ext: WorkerLoadedExtension): string {
  const ref = ext.identity.ref;
  return `${ref.publisher}.${ref.name}`;
}

function encodePathPreservingSlashes(path: string): string {
  return path.split("/").map((seg) => encodeURIComponent(seg)).join("/");
}

function windowsDrivePathToSlashSegments(path: string): string {
  const s = path.replace(/\\/g, "/");
  return s.replace(/(^|\/)([A-Za-z]):(?=\/|$)/g, "$1$2/");
}

function extensionScriptVfsUrl(absPath: string): string {
  const normalized = absPath.replace(/\\/g, "/");
  const withLeading = normalized.startsWith("/") ? normalized : `/${normalized}`;
  const vfsPath = `/_ext${withLeading}`;
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
  const isWindows = /Windows/i.test(ua);
  if (isWindows) {
    const forUrl = windowsDrivePathToSlashSegments(vfsPath);
    return `http://vfs.localhost${encodePathPreservingSlashes(forUrl)}`;
  }
  return `vfs://vfs${encodePathPreservingSlashes(vfsPath)}`;
}

function extensionAssetUri(absPath: string): Uri {
  return Uri.parse(extensionScriptVfsUrl(absPath));
}

function extensionWantsEvent(ext: WorkerLoadedExtension, event: string): boolean {
  const events = ext.identity.manifest.activationEvents ?? [];
  if (events.length === 0) return event === "*";
  return events.includes("*") || events.includes(event);
}

// ── Browser module loading ─────────────────────────────────────────

type BrowserExtensionModule = {
  activate?: (ctx: unknown) => unknown | Promise<unknown>;
  deactivate?: (ctx: unknown) => unknown | Promise<unknown>;
  default?: { activate?: (ctx: unknown) => unknown | Promise<unknown>; deactivate?: (ctx: unknown) => unknown | Promise<unknown> };
};

type CjsModuleRecord =
  | { kind: "js"; code: string; dirname: string }
  | { kind: "json"; value: unknown; dirname: string };

class UnsupportedExtensionModuleError extends Error {
  constructor(id: string) {
    super(`Unsupported extension module "${id}". DotDir supports web-compatible CJS only: "vscode" plus extension-relative JS/JSON modules.`);
    this.name = "UnsupportedExtensionModuleError";
  }
}

async function importBrowserModuleEsm(absScriptPath: string): Promise<BrowserExtensionModule> {
  const moduleUrl = extensionScriptVfsUrl(absScriptPath);
  const mod = await import(/* @vite-ignore */ moduleUrl);
  return mod as BrowserExtensionModule;
}

function staticRequireIds(code: string): string[] {
  const ids: string[] = [];
  const re = /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(code)) !== null) {
    ids.push(match[1] ?? "");
  }
  return ids;
}

function isRelativeRequire(id: string): boolean {
  return id.startsWith("./") || id.startsWith("../");
}

async function resolveCjsModulePath(fromPath: string, id: string): Promise<string> {
  if (!isRelativeRequire(id)) throw new UnsupportedExtensionModuleError(id);

  const base = normalizePath(join(dirname(fromPath), id));
  const candidates = [
    base,
    `${base}.js`,
    `${base}.json`,
    join(base, "index.js"),
    join(base, "index.json"),
  ];
  for (const candidate of candidates) {
    const content = await readTextFile(candidate);
    if (content !== null) return candidate;
  }
  throw new Error(`Cannot resolve extension module "${id}" from ${fromPath}`);
}

async function buildCjsModuleGraph(entryPath: string): Promise<Map<string, CjsModuleRecord>> {
  const modules = new Map<string, CjsModuleRecord>();
  const visiting = new Set<string>();

  const visit = async (path: string): Promise<void> => {
    const normalizedPath = normalizePath(path);
    if (modules.has(normalizedPath) || visiting.has(normalizedPath)) return;
    visiting.add(normalizedPath);

    const source = await readTextFile(normalizedPath);
    if (source === null) throw new Error(`Extension module not found: ${normalizedPath}`);

    if (normalizedPath.endsWith(".json")) {
      modules.set(normalizedPath, { kind: "json", value: JSON.parse(source), dirname: dirname(normalizedPath) });
      visiting.delete(normalizedPath);
      return;
    }

    modules.set(normalizedPath, { kind: "js", code: source, dirname: dirname(normalizedPath) });
    for (const id of staticRequireIds(source)) {
      if (id === "vscode") continue;
      if (!isRelativeRequire(id)) continue;
      await visit(await resolveCjsModulePath(normalizedPath, id));
    }
    visiting.delete(normalizedPath);
  };

  await visit(entryPath);
  return modules;
}

function buildCjsWrapperSource(entryPath: string, modules: Map<string, CjsModuleRecord>): string {
  const moduleEntries = Array.from(modules.entries()).map(([path, record]) => {
    if (record.kind === "json") {
      return [path, { kind: "json", value: record.value, dirname: record.dirname }];
    }
    return [path, { kind: "js", code: record.code, dirname: record.dirname }];
  });
  return `
const __dotdir_vscode = globalThis.__dotdir_vscode_api;
const __dotdir_modules = new Map(${JSON.stringify(moduleEntries)});
const __dotdir_cache = new Map();
const __dotdir_join = (left, right) => {
  const stack = [];
  const raw = (left + "/" + right).replace(/\\\\/g, "/").split("/");
  for (const part of raw) {
    if (!part || part === ".") continue;
    if (part === "..") stack.pop();
    else stack.push(part);
  }
  return (left.startsWith("/") ? "/" : "") + stack.join("/");
};
const __dotdir_dirname = (path) => {
  const idx = path.lastIndexOf("/");
  return idx <= 0 ? "/" : path.slice(0, idx);
};
const __dotdir_has = (path) => __dotdir_modules.has(path);
const __dotdir_resolve = (fromPath, id) => {
  if (id === "vscode") return "vscode";
  if (!(id.startsWith("./") || id.startsWith("../"))) {
    const err = new Error('Unsupported extension module "' + id + '". DotDir supports web-compatible CJS only: "vscode" plus extension-relative JS/JSON modules.');
    err.name = "UnsupportedExtensionModuleError";
    throw err;
  }
  const base = __dotdir_join(__dotdir_dirname(fromPath), id);
  const candidates = [base, base + ".js", base + ".json", __dotdir_join(base, "index.js"), __dotdir_join(base, "index.json")];
  for (const candidate of candidates) {
    if (__dotdir_has(candidate)) return candidate;
  }
  throw new Error('Cannot resolve extension module "' + id + '" from ' + fromPath);
};
const __dotdir_require = (id, fromPath) => {
  const resolved = __dotdir_resolve(fromPath, id);
  if (resolved === "vscode") return __dotdir_vscode;
  if (__dotdir_cache.has(resolved)) return __dotdir_cache.get(resolved).exports;
  const record = __dotdir_modules.get(resolved);
  if (!record) throw new Error("Extension module not found: " + resolved);
  if (record.kind === "json") {
    const jsonModule = { exports: record.value };
    __dotdir_cache.set(resolved, jsonModule);
    return jsonModule.exports;
  }
  const module = { exports: {} };
  __dotdir_cache.set(resolved, module);
  const exports = module.exports;
  const require = (nextId) => __dotdir_require(nextId, resolved);
  const __filename = resolved;
  const __dirname = record.dirname;
  const fn = new Function("module", "exports", "require", "globalThis", "self", "__filename", "__dirname", record.code + "\\n//# sourceURL=dotdir-ext-cjs://" + resolved);
  fn(module, exports, require, globalThis, self, __filename, __dirname);
  return module.exports;
};
const __entry = __dotdir_require(${JSON.stringify(entryPath)}, ${JSON.stringify(entryPath)});
const __exp = __entry && __entry.__esModule && __entry.default ? __entry.default : __entry;
export default __exp;
export const activate = __exp?.activate;
export const deactivate = __exp?.deactivate;
`;
}

async function importBrowserModuleCjs(absScriptPath: string): Promise<BrowserExtensionModule> {
  const resolvedScriptPath = await resolveBrowserScriptPath(absScriptPath);
  const graph = await buildCjsModuleGraph(resolvedScriptPath);
  const cjsWrapper = buildCjsWrapperSource(resolvedScriptPath, graph);
  const cjsBlobUrl = URL.createObjectURL(new Blob([cjsWrapper], { type: "text/javascript" }));
  try {
    return (await import(/* @vite-ignore */ cjsBlobUrl)) as BrowserExtensionModule;
  } finally {
    URL.revokeObjectURL(cjsBlobUrl);
  }
}

async function resolveBrowserScriptPath(absScriptPath: string): Promise<string> {
  const candidates = [absScriptPath, `${absScriptPath}.js`, `${absScriptPath}.mjs`, join(absScriptPath, "index.js"), join(absScriptPath, "index.mjs")];
  for (const candidate of candidates) {
    const content = await readTextFile(candidate);
    if (content != null) return candidate;
  }
  return absScriptPath;
}

// ── Activation ─────────────────────────────────────────────────────

function loadManifestConfig(manifest: ExtensionManifest): void {
  const cfg = manifest.contributes?.configuration;
  if (Array.isArray(cfg)) {
    for (const c of cfg) if (c?.properties) loadConfigDefaults(c.properties);
  } else if (cfg?.properties) {
    loadConfigDefaults(cfg.properties);
  }
  loadLanguageDefaults(manifest.contributes?.configurationDefaults);
}

interface ExtensionContextShape {
  subscriptions: Array<{ dispose: () => void }>;
  extensionUri: Uri;
  extensionPath: string;
  globalStoragePath: string;
  globalStorageUri: Uri;
  storagePath?: string;
  storageUri?: Uri;
  logPath: string;
  logUri: Uri;
  environmentVariableCollection: unknown;
  extensionMode: ExtensionMode;
  asAbsolutePath: (relative: string) => string;
  secrets: unknown;
  globalState: unknown;
  workspaceState: unknown;
  extension: { id: string; extensionUri: Uri; extensionPath: string; isActive: boolean; packageJSON: Record<string, unknown>; extensionKind: number; exports: unknown };
  dotdir: { commands: { registerCommand: (id: string, handler: (...args: unknown[]) => unknown) => { dispose: () => void } } };
}

const mementoStore = new Map<string, Map<string, unknown>>();

function createMemento(scopeKey: string): {
  get: <T>(key: string, defaultValue?: T) => T | undefined;
  update: (key: string, value: unknown) => Promise<void>;
  keys: () => readonly string[];
  setKeysForSync?: (keys: readonly string[]) => void;
} {
  let m = mementoStore.get(scopeKey);
  if (!m) {
    m = new Map<string, unknown>();
    mementoStore.set(scopeKey, m);
  }
  return {
    get<T>(key: string, defaultValue?: T): T | undefined {
      return (m!.has(key) ? (m!.get(key) as T) : defaultValue) as T | undefined;
    },
    async update(key: string, value: unknown): Promise<void> {
      if (value === undefined) m!.delete(key);
      else m!.set(key, value);
    },
    keys() {
      return Array.from(m!.keys());
    },
    setKeysForSync() {},
  };
}

function createExtensionContext(ext: WorkerLoadedExtension, subs: Array<{ dispose: () => void }>): ExtensionContextShape {
  const id = extensionId(ext);
  const extDir = ext.location.dirPath;
  const manifest = ext.identity.manifest;
  const extensionUri = extensionAssetUri(extDir);
  const globalStorageDir = join(extDir, "..", ".global-storage", id);
  const logDir = join(extDir, "..", ".logs", id);
  return {
    subscriptions: subs,
    extensionUri,
    extensionPath: extDir,
    globalStoragePath: globalStorageDir,
    globalStorageUri: Uri.file(globalStorageDir),
    storagePath: undefined,
    storageUri: undefined,
    logPath: logDir,
    logUri: Uri.file(logDir),
    environmentVariableCollection: { persistent: false, replace: () => {}, append: () => {}, prepend: () => {}, get: () => undefined, forEach: () => {}, delete: () => {}, clear: () => {} },
    extensionMode: ExtensionMode.Production,
    // Browser extensions should resolve bundle assets to extension web URLs,
    // not host `file://` paths.
    asAbsolutePath: (relative: string) => extensionScriptVfsUrl(join(extDir, relative)),
    secrets: { get: async () => undefined, store: async () => {}, delete: async () => {}, onDidChange: () => ({ dispose: () => {} }) },
    globalState: createMemento(`${id}:global`),
    workspaceState: createMemento(`${id}:workspace`),
    extension: {
      id,
      extensionUri,
      extensionPath: extDir,
      isActive: false,
      packageJSON: manifest as unknown as Record<string, unknown>,
      extensionKind: 1,
      exports: undefined,
    },
    dotdir: {
      commands: {
        registerCommand: (commandId: string, handler: (...args: unknown[]) => unknown) => {
          commandHandlers.set(commandId, handler);
          const d = new Disposable(() => {
            if (commandHandlers.get(commandId) === handler) commandHandlers.delete(commandId);
          });
          subs.push(d);
          return d;
        },
      },
    },
  };
}

async function activateExtension(ext: WorkerLoadedExtension): Promise<void> {
  const key = activationKey(ext);
  if (activeExtensions.has(key)) return;
  const activationEntry = ext.runtime.activationEntry;
  if (!activationEntry) return;

  setActiveExtensionKey(key);
  try {
    const resolvedScriptPath = await resolveBrowserScriptPath(activationEntry.path);
    logActivation(
      "info",
      `loading ${activationEntry.sourceField} script ${resolvedScriptPath} via ${activationEntry.format === "esm" ? "esm" : "cjs-wrapper"}`,
    );

    const mod = activationEntry.format === "esm"
      ? await importBrowserModuleEsm(resolvedScriptPath)
      : await importBrowserModuleCjs(resolvedScriptPath);
    const activate = mod.activate ?? mod.default?.activate;
    const deactivate = mod.deactivate ?? mod.default?.deactivate;
    if (typeof activate !== "function") {
      ext.compatibility = { activation: "unsupported", reason: "Activation entry has no activate() export." };
      logActivation("warn", "activation entry has no activate() export");
      return;
    }

    const subs: Array<{ dispose: () => void }> = [];
    const ctx = createExtensionContext(ext, subs);

    // Register in vscode.extensions.all before activation so the extension
    // can resolve itself during activate().
    registerExtension({
      id: extensionId(ext),
      extensionUri: ctx.extensionUri,
      extensionPath: ctx.extensionPath,
      isActive: false,
      packageJSON: ext.identity.manifest as unknown as Record<string, unknown>,
      extensionKind: 1,
      exports: undefined,
      activate: async () => undefined,
    });

    const exports = await activate(ctx);
    markExtensionActive(extensionId(ext), exports);
    ext.compatibility = { activation: "supported" };
    logActivation("info", "activated");
    activeExtensions.set(key, { subscriptions: subs, deactivate });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ext.compatibility =
      err instanceof Error && err.name === "UnsupportedExtensionModuleError"
        ? { activation: "unsupported", reason: message }
        : { activation: "failed", reason: message };
    throw err;
  } finally {
    setActiveExtensionKey(null);
  }
}

async function activateByEvent(event: string): Promise<void> {
  for (const ext of loadedExtensions.values()) {
    if (!ext.runtime.activationEntry) continue;
    if (!extensionWantsEvent(ext, event)) continue;
    try {
      await activateExtension(ext);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[ExtHost] activate failed:", activationKey(ext), err);
      setActiveExtensionKey(activationKey(ext));
      logActivation("error", message, event);
      setActiveExtensionKey(null);
    }
  }
}

async function runCommand(command: string, args: unknown[]): Promise<unknown> {
  await activateByEvent(`onCommand:${command}`);
  const handler = commandHandlers.get(command);
  if (!handler) return undefined;
  const resolvedArgs = resolveStashedCommandArguments(args);
  return await handler(...resolvedArgs);
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
    const ext = await normalizeExtensionManifest({
      extDir,
      ref,
      locale: ((self as typeof globalThis & { navigator?: { language?: string } }).navigator?.language ?? "en").trim() || "en",
      readTextFile,
      trustTier: "worker",
    }).catch(() => null);
    if (ext) {
      loadManifestConfig(ext.identity.manifest);
      loaded.push(ext);
    }
  }

  console.log("[ExtHost] loaded", loaded.length, "extensions");
  loadedExtensions.clear();
  for (const ext of loaded) loadedExtensions.set(activationKey(ext), ext);
  return loaded;
}

// ── Provider invocation dispatch ───────────────────────────────────

type ProviderCancellationRecord = { isCancellationRequested: boolean; onCancellationRequested: (listener: () => void) => { dispose: () => void } };

const providerCancellations = new Map<number, ProviderCancellationRecord>();

function makeCancellationToken(requestId: number): {
  isCancellationRequested: boolean;
  onCancellationRequested: (listener: () => void) => { dispose: () => void };
} {
  let cancelled = false;
  const listeners = new Set<() => void>();
  const token = {
    get isCancellationRequested() {
      return cancelled;
    },
    onCancellationRequested: (listener: () => void) => {
      listeners.add(listener);
      return {
        dispose: () => listeners.delete(listener),
      };
    },
  };
  providerCancellations.set(requestId, {
    get isCancellationRequested() {
      return cancelled;
    },
    onCancellationRequested: () => ({ dispose: () => {} }),
  } as unknown as (typeof providerCancellations extends Map<number, infer V> ? V : never));
  const cancel = () => {
    if (cancelled) return;
    cancelled = true;
    for (const l of listeners) {
      try {
        l();
      } catch {
        // ignore
      }
    }
    listeners.clear();
    providerCancellations.delete(requestId);
  };
  (token as unknown as { _cancel: () => void })._cancel = cancel;
  return token;
}

// ── Type adapters: shim → flat payload ─────────────────────────────

function posPayload(p: { line: number; character: number }): PositionPayload {
  return { line: p.line, character: p.character };
}

function rangePayload(r: { start: { line: number; character: number }; end: { line: number; character: number } }): RangePayload {
  return { start: posPayload(r.start), end: posPayload(r.end) };
}

function stringifyDoc(d: unknown): string | { kind: "plaintext" | "markdown"; value: string } | undefined {
  if (d == null) return undefined;
  if (typeof d === "string") return d;
  if (d instanceof MarkdownString) return { kind: "markdown", value: d.value };
  const any = d as { kind?: string; value?: string };
  if (typeof any.value === "string") return { kind: any.kind === "markdown" ? "markdown" : "plaintext", value: any.value };
  return String(d);
}

function textEditPayload(e: TextEdit | { range: Range; newText: string }): TextEditPayload {
  return { range: rangePayload(e.range), newText: e.newText };
}

function completionItemPayload(item: unknown): CompletionItemPayload {
  const ci = item as CompletionItem & { textEdit?: TextEdit; insertTextRules?: number };
  const label: string | { label: string; detail?: string; description?: string } =
    typeof ci.label === "string" ? ci.label : (ci.label as CompletionItemLabel);
  let range: CompletionItemPayload["range"];
  if (ci.range instanceof Range) range = rangePayload(ci.range);
  else if (ci.range && typeof ci.range === "object" && "inserting" in ci.range) {
    range = { inserting: rangePayload(ci.range.inserting), replacing: rangePayload(ci.range.replacing) };
  } else if (ci.textEdit) {
    range = rangePayload(ci.textEdit.range);
  }
  let insertText: string | undefined;
  let insertTextFormat: number | undefined;
  if (typeof ci.insertText === "string") insertText = ci.insertText;
  else if (ci.insertText && typeof ci.insertText === "object" && "value" in ci.insertText) {
    insertText = (ci.insertText as { value: string }).value;
    insertTextFormat = 2;
  } else if (ci.textEdit) {
    insertText = ci.textEdit.newText;
  }
  const originalCommandArgs = ci.command?.arguments as unknown[] | undefined;
  const needsStashing = Boolean(
    originalCommandArgs?.some((arg) => {
      if (arg == null) return false;
      const t = typeof arg;
      return t === "object" || t === "function";
    }),
  );
  const stashedCommandArgs =
    ci.command && needsStashing
      ? stashCommandArguments(originalCommandArgs)
      : undefined;
  return {
    label,
    kind: ci.kind,
    tags: ci.tags,
    detail: ci.detail,
    documentation: stringifyDoc(ci.documentation),
    sortText: ci.sortText,
    filterText: ci.filterText,
    insertText,
    insertTextFormat,
    range,
    commitCharacters: ci.commitCharacters,
    preselect: ci.preselect,
    additionalTextEdits: ci.additionalTextEdits?.map(textEditPayload),
    command: ci.command
      ? {
          command: ci.command.command,
          title: ci.command.title,
          arguments: stashedCommandArgs ? [stashedCommandArgs] : originalCommandArgs,
        }
      : undefined,
  };
}

function completionListPayload(result: unknown): CompletionListPayload | null {
  if (result == null) return null;
  let items: unknown[] = [];
  let isIncomplete = false;
  if (Array.isArray(result)) items = result;
  else if (result instanceof CompletionList) {
    items = result.items;
    isIncomplete = Boolean(result.isIncomplete);
  } else if (result && typeof result === "object" && "items" in result) {
    const r = result as { items: unknown[]; isIncomplete?: boolean };
    items = r.items;
    isIncomplete = Boolean(r.isIncomplete);
  }
  return { items: items.map(completionItemPayload), isIncomplete };
}

function hoverPayload(result: unknown): HoverPayload | null {
  if (!result) return null;
  const h = result as Hover;
  const contents = (h.contents ?? []).map((c: MarkedString) => {
    if (typeof c === "string") return c;
    if (c instanceof MarkdownString) return { kind: "markdown" as const, value: c.value };
    if ("language" in c) return { language: c.language, value: c.value };
    return { kind: "plaintext" as const, value: String((c as { value?: string }).value ?? c) };
  });
  return { contents, range: h.range ? rangePayload(h.range) : undefined };
}

function diagnosticPayload(d: unknown): DiagnosticPayload {
  const diag = d as Diagnostic;
  return {
    range: rangePayload(diag.range),
    message: diag.message,
    severity: diag.severity,
    source: diag.source,
    code:
      diag.code && typeof diag.code === "object" && "target" in diag.code
        ? { value: diag.code.value, target: diag.code.target.toString() }
        : (diag.code as string | number | undefined),
    tags: diag.tags,
  };
}

function symbolPayload(s: unknown): DocumentSymbolPayload | SymbolInformationPayload {
  if (s instanceof DocumentSymbol) {
    return {
      name: s.name,
      detail: s.detail,
      kind: s.kind,
      tags: s.tags,
      range: rangePayload(s.range),
      selectionRange: rangePayload(s.selectionRange),
      children: (s.children ?? []).map(symbolPayload) as DocumentSymbolPayload[],
    };
  }
  const si = s as SymbolInformation;
  return {
    name: si.name,
    kind: si.kind,
    tags: si.tags,
    containerName: si.containerName,
    location: { uri: si.location.uri.toString(), range: rangePayload(si.location.range) },
  };
}

function locationPayload(l: unknown): LocationPayload {
  const loc = l as Location;
  return { uri: loc.uri.toString(), range: rangePayload(loc.range) };
}

function foldingPayload(f: unknown): FoldingRangePayload {
  const fr = f as FoldingRange;
  const kindStr = fr.kind === 1 ? "comment" : fr.kind === 2 ? "imports" : fr.kind === 3 ? "region" : undefined;
  return { start: fr.start, end: fr.end, kind: kindStr };
}

function selectionRangePayload(sr: unknown): SelectionRangePayload {
  const r = sr as SelectionRange;
  return { range: rangePayload(r.range), parent: r.parent ? selectionRangePayload(r.parent) : undefined };
}

function docHighlightPayload(h: unknown): DocumentHighlightPayload {
  const dh = h as { range: Range; kind?: number };
  return { range: rangePayload(dh.range), kind: dh.kind };
}

function colorInfoPayload(c: unknown): ColorInformationPayload {
  const ci = c as { range: Range; color: { red: number; green: number; blue: number; alpha: number } };
  return { range: rangePayload(ci.range), color: { ...ci.color } };
}

function colorPresentationPayload(p: unknown): ColorPresentationPayload {
  const cp = p as { label: string; textEdit?: TextEdit; additionalTextEdits?: TextEdit[] };
  return { label: cp.label, textEdit: cp.textEdit ? textEditPayload(cp.textEdit) : undefined, additionalTextEdits: cp.additionalTextEdits?.map(textEditPayload) };
}

function documentLinkPayload(l: unknown): DocumentLinkPayload {
  const dl = l as DocumentLink;
  return { range: rangePayload(dl.range), target: dl.target?.toString(), tooltip: dl.tooltip };
}

function signatureHelpPayload(s: unknown): SignatureHelpPayload | null {
  if (!s) return null;
  const sh = s as { signatures: Array<{ label: string; documentation?: unknown; parameters?: Array<{ label: string | [number, number]; documentation?: unknown }>; activeParameter?: number }>; activeSignature?: number; activeParameter?: number };
  return {
    signatures: sh.signatures.map((sig) => ({
      label: sig.label,
      documentation: stringifyDoc(sig.documentation),
      parameters: sig.parameters?.map((p) => ({ label: p.label, documentation: stringifyDoc(p.documentation) })),
      activeParameter: sig.activeParameter,
    })),
    activeSignature: sh.activeSignature,
    activeParameter: sh.activeParameter,
  };
}

function codeActionPayload(a: unknown): CodeActionPayload {
  const act = a as { title: string; kind?: { value: string }; diagnostics?: Diagnostic[]; edit?: { entries: () => Array<[Uri, TextEdit[]]> }; command?: { command: string; title: string; arguments?: unknown[] }; isPreferred?: boolean; disabled?: { reason: string } };
  let edit: CodeActionPayload["edit"];
  if (act.edit && typeof act.edit.entries === "function") {
    const changes: Record<string, TextEditPayload[]> = {};
    for (const [uri, edits] of act.edit.entries()) changes[uri.toString()] = edits.map(textEditPayload);
    edit = { changes };
  }
  return {
    title: act.title,
    kind: act.kind?.value,
    diagnostics: act.diagnostics?.map(diagnosticPayload),
    edit,
    command: act.command,
    isPreferred: act.isPreferred,
    disabled: act.disabled,
  };
}

function codeLensPayload(l: unknown): CodeLensPayload {
  const cl = l as { range: Range; command?: { command: string; title: string; arguments?: unknown[] } };
  return { range: rangePayload(cl.range), command: cl.command };
}

// ── Invoke provider ───────────────────────────────────────────────

interface ProviderInvokeArgs {
  uri: string;
  position?: PositionPayload;
  range?: RangePayload;
  context?: Record<string, unknown>;
  newName?: string;
  ch?: string;
  options?: Record<string, unknown>;
}

async function invokeProvider(providerId: number, method: string, args: ProviderInvokeArgs, requestId: number): Promise<unknown> {
  const record = getProvider(providerId);
  if (!record) throw new Error(`No provider registered for id ${providerId}`);
  const provider = record.provider as Record<string, (...a: unknown[]) => unknown>;
  const fn = provider[method];
  if (typeof fn !== "function") throw new Error(`Provider ${record.kind} has no method ${method}`);
  const doc = textDocuments.get(args.uri);
  if (!doc) throw new Error(`No document for ${args.uri}`);
  const token = makeCancellationToken(requestId);
  const ctxArg = args.context ?? {};

  let result: unknown;
  switch (record.kind) {
    case "completion": {
      const pos = new Position(args.position!.line, args.position!.character);
      result = await fn.call(provider, doc, pos, token, ctxArg);
      return completionListPayload(result);
    }
    case "hover": {
      const pos = new Position(args.position!.line, args.position!.character);
      result = await fn.call(provider, doc, pos, token);
      return hoverPayload(result);
    }
    case "definition":
    case "typeDefinition":
    case "implementation":
    case "declaration": {
      const pos = new Position(args.position!.line, args.position!.character);
      result = await fn.call(provider, doc, pos, token);
      if (!result) return null;
      const arr = Array.isArray(result) ? result : [result];
      return arr.map((l) => (l && (l as { uri?: Uri }).uri ? locationPayload(l) : locationPayload(l)));
    }
    case "reference": {
      const pos = new Position(args.position!.line, args.position!.character);
      result = await fn.call(provider, doc, pos, ctxArg, token);
      if (!Array.isArray(result)) return [];
      return result.map(locationPayload);
    }
    case "documentHighlight": {
      const pos = new Position(args.position!.line, args.position!.character);
      result = await fn.call(provider, doc, pos, token);
      if (!Array.isArray(result)) return [];
      return result.map(docHighlightPayload);
    }
    case "documentSymbol": {
      result = await fn.call(provider, doc, token);
      if (!Array.isArray(result)) return [];
      return result.map(symbolPayload);
    }
    case "workspaceSymbol": {
      result = await fn.call(provider, args.context?.["query"] ?? "", token);
      if (!Array.isArray(result)) return [];
      return result.map(symbolPayload);
    }
    case "codeAction": {
      const r = new Range(args.range!.start.line, args.range!.start.character, args.range!.end.line, args.range!.end.character);
      result = await fn.call(provider, doc, r, ctxArg, token);
      if (!Array.isArray(result)) return [];
      return result.map(codeActionPayload);
    }
    case "codeLens": {
      result = await fn.call(provider, doc, token);
      if (!Array.isArray(result)) return [];
      return result.map(codeLensPayload);
    }
    case "documentFormatting": {
      result = await fn.call(provider, doc, args.options ?? {}, token);
      if (!Array.isArray(result)) return [];
      return result.map(textEditPayload);
    }
    case "documentRangeFormatting": {
      const r = new Range(args.range!.start.line, args.range!.start.character, args.range!.end.line, args.range!.end.character);
      result = await fn.call(provider, doc, r, args.options ?? {}, token);
      if (!Array.isArray(result)) return [];
      return result.map(textEditPayload);
    }
    case "onTypeFormatting": {
      const pos = new Position(args.position!.line, args.position!.character);
      result = await fn.call(provider, doc, pos, args.ch ?? "", args.options ?? {}, token);
      if (!Array.isArray(result)) return [];
      return result.map(textEditPayload);
    }
    case "rename": {
      const pos = new Position(args.position!.line, args.position!.character);
      result = await fn.call(provider, doc, pos, args.newName ?? "", token);
      if (!result) return null;
      const changes: Record<string, TextEditPayload[]> = {};
      const w = result as { entries?: () => Array<[Uri, TextEdit[]]> };
      if (typeof w.entries === "function") {
        for (const [uri, edits] of w.entries()) changes[uri.toString()] = edits.map(textEditPayload);
      }
      return { changes };
    }
    case "documentLink": {
      result = await fn.call(provider, doc, token);
      if (!Array.isArray(result)) return [];
      return result.map(documentLinkPayload);
    }
    case "color": {
      if (method === "provideDocumentColors") {
        result = await fn.call(provider, doc, token);
        if (!Array.isArray(result)) return [];
        return result.map(colorInfoPayload);
      }
      if (method === "provideColorPresentations") {
        const color = args.context?.["color"] as { red: number; green: number; blue: number; alpha: number };
        const r = new Range(args.range!.start.line, args.range!.start.character, args.range!.end.line, args.range!.end.character);
        result = await fn.call(provider, color, { document: doc, range: r }, token);
        if (!Array.isArray(result)) return [];
        return result.map(colorPresentationPayload);
      }
      return null;
    }
    case "folding": {
      result = await fn.call(provider, doc, ctxArg, token);
      if (!Array.isArray(result)) return [];
      return result.map(foldingPayload);
    }
    case "selectionRange": {
      const positions = (args.context?.["positions"] as PositionPayload[] | undefined)?.map((p) => new Position(p.line, p.character)) ?? [];
      result = await fn.call(provider, doc, positions, token);
      if (!Array.isArray(result)) return [];
      return result.map(selectionRangePayload);
    }
    case "signatureHelp": {
      const pos = new Position(args.position!.line, args.position!.character);
      result = await fn.call(provider, doc, pos, token, ctxArg);
      return signatureHelpPayload(result);
    }
    default:
      logActivation("warn", `provider kind ${record.kind} not implemented`);
      return null;
  }
}

// ── Message handler ─────────────────────────────────────────────────

self.onmessage = (e: MessageEvent) => {
  const msg = e.data as MainToHostMessage;
  // Give subscribers first crack for shim-internal wiring.
  rpc.dispatch(msg);

  switch (msg.type) {
    case "start":
      setDataDir(msg.dataDir);
      loadExtensions(msg.dataDir)
        .then(async (extensions) => {
          await activateByEvent("*");
          sendToMain({ type: "loaded", extensions: extensions as unknown[] });
        })
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          sendToMain({ type: "error", message });
        });
      break;

    case "activateByEvent":
      activateByEvent(msg.event)
        .then(() => sendToMain({ type: "requestResult", requestId: msg.requestId, result: null }))
        .catch((err: unknown) => sendToMain({ type: "requestResult", requestId: msg.requestId, error: err instanceof Error ? err.message : String(err) }));
      break;

    case "executeCommand":
      runCommand(msg.command, msg.args)
        .then((result) => sendToMain({ type: "requestResult", requestId: msg.requestId, result: result ?? null }))
        .catch((err: unknown) => sendToMain({ type: "requestResult", requestId: msg.requestId, error: err instanceof Error ? err.message : String(err) }));
      break;

    case "readFileResult": {
      const pending = pendingReads.get(msg.id);
      if (pending) {
        pendingReads.delete(msg.id);
        if (msg.error) pending.resolve(null);
        else pending.resolve(msg.data);
      }
      break;
    }

    case "readBinaryFileResult": {
      const pending = pendingBinaryReads.get(msg.id);
      if (pending) {
        pendingBinaryReads.delete(msg.id);
        if (msg.error) pending.resolve(null);
        else pending.resolve(msg.bytes ?? null);
      }
      break;
    }

    case "document/open": {
      const uriObj = Uri.parse(msg.uri);
      textDocuments.open(msg.uri, uriObj, msg.languageId, msg.version, msg.text);
      break;
    }
    case "document/change":
      textDocuments.change(msg.uri, msg.version, msg.text);
      break;
    case "document/close":
      textDocuments.close(msg.uri);
      break;
    case "document/save":
      textDocuments.save(msg.uri);
      break;
    case "workspace/folders":
      setWorkspaceFolders(msg.folders);
      break;
    case "configuration/update":
      updateUserConfigValue(msg.key, msg.value);
      break;
    case "editor/active":
      setActiveEditor(msg.uri);
      break;

    case "provider/invoke":
      invokeProvider(msg.providerId, msg.method, msg.args as ProviderInvokeArgs, msg.requestId)
        .then((result) => sendToMain({ type: "requestResult", requestId: msg.requestId, result: result ?? null }))
        .catch((err: unknown) => sendToMain({ type: "requestResult", requestId: msg.requestId, error: err instanceof Error ? err.message : String(err) }));
      break;

    case "provider/cancel": {
      const tok = providerCancellations.get(msg.requestId) as unknown as { _cancel?: () => void };
      if (tok?._cancel) tok._cancel();
      break;
    }

    case "requestResponse": {
      const pending = pendingRequests.get(msg.requestId);
      if (pending) {
        pendingRequests.delete(msg.requestId);
        if (msg.error) pending.reject(new Error(msg.error));
        else pending.resolve(msg.result);
      }
      break;
    }
  }
};

// Pre-seed default workspace user config as soon as a workspace/folders
// message updates it (handled above). Surface vscode to the assembled
// namespace as well for convenience.
(self as unknown as { vscode?: unknown }).vscode = vscodeNs;
void vscodeWorkspace;
