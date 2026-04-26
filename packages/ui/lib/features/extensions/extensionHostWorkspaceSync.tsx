/**
 * Extension Host Workspace Sync
 *
 * Builds one opened-resource view from all panel tabs, resolves opted-in
 * DotDir workspace roots, and sends the resulting workspace activation context
 * to the extension host worker. Runtime LSP activation is scoped to these
 * roots; static extension contributions still load globally.
 */

import type { EditorDocumentTab, PanelTab } from "@/entities/tab/model/types";
import { leftTabsAtom, modalEditorTabsAtom, rightTabsAtom } from "@/entities/tab/model/tabsAtoms";
import { useBridge } from "@/features/bridge/useBridge";
import { extensionLanguages, extensionManifest, type ExtensionLanguage } from "@/features/extensions/types";
import { useLoadedExtensions } from "@/features/extensions/useLoadedExtensions";
import { clearWorkspaceRootCache, findWorkspaceRoot, workspaceContainsMatch } from "@/features/extensions/workspaceContains";
import { useExtensionSettings } from "@/features/settings/useExtensionSettings";
import { basename, join, normalizePath } from "@/utils/path";
import { useAtomValue } from "jotai";
import { useEffect, useMemo, useRef, useState } from "react";
import { useExtensionHostClient } from "./extensionHostClient";

const DEFAULT_LSP_DEACTIVATE_DELAY_MS = 30_000;

export type OpenedResource = {
  id: string;
  kind: "file" | "directory";
  path: string;
  langId?: string;
  source: "left-tab" | "right-tab" | "modal-editor-tab";
};

export type ActiveWorkspaceRoot = {
  rootPath: string;
  uri: string;
  name: string;
  resources: OpenedResource[];
  languages: string[];
};

function pathToFileUri(path: string): string {
  if (!path) return "";
  const encoded = path
    .split("/")
    .map((part) => (part ? encodeURIComponent(part) : part))
    .join("/");
  if (encoded.startsWith("/")) return `file://${encoded}`;
  return `file:///${encoded}`;
}

function resourceFromTab(tab: PanelTab, source: OpenedResource["source"]): OpenedResource | null {
  if (tab.type === "filelist") {
    const path = normalizePath(tab.path);
    if (!path) return null;
    return { id: `${source}:${tab.id}`, kind: "directory", path, source };
  }
  const path = normalizePath(join(tab.path, tab.name));
  if (!path) return null;
  return {
    id: `${source}:${tab.id}`,
    kind: "file",
    path,
    langId: tab.langId,
    source,
  };
}

export function deriveOpenedResources(leftTabs: PanelTab[], rightTabs: PanelTab[]): OpenedResource[] {
  const resources: OpenedResource[] = [];
  for (const tab of leftTabs) {
    const resource = resourceFromTab(tab, "left-tab");
    if (resource) resources.push(resource);
  }
  for (const tab of rightTabs) {
    const resource = resourceFromTab(tab, "right-tab");
    if (resource) resources.push(resource);
  }
  return resources;
}

function resourceFromEditorTab(tab: EditorDocumentTab): OpenedResource | null {
  const path = normalizePath(tab.filePath);
  if (!path) return null;
  return {
    id: `modal-editor-tab:${tab.id}`,
    kind: "file",
    path,
    langId: tab.langId,
    source: "modal-editor-tab",
  };
}

export function deriveOpenedResourcesWithModalTabs(leftTabs: PanelTab[], rightTabs: PanelTab[], modalEditorTabs: EditorDocumentTab[]): OpenedResource[] {
  const resources = deriveOpenedResources(leftTabs, rightTabs);
  for (const tab of modalEditorTabs) {
    const resource = resourceFromEditorTab(tab);
    if (resource) resources.push(resource);
  }
  return resources;
}

function normalizeDeactivateDelay(value: unknown): number {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  if (!Number.isFinite(n)) return DEFAULT_LSP_DEACTIVATE_DELAY_MS;
  return Math.max(0, Math.floor(n));
}

function uniqueStrings(values: Iterable<string | undefined>): string[] {
  return Array.from(new Set(Array.from(values).filter((value): value is string => Boolean(value))));
}

function openedResourceSignature(resources: OpenedResource[]): string {
  return resources
    .map((resource) => [resource.id, resource.kind, resource.path, resource.langId ?? "", resource.source].join("\u0000"))
    .sort()
    .join("\u0001");
}

function workspaceContextSignature(
  roots: Array<{ rootPath: string; uri: string; name: string; languages: string[]; activationEvents: string[] }>,
  deactivateDelayMs: number,
): string {
  return JSON.stringify({
    deactivateDelayMs,
    roots: roots
      .map((root) => ({
        rootPath: root.rootPath,
        uri: root.uri,
        name: root.name,
        languages: [...root.languages].sort(),
        activationEvents: [...root.activationEvents].sort(),
      }))
      .sort((a, b) => a.rootPath.localeCompare(b.rootPath)),
  });
}

function languagePatterns(language: ExtensionLanguage): string[] {
  const patterns: string[] = [];
  for (const filename of language.filenames ?? []) {
    if (!filename) continue;
    patterns.push(filename, `**/${filename}`);
  }
  for (const filenamePattern of language.filenamePatterns ?? []) {
    if (!filenamePattern) continue;
    patterns.push(filenamePattern, `**/${filenamePattern}`);
  }
  for (const extension of language.extensions ?? []) {
    if (!extension) continue;
    const suffix = extension.startsWith(".") ? extension : `.${extension}`;
    patterns.push(`*${suffix}`, `**/*${suffix}`);
  }
  return patterns;
}

export function ExtensionHostWorkspaceSync(): null {
  const client = useExtensionHostClient();
  const bridge = useBridge();
  const leftTabs = useAtomValue(leftTabsAtom);
  const rightTabs = useAtomValue(rightTabsAtom);
  const modalEditorTabs = useAtomValue(modalEditorTabsAtom);
  const loadedExtensions = useLoadedExtensions();
  const extensionSettings = useExtensionSettings();
  const [workspaceSettingsVersion, setWorkspaceSettingsVersion] = useState(0);
  const workspaceContainsCacheRef = useRef<Map<string, boolean>>(new Map());
  const lastWorkspaceContextSignatureRef = useRef("");
  const openedResourcesRef = useRef<OpenedResource[]>([]);

  const openedResources = useMemo(() => deriveOpenedResourcesWithModalTabs(leftTabs, rightTabs, modalEditorTabs), [leftTabs, modalEditorTabs, rightTabs]);
  const openedResourcesSignature = useMemo(() => openedResourceSignature(openedResources), [openedResources]);
  openedResourcesRef.current = openedResources;
  const deactivateDelayMs = normalizeDeactivateDelay(extensionSettings.get("dotdir.lsp.deactivateDelayMs"));

  useEffect(() => {
    return bridge.fs.onFsChange((event) => {
      if (event.name !== "settings.json" && event.name !== ".dir") return;
      clearWorkspaceRootCache();
      workspaceContainsCacheRef.current.clear();
      setWorkspaceSettingsVersion((version) => version + 1);
    });
  }, [bridge]);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const openedResources = openedResourcesRef.current;
      const rootToResources = new Map<string, OpenedResource[]>();
      for (const resource of openedResources) {
        const root = await findWorkspaceRoot(bridge, resource.path, resource.kind).catch(() => null);
        if (cancelled) return;
        if (!root) continue;
        const resources = rootToResources.get(root) ?? [];
        resources.push(resource);
        rootToResources.set(root, resources);
      }

      const roots: ActiveWorkspaceRoot[] = Array.from(rootToResources.entries()).map(([rootPath, resources]) => ({
        rootPath,
        uri: pathToFileUri(rootPath),
        name: basename(rootPath) || rootPath,
        resources,
        languages: uniqueStrings(resources.map((resource) => resource.langId)),
      }));

      const activationRoots: Array<ActiveWorkspaceRoot & { activationEvents: string[] }> = [];
      const contributedLanguages = loadedExtensions.flatMap((ext) => extensionLanguages(ext));
      for (const root of roots) {
        const activationEvents = new Set<string>();
        const languages = new Set(root.languages);
        for (const language of root.languages) activationEvents.add(`onLanguage:${language}`);

        for (const language of contributedLanguages) {
          const patterns = languagePatterns(language);
          for (const pattern of patterns) {
            const key = `${root.rootPath}::language:${language.id}:${pattern}`;
            let matched = workspaceContainsCacheRef.current.get(key);
            if (matched === undefined) {
              matched = await workspaceContainsMatch(bridge, root.rootPath, pattern).catch(() => false);
              workspaceContainsCacheRef.current.set(key, matched);
            }
            if (cancelled) return;
            if (!matched) continue;
            languages.add(language.id);
            activationEvents.add(`onLanguage:${language.id}`);
            break;
          }
        }

        for (const ext of loadedExtensions) {
          const events = extensionManifest(ext).activationEvents ?? [];
          for (const event of events) {
            if (!event.startsWith("workspaceContains:")) continue;
            const pattern = event.slice("workspaceContains:".length);
            if (!pattern) continue;
            const key = `${root.rootPath}::${event}`;
            let matched = workspaceContainsCacheRef.current.get(key);
            if (matched === undefined) {
              matched = await workspaceContainsMatch(bridge, root.rootPath, pattern).catch(() => false);
              workspaceContainsCacheRef.current.set(key, matched);
            }
            if (cancelled) return;
            if (matched) activationEvents.add(event);
          }
        }

        activationRoots.push({ ...root, languages: Array.from(languages), activationEvents: Array.from(activationEvents) });
      }

      const contextRoots = activationRoots.map(({ rootPath, uri, name, languages, activationEvents }) => ({
        rootPath,
        uri,
        name,
        languages,
        activationEvents,
      }));
      const nextContextSignature = workspaceContextSignature(contextRoots, deactivateDelayMs);
      if (lastWorkspaceContextSignatureRef.current === nextContextSignature) return;
      lastWorkspaceContextSignatureRef.current = nextContextSignature;

      client.setWorkspaceFolders(roots.map(({ uri, name }) => ({ uri, name })));
      client.setWorkspaceActivationContext(
        contextRoots,
        deactivateDelayMs,
      );
    })();

    return () => {
      cancelled = true;
    };
  }, [bridge, client, deactivateDelayMs, loadedExtensions, openedResourcesSignature, workspaceSettingsVersion]);

  return null;
}
