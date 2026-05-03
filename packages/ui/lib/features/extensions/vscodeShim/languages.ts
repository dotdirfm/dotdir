/**
 * vscode.languages — provider registrations + DiagnosticCollection.
 *
 * All registrations are bookkept locally and also announced to the main
 * thread so Monaco can install matching adapter providers. Invocations
 * come back in as `provider/invoke` messages which are dispatched in
 * `extensionHost.worker.ts`.
 */

import type { DocumentSelectorPayload, ProviderKind } from "../ehProtocol";
import { DiagnosticSeverity } from "./enums";
import { Disposable, EventEmitter } from "./events";
import { allocProviderId, getRpc, registerProvider, unregisterProvider } from "./runtime";
import { Diagnostic, Range, Uri } from "./types";
import type { TextDocumentImpl } from "./textDocument";

export type DocumentSelector = DocumentSelectorPayload;

function normalizeSelector(selector: unknown): DocumentSelector {
  if (selector == null) return { language: "plaintext" };
  return selector as DocumentSelector;
}

function makeProviderDisposable(kind: ProviderKind, selector: DocumentSelector, provider: unknown, metadata?: Record<string, unknown>): Disposable {
  const id = allocProviderId();
  registerProvider({ id, kind, selector, provider, metadata });
  return new Disposable(() => unregisterProvider(id));
}

// ── DiagnosticCollection ────────────────────────────────────────────

const onDidChangeDiagnosticsEmitter = new EventEmitter<{ uris: Uri[] }>();

export interface DiagnosticCollection {
  readonly name: string;
  set(uri: Uri, diagnostics?: ReadonlyArray<Diagnostic>): void;
  set(entries: ReadonlyArray<[Uri, ReadonlyArray<Diagnostic>]>): void;
  delete(uri: Uri): void;
  clear(): void;
  forEach(callback: (uri: Uri, diagnostics: ReadonlyArray<Diagnostic>, collection: DiagnosticCollection) => unknown): void;
  get(uri: Uri): ReadonlyArray<Diagnostic> | undefined;
  has(uri: Uri): boolean;
  dispose(): void;
}

class DiagnosticCollectionImpl implements DiagnosticCollection {
  readonly name: string;
  private _data = new Map<string, Diagnostic[]>();
  private _disposed = false;

  constructor(name: string) {
    this.name = name;
  }

  set(...args: unknown[]): void {
    if (this._disposed) return;
    if (args.length === 1 && Array.isArray(args[0])) {
      // bulk form
      const entries = args[0] as Array<[Uri, ReadonlyArray<Diagnostic>]>;
      const changedUris: Uri[] = [];
      for (const [uri, diagnostics] of entries) {
        const key = uri.toString();
        this._data.set(key, (diagnostics ?? []).slice());
        changedUris.push(uri);
        this._publish(uri, diagnostics ?? []);
      }
      onDidChangeDiagnosticsEmitter.fire({ uris: changedUris });
      return;
    }
    const uri = args[0] as Uri;
    const diagnostics = (args[1] as ReadonlyArray<Diagnostic>) ?? [];
    const key = uri.toString();
    this._data.set(key, diagnostics.slice());
    this._publish(uri, diagnostics);
    onDidChangeDiagnosticsEmitter.fire({ uris: [uri] });
  }

  delete(uri: Uri): void {
    if (this._disposed) return;
    if (this._data.delete(uri.toString())) {
      this._publish(uri, []);
      onDidChangeDiagnosticsEmitter.fire({ uris: [uri] });
    }
  }

  clear(): void {
    if (this._disposed) return;
    const uris: Uri[] = [];
    for (const [key] of this._data) {
      const uri = Uri.parse(key);
      uris.push(uri);
      this._publish(uri, []);
    }
    this._data.clear();
    if (uris.length) onDidChangeDiagnosticsEmitter.fire({ uris });
  }

  forEach(cb: (uri: Uri, diagnostics: ReadonlyArray<Diagnostic>, collection: DiagnosticCollection) => unknown): void {
    for (const [key, diags] of this._data) {
      cb(Uri.parse(key), diags, this);
    }
  }

  get(uri: Uri): ReadonlyArray<Diagnostic> | undefined {
    return this._data.get(uri.toString())?.slice();
  }

  has(uri: Uri): boolean {
    return this._data.has(uri.toString());
  }

  dispose(): void {
    if (this._disposed) return;
    this.clear();
    this._disposed = true;
  }

  private _publish(uri: Uri, diagnostics: ReadonlyArray<Diagnostic>): void {
    const payloads = diagnostics.map((d) => ({
      range: {
        start: { line: d.range.start.line, character: d.range.start.character },
        end: { line: d.range.end.line, character: d.range.end.character },
      },
      message: d.message,
      severity: d.severity ?? DiagnosticSeverity.Error,
      source: d.source,
      code:
        d.code && typeof d.code === "object" && "target" in d.code
          ? { value: d.code.value, target: d.code.target.toString() }
          : (d.code as string | number | undefined),
      tags: d.tags,
    }));
    getRpc().send({
      type: "diagnostics/set",
      owner: this.name,
      uri: uri.toString(),
      diagnostics: payloads,
    });
  }
}

export function createDiagnosticCollection(name = "default"): DiagnosticCollection {
  return new DiagnosticCollectionImpl(name);
}

// ── languages.getDiagnostics (stub — return empty) ─────────────────

export function getDiagnostics(_uri?: Uri): ReadonlyArray<Diagnostic> | ReadonlyArray<[Uri, ReadonlyArray<Diagnostic>]> {
  return [];
}

// ── languages.match ────────────────────────────────────────────────

export function match(selector: DocumentSelector, document: TextDocumentImpl): number {
  const filters = Array.isArray(selector) ? selector : [selector];
  let best = 0;
  for (const f of filters) {
    const score = scoreFilter(f, document);
    if (score > best) best = score;
  }
  return best;
}

function scoreFilter(filter: string | { language?: string; scheme?: string; pattern?: string }, doc: TextDocumentImpl): number {
  if (typeof filter === "string") {
    return filter === "*" || filter === doc.languageId ? 10 : 0;
  }
  let score = 0;
  if (filter.language) {
    if (filter.language === "*") score = Math.max(score, 5);
    else if (filter.language === doc.languageId) score = 10;
    else return 0;
  }
  if (filter.scheme) {
    if (filter.scheme === "*" || filter.scheme === doc.uri.scheme) score = Math.max(score, 10);
    else return 0;
  }
  return score || 1;
}

// ── Individual provider registrations ───────────────────────────────

export function registerCompletionItemProvider(
  selector: DocumentSelector,
  provider: unknown,
  ...triggerCharacters: string[]
): Disposable {
  return makeProviderDisposable("completion", normalizeSelector(selector), provider, { triggerCharacters });
}

export function registerHoverProvider(selector: DocumentSelector, provider: unknown): Disposable {
  return makeProviderDisposable("hover", normalizeSelector(selector), provider);
}

export function registerDefinitionProvider(selector: DocumentSelector, provider: unknown): Disposable {
  return makeProviderDisposable("definition", normalizeSelector(selector), provider);
}

export function registerTypeDefinitionProvider(selector: DocumentSelector, provider: unknown): Disposable {
  return makeProviderDisposable("typeDefinition", normalizeSelector(selector), provider);
}

export function registerImplementationProvider(selector: DocumentSelector, provider: unknown): Disposable {
  return makeProviderDisposable("implementation", normalizeSelector(selector), provider);
}

export function registerDeclarationProvider(selector: DocumentSelector, provider: unknown): Disposable {
  return makeProviderDisposable("declaration", normalizeSelector(selector), provider);
}

export function registerReferenceProvider(selector: DocumentSelector, provider: unknown): Disposable {
  return makeProviderDisposable("reference", normalizeSelector(selector), provider);
}

export function registerDocumentHighlightProvider(selector: DocumentSelector, provider: unknown): Disposable {
  return makeProviderDisposable("documentHighlight", normalizeSelector(selector), provider);
}

export function registerDocumentSymbolProvider(selector: DocumentSelector, provider: unknown): Disposable {
  return makeProviderDisposable("documentSymbol", normalizeSelector(selector), provider);
}

export function registerWorkspaceSymbolProvider(provider: unknown): Disposable {
  return makeProviderDisposable("workspaceSymbol", "*", provider);
}

export function registerCodeActionsProvider(
  selector: DocumentSelector,
  provider: unknown,
  metadata?: { providedCodeActionKinds?: { value: string }[] },
): Disposable {
  return makeProviderDisposable("codeAction", normalizeSelector(selector), provider, { metadata });
}

export function registerCodeLensProvider(selector: DocumentSelector, provider: unknown): Disposable {
  return makeProviderDisposable("codeLens", normalizeSelector(selector), provider);
}

export function registerDocumentFormattingEditProvider(selector: DocumentSelector, provider: unknown): Disposable {
  return makeProviderDisposable("documentFormatting", normalizeSelector(selector), provider);
}

export function registerDocumentRangeFormattingEditProvider(selector: DocumentSelector, provider: unknown): Disposable {
  return makeProviderDisposable("documentRangeFormatting", normalizeSelector(selector), provider);
}

export function registerOnTypeFormattingEditProvider(
  selector: DocumentSelector,
  provider: unknown,
  firstTriggerCharacter: string,
  ...moreTriggerCharacters: string[]
): Disposable {
  return makeProviderDisposable("onTypeFormatting", normalizeSelector(selector), provider, {
    triggerCharacters: [firstTriggerCharacter, ...moreTriggerCharacters],
  });
}

export function registerRenameProvider(selector: DocumentSelector, provider: unknown): Disposable {
  return makeProviderDisposable("rename", normalizeSelector(selector), provider);
}

export function registerLinkedEditingRangeProvider(selector: DocumentSelector, provider: unknown): Disposable {
  return makeProviderDisposable("linkedEditingRange", normalizeSelector(selector), provider);
}

export function registerDocumentLinkProvider(selector: DocumentSelector, provider: unknown): Disposable {
  return makeProviderDisposable("documentLink", normalizeSelector(selector), provider);
}

export function registerColorProvider(selector: DocumentSelector, provider: unknown): Disposable {
  return makeProviderDisposable("color", normalizeSelector(selector), provider);
}

export function registerFoldingRangeProvider(selector: DocumentSelector, provider: unknown): Disposable {
  return makeProviderDisposable("folding", normalizeSelector(selector), provider);
}

export function registerSelectionRangeProvider(selector: DocumentSelector, provider: unknown): Disposable {
  return makeProviderDisposable("selectionRange", normalizeSelector(selector), provider);
}

export function registerSignatureHelpProvider(
  selector: DocumentSelector,
  provider: unknown,
  ...triggers: Array<string | { triggerCharacters?: string[]; retriggerCharacters?: string[] }>
): Disposable {
  return makeProviderDisposable("signatureHelp", normalizeSelector(selector), provider, { triggers });
}

export function registerCallHierarchyProvider(selector: DocumentSelector, provider: unknown): Disposable {
  return makeProviderDisposable("callHierarchy", normalizeSelector(selector), provider);
}

export function registerDocumentSemanticTokensProvider(
  selector: DocumentSelector,
  provider: unknown,
  legend: unknown,
): Disposable {
  return makeProviderDisposable("documentSemanticTokens", normalizeSelector(selector), provider, { legend });
}

export function registerDocumentRangeSemanticTokensProvider(
  selector: DocumentSelector,
  provider: unknown,
  legend: unknown,
): Disposable {
  return makeProviderDisposable("documentRangeSemanticTokens", normalizeSelector(selector), provider, { legend });
}

export function registerInlayHintsProvider(_selector: DocumentSelector, _provider: unknown): Disposable {
  return new Disposable(() => {});
}

export function registerInlineValuesProvider(_selector: DocumentSelector, _provider: unknown): Disposable {
  return new Disposable(() => {});
}

export function registerInlineCompletionItemProvider(_selector: DocumentSelector, _provider: unknown): Disposable {
  return new Disposable(() => {});
}

export function registerEvaluatableExpressionProvider(_selector: DocumentSelector, _provider: unknown): Disposable {
  return new Disposable(() => {});
}

export function registerTypeHierarchyProvider(_selector: DocumentSelector, _provider: unknown): Disposable {
  return new Disposable(() => {});
}

export function registerMultiDocumentHighlightProvider(_selector: DocumentSelector, _provider: unknown): Disposable {
  return new Disposable(() => {});
}

export function setTextDocumentLanguage(doc: TextDocumentImpl, languageId: string): Promise<TextDocumentImpl> {
  doc.languageId = languageId;
  return Promise.resolve(doc);
}

export function setLanguageConfiguration(_language: string, _configuration: unknown): Disposable {
  return new Disposable(() => {});
}

export async function getLanguages(): Promise<string[]> {
  return [];
}

// ── Language status item ────────────────────────────────────────────

import { LanguageStatusSeverity } from "./enums";

interface LanguageStatusItem {
  id: string;
  name?: string;
  selector: DocumentSelector;
  severity: LanguageStatusSeverity;
  text: string;
  detail?: string;
  busy: boolean;
  command?: { command: string; title: string; arguments?: unknown[] };
  dispose(): void;
}

export function createLanguageStatusItem(id: string, selector: DocumentSelector): LanguageStatusItem {
  return {
    id,
    selector,
    severity: LanguageStatusSeverity.Information,
    text: "",
    busy: false,
    dispose: () => {},
  };
}

// ── Assembled namespace ────────────────────────────────────────────

export const languages = {
  match,
  createDiagnosticCollection,
  getDiagnostics,
  onDidChangeDiagnostics: onDidChangeDiagnosticsEmitter.event,
  getLanguages,
  setLanguageConfiguration,
  setTextDocumentLanguage,
  registerCompletionItemProvider,
  registerHoverProvider,
  registerDefinitionProvider,
  registerTypeDefinitionProvider,
  registerImplementationProvider,
  registerDeclarationProvider,
  registerReferenceProvider,
  registerDocumentHighlightProvider,
  registerDocumentSymbolProvider,
  registerWorkspaceSymbolProvider,
  registerCodeActionsProvider,
  registerCodeActionProvider: registerCodeActionsProvider,
  registerCodeLensProvider,
  registerDocumentFormattingEditProvider,
  registerDocumentRangeFormattingEditProvider,
  registerOnTypeFormattingEditProvider,
  registerRenameProvider,
  registerLinkedEditingRangeProvider,
  registerDocumentLinkProvider,
  registerColorProvider,
  registerFoldingRangeProvider,
  registerSelectionRangeProvider,
  registerSignatureHelpProvider,
  registerCallHierarchyProvider,
  registerDocumentSemanticTokensProvider,
  registerDocumentRangeSemanticTokensProvider,
  registerInlayHintsProvider,
  registerInlineValuesProvider,
  registerInlineCompletionItemProvider,
  registerEvaluatableExpressionProvider,
  registerTypeHierarchyProvider,
  registerMultiDocumentHighlightProvider,
  createLanguageStatusItem,
};

// Helper used by extensionHost.worker.ts to dispatch provider calls.
export function rangeFromPayload(payload: { start: { line: number; character: number }; end: { line: number; character: number } }): Range {
  return new Range(payload.start.line, payload.start.character, payload.end.line, payload.end.character);
}
