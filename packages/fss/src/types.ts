// ─── FSS Language Types ──────────────────────────────────────────────────────

/**
 * The type of a filesystem node.
 */
export type FsNodeType = 'file' | 'folder';

/**
 * Theme variants, matching VS Code's theme kinds.
 */
export type ThemeKind = 'light' | 'dark' | 'high-contrast' | 'high-contrast-light';

/**
 * Bitmask flags for node state. Enables fast state comparison via bitwise AND.
 */
export const enum StateFlags {
  None = 0,
  Expanded = 1 << 0,
  Selected = 1 << 1,
  Hovered = 1 << 2,
  Active = 1 << 3,
  DragOver = 1 << 4,
  Focused = 1 << 5,
}

/**
 * A filesystem node that the style engine can match against.
 * Users provide objects conforming to this interface.
 */
export interface FsNode {
  /** Node type: 'file' or 'folder' */
  type: FsNodeType;
  /** File/folder name (e.g. "index.ts") */
  name: string;
  /** Base extension — last segment after final dot (e.g. "ts") */
  baseExt: string;
  /** Full extension — everything after first dot (e.g. "test.ts") */
  fullExt: string;
  /** Programming language identifier (e.g. "typescript", "python") */
  lang: string;
  /** Relative path from root (e.g. ".github/workflows/ci.yml") */
  path: string;
  /** Parent node, if any */
  parent?: FsNode;
  /** Bitmask of current state flags */
  stateFlags: StateFlags;
  /** Arbitrary metadata attributes for matching (e.g. inVcsRepo, vcsStatus) */
  meta: Record<string, unknown>;
}

// ─── Compiled Selector Structures ────────────────────────────────────────────

/**
 * Attribute match operators supported in FSS selectors.
 */
export type AttrOperator = '=' | '^=' | '$=' | '~=' | '!=';

/**
 * A single attribute condition within a simple selector.
 */
export interface AttrCondition {
  name: string;
  operator: AttrOperator | null; // null = boolean presence check
  value: string | null;
}

/**
 * A pseudo-class condition.
 */
export type PseudoState = 'expanded' | 'selected' | 'hovered' | 'active' | 'drag-over' | 'focused';

/**
 * The set of pseudo-states expressed as a bitmask for fast matching.
 */
export const PSEUDO_TO_FLAG: Record<PseudoState, StateFlags> = {
  expanded: StateFlags.Expanded,
  selected: StateFlags.Selected,
  hovered: StateFlags.Hovered,
  active: StateFlags.Active,
  'drag-over': StateFlags.DragOver,
  focused: StateFlags.Focused,
};

/**
 * A compiled "simple selector" — matches against a single node.
 * Produced by compiling css-tree's AST nodes.
 */
export interface CompiledSimpleSelector {
  /** Type constraint: 'file' | 'folder' | null (any) */
  typeConstraint: FsNodeType | null;
  /** Required pseudo-state bitmask */
  requiredStates: StateFlags;
  /** Attribute conditions */
  attrs: AttrCondition[];
  /** :is() alternatives — any one matching means success */
  isGroups: CompiledSimpleSelector[][] | null;
  /** :root pseudo-class — matches only if the node has no parent */
  requiresRoot: boolean;
}

/**
 * A compiled full selector, including optional ancestor chain.
 * For "folder[name='.github'] folder[name='workflows']":
 *   - target = compiled simple selector for "folder[name='workflows']"
 *   - ancestors = [compiled simple selector for "folder[name='.github']"]
 */
export interface CompiledSelector {
  target: CompiledSimpleSelector;
  ancestors: CompiledSimpleSelector[];
  specificity: number;
}

// ─── Rule Index Keys ─────────────────────────────────────────────────────────

/**
 * Keys extracted from a compiled selector for O(1) bucket lookup.
 */
export interface SelectorIndexKeys {
  /** Primary name key from [name="..."] attribute */
  nameKey: string | null;
  /** Extension key — last segment of the ext value (e.g. "ts" for both ext="ts" and ext="test.ts") */
  extKey: string | null;
  /** Language key from [lang="..."] */
  langKey: string | null;
  /** Type constraint */
  typeKey: FsNodeType | null;
}

// ─── Declarations ────────────────────────────────────────────────────────────

/**
 * A single FSS declaration value.
 */
export type FssValue = string | number | boolean;

/**
 * A resolved style object — a map of property names to values.
 */
export type ResolvedStyle = Record<string, FssValue>;

// ─── Style Resolver Interface ────────────────────────────────────────────────

/**
 * Common interface shared by CachedResolver and LayeredResolver.
 * Consumers that only need style/sorting resolution can accept either
 * implementation without knowing about layers or caching strategy.
 */
export interface StyleResolver {
  resolveStyle(node: FsNode): ResolvedStyle;
  resolveSorting(node: FsNode): Record<string, FssValue>;
  getTheme(): ThemeKind | undefined;
  setTheme(theme: ThemeKind | undefined): void;
  invalidate(): void;
}

// ─── Compiled Rules ──────────────────────────────────────────────────────────

/**
 * A fully compiled FSS rule ready for matching.
 */
export interface CompiledRule {
  /** All selector alternatives (from comma-separated selector list) */
  selectors: CompiledSelector[];
  /** Maximum specificity across all selectors */
  specificity: number;
  /** Declaration order (for tie-breaking) */
  order: number;
  /** Resolved declarations */
  declarations: Record<string, FssValue>;
  /** Which domain this rule belongs to */
  domain: 'style' | 'sorting';
  /** Theme scope — null means rule applies in all themes */
  theme: ThemeKind | null;
}

// ─── Table Configuration ─────────────────────────────────────────────────────

export interface ColumnConfig {
  visible?: boolean;
  width?: number;
  order?: number;
}

export type TableConfig = Record<string, ColumnConfig>;

// ─── Stylesheet ──────────────────────────────────────────────────────────────

/**
 * A fully compiled stylesheet, indexed for fast lookup.
 */
export interface CompiledStylesheet {
  /** All style rules, sorted by specificity then order */
  styleRules: CompiledRule[];
  /** All sorting rules, sorted by specificity then order */
  sortingRules: CompiledRule[];
  /** Table configuration */
  tableConfig: TableConfig;

  // ─── Rule Index (for sub-O(N) lookup) ──────────────────────────
  /** Rules indexed by exact [name="..."] match */
  byName: Map<string, CompiledRule[]>;
  /** Rules indexed by extension (last segment of ext value, e.g. "ts") */
  byExt: Map<string, CompiledRule[]>;
  /** Rules indexed by [lang="..."] match */
  byLang: Map<string, CompiledRule[]>;
  /** Rules indexed by type selector */
  byType: Map<FsNodeType, CompiledRule[]>;
  /** Rules that couldn't be indexed (generic/complex) */
  genericRules: CompiledRule[];
}

// ─── Layer System ────────────────────────────────────────────────────────────

/**
 * A style layer with scope information.
 */
export interface StyleLayer {
  /** Path this layer applies to (e.g. "/" for global, "/project/sub" for nested) */
  scopePath: string;
  /** Priority: higher wins. Depth-based: global=0, project=100, nested=100+depth */
  priority: number;
  /** The compiled stylesheet */
  stylesheet: CompiledStylesheet;
}
