# `@dotdirfm/ui` Architecture

## Overview

`@dotdirfm/ui` is the reusable React shell for DotDir. It owns the user-facing file manager experience: dual panels, file-list tabs, preview/editor tabs, command routing, command palette, command line, terminal integration, dialogs, extension UI surfaces, themes, icon themes, and file styling.

The package is intentionally host-neutral. It never talks directly to Tauri, Node, or a remote API. Host integration is supplied through the exported `Bridge` contract, and all paths, terminal sessions, filesystem events, extension installs, app directories, window operations, and virtual file URLs pass through that boundary.

Primary entry points:

- [`lib/DotDir.tsx`](./lib/DotDir.tsx) exports the public `DotDir` component, `DotDirHandle`, `Bridge`, path helpers, and VFS URL helpers.
- [`lib/app.tsx`](./lib/app.tsx) composes the interactive application shell after providers are mounted.
- [`lib/features/bridge/bridge.ts`](./lib/features/bridge/bridge.ts) defines the host contract.
- [`lib/viewerEditorRegistry.ts`](./lib/viewerEditorRegistry.ts) resolves viewer, editor, and filesystem-provider contributions.

## System Boundary

The core architectural line is:

```text
host app
  supplies Bridge + optional VFS resolver
    |
@dotdirfm/ui
  React shell, command system, tabs, terminal UI, extension runtime
    |
extensions
  commands, keybindings, languages, grammars, themes, viewers, editors, fsProviders
```

The UI package can be embedded in Tauri, a browser demo, or another React host as long as the host implements `Bridge`.

The `Bridge` is responsible for:

- Filesystem reads, writes, stats, watches, copy/move/delete/search/rename, and optional container-file backend providers.
- PTY lifecycle, writes, resizes, close events, and shell integration scripts.
- App directories, home path, mounted roots, environment variables, and optional external URL opening.
- System theme reads/subscriptions.
- Extension install lifecycle and progress.
- Optional window management.
- Optional reconnect notification.

The package exposes one default VFS URL resolver in [`lib/features/file-system/vfs.ts`](./lib/features/file-system/vfs.ts). Hosts can replace it with `resolveVfsUrl` when their file-serving route differs.

## Provider Stack

`DotDir` mounts a stable provider stack in [`lib/DotDir.tsx`](./lib/DotDir.tsx):

```text
VfsUrlResolverProvider
JotaiProvider
BridgeProvider
AppServicesProvider
FssProvider
ExtensionHostClientProvider
PanelControllersProvider
ExtensionHostWorkspaceSync
DotDirContent
```

`DotDirContent` then registers built-in command contributions and mounts:

```text
ErrorBoundary
Suspense
DialogProvider
UserSettingsProvider
AppRuntimeProvider
App
```

The split between `AppServicesProvider` and `AppRuntimeProvider` is deliberate:

- [`lib/appServices.tsx`](./lib/appServices.tsx) provides long-lived service registries: filesystem watches, command registry, focus context, and viewer/editor/fsProvider registries.
- [`lib/appRuntime.tsx`](./lib/appRuntime.tsx) provides runtime controllers derived from those services: persisted UI state, terminal controller, and command-line controller.

This keeps infrastructure registries available before feature controllers need to register themselves.

## Runtime Composition

[`App`](./lib/app.tsx) is the shell coordinator. It wires together:

- Startup readiness: waits for restored UI state and extension themes, with timeouts so a bad theme cannot block the app forever.
- Focus routing: registers the panel focus adapter and gives the command registry the current logical focus layer.
- Extension runtime: starts and reloads the extension host, applies extension contributions, and refreshes themes.
- Built-in commands: registers handlers for app-level commands such as open, edit, close viewer/editor, and file operations.
- File operation handlers: adapts copy, move, delete, trash, and rename into dialog-driven workflows.
- Layout: terminal background, panels overlay, command line, terminal toolbar, status bar, dialogs, and command palette.

The user-facing shell has two main modes:

- Panels visible: dual file panels and command line are interactive.
- Terminal visible: terminal receives focus and panels become inert until restored.

## Source Map

The package follows a loose feature-sliced layout:

- [`lib/components`](./lib/components) contains reusable UI surfaces such as file lists, panel tabs, command palette, breadcrumbs, action bars, lists, dropdowns, and popover menus.
- [`lib/dialogs`](./lib/dialogs) contains modal/dialog primitives and specific workflows such as rename, copy/move config, delete/copy progress, find files, settings, and help.
- [`lib/entities`](./lib/entities) contains simple domain model state for panels and tabs.
- [`lib/features`](./lib/features) contains application features: bridge, commands, command line, extensions, file icons, file operations, filesystem, FSS, languages, panels, settings, terminal, themes, and UI-state persistence.
- [`lib/hooks`](./lib/hooks) contains cross-feature hooks such as viewer/editor state and media query helpers.
- [`lib/processes`](./lib/processes) contains app-level background processes, currently workspace/session restore and persistence.
- [`lib/styles`](./lib/styles) contains package-level CSS Modules that are bundled into `dotdir.css`.
- [`lib/utils`](./lib/utils) contains path handling, media detection, container paths, CSS module helpers, binary search, style-host helpers, and input helpers.

Path aliasing uses `@/*` for `lib/*`, configured in [`tsconfig.json`](./tsconfig.json).

## State Model

State is intentionally mixed by lifetime and ownership:

- Global UI state uses Jotai atoms for lightweight shared state, including active panel/tab state, command palette state, terminal visibility, theme readiness, and recent autocomplete paths.
- Service-like state lives in React contexts for registries and controllers where lifecycle matters more than serialization.
- File list contents are stored in tab state as `fss-lang` `FsNode` entries, so styling and sorting can be resolved consistently.
- Persisted window layout/state is owned by [`features/ui-state`](./lib/features/ui-state/uiState.ts) and written under the host-provided data directory.
- User settings are loaded from config storage by [`features/settings`](./lib/features/settings), watched via JSONC file watchers, and patched back to disk with debounce.

The tab model in [`entities/tab/model/tabsAtoms.ts`](./lib/entities/tab/model/tabsAtoms.ts) is central. Each side has independent tabs and active tab ids, while derived atoms expose active/inactive panel views for commands and file operations.

## Panels, Tabs, And Navigation

Each side of the UI is a [`PanelGroup`](./lib/components/PanelGroup/PanelGroup.tsx). A panel owns:

- File-list tabs.
- Preview/editor tabs.
- Active tab selection and reorder/close behavior.
- Temporary preview tab reuse.
- Panel menu commands.
- Mounted-root and bookmark display.

Directory navigation lives in [`useFileListPanel`](./lib/features/panels/useFileListPanel.ts). It handles:

- Normal filesystem paths through `bridge.fs.entries`.
- Container paths through fsProvider contributions.
- Watch registration for the current directory, ancestors, and `.dir` style directories.
- Navigation cancellation and delayed loading indicators.
- Conversion from `Bridge` `FsEntry` values into `fss-lang` nodes.

[`PanelControllersProvider`](./lib/features/panels/panelControllers.tsx) is the imperative bridge between commands and visible panels. Commands do not reach directly into components; they ask the active panel controller to navigate, refresh, cancel navigation, or focus a file list.

## Commands And Focus

The command registry in [`features/commands/commands.ts`](./lib/features/commands/commands.ts) is the app's interaction bus. It owns:

- Command contributions.
- Command handlers.
- Keybinding layers: default, extension, user.
- `when` expression evaluation.
- Focus-context integration.

Keyboard events enter through [`useCommandRouting`](./lib/features/commands/useCommandRouting.ts). The current logical focus layer comes from [`focusContext.ts`](./lib/focusContext.ts), not just `document.activeElement`.

This lets the same keybinding map to different command behavior in panels, menus, command palette, autocomplete, viewer, editor, terminal, and modal contexts.

Command handler ownership is lifecycle-based: the latest active registration wins. A surface registers shared commands while it owns them and unregisters on unmount.

See also the repo-level keyboard design note in [`../../docs/keyboard-interaction-architecture.md`](../../docs/keyboard-interaction-architecture.md).

## Bridge And Filesystem Access

The UI treats filesystem access as asynchronous and host-owned. Helpers in [`features/file-system/fs.ts`](./lib/features/file-system/fs.ts) normalize paths and adapt the bridge into browser-like patterns:

- `readFile`, `readFileBuffer`, and `readFileText`.
- `FileSystemObserver`, backed by a shared watch registry so multiple consumers can observe the same path without duplicating host watches.

File operation workflows live in [`features/file-ops`](./lib/features/file-ops). They coordinate:

- Selected paths from active/inactive panels.
- Destination validation.
- Copy/move/delete progress dialogs.
- Conflict resolution callbacks.
- Container extraction/copy behavior through fsProvider extensions.
- Panel refresh and selection clearing after operations.

The package never assumes POSIX-only paths. Path helpers in [`utils/path.ts`](./lib/utils/path.ts) normalize separators and implement basename/dirname/join behavior used throughout the package.

## Extensions

Extensions are a first-class architecture layer, not just optional add-ons.

Installed manifests are normalized through a shared extension manifest normalizer before being projected into runtime lanes. The normalized loaded-extension payload carries activation compatibility, resolved activation entry metadata, and an internal trust tier. Open VSX manifests do not need DotDir-specific capability declarations.

The extension host client in [`features/extensions/extensionHostClient.ts`](./lib/features/extensions/extensionHostClient.ts) owns the worker, latches loaded extension payloads, and routes worker requests to main-thread services:

- Commands.
- Workspace/configuration reads and writes.
- Diagnostics and providers.
- Output/status/message events.
- External URL opening.
- Workspace edits.

[`useExtensionRuntime`](./lib/features/extensions/useExtensionRuntime.ts) coordinates the runtime:

- Starts/restarts the extension host.
- Registers extension commands and keybindings.
- Replaces viewer/editor/fsProvider registries.
- Applies icon/color themes and FSS layers.
- Resolves shell profiles and shell integration scripts.
- Watches install requests and auto-update behavior.

Supported contribution areas are defined in [`features/extensions/types.ts`](./lib/features/extensions/types.ts):

- Languages and TextMate grammar refs.
- Commands, keybindings, and command-palette menus.
- Viewers and editors.
- Filesystem providers for browsing containers.
- Icon themes and color themes.
- Shell integrations.
- Configuration schemas/defaults.

Viewer/editor/fsProvider resolution is priority-based and pattern-based in [`viewerEditorRegistry.ts`](./lib/viewerEditorRegistry.ts). Built-in fallbacks provide a file viewer and Monaco editor with very low priority so extension contributions can override them.

Extension UI surfaces are mounted through [`ExtensionContainer`](./lib/features/extensions/ExtensionContainer.tsx). Built-in surfaces live under [`features/extensions/builtins`](./lib/features/extensions/builtins) and render without iframes; external viewer/editor entries are always sandboxed in iframes.

See also the repo-level extension architecture note in [`../../docs/extensions-architecture.md`](../../docs/extensions-architecture.md) and the viewer/editor architecture note in [`../../docs/viewer-editor-extensions-architecture.md`](../../docs/viewer-editor-extensions-architecture.md).

## Viewer, Editor, And Preview Flow

Open/view/edit actions are coordinated by [`useViewerEditorState`](./lib/hooks/useViewerEditorState.tsx) and `PanelGroup`.

High-level flow:

```text
FileList command
  -> built-in command handler
  -> useViewerEditorState or PanelGroup preview-tab handler
  -> viewer/editor registry resolves contribution
  -> dialog or preview tab mounts ExtensionContainer
  -> extension/built-in surface reads/writes through Bridge-backed host APIs
```

Viewer/editor surfaces can appear as:

- Modal dialogs, managed by `DialogProvider`.
- Panel preview/editor tabs, managed by `PanelGroup`.

Editor dirty state is surfaced back to tab/dialog ownership so closing can prompt for unsaved changes.

Container files are special: opening a file that matches an fsProvider contribution navigates into a container path instead of opening a viewer.

## Terminal And Command Line

Terminal state is provided by [`features/terminal/useTerminal.tsx`](./lib/features/terminal/useTerminal.tsx) and lower-level session code in [`features/terminal`](./lib/features/terminal). The terminal controller:

- Creates and manages PTY-backed sessions through `bridge.pty`.
- Tracks active cwd and command-running context.
- Syncs terminal cwd back to the active panel when shell integration reports user-initiated cwd changes.
- Runs UI-launched commands in the active terminal and restores panels after command completion when requested.
- Restarts sessions on bridge reconnect.

The command line controller in [`features/command-line/useCommandLine.tsx`](./lib/features/command-line/useCommandLine.tsx) has two responsibilities:

- Run non-`cd` input in the terminal at the active cwd.
- Interpret DotDir-specific `cd` commands, including aliases stored in user settings, and navigate the active panel instead of spawning a shell command.

This separation lets the command line feel shell-like while still owning panel navigation semantics.

## Themes, Icons, And FSS

The visual system has three layers:

- Base CSS Modules and CSS custom properties from [`lib/styles`](./lib/styles).
- VS Code color themes mapped onto DotDir CSS variables in [`features/themes/vscodeColorTheme.ts`](./lib/features/themes/vscodeColorTheme.ts).
- File/folder styling through `fss-lang` in [`features/fss/fss.tsx`](./lib/features/fss/fss.tsx).

FSS layers are composed from:

- A built-in global layer.
- The active extension icon theme when it is FSS-backed.
- Any `.dir/fs.css` files found in the current directory's ancestor chain.

File icons are resolved by [`features/file-icons`](./lib/features/file-icons):

- FSS icon declarations can directly supply an icon path.
- VS Code icon themes are adapted through `VSCodeIconThemeAdapter`.
- The fallback adapter provides default icons.

Color theme loading is part of extension runtime startup. `App` waits for themes to become ready, but includes a timeout so the UI can recover if extension theme loading fails.

## Settings And Persistence

User settings are defined in [`features/settings/types.ts`](./lib/features/settings/types.ts). Current settings include:

- Active icon theme.
- Active color theme.
- Extension auto-update.
- Editor file size limit.
- Hidden-file visibility.
- Command-line path aliases.

Settings are loaded through `UserSettingsProvider`, watched for external changes, and saved back with debounced patches.

Workspace/window session persistence lives under [`processes/workspace-session`](./lib/processes/workspace-session). It uses `uiState` to restore and save:

- Panel tabs and active tab ids.
- Panel selection/navigation state.
- Window-specific state and layout.

## Build And Packaging

The package builds as a Vite library from [`lib/DotDir.tsx`](./lib/DotDir.tsx). The published package exposes:

- `.` as ESM/CJS plus TypeScript declarations.
- `./dotdir.css` as the compiled stylesheet.

Important package traits from [`package.json`](./package.json):

- React is a peer dependency.
- CSS is marked as a side effect.
- The build first builds workspace dependencies `fss-lang` and `@dotdirfm/extension-api`, then runs `tsc` and `vite build`.
- Tests run with Vitest.

## Architectural Rules Of Thumb

- Keep host-specific behavior behind `Bridge`. If a feature needs OS, Tauri, network, PTY, filesystem, or window behavior, add or use a bridge capability rather than importing host code.
- Prefer registering behavior through services and lifecycle hooks instead of passing large prop chains through the shell.
- Use commands for user-triggered behavior, especially keyboard behavior. Prefer focus layers and `when` clauses over surface-specific key listeners.
- Keep panel navigation in panel controllers and `useFileListPanel`; do not make dialogs or commands mutate file-list internals directly.
- Resolve viewer/editor/fsProvider behavior through registries. Do not special-case file types in command handlers unless the type is architectural, such as container navigation.
- Treat extensions as dynamic input. Runtime reload should clear old registrations, replace registries, and tolerate partial extension failure.
- Keep filesystem watchers shared and normalized. Avoid registering duplicate host watches for the same path.
- Put reusable UI primitives in `components`, domain flows in `features`, persisted/shared domain state in `entities` or `features/ui-state`, and app-level background coordination in `processes`.
- Preserve the package boundary: public exports belong in `DotDir.tsx`; internal modules should stay internal unless an embedder genuinely needs the type or helper.
