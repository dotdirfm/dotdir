import { FsNode } from 'fss-lang';
import type { LayeredResolver, ThemeKind } from 'fss-lang';
import { createFsNode } from 'fss-lang/helpers';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { isTauri as isTauriApp } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import type { FsChangeType } from './types';
import { bridge } from './bridge';
import { FileList } from './FileList';
import { PanelTabs, type PanelTab } from './FileList/PanelTabs';
import { isMediaFile, type MediaFileEntry } from './mediaFiles';
import { ViewerContainer, EditorContainer } from './ExtensionContainer';
import { clearEditorExtensionCache } from './editorExtensionCache';
import { viewerRegistry, editorRegistry, populateRegistries } from './viewerEditorRegistry';
import { ModalDialog, type ModalDialogProps } from './ModalDialog';
import { TerminalPanel } from './Terminal';
import { ActionBar } from './ActionBar';
import { ExtensionsPanel } from './ExtensionsPanel';
import { CommandPalette, useCommandPalette } from './CommandPalette';
import { commandRegistry } from './commands';
import { DirectoryHandle, FileSystemObserver, type FileSystemChangeRecord, type HandleMeta } from './fsa';
import { createPanelResolver, invalidateFssCache, setExtensionLayers, syncLayers } from './fss';
import { extensionHost } from './extensionHostClient';
import { DEFAULT_EDITOR_FILE_SIZE_LIMIT, type LoadedExtension, type PanelPersistedState } from './extensions';
import { initUserSettings, onSettingsChange, updateSettings } from './userSettings';
import { languageRegistry } from './languageRegistry';
import { setIconTheme, setIconThemeKind } from './iconResolver';
import { basename, dirname, isRootPath, join } from './path';
import { normalizeTerminalPath } from './terminal/path';
import { initUserKeybindings } from './userKeybindings';

function buildParentChain(dirPath: string): FsNode | undefined {
  if (dirname(dirPath) === dirPath) return undefined;

  const ancestors: string[] = [];
  let cur = dirPath;
  while (true) {
    ancestors.push(cur);
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  ancestors.reverse();

  let node: FsNode | undefined;
  for (const p of ancestors) {
    node = createFsNode({
      name: basename(p) || p,
      type: 'folder',
      path: p,
      parent: node,
    });
  }
  return node;
}

function handleToFsNode(handle: FileSystemHandle & { meta?: HandleMeta }, dirPath: string, parent?: FsNode): FsNode {
  const isDir = handle.kind === 'directory';
  return createFsNode({
    name: handle.name,
    type: isDir ? 'folder' : 'file',
    lang: isDir ? '' : languageRegistry.detectLanguage(handle.name),
    meta: {
      size: handle.meta?.size ?? 0,
      mtimeMs: handle.meta?.mtimeMs ?? 0,
      executable: !isDir && handle.meta != null && (handle.meta.mode & 0o111) !== 0,
      hidden: handle.meta?.hidden ?? handle.name.startsWith('.'),
      nlink: handle.meta?.nlink ?? 1,
      entryKind: handle.meta?.kind ?? (isDir ? 'directory' : 'file'),
      linkTarget: handle.meta?.linkTarget,
    },
    path: join(dirPath, handle.name),
    parent,
  });
}

interface PanelState {
  currentPath: string;
  parentNode?: FsNode;
  entries: FsNode[];
}

const emptyPanel: PanelState = { currentPath: '', parentNode: undefined, entries: [] };

async function findExistingParent(startPath: string): Promise<string> {
  let cur = dirname(startPath);
  while (true) {
    if (await bridge.fsa.exists(cur)) return cur;
    const parent = dirname(cur);
    if (parent === cur || isRootPath(cur)) return cur;
    cur = parent;
  }
}

function getAncestors(dirPath: string): string[] {
  const ancestors: string[] = [];
  let cur = dirPath;
  while (true) {
    ancestors.push(cur);
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return ancestors;
}

function usePanel(theme: ThemeKind, showError: (message: string) => void) {
  const [state, setState] = useState<PanelState>(emptyPanel);
  const [navigating, setNavigating] = useState(false);
  const navTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const navAbortRef = useRef<AbortController | null>(null);
  const resolverRef = useRef<LayeredResolver | null>(null);
  if (!resolverRef.current) {
    resolverRef.current = createPanelResolver(theme);
  }

  const observerRef = useRef<FileSystemObserver | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const currentPathRef = useRef<string>('');

  useEffect(() => {
    resolverRef.current!.setTheme(theme);
  }, [theme]);

  const showErrorRef = useRef(showError);
  showErrorRef.current = showError;

  const setupWatches = useCallback((dirPath: string) => {
    const observer = observerRef.current!;
    observer.disconnect();
    const ancestors = getAncestors(dirPath);
    for (const ancestor of ancestors) {
      observer.observe(new DirectoryHandle(ancestor));
      observer.observe(new DirectoryHandle(join(ancestor, '.faraday')));
    }
  }, []);

  const navigateTo = useCallback(
    async (path: string, force = false) => {
      // Skip if already navigating to this path
      if (!force && currentPathRef.current === path && navAbortRef.current) {
        return;
      }
      navAbortRef.current?.abort();
      const abort = new AbortController();
      navAbortRef.current = abort;

      navTimerRef.current = setTimeout(() => setNavigating(true), 300);
      try {
        const work = (async () => {
          currentPathRef.current = path;
          await syncLayers(resolverRef.current!, path);
          if (abort.signal.aborted) return;
          const dirHandle = new DirectoryHandle(path);
          const parent = buildParentChain(path);
          const nodes: FsNode[] = [];
          for await (const [, handle] of dirHandle.entries()) {
            if (abort.signal.aborted) return;
            nodes.push(handleToFsNode(handle, path, parent));
          }
          if (abort.signal.aborted) return;
          setState({ currentPath: path, parentNode: parent, entries: nodes });
          setupWatches(path);
        })();
        work.catch(() => {});
        await Promise.race([
          work,
          new Promise<void>((resolve) => {
            abort.signal.addEventListener('abort', () => resolve(), { once: true });
          }),
        ]);
      } catch (err) {
        if (!abort.signal.aborted) {
          const msg = err && typeof err === 'object' && 'message' in err
            ? (err as { message: string }).message
            : String(err);
          showErrorRef.current(`Failed to read directory: ${msg}`);
        }
      } finally {
        clearTimeout(navTimerRef.current!);
        navTimerRef.current = null;
        setNavigating(false);
      }
    },
    [setupWatches],
  );

  const cancelNavigation = useCallback(() => {
    navAbortRef.current?.abort();
    navAbortRef.current = null;
    if (navTimerRef.current) {
      clearTimeout(navTimerRef.current);
      navTimerRef.current = null;
    }
    setNavigating(false);
  }, []);

  useEffect(() => {
    const handleRecords = (records: FileSystemChangeRecord[]) => {
      const curPath = currentPathRef.current;
      if (!curPath) return;

      let needsRefresh = false;
      let needsFssRefresh = false;
      let navigateUp = false;

      for (const record of records) {
        const rootPath = record.root.path;
        const changedName = record.relativePathComponents[0] ?? null;
        const type: FsChangeType = record.type;

        if (rootPath === curPath) {
          if (type === 'errored') {
            navigateUp = true;
          } else {
            needsRefresh = true;
          }
        } else if (rootPath.endsWith('/.faraday')) {
          if (changedName === 'fs.css') {
            const parentDir = dirname(rootPath);
            invalidateFssCache(parentDir);
            needsFssRefresh = true;
          }
        } else if (curPath.startsWith(rootPath + '/') || curPath === rootPath) {
          if (changedName === '.faraday') {
            invalidateFssCache(rootPath);
            needsFssRefresh = true;
          } else if (changedName) {
            const relative = curPath.slice(rootPath.length + 1);
            const nextSegment = relative.split('/')[0];
            if (changedName === nextSegment && type === 'disappeared') {
              navigateUp = true;
            }
          }
        }
      }

      if (navigateUp) {
        if (debounceRef.current) {
          clearTimeout(debounceRef.current);
          debounceRef.current = null;
        }
        findExistingParent(curPath).then((parent) => {
          navigateToRef.current(parent);
        });
        return;
      }

      if (needsRefresh || needsFssRefresh) {
        if (debounceRef.current) clearTimeout(debounceRef.current);
        debounceRef.current = setTimeout(() => {
          debounceRef.current = null;
          navigateToRef.current(currentPathRef.current);
        }, 100);
      }
    };

    observerRef.current = new FileSystemObserver(handleRecords);

    return () => {
      observerRef.current?.disconnect();
      observerRef.current = null;
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
    };
  }, []);

  const navigateToRef = useRef(navigateTo);
  navigateToRef.current = navigateTo;

  return { ...state, navigateTo, navigating, cancelNavigation, resolver: resolverRef.current! };
}

type PanelSide = 'left' | 'right';

let nextTabId = 0;
function genTabId(): string {
  return `tab-${++nextTabId}`;
}

function createFilelistTab(path: string): PanelTab {
  return { id: genTabId(), type: 'filelist', path };
}

function createPreviewTab(path: string, name: string, size: number, sourcePanel: PanelSide): PanelTab {
  return { id: genTabId(), type: 'preview', path, name, size, isTemp: true, sourcePanel };
}

export function App() {
  const [theme, setTheme] = useState<ThemeKind>('dark');
  const [dialog, setDialog] = useState<Omit<ModalDialogProps, 'onClose'> | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const showError = useCallback((message: string) => {
    setDialog({ title: 'Error', message, variant: 'error' });
  }, []);
  const left = usePanel(theme, showError);
  const right = usePanel(theme, showError);
  const [activePanel, setActivePanel] = useState<PanelSide>('left');
  const [panelsVisible, setPanelsVisible] = useState(true);
  const [promptActive, setPromptActive] = useState(true);
  const promptHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [terminalVisibleHeight, setTerminalVisibleHeight] = useState(40);
  const [viewerFile, setViewerFile] = useState<{ path: string; name: string; size: number; panel: PanelSide } | null>(null);
  const [editorFile, setEditorFile] = useState<{ path: string; name: string; size: number; langId: string } | null>(null);
  const expectedTerminalCwdsRef = useRef<Map<string, number>>(new Map());
  const [requestedTerminalCwd, setRequestedTerminalCwd] = useState<string | null>(null);
  const [showExtensions, setShowExtensions] = useState(false);
  const [activeIconTheme, setActiveIconTheme] = useState<string | undefined>(undefined);
  const [editorFileSizeLimit, setEditorFileSizeLimit] = useState(DEFAULT_EDITOR_FILE_SIZE_LIMIT);
  const [initialLeftPanel, setInitialLeftPanel] = useState<PanelPersistedState | undefined>(undefined);
  const [initialRightPanel, setInitialRightPanel] = useState<PanelPersistedState | undefined>(undefined);
  const [initialActivePanel, setInitialActivePanel] = useState<PanelSide | undefined>(undefined);
  const [leftTabs, setLeftTabs] = useState<PanelTab[]>(() => [createFilelistTab('')]);
  const [rightTabs, setRightTabs] = useState<PanelTab[]>(() => [createFilelistTab('')]);
  const [leftActiveIndex, setLeftActiveIndex] = useState(0);
  const [rightActiveIndex, setRightActiveIndex] = useState(0);
  const [leftSelectedName, setLeftSelectedName] = useState<string | undefined>(undefined);
  const [rightSelectedName, setRightSelectedName] = useState<string | undefined>(undefined);
  const leftTabsRef = useRef(leftTabs);
  leftTabsRef.current = leftTabs;
  const rightTabsRef = useRef(rightTabs);
  rightTabsRef.current = rightTabs;
  const activeIconThemeRef = useRef(activeIconTheme);
  activeIconThemeRef.current = activeIconTheme;
  const commandPalette = useCommandPalette();
  const writeToTerminalRef = useRef<(data: string) => Promise<void>>(async () => {});

  useEffect(() => {
    // Initialize settings with watch
    initUserSettings().then((s) => {
      if (s.iconTheme) setActiveIconTheme(s.iconTheme);
      if (s.editorFileSizeLimit !== undefined) setEditorFileSizeLimit(s.editorFileSizeLimit);
      if (s.leftPanel) setInitialLeftPanel(s.leftPanel);
      if (s.rightPanel) setInitialRightPanel(s.rightPanel);
      if (s.activePanel) setInitialActivePanel(s.activePanel);
    });
    
    // Listen for settings changes (but don't update panel state from external changes)
    const unsubscribe = onSettingsChange((s) => {
      if (s.iconTheme) setActiveIconTheme(s.iconTheme);
      if (s.editorFileSizeLimit !== undefined) setEditorFileSizeLimit(s.editorFileSizeLimit);
    });
    
    initUserKeybindings();
    
    return unsubscribe;
  }, []);

  const activePanelRef = useRef(activePanel);
  activePanelRef.current = activePanel;

  // Set context for which panel is active
  useEffect(() => {
    commandRegistry.setContext('leftPanelActive', activePanel === 'left');
    commandRegistry.setContext('rightPanelActive', activePanel === 'right');
  }, [activePanel]);

  const handleViewFile = useCallback((filePath: string, fileName: string, fileSize: number) => {
    setViewerFile({ path: filePath, name: fileName, size: fileSize, panel: activePanelRef.current });
  }, []);

  const handleEditFile = useCallback((filePath: string, fileName: string, fileSize: number, langId: string) => {
    setEditorFile({ path: filePath, name: fileName, size: fileSize, langId });
  }, []);

  const rememberExpectedTerminalCwd = useCallback((path: string) => {
    const normalized = normalizeTerminalPath(path);
    expectedTerminalCwdsRef.current.set(normalized, Date.now() + 5000);
    setRequestedTerminalCwd(normalized);
  }, []);

  const viewerPanelEntries = viewerFile ? (viewerFile.panel === 'left' ? left.entries : right.entries) : [];
  const mediaFiles = useMemo(() => {
    if (!viewerFile || !isMediaFile(viewerFile.name)) return [];
    const entries = showHidden ? viewerPanelEntries : viewerPanelEntries.filter(e => !e.meta.hidden);
    return entries
      .filter(e => e.type === 'file' && isMediaFile(e.name))
      .map(e => ({ path: e.path as string, name: e.name, size: Number(e.meta.size) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [viewerFile, viewerPanelEntries, showHidden]);

  const handleNavigateMedia = useCallback((file: MediaFileEntry) => {
    setViewerFile(prev => prev ? { ...file, panel: prev.panel } : null);
  }, []);

  const viewerActiveName = viewerFile && isMediaFile(viewerFile.name) ? viewerFile.name : undefined;
  const leftRequestedCursor = viewerFile?.panel === 'left' ? viewerActiveName : undefined;
  const rightRequestedCursor = viewerFile?.panel === 'right' ? viewerActiveName : undefined;

  // Panel state persistence with long debounce (10s) to avoid excessive writes
  const panelStateSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingPanelStateRef = useRef<{
    leftPanel?: { currentPath: string; selectedName?: string; topmostName?: string };
    rightPanel?: { currentPath: string; selectedName?: string; topmostName?: string };
  }>({});

  const flushPanelState = useCallback(() => {
    if (panelStateSaveTimerRef.current) {
      clearTimeout(panelStateSaveTimerRef.current);
      panelStateSaveTimerRef.current = null;
    }
    const pending = pendingPanelStateRef.current;
    if (pending.leftPanel || pending.rightPanel) {
      updateSettings(pending);
      pendingPanelStateRef.current = {};
    }
  }, []);

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
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [flushPanelState]);

  const handleLeftStateChange = useCallback(
    (selectedName: string | undefined, topmostName: string | undefined) => {
      setLeftSelectedName((prev) => (prev === selectedName ? prev : selectedName));
      pendingPanelStateRef.current.leftPanel = {
        currentPath: left.currentPath,
        selectedName,
        topmostName,
      };
      savePanelStateDebounced();
      // Update opposite panel's temp preview tab and switch to it
      const tabs = rightTabsRef.current;
      const tempIdx = tabs.findIndex((t) => t.type === 'preview' && t.isTemp && t.sourcePanel === 'left');
      if (tempIdx < 0 || !selectedName) return;
      const entry = left.entries.find((e) => e.name === selectedName);
      if (!entry || entry.type !== 'file') return;
      const path = entry.path as string;
      const name = entry.name;
      const size = Number(entry.meta.size);
      const current = tabs[tempIdx];
      if (current.type === 'preview' && current.path === path && current.name === name) return;
      const next = [...tabs];
      next[tempIdx] = { id: current.id, type: 'preview' as const, path, name, size, isTemp: true, sourcePanel: 'left' as const };
      setRightTabs(next);
      setRightActiveIndex(tempIdx);
    },
    [left.currentPath, left.entries, savePanelStateDebounced]
  );

  const handleRightStateChange = useCallback(
    (selectedName: string | undefined, topmostName: string | undefined) => {
      setRightSelectedName((prev) => (prev === selectedName ? prev : selectedName));
      pendingPanelStateRef.current.rightPanel = {
        currentPath: right.currentPath,
        selectedName,
        topmostName,
      };
      savePanelStateDebounced();
      const tabs = leftTabsRef.current;
      const tempIdx = tabs.findIndex((t) => t.type === 'preview' && t.isTemp && t.sourcePanel === 'right');
      if (tempIdx < 0 || !selectedName) return;
      const entry = right.entries.find((e) => e.name === selectedName);
      if (!entry || entry.type !== 'file') return;
      const path = entry.path as string;
      const name = entry.name;
      const size = Number(entry.meta.size);
      const current = tabs[tempIdx];
      if (current.type === 'preview' && current.path === path && current.name === name) return;
      const next = [...tabs];
      next[tempIdx] = { id: current.id, type: 'preview' as const, path, name, size, isTemp: true, sourcePanel: 'right' as const };
      setLeftTabs(next);
      setLeftActiveIndex(tempIdx);
    },
    [right.currentPath, right.entries, savePanelStateDebounced]
  );

  // Save active panel when it changes
  useEffect(() => {
    updateSettings({ activePanel });
  }, [activePanel]);

  const handleNewTab = useCallback(
    (side: PanelSide) => {
      const path = side === 'left' ? left.currentPath : right.currentPath;
      const newTab = createFilelistTab(path);
      const setTabs = side === 'left' ? setLeftTabs : setRightTabs;
      const setIdx = side === 'left' ? setLeftActiveIndex : setRightActiveIndex;
      const panel = side === 'left' ? left : right;
      setTabs((prev) => {
        const next = [...prev, newTab];
        queueMicrotask(() => setIdx(next.length - 1));
        return next;
      });
      panel.navigateTo(path);
    },
    [left.currentPath, right.currentPath, left, right]
  );

  const handleCloseTab = useCallback(async (side: PanelSide, index: number) => {
    const tabs = side === 'left' ? leftTabs : rightTabs;
    if (tabs.length > 1) {
      const next = tabs.filter((_, i) => i !== index);
      const activeIdx = side === 'left' ? leftActiveIndex : rightActiveIndex;
      const newIdx = activeIdx === index ? Math.min(activeIdx, next.length - 1) : activeIdx > index ? activeIdx - 1 : activeIdx;
      if (side === 'left') {
        setLeftTabs(next);
        setLeftActiveIndex(newIdx);
      } else {
        setRightTabs(next);
        setRightActiveIndex(newIdx);
      }
      return;
    }
    // Last tab: replace with new filelist tab at home
    const home = await bridge.utils.getHomePath();
    const newTab = createFilelistTab(home);
    if (side === 'left') {
      setLeftTabs([newTab]);
      setLeftActiveIndex(0);
      left.navigateTo(home);
    } else {
      setRightTabs([newTab]);
      setRightActiveIndex(0);
      right.navigateTo(home);
    }
  }, [leftTabs, rightTabs, leftActiveIndex, rightActiveIndex, left, right]);

  const handleReorderTabs = useCallback((side: PanelSide, fromIndex: number, toIndex: number) => {
    const tabs = side === 'left' ? leftTabs : rightTabs;
    const activeIdx = side === 'left' ? leftActiveIndex : rightActiveIndex;
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
    if (side === 'left') {
      setLeftTabs(next);
      setLeftActiveIndex(newActiveIdx);
    } else {
      setRightTabs(next);
      setRightActiveIndex(newActiveIdx);
    }
  }, [leftTabs, rightTabs, leftActiveIndex, rightActiveIndex]);

  const handlePinTab = useCallback((side: PanelSide, index: number) => {
    if (side === 'left') {
      setLeftTabs((prev) => {
        const t = prev[index];
        if (t?.type !== 'preview' || !t.isTemp) return prev;
        const next = [...prev];
        next[index] = { ...t, isTemp: false };
        return next;
      });
    } else {
      setRightTabs((prev) => {
        const t = prev[index];
        if (t?.type !== 'preview' || !t.isTemp) return prev;
        const next = [...prev];
        next[index] = { ...t, isTemp: false };
        return next;
      });
    }
  }, []);

  const handleOpenCurrentFolderInOppositeCurrentTab = useCallback(() => {
    const side = activePanelRef.current;
    const opposite = side === 'left' ? 'right' : 'left';
    const path = side === 'left' ? left.currentPath : right.currentPath;
    const tabs = opposite === 'right' ? rightTabs : leftTabs;
    const activeIdx = opposite === 'right' ? rightActiveIndex : leftActiveIndex;
    const tab = tabs[activeIdx];
    if (tab?.type !== 'filelist') return;
    const setTabs = opposite === 'right' ? setRightTabs : setLeftTabs;
    const panel = opposite === 'right' ? right : left;
    setTabs((prev) => {
      const next = [...prev];
      const t = next[activeIdx];
      if (t?.type !== 'filelist') return prev;
      next[activeIdx] = { ...t, path };
      return next;
    });
    panel.navigateTo(path);
    setActivePanel(opposite);
  }, [left.currentPath, right.currentPath, leftTabs, rightTabs, leftActiveIndex, rightActiveIndex, left, right]);

  const handleOpenCurrentFolderInOppositeNewTab = useCallback(() => {
    const side = activePanelRef.current;
    const opposite = side === 'left' ? 'right' : 'left';
    const path = side === 'left' ? left.currentPath : right.currentPath;
    const newTab = createFilelistTab(path);
    const setTabs = opposite === 'right' ? setRightTabs : setLeftTabs;
    const setIdx = opposite === 'right' ? setRightActiveIndex : setLeftActiveIndex;
    const panel = opposite === 'right' ? right : left;
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
    const entries = side === 'left' ? left.entries : right.entries;
    const selectedName = side === 'left' ? leftSelectedName : rightSelectedName;
    const entry = selectedName ? entries.find((e) => e.name === selectedName) : undefined;
    if (!entry || entry.type !== 'folder') return;
    const path = entry.path as string;
    const opposite = side === 'left' ? 'right' : 'left';
    const tabs = opposite === 'right' ? rightTabs : leftTabs;
    const activeIdx = opposite === 'right' ? rightActiveIndex : leftActiveIndex;
    const tab = tabs[activeIdx];
    if (tab?.type !== 'filelist') return;
    const setTabs = opposite === 'right' ? setRightTabs : setLeftTabs;
    const panel = opposite === 'right' ? right : left;
    setTabs((prev) => {
      const next = [...prev];
      const t = next[activeIdx];
      if (t?.type !== 'filelist') return prev;
      next[activeIdx] = { ...t, path };
      return next;
    });
    panel.navigateTo(path);
    setActivePanel(opposite);
  }, [left.entries, right.entries, leftSelectedName, rightSelectedName, leftTabs, rightTabs, leftActiveIndex, rightActiveIndex, left, right]);

  const handleOpenSelectedFolderInOppositeNewTab = useCallback(() => {
    const side = activePanelRef.current;
    const entries = side === 'left' ? left.entries : right.entries;
    const selectedName = side === 'left' ? leftSelectedName : rightSelectedName;
    const entry = selectedName ? entries.find((e) => e.name === selectedName) : undefined;
    if (!entry || entry.type !== 'folder') return;
    const path = entry.path as string;
    const opposite = side === 'left' ? 'right' : 'left';
    const newTab = createFilelistTab(path);
    const setTabs = opposite === 'right' ? setRightTabs : setLeftTabs;
    const setIdx = opposite === 'right' ? setRightActiveIndex : setLeftActiveIndex;
    const panel = opposite === 'right' ? right : left;
    setTabs((prev) => {
      const next = [...prev, newTab];
      queueMicrotask(() => setIdx(next.length - 1));
      return next;
    });
    panel.navigateTo(path);
    setActivePanel(opposite);
  }, [left.entries, right.entries, leftSelectedName, rightSelectedName, left, right]);

  const handlePreviewInOppositePanel = useCallback(() => {
    const side = activePanelRef.current;
    const entries = side === 'left' ? left.entries : right.entries;
    const selectedName = side === 'left' ? leftSelectedName : rightSelectedName;
    const entry = selectedName ? entries.find((e) => e.name === selectedName) : undefined;
    if (!entry || entry.type !== 'file') return;
    const path = entry.path as string;
    const name = entry.name;
    const size = Number(entry.meta.size);
    const sourcePanel = side;
    const opposite = side === 'left' ? 'right' : 'left';
    const tabs = opposite === 'right' ? rightTabs : leftTabs;
    const setTabs = opposite === 'right' ? setRightTabs : setLeftTabs;
    const setIdx = opposite === 'right' ? setRightActiveIndex : setLeftActiveIndex;

    const tempIdx = tabs.findIndex((t) => t.type === 'preview' && t.isTemp);
    if (tempIdx >= 0) {
      const current = tabs[tempIdx];
      if (current.type === 'preview') {
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
  }, [left.entries, right.entries, leftSelectedName, rightSelectedName, leftTabs, rightTabs]);

  // Temporarily disabled: syncing terminal cwd to panels was causing infinite loop when entering a dir
  const handleTerminalCwd = useCallback((_path: string) => {
    // const normalizedPath = normalizeTerminalPath(path);
    // const now = Date.now();
    // for (const [expectedPath, expiresAt] of expectedTerminalCwdsRef.current) {
    //   if (expiresAt <= now) {
    //     expectedTerminalCwdsRef.current.delete(expectedPath);
    //   }
    // }
    // const expectedExpiry = expectedTerminalCwdsRef.current.get(normalizedPath);
    // if (expectedExpiry && expectedExpiry > now) return;
    // const panel = activePanel === 'left' ? left : right;
    // if (normalizedPath === normalizeTerminalPath(panel.currentPath)) return;
    // if (normalizedPath === normalizeTerminalPath(left.currentPath) || normalizedPath === normalizeTerminalPath(right.currentPath)) return;
    // if (normalizedPath !== panel.currentPath) panel.navigateTo(normalizedPath);
    // setRequestedTerminalCwd(null);
  }, []);

  useEffect(() => {
    if (!requestedTerminalCwd) return;
    const activePath = normalizeTerminalPath(activePanel === 'left' ? left.currentPath : right.currentPath);
    if (activePath === requestedTerminalCwd) {
      setRequestedTerminalCwd(null);
      expectedTerminalCwdsRef.current.delete(requestedTerminalCwd);
    }
  }, [activePanel, left.currentPath, requestedTerminalCwd, right.currentPath]);

  // Debounced prompt active handler - delay hiding panels to avoid flashing on fast commands
  const handlePromptActive = useCallback((active: boolean) => {
    if (promptHideTimerRef.current) {
      clearTimeout(promptHideTimerRef.current);
      promptHideTimerRef.current = null;
    }
    if (active) {
      // Show panels immediately when command finishes
      setPromptActive(true);
    } else {
      // Delay hiding panels by 60ms to avoid flashing on fast commands
      promptHideTimerRef.current = setTimeout(() => {
        setPromptActive(false);
      }, 60);
    }
  }, []);

  useEffect(() => {
    bridge.theme.get().then((t) => setTheme(t as ThemeKind));
    return bridge.theme.onChange((t) => setTheme(t as ThemeKind));
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    setIconThemeKind(theme === 'light' || theme === 'high-contrast-light' ? 'light' : 'dark');
  }, [theme]);

  // Register built-in commands
  useEffect(() => {
    const disposables: (() => void)[] = [];

    // View commands
    disposables.push(commandRegistry.registerCommand(
      'faraday.toggleHiddenFiles',
      'Toggle Hidden Files',
      () => setShowHidden(h => !h),
      { category: 'View' }
    ));
    disposables.push(commandRegistry.registerKeybinding({
      command: 'faraday.toggleHiddenFiles',
      key: 'ctrl+.',
      mac: 'cmd+.',
    }));

    disposables.push(commandRegistry.registerCommand(
      'faraday.togglePanels',
      'Toggle Panels',
      () => setPanelsVisible(v => !v),
      { category: 'View' }
    ));
    disposables.push(commandRegistry.registerKeybinding({
      command: 'faraday.togglePanels',
      key: 'ctrl+o',
      mac: 'cmd+o',
    }));

    disposables.push(commandRegistry.registerCommand(
      'faraday.showExtensions',
      'Show Extensions',
      () => setShowExtensions(true),
      { category: 'View' }
    ));
    disposables.push(commandRegistry.registerKeybinding({
      command: 'faraday.showExtensions',
      key: 'f11',
    }));

    // Navigation commands
    disposables.push(commandRegistry.registerCommand(
      'faraday.switchPanel',
      'Switch Panel',
      () => setActivePanel(s => s === 'left' ? 'right' : 'left'),
      { category: 'Navigation', when: 'focusPanel' }
    ));
    disposables.push(commandRegistry.registerKeybinding({
      command: 'faraday.switchPanel',
      key: 'tab',
    }));

    disposables.push(commandRegistry.registerCommand(
      'faraday.focusLeftPanel',
      'Focus Left Panel',
      () => setActivePanel('left'),
      { category: 'Navigation', when: 'focusPanel && !leftPanelActive' }
    ));

    disposables.push(commandRegistry.registerCommand(
      'faraday.focusRightPanel',
      'Focus Right Panel',
      () => setActivePanel('right'),
      { category: 'Navigation', when: 'focusPanel && !rightPanelActive' }
    ));

    disposables.push(commandRegistry.registerCommand(
      'faraday.cancelNavigation',
      'Cancel Navigation',
      () => {
        left.cancelNavigation();
        right.cancelNavigation();
      },
      { category: 'Navigation', when: 'focusPanel' }
    ));
    disposables.push(commandRegistry.registerKeybinding({
      command: 'faraday.cancelNavigation',
      key: 'escape',
      when: 'focusPanel',
    }));

    disposables.push(commandRegistry.registerCommand(
      'faraday.goToParent',
      'Go to Parent Directory',
      () => {
        const panel = activePanelRef.current === 'left' ? left : right;
        const parent = dirname(panel.currentPath);
        if (parent !== panel.currentPath) {
          panel.navigateTo(parent);
        }
      },
      { category: 'Navigation', when: 'focusPanel' }
    ));
    disposables.push(commandRegistry.registerKeybinding({
      command: 'faraday.goToParent',
      key: 'backspace',
      when: 'focusPanel',
    }));

    disposables.push(commandRegistry.registerCommand(
      'faraday.goHome',
      'Go to Home Directory',
      async () => {
        const home = await bridge.utils.getHomePath();
        const panel = activePanelRef.current === 'left' ? left : right;
        panel.navigateTo(home);
      },
      { category: 'Navigation', when: 'focusPanel' }
    ));
    disposables.push(commandRegistry.registerKeybinding({
      command: 'faraday.goHome',
      key: 'ctrl+home',
      mac: 'cmd+home',
    }));

    disposables.push(commandRegistry.registerCommand(
      'faraday.newTab',
      'New Tab',
      () => handleNewTab(activePanelRef.current),
      { category: 'File', when: 'focusPanel' }
    ));
    disposables.push(commandRegistry.registerKeybinding({
      command: 'faraday.newTab',
      key: 'ctrl+t',
      mac: 'cmd+t',
      when: 'focusPanel',
    }));

    disposables.push(commandRegistry.registerCommand(
      'faraday.closeTab',
      'Close Tab',
      () => {
        const side = activePanelRef.current;
        const idx = side === 'left' ? leftActiveIndex : rightActiveIndex;
        void handleCloseTab(side, idx);
      },
      { category: 'File', when: 'focusPanel' }
    ));
    disposables.push(commandRegistry.registerKeybinding({
      command: 'faraday.closeTab',
      key: 'ctrl+w',
      mac: 'cmd+w',
      when: 'focusPanel',
    }));

    disposables.push(commandRegistry.registerCommand(
      'faraday.previewInOppositePanel',
      'Show Preview in Opposite Panel',
      () => handlePreviewInOppositePanel(),
      { category: 'File', when: 'focusPanel && listItemIsFile' }
    ));
    disposables.push(commandRegistry.registerKeybinding({
      command: 'faraday.previewInOppositePanel',
      key: 'ctrl+shift+o',
      mac: 'cmd+shift+o',
      when: 'focusPanel && listItemIsFile',
    }));

    disposables.push(commandRegistry.registerCommand(
      'faraday.openCurrentFolderInOppositePanelCurrentTab',
      'Open Current Folder in Opposite Panel (Current Tab)',
      () => handleOpenCurrentFolderInOppositeCurrentTab(),
      { category: 'File', when: 'focusPanel' }
    ));

    disposables.push(commandRegistry.registerCommand(
      'faraday.openCurrentFolderInOppositePanelNewTab',
      'Open Current Folder in Opposite Panel (New Tab)',
      () => handleOpenCurrentFolderInOppositeNewTab(),
      { category: 'File', when: 'focusPanel' }
    ));

    disposables.push(commandRegistry.registerCommand(
      'faraday.openSelectedFolderInOppositePanelCurrentTab',
      'Open Selected Folder in Opposite Panel (Current Tab)',
      () => handleOpenSelectedFolderInOppositeCurrentTab(),
      { category: 'File', when: 'focusPanel && listItemIsFolder' }
    ));

    disposables.push(commandRegistry.registerCommand(
      'faraday.openSelectedFolderInOppositePanelNewTab',
      'Open Selected Folder in Opposite Panel (New Tab)',
      () => handleOpenSelectedFolderInOppositeNewTab(),
      { category: 'File', when: 'focusPanel && listItemIsFolder' }
    ));

    // File commands
    disposables.push(commandRegistry.registerCommand(
      'faraday.refresh',
      'Refresh',
      () => {
        const panel = activePanelRef.current === 'left' ? left : right;
        panel.navigateTo(panel.currentPath);
      },
      { category: 'File', when: 'focusPanel' }
    ));
    disposables.push(commandRegistry.registerKeybinding({
      command: 'faraday.refresh',
      key: 'ctrl+r',
      mac: 'cmd+r',
      when: 'focusPanel',
    }));

    // Command palette
    disposables.push(commandRegistry.registerCommand(
      'faraday.showCommandPalette',
      'Show All Commands',
      () => commandPalette.setOpen(true),
      { category: 'View' }
    ));

    // Close viewer/editor commands
    disposables.push(commandRegistry.registerCommand(
      'faraday.closeViewer',
      'Close Viewer',
      () => setViewerFile(null),
      { category: 'View', when: 'focusViewer' }
    ));
    disposables.push(commandRegistry.registerKeybinding({
      command: 'faraday.closeViewer',
      key: 'escape',
      when: 'focusViewer',
    }));

    disposables.push(commandRegistry.registerCommand(
      'faraday.closeEditor',
      'Close Editor',
      () => setEditorFile(null),
      { category: 'View', when: 'focusEditor' }
    ));
    disposables.push(commandRegistry.registerKeybinding({
      command: 'faraday.closeEditor',
      key: 'escape',
      when: 'focusEditor',
    }));

    // Exit command
    disposables.push(commandRegistry.registerCommand(
      'faraday.exit',
      'Exit',
      async () => {
        if (isTauriApp()) {
          await getCurrentWindow().close();
        } else {
          window.close();
        }
      },
      { category: 'Application' }
    ));
    disposables.push(commandRegistry.registerKeybinding({
      command: 'faraday.exit',
      key: 'f10',
    }));
    disposables.push(commandRegistry.registerKeybinding({
      command: 'faraday.exit',
      key: 'cmd+q',
      mac: 'cmd+q',
    }));

    return () => {
      for (const dispose of disposables) dispose();
    };
  }, [left, right, commandPalette]);

  const isBrowser = !isTauriApp();

  const leftPathRef = useRef(left.currentPath);
  leftPathRef.current = left.currentPath;
  const rightPathRef = useRef(right.currentPath);
  rightPathRef.current = right.currentPath;
  const leftRef = useRef(left);
  leftRef.current = left;
  const rightRef = useRef(right);
  rightRef.current = right;

  // Re-navigate when theme changes to refresh FSS styles
  const prevThemeRef = useRef(theme);
  useEffect(() => {
    if (prevThemeRef.current !== theme) {
      prevThemeRef.current = theme;
      if (leftPathRef.current) leftRef.current.navigateTo(leftPathRef.current, true);
      if (rightPathRef.current) rightRef.current.navigateTo(rightPathRef.current, true);
    }
  }, [theme]);

  // Sync panel path with active filelist tab.
  // Only navigate when the user *switches* tabs (activeIndex changes). Do NOT depend on leftTabs/rightTabs
  // or we get a loop: panel path change → we update tab path → this effect runs with stale tab.path → navigates back.
  const prevLeftActiveIndexRef = useRef(leftActiveIndex);
  const prevRightActiveIndexRef = useRef(rightActiveIndex);
  useEffect(() => {
    if (prevLeftActiveIndexRef.current === leftActiveIndex) return;
    prevLeftActiveIndexRef.current = leftActiveIndex;
    const tab = leftTabs[leftActiveIndex];
    if (tab?.type === 'filelist' && tab.path != null) {
      left.navigateTo(tab.path);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only run on tab switch; adding leftTabs/left would cause navigate loop
  }, [leftActiveIndex]);
  useEffect(() => {
    if (prevRightActiveIndexRef.current === rightActiveIndex) return;
    prevRightActiveIndexRef.current = rightActiveIndex;
    const tab = rightTabs[rightActiveIndex];
    if (tab?.type === 'filelist' && tab.path != null) {
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
      if (tab?.type !== 'filelist' || tab.path === left.currentPath) return prev;
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
      if (tab?.type !== 'filelist' || tab.path === right.currentPath) return prev;
      const next = [...prev];
      next[rightActiveIndex] = { ...tab, path: right.currentPath };
      return next;
    });
  }, [right.currentPath, rightActiveIndex]);

  // Navigate panels using persisted state or defaults
  useEffect(() => {
    const browserPath = (() => {
      if (!isBrowser) return '';
      const url = new URL(window.location.href);
      const queryPath = url.searchParams.get('path');
      if (queryPath) return queryPath;
      const pathName = decodeURIComponent(url.pathname);
      return pathName.length > 1 ? pathName : '';
    })();

    const hasUrlPath = browserPath.length > 0;

    const navigatePanel = async (
      panel: typeof left,
      persistedState: PanelPersistedState | undefined,
      fallbackPath?: string
    ) => {
      let targetPath = persistedState?.currentPath ?? fallbackPath;
      
      if (targetPath) {
        const exists = await bridge.fsa.exists(targetPath);
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
      bridge.fsa.exists(browserPath).then(async (exists) => {
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
      // Use persisted state
      navigatePanel(left, initialLeftPanel);
      navigatePanel(right, initialRightPanel);
      if (initialActivePanel) {
        setActivePanel(initialActivePanel);
      }
    }
    
    // Clear initial state after first navigation to prevent cursor jumping
    // when viewer is closed (was falling back to initial selectedName)
    setTimeout(() => {
      setInitialLeftPanel(undefined);
      setInitialRightPanel(undefined);
      setInitialActivePanel(undefined);
    }, 500);
  }, [initialLeftPanel, initialRightPanel, initialActivePanel]);

  const latestExtensionsRef = useRef<LoadedExtension[]>([]);

  // Start Extension Host lazily — re-navigate panels when extensions load
  useEffect(() => {
    languageRegistry.initialize();

    const registerLanguages = async (exts: LoadedExtension[]) => {
      languageRegistry.clear();
      // First pass: register all languages and grammar contents
      for (const ext of exts) {
        if (ext.languages) {
          for (const lang of ext.languages) {
            languageRegistry.registerLanguage(lang);
          }
        }
        if (ext.grammars) {
          for (const grammar of ext.grammars) {
            languageRegistry.registerGrammar(grammar);
          }
        }
      }
      // Second pass: activate tokenization (after all grammars are available for cross-references)
      await languageRegistry.activateGrammars();
    };

    const updateIconTheme = (exts: LoadedExtension[], themeId: string | undefined) => {
      if (!themeId) {
        setIconTheme('fss');
        return;
      }
      const ext = exts.find(e => `${e.ref.publisher}.${e.ref.name}` === themeId);
      if (ext?.vscodeIconThemePath) {
        setIconTheme('vscode', ext.vscodeIconThemePath);
      } else if (ext?.iconThemeFss) {
        setIconTheme('fss');
      } else {
        setIconTheme('none');
      }
    };

    // Register extension commands and keybindings
    const registerExtensionCommands = (exts: LoadedExtension[]) => {
      for (const ext of exts) {
        if (ext.commands) {
          for (const cmd of ext.commands) {
            commandRegistry.registerCommand(
              cmd.command,
              cmd.title,
              () => {
                console.log(`Extension command not implemented: ${cmd.command}`);
              },
              { category: cmd.category, icon: cmd.icon }
            );
          }
        }
        if (ext.keybindings) {
          for (const kb of ext.keybindings) {
            commandRegistry.registerKeybinding({
              command: kb.command,
              key: kb.key,
              mac: kb.mac,
              when: kb.when,
            });
          }
        }
      }
    };

    const unsub = extensionHost.onLoaded((exts) => {
      clearEditorExtensionCache();
      latestExtensionsRef.current = exts;
      populateRegistries(exts);
      setExtensionLayers(exts, activeIconThemeRef.current);
      updateIconTheme(exts, activeIconThemeRef.current);
      registerLanguages(exts);
      registerExtensionCommands(exts);
      // Force re-navigation to sync FSS layers with the new extension layers
      if (leftPathRef.current) leftRef.current.navigateTo(leftPathRef.current, true);
      if (rightPathRef.current) rightRef.current.navigateTo(rightPathRef.current, true);
    });
    extensionHost.start();
    return () => {
      unsub();
      extensionHost.dispose();
    };
  }, []);

  const activePath = activePanel === 'left' ? left.currentPath : right.currentPath;
  useEffect(() => {
    if (isBrowser && activePath) {
      const url = new URL(window.location.href);
      url.pathname = '/';
      url.search = `?path=${encodeURIComponent(activePath)}`;
      history.replaceState(null, '', url.toString());
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


  if (!left.currentPath || !right.currentPath) {
    return <div className="loading">Loading...</div>;
  }

  const actionBarHeight = 24;
  const collapsedTerminalVisibleHeight = 40;
  const activeCwd = requestedTerminalCwd ?? (activePanel === 'left' ? left.currentPath : right.currentPath);

  return (
    <div className="app">
      <div className={`terminal-background${panelsVisible ? '' : ' expanded'}`}>
        <TerminalPanel
          cwd={activeCwd}
          expanded={!panelsVisible}
          onCwdChange={handleTerminalCwd}
          onVisibleHeight={setTerminalVisibleHeight}
          onPromptActive={handlePromptActive}
          onWriteToTerminal={(write) => { writeToTerminalRef.current = write; }}
        />
      </div>
      <div
        className={`panels-overlay${panelsVisible && promptActive ? '' : ' hidden'}`}
        style={{ bottom: `${Math.max(collapsedTerminalVisibleHeight, terminalVisibleHeight) + actionBarHeight}px` }}
      >
        <div className={`panel ${activePanel === 'left' ? 'active' : ''}`} onClick={() => setActivePanel('left')}>
          {left.navigating && <div className="panel-progress" />}
          <PanelTabs
            tabs={leftTabs}
            activeIndex={leftActiveIndex}
            onSelectTab={setLeftActiveIndex}
            onDoubleClickTab={(i) => handlePinTab('left', i)}
            onCloseTab={(i) => handleCloseTab('left', i)}
            onNewTab={() => handleNewTab('left')}
            onReorderTabs={(from, to) => handleReorderTabs('left', from, to)}
          />
          <div className="panel-content">
          {leftTabs[leftActiveIndex]?.type === 'filelist' ? (
            <FileList
              key={leftTabs[leftActiveIndex].id}
              currentPath={left.currentPath}
              parentNode={left.parentNode}
              entries={showHidden ? left.entries : left.entries.filter((e) => !e.meta.hidden)}
              onNavigate={(path) => {
                setActivePanel('left');
                rememberExpectedTerminalCwd(path);
                return left.navigateTo(path);
              }}
              onViewFile={handleViewFile}
              onEditFile={handleEditFile}
              onExecuteInTerminal={(cmd) => writeToTerminalRef.current(cmd)}
              editorFileSizeLimit={editorFileSizeLimit}
              active={activePanel === 'left'}
              resolver={left.resolver}
              requestedActiveName={leftRequestedCursor ?? initialLeftPanel?.selectedName}
              requestedTopmostName={initialLeftPanel?.topmostName}
              onStateChange={handleLeftStateChange}
            />
          ) : leftTabs[leftActiveIndex]?.type === 'preview' ? (
            (() => {
              const tab = leftTabs[leftActiveIndex];
              if (tab.type !== 'preview') return null;
              const closeTab = () => {
                setLeftTabs((prev) => prev.filter((_, i) => i !== leftActiveIndex));
                setLeftActiveIndex(Math.max(0, leftActiveIndex - 1));
              };
              const resolved = viewerRegistry.resolve(tab.name);
              if (resolved) {
                const mediaFiles: MediaFileEntry[] = [];
                return (
                  <ViewerContainer
                    extensionDirPath={resolved.extensionDirPath}
                    entry={resolved.contribution.entry}
                    filePath={tab.path}
                    fileName={tab.name}
                    fileSize={tab.size}
                    inline
                    mediaFiles={mediaFiles}
                    onClose={closeTab}
                  />
                );
              }
              return (
                <div style={{ padding: 16, color: 'var(--fg-muted, #888)', textAlign: 'center' }}>
                  No viewer extension for this file type. Install viewer extensions from the extensions panel.
                </div>
              );
            })()
          ) : null}
          </div>
        </div>
        <div className={`panel ${activePanel === 'right' ? 'active' : ''}`} onClick={() => setActivePanel('right')}>
          {right.navigating && <div className="panel-progress" />}
          <PanelTabs
            tabs={rightTabs}
            activeIndex={rightActiveIndex}
            onSelectTab={setRightActiveIndex}
            onDoubleClickTab={(i) => handlePinTab('right', i)}
            onCloseTab={(i) => handleCloseTab('right', i)}
            onNewTab={() => handleNewTab('right')}
            onReorderTabs={(from, to) => handleReorderTabs('right', from, to)}
          />
          <div className="panel-content">
          {rightTabs[rightActiveIndex]?.type === 'filelist' ? (
            <FileList
              key={rightTabs[rightActiveIndex].id}
              currentPath={right.currentPath}
              parentNode={right.parentNode}
              entries={showHidden ? right.entries : right.entries.filter((e) => !e.meta.hidden)}
              onNavigate={(path) => {
                setActivePanel('right');
                rememberExpectedTerminalCwd(path);
                return right.navigateTo(path);
              }}
              onViewFile={handleViewFile}
              onEditFile={handleEditFile}
              onExecuteInTerminal={(cmd) => writeToTerminalRef.current(cmd)}
              editorFileSizeLimit={editorFileSizeLimit}
              active={activePanel === 'right'}
              resolver={right.resolver}
              requestedActiveName={rightRequestedCursor ?? initialRightPanel?.selectedName}
              requestedTopmostName={initialRightPanel?.topmostName}
              onStateChange={handleRightStateChange}
            />
          ) : rightTabs[rightActiveIndex]?.type === 'preview' ? (
            (() => {
              const tab = rightTabs[rightActiveIndex];
              if (tab.type !== 'preview') return null;
              const closeTab = () => {
                setRightTabs((prev) => prev.filter((_, i) => i !== rightActiveIndex));
                setRightActiveIndex(Math.max(0, rightActiveIndex - 1));
              };
              const resolved = viewerRegistry.resolve(tab.name);
              if (resolved) {
                const mediaFiles: MediaFileEntry[] = [];
                return (
                  <ViewerContainer
                    extensionDirPath={resolved.extensionDirPath}
                    entry={resolved.contribution.entry}
                    filePath={tab.path}
                    fileName={tab.name}
                    fileSize={tab.size}
                    inline
                    mediaFiles={mediaFiles}
                    onClose={closeTab}
                  />
                );
              }
              return (
                <div style={{ padding: 16, color: 'var(--fg-muted, #888)', textAlign: 'center' }}>
                  No viewer extension for this file type. Install viewer extensions from the extensions panel.
                </div>
              );
            })()
          ) : null}
          </div>
        </div>
      </div>
      <ActionBar />
      {viewerFile && (() => {
        const resolved = viewerRegistry.resolve(viewerFile.name);
        if (resolved) {
          return (
            <ViewerContainer
              extensionDirPath={resolved.extensionDirPath}
              entry={resolved.contribution.entry}
              filePath={viewerFile.path}
              fileName={viewerFile.name}
              fileSize={viewerFile.size}
              mediaFiles={mediaFiles}
              onClose={() => setViewerFile(null)}
              onNavigateMedia={handleNavigateMedia}
            />
          );
        }
        return (
          <ModalDialog
            title="No viewer"
            message="No viewer extension found for this file type. Install viewer extensions (e.g. Image Viewer, File Viewer) from the extensions panel."
            onClose={() => setViewerFile(null)}
          />
        );
      })()}
      {editorFile && (() => {
        const resolved = editorRegistry.resolve(editorFile.name);
        if (resolved) {
          const exts = latestExtensionsRef.current;
          const allLanguages = exts.flatMap((e) => e.languages ?? []);
          const allGrammars = exts.flatMap((e) => e.grammars ?? []);
          return (
            <EditorContainer
              extensionDirPath={resolved.extensionDirPath}
              entry={resolved.contribution.entry}
              filePath={editorFile.path}
              fileName={editorFile.name}
              langId={editorFile.langId}
              onClose={() => setEditorFile(null)}
              languages={allLanguages}
              grammars={allGrammars}
            />
          );
        }
        return (
          <ModalDialog
            title="No editor"
            message="No editor extension found for this file type. Install an editor extension (e.g. Monaco Editor) from the extensions panel."
            onClose={() => setEditorFile(null)}
          />
        );
      })()}
      {showExtensions && (
        <ExtensionsPanel
          onClose={() => setShowExtensions(false)}
          onExtensionsChanged={() => {
            extensionHost.restart();
          }}
          activeIconTheme={activeIconTheme}
          onIconThemeChange={(themeId) => {
            setActiveIconTheme(themeId);
            activeIconThemeRef.current = themeId;
            setExtensionLayers(latestExtensionsRef.current, themeId);
            // Update icon resolver
            if (!themeId) {
              setIconTheme('fss');
            } else {
              const ext = latestExtensionsRef.current.find(e => `${e.ref.publisher}.${e.ref.name}` === themeId);
              if (ext?.vscodeIconThemePath) {
                setIconTheme('vscode', ext.vscodeIconThemePath);
              } else if (ext?.iconThemeFss) {
                setIconTheme('fss');
              } else {
                setIconTheme('none');
              }
            }
            if (leftPathRef.current) leftRef.current.navigateTo(leftPathRef.current, true);
            if (rightPathRef.current) rightRef.current.navigateTo(rightPathRef.current, true);
          }}
        />
      )}
      {dialog && <ModalDialog {...dialog} onClose={() => setDialog(null)} />}
      <CommandPalette open={commandPalette.open} onOpenChange={commandPalette.setOpen} />
    </div>
  );
}
