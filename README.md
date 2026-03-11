# Faraday

Dual-pane file manager built with Tauri + React + Rust.

## Tech Stack

- **Frontend**: React 19, TypeScript 5.9, Vite 7
- **Editor**: CodeMirror 6 — syntax highlighting for JS, TS, Python, Rust, SQL, JSON, HTML, CSS, YAML, XML, Markdown
- **Terminal**: xterm.js 6 — integrated PTY shell with cwd tracking
- **Desktop**: Tauri 2
- **Native layer**: Rust — `faraday-core` for FS ops, elevated helper for privileged operations
- **Headless**: Standalone Rust server (axum) — HTTP + WebSocket, no GUI
- **Styling**: FSS (filesystem stylesheets) via `fss-lang` — custom CSS-like language for styling file listings
- **Build**: pnpm, Cargo
- **Targets**: macOS, Linux, Windows

## Prerequisites

- **Node.js** 22+
- **pnpm** (version pinned in `package.json`)
- **Rust** stable toolchain
- **Linux only**: `libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf`

## Project Structure

```
src/
  main.tsx             # Renderer entry point
  app.tsx              # Root component — dual-pane layout, keyboard shortcuts
  bridge.ts            # Dynamic bridge provider (Tauri IPC or WebSocket)
  tauriBridge.ts       # Tauri IPC bridge (invoke/listen)
  wsBridge.ts          # WebSocket bridge (headless/browser mode)
  fsa.ts               # File System Access API shim
  fss.ts               # FSS resolver (layered .faraday/fs.css)
  types.ts             # Shared types (FsaRawEntry, FsChangeEvent)
  iconCache.ts         # SVG icon loading and LRU cache
  langDetect.ts        # File language detection for syntax highlighting
  path.ts              # Cross-platform path utilities
  actionQueue.ts       # Debounced action queue
  FileList/            # File list components (virtual scrolling)
  FileViewer.tsx       # Read-only text file viewer with syntax highlighting
  FileEditor.tsx       # CodeMirror-based file editor
  ImageViewer.tsx      # Image viewer
  Terminal.tsx         # Integrated terminal (xterm.js + PTY)
  ModalDialog.tsx      # Error/confirmation dialogs
src-tauri/
  Cargo.toml           # Workspace manifest (faraday-tauri + faraday-core)
  tauri.conf.json      # Tauri app config
  src/
    main.rs            # Entry point — desktop / serve / rpc modes
    lib.rs             # Tauri commands + AppState
    elevate.rs         # Unix privileged helper proxy (binary protocol over Unix socket)
    elevate_stub.rs    # Windows stub
    pty.rs             # PTY spawn/write/resize/close (Unix)
    serve.rs           # Headless HTTP + WebSocket server (axum, JSON-RPC 2.0)
    rpc.rs             # JSON-RPC 2.0 command dispatcher
  faraday-core/        # Pure Rust core: ops, watch, error, proto
  icons-bundle/        # Bundled Material Design SVG icons
```

## Architecture

### Filesystem Access Layers

The app accesses the filesystem through multiple backends, all using `faraday-core`:

1. **Tauri (desktop)** — Rust commands called via Tauri IPC. Primary backend.
2. **Elevated helper** — Spawned with admin privileges on EACCES. Communicates over a Unix socket using a custom binary protocol (`faraday-core/src/proto.rs`).
3. **Headless server** — `faraday-tauri serve`. HTTP for static files + WebSocket for FS operations via JSON-RPC 2.0. Used for browser-only or remote access.

### Bridge System

The frontend uses a dynamic bridge that detects the runtime environment:

- **Tauri mode** (`tauriBridge.ts`): Uses `@tauri-apps/api` `invoke()` and `listen()` for IPC.
- **Browser mode** (`wsBridge.ts`): Uses WebSocket with JSON-RPC 2.0. Binary frames for file reads (4-byte LE request ID prefix + payload).

Detection: `'__TAURI_INTERNALS__' in window` — if true, loads Tauri bridge; otherwise, connects WebSocket to `ws://{host}/ws`.

### FSS (Filesystem Stylesheets)

Files are styled using `fss-lang` — a CSS-like language that matches filesystem entries by name, type, and metadata. Stylesheets cascade from `.faraday/fs.css` files found in ancestor directories. The built-in base layer (`material-icons.fs.css`) provides Material Icons mappings.

## Commands

### Desktop (Tauri)

```bash
pnpm tauri dev        # Start Tauri dev (frontend HMR + Rust backend)
pnpm tauri build      # Build desktop app
```

### Headless Server

```bash
pnpm build:web        # Build web UI → dist-web/
pnpm build:rust       # Build Rust binary (release)
pnpm build:rust:dev   # Build Rust binary (debug)

# Run headless
./src-tauri/target/release/faraday-tauri serve
# → http://127.0.0.1:3001

# With options
./src-tauri/target/release/faraday-tauri serve \
  --port 8080 \
  --host 0.0.0.0 \
  --static-dir dist-web \
  --icons-dir src-tauri/icons-bundle
```

The server auto-detects `dist-web/` and `icons-bundle/` relative to CWD. Port and host can also be set via `FARADAY_PORT` and `FARADAY_HOST` environment variables.

### Development (headless with HMR)

```bash
pnpm build:rust:dev && ./src-tauri/target/debug/faraday-tauri serve &
pnpm dev:web          # Vite dev server at http://localhost:5173 (proxies /ws → :3001)
```

## Key Conventions

- `faraday-core` is a pure Rust library shared by the Tauri app, the headless server, and the elevated helper
- File watcher events are delivered via `notify` crate callbacks routed by watch ID
- The renderer uses virtual scrolling for file lists
- FSS cache is invalidated when `.faraday/fs.css` changes are detected via watch events
- Elevated file descriptors are negated (`fd < 0`) to distinguish proxy vs local handles
