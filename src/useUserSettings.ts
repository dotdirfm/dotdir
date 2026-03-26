import { atom, useAtomValue, useSetAtom } from "jotai";
import { useCallback, useEffect } from "react";
import type { FaradaySettings } from "./extensions";
import { initUserSettings, onSettingsChange, updateSettings as persistSettings } from "./userSettings";

const settingsAtom = atom<FaradaySettings>({});
const settingsReadyAtom = atom(false);

// Ensures initUserSettings() is called at most once across all hook instances
let initPromise: Promise<FaradaySettings> | null = null;

export function useUserSettings() {
  const settings = useAtomValue(settingsAtom);
  const ready = useAtomValue(settingsReadyAtom);
  const setSettings = useSetAtom(settingsAtom);
  const setReady = useSetAtom(settingsReadyAtom);

  useEffect(() => {
    if (!initPromise) initPromise = initUserSettings();
    initPromise.then((s) => {
      setSettings(s);
      setReady(true);
    });
    return onSettingsChange(setSettings);
  }, [setSettings, setReady]);

  const updateSettings = useCallback(
    (partial: Partial<FaradaySettings>) => {
      setSettings((prev) => ({ ...prev, ...partial }));
      persistSettings(partial);
    },
    [setSettings],
  );

  return { settings, ready, updateSettings };
}
