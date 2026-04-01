import { commandLineOnExecuteAtom, commandLinePasteFnAtom, panelsVisibleAtom, showExtensionsAtom, systemThemeAtom, themesReadyAtom } from "@/atoms";
import { ActionBar } from "@/components/ActionBar/ActionBar";
import { CommandLine } from "@/components/CommandLine/CommandLine";
import { CommandPalette, useCommandPalette } from "@/components/CommandPalette/CommandPalette";
import { ExtensionsPanel } from "@/components/ExtensionsPanel/ExtensionsPanel";
import { PanelGroup } from "@/components/PanelGroup";
import { TerminalPanelBody, TerminalToolbar } from "@/components/Terminal";
import { DialogHolder, useDialog } from "@/dialogs/dialogContext";
import { activePanelSideAtom, leftActiveTabAtom, rightActiveTabAtom } from "@/entities/tab/model/tabsAtoms";
import { useBridge } from "@/features/bridge/useBridge";
import { useCommandRegistry } from "@/features/commands/commands";
import { useExtensionHost } from "@/features/extensions/useExtensionHost";
import { FileOperationHandlersProvider } from "@/features/file-ops/model/fileOperationHandlers";
import { useFileOperations } from "@/features/file-ops/model/useFileOperations";
import { showHiddenAtom } from "@/features/settings/useUserSettings";
import { FileListHandlersProvider } from "@/fileListHandlers";
import { useFocusContext } from "@/focusContext";
import { useBuiltInCommands } from "@/hooks/useBuiltInCommands";
import { useCommandLineExecute } from "@/hooks/useCommandLineExecute";
import { useSystemTheme } from "@/hooks/useSystemTheme";
import { useTerminal } from "@/hooks/useTerminal";
import { useViewerEditorState } from "@/hooks/useViewerEditorState";
import { useActivePanelNavigation } from "@/panelControllers";
import { useWorkspacePersistenceProcess, useWorkspaceRestoreProcess } from "@/processes/workspace-session/model/useWorkspaceSessionProcess";
import baseStyles from "@/styles/base.module.css";
import panelsStyles from "@/styles/panels.module.css";
import terminalStyles from "@/styles/terminal.module.css";
import { cx } from "@/utils/cssModules";
import type { FsNode } from "fss-lang";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from "react";

export type AppHandle = {
  focus(): void;
};

const AppContent = forwardRef<AppHandle, { widget: React.ReactNode }>(function AppContent({ widget }, ref) {
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
    [],
  );
  const bridge = useBridge();
  const setTheme = useSetAtom(systemThemeAtom);
  const { dialog, showDialog } = useDialog();
  const showHidden = useAtomValue(showHiddenAtom);

  const leftActiveTab = useAtomValue(leftActiveTabAtom);
  const rightActiveTab = useAtomValue(rightActiveTabAtom);

  const [activePanelSide] = useAtom(activePanelSideAtom);
  const panelsVisible = useAtomValue(panelsVisibleAtom);
  const showExtensions = useAtomValue(showExtensionsAtom);
  const themesReady = useAtomValue(themesReadyAtom);
  const systemTheme = useSystemTheme();
  const commandPalette = useCommandPalette();
  const setCommandLineOnExecute = useSetAtom(commandLineOnExecuteAtom);
  const commandLinePasteFnAtomValue = useAtomValue(commandLinePasteFnAtom);
  const commandLinePasteRef = useRef<(text: string) => void>(() => {});
  if (commandLinePasteFnAtomValue) commandLinePasteRef.current = commandLinePasteFnAtomValue;

  const { uiStateLoaded } = useWorkspaceRestoreProcess();

  useEffect(() => {
    commandRegistry.setFocusLayerGetter(() => focusContext.current);
    return () => {
      commandRegistry.setFocusLayerGetter(null);
    };
  }, [focusContext]);

  const activePanelSideRef = useRef(activePanelSide);
  activePanelSideRef.current = activePanelSide;

  const { navigateTo, cancelNavigation, refreshAll } = useActivePanelNavigation();
  const leftFileListState = leftActiveTab?.type === "filelist" ? leftActiveTab : { path: "", entries: [] as FsNode[] };
  const rightFileListState = rightActiveTab?.type === "filelist" ? rightActiveTab : { path: "", entries: [] as FsNode[] };

  const { handleCopy, handleMove, handleMoveToTrash, handlePermanentDelete, handleRename } = useFileOperations();
  const fileOperationHandlers = useMemo(
    () => ({
      moveToTrash: handleMoveToTrash,
      permanentDelete: handlePermanentDelete,
      copy: handleCopy,
      move: handleMove,
      rename: handleRename,
      pasteToCommandLine: (text: string) => commandLinePasteRef.current(text),
    }),
    [handleMoveToTrash, handlePermanentDelete, handleCopy, handleMove, handleRename],
  );

  // Set context for which panel is active
  useEffect(() => {
    commandRegistry.setContext("leftPanelActive", activePanelSide === "left");
    commandRegistry.setContext("rightPanelActive", activePanelSide === "right");
  }, [activePanelSide]);

  // Set context when a dialog is open (e.g. so Tab doesn't switch panel)
  useEffect(() => {
    commandRegistry.setContext("dialogOpen", dialog !== null);
  }, [dialog]);

  const {
    handleViewFile,
    handleEditFile,
    handleOpenCreateFileConfirm,
    requestCloseEditor,
    leftRequestedCursor,
    rightRequestedCursor,
    overlays: viewerEditorOverlays,
  } = useViewerEditorState({ bridge, showHidden, leftFileListState, rightFileListState, activePanelSideRef, navigateTo, showDialog });
  const leftRequestedTopmostName = leftActiveTab?.type === "filelist" ? leftActiveTab.topmostEntryName : undefined;
  const rightRequestedTopmostName = rightActiveTab?.type === "filelist" ? rightActiveTab.topmostEntryName : undefined;

  useWorkspacePersistenceProcess();

  useEffect(() => {
    setTheme(systemTheme);
  }, [setTheme, systemTheme]);

  useExtensionHost({
    onRefreshPanels: () => {
      refreshAll();
    },
  });

  const terminal = useTerminal({ onNavigatePanel: navigateTo });
  const handleCommandLineExecute = useCommandLineExecute({
    activeCwd: terminal.activeCwd,
    runCommand: terminal.runCommand,
  });

  useEffect(() => {
    setCommandLineOnExecute(() => handleCommandLineExecute);
  }, [handleCommandLineExecute, setCommandLineOnExecute]);

  useBuiltInCommands({
    navigateTo: navigateTo ?? (() => {}),
    cancelNavigation: cancelNavigation ?? (() => {}),
    onOpenCreateFileConfirm: handleOpenCreateFileConfirm,
    onViewFile: handleViewFile,
    onEditFile: handleEditFile,
    onRequestCloseEditor: requestCloseEditor,
    onExecuteInTerminal: (cmd) => terminal.writeToTerminal(cmd),
  });

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
  }, []);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      const shouldRoute = focusContext.shouldRouteCommandEvent(event, root);
      if (!shouldRoute) return;
      commandRegistry.handleKeyboardEvent(event);
    };

    root.addEventListener("keydown", handleKeyDown, true);
    return () => root.removeEventListener("keydown", handleKeyDown, true);
  }, []);

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
            <TerminalPanelBody />
          </div>
          <div inert={!panelsVisible} className={cx(panelsStyles, "panels-overlay", !panelsVisible && "hidden")}>
            <div className={panelsStyles["side-by-side-panels"]}>
              <PanelGroup side="left" requestedActiveName={leftRequestedCursor} requestedTopmostName={leftRequestedTopmostName} />
              <PanelGroup side="right" requestedActiveName={rightRequestedCursor} requestedTopmostName={rightRequestedTopmostName} />
            </div>
            <CommandLine />
          </div>
        </div>
        <TerminalToolbar />
        <div className={baseStyles["status-bar"]}>
          <ActionBar />
          {widget}
        </div>
        {viewerEditorOverlays}
        {showExtensions && <ExtensionsPanel />}
        <DialogHolder />
        <CommandPalette open={commandPalette.open} onOpenChange={commandPalette.setOpen} />
      </>
    );
  }

  return (
    <div ref={rootRef} className={baseStyles["app"]} tabIndex={0}>
      <FileOperationHandlersProvider handlers={fileOperationHandlers}>{body}</FileOperationHandlersProvider>
    </div>
  );
});

export const App = forwardRef<AppHandle, { widget: React.ReactNode }>(function App(props, ref) {
  return (
    <FileListHandlersProvider>
      <AppContent {...props} ref={ref} />
    </FileListHandlersProvider>
  );
});
