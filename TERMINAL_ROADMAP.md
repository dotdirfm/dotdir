# Terminal Roadmap

This document tracks the plan for evolving .dir's terminal toward a VS Code-style architecture.

## Goals

- Separate terminal rendering from terminal session lifecycle.
- Make PTY sessions first-class objects instead of a handful of ad hoc callbacks.
- Add capability tracking on top of raw terminal I/O.
- Keep desktop Tauri and headless WebSocket modes on the same terminal contract.

## Current State

- Terminal UI, xterm wiring, PTY lifecycle, cwd sync, and OSC parsing are mixed together in [src/Terminal.tsx](/D:/Projects/dotdir/dotdir-tauri/src/Terminal.tsx).
- The bridge exposes low-level PTY operations only: spawn, write, resize, close, data, exit.
- The Rust PTY backend is now portable, but the frontend still treats it like a raw byte pipe.

## Target Shape

### Frontend

- `TerminalView`
  - Owns xterm.js, fit addon, resize observer, and DOM integration.
- `TerminalSession`
  - Owns PTY lifecycle, metadata, status, cwd, shell integration parsing, and terminal capabilities.
- `TerminalService`
  - Owns session creation, active session, split terminals, restoration, and reconnection behavior.
- `terminal/parser`
  - Parses OSC and prompt-oriented shell integration signals.
- `terminal/capabilities`
  - Tracks cwd, prompt detection, command lifecycle, shell type, and future exit code support.

### Backend

- Return PTY launch metadata with session id, shell, and cwd.
- Keep local Tauri PTY and WebSocket PTY on the same shape.
- Add richer events over time when shell integration becomes explicit.

## Phases

### Phase 1: Split View from Session

- Extract xterm.js setup into `TerminalView`.
- Introduce `TerminalSession` as the owner of PTY lifecycle.
- Reduce `Terminal.tsx` to glue code.

Status: started

### Phase 2: Richer Session Model

- Return PTY launch metadata instead of a bare id.
- Normalize frontend session events: data, exit, cwd change, launch, status, error.
- Create a stable place for future title, environment, and reconnection metadata.

Status: started

### Phase 3: Capability Tracking

- Parse OSC 7 cwd updates outside the React view.
- Track shell type from launch metadata.
- Detect command start from user-entered input.
- Detect prompt-ready state heuristically from shell output.

Status: started

### Phase 4: Terminal Service

- Manage multiple sessions.
- Support split terminals and session switching.
- Restore sessions after UI reload or reconnect.

Status: started

### Phase 5: Reliability and UX

- Show startup and runtime terminal errors inline.
- Add explicit reconnect handling for remote sessions.
- Add session status UI and better terminal theming.

Status: started
