import { ErrorBoundary } from "@/components/ErrorBoundary";
import { DialogProvider } from "@/dialogs/dialogContext";
import { Bridge } from "@/features/bridge";
import { BridgeProvider } from "@/features/bridge/useBridge";
import { builtInCommandContributions } from "@/features/commands/builtInCommandContributions";
import { CommandRegistryProvider, useCommandRegistry } from "@/features/commands/commands";
import { FocusProvider } from "@/focusContext";
import { PanelControllersProvider } from "@/panelControllers";
import { Provider as JotaiProvider } from "jotai";
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { App, type AppHandle } from "./app";
import { setStyleHostElement } from "./styleHost";
import baseStyles from "./styles/base.module.css";
import {
  defaultResolveVfsUrl,
  pushVfsUrlResolver,
  VfsUrlResolverContext,
  type VfsUrlKind,
  type VfsUrlResolver,
} from "./utils/vfs";

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
        <App ref={appRef} widget={widget} />
      </DialogProvider>
    </ErrorBoundary>
  );
}

export const DotDir = forwardRef<DotDirHandle, DotDirProps>(function DotDir({ bridge, widget, resolveVfsUrl = defaultResolveVfsUrl }, ref) {
  const rootRef = useRef<HTMLDivElement>(null);
  const appRef = useRef<AppHandle>(null);

  useEffect(() => pushVfsUrlResolver(resolveVfsUrl), [resolveVfsUrl]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    setStyleHostElement(root);
    return () => {
      if (rootRef.current === root) {
        setStyleHostElement(null);
      }
    };
  }, []);

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
    <div ref={rootRef} className={baseStyles["dotdir-root"]}>
      <VfsUrlResolverContext.Provider value={resolveVfsUrl}>
        <JotaiProvider>
          <BridgeProvider bridge={bridge}>
            <CommandRegistryProvider>
              <FocusProvider>
                <PanelControllersProvider>
                  <DotDirContent widget={widget} appRef={appRef} />
                </PanelControllersProvider>
              </FocusProvider>
            </CommandRegistryProvider>
          </BridgeProvider>
        </JotaiProvider>
      </VfsUrlResolverContext.Provider>
    </div>
  );
});
