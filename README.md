# Faraday

Dual-pane file manager built with Tauri + React + Rust.

## Tech Stack

- **Frontend**: React 19, TypeScript 5.8, Vite 7
- **Desktop**: Tauri 2
- **Native layer**: Rust — `faraday-core` for FS ops, `frdye` elevated helper
- **Headless**: Standalone Rust server (axum) — HTTP + WebSocket, no GUI
- **Styling**: FSS (filesystem stylesheets) via `fss-lang` — custom CSS-like language for styling file listings
- **Build**: pnpm, Cargo
- **Targets**: macOS, Linux, Windows

## Project Structure

```
src/
  main.tsx             # Renderer entry point
  app.tsx              # Root component — dual-pane layout
  bridge.ts            # Dynamic bridge provider (Tauri IPC or WebSocket)
  tauriBridge.ts       # Tauri IPC bridge (invoke/listen)
  wsBridge.ts          # WebSocket bridge (headless/browser mode)
  fsa.ts               # File System Access API shim
  fss.ts               # FSS resolver (layered .faraday/fs.css)
  types.ts             # Shared types (FsaRawEntry, FsChangeEvent)
  iconCache.ts         # SVG icon loading and LRU cache
  langDetect.ts        # File language detection
  path.ts              # Cross-platform path utilities
  FileList/            # File list components (virtual scrolling)
  FileViewer.tsx       # Text file viewer
  ImageViewer.tsx      # Image viewer
  ModalDialog.tsx      # Error/confirmation dialogs
src-tauri/
  Cargo.toml           # Workspace manifest
  tauri.conf.json      # Tauri app config
  src/
    main.rs            # Tauri entry point
    lib.rs             # Tauri commands + AppState
    elevate.rs         # Spawns privileged frdye helper
  faraday-core/        # Pure Rust core: ops, watch, error, proto
  faraday-server/      # Headless server binary (axum + WebSocket)
  frdye/               # Elevated FS helper binary
  icons-bundle/        # Material Design SVG icons
```

## Architecture

### Filesystem Access Layers

The app accesses the filesystem through multiple backends, all using `faraday-core`:

1. **Tauri (desktop)** — Rust commands called via Tauri IPC. Primary backend.
2. **Elevated helper (frdye)** — Standalone Rust binary spawned with admin privileges. Communicates over Unix sockets using a custom binary protocol. Triggered on EACCES.
3. **Headless server** — Standalone axum binary. HTTP for static files + WebSocket for FS operations via JSON-RPC 2.0. Used for browser-only / remote access.

### Bridge System

The frontend uses a dynamic bridge that detects the runtime environment:

- **Tauri mode** (`tauriBridge.ts`): Uses `@tauri-apps/api` `invoke()` and `listen()` for IPC.
- **Browser mode** (`wsBridge.ts`): Uses WebSocket with JSON-RPC 2.0. Binary frames for file reads (4-byte LE request ID prefix + payload).

Detection: `'__TAURI_INTERNALS__' in window` — if true, loads Tauri bridge; otherwise, connects WebSocket to `ws://{host}/ws`.

### FSS (Filesystem Stylesheets)

Files are styled using `fss-lang` — a CSS-like language that matches filesystem entries by name, type, and metadata. Stylesheets cascade from `.faraday/fs.css` files found in ancestor directories. The built-in base layer provides Material Icons mappings.

## Commands

### Desktop (Tauri)

```bash
pnpm tauri dev        # Start Tauri dev (frontend HMR + Rust backend)
pnpm tauri build      # Build desktop app
```

### Headless Server

```bash
pnpm build:web          # Build web UI → dist-web/
pnpm build:server       # Build server binary (release)
pnpm build:server:dev   # Build server binary (debug)

# Run headless
./src-tauri/target/release/faraday-server
# → http://127.0.0.1:3001

# With options
./src-tauri/target/release/faraday-server \
  --port 8080 \
  --host 0.0.0.0 \
  --static-dir dist-web \
  --icons-dir src-tauri/icons-bundle
```

The server auto-detects `dist-web/` and `icons-bundle/` relative to CWD. Port and host can also be set via `FARADAY_PORT` and `FARADAY_HOST` environment variables.

### Development (headless with HMR)

```bash
pnpm build:server:dev && ./src-tauri/target/debug/faraday-server &
pnpm dev:web           # Vite dev server at http://localhost:5173 (proxies /ws → :3001)
```

### Other

```bash
pnpm build:frdye        # Build elevated helper (debug)
pnpm build:frdye:release # Build elevated helper (release)
```

## Key Conventions

- `faraday-core` is a pure Rust library shared by Tauri, the headless server, and frdye
- File watcher events are delivered via `notify` crate callbacks routed by watch ID
- The renderer uses virtual scrolling for file lists
- FSS cache is invalidated when `.faraday/fs.css` changes are detected via watch events
- Elevated file descriptors are negated (`fd < 0`) to distinguish proxy vs local handles
