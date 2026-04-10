import { describe, expect, it } from 'vitest';
import { CachedResolver, parseStylesheet } from '../src';
import { node } from './_helpers';

describe('CachedResolver', () => {
  it('returns same result from cache', () => {
    const sheet = parseStylesheet(`
      file[ext="ts"] { icon: url(ts.svg); }
    `);

    const resolver = new CachedResolver(sheet);
    const n = node({ name: 'index.ts' });

    const first = resolver.resolveStyle(n);
    const second = resolver.resolveStyle(n);

    expect(first).toEqual({ icon: 'url(ts.svg)' });
    expect(first).toBe(second); // Same reference = cache hit
  });

  it('invalidates cache', () => {
    const sheet1 = parseStylesheet(`
      file[ext="ts"] { icon: url(old.svg); }
    `);
    const sheet2 = parseStylesheet(`
      file[ext="ts"] { icon: url(new.svg); }
    `);

    const resolver = new CachedResolver(sheet1);
    const n = node({ name: 'index.ts' });

    expect(resolver.resolveStyle(n)).toEqual({ icon: 'url(old.svg)' });

    resolver.setStylesheet(sheet2);
    expect(resolver.resolveStyle(n)).toEqual({ icon: 'url(new.svg)' });
  });

  it('caches different nodes separately', () => {
    const sheet = parseStylesheet(`
      file[ext="ts"] { icon: url(ts.svg); }
      file[ext="js"] { icon: url(js.svg); }
    `);

    const resolver = new CachedResolver(sheet);
    const ts = node({ name: 'index.ts' });
    const js = node({ name: 'index.js' });

    expect(resolver.resolveStyle(ts)).toEqual({ icon: 'url(ts.svg)' });
    expect(resolver.resolveStyle(js)).toEqual({ icon: 'url(js.svg)' });
  });

  it('resolves sorting with cache', () => {
    const sheet = parseStylesheet(`
      @sorting {
        file[executable] { priority: 10; }
      }
    `);

    const resolver = new CachedResolver(sheet);
    const exec = node({ name: 'run.sh', meta: { executable: true } });

    const first = resolver.resolveSorting(exec);
    const second = resolver.resolveSorting(exec);

    expect(first).toEqual({ priority: 10 });
    expect(first).toBe(second);
  });

  it('CachedResolver with theme', () => {
    const sheet = parseStylesheet(`
      file[ext="ts"] { icon: url(ts.svg); color: white; }
      @theme dark {
        file[ext="ts"] { color: #58a6ff; }
      }
      @theme light {
        file[ext="ts"] { color: #0366d6; }
      }
    `);

    const resolver = new CachedResolver(sheet, 'dark');
    const tsFile = node({ name: 'index.ts', path: '/index.ts' });

    const style = resolver.resolveStyle(tsFile);
    expect(style.color).toBe('#58a6ff');

    // Switch theme
    resolver.setTheme('light');
    expect(resolver.getTheme()).toBe('light');
    const lightStyle = resolver.resolveStyle(tsFile);
    expect(lightStyle.color).toBe('#0366d6');
  });
});
