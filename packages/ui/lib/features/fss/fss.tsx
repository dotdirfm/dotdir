import type { Bridge } from "@/features/bridge";
import { extensionIconThemes, extensionRef, type LoadedExtension } from "@/features/extensions/types";
import { readFileText } from "@/features/file-system/fs";
import type { ResolvedEntryStyle } from "@/features/fss/types";
import { basename, dirname, join, normalizePath } from "@/utils/path";
import type { FsNode } from "fss-lang";
import { createLayer, LayeredResolver, LayerPriority, type StyleLayer, type ThemeKind } from "fss-lang";
import { createContext, createElement, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

const defaultFss = `
folder { font-weight: bold; }

@sorting {
  folder { group-first: true; }
  file[executable] { priority: 1; }
}
`;

const baseLayer = createLayer(defaultFss, "/", LayerPriority.GLOBAL);

type FssContextValue = {
  extensionLayers: StyleLayer[];
  setExtensionLayers: (extensions: LoadedExtension[], activeIconTheme?: string) => void;
  clearExtensionLayers: () => void;
};

const FssContext = createContext<FssContextValue | null>(null);

/**
 * Resolve relative url() paths in FSS source against a base directory.
 * `url(./icons/file.svg)` with basePath `/home/user/.dotdir/ext` becomes
 * `url(/home/user/.dotdir/ext/icons/file.svg)`.
 * Already-absolute paths are left unchanged.
 */
function resolveIconUrls(source: string, basePath: string): string {
  return source.replace(/url\(([^)]+)\)/g, (_match, rawUrl: string) => {
    const url = rawUrl.trim().replace(/^['"]|['"]$/g, "");
    if (url.startsWith("/") || /^[A-Za-z]:/.test(url)) return _match;
    const cleaned = url.replace(/^\.\//, "");
    return `url(${join(basePath, cleaned)})`;
  });
}

function buildExtensionLayers(extensions: LoadedExtension[], activeIconTheme?: string): StyleLayer[] {
  const withFss = extensions.flatMap((ext) =>
    extensionIconThemes(ext)
      .filter((theme): theme is NonNullable<LoadedExtension["assets"]["iconThemes"]>[number] & { kind: "fss"; fss: string; basePath: string } =>
        theme.kind === "fss" && theme.fss != null && theme.basePath != null)
      .map((theme) => ({
        ext,
        theme,
        key: `${extensionRef(ext).publisher}.${extensionRef(ext).name}:${theme.id}`,
      })),
  );
  const filtered = activeIconTheme ? withFss.filter((entry) => entry.key === activeIconTheme) : [];
  return filtered.map((entry) => createLayer(resolveIconUrls(entry.theme.fss, normalizePath(entry.theme.basePath)), "/", LayerPriority.USER));
}

export function FssProvider({ children }: { children: ReactNode }) {
  const [extensionLayers, setExtensionLayersState] = useState<StyleLayer[]>([]);
  const setExtensionLayers = useCallback((extensions: LoadedExtension[], activeIconTheme?: string) => {
    setExtensionLayersState(buildExtensionLayers(extensions, activeIconTheme));
  }, []);
  const clearExtensionLayers = useCallback(() => {
    setExtensionLayersState([]);
  }, []);

  const value = useMemo<FssContextValue>(
    () => ({
      extensionLayers,
      setExtensionLayers,
      clearExtensionLayers,
    }),
    [clearExtensionLayers, extensionLayers, setExtensionLayers],
  );

  return createElement(FssContext.Provider, { value }, children);
}

function useFssContext(): FssContextValue {
  const value = useContext(FssContext);
  if (!value) throw new Error("useFssContext must be used within FssProvider");
  return value;
}

export function useExtensionFssLayers(): StyleLayer[] {
  return useFssContext().extensionLayers;
}

export function useSetExtensionFssLayers(): FssContextValue["setExtensionLayers"] {
  return useFssContext().setExtensionLayers;
}

export function useClearExtensionFssLayers(): FssContextValue["clearExtensionLayers"] {
  return useFssContext().clearExtensionLayers;
}

const fssSourceCache = new Map<string, string | null>();
const resolvedLayersCache = new Map<StyleLayer[], Map<string, StyleLayer[]>>();

export function invalidateFssCache(dirPath: string): void {
  fssSourceCache.delete(dirPath);
  // Directory-specific invalidation affects every resolved ancestor chain that
  // may include this path, so keep it simple and flush the derived layer cache.
  resolvedLayersCache.clear();
}

export function createPanelResolver(theme: ThemeKind = "dark"): LayeredResolver {
  const resolver = new LayeredResolver();
  resolver.addLayer(baseLayer);
  resolver.setTheme(theme);
  return resolver;
}

export async function syncLayers(bridge: Bridge, resolver: LayeredResolver, dirPath: string, extensionLayers: StyleLayer[]): Promise<void> {
  const normalizedDirPath = normalizePath(dirPath);
  const ancestors: string[] = [];
  let cur = normalizedDirPath;
  while (true) {
    ancestors.push(cur);
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }

  for (const p of ancestors) {
    if (basename(p) === ".dir") continue;
    if (!fssSourceCache.has(p)) {
      const dir = join(p, ".dir");
      try {
        fssSourceCache.set(p, await readFileText(bridge, join(dir, "fs.css")));
      } catch {
        fssSourceCache.set(p, null);
      }
    }
  }

  let cacheForExtensionLayers = resolvedLayersCache.get(extensionLayers);
  if (!cacheForExtensionLayers) {
    cacheForExtensionLayers = new Map<string, StyleLayer[]>();
    resolvedLayersCache.set(extensionLayers, cacheForExtensionLayers);
  }

  let layers = cacheForExtensionLayers.get(normalizedDirPath);
  if (!layers) {
    layers = [baseLayer, ...extensionLayers];
    for (const p of ancestors) {
      const source = fssSourceCache.get(p);
      if (source != null) {
        const depth = p === "/" ? 0 : p.split("/").filter(Boolean).length;
        const fssDir = join(p, ".dir");
        layers.push(createLayer(resolveIconUrls(source, fssDir), p, LayerPriority.nestedPriority(depth)));
      }
    }
    cacheForExtensionLayers.set(normalizedDirPath, layers);
  }

  resolver.setLayers(layers);
}

function parseIconName(icon: string | undefined): string | null {
  if (!icon) return null;
  const match = /^url\(([^)]+)\)$/.exec(String(icon));
  return match ? match[1].trim().replace(/^['"]|['"]$/g, "") : null;
}

export function resolveEntryStyle(resolver: LayeredResolver, node: FsNode): ResolvedEntryStyle {
  const style = resolver.resolveStyle(node);
  const sorting = resolver.resolveSorting(node);

  return {
    color: style.color != null ? String(style.color) : undefined,
    opacity: style.opacity != null ? Number(style.opacity) : undefined,
    fontWeight: style["font-weight"] != null ? (style["font-weight"] as string | number) : undefined,
    fontStyle: style["font-style"] != null ? String(style["font-style"]) : undefined,
    fontStretch: style["font-stretch"] != null ? String(style["font-stretch"]) : undefined,
    fontVariant: style["font-variant"] != null ? String(style["font-variant"]) : undefined,
    textDecoration: style["text-decoration"] != null ? String(style["text-decoration"]) : undefined,
    icon: parseIconName(style.icon as string | undefined),
    sortPriority: typeof sorting.priority === "number" ? sorting.priority : 0,
    groupFirst: sorting["group-first"] === true,
  };
}
