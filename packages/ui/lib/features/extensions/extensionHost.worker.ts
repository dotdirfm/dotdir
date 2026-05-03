/**
 * Extension Host Worker
 *
 * Runs in a Web Worker to isolate extension loading from the main thread.
 * Hosts the VS Code API shim (`vscodeShim/*`) and bridges LSP/provider
 * calls over postMessage to the main thread where Monaco lives.
 *
 * See `ehProtocol.ts` for the full set of messages exchanged.
 */

import { dirname, join, normalizePath } from "./path";
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
  setActiveExtensionKey,
  setDataDir,
  setWorkspaceFolders,
  setActiveEditor,
  setWorkspaceConfig,
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
  CompletionItem,
  CompletionItemLabel,
  CompletionList,
  Diagnostic,
  DocumentLink,
  DocumentSymbol,
  FoldingRange,
  Hover,
  Location,
  MarkdownString,
  Position,
  Range,
  SelectionRange,
  SymbolInformation,
  TextEdit,
  Uri,
  type MarkedString,
} from "./vscodeShim/types";
import { ExtensionMode, registerExtension as _reg } from "./vscodeShim/extensions";

void _reg;

// ── Types duplicated from loader (avoid DOM imports) ────────────────

interface ExtensionIconTheme { id: string; label: string; path: string }
interface ExtensionLanguage { id: string; aliases?: string[]; extensions?: string[]; filenames?: string[]; configuration?: string }
interface ExtensionGrammar { language: string; scopeName: string; path: string; embeddedLanguages?: Record<string, string> }
interface LoadedGrammarRef { contribution: ExtensionGrammar; path: string }
interface ExtensionViewerContribution { id: string; label: string; patterns: string[]; mimeTypes?: string[]; entry: string; priority?: number }
interface ExtensionEditorContribution { id: string; label: string; patterns: string[]; mimeTypes?: string[]; langId?: string; entry: string; priority?: number }
interface ExtensionColorTheme { id?: string; label: string; uiTheme: string; path: string }
interface ExtensionCommand { command: string; title: string; category?: string; icon?: string }
interface ExtensionKeybinding { command: string; key: string; mac?: string; when?: string; args?: unknown }
interface ExtensionFsProviderContribution { id: string; label: string; patterns: string[]; entry: string; priority?: number; runtime?: "frontend" | "backend" }
interface ExtensionShellIntegration {
  shell: string; label: string; scriptPath: string; executableCandidates: string[];
  platforms?: ("darwin" | "linux" | "unix" | "windows")[];
  hiddenCdTemplate?: string; cwdEscape?: "posix" | "powershell" | "cmd";
  lineEnding?: "\n" | "\r\n"; spawnArgs?: string[]; scriptArg?: boolean;
}
interface ExtensionContributions {
  iconTheme?: ExtensionIconTheme; iconThemes?: ExtensionIconTheme[]; themes?: ExtensionColorTheme[];
  languages?: ExtensionLanguage[]; grammars?: ExtensionGrammar[];
  viewers?: ExtensionViewerContribution[]; editors?: ExtensionEditorContribution[];
  commands?: ExtensionCommand[]; keybindings?: ExtensionKeybinding[];
  fsProviders?: ExtensionFsProviderContribution[]; shellIntegrations?: ExtensionShellIntegration[];
  configuration?: { properties?: Record<string, { default?: unknown }> } | Array<{ properties?: Record<string, { default?: unknown }> }>;
  configurationDefaults?: Record<string, Record<string, unknown>>;
}

interface ExtensionManifest {
  name: string; version: string; publisher: string;
  displayName?: string; description?: string; icon?: string;
  activationEvents?: string[]; browser?: string; main?: string; type?: string;
  contributes?: ExtensionContributions;
}

interface ExtensionRef {
  publisher: string; name: string; version: string;
  source?: "dotdir-marketplace" | "open-vsx-marketplace";
  autoUpdate?: boolean; path?: string;
}

interface WorkerLoadedColorTheme { id: string; label: string; uiTheme: string; jsonPath: string }

export interface WorkerLoadedExtension {
  ref: ExtensionRef;
  manifest: ExtensionManifest;
  dirPath: string;
  iconUrl?: string;
  iconThemes?: Array<{ id: string; label: string; kind: "fss" | "vscode"; path: string; basePath?: string; sourceId?: string; fss?: string }>;
  colorThemes?: WorkerLoadedColorTheme[];
  languages?: ExtensionLanguage[];
  grammarRefs?: LoadedGrammarRef[];
  viewers?: ExtensionViewerContribution[];
  editors?: ExtensionEditorContribution[];
  commands?: ExtensionCommand[];
  keybindings?: ExtensionKeybinding[];
  fsProviders?: ExtensionFsProviderContribution[];
  shellIntegrations?: Array<{
    shell: string; label: string; script: string; executableCandidates: string[];
    platforms?: ("darwin" | "linux" | "unix" | "windows")[];
    hiddenCdTemplate?: string; cwdEscape?: "posix" | "powershell" | "cmd";
    lineEnding?: "\n" | "\r\n"; spawnArgs?: string[]; scriptArg?: boolean;
  }>;
}

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

/** Injected into nested workers so they can load file:// URLs via the parent. */
const NESTED_XHR_SHIM = `
(function(){
  var _XHR = self.XMLHttpRequest;
  self.XMLHttpRequest = function(){
    var xhr = this;
    var _method = 'GET', _url = '', _async = true;
    var _status = 0, _statusText = '', _responseText = '', _readyState = 0;
    var _onreadystatechange = null, _responseType = '';

    Object.defineProperty(xhr, 'readyState', { get:function(){return _readyState} });
    Object.defineProperty(xhr, 'status', { get:function(){return _status} });
    Object.defineProperty(xhr, 'statusText', { get:function(){return _statusText} });
    Object.defineProperty(xhr, 'responseText', { get:function(){return _responseText} });
    Object.defineProperty(xhr, 'responseType', { get:function(){return _responseType}, set:function(v){_responseType=v} });
    Object.defineProperty(xhr, 'responseURL', { get:function(){return _url} });
    Object.defineProperty(xhr, 'onreadystatechange', { get:function(){return _onreadystatechange}, set:function(v){_onreadystatechange=v} });

    xhr.open = function(method, url, async){ _method=method; _url=url; _async=async!==false };
    xhr.send = function(){
      var url = _url;
      // Only intercept file:// URLs or relative extension paths
      var isFile = /^file:\\/\\//i.test(url);
      if(!isFile){
        var real = new _XHR();
        real.open(_method, url, _async);
        real.responseType = _responseType;
        real.onreadystatechange = function(){
          _readyState = real.readyState;
          _status = real.status;
          _statusText = real.statusText;
          _responseText = real.responseText;
          if(_readyState === 4) _onreadystatechange&&_onreadystatechange();
        };
        real.send();
        return;
      }
      // Ask parent worker to read the file
      var rid = Date.now() + Math.random();
      var handler = function(e){
        if(e.data && e.data._xhrId === rid){
          self.removeEventListener('message', handler);
          _status = e.data.status || 200;
          _statusText = e.data.statusText || 'OK';
          _responseText = e.data.text || '';
          _readyState = 4;
          _onreadystatechange&&_onreadystatechange();
        }
      };
      self.addEventListener('message', handler);
      self.postMessage({ _xhrId: rid, _xhrUrl: url });
    };
    xhr.abort = function(){};
    xhr.overrideMimeType = function(){};
    xhr.getResponseHeader = function(){return null};
    xhr.getAllResponseHeaders = function(){return ''};
    xhr.addEventListener = function(){};
    xhr.removeEventListener = function(){};
    xhr.dispatchEvent = function(){return true};
  };
})();
`;

async function fetchAsBlobUrl(rawUrl: string, injectShim = true): Promise<string> {
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
    // Inject XHR shim so nested workers can read file:// resources
    const withShim = injectShim ? NESTED_XHR_SHIM + rewritten : rewritten;
    return URL.createObjectURL(new Blob([withShim], { type: "text/javascript" }));
  }
  const response = await fetch(rawUrl);
  const text = await response.text();
  const withShim = injectShim ? NESTED_XHR_SHIM + text : text;
  return URL.createObjectURL(new Blob([withShim], { type: "text/javascript" }));
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
      const blobUrl = await fetchAsBlobUrl(scriptUrl);
      const worker = new _OriginalWorker(blobUrl, options);
      this._impl = worker;

      worker.onmessage = (ev) => {
        // Handle nested XHR requests from the injected shim
        if (ev.data && typeof ev.data._xhrId !== "undefined" && typeof ev.data._xhrUrl === "string") {
          void this._handleNestedXhr(worker, ev.data._xhrId, ev.data._xhrUrl);
          return;
        }
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

  private async _handleNestedXhr(worker: Worker, id: number | string, rawUrl: string): Promise<void> {
    const path = urlToLocalPath(rawUrl);
    if (!path) {
      worker.postMessage({ _xhrId: id, status: 404, statusText: "Not Found", text: "" });
      return;
    }
    try {
      const text = await readTextFile(path);
      if (text == null) {
        worker.postMessage({ _xhrId: id, status: 404, statusText: "Not Found", text: "" });
        return;
      }
      worker.postMessage({ _xhrId: id, status: 200, statusText: "OK", text });
    } catch {
      worker.postMessage({ _xhrId: id, status: 500, statusText: "Error", text: "" });
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

// ── XMLHttpRequest polyfill for file:// URLs ────────────────────────

const _OriginalXHR = (globalThis as unknown as { XMLHttpRequest: typeof XMLHttpRequest }).XMLHttpRequest;

if (_OriginalXHR) {
  const g = globalThis as unknown as {
    XMLHttpRequest: typeof XMLHttpRequest;
    _DotDirOriginalXHR?: typeof XMLHttpRequest;
  };
  g._DotDirOriginalXHR = _OriginalXHR;
  g.XMLHttpRequest = class ProxiedXHR {
    private _method = "GET";
    private _url = "";
    private _async = true;
    private _status = 0;
    private _statusText = "";
    private _responseText = "";
    private _responseType: XMLHttpRequestResponseType = "";
    private _readyState = 0;
    private _listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
    private _onreadystatechange: (() => void) | null = null;

    get readyState(): number { return this._readyState; }
    get status(): number { return this._status; }
    get statusText(): string { return this._statusText; }
    get responseText(): string { return this._responseText; }
    get responseType(): XMLHttpRequestResponseType { return this._responseType; }
    set responseType(value: XMLHttpRequestResponseType) { this._responseType = value; }
    get responseURL(): string { return this._url; }

    set onreadystatechange(cb: (() => void) | null) { this._onreadystatechange = cb; }
    get onreadystatechange(): (() => void) | null { return this._onreadystatechange; }

    open(method: string, url: string, async = true): void {
      this._method = method;
      this._url = url;
      this._async = async;
    }

    send(): void {
      const url = this._url;
      const path = urlToLocalPath(url);
      if (!path) {
        // Fall through to real XHR (won't work for file:// but will for http(s))
        const real = new _OriginalXHR();
        real.open(this._method, url, this._async);
        real.responseType = this._responseType;
        real.onreadystatechange = () => {
          this._readyState = real.readyState;
          this._status = real.status;
          this._statusText = real.statusText;
          this._responseText = real.responseText;
          if (this._readyState === 4) {
            this._onreadystatechange?.();
          }
        };
        real.send();
        return;
      }
      void (async () => {
        try {
          const text = await readTextFile(path);
          if (text === null) {
            this._setState(4, 404, "Not Found", "");
            return;
          }
          this._setState(4, 200, "OK", text);
        } catch (err) {
          this._setState(4, 500, "Error", "");
        }
      })();
    }

    private _setState(readyState: number, status: number, statusText: string, responseText: string): void {
      this._readyState = readyState;
      this._status = status;
      this._statusText = statusText;
      this._responseText = responseText;
      this._onreadystatechange?.();
    }

    addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
      let set = this._listeners.get(type);
      if (!set) { set = new Set(); this._listeners.set(type, set); }
      set.add(listener);
    }
    removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
      this._listeners.get(type)?.delete(listener);
    }
    dispatchEvent(): boolean { return true; }
    abort(): void {}
    overrideMimeType(): void {}
    getResponseHeader(): string | null { return null; }
    getAllResponseHeaders(): string { return ""; }
  } as unknown as typeof XMLHttpRequest;
}

// ── Helpers ─────────────────────────────────────────────────────────

function activationKey(ext: WorkerLoadedExtension): string {
  return `${ext.ref.publisher}.${ext.ref.name}.${ext.ref.version}`;
}

function extensionId(ext: WorkerLoadedExtension): string {
  return `${ext.ref.publisher}.${ext.ref.name}`;
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

function extensionWantsEvent(ext: WorkerLoadedExtension, event: string): boolean {
  const events = ext.manifest.activationEvents ?? [];
  if (events.length === 0) return event === "*";
  return events.includes("*") || events.includes(event);
}

// ── Browser module loading ─────────────────────────────────────────

type BrowserExtensionModule = {
  activate?: (ctx: unknown) => unknown | Promise<unknown>;
  deactivate?: (ctx: unknown) => unknown | Promise<unknown>;
  default?: { activate?: (ctx: unknown) => unknown | Promise<unknown>; deactivate?: (ctx: unknown) => unknown | Promise<unknown> };
};

async function importBrowserModuleEsm(absScriptPath: string): Promise<BrowserExtensionModule> {
  const moduleUrl = extensionScriptVfsUrl(absScriptPath);
  const mod = await import(/* @vite-ignore */ moduleUrl);
  return mod as BrowserExtensionModule;
}

async function importBrowserModuleCjs(absScriptPath: string, extDir: string): Promise<BrowserExtensionModule> {
  const script = await readTextFile(absScriptPath);
  if (script == null) throw new Error(`Browser script not found: ${absScriptPath}`);
  const cjsWrapper = `
const __dotdir_vscode = globalThis.__dotdir_vscode_api;
const module = { exports: {} };
const exports = module.exports;
const require = (id) => {
  if (id === "vscode") return __dotdir_vscode;
  throw new Error("Unsupported browser require: " + id);
};
const __filename = ${JSON.stringify(absScriptPath)};
const __dirname = ${JSON.stringify(extDir)};

// Make vscode findable by webpack externals, which may use self.vscode,
// self.require, or __non_webpack_require__ in the worker global scope.
self.vscode = __dotdir_vscode;
self.require = require;

(function(module, exports, require, globalThis, self, __filename, __dirname){
${script}
})(module, exports, require, globalThis, self, __filename, __dirname);
delete self.vscode;
delete self.require;
const __exp = module.exports && module.exports.__esModule && module.exports.default ? module.exports.default : module.exports;
export default __exp;
export const activate = __exp?.activate;
export const deactivate = __exp?.deactivate;
`;
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
  const extensionUri = Uri.file(ext.dirPath);
  const globalStorageDir = join(ext.dirPath, "..", ".global-storage", id);
  const logDir = join(ext.dirPath, "..", ".logs", id);
  return {
    subscriptions: subs,
    extensionUri,
    extensionPath: ext.dirPath,
    globalStoragePath: globalStorageDir,
    globalStorageUri: Uri.file(globalStorageDir),
    storagePath: undefined,
    storageUri: undefined,
    logPath: logDir,
    logUri: Uri.file(logDir),
    environmentVariableCollection: { persistent: false, replace: () => {}, append: () => {}, prepend: () => {}, get: () => undefined, forEach: () => {}, delete: () => {}, clear: () => {} },
    extensionMode: ExtensionMode.Production,
    asAbsolutePath: (relative: string) => join(ext.dirPath, relative),
    secrets: { get: async () => undefined, store: async () => {}, delete: async () => {}, onDidChange: () => ({ dispose: () => {} }) },
    globalState: createMemento(`${id}:global`),
    workspaceState: createMemento(`${id}:workspace`),
    extension: {
      id,
      extensionUri,
      extensionPath: ext.dirPath,
      isActive: false,
      packageJSON: ext.manifest as unknown as Record<string, unknown>,
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
  if (!ext.manifest.browser) return;

  setActiveExtensionKey(key);

  const relScript = normalizePath(ext.manifest.browser).replace(/^\/+/, "");
  const absScriptPath = join(ext.dirPath, relScript);
  const resolvedScriptPath = await resolveBrowserScriptPath(absScriptPath);
  const isEsm = String(ext.manifest.type ?? "").trim().toLowerCase() === "module";
  logActivation("info", `loading browser script ${resolvedScriptPath} via ${isEsm ? "esm" : "cjs-wrapper"}`);

  const mod = isEsm
    ? await importBrowserModuleEsm(resolvedScriptPath)
    : await importBrowserModuleCjs(resolvedScriptPath, ext.dirPath);
  const activate = mod.activate ?? mod.default?.activate;
  const deactivate = mod.deactivate ?? mod.default?.deactivate;
  if (typeof activate !== "function") {
    logActivation("warn", "browser entry has no activate() export");
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
    packageJSON: ext.manifest as unknown as Record<string, unknown>,
    extensionKind: 1,
    exports: undefined,
    activate: async () => undefined,
  });

  const exports = await activate(ctx);
  markExtensionActive(extensionId(ext), exports);
  logActivation("info", "activated");
  activeExtensions.set(key, { subscriptions: subs, deactivate });
  setActiveExtensionKey(null);
}

async function activateByEvent(event: string): Promise<void> {
  for (const ext of loadedExtensions.values()) {
    if (!ext.manifest.browser) continue;
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
  return await handler(...args);
}

// ── Extension loading (from disk) ──────────────────────────────────

function extensionDirName(ref: ExtensionRef): string {
  return `${ref.publisher}-${ref.name}-${ref.version}`;
}

type NlsBundle = Record<string, string>;

function localeCandidates(locale: string): string[] {
  const normalized = locale.trim().toLowerCase().replace(/_/g, "-");
  if (!normalized) return [];
  const parts = normalized.split("-");
  const candidates: string[] = [];
  for (let i = parts.length; i > 0; i--) {
    candidates.push(parts.slice(0, i).join("-"));
  }
  return candidates;
}

async function readNlsBundle(path: string): Promise<NlsBundle | null> {
  const text = await readTextFile(path);
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const out: NlsBundle = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === "string") out[key] = value;
    }
    return out;
  } catch {
    return null;
  }
}

async function loadManifestNlsBundle(extDir: string): Promise<NlsBundle> {
  const locale =
    ((self as typeof globalThis & { navigator?: { language?: string } }).navigator?.language ?? "en").trim() || "en";
  const merged: NlsBundle = {};

  // Base bundle always provides the fallback source.
  const base = await readNlsBundle(join(extDir, "package.nls.json"));
  if (base) Object.assign(merged, base);

  // Locale-specific bundle overrides base keys when present.
  const candidates = localeCandidates(locale);
  for (const candidate of candidates) {
    const localized = await readNlsBundle(join(extDir, `package.nls.${candidate}.json`));
    if (localized) {
      Object.assign(merged, localized);
      break;
    }
  }

  return merged;
}

function localizeManifestValue(value: unknown, bundle: NlsBundle): unknown {
  if (typeof value === "string") {
    const match = value.match(/^%([^%]+)%$/);
    if (!match) return value;
    const key = match[1] ?? "";
    return bundle[key] ?? value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => localizeManifestValue(item, bundle));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = localizeManifestValue(v, bundle);
    }
    return out;
  }
  return value;
}

async function loadExtensionFromDir(extDir: string): Promise<WorkerLoadedExtension | null> {
  try {
    const manifestText = await readTextFile(join(extDir, "package.json"));
    if (manifestText === null) return null;
    const rawManifest = JSON.parse(manifestText) as ExtensionManifest;
    const nlsBundle = await loadManifestNlsBundle(extDir);
    const manifest = localizeManifestValue(rawManifest, nlsBundle) as ExtensionManifest;

    const ref: ExtensionRef = {
      publisher: manifest.publisher || "unknown",
      name: manifest.name || "unknown",
      version: manifest.version || "0.0.0",
    };

    const iconThemes: NonNullable<WorkerLoadedExtension["iconThemes"]> = [];
    if (manifest.contributes?.iconTheme?.path) {
      const theme = manifest.contributes.iconTheme;
      const themePath = join(extDir, theme.path);
      if (themePath.endsWith(".json")) {
        iconThemes.push({ id: theme.id || "default", label: theme.label || manifest.displayName || manifest.name, kind: "vscode", path: themePath, sourceId: theme.id });
      } else {
        iconThemes.push({ id: theme.id || "default", label: theme.label || manifest.displayName || manifest.name, kind: "fss", path: themePath, basePath: dirname(themePath), sourceId: theme.id });
      }
    }

    if (manifest.contributes?.iconThemes?.length) {
      iconThemes.push(
        ...manifest.contributes.iconThemes.map((theme, index) => ({
          id: theme.id || `${theme.label}#${index}`,
          label: theme.label,
          kind: theme.path.endsWith(".json") ? ("vscode" as const) : ("fss" as const),
          path: join(extDir, theme.path),
          basePath: theme.path.endsWith(".json") ? undefined : dirname(join(extDir, theme.path)),
          sourceId: theme.id,
        })),
      );
    }

    const languages = manifest.contributes?.languages;

    let grammarRefs: LoadedGrammarRef[] | undefined;
    if (manifest.contributes?.grammars?.length) {
      grammarRefs = [];
      for (const grammarContrib of manifest.contributes.grammars) {
        const grammarPath = join(extDir, grammarContrib.path);
        grammarRefs.push({ contribution: grammarContrib, path: grammarPath });
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

    const loaded: WorkerLoadedExtension = {
      ref,
      manifest,
      dirPath: extDir,
      iconUrl: manifest.icon ? join(extDir, normalizePath(manifest.icon).replace(/^\/+/, "")) : undefined,
      iconThemes: iconThemes.length > 0 ? iconThemes : undefined,
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
    loadManifestConfig(manifest);
    return loaded;
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
    if (ext) {
      ext.ref.source = ref.source;
      ext.ref.autoUpdate = ref.autoUpdate;
      if (ref.path) ext.ref.path = normalizePath(ref.path);
      loaded.push(ext);
    }
  }

  console.log("[ExtHost] loaded", loaded.length, "extensions");
  loadedExtensions.clear();
  for (const ext of loaded) loadedExtensions.set(activationKey(ext), ext);
  return loaded;
}

// ── Provider invocation dispatch ───────────────────────────────────

const providerCancellations = new Map<number, { isCancellationRequested: boolean; onCancellationRequested: ReturnType<typeof noopCancelEvent> }>();

function noopCancelEvent() {
  return (_l: () => void) => ({ dispose() {} });
}

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
    command: ci.command,
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
  const any = l as { uri?: Uri; range?: { start: { line: number; character: number }; end: { line: number; character: number } }; targetUri?: Uri; targetRange?: { start: { line: number; character: number }; end: { line: number; character: number } } };
  // LocationLink (used by TypeScript extension): targetUri + targetRange
  if (any.targetUri && any.targetRange) {
    return { uri: any.targetUri.toString(), range: rangePayload(any.targetRange) };
  }
  // Location: uri + range
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
      return arr.map((l) => locationPayload(l));
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
    case "configuration/workspace":
      setWorkspaceConfig(msg.root, msg.values);
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

