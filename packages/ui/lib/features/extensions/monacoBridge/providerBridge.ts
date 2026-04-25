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
import type { CompletionListPayload, DocumentSelectorPayload, ProviderKind } from "../ehProtocol";
import type { ExtensionHostClient, ProviderRegistration } from "../extensionHostClient";
import { isMonacoProviderSupported, providerDefinition } from "../providerDefinitions";
import type { rangeToMonaco } from "./typeAdapters";
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

interface CancellationTokenLike {
  readonly isCancellationRequested?: boolean;
  onCancellationRequested(listener: () => void): { dispose(): void };
}

const COMPLETION_COMMAND_RELAY_ID = "dotdir.extension.executeCompletionCommand";

export class MonacoProviderBridge {
  private providerDisposables = new Map<number, Monaco.IDisposable>();
  private registerUnsubscribe?: () => void;
  private unregisterUnsubscribe?: () => void;
  private completionCommandRelayDisposable?: Monaco.IDisposable;
  private loggedUnsupportedKinds = new Set<ProviderKind>();

  constructor(private options: BridgeOptions) {}

  attach(): void {
    this.completionCommandRelayDisposable = this.options.monaco.editor.registerCommand(
      COMPLETION_COMMAND_RELAY_ID,
      (_accessor, commandId: unknown, commandArgs: unknown) => {
        const id = typeof commandId === "string" ? commandId : "";
        if (!id) return;
        const args = Array.isArray(commandArgs) ? commandArgs : [];
        void this.options.extensionHost.executeCommand(id, args).catch((err) => {
          console.warn(`[MonacoProviderBridge] completion command ${id} failed`, err);
        });
      },
    );
    this.registerUnsubscribe = this.options.extensionHost.onProviderRegister((reg) => this.install(reg));
    this.unregisterUnsubscribe = this.options.extensionHost.onProviderUnregister((id) => this.remove(id));
  }

  detach(): void {
    this.completionCommandRelayDisposable?.dispose();
    this.completionCommandRelayDisposable = undefined;
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
          provideCompletionItems: async (model, position, context, token) => {
            const word = model.getWordAtPosition(position);
            const defaultRange = word
              ? { startLineNumber: position.lineNumber, endLineNumber: position.lineNumber, startColumn: word.startColumn, endColumn: word.endColumn }
              : { startLineNumber: position.lineNumber, endLineNumber: position.lineNumber, startColumn: position.column, endColumn: position.column };
            // Forward Monaco's CompletionContext verbatim (triggerKind + triggerCharacter).
            // Many language servers (including yaml-language-server via vscode-languageclient)
            // return `isIncomplete: true` and rely on `TriggerForIncompleteCompletions` on
            // subsequent requests while the user keeps typing. Hard-coding `Invoke` breaks
            // that contract and yields empty or generic-looking suggestion lists.
            const result = await this.invoke(
              reg.providerId,
              "provideCompletionItems",
              {
                uri: model.uri.toString(),
                position: monacoPositionToPayload(position),
                context: {
                  triggerKind: context.triggerKind,
                  ...(context.triggerCharacter != null && context.triggerCharacter !== ""
                    ? { triggerCharacter: context.triggerCharacter }
                    : {}),
                },
              },
              token,
            );
            const payload = result as CompletionListPayload | null;
            const completionList = completionListToMonaco(payload, defaultRange);
            if (!completionList || !payload) return completionList ?? undefined;
            this.rewriteCompletionCommands(completionList, payload);
            return completionList;
          },
        };
        disposable = monaco.languages.registerCompletionItemProvider(selector, provider);
        break;
      }
      case "hover": {
        const provider: Monaco.languages.HoverProvider = {
          provideHover: async (model, position, token) => {
            const result = await this.invoke(reg.providerId, "provideHover", {
              uri: model.uri.toString(),
              position: monacoPositionToPayload(position),
            }, token);
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
          provideDefinition: async (model: Monaco.editor.ITextModel, position: Monaco.Position, token?: CancellationTokenLike) => {
            const res = (await this.invoke(reg.providerId, method, {
              uri: model.uri.toString(),
              position: monacoPositionToPayload(position),
            }, token)) as Array<{ uri: string; range: Parameters<typeof rangeToMonaco>[0] }> | null;
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
          provideReferences: async (model, position, context, token) => {
            const res = (await this.invoke(reg.providerId, "provideReferences", {
              uri: model.uri.toString(),
              position: monacoPositionToPayload(position),
              context: { includeDeclaration: context.includeDeclaration },
            }, token)) as Array<{ uri: string; range: Parameters<typeof rangeToMonaco>[0] }> | null;
            if (!res) return [];
            return res.map((l) => locationToMonaco(l, monaco));
          },
        };
        disposable = monaco.languages.registerReferenceProvider(selector, provider);
        break;
      }
      case "documentHighlight": {
        const provider: Monaco.languages.DocumentHighlightProvider = {
          provideDocumentHighlights: async (model, position, token) => {
            const res = (await this.invoke(reg.providerId, "provideDocumentHighlights", {
              uri: model.uri.toString(),
              position: monacoPositionToPayload(position),
            }, token)) as Parameters<typeof docHighlightToMonaco>[0][] | null;
            return res?.map(docHighlightToMonaco) ?? [];
          },
        };
        disposable = monaco.languages.registerDocumentHighlightProvider(selector, provider);
        break;
      }
      case "documentSymbol": {
        const provider: Monaco.languages.DocumentSymbolProvider = {
          provideDocumentSymbols: async (model, token) => {
            const res = (await this.invoke(reg.providerId, "provideDocumentSymbols", {
              uri: model.uri.toString(),
            }, token)) as Array<Parameters<typeof documentSymbolToMonaco>[0]> | null;
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
          provideDocumentFormattingEdits: async (model, options, token) => {
            const res = (await this.invoke(reg.providerId, "provideDocumentFormattingEdits", {
              uri: model.uri.toString(),
              options: { tabSize: options.tabSize, insertSpaces: options.insertSpaces },
            }, token)) as Parameters<typeof textEditToMonaco>[0][] | null;
            return res?.map(textEditToMonaco) ?? [];
          },
        };
        disposable = monaco.languages.registerDocumentFormattingEditProvider(selector, provider);
        break;
      }
      case "documentRangeFormatting": {
        const provider: Monaco.languages.DocumentRangeFormattingEditProvider = {
          provideDocumentRangeFormattingEdits: async (model, range, options, token) => {
            const res = (await this.invoke(reg.providerId, "provideDocumentRangeFormattingEdits", {
              uri: model.uri.toString(),
              range: monacoRangeToPayload(range),
              options: { tabSize: options.tabSize, insertSpaces: options.insertSpaces },
            }, token)) as Parameters<typeof textEditToMonaco>[0][] | null;
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
          provideOnTypeFormattingEdits: async (model, position, ch, options, token) => {
            const res = (await this.invoke(reg.providerId, "provideOnTypeFormattingEdits", {
              uri: model.uri.toString(),
              position: monacoPositionToPayload(position),
              ch,
              options: { tabSize: options.tabSize, insertSpaces: options.insertSpaces },
            }, token)) as Parameters<typeof textEditToMonaco>[0][] | null;
            return res?.map(textEditToMonaco) ?? [];
          },
        };
        disposable = monaco.languages.registerOnTypeFormattingEditProvider(selector, provider);
        break;
      }
      case "rename": {
        const provider: Monaco.languages.RenameProvider = {
          provideRenameEdits: async (model, position, newName, token) => {
            const res = (await this.invoke(reg.providerId, "provideRenameEdits", {
              uri: model.uri.toString(),
              position: monacoPositionToPayload(position),
              newName,
            }, token)) as Parameters<typeof workspaceEditToMonaco>[0] | null;
            if (!res) return { edits: [] };
            return workspaceEditToMonaco(res, monaco);
          },
        };
        disposable = monaco.languages.registerRenameProvider(selector, provider);
        break;
      }
      case "folding": {
        const provider: Monaco.languages.FoldingRangeProvider = {
          provideFoldingRanges: async (model, _context, token) => {
            const res = (await this.invoke(reg.providerId, "provideFoldingRanges", {
              uri: model.uri.toString(),
            }, token)) as Parameters<typeof foldingRangeToMonaco>[0][] | null;
            return res?.map(foldingRangeToMonaco) ?? [];
          },
        };
        disposable = monaco.languages.registerFoldingRangeProvider(selector, provider);
        break;
      }
      case "selectionRange": {
        const provider: Monaco.languages.SelectionRangeProvider = {
          provideSelectionRanges: async (model, positions, token) => {
            const res = (await this.invoke(reg.providerId, "provideSelectionRanges", {
              uri: model.uri.toString(),
              context: { positions: positions.map((p) => monacoPositionToPayload(p)) },
            }, token)) as Parameters<typeof selectionRangeToMonaco>[0][] | null;
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
          provideSignatureHelp: async (model, position, token) => {
            const res = (await this.invoke(reg.providerId, "provideSignatureHelp", {
              uri: model.uri.toString(),
              position: monacoPositionToPayload(position),
            }, token)) as Parameters<typeof signatureHelpToMonaco>[0];
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
          provideCodeActions: async (model, range, context, token) => {
            const res = (await this.invoke(reg.providerId, "provideCodeActions", {
              uri: model.uri.toString(),
              range: monacoRangeToPayload(range),
              context: { only: context.only, diagnostics: context.markers.map((m) => ({ message: m.message, severity: m.severity })) },
            }, token)) as Parameters<typeof codeActionToMonaco>[0][] | null;
            const actions = res?.map((a) => codeActionToMonaco(a, monaco)) ?? [];
            return { actions, dispose: () => {} };
          },
        };
        disposable = monaco.languages.registerCodeActionProvider(selector, provider);
        break;
      }
      case "codeLens": {
        const provider: Monaco.languages.CodeLensProvider = {
          provideCodeLenses: async (model, token) => {
            const res = (await this.invoke(reg.providerId, "provideCodeLenses", {
              uri: model.uri.toString(),
            }, token)) as Parameters<typeof codeLensToMonaco>[0][] | null;
            return { lenses: res?.map(codeLensToMonaco) ?? [], dispose: () => {} };
          },
        };
        disposable = monaco.languages.registerCodeLensProvider(selector, provider);
        break;
      }
      case "color": {
        const provider: Monaco.languages.DocumentColorProvider = {
          provideDocumentColors: async (model, token) => {
            const res = (await this.invoke(reg.providerId, "provideDocumentColors", {
              uri: model.uri.toString(),
            }, token)) as Parameters<typeof colorInformationToMonaco>[0][] | null;
            return res?.map(colorInformationToMonaco) ?? [];
          },
          provideColorPresentations: async (model, colorInfo, token) => {
            const res = (await this.invoke(reg.providerId, "provideColorPresentations", {
              uri: model.uri.toString(),
              range: monacoRangeToPayload(colorInfo.range),
              context: { color: colorInfo.color },
            }, token)) as Parameters<typeof colorPresentationToMonaco>[0][] | null;
            return res?.map(colorPresentationToMonaco) ?? [];
          },
        };
        disposable = monaco.languages.registerColorProvider(selector, provider);
        break;
      }
      case "documentLink": {
        const provider: Monaco.languages.LinkProvider = {
          provideLinks: async (model, token) => {
            const res = (await this.invoke(reg.providerId, "provideDocumentLinks", {
              uri: model.uri.toString(),
            }, token)) as Parameters<typeof documentLinkToMonaco>[0][] | null;
            return { links: res?.map((l) => documentLinkToMonaco(l, monaco)) ?? [] };
          },
        };
        disposable = monaco.languages.registerLinkProvider(selector, provider);
        break;
      }
      default:
        if (!isMonacoProviderSupported(reg.kind)) {
          // Known gap between VS Code provider surface and Monaco bridge support.
          // Log once per kind to keep console noise low during extension startup.
          if (!this.loggedUnsupportedKinds.has(reg.kind)) {
            this.loggedUnsupportedKinds.add(reg.kind);
            const definition = providerDefinition(reg.kind);
            this.info(`Provider kind ${reg.kind} is currently unsupported by Monaco bridge: ${definition.reason ?? "no adapter registered"}`);
          }
          return;
        }
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

  private async invoke(providerId: number, method: string, args: Record<string, unknown>, cancellationToken?: CancellationTokenLike): Promise<unknown> {
    try {
      return await this.options.extensionHost.invokeProvider(providerId, method, args, cancellationToken);
    } catch (err) {
      console.warn(`[MonacoProviderBridge] ${method} failed`, err);
      return null;
    }
  }

  private warn(message: string): void {
    console.warn(`[MonacoProviderBridge] ${message}`);
  }

  private info(message: string): void {
    console.info(`[MonacoProviderBridge] ${message}`);
  }

  private rewriteCompletionCommands(list: Monaco.languages.CompletionList, payload: CompletionListPayload): void {
    const count = Math.min(list.suggestions.length, payload.items.length);
    for (let i = 0; i < count; i++) {
      const src = payload.items[i];
      const dst = list.suggestions[i];
      if (!src?.command || !dst) continue;
      // Monaco standalone cannot execute extension-private command ids itself.
      // Route such commands back through the extension host command executor.
      if (src.command.command.startsWith("editor.")) continue;
      dst.command = {
        id: COMPLETION_COMMAND_RELAY_ID,
        title: src.command.title,
        arguments: [src.command.command, src.command.arguments ?? []],
      };
    }
  }
}

export function createMonacoProviderBridge(monaco: typeof Monaco, extensionHost: ExtensionHostClient): MonacoProviderBridge {
  return new MonacoProviderBridge({ monaco, extensionHost });
}

export type { ProviderKind };
