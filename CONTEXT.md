# Faraday Project Context

## What It Is

Faraday is a dual-pane file manager built with a React/Vite frontend and a Rust/Tauri backend. It can run as:

- a desktop Tauri app
- a headless HTTP/WebSocket server
- an elevated RPC helper for privileged filesystem access on Unix

## Frontend Shape

- `src/main.tsx` initializes the runtime bridge and mounts the app.
- `src/app.tsx` owns the main UI: two file panels, terminal panel, file viewer, file editor, image viewer, dialogs, and global keyboard shortcuts.
- `src/bridge.ts` exposes one runtime-agnostic API for filesystem, PTY, utils, and theme operations.
- `src/tauriBridge.ts` implements that API with Tauri IPC.
- `src/wsBridge.ts` implements that API with JSON-RPC 2.0 over WebSocket.
- `src/fs.ts` wraps bridge operations in File System Access-style handles and observers.
- `src/fss.ts` loads layered `.faraday/fs.css` stylesheets for filesystem-aware coloring and icons.
- `src/FileList/FileList.tsx` renders the dual-pane file list with virtualized multi-column scrolling.
- `src/Terminal.tsx` embeds xterm.js and syncs cwd with the active panel using OSC 7.

## Backend Shape

- `src-tauri/src/main.rs` switches between desktop, `serve`, and `rpc` modes.
- `src-tauri/src/lib.rs` contains Tauri commands, shared app state, filesystem command wiring, and PTY event emission.
- `src-tauri/src/serve.rs` serves the web UI and WebSocket RPC endpoint for browser/headless mode.
- `src-tauri/src/rpc.rs` is the elevated helper used for privileged filesystem access on Unix.
- `src-tauri/src/pty.rs` implements Unix PTY and Windows ConPTY support.
- `src-tauri/faraday-core/src/ops.rs` contains shared filesystem operations.
- `src-tauri/faraday-core/src/watch.rs` contains shared watcher logic built on `notify`.

## Key Architectural Ideas

- The UI depends on a single bridge contract, not directly on Tauri or WebSocket details.
- `faraday-core` is the shared Rust layer used by desktop mode, headless mode, and the elevated helper.
- Filesystem styling comes from layered `.faraday/fs.css` files plus the bundled base icon/style layer.
- Terminal cwd reporting feeds back into panel navigation, so the terminal and file panes stay aligned.

## Notable Findings

- The README describes some scripts and headless workflows that do not exactly match the current `package.json`.
- Windows behavior is sensitive to path normalization because the frontend currently assumes POSIX-style paths in several places.
