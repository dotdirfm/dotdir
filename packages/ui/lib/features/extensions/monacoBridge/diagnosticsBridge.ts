/**
 * Diagnostics Bridge.
 *
 * Consumes `diagnostics/set` / `diagnostics/clear` messages from the
 * extension host and applies them to the matching Monaco text model
 * using `monaco.editor.setModelMarkers(model, owner, markers)`.
 */

import type * as Monaco from "monaco-editor/esm/vs/editor/editor.api.js";
import type { ExtensionHostClient } from "../extensionHostClient";
import { diagnosticToMarker } from "./typeAdapters";

export class MonacoDiagnosticsBridge {
  private setUnsub?: () => void;
  private clearUnsub?: () => void;

  constructor(
    private monaco: typeof Monaco,
    private extensionHost: ExtensionHostClient,
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
  }

  detach(): void {
    this.setUnsub?.();
    this.clearUnsub?.();
  }
}

export function createMonacoDiagnosticsBridge(monaco: typeof Monaco, extensionHost: ExtensionHostClient): MonacoDiagnosticsBridge {
  return new MonacoDiagnosticsBridge(monaco, extensionHost);
}
