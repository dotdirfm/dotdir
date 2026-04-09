/**
 * Unified Icon Resolver
 *
 * Provides a single interface for resolving file/folder icons through
 * a theme adapter, regardless of whether the active theme comes from
 * FSS metadata or a VS Code icon theme JSON.
 */

import { iconThemeVersionAtom } from "@/atoms";
import { useBridge } from "@/features/bridge/useBridge";
import { atom, useAtomValue, useSetAtom } from "jotai";
import { useCallback, useMemo } from "react";
import { DEFAULT_ICONS } from "./defaultIcons";
import { useIconAssetStore } from "./iconCache";
import {
  FssIconThemeAdapter,
  NoneIconThemeAdapter,
  VSCodeIconThemeAdapter,
  type IconLookupInput,
  type IconThemeAdapter,
  type IconThemeType,
} from "./adapters";

const activeIconThemeAdapterAtom = atom<IconThemeAdapter>(new NoneIconThemeAdapter());

export function useSetIconTheme() {
  const bridge = useBridge();
  const iconAssets = useIconAssetStore();
  const fssTheme = useMemo(() => new FssIconThemeAdapter(iconAssets), [iconAssets]);
  const vscodeTheme = useMemo(() => new VSCodeIconThemeAdapter(bridge, iconAssets), [bridge, iconAssets]);
  const noneTheme = useMemo(() => new NoneIconThemeAdapter(), []);
  const setActiveTheme = useSetAtom(activeIconThemeAdapterAtom);
  const bumpThemeVersion = useSetAtom(iconThemeVersionAtom);

  return {
    setIconTheme: async (type: IconThemeType, path?: string): Promise<void> => {
      noneTheme.clear();
      fssTheme.clear();
      vscodeTheme.clear();

      if (type === "vscode" && path) {
        try {
          await vscodeTheme.load(path);
          setActiveTheme(vscodeTheme);
          bumpThemeVersion((v) => v + 1);
        } catch {
          setActiveTheme(noneTheme);
          bumpThemeVersion((v) => v + 1);
        }
        return;
      }

      const nextTheme = type === "fss" ? fssTheme : noneTheme;
      setActiveTheme(nextTheme);
      bumpThemeVersion((v) => v + 1);
    },
  };
}

export function useSetIconThemeKind() {
  const activeTheme = useAtomValue(activeIconThemeAdapterAtom);
  const bumpThemeVersion = useSetAtom(iconThemeVersionAtom);
  return {
    setIconThemeKind: (kind: "dark" | "light"): void => {
      activeTheme.setThemeKind?.(kind);
      bumpThemeVersion((v) => v + 1);
    },
  };
}

export function useIconThemeType(): IconThemeType {
  return useAtomValue(activeIconThemeAdapterAtom).kind;
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
  const activeTheme = useAtomValue(activeIconThemeAdapterAtom);

  return useCallback(
    (name: string, isDirectory: boolean, isExpanded: boolean, isRoot: boolean, langId?: string, fssIconPath?: string | null): ResolvedIcon => {
      const fallbackUrl = isDirectory ? (isExpanded ? DEFAULT_ICONS.folderOpen : DEFAULT_ICONS.folder) : DEFAULT_ICONS.file;

      const iconPath = activeTheme.resolve({
        name,
        isDirectory,
        isExpanded,
        isRoot,
        langId,
        fssIconPath,
      } satisfies IconLookupInput);

      if (iconPath) {
        return {
          path: iconPath,
          url: activeTheme.getCachedUrl(iconPath),
          fallbackUrl,
        };
      }

      return { path: "_default", url: fallbackUrl, fallbackUrl };
    },
    [activeTheme],
  );
}

/**
 * Load icons by path.
 * Handles both FSS (via iconCache) and VS Code (via vscodeIconTheme).
 */
export function useLoadIconsForPaths() {
  const activeTheme = useAtomValue(activeIconThemeAdapterAtom);
  return useCallback(
    async (paths: string[]): Promise<void> => {
      await activeTheme.preload(paths);
    },
    [activeTheme],
  );
}

/**
 * Get cached icon URL by path.
 */
export function useGetCachedIcon() {
  const activeTheme = useAtomValue(activeIconThemeAdapterAtom);
  return useCallback(
    (path: string): string | null => {
      if (path === "_default_folder") return DEFAULT_ICONS.folder;
      if (path === "_default_folder_open") return DEFAULT_ICONS.folderOpen;
      if (path === "_default_file") return DEFAULT_ICONS.file;

      return activeTheme.getCachedUrl(path);
    },
    [activeTheme],
  );
}
