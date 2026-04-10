import { iconThemeVersionAtom, systemThemeAtom } from "@/atoms";
import { useBridge } from "@/features/bridge/useBridge";
import { FileSystemObserver, useFileSystemWatchRegistry, type FileSystemChangeRecord } from "@/features/file-system/fs";
import type { ResolvedEntryStyle } from "@/features/fss/types";
import { createPanelResolver, invalidateFssCache, resolveEntryStyle, syncLayers, useExtensionFssLayers } from "@/features/fss/fss";
import { useLoadIconsForPaths, type ResolvedIcon } from "@/features/file-icons/iconResolver";
import { basename, dirname, join, normalizePath } from "@/utils/path";
import type { FsNode } from "fss-lang";
import { createFsNode } from "fss-lang/helpers";
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
  resolve: (node: FsNode) => ResolvedEntryStyle;
  version: number;
  assetVersion: number;
  registerResolvedIcon: (icon: ResolvedIcon) => () => void;
};

type FileStyleResolverProviderProps = {
  path: string;
  pathKind?: "directory" | "file";
  children: ReactNode;
};

const FileStyleResolverContext = createContext<FileStyleResolverValue | null>(null);

function resolvedIconToThemeIcon(icon: ResolvedIcon) {
  if (icon.kind === "image" && icon.path) {
    return { kind: "image" as const, path: icon.path };
  }
  if (icon.kind === "font" && icon.font) {
    return {
      kind: "font" as const,
      character: icon.font.character,
      fontFamily: icon.font.fontFamily,
      color: icon.font.color,
      fontSize: icon.font.fontSize,
    };
  }
  return null;
}

function getResolvedIconKey(icon: ResolvedIcon): string | null {
  if (icon.kind === "image" && icon.path) {
    return `image:${icon.path}`;
  }
  if (icon.kind === "font" && icon.font) {
    return `font:${icon.font.fontFamily}:${icon.font.character}:${icon.font.color ?? ""}:${icon.font.fontSize ?? ""}`;
  }
  return null;
}

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
  const iconThemeVersion = useAtomValue(iconThemeVersionAtom);
  const loadIconsForPaths = useLoadIconsForPaths();
  const resolverRef = useRef(createPanelResolver(theme));
  const currentDirPathRef = useRef("");
  const styleCacheRef = useRef(new Map<string, ResolvedEntryStyle>());
  const requestedIconsRef = useRef(new Map<string, { count: number; icon: NonNullable<ReturnType<typeof resolvedIconToThemeIcon>> }>());
  const observerRef = useRef<FileSystemObserver | null>(null);
  const syncGenerationRef = useRef(0);
  const [version, setVersion] = useState(0);
  const [requestedIconsVersion, setRequestedIconsVersion] = useState(0);
  const [assetVersion, setAssetVersion] = useState(0);

  const syncCurrentLayers = useCallback(async () => {
    const dirPath = currentDirPathRef.current;
    if (!dirPath) return;
    const generation = ++syncGenerationRef.current;
    resolverRef.current.setTheme(theme);
    await syncLayers(bridge, resolverRef.current, dirPath, extensionLayers);
    if (generation !== syncGenerationRef.current) return;
    styleCacheRef.current.clear();
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
  }, [syncCurrentLayers, iconThemeVersion]);

  useEffect(() => {
    let cancelled = false;
    const icons = [...requestedIconsRef.current.values()].map((entry) => entry.icon);
    if (icons.length === 0) return;
    loadIconsForPaths(icons).then(() => {
      if (!cancelled) {
        setAssetVersion((value) => value + 1);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [loadIconsForPaths, requestedIconsVersion]);

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
    (node: FsNode): ResolvedEntryStyle => {
      const key = [
        node.path ?? "",
        node.type,
        node.lang ?? "",
        String((node.meta as { executable?: boolean } | undefined)?.executable ?? false),
        String((node.meta as { hidden?: boolean } | undefined)?.hidden ?? false),
      ].join("\0");
      const cached = styleCacheRef.current.get(key);
      if (cached) return cached;
      const resolved = resolveEntryStyle(resolverRef.current, node);
      styleCacheRef.current.set(key, resolved);
      return resolved;
    },
    [version],
  );

  const registerResolvedIcon = useCallback((icon: ResolvedIcon) => {
    const key = getResolvedIconKey(icon);
    const themeIcon = resolvedIconToThemeIcon(icon);
    if (!key || !themeIcon) {
      return () => {};
    }

    const current = requestedIconsRef.current.get(key);
    if (current) {
      current.count += 1;
    } else {
      requestedIconsRef.current.set(key, { count: 1, icon: themeIcon });
      setRequestedIconsVersion((value) => value + 1);
    }

    return () => {
      const existing = requestedIconsRef.current.get(key);
      if (!existing) return;
      if (existing.count <= 1) {
        requestedIconsRef.current.delete(key);
        setRequestedIconsVersion((value) => value + 1);
        return;
      }
      existing.count -= 1;
    };
  }, []);

  const value = useMemo<FileStyleResolverValue>(
    () => ({
      resolve,
      version,
      assetVersion,
      registerResolvedIcon,
    }),
    [assetVersion, registerResolvedIcon, resolve, version],
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
