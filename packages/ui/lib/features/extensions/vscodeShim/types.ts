/**
 * VS Code API value classes (Uri, Range, Position, Diagnostic, ...).
 *
 * These mirror the shapes the real `vscode` module exposes; consumers like
 * `vscode-languageclient/browser` and `vscode-yaml` instantiate them
 * directly (`new vscode.Position(...)`) and also use the `.create(...)`
 * static factories / `.is(...)` type guards.
 */

import {
  CompletionItemKind,
  DiagnosticSeverity,
  DocumentHighlightKind,
  EndOfLine,
  FoldingRangeKind,
  SymbolKind,
} from "./enums";

// ── Uri ─────────────────────────────────────────────────────────────
//
// Implementation is intentionally small but covers the operations
// exercised by yaml-language-server / vscode-languageclient:
//   - Uri.parse / file / joinPath / from / revive
//   - .with()
//   - .toString() producing a WHATWG-compliant uri string
//   - .fsPath / .path / .scheme / .authority / .query / .fragment

const SCHEME_RE = /^([a-zA-Z][a-zA-Z0-9+.-]*):/;

function encodeAuthority(value: string): string {
  return encodeURIComponent(value).replace(/%3A/g, ":");
}

function encodePath(value: string, allowFragment: boolean): string {
  // Keep most path characters readable; encode the few with reserved meaning.
  let result = "";
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]!;
    const code = ch.charCodeAt(0);
    if (
      (code >= 0x61 && code <= 0x7a) ||
      (code >= 0x41 && code <= 0x5a) ||
      (code >= 0x30 && code <= 0x39) ||
      ch === "-" ||
      ch === "." ||
      ch === "_" ||
      ch === "~" ||
      ch === "/" ||
      ch === "!" ||
      ch === "$" ||
      ch === "&" ||
      ch === "(" ||
      ch === ")" ||
      ch === "*" ||
      ch === "+" ||
      ch === "," ||
      ch === ";" ||
      ch === "=" ||
      ch === ":" ||
      ch === "@" ||
      (ch === "#" && !allowFragment)
    ) {
      result += ch;
    } else {
      result += encodeURIComponent(ch);
    }
  }
  return result;
}

export interface UriComponents {
  scheme: string;
  authority: string;
  path: string;
  query: string;
  fragment: string;
}

export class Uri implements UriComponents {
  readonly scheme: string;
  readonly authority: string;
  readonly path: string;
  readonly query: string;
  readonly fragment: string;

  protected constructor(scheme: string, authority: string, path: string, query: string, fragment: string) {
    this.scheme = scheme || "file";
    this.authority = authority || "";
    this.path = path || "";
    this.query = query || "";
    this.fragment = fragment || "";
  }

  static file(path: string): Uri {
    let p = path.replace(/\\/g, "/");
    let authority = "";
    if (p.startsWith("//")) {
      const idx = p.indexOf("/", 2);
      if (idx === -1) {
        authority = p.slice(2);
        p = "/";
      } else {
        authority = p.slice(2, idx);
        p = p.slice(idx) || "/";
      }
    }
    if (!p.startsWith("/")) p = `/${p}`;
    return new Uri("file", authority, p, "", "");
  }

  static parse(value: string, _strict = false): Uri {
    const match = SCHEME_RE.exec(value);
    if (!match) {
      // Treat as a file path.
      return Uri.file(value);
    }
    const scheme = match[1]!;
    let rest = value.slice(scheme.length + 1);
    let authority = "";
    let path = "";
    let query = "";
    let fragment = "";

    if (rest.startsWith("//")) {
      rest = rest.slice(2);
      const slashIdx = rest.indexOf("/");
      const qIdx = rest.indexOf("?");
      const hIdx = rest.indexOf("#");
      const stops = [slashIdx, qIdx, hIdx].filter((i) => i !== -1);
      const cut = stops.length ? Math.min(...stops) : -1;
      if (cut === -1) {
        authority = rest;
        rest = "";
      } else {
        authority = rest.slice(0, cut);
        rest = rest.slice(cut);
      }
    }

    const hashIdx = rest.indexOf("#");
    if (hashIdx !== -1) {
      fragment = decodeURIComponent(rest.slice(hashIdx + 1));
      rest = rest.slice(0, hashIdx);
    }
    const qIdx = rest.indexOf("?");
    if (qIdx !== -1) {
      query = decodeURIComponent(rest.slice(qIdx + 1));
      rest = rest.slice(0, qIdx);
    }
    path = decodeURIComponent(rest);
    return new Uri(scheme, authority, path, query, fragment);
  }

  static from(components: Partial<UriComponents>): Uri {
    return new Uri(
      components.scheme ?? "",
      components.authority ?? "",
      components.path ?? "",
      components.query ?? "",
      components.fragment ?? "",
    );
  }

  static joinPath(base: Uri, ...segments: string[]): Uri {
    let p = base.path || "/";
    for (const seg of segments) {
      if (!seg) continue;
      if (!p.endsWith("/")) p += "/";
      p += seg.replace(/^\/+/, "");
    }
    p = p.replace(/\/+/g, "/");
    return new Uri(base.scheme, base.authority, p, "", "");
  }

  static revive(components: UriComponents | Uri | null | undefined): Uri | null {
    if (!components) return null;
    if (components instanceof Uri) return components;
    return Uri.from(components);
  }

  static isUri(thing: unknown): thing is Uri {
    return thing instanceof Uri;
  }

  with(change: { scheme?: string; authority?: string; path?: string; query?: string; fragment?: string }): Uri {
    return new Uri(
      change.scheme ?? this.scheme,
      change.authority ?? this.authority,
      change.path ?? this.path,
      change.query ?? this.query,
      change.fragment ?? this.fragment,
    );
  }

  get fsPath(): string {
    if (this.scheme !== "file") return this.path;
    if (this.authority) return `//${this.authority}${this.path}`;
    // Handle drive letters on Windows paths
    if (/^\/[a-zA-Z]:/.test(this.path)) return this.path.slice(1).replace(/\//g, "/");
    return this.path;
  }

  toString(_skipEncoding = false): string {
    const scheme = this.scheme;
    const authority = this.authority ? encodeAuthority(this.authority) : "";
    const path = encodePath(this.path, true);
    let result = `${scheme}:`;
    if (authority || scheme === "file") result += `//${authority}`;
    result += path;
    if (this.query) result += `?${encodeURIComponent(this.query)}`;
    if (this.fragment) result += `#${encodeURIComponent(this.fragment)}`;
    return result;
  }

  toJSON(): UriComponents & { $mid: number } {
    return {
      $mid: 1,
      scheme: this.scheme,
      authority: this.authority,
      path: this.path,
      query: this.query,
      fragment: this.fragment,
    };
  }
}

export class RelativePattern {
  baseUri: Uri;
  pattern: string;

  constructor(base: Uri | string, pattern: string) {
    this.baseUri = base instanceof Uri ? base : Uri.file(base);
    this.pattern = pattern;
  }

  static is(thing: unknown): thing is RelativePattern {
    if (thing instanceof RelativePattern) return true;
    if (!thing || typeof thing !== "object") return false;
    const anyThing = thing as { baseUri?: unknown; pattern?: unknown };
    return Uri.isUri(anyThing.baseUri) && typeof anyThing.pattern === "string";
  }
}

// ── Position & Range ────────────────────────────────────────────────

export class Position {
  readonly line: number;
  readonly character: number;

  constructor(line: number, character: number) {
    this.line = Math.max(0, Math.floor(line));
    this.character = Math.max(0, Math.floor(character));
  }

  static create(line: number, character: number): Position {
    return new Position(line, character);
  }

  static is(thing: unknown): thing is Position {
    if (thing instanceof Position) return true;
    if (!thing || typeof thing !== "object") return false;
    const anyThing = thing as { line?: unknown; character?: unknown };
    return typeof anyThing.line === "number" && typeof anyThing.character === "number";
  }

  isBefore(other: Position): boolean {
    if (this.line < other.line) return true;
    if (this.line > other.line) return false;
    return this.character < other.character;
  }

  isBeforeOrEqual(other: Position): boolean {
    return this.isBefore(other) || this.isEqual(other);
  }

  isAfter(other: Position): boolean {
    return !this.isBeforeOrEqual(other);
  }

  isAfterOrEqual(other: Position): boolean {
    return !this.isBefore(other);
  }

  isEqual(other: Position): boolean {
    return this.line === other.line && this.character === other.character;
  }

  compareTo(other: Position): number {
    if (this.line < other.line) return -1;
    if (this.line > other.line) return 1;
    if (this.character < other.character) return -1;
    if (this.character > other.character) return 1;
    return 0;
  }

  translate(lineDelta?: number | { lineDelta?: number; characterDelta?: number }, characterDelta?: number): Position {
    let ld = 0;
    let cd = 0;
    if (typeof lineDelta === "object" && lineDelta) {
      ld = lineDelta.lineDelta ?? 0;
      cd = lineDelta.characterDelta ?? 0;
    } else {
      ld = (lineDelta as number | undefined) ?? 0;
      cd = characterDelta ?? 0;
    }
    return new Position(this.line + ld, this.character + cd);
  }

  with(change: number | { line?: number; character?: number }, character?: number): Position {
    if (typeof change === "object" && change) {
      return new Position(change.line ?? this.line, change.character ?? this.character);
    }
    return new Position((change as number | undefined) ?? this.line, character ?? this.character);
  }
}

export class Range {
  readonly start: Position;
  readonly end: Position;

  constructor(start: Position, end: Position);
  constructor(startLine: number, startChar: number, endLine: number, endChar: number);
  constructor(a: Position | number, b: Position | number, c?: number, d?: number) {
    if (a instanceof Position && b instanceof Position) {
      const start = a.isBeforeOrEqual(b) ? a : b;
      const end = a.isBeforeOrEqual(b) ? b : a;
      this.start = start;
      this.end = end;
    } else {
      const s = new Position(a as number, b as number);
      const e = new Position(c ?? 0, d ?? 0);
      const start = s.isBeforeOrEqual(e) ? s : e;
      const end = s.isBeforeOrEqual(e) ? e : s;
      this.start = start;
      this.end = end;
    }
  }

  static create(start: Position, end: Position): Range;
  static create(startLine: number, startChar: number, endLine: number, endChar: number): Range;
  static create(a: Position | number, b: Position | number, c?: number, d?: number): Range {
    if (a instanceof Position && b instanceof Position) return new Range(a, b);
    return new Range(a as number, b as number, c ?? 0, d ?? 0);
  }

  static is(thing: unknown): thing is Range {
    if (thing instanceof Range) return true;
    if (!thing || typeof thing !== "object") return false;
    const r = thing as { start?: unknown; end?: unknown };
    return Position.is(r.start) && Position.is(r.end);
  }

  get isEmpty(): boolean {
    return this.start.isEqual(this.end);
  }

  get isSingleLine(): boolean {
    return this.start.line === this.end.line;
  }

  contains(positionOrRange: Position | Range): boolean {
    if (positionOrRange instanceof Position) {
      return !positionOrRange.isBefore(this.start) && !positionOrRange.isAfter(this.end);
    }
    return this.contains(positionOrRange.start) && this.contains(positionOrRange.end);
  }

  isEqual(other: Range): boolean {
    return this.start.isEqual(other.start) && this.end.isEqual(other.end);
  }

  intersection(range: Range): Range | undefined {
    const start = this.start.isAfter(range.start) ? this.start : range.start;
    const end = this.end.isBefore(range.end) ? this.end : range.end;
    if (start.isAfter(end)) return undefined;
    return new Range(start, end);
  }

  union(other: Range): Range {
    const start = this.start.isBefore(other.start) ? this.start : other.start;
    const end = this.end.isAfter(other.end) ? this.end : other.end;
    return new Range(start, end);
  }

  with(change: { start?: Position; end?: Position } | Position, end?: Position): Range {
    if (change instanceof Position) {
      return new Range(change, end ?? this.end);
    }
    return new Range(change.start ?? this.start, change.end ?? this.end);
  }
}

export class Selection extends Range {
  readonly anchor: Position;
  readonly active: Position;

  constructor(anchor: Position, active: Position);
  constructor(anchorLine: number, anchorChar: number, activeLine: number, activeChar: number);
  constructor(a: Position | number, b: Position | number, c?: number, d?: number) {
    if (a instanceof Position && b instanceof Position) {
      super(a, b);
      this.anchor = a;
      this.active = b;
    } else {
      const anchor = new Position(a as number, b as number);
      const active = new Position(c ?? 0, d ?? 0);
      super(anchor, active);
      this.anchor = anchor;
      this.active = active;
    }
  }

  get isReversed(): boolean {
    return this.anchor.isAfter(this.active);
  }
}

// ── Location / LocationLink ─────────────────────────────────────────

export class Location {
  uri: Uri;
  range: Range;

  constructor(uri: Uri, rangeOrPosition: Range | Position) {
    this.uri = uri;
    if (rangeOrPosition instanceof Range) {
      this.range = rangeOrPosition;
    } else {
      this.range = new Range(rangeOrPosition, rangeOrPosition);
    }
  }

  static create(uri: Uri, range: Range): Location {
    return new Location(uri, range);
  }
}

export interface LocationLink {
  originSelectionRange?: Range;
  targetUri: Uri;
  targetRange: Range;
  targetSelectionRange?: Range;
}

// ── MarkdownString ──────────────────────────────────────────────────

export class MarkdownString {
  value: string;
  isTrusted?: boolean | { readonly enabledCommands: readonly string[] };
  supportThemeIcons?: boolean;
  supportHtml?: boolean;
  baseUri?: Uri;

  constructor(value: string = "", supportThemeIcons = false) {
    this.value = value;
    this.supportThemeIcons = supportThemeIcons;
  }

  appendText(value: string): MarkdownString {
    // Escape markdown characters
    this.value += value.replace(/[\\`*_{}[\]()#+\-.!|]/g, "\\$&");
    return this;
  }

  appendMarkdown(value: string): MarkdownString {
    this.value += value;
    return this;
  }

  appendCodeblock(code: string, language = ""): MarkdownString {
    this.value += `\n\`\`\`${language}\n${code}\n\`\`\`\n`;
    return this;
  }
}

// ── Diagnostic ──────────────────────────────────────────────────────

export class DiagnosticRelatedInformation {
  location: Location;
  message: string;

  constructor(location: Location, message: string) {
    this.location = location;
    this.message = message;
  }
}

export class Diagnostic {
  range: Range;
  message: string;
  severity: DiagnosticSeverity;
  source?: string;
  code?: string | number | { value: string | number; target: Uri };
  relatedInformation?: DiagnosticRelatedInformation[];
  tags?: number[];

  constructor(range: Range, message: string, severity: DiagnosticSeverity = DiagnosticSeverity.Error) {
    this.range = range;
    this.message = message;
    this.severity = severity;
  }

  static create(range: Range, message: string, severity?: DiagnosticSeverity, source?: string, code?: string | number): Diagnostic {
    const d = new Diagnostic(range, message, severity);
    if (source !== undefined) d.source = source;
    if (code !== undefined) d.code = code;
    return d;
  }
}

// ── TextEdit / WorkspaceEdit ────────────────────────────────────────

export class TextEdit {
  range: Range;
  newText: string;
  newEol?: EndOfLine;

  constructor(range: Range, newText: string) {
    this.range = range;
    this.newText = newText;
  }

  static replace(range: Range, newText: string): TextEdit {
    return new TextEdit(range, newText);
  }

  static insert(position: Position, newText: string): TextEdit {
    return new TextEdit(new Range(position, position), newText);
  }

  static delete(range: Range): TextEdit {
    return new TextEdit(range, "");
  }

  static setEndOfLine(eol: EndOfLine): TextEdit {
    const edit = new TextEdit(new Range(0, 0, 0, 0), "");
    edit.newEol = eol;
    return edit;
  }
}

export class SnippetString {
  value: string;

  constructor(value?: string) {
    this.value = value ?? "";
  }

  appendText(value: string): SnippetString {
    this.value += value.replace(/\$/g, "\\$").replace(/}/g, "\\}");
    return this;
  }

  appendTabstop(number?: number): SnippetString {
    this.value += `$${number ?? ""}`;
    return this;
  }

  appendPlaceholder(value: string | ((snippet: SnippetString) => unknown), number?: number): SnippetString {
    this.value += `\${${number ?? ""}:${typeof value === "string" ? value : ""}}`;
    return this;
  }

  appendChoice(values: string[], number?: number): SnippetString {
    this.value += `\${${number ?? ""}|${values.join(",")}|}`;
    return this;
  }

  appendVariable(name: string, defaultValue: string | ((snippet: SnippetString) => unknown)): SnippetString {
    this.value += `\${${name}:${typeof defaultValue === "string" ? defaultValue : ""}}`;
    return this;
  }
}

export class WorkspaceEdit {
  private _edits = new Map<string, TextEdit[]>();
  private _fileOps: Array<
    | { kind: "create"; uri: Uri; options?: { overwrite?: boolean; ignoreIfExists?: boolean } }
    | { kind: "delete"; uri: Uri; options?: { recursive?: boolean; ignoreIfNotExists?: boolean } }
    | { kind: "rename"; oldUri: Uri; newUri: Uri; options?: { overwrite?: boolean; ignoreIfExists?: boolean } }
  > = [];

  get size(): number {
    return this._edits.size + this._fileOps.length;
  }

  replace(uri: Uri, range: Range, newText: string): void {
    const key = uri.toString();
    const list = this._edits.get(key) ?? [];
    list.push(new TextEdit(range, newText));
    this._edits.set(key, list);
  }

  insert(uri: Uri, position: Position, newText: string): void {
    this.replace(uri, new Range(position, position), newText);
  }

  delete(uri: Uri, range: Range): void {
    this.replace(uri, range, "");
  }

  has(uri: Uri): boolean {
    return this._edits.has(uri.toString());
  }

  set(uri: Uri, edits: TextEdit[]): void {
    this._edits.set(uri.toString(), edits.slice());
  }

  get(uri: Uri): TextEdit[] {
    return this._edits.get(uri.toString())?.slice() ?? [];
  }

  createFile(uri: Uri, options?: { overwrite?: boolean; ignoreIfExists?: boolean }): void {
    this._fileOps.push({ kind: "create", uri, options });
  }

  deleteFile(uri: Uri, options?: { recursive?: boolean; ignoreIfNotExists?: boolean }): void {
    this._fileOps.push({ kind: "delete", uri, options });
  }

  renameFile(oldUri: Uri, newUri: Uri, options?: { overwrite?: boolean; ignoreIfExists?: boolean }): void {
    this._fileOps.push({ kind: "rename", oldUri, newUri, options });
  }

  entries(): Array<[Uri, TextEdit[]]> {
    const result: Array<[Uri, TextEdit[]]> = [];
    for (const [key, edits] of this._edits) {
      result.push([Uri.parse(key), edits.slice()]);
    }
    return result;
  }
}

// ── Completion ─────────────────────────────────────────────────────

export interface CompletionItemLabel {
  label: string;
  detail?: string;
  description?: string;
}

export class CompletionItem {
  label: string | CompletionItemLabel;
  kind?: CompletionItemKind;
  tags?: number[];
  detail?: string;
  documentation?: string | MarkdownString;
  sortText?: string;
  filterText?: string;
  preselect?: boolean;
  insertText?: string | SnippetString;
  insertTextRules?: number;
  range?: Range | { inserting: Range; replacing: Range };
  commitCharacters?: string[];
  keepWhitespace?: boolean;
  additionalTextEdits?: TextEdit[];
  command?: { command: string; title: string; arguments?: unknown[] };
  textEdit?: TextEdit;

  constructor(label: string | CompletionItemLabel, kind?: CompletionItemKind) {
    this.label = label;
    this.kind = kind;
  }
}

export class CompletionList {
  isIncomplete?: boolean;
  items: CompletionItem[];

  constructor(items: CompletionItem[] = [], isIncomplete = false) {
    this.items = items;
    this.isIncomplete = isIncomplete;
  }
}

// ── Hover ───────────────────────────────────────────────────────────

export type MarkedString = string | { language: string; value: string } | MarkdownString;

export class Hover {
  contents: MarkedString[];
  range?: Range;

  constructor(contents: MarkedString | MarkedString[], range?: Range) {
    this.contents = Array.isArray(contents) ? contents : [contents];
    this.range = range;
  }
}

// ── Symbols ────────────────────────────────────────────────────────

export class SymbolInformation {
  name: string;
  containerName: string;
  kind: SymbolKind;
  tags?: number[];
  location: Location;

  constructor(name: string, kind: SymbolKind, containerName: string, location: Location);
  constructor(name: string, kind: SymbolKind, range: Range, uri?: Uri, containerName?: string);
  constructor(name: string, kind: SymbolKind, arg: string | Range, locOrUri?: Location | Uri, containerName?: string) {
    this.name = name;
    this.kind = kind;
    if (typeof arg === "string") {
      this.containerName = arg;
      this.location = (locOrUri as Location) ?? new Location(Uri.parse(""), new Range(0, 0, 0, 0));
    } else {
      this.containerName = containerName ?? "";
      this.location = new Location((locOrUri as Uri) ?? Uri.parse(""), arg);
    }
  }
}

export class DocumentSymbol {
  name: string;
  detail: string;
  kind: SymbolKind;
  tags?: number[];
  range: Range;
  selectionRange: Range;
  children: DocumentSymbol[];

  constructor(name: string, detail: string, kind: SymbolKind, range: Range, selectionRange: Range) {
    this.name = name;
    this.detail = detail;
    this.kind = kind;
    this.range = range;
    this.selectionRange = selectionRange;
    this.children = [];
  }
}

// ── Code actions / lens ─────────────────────────────────────────────

export class CodeActionKind {
  static readonly Empty = new CodeActionKind("");
  static readonly QuickFix = new CodeActionKind("quickfix");
  static readonly Refactor = new CodeActionKind("refactor");
  static readonly RefactorExtract = new CodeActionKind("refactor.extract");
  static readonly RefactorInline = new CodeActionKind("refactor.inline");
  static readonly RefactorMove = new CodeActionKind("refactor.move");
  static readonly RefactorRewrite = new CodeActionKind("refactor.rewrite");
  static readonly Source = new CodeActionKind("source");
  static readonly SourceOrganizeImports = new CodeActionKind("source.organizeImports");
  static readonly SourceFixAll = new CodeActionKind("source.fixAll");
  static readonly Notebook = new CodeActionKind("notebook");

  readonly value: string;

  constructor(value: string) {
    this.value = value;
  }

  append(parts: string): CodeActionKind {
    return new CodeActionKind(this.value ? `${this.value}.${parts}` : parts);
  }

  intersects(other: CodeActionKind): boolean {
    return this.contains(other) || other.contains(this);
  }

  contains(other: CodeActionKind): boolean {
    return this.value === "" || other.value === this.value || other.value.startsWith(`${this.value}.`);
  }
}

export class DocumentDropOrPasteEditKind {
  static readonly Empty = new DocumentDropOrPasteEditKind("");

  readonly value: string;

  constructor(value: string) {
    this.value = value;
  }

  append(parts: string): DocumentDropOrPasteEditKind {
    return new DocumentDropOrPasteEditKind(this.value ? `${this.value}.${parts}` : parts);
  }

  intersects(other: DocumentDropOrPasteEditKind): boolean {
    return this.contains(other) || other.contains(this);
  }

  contains(other: DocumentDropOrPasteEditKind): boolean {
    return this.value === "" || other.value === this.value || other.value.startsWith(`${this.value}.`);
  }
}

export class CodeAction {
  title: string;
  edit?: WorkspaceEdit;
  diagnostics?: Diagnostic[];
  command?: { command: string; title: string; arguments?: unknown[] };
  kind?: CodeActionKind;
  isPreferred?: boolean;
  disabled?: { reason: string };

  constructor(title: string, kind?: CodeActionKind) {
    this.title = title;
    this.kind = kind;
  }

  static create(title: string, kind?: CodeActionKind): CodeAction {
    return new CodeAction(title, kind);
  }
}

export class CodeLens {
  range: Range;
  command?: { command: string; title: string; arguments?: unknown[] };
  isResolved: boolean;

  constructor(range: Range, command?: { command: string; title: string; arguments?: unknown[] }) {
    this.range = range;
    this.command = command;
    this.isResolved = command !== undefined;
  }

  static create(range: Range, command?: { command: string; title: string; arguments?: unknown[] }): CodeLens {
    return new CodeLens(range, command);
  }
}

// ── Folding / Selection ranges ──────────────────────────────────────

export class FoldingRange {
  start: number;
  end: number;
  kind?: FoldingRangeKind;

  constructor(start: number, end: number, kind?: FoldingRangeKind) {
    this.start = start;
    this.end = end;
    this.kind = kind;
  }
}

export class SelectionRange {
  range: Range;
  parent?: SelectionRange;

  constructor(range: Range, parent?: SelectionRange) {
    this.range = range;
    this.parent = parent;
  }
}

// ── Signature help ──────────────────────────────────────────────────

export class ParameterInformation {
  label: string | [number, number];
  documentation?: string | MarkdownString;

  constructor(label: string | [number, number], documentation?: string | MarkdownString) {
    this.label = label;
    this.documentation = documentation;
  }
}

export class SignatureInformation {
  label: string;
  documentation?: string | MarkdownString;
  parameters: ParameterInformation[];
  activeParameter?: number;

  constructor(label: string, documentation?: string | MarkdownString) {
    this.label = label;
    this.documentation = documentation;
    this.parameters = [];
  }
}

export class SignatureHelp {
  signatures: SignatureInformation[] = [];
  activeSignature = 0;
  activeParameter = 0;
}

// ── Document link / highlight ───────────────────────────────────────

export class DocumentLink {
  range: Range;
  target?: Uri;
  tooltip?: string;

  constructor(range: Range, target?: Uri) {
    this.range = range;
    this.target = target;
  }
}

export class DocumentHighlight {
  range: Range;
  kind: DocumentHighlightKind;

  constructor(range: Range, kind: DocumentHighlightKind = DocumentHighlightKind.Text) {
    this.range = range;
    this.kind = kind;
  }
}

// ── Color ──────────────────────────────────────────────────────────

export class Color {
  readonly red: number;
  readonly green: number;
  readonly blue: number;
  readonly alpha: number;

  constructor(red: number, green: number, blue: number, alpha: number) {
    this.red = red;
    this.green = green;
    this.blue = blue;
    this.alpha = alpha;
  }
}

export class ColorInformation {
  range: Range;
  color: Color;

  constructor(range: Range, color: Color) {
    this.range = range;
    this.color = color;
  }
}

export class ColorPresentation {
  label: string;
  textEdit?: TextEdit;
  additionalTextEdits?: TextEdit[];

  constructor(label: string) {
    this.label = label;
  }
}

// ── Call hierarchy ─────────────────────────────────────────────────

export class CallHierarchyItem {
  name: string;
  kind: SymbolKind;
  tags?: number[];
  detail?: string;
  uri: Uri;
  range: Range;
  selectionRange: Range;

  constructor(kind: SymbolKind, name: string, detail: string, uri: Uri, range: Range, selectionRange: Range) {
    this.kind = kind;
    this.name = name;
    this.detail = detail;
    this.uri = uri;
    this.range = range;
    this.selectionRange = selectionRange;
  }
}

export class CallHierarchyIncomingCall {
  from: CallHierarchyItem;
  fromRanges: Range[];

  constructor(from: CallHierarchyItem, fromRanges: Range[]) {
    this.from = from;
    this.fromRanges = fromRanges;
  }
}

export class CallHierarchyOutgoingCall {
  to: CallHierarchyItem;
  fromRanges: Range[];

  constructor(to: CallHierarchyItem, fromRanges: Range[]) {
    this.to = to;
    this.fromRanges = fromRanges;
  }
}

// ── Semantic tokens ────────────────────────────────────────────────

export class SemanticTokensLegend {
  tokenTypes: string[];
  tokenModifiers: string[];

  constructor(tokenTypes: string[], tokenModifiers: string[] = []) {
    this.tokenTypes = tokenTypes;
    this.tokenModifiers = tokenModifiers;
  }
}

export class SemanticTokens {
  resultId?: string;
  data: Uint32Array;

  constructor(data: Uint32Array, resultId?: string) {
    this.data = data;
    this.resultId = resultId;
  }
}

export class SemanticTokensBuilder {
  private _tokens: number[] = [];
  private _legend?: SemanticTokensLegend;

  constructor(legend?: SemanticTokensLegend) {
    this._legend = legend;
  }

  push(line: number, char: number, length: number, tokenType: number, tokenModifiers?: number): void;
  push(range: Range, tokenType: string, tokenModifiers?: string[]): void;
  push(
    lineOrRange: number | Range,
    charOrType: number | string,
    lengthOrMods?: number | string[],
    tokenType?: number,
    tokenModifiers?: number,
  ): void {
    if (typeof lineOrRange === "number") {
      this._tokens.push(lineOrRange, charOrType as number, lengthOrMods as number, tokenType ?? 0, tokenModifiers ?? 0);
    } else {
      const legend = this._legend;
      if (!legend) return;
      const typeIdx = legend.tokenTypes.indexOf(charOrType as string);
      let mods = 0;
      if (Array.isArray(lengthOrMods)) {
        for (const m of lengthOrMods) {
          const idx = legend.tokenModifiers.indexOf(m);
          if (idx !== -1) mods |= 1 << idx;
        }
      }
      const range = lineOrRange as Range;
      this._tokens.push(range.start.line, range.start.character, range.end.character - range.start.character, typeIdx, mods);
    }
  }

  build(resultId?: string): SemanticTokens {
    return new SemanticTokens(new Uint32Array(this._tokens), resultId);
  }
}

// ── Inline value / misc (used by LanguageClient) ───────────────────

export class InlayHintLabelPart {
  value: string;
  constructor(value: string) {
    this.value = value;
  }
}

export class InlayHint {
  position: Position;
  label: string | InlayHintLabelPart[];
  kind?: number;
  constructor(position: Position, label: string | InlayHintLabelPart[], kind?: number) {
    this.position = position;
    this.label = label;
    this.kind = kind;
  }
}

export class LinkedEditingRanges {
  ranges: Range[];
  wordPattern?: RegExp;

  constructor(ranges: Range[], wordPattern?: RegExp) {
    this.ranges = ranges;
    this.wordPattern = wordPattern;
  }
}
