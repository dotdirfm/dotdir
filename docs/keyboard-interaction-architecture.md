# Keyboard Interaction Architecture

## Overview

DotDir keyboard handling is built from three layers:

1. **DOM event routing**
2. **Focus-aware command routing**
3. **Command handlers**

The current design keeps one keyboard abstraction in the system: commands.

- **Surface navigation** uses shared generic commands like `cursorLeft` and `selectRight`
- **Editing-specific behavior** uses dedicated commands like `commandLine.execute`

## Event Flow

The main entry point is [useCommandRouting.ts](/Users/mike/github/dotdirfm/dotdir/packages/ui/lib/features/commands/useCommandRouting.ts).

For most keys:

1. A `keydown` is captured on the app root.
2. `CommandRegistry.handleKeyboardEvent(...)` resolves the keybinding to a command id.
3. The most recently registered handler for that command runs.

There is also a window-level fallback for panel mode:

- plain `Tab`
- function keys like `F5`, `F6`, `F10`, `F11`

That fallback exists because some special keys do not reliably travel through the normal focused-element path in the webview/browser environment.

## Focus Layers

Keyboard routing depends on the current logical focus layer, not just `document.activeElement`.

Focus layers are managed by [focusContext.ts](/Users/mike/github/dotdirfm/dotdir/packages/ui/lib/focusContext.ts) and exposed to the command system through `CommandRegistry.setFocusLayerGetter(...)`.

Current `when` clauses rely on focus predicates such as:

- `focusPanel`
- `focusMenu`
- `focusViewer`
- `focusEditor`
- `focusModal`

This is what lets the same physical key mean different things in different surfaces.

## Command Families

### Shared Navigation Commands

These commands are intentionally generic:

- `cursorUp`
- `cursorDown`
- `cursorLeft`
- `cursorRight`
- `cursorHome`
- `cursorEnd`
- `cursorPageUp`
- `cursorPageDown`
- `selectUp`
- `selectDown`
- `selectLeft`
- `selectRight`
- `selectHome`
- `selectEnd`
- `selectPageUp`
- `selectPageDown`
- `accept`
- `cancel`

They are defined in [commandIds.ts](/Users/mike/github/dotdirfm/dotdir/packages/ui/lib/features/commands/commandIds.ts).

These commands are appropriate when the meaning is “move around the current interactive surface”.

That is why FileList uses the shared `cursor*` and `select*` commands directly now, instead of older aliases like `filelist.cursorLeft`.

### Command Line Editing Commands

The command line keeps separate command ids for behavior that is truly editing-specific, for example:

- `commandLine.cursorWordLeft`
- `commandLine.selectWordRight`
- `commandLine.deleteLeft`
- `commandLine.execute`

These are registered in [CommandLine.tsx](/Users/mike/github/dotdirfm/dotdir/packages/ui/lib/features/command-line/CommandLine/CommandLine.tsx).

These are not just alternate names for `cursorLeft`.

They represent **text editing behavior**, not generic surface navigation.

## Command Ownership

[CommandRegistry](/Users/mike/github/dotdirfm/dotdir/packages/ui/lib/features/commands/commands.ts) now uses a simple **latest registration wins** rule.

That means:

- multiple parts of the app may still reuse the same command id
- only one handler runs for a given command execution
- ownership is expressed by registration lifecycle, not by registry predicates

So the important rule is:

- if a surface owns a shared command right now, it registers it
- if it stops owning that command, it unregisters it

This is what allows shared navigation commands to be reused safely across panels, menus, command palette, autocomplete, and command line.

## Shared Commands vs Dedicated Commands

The command line now reuses shared navigation commands for:

- `cursorLeft`
- `cursorRight`
- `cursorHome`
- `cursorEnd`
- `selectLeft`
- `selectRight`
- `selectHome`
- `selectEnd`

Those handlers are registered by [CommandLine.tsx](/Users/mike/github/dotdirfm/dotdir/packages/ui/lib/features/command-line/CommandLine/CommandLine.tsx) only while the command line owns editing navigation.

So the split is now:

- **FileList/menu aliases were redundant and removed**
- **Command line uses shared commands for basic cursor/selection movement**
- **Command line keeps dedicated commands for word movement, delete, clipboard, and execute/clear**

## Keybinding Layers

Keybindings are registered through [registerKeybindings.ts](/Users/mike/github/dotdirfm/dotdir/packages/ui/lib/features/commands/registerKeybindings.ts).

Resolution order is:

1. default
2. extension
3. user

Later layers override earlier ones.

This means a key like `Left` may resolve to:

- `cursorLeft` in panel/menu contexts
- `cursorLeft` in command-line editing too, with the command line registering that command while it owns editing

The distinction happens through `when` clauses, focus layers, and registration ownership, not through a separate intent layer.

## Current Rules of Thumb

When adding keyboard behavior:

- Use shared `cursor*` / `select*` / `accept` / `cancel` commands for focus-surface navigation.
- Use dedicated command ids for true domain-specific behavior, especially editing commands.
- Prefer `when` clauses plus focus layers over duplicated routing layers.
- Popup surfaces such as menus, command palette, and autocomplete should expose their own focus layer and command handlers instead of inventing a separate keyboard abstraction.
- If a key is flaky in the webview, fix it in the routing layer rather than adding one-off listeners across feature components.

## Current Direction

The current architecture is:

- shared commands for navigation semantics
- dedicated commands for buffer-editing semantics
- lifecycle-based command ownership so surfaces reuse command ids safely
- no separate interaction-intent layer between keybindings and commands
