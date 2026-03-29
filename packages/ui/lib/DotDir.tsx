import { ErrorBoundary } from "@/components/ErrorBoundary";
import { DialogProvider } from "@/dialogs/dialogContext";
import { Bridge } from "@/features/bridge";
import { BridgeProvider } from "@/features/bridge/useBridge";
import { builtInCommandContributions } from "@/features/commands/builtInCommandContributions";
import { commandRegistry } from "@/features/commands/commands";
import { Provider as JotaiProvider } from "jotai";
import { useEffect, useRef } from "react";
import { App } from "./app";
import baseStyles from "./styles/base.module.css";
import { setStyleHostElement } from "./styleHost";
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
  FsChangeEvent,
  FsChangeType,
  FspEntry,
  FsRawEntry,
  MoveOptions,
  MoveProgressEvent,
  PtyLaunchInfo
} from "@/features/bridge";
export { basename, dirname, join, normalizePath } from "./utils/path";
export { defaultResolveVfsUrl };
export type { VfsUrlKind, VfsUrlResolver };

export type DotDirProps = {
  bridge: Bridge;
  widget: React.ReactNode;
  resolveVfsUrl?: VfsUrlResolver;
};

export function DotDir({ bridge, widget, resolveVfsUrl = defaultResolveVfsUrl }: DotDirProps) {
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    commandRegistry.registerContributions(builtInCommandContributions);
  }, []);

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

  return (
    <div ref={rootRef} className={baseStyles["dotdir-root"]}>
      <VfsUrlResolverContext.Provider value={resolveVfsUrl}>
        <JotaiProvider>
          <BridgeProvider bridge={bridge}>
            <ErrorBoundary>
              <DialogProvider>
                <App widget={widget} />
              </DialogProvider>
            </ErrorBoundary>
          </BridgeProvider>
        </JotaiProvider>
      </VfsUrlResolverContext.Provider>
    </div>
  );
}
