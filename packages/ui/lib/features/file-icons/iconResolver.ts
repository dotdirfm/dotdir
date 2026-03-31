/**
 * Unified Icon Resolver
 *
 * Provides a single interface for resolving file/folder icons,
 * supporting both FSS-based and VS Code icon themes.
 */

import { iconThemeTypeAtom, iconThemeVersionAtom } from "@/atoms";
import { useBridge } from "@/features/bridge/useBridge";
import { useCallback } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { getCachedIconUrl, loadIcons } from "./iconCache";
import { useVscodeIconTheme } from "./vscodeIconTheme";

export type IconThemeType = "fss" | "vscode" | "none";

// Default fallback icons (Material Design inspired)
// These are used when no icon theme is active or icon resolution fails
const DEFAULT_ICONS = {
  // Folder icon - closed folder
  folder:
    "data:image/svg+xml," +
    encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="#90a4ae"><path d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg>`,
    ),
  // Folder open icon
  folderOpen:
    "data:image/svg+xml," +
    encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="#90a4ae"><path d="M20 6h-8l-2-2H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zm0 12H4V8h16v10z"/></svg>`,
    ),
  // File icon - generic document
  file:
    "data:image/svg+xml," +
    encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="#90a4ae"><path d="M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zm4 18H6V4h7v5h5v11z"/></svg>`,
    ),
};

export function useSetIconTheme() {
  const vscodeIconTheme = useVscodeIconTheme();
  const setThemeType = useSetAtom(iconThemeTypeAtom);
  const bumpThemeVersion = useSetAtom(iconThemeVersionAtom);
  return {
    setIconTheme: async (type: IconThemeType, path?: string): Promise<void> => {
      if (type === "vscode" && path) {
        try {
          await vscodeIconTheme.load(path);
          setThemeType(type);
          bumpThemeVersion((v) => v + 1);
        } catch {
          setThemeType("none");
          bumpThemeVersion((v) => v + 1);
        }
      } else {
        vscodeIconTheme.clear();
        setThemeType(type);
        bumpThemeVersion((v) => v + 1);
      }
    },
  };
}

export function useSetIconThemeKind() {
  const vscodeIconTheme = useVscodeIconTheme();
  const bumpThemeVersion = useSetAtom(iconThemeVersionAtom);
  return {
    setIconThemeKind: (kind: "dark" | "light"): void => {
      vscodeIconTheme.setTheme(kind);
      bumpThemeVersion((v) => v + 1);
    },
  };
}

export function useIconThemeType(): IconThemeType {
  return useAtomValue(iconThemeTypeAtom);
}

export function useIconThemeVersion(): number {
  return useAtomValue(iconThemeVersionAtom);
}

export interface ResolvedIcon {
  path: string;
  url: string | null;
  fallbackUrl: string; // Always available - show while real icon is loading
}

/**
 * Resolve icon for a file or folder.
 * Returns the icon path (for loading), cached URL if available, and a fallback URL.
 */
export function useResolveIcon() {
  const vscodeIconTheme = useVscodeIconTheme();
  const themeType = useIconThemeType();

  return useCallback((
    name: string,
    isDirectory: boolean,
    isExpanded: boolean,
    isRoot: boolean,
    langId?: string,
    fssIconPath?: string | null,
  ): ResolvedIcon => {
    const fallbackUrl = isDirectory
      ? isExpanded
        ? DEFAULT_ICONS.folderOpen
        : DEFAULT_ICONS.folder
      : DEFAULT_ICONS.file;

    if (themeType === "vscode" && vscodeIconTheme.isLoaded()) {
      const iconPath = vscodeIconTheme.resolveIcon(
        name,
        isDirectory,
        isExpanded,
        isRoot,
        langId,
      );
      if (iconPath) {
        return {
          path: iconPath,
          url: vscodeIconTheme.getCachedIcon(iconPath),
          fallbackUrl,
        };
      }
      // No specific icon found in theme, use default
      return { path: "_default", url: fallbackUrl, fallbackUrl };
    }

    if (themeType === "fss" && fssIconPath) {
      return {
        path: fssIconPath,
        url: getCachedIconUrl(fssIconPath) ?? null,
        fallbackUrl,
      };
    }

    // Fallback to default embedded icons
    return { path: "_default", url: fallbackUrl, fallbackUrl };
  }, [themeType, vscodeIconTheme]);
}

/**
 * Load icons by path.
 * Handles both FSS (via iconCache) and VS Code (via vscodeIconTheme).
 */
export function useLoadIconsForPaths() {
  const vscodeIconTheme = useVscodeIconTheme();
  const bridge = useBridge();
  const themeType = useIconThemeType();
  return useCallback(async (paths: string[]): Promise<void> => {
    if (themeType === "vscode" && vscodeIconTheme.isLoaded()) {
      await vscodeIconTheme.preloadIcons(paths);
    } else {
      await loadIcons(bridge, paths);
    }
  }, [bridge, themeType, vscodeIconTheme]);
}

/**
 * Get cached icon URL by path.
 */
export function useGetCachedIcon() {
  const vscodeIconTheme = useVscodeIconTheme();
  const themeType = useIconThemeType();
  return useCallback((path: string): string | null => {
    // Handle default embedded icons
    if (path === "_default_folder") return DEFAULT_ICONS.folder;
    if (path === "_default_folder_open") return DEFAULT_ICONS.folderOpen;
    if (path === "_default_file") return DEFAULT_ICONS.file;

    if (themeType === "vscode" && vscodeIconTheme.isLoaded()) {
      return vscodeIconTheme.getCachedIcon(path);
    }
    return getCachedIconUrl(path) ?? null;
  }, [themeType, vscodeIconTheme]);
}
