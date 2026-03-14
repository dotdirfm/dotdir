import { createLayer, FsNode, LayeredResolver, LayerPriority, type StyleLayer, type ThemeKind } from 'fss-lang';
import type { ResolvedEntryStyle } from './types';
import type { LoadedExtension } from './extensions';
import { DirectoryHandle } from './fsa';
import { basename, dirname, join } from './path';

const defaultFss = `
folder { font-weight: bold; }

@sorting {
  folder { group-first: true; }
  file[executable] { priority: 1; }
}
`;

const baseLayer = createLayer(defaultFss, '/', LayerPriority.GLOBAL);

let extensionLayers: StyleLayer[] = [];

/**
 * Resolve relative url() paths in FSS source against a base directory.
 * `url(./icons/file.svg)` with basePath `/home/user/.faraday/ext` becomes
 * `url(/home/user/.faraday/ext/icons/file.svg)`.
 * Already-absolute paths are left unchanged.
 */
function resolveIconUrls(source: string, basePath: string): string {
  return source.replace(/url\(([^)]+)\)/g, (_match, rawUrl: string) => {
    const url = rawUrl.trim();
    if (url.startsWith('/') || /^[A-Za-z]:/.test(url)) return _match;
    const cleaned = url.replace(/^\.\//, '');
    return `url(${join(basePath, cleaned)})`;
  });
}

export function setExtensionLayers(extensions: LoadedExtension[], activeIconTheme?: string): void {
  extensionLayers = extensions
    .filter((ext): ext is LoadedExtension & { iconThemeFss: string; iconThemeBasePath: string } =>
      ext.iconThemeFss != null && ext.iconThemeBasePath != null)
    .filter((ext) => !activeIconTheme || `${ext.ref.publisher}.${ext.ref.name}` === activeIconTheme)
    .map((ext) => createLayer(resolveIconUrls(ext.iconThemeFss, ext.iconThemeBasePath), '/', LayerPriority.USER));
}

const fssSourceCache = new Map<string, string | null>();

export function invalidateFssCache(dirPath: string): void {
  fssSourceCache.delete(dirPath);
}

export function createPanelResolver(theme: ThemeKind = 'dark'): LayeredResolver {
  const resolver = new LayeredResolver();
  resolver.addLayer(baseLayer);
  resolver.setTheme(theme);
  return resolver;
}

export async function syncLayers(resolver: LayeredResolver, dirPath: string): Promise<void> {
  const ancestors: string[] = [];
  let cur = dirPath;
  while (true) {
    ancestors.push(cur);
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }

  for (const p of ancestors) {
    if (basename(p) === '.faraday') continue;
    if (!fssSourceCache.has(p)) {
      const dir = join(p, '.faraday');
      try {
        const fileHandle = await new DirectoryHandle(dir).getFileHandle('fs.css');
        const file = await fileHandle.getFile();
        fssSourceCache.set(p, await file.text());
      } catch {
        fssSourceCache.set(p, null);
      }
    }
  }

  const layers: StyleLayer[] = [baseLayer, ...extensionLayers];
  for (const p of ancestors) {
    const source = fssSourceCache.get(p);
    if (source != null) {
      const depth = p === '/' ? 0 : p.split('/').filter(Boolean).length;
      const fssDir = join(p, '.faraday');
      layers.push(createLayer(resolveIconUrls(source, fssDir), p, LayerPriority.nestedPriority(depth)));
    }
  }

  resolver.setLayers(layers);
}

function parseIconName(icon: string | undefined): string | null {
  if (!icon) return null;
  const match = /^url\(([^)]+)\)$/.exec(String(icon));
  return match ? match[1] : null;
}

export function resolveEntryStyle(resolver: LayeredResolver, node: FsNode): ResolvedEntryStyle {
  const style = resolver.resolveStyle(node);
  const sorting = resolver.resolveSorting(node);

  return {
    color: style.color != null ? String(style.color) : undefined,
    opacity: style.opacity != null ? Number(style.opacity) : undefined,
    fontWeight: style['font-weight'] != null ? style['font-weight'] as string | number : undefined,
    fontStyle: style['font-style'] != null ? String(style['font-style']) : undefined,
    fontStretch: style['font-stretch'] != null ? String(style['font-stretch']) : undefined,
    fontVariant: style['font-variant'] != null ? String(style['font-variant']) : undefined,
    textDecoration: style['text-decoration'] != null ? String(style['text-decoration']) : undefined,
    icon: parseIconName(style.icon as string | undefined),
    sortPriority: typeof sorting.priority === 'number' ? sorting.priority : 0,
    groupFirst: sorting['group-first'] === true,
  };
}
