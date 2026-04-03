import { useBridge } from "@/features/bridge/useBridge";
import type { DotDirSettings } from "@/features/settings/types";
import { initUserSettings, onSettingsChange, updateSettings as updateUserSettings } from "@/features/settings/userSettings";
import { atom, useAtomValue, useSetAtom } from "jotai";
import { useCallback, useEffect } from "react";

const settingsAtom = atom<DotDirSettings>({});
export const settingsReadyAtom = atom(false);

export const showHiddenAtom = atom(get => get(settingsAtom).showHidden ?? false);
export const activeIconThemeAtom = atom(get => get(settingsAtom).iconTheme);
export const activeColorThemeAtom = atom(get => get(settingsAtom).colorTheme);

// Ensures initUserSettings() is called at most once across all hook instances
let initPromise: Promise<DotDirSettings> | null = null;

export function useUserSettings() {
  const settings = useAtomValue(settingsAtom);
  const ready = useAtomValue(settingsReadyAtom);
  const setSettings = useSetAtom(settingsAtom);
  const setReady = useSetAtom(settingsReadyAtom);
  const bridge = useBridge();

  useEffect(() => {
    if (!initPromise) initPromise = initUserSettings(bridge);
    initPromise.then((s) => {
      setSettings(s);
      setReady(true);
    });
    return onSettingsChange(setSettings);
  }, [setSettings, setReady, bridge]);

  const updateSettings = useCallback(
    (partial: Partial<DotDirSettings>) => {
      setSettings((prev) => ({ ...prev, ...partial }));
      updateUserSettings(bridge, partial);
    },
    [bridge, setSettings],
  );

  return { settings, ready, updateSettings };
}
