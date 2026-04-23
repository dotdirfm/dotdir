/**
 * vscode.workspace — text documents, configuration, folders, fs, file-event
 * emitters. Anything that mutates the host filesystem round-trips through
 * the worker RPC.
 */

import { ConfigurationTarget, FileType } from "./enums";
import { Disposable, EventEmitter } from "./events";
import { getRpc, logActivation } from "./runtime";
import { textDocuments as docs, type TextDocumentImpl } from "./textDocument";
import { Range, Uri, WorkspaceEdit } from "./types";

// ── Folders ─────────────────────────────────────────────────────────

export interface WorkspaceFolder {
  readonly uri: Uri;
  readonly name: string;
  readonly index: number;
}

let workspaceFolders: WorkspaceFolder[] = [];
export const onDidChangeWorkspaceFoldersEmitter = new EventEmitter<{
  added: WorkspaceFolder[];
  removed: WorkspaceFolder[];
}>();

export function setWorkspaceFolders(folders: Array<{ uri: string; name: string }>): void {
  const next: WorkspaceFolder[] = folders.map((f, i) => ({
    uri: Uri.parse(f.uri),
    name: f.name,
    index: i,
  }));
  const prev = workspaceFolders;
  workspaceFolders = next;
  const added = next.filter((n) => !prev.some((p) => p.uri.toString() === n.uri.toString()));
  const removed = prev.filter((p) => !next.some((n) => n.uri.toString() === p.uri.toString()));
  if (added.length || removed.length) {
    onDidChangeWorkspaceFoldersEmitter.fire({ added, removed });
  }
}

// ── Configuration store ─────────────────────────────────────────────

type ConfigValue = unknown;

const defaults = new Map<string, ConfigValue>();
const userValues = new Map<string, ConfigValue>();
const languageOverrides = new Map<string, Map<string, ConfigValue>>();

export function loadConfigDefaults(manifestProperties: Record<string, { default?: ConfigValue }> | undefined): void {
  if (!manifestProperties) return;
  for (const [key, prop] of Object.entries(manifestProperties)) {
    if ("default" in prop) {
      defaults.set(key, prop.default);
    }
  }
}

export function loadLanguageDefaults(overrides: Record<string, Record<string, ConfigValue>> | undefined): void {
  if (!overrides) return;
  for (const [key, values] of Object.entries(overrides)) {
    if (!key.startsWith("[") || !key.endsWith("]")) continue;
    const lang = key.slice(1, -1);
    let map = languageOverrides.get(lang);
    if (!map) {
      map = new Map<string, ConfigValue>();
      languageOverrides.set(lang, map);
    }
    for (const [k, v] of Object.entries(values)) {
      map.set(k, v);
    }
  }
}

export function applyUserConfig(flat: Record<string, ConfigValue>): void {
  for (const [k, v] of Object.entries(flat)) {
    userValues.set(k, v);
  }
}

export function updateUserConfigValue(key: string, value: ConfigValue | undefined): void {
  if (value === undefined) userValues.delete(key);
  else userValues.set(key, value);
  onDidChangeConfigurationEmitter.fire({
    affectsConfiguration: (section: string, _scope?: unknown) => key === section || key.startsWith(`${section}.`),
  });
}

export const onDidChangeConfigurationEmitter = new EventEmitter<ConfigurationChangeEvent>();

export interface ConfigurationChangeEvent {
  affectsConfiguration(section: string, scope?: unknown): boolean;
}

function resolveKey(section: string | undefined, key: string): string {
  if (!section) return key;
  return `${section}.${key}`;
}

function lookup(fullKey: string, language?: string): { value: ConfigValue | undefined; layer: "default" | "user" | "override" } {
  if (language) {
    const m = languageOverrides.get(language);
    if (m && m.has(fullKey)) return { value: m.get(fullKey), layer: "override" };
  }
  if (userValues.has(fullKey)) return { value: userValues.get(fullKey), layer: "user" };
  if (defaults.has(fullKey)) return { value: defaults.get(fullKey), layer: "default" };
  return { value: undefined, layer: "default" };
}

interface WorkspaceConfiguration {
  get<T>(section: string): T | undefined;
  get<T>(section: string, defaultValue: T): T;
  has(section: string): boolean;
  inspect<T>(section: string): {
    key: string;
    defaultValue?: T;
    globalValue?: T;
    workspaceValue?: T;
    workspaceFolderValue?: T;
    defaultLanguageValue?: T;
    globalLanguageValue?: T;
    workspaceLanguageValue?: T;
    workspaceFolderLanguageValue?: T;
    languageIds?: string[];
  } | undefined;
  update(section: string, value: unknown, target?: boolean | ConfigurationTarget, overrideInLanguage?: boolean): Promise<void>;
}

export function getConfiguration(section?: string, scope?: unknown): WorkspaceConfiguration {
  // scope may be a Uri, TextDocument, or an object `{ uri, languageId }`.
  let language: string | undefined;
  if (scope && typeof scope === "object") {
    const asAny = scope as { languageId?: string };
    if (typeof asAny.languageId === "string") language = asAny.languageId;
  }

  const cfg: WorkspaceConfiguration = {
    get<T>(key: string, defaultValue?: T): T | undefined {
      const { value } = lookup(resolveKey(section, key), language);
      if (value === undefined) return defaultValue;
      return value as T;
    },
    has(key: string): boolean {
      const fullKey = resolveKey(section, key);
      return defaults.has(fullKey) || userValues.has(fullKey);
    },
    inspect<T>(key: string) {
      const fullKey = resolveKey(section, key);
      return {
        key: fullKey,
        defaultValue: defaults.get(fullKey) as T | undefined,
        globalValue: userValues.get(fullKey) as T | undefined,
      };
    },
    async update(key: string, value: unknown, target?: boolean | ConfigurationTarget, _overrideInLanguage?: boolean): Promise<void> {
      const fullKey = resolveKey(section, key);
      const scopeTarget = target === true
        ? "global"
        : target === false || target === ConfigurationTarget.Workspace
          ? "workspace"
          : target === ConfigurationTarget.WorkspaceFolder
            ? "folder"
            : "global";
      const rpc = getRpc();
      const requestId = rpc.nextRequestId();
      try {
        await rpc.request({ type: "configuration/write", requestId, key: fullKey, value, target: scopeTarget });
      } catch (err) {
        logActivation("warn", `configuration update failed for ${fullKey}: ${err instanceof Error ? err.message : String(err)}`);
      }
      updateUserConfigValue(fullKey, value);
    },
  };

  return cfg;
}

// ── File events ─────────────────────────────────────────────────────

export const onDidOpenTextDocument = docs.onDidOpenEmitter.event;
export const onDidCloseTextDocument = docs.onDidCloseEmitter.event;
export const onDidChangeTextDocument = docs.onDidChangeEmitter.event;
export const onDidSaveTextDocument = docs.onDidSaveEmitter.event;
export const onWillSaveTextDocument = docs.onWillSaveEmitter.event;

export const onDidCreateFilesEmitter = new EventEmitter<{ files: Uri[] }>();
export const onDidDeleteFilesEmitter = new EventEmitter<{ files: Uri[] }>();
export const onDidRenameFilesEmitter = new EventEmitter<{ files: Array<{ oldUri: Uri; newUri: Uri }> }>();
export const onWillCreateFilesEmitter = new EventEmitter<{
  files: Uri[];
  waitUntil: (thenable: PromiseLike<unknown>) => void;
  token: { isCancellationRequested: boolean };
}>();
export const onWillDeleteFilesEmitter = new EventEmitter<{
  files: Uri[];
  waitUntil: (thenable: PromiseLike<unknown>) => void;
  token: { isCancellationRequested: boolean };
}>();
export const onWillRenameFilesEmitter = new EventEmitter<{
  files: Array<{ oldUri: Uri; newUri: Uri }>;
  waitUntil: (thenable: PromiseLike<unknown>) => void;
  token: { isCancellationRequested: boolean };
}>();

// ── Text document APIs ──────────────────────────────────────────────

function materializeDoc(d: TextDocumentImpl): TextDocumentImpl {
  return d;
}

export function openTextDocument(uriOrPath: Uri | string | { language?: string; content?: string }): Promise<TextDocumentImpl> {
  if (typeof uriOrPath === "string") {
    const uri = Uri.file(uriOrPath);
    return openByUri(uri);
  }
  if (uriOrPath instanceof Uri) {
    return openByUri(uriOrPath);
  }
  // untitled with content
  const content = uriOrPath.content ?? "";
  const uri = Uri.from({ scheme: "untitled", path: `/Untitled-${Date.now()}` });
  const doc = docs.open(uri.toString(), uri, uriOrPath.language ?? "plaintext", 1, content);
  doc.isUntitled = true;
  return Promise.resolve(materializeDoc(doc));
}

async function openByUri(uri: Uri): Promise<TextDocumentImpl> {
  const key = uri.toString();
  const existing = docs.get(key);
  if (existing) return existing;
  // Fallback: return a dummy empty document — the main thread hasn't
  // opened this file in Monaco, so we don't have content. Extensions that
  // rely on this will get an empty buffer, which is acceptable for the
  // yaml use case.
  return docs.open(key, uri, "plaintext", 1, "");
}

// ── workspace.fs (minimal file-scheme) ──────────────────────────────

class FileSystemApi {
  async stat(uri: Uri): Promise<{ type: FileType; ctime: number; mtime: number; size: number }> {
    const rpc = getRpc();
    const requestId = rpc.nextRequestId();
    const res = (await rpc.request({
      type: "command/execute",
      requestId,
      command: "__dotdir/fs.stat",
      args: [uri.fsPath],
    })) as { size: number; mtimeMs: number; isDir?: boolean } | null;
    if (!res) throw new Error(`File not found: ${uri.toString()}`);
    return {
      type: res.isDir ? FileType.Directory : FileType.File,
      ctime: res.mtimeMs,
      mtime: res.mtimeMs,
      size: res.size,
    };
  }

  async readFile(uri: Uri): Promise<Uint8Array> {
    const rpc = getRpc();
    const requestId = rpc.nextRequestId();
    try {
      const bytes = (await new Promise<ArrayBuffer | null>((resolve, reject) => {
        const id = rpc.nextRequestId();
        const dispose = rpc.subscribe("readBinaryFileResult", (msg) => {
          if (msg.type !== "readBinaryFileResult" || msg.id !== id) return;
          dispose();
          if (msg.error) reject(new Error(msg.error));
          else resolve(msg.bytes ?? null);
        });
        rpc.send({ type: "readBinaryFile", id, path: uri.fsPath });
      })) ?? null;
      void requestId;
      if (!bytes) throw new Error(`File not found: ${uri.toString()}`);
      return new Uint8Array(bytes);
    } catch (err) {
      throw err instanceof Error ? err : new Error(String(err));
    }
  }

  async writeFile(uri: Uri, content: Uint8Array): Promise<void> {
    const rpc = getRpc();
    const requestId = rpc.nextRequestId();
    const text = new TextDecoder().decode(content);
    await rpc.request({
      type: "command/execute",
      requestId,
      command: "__dotdir/fs.writeFile",
      args: [uri.fsPath, text],
    });
  }

  async delete(uri: Uri, _options?: { recursive?: boolean; useTrash?: boolean }): Promise<void> {
    const rpc = getRpc();
    const requestId = rpc.nextRequestId();
    await rpc.request({
      type: "command/execute",
      requestId,
      command: "__dotdir/fs.delete",
      args: [uri.fsPath],
    });
  }

  async rename(oldUri: Uri, newUri: Uri, _options?: { overwrite?: boolean }): Promise<void> {
    const rpc = getRpc();
    const requestId = rpc.nextRequestId();
    await rpc.request({
      type: "command/execute",
      requestId,
      command: "__dotdir/fs.rename",
      args: [oldUri.fsPath, newUri.fsPath],
    });
  }

  async readDirectory(uri: Uri): Promise<Array<[string, FileType]>> {
    const rpc = getRpc();
    const requestId = rpc.nextRequestId();
    const entries = (await rpc.request({
      type: "command/execute",
      requestId,
      command: "__dotdir/fs.readDir",
      args: [uri.fsPath],
    })) as Array<{ name: string; isDir: boolean }> | null;
    if (!entries) return [];
    return entries.map((e) => [e.name, e.isDir ? FileType.Directory : FileType.File]);
  }

  async createDirectory(uri: Uri): Promise<void> {
    const rpc = getRpc();
    const requestId = rpc.nextRequestId();
    await rpc.request({
      type: "command/execute",
      requestId,
      command: "__dotdir/fs.createDir",
      args: [uri.fsPath],
    });
  }

  async copy(source: Uri, target: Uri, options?: { overwrite?: boolean }): Promise<void> {
    const rpc = getRpc();
    const requestId = rpc.nextRequestId();
    await rpc.request({
      type: "command/execute",
      requestId,
      command: "__dotdir/fs.copy",
      args: [source.fsPath, target.fsPath, options ?? {}],
    });
  }

  isWritableFileSystem(_scheme: string): boolean | undefined {
    return true;
  }
}

export const fs = new FileSystemApi();

// ── FileSystemWatcher (no-op shell) ─────────────────────────────────

class FileSystemWatcher extends Disposable {
  readonly onDidCreate = new EventEmitter<Uri>().event;
  readonly onDidChange = new EventEmitter<Uri>().event;
  readonly onDidDelete = new EventEmitter<Uri>().event;

  constructor() {
    // TODO(vscode-shim): implement watcher subscription and event fanout.
    super(() => {});
  }

  get ignoreCreateEvents(): boolean {
    return false;
  }
  get ignoreChangeEvents(): boolean {
    return false;
  }
  get ignoreDeleteEvents(): boolean {
    return false;
  }
}

export function createFileSystemWatcher(
  _globPattern: unknown,
  _ignoreCreateEvents = false,
  _ignoreChangeEvents = false,
  _ignoreDeleteEvents = false,
): FileSystemWatcher {
  return new FileSystemWatcher();
}

// ── Misc ────────────────────────────────────────────────────────────

export function registerTextDocumentContentProvider(_scheme: string, _provider: unknown): Disposable {
  // TODO(vscode-shim): serve virtual documents via content providers.
  return new Disposable(() => {});
}

export function registerFileSystemProvider(_scheme: string, _provider: unknown, _options?: unknown): Disposable {
  // TODO(vscode-shim): support custom fs providers and route fs operations.
  return new Disposable(() => {});
}

export async function applyEdit(edit: WorkspaceEdit): Promise<boolean> {
  const rpc = getRpc();
  const requestId = rpc.nextRequestId();
  const payload = {
    changes: Object.fromEntries(
      edit.entries().map(([uri, edits]) => [
        uri.toString(),
        edits.map((e) => ({ range: rangeToPayload(e.range), newText: e.newText })),
      ]),
    ),
  };
  try {
    const result = await rpc.request({ type: "editor/applyEdit", requestId, edit: payload });
    return Boolean(result);
  } catch {
    return false;
  }
}

export function getWorkspaceFolder(uri: Uri): WorkspaceFolder | undefined {
  const uriStr = uri.toString();
  return workspaceFolders.find((f) => uriStr.startsWith(f.uri.toString()));
}

export function asRelativePath(pathOrUri: string | Uri, includeWorkspaceFolder = true): string {
  const s = pathOrUri instanceof Uri ? pathOrUri.fsPath : pathOrUri;
  for (const folder of workspaceFolders) {
    const root = folder.uri.fsPath;
    if (s.startsWith(`${root}/`) || s === root) {
      const rel = s.slice(root.length).replace(/^\/+/, "");
      return includeWorkspaceFolder && workspaceFolders.length > 1 ? `${folder.name}/${rel}` : rel;
    }
  }
  return s;
}

function rangeToPayload(range: Range): { start: { line: number; character: number }; end: { line: number; character: number } } {
  return {
    start: { line: range.start.line, character: range.start.character },
    end: { line: range.end.line, character: range.end.character },
  };
}

// ── Assembled `workspace` namespace ────────────────────────────────

export const workspace = {
  get workspaceFolders(): WorkspaceFolder[] | undefined {
    return workspaceFolders.length ? workspaceFolders : undefined;
  },
  get name(): string | undefined {
    if (!workspaceFolders.length) return undefined;
    return workspaceFolders[0]!.name;
  },
  get workspaceFile(): Uri | undefined {
    // TODO(vscode-shim): expose workspace file URI when multi-root/workspace files are supported.
    return undefined;
  },
  get textDocuments(): TextDocumentImpl[] {
    return docs.all;
  },
  get rootPath(): string | undefined {
    return workspaceFolders[0]?.uri.fsPath;
  },
  getConfiguration,
  getWorkspaceFolder,
  asRelativePath,
  openTextDocument,
  registerTextDocumentContentProvider,
  registerFileSystemProvider,
  createFileSystemWatcher,
  applyEdit,
  fs,
  // events
  onDidChangeWorkspaceFolders: onDidChangeWorkspaceFoldersEmitter.event,
  onDidOpenTextDocument,
  onDidCloseTextDocument,
  onDidChangeTextDocument,
  onDidSaveTextDocument,
  onWillSaveTextDocument,
  onDidChangeConfiguration: onDidChangeConfigurationEmitter.event,
  onDidCreateFiles: onDidCreateFilesEmitter.event,
  onDidDeleteFiles: onDidDeleteFilesEmitter.event,
  onDidRenameFiles: onDidRenameFilesEmitter.event,
  onWillCreateFiles: onWillCreateFilesEmitter.event,
  onWillDeleteFiles: onWillDeleteFilesEmitter.event,
  onWillRenameFiles: onWillRenameFilesEmitter.event,

  // Misc stubs used by extensions but not wired to real behaviour.
  notebookDocuments: [] as unknown[],
  onDidOpenNotebookDocument: new EventEmitter<unknown>().event,
  onDidCloseNotebookDocument: new EventEmitter<unknown>().event,
  onDidChangeNotebookDocument: new EventEmitter<unknown>().event,
  onDidSaveNotebookDocument: new EventEmitter<unknown>().event,
  onWillSaveNotebookDocument: new EventEmitter<unknown>().event,
  registerNotebookSerializer(): Disposable {
    // TODO(vscode-shim): implement notebook serializer registration.
    return new Disposable(() => {});
  },
  isTrusted: true,
  onDidGrantWorkspaceTrust: new EventEmitter<unknown>().event,
  requestWorkspaceTrust: async (): Promise<boolean> => true,
};

// Accessor used by editor/active routing later
export function setWorkspaceUserConfig(config: Record<string, ConfigValue>): void {
  applyUserConfig(config);
}

export function getWorkspaceFoldersSnapshot(): WorkspaceFolder[] {
  return workspaceFolders.slice();
}
