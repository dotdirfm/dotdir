import { describe, expect, it } from 'vitest';
import { StateFlags } from '../src';
import { createFsNode } from '../src/helpers';

describe('createFsNode', () => {
  it('computes baseExt and fullExt from simple filename', () => {
    const n = createFsNode({
      type: 'file',
      name: 'index.ts',
      path: '/index.ts',
    });
    expect(n.baseExt).toBe('ts');
    expect(n.fullExt).toBe('ts');
  });

  it('computes compound extension correctly', () => {
    const n = createFsNode({
      type: 'file',
      name: 'utils.test.ts',
      path: '/utils.test.ts',
    });
    expect(n.baseExt).toBe('ts');
    expect(n.fullExt).toBe('test.ts');
  });

  it('handles triple-dotted filename', () => {
    const n = createFsNode({ type: 'file', name: 'a.b.c.d', path: '/a.b.c.d' });
    expect(n.baseExt).toBe('d');
    expect(n.fullExt).toBe('b.c.d');
  });

  it('returns empty extensions for folder', () => {
    const n = createFsNode({
      type: 'folder',
      name: 'src.backup',
      path: '/src.backup',
    });
    expect(n.baseExt).toBe('');
    expect(n.fullExt).toBe('');
  });

  it('returns empty extensions for dotfile without extension', () => {
    const n = createFsNode({
      type: 'file',
      name: '.gitignore',
      path: '/.gitignore',
    });
    // First dot is at index 0 — dotIndex > 0 check fails → no extension
    expect(n.baseExt).toBe('');
    expect(n.fullExt).toBe('');
  });

  it('handles extensionless file', () => {
    const n = createFsNode({
      type: 'file',
      name: 'Makefile',
      path: '/Makefile',
    });
    expect(n.baseExt).toBe('');
    expect(n.fullExt).toBe('');
  });

  it('applies default stateFlags and meta', () => {
    const n = createFsNode({ type: 'file', name: 'f.txt', path: '/f.txt' });
    expect(n.stateFlags).toBe(StateFlags.None);
    expect(n.meta).toEqual({});
  });

  it('preserves provided meta and stateFlags', () => {
    const n = createFsNode({
      type: 'folder',
      name: 'src',
      path: '/src',
      stateFlags: StateFlags.Expanded,
      meta: { vcsStatus: 'clean' },
    });
    expect(n.stateFlags).toBe(StateFlags.Expanded);
    expect(n.meta).toEqual({ vcsStatus: 'clean' });
  });

  it('preserves parent reference', () => {
    const parent = createFsNode({ type: 'folder', name: 'root', path: '/' });
    const child = createFsNode({
      type: 'file',
      name: 'f.ts',
      path: '/f.ts',
      parent,
    });
    expect(child.parent).toBe(parent);
  });

  it('defaults lang to empty string', () => {
    const n = createFsNode({ type: 'file', name: 'f.ts', path: '/f.ts' });
    expect(n.lang).toBe('');
  });

  it('preserves provided lang', () => {
    const n = createFsNode({
      type: 'file',
      name: 'f.ts',
      path: '/f.ts',
      lang: 'typescript',
    });
    expect(n.lang).toBe('typescript');
  });
});
