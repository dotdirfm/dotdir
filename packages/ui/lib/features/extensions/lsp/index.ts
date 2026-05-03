/**
 * LSP subsystem public API.
 *
 * The LSP (Language Server Protocol) subsystem manages dedicated
 * worker threads for real language servers. When a workspace root
 * declares `"workspace": true` in its `.dir/settings.json` and
 * lists language server configurations, this subsystem initializes
 * one LSP server worker per (languageId, workspaceRoot) pair.
 *
 * Usage in `.dir/settings.json`:
 * ```jsonc
 * {
 *   "workspace": true,
 *   "languages": {
 *     "yaml": {
 *       "enabled": true,
 *       "settings": {
 *         "yaml.schemas": { "...": "schema.json" }
 *       }
 *     }
 *   }
 * }
 * ```
 *
 * Extension modules can register LSP server worker factories:
 * ```ts
 * import { useLspManager } from "@dotdirfm/ui";
 * function MyExtension() {
 *   const lsp = useLspManager();
 *   useEffect(() => {
 *     lsp?.registerServerModule("/path/to/server.js", () =>
 *       new Worker(new URL("./server.worker.ts", import.meta.url))
 *     );
 *   }, [lsp]);
 * }
 * ```
 */

export { LspStatusBar } from "./LspStatusBar";

export { LspServerManager } from "./lspServerManager";
export { LspManagerProvider, useLspManager, useLspDiagnostics } from "./lspContext";
export type { DiagnosticsCallback } from "./lspServerManager";
export type {
  MainToLspMessage,
  LspToMainMessage,
  LspServerConfig,
  LspServerCapabilities,
  LspServerState,
  LspServerHandle,
  LspDiagnosticPayload,
  LspCompletionItem,
  LspCompletionList,
  LspHoverResult,
  LspLocation,
  LspRange,
  LspTextEdit,
  LspDocumentSymbol,
  LspFoldingRange,
  LspSignatureHelp,
  LspWorkspaceEdit,
  LspRequest,
  LspRequestResponse,
} from "./types";
export {
  readWorkspaceConfig,
  isWorkspace,
  resolveLanguageConfig,
  isLanguageEnabled,
  configuredLanguages,
  WORKSPACE_MARKER,
  clearWorkspaceConfigCache,
  invalidateWorkspaceConfig,
} from "../workspaceConfig";
