import { type Bridge, type SystemThemeKind } from "@dotdirfm/ui-bridge";
import { useBridge } from "@dotdirfm/ui-bridge";
import { useMemo, useSyncExternalStore } from "react";

type ThemeStore = {
  getSnapshot(): SystemThemeKind;
  subscribe(listener: () => void): () => void;
};

function createSystemThemeStore(bridge: Bridge): ThemeStore {
  let current: SystemThemeKind = "dark";
  let initialized = false;
  let unsubscribeBridge: (() => void) | null = null;
  const listeners = new Set<() => void>();

  const emit = () => {
    for (const listener of listeners) listener();
  };

  const setCurrent = (next: SystemThemeKind) => {
    if (current === next) return;
    current = next;
    emit();
  };

  const ensureStarted = () => {
    if (initialized) return;
    initialized = true;
    void bridge.systemTheme.get().then(setCurrent);
    unsubscribeBridge = bridge.systemTheme.onChange(setCurrent);
  };

  return {
    getSnapshot() {
      ensureStarted();
      return current;
    },
    subscribe(listener) {
      ensureStarted();
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && unsubscribeBridge) {
          unsubscribeBridge();
          unsubscribeBridge = null;
          initialized = false;
        }
      };
    },
  };
}

export function useSystemTheme(): SystemThemeKind {
  const bridge = useBridge();
  const store = useMemo(() => createSystemThemeStore(bridge), [bridge]);
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}
