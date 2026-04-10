import { beforeEach, describe, expect, it } from 'vitest';
import type { CompiledStylesheet, FsNode } from '../src';
import { parseStylesheet, resolveStyle } from '../src';
import { node } from './_helpers';

describe('@theme', () => {
  const FSS = `
    file { icon: url(file.svg); color: white; }
    file[ext="ts"] { icon: url(ts.svg); }

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
  `;

  let sheet: CompiledStylesheet;
  let tsFile: FsNode;

  beforeEach(() => {
    sheet = parseStylesheet(FSS);
    tsFile = node({ name: 'index.ts', path: '/index.ts' });
  });

  it('parses @theme rules into styleRules', () => {
    // Base: 2 rules (file, file[ext="ts"])
    // dark: 2 rules
    // light: 2 rules
    // high-contrast: 1 rule
    // high-contrast-light: 1 rule
    expect(sheet.styleRules.length).toBe(8);
  });

  it('tags rules with correct theme', () => {
    const themes = sheet.styleRules.map((r) => r.theme);
    expect(themes.filter((t) => t === null).length).toBe(2);
    expect(themes.filter((t) => t === 'dark').length).toBe(2);
    expect(themes.filter((t) => t === 'light').length).toBe(2);
    expect(themes.filter((t) => t === 'high-contrast').length).toBe(1);
    expect(themes.filter((t) => t === 'high-contrast-light').length).toBe(1);
  });

  it('without theme, only unscoped rules apply', () => {
    const style = resolveStyle(sheet, tsFile);
    expect(style).toEqual({ icon: 'url(ts.svg)', color: 'white' });
  });

  it('dark theme merges base + dark rules', () => {
    const style = resolveStyle(sheet, tsFile, 'dark');
    expect(style).toEqual({ icon: 'url(ts.svg)', color: '#58a6ff' });
  });

  it('light theme merges base + light rules', () => {
    const style = resolveStyle(sheet, tsFile, 'light');
    expect(style).toEqual({ icon: 'url(ts.svg)', color: '#0366d6' });
  });

  it('high-contrast theme merges base + hc rules', () => {
    const style = resolveStyle(sheet, tsFile, 'high-contrast');
    expect(style).toEqual({ icon: 'url(ts.svg)', color: '#79c0ff', 'font-weight': 'bold' });
  });

  it('high-contrast-light theme merges base + hcl rules', () => {
    const style = resolveStyle(sheet, tsFile, 'high-contrast-light');
    expect(style).toEqual({ icon: 'url(ts.svg)', color: '#0969da', 'font-weight': 'bold' });
  });

  it('non-matching extensions get only base + theme type rules', () => {
    const jsFile = node({ name: 'app.js', path: '/app.js' });
    const darkStyle = resolveStyle(sheet, jsFile, 'dark');
    expect(darkStyle).toEqual({ icon: 'url(file.svg)', color: '#ccc' });
  });

  it('ignores invalid theme names', () => {
    const sheet2 = parseStylesheet(`
      file { color: white; }
      @theme neon {
        file { color: lime; }
      }
    `);
    // The invalid @theme block is ignored
    expect(sheet2.styleRules.length).toBe(1);
    expect(sheet2.styleRules[0].theme).toBeNull();
  });

  it('theme rules preserve specificity ordering', () => {
    const sheet2 = parseStylesheet(`
      @theme dark {
        file { color: gray; }
        file[ext="ts"] { color: blue; }
      }
    `);

    const style = resolveStyle(sheet2, tsFile, 'dark');
    // ext rule is more specific than type rule
    expect(style.color).toBe('blue');
  });

  it('theme rules do not leak to other themes', () => {
    const style = resolveStyle(sheet, tsFile, 'light');
    // Should NOT have high-contrast's font-weight
    expect(style['font-weight']).toBeUndefined();
  });

  it('theme-scoped rules do not apply without theme', () => {
    const sheet2 = parseStylesheet(`
      @theme dark {
        file { color: #ccc; }
      }
    `);

    const f = node({ name: 'test.txt' });
    expect(resolveStyle(sheet2, f)).toEqual({});
  });
});
