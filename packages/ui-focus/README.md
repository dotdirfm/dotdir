# @dotdirfm/ui-focus

Stack-based focus layer management for DotDir. Focus is modeled as a stack so temporary surfaces (modals, command palette) can override the current layer and restore on dismissal.

## Install

```bash
pnpm add @dotdirfm/ui-focus
```

## Usage

```tsx
import { FocusProvider, useManagedFocusLayer, useFocusContext } from "@dotdirfm/ui-focus";

function App() {
  return (
    <FocusProvider>
      <MainPanel />
      <CommandPalette />
    </FocusProvider>
  );
}

function MainPanel() {
  useManagedFocusLayer("panel", true);
  // ...
}

function CommandPalette() {
  useManagedFocusLayer("palette", isOpen);
  // ...
}
```

## Exports

| Export | Description |
|--------|-------------|
| `FocusContextManager` | Stack-based focus layer manager |
| `FocusProvider` / `useFocusContext` | React context and hook |
| `useManagedFocusLayer` | Hook to push/pop a focus layer |
| `FocusState`, `FocusLayer` | Type definitions |
