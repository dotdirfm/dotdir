import type { FsNode, FssValue, ResolvedStyle, StyleLayer, StyleResolver, ThemeKind } from './types.js';
import { resolveStyle, resolveSorting, computeStyleKey } from './resolver.js';
import { parseStylesheet } from './parser.js';

// ─── Layer System ────────────────────────────────────────────────────────────

/**
 * Priority constants for layer ordering.
 */
export const LayerPriority = {
  GLOBAL: 0,
  USER: 50,
  PROJECT: 100,
  /** Nested layers get PROJECT + depth. E.g. depth 1 = 101, depth 2 = 102 */
  nestedPriority(depth: number): number {
    return 100 + depth;
  },
} as const;

/**
 * Create a style layer from FSS source and scope info.
 */
export function createLayer(source: string, scopePath: string, priority: number): StyleLayer {
  // Normalize path: ensure it ends with / for prefix matching
  const normalizedPath = scopePath.endsWith('/') ? scopePath : scopePath + '/';

  return {
    scopePath: normalizedPath,
    priority,
    stylesheet: parseStylesheet(source),
  };
}

// ─── Layered Resolver ────────────────────────────────────────────────────────

/**
 * Manages multiple style layers and resolves styles with correct
 * layer priority ordering. Layers are scoped to folder subtrees.
 *
 * Resolution order:
 * 1. Collect all layers whose scopePath is a prefix of the node's path
 * 2. Sort by priority (ascending)
 * 3. Resolve each layer's style
 * 4. Merge in order — higher-priority layers override
 *
 * Caching:
 * - Per (styleKey + parentPath + applicableLayerIds) combo
 * - Automatically invalidated on layer changes
 */
export class LayeredResolver implements StyleResolver {
  private layers: StyleLayer[] = [];
  private sortedDirty = false;
  private styleCache = new Map<string, ResolvedStyle>();
  private sortCache = new Map<string, Record<string, FssValue>>();
  private tableConfigCache = new Map<string, Record<string, any>>();
  private theme: ThemeKind | undefined;

  /**
   * Add a style layer.
   */
  addLayer(layer: StyleLayer): void {
    this.layers.push(layer);
    this.sortedDirty = true;
    this.invalidate();
  }

  /**
   * Remove a layer by scope path.
   */
  removeLayer(scopePath: string): void {
    const normalized = scopePath.endsWith('/') ? scopePath : scopePath + '/';
    this.layers = this.layers.filter((l) => l.scopePath !== normalized);
    this.sortedDirty = true;
    this.invalidate();
  }

  /**
   * Replace all layers.
   */
  setLayers(layers: StyleLayer[]): void {
    this.layers = [...layers];
    this.sortedDirty = true;
    this.invalidate();
  }

  /**
   * Get all currently active layers.
   */
  getLayers(): readonly StyleLayer[] {
    return this.layers;
  }

  private ensureSorted(): void {
    if (this.sortedDirty) {
      this.layers.sort((a, b) => a.priority - b.priority);
      this.sortedDirty = false;
    }
  }

  /**
   * Find all layers that apply to a given node path.
   * A layer applies if the node's path starts with the layer's scopePath.
   */
  private getApplicableLayers(nodePath: string): StyleLayer[] {
    this.ensureSorted();
    const result: StyleLayer[] = [];
    const normalizedPath = nodePath.startsWith('/') ? nodePath : '/' + nodePath;

    for (let i = 0; i < this.layers.length; i++) {
      const layer = this.layers[i];
      if (normalizedPath.startsWith(layer.scopePath) || layer.scopePath === '/') {
        result.push(layer);
      }
    }

    return result;
  }

  /**
   * Build a cache key incorporating which layers apply.
   */
  private buildCacheKey(node: FsNode, layers: StyleLayer[]): string {
    const baseKey = computeStyleKey(node) + '|' + (node.parent ? node.parent.path : '');
    // Include which layers apply (by scopePath) and the active theme for correctness
    const layerKey = layers.map((l) => l.scopePath).join(',');
    return baseKey + '||' + layerKey + '||' + (this.theme ?? '');
  }

  /**
   * Resolve the style for a node across all applicable layers.
   */
  resolveStyle(node: FsNode): ResolvedStyle {
    const layers = this.getApplicableLayers(node.path);
    const cacheKey = this.buildCacheKey(node, layers);

    let cached = this.styleCache.get(cacheKey);
    if (cached !== undefined) return cached;

    const merged: ResolvedStyle = {};

    // Apply each layer in priority order (lowest first, highest overrides)
    for (let i = 0; i < layers.length; i++) {
      const style = resolveStyle(layers[i].stylesheet, node, this.theme);
      Object.assign(merged, style);
    }

    this.styleCache.set(cacheKey, merged);
    return merged;
  }

  /**
   * Resolve sorting info for a node across all applicable layers.
   */
  resolveSorting(node: FsNode): Record<string, FssValue> {
    const layers = this.getApplicableLayers(node.path);
    const cacheKey = this.buildCacheKey(node, layers);

    let cached = this.sortCache.get(cacheKey);
    if (cached !== undefined) return cached;

    const merged: Record<string, FssValue> = {};

    for (let i = 0; i < layers.length; i++) {
      const sorting = resolveSorting(layers[i].stylesheet, node, this.theme);
      Object.assign(merged, sorting);
    }

    this.sortCache.set(cacheKey, merged);
    return merged;
  }

  /**
   * Resolve table config for a given path (uses closest layer).
   */
  resolveTableConfig(path: string): Record<string, any> {
    let cached = this.tableConfigCache.get(path);
    if (cached !== undefined) return cached;

    const layers = this.getApplicableLayers(path);
    const merged: Record<string, any> = {};

    for (let i = 0; i < layers.length; i++) {
      const tc = layers[i].stylesheet.tableConfig;
      for (const col of Object.keys(tc)) {
        if (!merged[col]) merged[col] = {};
        Object.assign(merged[col], tc[col]);
      }
    }

    this.tableConfigCache.set(path, merged);
    return merged;
  }

  /**
   * Invalidate all caches. Call when any layer changes.
   */
  invalidate(): void {
    this.styleCache.clear();
    this.sortCache.clear();
    this.tableConfigCache.clear();
  }

  /**
   * Get the current theme.
   */
  getTheme(): ThemeKind | undefined {
    return this.theme;
  }

  /**
   * Switch theme and invalidate cache.
   */
  setTheme(theme: ThemeKind | undefined): void {
    if (this.theme !== theme) {
      this.theme = theme;
      this.invalidate();
    }
  }
}
