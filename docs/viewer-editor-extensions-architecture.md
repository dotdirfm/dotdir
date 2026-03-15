# Viewer & Editor Extensions — Architecture Plan

## 1. Current State

- **Viewers**: `FileViewer` (text, read-only) and `ImageViewer` (images/video, read-only) are hardcoded in `app.tsx`. Selection is by `isMediaFile(fileName)`; everything else uses `FileViewer`.
- **Editor**: `FileEditor` (Monaco) is the only editor, also hardcoded in `app.tsx`.
- **Entry points**: FileList calls `onViewFile(path, name, size)` and `onEditFile(path, name, size, langId)`; App owns `viewerFile` / `editorFile` state and renders the matching component.
- **Extension system**: Extensions are loaded from `~/.faraday/extensions`, contribute languages, grammars, commands, keybindings, icon themes, and FSS. The extension host worker loads manifests and contributions; **no extension-provided UI** is loaded today.

## 2. Goals

- **Viewers and editors are provided by extensions.** The core app does not bundle a specific viewer or editor; it only provides the extension host, registries, and a generic container.
- **Out-of-box experience**: Default extensions (e.g. “Faraday: Text & Image Viewers”, “Faraday: Code Editor”) are installed by default so the app works without user installing anything.
- **Extensibility**: Third-party extensions can add viewers/editors for custom formats (e.g. PDF, Markdown preview, hex) and override or supplement defaults.
- **Consistent with existing contributions**: Follow the same pattern as `contributes.languages` / `contributes.commands` (manifest in `package.json`, host resolves and activates).

## 3. Contribution Model

### 3.1 Manifest Additions

Add to `ExtensionContributions` in `extensions.ts`:

```ts
// Viewer: read-only. Matches by filename patterns or MIME.
export interface ExtensionViewerContribution {
  id: string;                    // e.g. "faraday.imageViewer"
  label: string;                 // "Image & Video Viewer"
  patterns: string[];             // e.g. ["*.png", "*.jpg", "*.mp4"]
  mimeTypes?: string[];          // optional: ["image/png", "image/jpeg"]
  entry: string;                 // path to JS entry (relative to extension dir), e.g. "./viewer.js"
  priority?: number;             // higher = preferred when multiple match; default 0
}

// Editor: read-write. Same idea.
export interface ExtensionEditorContribution {
  id: string;
  label: string;
  patterns: string[];
  mimeTypes?: string[];
  langId?: string;               // default language for syntax (e.g. "markdown")
  entry: string;                 // path to JS entry, e.g. "./editor.js"
  priority?: number;
}
```

In `package.json` (extension manifest):

```json
{
  "contributes": {
    "viewers": [
      {
        "id": "faraday.imageViewer",
        "label": "Image & Video Viewer",
        "patterns": ["*.png", "*.jpg", "*.jpeg", "*.gif", "*.webp", "*.mp4", "*.webm"],
        "entry": "./image-viewer.js"
      }
    ],
    "editors": [
      {
        "id": "faraday.monacoEditor",
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
- **entry**: Relative to extension dir. Path to a **JS file** (e.g. `./viewer.js`). The host reads this file, turns it into a blob URL, and loads it inside a **host-provided shell HTML** in the iframe (see §4.3). All loading is done on the frontend; no Tauri custom protocol or static file serving.

### 3.2 Registries in the Host

- **Viewer registry**: On extension load, for each `contributes.viewers` item, register `(patterns, mimeTypes?, id, extensionRef, entry, priority)`.
- **Editor registry**: Same for `contributes.editors`.

When the user opens a file (view or edit):

1. **Resolve viewer**: For `(fileName, optionalMimeType)`, find all viewer contributions whose patterns (and optionally mime) match; pick the one with highest `priority`; if none, show a “No viewer available” placeholder or fallback to a built-in “raw text” viewer if we keep one.
2. **Resolve editor**: Same for edit; if none match, “No editor available” or fallback.

So the **core app** only knows:
- How to resolve (fileName, mime?) → viewer contribution or editor contribution
- How to load the contribution’s entry in an iframe and establish Comlink RPC (see below).

## 4. Loading Extension UI — Iframe + Comlink

Viewer/editor UI runs in an **iframe**. The host and the iframe communicate via **[Comlink](https://github.com/GoogleChromeLabs/comlink)** so that each side exposes an API and gets a promise-based RPC proxy to the other, without manual `postMessage` handling.

### 4.1 Why iframe

- **Isolation**: Extension code cannot touch the host’s DOM or React state.
- **Security**: Malicious or buggy extensions are sandboxed (same-origin but separate document).
- **Stability**: Crashes or heavy work in the iframe don’t block the main app.

### 4.2 Why Comlink

- **RPC over postMessage**: Comlink turns the iframe boundary into async method calls (e.g. `await hostApi.readFile(path)` in the iframe, `await extensionApi.mount(props)` in the host).
- **Small, well-supported**: ~1.1kB, works with any `postMessage`-like endpoint; supports `MessageChannel` and `Comlink.windowEndpoint()` for window/iframe.
- **TypeScript**: Types can be shared so both host and extension know the API shape.

Add as a dependency: `pnpm add comlink` (host app); default extensions can use the same dependency or a shared `extension-api` package that re-exports Comlink and the shared types.

### 4.3 All frontend: blob URL + host shell HTML (no Tauri serving)

We do **not** use Tauri to serve extension dirs (no custom protocol, no static file server). All loading is on the **frontend**:

1. **Read entry JS**: The host reads the extension entry file (e.g. `viewer.js`) from disk via the existing **bridge** (e.g. `bridge.fsa` or a dedicated “read extension file” that takes extension dir + relative path). So we need one bridge call that returns the file content as text or `ArrayBuffer`.
2. **Script blob**: Create a blob from that content and an object URL:
   - `const scriptBlob = new Blob([jsContent], { type: 'application/javascript' });`
   - `const scriptUrl = URL.createObjectURL(scriptBlob);`
3. **Shell HTML**: The host owns a minimal **shell HTML** string (e.g. in code or a small template). It contains a single `<script src="…">` whose `src` is the extension script blob URL. Example:
   - `const html = \`<!DOCTYPE html><html><head><script src="${scriptUrl}"></script></head><body></body></html>\`;`
4. **Iframe from HTML blob**: Create a blob from the shell HTML and set the iframe’s `src` to that blob URL:
   - `const htmlBlob = new Blob([html], { type: 'text/html' });`
   - `iframe.src = URL.createObjectURL(htmlBlob);`

The iframe’s origin is the **same as the host** (the blob was created by the host document), so we can pass `MessagePort`s and use Comlink without cross-origin issues. No Tauri, no dev-server routes for extensions—only bridge to read the entry file once, then blobs.

**Cleanup**: When the viewer/editor is closed, revoke the blob URLs (`URL.revokeObjectURL(scriptUrl)` and the HTML blob URL) to avoid leaks.

### 4.4 Handshake (MessageChannel)

Two-way Comlink needs one channel host→iframe and one iframe→host. Using a **MessageChannel** handshake is straightforward:

1. **Host** creates iframe, sets `src` to the shell HTML blob URL (which loads the extension JS), waits for `load`.
2. **Host** creates `MessageChannel()` → `port1`, `port2`. Host calls `Comlink.expose(hostApi, port1)` and sends `port2` to the iframe via `iframe.contentWindow.postMessage({ type: 'faraday-init', port: port2 }, '*', [port2])`.
3. **Iframe** (in its script) listens for `faraday-init`, receives `port2`, then `hostApi = Comlink.wrap(port2)`.
4. **Iframe** creates a second `MessageChannel()` → `portA`, `portB`. Iframe calls `Comlink.expose(extensionApi, portA)` and sends `portB` to the host via `window.parent.postMessage({ type: 'faraday-ready', port: portB }, '*', [portB])`.
5. **Host** listens for `faraday-ready`, receives `portB`, then `extensionApi = Comlink.wrap(portB)`. Host can now call `await extensionApi.mount(props)` etc.

Result: iframe has a proxy to `hostApi`; host has a proxy to `extensionApi`. All methods are async across the boundary.

### 4.5 Extension entry JS shape

- **entry** in the manifest is the path to a **JS file** (e.g. `./viewer.js`). That script runs inside the host’s shell HTML (no separate HTML in the extension). The script:
  - Loads or inlines Comlink (e.g. bundled with the extension or loaded from a host-provided blob for a shared “guest” runtime).
  - Listens for the host’s `faraday-init` message (with the port) and performs the handshake above.
  - Gets `hostApi = Comlink.wrap(port)` and builds `extensionApi` (e.g. `{ mount(props), unmount() }` for viewers; plus `setDirty?` for editors).
  - Exposes `extensionApi` on the second channel and sends the port back to the host (`faraday-ready`).
  - Renders its UI in the iframe document (e.g. mount a root into `document.body`); uses `hostApi` for file I/O and host callbacks (e.g. `hostApi.onClose()`).

## 5. API Contract (Comlink)

The **host** exposes a **host API** to the iframe (via Comlink). The **iframe** exposes an **extension API** to the host. Types can live in a shared package or in-repo module (e.g. `extension-api.ts` or `@faraday/extension-api`).

### 5.1 Host API (host → iframe)

The host exposes an object the iframe can call (all methods async over Comlink):

```ts
interface HostApi {
  // File I/O (bridge subset the extension is allowed to use)
  readFile(path: string): Promise<ArrayBuffer>;
  readFileText(path: string): Promise<string>;
  writeFile(path: string, content: string | ArrayBuffer): Promise<void>;

  // Theme (so extension can match host)
  getTheme(): Promise<'light' | 'dark'>;

  // Lifecycle / host actions
  onClose(): void;   // extension requests close (user clicked X)
  onNavigateMedia?(file: { path: string; name: string; size: number }): void;  // gallery: switch to another file
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
  setDirty?(dirty: boolean): void;  // optional: host can show unsaved indicator
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

- **Layout**: e.g. `extensions/faraday-viewers-basic/` and `extensions/faraday-editor-monaco/` (or a single `extensions/` folder with one subfolder per default extension).
- **faraday-viewers-basic**: Contains the current `FileViewer` (text) and `ImageViewer` (image/video) logic, each as a **JS entry** (e.g. `text-viewer.js`, `image-viewer.js`). The extension’s `package.json` contributes two viewers with different `patterns` and `entry` paths. The host loads each entry via bridge, creates a script blob + shell HTML blob, and runs it in an iframe.
- **faraday-editor-monaco**: Contains the current Monaco-based `FileEditor` as a JS entry (e.g. `editor.js`), contributes one editor with a catch-all or broad pattern and lower priority.

**Loading built-ins**: The host treats these as built-in by either:
- **Option A**: Registering their paths at build time (e.g. `import.meta.env` or a generated list) and loading them from the app bundle/resources (no copy to `~/.faraday/extensions`), or
- **Option B**: Copying or linking them into `~/.faraday/extensions` on first run so the same `loadExtensions()` path works for both built-ins and user-installed extensions.

Recommendation: **Option A** — resolve built-in extension dirs from app resources; when building the list of extensions to load, merge “built-in dirs” with `~/.faraday/extensions`. Same manifest/contribution format; only the source path differs.

**Implementation**: Built-in dirs are returned by the Tauri command `get_builtin_extension_dirs` (dev: repo `extensions/`; production: `$RESOURCE/extensions/` via `bundle.resources: ["../extensions/"]`). The extension host worker receives `builtInDirs` and loads them with `loadExtensionFromDir()` before user extensions. The host shell HTML loads `comlink.js` from the same origin (copied to `public/` at build/postinstall) so entry scripts can use `window.Comlink`. The core app keeps `FileViewer`, `ImageViewer`, and `FileEditor` as **fallbacks** when no extension matches (e.g. headless with no built-in dirs).

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
- **ViewerContainer / EditorContainer**: Resolve contribution, read entry JS file via bridge, build script blob + shell HTML blob, set iframe `src` to HTML blob URL, run Comlink handshake (expose hostApi, receive extensionApi), call `extensionApi.mount(props)`, render iframe in a wrapper. On load/handshake error or timeout, show “Failed to load viewer/editor” and onClose. On unmount/close, call `extensionApi.unmount()`, revoke blob URLs, and destroy iframe.

## 9. Extension Host Worker

- The worker loads manifest + languages + grammars and returns `WorkerLoadedExtension`. Viewer/editor **entry code** runs only in the iframe; the worker (or main-thread `loadExtensions`) only parses **contribution metadata** (id, label, patterns, mimeTypes, entry HTML path, priority).
- So: worker or `loadExtensions` parses `contributes.viewers` and `contributes.editors` and attaches them to `LoadedExtension`. The main thread maintains **viewerRegistry** and **editorRegistry** and fills them when extensions load (same as for commands/keybindings). No Comlink or iframe logic in the worker.

## 10. Summary

| Piece | Responsibility |
|-------|----------------|
| **Core app** | Extension host, viewer + editor registries, resolution, ViewerContainer/EditorContainer (iframe + Comlink handshake), hostApi implementation (bridge + theme + onClose) |
| **Manifest** | `contributes.viewers` / `contributes.editors` with id, label, patterns, entry (JS file path), priority |
| **Default extensions** | In-repo `extensions/faraday-viewers-basic`, `extensions/faraday-editor-monaco`; loaded from app resources, same format as user extensions |
| **Third-party extensions** | Add viewers/editors for other formats; same contract (entry JS + Comlink hostApi/extensionApi) |
| **Loading** | Frontend-only: read entry JS via bridge → script blob URL → host shell HTML (with script src=blob) → iframe src=HTML blob; Comlink handshake (MessageChannel); no Tauri serving |
| **API** | HostApi (readFile, writeFile, getTheme, onClose, …) from host to iframe; ViewerExtensionApi / EditorExtensionApi (mount, unmount) from iframe to host; shared types in extension-api module |

This keeps the app UI-agnostic for viewing/editing and makes File/Image Viewer and Editor first-class extension points with isolation (iframe) and a clear RPC contract (Comlink).

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

| Aspect | VSCode | Faraday (this plan) | Note |
|--------|--------|----------------------|------|
| **Contribution** | `customEditors`: viewType, displayName, selector, priority | `viewers` / `editors`: id, label, patterns, entry, priority | Same idea; we use numeric priority for tie-breaking; can add "default" vs "option" semantics later (e.g. `priority: "option"` = don’t use by default). |
| **Selector** | `selector: [{ filenamePattern: "*.png" }]` | `patterns: ["*.png", "*.jpg"]` | Equivalent; we use a single array of globs. |
| **Isolation** | Webview in separate context | Iframe (same-origin blob) | Both isolate extension UI from host. |
| **Host → extension comms** | `webview.postMessage()` | Comlink over MessageChannel (host exposes `hostApi`) | We use Comlink for typed RPC instead of ad-hoc message protocol. |
| **Extension → host comms** | `acquireVsCodeApi().postMessage()` + `onDidReceiveMessage` | Comlink (iframe exposes `extensionApi`) | Same direction; we use a single RPC surface (mount, unmount, setDirty). |
| **Theme** | Body class + CSS variables | `getTheme(): Promise<'light' \| 'dark'>` | We can add body class (and optionally CSS variables) in the **host shell HTML** so extension content matches host theme without extra RPC for initial paint. |
| **Local resources** | `asWebviewUri` + `localResourceRoots` | Entry is one JS bundle; host reads file via bridge | We don’t serve extension dir. Assets either live in the bundle or are fetched via HostApi (e.g. `readFile` for the opened file). For extension-owned assets (icons, CSS), we could add a HostApi such as `readExtensionFile(extensionId, relativePath)` and pass blob/data URLs. |

### 11.3 Intentional Differences

- **No extension host process**: In VSCode the extension runs in Node; the webview is only the view. In Faraday the “extension” is the code inside the iframe; there is no separate Node process. So we don’t have activation events like `onCustomEditor:viewType`; we load extension manifests (and contribution metadata) up front and only spin up the iframe when a viewer/editor is opened.
- **Loading mechanism**: VSCode sets `webview.html` (full HTML, often with inline script or script src to extension-bundled JS). We use blob URLs: host reads entry JS via bridge → script blob → minimal shell HTML with that script → iframe. No custom protocol or static file server; keeps loading on the frontend and avoids serving from extension dirs.
- **Document model**: VSCode separates **document** (one per resource, can have undo/save) from **webview** (one per tab). We currently have one iframe per open view/edit and no explicit CustomDocument. For simple viewers and single-tab editors this is enough. If we later add split view or host-driven undo/save, we can introduce a document abstraction (e.g. host holds document ref, multiple iframes get the same document id and sync via HostApi).

### 11.4 Takeaways for Implementation

1. **Contribution format**: Keep `contributes.viewers` / `contributes.editors` with id, label, patterns, mimeTypes?, entry, priority — aligned with VSCode’s contribution idea.
2. **Shell HTML**: In the host-owned shell that wraps the extension script, inject theme (e.g. `<body class="faraday-light">` or `faraday-dark`) and optionally a small set of CSS variables so extensions can style without calling `getTheme()` for initial render.
3. **Comlink**: Keep Comlink for host ↔ iframe; no need to switch to raw postMessage unless we hit a concrete limitation.
4. **Extension assets**: If an extension needs its own images/fonts/CSS, either (a) bundle them into the entry JS (e.g. inline or import), or (b) add `HostApi.readExtensionFile(extensionId, path)` and expose URLs (e.g. blob) to the iframe. Avoid adding a custom protocol or file server if possible.
5. **Optional “option” priority**: Reserve a convention (e.g. `priority: "option"` or a separate `default: false` flag) so some contributions are “Reopen with…” only and don’t take over a file type by default.
6. **Future**: If we need multiple views per document or host-managed undo/save, introduce a document handle (and optionally edit events) in the HostApi/ExtensionApi contract, similar in spirit to VSCode’s CustomDocument.
