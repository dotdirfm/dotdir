import { readAppDirs, useAppDirs } from "@dotdirfm/ui-bridge";
import { bridgeAtom, useBridge } from "@dotdirfm/ui-bridge";
import type { JsoncFileWatcher } from "@/features/file-system/jsoncFileWatcher";
import type { DotDirSettings } from "@/features/settings/types";
import { createUserSettingsWatcher, loadUserSettings, saveSettingsPatchToDisk } from "@/features/settings/userSettings";
import { atom, useAtomValue, useSetAtom } from "jotai";
import { use, useCallback, useEffect, useState, type ReactNode } from "react";

const initialSettingsCache = new WeakMap<object, Promise<DotDirSettings>>();

const userSettingsAtom = atom<DotDirSettings>({});
const userSettingsPendingPatchAtom = atom<Partial<DotDirSettings>>({});
const userSettingsSaveTimerAtom = atom<ReturnType<typeof setTimeout> | null>(null);

const userSettingsWriteAtom = atom(
  null,
  (get, set, partial: Partial<DotDirSettings>) => {
    const bridge = get(bridgeAtom);
    if (!bridge) return;

    const current = get(userSettingsAtom);
    const next = { ...current, ...partial };
    set(userSettingsAtom, next);

    void (async () => {
      const { configDir } = await readAppDirs(bridge);
      const watcher = await createUserSettingsWatcher(bridge, configDir);
      try {
        watcher.setValue(next);
      } finally {
        await watcher.dispose();
      }
    })();

    const pendingPatch = get(userSettingsPendingPatchAtom);
    set(userSettingsPendingPatchAtom, { ...pendingPatch, ...partial });

    const activeTimer = get(userSettingsSaveTimerAtom);
    if (activeTimer) {
      clearTimeout(activeTimer);
    }

    const timer = setTimeout(() => {
      const patch = get(userSettingsPendingPatchAtom);
      set(userSettingsPendingPatchAtom, {});
      set(userSettingsSaveTimerAtom, null);
      void (async () => {
        const { configDir } = await readAppDirs(bridge);
        await saveSettingsPatchToDisk(bridge, configDir, patch);
      })();
    }, 500);

    set(userSettingsSaveTimerAtom, timer);
  },
);

const showHiddenAtom = atom((get) => get(userSettingsAtom).showHidden ?? false);

function getInitialSettings(bridge: ReturnType<typeof useBridge>, configDir: string): Promise<DotDirSettings> {
  const cached = initialSettingsCache.get(bridge);
  if (cached) return cached;
  const pending = loadUserSettings(bridge, configDir);
  initialSettingsCache.set(bridge, pending);
  return pending;
}

export function UserSettingsProvider({ children }: { children: ReactNode }) {
  const bridge = useBridge();
  const { configDir } = useAppDirs();
  const initialSettings = use(getInitialSettings(bridge, configDir));
  const setSettings = useSetAtom(userSettingsAtom);
  const setPendingPatch = useSetAtom(userSettingsPendingPatchAtom);
  const setSaveTimer = useSetAtom(userSettingsSaveTimerAtom);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setSettings(initialSettings);
    setReady(true);
  }, [initialSettings, setSettings]);

  useEffect(() => {
    let cancelled = false;
    let unsubscribe: (() => void) | null = null;
    let watcher: JsoncFileWatcher<DotDirSettings> | null = null;

    void (async () => {
      watcher = await createUserSettingsWatcher(bridge, configDir);
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
  }, [bridge, configDir, setSettings]);

  useEffect(() => {
    return () => {
      setSaveTimer((current) => {
        if (current) {
          clearTimeout(current);
        }
        return null;
      });
      setPendingPatch({});
    };
  }, [setPendingPatch, setSaveTimer]);

  return ready ? children : null;
}

export function useUserSettings() {
  const settings = useAtomValue(userSettingsAtom);
  const writeSettings = useSetAtom(userSettingsWriteAtom);
  const updateSettings = useCallback(
    (partial: Partial<DotDirSettings>) => {
      writeSettings(partial);
    },
    [writeSettings],
  );
  return { settings, updateSettings };
}

export function useShowHidden() {
  const showHidden = useAtomValue(showHiddenAtom);
  const writeSettings = useSetAtom(userSettingsWriteAtom);
  return {
    showHidden,
    setShowHidden: (value: boolean) => writeSettings({ showHidden: value }),
  };
}

export function useActiveIconTheme() {
  const { settings, updateSettings } = useUserSettings();
  return {
    activeIconTheme: settings.iconTheme,
    setActiveIconTheme: (value: string | undefined) => updateSettings({ iconTheme: value }),
  };
}

export function useActiveColorTheme() {
  const { settings, updateSettings } = useUserSettings();
  return {
    activeColorTheme: settings.colorTheme,
    setActiveColorTheme: (value: string | undefined) => updateSettings({ colorTheme: value }),
  };
}

export function useExtensionsAutoUpdateEnabled() {
  const { settings, updateSettings } = useUserSettings();
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
