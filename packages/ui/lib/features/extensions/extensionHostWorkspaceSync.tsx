/**
 * Extension Host Workspace Sync
 *
 * Derives the set of active "workspace roots" from the currently-open file
 * list tabs and pushes it to the extension host worker. A workspace root is
 * the nearest ancestor directory that contains a `.dir` subfolder; any panel
 * whose path lives under such a directory contributes that root. If no panel
 * is inside a workspace, the active tab's directory is used as a fallback so
 * LSP-backed extensions (e.g. yaml-language-server) still have a sane root
 * for resolving relative schema paths.
 *
 * In addition to sending workspaceFolders over to the worker, this component
 * evaluates every loaded extension's `workspaceContains:<glob>` activation
 * events against each real workspace root and asks the host to activate
 * matching extensions. Each (root, pattern) pair is only evaluated once per
 * session.
 *
 * If a workspace root's `.dir/settings.json` declares `"workspace": true`,
 * the LSP subsystem is notified to initialize language servers for
 * configured languages.
 */

import { useBridge } from "@dotdirfm/ui-bridge";
import { leftActiveTabAtom, rightActiveTabAtom } from "@/entities/tab/model/tabsAtoms";
import { extensionManifest } from "@/features/extensions/types";
import { useLoadedExtensions } from "@/features/extensions/useLoadedExtensions";
import { findWorkspaceRoot, workspaceContainsMatch } from "@/features/extensions/workspaceContains";
import { readWorkspaceConfig, clearWorkspaceConfigCache } from "@/features/extensions/workspaceConfig";
import { basename } from "@dotdirfm/ui-utils";
import { useAtomValue } from "jotai";
import { useEffect, useMemo, useRef } from "react";
import { useExtensionHostClient } from "./extensionHostClient";
import { useLspManager } from "./lsp/lspContext";
import type { DotDirSettings } from "@/features/settings/types";

type ResolvedRoot = { path: string; isWorkspace: boolean; config: DotDirSettings | null };

function pathToFileUri(path: string): string {
  if (!path) return "";
  const encoded = path
    .split("/")
    .map((part) => (part ? encodeURIComponent(part) : part))
    .join("/");
  if (encoded.startsWith("/")) return `file://${encoded}`;
  return `file:///${encoded}`;
}

function tabPath(tab: { type: string; path?: string } | null): string {
  if (!tab) return "";
  if (tab.type === "filelist" || tab.type === "preview") return tab.path ?? "";
  return "";
}

export function ExtensionHostWorkspaceSync(): null {
  const client = useExtensionHostClient();
  const bridge = useBridge();
  const lspManager = useLspManager();
  const left = useAtomValue(leftActiveTabAtom);
  const right = useAtomValue(rightActiveTabAtom);
  const loadedExtensions = useLoadedExtensions();

  const candidatePaths = useMemo(() => {
    const paths: string[] = [];
    const leftPath = tabPath(left);
    const rightPath = tabPath(right);
    if (leftPath) paths.push(leftPath);
    if (rightPath && rightPath !== leftPath) paths.push(rightPath);
    return paths;
  }, [left, right]);

  const activatedPatternsRef = useRef<Set<string>>(new Set());
  const prevWorkspaceRootsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const resolved = await Promise.all(
        candidatePaths.map<Promise<ResolvedRoot | null>>(async (p) => {
          const root = await findWorkspaceRoot(bridge, p);
          if (root) {
            const config = await readWorkspaceConfig(bridge, root);
            return { path: root, isWorkspace: true, config };
          }
          return p ? { path: p, isWorkspace: false, config: null } : null;
        }),
      );
      if (cancelled) return;

      const seen = new Set<string>();
      const roots: ResolvedRoot[] = [];
      for (const r of resolved) {
        if (!r) continue;
        if (seen.has(r.path)) continue;
        seen.add(r.path);
        roots.push(r);
      }

      client.setWorkspaceFolders(
        roots.map(({ path }) => ({ uri: pathToFileUri(path), name: basename(path) || path })),
      );

      // ── LSP workspace config sync ───────────────────────────────────
      const currentRoots = new Set<string>();
      for (const r of roots) {
        currentRoots.add(r.path);
      }

      // Remove configs for roots that are no longer active
      if (lspManager) {
        for (const prev of prevWorkspaceRootsRef.current) {
          if (!currentRoots.has(prev)) {
            lspManager.removeWorkspace(prev);
          }
        }

        // Push config for all active roots
        for (const r of roots) {
          lspManager.setWorkspaceConfig(r.path, r.config);
        }
      }

      // Push workspace settings to extension host for vscode shim
      for (const r of roots) {
        if (r.config) {
          client.configurationWorkspace(r.path, r.config as Record<string, unknown>);
        }
      }

      prevWorkspaceRootsRef.current = currentRoots;

      // ── Extension activation via workspaceContains ──────────────────
      const workspaceRoots = roots.filter((r) => r.isWorkspace).map((r) => r.path);
      if (workspaceRoots.length === 0) return;

      for (const ext of loadedExtensions) {
        const manifest = extensionManifest(ext);
        const events = manifest.activationEvents ?? [];
        for (const event of events) {
          if (!event.startsWith("workspaceContains:")) continue;
          const pattern = event.slice("workspaceContains:".length);
          if (!pattern) continue;
          for (const root of workspaceRoots) {
            const key = `${root}::${event}`;
            if (activatedPatternsRef.current.has(key)) continue;
            const matched = await workspaceContainsMatch(bridge, root, pattern).catch(() => false);
            if (cancelled) return;
            if (!matched) continue;
            activatedPatternsRef.current.add(key);
            void client.activateByEvent(event).catch(() => {});
          }
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [bridge, client, lspManager, candidatePaths, loadedExtensions]);

  // Clear workspace config cache when the map component unmounts
  useEffect(() => {
    return () => { clearWorkspaceConfigCache(); };
  }, []);

  return null;
}
