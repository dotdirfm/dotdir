/**
 * Diagnostics Bridge.
 *
 * Consumes `diagnostics/set` / `diagnostics/clear` messages from the
 * extension host and feeds LSP server diagnostics to the matching
 * Monaco text model using `monaco.editor.setModelMarkers(model, owner, markers)`.
 */

import type * as Monaco from "monaco-editor/esm/vs/editor/editor.api.js";
import type { ExtensionHostClient } from "../extensionHostClient";
import type { LspServerManager } from "../lsp/lspServerManager";
import type { LspDiagnosticPayload } from "../lsp/types";
import { diagnosticToMarker } from "./typeAdapters";

export class MonacoDiagnosticsBridge {
  private setUnsub?: () => void;
  private clearUnsub?: () => void;
  private lspUnsub?: () => void;

  constructor(
    private monaco: typeof Monaco,
    private extensionHost: ExtensionHostClient,
    private lspManager?: LspServerManager | null,
  ) {}

  attach(): void {
    this.setUnsub = this.extensionHost.onDiagnostics(({ owner, uri, diagnostics }) => {
      const uriObj = this.monaco.Uri.parse(uri);
      const model = this.monaco.editor.getModel(uriObj);
      if (!model) return;
      const markers = diagnostics.map((d) => diagnosticToMarker(d, this.monaco));
      this.monaco.editor.setModelMarkers(model, owner, markers);
    });
    this.clearUnsub = this.extensionHost.onDiagnosticsClear(({ owner, uri }) => {
      if (uri) {
        const uriObj = this.monaco.Uri.parse(uri);
        const model = this.monaco.editor.getModel(uriObj);
        if (!model) return;
        this.monaco.editor.setModelMarkers(model, owner, []);
      } else {
        for (const model of this.monaco.editor.getModels()) {
          this.monaco.editor.setModelMarkers(model, owner, []);
        }
      }
    });

    // Subscribe to LSP server diagnostics
    if (this.lspManager) {
      const originalOptions = (this.lspManager as unknown as {
        options: { onDiagnostics: (owner: string, uri: string, diagnostics: LspDiagnosticPayload[]) => void };
      }).options;
      const prevOnDiagnostics = originalOptions.onDiagnostics;
      originalOptions.onDiagnostics = (owner: string, uri: string, diagnostics: LspDiagnosticPayload[]) => {
        prevOnDiagnostics(owner, uri, diagnostics);
        this.handleLspDiagnostics(owner, uri, diagnostics);
      };
      this.lspUnsub = () => {
        originalOptions.onDiagnostics = prevOnDiagnostics;
      };
    }
  }

  private handleLspDiagnostics(owner: string, uri: string, diagnostics: LspDiagnosticPayload[]): void {
    const uriObj = this.monaco.Uri.parse(uri);
    const model = this.monaco.editor.getModel(uriObj);
    if (!model) return;
    const markers = diagnostics.map((d) => {
      // Convert LspDiagnosticPayload to DiagnosticPayload shape expected by diagnosticToMarker
      return diagnosticToMarker({
        range: d.range,
        message: d.message,
        severity: d.severity,
        code: d.code,
        source: d.source,
      }, this.monaco);
    });
    this.monaco.editor.setModelMarkers(model, `lsp:${owner}`, markers);
  }

  detach(): void {
    this.setUnsub?.();
    this.clearUnsub?.();
    this.lspUnsub?.();
  }
}

export function createMonacoDiagnosticsBridge(
  monaco: typeof Monaco,
  extensionHost: ExtensionHostClient,
  lspManager?: LspServerManager | null,
): MonacoDiagnosticsBridge {
  return new MonacoDiagnosticsBridge(monaco, extensionHost, lspManager);
}
