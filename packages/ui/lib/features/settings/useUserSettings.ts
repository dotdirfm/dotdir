import { DotDirSettings } from "@/features/settings/types";
import { initUserSettings, onSettingsChange, updateSettings as updateUserSettings } from "@/features/settings/userSettings";
import { atom, useAtomValue, useSetAtom } from "jotai";
import { useCallback, useEffect } from "react";
import { useBridge } from "../../hooks/useBridge";

const settingsAtom = atom<DotDirSettings>({});
const settingsReadyAtom = atom(false);

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
    [setSettings],
  );

  return { settings, ready, updateSettings };
}
