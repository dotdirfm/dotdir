import { ErrorBoundary } from "@/components/ErrorBoundary";
import { DialogProvider } from "@/dialogs/dialogContext";
import type { Bridge } from "@/features/bridge";
import { BridgeProvider } from "@/features/bridge/useBridge";
import { CommandLineProvider } from "@/features/command-line/useCommandLine";
import { builtInCommandContributions } from "@/features/commands/builtInCommandContributions";
import { CommandRegistryProvider, useCommandRegistry } from "@/features/commands/commands";
import { FileSystemWatchRegistryProvider } from "@/features/file-system/fs";
import { PanelControllersProvider } from "@/features/panels/panelControllers";
import { UserSettingsProvider } from "@/features/settings/useUserSettings";
import { TerminalProvider } from "@/features/terminal/useTerminal";
import { UiStateProvider } from "@/features/ui-state/uiState";
import { FocusProvider } from "@/focusContext";
import { FssProvider } from "@/fss";
import { InteractionProvider } from "@/interactionContext";
import { LanguageRegistryProvider } from "@/languageRegistry";
import { Provider as JotaiProvider } from "jotai";
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { App, type AppHandle } from "./app";
import {
  defaultResolveVfsUrl,
  VfsUrlResolverProvider,
  type VfsUrlKind,
  type VfsUrlResolver,
} from "./features/file-system/vfs";
import baseStyles from "./styles/base.module.css";

export type {
  Bridge,
  ConflictResolution,
  CopyOptions,
  CopyProgressEvent,
  DeleteProgressEvent,
  ExtensionInstallProgressEvent,
  ExtensionInstallRequest,
  FsChangeEvent,
  FsChangeType,
  FsEntry,
  MoveOptions,
  MoveProgressEvent,
  PtyLaunchInfo
} from "@/features/bridge";
export { basename, dirname, join, normalizePath } from "./utils/path";
export { defaultResolveVfsUrl };
export type { AppHandle, VfsUrlKind, VfsUrlResolver };

export type DotDirProps = {
  bridge: Bridge;
  widget: React.ReactNode;
  resolveVfsUrl?: VfsUrlResolver;
};

export type DotDirHandle = {
  focus(): void;
};

function DotDirContent({ widget, appRef }: { widget: React.ReactNode; appRef: React.RefObject<AppHandle | null> }) {
  const commandRegistry = useCommandRegistry();

  useEffect(() => {
    return commandRegistry.registerContributions(builtInCommandContributions);
  }, [commandRegistry]);

  return (
    <ErrorBoundary>
      <DialogProvider>
        <UserSettingsProvider>
          <CommandLineProvider>
            <App ref={appRef} widget={widget} />
          </CommandLineProvider>
        </UserSettingsProvider>
      </DialogProvider>
    </ErrorBoundary>
  );
}

export const DotDir = forwardRef<DotDirHandle, DotDirProps>(function DotDir({ bridge, widget, resolveVfsUrl = defaultResolveVfsUrl }, ref) {
  const rootRef = useRef<HTMLDivElement>(null);
  const appRef = useRef<AppHandle>(null);

  useImperativeHandle(
    ref,
    () => ({
      focus() {
        appRef.current?.focus();
      },
    }),
    [],
  );

  return (
    <div ref={rootRef} className={baseStyles["dotdir-root"]} data-dotdir-style-host="true">
      <VfsUrlResolverProvider resolveVfsUrl={resolveVfsUrl}>
        <JotaiProvider>
          <BridgeProvider bridge={bridge}>
            <FileSystemWatchRegistryProvider>
              <CommandRegistryProvider>
                <FocusProvider>
                  <InteractionProvider>
                    <LanguageRegistryProvider>
                      <FssProvider>
                        <PanelControllersProvider>
                          <UiStateProvider>
                            <TerminalProvider>
                              <DotDirContent widget={widget} appRef={appRef} />
                            </TerminalProvider>
                          </UiStateProvider>
                        </PanelControllersProvider>
                      </FssProvider>
                    </LanguageRegistryProvider>
                  </InteractionProvider>
                </FocusProvider>
              </CommandRegistryProvider>
            </FileSystemWatchRegistryProvider>
          </BridgeProvider>
        </JotaiProvider>
      </VfsUrlResolverProvider>
    </div>
  );
});
