import { describe, expect, it } from 'vitest';
import type { FsNode } from '../src';
import { CachedResolver, parseStylesheet, resolveStyle } from '../src';
import { node } from './_helpers';

describe('performance', () => {
  it('handles 5000 files with 10000 rules efficiently', () => {
    // Build a stylesheet with 10000 rules:
    // - 5000 rules for specific file names
    // - 2000 rules for various extensions
    // - 2000 rules by type
    // - 1000 generic rules
    const ruleLines: string[] = [];

    for (let i = 0; i < 5000; i++) {
      ruleLines.push(`file[name="special-${i}.ts"] { badge: "S${i}"; }`);
    }
    for (let i = 0; i < 100; i++) {
      ruleLines.push(`file[ext="ext${i}"] { icon: url(ext${i}.svg); }`);
    }
    for (let i = 0; i < 1900; i++) {
      ruleLines.push(`file[ext="rare${i}"] { color: red; }`);
    }
    for (let i = 0; i < 2000; i++) {
      ruleLines.push(`file { opacity: 0.${i % 10}; }`);
    }
    for (let i = 0; i < 1000; i++) {
      ruleLines.push(`[vcs-status="status${i}"] { badge: "V${i}"; }`);
    }

    const sheet = parseStylesheet(ruleLines.join('\n'));
    expect(sheet.styleRules.length).toBe(10000);

    // Create 5000 files in same directory
    const parent = node({ name: 'big-dir', type: 'folder', path: '/big-dir' });
    const files: FsNode[] = [];
    for (let i = 0; i < 5000; i++) {
      files.push(
        node({
          name: `file-${i}.ts`,
          path: `/big-dir/file-${i}.ts`,
          parent,
        }),
      );
    }

    // First pass with CachedResolver — populates the cache
    const resolver = new CachedResolver(sheet);
    const startFirstPass = performance.now();
    for (const f of files) {
      resolver.resolveStyle(f);
    }
    const firstPassMs = performance.now() - startFirstPass;

    // Second pass — all 5000 files hit the CachedResolver cache
    // (same ext, same type, no meta → same style key)
    const startSecondPass = performance.now();
    for (const f of files) {
      resolver.resolveStyle(f);
    }
    const secondPassMs = performance.now() - startSecondPass;

    // The cached second pass should be faster than the cold first pass
    expect(secondPassMs).toBeLessThan(firstPassMs);

    // Verify correctness: a .ts file in big-dir gets type-based rules applied
    const style = resolver.resolveStyle(files[0]);
    expect(style).toBeDefined();
    // The last type rule wins
    expect(typeof style.opacity).toBe('number');
  });

  it('candidate list is cached per bucket key', () => {
    const sheet = parseStylesheet(`
      file { color: white; }
      file[ext="ts"] { icon: url(ts.svg); }
      file[name="Dockerfile"] { icon: url(docker.svg); }
    `);

    // Two different .ts files should use the cached candidate list
    const f1 = node({ name: 'a.ts', path: '/a.ts' });
    const f2 = node({ name: 'b.ts', path: '/b.ts' });

    const style1 = resolveStyle(sheet, f1);
    const style2 = resolveStyle(sheet, f2);

    // Both should resolve identically (same ext, same type, different name but no name rule)
    expect(style1).toEqual({ color: 'white', icon: 'url(ts.svg)' });
    expect(style2).toEqual({ color: 'white', icon: 'url(ts.svg)' });
  });

  it('parsing large stylesheet completes in reasonable time', () => {
    const rules: string[] = [];
    for (let i = 0; i < 1000; i++) {
      rules.push(`file[ext="ext${i}"] { icon: url(icon${i}.svg); color: #${String(i).padStart(6, '0')}; }`);
    }

    const start = performance.now();
    const sheet = parseStylesheet(rules.join('\n'));
    const elapsed = performance.now() - start;

    expect(sheet.styleRules.length).toBe(1000);
    // Should parse 1000 rules in under 5 seconds on any machine
    expect(elapsed).toBeLessThan(5000);
  });
});
