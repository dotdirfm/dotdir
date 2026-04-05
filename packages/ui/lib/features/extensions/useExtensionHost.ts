import { loadedExtensionsAtom, systemThemeAtom, themesReadyAtom } from "@/atoms";
import { useBridge } from "@/features/bridge/useBridge";
import { useCommandRegistry } from "@/features/commands/commands";
import { registerExtensionKeybindings } from "@/features/commands/registerKeybindings";
import { clearFsProviderCache } from "@/features/extensions/browserFsProvider";
import { executeMountedExtensionCommand } from "@/features/extensions/extensionCommandHandlers";
import { useExtensionHostClient } from "@/features/extensions/extensionHostClient";
import { fetchOpenVsxExtensionDetails } from "@/features/marketplace/openVsxMarketplace";
import { checkMarketplaceUpdates, compareExtensionVersions, type ExtensionInstallSource, type LoadedExtension, findColorTheme } from "@/features/extensions/extensions";
import { useSetIconTheme, useSetIconThemeKind } from "@/features/file-icons/iconResolver";
import { readFileText } from "@/features/file-system/fs";
import { useActivePanelNavigation } from "@/features/panels/panelControllers";
import { activeColorThemeAtom, activeIconThemeAtom, extensionsAutoUpdateAtom, settingsReadyAtom } from "@/features/settings/useUserSettings";
import { useTerminal } from "@/features/terminal/useTerminal";
import { resolveShellProfiles } from "@/features/terminal/shellProfiles";
import { clearColorTheme, loadAndApplyColorTheme, uiThemeToKind } from "@/features/themes/vscodeColorTheme";
import { useClearExtensionFssLayers, useSetExtensionFssLayers } from "@/fss";
import { useLanguageRegistry } from "@/languageRegistry";
import { dirname, join } from "@/utils/path";
import { getStyleHostElement } from "@/utils/styleHost";
import { populateRegistries } from "@/viewerEditorRegistry";
import { useAtomValue, useSetAtom } from "jotai";
import { useCallback, useEffect, useRef } from "react";

const AUTO_UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000;
const AUTO_UPDATE_INITIAL_DELAY_MS = 60 * 1000;

export function useExtensionHost(): void {
  const bridge = useBridge();
  const bridgeRef = useRef(bridge);
  bridgeRef.current = bridge;
  const commandRegistry = useCommandRegistry();
  const commandRegistryRef = useRef(commandRegistry);
  commandRegistryRef.current = commandRegistry;
  const extensionHost = useExtensionHostClient();
  const extensionHostRef = useRef(extensionHost);
  extensionHostRef.current = extensionHost;
  const setExtensionFssLayers = useSetExtensionFssLayers();
  const clearExtensionFssLayers = useClearExtensionFssLayers();
  const languageRegistry = useLanguageRegistry();
  const languageRegistryRef = useRef(languageRegistry);
  languageRegistryRef.current = languageRegistry;
  const { refreshAll } = useActivePanelNavigation();
  const activeIconTheme = useAtomValue(activeIconThemeAtom);
  const activeColorTheme = useAtomValue(activeColorThemeAtom);
  const settingsReady = useAtomValue(settingsReadyAtom);
  const extensionsAutoUpdateEnabled = useAtomValue(extensionsAutoUpdateAtom);
  const systemTheme = useAtomValue(systemThemeAtom);
  const themesReady = useAtomValue(themesReadyAtom);
  const loadedExtensions = useAtomValue(loadedExtensionsAtom);
  const setLoadedExtensions = useSetAtom(loadedExtensionsAtom);
  const setThemesReady = useSetAtom(themesReadyAtom);
  const { setAvailableProfiles, setProfilesLoaded } = useTerminal();
  const { setIconTheme } = useSetIconTheme();
  const { setIconThemeKind } = useSetIconThemeKind();

  // Refs so async callbacks always see the latest atom values without re-subscribing
  const activeIconThemeRef = useRef(activeIconTheme);
  activeIconThemeRef.current = activeIconTheme;
  const activeColorThemeRef = useRef(activeColorTheme);
  activeColorThemeRef.current = activeColorTheme;
  const settingsReadyRef = useRef(settingsReady);
  settingsReadyRef.current = settingsReady;
  const refreshPanelsRef = useRef(refreshAll);
  refreshPanelsRef.current = refreshAll;
  const setIconThemeRef = useRef(setIconTheme);
  setIconThemeRef.current = setIconTheme;
  const setIconThemeKindRef = useRef(setIconThemeKind);
  setIconThemeKindRef.current = setIconThemeKind;
  const systemThemeRef = useRef(systemTheme);
  systemThemeRef.current = systemTheme;

  // Internal refs — never exposed outside this hook
  const latestExtensionsRef = useRef<LoadedExtension[]>([]);
  const extensionsLoadedRef = useRef(false);
  const extensionContributionDisposersRef = useRef<(() => void)[]>([]);
  const themesReadyRef = useRef(false);
  const iconThemeApplyGenerationRef = useRef(0);
  const colorThemeApplyGenerationRef = useRef(0);
  const autoUpdateInFlightRef = useRef(false);

  const clearExtensionCommandRegistrations = useCallback(() => {
    for (const d of extensionContributionDisposersRef.current) {
      try {
        d();
      } catch {
        /* ignore */
      }
    }
    extensionContributionDisposersRef.current = [];
  }, []);

  const resetExtensionRuntimeState = useCallback(() => {
    latestExtensionsRef.current = [];
    themesReadyRef.current = false;
    clearExtensionCommandRegistrations();
    languageRegistryRef.current.clear();
    populateRegistries([]);
    clearExtensionFssLayers();
    clearFsProviderCache();
    setLoadedExtensions([]);
    setAvailableProfiles([]);
    setProfilesLoaded(false);
    setThemesReady(false);
  }, [clearExtensionCommandRegistrations, clearExtensionFssLayers, setAvailableProfiles, setLoadedExtensions, setProfilesLoaded, setThemesReady]);

  const restartExtensionHost = useCallback(async () => {
    resetExtensionRuntimeState();
    extensionsLoadedRef.current = false;
    await extensionHostRef.current.restart();
  }, [resetExtensionRuntimeState]);

  const installExtensionAndWait = useCallback(
    async (
      request:
        | { source: "dotdir-marketplace"; publisher: string; name: string; version: string }
        | { source: "open-vsx-marketplace"; publisher: string; name: string; downloadUrl: string },
    ): Promise<void> => {
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
          } else if (payload.event.kind === "error") {
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
    },
    [],
  );

  const runAutoUpdatePass = useCallback(async (): Promise<void> => {
    if (autoUpdateInFlightRef.current) return;
    autoUpdateInFlightRef.current = true;
    try {
      const installedForUpdate = latestExtensionsRef.current.filter(
        (ext) => !ext.ref.path && ext.ref.source && (ext.ref.autoUpdate ?? true),
      );
      if (installedForUpdate.length === 0) return;

      const pendingInstalls: Array<
        | { source: "dotdir-marketplace"; publisher: string; name: string; version: string }
        | { source: "open-vsx-marketplace"; publisher: string; name: string; downloadUrl: string }
      > = [];

      const bySource = (source: ExtensionInstallSource) => installedForUpdate.filter((ext) => ext.ref.source === source);

      const dotdirExtensions = bySource("dotdir-marketplace");
      if (dotdirExtensions.length > 0) {
        const updates = await checkMarketplaceUpdates(
          dotdirExtensions.map((ext) => ({
            publisher: ext.ref.publisher,
            name: ext.ref.name,
            version: ext.ref.version,
          })),
        );
        for (const update of updates) {
          if (!update.hasUpdate || !update.latestVersion) continue;
          pendingInstalls.push({
            source: "dotdir-marketplace",
            publisher: update.publisher,
            name: update.name,
            version: update.latestVersion,
          });
        }
      }

      const openVsxExtensions = bySource("open-vsx-marketplace");
      for (const ext of openVsxExtensions) {
        try {
          const details = await fetchOpenVsxExtensionDetails(ext.ref.publisher, ext.ref.name);
          if (!details.version || compareExtensionVersions(details.version, ext.ref.version) <= 0) continue;
          if (!details.files?.download) continue;
          pendingInstalls.push({
            source: "open-vsx-marketplace",
            publisher: ext.ref.publisher,
            name: ext.ref.name,
            downloadUrl: details.files.download,
          });
        } catch (error) {
          console.warn("[ExtHost] Failed to check Open VSX update for", `${ext.ref.publisher}.${ext.ref.name}`, error);
        }
      }

      if (pendingInstalls.length === 0) return;

      for (const request of pendingInstalls) {
        await installExtensionAndWait(request);
      }

      await restartExtensionHost();
    } finally {
      autoUpdateInFlightRef.current = false;
    }
  }, [installExtensionAndWait, restartExtensionHost]);

  // OS theme + active color theme → keep iconThemeKind in sync
  useEffect(() => {
    const colorThemeMatch = activeColorTheme ? findColorTheme(latestExtensionsRef.current, activeColorTheme) : null;
    const effectiveKind = colorThemeMatch
      ? uiThemeToKind(colorThemeMatch.theme.uiTheme)
      : systemTheme;
    getStyleHostElement().dataset.theme = effectiveKind;
    setIconThemeKindRef.current(effectiveKind);
  }, [systemTheme, activeColorTheme]);

  const ensureActiveIconThemeFssLoaded = useCallback(
    async (exts: LoadedExtension[], themeId: string | undefined): Promise<void> => {
      if (!themeId) return;
      const ext = exts.find((e) => `${e.ref.publisher}.${e.ref.name}` === themeId);
      if (!ext?.iconThemeFssPath) return;
      if (ext.iconThemeFss) return;
      try {
        ext.iconThemeFss = await readFileText(bridgeRef.current, ext.iconThemeFssPath);
        if (!ext.iconThemeBasePath) ext.iconThemeBasePath = dirname(ext.iconThemeFssPath);
      } catch {
        // Ignore; resolver will fall back
      }
    },
    [],
  );

  const applyInitialThemes = useCallback(async () => {
    const exts = latestExtensionsRef.current;
    const applyIconTheme = async (extensions: LoadedExtension[], themeId: string | undefined): Promise<void> => {
      const generation = ++iconThemeApplyGenerationRef.current;
      await ensureActiveIconThemeFssLoaded(extensions, themeId);
      if (generation !== iconThemeApplyGenerationRef.current) return;
      setExtensionFssLayers(extensions, themeId);
      if (!themeId) {
        await setIconThemeRef.current("fss");
      } else {
        const ext = extensions.find((e) => `${e.ref.publisher}.${e.ref.name}` === themeId);
        if (ext?.vscodeIconThemePath) {
          await setIconThemeRef.current("vscode", ext.vscodeIconThemePath);
        } else if (ext?.iconThemeFssPath) {
          await setIconThemeRef.current("fss");
        } else {
          await setIconThemeRef.current("none");
        }
      }
      if (generation !== iconThemeApplyGenerationRef.current) return;
      refreshPanelsRef.current();
    };
    const applyColorTheme = async (extensions: LoadedExtension[], themeKey: string | undefined): Promise<void> => {
      const generation = ++colorThemeApplyGenerationRef.current;
      if (!themeKey) {
        getStyleHostElement().dataset.theme = systemThemeRef.current;
        setIconThemeKindRef.current(systemThemeRef.current);
        clearColorTheme();
        return;
      }
      const match = findColorTheme(extensions, themeKey);
      if (!match) {
        getStyleHostElement().dataset.theme = systemThemeRef.current;
        setIconThemeKindRef.current(systemThemeRef.current);
        clearColorTheme();
        return;
      }
      const kind = uiThemeToKind(match.theme.uiTheme);
      getStyleHostElement().dataset.theme = kind;
      setIconThemeKindRef.current(kind);
      try {
        await loadAndApplyColorTheme(bridgeRef.current, match.theme.jsonPath, match.theme.uiTheme);
      } catch (err) {
        if (generation !== colorThemeApplyGenerationRef.current) return;
        console.warn("[ExtHost] Failed to load color theme:", themeKey, err);
        getStyleHostElement().dataset.theme = systemThemeRef.current;
        setIconThemeKindRef.current(systemThemeRef.current);
        clearColorTheme();
      }
    };
    await Promise.all([applyIconTheme(exts, activeIconThemeRef.current), applyColorTheme(exts, activeColorThemeRef.current)]);
    setThemesReady(true);
    themesReadyRef.current = true;
  }, [ensureActiveIconThemeFssLoaded, setExtensionFssLayers, setThemesReady]);

  // Apply icon theme when activeIconTheme changes (user-triggered, not initial load)
  useEffect(() => {
    if (!themesReady) return;
    void (async () => {
      const exts = latestExtensionsRef.current;
      const generation = ++iconThemeApplyGenerationRef.current;
      await ensureActiveIconThemeFssLoaded(exts, activeIconTheme);
      if (generation !== iconThemeApplyGenerationRef.current) return;
      setExtensionFssLayers(exts, activeIconTheme);
      if (!activeIconTheme) {
        await setIconThemeRef.current("fss");
      } else {
        const ext = exts.find((e) => `${e.ref.publisher}.${e.ref.name}` === activeIconTheme);
        if (ext?.vscodeIconThemePath) {
          await setIconThemeRef.current("vscode", ext.vscodeIconThemePath);
        } else if (ext?.iconThemeFssPath) {
          await setIconThemeRef.current("fss");
        } else {
          await setIconThemeRef.current("none");
        }
      }
      if (generation !== iconThemeApplyGenerationRef.current) return;
      refreshPanelsRef.current();
    })();
  }, [activeIconTheme, ensureActiveIconThemeFssLoaded, setExtensionFssLayers, themesReady]);

  // Apply color theme when activeColorTheme changes (user-triggered, not initial load)
  useEffect(() => {
    if (!themesReady) return;
    const generation = ++colorThemeApplyGenerationRef.current;
    if (!activeColorTheme) {
      getStyleHostElement().dataset.theme = systemTheme;
      setIconThemeKindRef.current(systemTheme);
      clearColorTheme();
    } else {
      const match = findColorTheme(latestExtensionsRef.current, activeColorTheme);
      if (match) {
        const kind = uiThemeToKind(match.theme.uiTheme);
        getStyleHostElement().dataset.theme = kind;
        setIconThemeKindRef.current(kind);
        loadAndApplyColorTheme(bridgeRef.current, match.theme.jsonPath, match.theme.uiTheme).catch(() => {
          if (generation !== colorThemeApplyGenerationRef.current) return;
          getStyleHostElement().dataset.theme = systemTheme;
          setIconThemeKindRef.current(systemTheme);
          clearColorTheme();
        });
      } else {
        getStyleHostElement().dataset.theme = systemTheme;
        setIconThemeKindRef.current(systemTheme);
        clearColorTheme();
      }
    }
  }, [activeColorTheme, systemTheme, themesReady]);

  useEffect(() => {
    if (!settingsReady) return;
    if (!extensionsLoadedRef.current) return;
    if (themesReadyRef.current) return;
    void applyInitialThemes();
  }, [applyInitialThemes, settingsReady]);

  useEffect(() => {
    if (!settingsReady) return;
    if (!extensionsAutoUpdateEnabled) return;
    if (loadedExtensions.length === 0) return;
    if (!loadedExtensions.some((ext) => ext.ref.autoUpdate ?? true)) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const schedule = (delay: number) => {
      timer = setTimeout(() => {
        if (cancelled) return;
        void runAutoUpdatePass()
          .catch((error) => {
            console.warn("[ExtHost] Automatic extension update failed:", error);
          })
          .finally(() => {
            if (!cancelled) schedule(AUTO_UPDATE_INTERVAL_MS);
          });
      }, delay);
    };

    schedule(AUTO_UPDATE_INITIAL_DELAY_MS);

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [extensionsAutoUpdateEnabled, loadedExtensions, runAutoUpdatePass, settingsReady]);

  useEffect(() => {
    return commandRegistryRef.current.registerCommand("dotdir.restartExtensionHost", restartExtensionHost);
  }, [restartExtensionHost]);

  useEffect(() => {
    languageRegistryRef.current.initialize();

    const registerLanguages = async (exts: LoadedExtension[]) => {
      languageRegistryRef.current.clear();
      for (const ext of exts) {
        if (ext.languages) {
          for (const lang of ext.languages) {
            languageRegistryRef.current.registerLanguage(lang);
          }
        }
      }
      await languageRegistryRef.current.activateGrammars();
    };

    const registerExtensionCommands = (exts: LoadedExtension[]) => {
      clearExtensionCommandRegistrations();

      for (const ext of exts) {
        if (ext.commands) {
          const disposeContributions = commandRegistryRef.current.registerContributions(ext.commands);
          extensionContributionDisposersRef.current.push(disposeContributions);
          for (const cmd of ext.commands) {
            const disposeCmd = commandRegistryRef.current.registerCommand(cmd.command, async (...args: unknown[]) => {
              const handled = await executeMountedExtensionCommand(cmd.command, args);
              if (handled) return;
              await extensionHostRef.current.executeCommand(cmd.command, args);
            });
            extensionContributionDisposersRef.current.push(disposeCmd);
          }
        }
        if (ext.keybindings?.length) {
          extensionContributionDisposersRef.current.push(...registerExtensionKeybindings(commandRegistryRef.current, ext.keybindings));
        }
      }
    };

    const unsub = extensionHostRef.current.onLoaded((exts) => {
      void (async () => {
        extensionsLoadedRef.current = true;
        latestExtensionsRef.current = exts;
        setLoadedExtensions(exts);
        populateRegistries(exts);
        clearFsProviderCache();

        // Pre-compile backend WASM providers so first navigation is fast.
        if (bridgeRef.current.fsProvider) {
          for (const ext of exts) {
            for (const p of ext.fsProviders ?? []) {
              if (p.runtime === "backend") {
                const wasmPath = join(ext.dirPath, p.entry);
                bridgeRef.current.fsProvider!.load(wasmPath).catch(() => {});
              }
            }
          }
        }

        // Resolve shell profiles from extension contributions.
        bridgeRef.current.utils
          .getEnv()
          .then((env) =>
            resolveShellProfiles(bridgeRef.current, exts, env).then(({ profiles, shellScripts }) => {
              setAvailableProfiles(profiles);
              setProfilesLoaded(true);
              if (bridgeRef.current.pty.setShellIntegrations && Object.keys(shellScripts).length > 0) {
                bridgeRef.current.pty.setShellIntegrations(shellScripts).catch(() => {});
              }
            }),
          )
          .catch(() => {
            setProfilesLoaded(true);
          });

        registerLanguages(exts);
        registerExtensionCommands(exts);
        if (!settingsReadyRef.current) return;
        await applyInitialThemes();
      })();
    });
    void extensionHostRef.current.start();

    return () => {
      unsub();
      clearExtensionCommandRegistrations();
      extensionHostRef.current.dispose();
    };
  // This lifecycle is intentionally registered once; mutable refs keep callbacks current.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
