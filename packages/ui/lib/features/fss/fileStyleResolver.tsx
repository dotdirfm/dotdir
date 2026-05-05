import { systemThemeAtom } from "@/atoms";
import { useResolveIcon } from "@/features/file-icons/iconResolver";
import { FileSystemObserver, useFileSystemWatchRegistry, type FileSystemChangeRecord } from "@/features/file-system/fs";
import { createPanelResolver, invalidateFssCache, resolveEntryStyle, syncLayers, useExtensionFssLayers } from "@/features/fss/fss";
import type { FilePresentation } from "@/features/fss/types";
import type { FsNode } from "@dotdirfm/fss";
import { createFsNode } from "@dotdirfm/fss/helpers";
import { useBridge } from "@dotdirfm/ui-bridge";
import { basename, dirname, isRootPath, join, normalizePath } from "@dotdirfm/ui-utils";
import { useAtomValue } from "jotai";
import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useRef,
    useState,
    type ReactNode,
} from "react";

type FileStyleResolverValue = {
  resolve: (node: FsNode) => FilePresentation;
  version: number;
};

type FileStyleResolverProviderProps = {
  path: string;
  pathKind?: "directory" | "file";
  children: ReactNode;
};

const FileStyleResolverContext = createContext<FileStyleResolverValue | null>(null);

function getWatchRoots(dirPath: string): string[] {
  const paths: string[] = [];
  let current = dirPath;
  while (true) {
    paths.push(current);
    paths.push(join(current, ".dir"));
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return paths;
}

function toDirectoryPath(path: string, pathKind: "directory" | "file"): string {
  const normalized = normalizePath(path);
  return pathKind === "file" ? dirname(normalized) : normalized;
}

export function createFileStyleNode({
  path,
  isDirectory,
  langId,
  hidden,
  executable,
}: {
  path: string;
  isDirectory: boolean;
  langId?: string;
  hidden?: boolean;
  executable?: boolean;
}): FsNode {
  const normalizedPath = normalizePath(path);
  const name = basename(normalizedPath) || normalizedPath;
  return createFsNode({
    name,
    type: isDirectory ? "folder" : "file",
    lang: isDirectory ? "" : (langId ?? ""),
    meta: isDirectory
      ? {
          hidden: hidden ?? name.startsWith("."),
          nlink: 1,
          entryKind: "directory",
        }
      : {
          hidden: hidden ?? name.startsWith("."),
          executable: executable ?? false,
          nlink: 1,
          entryKind: "file",
        },
    path: normalizedPath,
  });
}

export function FileStyleResolverProvider({ path, pathKind = "directory", children }: FileStyleResolverProviderProps) {
  const bridge = useBridge();
  const watchRegistry = useFileSystemWatchRegistry();
  const extensionLayers = useExtensionFssLayers();
  const theme = useAtomValue(systemThemeAtom);
  const resolveIcon = useResolveIcon();
  const resolverRef = useRef(createPanelResolver(theme));
  const currentDirPathRef = useRef("");
  const presentationCacheRef = useRef(new Map<string, FilePresentation>());
  const observerRef = useRef<FileSystemObserver | null>(null);
  const syncGenerationRef = useRef(0);
  const [version, setVersion] = useState(0);

  const syncCurrentLayers = useCallback(async () => {
    const dirPath = currentDirPathRef.current;
    if (!dirPath) return;
    const generation = ++syncGenerationRef.current;
    resolverRef.current.setTheme(theme);
    await syncLayers(bridge, resolverRef.current, dirPath, extensionLayers);
    if (generation !== syncGenerationRef.current) return;
    presentationCacheRef.current.clear();
    setVersion((value) => value + 1);
  }, [bridge, extensionLayers, theme]);

  useEffect(() => {
    const dirPath = toDirectoryPath(path, pathKind);
    currentDirPathRef.current = dirPath;
    observerRef.current?.sync(getWatchRoots(dirPath));
    void syncCurrentLayers();
  }, [path, pathKind, syncCurrentLayers]);

  useEffect(() => {
    void syncCurrentLayers();
  }, [resolveIcon, syncCurrentLayers]);

  useEffect(() => {
    const handleRecords = (records: FileSystemChangeRecord[]) => {
      const dirPath = currentDirPathRef.current;
      if (!dirPath) return;

      let needsResync = false;

      for (const record of records) {
        const rootPath = record.root.path;
        const changedName = record.relativePathComponents[0] ?? null;

        if (rootPath.endsWith("/.dir")) {
          if (changedName === "fs.css") {
            invalidateFssCache(dirname(rootPath));
            needsResync = true;
          }
          continue;
        }

        if (dirPath === rootPath || dirPath.startsWith(rootPath + "/")) {
          if (changedName === ".dir") {
            invalidateFssCache(rootPath);
            needsResync = true;
          }
        }
      }

      if (needsResync) {
        void syncCurrentLayers();
      }
    };

    observerRef.current = new FileSystemObserver(watchRegistry, handleRecords);
    const dirPath = currentDirPathRef.current;
    if (dirPath) {
      observerRef.current.sync(getWatchRoots(dirPath));
    }

    return () => {
      syncGenerationRef.current += 1;
      observerRef.current?.disconnect();
      observerRef.current = null;
    };
  }, [syncCurrentLayers, watchRegistry]);

  const resolve = useCallback(
    (node: FsNode): FilePresentation => {
      const key = [
        node.path ?? "",
        node.type,
        node.lang ?? "",
        String((node.meta as { executable?: boolean } | undefined)?.executable ?? false),
        String((node.meta as { hidden?: boolean } | undefined)?.hidden ?? false),
      ].join("\0");
      const cached = presentationCacheRef.current.get(key);
      if (cached) return cached;
      const style = resolveEntryStyle(resolverRef.current, node);
      const presentation = {
        style,
        icon: resolveIcon(node.name, node.type === "folder", false, isRootPath(node.path ?? ""), node.lang, style.icon),
      };
      presentationCacheRef.current.set(key, presentation);
      return presentation;
    },
    [resolveIcon, version],
  );

  const value = useMemo<FileStyleResolverValue>(
    () => ({
      resolve,
      version,
    }),
    [resolve, version],
  );

  return <FileStyleResolverContext.Provider value={value}>{children}</FileStyleResolverContext.Provider>;
}

export function useFileStyleResolver(): FileStyleResolverValue {
  const value = useContext(FileStyleResolverContext);
  if (!value) {
    throw new Error("useFileStyleResolver must be used within FileStyleResolverProvider");
  }
  return value;
}
