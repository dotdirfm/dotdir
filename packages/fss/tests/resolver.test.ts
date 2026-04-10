import { describe, expect, it } from 'vitest';
import { parseStylesheet, resolveStyle, StateFlags } from '../src';
import { node } from './_helpers';

describe('resolveStyle', () => {
  it('matches type selector', () => {
    const sheet = parseStylesheet(`
      file { icon: url(file.svg); }
      folder { icon: url(folder.svg); }
    `);

    const fileNode = node({ name: 'test.txt', type: 'file' });
    const folderNode = node({ name: 'src', type: 'folder' });

    expect(resolveStyle(sheet, fileNode)).toEqual({ icon: 'url(file.svg)' });
    expect(resolveStyle(sheet, folderNode)).toEqual({
      icon: 'url(folder.svg)',
    });
  });

  it('matches attribute selector [ext="..."]', () => {
    const sheet = parseStylesheet(`
      file[ext="ts"] { icon: url(ts.svg); }
      file[ext="js"] { icon: url(js.svg); }
    `);

    const tsFile = node({ name: 'index.ts' });
    const jsFile = node({ name: 'index.js' });

    expect(resolveStyle(sheet, tsFile)).toEqual({ icon: 'url(ts.svg)' });
    expect(resolveStyle(sheet, jsFile)).toEqual({ icon: 'url(js.svg)' });
  });

  it('matches compound extension [ext="test.ts"]', () => {
    const sheet = parseStylesheet(`
      file[ext="ts"] { icon: url(ts.svg); }
      file[ext="test.ts"] { icon: url(test.svg); }
    `);

    const regular = node({ name: 'index.ts' });
    const test = node({ name: 'utils.test.ts' });

    // ext="ts" matches both index.ts and utils.test.ts (suffix match)
    // ext="test.ts" has higher specificity and overrides for test files
    expect(resolveStyle(sheet, regular)).toEqual({ icon: 'url(ts.svg)' });
    expect(resolveStyle(sheet, test)).toEqual({ icon: 'url(test.svg)' });
  });

  it('[ext="ts"] matches files with compound extensions', () => {
    const sheet = parseStylesheet(`
      file[ext="ts"] { color: red; }
    `);

    const simple = node({ name: 'index.ts' });
    const compound = node({ name: 'utils.test.ts' });
    const triple = node({ name: 'a.b.ts' });
    const noMatch = node({ name: 'index.js' });

    expect(resolveStyle(sheet, simple)).toEqual({ color: 'red' });
    expect(resolveStyle(sheet, compound)).toEqual({ color: 'red' });
    expect(resolveStyle(sheet, triple)).toEqual({ color: 'red' });
    expect(resolveStyle(sheet, noMatch)).toEqual({});
  });

  it('ext specificity: more segments win', () => {
    const sheet = parseStylesheet(`
      file[ext="test.ts"] { icon: url(test.svg); }
      file[ext="ts"] { icon: url(ts.svg); }
    `);

    // Even though ext="ts" comes after ext="test.ts",
    // ext="test.ts" has higher specificity (2 segments vs 1)
    const testFile = node({ name: 'utils.test.ts' });
    expect(resolveStyle(sheet, testFile)).toEqual({ icon: 'url(test.svg)' });
  });

  it('matches [name="..."] selector', () => {
    const sheet = parseStylesheet(`
      file[name="Dockerfile"] { icon: url(docker.svg); }
    `);

    const dockerfile = node({ name: 'Dockerfile' });
    const other = node({ name: 'README.md' });

    expect(resolveStyle(sheet, dockerfile)).toEqual({
      icon: 'url(docker.svg)',
    });
    expect(resolveStyle(sheet, other)).toEqual({});
  });

  it('matches boolean attribute [flag]', () => {
    const sheet = parseStylesheet(`
      file[inVcsRepo] { badge: "G"; }
    `);

    const inRepo = node({ name: 'test.ts', meta: { inVcsRepo: true } });
    const notInRepo = node({ name: 'test.ts', meta: {} });

    expect(resolveStyle(sheet, inRepo)).toEqual({ badge: 'G' });
    expect(resolveStyle(sheet, notInRepo)).toEqual({});
  });

  it('matches pseudo-class :expanded', () => {
    const sheet = parseStylesheet(`
      folder:expanded { icon: url(open.svg); }
    `);

    const expanded = node({
      name: 'src',
      type: 'folder',
      stateFlags: StateFlags.Expanded,
    });
    const collapsed = node({
      name: 'src',
      type: 'folder',
      stateFlags: StateFlags.None,
    });

    expect(resolveStyle(sheet, expanded)).toEqual({ icon: 'url(open.svg)' });
    expect(resolveStyle(sheet, collapsed)).toEqual({});
  });

  it('matches :is() pseudo-class', () => {
    const sheet = parseStylesheet(`
      file:is([ext="ts"], [ext="tsx"]) { icon: url(ts.svg); }
    `);

    const ts = node({ name: 'index.ts' });
    const tsx = node({ name: 'App.tsx' });
    const js = node({ name: 'index.js' });

    expect(resolveStyle(sheet, ts)).toEqual({ icon: 'url(ts.svg)' });
    expect(resolveStyle(sheet, tsx)).toEqual({ icon: 'url(ts.svg)' });
    expect(resolveStyle(sheet, js)).toEqual({});
  });

  it('matches descendant combinator', () => {
    const sheet = parseStylesheet(`
      folder[name=".github"] folder[name="workflows"] { icon: url(gh.svg); }
    `);

    const github = node({ name: '.github', type: 'folder', path: '/.github' });
    const workflows = node({
      name: 'workflows',
      type: 'folder',
      path: '/.github/workflows',
      parent: github,
    });
    const unrelated = node({
      name: 'workflows',
      type: 'folder',
      path: '/workflows',
    });

    expect(resolveStyle(sheet, workflows)).toEqual({ icon: 'url(gh.svg)' });
    expect(resolveStyle(sheet, unrelated)).toEqual({});
  });

  it('applies specificity: name > extension > type', () => {
    const sheet = parseStylesheet(`
      file { icon: url(file.svg); }
      file[ext="ts"] { icon: url(ts.svg); }
      file[name="tsconfig.json"] { icon: url(tsconfig.svg); }
    `);

    const tsconfig = node({ name: 'tsconfig.json' });
    const regular = node({ name: 'index.ts' });
    const txt = node({ name: 'readme.txt' });

    expect(resolveStyle(sheet, tsconfig)).toEqual({
      icon: 'url(tsconfig.svg)',
    });
    expect(resolveStyle(sheet, regular)).toEqual({ icon: 'url(ts.svg)' });
    expect(resolveStyle(sheet, txt)).toEqual({ icon: 'url(file.svg)' });
  });

  it('merges declarations from multiple matching rules', () => {
    const sheet = parseStylesheet(`
      file { color: white; }
      file[ext="ts"] { icon: url(ts.svg); }
    `);

    const ts = node({ name: 'index.ts' });
    const style = resolveStyle(sheet, ts);

    expect(style).toEqual({ color: 'white', icon: 'url(ts.svg)' });
  });

  it('later rules override earlier ones at same specificity', () => {
    const sheet = parseStylesheet(`
      file[ext="ts"] { icon: url(old.svg); }
      file[ext="ts"] { icon: url(new.svg); }
    `);

    const ts = node({ name: 'index.ts' });
    expect(resolveStyle(sheet, ts)).toEqual({ icon: 'url(new.svg)' });
  });

  it('matches ^= prefix operator', () => {
    const sheet = parseStylesheet(`
      file[ext^="test"] { badge: "T"; }
    `);

    const test = node({ name: 'foo.test.ts' });
    const regular = node({ name: 'foo.ts' });

    expect(resolveStyle(sheet, test)).toEqual({ badge: 'T' });
    expect(resolveStyle(sheet, regular)).toEqual({});
  });

  it('matches $= suffix operator', () => {
    const sheet = parseStylesheet(`
      file[ext$="d.ts"] { badge: "DT"; }
    `);

    const dts = node({ name: 'types.d.ts' });
    const regular = node({ name: 'index.ts' });

    expect(resolveStyle(sheet, dts)).toEqual({ badge: 'DT' });
    expect(resolveStyle(sheet, regular)).toEqual({});
  });

  it('matches meta attributes', () => {
    const sheet = parseStylesheet(`
      file[vcs-status="modified"] { color: orange; }
    `);

    const modified = node({
      name: 'test.ts',
      meta: { 'vcs-status': 'modified' },
    });
    const clean = node({ name: 'test.ts', meta: { 'vcs-status': 'clean' } });

    expect(resolveStyle(sheet, modified)).toEqual({ color: 'orange' });
    expect(resolveStyle(sheet, clean)).toEqual({});
  });

  it('returns empty object for unmatched node', () => {
    const sheet = parseStylesheet(`
      file[ext="rs"] { icon: url(rs.svg); }
    `);

    const tsFile = node({ name: 'index.ts' });
    expect(resolveStyle(sheet, tsFile)).toEqual({});
  });

  it('handles numeric declaration values', () => {
    const sheet = parseStylesheet(`
      file { opacity: 0.5; }
    `);

    const f = node({ name: 'test.txt' });
    const style = resolveStyle(sheet, f);
    expect(style.opacity).toBe(0.5);
    expect(typeof style.opacity).toBe('number');
  });
});
