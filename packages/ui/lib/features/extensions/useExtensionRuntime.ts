import { systemThemeAtom, themesReadyAtom } from "@/atoms";
import { useBridge } from "@/features/bridge/useBridge";
import { useCommandRegistry } from "@/features/commands/commands";
import { clearFsProviderCache } from "@/features/extensions/browserFsProvider";
import { useExtensionHostClient } from "@/features/extensions/extensionHostClient";
import { type InstallRequest } from "@/features/extensions/runtime/shared";
import { useExtensionAutoUpdateRuntime } from "@/features/extensions/runtime/useExtensionAutoUpdateRuntime";
import { useExtensionLifecycleRuntime } from "@/features/extensions/runtime/useExtensionLifecycleRuntime";
import { useExtensionThemeRuntime } from "@/features/extensions/runtime/useExtensionThemeRuntime";
import { useSetLoadedExtensions } from "@/features/extensions/useExtensions";
import { useClearExtensionFssLayers, useSetExtensionFssLayers } from "@/features/fss/fss";
import { useLanguageRegistry } from "@/features/languages/languageRegistry";
import { useActiveColorTheme, useActiveIconTheme } from "@/features/settings/useUserSettings";
import { useTerminal } from "@/features/terminal/useTerminal";
import { useViewerEditorRegistry } from "@/viewerEditorRegistry";
import { useAtom, useAtomValue } from "jotai";
import { useCallback, useEffect, useRef } from "react";

export function useExtensionRuntime(): void {
  const bridge = useBridge();
  const commandRegistry = useCommandRegistry();
  const extensionHost = useExtensionHostClient();
  const languageRegistry = useLanguageRegistry();
  const { activeIconTheme } = useActiveIconTheme();
  const { activeColorTheme } = useActiveColorTheme();
  const systemTheme = useAtomValue(systemThemeAtom);
  const [themesReady, setThemesReady] = useAtom(themesReadyAtom);
  const setLoadedExtensions = useSetLoadedExtensions();
  const { setAvailableProfiles, setProfilesLoaded } = useTerminal();
  const setExtensionFssLayers = useSetExtensionFssLayers();
  const clearExtensionFssLayers = useClearExtensionFssLayers();
  const viewerEditorRegistry = useViewerEditorRegistry();

  const extensionsLoadedRef = useRef(false);
  const extensionContributionDisposersRef = useRef<Array<() => void>>([]);
  const themesReadyRef = useRef(false);
  const iconThemeApplyGenerationRef = useRef(0);
  const colorThemeApplyGenerationRef = useRef(0);

  const clearExtensionCommandRegistrations = useCallback(() => {
    for (const dispose of extensionContributionDisposersRef.current) {
      try {
        dispose();
      } catch {
        // Ignore extension teardown errors.
      }
    }
    extensionContributionDisposersRef.current = [];
  }, []);

  const prepareExtensionRuntimeReload = useCallback(
    (mode: "hard" | "soft") => {
      clearExtensionCommandRegistrations();
      languageRegistry.clear();
      viewerEditorRegistry.replaceExtensions([]);
      clearFsProviderCache();
      if (mode !== "hard") return;
      themesReadyRef.current = false;
      clearExtensionFssLayers();
      setLoadedExtensions([]);
      setAvailableProfiles([]);
      setProfilesLoaded(false);
      setThemesReady(false);
    },
    [clearExtensionCommandRegistrations, clearExtensionFssLayers, languageRegistry, setAvailableProfiles, setLoadedExtensions, setProfilesLoaded, setThemesReady, viewerEditorRegistry],
  );

  const restartExtensionRuntime = useCallback(async () => {
    prepareExtensionRuntimeReload("hard");
    extensionsLoadedRef.current = false;
    await extensionHost.restart();
  }, [extensionHost, prepareExtensionRuntimeReload]);

  const reloadExtensionRuntimeInPlace = useCallback(async () => {
    prepareExtensionRuntimeReload("soft");
    extensionsLoadedRef.current = false;
    await extensionHost.restart();
  }, [extensionHost, prepareExtensionRuntimeReload]);

  const installExtensionAndWait = useCallback(
    async (request: InstallRequest): Promise<void> => {
      await new Promise<void>((resolve, reject) => {
        let installId: number | null = null;
        let finished = false;

        const cleanup = () => {
          if (finished) return;
          finished = true;
          unsubscribe();
        };

        const unsubscribe = bridge.extensions.install.onProgress((payload) => {
          if (installId == null || payload.installId !== installId) return;
          if (payload.event.kind === "done") {
            cleanup();
            resolve();
            return;
          }
          if (payload.event.kind === "error") {
            cleanup();
            reject(new Error(payload.event.message));
          }
        });

        bridge.extensions.install
          .start(request)
          .then((id) => {
            installId = id;
          })
          .catch((error) => {
            cleanup();
            reject(error instanceof Error ? error : new Error(String(error)));
          });
      });
    },
    [bridge],
  );

  const { applyInitialThemes } = useExtensionThemeRuntime({
    activeIconTheme,
    activeColorTheme,
    systemTheme,
    themesReady,
    themesReadyRef,
    iconThemeApplyGenerationRef,
    colorThemeApplyGenerationRef,
    setThemesReady,
    setExtensionFssLayers,
  });

  useExtensionAutoUpdateRuntime({ installExtensionAndWait, reloadExtensionRuntimeInPlace });

  useExtensionLifecycleRuntime({
    extensionsLoadedRef,
    extensionContributionDisposersRef,
    clearExtensionCommandRegistrations,
    setLoadedExtensions,
    setAvailableProfiles,
    setProfilesLoaded,
    applyInitialThemes,
  });

  useEffect(() => {
    const onRequest = bridge.extensions.install.onRequest;
    if (!onRequest) return;
    return onRequest((request) => {
      if (!request) return;
      void (async () => {
        try {
          await installExtensionAndWait(request);
          await reloadExtensionRuntimeInPlace();
        } catch (error) {
          console.error("[ExtHost] Deep-link install failed", error);
        }
      })();
    });
  }, [bridge, installExtensionAndWait, reloadExtensionRuntimeInPlace]);

  useEffect(() => {
    return commandRegistry.registerCommand("dotdir.restartExtensionHost", restartExtensionRuntime);
  }, [commandRegistry, restartExtensionRuntime]);
}
