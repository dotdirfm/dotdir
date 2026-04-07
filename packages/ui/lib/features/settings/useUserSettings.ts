import { useBridge } from "@/features/bridge/useBridge";
import type { DotDirSettings } from "@/features/settings/types";
import { createUserSettingsWatcher, saveSettingsPatchToDisk } from "@/features/settings/userSettings";
import type { JsoncFileWatcher } from "@/jsoncFileWatcher";
import { createContext, createElement, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

type UserSettingsContextValue = {
  settings: DotDirSettings;
  ready: boolean;
  updateSettings: (partial: Partial<DotDirSettings>) => void;
};

const UserSettingsContext = createContext<UserSettingsContextValue | null>(null);

export function UserSettingsProvider({ children }: { children: ReactNode }) {
  const bridge = useBridge();
  const [settings, setSettings] = useState<DotDirSettings>({});
  const [ready, setReady] = useState(false);
  const watcherRef = useRef<JsoncFileWatcher<DotDirSettings> | null>(null);
  const saveDebounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingPatchRef = useRef<Partial<DotDirSettings>>({});

  useEffect(() => {
    let cancelled = false;
    let unsubscribe: (() => void) | null = null;

    void (async () => {
      if (cancelled) return;
      const watcher = await createUserSettingsWatcher(bridge);
      if (cancelled) {
        await watcher.dispose();
        return;
      }

      watcherRef.current = watcher;
      setSettings(watcher.getValue());
      setReady(true);
      unsubscribe = watcher.onChange((value) => {
        setSettings(value);
      });
    })();

    return () => {
      cancelled = true;
      if (saveDebounceTimerRef.current) {
        clearTimeout(saveDebounceTimerRef.current);
        saveDebounceTimerRef.current = null;
      }
      pendingPatchRef.current = {};
      unsubscribe?.();
      const watcher = watcherRef.current;
      watcherRef.current = null;
      if (watcher) {
        void watcher.dispose();
      }
    };
  }, [bridge]);

  const updateSettings = useCallback(
    (partial: Partial<DotDirSettings>) => {
      const watcher = watcherRef.current;
      if (!watcher) return;

      const current = watcher.getValue();
      const updated = { ...current, ...partial };
      watcher.setValue(updated);
      setSettings(updated);
      pendingPatchRef.current = { ...pendingPatchRef.current, ...partial };

      if (saveDebounceTimerRef.current) clearTimeout(saveDebounceTimerRef.current);
      saveDebounceTimerRef.current = setTimeout(() => {
        const pendingPatch = pendingPatchRef.current;
        saveDebounceTimerRef.current = null;
        pendingPatchRef.current = {};
        void saveSettingsPatchToDisk(bridge, pendingPatch);
      }, 500);
    },
    [bridge],
  );

  const value = useMemo<UserSettingsContextValue>(
    () => ({
      settings,
      ready,
      updateSettings,
    }),
    [ready, settings, updateSettings],
  );

  return createElement(UserSettingsContext.Provider, { value }, children);
}

function useUserSettingsContext(): UserSettingsContextValue {
  const value = useContext(UserSettingsContext);
  if (!value) {
    throw new Error("useUserSettings must be used within UserSettingsProvider");
  }
  return value;
}

export function useUserSettings() {
  return useUserSettingsContext();
}

export function useSettingsReady(): boolean {
  return useUserSettingsContext().ready;
}

export function useShowHidden(): boolean {
  return useUserSettingsContext().settings.showHidden ?? false;
}

export function useActiveIconTheme(): string | undefined {
  return useUserSettingsContext().settings.iconTheme;
}

export function useActiveColorTheme(): string | undefined {
  return useUserSettingsContext().settings.colorTheme;
}

export function useExtensionsAutoUpdateEnabled(): boolean {
  return useUserSettingsContext().settings.extensions?.autoUpdate ?? true;
}
