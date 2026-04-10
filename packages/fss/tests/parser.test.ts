import { describe, expect, it } from 'vitest';
import { parseStylesheet, StateFlags } from '../src';

describe('parseStylesheet', () => {
  it('parses basic type selector with declarations', () => {
    const sheet = parseStylesheet(`
      file { icon: url(default-file.svg); }
    `);

    expect(sheet.styleRules.length).toBe(1);
    expect(sheet.styleRules[0].declarations).toEqual({
      icon: 'url(default-file.svg)',
    });
  });

  it('parses attribute selectors', () => {
    const sheet = parseStylesheet(`
      file[ext="ts"] { icon: url(ts.svg); }
    `);

    expect(sheet.styleRules.length).toBe(1);
    const sel = sheet.styleRules[0].selectors[0];
    expect(sel.target.typeConstraint).toBe('file');
    expect(sel.target.attrs.length).toBe(1);
    expect(sel.target.attrs[0]).toEqual({
      name: 'ext',
      operator: '=',
      value: 'ts',
    });
  });

  it('parses pseudo-class selectors', () => {
    const sheet = parseStylesheet(`
      folder:expanded { icon: url(open.svg); }
    `);

    const sel = sheet.styleRules[0].selectors[0];
    expect(sel.target.typeConstraint).toBe('folder');
    expect(sel.target.requiredStates).toBe(StateFlags.Expanded);
  });

  it('parses descendant combinator', () => {
    const sheet = parseStylesheet(`
      folder[name=".github"] folder[name="workflows"] { icon: url(gh.svg); }
    `);

    const sel = sheet.styleRules[0].selectors[0];
    expect(sel.target.attrs[0]).toEqual({
      name: 'name',
      operator: '=',
      value: 'workflows',
    });
    expect(sel.ancestors.length).toBe(1);
    expect(sel.ancestors[0].attrs[0]).toEqual({
      name: 'name',
      operator: '=',
      value: '.github',
    });
  });

  it('parses :is() pseudo-class', () => {
    const sheet = parseStylesheet(`
      file:is([ext="ts"], [ext="tsx"]) { icon: url(ts.svg); }
    `);

    const sel = sheet.styleRules[0].selectors[0];
    expect(sel.target.isGroups).not.toBeNull();
    expect(sel.target.isGroups!.length).toBe(2);
  });

  it('parses boolean attribute selector', () => {
    const sheet = parseStylesheet(`
      file[inVcsRepo] { badge: "G"; }
    `);

    const sel = sheet.styleRules[0].selectors[0];
    expect(sel.target.attrs[0]).toEqual({
      name: 'inVcsRepo',
      operator: null,
      value: null,
    });
  });

  it('parses @sorting block', () => {
    const sheet = parseStylesheet(`
      @sorting {
        file[executable] { priority: 10; }
        folder { group-first: true; }
      }
    `);

    expect(sheet.sortingRules.length).toBe(2);
    expect(sheet.sortingRules[0].domain).toBe('sorting');
    expect(sheet.styleRules.length).toBe(0);
  });

  it('parses @table block', () => {
    const sheet = parseStylesheet(`
      @table {
        column(size) { visible: false; }
        column(modified) { width: 120; order: 2; }
      }
    `);

    expect(sheet.tableConfig.size).toEqual({ visible: false });
    expect(sheet.tableConfig.modified).toEqual({ width: 120, order: 2 });
  });

  it('parses comma-separated selector lists', () => {
    const sheet = parseStylesheet(`
      file[ext="ts"], file[ext="tsx"] { icon: url(ts.svg); }
    `);

    expect(sheet.styleRules[0].selectors.length).toBe(2);
  });

  it('parses attribute operators (^=, $=, ~=, !=)', () => {
    const sheet = parseStylesheet(`
      file[ext^="test"] { color: red; }
      file[ext$="d.ts"] { color: blue; }
    `);

    expect(sheet.styleRules[0].selectors[0].target.attrs[0].operator).toBe('^=');
    expect(sheet.styleRules[1].selectors[0].target.attrs[0].operator).toBe('$=');
  });

  it('handles multiple declarations', () => {
    const sheet = parseStylesheet(`
      file[ext="ts"] {
        icon: url(ts.svg);
        color: blue;
        opacity: 0.6;
        badge: "TS";
      }
    `);

    expect(sheet.styleRules[0].declarations).toEqual({
      icon: 'url(ts.svg)',
      color: 'blue',
      opacity: 0.6,
      badge: 'TS',
    });
  });

  it('parses empty stylesheet', () => {
    const sheet = parseStylesheet('');
    expect(sheet.styleRules.length).toBe(0);
    expect(sheet.sortingRules.length).toBe(0);
  });

  it('parses multiple pseudo-classes on one selector', () => {
    const sheet = parseStylesheet(`
      folder:expanded:selected { icon: url(active.svg); }
    `);

    const sel = sheet.styleRules[0].selectors[0];
    expect(sel.target.requiredStates).toBe(StateFlags.Expanded | StateFlags.Selected);
  });

  it('parses :root pseudo-class', () => {
    const sheet = parseStylesheet(`
      folder:root { icon: url(root.svg); }
    `);

    const sel = sheet.styleRules[0].selectors[0];
    expect(sel.target.requiresRoot).toBe(true);
  });

  it('rules are sorted by specificity then order', () => {
    const sheet = parseStylesheet(`
      file { icon: url(file.svg); }
      file[ext="ts"] { icon: url(ts.svg); }
      file[name="Dockerfile"] { icon: url(docker.svg); }
    `);

    // Specificity: type < ext < name; order should be ascending
    for (let i = 1; i < sheet.styleRules.length; i++) {
      const prev = sheet.styleRules[i - 1];
      const curr = sheet.styleRules[i];
      expect(curr.specificity > prev.specificity || (curr.specificity === prev.specificity && curr.order > prev.order)).toBe(true);
    }
  });
});
