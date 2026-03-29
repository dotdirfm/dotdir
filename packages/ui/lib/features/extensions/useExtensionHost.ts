import { useBridge } from "@/features/bridge/useBridge";
import { commandRegistry } from "@/features/commands/commands";
import { clearFsProviderCache } from "@/features/extensions/browserFsProvider";
import { useExtensionHostClient } from "@/features/extensions/extensionHostClient";
import { type LoadedExtension, findColorTheme } from "@/features/extensions/extensions";
import { useSetIconTheme, useSetIconThemeKind } from "@/features/file-icons/iconResolver";
import { readFileText } from "@/fs";
import { setExtensionLayers } from "@/fss";
import { languageRegistry } from "@/languageRegistry";
import { registerExtensionKeybindings } from "@/registerKeybindings";
import { resolveShellProfiles } from "@/terminal/shellProfiles";
import { dirname, join } from "@/utils/path";
import { populateRegistries } from "@/viewerEditorRegistry";
import { useAtomValue, useSetAtom } from "jotai";
import { useCallback, useEffect, useRef } from "react";
import {
  activeColorThemeAtom,
  activeIconThemeAtom,
  loadedExtensionsAtom,
  osThemeAtom,
  resolvedProfilesAtom,
  terminalProfilesLoadedAtom,
  themesReadyAtom,
} from "../../atoms";
import {
  clearColorTheme,
  loadAndApplyColorTheme,
  uiThemeToKind,
} from "../../vscodeColorTheme";

interface UseExtensionHostOptions {
  settingsLoaded: boolean;
  onRefreshPanels: () => void;
}

export function useExtensionHost({
  settingsLoaded,
  onRefreshPanels,
}: UseExtensionHostOptions): void {
  const bridge = useBridge();
  const extensionHost = useExtensionHostClient();
  const activeIconTheme = useAtomValue(activeIconThemeAtom);
  const activeColorTheme = useAtomValue(activeColorThemeAtom);
  const osTheme = useAtomValue(osThemeAtom);
  const setLoadedExtensions = useSetAtom(loadedExtensionsAtom);
  const setThemesReady = useSetAtom(themesReadyAtom);
  const setResolvedProfiles = useSetAtom(resolvedProfilesAtom);
  const setTerminalProfilesLoaded = useSetAtom(terminalProfilesLoadedAtom);
  const { setIconTheme } = useSetIconTheme();
  const { setIconThemeKind } = useSetIconThemeKind();

  // Refs so async callbacks always see the latest atom values without re-subscribing
  const activeIconThemeRef = useRef(activeIconTheme);
  activeIconThemeRef.current = activeIconTheme;
  const activeColorThemeRef = useRef(activeColorTheme);
  activeColorThemeRef.current = activeColorTheme;
  const onNavigatePanelsRef = useRef(onRefreshPanels);
  onNavigatePanelsRef.current = onRefreshPanels;

  // Internal refs — never exposed outside this hook
  const latestExtensionsRef = useRef<LoadedExtension[]>([]);
  const extensionContributionDisposersRef = useRef<(() => void)[]>([]);
  const themesReadyRef = useRef(false);

  // OS theme + active color theme → keep iconThemeKind in sync
  useEffect(() => {
    const colorThemeMatch = activeColorTheme
      ? findColorTheme(latestExtensionsRef.current, activeColorTheme)
      : null;
    const effectiveKind = colorThemeMatch
      ? uiThemeToKind(colorThemeMatch.theme.uiTheme)
      : osTheme === "light" || osTheme === "high-contrast-light"
        ? "light"
        : "dark";
    document.documentElement.dataset.theme = effectiveKind;
    setIconThemeKind(effectiveKind);
  }, [osTheme, activeColorTheme]);

  const ensureActiveIconThemeFssLoaded = useCallback(
    async (
      exts: LoadedExtension[],
      themeId: string | undefined,
    ): Promise<void> => {
      if (!themeId) return;
      const ext = exts.find(
        (e) => `${e.ref.publisher}.${e.ref.name}` === themeId,
      );
      if (!ext?.iconThemeFssPath) return;
      if (ext.iconThemeFss) return;
      try {
        ext.iconThemeFss = await readFileText(bridge, ext.iconThemeFssPath);
        if (!ext.iconThemeBasePath)
          ext.iconThemeBasePath = dirname(ext.iconThemeFssPath);
      } catch {
        // Ignore; resolver will fall back
      }
    },
    [bridge],
  );

  // Apply icon theme when activeIconTheme changes (user-triggered, not initial load)
  useEffect(() => {
    if (!themesReadyRef.current) return;
    void (async () => {
      const exts = latestExtensionsRef.current;
      await ensureActiveIconThemeFssLoaded(exts, activeIconTheme);
      setExtensionLayers(exts, activeIconTheme);
      if (!activeIconTheme) {
        setIconTheme("fss");
      } else {
        const ext = exts.find(
          (e) => `${e.ref.publisher}.${e.ref.name}` === activeIconTheme,
        );
        if (ext?.vscodeIconThemePath) {
          setIconTheme("vscode", ext.vscodeIconThemePath);
        } else if (ext?.iconThemeFssPath) {
          setIconTheme("fss");
        } else {
          setIconTheme("none");
        }
      }
      onNavigatePanelsRef.current();
    })();
  }, [activeIconTheme, ensureActiveIconThemeFssLoaded]);

  // Apply color theme when activeColorTheme changes (user-triggered, not initial load)
  useEffect(() => {
    if (!themesReadyRef.current) return;
    if (!activeColorTheme) {
      clearColorTheme();
    } else {
      const match = findColorTheme(
        latestExtensionsRef.current,
        activeColorTheme,
      );
      if (match) {
        loadAndApplyColorTheme(
          bridge,
          match.theme.jsonPath,
          match.theme.uiTheme,
        ).catch(() => clearColorTheme());
      }
    }
  }, [activeColorTheme]);

  // Extension host lifecycle — gated on settings being loaded
  useEffect(() => {
    if (!settingsLoaded) return;
    languageRegistry.initialize();

    const registerLanguages = async (exts: LoadedExtension[]) => {
      languageRegistry.clear();
      for (const ext of exts) {
        if (ext.languages) {
          for (const lang of ext.languages) {
            languageRegistry.registerLanguage(lang);
          }
        }
      }
      await languageRegistry.activateGrammars();
    };

    const updateIconTheme = async (
      exts: LoadedExtension[],
      themeId: string | undefined,
    ): Promise<void> => {
      if (!themeId) {
        await setIconTheme("fss");
        return;
      }
      const ext = exts.find(
        (e) => `${e.ref.publisher}.${e.ref.name}` === themeId,
      );
      if (ext?.vscodeIconThemePath) {
        await setIconTheme("vscode", ext.vscodeIconThemePath);
      } else if (ext?.iconThemeFssPath) {
        await setIconTheme("fss");
      } else {
        await setIconTheme("none");
      }
    };

    const updateColorTheme = async (
      exts: LoadedExtension[],
      themeKey: string | undefined,
    ): Promise<void> => {
      if (!themeKey) {
        clearColorTheme();
        return;
      }
      const match = findColorTheme(exts, themeKey);
      if (match) {
        const kind = uiThemeToKind(match.theme.uiTheme);
        document.documentElement.dataset.theme = kind;
        setIconThemeKind(kind);
        try {
          await loadAndApplyColorTheme(
            bridge,
            match.theme.jsonPath,
            match.theme.uiTheme,
          );
        } catch (err) {
          console.warn("[ExtHost] Failed to load color theme:", themeKey, err);
          clearColorTheme();
        }
      } else {
        clearColorTheme();
      }
    };

    const registerExtensionCommands = (exts: LoadedExtension[]) => {
      for (const d of extensionContributionDisposersRef.current) {
        try {
          d();
        } catch {
          /* ignore */
        }
      }
      extensionContributionDisposersRef.current = [];

      for (const ext of exts) {
        if (ext.commands) {
          const disposeContributions = commandRegistry.registerContributions(
            ext.commands,
          );
          extensionContributionDisposersRef.current.push(disposeContributions);
          for (const cmd of ext.commands) {
            const disposeCmd = commandRegistry.registerCommand(
              cmd.command,
              async (...args: unknown[]) => {
                await extensionHost.executeCommand(cmd.command, args);
              },
            );
            extensionContributionDisposersRef.current.push(disposeCmd);
          }
        }
        if (ext.keybindings?.length) {
          extensionContributionDisposersRef.current.push(
            ...registerExtensionKeybindings(commandRegistry, ext.keybindings),
          );
        }
      }
    };

    const unsub = extensionHost.onLoaded((exts) => {
      void (async () => {
        latestExtensionsRef.current = exts;
        setLoadedExtensions(exts);
        populateRegistries(exts);
        clearFsProviderCache();

        // Pre-compile backend WASM providers so first navigation is fast.
        if (bridge.fsProvider) {
          for (const ext of exts) {
            for (const p of ext.fsProviders ?? []) {
              if (p.runtime === "backend") {
                const wasmPath = join(ext.dirPath, p.entry);
                bridge.fsProvider!.load(wasmPath).catch(() => {});
              }
            }
          }
        }

        // Resolve shell profiles from extension contributions.
        bridge.utils
          .getEnv()
          .then((env) =>
            resolveShellProfiles(bridge, exts, env).then(
              ({ profiles, shellScripts }) => {
                setResolvedProfiles(profiles);
                setTerminalProfilesLoaded(true);
                if (
                  bridge.pty.setShellIntegrations &&
                  Object.keys(shellScripts).length > 0
                ) {
                  bridge.pty.setShellIntegrations(shellScripts).catch(() => {});
                }
              },
            ),
          )
          .catch(() => {
            setTerminalProfilesLoaded(true);
          });

        await ensureActiveIconThemeFssLoaded(exts, activeIconThemeRef.current);
        setExtensionLayers(exts, activeIconThemeRef.current);

        registerLanguages(exts);
        registerExtensionCommands(exts);

        Promise.all([
          updateIconTheme(exts, activeIconThemeRef.current),
          updateColorTheme(exts, activeColorThemeRef.current),
        ]).then(() => {
          setThemesReady(true);
          themesReadyRef.current = true;
          onNavigatePanelsRef.current();
        });
      })();
    });
    extensionHost.start();

    return () => {
      unsub();
      for (const d of extensionContributionDisposersRef.current) {
        try {
          d();
        } catch {
          /* ignore */
        }
      }
      extensionContributionDisposersRef.current = [];
      extensionHost.dispose();
    };
  }, [
    settingsLoaded,
    ensureActiveIconThemeFssLoaded,
    setLoadedExtensions,
    setResolvedProfiles,
    setTerminalProfilesLoaded,
    setThemesReady,
  ]);
}
