import { parse, generate } from 'css-tree';
import type { CssNode, Rule, Atrule, Declaration, AttributeSelector, PseudoClassSelector, Selector, SelectorList } from 'css-tree';
import type {
  AttrCondition,
  AttrOperator,
  ColumnConfig,
  CompiledRule,
  CompiledSelector,
  CompiledSimpleSelector,
  CompiledStylesheet,
  FsNodeType,
  FssValue,
  SelectorIndexKeys,
  TableConfig,
  StateFlags,
  ThemeKind,
} from './types.js';
import { PSEUDO_TO_FLAG, StateFlags as SF } from './types.js';

// ─── CSS-Tree AST → Compiled Stylesheet ──────────────────────────────────────

/**
 * Parse an FSS string and compile it into an indexed stylesheet.
 */
export function parseStylesheet(source: string): CompiledStylesheet {
  const ast = parse(source);

  const styleRules: CompiledRule[] = [];
  const sortingRules: CompiledRule[] = [];
  const tableConfig: TableConfig = {};
  const orderCounter = { value: 0 };

  // Valid theme names
  const THEME_NAMES = new Set<ThemeKind>(['light', 'dark', 'high-contrast', 'high-contrast-light']);

  // Process top-level AST children (Rules + Atrules)
  (ast as any).children.forEach((child: CssNode) => {
    if (child.type === 'Rule') {
      processRule(child as Rule, null, 'style', null, orderCounter, styleRules, sortingRules);
    } else if (child.type === 'Atrule') {
      const atrule = child as Atrule;
      if (atrule.name === 'sorting' && atrule.block) {
        atrule.block.children.forEach((c: CssNode) => {
          if (c.type === 'Rule') {
            processRule(c as Rule, null, 'sorting', null, orderCounter, styleRules, sortingRules);
          }
        });
      } else if (atrule.name === 'table' && atrule.block) {
        parseTableConfig(atrule, tableConfig);
      } else if (atrule.name === 'theme') {
        const themeName = atrule.prelude ? generate(atrule.prelude).trim() : '';
        if (THEME_NAMES.has(themeName as ThemeKind) && atrule.block) {
          atrule.block.children.forEach((c: CssNode) => {
            if (c.type === 'Rule') {
              processRule(c as Rule, null, 'style', themeName as ThemeKind, orderCounter, styleRules, sortingRules);
            }
          });
        }
      }
    }
  });

  // Sort by specificity (ascending), then order (ascending) — last applied wins
  const sortFn = (a: CompiledRule, b: CompiledRule) => a.specificity - b.specificity || a.order - b.order;

  styleRules.sort(sortFn);
  sortingRules.sort(sortFn);

  // Build rule index
  return buildIndex(styleRules, sortingRules, tableConfig);
}

// ─── Nesting Resolution ──────────────────────────────────────────────────────

/**
 * Resolve nesting: combine parent selector texts with a child SelectorList.
 * If a child selector contains `&`, replace it with each parent selector.
 * Otherwise, prepend the parent as an ancestor (descendant combinator).
 *
 * Handles the cross-product: each parent × each child selector.
 */
function resolveNesting(parentSelectors: string[], childPrelude: SelectorList): string[] {
  const results: string[] = [];
  childPrelude.children.forEach((sel) => {
    if (sel.type !== 'Selector') return;
    const childText = generate(sel).trim();
    for (const parentSel of parentSelectors) {
      if (childText.includes('&')) {
        results.push(childText.replace(/&/g, parentSel));
      } else {
        // Implicit descendant combinator
        results.push(`${parentSel} ${childText}`);
      }
    }
  });
  return results;
}

// ─── Rule Processing (with nesting) ─────────────────────────────────────────

/**
 * Process a Rule node, resolving nesting if it has a parent selector context.
 * Emits compiled rules and recurses into nested child rules.
 */
function processRule(
  rule: Rule,
  parentSelectors: string[] | null,
  domain: 'style' | 'sorting',
  theme: ThemeKind | null,
  orderCounter: { value: number },
  styleRules: CompiledRule[],
  sortingRules: CompiledRule[],
): void {
  if (rule.prelude.type !== 'SelectorList') return;

  // Resolve selector texts for this level
  let resolvedSelectorTexts: string[];

  if (parentSelectors === null) {
    // Top-level rule: extract individual selector texts
    resolvedSelectorTexts = [];
    rule.prelude.children.forEach((sel) => {
      if (sel.type === 'Selector') {
        resolvedSelectorTexts.push(generate(sel).trim());
      }
    });
  } else {
    // Nested rule: resolve & with parent selectors
    resolvedSelectorTexts = resolveNesting(parentSelectors, rule.prelude as SelectorList);
  }

  if (resolvedSelectorTexts.length === 0) return;

  // Compile selectors — re-parse if nesting was resolved, use original AST otherwise
  const selectors: CompiledSelector[] = [];

  if (parentSelectors !== null) {
    // Parse the resolved combined text to get a clean AST
    const resolvedPrelude = parse(resolvedSelectorTexts.join(','), {
      context: 'selectorList',
    }) as SelectorList;
    resolvedPrelude.children.forEach((sel) => {
      if (sel.type === 'Selector') {
        const compiled = compileSelector(sel as Selector);
        if (compiled) selectors.push(compiled);
      }
    });
  } else {
    // Use original prelude directly (faster, no re-parse)
    rule.prelude.children.forEach((sel) => {
      if (sel.type === 'Selector') {
        const compiled = compileSelector(sel as Selector);
        if (compiled) selectors.push(compiled);
      }
    });
  }

  // Emit a compiled rule only if there are selectors AND declarations
  if (selectors.length > 0) {
    const declarations = compileDeclarations(rule.block);
    if (Object.keys(declarations).length > 0) {
      const specificity = Math.max(...selectors.map((s) => s.specificity));
      const compiled: CompiledRule = {
        selectors,
        specificity,
        order: orderCounter.value++,
        declarations,
        domain,
        theme,
      };
      if (domain === 'sorting') {
        sortingRules.push(compiled);
      } else {
        styleRules.push(compiled);
      }
    }
  }

  // Recurse into nested rules within this rule's block
  rule.block.children.forEach((child: CssNode) => {
    if (child.type === 'Rule') {
      processRule(child as Rule, resolvedSelectorTexts, domain, theme, orderCounter, styleRules, sortingRules);
    }
  });
}

// ─── Selector Compilation ────────────────────────────────────────────────────

function compileSelector(node: Selector): CompiledSelector | null {
  // Split selector children by Combinator nodes (only space combinator allowed)
  const segments: CssNode[][] = [[]];

  node.children.forEach((child) => {
    if (child.type === 'Combinator') {
      if (child.name !== ' ') {
        // Only descendant combinator is supported
        return;
      }
      segments.push([]);
    } else {
      segments[segments.length - 1].push(child);
    }
  });

  if (segments.length === 0) return null;

  // Last segment is the target, rest are ancestors (right to left)
  const targetNodes = segments[segments.length - 1];
  const ancestorSegments = segments.slice(0, -1);

  const target = compileSimpleSelector(targetNodes);
  const ancestors = ancestorSegments.map(compileSimpleSelector);

  const specificity = computeSpecificity(target, ancestors);

  return { target, ancestors, specificity };
}

function compileSimpleSelector(nodes: CssNode[]): CompiledSimpleSelector {
  let typeConstraint: FsNodeType | null = null;
  let requiredStates: StateFlags = SF.None;
  const attrs: AttrCondition[] = [];
  let isGroups: CompiledSimpleSelector[][] | null = null;
  let requiresRoot = false;

  for (const node of nodes) {
    switch (node.type) {
      case 'TypeSelector': {
        const name = node.name.toLowerCase();
        if (name === 'file' || name === 'folder') {
          typeConstraint = name;
        }
        break;
      }

      case 'AttributeSelector': {
        const attrNode = node as AttributeSelector;
        const attrName = attrNode.name.name;
        const operator = (attrNode.matcher as AttrOperator) ?? null;
        const value =
          attrNode.value != null
            ? attrNode.value.type === 'String'
              ? attrNode.value.value
              : attrNode.value.type === 'Identifier'
                ? attrNode.value.name
                : null
            : null;

        attrs.push({ name: attrName, operator, value });
        break;
      }

      case 'PseudoClassSelector': {
        const pseudo = node as PseudoClassSelector;
        if (pseudo.name === 'is' && pseudo.children) {
          // :is() — contains a SelectorList
          const groups: CompiledSimpleSelector[][] = [];
          pseudo.children.forEach((child) => {
            if (child.type === 'SelectorList') {
              (child as SelectorList).children.forEach((sel) => {
                if (sel.type === 'Selector') {
                  const selectorNodes: CssNode[] = [];
                  (sel as Selector).children.forEach((n) => selectorNodes.push(n));
                  groups.push([compileSimpleSelector(selectorNodes)]);
                }
              });
            } else if (child.type === 'Selector') {
              const selectorNodes: CssNode[] = [];
              (child as Selector).children.forEach((n) => selectorNodes.push(n));
              groups.push([compileSimpleSelector(selectorNodes)]);
            }
          });
          isGroups = groups;
        } else if (pseudo.name === 'root') {
          requiresRoot = true;
        } else {
          // State pseudo-class
          const flag = PSEUDO_TO_FLAG[pseudo.name as keyof typeof PSEUDO_TO_FLAG];
          if (flag) {
            requiredStates = (requiredStates | flag) as StateFlags;
          }
        }
        break;
      }
    }
  }

  return { typeConstraint, requiredStates, attrs, isGroups, requiresRoot };
}

// ─── Specificity ─────────────────────────────────────────────────────────────

/**
 * Compute a numeric specificity score.
 * Hierarchy: name match > attribute count > pseudo count > type > ancestor depth
 */
function computeSpecificity(target: CompiledSimpleSelector, ancestors: CompiledSimpleSelector[]): number {
  let score = 0;

  // Name attributes are most specific (weight: 1000)
  for (const attr of target.attrs) {
    if (attr.name === 'name' && attr.operator === '=') {
      score += 1000;
    } else if (attr.name === 'ext' && attr.operator === '=') {
      // Specificity scales by number of dot-segments:
      // ext="ts" → 1 segment → 100, ext="test.ts" → 2 segments → 200
      const segments = (attr.value ?? '').split('.').length;
      score += 100 * segments;
    } else {
      score += 100;
    }
  }

  // Pseudo-class states
  if (target.requiredStates !== SF.None) {
    score += 10;
  }

  // Type selector
  if (target.typeConstraint) {
    score += 1;
  }

  // :is() groups add some specificity
  if (target.isGroups) {
    score += 50;
  }

  // Ancestor selectors add specificity
  for (const anc of ancestors) {
    score += 10;
    for (const attr of anc.attrs) {
      if (attr.name === 'name' && attr.operator === '=') {
        score += 100;
      } else {
        score += 10;
      }
    }
  }

  return score;
}

// ─── Declarations ────────────────────────────────────────────────────────────

function compileDeclarations(block: Rule['block']): Record<string, FssValue> {
  const result: Record<string, FssValue> = {};

  block.children.forEach((child) => {
    if (child.type !== 'Declaration') return;
    const decl = child as Declaration;
    const prop = decl.property;
    const value = extractValue(decl.value);
    if (value !== undefined) {
      result[prop] = value;
    }
  });

  return result;
}

function extractValue(valueNode: CssNode): FssValue | undefined {
  if (valueNode.type === 'Value') {
    const parts: string[] = [];
    let singleNumber: number | null = null;
    let singleBool: boolean | null = null;

    (valueNode as any).children.forEach((child: CssNode) => {
      switch (child.type) {
        case 'Identifier': {
          const name = (child as any).name as string;
          if (name === 'true') {
            singleBool = true;
            parts.push('true');
          } else if (name === 'false') {
            singleBool = false;
            parts.push('false');
          } else {
            parts.push(name);
          }
          break;
        }
        case 'Number': {
          const val = (child as any).value as string;
          singleNumber = parseFloat(val);
          parts.push(val);
          break;
        }
        case 'String':
          parts.push((child as any).value);
          break;
        case 'Url':
          parts.push(`url(${(child as any).value})`);
          break;
        case 'Dimension':
          parts.push((child as any).value + (child as any).unit);
          break;
        default:
          parts.push(generate(child));
      }
    });

    if (parts.length === 0) return undefined;

    // Single-value optimizations
    if (parts.length === 1) {
      if (singleNumber !== null) return singleNumber;
      if (singleBool !== null) return singleBool;
    }

    return parts.join(' ');
  }

  return generate(valueNode);
}

// ─── Table Config Parsing ────────────────────────────────────────────────────

function parseTableConfig(atrule: Atrule, config: TableConfig): void {
  if (!atrule.block) return;

  atrule.block.children.forEach((child) => {
    if (child.type !== 'Rule') return;
    const rule = child as Rule;

    // Expect: column(name) { ... }
    // css-tree will parse "column(size)" as a selector with a PseudoClassSelector or TypeSelector
    // Let's use generate() to get the selector text and extract column name
    const selectorText = generate(rule.prelude).trim();
    const match = /^column\(([^)]+)\)$/.exec(selectorText);
    if (!match) return;

    const columnName = match[1].trim();
    const colConfig: ColumnConfig = {};

    rule.block.children.forEach((decl) => {
      if (decl.type !== 'Declaration') return;
      const d = decl as Declaration;
      const val = extractValue(d.value);
      if (val === undefined) return;

      switch (d.property) {
        case 'visible':
          colConfig.visible = val === true || val === 'true';
          break;
        case 'width':
          colConfig.width = typeof val === 'number' ? val : parseFloat(String(val));
          break;
        case 'order':
          colConfig.order = typeof val === 'number' ? val : parseInt(String(val), 10);
          break;
      }
    });

    config[columnName] = colConfig;
  });
}

// ─── Rule Indexing ───────────────────────────────────────────────────────────

/**
 * Extract the best index key from a compiled selector's target.
 */
function extractIndexKeys(selector: CompiledSelector): SelectorIndexKeys {
  const keys: SelectorIndexKeys = {
    nameKey: null,
    extKey: null,
    langKey: null,
    typeKey: selector.target.typeConstraint,
  };

  for (const attr of selector.target.attrs) {
    if (attr.operator !== '=') continue;

    switch (attr.name) {
      case 'name':
        if (attr.value != null) keys.nameKey = attr.value;
        break;
      case 'ext':
        if (attr.value != null) {
          // Index by last dot-segment (e.g. "ts" for both "ts" and "test.ts")
          const lastDot = attr.value.lastIndexOf('.');
          keys.extKey = lastDot >= 0 ? attr.value.substring(lastDot + 1) : attr.value;
        }
        break;
      case 'lang':
        if (attr.value != null) keys.langKey = attr.value;
        break;
    }
  }

  return keys;
}

/**
 * Build an indexed stylesheet from compiled rules.
 */
function buildIndex(styleRules: CompiledRule[], sortingRules: CompiledRule[], tableConfig: TableConfig): CompiledStylesheet {
  const sheet: CompiledStylesheet = {
    styleRules,
    sortingRules,
    tableConfig,
    byName: new Map(),
    byExt: new Map(),
    byLang: new Map(),
    byType: new Map(),
    genericRules: [],
  };

  for (const rule of styleRules) {
    let indexed = false;

    for (const selector of rule.selectors) {
      const keys = extractIndexKeys(selector);

      // Try to index by the most specific key
      if (keys.nameKey) {
        addToMap(sheet.byName, keys.nameKey, rule);
        indexed = true;
      } else if (keys.extKey) {
        addToMap(sheet.byExt, keys.extKey, rule);
        indexed = true;
      } else if (keys.langKey) {
        addToMap(sheet.byLang, keys.langKey, rule);
        indexed = true;
      } else if (keys.typeKey) {
        addToMap(sheet.byType, keys.typeKey, rule);
        indexed = true;
      }
    }

    if (!indexed) {
      sheet.genericRules.push(rule);
    }
  }

  return sheet;
}

function addToMap<K>(map: Map<K, CompiledRule[]>, key: K, rule: CompiledRule): void {
  let arr = map.get(key);
  if (!arr) {
    arr = [];
    map.set(key, arr);
  }
  arr.push(rule);
}
