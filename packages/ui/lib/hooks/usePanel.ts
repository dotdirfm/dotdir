/**
 * usePanel — navigation state for one file-list panel.
 *
 * Handles both normal filesystem paths and container paths (e.g. ZIP archives
 * accessed via fsProvider extensions).  Watches the filesystem for changes and
 * refreshes or navigates up automatically.
 */

import { osThemeAtom } from "@/atoms";
import { Bridge, FsChangeType, FsRawEntry } from "@/features/bridge";
import { useBridge } from "@/features/bridge/useBridge";
import { loadFsProvider } from "@/features/extensions/browserFsProvider";
import { FileSystemObserver, type FileSystemChangeRecord, type HandleMeta } from "@/fs";
import { createPanelResolver, invalidateFssCache, syncLayers } from "@/fss";
import { languageRegistry } from "@/languageRegistry";
import { buildContainerPath, isContainerPath, parseContainerPath } from "@/utils/containerPath";
import { basename, dirname, isFileExecutable, isRootPath, join } from "@/utils/path";
import { fsProviderRegistry } from "@/viewerEditorRegistry";
import type { LayeredResolver } from "fss-lang";
import { FsNode } from "fss-lang";
import { createFsNode } from "fss-lang/helpers";
import { useAtomValue } from "jotai";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

// ── Helper functions ──────────────────────────────────────────────────────────

function buildParentChain(dirPath: string): FsNode | undefined {
  if (dirname(dirPath) === dirPath) return undefined;

  const ancestors: string[] = [];
  let cur = dirPath;
  while (true) {
    ancestors.push(cur);
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  ancestors.reverse();

  let node: FsNode | undefined;
  for (const p of ancestors) {
    node = createFsNode({
      name: basename(p) || p,
      type: "folder",
      path: p,
      parent: node,
    });
  }
  return node;
}

function isDirectoryEntry(entry: FsRawEntry): boolean {
  return entry.kind === "directory" || (entry.kind === "symlink" && (entry.mode & 0o170000) === 0o040000);
}

function entryToFsNode(entry: FsRawEntry, dirPath: string, parent?: FsNode): FsNode {
  const isDir = isDirectoryEntry(entry);
  const meta: HandleMeta = {
    size: entry.size,
    mtimeMs: entry.mtimeMs,
    mode: entry.mode,
    nlink: entry.nlink,
    kind: entry.kind,
    hidden: entry.hidden,
    linkTarget: entry.linkTarget,
  };
  return createFsNode({
    name: entry.name,
    type: isDir ? "folder" : "file",
    lang: isDir ? "" : languageRegistry.detectLanguage(entry.name),
    meta: {
      size: meta.size,
      mtimeMs: meta.mtimeMs,
      executable: !isDir && isFileExecutable(meta.mode ?? 0, entry.name),
      hidden: meta.hidden ?? entry.name.startsWith("."),
      nlink: meta.nlink ?? 1,
      entryKind: meta.kind ?? (isDir ? "directory" : "file"),
      linkTarget: meta.linkTarget,
    },
    path: join(dirPath, entry.name),
    parent,
  });
}

export async function findExistingParent(bridge: Bridge, startPath: string): Promise<string> {
  let cur = startPath;
  while (true) {
    if (await bridge.fs.exists(cur)) return cur;
    const parent = dirname(cur);
    if (parent === cur || isRootPath(cur)) return cur;
    cur = parent;
  }
}

function getAncestors(dirPath: string): string[] {
  const ancestors: string[] = [];
  let cur = dirPath;
  while (true) {
    ancestors.push(cur);
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return ancestors;
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PanelState {
  currentPath: string;
  parentNode?: FsNode;
  entries: FsNode[];
  /** Name of the entry to focus when navigating to a directory (e.g. the archive file when leaving a ZIP). */
  requestedCursor?: string;
}

export interface PanelController extends PanelState {
  navigateTo: (path: string, force?: boolean, cursorName?: string) => Promise<void>;
  navigating: boolean;
  cancelNavigation: () => void;
  refresh: () => void;
  resolver: LayeredResolver;
}

export const emptyPanel: PanelState = {
  currentPath: "",
  parentNode: undefined,
  entries: [],
  requestedCursor: undefined,
};

// ── Hook ──────────────────────────────────────────────────────────────────────

export function usePanel(showError: (message: string) => void) {
  const bridge = useBridge();
  const theme = useAtomValue(osThemeAtom);
  const [state, setState] = useState<PanelState>(emptyPanel);
  const [navigating, setNavigating] = useState(false);
  const navTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const navAbortRef = useRef<AbortController | null>(null);
  const resolver = useMemo(() => createPanelResolver(theme), [theme]);
  const resolverRef = useRef<LayeredResolver>(resolver);
  resolverRef.current = resolver;

  const observerRef = useRef<FileSystemObserver | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const currentPathRef = useRef<string>("");

  const showErrorRef = useRef(showError);
  showErrorRef.current = showError;

  // When the OS theme changes, resolver is a new object — re-navigate to re-sync FSS layers.
  // currentPathRef is used instead of state to avoid a stale closure; skips mount (path is "").
  useEffect(() => {
    if (currentPathRef.current) navigateTo(currentPathRef.current, true);
  }, [resolver]); // eslint-disable-line react-hooks/exhaustive-deps

  const setupWatches = useCallback((dirPath: string) => {
    const observer = observerRef.current!;
    const ancestors = getAncestors(dirPath);
    const paths: string[] = [];
    for (const ancestor of ancestors) {
      paths.push(ancestor);
      paths.push(join(ancestor, ".dotdir"));
    }
    observer.sync(paths);
  }, []);

  const navigateTo = useCallback(
    async (path: string, force = false, cursorName?: string) => {
      // Skip if already navigating to this path
      if (!force && currentPathRef.current === path && navAbortRef.current) {
        return;
      }
      navAbortRef.current?.abort();
      const abort = new AbortController();
      navAbortRef.current = abort;

      navTimerRef.current = setTimeout(() => setNavigating(true), 300);
      try {
        const work = (async () => {
          currentPathRef.current = path;

          if (isContainerPath(path)) {
            // ── Container path: delegate listing to the fsProvider extension ──
            const { containerFile: hostFile, innerPath } = parseContainerPath(path);
            const providerMatch = fsProviderRegistry.resolve(basename(hostFile));
            if (!providerMatch) {
              throw new Error(`No fsProvider registered for "${basename(hostFile)}"`);
            }
            let entries: import("../features/extensions/extensionApi").FsProviderEntry[];
            if (providerMatch.contribution.runtime === "backend" && bridge.fsProvider) {
              const wasmPath = join(providerMatch.extensionDirPath, providerMatch.contribution.entry);
              const raw = await bridge.fsProvider.listEntries(wasmPath, hostFile, innerPath);
              if (abort.signal.aborted) return;
              entries = raw.map((e) => ({
                name: e.name,
                type: e.kind,
                size: e.size,
                mtimeMs: e.mtimeMs,
              }));
            } else {
              const provider = await loadFsProvider(bridge, providerMatch.extensionDirPath, providerMatch.contribution.entry);
              if (abort.signal.aborted) return;
              entries = await provider.listEntries(hostFile, innerPath);
              if (abort.signal.aborted) return;
            }

            const parent = buildParentChain(path);
            const nodes: FsNode[] = entries.map((entry) => {
              const entryInner = (innerPath === "/" ? "" : innerPath) + "/" + entry.name;
              return createFsNode({
                name: entry.name,
                type: entry.type === "directory" ? "folder" : "file",
                lang: entry.type === "file" ? languageRegistry.detectLanguage(entry.name) : "",
                meta: {
                  size: entry.size ?? 0,
                  mtimeMs: entry.mtimeMs ?? 0,
                  executable: false,
                  hidden: entry.name.startsWith("."),
                  nlink: 1,
                  entryKind: entry.type === "directory" ? "directory" : "file",
                },
                path: buildContainerPath(hostFile, entryInner),
                parent,
              });
            });
            setState({
              currentPath: path,
              parentNode: parent,
              entries: nodes,
              requestedCursor: cursorName,
            });
            // No filesystem watches inside containers.
          } else {
            // ── Normal filesystem path ────────────────────────────────────────
            await syncLayers(bridge, resolverRef.current!, path);
            if (abort.signal.aborted) return;
            const parent = buildParentChain(path);
            const rawEntries = await bridge.fs.entries(path);
            if (abort.signal.aborted) return;
            const nodes: FsNode[] = rawEntries.map((entry) => entryToFsNode(entry, path, parent));
            if (abort.signal.aborted) return;
            setState({
              currentPath: path,
              parentNode: parent,
              entries: nodes,
              requestedCursor: cursorName,
            });
            setupWatches(path);
          }
        })();
        work.catch(() => {});
        await Promise.race([
          work,
          new Promise<void>((resolve) => {
            abort.signal.addEventListener("abort", () => resolve(), { once: true });
          }),
        ]);
      } catch (err) {
        if (!abort.signal.aborted) {
          const msg = err && typeof err === "object" && "message" in err ? (err as { message: string }).message : String(err);
          showErrorRef.current(`Failed to read directory: ${msg}`);
        }
      } finally {
        if (navAbortRef.current === abort) {
          navAbortRef.current = null;
        }
        clearTimeout(navTimerRef.current!);
        navTimerRef.current = null;
        setNavigating(false);
      }
    },
    [setupWatches],
  );

  const cancelNavigation = useCallback(() => {
    navAbortRef.current?.abort();
    navAbortRef.current = null;
    if (navTimerRef.current) {
      clearTimeout(navTimerRef.current);
      navTimerRef.current = null;
    }
    setNavigating(false);
  }, []);

  useEffect(() => {
    const handleRecords = (records: FileSystemChangeRecord[]) => {
      const curPath = currentPathRef.current;
      if (!curPath) return;

      let needsRefresh = false;
      let needsFssRefresh = false;
      let navigateUp = false;

      for (const record of records) {
        const rootPath = record.root.path;
        const changedName = record.relativePathComponents[0] ?? null;
        const type: FsChangeType = record.type;

        if (rootPath === curPath) {
          if (type === "errored") {
            navigateUp = true;
          } else {
            needsRefresh = true;
          }
        } else if (rootPath.endsWith("/.dotdir")) {
          if (changedName === "fs.css") {
            const parentDir = dirname(rootPath);
            invalidateFssCache(parentDir);
            needsFssRefresh = true;
          }
        } else if (curPath.startsWith(rootPath + "/") || curPath === rootPath) {
          if (changedName === ".dotdir") {
            invalidateFssCache(rootPath);
            needsFssRefresh = true;
          } else if (changedName) {
            const relative = curPath.slice(rootPath.length + 1);
            const nextSegment = relative.split("/")[0];
            if (changedName === nextSegment && type === "disappeared") {
              navigateUp = true;
            }
          }
        }
      }

      if (navigateUp) {
        if (debounceRef.current) {
          clearTimeout(debounceRef.current);
          debounceRef.current = null;
        }
        findExistingParent(bridge, curPath).then((parent) => {
          navigateToRef.current(parent);
        });
        return;
      }

      if (needsRefresh || needsFssRefresh) {
        if (debounceRef.current) clearTimeout(debounceRef.current);
        debounceRef.current = setTimeout(() => {
          debounceRef.current = null;
          navigateToRef.current(currentPathRef.current);
        }, 100);
      }
    };

    observerRef.current = new FileSystemObserver(bridge, handleRecords);

    return () => {
      observerRef.current?.disconnect();
      observerRef.current = null;
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
    };
  }, []);

  const navigateToRef = useRef(navigateTo);
  navigateToRef.current = navigateTo;

  const refresh = useCallback(() => {
    navigateToRef.current(currentPathRef.current, true);
  }, []);

  return useMemo(
    () => ({
      ...state,
      navigateTo,
      navigating,
      cancelNavigation,
      refresh,
      resolver: resolverRef.current!,
    }),
    [state, navigateTo, navigating, cancelNavigation, refresh],
  );
}
