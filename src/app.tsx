import { isTauri as isTauriApp } from "@tauri-apps/api/core";
import type { ThemeKind } from "fss-lang";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActionBar } from "./ActionBar";
import {
  activeColorThemeAtom,
  activeIconThemeAtom,
  activePanelAtom,
  commandLineOnExecuteAtom,
  commandLinePasteFnAtom,
  editorFileAtom,
  loadedExtensionsAtom,
  osThemeAtom,
  panelsVisibleAtom,
  showExtensionsAtom,
  showHiddenAtom,
  themesReadyAtom,
  viewerFileAtom,
} from "./atoms";
import { bridge } from "./bridge";
import { CommandLine } from "./CommandLine";
import { isExistingDirectory, parseCdCommand, resolveCdPath } from "./commandLineCd";
import { CommandPalette, useCommandPalette } from "./CommandPalette";
import { commandRegistry } from "./commands";
import { CONTAINER_SEP } from "./containerPath";
import { DialogHolder, useDialog } from "./dialogContext";
import { EditorContainer, ViewerContainer } from "./ExtensionContainer";
import { DEFAULT_EDITOR_FILE_SIZE_LIMIT, type PanelPersistedState, type PersistedTab } from "./extensions";
import { ExtensionsPanel } from "./ExtensionsPanel";
import type { PanelTab } from "./FileList/PanelTabs";
import { isMediaFile } from "./mediaFiles";
import { ModalDialog } from "./ModalDialog";
import { PanelGroup } from "./PanelGroup";
import { OPPOSITE_PANEL, PANEL_SETTINGS_KEY, PANEL_SIDES } from "./panelSide";
import { basename, normalizePath, resolveDotSegments } from "./path";
import { createFilelistTab, createPreviewTab, genTabId, leftActiveTabIdAtom, leftTabsAtom, rightActiveTabIdAtom, rightTabsAtom } from "./tabsAtoms";
import { TerminalPanelBody, TerminalToolbar } from "./Terminal";
import { normalizeTerminalPath } from "./terminal/path";
import { useBuiltInCommands } from "./useBuiltInCommands";
import { useExtensionHost } from "./useExtensionHost";
import { setFileOperationHandlers } from "./fileOperationHandlers";
import { useFileOperations, type PanelSide } from "./useFileOperations";
import { findExistingParent, usePanel } from "./usePanel";
import { initUserKeybindings } from "./userKeybindings";
import { useTerminal } from "./useTerminal";
import { useUserSettings } from "./useUserSettings";
import { editorRegistry, fsProviderRegistry, viewerRegistry } from "./viewerEditorRegistry";

export function App() {
  const { settings, ready, updateSettings } = useUserSettings();
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const setTheme = useSetAtom(osThemeAtom);
  const { dialog, showDialog } = useDialog();
  const [showHidden, setShowHidden] = useAtom(showHiddenAtom);
  const showError = useCallback(
    (message: string) => {
      showDialog({
        type: "message",
        title: "Error",
        message,
        variant: "error",
      });
    },
    [showDialog],
  );
  const left = usePanel(showError);
  const right = usePanel(showError);
  const [activePanel, setActivePanel] = useAtom(activePanelAtom);
  const panelsVisible = useAtomValue(panelsVisibleAtom);
  const [viewerFile, setViewerFile] = useAtom(viewerFileAtom);
  const [editorFile, setEditorFile] = useAtom(editorFileAtom);
  const [viewerExt, setViewerExt] = useState<{ dirPath: string; entry: string } | null>(null);
  const [editorExt, setEditorExt] = useState<{ dirPath: string; entry: string } | null>(null);
  const showExtensions = useAtomValue(showExtensionsAtom);
  const setActiveIconTheme = useSetAtom(activeIconThemeAtom);
  const setActiveColorTheme = useSetAtom(activeColorThemeAtom);
  const [editorFileSizeLimit, setEditorFileSizeLimit] = useState(DEFAULT_EDITOR_FILE_SIZE_LIMIT);
  const [initialLeftPanel, setInitialLeftPanel] = useState<PanelPersistedState | undefined>(undefined);
  const [initialRightPanel, setInitialRightPanel] = useState<PanelPersistedState | undefined>(undefined);
  const [initialActivePanel, setInitialActivePanel] = useState<PanelSide | undefined>(undefined);
  const [leftTabs, setLeftTabs] = useAtom(leftTabsAtom);
  const [rightTabs, setRightTabs] = useAtom(rightTabsAtom);
  const [leftActiveTabId, setLeftActiveTabId] = useAtom(leftActiveTabIdAtom);
  const [rightActiveTabId, setRightActiveTabId] = useAtom(rightActiveTabIdAtom);
  const leftSelectedNameRef = useRef<string | undefined>(undefined);
  const rightSelectedNameRef = useRef<string | undefined>(undefined);
  const leftTabSelectionRef = useRef<Record<string, { selectedName?: string; topmostName?: string }>>({});
  const rightTabSelectionRef = useRef<Record<string, { selectedName?: string; topmostName?: string }>>({});
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const loadedExtensions = useAtomValue(loadedExtensionsAtom);
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

  // Apply non-structural settings reactively (initial load + external file changes)
  useEffect(() => {
    if (!ready) return;
    if (settings.iconTheme) setActiveIconTheme(settings.iconTheme);
    if (settings.colorTheme !== undefined) setActiveColorTheme(settings.colorTheme || undefined);
    if (settings.editorFileSizeLimit !== undefined) setEditorFileSizeLimit(settings.editorFileSizeLimit);
    if (settings.showHidden !== undefined) setShowHidden(settings.showHidden);
  }, [settings, ready]);

  // One-time restoration: tabs, panel paths, active panel — runs once when settings first load
  useEffect(() => {
    if (!ready) return;

    const s = settingsRef.current;

    const restoreTabs = (panel: PanelPersistedState | undefined): PanelTab[] | null => {
      if (panel?.tabs?.length) {
        return panel.tabs.map((t) => {
          if (t.type === "filelist") return createFilelistTab(t.path);
          return { id: genTabId(), type: "preview" as const, path: t.path, name: t.name, size: t.size, isTemp: false };
        });
      }
      if (panel?.currentPath) {
        return [createFilelistTab(panel.currentPath)];
      }
      return null;
    };

    const seedTabSelections = (refs: typeof leftTabSelectionRef, restored: PanelTab[] | null, persisted: PanelPersistedState | undefined) => {
      if (!restored?.length || !persisted?.tabs?.length) return;
      for (let i = 0; i < restored.length && i < persisted.tabs.length; i++) {
        const t = restored[i];
        const p = persisted.tabs[i];
        if (t.type === "filelist" && p.type === "filelist" && (p.selectedName != null || p.topmostName != null)) {
          refs.current[t.id] = { selectedName: p.selectedName, topmostName: p.topmostName };
        }
      }
    };

    const restoredLeftTabs = restoreTabs(s.leftPanel);
    const restoredRightTabs = restoreTabs(s.rightPanel);
    if (restoredLeftTabs) seedTabSelections(leftTabSelectionRef, restoredLeftTabs, s.leftPanel);
    if (restoredRightTabs) seedTabSelections(rightTabSelectionRef, restoredRightTabs, s.rightPanel);
    const restoredLeftIndex = restoredLeftTabs ? Math.min(s.leftPanel?.activeTabIndex ?? 0, restoredLeftTabs.length - 1) : 0;
    const restoredRightIndex = restoredRightTabs ? Math.min(s.rightPanel?.activeTabIndex ?? 0, restoredRightTabs.length - 1) : 0;
    const restoredLeftActiveId = restoredLeftTabs?.[restoredLeftIndex]?.id;
    const restoredRightActiveId = restoredRightTabs?.[restoredRightIndex]?.id;

    if (restoredLeftActiveId) prevLeftActiveTabIdRef.current = restoredLeftActiveId;
    if (restoredRightActiveId) prevRightActiveTabIdRef.current = restoredRightActiveId;

    if (restoredLeftTabs) setLeftTabs(restoredLeftTabs);
    if (restoredRightTabs) setRightTabs(restoredRightTabs);
    if (restoredLeftActiveId) setLeftActiveTabId(restoredLeftActiveId);
    if (restoredRightActiveId) setRightActiveTabId(restoredRightActiveId);

    if (s.leftPanel) setInitialLeftPanel(s.leftPanel);
    if (s.rightPanel) setInitialRightPanel(s.rightPanel);
    if (s.activePanel) setInitialActivePanel(s.activePanel);
    setSettingsLoaded(true);
    initUserKeybindings();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally runs once when ready
  }, [ready]);

  const activePanelRef = useRef(activePanel);
  activePanelRef.current = activePanel;
  // Points to the active panel's navigateTo so handleViewFile can enter containers.
  const activePanelNavigateRef = useRef(left.navigateTo);
  activePanelNavigateRef.current = activePanel === "left" ? left.navigateTo : right.navigateTo;

  const leftRef = useRef(left);
  leftRef.current = left;
  const rightRef = useRef(right);
  rightRef.current = right;

  const activeCwdForExecuteRef = useRef("");

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
      const panel = activePanelRef.current === "left" ? leftRef.current : rightRef.current;
      const cwd = panel.currentPath;

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
        if (!(await isExistingDirectory(path))) {
          showDialog({
            type: "message",
            title: "cd",
            message: `Folder not found: ${path}`,
            variant: "error",
          });
          return;
        }
        await panel.navigateTo(path);
        return;
      }

      if (parsed.kind === "chdir") {
        const target = await resolveCdPath(parsed.pathArg, cwd);
        if (!(await isExistingDirectory(target))) {
          showDialog({
            type: "message",
            title: "cd",
            message: `Path not found: ${target}`,
            variant: "error",
          });
          return;
        }
        await panel.navigateTo(target);
      }
    },
    [showDialog],
  );

  useEffect(() => {
    setCommandLineOnExecute(() => handleCommandLineExecute);
  }, [handleCommandLineExecute, setCommandLineOnExecute]);

  const { handleCopy, handleMove, handleMoveToTrash, handlePermanentDelete, handleRename } = useFileOperations(
    activePanelRef,
    leftRef,
    rightRef,
    setSelectionKey,
  );

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
    commandRegistry.setContext("leftPanelActive", activePanel === "left");
    commandRegistry.setContext("rightPanelActive", activePanel === "right");
  }, [activePanel]);

  // Set context when a dialog is open (e.g. so Tab doesn't switch panel)
  useEffect(() => {
    commandRegistry.setContext("dialogOpen", dialog !== null);
  }, [dialog]);

  const handleViewFile = useCallback((filePath: string, fileName: string, fileSize: number) => {
    // If an fsProvider is registered for this file type, enter it like a directory.
    if (fsProviderRegistry.resolve(basename(filePath))) {
      void activePanelNavigateRef.current(filePath + CONTAINER_SEP);
      return;
    }
    setViewerFile({
      path: filePath,
      name: fileName,
      size: fileSize,
      panel: activePanelRef.current,
    });
  }, []);

  const handleEditFile = useCallback((filePath: string, fileName: string, fileSize: number, langId: string) => {
    setEditorFile({ path: filePath, name: fileName, size: fileSize, langId });
  }, []);

  const handleOpenCreateFileConfirm = useCallback(async (filePath: string, fileName: string, langId: string) => {
    const exists = await bridge.fs.exists(filePath);
    if (!exists) {
      await bridge.fs.writeFile(filePath, "");
    }
    const size = exists ? (await bridge.fs.stat(filePath)).size : 0;
    setEditorFile({ path: filePath, name: fileName, size, langId });
  }, []);

  const viewerPanelEntries = viewerFile ? (viewerFile.panel === "left" ? left.entries : right.entries) : [];

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
  const leftRequestedCursor = left.requestedCursor ?? (viewerFile?.panel === "left" ? viewerActiveName : undefined);
  const rightRequestedCursor = right.requestedCursor ?? (viewerFile?.panel === "right" ? viewerActiveName : undefined);

  // Panel state persistence with long debounce (10s) to avoid excessive writes
  const panelStateSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingPanelStateRef = useRef<{
    leftPanel?: PanelPersistedState;
    rightPanel?: PanelPersistedState;
  }>({});

  const buildPersistedTabs = useCallback((side: PanelSide, tabs: PanelTab[], activeTabId: string): { tabs: PersistedTab[]; activeTabIndex: number } => {
    const selectionRef = side === "left" ? leftTabSelectionRef : rightTabSelectionRef;
    const persisted: PersistedTab[] = tabs.map((tab) => {
      if (tab.type === "filelist") {
        const sel = selectionRef.current[tab.id];
        const pt: PersistedTab = { type: "filelist", path: tab.path };
        if (sel?.selectedName != null) pt.selectedName = sel.selectedName;
        if (sel?.topmostName != null) pt.topmostName = sel.topmostName;
        return pt;
      }
      return { type: "preview", path: tab.path, name: tab.name, size: tab.size };
    });
    const activeTabIndex = Math.max(
      0,
      tabs.findIndex((t) => t.id === activeTabId),
    );
    return { tabs: persisted, activeTabIndex };
  }, []);

  const flushPanelState = useCallback(() => {
    if (panelStateSaveTimerRef.current) {
      clearTimeout(panelStateSaveTimerRef.current);
      panelStateSaveTimerRef.current = null;
    }
    const pending = pendingPanelStateRef.current;
    for (const side of PANEL_SIDES) {
      const key = PANEL_SETTINGS_KEY[side];
      if (!pending[key]) {
        pending[key] = { currentPath: side === "left" ? left.currentPath : right.currentPath };
      }
      const tabsRef = side === "left" ? leftTabsRef : rightTabsRef;
      const activeTabIdRef = side === "left" ? leftActiveTabIdRef : rightActiveTabIdRef;
      Object.assign(pending[key]!, buildPersistedTabs(side, tabsRef.current, activeTabIdRef.current));
    }
    updateSettings(pending);
    pendingPanelStateRef.current = {};
  }, [buildPersistedTabs, left.currentPath, right.currentPath]);

  const savePanelStateDebounced = useCallback(() => {
    if (panelStateSaveTimerRef.current) {
      clearTimeout(panelStateSaveTimerRef.current);
    }
    panelStateSaveTimerRef.current = setTimeout(() => {
      panelStateSaveTimerRef.current = null;
      updateSettings(pendingPanelStateRef.current);
      pendingPanelStateRef.current = {};
    }, 10000); // 10 second debounce
  }, []);

  // Flush panel state on window close
  useEffect(() => {
    const handleBeforeUnload = () => {
      flushPanelState();
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [flushPanelState]);

  const handlePanelStateChange = useCallback(
    (side: PanelSide, selectedName: string | undefined, topmostName: string | undefined) => {
      const selfTabsRef = side === "left" ? leftTabsRef : rightTabsRef;
      const selfActiveTabIdRef = side === "left" ? leftActiveTabIdRef : rightActiveTabIdRef;
      const selfTabSelRef = side === "left" ? leftTabSelectionRef : rightTabSelectionRef;
      const selfSelectedNameRef = side === "left" ? leftSelectedNameRef : rightSelectedNameRef;
      const panel = side === "left" ? left : right;

      const tab = selfTabsRef.current.find((t) => t.id === selfActiveTabIdRef.current);
      if (tab?.type === "filelist") {
        selfTabSelRef.current[tab.id] = { selectedName, topmostName };
      }
      selfSelectedNameRef.current = selectedName;
      pendingPanelStateRef.current[PANEL_SETTINGS_KEY[side]] = {
        currentPath: panel.currentPath,
        ...buildPersistedTabs(side, selfTabsRef.current, selfActiveTabIdRef.current),
      };
      savePanelStateDebounced();

      const opposite = OPPOSITE_PANEL[side];
      const oppTabsRef = opposite === "left" ? leftTabsRef : rightTabsRef;
      const setOppTabs = opposite === "right" ? setRightTabs : setLeftTabs;
      const setOppActiveId = opposite === "right" ? setRightActiveTabId : setLeftActiveTabId;
      const tabs = oppTabsRef.current;
      const tempTab = tabs.find((t) => t.type === "preview" && t.isTemp && t.sourcePanel === side);
      if (!tempTab || !selectedName) return;
      const entry = panel.entries.find((e) => e.name === selectedName);
      if (!entry || entry.type !== "file") return;
      const path = entry.path as string;
      const name = entry.name;
      const size = Number(entry.meta.size);
      if (tempTab.type === "preview" && tempTab.path === path && tempTab.name === name) return;
      setOppTabs((prev) =>
        prev.map((t) => (t.id === tempTab.id ? { id: t.id, type: "preview" as const, path, name, size, isTemp: true, sourcePanel: side } : t)),
      );
      setOppActiveId(tempTab.id);
    },
    [left, right, buildPersistedTabs, savePanelStateDebounced],
  );

  // Save active panel when it changes (only after settings loaded to avoid overwriting on mount)
  useEffect(() => {
    if (!settingsLoaded) return;
    updateSettings({ activePanel });
  }, [activePanel, settingsLoaded]);

  const handleOpenCurrentFolderInOppositeCurrentTab = useCallback(() => {
    const side = activePanelRef.current;
    const opposite = OPPOSITE_PANEL[side];
    const path = side === "left" ? left.currentPath : right.currentPath;
    const activeTabId = (opposite === "left" ? leftActiveTabIdRef : rightActiveTabIdRef).current;
    const setTabs = opposite === "left" ? setLeftTabs : setRightTabs;
    const panel = opposite === "left" ? left : right;
    setTabs((prev) => prev.map((t) => (t.id === activeTabId && t.type === "filelist" ? { ...t, path } : t)));
    panel.navigateTo(path);
    setActivePanel(opposite);
  }, [left.currentPath, right.currentPath, left, right]);

  const handleOpenCurrentFolderInOppositeNewTab = useCallback(() => {
    const side = activePanelRef.current;
    const opposite = OPPOSITE_PANEL[side];
    const path = side === "left" ? left.currentPath : right.currentPath;
    const newTab = createFilelistTab(path);
    const setTabs = opposite === "left" ? setLeftTabs : setRightTabs;
    const setActiveId = opposite === "left" ? setLeftActiveTabId : setRightActiveTabId;
    const panel = opposite === "left" ? left : right;
    setTabs((prev) => [...prev, newTab]);
    setActiveId(newTab.id);
    panel.navigateTo(path);
    setActivePanel(opposite);
  }, [left.currentPath, right.currentPath, left, right]);

  const handleOpenSelectedFolderInOppositeCurrentTab = useCallback(() => {
    const side = activePanelRef.current;
    const entries = side === "left" ? left.entries : right.entries;
    const selectedName = side === "left" ? leftSelectedNameRef.current : rightSelectedNameRef.current;
    const entry = selectedName ? entries.find((e) => e.name === selectedName) : undefined;
    if (!entry || entry.type !== "folder") return;
    const path = entry.path as string;
    const opposite = OPPOSITE_PANEL[side];
    const activeTabId = (opposite === "left" ? leftActiveTabIdRef : rightActiveTabIdRef).current;
    const setTabs = opposite === "left" ? setLeftTabs : setRightTabs;
    const panel = opposite === "left" ? left : right;
    setTabs((prev) => prev.map((t) => (t.id === activeTabId && t.type === "filelist" ? { ...t, path } : t)));
    panel.navigateTo(path);
    setActivePanel(opposite);
  }, [left.entries, right.entries, left, right]);

  const handleOpenSelectedFolderInOppositeNewTab = useCallback(() => {
    const side = activePanelRef.current;
    const entries = side === "left" ? left.entries : right.entries;
    const selectedName = side === "left" ? leftSelectedNameRef.current : rightSelectedNameRef.current;
    const entry = selectedName ? entries.find((e) => e.name === selectedName) : undefined;
    if (!entry || entry.type !== "folder") return;
    const path = entry.path as string;
    const opposite = OPPOSITE_PANEL[side];
    const newTab = createFilelistTab(path);
    const setTabs = opposite === "left" ? setLeftTabs : setRightTabs;
    const setActiveId = opposite === "left" ? setLeftActiveTabId : setRightActiveTabId;
    const panel = opposite === "left" ? left : right;
    setTabs((prev) => [...prev, newTab]);
    setActiveId(newTab.id);
    panel.navigateTo(path);
    setActivePanel(opposite);
  }, [left.entries, right.entries, left, right]);

  const handlePreviewInOppositePanel = useCallback(() => {
    const side = activePanelRef.current;
    const entries = side === "left" ? left.entries : right.entries;
    const selectedName = side === "left" ? leftSelectedNameRef.current : rightSelectedNameRef.current;
    const entry = selectedName ? entries.find((e) => e.name === selectedName) : undefined;
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
      setTabs((prev) => prev.map((t) => (t.id === tempTab.id ? { ...t, path, name, size, sourcePanel } : t)));
      setActiveId(tempTab.id);
    } else {
      const newTab = createPreviewTab(path, name, size, sourcePanel);
      setTabs((prev) => [...prev, newTab]);
      setActiveId(newTab.id);
    }
    setActivePanel(opposite);
  }, [left.entries, right.entries]);

  useEffect(() => {
    bridge.theme.get().then((t) => setTheme(t as ThemeKind));
    return bridge.theme.onChange((t) => setTheme(t as ThemeKind));
  }, []);

  const isBrowser = !isTauriApp();

  const leftPathRef = useRef(left.currentPath);
  leftPathRef.current = left.currentPath;
  const rightPathRef = useRef(right.currentPath);
  rightPathRef.current = right.currentPath;

  // Sync panel path with active filelist tab.
  // Only navigate when the user *switches* tabs (activeTabId changes). Do NOT depend on leftTabs/rightTabs
  // or we get a loop: panel path change → we update tab path → this effect runs with stale tab.path → navigates back.
  const prevLeftActiveTabIdRef = useRef(leftActiveTabId);
  const prevRightActiveTabIdRef = useRef(rightActiveTabId);
  useEffect(() => {
    if (prevLeftActiveTabIdRef.current === leftActiveTabId) return;
    prevLeftActiveTabIdRef.current = leftActiveTabId;
    const tab = leftTabsRef.current.find((t) => t.id === leftActiveTabId);
    if (tab?.type === "filelist" && tab.path != null) {
      left.navigateTo(tab.path);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only run on tab switch; adding leftTabs/left would cause navigate loop
  }, [leftActiveTabId]);
  useEffect(() => {
    if (prevRightActiveTabIdRef.current === rightActiveTabId) return;
    prevRightActiveTabIdRef.current = rightActiveTabId;
    const tab = rightTabsRef.current.find((t) => t.id === rightActiveTabId);
    if (tab?.type === "filelist" && tab.path != null) {
      right.navigateTo(tab.path);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only run on tab switch; adding rightTabs/right would cause navigate loop
  }, [rightActiveTabId]);
  // Only sync panel path → tab path when the path actually changed (user navigated), not when active tab index changed
  const prevLeftPathRef = useRef(left.currentPath);
  const prevRightPathRef = useRef(right.currentPath);
  useEffect(() => {
    if (prevLeftPathRef.current === left.currentPath) return;
    prevLeftPathRef.current = left.currentPath;
    setLeftTabs((prev) => {
      const idx = prev.findIndex((t) => t.id === leftActiveTabId);
      if (idx < 0) return prev;
      const tab = prev[idx];
      if (tab?.type !== "filelist" || tab.path === left.currentPath) return prev;
      const next = [...prev];
      next[idx] = { ...tab, path: left.currentPath };
      return next;
    });
  }, [left.currentPath, leftActiveTabId]);
  useEffect(() => {
    if (prevRightPathRef.current === right.currentPath) return;
    prevRightPathRef.current = right.currentPath;
    setRightTabs((prev) => {
      const idx = prev.findIndex((t) => t.id === rightActiveTabId);
      if (idx < 0) return prev;
      const tab = prev[idx];
      if (tab?.type !== "filelist" || tab.path === right.currentPath) return prev;
      const next = [...prev];
      next[idx] = { ...tab, path: right.currentPath };
      return next;
    });
  }, [right.currentPath, rightActiveTabId]);

  // Navigate panels using persisted state or defaults — fires once when settings are loaded
  useEffect(() => {
    if (!settingsLoaded) return;

    const browserPath = (() => {
      if (!isBrowser) return "";
      const url = new URL(window.location.href);
      const queryPath = url.searchParams.get("path");
      if (queryPath) return queryPath;
      const pathName = decodeURIComponent(url.pathname);
      return pathName.length > 1 ? pathName : "";
    })();

    const hasUrlPath = browserPath.length > 0;

    const navigatePanel = async (panel: typeof left, persistedState: PanelPersistedState | undefined, fallbackPath?: string) => {
      let targetPath = persistedState?.currentPath ?? fallbackPath;

      if (targetPath) {
        const exists = await bridge.fs.exists(targetPath);
        if (!exists) {
          targetPath = await findExistingParent(targetPath);
        }
      }

      if (!targetPath) {
        targetPath = await bridge.utils.getHomePath();
      }

      await panel.navigateTo(targetPath);
    };

    if (hasUrlPath) {
      bridge.fs.exists(browserPath).then(async (exists) => {
        if (exists) {
          left.navigateTo(browserPath);
        } else {
          const parent = await findExistingParent(browserPath);
          left.navigateTo(parent);
          showError(`Directory not found: ${browserPath}`);
        }
      });
      navigatePanel(right, initialRightPanel);
    } else {
      navigatePanel(left, initialLeftPanel);
      navigatePanel(right, initialRightPanel);
      if (initialActivePanel) {
        setActivePanel(initialActivePanel);
      }
    }

    // Clear initial state after first navigation to prevent cursor jumping
    // when viewer is closed (was falling back to initial per-tab selection)
    setTimeout(() => {
      setInitialLeftPanel(undefined);
      setInitialRightPanel(undefined);
      setInitialActivePanel(undefined);
    }, 500);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally fires once when settingsLoaded becomes true
  }, [settingsLoaded]);

  useExtensionHost({
    settingsLoaded,
    onRefreshPanels: () => {
      leftRef.current.refresh();
      rightRef.current.refresh();
    },
  });

  const onNavigatePanel = useCallback((path: string) => {
    (activePanelRef.current === "left" ? leftRef.current : rightRef.current).navigateTo(path);
  }, []);

  const terminal = useTerminal({
    activePanelCwd: activePanel === "left" ? left.currentPath : right.currentPath,
    onNavigatePanel,
  });
  activeCwdForExecuteRef.current = terminal.activeCwd;

  useBuiltInCommands({
    leftRef,
    rightRef,
    onPreviewInOppositePanel: handlePreviewInOppositePanel,
    onOpenCurrentFolderInOppositeCurrentTab: handleOpenCurrentFolderInOppositeCurrentTab,
    onOpenCurrentFolderInOppositeNewTab: handleOpenCurrentFolderInOppositeNewTab,
    onOpenSelectedFolderInOppositeCurrentTab: handleOpenSelectedFolderInOppositeCurrentTab,
    onOpenSelectedFolderInOppositeNewTab: handleOpenSelectedFolderInOppositeNewTab,
    onOpenCreateFileConfirm: handleOpenCreateFileConfirm,
    showDialog,
    onViewFile: handleViewFile,
    onEditFile: handleEditFile,
    onExecuteInTerminal: (cmd) => terminal.writeToTerminal(cmd),
    editorFileSizeLimit,
  });

  const activePath = activePanel === "left" ? left.currentPath : right.currentPath;
  useEffect(() => {
    if (isBrowser && activePath) {
      const url = new URL(window.location.href);
      url.pathname = "/";
      url.search = `?path=${encodeURIComponent(activePath)}`;
      history.replaceState(null, "", url.toString());
    }
  }, [activePath]);

  useEffect(() => {
    if (bridge.onReconnect) {
      return bridge.onReconnect(() => {
        leftRef.current.navigateTo(leftPathRef.current);
        rightRef.current.navigateTo(rightPathRef.current);
      });
    }
  }, []);

  if (!left.currentPath || !right.currentPath || !themesReady) {
    return <div className="loading">Loading...</div>;
  }

  return (
    <div className="app">
      <>
        <div className="terminal-and-panels">
          <div className={`terminal-background${panelsVisible ? "" : " expanded"}`}>
            <TerminalPanelBody />
          </div>
          <div className={`panels-overlay${panelsVisible ? "" : " hidden"}`}>
            <PanelGroup
              side="left"
              panel={left}
              onRememberExpectedTerminalCwd={terminal.rememberExpectedTerminalCwd}
              selectionKey={selectionKey}
              requestedActiveName={leftRequestedCursor}
              initialPanelState={initialLeftPanel}
              onStateChange={(sel, top) => handlePanelStateChange("left", sel, top)}
            />
            <PanelGroup
              side="right"
              panel={right}
              onRememberExpectedTerminalCwd={terminal.rememberExpectedTerminalCwd}
              selectionKey={selectionKey}
              requestedActiveName={rightRequestedCursor}
              initialPanelState={initialRightPanel}
              onStateChange={(sel, top) => handlePanelStateChange("right", sel, top)}
            />
          </div>
        </div>
        <CommandLine />
        <TerminalToolbar />
      </>
      <ActionBar />
      {viewerFile && !viewerResolved && (
        <ModalDialog
          title="No viewer"
          message="No viewer extension found for this file type. Install viewer extensions (e.g. Image Viewer, File Viewer) from the extensions panel."
          onClose={() => setViewerFile(null)}
        />
      )}
      {viewerExt && (
        <ViewerContainer
          key={`viewer:${viewerExt.dirPath}:${viewerExt.entry}`}
          extensionDirPath={viewerExt.dirPath}
          entry={viewerExt.entry}
          filePath={viewerFile?.path ?? ""}
          fileName={viewerFile?.name ?? ""}
          fileSize={viewerFile?.size ?? 0}
          visible={viewerFile != null && viewerResolved != null}
          onClose={() => setViewerFile(null)}
          onExecuteCommand={handleExecuteCommand}
        />
      )}
      {editorFile && !editorResolved && (
        <ModalDialog
          title="No editor"
          message="No editor extension found for this file type. Install an editor extension (e.g. Monaco Editor) from the extensions panel."
          onClose={() => setEditorFile(null)}
        />
      )}
      {editorExt &&
        (() => {
          const allLanguages = loadedExtensions.flatMap((e) => e.languages ?? []);
          const allGrammarRefs = loadedExtensions.flatMap((e) => e.grammarRefs ?? []);
          const grammars = allGrammarRefs.map((gr) => ({
            contribution: gr.contribution,
            path: gr.path,
          }));
          return (
            <EditorContainer
              key={`editor:${editorExt.dirPath}:${editorExt.entry}`}
              extensionDirPath={editorExt.dirPath}
              entry={editorExt.entry}
              filePath={editorFile?.path ?? ""}
              fileName={editorFile?.name ?? ""}
              langId={editorFile?.langId ?? "plaintext"}
              visible={editorFile != null && editorResolved != null}
              onClose={() => setEditorFile(null)}
              languages={allLanguages}
              grammars={grammars}
            />
          );
        })()}
      {showExtensions && <ExtensionsPanel />}
      <DialogHolder />
      <CommandPalette open={commandPalette.open} onOpenChange={commandPalette.setOpen} />
    </div>
  );
}
