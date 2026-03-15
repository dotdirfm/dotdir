import { bridge } from './bridge';
import { join } from './path';

/**
 * Recursively collect all file and directory paths under dirPath.
 * Returns files first, then dirs sorted by path length descending (deepest first)
 * so they can be deleted in order with fsa_delete_path (empty dir).
 */
export async function collectPathsForDelete(dirPath: string): Promise<{ files: string[]; dirs: string[] }> {
  const files: string[] = [];
  const dirs: string[] = [];

  async function walk(dir: string): Promise<void> {
    const entries = await bridge.fsa.entries(dir);
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.kind === 'file') {
        files.push(full);
      } else {
        dirs.push(full);
        await walk(full);
      }
    }
  }

  await walk(dirPath);
  dirs.push(dirPath);
  dirs.sort((a, b) => b.length - a.length);
  return { files, dirs };
}
