# @dotdirfm/commands

VS Code-compatible command registry and keybinding system for DotDir.

## Features

- Command registration, execution, and disposal with active-scope support
- Multi-layer keybinding system (`default` < `extension` < `user`)
- `when` clause evaluation with `&&`, `||`, `!` operators
- Layout-independent keyboard event routing (physical code based)
- Batch operations for context updates to avoid cascading notifications
- React integration via context + `useCommandRegistry` hook

## Install

```bash
pnpm add @dotdirfm/commands
```

## Usage

```tsx
import { CommandRegistryProvider, useCommandRegistry } from "@dotdirfm/commands";

function App() {
  return (
    <CommandRegistryProvider>
      <MyComponent />
    </CommandRegistryProvider>
  );
}

function MyComponent() {
  const registry = useCommandRegistry();
  // Register commands, add keybindings, execute commands
}
```

## Exports

| Export | Description |
|--------|-------------|
| `CommandRegistry` | Main class for managing commands and keybindings |
| `CommandRegistryProvider` / `useCommandRegistry` | React context and hook |
| `runCommandSequence` | Execute a sequence of commands |
| `formatKeybinding` | Render platform-specific key labels with symbols |
| `commandIds.ts` | All command ID string constants |
