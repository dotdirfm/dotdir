/**
 * Assembled `vscode` namespace object for the extension host worker.
 *
 * This module has zero side effects at import time — it is constructed
 * once and handed to extensions via `require('vscode')` /
 * `import 'vscode'`. All state lives in the submodules so that each
 * extension sees the same shim instance.
 */

import * as enums from "./enums";
import * as types from "./types";
import * as events from "./events";
import { env } from "./env";
import { workspace } from "./workspace";
import { languages } from "./languages";
import { window } from "./window";
import { commands } from "./commands";
import { extensions, ExtensionMode } from "./extensions";

const l10n = {
  t: (message: string, ..._args: unknown[]): string => {
    if (typeof message !== "string") return "";
    return message;
  },
  bundle: undefined as Record<string, string> | undefined,
  uri: undefined as types.Uri | undefined,
};

const debug = {
  activeDebugSession: undefined,
  activeDebugConsole: { append: () => {}, appendLine: () => {} },
  breakpoints: [] as unknown[],
  onDidChangeActiveDebugSession: new events.EventEmitter<unknown>().event,
  onDidStartDebugSession: new events.EventEmitter<unknown>().event,
  onDidReceiveDebugSessionCustomEvent: new events.EventEmitter<unknown>().event,
  onDidTerminateDebugSession: new events.EventEmitter<unknown>().event,
  onDidChangeBreakpoints: new events.EventEmitter<unknown>().event,
  registerDebugAdapterDescriptorFactory: (): events.Disposable => new events.Disposable(() => {}),
  registerDebugConfigurationProvider: (): events.Disposable => new events.Disposable(() => {}),
  registerDebugAdapterTrackerFactory: (): events.Disposable => new events.Disposable(() => {}),
  startDebugging: async (): Promise<boolean> => false,
  stopDebugging: async (): Promise<void> => undefined,
  addBreakpoints: () => {},
  removeBreakpoints: () => {},
  asDebugSourceUri: (uri: types.Uri) => uri,
};

const tasks = {
  taskExecutions: [] as unknown[],
  onDidStartTask: new events.EventEmitter<unknown>().event,
  onDidStartTaskProcess: new events.EventEmitter<unknown>().event,
  onDidEndTask: new events.EventEmitter<unknown>().event,
  onDidEndTaskProcess: new events.EventEmitter<unknown>().event,
  fetchTasks: async (): Promise<unknown[]> => [],
  executeTask: async (): Promise<undefined> => undefined,
  registerTaskProvider: (): events.Disposable => new events.Disposable(() => {}),
};

const scm = {
  inputBox: { value: "", placeholder: "" },
  createSourceControl: (): { dispose(): void } => ({ dispose: () => {} }),
};

const comments = {
  createCommentController: (): { dispose(): void } => ({ dispose: () => {} }),
};

const authentication = {
  getSession: async (): Promise<undefined> => undefined,
  onDidChangeSessions: new events.EventEmitter<unknown>().event,
  registerAuthenticationProvider: (): events.Disposable => new events.Disposable(() => {}),
};

const chat = {
  createChatParticipant: (): { dispose(): void } => ({ dispose: () => {} }),
  registerMappedEditsProvider: (): events.Disposable => new events.Disposable(() => {}),
};

const tests = {
  createTestController: (): { dispose(): void } => ({ dispose: () => {} }),
  registerTestProvider: (): events.Disposable => new events.Disposable(() => {}),
};

const l10nFallback = l10n;

export function createVscodeNamespace(): Record<string, unknown> {
  return {
    // enums
    DiagnosticSeverity: enums.DiagnosticSeverity,
    DiagnosticTag: enums.DiagnosticTag,
    CompletionItemKind: enums.CompletionItemKind,
    CompletionItemTag: enums.CompletionItemTag,
    CompletionTriggerKind: enums.CompletionTriggerKind,
    SymbolKind: enums.SymbolKind,
    SymbolTag: enums.SymbolTag,
    CodeActionTriggerKind: enums.CodeActionTriggerKind,
    DocumentHighlightKind: enums.DocumentHighlightKind,
    FoldingRangeKind: enums.FoldingRangeKind,
    TextDocumentSaveReason: enums.TextDocumentSaveReason,
    TextEditorRevealType: enums.TextEditorRevealType,
    ViewColumn: enums.ViewColumn,
    EndOfLine: enums.EndOfLine,
    FileType: enums.FileType,
    ConfigurationTarget: enums.ConfigurationTarget,
    ExtensionKind: enums.ExtensionKind,
    UIKind: enums.UIKind,
    StatusBarAlignment: enums.StatusBarAlignment,
    ProgressLocation: enums.ProgressLocation,
    LanguageStatusSeverity: enums.LanguageStatusSeverity,
    LogLevel: enums.LogLevel,
    ExtensionMode,
    FileChangeType: enums.FileChangeType,
    InlineCompletionTriggerKind: enums.InlineCompletionTriggerKind,
    SignatureHelpTriggerKind: enums.SignatureHelpTriggerKind,
    TextDocumentChangeReason: enums.TextDocumentChangeReason,
    DebugConsoleMode: enums.DebugConsoleMode,
    CommentMode: enums.CommentMode,
    NotebookCellKind: enums.NotebookCellKind,

    // value classes
    Uri: types.Uri,
    Position: types.Position,
    Range: types.Range,
    Selection: types.Selection,
    Location: types.Location,
    Diagnostic: types.Diagnostic,
    DiagnosticRelatedInformation: types.DiagnosticRelatedInformation,
    MarkdownString: types.MarkdownString,
    SnippetString: types.SnippetString,
    TextEdit: types.TextEdit,
    WorkspaceEdit: types.WorkspaceEdit,
    CompletionItem: types.CompletionItem,
    CompletionList: types.CompletionList,
    Hover: types.Hover,
    SymbolInformation: types.SymbolInformation,
    DocumentSymbol: types.DocumentSymbol,
    CodeActionKind: types.CodeActionKind,
    CodeAction: types.CodeAction,
    CodeLens: types.CodeLens,
    FoldingRange: types.FoldingRange,
    SelectionRange: types.SelectionRange,
    SignatureHelp: types.SignatureHelp,
    SignatureInformation: types.SignatureInformation,
    ParameterInformation: types.ParameterInformation,
    DocumentLink: types.DocumentLink,
    DocumentHighlight: types.DocumentHighlight,
    Color: types.Color,
    ColorInformation: types.ColorInformation,
    ColorPresentation: types.ColorPresentation,
    CallHierarchyItem: types.CallHierarchyItem,
    CallHierarchyIncomingCall: types.CallHierarchyIncomingCall,
    CallHierarchyOutgoingCall: types.CallHierarchyOutgoingCall,
    SemanticTokens: types.SemanticTokens,
    SemanticTokensLegend: types.SemanticTokensLegend,
    SemanticTokensBuilder: types.SemanticTokensBuilder,
    InlayHint: types.InlayHint,
    InlayHintLabelPart: types.InlayHintLabelPart,
    LinkedEditingRanges: types.LinkedEditingRanges,
    TabInputText: types.TabInputText,
    TabInputTextDiff: types.TabInputTextDiff,
    TabInputNotebook: types.TabInputNotebook,
    TabInputCustom: types.TabInputCustom,
    DocumentDropOrPasteEditKind: types.DocumentDropOrPasteEditKind,
    RelativePattern: types.RelativePattern,
    EventEmitter: events.EventEmitter,
    Disposable: events.Disposable,
    CancellationTokenSource: events.CancellationTokenSource,
    CancellationError: events.CancellationError,

    // namespaces
    workspace,
    languages,
    window,
    commands,
    env,
    extensions,
    debug,
    tasks,
    scm,
    comments,
    authentication,
    chat,
    tests,
    l10n: l10nFallback,

    // Version — match a reasonable recent VS Code for compatibility
    version: "1.95.0",
  };
}

export { enums, events, types };
export { workspace } from "./workspace";
export { languages } from "./languages";
export { window } from "./window";
export { commands, installCommandAdapter } from "./commands";
export { env } from "./env";
export { extensions, registerExtension, markExtensionActive } from "./extensions";
export {
  installWorkerRpc,
  getRpc,
  setActiveExtensionKey,
  getActiveExtensionKey,
  setDataDir,
  getDataDir,
  logActivation,
  getProvider,
} from "./runtime";
export type { WorkerRpc, WorkerRpcHandler } from "./runtime";
export { textDocuments } from "./textDocument";
export type { TextDocumentImpl } from "./textDocument";
export { setWorkspaceFolders, setWorkspaceConfig, loadConfigDefaults, loadLanguageDefaults, applyUserConfig, updateUserConfigValue } from "./workspace";
export { setActiveEditor } from "./window";
