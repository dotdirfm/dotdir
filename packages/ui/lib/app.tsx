import {
  commandLineOnExecuteAtom,
  commandLinePasteFnAtom,
  editorFileAtom,
  osThemeAtom,
  panelsVisibleAtom,
  showExtensionsAtom,
  themesReadyAtom,
  viewerFileAtom,
} from "@/atoms";
import { ActionBar } from "@/components/ActionBar/ActionBar";
import { CommandLine } from "@/components/CommandLine/CommandLine";
import { CommandPalette, useCommandPalette } from "@/components/CommandPalette/CommandPalette";
import { EditorContainer, ViewerContainer } from "@/components/ExtensionContainer";
import { ExtensionsPanel } from "@/components/ExtensionsPanel/ExtensionsPanel";
import { PanelGroup } from "@/components/PanelGroup";
import { TerminalPanelBody, TerminalToolbar } from "@/components/Terminal";
import { DialogHolder, useDialog } from "@/dialogs/dialogContext";
import { ModalDialog } from "@/dialogs/ModalDialog";
import { OPPOSITE_PANEL } from "@/entities/panel/model/panelSide";
import {
  activePanelSideAtom,
  activeTabAtom,
  createFilelistTab,
  createPreviewTab,
  leftActiveTabAtom,
  leftActiveTabIdAtom,
  leftTabsAtom,
  rightActiveTabAtom,
  rightActiveTabIdAtom,
  rightTabsAtom,
} from "@/entities/tab/model/tabsAtoms";
import { useBridge } from "@/features/bridge/useBridge";
import { commandRegistry } from "@/features/commands/commands";
import { useExtensionHost } from "@/features/extensions/useExtensionHost";
import { setFileOperationHandlers } from "@/features/file-ops/model/fileOperationHandlers";
import { useFileOperations } from "@/features/file-ops/model/useFileOperations";
import { isExistingDirectory, parseCdCommand, resolveCdPath } from "@/features/navigation/lib/commandLineCd";
import { showHiddenAtom, useUserSettings } from "@/features/settings/useUserSettings";
import { focusContext } from "@/focusContext";
import { useBuiltInCommands } from "@/hooks/useBuiltInCommands";
import { type FileListPanelController } from "@/hooks/useFileListPanel";
import { useTerminal } from "@/hooks/useTerminal";
import { useWorkspacePersistenceProcess, useWorkspaceRestoreProcess } from "@/processes/workspace-session/model/useWorkspaceSessionProcess";
import { normalizeTerminalPath } from "@/terminal/path";
import { CONTAINER_SEP } from "@/utils/containerPath";
import { isMediaFile } from "@/utils/mediaFiles";
import { basename, normalizePath, resolveDotSegments } from "@/utils/path";
import { editorRegistry, fsProviderRegistry, viewerRegistry } from "@/viewerEditorRegistry";
import type { FsNode, ThemeKind } from "fss-lang";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import baseStyles from "./styles/base.module.css";
import panelsStyles from "./styles/panels.module.css";
import terminalStyles from "./styles/terminal.module.css";
import { cx } from "./utils/cssModules";

export type AppHandle = {
  focus(): void;
};

export const App = forwardRef<AppHandle, { widget: React.ReactNode }>(function App({ widget }, ref) {
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

  const [activePanelSide, setActivePanelSide] = useAtom(activePanelSideAtom);
  const panelsVisible = useAtomValue(panelsVisibleAtom);
  const [viewerFile, setViewerFile] = useAtom(viewerFileAtom);
  const [editorFile, setEditorFile] = useAtom(editorFileAtom);
  const [viewerExt, setViewerExt] = useState<{ dirPath: string; entry: string } | null>(null);
  const [editorExt, setEditorExt] = useState<{ dirPath: string; entry: string } | null>(null);
  const [editorDirty, setEditorDirty] = useState(false);
  const showExtensions = useAtomValue(showExtensionsAtom);
  const [leftTabs, setLeftTabs] = useAtom(leftTabsAtom);
  const [rightTabs, setRightTabs] = useAtom(rightTabsAtom);
  const [leftActiveTabId, setLeftActiveTabId] = useAtom(leftActiveTabIdAtom);
  const [rightActiveTabId, setRightActiveTabId] = useAtom(rightActiveTabIdAtom);
  const leftSelectedNameRef = useRef<string | undefined>(undefined);
  const rightSelectedNameRef = useRef<string | undefined>(undefined);
  const themesReady = useAtomValue(themesReadyAtom);
  const leftTabsRef = useRef(leftTabs);
  leftTabsRef.current = leftTabs;
  const rightTabsRef = useRef(rightTabs);
  rightTabsRef.current = rightTabs;
  const leftActiveTabIdRef = useRef(leftActiveTabId);
  leftActiveTabIdRef.current = leftActiveTabId;
  const rightActiveTabIdRef = useRef(rightActiveTabId);
  rightActiveTabIdRef.current = rightActiveTabId;
  const [selectionKey, setSelectionKey] = useState(0);
  const commandPalette = useCommandPalette();
  const setCommandLineOnExecute = useSetAtom(commandLineOnExecuteAtom);
  const commandLinePasteFnAtomValue = useAtomValue(commandLinePasteFnAtom);
  const commandLinePasteRef = useRef<(text: string) => void>(() => {});
  if (commandLinePasteFnAtomValue) commandLinePasteRef.current = commandLinePasteFnAtomValue;

  // const onAfterRestore = useCallback(() => {
  //   initUserKeybindings(bridge);
  // }, [bridge]);

  const { uiStateLoaded } = useWorkspaceRestoreProcess();

  const activePanelSideRef = useRef(activePanelSide);
  activePanelSideRef.current = activePanelSide;

  const activeTab = useAtomValue(activeTabAtom);
  const activeTabRef = useRef(activeTab);
  activeTabRef.current = activeTab;

  const leftRef = useRef<FileListPanelController | undefined>(undefined);
  const rightRef = useRef<FileListPanelController | undefined>(undefined);

  const navigateTo = activePanelSide === "left" ? leftRef.current?.navigateTo : rightRef.current?.navigateTo;
  const activePanelNavigateRef = useRef(navigateTo);
  activePanelNavigateRef.current = navigateTo;

  const cancelNavigation = activePanelSide === "left" ? leftRef.current?.cancelNavigation : rightRef.current?.cancelNavigation;
  const activePanelCancelNavigationRef = useRef(cancelNavigation);
  activePanelCancelNavigationRef.current = cancelNavigation;

  const activeCwdForExecuteRef = useRef("");

  const handleLeftPanelChange = useCallback((panel: FileListPanelController) => {
    leftRef.current = panel;
  }, []);

  const handleRightPanelChange = useCallback((panel: FileListPanelController) => {
    rightRef.current = panel;
  }, []);

  const leftFileListState = leftRef.current?.state ?? (leftActiveTab?.type === "filelist" ? leftActiveTab : { path: "", entries: [] as FsNode[] });
  const rightFileListState = rightRef.current?.state ?? (rightActiveTab?.type === "filelist" ? rightActiveTab : { path: "", entries: [] as FsNode[] });

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
      const panel = activePanelSideRef.current === "left" ? leftRef.current : rightRef.current;
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
        await panel?.navigateTo(path);
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
        await panel?.navigateTo(target);
      }
    },
    [showDialog],
  );

  useEffect(() => {
    setCommandLineOnExecute(() => handleCommandLineExecute);
  }, [handleCommandLineExecute, setCommandLineOnExecute]);

  const { handleCopy, handleMove, handleMoveToTrash, handlePermanentDelete, handleRename } = useFileOperations(leftRef, rightRef, setSelectionKey);

  useEffect(() => {
    setFileOperationHandlers({
      moveToTrash: handleMoveToTrash,
      permanentDelete: handlePermanentDelete,
      copy: handleCopy,
      move: handleMove,
      rename: handleRename,
      pasteToCommandLine: (text) => commandLinePasteRef.current(text),
    });
  }, [handleMoveToTrash, handlePermanentDelete, handleCopy, handleMove, handleRename]);

  // Set context for which panel is active
  useEffect(() => {
    commandRegistry.setContext("leftPanelActive", activePanelSide === "left");
    commandRegistry.setContext("rightPanelActive", activePanelSide === "right");
  }, [activePanelSide]);

  // Set context when a dialog is open (e.g. so Tab doesn't switch panel)
  useEffect(() => {
    commandRegistry.setContext("dialogOpen", dialog !== null);
  }, [dialog]);

  const handleViewFile = useCallback((filePath: string, fileName: string, fileSize: number) => {
    // If an fsProvider is registered for this file type, enter it like a directory.
    if (fsProviderRegistry.resolve(basename(filePath))) {
      void activePanelNavigateRef.current?.(filePath + CONTAINER_SEP);
      return;
    }
    setViewerFile({
      path: filePath,
      name: fileName,
      size: fileSize,
      panel: activePanelSideRef.current,
    });
  }, []);

  const handleEditFile = useCallback((filePath: string, fileName: string, fileSize: number, langId: string) => {
    setEditorDirty(false);
    setEditorFile({ path: filePath, name: fileName, size: fileSize, langId });
  }, []);

  const handleOpenCreateFileConfirm = useCallback(async (filePath: string, fileName: string, langId: string) => {
    const exists = await bridge.fs.exists(filePath);
    if (!exists) {
      await bridge.fs.writeFile(filePath, "");
    }
    const size = exists ? (await bridge.fs.stat(filePath)).size : 0;
    setEditorDirty(false);
    setEditorFile({ path: filePath, name: fileName, size, langId });
  }, []);

  const requestCloseEditor = useCallback(() => {
    if (!editorDirty || !editorFile) {
      setEditorDirty(false);
      setEditorFile(null);
      return;
    }
    showDialog({
      type: "message",
      title: "Unsaved Changes",
      message: `Close "${editorFile.name}" and discard unsaved changes?`,
      buttons: [
        { label: "Cancel", default: true },
        {
          label: "Discard",
          onClick: () => {
            setEditorDirty(false);
            setEditorFile(null);
          },
        },
      ],
    });
  }, [editorDirty, editorFile, showDialog]);

  const viewerPanelEntries: FsNode[] = viewerFile ? (viewerFile.panel === "left" ? leftFileListState.entries : rightFileListState.entries) : [];

  // Helper: match a filename against simple glob patterns like "*.png"
  const matchesPatterns = useCallback((name: string, patterns: string[]): boolean => {
    return patterns.some((p) => {
      if (p.startsWith("*.")) {
        const ext = p.slice(1).toLowerCase();
        return name.toLowerCase().endsWith(ext);
      }
      return name.toLowerCase() === p.toLowerCase();
    });
  }, []);

  // Compute filtered & sorted file list matching given patterns from the viewer's panel
  const getMatchingFiles = useCallback(
    (patterns: string[]) => {
      if (!viewerFile) return [];
      const entries = showHidden ? viewerPanelEntries : viewerPanelEntries.filter((e) => !e.meta.hidden);
      return entries
        .filter((e) => e.type === "file" && matchesPatterns(e.name, patterns))
        .map((e) => ({
          path: e.path as string,
          name: e.name,
          size: Number(e.meta.size),
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
    },
    [viewerFile, viewerPanelEntries, showHidden, matchesPatterns],
  );

  // Generic command handler for viewer extensions
  const handleExecuteCommand = useCallback(
    async (command: string, args?: unknown): Promise<unknown> => {
      const { patterns } = (args as { patterns?: string[] } | undefined) ?? {};
      if (!patterns || !viewerFile) return undefined;
      const files = getMatchingFiles(patterns);
      const idx = files.findIndex((f) => f.path === viewerFile.path);

      if (command === "navigatePrev") {
        if (idx > 0) {
          const file = files[idx - 1]!;
          setViewerFile((prev) => (prev ? { ...file, panel: prev.panel } : null));
        }
        return undefined;
      }
      if (command === "navigateNext") {
        if (idx >= 0 && idx < files.length - 1) {
          const file = files[idx + 1]!;
          setViewerFile((prev) => (prev ? { ...file, panel: prev.panel } : null));
        }
        return undefined;
      }
      if (command === "getFileIndex") {
        return { index: idx, total: files.length };
      }
      return undefined;
    },
    [viewerFile, getMatchingFiles],
  );

  // Resolve extension for current viewer/editor file. Cache the identity so the
  // overlay + iframe persist after the file is closed, enabling iframe reuse.
  const viewerResolved = viewerFile ? viewerRegistry.resolve(viewerFile.name) : null;
  const editorResolved = editorFile ? editorRegistry.resolve(editorFile.name) : null;

  useEffect(() => {
    if (!viewerResolved) return;
    setViewerExt((prev) => {
      if (prev?.dirPath === viewerResolved.extensionDirPath && prev?.entry === viewerResolved.contribution.entry) return prev;
      return {
        dirPath: viewerResolved.extensionDirPath,
        entry: viewerResolved.contribution.entry,
      };
    });
  }, [viewerResolved?.extensionDirPath, viewerResolved?.contribution.entry]);

  useEffect(() => {
    if (!editorResolved) return;
    setEditorExt((prev) => {
      if (prev?.dirPath === editorResolved.extensionDirPath && prev?.entry === editorResolved.contribution.entry) return prev;
      return {
        dirPath: editorResolved.extensionDirPath,
        entry: editorResolved.contribution.entry,
      };
    });
  }, [editorResolved?.extensionDirPath, editorResolved?.contribution.entry]);

  const viewerActiveName = viewerFile && isMediaFile(viewerFile.name) ? viewerFile.name : undefined;
  const leftRequestedCursor = viewerFile?.panel === "left" ? viewerActiveName : leftActiveTab?.type === "filelist" ? leftActiveTab.activeEntryName : undefined;
  const rightRequestedCursor = viewerFile?.panel === "right" ? viewerActiveName : rightActiveTab?.type === "filelist" ? rightActiveTab.activeEntryName : undefined;
  const leftRequestedTopmostName = leftActiveTab?.type === "filelist" ? leftActiveTab.topmostEntryName : undefined;
  const rightRequestedTopmostName = rightActiveTab?.type === "filelist" ? rightActiveTab.topmostEntryName : undefined;

  useWorkspacePersistenceProcess();

  const handlePanelStateChange = useCallback(
    (side: "left" | "right", selectedName: string | undefined, topmostName: string | undefined) => {
      const activeId = side === "left" ? leftActiveTabIdRef.current : rightActiveTabIdRef.current;
      const setTabs = side === "left" ? setLeftTabs : setRightTabs;
      const selectedRef = side === "left" ? leftSelectedNameRef : rightSelectedNameRef;
      selectedRef.current = selectedName;
      setTabs((prev) =>
        prev.map((tab) =>
          tab.id === activeId && tab.type === "filelist"
            ? { ...tab, activeEntryName: selectedName, topmostEntryName: topmostName, entries: tab.entries }
            : tab,
        ),
      );
    },
    [setLeftTabs, setRightTabs],
  );

  const handleOpenCurrentFolderInOppositeCurrentTab = useCallback(() => {
    const side = activePanelSideRef.current;
    const opposite = OPPOSITE_PANEL[side];
    const path = side === "left" ? leftFileListState.path : rightFileListState.path;
    const activeTabId = (opposite === "left" ? leftActiveTabIdRef : rightActiveTabIdRef).current;
    const setTabs = opposite === "left" ? setLeftTabs : setRightTabs;
    setTabs((prev) => prev.map((t) => (t.id === activeTabId && t.type === "filelist" ? { ...t, path } : t)));
    setActivePanelSide(opposite);
  }, [leftFileListState.path, rightFileListState.path]);

  const handleOpenCurrentFolderInOppositeNewTab = useCallback(() => {
    const side = activePanelSideRef.current;
    const opposite = OPPOSITE_PANEL[side];
    const path = side === "left" ? leftFileListState.path : rightFileListState.path;
    const newTab = createFilelistTab(path);
    const setTabs = opposite === "left" ? setLeftTabs : setRightTabs;
    const setActiveId = opposite === "left" ? setLeftActiveTabId : setRightActiveTabId;
    setTabs((prev) => [...prev, newTab]);
    setActiveId(newTab.id);
    setActivePanelSide(opposite);
  }, [leftFileListState.path, rightFileListState.path]);

  const handleOpenSelectedFolderInOppositeCurrentTab = useCallback(() => {
    const side = activePanelSideRef.current;
    const entries = side === "left" ? leftFileListState.entries : rightFileListState.entries;
    const selectedName = side === "left" ? leftSelectedNameRef.current : rightSelectedNameRef.current;
    const entry = selectedName ? entries.find((e) => e.name === selectedName) : undefined;
    if (!entry || entry.type !== "folder") return;
    const path = entry.path as string;
    const opposite = OPPOSITE_PANEL[side];
    const activeTabId = (opposite === "left" ? leftActiveTabIdRef : rightActiveTabIdRef).current;
    const setTabs = opposite === "left" ? setLeftTabs : setRightTabs;
    setTabs((prev) => prev.map((t) => (t.id === activeTabId && t.type === "filelist" ? { ...t, path } : t)));
    setActivePanelSide(opposite);
  }, [leftFileListState.entries, rightFileListState.entries]);

  const handleOpenSelectedFolderInOppositeNewTab = useCallback(() => {
    const side = activePanelSideRef.current;
    const entries = side === "left" ? leftFileListState.entries : rightFileListState.entries;
    const selectedName = side === "left" ? leftSelectedNameRef.current : rightSelectedNameRef.current;
    const entry = selectedName ? entries.find((e) => e.name === selectedName) : undefined;
    if (!entry || entry.type !== "folder") return;
    const path = entry.path as string;
    const opposite = OPPOSITE_PANEL[side];
    const newTab = createFilelistTab(path);
    const setTabs = opposite === "left" ? setLeftTabs : setRightTabs;
    const setActiveId = opposite === "left" ? setLeftActiveTabId : setRightActiveTabId;
    setTabs((prev) => [...prev, newTab]);
    setActiveId(newTab.id);
    setActivePanelSide(opposite);
  }, [leftFileListState.entries, rightFileListState.entries]);

  const handlePreviewInOppositePanel = useCallback(() => {
    const side = activePanelSideRef.current;
    const entries = side === "left" ? leftFileListState.entries : rightFileListState.entries;
    const selectedName = side === "left" ? leftSelectedNameRef.current : rightSelectedNameRef.current;
    const entry = selectedName ? entries.find((e: FsNode) => e.name === selectedName) : undefined;
    if (!entry || entry.type !== "file") return;
    const path = entry.path as string;
    const name = entry.name;
    const size = Number(entry.meta.size);
    const sourcePanel = side;
    const opposite = OPPOSITE_PANEL[side];
    const tabs = (opposite === "left" ? leftTabsRef : rightTabsRef).current;
    const setTabs = opposite === "left" ? setLeftTabs : setRightTabs;
    const setActiveId = opposite === "left" ? setLeftActiveTabId : setRightActiveTabId;

    const tempTab = tabs.find((t) => t.type === "preview" && t.isTemp);
    if (tempTab && tempTab.type === "preview") {
      setTabs((prev) => prev.map((t) => (t.id === tempTab.id ? { ...t, path, name, size, sourcePanel, mode: "viewer", dirty: false } : t)));
      setActiveId(tempTab.id);
    } else {
      const newTab = createPreviewTab(path, name, size, sourcePanel, { mode: "viewer" });
      setTabs((prev) => [...prev, newTab]);
      setActiveId(newTab.id);
    }
    setActivePanelSide(opposite);
  }, [leftFileListState.entries, rightFileListState.entries]);

  const handleEditInOppositePanel = useCallback(() => {
    const side = activePanelSideRef.current;
    const entries = side === "left" ? leftFileListState.entries : rightFileListState.entries;
    const selectedName = side === "left" ? leftSelectedNameRef.current : rightSelectedNameRef.current;
    const entry = selectedName ? entries.find((e: FsNode) => e.name === selectedName) : undefined;
    if (!entry || entry.type !== "file") return;
    const path = entry.path as string;
    const name = entry.name;
    const size = Number(entry.meta.size);
    const langId = typeof entry.lang === "string" && entry.lang ? entry.lang : "plaintext";
    const sourcePanel = side;
    const opposite = OPPOSITE_PANEL[side];
    const tabs = (opposite === "left" ? leftTabsRef : rightTabsRef).current;
    const setTabs = opposite === "left" ? setLeftTabs : setRightTabs;
    const setActiveId = opposite === "left" ? setLeftActiveTabId : setRightActiveTabId;

    const tempTab = tabs.find((t) => t.type === "preview" && t.isTemp);
    if (tempTab && tempTab.type === "preview") {
      setTabs((prev) => prev.map((t) => (t.id === tempTab.id ? { ...t, path, name, size, sourcePanel, mode: "editor", langId, dirty: false } : t)));
      setActiveId(tempTab.id);
    } else {
      const newTab = createPreviewTab(path, name, size, sourcePanel, { mode: "editor", langId });
      setTabs((prev) => [...prev, newTab]);
      setActiveId(newTab.id);
    }
    setActivePanelSide(opposite);
  }, [leftFileListState.entries, rightFileListState.entries]);

  useEffect(() => {
    bridge.theme.get().then((t) => setTheme(t as ThemeKind));
    return bridge.theme.onChange((t) => setTheme(t as ThemeKind));
  }, []);

  const leftPathRef = useRef(leftFileListState.path);
  leftPathRef.current = leftFileListState.path;
  const rightPathRef = useRef(rightFileListState.path);
  rightPathRef.current = rightFileListState.path;

  // const prevLeftPathRef = useRef(leftPanelState.path);
  // const prevRightPathRef = useRef(rightPanelState.path);
  // useEffect(() => {
  //   if (prevLeftPathRef.current === leftPanelState.path) return;
  //   prevLeftPathRef.current = leftPanelState.path;
  //   setLeftTabs((prev) => {
  //     const idx = prev.findIndex((t) => t.id === leftActiveTabId);
  //     if (idx < 0) return prev;
  //     const tab = prev[idx];
  //     if (tab?.type !== "filelist" || tab.path === leftPanelState.path) return prev;
  //     const next = [...prev];
  //     next[idx] = { ...tab, path: leftPanelState.path };
  //     return next;
  //   });
  // }, [leftPanelState.path, leftActiveTabId]);

  // useEffect(() => {
  //   if (prevRightPathRef.current === rightPanelState.path) return;
  //   prevRightPathRef.current = rightPanelState.path;
  //   setRightTabs((prev) => {
  //     const idx = prev.findIndex((t) => t.id === rightActiveTabId);
  //     if (idx < 0) return prev;
  //     const tab = prev[idx];
  //     if (tab?.type !== "filelist" || tab.path === rightPanelState.path) return prev;
  //     const next = [...prev];
  //     next[idx] = { ...tab, path: rightPanelState.path };
  //     return next;
  //   });
  // }, [rightPanelState.path, rightActiveTabId]);

  // Navigate panels using persisted state or defaults — fires once when settings are loaded
  // useEffect(() => {
  //   if (!settingsLoaded) return;

  //   const navigatePanel = async (
  //     panel: ActivePanelHandle | undefined,
  //     setTabs: typeof setLeftTabs,
  //     activeTabId: string,
  //     persistedState: PanelPersistedState | undefined,
  //     fallbackPath?: string,
  //   ) => {
  //     let targetPath = persistedState?.currentPath ?? fallbackPath;

  //     if (targetPath) {
  //       const exists = await bridge.fs.exists(targetPath);
  //       if (!exists) {
  //         targetPath = await findExistingParent(bridge, targetPath);
  //       }
  //     }

  //     if (!targetPath) {
  //       targetPath = await bridge.utils.getHomePath();
  //     }

  //     setTabs((prev) => prev.map((t) => (t.id === activeTabId && t.type === "filelist" ? { ...t, path: targetPath! } : t)));
  //     await panel?.navigateTo(targetPath);
  //   };

  //   navigatePanel(leftRef.current, setLeftTabs, leftActiveTabIdRef.current, initialLeftPanel);
  //   navigatePanel(rightRef.current, setRightTabs, rightActiveTabIdRef.current, initialRightPanel);
  //   if (initialActivePanel) {
  //     setActivePanelSide(initialActivePanel);
  //   }

  //   // Clear initial state after first navigation to prevent cursor jumping
  //   // when viewer is closed (was falling back to initial per-tab selection)
  //   setTimeout(() => {
  //     setInitialLeftPanel(undefined);
  //     setInitialRightPanel(undefined);
  //     setInitialActivePanel(undefined);
  //   }, 500);
  //   // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally fires once when settingsLoaded becomes true
  // }, [settingsLoaded]);

  useExtensionHost({
    onRefreshPanels: () => {
      leftRef.current?.refresh();
      rightRef.current?.refresh();
    },
  });

  const onNavigatePanel = useCallback((path: string) => {
    (activePanelSideRef.current === "left" ? leftRef.current : rightRef.current)?.navigateTo(path);
  }, []);

  const terminal = useTerminal({ onNavigatePanel });
  activeCwdForExecuteRef.current = terminal.activeCwd;

  useBuiltInCommands({
    navigateTo: navigateTo ?? (() => {}),
    cancelNavigation: cancelNavigation ?? (() => {}),
    onPreviewInOppositePanel: handlePreviewInOppositePanel,
    onEditInOppositePanel: handleEditInOppositePanel,
    openCurrentDirInOppositePanelCurrentTab: handleOpenCurrentFolderInOppositeCurrentTab,
    openCurrentDirInOppositePanelNewTab: handleOpenCurrentFolderInOppositeNewTab,
    openSelectedDirInOppositePanelCurrentTab: handleOpenSelectedFolderInOppositeCurrentTab,
    openSelectedDirInOppositePanelNewTab: handleOpenSelectedFolderInOppositeNewTab,
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
        leftRef.current?.refresh();
        rightRef.current?.refresh();
      });
    }
  }, []);

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
                selectionKey={selectionKey}
                requestedActiveName={leftRequestedCursor}
                requestedTopmostName={leftRequestedTopmostName}
                onStateChange={(sel, top) => handlePanelStateChange("left", sel, top)}
                onActivePanelChange={handleLeftPanelChange}
              />
              <PanelGroup
                side="right"
                selectionKey={selectionKey}
                requestedActiveName={rightRequestedCursor}
                requestedTopmostName={rightRequestedTopmostName}
                onStateChange={(sel, top) => handlePanelStateChange("right", sel, top)}
                onActivePanelChange={handleRightPanelChange}
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
        {viewerFile && !viewerResolved && (
          <ModalDialog
            title="No viewer"
            message="No viewer extension found for this file type. Install viewer extensions (e.g. Image Viewer, File Viewer) from the extensions panel."
            onClose={() => setViewerFile(null)}
          />
        )}
        {viewerExt && viewerFile && viewerResolved && (
          <ViewerContainer
            key={`viewer:${viewerExt.dirPath}:${viewerExt.entry}`}
            extensionDirPath={viewerExt.dirPath}
            entry={viewerExt.entry}
            filePath={viewerFile.path}
            fileName={viewerFile.name}
            fileSize={viewerFile.size}
            onClose={() => setViewerFile(null)}
            onExecuteCommand={handleExecuteCommand}
          />
        )}
        {editorFile && !editorResolved && (
          <ModalDialog
            title="No editor"
            message="No editor extension found for this file type. Install an editor extension (e.g. Monaco Editor) from the extensions panel."
            onClose={requestCloseEditor}
          />
        )}
        {editorExt &&
          editorFile &&
          editorResolved &&
          (() => {
            return (
              <EditorContainer
                key={`editor:${editorExt.dirPath}:${editorExt.entry}`}
                extensionDirPath={editorExt.dirPath}
                entry={editorExt.entry}
                filePath={editorFile.path}
                fileName={editorFile.name}
                langId={editorFile.langId}
                onClose={requestCloseEditor}
                onDirtyChange={setEditorDirty}
              />
            );
          })()}
        {showExtensions && <ExtensionsPanel />}
        <DialogHolder />
        <CommandPalette open={commandPalette.open} onOpenChange={commandPalette.setOpen} />
      </>
    );
  }

  return (
    <div ref={rootRef} className={baseStyles["app"]} tabIndex={0}>
      {body}
    </div>
  );
});
