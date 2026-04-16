/**
 * Main-thread Monaco ↔ Extension Host plumbing.
 *
 * `attachMonacoBridges(monaco, host)` wires up document tracking,
 * provider registration, and diagnostics in one go. Returns a
 * `detach()` function to tear down all three.
 */

import type * as Monaco from "monaco-editor/esm/vs/editor/editor.api.js";
import type { ExtensionHostClient } from "../extensionHostClient";
import { MonacoDocumentTracker } from "./documentTracker";
import { MonacoProviderBridge } from "./providerBridge";
import { MonacoDiagnosticsBridge } from "./diagnosticsBridge";

export { MonacoDocumentTracker, MonacoProviderBridge, MonacoDiagnosticsBridge };
export * from "./typeAdapters";

export interface AttachedBridges {
  documentTracker: MonacoDocumentTracker;
  providerBridge: MonacoProviderBridge;
  diagnosticsBridge: MonacoDiagnosticsBridge;
  detach: () => void;
}

export function attachMonacoBridges(monaco: typeof Monaco, extensionHost: ExtensionHostClient): AttachedBridges {
  const documentTracker = new MonacoDocumentTracker(monaco, { extensionHost });
  const providerBridge = new MonacoProviderBridge({ monaco, extensionHost });
  const diagnosticsBridge = new MonacoDiagnosticsBridge(monaco, extensionHost);

  documentTracker.attach();
  providerBridge.attach();
  diagnosticsBridge.attach();

  return {
    documentTracker,
    providerBridge,
    diagnosticsBridge,
    detach: () => {
      documentTracker.detach();
      providerBridge.detach();
      diagnosticsBridge.detach();
    },
  };
}
