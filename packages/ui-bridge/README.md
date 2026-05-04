# @dotdirfm/ui-bridge

Backend communication abstraction for DotDir. All UI code depends on this interface — never on concrete backend implementations.

## Purpose

Defines the abstract `Bridge` interface that provides:
- File system operations (list, read, write, stat, copy, move, delete, rename)
- PTY (terminal) management
- System theme and window state
- Extension host API
- Utility functions (app dirs, home path, etc.)

## Install

```bash
pnpm add @dotdirfm/ui-bridge
```

## Usage

```tsx
import { BridgeProvider, useBridge, bridgeAtom } from "@dotdirfm/ui-bridge";

function App({ bridge }: { bridge: Bridge }) {
  return (
    <BridgeProvider bridge={bridge}>
      <MyComponent />
    </BridgeProvider>
  );
}

function MyComponent() {
  const bridge = useBridge();
  // Use bridge methods...
}
```

## Exports

| Export | Description |
|--------|-------------|
| `Bridge` | Interface for all backend communication |
| `BridgeProvider` / `useBridge` | React context provider and hook |
| `bridgeAtom` | Jotai atom for bridge state |
| `useAppDirs` | Hook to read application directories |
| `FsEntry`, `FsChangeEvent`, `CopyOptions`, etc. | Type definitions for bridge operations |
