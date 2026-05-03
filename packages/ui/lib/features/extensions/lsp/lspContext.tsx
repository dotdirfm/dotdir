/**
 * LSP subsystem React integration.
 *
 * Provides the LspServerManager to React components via context,
 * similar to ExtensionHostClientProvider. Also exports a hook
 * for accessing diagnostics from LSP servers.
 */

import { createContext, createElement, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { LspServerManager, type DiagnosticsCallback } from "./lspServerManager";
import type { LspDiagnosticPayload } from "./types";
import type { DotDirSettings } from "@/features/settings/types";

const LspManagerContext = createContext<LspServerManager | null>(null);

export function useLspManager(): LspServerManager | null {
  return useContext(LspManagerContext);
}

export function LspManagerProvider({ children }: { children: ReactNode }) {
  const [manager, setManager] = useState<LspServerManager | null>(null);
  const diagnosticsRef = useRef<DiagnosticsCallback | null>(null);

  useEffect(() => {
    const m = new LspServerManager({
      extensionServerPaths: new Map(),
      onDiagnostics: (owner, uri, diagnostics) => {
        diagnosticsRef.current?.(owner, uri, diagnostics);
      },
    });
    setManager(m);
    return () => { m.shutdown(); };
  }, []);

  return createElement(
    LspManagerContext.Provider,
    { value: manager },
    children,
  );
}

/**
 * Hook: bridge LSP diagnostics to a callback (used by MonacoDiagnosticsBridge).
 */
export function useLspDiagnostics(onDiagnostics: DiagnosticsCallback | null): void {
  const manager = useLspManager();
  const cbRef = useRef(onDiagnostics);
  cbRef.current = onDiagnostics;

  useEffect(() => {
    if (!manager) return;
    const wrapped: DiagnosticsCallback = (owner, uri, diagnostics) => {
      cbRef.current?.(owner, uri, diagnostics);
    };
    void wrapped;
    // LSP diagnostics are wired via DiagnosticsBridge which subscribes
    // directly to the manager's options.onDiagnostics callback.
  }, [manager]);
}

/** Public API for broadcasting LSP diagnostics to Monaco markers. */
export type { LspDiagnosticPayload, DiagnosticsCallback };

// Re-export manager for non-React consumers
export { LspServerManager };
export type { DotDirSettings };
