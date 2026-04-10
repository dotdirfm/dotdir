import { beforeEach, describe, expect, it } from 'vitest';
import { createLayer, LayeredResolver, LayerPriority } from '../src';
import { node } from './_helpers';

describe('LayeredResolver', () => {
  let resolver: LayeredResolver;

  beforeEach(() => {
    resolver = new LayeredResolver();
  });

  it('applies global layer', () => {
    resolver.addLayer(
      createLayer(
        `
      file { icon: url(file.svg); }
    `,
        '/',
        LayerPriority.GLOBAL,
      ),
    );

    const n = node({ name: 'test.ts', path: '/test.ts' });
    expect(resolver.resolveStyle(n)).toEqual({ icon: 'url(file.svg)' });
  });

  it('nested layer overrides global', () => {
    resolver.addLayer(
      createLayer(
        `
      file[ext="ts"] { icon: url(global-ts.svg); }
    `,
        '/',
        LayerPriority.GLOBAL,
      ),
    );

    resolver.addLayer(
      createLayer(
        `
      file[ext="ts"] { icon: url(project-ts.svg); }
    `,
        '/project/',
        LayerPriority.PROJECT,
      ),
    );

    const inProject = node({ name: 'index.ts', path: '/project/index.ts' });
    const outside = node({ name: 'index.ts', path: '/other/index.ts' });

    expect(resolver.resolveStyle(inProject)).toEqual({
      icon: 'url(project-ts.svg)',
    });
    expect(resolver.resolveStyle(outside)).toEqual({
      icon: 'url(global-ts.svg)',
    });
  });

  it('deeper nested layer overrides parent layer', () => {
    resolver.addLayer(
      createLayer(
        `
      file { icon: url(root.svg); }
    `,
        '/',
        LayerPriority.GLOBAL,
      ),
    );

    resolver.addLayer(
      createLayer(
        `
      file { icon: url(project.svg); }
    `,
        '/project/',
        LayerPriority.PROJECT,
      ),
    );

    resolver.addLayer(
      createLayer(
        `
      file { icon: url(sub.svg); }
    `,
        '/project/sub/',
        LayerPriority.nestedPriority(1),
      ),
    );

    const deep = node({ name: 'test.ts', path: '/project/sub/test.ts' });
    const proj = node({ name: 'test.ts', path: '/project/test.ts' });
    const root = node({ name: 'test.ts', path: '/test.ts' });

    expect(resolver.resolveStyle(deep)).toEqual({ icon: 'url(sub.svg)' });
    expect(resolver.resolveStyle(proj)).toEqual({ icon: 'url(project.svg)' });
    expect(resolver.resolveStyle(root)).toEqual({ icon: 'url(root.svg)' });
  });

  it('merges properties across layers', () => {
    resolver.addLayer(
      createLayer(
        `
      file { color: white; }
    `,
        '/',
        LayerPriority.GLOBAL,
      ),
    );

    resolver.addLayer(
      createLayer(
        `
      file[ext="ts"] { icon: url(ts.svg); }
    `,
        '/',
        LayerPriority.GLOBAL,
      ),
    );

    const n = node({ name: 'index.ts', path: '/index.ts' });
    expect(resolver.resolveStyle(n)).toEqual({
      color: 'white',
      icon: 'url(ts.svg)',
    });
  });

  it('resolves table config across layers', () => {
    resolver.addLayer(
      createLayer(
        `
      @table {
        column(size) { visible: true; width: 100; }
        column(modified) { visible: true; }
      }
    `,
        '/',
        LayerPriority.GLOBAL,
      ),
    );

    resolver.addLayer(
      createLayer(
        `
      @table {
        column(size) { visible: false; }
      }
    `,
        '/project/',
        LayerPriority.PROJECT,
      ),
    );

    const config = resolver.resolveTableConfig('/project/src/file.ts');
    expect(config.size).toEqual({ visible: false, width: 100 }); // nested overrides visible, keeps width
    expect(config.modified).toEqual({ visible: true });
  });

  it('removes layer', () => {
    resolver.addLayer(
      createLayer(
        `
      file { icon: url(global.svg); }
    `,
        '/',
        LayerPriority.GLOBAL,
      ),
    );

    resolver.addLayer(
      createLayer(
        `
      file { icon: url(project.svg); }
    `,
        '/project/',
        LayerPriority.PROJECT,
      ),
    );

    const n = node({ name: 'test.ts', path: '/project/test.ts' });
    expect(resolver.resolveStyle(n)).toEqual({ icon: 'url(project.svg)' });

    resolver.removeLayer('/project/');
    expect(resolver.resolveStyle(n)).toEqual({ icon: 'url(global.svg)' });
  });

  it('LayeredResolver with theme', () => {
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
    `;

    resolver.addLayer(createLayer(FSS, '/', LayerPriority.GLOBAL));

    const tsFile = node({ name: 'index.ts', path: '/index.ts' });

    resolver.setTheme('dark');
    const darkStyle = resolver.resolveStyle(tsFile);
    expect(darkStyle.color).toBe('#58a6ff');

    resolver.setTheme('light');
    const lightStyle = resolver.resolveStyle(tsFile);
    expect(lightStyle.color).toBe('#0366d6');
  });

  it('resolves sorting across layers', () => {
    resolver.addLayer(
      createLayer(
        `
      @sorting {
        file { order: 0; }
      }
    `,
        '/',
        LayerPriority.GLOBAL,
      ),
    );

    resolver.addLayer(
      createLayer(
        `
      @sorting {
        file[ext="ts"] { order: 5; }
      }
    `,
        '/project/',
        LayerPriority.PROJECT,
      ),
    );

    const tsFile = node({ name: 'index.ts', path: '/project/index.ts' });
    expect(resolver.resolveSorting(tsFile)).toEqual({ order: 5 });
  });

  it('setLayers replaces all layers', () => {
    resolver.addLayer(
      createLayer(
        `
      file { icon: url(old.svg); }
    `,
        '/',
        LayerPriority.GLOBAL,
      ),
    );

    const n = node({ name: 'test.ts', path: '/test.ts' });
    expect(resolver.resolveStyle(n)).toEqual({ icon: 'url(old.svg)' });

    resolver.setLayers([createLayer(`file { icon: url(new.svg); }`, '/', LayerPriority.GLOBAL)]);
    expect(resolver.resolveStyle(n)).toEqual({ icon: 'url(new.svg)' });
  });

  it('getLayers returns current layers', () => {
    const layer = createLayer(`file { icon: url(f.svg); }`, '/', LayerPriority.GLOBAL);
    resolver.addLayer(layer);

    expect(resolver.getLayers().length).toBe(1);
    expect(resolver.getLayers()[0]).toBe(layer);
  });
});
