import type { FsNode } from '../src';
import { StateFlags } from '../src';
import { createFsNode } from '../src/helpers';

/**
 * Shorthand helper to create an FsNode for tests with sensible defaults.
 */
export function node(opts: Partial<Parameters<typeof createFsNode>[0]> & { name: string }): FsNode {
  return createFsNode({
    type: opts.type ?? 'file',
    name: opts.name,
    path: opts.path ?? '/' + opts.name,
    lang: opts.lang,
    parent: opts.parent,
    stateFlags: opts.stateFlags ?? StateFlags.None,
    meta: opts.meta ?? {},
  });
}
