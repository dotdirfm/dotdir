import type { TerminalProfile } from "@dotdirfm/ui-bridge";
import { useBridge } from "@dotdirfm/ui-bridge";
import { useCommandRegistry } from "@dotdirfm/commands";
import { registerExtensionKeybindings } from "@/features/commands/registerKeybindings";
import { clearFsProviderCache } from "@/features/extensions/browserFsProvider";
import { executeMountedExtensionCommand } from "@/features/extensions/extensionCommandHandlers";
import { useExtensionHostClient } from "@/features/extensions/extensionHostClient";
import {
  extensionCommands,
  extensionDirPath,
  extensionFsProviders,
  extensionKeybindings,
  type LoadedExtension,
} from "@/features/extensions/types";
import { resolveShellProfiles } from "@/features/terminal/shellProfiles";
import { join } from "@dotdirfm/ui-utils";
import { useViewerEditorRegistry } from "@/viewerEditorRegistry";
import { useEffect, type RefObject } from "react";

type LifecycleRuntimeParams = {
  extensionsLoadedRef: RefObject<boolean>;
  extensionContributionDisposersRef: RefObject<Array<() => void>>;
  clearExtensionCommandRegistrations: () => void;
  setLoadedExtensions: React.Dispatch<React.SetStateAction<LoadedExtension[]>>;
  setAvailableProfiles: (profiles: TerminalProfile[]) => void;
  setProfilesLoaded: (loaded: boolean) => void;
  applyInitialThemes: () => Promise<void>;
};

export function useExtensionLifecycleRuntime({
  extensionsLoadedRef,
  extensionContributionDisposersRef,
  clearExtensionCommandRegistrations,
  setLoadedExtensions,
  setAvailableProfiles,
  setProfilesLoaded,
  applyInitialThemes,
}: LifecycleRuntimeParams) {
  const bridge = useBridge();
  const extensionHost = useExtensionHostClient();
  const commandRegistry = useCommandRegistry();
  const viewerEditorRegistry = useViewerEditorRegistry();

  useEffect(() => {
    const registerExtensionCommands = (exts: LoadedExtension[]) => {
      clearExtensionCommandRegistrations();
      for (const ext of exts) {
        const commands = extensionCommands(ext);
        if (commands.length > 0) {
          const disposeContributions = commandRegistry.registerContributions(commands);
          extensionContributionDisposersRef.current.push(disposeContributions);
          for (const cmd of commands) {
            const disposeCommand = commandRegistry.registerCommand(cmd.command, async (...args: unknown[]) => {
              const handled = await executeMountedExtensionCommand(cmd.command, args);
              if (handled) return;
              await extensionHost.executeCommand(cmd.command, args);
            });
            extensionContributionDisposersRef.current.push(disposeCommand);
          }
        }
        const keybindings = extensionKeybindings(ext);
        if (keybindings.length > 0) {
          extensionContributionDisposersRef.current.push(...registerExtensionKeybindings(commandRegistry, keybindings));
        }
      }
    };

    const unsubscribe = extensionHost.onLoaded((exts) => {
      void (async () => {
        extensionsLoadedRef.current = true;
        setLoadedExtensions(exts);
        viewerEditorRegistry.replaceExtensions(exts);
        clearFsProviderCache();

        if (bridge.fsProvider) {
          for (const ext of exts) {
            for (const provider of extensionFsProviders(ext)) {
              if (provider.runtime !== "backend") continue;
              const wasmPath = join(extensionDirPath(ext), provider.entry);
              bridge.fsProvider.load(wasmPath).catch(() => {});
            }
          }
        }

        bridge.utils
          .getEnv()
          .then((env) =>
            resolveShellProfiles(bridge, exts, env).then(({ profiles, shellScripts }) => {
              setAvailableProfiles(profiles);
              setProfilesLoaded(true);
              if (bridge.pty.setShellIntegrations && Object.keys(shellScripts).length > 0) {
                bridge.pty.setShellIntegrations(shellScripts).catch(() => {});
              }
            }),
          )
          .catch(() => setProfilesLoaded(true));

        registerExtensionCommands(exts);
        await applyInitialThemes();
      })();
    });
    void extensionHost.start();

    return () => {
      unsubscribe();
      clearExtensionCommandRegistrations();
      extensionHost.dispose();
    };
    // Registered once; mutable refs keep callbacks current.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
