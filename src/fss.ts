import { createLayer, FsNode, LayeredResolver, LayerPriority, type StyleLayer, type ThemeKind } from 'fss-lang';
import type { ResolvedEntryStyle } from './types';
import { DirectoryHandle } from './fsa';
import fssSource from './material-icons.fs.css?raw';
import { basename, dirname, join } from './path';

const baseLayer = createLayer(fssSource, '/', LayerPriority.GLOBAL);

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

  const layers: StyleLayer[] = [baseLayer];
  for (const p of ancestors) {
    const source = fssSourceCache.get(p);
    if (source != null) {
      const depth = p === '/' ? 0 : p.split('/').filter(Boolean).length;
      layers.push(createLayer(source, p, LayerPriority.nestedPriority(depth)));
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
    icon: parseIconName(style.icon as string | undefined),
    sortPriority: typeof sorting.priority === 'number' ? sorting.priority : 0,
    groupFirst: sorting['group-first'] === true,
  };
}
