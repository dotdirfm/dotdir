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
  type ResolvedFontIcon,
  type ResolvedThemeIcon,
} from "./adapters";

const activeIconThemeAdapterAtom = atom<IconThemeAdapter>(new NoneIconThemeAdapter());

export function useSetIconTheme() {
  const bridge = useBridge();
  const fssTheme = useMemo(() => new FssIconThemeAdapter(), []);
  const vscodeTheme = useMemo(() => new VSCodeIconThemeAdapter(bridge), [bridge]);
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
  kind: "image" | "font";
  path: string | null;
  url: string | null;
  fallbackUrl: string; // Always available - show while real icon is loading
  font?: ResolvedFontIcon;
}

/**
 * Resolve icon for a file or folder.
 * Returns either an image icon or a font icon plus fallback metadata.
 */
export function useResolveIcon() {
  const activeTheme = useAtomValue(activeIconThemeAdapterAtom);
  const iconAssets = useIconAssetStore();

  return useCallback(
    (name: string, isDirectory: boolean, isExpanded: boolean, isRoot: boolean, langId?: string, resolvedFssIconPath?: string | null): ResolvedIcon => {
      const fallbackUrl = isDirectory ? (isExpanded ? DEFAULT_ICONS.folderOpen : DEFAULT_ICONS.folder) : DEFAULT_ICONS.file;

      if (resolvedFssIconPath) {
        return {
          kind: "image",
          path: resolvedFssIconPath,
          url: iconAssets.getCachedIconUrl(resolvedFssIconPath) ?? null,
          fallbackUrl,
        };
      }

      const resolved = activeTheme.resolve({
        name,
        isDirectory,
        isExpanded,
        isRoot,
        langId,
      } satisfies IconLookupInput);

      if (resolved?.kind === "image") {
        return {
          kind: "image",
          path: resolved.path,
          url: iconAssets.getCachedIconUrl(resolved.path) ?? null,
          fallbackUrl,
        };
      }

      if (resolved?.kind === "font") {
        return {
          kind: "font",
          path: null,
          url: null,
          fallbackUrl,
          font: resolved,
        };
      }

      return { kind: "image", path: "_default", url: fallbackUrl, fallbackUrl };
    },
    [activeTheme, iconAssets],
  );
}

/**
 * Load any image assets and ensure any font families are ready.
 */
export function useLoadIconsForPaths() {
  const activeTheme = useAtomValue(activeIconThemeAdapterAtom);
  const iconAssets = useIconAssetStore();
  return useCallback(
    async (icons: ResolvedThemeIcon[]): Promise<void> => {
      if (activeTheme.prepareIcons) {
        await activeTheme.prepareIcons(icons, iconAssets);
        return;
      }
      const paths = icons.flatMap((icon) => (icon.kind === "image" ? [icon.path] : []));
      await iconAssets.loadIcons(paths);
    },
    [activeTheme, iconAssets],
  );
}

/**
 * Get cached icon URL by path.
 */
export function useGetCachedIcon() {
  const iconAssets = useIconAssetStore();
  return useCallback(
    (path: string): string | null => {
      if (path === "_default_folder") return DEFAULT_ICONS.folder;
      if (path === "_default_folder_open") return DEFAULT_ICONS.folderOpen;
      if (path === "_default_file") return DEFAULT_ICONS.file;

      return iconAssets.getCachedIconUrl(path) ?? null;
    },
    [iconAssets],
  );
}
