// FSS Language — File Style Sheets
// A CSS-like language for describing how files should be rendered in a tree or panel.

// Core types
export type {
  FsNode,
  FsNodeType,
  FssValue,
  ResolvedStyle,
  CompiledStylesheet,
  CompiledRule,
  CompiledSelector,
  CompiledSimpleSelector,
  AttrCondition,
  AttrOperator,
  ColumnConfig,
  TableConfig,
  StyleLayer,
  StyleResolver,
  SelectorIndexKeys,
  PseudoState,
  ThemeKind,
} from './types';

export { StateFlags, PSEUDO_TO_FLAG } from './types';

// Parser
export { parseStylesheet } from './parser';

// Resolver
export { resolveStyle, resolveSorting, computeStyleKey, CachedResolver } from './resolver';

// Layer system
export { createLayer, LayerPriority, LayeredResolver } from './layers';
