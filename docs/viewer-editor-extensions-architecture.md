# Viewer & Editor Extensions — Architecture Plan

For the broader extension runtime, manifest loading, worker host, marketplace, and contribution architecture, see [Extensions Architecture](./extensions-architecture.md).

Current runtime rule: built-in `file-viewer` and `monaco` surfaces render as trusted React components without an iframe. Custom viewer/editor contributions, including Open VSX-sourced entries, always render in sandboxed iframes.

## 1. Current State

- **Viewers**: `FileViewer` (text, read-only) and `ImageViewer` (images/video, read-only) are hardcoded in `app.tsx`. Selection is by `isMediaFile(fileName)`; everything else uses `FileViewer`.
- **Editor**: `FileEditor` (Monaco) is the only editor, also hardcoded in `app.tsx`.
- **Entry points**: FileList calls `onViewFile(path, name, size)` and `onEditFile(path, name, size, langId)`; App owns `viewerFile` / `editorFile` state and renders the matching component.
- **Extension system**: Extensions are loaded from `~/.dotdir/extensions`, contribute languages, grammars, commands, keybindings, icon themes, and FSS. The extension host worker loads manifests and contributions; **no extension-provided UI** is loaded today.

## 2. Goals

- **Viewers and editors are provided by extensions.** The core app does not bundle a specific viewer or editor; it only provides the extension host, registries, and a generic container.
- **Out-of-box experience**: Default extensions (e.g. “.dir: Text & Image Viewers”, “.dir: Code Editor”) are installed by default so the app works without user installing anything.
- **Extensibility**: Third-party extensions can add viewers/editors for custom formats (e.g. PDF, Markdown preview, hex) and override or supplement defaults.
- **Consistent with existing contributions**: Follow the same pattern as `contributes.languages` / `contributes.commands` (manifest in `package.json`, host resolves and activates).

## 3. Contribution Model

### 3.1 Manifest Additions

Add to `ExtensionContributions` in `extensions.ts`:

```ts
// Viewer: read-only. Matches by filename patterns or MIME.
export interface ExtensionViewerContribution {
  id: string; // e.g. "dotdir.imageViewer"
  label: string; // "Image & Video Viewer"
  patterns: string[]; // e.g. ["*.png", "*.jpg", "*.mp4"]
  mimeTypes?: string[]; // optional: ["image/png", "image/jpeg"]
  entry: string; // path to JS entry (relative to extension dir), e.g. "./viewer.js"
  priority?: number; // higher = preferred when multiple match; default 0
}

// Editor: read-write. Same idea.
export interface ExtensionEditorContribution {
  id: string;
  label: string;
  patterns: string[];
  mimeTypes?: string[];
  langId?: string; // default language for syntax (e.g. "markdown")
  entry: string; // path to JS entry, e.g. "./editor.js"
  priority?: number;
}
```

In `package.json` (extension manifest):

```json
{
  "contributes": {
    "viewers": [
      {
        "id": "dotdir.imageViewer",
        "label": "Image & Video Viewer",
        "patterns": ["*.png", "*.jpg", "*.jpeg", "*.gif", "*.webp", "*.mp4", "*.webm"],
        "entry": "./image-viewer.js"
      }
    ],
    "editors": [
      {
        "id": "dotdir.monacoEditor",
        "label": "Code Editor",
        "patterns": ["*.*"],
        "entry": "./editor.js",
        "priority": -100
      }
    ]
  }
}
```

- **Patterns**: Glob-style (`*.ext` or `*`). Match against `fileName` (e.g. `doc.pdf`). Longest/match-all or explicit ordering can decide ties; `priority` disambiguates.
- **entry**: Relative to extension dir. Path to a **JS file** (e.g. `./viewer.js`). The iframe bootstrap loads this entry script from the VFS mount and then calls `mount(...)` (see §4.3). No Comlink or blob URLs are required.

### 3.2 Registries in the Host

- **Viewer registry**: On extension load, for each `contributes.viewers` item, register `(patterns, mimeTypes?, id, extensionRef, entry, priority)`.
- **Editor registry**: Same for `contributes.editors`.

When the user opens a file (view or edit):

1. **Resolve viewer**: For `(fileName, optionalMimeType)`, find all viewer contributions whose patterns (and optionally mime) match; pick the one with highest `priority`; if none, show a “No viewer available” placeholder or fallback to a built-in “raw text” viewer if we keep one.
2. **Resolve editor**: Same for edit; if none match, “No editor available” or fallback.

So the **core app** only knows:

- How to resolve (fileName, mime?) → viewer contribution or editor contribution
- How to load the contribution’s entry in an iframe and establish the postMessage RPC bridge (see below).

## 4. Loading Extension UI — Iframe + postMessage RPC

Viewer/editor UI runs in an **iframe**. The host and the iframe communicate via a small **postMessage RPC** layer so each side can call methods on the other (no Comlink).

### 4.1 Why iframe

- **Isolation**: Extension code cannot touch the host’s DOM or React state.
- **Security**: Malicious or buggy extensions are sandboxed (same-origin but separate document).
- **Stability**: Crashes or heavy work in the iframe don’t block the main app.

### 4.2 Why postMessage RPC

- **RPC over postMessage**: We turn the iframe boundary into async method calls (e.g. `dotdir.readFileText()` / `dotdir.getTheme()` inside the iframe).
- **No dependency**: We don't require Comlink or `MessagePort`s; the bootstrap logic lives in a single inline script.
- **TypeScript-friendly**: Extensions still implement the same `mount/unmount` API, and host APIs remain source-compatible via `globalThis.dotdir`.

### 4.3 VFS-served iframe bootstrap (no Comlink)

Extension UI is loaded via our stateless VFS mount:

1. The host sets the iframe `src` to `vfsUrl('/_ext/<abs extension dir>/')` (or the equivalent for the runtime).
2. The VFS response returns a generated `index.html` that inlines the shared iframe bootstrap from `packages/ui/lib/features/extensions/iframeBootstrap.inline.js`.
3. The host then sends `dotdir:init` with the extension `entryUrl`.
4. The iframe bootstrap creates a `<script src="entryUrl">` tag to load the extension entry JS, then calls `api.mount(...)`.

**Cleanup**: When the viewer/editor is closed, the host sends `dotdir:dispose` and unmounts the extension API; the iframe is destroyed as part of the UI lifecycle.

### 4.4 Handshake (postMessage)

We use a lightweight message protocol between host and iframe:

1. The shared iframe bootstrap installs a `message` listener and immediately notifies the host via `type: "dotdir:bootstrap-ready"`.
2. The host responds by sending `type: "dotdir:init"` with `{ kind, entryUrl, props, themeVars, colorTheme }`.
3. The iframe loads the extension entry script (`entryUrl`), receives the extension API through `window.__dotdirHostReady(api)`, then calls `api.mount(root, hostApi, props)`.
4. Subsequent host updates are sent as `type: "dotdir:update"`; cleanup as `type: "dotdir:dispose"`.
5. The iframe calls host methods via `type: "ext:call"`, and the host replies with `type: "host:reply"`. Subscriptions use `ext:subscribe` / `host:callback`.

### 4.5 Extension entry JS shape

- **entry** in the manifest is the path to a **JS file** (e.g. `./viewer.js`). That script runs inside the iframe. The script:
  - Implements the extension API (`mount`, `unmount`, and optionally `setLanguage`) and registers it by calling `window.__dotdirHostReady(api)`.
  - Uses `globalThis.dotdir` (provided by the iframe bootstrap) for file I/O, theme access, and host actions (e.g. `onClose()`).

## 5. API Contract (postMessage RPC)

The **host** exposes a **host API** to the iframe (via postMessage RPC). The **iframe** exposes an **extension API** to the host. Types can live in a shared package or in-repo module (e.g. `extension-api.ts` or `@dotdir/extension-api`).

### 5.1 Host API (host → iframe)

The host exposes an object the iframe can call (all methods async over our postMessage RPC):

```ts
interface HostApi {
  // File I/O (bridge subset the extension is allowed to use)
  readFile(path: string): Promise<ArrayBuffer>;
  readFileText(path: string): Promise<string>;
  writeFile(path: string, content: string | ArrayBuffer): Promise<void>;

  // Theme (so extension can match host)
  getTheme(): Promise<"light" | "dark">;

  // Lifecycle / host actions
  onClose(): void; // extension requests close (user clicked X)
  onNavigateMedia?(file: { path: string; name: string; size: number }): void; // gallery: switch to another file
}
```

- For **viewers**: only `readFile`/`readFileText`, `getTheme`, `onClose`, and optionally `onNavigateMedia` are needed.
- For **editors**: add `writeFile`; optional `setDirty?(dirty: boolean)` so the host can show an unsaved indicator (if we add that later).

### 5.2 Extension API — Viewer (iframe → host)

The iframe exposes:

```ts
interface ViewerExtensionApi {
  mount(props: ViewerProps): Promise<void>;
  unmount(): Promise<void>;
}
```

**ViewerProps** (serializable, passed from host to iframe):

```ts
interface ViewerProps {
  filePath: string;
  fileName: string;
  fileSize: number;
  inline?: boolean;
  mediaFiles?: { path: string; name: string; size: number }[];
}
```

- Host calls `await extensionApi.mount(props)` after the handshake; the iframe renders and uses `hostApi` to read file content and call `hostApi.onClose()` when the user closes.
- Host calls `await extensionApi.unmount()` when closing the viewer (e.g. user switched tab or closed from host UI).

### 5.3 Extension API — Editor (iframe → host)

```ts
interface EditorExtensionApi {
  mount(props: EditorProps): Promise<void>;
  unmount(): Promise<void>;
  setDirty?(dirty: boolean): void; // optional: host can show unsaved indicator
}
```

**EditorProps**:

```ts
interface EditorProps {
  filePath: string;
  fileName: string;
  langId: string;
}
```

- Extension uses `hostApi.readFileText` / `hostApi.writeFile` for load/save and calls `hostApi.onClose()` when user requests close (with optional dirty check inside the iframe).

## 6. Default Extensions (In-Repo)

Default viewers and editor live **inside this repo** as regular extensions, so they are versioned and built with the app.

- **Layout**: e.g. `extensions/dotdir-viewers-basic/` and `extensions/dotdir-editor-monaco/` (or a single `extensions/` folder with one subfolder per default extension).
- **dotdir-viewers-basic**: Contains the current `FileViewer` (text) and `ImageViewer` (image/video) logic, each as a **JS entry** (e.g. `text-viewer.js`, `image-viewer.js`). The extension’s `package.json` contributes two viewers with different `patterns` and `entry` paths. The host provides the iframe with an `entryUrl` under the VFS `_ext` mount; the iframe bootstrap loads and mounts the entry.
- **dotdir-editor-monaco**: Contains the current Monaco-based `FileEditor` as a JS entry (e.g. `editor.js`), contributes one editor with a catch-all or broad pattern and lower priority.

**Loading built-ins**: The host treats these as built-in by either:

- **Option A**: Registering their paths at build time (e.g. `import.meta.env` or a generated list) and loading them from the app bundle/resources (no copy to `~/.dotdir/extensions`), or
- **Option B**: Copying or linking them into `~/.dotdir/extensions` on first run so the same `loadExtensions()` path works for both built-ins and user-installed extensions.

Recommendation: **Option A** — resolve built-in extension dirs from app resources; when building the list of extensions to load, merge “built-in dirs” with `~/.dotdir/extensions`. Same manifest/contribution format; only the source path differs.

## 7. Resolution and Precedence

- **Pattern matching**: For `fileName`, check each contribution’s `patterns` (e.g. minimatch or a simple `*.ext` check). If `mimeTypes` are provided and we have MIME (e.g. from backend or from extension), require MIME match too.
- **Priority**: Among matches, choose contribution with highest `priority`. If tie, deterministic (e.g. by `id` string). (See §11 for optional "option" vs "default" semantics, VSCode-style.)
- **Default / fallback**: The “text” viewer and “monaco” editor can use low or negative priority so that more specific extensions (e.g. “PDF viewer” for `*.pdf`) override them when present.

## 8. File List and App Flow (Minimal Changes)

- **FileList**: Unchanged. It still calls `onViewFile(path, name, size)` and `onEditFile(path, name, size, langId)`.
- **App**:
  - Keeps `viewerFile` and `editorFile` state.
  - Instead of branching on `isMediaFile()` and rendering `<ImageViewer>` vs `<FileViewer>`, it calls **viewerRegistry.resolve(fileName)** (and optionally mime), then **ViewerContainer** with the resolved contribution + props.
  - Same for editor: **editorRegistry.resolve(fileName)** → **EditorContainer** with contribution + props.
- **ViewerContainer / EditorContainer**: Resolve contribution, load the extension entry URL, mount it inside an iframe, let the iframe bootstrap establish the postMessage RPC bridge and call `extensionApi.mount(props)`. On load/handshake error or timeout, show “Failed to load viewer/editor” and onClose. On unmount/close, call `extensionApi.unmount()` and destroy the iframe.

## 9. Extension Host Worker

- The worker loads manifest + languages + grammars and returns `WorkerLoadedExtension`. Viewer/editor **entry code** runs only in the iframe; the worker (or main-thread `loadExtensions`) only parses **contribution metadata** (id, label, patterns, mimeTypes, entry HTML path, priority).
- So: worker or `loadExtensions` parses `contributes.viewers` and `contributes.editors` and attaches them to `LoadedExtension`. The main thread maintains **viewerRegistry** and **editorRegistry** and fills them when extensions load (same as for commands/keybindings). No iframe logic in the worker.

## 10. Summary

| Piece                      | Responsibility                                                                                                                                                                              |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Core app**               | Extension host, viewer + editor registries, resolution, ViewerContainer/EditorContainer (iframe + postMessage RPC), hostApi implementation (bridge + theme + onClose)                       |
| **Manifest**               | `contributes.viewers` / `contributes.editors` with id, label, patterns, entry (JS file path), priority                                                                                      |
| **Default extensions**     | In-repo `extensions/dotdir-viewers-basic`, `extensions/dotdir-editor-monaco`; loaded from app resources, same format as user extensions                                                   |
| **Third-party extensions** | Add viewers/editors for other formats; same contract (entry JS + hostApi/extensionApi over postMessage RPC)                                                                                 |
| **Loading**                | Frontend-only: load entry JS + iframe bootstrap; host/iframe establish the postMessage RPC bridge (no MessageChannel); no Tauri serving                                                     |
| **API**                    | HostApi (readFile, writeFile, getTheme, onClose, …) from host to iframe; ViewerExtensionApi / EditorExtensionApi (mount, unmount) from iframe to host; shared types in extension-api module |

This keeps the app UI-agnostic for viewing/editing and makes File/Image Viewer and Editor first-class extension points with isolation (iframe) and a clear RPC contract (postMessage).

---

## 11. Comparison with VSCode Webview & Custom Editors

VSCode’s [Webview API](https://code.visualstudio.com/api/extension-guides/webview) and [Custom Editor API](https://code.visualstudio.com/api/extension-guides/custom-editors) inform the following alignment and differences.

### 11.1 How VSCode Does It

- **Webview**: Extensions create a panel with `createWebviewPanel`. The host sets `panel.webview.html` (full HTML string). The webview runs in an isolated context; communication is **postMessage**: extension → webview via `webview.postMessage()`, webview → extension via `acquireVsCodeApi().postMessage()` and `webview.onDidReceiveMessage()`.
- **Custom editors**: Contribution point `customEditors` with `viewType`, `displayName`, `selector` (array of `{ filenamePattern }`), and `priority` (`"default"` | `"option"`). Two kinds:
  - **CustomTextEditorProvider**: Uses the built-in `TextDocument`; host handles save/backup.
  - **CustomEditorProvider** / **CustomReadonlyEditorProvider**: Extension owns the document model (`CustomDocument`). Lifecycle: `openCustomDocument(uri)` → document; then `resolveCustomEditor(document, webviewPanel)` to fill the webview. Multiple webviews can share one document (e.g. split editor).
- **Resources**: Webviews cannot touch the filesystem directly. Local assets are loaded via `webview.asWebviewUri(localFile)` (e.g. `vscode-resource:/path`). `localResourceRoots` restricts which paths the webview can load.
- **Theme**: VSCode injects body classes (`vscode-light`, `vscode-dark`, `vscode-high-contrast`) and CSS variables (e.g. `--vscode-editor-foreground`).
- **Lifecycle**: Panel has `onDidDispose`; when all panels for a document close, the document is disposed. Editable custom editors fire `onDidChangeCustomDocument` (with optional undo/redo) and implement save via `workspace.fs.writeFile`.

### 11.2 Alignments (and small adjustments)

| Aspect                     | VSCode                                                     | .dir (this plan)                                         | Note                                                                                                                                                                                                                                                                             |
| -------------------------- | ---------------------------------------------------------- | ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Contribution**           | `customEditors`: viewType, displayName, selector, priority | `viewers` / `editors`: id, label, patterns, entry, priority | Same idea; we use numeric priority for tie-breaking; can add "default" vs "option" semantics later (e.g. `priority: "option"` = don’t use by default).                                                                                                                           |
| **Selector**               | `selector: [{ filenamePattern: "*.png" }]`                 | `patterns: ["*.png", "*.jpg"]`                              | Equivalent; we use a single array of globs.                                                                                                                                                                                                                                      |
| **Isolation**              | Webview in separate context                                | Iframe (same-origin blob)                                   | Both isolate extension UI from host.                                                                                                                                                                                                                                             |
| **Host → extension comms** | `webview.postMessage()`                                    | postMessage RPC (host exposes `dotdir.*`)                     | Typed-ish RPC via our postMessage protocol (no Comlink).                                                                                                                                                                                                                         |
| **Extension → host comms** | `acquireVsCodeApi().postMessage()` + `onDidReceiveMessage` | postMessage RPC (iframe calls back into host)               | Same direction; we use a single RPC surface (mount, unmount, setLanguage/setDirty).                                                                                                                                                                                              |
| **Theme**                  | Body class + CSS variables                                 | `getTheme(): Promise<'light' \| 'dark'>`                    | We can add body class (and optionally CSS variables) in the **host shell HTML** so extension content matches host theme without extra RPC for initial paint.                                                                                                                     |
| **Local resources**        | `asWebviewUri` + `localResourceRoots`                      | Entry is one JS bundle; host reads file via bridge          | We don’t serve extension dir. Assets either live in the bundle or are fetched via HostApi (e.g. `readFile` for the opened file). For extension-owned assets (icons, CSS), we could add a HostApi such as `readExtensionFile(extensionId, relativePath)` and pass blob/data URLs. |

### 11.3 Intentional Differences

- **No extension host process**: In VSCode the extension runs in Node; the webview is only the view. In .dir the “extension” is the code inside the iframe; there is no separate Node process. So we don’t have activation events like `onCustomEditor:viewType`; we load extension manifests (and contribution metadata) up front and only spin up the iframe when a viewer/editor is opened.
- **Loading mechanism**: VSCode sets `webview.html` (full HTML, often with inline script or script src to extension-bundled JS). In .dir, we load a generated iframe bootstrap from our stateless `_ext` VFS mount and then load the extension entry script via `entryUrl`. No custom protocol or static file server; keeps loading on the frontend.
- **Document model**: VSCode separates **document** (one per resource, can have undo/save) from **webview** (one per tab). We currently have one iframe per open view/edit and no explicit CustomDocument. For simple viewers and single-tab editors this is enough. If we later add split view or host-driven undo/save, we can introduce a document abstraction (e.g. host holds document ref, multiple iframes get the same document id and sync via HostApi).

### 11.4 Takeaways for Implementation

1. **Contribution format**: Keep `contributes.viewers` / `contributes.editors` with id, label, patterns, mimeTypes?, entry, priority — aligned with VSCode’s contribution idea.
2. **Shell HTML**: In the host-owned shell that wraps the extension script, inject theme (e.g. `<body class="dotdir-light">` or `dotdir-dark`) and optionally a small set of CSS variables so extensions can style without calling `getTheme()` for initial render.
3. **postMessage RPC**: Use the built-in postMessage RPC bootstrap (no Comlink).
4. **Extension assets**: If an extension needs its own images/fonts/CSS, either (a) bundle them into the entry JS (e.g. inline or import), or (b) add `HostApi.readExtensionFile(extensionId, path)` and expose URLs (e.g. blob) to the iframe. Avoid adding a custom protocol or file server if possible.
5. **Optional “option” priority**: Reserve a convention (e.g. `priority: "option"` or a separate `default: false` flag) so some contributions are “Reopen with…” only and don’t take over a file type by default.
6. **Future**: If we need multiple views per document or host-managed undo/save, introduce a document handle (and optionally edit events) in the HostApi/ExtensionApi contract, similar in spirit to VSCode’s CustomDocument.
