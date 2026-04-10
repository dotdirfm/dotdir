import { describe, expect, it } from 'vitest';
import { parseStylesheet, resolveSorting, resolveStyle, StateFlags } from '../src';
import { node } from './_helpers';

describe('integration', () => {
  it('full stylesheet with all features', () => {
    const sheet = parseStylesheet(`
      file { icon: url(default-file.svg); color: white; }
      folder { icon: url(default-folder.svg); }

      folder:expanded { icon: url(folder-open.svg); }

      file[ext="ts"] { icon: url(ts.svg); }
      file[ext="test.ts"] { icon: url(test.svg); badge: "T"; }
      file[name="Dockerfile"] { icon: url(docker.svg); }

      file:is([ext="ts"], [ext="tsx"]) { color: blue; }

      folder[name=".github"] folder[name="workflows"] { icon: url(gh-workflow.svg); }

      file[vcs-status="modified"] { color: orange; }
      file[inVcsRepo] { badge: "G"; }

      @sorting {
        file[executable] { priority: 10; }
      }

      @table {
        column(size) { visible: false; }
      }
    `);

    // Regular TS file
    const tsFile = node({ name: 'index.ts', meta: { inVcsRepo: true } });
    const tsStyle = resolveStyle(sheet, tsFile);
    expect(tsStyle.icon).toBe('url(ts.svg)');
    expect(tsStyle.color).toBe('blue');
    expect(tsStyle.badge).toBe('G');

    // Test file
    const testFile = node({ name: 'utils.test.ts', meta: { inVcsRepo: true } });
    const testStyle = resolveStyle(sheet, testFile);
    expect(testStyle.icon).toBe('url(test.svg)');
    expect(testStyle.badge).toBe('T'); // test badge overrides vcs badge due to higher specificity

    // Dockerfile
    const dockerfile = node({ name: 'Dockerfile' });
    expect(resolveStyle(sheet, dockerfile).icon).toBe('url(docker.svg)');

    // Expanded folder
    const expandedFolder = node({
      name: 'src',
      type: 'folder',
      stateFlags: StateFlags.Expanded,
    });
    expect(resolveStyle(sheet, expandedFolder).icon).toBe('url(folder-open.svg)');

    // Collapsed folder
    const collapsedFolder = node({ name: 'src', type: 'folder' });
    expect(resolveStyle(sheet, collapsedFolder).icon).toBe('url(default-folder.svg)');

    // GitHub workflow
    const github = node({ name: '.github', type: 'folder', path: '/.github' });
    const workflows = node({
      name: 'workflows',
      type: 'folder',
      path: '/.github/workflows',
      parent: github,
    });
    expect(resolveStyle(sheet, workflows).icon).toBe('url(gh-workflow.svg)');

    // Modified file
    const modified = node({
      name: 'dirty.ts',
      meta: { 'vcs-status': 'modified', inVcsRepo: true },
    });
    expect(resolveStyle(sheet, modified).color).toBe('orange');
    expect(resolveStyle(sheet, modified).icon).toBe('url(ts.svg)');

    // Sorting
    const executable = node({ name: 'run.sh', meta: { executable: true } });
    expect(resolveSorting(sheet, executable)).toEqual({ priority: 10 });

    // Table
    expect(sheet.tableConfig.size).toEqual({ visible: false });
  });

  it('handles deep nested ancestor matching', () => {
    const sheet = parseStylesheet(`
      folder[name="packages"] folder[name="core"] file[ext="ts"] {
        badge: "core";
      }
    `);

    const packages = node({
      name: 'packages',
      type: 'folder',
      path: '/packages',
    });
    const core = node({
      name: 'core',
      type: 'folder',
      path: '/packages/core',
      parent: packages,
    });
    const src = node({
      name: 'src',
      type: 'folder',
      path: '/packages/core/src',
      parent: core,
    });
    const file = node({
      name: 'index.ts',
      path: '/packages/core/src/index.ts',
      parent: src,
    });

    expect(resolveStyle(sheet, file)).toEqual({ badge: 'core' });

    // Non-matching: file not under packages/core
    const otherFile = node({ name: 'index.ts', path: '/other/index.ts' });
    expect(resolveStyle(sheet, otherFile)).toEqual({});
  });

  it('mixed themes + layers + nesting', () => {
    const sheet = parseStylesheet(`
      folder {
        icon: url(folder.svg);
        &:expanded { icon: url(folder-open.svg); }
      }
      file[ext="ts"] { icon: url(ts.svg); color: white; }

      @theme dark {
        file[ext="ts"] { color: #58a6ff; }
      }
    `);

    const tsFile = node({ name: 'index.ts' });
    const folder = node({
      name: 'src',
      type: 'folder',
      stateFlags: StateFlags.Expanded,
    });

    expect(resolveStyle(sheet, tsFile)).toEqual({
      icon: 'url(ts.svg)',
      color: 'white',
    });
    expect(resolveStyle(sheet, tsFile, 'dark')).toEqual({
      icon: 'url(ts.svg)',
      color: '#58a6ff',
    });
    expect(resolveStyle(sheet, folder)).toEqual({
      icon: 'url(folder-open.svg)',
    });
  });

  it('many rules with different selectors all resolve correctly', () => {
    const sheet = parseStylesheet(`
      file { icon: url(file.svg); }
      folder { icon: url(folder.svg); }
      file[ext="ts"] { icon: url(ts.svg); }
      file[ext="js"] { icon: url(js.svg); }
      file[name="Makefile"] { icon: url(make.svg); }
      file[lang="python"] { icon: url(py.svg); }
      folder:expanded { icon: url(folder-open.svg); }
      file[inVcsRepo] { badge: "G"; }
    `);

    expect(resolveStyle(sheet, node({ name: 'index.ts' })).icon).toBe('url(ts.svg)');
    expect(resolveStyle(sheet, node({ name: 'index.js' })).icon).toBe('url(js.svg)');
    expect(resolveStyle(sheet, node({ name: 'Makefile' })).icon).toBe('url(make.svg)');
    expect(resolveStyle(sheet, node({ name: 'app.py', lang: 'python' })).icon).toBe('url(py.svg)');
    expect(resolveStyle(sheet, node({ name: 'src', type: 'folder', stateFlags: StateFlags.Expanded })).icon).toBe('url(folder-open.svg)');
    expect(resolveStyle(sheet, node({ name: 'x.ts', meta: { inVcsRepo: true } })).badge).toBe('G');
    expect(resolveStyle(sheet, node({ name: 'unknown.xyz' })).icon).toBe('url(file.svg)');
  });
});
