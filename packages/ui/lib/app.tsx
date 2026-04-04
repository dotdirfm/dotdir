import { panelsVisibleAtom, showExtensionsAtom, systemThemeAtom, themesReadyAtom } from "@/atoms";
import { CommandPalette } from "@/components/CommandPalette/CommandPalette";
import { KeyBar } from "@/components/KeyBar/KeyBar";
import { PanelGroup } from "@/components/PanelGroup/PanelGroup";
import { DialogHolder, useDialog } from "@/dialogs/dialogContext";
import { useBridge } from "@/features/bridge/useBridge";
import { CommandLine } from "@/features/command-line/CommandLine/CommandLine";
import { useCommandRegistry } from "@/features/commands/commands";
import { useBuiltInCommands } from "@/features/commands/useBuiltInCommands";
import { useCommandRouting } from "@/features/commands/useCommandRouting";
import { ExtensionsPanel } from "@/features/extensions/ExtensionsPanel/ExtensionsPanel";
import { useExtensionHost } from "@/features/extensions/useExtensionHost";
import { FileOperationHandlersProvider } from "@/features/file-ops/model/fileOperationHandlers";
import { useFileOperations } from "@/features/file-ops/model/useFileOperations";
import { useActivePanelNavigation } from "@/features/panels/panelControllers";
import { Terminal, TerminalToolbar } from "@/features/terminal/Terminal";
import { useSystemTheme } from "@/features/themes/useSystemTheme";
import { useFocusContext } from "@/focusContext";
import { useInteractionCommands } from "@/hooks/useInteractionCommands";
import { useViewerEditorState } from "@/hooks/useViewerEditorState";
import { useWorkspacePersistenceProcess, useWorkspaceRestoreProcess } from "@/processes/workspace-session/model/useWorkspaceSessionProcess";
import baseStyles from "@/styles/base.module.css";
import panelsStyles from "@/styles/panels.module.css";
import terminalStyles from "@/styles/terminal.module.css";
import { cx } from "@/utils/cssModules";
import { useAtomValue, useSetAtom } from "jotai";
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from "react";

export type AppHandle = {
  focus(): void;
};

export const App = forwardRef<AppHandle, { widget: React.ReactNode }>(function App({ widget }, ref) {
  const commandRegistry = useCommandRegistry();
  const focusContext = useFocusContext();
  const rootRef = useRef<HTMLDivElement>(null);
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
  const showExtensions = useAtomValue(showExtensionsAtom);
  const themesReady = useAtomValue(themesReadyAtom);
  const systemTheme = useSystemTheme();

  const { uiStateLoaded } = useWorkspaceRestoreProcess();

  useEffect(() => {
    commandRegistry.setFocusLayerGetter(() => focusContext.current);
    return () => {
      commandRegistry.setFocusLayerGetter(null);
    };
  }, [commandRegistry, focusContext]);

  const { refreshAll } = useActivePanelNavigation();
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
    requestCloseEditor,
    overlays: viewerEditorOverlays,
  } = useViewerEditorState();

  useWorkspacePersistenceProcess();

  useEffect(() => {
    setTheme(systemTheme);
  }, [setTheme, systemTheme]);

  useExtensionHost();

  useBuiltInCommands({
    onOpenCreateFileConfirm: handleOpenCreateFileConfirm,
    onViewFile: handleViewFile,
    onEditFile: handleEditFile,
    onRequestCloseEditor: requestCloseEditor,
  });

  useInteractionCommands();
  useCommandRouting(rootRef);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    return focusContext.registerAdapter("panel", {
      focus() {
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
  }, [focusContext]);

  useEffect(() => {
    if (bridge.onReconnect) {
      return bridge.onReconnect(() => {
        refreshAll();
      });
    }
  }, [bridge, refreshAll]);

  let body = null;

  if (!themesReady || !uiStateLoaded) {
    body = <div className={baseStyles["loading"]}>Loading...</div>;
  } else {
    body = (
      <>
        <div className={terminalStyles["terminal-and-panels"]}>
          <div inert={panelsVisible} className={cx(terminalStyles, "terminal-background", panelsVisible && "hidden")}>
            <Terminal />
          </div>
          <div inert={!panelsVisible} className={cx(panelsStyles, "panels-overlay", !panelsVisible && "hidden")}>
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
        {viewerEditorOverlays}
        {showExtensions && <ExtensionsPanel />}
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
