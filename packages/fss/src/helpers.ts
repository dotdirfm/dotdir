import type { FsNode, FsNodeType, StateFlags } from './types.js';
import { StateFlags as SF } from './types.js';

/**
 * Helper to create an FsNode from minimal info.
 * Automatically computes baseExt and fullExt from the name.
 */
export function createFsNode(opts: {
  type: FsNodeType;
  name: string;
  path: string;
  lang?: string;
  parent?: FsNode;
  stateFlags?: StateFlags;
  meta?: Record<string, unknown>;
}): FsNode {
  const dotIndex = opts.name.indexOf('.');
  const lastDotIndex = opts.name.lastIndexOf('.');

  let baseExt = '';
  let fullExt = '';

  if (opts.type === 'file' && dotIndex > 0) {
    fullExt = opts.name.substring(dotIndex + 1); // e.g. "test.ts" from "foo.test.ts"
    baseExt = lastDotIndex > 0 ? opts.name.substring(lastDotIndex + 1) : fullExt; // e.g. "ts"
  }

  return {
    type: opts.type,
    name: opts.name,
    baseExt,
    fullExt,
    lang: opts.lang ?? '',
    path: opts.path,
    parent: opts.parent,
    stateFlags: opts.stateFlags ?? SF.None,
    meta: opts.meta ?? {},
  };
}
