/**
 * In-worker TextDocument backed by a buffer synced from the main thread.
 *
 * vscode-languageclient/browser calls `.offsetAt`, `.positionAt`,
 * `.getText(range)`, `.lineAt`, `.lineCount`, `.eol` during `didChange`
 * processing. This implementation mirrors the behaviour of the real
 * vscode TextDocument (LF/CRLF-aware line tracking) without pulling in
 * the full editor stack.
 */

import { EndOfLine } from "./enums";
import { EventEmitter } from "./events";
import { Position, Range, type Uri } from "./types";

export interface TextLine {
  readonly lineNumber: number;
  readonly text: string;
  readonly range: Range;
  readonly rangeIncludingLineBreak: Range;
  readonly firstNonWhitespaceCharacterIndex: number;
  readonly isEmptyOrWhitespace: boolean;
}

export class TextDocumentImpl {
  readonly uri: Uri;
  readonly fileName: string;
  isUntitled = false;
  languageId: string;
  version: number;
  isDirty = false;
  isClosed = false;
  eol: EndOfLine = EndOfLine.LF;

  private _text: string;
  private _lineOffsets: number[] | null = null;

  constructor(uri: Uri, languageId: string, version: number, text: string) {
    this.uri = uri;
    this.languageId = languageId;
    this.version = version;
    this._text = text;
    this.fileName = uri.scheme === "file" ? uri.fsPath : uri.toString();
    this._detectEol(text);
  }

  private _detectEol(text: string): void {
    const crlfIdx = text.indexOf("\r\n");
    const lfIdx = text.indexOf("\n");
    if (crlfIdx !== -1 && (lfIdx === -1 || crlfIdx <= lfIdx)) this.eol = EndOfLine.CRLF;
    else this.eol = EndOfLine.LF;
  }

  get lineCount(): number {
    return this._getLineOffsets().length;
  }

  getText(range?: Range): string {
    if (!range) return this._text;
    const start = this._offsetAt(range.start);
    const end = this._offsetAt(range.end);
    return this._text.slice(start, end);
  }

  offsetAt(position: Position): number {
    return this._offsetAt(position);
  }

  positionAt(offset: number): Position {
    offset = Math.max(0, Math.min(offset, this._text.length));
    const lineOffsets = this._getLineOffsets();
    let low = 0;
    let high = lineOffsets.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (lineOffsets[mid]! > offset) high = mid;
      else low = mid + 1;
    }
    const line = low - 1;
    return new Position(line, offset - lineOffsets[line]!);
  }

  lineAt(lineOrPosition: number | Position): TextLine {
    const line = lineOrPosition instanceof Position ? lineOrPosition.line : lineOrPosition;
    const lineOffsets = this._getLineOffsets();
    if (line < 0 || line >= lineOffsets.length) {
      throw new Error(`Illegal line value ${line}`);
    }
    const start = lineOffsets[line]!;
    const nextOffset = line + 1 < lineOffsets.length ? lineOffsets[line + 1]! : this._text.length;
    let endNoEol = nextOffset;
    if (nextOffset > start) {
      if (this._text[nextOffset - 1] === "\n") endNoEol = nextOffset - 1;
      if (endNoEol > start && this._text[endNoEol - 1] === "\r") endNoEol = endNoEol - 1;
    }
    const text = this._text.slice(start, endNoEol);
    const firstNonWs = /[^\s]/.exec(text);
    const range = new Range(new Position(line, 0), new Position(line, text.length));
    const rangeWithEol = new Range(new Position(line, 0), new Position(line, nextOffset - start));
    return {
      lineNumber: line,
      text,
      range,
      rangeIncludingLineBreak: rangeWithEol,
      firstNonWhitespaceCharacterIndex: firstNonWs ? firstNonWs.index : text.length,
      isEmptyOrWhitespace: !firstNonWs,
    };
  }

  validateRange(range: Range): Range {
    return new Range(this.validatePosition(range.start), this.validatePosition(range.end));
  }

  validatePosition(position: Position): Position {
    const lineCount = this.lineCount;
    if (position.line < 0) return new Position(0, 0);
    if (position.line >= lineCount) {
      const line = Math.max(0, lineCount - 1);
      const length = this.lineAt(line).text.length;
      return new Position(line, length);
    }
    const length = this.lineAt(position.line).text.length;
    return new Position(position.line, Math.min(position.character, length));
  }

  getWordRangeAtPosition(position: Position, regex?: RegExp): Range | undefined {
    if (position.line >= this.lineCount) return undefined;
    const line = this.lineAt(position.line).text;
    const re = regex ?? /[A-Za-z0-9_]+/g;
    re.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(line))) {
      const start = match.index;
      const end = start + match[0].length;
      if (start <= position.character && position.character <= end) {
        return new Range(new Position(position.line, start), new Position(position.line, end));
      }
      if (match.index === re.lastIndex) re.lastIndex++;
    }
    return undefined;
  }

  async save(): Promise<boolean> {
    return true;
  }

  // ── Mutation (not exposed to extensions) ─────────────────────────

  _setText(text: string, version: number): void {
    this._text = text;
    this.version = version;
    this._lineOffsets = null;
    this._detectEol(text);
  }

  _markClosed(): void {
    this.isClosed = true;
  }

  private _offsetAt(position: Position): number {
    const lineOffsets = this._getLineOffsets();
    if (position.line >= lineOffsets.length) return this._text.length;
    if (position.line < 0) return 0;
    const lineOffset = lineOffsets[position.line]!;
    const nextLineOffset = position.line + 1 < lineOffsets.length ? lineOffsets[position.line + 1]! : this._text.length;
    return Math.min(lineOffset + position.character, nextLineOffset);
  }

  private _getLineOffsets(): number[] {
    if (this._lineOffsets) return this._lineOffsets;
    const result: number[] = [0];
    const text = this._text;
    for (let i = 0; i < text.length; i++) {
      const ch = text.charCodeAt(i);
      if (ch === 13) {
        if (i + 1 < text.length && text.charCodeAt(i + 1) === 10) i++;
        result.push(i + 1);
      } else if (ch === 10) {
        result.push(i + 1);
      }
    }
    this._lineOffsets = result;
    return result;
  }
}

// ── Registry ────────────────────────────────────────────────────────

export class TextDocumentRegistry {
  private docs = new Map<string, TextDocumentImpl>();
  readonly onDidOpenEmitter = new EventEmitter<TextDocumentImpl>();
  readonly onDidCloseEmitter = new EventEmitter<TextDocumentImpl>();
  readonly onDidChangeEmitter = new EventEmitter<{
    document: TextDocumentImpl;
    contentChanges: Array<{ range: Range; rangeOffset: number; rangeLength: number; text: string }>;
    reason?: number;
  }>();
  readonly onWillSaveEmitter = new EventEmitter<{ document: TextDocumentImpl; reason: number; waitUntil: (thenable: Thenable<unknown>) => void }>();
  readonly onDidSaveEmitter = new EventEmitter<TextDocumentImpl>();

  get all(): TextDocumentImpl[] {
    return Array.from(this.docs.values());
  }

  get(uri: string): TextDocumentImpl | undefined {
    return this.docs.get(uri);
  }

  open(uri: string, uriObj: Uri, languageId: string, version: number, text: string): TextDocumentImpl {
    let doc = this.docs.get(uri);
    if (doc) {
      doc._setText(text, version);
      doc.languageId = languageId;
      return doc;
    }
    doc = new TextDocumentImpl(uriObj, languageId, version, text);
    this.docs.set(uri, doc);
    this.onDidOpenEmitter.fire(doc);
    return doc;
  }

  change(uri: string, version: number, text: string): TextDocumentImpl | null {
    const doc = this.docs.get(uri);
    if (!doc) return null;
    // We receive the whole file text each time; just compute a single full-range edit.
    const prevText = doc.getText();
    const prevEnd = doc.positionAt(prevText.length);
    const change = {
      range: new Range(new Position(0, 0), prevEnd),
      rangeOffset: 0,
      rangeLength: prevText.length,
      text,
    };
    doc._setText(text, version);
    this.onDidChangeEmitter.fire({ document: doc, contentChanges: [change] });
    return doc;
  }

  close(uri: string): void {
    const doc = this.docs.get(uri);
    if (!doc) return;
    doc._markClosed();
    this.docs.delete(uri);
    this.onDidCloseEmitter.fire(doc);
  }

  save(uri: string): void {
    const doc = this.docs.get(uri);
    if (!doc) return;
    this.onDidSaveEmitter.fire(doc);
  }
}

type Thenable<T> = PromiseLike<T>;

export const textDocuments = new TextDocumentRegistry();
