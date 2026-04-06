import { systemThemeAtom, themesReadyAtom } from "@/atoms";
import { useBridge } from "@/features/bridge/useBridge";
import { useCommandRegistry } from "@/features/commands/commands";
import { clearFsProviderCache } from "@/features/extensions/browserFsProvider";
import { useExtensionHostClient } from "@/features/extensions/extensionHostClient";
import { type LoadedExtension } from "@/features/extensions/types";
import { useLoadedExtensions, useSetLoadedExtensions } from "@/features/extensions/useExtensions";
import { useSetIconTheme, useSetIconThemeKind } from "@/features/file-icons/iconResolver";
import { useClearExtensionFssLayers, useSetExtensionFssLayers } from "@/features/fss/fss";
import { useLanguageRegistry } from "@/features/languages/languageRegistry";
import { useActivePanelNavigation } from "@/features/panels/panelControllers";
import { activeColorThemeAtom, activeIconThemeAtom, extensionsAutoUpdateAtom, settingsReadyAtom } from "@/features/settings/useUserSettings";
import { useTerminal } from "@/features/terminal/useTerminal";
import { useViewerEditorRegistry } from "@/viewerEditorRegistry";
import { useAtomValue, useSetAtom } from "jotai";
import { useCallback, useEffect, useRef } from "react";
import { useExtensionAutoUpdateRuntime } from "@/features/extensions/runtime/useExtensionAutoUpdateRuntime";
import { useExtensionLifecycleRuntime } from "@/features/extensions/runtime/useExtensionLifecycleRuntime";
import { useExtensionThemeRuntime } from "@/features/extensions/runtime/useExtensionThemeRuntime";
import { type InstallRequest, useLatestRef } from "@/features/extensions/runtime/shared";

export function useExtensionRuntime(): void {
  const bridge = useBridge();
  const commandRegistry = useCommandRegistry();
  const extensionHost = useExtensionHostClient();
  const viewerEditorRegistry = useViewerEditorRegistry();
  const languageRegistry = useLanguageRegistry();
  const { refreshAll } = useActivePanelNavigation();
  const activeIconTheme = useAtomValue(activeIconThemeAtom);
  const activeColorTheme = useAtomValue(activeColorThemeAtom);
  const settingsReady = useAtomValue(settingsReadyAtom);
  const extensionsAutoUpdateEnabled = useAtomValue(extensionsAutoUpdateAtom);
  const systemTheme = useAtomValue(systemThemeAtom);
  const themesReady = useAtomValue(themesReadyAtom);
  const loadedExtensions = useLoadedExtensions();
  const setLoadedExtensions = useSetLoadedExtensions();
  const setThemesReady = useSetAtom(themesReadyAtom);
  const { setAvailableProfiles, setProfilesLoaded } = useTerminal();
  const { setIconTheme } = useSetIconTheme();
  const { setIconThemeKind } = useSetIconThemeKind();
  const setExtensionFssLayers = useSetExtensionFssLayers();
  const clearExtensionFssLayers = useClearExtensionFssLayers();

  const bridgeRef = useLatestRef(bridge);
  const commandRegistryRef = useLatestRef(commandRegistry);
  const extensionHostRef = useLatestRef(extensionHost);
  const viewerEditorRegistryRef = useLatestRef(viewerEditorRegistry);
  const languageRegistryRef = useLatestRef(languageRegistry);
  const settingsReadyRef = useLatestRef(settingsReady);

  const latestExtensionsRef = useRef<LoadedExtension[]>([]);
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

  const prepareExtensionRuntimeReload = useCallback((mode: "hard" | "soft") => {
    clearExtensionCommandRegistrations();
    languageRegistryRef.current.clear();
    viewerEditorRegistryRef.current.replaceExtensions([]);
    clearFsProviderCache();
    if (mode !== "hard") return;
    latestExtensionsRef.current = [];
    themesReadyRef.current = false;
    clearExtensionFssLayers();
    setLoadedExtensions([]);
    setAvailableProfiles([]);
    setProfilesLoaded(false);
    setThemesReady(false);
  }, [
    clearExtensionCommandRegistrations,
    clearExtensionFssLayers,
    languageRegistryRef,
    setAvailableProfiles,
    setLoadedExtensions,
    setProfilesLoaded,
    setThemesReady,
    viewerEditorRegistryRef,
  ]);

  const restartExtensionRuntime = useCallback(async () => {
    prepareExtensionRuntimeReload("hard");
    extensionsLoadedRef.current = false;
    await extensionHostRef.current.restart();
  }, [extensionHostRef, prepareExtensionRuntimeReload]);

  const reloadExtensionRuntimeInPlace = useCallback(async () => {
    prepareExtensionRuntimeReload("soft");
    extensionsLoadedRef.current = false;
    await extensionHostRef.current.restart();
  }, [extensionHostRef, prepareExtensionRuntimeReload]);

  const installExtensionAndWait = useCallback(async (request: InstallRequest): Promise<void> => {
    await new Promise<void>((resolve, reject) => {
      let installId: number | null = null;
      let finished = false;

      const cleanup = () => {
        if (finished) return;
        finished = true;
        unsubscribe();
      };

      const unsubscribe = bridgeRef.current.extensions.install.onProgress((payload) => {
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

      bridgeRef.current.extensions.install.start(request).then((id) => {
        installId = id;
      }).catch((error) => {
        cleanup();
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }, [bridgeRef]);

  const { applyInitialThemes } = useExtensionThemeRuntime({
    activeIconTheme,
    activeColorTheme,
    systemTheme,
    settingsReady,
    themesReady,
    latestExtensionsRef,
    themesReadyRef,
    iconThemeApplyGenerationRef,
    colorThemeApplyGenerationRef,
    setThemesReady,
    bridgeRef,
    setExtensionFssLayers,
    setIconTheme,
    setIconThemeKind,
    refreshAll,
  });

  useExtensionAutoUpdateRuntime({
    settingsReady,
    enabled: extensionsAutoUpdateEnabled,
    loadedExtensions,
    latestExtensionsRef,
    installExtensionAndWait,
    reloadExtensionRuntimeInPlace,
  });

  useExtensionLifecycleRuntime({
    bridgeRef,
    extensionHostRef,
    commandRegistryRef,
    viewerEditorRegistryRef,
    languageRegistryRef,
    latestExtensionsRef,
    extensionsLoadedRef,
    settingsReadyRef,
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
    return commandRegistryRef.current.registerCommand("dotdir.restartExtensionHost", restartExtensionRuntime);
  }, [commandRegistryRef, restartExtensionRuntime]);
}
