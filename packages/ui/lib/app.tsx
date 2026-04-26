import { panelsVisibleAtom, systemThemeAtom, themesReadyAtom } from "@/atoms";
import { CommandPalette } from "@/components/CommandPalette/CommandPalette";
import { KeyBar } from "@/components/KeyBar/KeyBar";
import { PanelGroup } from "@/components/PanelGroup/PanelGroup";
import { DialogHolder, useDialog } from "@/dialogs/dialogContext";
import { useBridge } from "@/features/bridge/useBridge";
import { CommandLine } from "@/features/command-line/CommandLine/CommandLine";
import { useCommandRegistry } from "@dotdirfm/commands";
import { useBuiltInCommands } from "@/features/commands/useBuiltInCommands";
import { useCommandRouting } from "@/features/commands/useCommandRouting";
import { useExtensionRuntime } from "@/features/extensions/useExtensionRuntime";
import { FileOperationHandlersProvider } from "@/features/file-ops/fileOperationHandlers";
import { useFileOperations } from "@/features/file-ops/useFileOperations";
import { useActivePanelNavigation } from "@/features/panels/panelControllers";
import { Terminal, TerminalToolbar } from "@/features/terminal/Terminal";
import { useSystemTheme } from "@/features/themes/useSystemTheme";
import { useFocusContext } from "@/focusContext";
import { useViewerEditorState } from "@/hooks/useViewerEditorState";
import { useWorkspacePersistenceProcess, useWorkspaceRestoreProcess } from "@/processes/workspace-session/model/useWorkspaceSessionProcess";
import baseStyles from "@/styles/base.module.css";
import panelsStyles from "@/styles/panels.module.css";
import terminalStyles from "@/styles/terminal.module.css";
import { cx } from "@/utils/cssModules";
import { useAtomValue, useSetAtom } from "jotai";
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";

export type AppHandle = {
  focus(): void;
};

const THEME_STARTUP_TIMEOUT_MS = 5_000;
const WINDOW_SHOW_TIMEOUT_MS = 5_000;

export const App = forwardRef<AppHandle, { widget: React.ReactNode }>(function App({ widget }, ref) {
  const commandRegistry = useCommandRegistry();
  const focusContext = useFocusContext();
  const rootRef = useRef<HTMLDivElement>(null);
  const panelsOverlayRef = useRef<HTMLDivElement>(null);
  useImperativeHandle(
    ref,
    () => ({
      focus() {
        focusContext.request("panel");
      },
    }),
    [focusContext],
  );
  const bridge = useBridge();
  const setTheme = useSetAtom(systemThemeAtom);
  useDialog();

  const panelsVisible = useAtomValue(panelsVisibleAtom);
  const themesReady = useAtomValue(themesReadyAtom);
  const systemTheme = useSystemTheme();
  const windowShownRef = useRef(false);
  const initialThemeRefreshDoneRef = useRef(false);
  const [themeStartupTimedOut, setThemeStartupTimedOut] = useState(false);
  const [windowShowTimedOut, setWindowShowTimedOut] = useState(false);

  const { uiStateLoaded } = useWorkspaceRestoreProcess();
  const startupReady = uiStateLoaded && (themesReady || themeStartupTimedOut);

  useEffect(() => {
    commandRegistry.setFocusLayerGetter(() => focusContext.current);
    return () => {
      commandRegistry.setFocusLayerGetter(null);
    };
  }, [commandRegistry, focusContext]);

  const { refreshAll, focusActiveFileList } = useActivePanelNavigation();
  const { handleCopy, handleMove, handleMoveToTrash, handlePermanentDelete, handleRename } = useFileOperations();
  const fileOperationHandlers = useMemo(
    () => ({
      moveToTrash: handleMoveToTrash,
      permanentDelete: handlePermanentDelete,
      copy: handleCopy,
      move: handleMove,
      rename: handleRename,
    }),
    [handleMoveToTrash, handlePermanentDelete, handleCopy, handleMove, handleRename],
  );

  const {
    handleViewFile,
    handleEditFile,
    handleOpenCreateFileConfirm,
    requestCloseViewer,
    requestCloseEditor,
    viewerOpen,
  } = useViewerEditorState();

  useWorkspacePersistenceProcess();

  useEffect(() => {
    setTheme(systemTheme);
  }, [setTheme, systemTheme]);

  useEffect(() => {
    if (themesReady) {
      setThemeStartupTimedOut(false);
      return;
    }

    const timer = setTimeout(() => {
      console.warn("[startup] Theme loading timed out after 5000ms; continuing without waiting for themes.");
      setThemeStartupTimedOut(true);
    }, THEME_STARTUP_TIMEOUT_MS);

    return () => clearTimeout(timer);
  }, [themesReady]);

  useEffect(() => {
    if (startupReady) {
      setWindowShowTimedOut(false);
      return;
    }

    const timer = setTimeout(() => {
      console.warn("[startup] Window show timed out after 5000ms; forcing window visibility.");
      setWindowShowTimedOut(true);
    }, WINDOW_SHOW_TIMEOUT_MS);

    return () => clearTimeout(timer);
  }, [startupReady]);

  useEffect(() => {
    if (windowShownRef.current) return;
    if (!startupReady && !windowShowTimedOut) return;
    if (!bridge.window?.showCurrent) return;
    windowShownRef.current = true;
    void bridge.window.showCurrent().catch(() => {
      // Ignore show failures so startup can proceed.
    });
  }, [bridge.window, startupReady, windowShowTimedOut]);

  useEffect(() => {
    if (!startupReady || !themesReady) return;
    if (initialThemeRefreshDoneRef.current) return;
    initialThemeRefreshDoneRef.current = true;
    refreshAll();
  }, [refreshAll, startupReady, themesReady]);

  useExtensionRuntime();

  useBuiltInCommands({
    onOpenCreateFileConfirm: handleOpenCreateFileConfirm,
    onViewFile: handleViewFile,
    onEditFile: handleEditFile,
    onRequestCloseViewer: requestCloseViewer,
    onRequestCloseEditor: requestCloseEditor,
    viewerOpen,
  });

  useCommandRouting(rootRef);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    return focusContext.registerAdapter("panel", {
      focus() {
        focusActiveFileList();
        const active = document.activeElement as HTMLElement | null;
        if (active && panelsOverlayRef.current?.contains(active) && active !== root) return;
        try {
          root.focus({ preventScroll: true });
        } catch {
          root.focus();
        }
      },
      contains(node) {
        return node instanceof Node ? root.contains(node) : false;
      },
    });
  }, [focusActiveFileList, focusContext]);

  useEffect(() => {
    if (bridge.onReconnect) {
      return bridge.onReconnect(() => {
        refreshAll();
      });
    }
  }, [bridge, refreshAll]);

  let body = null;

  if (!startupReady) {
    body = <div className={baseStyles["loading"]}>Loading...</div>;
  } else {
    body = (
      <>
        <div className={terminalStyles["terminal-and-panels"]}>
          <div inert={panelsVisible} className={cx(terminalStyles, "terminal-background", panelsVisible && "hidden")}>
            <Terminal />
          </div>
          <div ref={panelsOverlayRef} inert={!panelsVisible} className={cx(panelsStyles, "panels-overlay", !panelsVisible && "hidden")}>
            <div className={panelsStyles["side-by-side-panels"]}>
              <PanelGroup side="left" />
              <PanelGroup side="right" />
            </div>
            <CommandLine />
          </div>
        </div>
        <TerminalToolbar />
        <div className={baseStyles["status-bar"]}>
          <KeyBar />
          {widget}
        </div>
        <DialogHolder />
        <CommandPalette />
      </>
    );
  }

  return (
    <div ref={rootRef} className={baseStyles["app"]} tabIndex={0}>
      <FileOperationHandlersProvider handlers={fileOperationHandlers}>{body}</FileOperationHandlersProvider>
    </div>
  );
});
