import { ErrorBoundary } from "@/components/ErrorBoundary";
import { DialogProvider } from "@/dialogs/dialogContext";
import type { Bridge } from "@/features/bridge";
import { BridgeProvider, useBridge } from "@/features/bridge/useBridge";
import { CommandLineProvider } from "@/features/command-line/useCommandLine";
import { builtInCommandContributions } from "@/features/commands/builtInCommandContributions";
import { useCommandRegistry } from "@/features/commands/commands";
import { ExtensionHostClientProvider } from "@/features/extensions/extensionHostClient";
import { ExtensionHostWorkspaceSync } from "@/features/extensions/extensionHostWorkspaceSync";
import { FssProvider } from "@/features/fss/fss";
import { PanelControllersProvider } from "@/features/panels/panelControllers";
import { UserSettingsProvider } from "@/features/settings/useUserSettings";
import { TerminalProvider } from "@/features/terminal/useTerminal";
import { UiStateProvider } from "@/features/ui-state/uiState";
import { Provider as JotaiProvider } from "jotai";
import { forwardRef, Suspense, useEffect, useImperativeHandle, useRef } from "react";
import { App, type AppHandle } from "./app";
import { AppServicesProvider } from "./appServices";
import { defaultResolveVfsUrl, VfsUrlResolverProvider, type VfsUrlKind, type VfsUrlResolver } from "./features/file-system/vfs";
import baseStyles from "./styles/base.module.css";

export type {
    Bridge,
    ConflictResolution,
    CopyOptions,
    CopyProgressEvent,
    CreateWindowOptions,
    DeleteProgressEvent,
    ExtensionInstallProgressEvent,
    ExtensionInstallRequest,
    FileSearchMatch,
    FileSearchProgressEvent,
    FileSearchRequest,
    FsChangeEvent,
    FsChangeType,
    FsEntry,
    MoveOptions,
    MoveProgressEvent,
    PtyLaunchInfo
} from "@/features/bridge";
export { extensionIframeBootstrapSource } from "./features/extensions/iframeBootstrap";
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
  const bridge = useBridge();

  useEffect(() => {
    return commandRegistry.registerContributions(builtInCommandContributions);
  }, [commandRegistry]);

  useEffect(() => {
    commandRegistry.setContext("supportsWindowManagement", Boolean(bridge.window));
    return () => {
      commandRegistry.setContext("supportsWindowManagement", false);
    };
  }, [bridge.window, commandRegistry]);

  return (
    <ErrorBoundary>
      <Suspense fallback={<div className={baseStyles["loading"]}>Loading...</div>}>
        <DialogProvider>
          <UserSettingsProvider>
            <UiStateProvider>
              <TerminalProvider>
                <CommandLineProvider>
                  <App ref={appRef} widget={widget} />
                </CommandLineProvider>
              </TerminalProvider>
            </UiStateProvider>
          </UserSettingsProvider>
        </DialogProvider>
      </Suspense>
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
            <AppServicesProvider>
              <FssProvider>
                <ExtensionHostClientProvider>
                  <PanelControllersProvider>
                    <ExtensionHostWorkspaceSync />
                    <DotDirContent widget={widget} appRef={appRef} />
                  </PanelControllersProvider>
                </ExtensionHostClientProvider>
              </FssProvider>
            </AppServicesProvider>
          </BridgeProvider>
        </JotaiProvider>
      </VfsUrlResolverProvider>
    </div>
  );
});
