# fss-lang

**File Style Sheets** — a CSS-like language for describing how files should be rendered in a tree or panel.

## Features

- **CSS-like syntax** powered by [css-tree](https://github.com/nicolo-ribaudo/css-tree) for robust parsing
- **Type selectors**: `file`, `folder`
- **Attribute selectors**: `[ext="ts"]`, `[name="Dockerfile"]`, `[lang="typescript"]`, `[vcs-status="modified"]`
- **Attribute operators**: `=`, `^=`, `$=`, `~=`, `!=`
- **Pseudo-classes**: `:expanded`, `:selected`, `:hovered`, `:active`, `:drag-over`, `:focused`
- **`:root` pseudo-class**: `folder:root` matches the top-level folder
- **`:is()` grouping**: `file:is([ext="ts"], [ext="tsx"])`
- **Descendant combinator**: `folder[name=".github"] folder[name="workflows"]`
- **Compound extensions**: `file[ext="test.ts"]` overrides `file[ext="ts"]` — specificity scales by segment count
- **Language selector**: `file[lang="typescript"]` — match by VS Code language ID
- **`@theme` blocks**: `light`, `dark`, `high-contrast`, `high-contrast-light` — like VS Code
- **`@sorting` block** for sort priority/grouping
- **`@table` block** for column visibility/width/order
- **Layered resolution**: global → project → nested `.faraday` overrides
- **Sub-O(N) matching** via rule indexing by name, extension, language, and type
- **Style caching** for amortized O(1) per unique file signature

## Install

```bash
npm install fss-lang
```

## Quick Start

```typescript
import { parseStylesheet, resolveStyle, createFsNode, StateFlags } from '@dotdirfm/fss'

// Parse an FSS stylesheet
const sheet = parseStylesheet(`
  file { icon: url(default-file.svg); color: white; }
  folder { icon: url(default-folder.svg); }
  folder:expanded { icon: url(folder-open.svg); }

  file[ext="ts"] { icon: url(ts.svg); color: blue; }
  file[ext="test.ts"] { icon: url(test.svg); badge: "T"; }
  file[name="Dockerfile"] { icon: url(docker.svg); }

  file[lang="typescript"] { color: blue; }
  file:is([ext="ts"], [ext="tsx"]) { color: blue; }
  file[vcs-status="modified"] { color: orange; }

  folder:root { icon: url(project-root.svg); }

  folder[name=".github"] folder[name="workflows"] {
    icon: url(gh-workflow.svg);
  }

  @sorting {
    file[executable] { priority: 10; }
  }

  @table {
    column(size) { visible: false; }
    column(vcs-status) { width: 30; order: 2; }
  }
`)

// Create a file node
const node = createFsNode({
  type: 'file',
  name: 'index.ts',
  path: '/src/index.ts',
  lang: 'typescript',
  meta: { 'vcs-status': 'modified' },
})

// Resolve style
const style = resolveStyle(sheet, node, 'dark')
// → { icon: 'url(ts.svg)', color: '#58a6ff' }
```

## Cached Resolution

For large trees (10k+ nodes), use `CachedResolver` to avoid recomputing styles for nodes with identical signatures:

```typescript
import { CachedResolver, parseStylesheet } from '@dotdirfm/fss'

const sheet = parseStylesheet(`...`)
const resolver = new CachedResolver(sheet, 'dark')

// Many .ts files share the same style — computed once, cached forever
const style = resolver.resolveStyle(node)

// Switch theme — cache is invalidated automatically
resolver.setTheme('light')
```

## Layer System

Support global config with per-folder overrides (e.g. `.faraday/style.fss`):

```typescript
import { LayeredResolver, createLayer, LayerPriority } from '@dotdirfm/fss'

const resolver = new LayeredResolver()

// Global defaults
resolver.addLayer(createLayer(`
  file { icon: url(file.svg); }
`, '/', LayerPriority.GLOBAL))

// Project-specific overrides
resolver.addLayer(createLayer(`
  file[ext="ts"] { icon: url(custom-ts.svg); }
`, '/my-project/', LayerPriority.PROJECT))

// Nested folder overrides (deeper = higher priority)
resolver.addLayer(createLayer(`
  file { icon: url(special.svg); }
`, '/my-project/packages/core/', LayerPriority.nestedPriority(1)))

const style = resolver.resolveStyle(node)
```

## Grammar

### Node Styling

```
file { icon: url(file.svg); }
folder { icon: url(folder.svg); }
file[ext="ts"] { icon: url(ts.svg); }
file[name="Dockerfile"] { icon: url(docker.svg); }
file[ext$="d.ts"] { badge: "DT"; }
folder:expanded { icon: url(open.svg); }
file:is([ext="ts"], [ext="tsx"]) { color: blue; }
file[lang="typescript"] { icon: url(ts.svg); }
folder[name=".github"] folder[name="workflows"] { icon: url(gh.svg); }
file[inVcsRepo] { badge: "V"; }
folder:root { icon: url(project-root.svg); }
```

### Themes

```
@theme dark {
  file { color: #ccc; }
  file[ext="ts"] { color: #58a6ff; }
}

@theme light {
  file { color: #333; }
  file[ext="ts"] { color: #0366d6; }
}

@theme high-contrast {
  file[ext="ts"] { color: #79c0ff; font-weight: bold; }
}

@theme high-contrast-light {
  file[ext="ts"] { color: #0969da; font-weight: bold; }
}
```

Supported kinds: `light`, `dark`, `high-contrast`, `high-contrast-light` (matching VS Code).
Rules outside `@theme` apply in all themes. Theme-scoped rules merge on top.

### Sorting

```
@sorting {
  file[executable] { priority: 10; }
  folder { group-first: true; }
}
```

### Table Configuration

```
@table {
  column(size) { visible: false; }
  column(vcs-status) { width: 30; order: 2; }
}
```

## Performance

The engine uses **rule indexing** for sub-O(N) matching:

| Technique | Benefit |
|---|---|
| **Bucket indexing** by name, ext, type | Only evaluate ~5–20 candidate rules instead of all |
| **Bitmask state matching** | Single integer AND for pseudo-class checks |
| **Style key caching** | Amortized O(1) for nodes with identical signatures |
| **Pre-sorted rules** | No sorting during match phase |

| **Candidate caching** | WeakMap-based per-sheet cache for nodes sharing the same bucket key |

For a stylesheet with 10,000 rules and 5,000 files in the same directory, the engine evaluates only a small subset of candidate rules per node. Nodes sharing the same extension/type/name pattern reuse a cached candidate list, and `CachedResolver` further deduplicates resolution for nodes with identical style keys.

## API

### `parseStylesheet(source: string): CompiledStylesheet`

Parse FSS source into an indexed, compiled stylesheet.

### `resolveStyle(sheet: CompiledStylesheet, node: FsNode, theme?: ThemeKind): ResolvedStyle`

Resolve all matching style declarations for a node.
When `theme` is provided, both unscoped and matching-theme rules apply.

### `resolveSorting(sheet: CompiledStylesheet, node: FsNode, theme?: ThemeKind): Record<string, FssValue>`

Resolve sorting declarations for a node.

### `createFsNode(opts): FsNode`

Create a node with auto-computed extensions.

### `CachedResolver`

Style resolver with per-signature caching. Accepts optional `theme` in constructor.
Call `setTheme(theme)` to switch — cache is auto-invalidated.

### `LayeredResolver`

Multi-layer resolver with scope-based priority.
Call `setTheme(theme)` to switch — cache is auto-invalidated.

### `createLayer(source, scopePath, priority): StyleLayer`

Create a scoped style layer from FSS source.

## License

MIT
