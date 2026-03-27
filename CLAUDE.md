# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Run Commands

```bash
pnpm tauri dev              # Desktop app with HMR (frontend + Rust backend)
pnpm tauri build            # Production desktop build
pnpm dev                    # Frontend-only dev server (port 1420)
pnpm build                  # TypeScript check + Vite build → /dist
pnpm build:rust             # Rust release build
pnpm build:rust:dev         # Rust debug build
```

Headless server (browser mode):

```bash
pnpm build:rust && ./src-tauri/target/release/faraday serve  # http://127.0.0.1:3001
```

Headless dev with HMR:

```bash
pnpm build:rust:dev && ./src-tauri/target/debug/faraday serve &
pnpm dev:web                # Vite at http://localhost:5173 (proxies /ws → :3001)
```

No test suite or linter is configured.

## Tech Stack

- **Frontend**: React 19, TypeScript 5.9 (strict), Vite 7, pnpm
- **Backend**: Rust (edition 2021), Tauri 2, axum, portable-pty
- **Editor**: Monaco Editor (no built-in languages) | **Terminal**: xterm.js 6
- **Targets**: macOS, Linux, Windows
- **Prerequisites**: Node.js 22+, Rust stable toolchain

## Architecture

.dir is a dual-pane file manager with three runtime modes:

1. **Desktop (Tauri)** — React UI ↔ Tauri IPC ↔ Rust backend
2. **Headless server** — React UI ↔ WebSocket (JSON-RPC 2.0) ↔ axum server
3. **Elevated helper** (Unix) — Privileged RPC daemon for root-required operations

### Bridge Pattern

The frontend depends on a single `Bridge` interface (`bridge.ts`) with two implementations:

- `tauriBridge.ts` — Tauri `invoke()`/`listen()` IPC
- `wsBridge.ts` — WebSocket with JSON-RPC 2.0 text messages + binary frames for PTY data

Detection at boot (`main.tsx`): `'__TAURI_INTERNALS__' in window` selects Tauri or WebSocket. All UI code calls the bridge interface, never a specific implementation.

### dotdir-core

`src-tauri/dotdir-core/` is a pure Rust library (no Tauri dependency) containing filesystem operations, file watching, error types, and the binary protocol for the elevated helper. Shared by all three runtime modes.

### Rust Entry Points

`main.rs` dispatches by CLI subcommand: none → desktop (`lib.rs`), `serve` → headless server (`serve.rs`), `rpc` → elevated helper (`rpc.rs`).

### Cargo Workspace

`src-tauri/Cargo.toml` is the workspace root with members: the Tauri app crate and `dotdir-core`.

## Key Conventions

- **Field naming**: Rust `snake_case` ↔ TypeScript `camelCase` (e.g., `mtime_ms` → `mtimeMs`). Bridges handle conversion.
- **EntryKind**: Unified enum shared between Rust (`ops.rs`) and TypeScript (`types.ts`), serialized as `u8`.
- **File descriptors**: Positive = local (Tauri), negative = proxied through elevated helper.
- **State management**: React hooks + Jotai atoms. Never call `getDefaultStore()` — all atom reads/writes must happen inside React components or hooks via `useAtomValue` / `useSetAtom` / `useAtom`.
- **Platform code**: Rust uses `#[cfg(unix)]`/`#[cfg(windows)]` with separate modules (`elevate.rs` vs `elevate_stub.rs`). TypeScript path utils (`path.ts`) handle both separators.
- **Virtual scrolling**: `FileList/` uses custom multi-column virtualization (26px row height, 350px column width).

## FSS (Filesystem Stylesheets)

A custom CSS-like system (`fss-lang` crate + `fss.ts`) that styles file entries. Stylesheets cascade from `.dotdir/fs.css` files in ancestor directories. Built-in base layer: `material-icons.fs.css`. Cache invalidated via filesystem watch events.

## Terminal Integration

`Terminal.tsx` embeds xterm.js and parses OSC 7 escape sequences to track the shell's cwd. This syncs the terminal's working directory back to the file panel. `pty.rs` injects shell-specific init code (bash/zsh/fish/PowerShell) for OSC 7 and OSC 133 prompt markers.
