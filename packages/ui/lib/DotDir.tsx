import { ErrorBoundary } from "@/components/ErrorBoundary";
import { DialogProvider } from "@/dialogs/dialogContext";
import type { Bridge } from "@dotdirfm/ui-bridge";
import { BridgeProvider, useBridge } from "@dotdirfm/ui-bridge";
import { builtInCommandContributions } from "@/features/commands/builtInCommandContributions";
import { useCommandRegistry } from "@dotdirfm/commands";
import { ExtensionHostClientProvider } from "@/features/extensions/extensionHostClient";
import { ExtensionHostWorkspaceSync } from "@/features/extensions/extensionHostWorkspaceSync";
import { FssProvider } from "@/features/fss/fss";
import { PanelControllersProvider } from "@/features/panels/panelControllers";
import { UserSettingsProvider } from "@/features/settings/useUserSettings";
import { Provider as JotaiProvider } from "jotai";
import { forwardRef, Suspense, useEffect, useImperativeHandle, useRef } from "react";
import { App, type AppHandle } from "./app";
import { AppRuntimeProvider } from "./appRuntime";
import { AppServicesProvider } from "./appServices";
import { ComposeProviders } from "@dotdirfm/ui-utils";
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
} from "@dotdirfm/ui-bridge";
export { extensionIframeBootstrapSource } from "./features/extensions/iframeBootstrap";
export { basename, dirname, join, normalizePath } from "@dotdirfm/ui-utils";
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
            <AppRuntimeProvider>
              <App ref={appRef} widget={widget} />
            </AppRuntimeProvider>
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
      <ComposeProviders
        providers={[
          [VfsUrlResolverProvider, { resolveVfsUrl }],
          [JotaiProvider],
          [BridgeProvider, { bridge }],
          [AppServicesProvider],
          [FssProvider],
          [ExtensionHostClientProvider],
          [PanelControllersProvider],
        ]}
      >
        <ExtensionHostWorkspaceSync />
        <DotDirContent widget={widget} appRef={appRef} />
      </ComposeProviders>
    </div>
  );
});
