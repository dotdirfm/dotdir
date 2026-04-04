import { ErrorBoundary } from "@/components/ErrorBoundary";
import { DialogProvider } from "@/dialogs/dialogContext";
import type { Bridge } from "@/features/bridge";
import { BridgeProvider } from "@/features/bridge/useBridge";
import { CommandLineProvider } from "@/features/command-line/useCommandLine";
import { builtInCommandContributions } from "@/features/commands/builtInCommandContributions";
import { CommandRegistryProvider, useCommandRegistry } from "@/features/commands/commands";
import { FileSystemWatchRegistryProvider } from "@/features/file-system/fs";
import { TerminalProvider } from "@/features/terminal/useTerminal";
import { FocusProvider } from "@/focusContext";
import { InteractionProvider } from "@/interactionContext";
import { FssProvider } from "@/fss";
import { LanguageRegistryProvider } from "@/languageRegistry";
import { PanelControllersProvider } from "@/panelControllers";
import { themesReadyAtom } from "@/atoms";
import { getStyleHostElement } from "@/styleHost";
import { Provider as JotaiProvider } from "jotai";
import { useAtomValue } from "jotai";
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

export type DotDirTheme = {
  kind: "light" | "dark";
  colors: {
    background: string;
    backgroundSecondary: string;
    foreground: string;
    foregroundSecondary: string;
    border: string;
    borderActive: string;
    accent: string;
    accentForeground: string;
  };
};

export type DotDirProps = {
  bridge: Bridge;
  widget: React.ReactNode;
  resolveVfsUrl?: VfsUrlResolver;
  onThemeChange?: (theme: DotDirTheme) => void;
};

export type DotDirHandle = {
  focus(): void;
};

function readThemeSnapshot(): DotDirTheme {
  const host = getStyleHostElement();
  const style = getComputedStyle(host);
  const kind = host.dataset.theme === "light" ? "light" : "dark";
  return {
    kind,
    colors: {
      background: style.getPropertyValue("--bg").trim(),
      backgroundSecondary: style.getPropertyValue("--bg-secondary").trim(),
      foreground: style.getPropertyValue("--fg").trim(),
      foregroundSecondary: style.getPropertyValue("--fg-secondary").trim(),
      border: style.getPropertyValue("--border").trim(),
      borderActive: style.getPropertyValue("--border-active").trim(),
      accent: style.getPropertyValue("--accent").trim(),
      accentForeground: style.getPropertyValue("--accent-fg").trim(),
    },
  };
}

function ThemeObserver({ onThemeChange }: { onThemeChange?: (theme: DotDirTheme) => void }) {
  const themesReady = useAtomValue(themesReadyAtom);

  useEffect(() => {
    if (!onThemeChange || !themesReady) return;

    const host = getStyleHostElement();
    let frame = 0;
    let previousKey = "";

    const emit = () => {
      const snapshot = readThemeSnapshot();
      const nextKey = JSON.stringify(snapshot);
      if (nextKey === previousKey) return;
      previousKey = nextKey;
      onThemeChange(snapshot);
    };

    const scheduleEmit = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        frame = 0;
        emit();
      });
    };

    emit();

    const observer = new MutationObserver(() => {
      scheduleEmit();
    });
    observer.observe(host, {
      attributes: true,
      attributeFilter: ["data-theme", "style"],
    });

    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [onThemeChange, themesReady]);

  return null;
}

function DotDirContent({
  widget,
  appRef,
  onThemeChange,
}: {
  widget: React.ReactNode;
  appRef: React.RefObject<AppHandle | null>;
  onThemeChange?: (theme: DotDirTheme) => void;
}) {
  const commandRegistry = useCommandRegistry();

  useEffect(() => {
    return commandRegistry.registerContributions(builtInCommandContributions);
  }, [commandRegistry]);

  return (
    <ErrorBoundary>
      <DialogProvider>
        <CommandLineProvider>
          <ThemeObserver onThemeChange={onThemeChange} />
          <App ref={appRef} widget={widget} />
        </CommandLineProvider>
      </DialogProvider>
    </ErrorBoundary>
  );
}

export const DotDir = forwardRef<DotDirHandle, DotDirProps>(function DotDir(
  { bridge, widget, resolveVfsUrl = defaultResolveVfsUrl, onThemeChange },
  ref,
) {
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
                          <TerminalProvider>
                            <DotDirContent widget={widget} appRef={appRef} onThemeChange={onThemeChange} />
                          </TerminalProvider>
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
