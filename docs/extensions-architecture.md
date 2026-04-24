# Extensions Architecture

## Overview

DotDir extensions are loaded from disk, described by VS Code/Open VSX-style `package.json` manifests, and projected into the UI through explicit runtime lanes.

There is no required `capabilities` field. Open VSX manifests must load unmodified. DotDir instead derives internal compatibility and trust metadata while normalizing each manifest.

There is no single "extension runtime." The architecture has four cooperating lanes:

```text
installed extension files
  |
extension host worker
  loads manifests, activates browser scripts, hosts the VS Code shim
  |
main-thread runtime
  registers commands, keybindings, themes, viewers, editors, fsProviders, shell profiles
  |
UI surfaces
  panels, command palette, Monaco, terminal, settings, viewer/editor iframes
```

The key rule is that extensions never talk directly to Tauri or the OS. The UI package uses the host-provided `Bridge`, and extensions talk to either the worker shim or the viewer/editor host API.

Primary files:

- [`extensionHost.worker.ts`](../packages/ui/lib/features/extensions/extensionHost.worker.ts) loads extension manifests and runs browser activation code in a Web Worker.
- [`extensionHostClient.ts`](../packages/ui/lib/features/extensions/extensionHostClient.ts) owns the worker from the main thread and routes worker messages to UI services.
- [`useExtensionRuntime.ts`](../packages/ui/lib/features/extensions/useExtensionRuntime.ts) coordinates lifecycle, reload, theme application, auto-update, and contribution registration.
- [`types.ts`](../packages/ui/lib/features/extensions/types.ts) defines manifest and loaded-extension contribution types.
- [`ExtensionContainer.tsx`](../packages/ui/lib/features/extensions/ExtensionContainer.tsx) mounts viewer/editor extension UI.
- [`manifestNormalizer.ts`](../packages/ui/lib/features/extensions/manifestNormalizer.ts) is the shared manifest normalization path for worker and main-thread consumers.
- [`@dotdirfm/extension-api`](../packages/extension-api/src/index.ts) defines the public viewer/editor/fsProvider extension API.

## Installed Extension Model

Installed extensions are indexed under the host-provided app data directory:

```text
<dataDir>/extensions/extensions.json
<dataDir>/extensions/<publisher>-<name>-<version>/package.json
```

`extensions.json` is an array of extension refs:

```json
[
  {
    "publisher": "example",
    "name": "my-extension",
    "version": "1.0.0",
    "source": "dotdir-marketplace",
    "autoUpdate": true
  }
]
```

Development refs can point at an absolute path:

```json
[
  {
    "publisher": "example",
    "name": "local-extension",
    "version": "0.0.0",
    "path": "/absolute/path/to/local-extension"
  }
]
```

The path-based form is not deleted on uninstall and is skipped by marketplace auto-update.

## Manifest Contributions

The manifest type is defined by [`ExtensionManifest`](../packages/ui/lib/features/extensions/types.ts). DotDir supports these contribution areas:

- `languages`: filename and extension to language-id metadata.
- `grammars`: TextMate grammar refs for editor tokenization.
- `commands`: command-palette and command-registry entries.
- `keybindings`: extension keybinding layer entries.
- `menus.commandPalette`: command palette menu metadata.
- `viewers`: read-only file UI contributions.
- `editors`: editable file UI contributions.
- `fsProviders`: container-file browsing providers such as ZIP/ISO.
- `iconTheme` and `iconThemes`: FSS or VS Code icon themes.
- `themes`: VS Code color themes.
- `shellIntegrations`: shell profiles and init scripts.
- `configuration`: settings schema/defaults.
- `configurationDefaults`: language-specific default configuration.

Activation is controlled by:

- `browser`: path to an activation script.
- `main`: fallback activation script when `browser` is absent.
- `type: "module"`: load the activation entry as ESM. Otherwise DotDir wraps it as CommonJS.
- `activationEvents`: `*`, `onCommand:<id>`, and `workspaceContains:<glob>` are currently meaningful activation triggers.

Minimal example:

```json
{
  "publisher": "example",
  "name": "markdown-tools",
  "version": "1.0.0",
  "displayName": "Markdown Tools",
  "browser": "./dist/extension.js",
  "activationEvents": ["onCommand:markdown.preview"],
  "contributes": {
    "commands": [
      {
        "command": "markdown.preview",
        "title": "Markdown: Preview"
      }
    ],
    "viewers": [
      {
        "id": "markdown-preview",
        "label": "Markdown Preview",
        "patterns": ["*.md", "*.markdown"],
        "entry": "./dist/viewer.js",
        "priority": 10
      }
    ]
  }
}
```

## Load Flow

Startup and reload follow this path:

```text
ExtensionHostClientProvider
  -> reads dataDir from Bridge
  -> constructs ExtensionHostClient
  -> worker receives { type: "start", dataDir }
  -> worker reads extensions/extensions.json
  -> worker reads each package.json and package.nls*.json
  -> worker resolves contribution asset paths
  -> worker activates "*" browser extensions
  -> worker posts loaded extensions
  -> main runtime registers contributions and applies themes
```

The shared normalizer localizes manifest strings using `package.nls.json` and the best matching `package.nls.<locale>.json` file before it builds the loaded-extension payload.

The loaded payload is latched in `ExtensionHostClient`. Late subscribers receive the last `loaded` event on a microtask, which prevents extension state from disappearing during mount-order changes or hot reload.

Each loaded extension includes runtime metadata:

- `compatibility.activation`: `supported`, `unsupported`, or `failed`.
- `compatibility.reason`: optional human-readable compatibility detail.
- `runtime.activationEntry`: resolved activation path, format, and whether it came from `browser` or `main`.
- `trustTier`: internal runtime policy such as `worker`, `iframe`, `provider`, or `builtin`.

## Runtime Reload

`useExtensionRuntime` supports two reload modes:

- Hard reload clears commands, registries, loaded extension state, terminal shell profiles, FSS layers, and theme readiness before restarting the worker.
- Soft reload clears command registrations, registries, and fsProvider caches, then restarts the worker while preserving broader UI state.

Both modes replace dynamic contribution registries from the newly loaded extension list. This matters because uninstall, install, update, and development path changes must remove stale commands/viewers/editors/providers from the running app.

## Extension Host Worker

The worker is responsible for:

- Reading installed extension manifests through `readFile` RPC back to the main thread.
- Resolving manifest contributions into `WorkerLoadedExtension` records.
- Running `browser` activation scripts.
- Hosting the VS Code API shim in [`vscodeShim`](../packages/ui/lib/features/extensions/vscodeShim).
- Tracking active extensions and their subscriptions.
- Registering worker-side command handlers.
- Registering language providers and sending provider registration messages to the main thread.
- Sending diagnostics, output, status bar, message, open-external, apply-edit, command, and configuration requests to the main thread.

CommonJS activation scripts use a worker-side module graph loader. It supports `require("vscode")`, extension-relative `.js` and `.json` modules, and `index.js`/`index.json` resolution with per-extension module caching. Unsupported Node builtins, native modules, or package imports fail with structured compatibility errors instead of crashing the extension host.

ESM activation scripts are imported from VFS URLs so relative imports can resolve from the extension directory.

Activation context includes:

- `subscriptions`.
- `extensionUri`, `extensionPath`, and `asAbsolutePath`.
- `globalStoragePath`, `globalStorageUri`, `logPath`, and `logUri`.
- `globalState` and `workspaceState` mementos.
- `extension` metadata compatible with `vscode.extensions`.
- `dotdir.commands.registerCommand`, an explicit DotDir command helper.

## Main-Thread Client

[`ExtensionHostClient`](../packages/ui/lib/features/extensions/extensionHostClient.ts) translates between worker messages and main-thread services.

It handles worker-to-main messages for:

- Manifest file reads and binary reads.
- Loaded extension payloads.
- Activation logs and worker errors.
- Provider register/unregister events.
- Diagnostics set/clear events.
- Output and status bar updates.
- `window.show*Message` style requests.
- `env.openExternal`.
- Workspace edit application.
- Command execution requests.
- Configuration reads and writes.

It exposes main-to-worker methods for:

- Starting and restarting the worker.
- Opening, changing, saving, and closing text documents.
- Updating workspace folders.
- Updating configuration.
- Setting active editor.
- Invoking and cancelling providers.
- Activating by event.
- Executing extension commands.

## VS Code Shim And Monaco Bridge

DotDir implements a browser-oriented subset of the VS Code API under [`vscodeShim`](../packages/ui/lib/features/extensions/vscodeShim).

The shim owns worker-side APIs such as:

- `vscode.commands`.
- `vscode.workspace`.
- `vscode.window`.
- `vscode.languages`.
- `vscode.extensions`.
- `Uri`, `Position`, `Range`, `Diagnostic`, and related value types.

Monaco integration happens on the main thread through [`monacoBridge`](../packages/ui/lib/features/extensions/monacoBridge):

- `MonacoDocumentTracker` mirrors open/change/save/close document events into the worker.
- `MonacoProviderBridge` maps worker provider registrations to Monaco providers and invokes worker provider methods.
- `MonacoDiagnosticsBridge` maps worker diagnostics to Monaco diagnostics.

Provider payloads crossing the worker boundary are plain JSON, not VS Code or Monaco class instances. Type adapters reconstruct the appropriate values on each side.

## Commands And Keybindings

Extension manifest commands are registered into the main command registry after the worker sends its loaded payload.

Command execution flow:

```text
keyboard / command palette / UI action
  -> CommandRegistry
  -> mounted extension command handler, if one exists
  -> worker executeCommand
  -> activateByEvent("onCommand:<id>")
  -> worker command handler
```

Mounted viewer/editor surfaces can register commands through `dotdir.commands.registerCommand`. Those handlers are checked before worker-side command execution so a currently mounted surface can own local commands.

Keybindings are layered:

```text
default -> extension -> user
```

Later layers override earlier layers. Focus-layer `when` clauses determine whether a binding is active in panels, menus, viewer, editor, terminal, command palette, or modal contexts.

## Viewer And Editor Contributions

Viewer and editor contributions are resolved by [`ViewerEditorRegistryManager`](../packages/ui/lib/viewerEditorRegistry.ts). Matching is currently filename-pattern based, then sorted by descending `priority`.

Built-in fallbacks are always registered:

- Viewer: `file-viewer`, priority `-10000`.
- Editor: `monaco`, priority `-10000`.

That gives DotDir an out-of-box viewer/editor while allowing extensions to override specific file types with higher priorities.

Viewer/editor UI is mounted by [`ExtensionContainer`](../packages/ui/lib/features/extensions/ExtensionContainer.tsx):

- Built-in surfaces are lazy React components.
- Built-in surface selection requires the built-in extension lane plus the built-in contribution id, so third-party `file-viewer` or `monaco` ids do not bypass isolation.
- External surfaces run in sandboxed iframes served from extension-directory VFS URLs.
- The iframe bootstrap performs a `postMessage` handshake.
- Host APIs are exposed as async RPC methods.
- Props updates are sent without remounting the iframe when possible.
- File descriptors are closed when a surface is hidden or unmounted.

External viewer/editor entries implement `ViewerExtensionApi` or `EditorExtensionApi` from `@dotdirfm/extension-api` and register with `window.__dotdirHostReady(api)`.

Viewer/editor host APIs include:

- File reads, range reads, text reads, stats, and file-change subscription.
- Editor writes and dirty-state reporting.
- Theme and color-theme reads/subscriptions.
- Close requests.
- Command execution.
- Extension resource URL lookup.

See [`viewer-editor-extensions-architecture.md`](./viewer-editor-extensions-architecture.md) for the detailed viewer/editor loading design.

## FsProvider Contributions

`fsProviders` allow an extension to expose a file as a browsable virtual directory, for example an archive or disk image.

Resolution is handled by the same registry manager as viewers/editors. `useFileListPanel` checks container paths and delegates listing to the matched provider.

There are two runtime modes:

- `frontend` or omitted: load a JavaScript provider bundle in an isolated worker with [`browserFsProvider.ts`](../packages/ui/lib/features/extensions/browserFsProvider.ts).
- `backend`: ask `bridge.fsProvider` to load and call a WASM provider through the host.

Frontend providers are cached by `(extensionDirPath, entry)` and expose `window.__dotdirProviderReady = (hostApi) => providerApi`. In this lane, `window` is a worker-global shim, not the app document.

Provider APIs are defined in `@dotdirfm/extension-api`:

- `listEntries(containerPath, innerPath)`.
- Optional `readFileRange(containerPath, innerPath, offset, length)`.

## Theme, Icon, And FSS Contributions

The extension runtime applies visual contributions after the loaded extension payload arrives.

Color themes:

- Manifest `themes` entries point to VS Code color theme JSON files.
- [`vscodeColorTheme.ts`](../packages/ui/lib/features/themes/vscodeColorTheme.ts) maps VS Code color keys to DotDir CSS custom properties.
- The active color theme controls the root `data-theme` and informs viewer/editor surfaces.

Icon themes:

- `iconTheme` and `iconThemes` can point to VS Code icon-theme JSON or FSS files.
- VS Code icon themes are adapted by `VSCodeIconThemeAdapter`.
- FSS icon themes become high-priority FSS layers.

FSS:

- Extension FSS layers combine with the built-in layer and `.dir/fs.css` files from the current directory ancestry.
- Panel file entries are `fss-lang` nodes, so styling and sorting resolve through one layered resolver.

## Shell Integration Contributions

Shell integration contributions describe terminal profiles and initialization scripts. The worker resolves script contents during manifest loading, then the main runtime passes loaded integrations to [`resolveShellProfiles`](../packages/ui/lib/features/terminal/shellProfiles.ts).

If the host bridge supports `pty.setShellIntegrations`, DotDir also passes shell init scripts to the host so PTY sessions can receive shell-specific integration behavior.

## Workspace And Activation Events

[`ExtensionHostWorkspaceSync`](../packages/ui/lib/features/extensions/extensionHostWorkspaceSync.tsx) derives workspace folders from open panel tabs.

The preferred workspace root is the nearest ancestor containing a `.dir` folder. If no `.dir` workspace exists, the active tab directory is sent as a fallback so language-server-style extensions still have a workspace folder.

`workspaceContains:<glob>` activation is evaluated against real `.dir` workspace roots. Each `(root, event)` pair is only evaluated once per session.

Supported activation patterns today:

- `*`: activate during startup after extension loading.
- `onCommand:<id>`: activate before command execution.
- `workspaceContains:<glob>`: activate when a matching workspace root is detected.

## Configuration

Manifest `contributes.configuration` defaults are loaded into the worker-side configuration shim during manifest loading.

Runtime configuration values are stored by [`ExtensionSettingsStore`](../packages/ui/lib/features/extensions/extensionSettings.ts). `ExtensionHostClientProvider` wires synchronous read/write listeners before the async store load completes, so early activation code can safely call `workspace.getConfiguration`.

When an extension writes configuration, the main thread persists it and sends a configuration update back to the worker.

## Marketplace, Install, And Auto-Update

The Extensions panel searches two marketplace providers:

- `.dir`: [`marketplaces/dotdir.ts`](../packages/ui/lib/features/extensions/marketplaces/dotdir.ts), backed by `https://dotdir.dev`.
- Open VSX: [`marketplaces/openVsx.ts`](../packages/ui/lib/features/extensions/marketplaces/openVsx.ts), backed by `https://open-vsx.org`.

The UI does not download or unpack extensions directly. It asks `bridge.extensions.install.start(request)` and listens for install progress. This keeps platform-specific download, extraction, validation, and filesystem writes in the host.

After a successful install/update:

- The runtime waits for the install progress `done` event.
- The extension host is restarted.
- Registries and themes are rebuilt from the new installed extension set.

Auto-update checks installed non-path extensions with a marketplace `source` when extension auto-update is enabled and the extension ref has `autoUpdate !== false`.

## Error Handling And Isolation

Isolation boundaries:

- Browser activation code runs in a Web Worker.
- External viewer/editor UI runs in sandboxed iframes.
- Frontend fsProviders run in dedicated workers.
- Backend fsProviders run through the host `bridge.fsProvider` implementation.

Failure handling:

- Manifest load failures skip that extension.
- Activation failures are logged and do not prevent other extensions from loading.
- Theme failures fall back to the system theme.
- Viewer/editor bootstrap failures surface an inline error for that surface.
- Failed fsProvider loads are evicted from cache so later retries can work.
- Runtime reload clears stale registrations before replacing dynamic state.

## Adding A New Contribution Type

Use this checklist when adding extension capabilities:

1. Extend manifest and loaded-extension types in [`types.ts`](../packages/ui/lib/features/extensions/types.ts).
2. Mirror worker-local types in [`extensionHost.worker.ts`](../packages/ui/lib/features/extensions/extensionHost.worker.ts).
3. Parse and normalize the contribution in `loadExtensionFromDir`.
4. Include the contribution in worker `loaded` payload normalization in [`extensionHostClient.ts`](../packages/ui/lib/features/extensions/extensionHostClient.ts).
5. Add a registry or runtime applier in the main thread if the contribution affects UI state.
6. Clear the contribution during hard and soft reload paths in [`useExtensionRuntime.ts`](../packages/ui/lib/features/extensions/useExtensionRuntime.ts).
7. Add command/focus/theme/settings integration only at the layer that owns that concern.
8. Update docs and public API types if extension authors need to consume it.

## Rules Of Thumb

- Keep host-specific work behind `Bridge`.
- Keep manifest parsing in the shared normalizer; do not fork worker and main-thread parsing logic.
- Keep long-lived extension state in the worker; keep UI projection state in React/Jotai.
- Prefer manifest contributions for static capabilities and activation scripts for dynamic behavior.
- Prefer worker activation for commands/providers/configuration and iframe surfaces for viewer/editor UI.
- Do not special-case file types in command handlers; register viewers, editors, or fsProviders.
- Treat extension reload as replacement, not mutation. Clear old registrations first.
- Do not load third-party extension code in the main document.
