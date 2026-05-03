/**
 * Extension Host RPC protocol
 *
 * Shared message definitions used by both the extension host Web Worker
 * (where extensions run) and the main thread (where Monaco lives).
 *
 * Naming:
 *   - "MainToHost" messages travel from the main thread into the worker
 *   - "HostToMain" messages travel from the worker to the main thread
 *
 * Request/response pairs use `requestId` so either side can await a reply.
 */

// ── Primitive LSP-shaped payloads (flat JSON — no class instances) ───

export interface PositionPayload {
  line: number;
  character: number;
}

export interface RangePayload {
  start: PositionPayload;
  end: PositionPayload;
}

export interface LocationPayload {
  uri: string;
  range: RangePayload;
}

export interface DiagnosticPayload {
  range: RangePayload;
  message: string;
  severity?: number;
  code?: string | number | { value: string | number; target: string };
  source?: string;
  tags?: number[];
  relatedInformation?: Array<{ location: LocationPayload; message: string }>;
}

export interface TextEditPayload {
  range: RangePayload;
  newText: string;
}

export interface CompletionItemPayload {
  label: string | { label: string; detail?: string; description?: string };
  kind?: number;
  tags?: number[];
  detail?: string;
  documentation?: string | { kind: "plaintext" | "markdown"; value: string };
  sortText?: string;
  filterText?: string;
  insertText?: string;
  insertTextFormat?: number;
  range?: RangePayload | { inserting: RangePayload; replacing: RangePayload };
  commitCharacters?: string[];
  preselect?: boolean;
  additionalTextEdits?: TextEditPayload[];
  command?: { command: string; title: string; arguments?: unknown[] };
  data?: unknown;
}

export interface CompletionListPayload {
  isIncomplete?: boolean;
  items: CompletionItemPayload[];
}

export interface HoverPayload {
  contents: Array<string | { kind: "plaintext" | "markdown"; value: string } | { language?: string; value: string }>;
  range?: RangePayload;
}

export interface DocumentSymbolPayload {
  name: string;
  detail?: string;
  kind: number;
  tags?: number[];
  range: RangePayload;
  selectionRange: RangePayload;
  children?: DocumentSymbolPayload[];
}

export interface SymbolInformationPayload {
  name: string;
  kind: number;
  tags?: number[];
  containerName?: string;
  location: LocationPayload;
}

export interface FoldingRangePayload {
  start: number;
  end: number;
  kind?: "comment" | "imports" | "region";
}

export interface CodeActionPayload {
  title: string;
  kind?: string;
  diagnostics?: DiagnosticPayload[];
  edit?: WorkspaceEditPayload;
  command?: { command: string; title: string; arguments?: unknown[] };
  isPreferred?: boolean;
  disabled?: { reason: string };
}

export interface CodeLensPayload {
  range: RangePayload;
  command?: { command: string; title: string; arguments?: unknown[] };
}

export interface DocumentLinkPayload {
  range: RangePayload;
  target?: string;
  tooltip?: string;
}

export interface SignatureHelpPayload {
  signatures: Array<{
    label: string;
    documentation?: string | { kind: "plaintext" | "markdown"; value: string };
    parameters?: Array<{
      label: string | [number, number];
      documentation?: string | { kind: "plaintext" | "markdown"; value: string };
    }>;
    activeParameter?: number;
  }>;
  activeSignature?: number;
  activeParameter?: number;
}

export interface SelectionRangePayload {
  range: RangePayload;
  parent?: SelectionRangePayload;
}

export interface DocumentHighlightPayload {
  range: RangePayload;
  kind?: number;
}

export interface WorkspaceEditPayload {
  changes?: Record<string, TextEditPayload[]>;
  documentChanges?: Array<{ uri: string; version?: number; edits: TextEditPayload[] }>;
}

export interface ColorInformationPayload {
  range: RangePayload;
  color: { red: number; green: number; blue: number; alpha: number };
}

export interface ColorPresentationPayload {
  label: string;
  textEdit?: TextEditPayload;
  additionalTextEdits?: TextEditPayload[];
}

export type ProviderKind =
  | "completion"
  | "hover"
  | "definition"
  | "typeDefinition"
  | "implementation"
  | "declaration"
  | "reference"
  | "documentHighlight"
  | "documentSymbol"
  | "workspaceSymbol"
  | "codeAction"
  | "codeLens"
  | "documentFormatting"
  | "documentRangeFormatting"
  | "onTypeFormatting"
  | "rename"
  | "linkedEditingRange"
  | "documentLink"
  | "color"
  | "folding"
  | "selectionRange"
  | "signatureHelp"
  | "documentSemanticTokens"
  | "documentRangeSemanticTokens"
  | "callHierarchy";

export interface DocumentSelectorFilter {
  language?: string;
  scheme?: string;
  pattern?: string;
}

export type DocumentSelectorPayload = string | DocumentSelectorFilter | Array<string | DocumentSelectorFilter>;

// ── Main → Host (worker) messages ───────────────────────────────────

export interface StartMsg {
  type: "start";
  dataDir: string;
}

export interface ReadFileResultMsg {
  type: "readFileResult";
  id: number;
  data: string | null;
  error?: string;
}

export interface ReadBinaryFileResultMsg {
  type: "readBinaryFileResult";
  id: number;
  bytes?: ArrayBuffer;
  error?: string;
}

export interface ActivateByEventMsg {
  type: "activateByEvent";
  requestId: number;
  event: string;
}

export interface ExecuteCommandMsg {
  type: "executeCommand";
  requestId: number;
  command: string;
  args: unknown[];
}

export interface DocumentOpenMsg {
  type: "document/open";
  uri: string;
  languageId: string;
  version: number;
  text: string;
}

export interface DocumentChangeMsg {
  type: "document/change";
  uri: string;
  version: number;
  text: string;
}

export interface DocumentCloseMsg {
  type: "document/close";
  uri: string;
}

export interface DocumentSaveMsg {
  type: "document/save";
  uri: string;
}

export interface WorkspaceFoldersMsg {
  type: "workspace/folders";
  folders: Array<{ uri: string; name: string }>;
}

export interface ConfigurationUpdateMsg {
  type: "configuration/update";
  section?: string;
  key: string;
  value: unknown;
}

export interface ConfigurationWorkspaceMsg {
  type: "configuration/workspace";
  /** Absolute path to the workspace root. */
  root: string;
  /** Merged workspace-level settings (from .dir/settings.json). */
  values: Record<string, unknown>;
}

export interface ActiveEditorMsg {
  type: "editor/active";
  uri: string | null;
}

export interface ProviderInvokeMsg {
  type: "provider/invoke";
  requestId: number;
  providerId: number;
  method: string;
  args: unknown;
}

export interface ProviderCancelMsg {
  type: "provider/cancel";
  requestId: number;
}

export interface RequestResponseMsg {
  type: "requestResponse";
  requestId: number;
  result?: unknown;
  error?: string;
}

export type MainToHostMessage =
  | StartMsg
  | ReadFileResultMsg
  | ReadBinaryFileResultMsg
  | ActivateByEventMsg
  | ExecuteCommandMsg
  | DocumentOpenMsg
  | DocumentChangeMsg
  | DocumentCloseMsg
  | DocumentSaveMsg
  | WorkspaceFoldersMsg
  | ConfigurationUpdateMsg
  | ConfigurationWorkspaceMsg
  | ActiveEditorMsg
  | ProviderInvokeMsg
  | ProviderCancelMsg
  | RequestResponseMsg;

// ── Host (worker) → Main messages ───────────────────────────────────

export interface ReadFileMsg {
  type: "readFile";
  id: number;
  path: string;
}

export interface ReadBinaryFileMsg {
  type: "readBinaryFile";
  id: number;
  path: string;
}

export interface LoadedMsg {
  type: "loaded";
  extensions: unknown[];
}

export interface ErrorMsg {
  type: "error";
  message: string;
}

export interface ActivationLogMsg {
  type: "activationLog";
  level: "info" | "warn" | "error";
  extension: string;
  event?: string;
  message: string;
}

export interface RequestResultMsg {
  type: "requestResult";
  requestId: number;
  result?: unknown;
  error?: string;
}

export interface ProviderRegisterMsg {
  type: "provider/register";
  providerId: number;
  kind: ProviderKind;
  selector: DocumentSelectorPayload;
  metadata?: Record<string, unknown>;
}

export interface ProviderUnregisterMsg {
  type: "provider/unregister";
  providerId: number;
}

export interface DiagnosticsSetMsg {
  type: "diagnostics/set";
  owner: string;
  uri: string;
  diagnostics: DiagnosticPayload[];
}

export interface DiagnosticsClearMsg {
  type: "diagnostics/clear";
  owner: string;
  uri?: string;
}

export interface OutputAppendMsg {
  type: "output/append";
  channel: string;
  text: string;
  newline: boolean;
}

export interface StatusBarUpdateMsg {
  type: "statusbar/update";
  id: string;
  text?: string;
  tooltip?: string;
  alignment?: "left" | "right";
  priority?: number;
  visible: boolean;
  command?: string;
  color?: string;
  backgroundColor?: string;
}

export interface MessageShowMsg {
  type: "message/show";
  requestId: number;
  level: "info" | "warn" | "error";
  message: string;
  modal?: boolean;
  detail?: string;
  items: Array<{ title: string; isCloseAffordance?: boolean }>;
}

export interface EnvOpenExternalMsg {
  type: "env/openExternal";
  requestId: number;
  uri: string;
}

export interface EditorApplyEditMsg {
  type: "editor/applyEdit";
  requestId: number;
  edit: WorkspaceEditPayload;
}

export interface CommandExecuteMsg {
  type: "command/execute";
  requestId: number;
  command: string;
  args: unknown[];
}

export interface ConfigurationReadMsg {
  type: "configuration/read";
  requestId: number;
  section?: string;
  key: string;
}

export interface ConfigurationWriteMsg {
  type: "configuration/write";
  requestId: number;
  section?: string;
  key: string;
  value: unknown;
  target: "global" | "workspace" | "folder";
}

export type HostToMainMessage =
  | ReadFileMsg
  | ReadBinaryFileMsg
  | LoadedMsg
  | ErrorMsg
  | ActivationLogMsg
  | RequestResultMsg
  | ProviderRegisterMsg
  | ProviderUnregisterMsg
  | DiagnosticsSetMsg
  | DiagnosticsClearMsg
  | OutputAppendMsg
  | StatusBarUpdateMsg
  | MessageShowMsg
  | EnvOpenExternalMsg
  | EditorApplyEditMsg
  | CommandExecuteMsg
  | ConfigurationReadMsg
  | ConfigurationWriteMsg;
