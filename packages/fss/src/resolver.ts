import type {
  AttrCondition,
  CompiledRule,
  CompiledSelector,
  CompiledSimpleSelector,
  CompiledStylesheet,
  FsNode,
  FssValue,
  ResolvedStyle,
  StyleResolver,
  ThemeKind,
} from './types.js';
import { StateFlags as SF } from './types.js';

// ─── Matcher: Node matching against compiled selectors ───────────────────────

/**
 * Test whether a single simple selector matches a node.
 * This is the inner hot-path function — kept minimal.
 */
function matchSimple(sel: CompiledSimpleSelector, node: FsNode): boolean {
  // 1. Type constraint (fast rejection)
  if (sel.typeConstraint !== null && sel.typeConstraint !== node.type) {
    return false;
  }

  // 2. State bitmask check (single integer AND — extremely fast)
  if (sel.requiredStates !== SF.None) {
    if ((node.stateFlags & sel.requiredStates) !== sel.requiredStates) {
      return false;
    }
  }

  // 3. Attribute conditions
  for (let i = 0; i < sel.attrs.length; i++) {
    if (!matchAttr(sel.attrs[i], node)) {
      return false;
    }
  }

  // 4. :root check
  if (sel.requiresRoot) {
    if (node.parent != null) return false;
  }

  // 5. :is() groups — any group matching is sufficient
  if (sel.isGroups !== null) {
    let anyMatch = false;
    for (let g = 0; g < sel.isGroups.length; g++) {
      const group = sel.isGroups[g];
      let groupMatch = true;
      for (let s = 0; s < group.length; s++) {
        if (!matchSimple(group[s], node)) {
          groupMatch = false;
          break;
        }
      }
      if (groupMatch) {
        anyMatch = true;
        break;
      }
    }
    if (!anyMatch) return false;
  }

  return true;
}

/**
 * Match a single attribute condition against a node.
 */
function matchAttr(cond: AttrCondition, node: FsNode): boolean {
  const nodeValue = getNodeAttrValue(cond.name, node);

  // Boolean presence check: [attr] without operator
  if (cond.operator === null) {
    return nodeValue !== undefined && nodeValue !== false && nodeValue !== '';
  }

  // If no value on node, can't match value operators
  if (nodeValue === undefined || nodeValue === false) return false;

  const strValue = String(nodeValue);
  const condValue = cond.value ?? '';

  // Special ext matching: [ext="ts"] does suffix match on dot boundaries
  // so ext="ts" matches both "ts" and "test.ts"
  if (cond.name === 'ext') {
    if (cond.operator === '=') {
      return strValue === condValue || strValue.endsWith('.' + condValue);
    }
    if (cond.operator === '!=') {
      return strValue !== condValue && !strValue.endsWith('.' + condValue);
    }
  }

  switch (cond.operator) {
    case '=':
      return strValue === condValue;
    case '^=':
      return strValue.startsWith(condValue);
    case '$=':
      return strValue.endsWith(condValue);
    case '~=':
      // Space-separated word match (like CSS class matching)
      return strValue === condValue || strValue.split(/[.\s]/).includes(condValue);
    case '!=':
      return strValue !== condValue;
    default:
      return false;
  }
}

/**
 * Resolve a named attribute from a FsNode.
 * Maps well-known attribute names to node properties.
 */
function getNodeAttrValue(name: string, node: FsNode): string | boolean | undefined {
  switch (name) {
    case 'name':
      return node.name;
    case 'ext':
      return node.fullExt;
    case 'lang':
      return node.lang;
    case 'path':
      return node.path;
    case 'type':
      return node.type;
    default:
      const meta = node.meta[name];
      if (meta === undefined) return undefined;
      return typeof meta === 'string' || typeof meta === 'boolean' ? meta : String(meta);
  }
}

/**
 * Test whether a full compiled selector (with optional ancestors) matches a node.
 */
function matchSelector(sel: CompiledSelector, node: FsNode): boolean {
  // 1. Target must match
  if (!matchSimple(sel.target, node)) return false;

  // 2. If no ancestor requirements, we're done
  if (sel.ancestors.length === 0) return true;

  // 3. Walk up parent chain to match ancestors (right to left, bottom to top)
  // Each ancestor predicate must match some node in the parent chain, in order
  let current: FsNode | undefined = node.parent;
  let ancestorIdx = sel.ancestors.length - 1;

  while (current && ancestorIdx >= 0) {
    if (matchSimple(sel.ancestors[ancestorIdx], current)) {
      ancestorIdx--;
    }
    current = current.parent;
  }

  return ancestorIdx < 0;
}

/**
 * Test whether any selector in a rule matches the node.
 */
function matchRule(rule: CompiledRule, node: FsNode): boolean {
  for (let i = 0; i < rule.selectors.length; i++) {
    if (matchSelector(rule.selectors[i], node)) return true;
  }
  return false;
}

// ─── Style Resolution ────────────────────────────────────────────────────────

/**
 * Compute a bucket key for a node — identifies which index buckets
 * it will hit. Nodes with the same bucket key produce the same
 * candidate list, so we can cache the merged+sorted result.
 *
 * Only dimensions that actually have rules indexed in the sheet
 * contribute to the key. If no rule targets [name="X"], then all
 * names collapse to the same wildcard — maximising cache hits.
 */
function computeBucketKey(sheet: CompiledStylesheet, node: FsNode): string {
  const nameKey = sheet.byName.has(node.name) ? node.name : '*';
  const extKey = node.baseExt && sheet.byExt.has(node.baseExt) ? node.baseExt : '*';
  const langKey = node.lang && sheet.byLang.has(node.lang) ? node.lang : '*';
  return `${node.type}\0${nameKey}\0${extKey}\0${langKey}`;
}

// Per-stylesheet cache of merged candidate lists, keyed by bucket key.
// WeakMap so sheets can be garbage-collected.
const candidateCache = new WeakMap<CompiledStylesheet, Map<string, CompiledRule[]>>();

/**
 * Gather candidate rules for a node from the indexed stylesheet.
 * Returns a small subset of rules — much faster than scanning all rules.
 *
 * The merged candidate list is cached by bucket key, so nodes that hit
 * the same index buckets (e.g. all ".ts" files) share one pre-sorted
 * candidate array. This eliminates the O(k log k) sort per node.
 */
function gatherCandidates(sheet: CompiledStylesheet, node: FsNode): CompiledRule[] {
  let sheetCache = candidateCache.get(sheet);
  if (!sheetCache) {
    sheetCache = new Map();
    candidateCache.set(sheet, sheetCache);
  }

  const bKey = computeBucketKey(sheet, node);
  let cached = sheetCache.get(bKey);
  if (cached) return cached;

  // Use a Set to avoid duplicates (a rule might be indexed under multiple keys)
  const seen = new Set<CompiledRule>();
  const candidates: CompiledRule[] = [];

  const addRules = (rules: CompiledRule[] | undefined) => {
    if (!rules) return;
    for (let i = 0; i < rules.length; i++) {
      const rule = rules[i];
      if (!seen.has(rule)) {
        seen.add(rule);
        candidates.push(rule);
      }
    }
  };

  // Lookup by name (most specific)
  addRules(sheet.byName.get(node.name));

  // Lookup by extension (last segment)
  if (node.baseExt) {
    addRules(sheet.byExt.get(node.baseExt));
  }

  // Lookup by language
  if (node.lang) {
    addRules(sheet.byLang.get(node.lang));
  }

  // Lookup by type
  addRules(sheet.byType.get(node.type));

  // Always include generic (non-indexed) rules
  addRules(sheet.genericRules);

  // Sort candidates by specificity then order (ascending — last wins)
  // This sort happens once per unique bucket key, not per node.
  candidates.sort((a, b) => a.specificity - b.specificity || a.order - b.order);

  sheetCache.set(bKey, candidates);
  return candidates;
}

/**
 * Resolve style for a single node against a compiled stylesheet.
 * Uses indexed lookup for sub-O(N) performance.
 *
 * When `theme` is provided, only rules with a matching theme (or no theme)
 * are applied. When `theme` is omitted, only unscoped rules apply.
 */
export function resolveStyle(sheet: CompiledStylesheet, node: FsNode, theme?: ThemeKind): ResolvedStyle {
  const candidates = gatherCandidates(sheet, node);
  const style: ResolvedStyle = {};

  for (let i = 0; i < candidates.length; i++) {
    const rule = candidates[i];
    // Skip rules that don't match the active theme
    if (rule.theme !== null && rule.theme !== theme) continue;
    if (matchRule(rule, node)) {
      const decls = rule.declarations;
      const keys = Object.keys(decls);
      for (let j = 0; j < keys.length; j++) {
        style[keys[j]] = decls[keys[j]];
      }
    }
  }

  return style;
}

/**
 * Resolve sorting info for a single node.
 * Returns { priority, group } or empty object.
 */
export function resolveSorting(sheet: CompiledStylesheet, node: FsNode, theme?: ThemeKind): Record<string, FssValue> {
  const result: Record<string, FssValue> = {};

  for (let i = 0; i < sheet.sortingRules.length; i++) {
    const rule = sheet.sortingRules[i];
    if (rule.theme !== null && rule.theme !== theme) continue;
    if (matchRule(rule, node)) {
      const decls = rule.declarations;
      const keys = Object.keys(decls);
      for (let j = 0; j < keys.length; j++) {
        result[keys[j]] = decls[keys[j]];
      }
    }
  }

  return result;
}

// ─── Style Cache ─────────────────────────────────────────────────────────────

/**
 * Compute a cache key for a node based on its style-relevant properties.
 * Nodes with the same key will have the same resolved style.
 */
export function computeStyleKey(node: FsNode): string {
  // For nodes without ancestors in selectors, this is very effective:
  // many ".ts" files share the same style
  const metaKeys = Object.keys(node.meta).sort();
  let metaStr = '';
  for (let i = 0; i < metaKeys.length; i++) {
    const k = metaKeys[i];
    metaStr += `${k}=${node.meta[k]};`;
  }

  return `${node.type}|${node.name}|${node.baseExt}|${node.fullExt}|${node.lang}|${node.stateFlags}|${metaStr}`;
}

/**
 * A cached style resolver that avoids recomputing styles for nodes
 * with identical style signatures.
 */
export class CachedResolver implements StyleResolver {
  private cache = new Map<string, ResolvedStyle>();
  private sortCache = new Map<string, Record<string, FssValue>>();
  private theme: ThemeKind | undefined;

  constructor(
    private sheet: CompiledStylesheet,
    theme?: ThemeKind,
  ) {
    this.theme = theme;
  }

  resolveStyle(node: FsNode): ResolvedStyle {
    // For nodes with ancestor selectors, we need path context.
    // Include the parent path in the cache key for correctness.
    const key = computeStyleKey(node) + '|' + (node.parent ? node.parent.path : '');

    let result = this.cache.get(key);
    if (result !== undefined) return result;

    result = resolveStyle(this.sheet, node, this.theme);
    this.cache.set(key, result);
    return result;
  }

  resolveSorting(node: FsNode): Record<string, FssValue> {
    const key = computeStyleKey(node);

    let result = this.sortCache.get(key);
    if (result !== undefined) return result;

    result = resolveSorting(this.sheet, node, this.theme);
    this.sortCache.set(key, result);
    return result;
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

  /**
   * Invalidate all cached styles. Call when stylesheet changes.
   */
  invalidate(): void {
    this.cache.clear();
    this.sortCache.clear();
  }

  /**
   * Replace the underlying stylesheet and invalidate cache.
   */
  setStylesheet(sheet: CompiledStylesheet): void {
    this.sheet = sheet;
    this.invalidate();
  }
}
