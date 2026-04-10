import { describe, expect, it } from 'vitest';
import { parseStylesheet, resolveStyle } from '../src';
import { node } from './_helpers';

describe('[lang="..."] selector', () => {
  it('matches by language', () => {
    const sheet = parseStylesheet(`
      file[lang="typescript"] { icon: url(ts.svg); color: blue; }
      file[lang="python"] { icon: url(py.svg); color: green; }
    `);

    const tsFile = node({
      name: 'index.ts',
      path: '/index.ts',
      lang: 'typescript',
    });
    const pyFile = node({ name: 'app.py', path: '/app.py', lang: 'python' });
    const mdFile = node({
      name: 'README.md',
      path: '/README.md',
      lang: 'markdown',
    });

    expect(resolveStyle(sheet, tsFile)).toEqual({
      icon: 'url(ts.svg)',
      color: 'blue',
    });
    expect(resolveStyle(sheet, pyFile)).toEqual({
      icon: 'url(py.svg)',
      color: 'green',
    });
    expect(resolveStyle(sheet, mdFile)).toEqual({});
  });

  it('indexes rules by lang for fast lookup', () => {
    const sheet = parseStylesheet(`
      file[lang="typescript"] { icon: url(ts.svg); }
    `);

    expect(sheet.byLang.has('typescript')).toBe(true);
    expect(sheet.byLang.get('typescript')!.length).toBe(1);
  });

  it('combines lang with other selectors', () => {
    const sheet = parseStylesheet(`
      file[lang="typescript"][ext="test.ts"] { badge: "test"; }
      file[lang="typescript"] { icon: url(ts.svg); }
    `);

    const testFile = node({
      name: 'app.test.ts',
      path: '/app.test.ts',
      lang: 'typescript',
    });
    const srcFile = node({
      name: 'app.ts',
      path: '/app.ts',
      lang: 'typescript',
    });

    expect(resolveStyle(sheet, testFile)).toEqual({
      icon: 'url(ts.svg)',
      badge: 'test',
    });
    expect(resolveStyle(sheet, srcFile)).toEqual({ icon: 'url(ts.svg)' });
  });

  it('lang works with themes', () => {
    const sheet = parseStylesheet(`
      file[lang="typescript"] { icon: url(ts.svg); color: white; }
      @theme dark {
        file[lang="typescript"] { color: #58a6ff; }
      }
      @theme light {
        file[lang="typescript"] { color: #0366d6; }
      }
    `);

    const tsFile = node({
      name: 'index.ts',
      path: '/index.ts',
      lang: 'typescript',
    });

    expect(resolveStyle(sheet, tsFile)).toEqual({
      icon: 'url(ts.svg)',
      color: 'white',
    });
    expect(resolveStyle(sheet, tsFile, 'dark')).toEqual({
      icon: 'url(ts.svg)',
      color: '#58a6ff',
    });
    expect(resolveStyle(sheet, tsFile, 'light')).toEqual({
      icon: 'url(ts.svg)',
      color: '#0366d6',
    });
  });

  it('lang with descendant combinator', () => {
    const sheet = parseStylesheet(`
      folder[name="src"] file[lang="typescript"] { badge: "src"; }
    `);

    const src = node({ name: 'src', type: 'folder', path: '/src' });
    const tsFile = node({
      name: 'index.ts',
      path: '/src/index.ts',
      lang: 'typescript',
      parent: src,
    });
    const orphanTs = node({
      name: 'index.ts',
      path: '/index.ts',
      lang: 'typescript',
    });

    expect(resolveStyle(sheet, tsFile)).toEqual({ badge: 'src' });
    expect(resolveStyle(sheet, orphanTs)).toEqual({});
  });

  it('lang with :is() grouping', () => {
    const sheet = parseStylesheet(`
      file:is([lang="typescript"], [lang="javascript"]) { color: yellow; }
    `);

    const tsFile = node({ name: 'a.ts', path: '/a.ts', lang: 'typescript' });
    const jsFile = node({ name: 'b.js', path: '/b.js', lang: 'javascript' });
    const pyFile = node({ name: 'c.py', path: '/c.py', lang: 'python' });

    expect(resolveStyle(sheet, tsFile)).toEqual({ color: 'yellow' });
    expect(resolveStyle(sheet, jsFile)).toEqual({ color: 'yellow' });
    expect(resolveStyle(sheet, pyFile)).toEqual({});
  });

  it('lang specificity: lang+ext > lang > type', () => {
    const sheet = parseStylesheet(`
      file { color: white; }
      file[lang="typescript"] { color: blue; }
      file[lang="typescript"][ext="test.ts"] { color: red; }
    `);

    const testFile = node({
      name: 'app.test.ts',
      path: '/app.test.ts',
      lang: 'typescript',
    });
    expect(resolveStyle(sheet, testFile).color).toBe('red');
  });

  it('no lang on node means empty string, no match', () => {
    const sheet = parseStylesheet(`
      file[lang="typescript"] { icon: url(ts.svg); }
    `);

    const noLang = node({ name: 'somefile.ts', path: '/somefile.ts' });
    expect(resolveStyle(sheet, noLang)).toEqual({});
  });
});
