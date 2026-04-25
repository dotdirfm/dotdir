import { ErrorBoundary } from "@/components/ErrorBoundary";
import { DialogProvider } from "@/dialogs/dialogContext";
import type { Bridge, BridgeFactory } from "@/features/bridge";
import { BridgeFactoryProvider, BridgeProvider, useBridge } from "@/features/bridge/useBridge";
import { builtInCommandContributions } from "@/features/commands/builtInCommandContributions";
import { useCommandRegistry } from "@/features/commands/commands";
import { ExtensionHostClientProvider } from "@/features/extensions/extensionHostClient";
import { ExtensionHostWorkspaceSync } from "@/features/extensions/extensionHostWorkspaceSync";
import { FssProvider } from "@/features/fss/fss";
import { PanelControllersProvider } from "@/features/panels/panelControllers";
import { UserSettingsProvider } from "@/features/settings/useUserSettings";
import { Provider as JotaiProvider } from "jotai";
import { forwardRef, Suspense, useEffect, useImperativeHandle, useRef, useState } from "react";
import { App, type AppHandle } from "./app";
import { AppRuntimeProvider } from "./appRuntime";
import { AppServicesProvider } from "./appServices";
import { defaultResolveVfsUrl, VfsUrlResolverProvider, type VfsUrlKind, type VfsUrlResolver } from "./features/file-system/vfs";
import baseStyles from "./styles/base.module.css";

export type {
  Bridge,
  BridgeFactory,
  BridgeFactoryOptions,
  BridgePurpose,
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
  bridgeFactory: BridgeFactory;
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

function DotDirBridgeRoot({
  bridgeFactory,
  children,
}: {
  bridgeFactory: BridgeFactory;
  children: React.ReactNode;
}) {
  const [bridge, setBridge] = useState<Bridge | null>(null);

  useEffect(() => {
    let cancelled = false;
    setBridge(null);
    void Promise.resolve(bridgeFactory({ purpose: "ui" })).then((nextBridge) => {
      if (!cancelled) setBridge(nextBridge);
    });
    return () => {
      cancelled = true;
    };
  }, [bridgeFactory]);

  if (!bridge) {
    return <div className={baseStyles["loading"]}>Loading...</div>;
  }

  return <BridgeProvider bridge={bridge}>{children}</BridgeProvider>;
}

export const DotDir = forwardRef<DotDirHandle, DotDirProps>(function DotDir({ bridgeFactory, widget, resolveVfsUrl = defaultResolveVfsUrl }, ref) {
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
          <BridgeFactoryProvider bridgeFactory={bridgeFactory}>
            <DotDirBridgeRoot bridgeFactory={bridgeFactory}>
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
            </DotDirBridgeRoot>
          </BridgeFactoryProvider>
        </JotaiProvider>
      </VfsUrlResolverProvider>
    </div>
  );
});
