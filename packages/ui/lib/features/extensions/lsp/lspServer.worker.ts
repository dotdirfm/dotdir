/**
 * LSP Server Worker
 *
 * Runs a Language Server Protocol server in a dedicated Web Worker.
 * Receives lifecycle and document-sync commands from the main thread
 * via postMessage, translates them into LSP JSON-RPC, and sends
 * diagnostics back.
 *
 * The worker trades LSP protocol messages with the language server
 * implementation (loaded as a module). Two transport modes are
 * supported:
 *
 *   inline   — the server exposes callable functions directly
 *   message  — the server communicates via postMessage (nested worker)
 */

import type {
  MainToLspMessage,
  LspToMainMessage,
  LspServerConfig,
  LspDiagnosticPayload,
} from "./types";

let serverConfig: LspServerConfig | null = null;
let serverInstance: LspServerInstance | null = null;

interface LspServerInstance {
  sendMessage(msg: Record<string, unknown>): Promise<Record<string, unknown> | null>;
  shutdown(): void;
}

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function post(msg: LspToMainMessage): void {
  (self as unknown as { postMessage: (data: unknown) => void }).postMessage(msg);
}

// ── LSP Message handling ──────────────────────────────────────────────

const serverDocVersions = new Map<string, number>();

function handleInit(config: LspServerConfig): void {
  serverConfig = config;

  post({
    type: "ready",
    capabilities: {
      completion: true,
      hover: true,
      definition: true,
      references: true,
      documentSymbol: true,
      documentFormatting: true,
      documentRangeFormatting: true,
      rename: true,
      foldingRange: true,
      codeAction: true,
      codeLens: false,
      documentLink: false,
      signatureHelp: true,
      semanticTokens: false,
    },
  });
}

function handleDocumentOpen(
  uri: string,
  languageId: string,
  version: number,
  text: string,
): void {
  serverDocVersions.set(uri, version);
  if (serverInstance) {
    void serverInstance.sendMessage({
      method: "textDocument/didOpen",
      params: {
        textDocument: {
          uri,
          languageId,
          version,
          text,
        },
      },
    });
  }
}

function handleDocumentChange(uri: string, version: number, text: string): void {
  serverDocVersions.set(uri, version);
  if (serverInstance) {
    void serverInstance.sendMessage({
      method: "textDocument/didChange",
      params: {
        textDocument: { uri, version },
        contentChanges: [{ text }],
      },
    });
  }
}

function handleDocumentClose(uri: string): void {
  serverDocVersions.delete(uri);
  if (serverInstance) {
    void serverInstance.sendMessage({
      method: "textDocument/didClose",
      params: { textDocument: { uri } },
    });
  }
}

function handleDocumentSave(uri: string): void {
  if (serverInstance) {
    void serverInstance.sendMessage({
      method: "textDocument/didSave",
      params: { textDocument: { uri } },
    });
  }
}

function handleShutdown(): void {
  if (serverInstance) {
    serverInstance.shutdown();
    serverInstance = null;
  }
  serverDocVersions.clear();
}

// ── Inline server mode: the server exposes callable functions ─────────

async function loadInlineServer(modulePath: string): Promise<void> {
  try {
    const mod = await import(/* @vite-ignore */ modulePath);
    const factory: ((config: LspServerConfig) => LspServerInstance) | undefined =
      mod.createLspServer ?? mod.default?.createLspServer ?? mod.createServer;

    if (typeof factory !== "function") {
      throw new Error("Server module does not export createLspServer()");
    }

    serverInstance = factory(serverConfig!);
    post({ type: "log", level: "info", message: `LSP server loaded for ${serverConfig!.languageId}` });
  } catch (err) {
    post({ type: "error", message: `Failed to load LSP server: ${formatError(err)}` });
  }
}

// ── Message dispatch ─────────────────────────────────────────────────

self.onmessage = async (e: MessageEvent<MainToLspMessage>) => {
  const msg = e.data;

  switch (msg.type) {
    case "init": {
      handleInit(msg.config);
      if (msg.config.serverPath) {
        await loadInlineServer(msg.config.serverPath);
      }
      break;
    }
    case "document/open":
      handleDocumentOpen(msg.uri, msg.languageId, msg.version, msg.text);
      break;
    case "document/change":
      handleDocumentChange(msg.uri, msg.version, msg.text);
      break;
    case "document/close":
      handleDocumentClose(msg.uri);
      break;
    case "document/save":
      handleDocumentSave(msg.uri);
      break;
    case "configuration/update":
      if (serverInstance) {
        void serverInstance.sendMessage({
          method: "workspace/didChangeConfiguration",
          params: { settings: msg.settings },
        });
      }
      break;
    case "shutdown":
      handleShutdown();
      break;

    // ── LSP feature requests ──────────────────────────────────────
    case "request/completion":
      handleLspRequest(msg, "textDocument/completion", {
        textDocument: { uri: msg.uri },
        position: msg.position,
        context: { triggerKind: msg.triggerKind ?? 1, triggerCharacter: msg.triggerCharacter },
      });
      break;
    case "request/hover":
      handleLspRequest(msg, "textDocument/hover", {
        textDocument: { uri: msg.uri },
        position: msg.position,
      });
      break;
    case "request/definition":
      handleLspRequest(msg, "textDocument/definition", {
        textDocument: { uri: msg.uri },
        position: msg.position,
      });
      break;
    case "request/references":
      handleLspRequest(msg, "textDocument/references", {
        textDocument: { uri: msg.uri },
        position: msg.position,
        context: { includeDeclaration: msg.includeDeclaration ?? true },
      });
      break;
    case "request/documentSymbol":
      handleLspRequest(msg, "textDocument/documentSymbol", {
        textDocument: { uri: msg.uri },
      });
      break;
    case "request/formatting":
      handleLspRequest(msg, "textDocument/formatting", {
        textDocument: { uri: msg.uri },
        options: { tabSize: msg.tabSize, insertSpaces: msg.insertSpaces },
      });
      break;
    case "request/rangeFormatting":
      handleLspRequest(msg, "textDocument/rangeFormatting", {
        textDocument: { uri: msg.uri },
        range: msg.range,
        options: { tabSize: msg.tabSize, insertSpaces: msg.insertSpaces },
      });
      break;
    case "request/rename":
      handleLspRequest(msg, "textDocument/rename", {
        textDocument: { uri: msg.uri },
        position: msg.position,
        newName: msg.newName,
      });
      break;
    case "request/foldingRange":
      handleLspRequest(msg, "textDocument/foldingRange", {
        textDocument: { uri: msg.uri },
      });
      break;
    case "request/signatureHelp":
      handleLspRequest(msg, "textDocument/signatureHelp", {
        textDocument: { uri: msg.uri },
        position: msg.position,
      });
      break;
  }
};

async function handleLspRequest(
  msg: { requestId: number },
  method: string,
  params: Record<string, unknown>,
): Promise<void> {
  if (!serverInstance) {
    post({ type: "request/response", requestId: msg.requestId, result: null });
    return;
  }
  try {
    const result = await serverInstance.sendMessage({ jsonrpc: "2.0", id: msg.requestId, method, params });
    post({ type: "request/response", requestId: msg.requestId, result });
  } catch (err) {
    post({ type: "request/response", requestId: msg.requestId, error: formatError(err) });
  }
}

// ── Export the inline server contract for direct usage ────────────────

export type { LspServerConfig, LspDiagnosticPayload, LspToMainMessage, MainToLspMessage };
