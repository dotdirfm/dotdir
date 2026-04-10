import { describe, expect, it } from 'vitest';
import { parseStylesheet, resolveStyle, resolveSorting, StateFlags } from '../src';
import { node } from './_helpers';

describe('nested rules (&)', () => {
  it('basic nesting with &:pseudo-class', () => {
    const sheet = parseStylesheet(`
      folder {
        icon: url(folder.svg);
        &:expanded {
          icon: url(folder-open.svg);
        }
      }
    `);

    const collapsed = node({ name: 'src', path: '/src', type: 'folder' });
    const expanded = node({
      name: 'src',
      path: '/src',
      type: 'folder',
      stateFlags: StateFlags.Expanded,
    });

    expect(resolveStyle(sheet, collapsed)).toEqual({ icon: 'url(folder.svg)' });
    expect(resolveStyle(sheet, expanded)).toEqual({
      icon: 'url(folder-open.svg)',
    });
  });

  it('nesting with :is() grouping', () => {
    const sheet = parseStylesheet(`
      folder {
        &:is([name="src"], [name="lib"]) {
          icon: url(special.svg);
        }
      }
    `);

    const folderA = node({ name: 'src', path: '/src', type: 'folder' });
    const folderB = node({ name: 'lib', path: '/lib', type: 'folder' });
    const folderC = node({ name: 'dist', path: '/dist', type: 'folder' });

    expect(resolveStyle(sheet, folderA)).toEqual({ icon: 'url(special.svg)' });
    expect(resolveStyle(sheet, folderB)).toEqual({ icon: 'url(special.svg)' });
    expect(resolveStyle(sheet, folderC)).toEqual({});
  });

  it('deep nesting (two levels)', () => {
    const sheet = parseStylesheet(`
      folder {
        icon: url(folder.svg);
        &:is([name="src"], [name="lib"]) {
          icon: url(code-folder.svg);
          &:expanded {
            icon: url(code-folder-open.svg);
          }
        }
      }
    `);

    const srcCollapsed = node({ name: 'src', path: '/src', type: 'folder' });
    const srcExpanded = node({
      name: 'src',
      path: '/src',
      type: 'folder',
      stateFlags: StateFlags.Expanded,
    });
    const plainFolder = node({ name: 'docs', path: '/docs', type: 'folder' });

    expect(resolveStyle(sheet, plainFolder)).toEqual({
      icon: 'url(folder.svg)',
    });
    expect(resolveStyle(sheet, srcCollapsed)).toEqual({
      icon: 'url(code-folder.svg)',
    });
    expect(resolveStyle(sheet, srcExpanded)).toEqual({
      icon: 'url(code-folder-open.svg)',
    });
  });

  it('nesting with attribute selector', () => {
    const sheet = parseStylesheet(`
      file {
        &[ext="ts"] {
          icon: url(ts.svg);
        }
        &[ext="js"] {
          icon: url(js.svg);
        }
      }
    `);

    const tsFile = node({ name: 'app.ts', path: '/app.ts' });
    const jsFile = node({ name: 'app.js', path: '/app.js' });

    expect(resolveStyle(sheet, tsFile)).toEqual({ icon: 'url(ts.svg)' });
    expect(resolveStyle(sheet, jsFile)).toEqual({ icon: 'url(js.svg)' });
  });

  it('comma-separated parent × nested child', () => {
    const sheet = parseStylesheet(`
      file, folder {
        &:expanded {
          icon: url(open.svg);
        }
      }
    `);

    // Only folder can be expanded — file:expanded wouldn't match (no expanded state on file)
    const expandedFolder = node({
      name: 'src',
      path: '/src',
      type: 'folder',
      stateFlags: StateFlags.Expanded,
    });
    expect(resolveStyle(sheet, expandedFolder)).toEqual({
      icon: 'url(open.svg)',
    });
  });

  it('nesting inside @theme', () => {
    const sheet = parseStylesheet(`
      folder {
        icon: url(folder.svg);
        &:expanded {
          icon: url(folder-open.svg);
        }
      }
      @theme dark {
        folder {
          icon: url(folder-dark.svg);
          &:expanded {
            icon: url(folder-open-dark.svg);
          }
        }
      }
    `);

    const collapsed = node({ name: 'src', path: '/src', type: 'folder' });
    const expanded = node({
      name: 'src',
      path: '/src',
      type: 'folder',
      stateFlags: StateFlags.Expanded,
    });

    // No theme: base rules only
    expect(resolveStyle(sheet, collapsed)).toEqual({ icon: 'url(folder.svg)' });
    expect(resolveStyle(sheet, expanded)).toEqual({
      icon: 'url(folder-open.svg)',
    });

    // Dark theme: overrides base
    expect(resolveStyle(sheet, collapsed, 'dark')).toEqual({
      icon: 'url(folder-dark.svg)',
    });
    expect(resolveStyle(sheet, expanded, 'dark')).toEqual({
      icon: 'url(folder-open-dark.svg)',
    });
  });

  it('nesting inside @sorting', () => {
    const sheet = parseStylesheet(`
      @sorting {
        folder {
          &[name="node_modules"] {
            order: 999;
          }
        }
      }
    `);

    const nodeModules = node({
      name: 'node_modules',
      path: '/node_modules',
      type: 'folder',
    });
    const src = node({ name: 'src', path: '/src', type: 'folder' });

    expect(resolveSorting(sheet, nodeModules)).toEqual({ order: 999 });
    expect(resolveSorting(sheet, src)).toEqual({});
  });

  it('parent rule with no declarations emits only nested rules', () => {
    const sheet = parseStylesheet(`
      folder {
        &[name="src"] {
          icon: url(src.svg);
        }
        &[name="dist"] {
          icon: url(dist.svg);
        }
      }
    `);

    const src = node({ name: 'src', path: '/src', type: 'folder' });
    const dist = node({ name: 'dist', path: '/dist', type: 'folder' });
    const other = node({ name: 'lib', path: '/lib', type: 'folder' });

    expect(resolveStyle(sheet, src)).toEqual({ icon: 'url(src.svg)' });
    expect(resolveStyle(sheet, dist)).toEqual({ icon: 'url(dist.svg)' });
    expect(resolveStyle(sheet, other)).toEqual({});
  });
});
