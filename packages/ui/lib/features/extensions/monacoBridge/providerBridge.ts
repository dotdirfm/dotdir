/**
 * Monaco Provider Bridge.
 *
 * Installs Monaco providers that forward invocations to the extension
 * host worker (`provider/invoke`) and reshape the responses back into
 * Monaco's types.
 *
 * One Monaco disposable is tracked per registered provider id so that
 * `provider/unregister` from the worker cleanly tears down the Monaco
 * side.
 */

import type * as Monaco from "monaco-editor/esm/vs/editor/editor.api.js";
import type { DocumentSelectorPayload, ProviderKind } from "../ehProtocol";
import type { ExtensionHostClient, ProviderRegistration } from "../extensionHostClient";
import type {
  rangeToMonaco
} from "./typeAdapters";
import {
  codeActionToMonaco,
  codeLensToMonaco,
  colorInformationToMonaco,
  colorPresentationToMonaco,
  completionListToMonaco,
  docHighlightToMonaco,
  documentLinkToMonaco,
  documentSymbolToMonaco,
  foldingRangeToMonaco,
  hoverToMonaco,
  locationToMonaco,
  monacoPositionToPayload,
  monacoRangeToPayload,
  selectionRangeToMonaco,
  signatureHelpToMonaco,
  symbolInformationToMonaco,
  textEditToMonaco,
  workspaceEditToMonaco,
} from "./typeAdapters";

function languageFilter(selector: DocumentSelectorPayload | undefined): Monaco.languages.LanguageSelector {
  if (!selector) return "*";
  if (typeof selector === "string") return selector;
  if (Array.isArray(selector)) {
    return selector.map((s) => (typeof s === "string" ? s : { language: s.language, scheme: s.scheme, pattern: s.pattern })) as Monaco.languages.LanguageSelector;
  }
  return { language: selector.language, scheme: selector.scheme, pattern: selector.pattern } as Monaco.languages.LanguageSelector;
}

interface BridgeOptions {
  extensionHost: ExtensionHostClient;
  monaco: typeof Monaco;
}

export class MonacoProviderBridge {
  private providerDisposables = new Map<number, Monaco.IDisposable>();
  private registerUnsubscribe?: () => void;
  private unregisterUnsubscribe?: () => void;

  constructor(private options: BridgeOptions) {}

  attach(): void {
    this.registerUnsubscribe = this.options.extensionHost.onProviderRegister((reg) => this.install(reg));
    this.unregisterUnsubscribe = this.options.extensionHost.onProviderUnregister((id) => this.remove(id));
  }

  detach(): void {
    this.registerUnsubscribe?.();
    this.unregisterUnsubscribe?.();
    for (const [, d] of this.providerDisposables) d.dispose();
    this.providerDisposables.clear();
  }

  private install(reg: ProviderRegistration): void {
    const monaco = this.options.monaco;
    const selector = languageFilter(reg.selector);
    const metadata = reg.metadata ?? {};
    const triggerCharacters = Array.isArray((metadata as { triggerCharacters?: string[] }).triggerCharacters)
      ? ((metadata as { triggerCharacters?: string[] }).triggerCharacters ?? [])
      : [];

    let disposable: Monaco.IDisposable | null = null;

    switch (reg.kind) {
      case "completion": {
        const provider: Monaco.languages.CompletionItemProvider = {
          triggerCharacters,
          provideCompletionItems: async (model, position, context) => {
            const word = model.getWordAtPosition(position);
            const defaultRange = word
              ? { startLineNumber: position.lineNumber, endLineNumber: position.lineNumber, startColumn: word.startColumn, endColumn: word.endColumn }
              : { startLineNumber: position.lineNumber, endLineNumber: position.lineNumber, startColumn: position.column, endColumn: position.column };
            // Forward Monaco's CompletionContext verbatim (triggerKind + triggerCharacter).
            // Many language servers (including yaml-language-server via vscode-languageclient)
            // return `isIncomplete: true` and rely on `TriggerForIncompleteCompletions` on
            // subsequent requests while the user keeps typing. Hard-coding `Invoke` breaks
            // that contract and yields empty or generic-looking suggestion lists.
            const result = await this.invoke(reg.providerId, "provideCompletionItems", {
              uri: model.uri.toString(),
              position: monacoPositionToPayload(position),
              context: {
                triggerKind: context.triggerKind,
                ...(context.triggerCharacter != null && context.triggerCharacter !== ""
                  ? { triggerCharacter: context.triggerCharacter }
                  : {}),
              },
            });
            return completionListToMonaco(result as Parameters<typeof completionListToMonaco>[0], defaultRange) ?? undefined;
          },
        };
        disposable = monaco.languages.registerCompletionItemProvider(selector, provider);
        break;
      }
      case "hover": {
        const provider: Monaco.languages.HoverProvider = {
          provideHover: async (model, position) => {
            const result = await this.invoke(reg.providerId, "provideHover", {
              uri: model.uri.toString(),
              position: monacoPositionToPayload(position),
            });
            return hoverToMonaco(result as Parameters<typeof hoverToMonaco>[0]) ?? undefined;
          },
        };
        disposable = monaco.languages.registerHoverProvider(selector, provider);
        break;
      }
      case "definition":
      case "typeDefinition":
      case "implementation":
      case "declaration": {
        const method = reg.kind === "definition" ? "provideDefinition" : reg.kind === "typeDefinition" ? "provideTypeDefinition" : reg.kind === "implementation" ? "provideImplementation" : "provideDeclaration";
        const provider = {
          provideDefinition: async (model: Monaco.editor.ITextModel, position: Monaco.Position) => {
            const res = (await this.invoke(reg.providerId, method, {
              uri: model.uri.toString(),
              position: monacoPositionToPayload(position),
            })) as Array<{ uri: string; range: Parameters<typeof rangeToMonaco>[0] }> | null;
            if (!res) return undefined;
            return res.map((l) => locationToMonaco(l, monaco));
          },
        };
        if (reg.kind === "definition") disposable = monaco.languages.registerDefinitionProvider(selector, provider);
        else if (reg.kind === "typeDefinition") disposable = monaco.languages.registerTypeDefinitionProvider(selector, { provideTypeDefinition: provider.provideDefinition });
        else if (reg.kind === "implementation") disposable = monaco.languages.registerImplementationProvider(selector, { provideImplementation: provider.provideDefinition });
        else disposable = monaco.languages.registerDeclarationProvider(selector, { provideDeclaration: provider.provideDefinition });
        break;
      }
      case "reference": {
        const provider: Monaco.languages.ReferenceProvider = {
          provideReferences: async (model, position, context) => {
            const res = (await this.invoke(reg.providerId, "provideReferences", {
              uri: model.uri.toString(),
              position: monacoPositionToPayload(position),
              context: { includeDeclaration: context.includeDeclaration },
            })) as Array<{ uri: string; range: Parameters<typeof rangeToMonaco>[0] }> | null;
            if (!res) return [];
            return res.map((l) => locationToMonaco(l, monaco));
          },
        };
        disposable = monaco.languages.registerReferenceProvider(selector, provider);
        break;
      }
      case "documentHighlight": {
        const provider: Monaco.languages.DocumentHighlightProvider = {
          provideDocumentHighlights: async (model, position) => {
            const res = (await this.invoke(reg.providerId, "provideDocumentHighlights", {
              uri: model.uri.toString(),
              position: monacoPositionToPayload(position),
            })) as Parameters<typeof docHighlightToMonaco>[0][] | null;
            return res?.map(docHighlightToMonaco) ?? [];
          },
        };
        disposable = monaco.languages.registerDocumentHighlightProvider(selector, provider);
        break;
      }
      case "documentSymbol": {
        const provider: Monaco.languages.DocumentSymbolProvider = {
          provideDocumentSymbols: async (model) => {
            const res = (await this.invoke(reg.providerId, "provideDocumentSymbols", {
              uri: model.uri.toString(),
            })) as Array<Parameters<typeof documentSymbolToMonaco>[0]> | null;
            if (!res) return [];
            // Distinguish DocumentSymbol vs SymbolInformation: SymbolInformation has `.location`.
            return res.map((s) => {
              const maybe = s as unknown as { location?: unknown };
              if (maybe.location) return symbolInformationToMonaco(s as unknown as Parameters<typeof symbolInformationToMonaco>[0], monaco);
              return documentSymbolToMonaco(s);
            });
          },
        };
        disposable = monaco.languages.registerDocumentSymbolProvider(selector, provider);
        break;
      }
      case "documentFormatting": {
        const provider: Monaco.languages.DocumentFormattingEditProvider = {
          provideDocumentFormattingEdits: async (model, options) => {
            const res = (await this.invoke(reg.providerId, "provideDocumentFormattingEdits", {
              uri: model.uri.toString(),
              options: { tabSize: options.tabSize, insertSpaces: options.insertSpaces },
            })) as Parameters<typeof textEditToMonaco>[0][] | null;
            return res?.map(textEditToMonaco) ?? [];
          },
        };
        disposable = monaco.languages.registerDocumentFormattingEditProvider(selector, provider);
        break;
      }
      case "documentRangeFormatting": {
        const provider: Monaco.languages.DocumentRangeFormattingEditProvider = {
          provideDocumentRangeFormattingEdits: async (model, range, options) => {
            const res = (await this.invoke(reg.providerId, "provideDocumentRangeFormattingEdits", {
              uri: model.uri.toString(),
              range: monacoRangeToPayload(range),
              options: { tabSize: options.tabSize, insertSpaces: options.insertSpaces },
            })) as Parameters<typeof textEditToMonaco>[0][] | null;
            return res?.map(textEditToMonaco) ?? [];
          },
        };
        disposable = monaco.languages.registerDocumentRangeFormattingEditProvider(selector, provider);
        break;
      }
      case "onTypeFormatting": {
        const metaTriggers = (metadata as { triggerCharacters?: string[] }).triggerCharacters ?? [];
        const provider: Monaco.languages.OnTypeFormattingEditProvider = {
          autoFormatTriggerCharacters: metaTriggers,
          provideOnTypeFormattingEdits: async (model, position, ch, options) => {
            const res = (await this.invoke(reg.providerId, "provideOnTypeFormattingEdits", {
              uri: model.uri.toString(),
              position: monacoPositionToPayload(position),
              ch,
              options: { tabSize: options.tabSize, insertSpaces: options.insertSpaces },
            })) as Parameters<typeof textEditToMonaco>[0][] | null;
            return res?.map(textEditToMonaco) ?? [];
          },
        };
        disposable = monaco.languages.registerOnTypeFormattingEditProvider(selector, provider);
        break;
      }
      case "rename": {
        const provider: Monaco.languages.RenameProvider = {
          provideRenameEdits: async (model, position, newName) => {
            const res = (await this.invoke(reg.providerId, "provideRenameEdits", {
              uri: model.uri.toString(),
              position: monacoPositionToPayload(position),
              newName,
            })) as Parameters<typeof workspaceEditToMonaco>[0] | null;
            if (!res) return { edits: [] };
            return workspaceEditToMonaco(res, monaco);
          },
        };
        disposable = monaco.languages.registerRenameProvider(selector, provider);
        break;
      }
      case "folding": {
        const provider: Monaco.languages.FoldingRangeProvider = {
          provideFoldingRanges: async (model) => {
            const res = (await this.invoke(reg.providerId, "provideFoldingRanges", {
              uri: model.uri.toString(),
            })) as Parameters<typeof foldingRangeToMonaco>[0][] | null;
            return res?.map(foldingRangeToMonaco) ?? [];
          },
        };
        disposable = monaco.languages.registerFoldingRangeProvider(selector, provider);
        break;
      }
      case "selectionRange": {
        const provider: Monaco.languages.SelectionRangeProvider = {
          provideSelectionRanges: async (model, positions) => {
            const res = (await this.invoke(reg.providerId, "provideSelectionRanges", {
              uri: model.uri.toString(),
              context: { positions: positions.map((p) => monacoPositionToPayload(p)) },
            })) as Parameters<typeof selectionRangeToMonaco>[0][] | null;
            if (!res) return [];
            return res.map((r) => [selectionRangeToMonaco(r)]);
          },
        };
        disposable = monaco.languages.registerSelectionRangeProvider(selector, provider);
        break;
      }
      case "signatureHelp": {
        const triggerCharacters = (metadata as { triggers?: Array<string | { triggerCharacters?: string[]; retriggerCharacters?: string[] }> }).triggers ?? [];
        const tc: string[] = [];
        const rc: string[] = [];
        for (const t of triggerCharacters) {
          if (typeof t === "string") tc.push(t);
          else {
            for (const x of t.triggerCharacters ?? []) tc.push(x);
            for (const x of t.retriggerCharacters ?? []) rc.push(x);
          }
        }
        const provider: Monaco.languages.SignatureHelpProvider = {
          signatureHelpTriggerCharacters: tc,
          signatureHelpRetriggerCharacters: rc,
          provideSignatureHelp: async (model, position) => {
            const res = (await this.invoke(reg.providerId, "provideSignatureHelp", {
              uri: model.uri.toString(),
              position: monacoPositionToPayload(position),
            })) as Parameters<typeof signatureHelpToMonaco>[0];
            const conv = signatureHelpToMonaco(res);
            if (!conv) return null;
            return { value: conv, dispose: () => {} };
          },
        };
        disposable = monaco.languages.registerSignatureHelpProvider(selector, provider);
        break;
      }
      case "codeAction": {
        const provider: Monaco.languages.CodeActionProvider = {
          provideCodeActions: async (model, range, context) => {
            const res = (await this.invoke(reg.providerId, "provideCodeActions", {
              uri: model.uri.toString(),
              range: monacoRangeToPayload(range),
              context: { only: context.only, diagnostics: context.markers.map((m) => ({ message: m.message, severity: m.severity })) },
            })) as Parameters<typeof codeActionToMonaco>[0][] | null;
            const actions = res?.map((a) => codeActionToMonaco(a, monaco)) ?? [];
            return { actions, dispose: () => {} };
          },
        };
        disposable = monaco.languages.registerCodeActionProvider(selector, provider);
        break;
      }
      case "codeLens": {
        const provider: Monaco.languages.CodeLensProvider = {
          provideCodeLenses: async (model) => {
            const res = (await this.invoke(reg.providerId, "provideCodeLenses", {
              uri: model.uri.toString(),
            })) as Parameters<typeof codeLensToMonaco>[0][] | null;
            return { lenses: res?.map(codeLensToMonaco) ?? [], dispose: () => {} };
          },
        };
        disposable = monaco.languages.registerCodeLensProvider(selector, provider);
        break;
      }
      case "color": {
        const provider: Monaco.languages.DocumentColorProvider = {
          provideDocumentColors: async (model) => {
            const res = (await this.invoke(reg.providerId, "provideDocumentColors", {
              uri: model.uri.toString(),
            })) as Parameters<typeof colorInformationToMonaco>[0][] | null;
            return res?.map(colorInformationToMonaco) ?? [];
          },
          provideColorPresentations: async (model, colorInfo) => {
            const res = (await this.invoke(reg.providerId, "provideColorPresentations", {
              uri: model.uri.toString(),
              range: monacoRangeToPayload(colorInfo.range),
              context: { color: colorInfo.color },
            })) as Parameters<typeof colorPresentationToMonaco>[0][] | null;
            return res?.map(colorPresentationToMonaco) ?? [];
          },
        };
        disposable = monaco.languages.registerColorProvider(selector, provider);
        break;
      }
      case "documentLink": {
        const provider: Monaco.languages.LinkProvider = {
          provideLinks: async (model) => {
            const res = (await this.invoke(reg.providerId, "provideDocumentLinks", {
              uri: model.uri.toString(),
            })) as Parameters<typeof documentLinkToMonaco>[0][] | null;
            return { links: res?.map((l) => documentLinkToMonaco(l, monaco)) ?? [] };
          },
        };
        disposable = monaco.languages.registerLinkProvider(selector, provider);
        break;
      }
      default:
        this.warn(`Provider kind ${reg.kind} not installed on Monaco`);
        return;
    }

    if (disposable) this.providerDisposables.set(reg.providerId, disposable);
  }

  private remove(id: number): void {
    const d = this.providerDisposables.get(id);
    if (!d) return;
    this.providerDisposables.delete(id);
    try {
      d.dispose();
    } catch (err) {
      console.warn("[MonacoProviderBridge] dispose failed", err);
    }
  }

  private async invoke(providerId: number, method: string, args: Record<string, unknown>): Promise<unknown> {
    try {
      return await this.options.extensionHost.invokeProvider(providerId, method, args);
    } catch (err) {
      console.warn(`[MonacoProviderBridge] ${method} failed`, err);
      return null;
    }
  }

  private warn(message: string): void {
    console.warn(`[MonacoProviderBridge] ${message}`);
  }
}

export function createMonacoProviderBridge(monaco: typeof Monaco, extensionHost: ExtensionHostClient): MonacoProviderBridge {
  return new MonacoProviderBridge({ monaco, extensionHost });
}

export type { ProviderKind };
