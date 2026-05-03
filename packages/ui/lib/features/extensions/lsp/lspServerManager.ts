/**
 * LSP Server Manager
 *
 * Manages the lifecycle of LSP server workers — one per (languageId,
 * workspaceRoot) pair. Spawns servers when a workspace is detected
 * with language configs, feeds document events to the correct server,
 * and collects diagnostics for Monaco.
 *
 * Each LSP server runs in a dedicated Web Worker that communicates
 * with the main thread via postMessage. The worker handles the full
 * LSP handshake (initialize → initialized) and translates between
 * the LSP wire protocol and our internal message types.
 */

import type { DotDirSettings } from "@/features/settings/types";
import { isWorkspace, configuredLanguages, resolveLanguageConfig } from "../workspaceConfig";
import type {
  LspServerConfig,
  LspServerHandle,
  LspToMainMessage,
  LspDiagnosticPayload,
  LspCompletionList,
  LspHoverResult,
  LspLocation,
  LspTextEdit,
  LspDocumentSymbol,
  LspFoldingRange,
  LspSignatureHelp,
  LspWorkspaceEdit,
} from "./types";
import type { ExtensionManifest, ExtensionRef } from "../types";

export type DiagnosticsCallback = (
  owner: string,
  uri: string,
  diagnostics: LspDiagnosticPayload[],
) => void;

export interface LspManagerOptions {
  onDiagnostics: DiagnosticsCallback;
  /** Resolved from loaded extensions: languageId → default serverPath */
  extensionServerPaths: Map<string, string>;
}

export class LspServerManager {
  private servers = new Map<string, LspServerHandle>();
  private workspaceConfigs = new Map<string, DotDirSettings | null>();
  private serverModules = new Map<string, () => Worker>();
  private options: LspManagerOptions;
  private disposed = false;

  constructor(options: LspManagerOptions) {
    this.options = options;
  }

  // ── Registration ───────────────────────────────────────────────────

  /** Register a worker module factory for a given serverPath to enable Vite bundling. */
  registerServerModule(serverPath: string, factory: () => Worker): void {
    this.serverModules.set(serverPath, factory);
  }

  /** Called after extensions load: derive LSP server paths from extension manifests. */
  syncExtensionServers(_extensions: Array<{ ref: ExtensionRef; manifest: ExtensionManifest; dirPath: string }>): void {
    // TBD: extensions declare language server contributions in manifest.
    // For now we rely on workspace config's serverPath entries.
  }

  // ── Workspace config ───────────────────────────────────────────────

  /**
   * Update the workspace config for a root. Triggers server
   * creation/destruction as needed.
   */
  setWorkspaceConfig(root: string, config: DotDirSettings | null): void {
    this.workspaceConfigs.set(root, config);

    if (!isWorkspace(config)) {
      this.shutdownWorkspace(root);
      return;
    }

    const languageIds = configuredLanguages(config);
    for (const langId of languageIds) {
      const langConfig = resolveLanguageConfig(config, langId);
      if (!langConfig) continue;
      const serverPath = this.resolveServerPath(config, langId, langConfig);
      if (!serverPath) continue;

      const serverId = this.serverId(langId, root);
      this.ensureServer({
        id: serverId,
        languageId: langId,
        workspaceRoot: root,
        serverPath,
        serverArgs: langConfig.serverArgs,
        initializationOptions: langConfig.initializationOptions,
        settings: langConfig.settings,
      });
    }
  }

  /** Remove workspace config. Shuts down any servers for that root. */
  removeWorkspace(root: string): void {
    this.workspaceConfigs.delete(root);
    this.shutdownWorkspace(root);
  }

  // ── Document events ────────────────────────────────────────────────

  documentOpen(uri: string, languageId: string, version: number, text: string): void {
    for (const [, server] of this.servers) {
      if (server.config.languageId === languageId && this.uriInWorkspace(uri, server.config.workspaceRoot)) {
        this.send(server, { type: "document/open", uri, languageId, version, text });
        return;
      }
    }
  }

  documentChange(uri: string, version: number, text: string): void {
    for (const [, server] of this.servers) {
      if (uri.startsWith(server.config.workspaceRoot) || uri.startsWith("file://" + server.config.workspaceRoot)) {
        this.send(server, { type: "document/change", uri, version, text });
        return;
      }
    }
  }

  documentClose(uri: string): void {
    for (const [, server] of this.servers) {
      if (uri.startsWith(server.config.workspaceRoot) || uri.startsWith("file://" + server.config.workspaceRoot)) {
        this.send(server, { type: "document/close", uri });
        return;
      }
    }
  }

  documentSave(uri: string): void {
    for (const [, server] of this.servers) {
      if (uri.startsWith(server.config.workspaceRoot) || uri.startsWith("file://" + server.config.workspaceRoot)) {
        this.send(server, { type: "document/save", uri });
        return;
      }
    }
  }

  configurationUpdate(settings: Record<string, unknown>): void {
    for (const [, server] of this.servers) {
      if (server.state === "running") {
        this.send(server, { type: "configuration/update", settings });
      }
    }
  }

  // ── Lifecycle ──────────────────────────────────────────────────────

  shutdown(): void {
    this.disposed = true;
    for (const [, server] of this.servers) {
      this.stopServer(server);
    }
    this.servers.clear();
    this.workspaceConfigs.clear();
  }

  // ── Internals ──────────────────────────────────────────────────────

  private serverId(languageId: string, workspaceRoot: string): string {
    return `${languageId}::${workspaceRoot}`;
  }

  private uriInWorkspace(uri: string, workspaceRoot: string): boolean {
    const filePath = uri.startsWith("file://") ? decodeURIComponent(uri.slice(7)) : uri;
    const normalizedRoot = workspaceRoot.replace(/\/$/, "");
    return filePath.startsWith(normalizedRoot + "/") || filePath === normalizedRoot;
  }

  private resolveServerPath(
    _config: DotDirSettings | null,
    languageId: string,
    langConfig: { serverPath?: string },
  ): string | null {
    if (langConfig.serverPath) return langConfig.serverPath;
    return this.options.extensionServerPaths.get(languageId) ?? null;
  }

  private ensureServer(config: LspServerConfig): void {
    if (this.servers.has(config.id)) return;
    if (this.disposed) return;

    const handle: LspServerHandle = {
      config,
      state: "initializing",
      worker: null,
      capabilities: null,
    };
    this.servers.set(config.id, handle);

    this.spawnServer(handle);
  }

  private spawnServer(handle: LspServerHandle): void {
    const factory = this.serverModules.get(handle.config.serverPath);
    if (!factory) {
      console.warn(
        `[LspServerManager] No worker module registered for serverPath: ${handle.config.serverPath}`,
      );
      handle.state = "exited";
      return;
    }

    try {
      const worker = factory();
      handle.worker = worker;
      handle.state = "initializing";

      worker.onmessage = (e: MessageEvent<LspToMainMessage>) => {
        this.handleMessage(handle, e.data);
      };
      worker.onerror = (e: ErrorEvent) => {
        console.error(`[LspServerManager] Worker error for ${handle.config.id}:`, e);
        handle.state = "crashed";
      };

      worker.postMessage({
        type: "init",
        config: handle.config,
      });
    } catch (err) {
      console.error(
        `[LspServerManager] Failed to spawn LSP worker for ${handle.config.id}:`,
        err,
      );
      handle.state = "crashed";
    }
  }

  private stopServer(handle: LspServerHandle): void {
    if (handle.state === "running" || handle.state === "initializing") {
      handle.state = "shutting-down";
      this.send(handle, { type: "shutdown" });
    }
    if (handle.worker) {
      handle.worker.terminate();
      handle.worker = null;
    }
    handle.state = "exited";
    handle.capabilities = null;
  }

  private shutdownWorkspace(root: string): void {
    for (const [id, server] of this.servers) {
      if (server.config.workspaceRoot === root) {
        this.stopServer(server);
        this.servers.delete(id);
      }
    }
  }

  private send(handle: LspServerHandle, msg: Record<string, unknown>): void {
    if (handle.worker && (handle.state === "running" || handle.state === "initializing")) {
      handle.worker.postMessage(msg);
    }
  }

  // ── Status query ───────────────────────────────────────────────────

  /** Return status info for all running LSP servers, grouped by language. */
  getServerStates(): Array<{ languageId: string; state: string; workspaceRoot: string }> {
    const result: Array<{ languageId: string; state: string; workspaceRoot: string }> = [];
    for (const [, server] of this.servers) {
      result.push({
        languageId: server.config.languageId,
        state: server.state,
        workspaceRoot: server.config.workspaceRoot,
      });
    }
    return result;
  }

  // ── Provider request methods ────────────────────────────────────────

  private nextLspRequestId = 1;
  private pendingLspResponses = new Map<number, { resolve: (value: unknown) => void; reject: (err: Error) => void }>();

  private requestProvider(
    serverId: string,
    msg: Record<string, unknown>,
  ): Promise<unknown> {
    const handle = this.servers.get(serverId);
    if (!handle || handle.state !== "running") {
      return Promise.resolve(null);
    }
    const requestId = this.nextLspRequestId++;
    return new Promise((resolve, reject) => {
      this.pendingLspResponses.set(requestId, { resolve, reject });
      handle.worker!.postMessage({ ...msg, requestId });
      setTimeout(() => {
        if (this.pendingLspResponses.has(requestId)) {
          this.pendingLspResponses.delete(requestId);
          reject(new Error(`LSP request timed out for ${serverId}`));
        }
      }, 30000);
    });
  }

  private serverIdForUri(uri: string, languageId: string): string | null {
    for (const [id, server] of this.servers) {
      if (server.config.languageId === languageId && this.uriInWorkspace(uri, server.config.workspaceRoot)) {
        return id;
      }
    }
    return null;
  }

  async provideCompletionItems(
    uri: string,
    languageId: string,
    position: { line: number; character: number },
    triggerKind?: number,
    triggerCharacter?: string,
  ): Promise<LspCompletionList | null> {
    const sid = this.serverIdForUri(uri, languageId);
    if (!sid) return null;
    const result = await this.requestProvider(sid, {
      type: "request/completion",
      uri,
      position,
      triggerKind,
      triggerCharacter,
    });
    return result as LspCompletionList | null;
  }

  async provideHover(
    uri: string,
    languageId: string,
    position: { line: number; character: number },
  ): Promise<LspHoverResult | null> {
    const sid = this.serverIdForUri(uri, languageId);
    if (!sid) return null;
    return (await this.requestProvider(sid, {
      type: "request/hover",
      uri,
      position,
    })) as LspHoverResult | null;
  }

  async provideDefinition(
    uri: string,
    languageId: string,
    position: { line: number; character: number },
  ): Promise<LspLocation[] | null> {
    const sid = this.serverIdForUri(uri, languageId);
    if (!sid) return null;
    const result = await this.requestProvider(sid, {
      type: "request/definition",
      uri,
      position,
    });
    return result as LspLocation[] | null;
  }

  async provideReferences(
    uri: string,
    languageId: string,
    position: { line: number; character: number },
    includeDeclaration?: boolean,
  ): Promise<LspLocation[] | null> {
    const sid = this.serverIdForUri(uri, languageId);
    if (!sid) return null;
    const result = await this.requestProvider(sid, {
      type: "request/references",
      uri,
      position,
      includeDeclaration,
    });
    return result as LspLocation[] | null;
  }

  async provideDocumentSymbols(
    uri: string,
    languageId: string,
  ): Promise<LspDocumentSymbol[] | null> {
    const sid = this.serverIdForUri(uri, languageId);
    if (!sid) return null;
    const result = await this.requestProvider(sid, {
      type: "request/documentSymbol",
      uri,
    });
    return result as LspDocumentSymbol[] | null;
  }

  async provideDocumentFormattingEdits(
    uri: string,
    languageId: string,
    tabSize: number,
    insertSpaces: boolean,
  ): Promise<LspTextEdit[] | null> {
    const sid = this.serverIdForUri(uri, languageId);
    if (!sid) return null;
    const result = await this.requestProvider(sid, {
      type: "request/formatting",
      uri,
      tabSize,
      insertSpaces,
    });
    return result as LspTextEdit[] | null;
  }

  async provideDocumentRangeFormattingEdits(
    uri: string,
    languageId: string,
    range: { start: { line: number; character: number }; end: { line: number; character: number } },
    tabSize: number,
    insertSpaces: boolean,
  ): Promise<LspTextEdit[] | null> {
    const sid = this.serverIdForUri(uri, languageId);
    if (!sid) return null;
    const result = await this.requestProvider(sid, {
      type: "request/rangeFormatting",
      uri,
      range,
      tabSize,
      insertSpaces,
    });
    return result as LspTextEdit[] | null;
  }

  async provideRenameEdits(
    uri: string,
    languageId: string,
    position: { line: number; character: number },
    newName: string,
  ): Promise<LspWorkspaceEdit | null> {
    const sid = this.serverIdForUri(uri, languageId);
    if (!sid) return null;
    const result = await this.requestProvider(sid, {
      type: "request/rename",
      uri,
      position,
      newName,
    });
    return result as LspWorkspaceEdit | null;
  }

  async provideFoldingRanges(
    uri: string,
    languageId: string,
  ): Promise<LspFoldingRange[] | null> {
    const sid = this.serverIdForUri(uri, languageId);
    if (!sid) return null;
    const result = await this.requestProvider(sid, {
      type: "request/foldingRange",
      uri,
    });
    return result as LspFoldingRange[] | null;
  }

  async provideSignatureHelp(
    uri: string,
    languageId: string,
    position: { line: number; character: number },
  ): Promise<LspSignatureHelp | null> {
    const sid = this.serverIdForUri(uri, languageId);
    if (!sid) return null;
    const result = await this.requestProvider(sid, {
      type: "request/signatureHelp",
      uri,
      position,
    });
    return result as LspSignatureHelp | null;
  }

  private handleMessage(handle: LspServerHandle, msg: LspToMainMessage): void {
    switch (msg.type) {
      case "ready": {
        handle.state = "running";
        handle.capabilities = msg.capabilities;
        console.log(`[LspServerManager] Server ready: ${handle.config.id}`);
        break;
      }
      case "diagnostics": {
        this.options.onDiagnostics(
          handle.config.languageId,
          msg.uri,
          msg.diagnostics,
        );
        break;
      }
      case "log": {
        const prefix = `[LSP:${handle.config.languageId}]`;
        if (msg.level === "error") console.error(prefix, msg.message);
        else if (msg.level === "warn") console.warn(prefix, msg.message);
        else console.log(prefix, msg.message);
        break;
      }
      case "error": {
        console.error(`[LSP:${handle.config.languageId}] ${msg.message}`);
        break;
      }
      case "request/response": {
        const pending = this.pendingLspResponses.get(msg.requestId);
        if (pending) {
          this.pendingLspResponses.delete(msg.requestId);
          if (msg.error) pending.reject(new Error(msg.error));
          else pending.resolve(msg.result ?? null);
        }
        break;
      }
    }
  }
}
