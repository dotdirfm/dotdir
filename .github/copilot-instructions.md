# Copilot Instructions for Faraday

## Build & Run Commands

```bash
pnpm tauri dev          # Start Tauri desktop app with HMR
pnpm tauri build        # Production desktop build
pnpm dev                # Frontend-only dev server (port 1420)
pnpm build              # TypeScript check + Vite build
pnpm build:rust         # Rust release build only
pnpm build:rust:dev     # Rust debug build only
```

Headless mode (after building Rust):

```bash
./src-tauri/target/release/faraday serve --port 8080 --host 0.0.0.0
```

No test suite or linter is configured.

## Architecture

Faraday is a dual-pane desktop file manager with three runtime modes:

1. **Desktop (Tauri)** — React UI communicates with Rust backend via Tauri IPC
2. **Headless server** — Axum HTTP/WebSocket server with JSON-RPC 2.0 for browser access
3. **Elevated helper** (Unix only) — Privileged RPC daemon for operations needing root

### Bridge pattern

The frontend uses a single `Bridge` interface (`bridge.ts`) with two implementations:

- `TauriBridge` — Tauri `invoke`/`listen` IPC
- `WsBridge` — WebSocket with JSON-RPC 2.0

The bridge is selected at boot in `main.tsx` based on whether Tauri APIs are available. All UI code calls the bridge interface, never a specific implementation.

### faraday-core

`src-tauri/faraday-core/` is a pure Rust library (no Tauri dependency) containing filesystem operations, file watching, error types, and the binary protocol for the elevated helper. It is shared by the Tauri app, the headless server, and the elevated helper.

### Rust entry point modes

`main.rs` dispatches based on CLI subcommand:

- No subcommand → desktop Tauri app (`lib.rs`)
- `serve` → headless HTTP/WS server (`serve.rs`)
- `rpc` → elevated helper daemon (`rpc.rs`)

### FSS (Filesystem Stylesheets)

A custom CSS-like system (`fss-lang` crate + `fss.ts`) that styles file entries based on name, type, and metadata. Stylesheets are loaded from `.faraday/fs.css` files in ancestor directories and layered with specificity rules. Cache is invalidated via filesystem watch events.

## Key Conventions

- **Field name mapping**: Rust returns `snake_case` fields; bridge implementations map them to `camelCase` for TypeScript (e.g., `mtime_ms` → `mtimeMs`).
- **EntryKind**: A unified enum (14 variants) shared between Rust (`ops.rs`) and TypeScript (`types.ts`), serialized as `u8` in the binary protocol.
- **File descriptors**: Positive FDs are local (Tauri); negative FDs indicate proxied handles through the elevated helper.
- **State management**: React hooks only (useState, useRef, useCallback) — no external state library.
- **Platform-conditional code**: Rust uses `#[cfg(unix)]` / `#[cfg(windows)]` with separate modules (e.g., `elevate.rs` vs `elevate_stub.rs`). TypeScript path utilities in `path.ts` handle both separators.
- **Virtual scrolling**: `FileList/` components use custom virtualization for multi-column file lists with `useElementSize` for responsive sizing.
