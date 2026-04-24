# `@dotdirfm/ui`

Reusable React UI for DotDir.

`@dotdirfm/ui` renders the full DotDir shell inside your app:

- dual file panels
- command palette and command line
- integrated terminal
- file viewer and editor overlays
- extension manager
- themes, icon themes, language grammars, and FSS-based file styling

The package is UI-only. All host-specific behavior comes from a required `Bridge` implementation.

## Install

```bash
pnpm add @dotdirfm/ui react
```

Import the bundled stylesheet once:

```ts
import "@dotdirfm/ui/dotdir.css";
```

## Basic Usage

```tsx
import { DotDir, type Bridge } from "@dotdirfm/ui";
import "@dotdirfm/ui/dotdir.css";

type Props = {
  bridge: Bridge;
};

export function DotDirScreen({ bridge }: Props) {
  return (
    <div style={{ width: "100%", height: "100vh" }}>
      <DotDir bridge={bridge} widget={null} />
    </div>
  );
}
```

`DotDir` fills its container, so the host element must have an explicit height.

## Public API

Main exports:

- `DotDir`
- `defaultResolveVfsUrl`
- `basename`, `dirname`, `join`, `normalizePath`
- `Bridge`
- `DotDirHandle`
- `VfsUrlResolver`, `VfsUrlKind`
- filesystem, terminal, copy/move/delete, and extension-install event types

`DotDir` props:

- `bridge: Bridge`
- `widget: React.ReactNode`
- `resolveVfsUrl?: VfsUrlResolver`

Imperative handle:

```tsx
import { DotDir, type DotDirHandle } from "@dotdirfm/ui";
import { useRef } from "react";

const ref = useRef<DotDirHandle>(null);

ref.current?.focus();
```

## Architecture

For a top-level map of the package boundaries, provider stack, runtime flows, extension system, and source layout, see [ARCHITECTURE.md](./ARCHITECTURE.md).

## Bridge Contract

Your `Bridge` implementation is responsible for all host integration.

Required areas:

- `fs`
  list entries, stat files, read file contents, write files, watch directories, move to trash, copy, move, delete, rename
- `pty`
  spawn a shell, write to it, resize it, close it, and stream output/exit events
- `utils`
  return the home directory and environment variables
- `systemTheme`
  return the current system theme and subscribe to theme changes
- `extensions.install`
  install extensions and report progress

Optional areas:

- `fs.createDir`
- `pty.setShellIntegrations`
- `onReconnect`
- `fsProvider`
  support browsing files inside containers such as archives or images

The exported `Bridge` type in the package is the source of truth for the full contract.

## Browser And Demo Embedding

The package works well in browser demos too, as long as your `Bridge` implementation provides the same contract.

Typical embed:

```tsx
import { DotDir, type Bridge } from "@dotdirfm/ui";
import "@dotdirfm/ui/dotdir.css";

export function Demo({ bridge }: { bridge: Bridge }) {
  return (
    <div style={{ width: "100%", height: 560 }}>
      <DotDir bridge={bridge} widget={null} />
    </div>
  );
}
```

## VFS URLs

Viewer/editor extensions and file-backed assets are loaded through virtual URLs.

By default, `defaultResolveVfsUrl()` maps:

- file paths to `/vfs/...`
- extension directories to `/vfs/_ext/...`

If your host uses a different routing scheme, pass a custom `resolveVfsUrl(path, kind)`.

## Notes

- React `^19` is a peer dependency.
- The package ships CSS Modules internally and exposes a single compiled stylesheet for consumers.
- Extension installation is host-driven.
- `widget` is rendered inside the DotDir shell, and `null` is fine if you do not need an extra host widget.

## Repository

- GitHub: [dotdirfm/dotdir](https://github.com/dotdirfm/dotdir)
- Issues: [github.com/dotdirfm/dotdir/issues](https://github.com/dotdirfm/dotdir/issues)
