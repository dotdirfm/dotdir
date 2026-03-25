import { isTauri as isTauriApp } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { ThemeKind } from "fss-lang";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActionBar } from "./ActionBar";
import {
  activeColorThemeAtom,
  activeIconThemeAtom,
  commandLineOnExecuteAtom,
  commandLinePasteFnAtom,
  loadedExtensionsAtom,
  osThemeAtom,
  panelsVisibleAtom,
  promptActiveAtom,
  showExtensionsAtom,
  themesReadyAtom,
} from "./atoms";
import { bridge } from "./bridge";
import { CommandLine } from "./CommandLine";
import { isExistingDirectory, parseCdCommand, resolveCdPath } from "./commandLineCd";
import { CommandPalette, useCommandPalette } from "./CommandPalette";
import { commandRegistry } from "./commands";
import { CONTAINER_SEP, isContainerPath, parseContainerPath } from "./containerPath";
import { DialogHolder, useDialog } from "./dialogContext";
import { EditorContainer, ViewerContainer } from "./ExtensionContainer";
import { DEFAULT_EDITOR_FILE_SIZE_LIMIT, type PanelPersistedState, type PersistedTab } from "./extensions";
import { ExtensionsPanel } from "./ExtensionsPanel";
import type { PanelTab } from "./FileList/PanelTabs";
import { focusContext } from "./focusContext";
import { isMediaFile } from "./mediaFiles";
import { ModalDialog } from "./ModalDialog";
import type { LanguageOption } from "./OpenCreateFileDialog";
import { PanelGroup } from "./PanelGroup";
import { OPPOSITE_PANEL, PANEL_SETTINGS_KEY, PANEL_SIDES } from "./panelSide";
import { basename, dirname, normalizePath, resolveDotSegments } from "./path";
import { registerAppBuiltInKeybindings } from "./registerKeybindings";
import { normalizeTerminalPath } from "./terminal/path";
import { useExtensionHost } from "./useExtensionHost";
import { useFileOperations, type PanelSide } from "./useFileOperations";
import { findExistingParent, usePanel } from "./usePanel";
import { useTerminal } from "./useTerminal";
import { initUserKeybindings } from "./userKeybindings";
import { getSettings, initUserSettings, onSettingsChange, updateSettings } from "./userSettings";
import { editorRegistry, fsProviderRegistry, viewerRegistry } from "./viewerEditorRegistry";
import { TerminalPanelBody, TerminalToolbar } from "./Terminal";

let nextTabId = 0;
function genTabId(): string {
  return `tab-${++nextTabId}`;
}

function createFilelistTab(path: string): PanelTab {
  return { id: genTabId(), type: "filelist", path };
}

function createPreviewTab(path: string, name: string, size: number, sourcePanel: PanelSide): PanelTab {
  return {
    id: genTabId(),
    type: "preview",
    path,
    name,
    size,
    isTemp: true,
    sourcePanel,
  };
}

export function App() {
  const setTheme = useSetAtom(osThemeAtom);
  const { dialog, showDialog, closeDialog, updateDialog } = useDialog();
  const [showHidden, setShowHidden] = useState(false);
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
  const [activePanel, setActivePanel] = useState<PanelSide>("left");
  const panelsVisible = useAtomValue(panelsVisibleAtom);
  const promptActive = useAtomValue(promptActiveAtom);
  const setPanelsVisible = useSetAtom(panelsVisibleAtom);
  const [viewerFile, setViewerFile] = useState<{ path: string; name: string; size: number; panel: PanelSide } | null>(null);
  const [editorFile, setEditorFile] = useState<{ path: string; name: string; size: number; langId: string } | null>(null);
  const [viewerExt, setViewerExt] = useState<{ dirPath: string; entry: string } | null>(null);
  const [editorExt, setEditorExt] = useState<{ dirPath: string; entry: string } | null>(null);
  const [showExtensions, setShowExtensions] = useAtom(showExtensionsAtom);
  const setActiveIconTheme = useSetAtom(activeIconThemeAtom);
  const setActiveColorTheme = useSetAtom(activeColorThemeAtom);
  const [editorFileSizeLimit, setEditorFileSizeLimit] = useState(DEFAULT_EDITOR_FILE_SIZE_LIMIT);
  const [initialLeftPanel, setInitialLeftPanel] = useState<PanelPersistedState | undefined>(undefined);
  const [initialRightPanel, setInitialRightPanel] = useState<PanelPersistedState | undefined>(undefined);
  const [initialActivePanel, setInitialActivePanel] = useState<PanelSide | undefined>(undefined);
  const [leftTabs, setLeftTabs] = useState<PanelTab[]>(() => [createFilelistTab("")]);
  const [rightTabs, setRightTabs] = useState<PanelTab[]>(() => [createFilelistTab("")]);
  const [leftActiveIndex, setLeftActiveIndex] = useState(0);
  const [rightActiveIndex, setRightActiveIndex] = useState(0);
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
  const leftActiveIndexRef = useRef(leftActiveIndex);
  leftActiveIndexRef.current = leftActiveIndex;
  const rightActiveIndexRef = useRef(rightActiveIndex);
  rightActiveIndexRef.current = rightActiveIndex;
  const [selectionKey, setSelectionKey] = useState(0);
  const commandPalette = useCommandPalette();
  const setCommandLineOnExecute = useSetAtom(commandLineOnExecuteAtom);
  const commandLinePasteFnAtomValue = useAtomValue(commandLinePasteFnAtom);
  const commandLinePasteRef = useRef<(text: string) => void>(() => {});
  if (commandLinePasteFnAtomValue) commandLinePasteRef.current = commandLinePasteFnAtomValue;

  useEffect(() => {
    // Initialize settings with watch
    initUserSettings().then((s) => {
      if (s.iconTheme) setActiveIconTheme(s.iconTheme);
      if (s.colorTheme) setActiveColorTheme(s.colorTheme);
      if (s.editorFileSizeLimit !== undefined) setEditorFileSizeLimit(s.editorFileSizeLimit);
      if (s.showHidden !== undefined) setShowHidden(s.showHidden);

      // Restore tabs from persisted state
      const restoreTabs = (panel: PanelPersistedState | undefined) => {
        if (panel?.tabs?.length) {
          return panel.tabs.map((t) => createFilelistTab(t.path));
        }
        if (panel?.currentPath) {
          return [createFilelistTab(panel.currentPath)];
        }
        return null;
      };

      const leftPanelM = s.leftPanel;
      const rightPanelM = s.rightPanel;

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

      const restoredLeftTabs = restoreTabs(leftPanelM);
      const restoredRightTabs = restoreTabs(rightPanelM);
      if (restoredLeftTabs) seedTabSelections(leftTabSelectionRef, restoredLeftTabs, leftPanelM);
      if (restoredRightTabs) seedTabSelections(rightTabSelectionRef, restoredRightTabs, rightPanelM);
      const restoredLeftIndex = restoredLeftTabs ? Math.min(leftPanelM?.activeTabIndex ?? 0, restoredLeftTabs.length - 1) : 0;
      const restoredRightIndex = restoredRightTabs ? Math.min(rightPanelM?.activeTabIndex ?? 0, restoredRightTabs.length - 1) : 0;

      // Update prev refs so tab sync effects don't fire redundantly
      prevLeftActiveIndexRef.current = restoredLeftIndex;
      prevRightActiveIndexRef.current = restoredRightIndex;

      if (restoredLeftTabs) setLeftTabs(restoredLeftTabs);
      if (restoredRightTabs) setRightTabs(restoredRightTabs);
      setLeftActiveIndex(restoredLeftIndex);
      setRightActiveIndex(restoredRightIndex);

      if (leftPanelM) setInitialLeftPanel(leftPanelM);
      if (rightPanelM) setInitialRightPanel(rightPanelM);
      if (s.activePanel) setInitialActivePanel(s.activePanel);
      setSettingsLoaded(true);
    });

    // Listen for settings changes (but don't update panel state from external changes)
    const unsubscribe = onSettingsChange((s) => {
      if (s.iconTheme) setActiveIconTheme(s.iconTheme);
      if (s.colorTheme !== undefined) setActiveColorTheme(s.colorTheme || undefined);
      if (s.editorFileSizeLimit !== undefined) setEditorFileSizeLimit(s.editorFileSizeLimit);
      if (s.showHidden !== undefined) setShowHidden(s.showHidden);
    });

    initUserKeybindings();

    return unsubscribe;
  }, []);

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
          ...getSettings().pathAliases,
          [parsed.alias]: normalizeTerminalPath(cwd),
        };
        updateSettings({ pathAliases: aliases });
        return;
      }

      if (parsed.kind === "goAlias") {
        const raw = getSettings().pathAliases?.[parsed.alias];
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

  const buildPersistedTabs = useCallback((side: PanelSide, tabs: PanelTab[], activeIdx: number): { tabs: PersistedTab[]; activeTabIndex: number } => {
    const selectionRef = side === "left" ? leftTabSelectionRef : rightTabSelectionRef;
    const persisted: PersistedTab[] = [];
    let mappedIdx = 0;
    for (let i = 0; i < tabs.length; i++) {
      const tab = tabs[i];
      if (tab.type === "filelist") {
        if (i === activeIdx) mappedIdx = persisted.length;
        const sel = selectionRef.current[tab.id];
        const pt: PersistedTab = { type: "filelist", path: tab.path };
        if (sel?.selectedName != null) pt.selectedName = sel.selectedName;
        if (sel?.topmostName != null) pt.topmostName = sel.topmostName;
        persisted.push(pt);
      }
    }
    return { tabs: persisted, activeTabIndex: mappedIdx };
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
      const activeIdxRef = side === "left" ? leftActiveIndexRef : rightActiveIndexRef;
      Object.assign(pending[key]!, buildPersistedTabs(side, tabsRef.current, activeIdxRef.current));
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
      const selfActiveIdxRef = side === "left" ? leftActiveIndexRef : rightActiveIndexRef;
      const selfTabSelRef = side === "left" ? leftTabSelectionRef : rightTabSelectionRef;
      const selfSelectedNameRef = side === "left" ? leftSelectedNameRef : rightSelectedNameRef;
      const panel = side === "left" ? left : right;

      const tab = selfTabsRef.current[selfActiveIdxRef.current];
      if (tab?.type === "filelist") {
        selfTabSelRef.current[tab.id] = { selectedName, topmostName };
      }
      selfSelectedNameRef.current = selectedName;
      pendingPanelStateRef.current[PANEL_SETTINGS_KEY[side]] = {
        currentPath: panel.currentPath,
        ...buildPersistedTabs(side, selfTabsRef.current, selfActiveIdxRef.current),
      };
      savePanelStateDebounced();

      const opposite = OPPOSITE_PANEL[side];
      const oppTabsRef = opposite === "left" ? leftTabsRef : rightTabsRef;
      const setOppTabs = opposite === "right" ? setRightTabs : setLeftTabs;
      const setOppActiveIndex = opposite === "right" ? setRightActiveIndex : setLeftActiveIndex;
      const tabs = oppTabsRef.current;
      const tempIdx = tabs.findIndex((t) => t.type === "preview" && t.isTemp && t.sourcePanel === side);
      if (tempIdx < 0 || !selectedName) return;
      const entry = panel.entries.find((e) => e.name === selectedName);
      if (!entry || entry.type !== "file") return;
      const path = entry.path as string;
      const name = entry.name;
      const size = Number(entry.meta.size);
      const current = tabs[tempIdx];
      if (current.type === "preview" && current.path === path && current.name === name) return;
      const next = [...tabs];
      next[tempIdx] = {
        id: current.id,
        type: "preview" as const,
        path,
        name,
        size,
        isTemp: true,
        sourcePanel: side,
      };
      setOppTabs(next);
      setOppActiveIndex(tempIdx);
    },
    [left, right, buildPersistedTabs, savePanelStateDebounced],
  );

  // Save active panel when it changes (only after settings loaded to avoid overwriting on mount)
  useEffect(() => {
    if (!settingsLoaded) return;
    updateSettings({ activePanel });
  }, [activePanel, settingsLoaded]);

  const handleNewTab = useCallback(
    (side: PanelSide) => {
      const path = side === "left" ? left.currentPath : right.currentPath;
      const newTab = createFilelistTab(path);
      const setTabs = side === "left" ? setLeftTabs : setRightTabs;
      const setIdx = side === "left" ? setLeftActiveIndex : setRightActiveIndex;
      const panel = side === "left" ? left : right;
      setTabs((prev) => {
        const next = [...prev, newTab];
        queueMicrotask(() => setIdx(next.length - 1));
        return next;
      });
      panel.navigateTo(path);
    },
    [left.currentPath, right.currentPath, left, right],
  );

  const handleCloseTab = useCallback(
    async (side: PanelSide, index: number) => {
      const tabs = side === "left" ? leftTabs : rightTabs;
      const activeIdx = side === "left" ? leftActiveIndex : rightActiveIndex;
      const setTabs = side === "left" ? setLeftTabs : setRightTabs;
      const setActiveIndex = side === "left" ? setLeftActiveIndex : setRightActiveIndex;
      const panel = side === "left" ? left : right;
      if (tabs.length > 1) {
        const next = tabs.filter((_, i) => i !== index);
        const newIdx = activeIdx === index ? Math.min(activeIdx, next.length - 1) : activeIdx > index ? activeIdx - 1 : activeIdx;
        setTabs(next);
        setActiveIndex(newIdx);
        return;
      }
      const home = await bridge.utils.getHomePath();
      const newTab = createFilelistTab(home);
      setTabs([newTab]);
      setActiveIndex(0);
      panel.navigateTo(home);
    },
    [leftTabs, rightTabs, leftActiveIndex, rightActiveIndex, left, right],
  );

  const handleReorderTabs = useCallback(
    (side: PanelSide, fromIndex: number, toIndex: number) => {
      const tabs = side === "left" ? leftTabs : rightTabs;
      const activeIdx = side === "left" ? leftActiveIndex : rightActiveIndex;
      const setTabs = side === "left" ? setLeftTabs : setRightTabs;
      const setActiveIndex = side === "left" ? setLeftActiveIndex : setRightActiveIndex;
      const next = [...tabs];
      const [moved] = next.splice(fromIndex, 1);
      next.splice(toIndex, 0, moved);
      let newActiveIdx = activeIdx;
      if (activeIdx === fromIndex) {
        newActiveIdx = toIndex;
      } else {
        if (fromIndex < activeIdx && toIndex >= activeIdx) newActiveIdx--;
        else if (fromIndex > activeIdx && toIndex <= activeIdx) newActiveIdx++;
      }
      setTabs(next);
      setActiveIndex(newActiveIdx);
    },
    [leftTabs, rightTabs, leftActiveIndex, rightActiveIndex],
  );

  const handlePinTab = useCallback((side: PanelSide, index: number) => {
    const setTabs = side === "left" ? setLeftTabs : setRightTabs;
    setTabs((prev) => {
      const t = prev[index];
      if (t?.type !== "preview" || !t.isTemp) return prev;
      const next = [...prev];
      next[index] = { ...t, isTemp: false };
      return next;
    });
  }, []);

  const handleOpenCurrentFolderInOppositeCurrentTab = useCallback(() => {
    const side = activePanelRef.current;
    const opposite = side === "left" ? "right" : "left";
    const path = side === "left" ? left.currentPath : right.currentPath;
    const tabs = opposite === "right" ? rightTabs : leftTabs;
    const activeIdx = opposite === "right" ? rightActiveIndex : leftActiveIndex;
    const tab = tabs[activeIdx];
    if (tab?.type !== "filelist") return;
    const setTabs = opposite === "right" ? setRightTabs : setLeftTabs;
    const panel = opposite === "right" ? right : left;
    setTabs((prev) => {
      const next = [...prev];
      const t = next[activeIdx];
      if (t?.type !== "filelist") return prev;
      next[activeIdx] = { ...t, path };
      return next;
    });
    panel.navigateTo(path);
    setActivePanel(opposite);
  }, [left.currentPath, right.currentPath, leftTabs, rightTabs, leftActiveIndex, rightActiveIndex, left, right]);

  const handleOpenCurrentFolderInOppositeNewTab = useCallback(() => {
    const side = activePanelRef.current;
    const opposite = side === "left" ? "right" : "left";
    const path = side === "left" ? left.currentPath : right.currentPath;
    const newTab = createFilelistTab(path);
    const setTabs = opposite === "right" ? setRightTabs : setLeftTabs;
    const setIdx = opposite === "right" ? setRightActiveIndex : setLeftActiveIndex;
    const panel = opposite === "right" ? right : left;
    setTabs((prev) => {
      const next = [...prev, newTab];
      queueMicrotask(() => setIdx(next.length - 1));
      return next;
    });
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
    const opposite = side === "left" ? "right" : "left";
    const tabs = opposite === "right" ? rightTabs : leftTabs;
    const activeIdx = opposite === "right" ? rightActiveIndex : leftActiveIndex;
    const tab = tabs[activeIdx];
    if (tab?.type !== "filelist") return;
    const setTabs = opposite === "right" ? setRightTabs : setLeftTabs;
    const panel = opposite === "right" ? right : left;
    setTabs((prev) => {
      const next = [...prev];
      const t = next[activeIdx];
      if (t?.type !== "filelist") return prev;
      next[activeIdx] = { ...t, path };
      return next;
    });
    panel.navigateTo(path);
    setActivePanel(opposite);
  }, [left.entries, right.entries, leftTabs, rightTabs, leftActiveIndex, rightActiveIndex, left, right]);

  const handleOpenSelectedFolderInOppositeNewTab = useCallback(() => {
    const side = activePanelRef.current;
    const entries = side === "left" ? left.entries : right.entries;
    const selectedName = side === "left" ? leftSelectedNameRef.current : rightSelectedNameRef.current;
    const entry = selectedName ? entries.find((e) => e.name === selectedName) : undefined;
    if (!entry || entry.type !== "folder") return;
    const path = entry.path as string;
    const opposite = side === "left" ? "right" : "left";
    const newTab = createFilelistTab(path);
    const setTabs = opposite === "right" ? setRightTabs : setLeftTabs;
    const setIdx = opposite === "right" ? setRightActiveIndex : setLeftActiveIndex;
    const panel = opposite === "right" ? right : left;
    setTabs((prev) => {
      const next = [...prev, newTab];
      queueMicrotask(() => setIdx(next.length - 1));
      return next;
    });
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
    const opposite = side === "left" ? "right" : "left";
    const tabs = opposite === "right" ? rightTabs : leftTabs;
    const setTabs = opposite === "right" ? setRightTabs : setLeftTabs;
    const setIdx = opposite === "right" ? setRightActiveIndex : setLeftActiveIndex;

    const tempIdx = tabs.findIndex((t) => t.type === "preview" && t.isTemp);
    if (tempIdx >= 0) {
      const current = tabs[tempIdx];
      if (current.type === "preview") {
        setTabs((prev) => {
          const next = [...prev];
          next[tempIdx] = { ...current, path, name, size, sourcePanel };
          return next;
        });
        setIdx(tempIdx);
      }
    } else {
      const newTab = createPreviewTab(path, name, size, sourcePanel);
      setTabs((prev) => [...prev, newTab]);
      setIdx(tabs.length);
    }
    setActivePanel(opposite);
  }, [left.entries, right.entries, leftTabs, rightTabs]);

  useEffect(() => {
    bridge.theme.get().then((t) => setTheme(t as ThemeKind));
    return bridge.theme.onChange((t) => setTheme(t as ThemeKind));
  }, []);

  // Register built-in commands
  useEffect(() => {
    const disposables: (() => void)[] = [];

    // View commands
    disposables.push(
      commandRegistry.registerCommand(
        "faraday.toggleHiddenFiles",
        "Toggle Hidden Files",
        () =>
          setShowHidden((h) => {
            const next = !h;
            updateSettings({ showHidden: next });
            return next;
          }),
        { category: "View" },
      ),
    );

    disposables.push(
      commandRegistry.registerCommand(
        "faraday.togglePanels",
        "Toggle Panels",
        () =>
          setPanelsVisible((v) => {
            const next = !v;
            if (next) {
              // Restoring panels should deterministically restore panel command context.
              focusContext.set("panel");
            }
            return next;
          }),
        { category: "View" },
      ),
    );

    disposables.push(
      commandRegistry.registerCommand("faraday.showExtensions", "Show Extensions", () => setShowExtensions(true), {
        category: "View",
      }),
    );

    // Navigation commands
    disposables.push(
      commandRegistry.registerCommand("faraday.switchPanel", "Switch Panel", () => setActivePanel((s) => (s === "left" ? "right" : "left")), {
        category: "Navigation",
        when: "focusPanel && !dialogOpen",
      }),
    );

    disposables.push(
      commandRegistry.registerCommand("faraday.focusLeftPanel", "Focus Left Panel", () => setActivePanel("left"), {
        category: "Navigation",
        when: "focusPanel && !leftPanelActive",
      }),
    );

    disposables.push(
      commandRegistry.registerCommand("faraday.focusRightPanel", "Focus Right Panel", () => setActivePanel("right"), {
        category: "Navigation",
        when: "focusPanel && !rightPanelActive",
      }),
    );

    disposables.push(
      commandRegistry.registerCommand(
        "faraday.cancelNavigation",
        "Cancel Navigation",
        () => {
          left.cancelNavigation();
          right.cancelNavigation();
        },
        { category: "Navigation", when: "focusPanel" },
      ),
    );

    disposables.push(
      commandRegistry.registerCommand(
        "faraday.goToParent",
        "Go to Parent Directory",
        () => {
          const panel = activePanelRef.current === "left" ? left : right;
          const currentPath = panel.currentPath;
          if (isContainerPath(currentPath)) {
            const { containerFile, innerPath } = parseContainerPath(currentPath);
            if (innerPath === "/" || innerPath === "") {
              // Exiting the container root — go to the parent dir, cursor on the archive file.
              panel.navigateTo(dirname(containerFile), false, basename(containerFile));
              return;
            }
          }
          const parent = dirname(currentPath);
          if (parent !== currentPath) {
            panel.navigateTo(parent);
          }
        },
        { category: "Navigation", when: "focusPanel" },
      ),
    );

    disposables.push(
      commandRegistry.registerCommand(
        "faraday.goHome",
        "Go to Home Directory",
        async () => {
          const home = await bridge.utils.getHomePath();
          const panel = activePanelRef.current === "left" ? left : right;
          panel.navigateTo(home);
        },
        { category: "Navigation", when: "focusPanel" },
      ),
    );

    disposables.push(
      commandRegistry.registerCommand("faraday.newTab", "New Tab", () => handleNewTab(activePanelRef.current), {
        category: "File",
        when: "focusPanel",
      }),
    );

    disposables.push(
      commandRegistry.registerCommand(
        "faraday.closeTab",
        "Close Tab",
        () => {
          const side = activePanelRef.current;
          const idx = side === "left" ? leftActiveIndex : rightActiveIndex;
          void handleCloseTab(side, idx);
        },
        { category: "File", when: "focusPanel" },
      ),
    );

    disposables.push(
      commandRegistry.registerCommand("faraday.previewInOppositePanel", "Show Preview in Opposite Panel", () => handlePreviewInOppositePanel(), {
        category: "File",
        when: "focusPanel && listItemIsFile",
      }),
    );

    disposables.push(
      commandRegistry.registerCommand(
        "faraday.openCurrentFolderInOppositePanelCurrentTab",
        "Open Current Folder in Opposite Panel (Current Tab)",
        () => handleOpenCurrentFolderInOppositeCurrentTab(),
        { category: "File", when: "focusPanel" },
      ),
    );

    disposables.push(
      commandRegistry.registerCommand(
        "faraday.openCurrentFolderInOppositePanelNewTab",
        "Open Current Folder in Opposite Panel (New Tab)",
        () => handleOpenCurrentFolderInOppositeNewTab(),
        { category: "File", when: "focusPanel" },
      ),
    );

    disposables.push(
      commandRegistry.registerCommand(
        "faraday.openSelectedFolderInOppositePanelCurrentTab",
        "Open Selected Folder in Opposite Panel (Current Tab)",
        () => handleOpenSelectedFolderInOppositeCurrentTab(),
        { category: "File", when: "focusPanel && listItemIsFolder" },
      ),
    );

    disposables.push(
      commandRegistry.registerCommand(
        "faraday.openSelectedFolderInOppositePanelNewTab",
        "Open Selected Folder in Opposite Panel (New Tab)",
        () => handleOpenSelectedFolderInOppositeNewTab(),
        { category: "File", when: "focusPanel && listItemIsFolder" },
      ),
    );

    // File commands
    disposables.push(
      commandRegistry.registerCommand(
        "faraday.refresh",
        "Refresh",
        () => {
          const panel = activePanelRef.current === "left" ? left : right;
          panel.navigateTo(panel.currentPath);
        },
        { category: "File", when: "focusPanel" },
      ),
    );

    disposables.push(
      commandRegistry.registerCommand(
        "faraday.openCreateFile",
        "Open / Create File",
        () => {
          const panel = activePanelRef.current === "left" ? left : right;
          const currentPath = panel.currentPath;
          const langList = loadedExtensions.flatMap((e) => e.languages ?? []);
          const seen = new Set<string>();
          const languages: LanguageOption[] = langList
            .filter((l) => {
              if (seen.has(l.id)) return false;
              seen.add(l.id);
              return true;
            })
            .map((l) => ({ id: l.id, label: l.aliases?.[0] ?? l.id }));
          showDialog({
            type: "openCreateFile",
            currentPath,
            languages,
            onConfirm: handleOpenCreateFileConfirm,
            onCancel: () => {},
          });
        },
        { category: "File", when: "focusPanel" },
      ),
    );

    disposables.push(
      commandRegistry.registerCommand(
        "faraday.makeFolder",
        "Make Folder",
        () => {
          const panel = activePanelRef.current === "left" ? left : right;
          const currentPath = panel.currentPath;
          showDialog({
            type: "makeFolder",
            currentPath,
            onConfirm: async (result) => {
              const join = (name: string) => (currentPath ? `${currentPath.replace(/\/?$/, "")}/${name}` : name);
              if (result.mode === "single") {
                const fullPath = join(result.name);
                if (bridge.fs.createDir) await bridge.fs.createDir(fullPath);
                panel.navigateTo(fullPath);
                return;
              }
              for (const name of result.names) {
                const fullPath = join(name);
                if (bridge.fs.createDir) await bridge.fs.createDir(fullPath);
              }
              panel.navigateTo(currentPath);
            },
            onCancel: () => {},
          });
        },
        { category: "File", when: "focusPanel" },
      ),
    );

    // Command palette
    disposables.push(
      commandRegistry.registerCommand("faraday.showCommandPalette", "Show All Commands", () => commandPalette.setOpen((o) => !o), { category: "View" }),
    );

    // Close viewer/editor commands
    disposables.push(
      commandRegistry.registerCommand("faraday.closeViewer", "Close Viewer", () => setViewerFile(null), {
        category: "View",
        when: "focusViewer",
      }),
    );

    disposables.push(
      commandRegistry.registerCommand("faraday.closeEditor", "Close Editor", () => setEditorFile(null), {
        category: "View",
        when: "focusEditor",
      }),
    );

    // Exit command
    disposables.push(
      commandRegistry.registerCommand(
        "faraday.exit",
        "Exit",
        async () => {
          if (isTauriApp()) {
            await getCurrentWindow().close();
          } else {
            window.close();
          }
        },
        { category: "Application" },
      ),
    );

    // Register built-in shortcuts (moved to `registerKeybindings.ts`).
    disposables.push(...registerAppBuiltInKeybindings(commandRegistry));

    return () => {
      for (const dispose of disposables) dispose();
    };
  }, [left, right, commandPalette, showDialog, closeDialog, updateDialog, handleOpenCreateFileConfirm]);

  const isBrowser = !isTauriApp();

  const leftPathRef = useRef(left.currentPath);
  leftPathRef.current = left.currentPath;
  const rightPathRef = useRef(right.currentPath);
  rightPathRef.current = right.currentPath;

  // Sync panel path with active filelist tab.
  // Only navigate when the user *switches* tabs (activeIndex changes). Do NOT depend on leftTabs/rightTabs
  // or we get a loop: panel path change → we update tab path → this effect runs with stale tab.path → navigates back.
  const prevLeftActiveIndexRef = useRef(leftActiveIndex);
  const prevRightActiveIndexRef = useRef(rightActiveIndex);
  useEffect(() => {
    if (prevLeftActiveIndexRef.current === leftActiveIndex) return;
    prevLeftActiveIndexRef.current = leftActiveIndex;
    const tab = leftTabs[leftActiveIndex];
    if (tab?.type === "filelist" && tab.path != null) {
      left.navigateTo(tab.path);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only run on tab switch; adding leftTabs/left would cause navigate loop
  }, [leftActiveIndex]);
  useEffect(() => {
    if (prevRightActiveIndexRef.current === rightActiveIndex) return;
    prevRightActiveIndexRef.current = rightActiveIndex;
    const tab = rightTabs[rightActiveIndex];
    if (tab?.type === "filelist" && tab.path != null) {
      right.navigateTo(tab.path);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only run on tab switch; adding rightTabs/right would cause navigate loop
  }, [rightActiveIndex]);
  // Only sync panel path → tab path when the path actually changed (user navigated), not when active tab index changed
  const prevLeftPathRef = useRef(left.currentPath);
  const prevRightPathRef = useRef(right.currentPath);
  useEffect(() => {
    if (prevLeftPathRef.current === left.currentPath) return;
    prevLeftPathRef.current = left.currentPath;
    setLeftTabs((prev) => {
      if (leftActiveIndex < 0 || leftActiveIndex >= prev.length) return prev;
      const tab = prev[leftActiveIndex];
      if (tab?.type !== "filelist" || tab.path === left.currentPath) return prev;
      const next = [...prev];
      next[leftActiveIndex] = { ...tab, path: left.currentPath };
      return next;
    });
  }, [left.currentPath, leftActiveIndex]);
  useEffect(() => {
    if (prevRightPathRef.current === right.currentPath) return;
    prevRightPathRef.current = right.currentPath;
    setRightTabs((prev) => {
      if (rightActiveIndex < 0 || rightActiveIndex >= prev.length) return prev;
      const tab = prev[rightActiveIndex];
      if (tab?.type !== "filelist" || tab.path === right.currentPath) return prev;
      const next = [...prev];
      next[rightActiveIndex] = { ...tab, path: right.currentPath };
      return next;
    });
  }, [right.currentPath, rightActiveIndex]);

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

  const leftFilteredEntries = useMemo(() => (showHidden ? left.entries : left.entries.filter((e) => !e.meta.hidden)), [showHidden, left.entries]);
  const rightFilteredEntries = useMemo(() => (showHidden ? right.entries : right.entries.filter((e) => !e.meta.hidden)), [showHidden, right.entries]);

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
          <div className={`panels-overlay${panelsVisible && promptActive ? "" : " hidden"}`}>
            <PanelGroup
              side="left"
              active={activePanel === "left"}
              panel={left}
              tabs={leftTabs}
              activeIndex={leftActiveIndex}
              onSelectTab={setLeftActiveIndex}
              onDoubleClickTab={(i) => handlePinTab("left", i)}
              onCloseTab={(i) => {
                void handleCloseTab("left", i);
              }}
              onNewTab={() => handleNewTab("left")}
              onReorderTabs={(from, to) => handleReorderTabs("left", from, to)}
              filteredEntries={leftFilteredEntries}
              editorFileSizeLimit={editorFileSizeLimit}
              onActivatePanel={() => setActivePanel("left")}
              onRememberExpectedTerminalCwd={terminal.rememberExpectedTerminalCwd}
              onViewFile={handleViewFile}
              onEditFile={handleEditFile}
              onMoveToTrash={(sourcePaths, refresh) => handleMoveToTrash(sourcePaths, refresh)}
              onPermanentDelete={(sourcePaths, refresh) => handlePermanentDelete(sourcePaths, refresh)}
              onCopy={(sourcePaths, refresh) => handleCopy(sourcePaths, refresh)}
              onMove={(sourcePaths, refresh) => handleMove(sourcePaths, refresh)}
              onRename={(sourcePath, currentName, refresh) => handleRename(sourcePath, currentName, refresh)}
              onExecuteInTerminal={(cmd) => terminal.writeToTerminal(cmd)}
              onPasteToCommandLine={(text) => commandLinePasteRef.current(text)}
              selectionKey={selectionKey}
              requestedActiveName={leftRequestedCursor}
              requestedTopmostName={undefined}
              initialPanelState={initialLeftPanel}
              onStateChange={(sel, top) => handlePanelStateChange("left", sel, top)}
            />
            <PanelGroup
              side="right"
              active={activePanel === "right"}
              panel={right}
              tabs={rightTabs}
              activeIndex={rightActiveIndex}
              onSelectTab={setRightActiveIndex}
              onDoubleClickTab={(i) => handlePinTab("right", i)}
              onCloseTab={(i) => {
                void handleCloseTab("right", i);
              }}
              onNewTab={() => handleNewTab("right")}
              onReorderTabs={(from, to) => handleReorderTabs("right", from, to)}
              filteredEntries={rightFilteredEntries}
              editorFileSizeLimit={editorFileSizeLimit}
              onActivatePanel={() => setActivePanel("right")}
              onRememberExpectedTerminalCwd={terminal.rememberExpectedTerminalCwd}
              onViewFile={handleViewFile}
              onEditFile={handleEditFile}
              onMoveToTrash={(sourcePaths, refresh) => handleMoveToTrash(sourcePaths, refresh)}
              onPermanentDelete={(sourcePaths, refresh) => handlePermanentDelete(sourcePaths, refresh)}
              onCopy={(sourcePaths, refresh) => handleCopy(sourcePaths, refresh)}
              onMove={(sourcePaths, refresh) => handleMove(sourcePaths, refresh)}
              onRename={(sourcePath, currentName, refresh) => handleRename(sourcePath, currentName, refresh)}
              onExecuteInTerminal={(cmd) => terminal.writeToTerminal(cmd)}
              onPasteToCommandLine={(text) => commandLinePasteRef.current(text)}
              selectionKey={selectionKey}
              requestedActiveName={rightRequestedCursor}
              requestedTopmostName={undefined}
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
