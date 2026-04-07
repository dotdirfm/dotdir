import { useBridge } from "@/features/bridge/useBridge";
import type { JsoncFileWatcher } from "@/features/file-system/jsoncFileWatcher";
import type { DotDirSettings } from "@/features/settings/types";
import { createUserSettingsWatcher, loadUserSettings, saveSettingsPatchToDisk } from "@/features/settings/userSettings";
import { createContext, createElement, use, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

type UserSettingsContextValue = {
  settings: DotDirSettings;
  updateSettings: (partial: Partial<DotDirSettings>) => void;
};

const UserSettingsContext = createContext<UserSettingsContextValue | null>(null);
const initialSettingsCache = new WeakMap<object, Promise<DotDirSettings>>();

function getInitialSettings(bridge: ReturnType<typeof useBridge>): Promise<DotDirSettings> {
  const cached = initialSettingsCache.get(bridge);
  if (cached) return cached;
  const pending = loadUserSettings(bridge);
  initialSettingsCache.set(bridge, pending);
  return pending;
}

export function UserSettingsProvider({ children }: { children: ReactNode }) {
  const bridge = useBridge();
  const initialSettings = use(getInitialSettings(bridge));
  const [settings, setSettings] = useState<DotDirSettings>(initialSettings);
  const pendingPatchRef = useMemo(() => ({ current: {} as Partial<DotDirSettings> }), []);
  const saveTimerRef = useMemo(() => ({ current: null as ReturnType<typeof setTimeout> | null }), []);

  useEffect(() => {
    let cancelled = false;
    let unsubscribe: (() => void) | null = null;
    let watcher: JsoncFileWatcher<DotDirSettings> | null = null;

    void (async () => {
      watcher = await createUserSettingsWatcher(bridge);
      if (cancelled) {
        await watcher.dispose();
        return;
      }
      setSettings(watcher.getValue());
      unsubscribe = watcher.onChange((value) => {
        setSettings(value);
      });
    })();

    return () => {
      cancelled = true;
      unsubscribe?.();
      if (watcher) {
        void watcher.dispose();
      }
    };
  }, [bridge]);

  const updateSettings = useCallback(
    (partial: Partial<DotDirSettings>) => {
      setSettings((current) => {
        const next = { ...current, ...partial };
        void (async () => {
          const watcher = await createUserSettingsWatcher(bridge);
          try {
            watcher.setValue(next);
          } finally {
            await watcher.dispose();
          }
        })();
        pendingPatchRef.current = { ...pendingPatchRef.current, ...partial };
        if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
        saveTimerRef.current = setTimeout(() => {
          const patch = pendingPatchRef.current;
          pendingPatchRef.current = {};
          saveTimerRef.current = null;
          void saveSettingsPatchToDisk(bridge, patch);
        }, 500);
        return next;
      });
    },
    [bridge, pendingPatchRef, saveTimerRef],
  );

  useEffect(() => {
    return () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      pendingPatchRef.current = {};
    };
  }, [pendingPatchRef, saveTimerRef]);

  const value = useMemo<UserSettingsContextValue>(
    () => ({
      settings,
      updateSettings,
    }),
    [settings, updateSettings],
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

export function useShowHidden() {
  const { settings, updateSettings } = useUserSettingsContext();
  return {
    showHidden: settings.showHidden ?? false,
    setShowHidden: (value: boolean) => updateSettings({ showHidden: value }),
  };
}

export function useActiveIconTheme() {
  const { settings, updateSettings } = useUserSettingsContext();
  return {
    activeIconTheme: settings.iconTheme,
    setActiveIconTheme: (value: string | undefined) => updateSettings({ iconTheme: value }),
  };
}

export function useActiveColorTheme() {
  const { settings, updateSettings } = useUserSettingsContext();
  return {
    activeColorTheme: settings.colorTheme,
    setActiveColorTheme: (value: string | undefined) => updateSettings({ colorTheme: value }),
  };
}

export function useExtensionsAutoUpdateEnabled() {
  const { settings, updateSettings } = useUserSettingsContext();
  return {
    extensionsAutoUpdateEnabled: settings.extensions?.autoUpdate ?? true,
    setExtensionsAutoUpdateEnabled: (value: boolean) =>
      updateSettings({
        extensions: {
          ...settings.extensions,
          autoUpdate: value,
        },
      }),
  };
}
