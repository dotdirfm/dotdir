/**
 * Extension Host Client
 *
 * Owns the Extension Host Web Worker from the main thread. Translates
 * document/editor/workspace/configuration events into RPC messages for
 * the worker, and routes provider/diagnostic/output/message/command
 * requests coming back out of the worker to the appropriate main-thread
 * sinks (DocumentTracker, ProviderBridge, DiagnosticsBridge, ...).
 */

import type { Bridge } from "@/features/bridge";
import { readAppDirs } from "@/features/bridge/appDirs";
import { useBridge } from "@/features/bridge/useBridge";
import { readFileText } from "@/features/file-system/fs";
import { normalizePath } from "@/utils/path";
import { createContext, createElement, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type {
  CommandExecuteMsg,
  ConfigurationReadMsg,
  ConfigurationWriteMsg,
  DiagnosticPayload,
  DocumentSelectorPayload,
  EditorApplyEditMsg,
  EnvOpenExternalMsg,
  HostToMainMessage,
  MainToHostMessage,
  MessageShowMsg,
  OutputAppendMsg,
  ProviderKind,
  StatusBarUpdateMsg,
  WorkspaceEditPayload,
} from "./ehProtocol";
import worker2 from "./extensionHost.worker.ts?worker&inline";
import { ExtensionSettingsStore } from "./extensionSettings";
import {
  extensionColorThemes,
  extensionCommands,
  extensionGrammarRefs,
  extensionIconThemes,
  extensionLanguages,
  extensionRef,
  type LoadedExtension,
} from "./types";

type ExtensionsLoadedCallback = (extensions: LoadedExtension[]) => void;

export interface ProviderRegistration {
  providerId: number;
  kind: ProviderKind;
  selector: DocumentSelectorPayload;
  metadata?: Record<string, unknown>;
}

export type ProviderRegisterListener = (reg: ProviderRegistration) => void;
export type ProviderUnregisterListener = (providerId: number) => void;

export type DiagnosticsListener = (event: { owner: string; uri: string; diagnostics: DiagnosticPayload[] }) => void;
export type DiagnosticsClearListener = (event: { owner: string; uri?: string }) => void;

export type OutputAppendListener = (event: { channel: string; text: string; newline: boolean }) => void;
export type StatusBarListener = (event: StatusBarUpdateMsg) => void;
export type MessageShowListener = (event: MessageShowMsg) => Promise<string | undefined>;
export type OpenExternalListener = (uri: string) => Promise<boolean>;
export type ApplyEditListener = (edit: WorkspaceEditPayload) => Promise<boolean>;
export type CommandRequestListener = (command: string, args: unknown[]) => Promise<unknown>;
export type ConfigReadListener = (key: string, section?: string) => unknown;
export type ConfigWriteListener = (msg: Omit<ConfigurationWriteMsg, "type" | "requestId">) => Promise<void>;

/**
 * Emit a dev-friendly summary of what the extension host actually loaded.
 *
 * The previous log only printed the *icon* theme contributions, which made it
 * look like nothing else loaded even when 6 extensions were up. This prints
 * one grouped line plus a per-extension breakdown of languages, grammars,
 * commands, icon themes and color themes so you can tell at a glance whether a
 * given extension's contributions were picked up.
 */
function logLoadedExtensionSummary(extensions: LoadedExtension[]): void {
  const ids = extensions.map((e) => `${extensionRef(e).publisher}.${extensionRef(e).name}@${extensionRef(e).version}`);
  const languages = extensions.flatMap((e) => extensionLanguages(e).map((l) => l.id));
  const grammars = extensions.flatMap((e) => extensionGrammarRefs(e).map((g) => g.contribution.scopeName));
  const commands = extensions.flatMap((e) => extensionCommands(e).map((c) => c.command));
  const iconThemes = extensions.flatMap((e) =>
    extensionIconThemes(e).map((t) => `${extensionRef(e).publisher}.${extensionRef(e).name}:${t.id}[${t.kind}]`),
  );
  const colorThemes = extensions.flatMap((e) =>
    extensionColorThemes(e).map((t) => `${extensionRef(e).publisher}.${extensionRef(e).name}:${t.id}`),
  );

  console.groupCollapsed(
    `[ExtHost] loaded ${extensions.length} extension(s); ${languages.length} language(s), ${grammars.length} grammar(s), ${commands.length} command(s), ${iconThemes.length} icon theme(s), ${colorThemes.length} color theme(s)`,
  );
  console.log("extensions:", ids);
  if (languages.length) console.log("languages:", languages);
  if (grammars.length) console.log("grammars:", grammars);
  if (commands.length) console.log("commands:", commands);
  if (iconThemes.length) console.log("iconThemes:", iconThemes);
  if (colorThemes.length) console.log("colorThemes:", colorThemes);
  console.groupEnd();
}

function normalizeLoadedExtensionPayload(raw: unknown): LoadedExtension {
  const value = raw as Record<string, unknown>;
  if ("identity" in value && "location" in value && "assets" in value && "contributions" in value) {
    return raw as unknown as LoadedExtension;
  }
  return {
    identity: {
      ref: value.ref as LoadedExtension["identity"]["ref"],
      manifest: value.manifest as LoadedExtension["identity"]["manifest"],
    },
    location: { dirPath: String(value.dirPath ?? "") },
    assets: {
      iconThemes: value.iconThemes as LoadedExtension["assets"]["iconThemes"],
      colorThemes: value.colorThemes as LoadedExtension["assets"]["colorThemes"],
    },
    contributions: {
      languages: value.languages as LoadedExtension["contributions"]["languages"],
      grammarRefs: value.grammarRefs as LoadedExtension["contributions"]["grammarRefs"],
      commands: value.commands as LoadedExtension["contributions"]["commands"],
      keybindings: value.keybindings as LoadedExtension["contributions"]["keybindings"],
      viewers: value.viewers as LoadedExtension["contributions"]["viewers"],
      editors: value.editors as LoadedExtension["contributions"]["editors"],
      fsProviders: value.fsProviders as LoadedExtension["contributions"]["fsProviders"],
      shellIntegrations: value.shellIntegrations as LoadedExtension["contributions"]["shellIntegrations"],
    },
  };
}

async function handleWorkerCommand(bridge: Bridge, command: string, args: unknown[]): Promise<unknown> {
  switch (command) {
    case "__dotdir/fs.stat": {
      const p = normalizePath(String(args[0] ?? ""));
      try {
        const exists = await bridge.fs.exists(p);
        if (!exists) return null;
        const st = await bridge.fs.stat(p);
        const isDir = await bridge.fs.entries(p).then(() => true, () => false);
        return { size: st.size, mtimeMs: st.mtimeMs, isDir };
      } catch {
        return null;
      }
    }
    case "__dotdir/fs.writeFile": {
      const p = normalizePath(String(args[0] ?? ""));
      const text = String(args[1] ?? "");
      await bridge.fs.writeFile(p, text);
      return null;
    }
    case "__dotdir/fs.delete": {
      const p = normalizePath(String(args[0] ?? ""));
      if (bridge.fs.removeFile) {
        await bridge.fs.removeFile(p);
      } else {
        await bridge.fs.moveToTrash([p]);
      }
      return null;
    }
    case "__dotdir/fs.rename": {
      const from = normalizePath(String(args[0] ?? ""));
      const to = normalizePath(String(args[1] ?? ""));
      await bridge.fs.rename.rename(from, to);
      return null;
    }
    case "__dotdir/fs.readDir": {
      const p = normalizePath(String(args[0] ?? ""));
      const entries = await bridge.fs.entries(p);
      return entries.map((e) => ({ name: e.name, isDir: e.kind === "directory" }));
    }
    case "__dotdir/fs.createDir": {
      const p = normalizePath(String(args[0] ?? ""));
      await bridge.fs.createDir(p);
      return null;
    }
    case "__dotdir/fs.copy": {
      const from = normalizePath(String(args[0] ?? ""));
      const to = normalizePath(String(args[1] ?? ""));
      // Minimal copy: read + write
      const bytes = await bridge.fs.readFile(from);
      await bridge.fs.writeBinaryFile(to, new Uint8Array(bytes));
      return null;
    }
    case "__dotdir/openFile": {
      // Best-effort: log; real panel navigation happens elsewhere.
      void bridge.utils.debugLog?.(`[ExtensionHost] openFile requested: ${String(args[0] ?? "")}`);
      return null;
    }
    default:
      return null;
  }
}

export class ExtensionHostClient {
  private worker: Worker | null = null;
  private listeners: ExtensionsLoadedCallback[] = [];
  // The `loaded` message arrives asynchronously after the worker finishes
  // reading extensions.json and activating `*` events. If a subscriber
  // registers *after* that message has already been delivered (common during
  // HMR or when mount ordering puts the subscriber's effect late), the event
  // would otherwise be lost and the UI would see an empty extensions list.
  // We latch the last payload here and replay it to late subscribers.
  private lastLoaded: LoadedExtension[] | null = null;
  private starting = false;
  private nextRequestId = 1;
  private pendingRequests = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();

  // Bridge listeners registered by main-thread subsystems.
  private providerRegisterListeners = new Set<ProviderRegisterListener>();
  private providerUnregisterListeners = new Set<ProviderUnregisterListener>();
  private diagnosticsListeners = new Set<DiagnosticsListener>();
  private diagnosticsClearListeners = new Set<DiagnosticsClearListener>();
  private outputListeners = new Set<OutputAppendListener>();
  private statusBarListeners = new Set<StatusBarListener>();
  private messageShowListener: MessageShowListener | null = null;
  private openExternalListener: OpenExternalListener | null = null;
  private applyEditListener: ApplyEditListener | null = null;
  private commandRequestListener: CommandRequestListener | null = null;
  private configReadListener: ConfigReadListener | null = null;
  private configWriteListener: ConfigWriteListener | null = null;

  private queuedOutbound: MainToHostMessage[] = [];
  private workerReady = false;

  constructor(
    private bridge: Bridge,
    private dataDir: string,
  ) {}

  onLoaded(cb: ExtensionsLoadedCallback): () => void {
    this.listeners.push(cb);
    // Replay the latched payload so late subscribers never miss the initial
    // `loaded` event. Deliver on a microtask so the caller can still set up
    // whatever state it needs before the callback fires.
    if (this.lastLoaded) {
      const snapshot = this.lastLoaded;
      queueMicrotask(() => {
        if (this.listeners.includes(cb)) cb(snapshot);
      });
    }
    return () => {
      this.listeners = this.listeners.filter((l) => l !== cb);
    };
  }

  async start(): Promise<void> {
    if (this.worker || this.starting) return;
    this.starting = true;
    try {
      this.spawnWorker();
    } finally {
      this.starting = false;
    }
  }

  async restart(): Promise<void> {
    this.worker?.terminate();
    this.worker = null;
    this.workerReady = false;
    this.lastLoaded = null;
    for (const [, pending] of this.pendingRequests) pending.reject(new Error("Extension host restarted"));
    this.pendingRequests.clear();
    await this.start();
  }

  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
    this.workerReady = false;
    this.lastLoaded = null;
    for (const [, pending] of this.pendingRequests) pending.reject(new Error("Extension host disposed"));
    this.pendingRequests.clear();
    this.listeners = [];
  }

  // ── Inbound subscriptions (provider, diagnostics, ...) ────────────

  onProviderRegister(cb: ProviderRegisterListener): () => void {
    this.providerRegisterListeners.add(cb);
    return () => this.providerRegisterListeners.delete(cb);
  }
  onProviderUnregister(cb: ProviderUnregisterListener): () => void {
    this.providerUnregisterListeners.add(cb);
    return () => this.providerUnregisterListeners.delete(cb);
  }
  onDiagnostics(cb: DiagnosticsListener): () => void {
    this.diagnosticsListeners.add(cb);
    return () => this.diagnosticsListeners.delete(cb);
  }
  onDiagnosticsClear(cb: DiagnosticsClearListener): () => void {
    this.diagnosticsClearListeners.add(cb);
    return () => this.diagnosticsClearListeners.delete(cb);
  }
  onOutput(cb: OutputAppendListener): () => void {
    this.outputListeners.add(cb);
    return () => this.outputListeners.delete(cb);
  }
  onStatusBar(cb: StatusBarListener): () => void {
    this.statusBarListeners.add(cb);
    return () => this.statusBarListeners.delete(cb);
  }
  setMessageShowListener(listener: MessageShowListener | null): void {
    this.messageShowListener = listener;
  }
  setOpenExternalListener(listener: OpenExternalListener | null): void {
    this.openExternalListener = listener;
  }
  setApplyEditListener(listener: ApplyEditListener | null): void {
    this.applyEditListener = listener;
  }
  setCommandRequestListener(listener: CommandRequestListener | null): void {
    this.commandRequestListener = listener;
  }
  setConfigReadListener(listener: ConfigReadListener | null): void {
    this.configReadListener = listener;
  }
  setConfigWriteListener(listener: ConfigWriteListener | null): void {
    this.configWriteListener = listener;
  }

  // ── Outbound: document / editor / workspace / configuration ──────

  documentOpen(uri: string, languageId: string, version: number, text: string): void {
    this.post({ type: "document/open", uri, languageId, version, text });
  }

  documentChange(uri: string, version: number, text: string): void {
    this.post({ type: "document/change", uri, version, text });
  }

  documentClose(uri: string): void {
    this.post({ type: "document/close", uri });
  }

  documentSave(uri: string): void {
    this.post({ type: "document/save", uri });
  }

  setWorkspaceFolders(folders: Array<{ uri: string; name: string }>): void {
    this.post({ type: "workspace/folders", folders });
  }

  configurationUpdate(key: string, value: unknown, section?: string): void {
    this.post({ type: "configuration/update", key, value, section });
  }

  setActiveEditor(uri: string | null): void {
    this.post({ type: "editor/active", uri });
  }

  invokeProvider(providerId: number, method: string, args: unknown): Promise<unknown> {
    return this.request<unknown>({ type: "provider/invoke", providerId, method, args });
  }

  cancelProviderRequest(requestId: number): void {
    this.post({ type: "provider/cancel", requestId });
  }

  async activateByEvent(event: string): Promise<void> {
    await this.request<void>({ type: "activateByEvent", event });
  }

  async executeCommand(command: string, args: unknown[] = []): Promise<unknown> {
    return await this.request<unknown>({ type: "executeCommand", command, args });
  }

  // ── Internals ─────────────────────────────────────────────────────

  private spawnWorker(): void {
    const worker = new worker2();

    worker.onmessage = (e: MessageEvent) => {
      this.handleMessage(worker, e.data as HostToMainMessage);
    };
    worker.onerror = (e) => {
      console.error("[ExtensionHost] Worker runtime error:", e);
    };

    this.worker = worker;
    this.workerReady = true;
    void (async () => {
      worker.postMessage({ type: "start", dataDir: this.dataDir } satisfies MainToHostMessage);
      // Flush queued outbound messages that tried to send before the worker existed.
      const queued = this.queuedOutbound.splice(0);
      for (const msg of queued) worker.postMessage(msg);
    })();
  }

  private handleMessage(worker: Worker, msg: HostToMainMessage): void {
    switch (msg.type) {
      case "readFile":
        void this.handleFileRead(worker, msg.id, msg.path);
        return;
      case "readBinaryFile":
        void this.handleBinaryRead(worker, msg.id, msg.path);
        return;
      case "loaded": {
        const extensions: LoadedExtension[] = Array.isArray(msg.extensions)
          ? (msg.extensions as unknown[]).map(normalizeLoadedExtensionPayload)
          : [];
        logLoadedExtensionSummary(extensions);
        this.lastLoaded = extensions;
        for (const cb of this.listeners.slice()) cb(extensions);
        return;
      }
      case "error":
        console.error("[ExtensionHost] Worker error:", msg.message);
        void this.bridge.utils.debugLog?.(`[ExtensionHost] worker error: ${String(msg.message ?? "unknown")}`);
        return;
      case "activationLog": {
        const text = `[ExtensionHost:${msg.level}] ${msg.extension}${msg.event ? ` event=${msg.event}` : ""} ${msg.message}`.trim();
        if (msg.level === "error") console.error(text);
        else if (msg.level === "warn") console.warn(text);
        else console.log(text);
        void this.bridge.utils.debugLog?.(text);
        return;
      }
      case "requestResult": {
        const pending = this.pendingRequests.get(msg.requestId);
        if (!pending) return;
        this.pendingRequests.delete(msg.requestId);
        if (msg.error) pending.reject(new Error(String(msg.error)));
        else pending.resolve(msg.result);
        return;
      }
      case "provider/register": {
        for (const cb of this.providerRegisterListeners) cb({ providerId: msg.providerId, kind: msg.kind, selector: msg.selector, metadata: msg.metadata });
        return;
      }
      case "provider/unregister": {
        for (const cb of this.providerUnregisterListeners) cb(msg.providerId);
        return;
      }
      case "diagnostics/set": {
        for (const cb of this.diagnosticsListeners) cb({ owner: msg.owner, uri: msg.uri, diagnostics: msg.diagnostics });
        return;
      }
      case "diagnostics/clear": {
        for (const cb of this.diagnosticsClearListeners) cb({ owner: msg.owner, uri: msg.uri });
        return;
      }
      case "output/append":
        for (const cb of this.outputListeners) cb(msg satisfies OutputAppendMsg);
        return;
      case "statusbar/update":
        for (const cb of this.statusBarListeners) cb(msg);
        return;
      case "message/show":
        void this.handleMessageShow(worker, msg);
        return;
      case "env/openExternal":
        void this.handleOpenExternal(worker, msg);
        return;
      case "editor/applyEdit":
        void this.handleApplyEdit(worker, msg);
        return;
      case "command/execute":
        void this.handleCommandExecute(worker, msg);
        return;
      case "configuration/read":
        void this.handleConfigRead(worker, msg);
        return;
      case "configuration/write":
        void this.handleConfigWrite(worker, msg);
        return;
    }
  }

  private post(message: MainToHostMessage): void {
    if (!this.worker || !this.workerReady) {
      this.queuedOutbound.push(message);
      void this.start();
      return;
    }
    this.worker.postMessage(message);
  }

  private async request<T>(message: Record<string, unknown> & { type: string }): Promise<T> {
    if (!this.worker) await this.start();
    if (!this.worker) throw new Error("Extension host is not running");
    const requestId = this.nextRequestId++;
    return await new Promise<T>((resolve, reject) => {
      this.pendingRequests.set(requestId, { resolve: resolve as (v: unknown) => void, reject });
      this.worker!.postMessage({ ...message, requestId });
    });
  }

  private async handleFileRead(worker: Worker, id: number, path: string): Promise<void> {
    try {
      const normalizedPath = normalizePath(path);
      const text = await readFileText(this.bridge, normalizedPath);
      worker.postMessage({ type: "readFileResult", id, data: text } satisfies MainToHostMessage);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("Not a file:") || message.includes("ENOENT")) {
        worker.postMessage({ type: "readFileResult", id, data: null } satisfies MainToHostMessage);
        return;
      }
      worker.postMessage({ type: "readFileResult", id, data: null, error: "read failed" } satisfies MainToHostMessage);
    }
  }

  private async handleBinaryRead(worker: Worker, id: number, path: string): Promise<void> {
    try {
      const normalizedPath = normalizePath(path);
      const bytes = await this.bridge.fs.readFile(normalizedPath);
      worker.postMessage({ type: "readBinaryFileResult", id, bytes } satisfies MainToHostMessage, [bytes]);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      worker.postMessage({ type: "readBinaryFileResult", id, error: message } satisfies MainToHostMessage);
    }
  }

  private async handleMessageShow(worker: Worker, msg: MessageShowMsg): Promise<void> {
    try {
      const result = this.messageShowListener ? await this.messageShowListener(msg) : undefined;
      worker.postMessage({ type: "requestResponse", requestId: msg.requestId, result: result ?? null } satisfies MainToHostMessage);
    } catch (err) {
      worker.postMessage({ type: "requestResponse", requestId: msg.requestId, error: err instanceof Error ? err.message : String(err) } satisfies MainToHostMessage);
    }
  }

  private async handleOpenExternal(worker: Worker, msg: EnvOpenExternalMsg): Promise<void> {
    try {
      const ok = this.openExternalListener ? await this.openExternalListener(msg.uri) : await this.openExternalFallback(msg.uri);
      worker.postMessage({ type: "requestResponse", requestId: msg.requestId, result: ok } satisfies MainToHostMessage);
    } catch (err) {
      worker.postMessage({ type: "requestResponse", requestId: msg.requestId, error: err instanceof Error ? err.message : String(err) } satisfies MainToHostMessage);
    }
  }

  private async openExternalFallback(uri: string): Promise<boolean> {
    try {
      await this.bridge.utils.openExternal?.(uri);
      return true;
    } catch {
      return false;
    }
  }

  private async handleApplyEdit(worker: Worker, msg: EditorApplyEditMsg): Promise<void> {
    try {
      const ok = this.applyEditListener ? await this.applyEditListener(msg.edit) : false;
      worker.postMessage({ type: "requestResponse", requestId: msg.requestId, result: ok } satisfies MainToHostMessage);
    } catch (err) {
      worker.postMessage({ type: "requestResponse", requestId: msg.requestId, error: err instanceof Error ? err.message : String(err) } satisfies MainToHostMessage);
    }
  }

  private async handleCommandExecute(worker: Worker, msg: CommandExecuteMsg): Promise<void> {
    try {
      const result = this.commandRequestListener ? await this.commandRequestListener(msg.command, msg.args) : undefined;
      worker.postMessage({ type: "requestResponse", requestId: msg.requestId, result: result ?? null } satisfies MainToHostMessage);
    } catch (err) {
      worker.postMessage({ type: "requestResponse", requestId: msg.requestId, error: err instanceof Error ? err.message : String(err) } satisfies MainToHostMessage);
    }
  }

  private async handleConfigRead(worker: Worker, msg: ConfigurationReadMsg): Promise<void> {
    try {
      const result = this.configReadListener ? this.configReadListener(msg.key, msg.section) : undefined;
      worker.postMessage({ type: "requestResponse", requestId: msg.requestId, result: result ?? null } satisfies MainToHostMessage);
    } catch (err) {
      worker.postMessage({ type: "requestResponse", requestId: msg.requestId, error: err instanceof Error ? err.message : String(err) } satisfies MainToHostMessage);
    }
  }

  private async handleConfigWrite(worker: Worker, msg: ConfigurationWriteMsg): Promise<void> {
    try {
      if (this.configWriteListener) {
        await this.configWriteListener({ section: msg.section, key: msg.key, value: msg.value, target: msg.target });
      }
      worker.postMessage({ type: "requestResponse", requestId: msg.requestId, result: null } satisfies MainToHostMessage);
    } catch (err) {
      worker.postMessage({ type: "requestResponse", requestId: msg.requestId, error: err instanceof Error ? err.message : String(err) } satisfies MainToHostMessage);
    }
  }
}

const ExtensionHostClientContext = createContext<ExtensionHostClient | null>(null);

export function ExtensionHostClientProvider({ children }: { children: ReactNode }) {
  const bridge = useBridge();
  const [dataDir, setDataDir] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const dirs = await readAppDirs(bridge);
      if (!cancelled) setDataDir(dirs.dataDir);
    })();
    return () => {
      cancelled = true;
    };
  }, [bridge]);

  const client = useMemo(() => {
    if (!dataDir) return null;
    return new ExtensionHostClient(bridge, dataDir);
  }, [bridge, dataDir]);

  useEffect(() => {
    if (!client || !dataDir) return;
    const store = new ExtensionSettingsStore(bridge, dataDir);
    let cancelled = false;

    // Register listeners SYNCHRONOUSLY so that any `workspace.getConfiguration`
    // read from an extension's `activate()` immediately finds a handler. The
    // store starts with an empty map and is populated once `load()` resolves;
    // extensions activated before then just see defaults (from manifest
    // contributions), which is the correct behavior.
    client.setConfigReadListener((key, section) => {
      const fullKey = section ? `${section}.${key}` : key;
      return store.get(fullKey);
    });
    client.setConfigWriteListener(async ({ section, key, value, target }) => {
      await store.write({ section, key, value, target });
      client.configurationUpdate(section ? `${section}.${key}` : key, value);
    });

    void (async () => {
      const snapshot = await store.load();
      if (cancelled) return;
      for (const [fullKey, value] of Object.entries(snapshot)) {
        client.configurationUpdate(fullKey, value);
      }
    })();

    return () => {
      cancelled = true;
      client.setConfigReadListener(null);
      client.setConfigWriteListener(null);
    };
  }, [client, bridge, dataDir]);

  useEffect(() => {
    if (!client) return;
    // Default output → debugLog so extension chatter shows up in the console.
    const unsubOutput = client.onOutput(({ channel, text, newline }) => {
      const line = `[${channel}] ${text}${newline ? "" : ""}`;
      void bridge.utils.debugLog?.(line);
    });
    const unsubStatus = client.onStatusBar((msg) => {
      if (msg.text) {
        void bridge.utils.debugLog?.(`[statusbar ${msg.id}] ${msg.text}`);
      }
    });
    client.setMessageShowListener(async (msg) => {
      const level = msg.level === "error" ? "error" : msg.level === "warn" ? "warn" : "log";
      console[level](`[ExtensionHost] ${msg.message}`);
      void bridge.utils.debugLog?.(`[ExtensionHost ${msg.level}] ${msg.message}`);
      return undefined;
    });
    client.setCommandRequestListener(async (command, args) => {
      return handleWorkerCommand(bridge, command, args);
    });
    return () => {
      unsubOutput();
      unsubStatus();
      client.setMessageShowListener(null);
      client.setCommandRequestListener(null);
    };
  }, [client, bridge]);

  useEffect(() => {
    if (!client) return;
    return () => {
      client.dispose();
    };
  }, [client]);

  if (!client) return null;

  return createElement(ExtensionHostClientContext.Provider, { value: client }, children);
}

export function useExtensionHostClient(): ExtensionHostClient {
  const value = useContext(ExtensionHostClientContext);
  if (!value) throw new Error("useExtensionHostClient must be used within ExtensionHostClientProvider");
  return value;
}
