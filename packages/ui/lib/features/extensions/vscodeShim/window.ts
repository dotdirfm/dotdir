/**
 * vscode.window — editors, messages, output channels, status bar, progress,
 * quick pick, input box. Anything that would touch the UI forwards via RPC
 * to the main thread (today, most of those forward as "show a toast"
 * or a no-op).
 */

import { ProgressLocation, StatusBarAlignment, ViewColumn } from "./enums";
import { Disposable, EventEmitter } from "./events";
import { getRpc, logActivation } from "./runtime";
import { textDocuments } from "./textDocument";
import { Position, Range, Selection, Uri, TabInputText } from "./types";
import type { TextDocumentImpl } from "./textDocument";

// ── TextEditor (synthetic — backed by main-thread Monaco) ───────────

export interface TextEditor {
  readonly document: TextDocumentImpl;
  selection: Selection;
  selections: Selection[];
  visibleRanges: Range[];
  options: { tabSize?: number; insertSpaces?: boolean };
  viewColumn?: ViewColumn;
  edit(callback: (edit: TextEditorEditImpl) => void): Promise<boolean>;
  insertSnippet(): Promise<boolean>;
  setDecorations(): void;
  revealRange(): void;
  show(): void;
  hide(): void;
}

class TextEditorEditImpl {
  readonly _edits: Array<{ range: Range; newText: string }> = [];

  replace(range: Range, newText: string): void {
    this._edits.push({ range, newText });
  }

  insert(position: Position, text: string): void {
    this._edits.push({ range: new Range(position, position), newText: text });
  }

  delete(range: Range): void {
    this._edits.push({ range, newText: "" });
  }

  setEndOfLine(): void {
    // no-op
  }
}

let activeTextEditor: TextEditor | null = null;
const visibleEditors: TextEditor[] = [];

export const onDidChangeActiveTextEditorEmitter = new EventEmitter<TextEditor | undefined>();
export const onDidChangeVisibleTextEditorsEmitter = new EventEmitter<TextEditor[]>();
export const onDidChangeTextEditorSelectionEmitter = new EventEmitter<{
  textEditor: TextEditor;
  selections: Selection[];
  kind?: number;
}>();
export const onDidChangeTextEditorVisibleRangesEmitter = new EventEmitter<{ textEditor: TextEditor; visibleRanges: Range[] }>();
export const onDidChangeTextEditorOptionsEmitter = new EventEmitter<{ textEditor: TextEditor; options: unknown }>();
export const onDidChangeTextEditorViewColumnEmitter = new EventEmitter<{ textEditor: TextEditor; viewColumn: ViewColumn }>();
export const onDidChangeWindowStateEmitter = new EventEmitter<{ focused: boolean }>();
export const onDidChangeActiveColorThemeEmitter = new EventEmitter<unknown>();

function makeTextEditor(doc: TextDocumentImpl): TextEditor {
  const selection = new Selection(0, 0, 0, 0);
  return {
    document: doc,
    selection,
    selections: [selection],
    visibleRanges: [new Range(0, 0, doc.lineCount, 0)],
    options: { tabSize: 2, insertSpaces: true },
    viewColumn: ViewColumn.One,
    async edit(callback: (edit: TextEditorEditImpl) => void): Promise<boolean> {
      const builder = new TextEditorEditImpl();
      callback(builder);
      // Forward to the main thread via workspace.applyEdit-style message
      const rpc = getRpc();
      const requestId = rpc.nextRequestId();
      try {
        await rpc.request({
          type: "editor/applyEdit",
          requestId,
          edit: {
            changes: {
              [doc.uri.toString()]: builder._edits.map((e) => ({
                range: {
                  start: { line: e.range.start.line, character: e.range.start.character },
                  end: { line: e.range.end.line, character: e.range.end.character },
                },
                newText: e.newText,
              })),
            },
          },
        });
        return true;
      } catch {
        return false;
      }
    },
    async insertSnippet() {
      return true;
    },
    setDecorations() {},
    revealRange() {},
    show() {},
    hide() {},
  };
}

export function setActiveEditor(uri: string | null): void {
  if (!uri) {
    activeTextEditor = null;
    onDidChangeActiveTextEditorEmitter.fire(undefined);
    return;
  }
  const doc = textDocuments.get(uri);
  if (!doc) {
    activeTextEditor = null;
    onDidChangeActiveTextEditorEmitter.fire(undefined);
    return;
  }
  activeTextEditor = makeTextEditor(doc);
  visibleEditors.splice(0, visibleEditors.length, activeTextEditor);
  onDidChangeActiveTextEditorEmitter.fire(activeTextEditor);
  onDidChangeVisibleTextEditorsEmitter.fire(visibleEditors);
}

// ── Messages ────────────────────────────────────────────────────────

async function showMessage(
  level: "info" | "warn" | "error",
  message: string,
  ...rest: Array<string | { modal?: boolean; detail?: string } | { title: string; isCloseAffordance?: boolean }>
): Promise<string | undefined> {
  const rpc = getRpc();
  const requestId = rpc.nextRequestId();
  let modal = false;
  let detail: string | undefined;
  const items: Array<{ title: string; isCloseAffordance?: boolean }> = [];
  for (const arg of rest) {
    if (typeof arg === "string") items.push({ title: arg });
    else if (arg && typeof arg === "object" && "title" in arg) items.push(arg as { title: string; isCloseAffordance?: boolean });
    else if (arg && typeof arg === "object") {
      if ((arg as { modal?: boolean }).modal) modal = true;
      if ((arg as { detail?: string }).detail) detail = (arg as { detail?: string }).detail;
    }
  }
  logActivation(level === "error" ? "error" : level === "warn" ? "warn" : "info", `window.show${level}Message: ${message}`);
  try {
    const title = (await rpc.request({
      type: "message/show",
      requestId,
      level,
      message,
      modal,
      detail,
      items,
    })) as string | undefined;
    return title;
  } catch {
    return undefined;
  }
}

export const showInformationMessage = (message: string, ...rest: unknown[]) =>
  showMessage("info", message, ...(rest as Parameters<typeof showMessage>[2][]));
export const showWarningMessage = (message: string, ...rest: unknown[]) =>
  showMessage("warn", message, ...(rest as Parameters<typeof showMessage>[2][]));
export const showErrorMessage = (message: string, ...rest: unknown[]) =>
  showMessage("error", message, ...(rest as Parameters<typeof showMessage>[2][]));

// ── Output channels ────────────────────────────────────────────────

interface OutputChannel {
  readonly name: string;
  append(value: string): void;
  appendLine(value: string): void;
  clear(): void;
  replace(value: string): void;
  show(preserveFocus?: boolean): void;
  show(column?: ViewColumn, preserveFocus?: boolean): void;
  hide(): void;
  dispose(): void;
}

export function createOutputChannel(name: string, options?: string | { log?: boolean; languageId?: string }): OutputChannel {
  const rpc = getRpc();
  const send = (text: string, newline: boolean) => {
    rpc.send({ type: "output/append", channel: name, text, newline });
  };
  const isLog = typeof options === "object" && options?.log === true;

  return {
    name,
    append: (value) => send(value, false),
    appendLine: (value) => send(value, true),
    clear: () => send("", false),
    replace: (value) => send(value, true),
    show: () => {},
    hide: () => {},
    dispose: () => {},
    // LogOutputChannel properties (when { log: true })
    ...(isLog ? {
      logLevel: 3 as number, // 3 = Info
      info: (message: string) => {
        logActivation("info", `[${name}] ${message}`);
        send(`${message}`, true);
      },
      trace: (message: string) => {
        logActivation("info", `[${name}] ${message}`);
        send(`${message}`, true);
      },
      warn: (message: string) => {
        logActivation("warn", `[${name}] ${message}`);
        send(`${message}`, true);
      },
      error: (message: string) => {
        logActivation("error", `[${name}] ${message}`);
        send(`${message}`, true);
      },
      debug: (message: string) => {
        logActivation("info", `[${name}] ${message}`);
        send(`${message}`, true);
      },
    } : {}),
  };
}

// ── Status bar ──────────────────────────────────────────────────────

interface StatusBarItem {
  alignment: StatusBarAlignment;
  priority?: number;
  id: string;
  name?: string;
  text: string;
  tooltip?: string;
  color?: string | { id: string };
  backgroundColor?: { id: string };
  command?: string | { command: string; title: string; arguments?: unknown[] };
  accessibilityInformation?: unknown;
  show(): void;
  hide(): void;
  dispose(): void;
}

let nextStatusId = 0;

export function createStatusBarItem(
  arg1?: string | StatusBarAlignment,
  arg2?: StatusBarAlignment | number,
  arg3?: number,
): StatusBarItem {
  let id: string;
  let alignment = StatusBarAlignment.Left;
  let priority: number | undefined;
  if (typeof arg1 === "string") {
    id = arg1;
    alignment = (arg2 as StatusBarAlignment | undefined) ?? StatusBarAlignment.Left;
    priority = arg3;
  } else {
    id = `sb-${++nextStatusId}`;
    alignment = arg1 ?? StatusBarAlignment.Left;
    priority = arg2 as number | undefined;
  }
  const rpc = getRpc();
  const item: StatusBarItem = {
    id,
    alignment,
    priority,
    text: "",
    show() {
      rpc.send({
        type: "statusbar/update",
        id,
        text: item.text,
        tooltip: item.tooltip,
        alignment: alignment === StatusBarAlignment.Left ? "left" : "right",
        priority,
        visible: true,
        command: typeof item.command === "string" ? item.command : item.command?.command,
      });
    },
    hide() {
      rpc.send({ type: "statusbar/update", id, visible: false });
    },
    dispose() {
      rpc.send({ type: "statusbar/update", id, visible: false });
    },
  };
  return item;
}

// ── Quick pick / input box (stubs) ─────────────────────────────────

export function createQuickPick<T extends { label: string }>(): {
  items: T[];
  title?: string;
  value: string;
  placeholder?: string;
  canSelectMany: boolean;
  matchOnDescription: boolean;
  matchOnDetail: boolean;
  selectedItems: T[];
  activeItems: T[];
  show(): void;
  hide(): void;
  dispose(): void;
  onDidAccept: EventEmitter<void>["event"];
  onDidHide: EventEmitter<void>["event"];
  onDidChangeValue: EventEmitter<string>["event"];
  onDidChangeSelection: EventEmitter<T[]>["event"];
  onDidChangeActive: EventEmitter<T[]>["event"];
} {
  const accept = new EventEmitter<void>();
  const hide = new EventEmitter<void>();
  const change = new EventEmitter<string>();
  const sel = new EventEmitter<T[]>();
  const active = new EventEmitter<T[]>();
  return {
    items: [],
    value: "",
    canSelectMany: false,
    matchOnDescription: false,
    matchOnDetail: false,
    selectedItems: [],
    activeItems: [],
    show: () => {},
    hide: () => {
      hide.fire();
    },
    dispose: () => {
      accept.dispose();
      hide.dispose();
      change.dispose();
      sel.dispose();
      active.dispose();
    },
    onDidAccept: accept.event,
    onDidHide: hide.event,
    onDidChangeValue: change.event,
    onDidChangeSelection: sel.event,
    onDidChangeActive: active.event,
  };
}

export function createInputBox(): {
  title?: string;
  value: string;
  placeholder?: string;
  password: boolean;
  show(): void;
  hide(): void;
  dispose(): void;
  onDidAccept: EventEmitter<void>["event"];
  onDidHide: EventEmitter<void>["event"];
  onDidChangeValue: EventEmitter<string>["event"];
} {
  const accept = new EventEmitter<void>();
  const hide = new EventEmitter<void>();
  const change = new EventEmitter<string>();
  return {
    value: "",
    password: false,
    show: () => {},
    hide: () => {
      hide.fire();
    },
    dispose: () => {
      accept.dispose();
      hide.dispose();
      change.dispose();
    },
    onDidAccept: accept.event,
    onDidHide: hide.event,
    onDidChangeValue: change.event,
  };
}

export async function showQuickPick<T extends { label: string } | string>(
  items: readonly T[] | PromiseLike<readonly T[]>,
  _options?: unknown,
): Promise<T | undefined> {
  const resolved = await Promise.resolve(items);
  return resolved[0];
}

export async function showInputBox(_options?: unknown): Promise<string | undefined> {
  return undefined;
}

export async function showOpenDialog(_options?: unknown): Promise<Uri[] | undefined> {
  return undefined;
}

export async function showSaveDialog(_options?: unknown): Promise<Uri | undefined> {
  return undefined;
}

export async function showWorkspaceFolderPick(_options?: unknown): Promise<undefined> {
  return undefined;
}

// ── Progress ────────────────────────────────────────────────────────

export async function withProgress<T>(
  _options: { location: ProgressLocation; title?: string; cancellable?: boolean },
  task: (progress: { report(value: { message?: string; increment?: number }): void }, token: { isCancellationRequested: boolean }) => Thenable<T>,
): Promise<T> {
  const progress = { report: () => {} };
  const token = { isCancellationRequested: false };
  return task(progress, token);
}

type Thenable<T> = PromiseLike<T>;

// ── Decoration types (stub) ─────────────────────────────────────────

export function createTextEditorDecorationType(_options: unknown): { key: string; dispose(): void } {
  const key = `deco-${Math.random().toString(36).slice(2)}`;
  return { key, dispose: () => {} };
}

// ── showTextDocument ────────────────────────────────────────────────

export async function showTextDocument(
  docOrUri: TextDocumentImpl | Uri,
  _column?: ViewColumn | { viewColumn?: ViewColumn; preview?: boolean; preserveFocus?: boolean; selection?: Range },
  _preserveFocus?: boolean,
): Promise<TextEditor> {
  const uri = docOrUri instanceof Uri ? docOrUri : docOrUri.uri;
  const rpc = getRpc();
  const requestId = rpc.nextRequestId();
  try {
    await rpc.request({ type: "command/execute", requestId, command: "__dotdir/openFile", args: [uri.fsPath] });
  } catch {
    // ignore
  }
  const doc = textDocuments.get(uri.toString());
  return makeTextEditor(doc ?? (docOrUri as TextDocumentImpl));
}

// ── Tabs ─────────────────────────────────────────────────────────────

interface Tab {
  readonly input: unknown;
  readonly label: string;
  readonly isActive: boolean;
  readonly group: { activeTab: Tab | undefined; tabs: Tab[] };
}

interface TabGroup {
  readonly activeTab: Tab | undefined;
  readonly tabs: Tab[];
}

function makeActiveTab(): Tab {
  const doc = activeTextEditor?.document;
  const input = doc ? new TabInputText(doc.uri) : undefined;
  const group: TabGroup = {
    activeTab: undefined,
    tabs: [],
  };
  const tab: Tab = {
    input,
    label: doc?.fileName ?? "",
    isActive: true,
    group,
  };
  (group as { activeTab: Tab }).activeTab = tab;
  (group as { tabs: Tab[] }).tabs = [tab];
  return tab;
}

function makeTabGroup(): TabGroup {
  const tab = activeTextEditor ? makeActiveTab() : undefined;
  return {
    activeTab: tab,
    tabs: tab ? [tab] : [],
  };
}

const tabGroups = {
  all: [] as TabGroup[],
  get activeTabGroup(): TabGroup {
    return makeTabGroup();
  },
  onDidChangeTabs: new EventEmitter<unknown>().event,
  onDidChangeTabGroups: new EventEmitter<unknown>().event,
  close: async (): Promise<boolean> => true,
};

// ── TreeView / WebView / Terminal stubs ─────────────────────────────

function notImplementedDisposable(): Disposable {
  return new Disposable(() => {});
}

export const window = {
  get activeTextEditor(): TextEditor | undefined {
    return activeTextEditor ?? undefined;
  },
  get visibleTextEditors(): TextEditor[] {
    return visibleEditors.slice();
  },
  get state(): { focused: boolean; active: boolean } {
    return { focused: true, active: true };
  },
  get activeColorTheme(): { kind: number } {
    return { kind: 2 };
  },
  tabGroups,
  onDidChangeActiveTextEditor: onDidChangeActiveTextEditorEmitter.event,
  onDidChangeVisibleTextEditors: onDidChangeVisibleTextEditorsEmitter.event,
  onDidChangeTextEditorSelection: onDidChangeTextEditorSelectionEmitter.event,
  onDidChangeTextEditorVisibleRanges: onDidChangeTextEditorVisibleRangesEmitter.event,
  onDidChangeTextEditorOptions: onDidChangeTextEditorOptionsEmitter.event,
  onDidChangeTextEditorViewColumn: onDidChangeTextEditorViewColumnEmitter.event,
  onDidChangeWindowState: onDidChangeWindowStateEmitter.event,
  onDidChangeActiveColorTheme: onDidChangeActiveColorThemeEmitter.event,
  showInformationMessage,
  showWarningMessage,
  showErrorMessage,
  createOutputChannel,
  createStatusBarItem,
  createQuickPick,
  createInputBox,
  showQuickPick,
  showInputBox,
  showOpenDialog,
  showSaveDialog,
  showWorkspaceFolderPick,
  withProgress,
  createTextEditorDecorationType,
  showTextDocument,
  registerTreeDataProvider: (): Disposable => notImplementedDisposable(),
  createTreeView: (): { dispose(): void } => ({ dispose: () => {} }),
  registerWebviewPanelSerializer: (): Disposable => notImplementedDisposable(),
  registerWebviewViewProvider: (): Disposable => notImplementedDisposable(),
  registerCustomEditorProvider: (): Disposable => notImplementedDisposable(),
  registerFileDecorationProvider: (): Disposable => notImplementedDisposable(),
  registerUriHandler: (): Disposable => notImplementedDisposable(),
  registerTerminalLinkProvider: (): Disposable => notImplementedDisposable(),
  registerTerminalProfileProvider: (): Disposable => notImplementedDisposable(),
  createTerminal: (): { dispose(): void } => ({ dispose: () => {} }),
  terminals: [] as unknown[],
  onDidOpenTerminal: new EventEmitter<unknown>().event,
  onDidCloseTerminal: new EventEmitter<unknown>().event,
  onDidChangeActiveTerminal: new EventEmitter<unknown>().event,
  onDidWriteTerminalData: new EventEmitter<unknown>().event,
  activeTerminal: undefined,
  createWebviewPanel: (): { dispose(): void } => ({ dispose: () => {} }),
};
