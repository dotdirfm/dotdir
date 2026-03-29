# `@dotdirfm/ui`

Reusable React UI for DotDir.

It renders the full DotDir shell:

- dual file panels
- command line
- terminal integration
- extension manager
- viewer/editor overlays
- themes, icon themes, and language contributions

The package is UI-only. Host-specific behavior comes from a required `Bridge` implementation that provides filesystem, terminal, theme, and extension-install APIs.

## Install

```bash
pnpm add @dotdirfm/ui react
```

Import the bundled styles once:

```ts
import "@dotdirfm/ui/dotdir.css";
```

## Basic Usage

```tsx
import { DotDir, defaultResolveVfsUrl, type Bridge } from "@dotdirfm/ui";
import "@dotdirfm/ui/dotdir.css";

type Props = {
  bridge: Bridge;
};

export function DotDirScreen({ bridge }: Props) {
  return (
    <div style={{ width: "100%", height: "100vh" }}>
      <DotDir
        bridge={bridge}
        widget={null}
        resolveVfsUrl={defaultResolveVfsUrl}
      />
    </div>
  );
}
```

`DotDir` fills its container, so the host element must have an explicit height.

## Required Bridge

The exported `Bridge` type defines the host contract. Your implementation must provide:

- `fs`
  file listing, reads, writes, watch events, copy/move/delete/rename
- `pty`
  terminal spawn, write, resize, close, and output events
- `utils`
  home path and environment variables
- `theme`
  current theme and change subscription
- `extensions.install`
  start progress-driven extension installation

This keeps the UI portable across:

- Tauri / desktop
- browser demos
- websocket / remote hosts

## VFS URLs

Viewer/editor extensions and file-backed assets load through virtual URLs.

By default, `defaultResolveVfsUrl()` maps:

- file paths to `/vfs/...`
- extension directories to `/vfs/_ext/...`

If your host uses a different routing scheme, pass a custom `resolveVfsUrl(path, kind)`.

## Exports

Main exports:

- `DotDir`
- `defaultResolveVfsUrl`
- `normalizePath`, `join`, `dirname`, `basename`
- `Bridge` and related progress/event types
- `VfsUrlResolver`, `VfsUrlKind`

## Notes

- React `^19` is a peer dependency.
- The package ships CSS Modules internally and exposes a single compiled stylesheet for consumers.
- Extension installation is host-driven. The UI no longer performs archive extraction itself.

## Repository

- GitHub: [dotdirfm/dotdir](https://github.com/dotdirfm/dotdir)
- Issues: [github.com/dotdirfm/dotdir/issues](https://github.com/dotdirfm/dotdir/issues)
