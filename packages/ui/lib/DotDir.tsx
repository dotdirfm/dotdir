import { ErrorBoundary } from "@/components/ErrorBoundary";
import { DialogProvider } from "@/dialogs/dialogContext";
import { Bridge } from "@/features/bridge";
import { BridgeProvider } from "@/features/bridge/useBridge";
import { builtInCommandContributions } from "@/features/commands/builtInCommandContributions";
import { commandRegistry } from "@/features/commands/commands";
import { Provider as JotaiProvider } from "jotai";
import { useEffect } from "react";
import { App } from "./app";

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

export type DotDirProps = {
  bridge: Bridge;
  widget: React.ReactNode;
};

export function DotDir({ bridge, widget }: DotDirProps) {
  useEffect(() => {
    commandRegistry.registerContributions(builtInCommandContributions);
  }, []);

  return (
    <JotaiProvider>
      <BridgeProvider bridge={bridge}>
        <ErrorBoundary>
          <DialogProvider>
            <App widget={widget} />
          </DialogProvider>
        </ErrorBoundary>
      </BridgeProvider>
    </JotaiProvider>
  );
}
