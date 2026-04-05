import { useBridge } from "@/features/bridge/useBridge";
import type { DotDirSettings } from "@/features/settings/types";
import { createUserSettingsWatcher, saveSettingsPatchToDisk } from "@/features/settings/userSettings";
import type { JsoncFileWatcher } from "@/jsoncFileWatcher";
import { atom, useAtomValue, useSetAtom } from "jotai";
import { createContext, createElement, useCallback, useContext, useEffect, useMemo, useRef, type ReactNode } from "react";

const settingsAtom = atom<DotDirSettings>({});
export const settingsReadyAtom = atom(false);

export const showHiddenAtom = atom((get) => get(settingsAtom).showHidden ?? false);
export const activeIconThemeAtom = atom((get) => get(settingsAtom).iconTheme);
export const activeColorThemeAtom = atom((get) => get(settingsAtom).colorTheme);
export const extensionsAutoUpdateAtom = atom((get) => get(settingsAtom).extensions?.autoUpdate ?? true);

type UserSettingsContextValue = {
  updateSettings: (partial: Partial<DotDirSettings>) => void;
};

const UserSettingsContext = createContext<UserSettingsContextValue | null>(null);

export function UserSettingsProvider({ children }: { children: ReactNode }) {
  const bridge = useBridge();
  const setSettings = useSetAtom(settingsAtom);
  const setReady = useSetAtom(settingsReadyAtom);
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
  }, [bridge, setReady, setSettings]);

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
    [bridge, setSettings],
  );

  const value = useMemo<UserSettingsContextValue>(
    () => ({
      updateSettings,
    }),
    [updateSettings],
  );

  return createElement(UserSettingsContext.Provider, { value }, children);
}

export function useUserSettings() {
  const settings = useAtomValue(settingsAtom);
  const ready = useAtomValue(settingsReadyAtom);
  const value = useContext(UserSettingsContext);
  if (!value) {
    throw new Error("useUserSettings must be used within UserSettingsProvider");
  }

  return { settings, ready, updateSettings: value.updateSettings };
}
