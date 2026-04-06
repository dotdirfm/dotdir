import type { Bridge, TerminalProfile } from "@/features/bridge";
import { type CommandRegistry } from "@/features/commands/commands";
import { registerExtensionKeybindings } from "@/features/commands/registerKeybindings";
import { clearFsProviderCache } from "@/features/extensions/browserFsProvider";
import { executeMountedExtensionCommand } from "@/features/extensions/extensionCommandHandlers";
import { type ExtensionHostClient } from "@/features/extensions/extensionHostClient";
import {
  extensionCommands,
  extensionDirPath,
  extensionFsProviders,
  extensionKeybindings,
  extensionLanguages,
  type LoadedExtension,
} from "@/features/extensions/types";
import type { LanguageRegistry } from "@/features/languages/languageRegistry";
import { resolveShellProfiles } from "@/features/terminal/shellProfiles";
import { join } from "@/utils/path";
import { type ViewerEditorRegistryManager } from "@/viewerEditorRegistry";
import { type RefObject, useEffect } from "react";

type LifecycleRuntimeParams = {
  bridgeRef: RefObject<Bridge>;
  extensionHostRef: RefObject<ExtensionHostClient>;
  commandRegistryRef: RefObject<CommandRegistry>;
  viewerEditorRegistryRef: RefObject<ViewerEditorRegistryManager>;
  languageRegistryRef: RefObject<LanguageRegistry>;
  latestExtensionsRef: RefObject<LoadedExtension[]>;
  extensionsLoadedRef: RefObject<boolean>;
  settingsReadyRef: RefObject<boolean>;
  extensionContributionDisposersRef: RefObject<Array<() => void>>;
  clearExtensionCommandRegistrations: () => void;
  setLoadedExtensions: React.Dispatch<React.SetStateAction<LoadedExtension[]>>;
  setAvailableProfiles: (profiles: TerminalProfile[]) => void;
  setProfilesLoaded: (loaded: boolean) => void;
  applyInitialThemes: () => Promise<void>;
};

export function useExtensionLifecycleRuntime({
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
}: LifecycleRuntimeParams) {
  useEffect(() => {
    languageRegistryRef.current.initialize();

    const registerLanguages = async (exts: LoadedExtension[]) => {
      languageRegistryRef.current.clear();
      for (const ext of exts) {
        for (const lang of extensionLanguages(ext)) {
          languageRegistryRef.current.registerLanguage(lang);
        }
      }
      await languageRegistryRef.current.activateGrammars();
    };

    const registerExtensionCommands = (exts: LoadedExtension[]) => {
      clearExtensionCommandRegistrations();
      for (const ext of exts) {
        const commands = extensionCommands(ext);
        if (commands.length > 0) {
          const disposeContributions = commandRegistryRef.current.registerContributions(commands);
          extensionContributionDisposersRef.current.push(disposeContributions);
          for (const cmd of commands) {
            const disposeCommand = commandRegistryRef.current.registerCommand(cmd.command, async (...args: unknown[]) => {
              const handled = await executeMountedExtensionCommand(cmd.command, args);
              if (handled) return;
              await extensionHostRef.current.executeCommand(cmd.command, args);
            });
            extensionContributionDisposersRef.current.push(disposeCommand);
          }
        }
        const keybindings = extensionKeybindings(ext);
        if (keybindings.length > 0) {
          extensionContributionDisposersRef.current.push(...registerExtensionKeybindings(commandRegistryRef.current, keybindings));
        }
      }
    };

    const unsubscribe = extensionHostRef.current.onLoaded((exts) => {
      void (async () => {
        extensionsLoadedRef.current = true;
        latestExtensionsRef.current = exts;
        setLoadedExtensions(exts);
        viewerEditorRegistryRef.current.replaceExtensions(exts);
        clearFsProviderCache();

        if (bridgeRef.current.fsProvider) {
          for (const ext of exts) {
            for (const provider of extensionFsProviders(ext)) {
              if (provider.runtime !== "backend") continue;
              const wasmPath = join(extensionDirPath(ext), provider.entry);
              bridgeRef.current.fsProvider.load(wasmPath).catch(() => {});
            }
          }
        }

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
      unsubscribe();
      clearExtensionCommandRegistrations();
      extensionHostRef.current.dispose();
    };
    // Registered once; mutable refs keep callbacks current.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
