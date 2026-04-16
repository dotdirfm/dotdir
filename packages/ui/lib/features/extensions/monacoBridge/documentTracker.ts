/**
 * Monaco ↔ Extension Host document tracker.
 *
 * Subscribes to Monaco's model lifecycle (create / content change / dispose)
 * and active-editor changes, and forwards each event to the extension host
 * worker as `document/open`, `document/change`, `document/close`,
 * `document/save`, `editor/active`.
 *
 * Only file-scheme URIs are broadcast (Monaco has plenty of internal models
 * that don't represent user documents).
 */

import type * as Monaco from "monaco-editor/esm/vs/editor/editor.api.js";
import type { ExtensionHostClient } from "../extensionHostClient";

export interface DocumentTrackerOptions {
  extensionHost: ExtensionHostClient;
  shouldTrack?: (model: Monaco.editor.ITextModel) => boolean;
}

interface ModelEntry {
  uri: string;
  version: number;
  contentListener: Monaco.IDisposable;
  disposeListener: Monaco.IDisposable;
}

export class MonacoDocumentTracker {
  private entries = new Map<Monaco.editor.ITextModel, ModelEntry>();
  private disposables: Monaco.IDisposable[] = [];
  private activeUri: string | null = null;

  constructor(
    private monaco: typeof Monaco,
    private options: DocumentTrackerOptions,
  ) {}

  attach(): void {
    // Seed existing models first.
    for (const model of this.monaco.editor.getModels()) {
      this.trackModel(model);
    }
    const createDisposable = this.monaco.editor.onDidCreateModel((model) => this.trackModel(model));
    this.disposables.push(createDisposable);

    // Active editor tracking
    const editorCreateDisposable = this.monaco.editor.onDidCreateEditor((editor) => {
      const standalone = editor as Monaco.editor.IStandaloneCodeEditor;
      // react when the editor receives focus or its model changes
      const focusSub = standalone.onDidFocusEditorText?.(() => this.handleEditorFocus(standalone));
      const modelChangeSub = standalone.onDidChangeModel?.(() => this.handleEditorFocus(standalone));
      if (focusSub) this.disposables.push(focusSub);
      if (modelChangeSub) this.disposables.push(modelChangeSub);
      if (standalone.hasTextFocus?.()) this.handleEditorFocus(standalone);
      else {
        // Consider an editor "active" if it's the only one so language servers
        // that key off active editor can proceed.
        this.handleEditorFocus(standalone);
      }
    });
    this.disposables.push(editorCreateDisposable);
  }

  detach(): void {
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
    for (const [model, entry] of this.entries) {
      entry.contentListener.dispose();
      entry.disposeListener.dispose();
      this.options.extensionHost.documentClose(entry.uri);
      this.entries.delete(model);
    }
    if (this.activeUri !== null) {
      this.activeUri = null;
      this.options.extensionHost.setActiveEditor(null);
    }
  }

  notifySave(model: Monaco.editor.ITextModel): void {
    const entry = this.entries.get(model);
    if (!entry) return;
    this.options.extensionHost.documentSave(entry.uri);
  }

  private trackModel(model: Monaco.editor.ITextModel): void {
    if (this.entries.has(model)) return;
    if (this.options.shouldTrack && !this.options.shouldTrack(model)) return;
    if (model.uri.scheme !== "file") return;
    const uriStr = model.uri.toString();

    const version = model.getVersionId();
    const entry: ModelEntry = {
      uri: uriStr,
      version,
      contentListener: model.onDidChangeContent(() => {
        entry.version = model.getVersionId();
        this.options.extensionHost.documentChange(entry.uri, entry.version, model.getValue());
      }),
      disposeListener: model.onWillDispose(() => {
        this.options.extensionHost.documentClose(entry.uri);
        entry.contentListener.dispose();
        entry.disposeListener.dispose();
        this.entries.delete(model);
        if (this.activeUri === entry.uri) {
          this.activeUri = null;
          this.options.extensionHost.setActiveEditor(null);
        }
      }),
    };
    this.entries.set(model, entry);
    this.options.extensionHost.documentOpen(entry.uri, model.getLanguageId(), entry.version, model.getValue());
  }

  private handleEditorFocus(editor: Monaco.editor.IStandaloneCodeEditor): void {
    const model = editor.getModel();
    if (!model) return;
    if (model.uri.scheme !== "file") return;
    const uri = model.uri.toString();
    if (this.activeUri === uri) return;
    this.activeUri = uri;
    this.options.extensionHost.setActiveEditor(uri);
  }
}

export function createMonacoDocumentTracker(monaco: typeof Monaco, options: DocumentTrackerOptions): MonacoDocumentTracker {
  return new MonacoDocumentTracker(monaco, options);
}
