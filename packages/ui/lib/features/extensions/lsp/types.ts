/**
 * LSP subsystem types.
 *
 * Defines the shape of LSP server configurations, server-side message
 * types for communication with the dedicated LSP worker thread, and
 * the management types used by LspServerManager.
 */

// ── LSP request types (main -> worker) ──────────────────────────────

export interface LspCompletionRequest {
  type: "request/completion";
  requestId: number;
  uri: string;
  position: { line: number; character: number };
  triggerKind?: number;
  triggerCharacter?: string;
}

export interface LspHoverRequest {
  type: "request/hover";
  requestId: number;
  uri: string;
  position: { line: number; character: number };
}

export interface LspDefinitionRequest {
  type: "request/definition";
  requestId: number;
  uri: string;
  position: { line: number; character: number };
}

export interface LspReferencesRequest {
  type: "request/references";
  requestId: number;
  uri: string;
  position: { line: number; character: number };
  includeDeclaration?: boolean;
}

export interface LspDocumentSymbolRequest {
  type: "request/documentSymbol";
  requestId: number;
  uri: string;
}

export interface LspFormattingRequest {
  type: "request/formatting";
  requestId: number;
  uri: string;
  tabSize: number;
  insertSpaces: boolean;
}

export interface LspRangeFormattingRequest {
  type: "request/rangeFormatting";
  requestId: number;
  uri: string;
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
  tabSize: number;
  insertSpaces: boolean;
}

export interface LspRenameRequest {
  type: "request/rename";
  requestId: number;
  uri: string;
  position: { line: number; character: number };
  newName: string;
}

export interface LspFoldingRangeRequest {
  type: "request/foldingRange";
  requestId: number;
  uri: string;
}

export interface LspSignatureHelpRequest {
  type: "request/signatureHelp";
  requestId: number;
  uri: string;
  position: { line: number; character: number };
}

export type LspRequest =
  | LspCompletionRequest
  | LspHoverRequest
  | LspDefinitionRequest
  | LspReferencesRequest
  | LspDocumentSymbolRequest
  | LspFormattingRequest
  | LspRangeFormattingRequest
  | LspRenameRequest
  | LspFoldingRangeRequest
  | LspSignatureHelpRequest;

// ── LSP response types (worker -> main) ──────────────────────────────

export interface LspCompletionItem {
  label: string;
  kind?: number;
  detail?: string;
  documentation?: string;
  insertText?: string;
  insertTextFormat?: number;
  sortText?: string;
  filterText?: string;
  textEdit?: { range: LspRange; newText: string };
  additionalTextEdits?: Array<{ range: LspRange; newText: string }>;
  commitCharacters?: string[];
  data?: unknown;
}

export interface LspCompletionList {
  isIncomplete: boolean;
  items: LspCompletionItem[];
}

export interface LspHoverResult {
  contents: Array<string | { language?: string; value: string }>;
  range?: LspRange;
}

export interface LspLocation {
  uri: string;
  range: LspRange;
}

export interface LspRange {
  start: { line: number; character: number };
  end: { line: number; character: number };
}

export interface LspTextEdit {
  range: LspRange;
  newText: string;
}

export interface LspDocumentSymbol {
  name: string;
  detail?: string;
  kind: number;
  range: LspRange;
  selectionRange: LspRange;
  children?: LspDocumentSymbol[];
}

export interface LspFoldingRange {
  start: number;
  end: number;
  kind?: string;
}

export interface LspSignatureHelp {
  signatures: Array<{
    label: string;
    documentation?: string;
    parameters?: Array<{ label: string | [number, number]; documentation?: string }>;
  }>;
  activeSignature?: number;
  activeParameter?: number;
}

export interface LspWorkspaceEdit {
  changes?: Record<string, LspTextEdit[]>;
}

/**
 * Generic request response wrapper.
 * The worker responds with `{ type: "request/response", requestId, result? }`
 * where result is one of the types above.
 */
export interface LspRequestResponse {
  type: "request/response";
  requestId: number;
  result?: unknown;
  error?: string;
}

// ── Configuration ───────────────────────────────────────────────────

export interface LspServerConfig {
  /** Stable identifier: `${languageId}` (e.g. "yaml", "typescript"). */
  id: string;
  /** VS Code language ID the server handles. */
  languageId: string;
  /** Workspace root path (absolute). */
  workspaceRoot: string;
  /** Path to the server's JS bundle or executable. */
  serverPath: string;
  /** Arguments for the server process. */
  serverArgs?: string[];
  /** LSP initialization options. */
  initializationOptions?: Record<string, unknown>;
  /** Settings forwarded as workspace/configuration. */
  settings?: Record<string, unknown>;
}

// ── Main ↔ Worker messages ──────────────────────────────────────────

/** Messages sent from the main thread to the LSP server worker. */
export type MainToLspMessage =
  | LspInitMsg
  | LspDocumentOpenMsg
  | LspDocumentChangeMsg
  | LspDocumentCloseMsg
  | LspDocumentSaveMsg
  | LspConfigurationUpdateMsg
  | LspShutdownMsg
  | LspRequest;

export interface LspInitMsg {
  type: "init";
  config: LspServerConfig;
}

export interface LspDocumentOpenMsg {
  type: "document/open";
  uri: string;
  languageId: string;
  version: number;
  text: string;
}

export interface LspDocumentChangeMsg {
  type: "document/change";
  uri: string;
  version: number;
  text: string;
}

export interface LspDocumentCloseMsg {
  type: "document/close";
  uri: string;
}

export interface LspDocumentSaveMsg {
  type: "document/save";
  uri: string;
}

export interface LspConfigurationUpdateMsg {
  type: "configuration/update";
  settings: Record<string, unknown>;
}

export interface LspShutdownMsg {
  type: "shutdown";
}

/** Messages sent from the LSP server worker to the main thread. */
export type LspToMainMessage =
  | LspReadyMsg
  | LspDiagnosticsMsg
  | LspLogMsg
  | LspErrorMessage
  | LspRequestResponse;

export interface LspReadyMsg {
  type: "ready";
  /** Language providers the server supports. */
  capabilities: LspServerCapabilities;
}

export interface LspServerCapabilities {
  completion?: boolean;
  hover?: boolean;
  definition?: boolean;
  references?: boolean;
  documentSymbol?: boolean;
  documentFormatting?: boolean;
  documentRangeFormatting?: boolean;
  rename?: boolean;
  foldingRange?: boolean;
  codeAction?: boolean;
  codeLens?: boolean;
  documentLink?: boolean;
  signatureHelp?: boolean;
  semanticTokens?: boolean;
}

export interface LspDiagnosticsMsg {
  type: "diagnostics";
  uri: string;
  diagnostics: LspDiagnosticPayload[];
}

export interface LspDiagnosticPayload {
  range: LspRange;
  severity?: number;
  code?: string | number;
  source?: string;
  message: string;
}

export interface LspLogMsg {
  type: "log";
  level: "info" | "warn" | "error";
  message: string;
}

export interface LspErrorMessage {
  type: "error";
  message: string;
}

/** Server lifecycle states. */
export type LspServerState =
  | "initializing"
  | "running"
  | "shutting-down"
  | "exited"
  | "crashed";

/** Runtime representation of an LSP server. */
export interface LspServerHandle {
  config: LspServerConfig;
  state: LspServerState;
  worker: Worker | null;
  capabilities: LspServerCapabilities | null;
}
