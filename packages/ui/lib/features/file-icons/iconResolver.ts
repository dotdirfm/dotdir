import { useBridge } from "@/features/bridge/useBridge";
import { atom, useAtomValue, useSetAtom } from "jotai";
import { useCallback } from "react";
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
import { DEFAULT_ICONS } from "./defaultIcons";
import { useIconAssetStore } from "./iconCache";

type ActiveIconThemeState = {
  adapter: IconThemeAdapter;
  kind: "dark" | "light";
  type: IconThemeType;
};

const activeIconThemeStateAtom = atom<ActiveIconThemeState>({
  adapter: new NoneIconThemeAdapter(),
  kind: "dark",
  type: "none",
});

export function useSetIconTheme() {
  const bridge = useBridge();
  const setActiveThemeState = useSetAtom(activeIconThemeStateAtom);

  return {
    setIconTheme: async (type: IconThemeType, path?: string): Promise<void> => {
      if (type === "vscode" && path) {
        const adapter = new VSCodeIconThemeAdapter(bridge);
        try {
          await adapter.load(path);
          setActiveThemeState((current) => {
            current.adapter.clear();
            adapter.setThemeKind?.(current.kind);
            return {
              adapter,
              kind: current.kind,
              type: "vscode",
            };
          });
        } catch {
          setActiveThemeState((current) => {
            current.adapter.clear();
            return {
              adapter: new NoneIconThemeAdapter(),
              kind: current.kind,
              type: "none",
            };
          });
        }
        return;
      }

      setActiveThemeState((current) => {
        current.adapter.clear();
        const adapter: IconThemeAdapter = type === "fss" ? new FssIconThemeAdapter() : new NoneIconThemeAdapter();
        adapter.setThemeKind?.(current.kind);
        return {
          adapter,
          kind: current.kind,
          type,
        };
      });
    },
  };
}

export function useSetIconThemeKind() {
  const setActiveThemeState = useSetAtom(activeIconThemeStateAtom);
  return {
    setIconThemeKind: (kind: "dark" | "light"): void => {
      setActiveThemeState((current) => {
        current.adapter.setThemeKind?.(kind);
        return {
          ...current,
        };
      });
    },
  };
}

export function useIconThemeType(): IconThemeType {
  return useAtomValue(activeIconThemeStateAtom).type;
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
  const { adapter: activeTheme } = useAtomValue(activeIconThemeStateAtom);
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
  const { adapter: activeTheme } = useAtomValue(activeIconThemeStateAtom);
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
