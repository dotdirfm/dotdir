import { describe, expect, it } from 'vitest';
import { parseStylesheet, resolveStyle } from '../src';
import { node } from './_helpers';

describe(':root pseudo-class', () => {
  it('matches root folder (no parent)', () => {
    const sheet = parseStylesheet(`
      folder:root { icon: url(root.svg); }
    `);

    const rootFolder = node({ name: 'project', type: 'folder', path: '/project' });
    const childFolder = node({
      name: 'src',
      type: 'folder',
      path: '/project/src',
      parent: rootFolder,
    });

    expect(resolveStyle(sheet, rootFolder)).toEqual({ icon: 'url(root.svg)' });
    expect(resolveStyle(sheet, childFolder)).toEqual({});
  });

  it(':root combined with attributes', () => {
    const sheet = parseStylesheet(`
      folder:root[name="my-project"] { icon: url(my-project.svg); }
    `);

    const matching = node({ name: 'my-project', type: 'folder', path: '/my-project' });
    const nonRoot = node({
      name: 'my-project',
      type: 'folder',
      path: '/other/my-project',
      parent: node({ name: 'other', type: 'folder', path: '/other' }),
    });

    expect(resolveStyle(sheet, matching)).toEqual({ icon: 'url(my-project.svg)' });
    expect(resolveStyle(sheet, nonRoot)).toEqual({});
  });

  it(':root has higher specificity than plain type', () => {
    const sheet = parseStylesheet(`
      folder { icon: url(folder.svg); }
      folder:root { icon: url(root.svg); }
    `);

    const rootFolder = node({ name: 'project', type: 'folder', path: '/project' });

    expect(resolveStyle(sheet, rootFolder)).toEqual({ icon: 'url(root.svg)' });
  });

  it(':root does not match file nodes with parents', () => {
    const sheet = parseStylesheet(`
      file:root { icon: url(root-file.svg); }
    `);

    const root = node({ name: 'readme.txt', type: 'file', path: '/readme.txt' });
    const child = node({
      name: 'readme.txt',
      type: 'file',
      path: '/docs/readme.txt',
      parent: node({ name: 'docs', type: 'folder', path: '/docs' }),
    });

    expect(resolveStyle(sheet, root)).toEqual({ icon: 'url(root-file.svg)' });
    expect(resolveStyle(sheet, child)).toEqual({});
  });
});
