# @dotdirfm/extension-api

Shared type definitions for the DotDir extension system. Pure types — no runtime code.

## Purpose

Defines the contract between host and extensions:

- **Viewer extensions** — mount/unmount/focus
- **Editor extensions** — mount/unmount/focus/setDirty/setLanguage
- **FS provider extensions** — listEntries/readFileRange
- **Host API** — readFile, statFile, file watching, theme, commands
- **Global window augmentation** (`window.dotdir`)

## Install

```bash
pnpm add @dotdirfm/extension-api
```

## Exports

| Export | Description |
|--------|-------------|
| `HostApi` | API provided by the host to extensions |
| `ViewerExtensionApi` | Interface for viewer extensions |
| `EditorExtensionApi` | Interface for editor extensions |
| `FsProviderExtensionApi` | Interface for filesystem provider extensions |
| `ColorThemeData`, `SystemThemeKind`, `ThemePreference` | Theme-related types |
| `FsProviderEntry`, `EntryKind` | Filesystem entry types |
