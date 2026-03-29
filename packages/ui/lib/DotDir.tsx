import { Provider as JotaiProvider } from "jotai";
import { useEffect } from "react";
import { App } from "./app";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { DialogProvider } from "./dialogs/dialogContext";
import { builtInCommandContributions } from "./features/commands/builtInCommandContributions";
import { commandRegistry } from "./features/commands/commands";
import { BridgeProvider } from "./hooks/useBridge";
import "./index.css";
import { Bridge } from "./shared/api/bridge";

export { basename, dirname, join, normalizePath } from "./path";
export type {
  Bridge,
  ConflictResolution,
  CopyOptions,
  CopyProgressEvent,
  DeleteProgressEvent,
  FspEntry,
  MoveOptions,
  MoveProgressEvent,
  PtyLaunchInfo
} from "./shared/api/bridge";
export type { FsChangeEvent, FsChangeType, FsRawEntry } from "./types";

export function DotDir({
  bridge,
  widget,
}: {
  bridge: Bridge;
  widget: React.ReactNode;
}) {
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
