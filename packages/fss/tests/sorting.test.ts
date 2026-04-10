import { describe, expect, it } from 'vitest';
import { parseStylesheet, resolveSorting } from '../src';
import { node } from './_helpers';

describe('resolveSorting', () => {
  it('resolves sorting rules', () => {
    const sheet = parseStylesheet(`
      @sorting {
        file[executable] { priority: 10; }
      }
    `);

    const exec = node({ name: 'run.sh', meta: { executable: true } });
    const regular = node({ name: 'test.ts' });

    expect(resolveSorting(sheet, exec)).toEqual({ priority: 10 });
    expect(resolveSorting(sheet, regular)).toEqual({});
  });

  it('resolves multiple sorting properties', () => {
    const sheet = parseStylesheet(`
      @sorting {
        folder { group-first: true; order: 0; }
        file[executable] { priority: 10; }
      }
    `);

    const folder = node({ name: 'src', type: 'folder' });
    expect(resolveSorting(sheet, folder)).toEqual({ 'group-first': true, order: 0 });
  });

  it('sorting rules do not appear in style rules', () => {
    const sheet = parseStylesheet(`
      file { icon: url(file.svg); }
      @sorting {
        file[executable] { priority: 10; }
      }
    `);

    expect(sheet.styleRules.length).toBe(1);
    expect(sheet.sortingRules.length).toBe(1);
  });

  it('sorting specificity: more specific selector wins', () => {
    const sheet = parseStylesheet(`
      @sorting {
        file { order: 1; }
        file[ext="ts"] { order: 5; }
      }
    `);

    const tsFile = node({ name: 'index.ts' });
    expect(resolveSorting(sheet, tsFile)).toEqual({ order: 5 });
  });
});
