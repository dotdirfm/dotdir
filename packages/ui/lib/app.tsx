import {
  commandLineOnExecuteAtom,
  commandLinePasteFnAtom,
  osThemeAtom,
  panelsVisibleAtom,
  showExtensionsAtom,
  themesReadyAtom,
} from "@/atoms";
import { ActionBar } from "@/components/ActionBar/ActionBar";
import { CommandLine } from "@/components/CommandLine/CommandLine";
import { CommandPalette, useCommandPalette } from "@/components/CommandPalette/CommandPalette";
import { ExtensionsPanel } from "@/components/ExtensionsPanel/ExtensionsPanel";
import { PanelGroup } from "@/components/PanelGroup";
import { TerminalPanelBody, TerminalToolbar } from "@/components/Terminal";
import { DialogHolder, useDialog } from "@/dialogs/dialogContext";
import {
  activePanelSideAtom,
  activeTabAtom,
  leftActiveTabAtom,
  rightActiveTabAtom,
} from "@/entities/tab/model/tabsAtoms";
import { useBridge } from "@/features/bridge/useBridge";
import { useCommandRegistry } from "@/features/commands/commands";
import { useExtensionHost } from "@/features/extensions/useExtensionHost";
import { FileOperationHandlersProvider } from "@/features/file-ops/model/fileOperationHandlers";
import { useFileOperations } from "@/features/file-ops/model/useFileOperations";
import { isExistingDirectory, parseCdCommand, resolveCdPath } from "@/features/navigation/lib/commandLineCd";
import { showHiddenAtom, useUserSettings } from "@/features/settings/useUserSettings";
import { useFocusContext } from "@/focusContext";
import { useBuiltInCommands } from "@/hooks/useBuiltInCommands";
import { useTerminal } from "@/hooks/useTerminal";
import { useViewerEditorState } from "@/hooks/useViewerEditorState";
import { useActivePanelNavigation } from "@/panelControllers";
import { useWorkspacePersistenceProcess, useWorkspaceRestoreProcess } from "@/processes/workspace-session/model/useWorkspaceSessionProcess";
import { normalizeTerminalPath } from "@/terminal/path";
import { normalizePath, resolveDotSegments } from "@/utils/path";
import type { FsNode, ThemeKind } from "fss-lang";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef } from "react";
import baseStyles from "./styles/base.module.css";
import panelsStyles from "./styles/panels.module.css";
import terminalStyles from "./styles/terminal.module.css";
import { cx } from "./utils/cssModules";

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
    [],
  );
  const bridge = useBridge();
  const { settings, updateSettings } = useUserSettings();
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const setTheme = useSetAtom(osThemeAtom);
  const { dialog, showDialog } = useDialog();
  const showHidden = useAtomValue(showHiddenAtom);

  const leftActiveTab = useAtomValue(leftActiveTabAtom);
  const rightActiveTab = useAtomValue(rightActiveTabAtom);

  const [activePanelSide] = useAtom(activePanelSideAtom);
  const panelsVisible = useAtomValue(panelsVisibleAtom);
  const showExtensions = useAtomValue(showExtensionsAtom);
  const themesReady = useAtomValue(themesReadyAtom);
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

  const activeTab = useAtomValue(activeTabAtom);
  const activeTabRef = useRef(activeTab);
  activeTabRef.current = activeTab;

  const {
    navigateTo,
    cancelNavigation,
    refreshAll,
    getPanel,
  } = useActivePanelNavigation();

  const activeCwdForExecuteRef = useRef("");
  const leftFileListState = leftActiveTab?.type === "filelist" ? leftActiveTab : { path: "", entries: [] as FsNode[] };
  const rightFileListState = rightActiveTab?.type === "filelist" ? rightActiveTab : { path: "", entries: [] as FsNode[] };

  const handleCommandLineExecute = useCallback(
    async (cmd: string) => {
      const parsed = parseCdCommand(cmd);
      if (!parsed) {
        void terminal.runCommand(cmd, activeCwdForExecuteRef.current);
        return;
      }
      if (parsed.kind === "error") {
        showDialog({
          type: "message",
          title: "cd",
          message: parsed.message,
          variant: "error",
        });
        return;
      }
      const cwd = activeTabRef.current?.path;
      if (!cwd) {
        return;
      }

      if (parsed.kind === "setAlias") {
        const aliases = {
          ...settingsRef.current.pathAliases,
          [parsed.alias]: normalizeTerminalPath(cwd),
        };
        updateSettings({ pathAliases: aliases });
        return;
      }

      if (parsed.kind === "goAlias") {
        const raw = settingsRef.current.pathAliases?.[parsed.alias];
        if (!raw) {
          showDialog({
            type: "message",
            title: "cd",
            message: `Unknown alias: ${parsed.alias}`,
            variant: "error",
          });
          return;
        }
        const path = normalizeTerminalPath(resolveDotSegments(normalizePath(raw)));
        if (!(await isExistingDirectory(bridge, path))) {
          showDialog({
            type: "message",
            title: "cd",
            message: `Folder not found: ${path}`,
            variant: "error",
          });
          return;
        }
        await getPanel(activePanelSideRef.current)?.navigateTo(path);
        return;
      }

      if (parsed.kind === "chdir") {
        const target = await resolveCdPath(bridge, parsed.pathArg, cwd);
        if (!(await isExistingDirectory(bridge, target))) {
          showDialog({
            type: "message",
            title: "cd",
            message: `Path not found: ${target}`,
            variant: "error",
          });
          return;
        }
        await getPanel(activePanelSideRef.current)?.navigateTo(target);
      }
    },
    [getPanel, showDialog],
  );

  useEffect(() => {
    setCommandLineOnExecute(() => handleCommandLineExecute);
  }, [handleCommandLineExecute, setCommandLineOnExecute]);

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
  } = useViewerEditorState({
    bridge,
    showHidden,
    leftFileListState,
    rightFileListState,
    activePanelSideRef,
    navigateTo,
    showDialog,
  });
  const leftRequestedTopmostName = leftActiveTab?.type === "filelist" ? leftActiveTab.topmostEntryName : undefined;
  const rightRequestedTopmostName = rightActiveTab?.type === "filelist" ? rightActiveTab.topmostEntryName : undefined;

  useWorkspacePersistenceProcess();

  useEffect(() => {
    bridge.theme.get().then((t) => setTheme(t as ThemeKind));
    return bridge.theme.onChange((t) => setTheme(t as ThemeKind));
  }, []);

  useExtensionHost({
    onRefreshPanels: () => {
      refreshAll();
    },
  });

  const terminal = useTerminal({ onNavigatePanel: navigateTo });
  activeCwdForExecuteRef.current = terminal.activeCwd;

  useBuiltInCommands({
    navigateTo: navigateTo ?? (() => {}),
    cancelNavigation: cancelNavigation ?? (() => {}),
    onOpenCreateFileConfirm: handleOpenCreateFileConfirm,
    showDialog,
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
              <PanelGroup
                side="left"
                requestedActiveName={leftRequestedCursor}
                requestedTopmostName={leftRequestedTopmostName}
              />
              <PanelGroup
                side="right"
                requestedActiveName={rightRequestedCursor}
                requestedTopmostName={rightRequestedTopmostName}
              />
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
