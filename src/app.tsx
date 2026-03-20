import { FsNode } from 'fss-lang';
import type { LayeredResolver, ThemeKind } from 'fss-lang';
import { createFsNode } from 'fss-lang/helpers';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { isTauri as isTauriApp } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import type { FsChangeType } from './types';
import { bridge } from './bridge';
import type { PanelTab } from './FileList/PanelTabs';
import { isMediaFile } from './mediaFiles';
import { ViewerContainer, EditorContainer } from './ExtensionContainer';
import { viewerRegistry, editorRegistry, populateRegistries } from './viewerEditorRegistry';
import type { LanguageOption } from './OpenCreateFileDialog';
import { collectPathsForDelete } from './deleteHelpers';
import { useDialog, DialogHolder } from './dialogContext';
import { ModalDialog } from './ModalDialog';
import { TerminalController } from './Terminal';
import { ActionBar } from './ActionBar';
import { ExtensionsPanel } from './ExtensionsPanel';
import { PanelGroup } from './PanelGroup';
import { CommandPalette, useCommandPalette } from './CommandPalette';
import { commandRegistry } from './commands';
import { DirectoryHandle, FileHandle, FileSystemObserver, type FileSystemChangeRecord, type HandleMeta } from './fsa';
import { createPanelResolver, invalidateFssCache, setExtensionLayers, syncLayers } from './fss';
import { extensionHost } from './extensionHostClient';
import { DEFAULT_EDITOR_FILE_SIZE_LIMIT, findColorTheme, type LoadedExtension, type PanelPersistedState, type PersistedTab } from './extensions';
import { loadAndApplyColorTheme, clearColorTheme, uiThemeToKind } from './vscodeColorTheme';
import { initUserSettings, onSettingsChange, updateSettings } from './userSettings';
import { languageRegistry } from './languageRegistry';
import { setIconTheme, setIconThemeKind } from './iconResolver';
import { basename, dirname, isFileExecutable, isRootPath, join } from './path';
import { normalizeTerminalPath } from './terminal/path';
import { initUserKeybindings } from './userKeybindings';
import { BrowserExtensionHost } from './browserExtensionHost';

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
      executable: !isDir && handle.meta != null && isFileExecutable(handle.meta.mode ?? 0, handle.name),
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
    const ancestors = getAncestors(dirPath);
    const paths: string[] = [];
    for (const ancestor of ancestors) {
      paths.push(ancestor);
      paths.push(join(ancestor, '.faraday'));
    }
    observer.sync(paths);
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
        if (navAbortRef.current === abort) {
          navAbortRef.current = null;
        }
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
  const { dialog, showDialog, closeDialog, updateDialog } = useDialog();
  const [showHidden, setShowHidden] = useState(false);
  const showError = useCallback((message: string) => {
    showDialog({ type: 'message', title: 'Error', message, variant: 'error' });
  }, [showDialog]);
  const left = usePanel(theme, showError);
  const right = usePanel(theme, showError);
  const [activePanel, setActivePanel] = useState<PanelSide>('left');
  const [panelsVisible, setPanelsVisible] = useState(true);
  const [promptActive, setPromptActive] = useState(true);
  const promptHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [viewerFile, setViewerFile] = useState<{ path: string; name: string; size: number; panel: PanelSide } | null>(null);
  const [editorFile, setEditorFile] = useState<{ path: string; name: string; size: number; langId: string } | null>(null);
  const [viewerExt, setViewerExt] = useState<{ dirPath: string; entry: string } | null>(null);
  const [editorExt, setEditorExt] = useState<{ dirPath: string; entry: string } | null>(null);
  const [requestedTerminalCwd, setRequestedTerminalCwd] = useState<string | null>(null);
  const [showExtensions, setShowExtensions] = useState(false);
  const cancelDeleteRef = useRef(false);
  const deleteProgressSpecRef = useRef<{ type: 'deleteProgress'; total: number; current: number; currentPath: string; onCancel: () => void } | null>(null);
  const [activeIconTheme, setActiveIconTheme] = useState<string | undefined>(undefined);
  const [activeColorTheme, setActiveColorTheme] = useState<string | undefined>(undefined);
  const [editorFileSizeLimit, setEditorFileSizeLimit] = useState(DEFAULT_EDITOR_FILE_SIZE_LIMIT);
  const [initialLeftPanel, setInitialLeftPanel] = useState<PanelPersistedState | undefined>(undefined);
  const [initialRightPanel, setInitialRightPanel] = useState<PanelPersistedState | undefined>(undefined);
  const [initialActivePanel, setInitialActivePanel] = useState<PanelSide | undefined>(undefined);
  const [leftTabs, setLeftTabs] = useState<PanelTab[]>(() => [createFilelistTab('')]);
  const [rightTabs, setRightTabs] = useState<PanelTab[]>(() => [createFilelistTab('')]);
  const [leftActiveIndex, setLeftActiveIndex] = useState(0);
  const [rightActiveIndex, setRightActiveIndex] = useState(0);
  const leftSelectedNameRef = useRef<string | undefined>(undefined);
  const rightSelectedNameRef = useRef<string | undefined>(undefined);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [themesReady, setThemesReady] = useState(false);
  const leftTabsRef = useRef(leftTabs);
  leftTabsRef.current = leftTabs;
  const rightTabsRef = useRef(rightTabs);
  rightTabsRef.current = rightTabs;
  const leftActiveIndexRef = useRef(leftActiveIndex);
  leftActiveIndexRef.current = leftActiveIndex;
  const rightActiveIndexRef = useRef(rightActiveIndex);
  rightActiveIndexRef.current = rightActiveIndex;
  const activeIconThemeRef = useRef(activeIconTheme);
  activeIconThemeRef.current = activeIconTheme;
  const activeColorThemeRef = useRef(activeColorTheme);
  activeColorThemeRef.current = activeColorTheme;
  const commandPalette = useCommandPalette();
  const writeToTerminalRef = useRef<(data: string) => Promise<void>>(async () => {});

  useEffect(() => {
    // Initialize settings with watch
    initUserSettings().then((s) => {
      if (s.iconTheme) setActiveIconTheme(s.iconTheme);
      if (s.colorTheme) setActiveColorTheme(s.colorTheme);
      if (s.editorFileSizeLimit !== undefined) setEditorFileSizeLimit(s.editorFileSizeLimit);

      // Restore tabs from persisted state
      const restoreTabs = (panel: PanelPersistedState | undefined) => {
        if (panel?.tabs?.length) {
          return panel.tabs.map(t => createFilelistTab(t.path));
        }
        if (panel?.currentPath) {
          return [createFilelistTab(panel.currentPath)];
        }
        return null;
      };

      const restoredLeftTabs = restoreTabs(s.leftPanel);
      const restoredRightTabs = restoreTabs(s.rightPanel);
      const restoredLeftIndex = restoredLeftTabs
        ? Math.min(s.leftPanel?.activeTabIndex ?? 0, restoredLeftTabs.length - 1)
        : 0;
      const restoredRightIndex = restoredRightTabs
        ? Math.min(s.rightPanel?.activeTabIndex ?? 0, restoredRightTabs.length - 1)
        : 0;

      // Update prev refs so tab sync effects don't fire redundantly
      prevLeftActiveIndexRef.current = restoredLeftIndex;
      prevRightActiveIndexRef.current = restoredRightIndex;

      if (restoredLeftTabs) setLeftTabs(restoredLeftTabs);
      if (restoredRightTabs) setRightTabs(restoredRightTabs);
      setLeftActiveIndex(restoredLeftIndex);
      setRightActiveIndex(restoredRightIndex);

      if (s.leftPanel) setInitialLeftPanel(s.leftPanel);
      if (s.rightPanel) setInitialRightPanel(s.rightPanel);
      if (s.activePanel) setInitialActivePanel(s.activePanel);
      setSettingsLoaded(true);
    });

    // Listen for settings changes (but don't update panel state from external changes)
    const unsubscribe = onSettingsChange((s) => {
      if (s.iconTheme) setActiveIconTheme(s.iconTheme);
      if (s.colorTheme !== undefined) setActiveColorTheme(s.colorTheme || undefined);
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

  // Set context when a dialog is open (e.g. so Tab doesn't switch panel)
  useEffect(() => {
    commandRegistry.setContext('dialogOpen', dialog !== null);
  }, [dialog]);

  const handleViewFile = useCallback((filePath: string, fileName: string, fileSize: number) => {
    setViewerFile({ path: filePath, name: fileName, size: fileSize, panel: activePanelRef.current });
  }, []);

  const handleEditFile = useCallback((filePath: string, fileName: string, fileSize: number, langId: string) => {
    setEditorFile({ path: filePath, name: fileName, size: fileSize, langId });
  }, []);

  const handleOpenCreateFileConfirm = useCallback(
    async (filePath: string, fileName: string, langId: string) => {
      const exists = await bridge.fsa.exists(filePath);
      if (!exists) {
        await bridge.fsa.writeFile(filePath, '');
      }
      const size = exists ? (await bridge.fsa.stat(filePath)).size : 0;
      setEditorFile({ path: filePath, name: fileName, size, langId });
    },
    []
  );

  const handleMoveToTrash = useCallback(
    (path: string, name: string, _isDir: boolean, refresh: () => void) => {
      if (!bridge.fsa.moveToTrash) {
        showDialog({ type: 'message', title: 'Not available', message: 'Move to Trash is only available in the desktop app.', variant: 'error' });
        return;
      }
      showDialog({
        type: 'message',
        title: 'Move to Trash',
        message: `Move "${name}" to Trash?`,
        variant: 'default',
        buttons: [
          { label: 'Cancel' },
          { label: 'Move to Trash', default: true, onClick: async () => {
            try {
              await bridge.fsa.moveToTrash!(path);
              refresh();
            } catch (e) {
              showDialog({ type: 'message', title: 'Error', message: e instanceof Error ? e.message : String(e), variant: 'error' });
            }
          }},
        ],
      });
    },
    [showDialog]
  );

  const handlePermanentDelete = useCallback(
    (path: string, name: string, isDir: boolean, refresh: () => void) => {
      if (!bridge.fsa.deletePath) {
        showDialog({ type: 'message', title: 'Not available', message: 'Permanent delete is only available in the desktop app.', variant: 'error' });
        return;
      }
      showDialog({
        type: 'message',
        title: 'Permanently Delete',
        message: `Permanently delete "${name}"? This cannot be undone.`,
        variant: 'default',
        buttons: [
          { label: 'Cancel' },
          { label: 'Delete', default: true, onClick: async () => {
            try {
              if (isDir) {
                const { files, dirs } = await collectPathsForDelete(path);
                const paths = [...files, ...dirs];
                if (paths.length === 0) {
                  await bridge.fsa.deletePath!(path);
                  refresh();
                  return;
                }
                cancelDeleteRef.current = false;
                const initialSpec = {
                  type: 'deleteProgress' as const,
                  total: paths.length,
                  current: 0,
                  currentPath: paths[0] ?? '',
                  onCancel: () => {
                    showDialog({
                      type: 'cancelDeleteConfirm',
                      onResume: () => {
                        if (deleteProgressSpecRef.current) showDialog(deleteProgressSpecRef.current);
                      },
                      onCancelDeletion: () => {
                        cancelDeleteRef.current = true;
                        closeDialog();
                      },
                    });
                  },
                };
                deleteProgressSpecRef.current = { ...initialSpec };
                showDialog(initialSpec);
                for (let i = 0; i < paths.length; i++) {
                  if (cancelDeleteRef.current) {
                    closeDialog();
                    refresh();
                    return;
                  }
                  updateDialog({ current: i, currentPath: paths[i] });
                  if (deleteProgressSpecRef.current) {
                    deleteProgressSpecRef.current = { ...deleteProgressSpecRef.current, current: i, currentPath: paths[i] };
                  }
                  await bridge.fsa.deletePath!(paths[i]);
                }
                closeDialog();
              } else {
                await bridge.fsa.deletePath!(path);
              }
              refresh();
            } catch (e) {
              closeDialog();
              showDialog({ type: 'message', title: 'Error', message: e instanceof Error ? e.message : String(e), variant: 'error' });
            }
          }},
        ],
      });
    },
    [showDialog, closeDialog, updateDialog]
  );

  const rememberExpectedTerminalCwd = useCallback((path: string) => {
    setRequestedTerminalCwd(normalizeTerminalPath(path));
  }, []);

  const viewerPanelEntries = viewerFile ? (viewerFile.panel === 'left' ? left.entries : right.entries) : [];

  // Helper: match a filename against simple glob patterns like "*.png"
  const matchesPatterns = useCallback((name: string, patterns: string[]): boolean => {
    return patterns.some((p) => {
      if (p.startsWith('*.')) {
        const ext = p.slice(1).toLowerCase();
        return name.toLowerCase().endsWith(ext);
      }
      return name.toLowerCase() === p.toLowerCase();
    });
  }, []);

  // Compute filtered & sorted file list matching given patterns from the viewer's panel
  const getMatchingFiles = useCallback((patterns: string[]) => {
    if (!viewerFile) return [];
    const entries = showHidden ? viewerPanelEntries : viewerPanelEntries.filter(e => !e.meta.hidden);
    return entries
      .filter(e => e.type === 'file' && matchesPatterns(e.name, patterns))
      .map(e => ({ path: e.path as string, name: e.name, size: Number(e.meta.size) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [viewerFile, viewerPanelEntries, showHidden, matchesPatterns]);

  // Generic command handler for viewer extensions
  const handleExecuteCommand = useCallback(async (command: string, args?: unknown): Promise<unknown> => {
    const { patterns } = (args as { patterns?: string[] } | undefined) ?? {};
    if (!patterns || !viewerFile) return undefined;
    const files = getMatchingFiles(patterns);
    const idx = files.findIndex((f) => f.path === viewerFile.path);

    if (command === 'navigatePrev') {
      if (idx > 0) {
        const file = files[idx - 1]!;
        setViewerFile(prev => prev ? { ...file, panel: prev.panel } : null);
      }
      return undefined;
    }
    if (command === 'navigateNext') {
      if (idx >= 0 && idx < files.length - 1) {
        const file = files[idx + 1]!;
        setViewerFile(prev => prev ? { ...file, panel: prev.panel } : null);
      }
      return undefined;
    }
    if (command === 'getFileIndex') {
      return { index: idx, total: files.length };
    }
    return undefined;
  }, [viewerFile, getMatchingFiles]);

  // Resolve extension for current viewer/editor file. Cache the identity so the
  // overlay + iframe persist after the file is closed, enabling iframe reuse.
  const viewerResolved = viewerFile ? viewerRegistry.resolve(viewerFile.name) : null;
  const editorResolved = editorFile ? editorRegistry.resolve(editorFile.name) : null;

  useEffect(() => {
    if (!viewerResolved) return;
    setViewerExt(prev => {
      if (prev?.dirPath === viewerResolved.extensionDirPath && prev?.entry === viewerResolved.contribution.entry) return prev;
      return { dirPath: viewerResolved.extensionDirPath, entry: viewerResolved.contribution.entry };
    });
  }, [viewerResolved?.extensionDirPath, viewerResolved?.contribution.entry]);

  useEffect(() => {
    if (!editorResolved) return;
    setEditorExt(prev => {
      if (prev?.dirPath === editorResolved.extensionDirPath && prev?.entry === editorResolved.contribution.entry) return prev;
      return { dirPath: editorResolved.extensionDirPath, entry: editorResolved.contribution.entry };
    });
  }, [editorResolved?.extensionDirPath, editorResolved?.contribution.entry]);

  const viewerActiveName = viewerFile && isMediaFile(viewerFile.name) ? viewerFile.name : undefined;
  const leftRequestedCursor = viewerFile?.panel === 'left' ? viewerActiveName : undefined;
  const rightRequestedCursor = viewerFile?.panel === 'right' ? viewerActiveName : undefined;

  // Panel state persistence with long debounce (10s) to avoid excessive writes
  const panelStateSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingPanelStateRef = useRef<{
    leftPanel?: PanelPersistedState;
    rightPanel?: PanelPersistedState;
  }>({});

  const buildPersistedTabs = useCallback((tabs: PanelTab[], activeIdx: number): { tabs: PersistedTab[]; activeTabIndex: number } => {
    const persisted: PersistedTab[] = [];
    let mappedIdx = 0;
    for (let i = 0; i < tabs.length; i++) {
      if (tabs[i].type === 'filelist') {
        if (i === activeIdx) mappedIdx = persisted.length;
        persisted.push({ type: 'filelist', path: tabs[i].path });
      }
    }
    return { tabs: persisted, activeTabIndex: mappedIdx };
  }, []);

  const flushPanelState = useCallback(() => {
    if (panelStateSaveTimerRef.current) {
      clearTimeout(panelStateSaveTimerRef.current);
      panelStateSaveTimerRef.current = null;
    }
    // Always include fresh tab state in the flush
    const pending = pendingPanelStateRef.current;
    if (!pending.leftPanel) {
      pending.leftPanel = { currentPath: left.currentPath };
    }
    if (!pending.rightPanel) {
      pending.rightPanel = { currentPath: right.currentPath };
    }
    Object.assign(pending.leftPanel, buildPersistedTabs(leftTabsRef.current, leftActiveIndexRef.current));
    Object.assign(pending.rightPanel, buildPersistedTabs(rightTabsRef.current, rightActiveIndexRef.current));
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
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [flushPanelState]);

  const handleLeftStateChange = useCallback(
    (selectedName: string | undefined, topmostName: string | undefined) => {
      leftSelectedNameRef.current = selectedName;
      pendingPanelStateRef.current.leftPanel = {
        currentPath: left.currentPath,
        ...buildPersistedTabs(leftTabsRef.current, leftActiveIndexRef.current),
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
      rightSelectedNameRef.current = selectedName;
      pendingPanelStateRef.current.rightPanel = {
        currentPath: right.currentPath,
        ...buildPersistedTabs(rightTabsRef.current, rightActiveIndexRef.current),
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

  // Save active panel when it changes (only after settings loaded to avoid overwriting on mount)
  useEffect(() => {
    if (!settingsLoaded) return;
    updateSettings({ activePanel });
  }, [activePanel, settingsLoaded]);

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
    const selectedName = side === 'left' ? leftSelectedNameRef.current : rightSelectedNameRef.current;
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
  }, [left.entries, right.entries, leftTabs, rightTabs, leftActiveIndex, rightActiveIndex, left, right]);

  const handleOpenSelectedFolderInOppositeNewTab = useCallback(() => {
    const side = activePanelRef.current;
    const entries = side === 'left' ? left.entries : right.entries;
    const selectedName = side === 'left' ? leftSelectedNameRef.current : rightSelectedNameRef.current;
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
  }, [left.entries, right.entries, left, right]);

  const handlePreviewInOppositePanel = useCallback(() => {
    const side = activePanelRef.current;
    const entries = side === 'left' ? left.entries : right.entries;
    const selectedName = side === 'left' ? leftSelectedNameRef.current : rightSelectedNameRef.current;
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
  }, [left.entries, right.entries, leftTabs, rightTabs]);

  const handleTerminalCwd = useCallback((path: string) => {
    const normalizedPath = normalizeTerminalPath(path);
    const panel = activePanel === 'left' ? left : right;
    if (normalizedPath === normalizeTerminalPath(panel.currentPath)) return;
    panel.navigateTo(normalizedPath);
    setRequestedTerminalCwd(null);
  }, []);

  useEffect(() => {
    if (!requestedTerminalCwd) return;
    const activePath = normalizeTerminalPath(activePanel === 'left' ? left.currentPath : right.currentPath);
    if (activePath === requestedTerminalCwd) {
      setRequestedTerminalCwd(null);
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
    // If a color theme is active, determine light/dark from its uiTheme.
    // Otherwise fall back to OS/system theme.
    const colorThemeMatch = activeColorTheme
      ? findColorTheme(latestExtensionsRef.current, activeColorTheme)
      : null;
    const effectiveKind = colorThemeMatch
      ? uiThemeToKind(colorThemeMatch.theme.uiTheme)
      : (theme === 'light' || theme === 'high-contrast-light' ? 'light' : 'dark');
    document.documentElement.dataset.theme = effectiveKind;
    setIconThemeKind(effectiveKind);
  }, [theme, activeColorTheme]);

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
      { category: 'Navigation', when: 'focusPanel && !dialogOpen' }
    ));
    disposables.push(commandRegistry.registerKeybinding({
      command: 'faraday.switchPanel',
      key: 'tab',
      when: 'focusPanel && !dialogOpen',
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

    disposables.push(commandRegistry.registerCommand(
      'faraday.openCreateFile',
      'Open / Create File',
      () => {
        const panel = activePanelRef.current === 'left' ? left : right;
        const currentPath = panel.currentPath;
        const exts = latestExtensionsRef.current;
        const langList = exts.flatMap((e) => e.languages ?? []);
        const seen = new Set<string>();
        const languages: LanguageOption[] = langList
          .filter((l) => {
            if (seen.has(l.id)) return false;
            seen.add(l.id);
            return true;
          })
          .map((l) => ({ id: l.id, label: l.aliases?.[0] ?? l.id }));
        showDialog({ type: 'openCreateFile', currentPath, languages, onConfirm: handleOpenCreateFileConfirm, onCancel: () => {} });
      },
      { category: 'File', when: 'focusPanel' }
    ));
    disposables.push(commandRegistry.registerKeybinding({
      command: 'faraday.openCreateFile',
      key: 'shift+f4',
      when: 'focusPanel',
    }));

    disposables.push(commandRegistry.registerCommand(
      'faraday.makeFolder',
      'Make Folder',
      () => {
        const panel = activePanelRef.current === 'left' ? left : right;
        const currentPath = panel.currentPath;
        showDialog({
          type: 'makeFolder',
          currentPath,
          onConfirm: async (folderName: string) => {
            const fullPath = currentPath ? `${currentPath.replace(/\/?$/, '')}/${folderName}` : folderName;
            if (bridge.fsa.createDir) await bridge.fsa.createDir(fullPath);
            panel.navigateTo(currentPath);
          },
          onCancel: () => {},
        });
      },
      { category: 'File', when: 'focusPanel' }
    ));
    disposables.push(commandRegistry.registerKeybinding({
      command: 'faraday.makeFolder',
      key: 'f7',
      when: 'focusPanel',
    }));

    // Command palette
    disposables.push(commandRegistry.registerCommand(
      'faraday.showCommandPalette',
      'Show All Commands',
      () => commandPalette.setOpen((o) => !o),
      { category: 'View' }
    ));

    disposables.push(commandRegistry.registerKeybinding({
      command: 'faraday.showCommandPalette',
      key: 'cmd+shift+p',
    }));

    disposables.push(commandRegistry.registerKeybinding({
      command: 'faraday.showCommandPalette',
      key: 'cmd+p',
    }));

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
  }, [left, right, commandPalette, showDialog, closeDialog, updateDialog, handleOpenCreateFileConfirm]);

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

  // Navigate panels using persisted state or defaults — fires once when settings are loaded
  useEffect(() => {
    if (!settingsLoaded) return;

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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally fires once when settingsLoaded becomes true
  }, [settingsLoaded]);

  const latestExtensionsRef = useRef<LoadedExtension[]>([]);
  const browserExtensionHostRef = useRef(new BrowserExtensionHost());
  const extensionContributionDisposersRef = useRef<(() => void)[]>([]);

  const readTextFileAbs = useCallback(async (absPath: string): Promise<string> => {
    const normalized = absPath;
    const name = normalized.split('/').pop() ?? normalized;
    const handle = new FileHandle(normalized, name);
    const file = await handle.getFile();
    return file.text();
  }, []);

  const ensureActiveIconThemeFssLoaded = useCallback(
    async (exts: LoadedExtension[], themeId: string | undefined): Promise<void> => {
      if (!themeId) return;
      const ext = exts.find((e) => `${e.ref.publisher}.${e.ref.name}` === themeId);
      if (!ext?.iconThemeFssPath) return;
      if (ext.iconThemeFss) return; // already loaded
      try {
        ext.iconThemeFss = await readTextFileAbs(ext.iconThemeFssPath);
        if (!ext.iconThemeBasePath) ext.iconThemeBasePath = dirname(ext.iconThemeFssPath);
      } catch {
        // Ignore theme load errors; resolver will fall back.
      }
    },
    [readTextFileAbs]
  );

  // Start Extension Host lazily — re-navigate panels when extensions load
  useEffect(() => {
    if (!settingsLoaded) return;
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
      }
      // Second pass: activate tokenization (after all grammars are available for cross-references)
      await languageRegistry.activateGrammars();
    };

    const updateIconTheme = async (exts: LoadedExtension[], themeId: string | undefined): Promise<void> => {
      if (!themeId) {
        await setIconTheme('fss');
        return;
      }
      const ext = exts.find(e => `${e.ref.publisher}.${e.ref.name}` === themeId);
      if (ext?.vscodeIconThemePath) {
        await setIconTheme('vscode', ext.vscodeIconThemePath);
      } else if (ext?.iconThemeFssPath) {
        await setIconTheme('fss');
      } else {
        await setIconTheme('none');
      }
    };

    const updateColorTheme = async (exts: LoadedExtension[], themeKey: string | undefined): Promise<void> => {
      if (!themeKey) {
        clearColorTheme();
        return;
      }
      const match = findColorTheme(exts, themeKey);
      if (match) {
        const kind = uiThemeToKind(match.theme.uiTheme);
        document.documentElement.dataset.theme = kind;
        setIconThemeKind(kind);
        try {
          await loadAndApplyColorTheme(match.theme.jsonPath, match.theme.uiTheme);
        } catch (err) {
          console.warn('[ExtHost] Failed to load color theme:', themeKey, err);
          clearColorTheme();
        }
      } else {
        clearColorTheme();
      }
    };

    // Register extension commands and keybindings
    const registerExtensionCommands = (exts: LoadedExtension[]) => {
      // Avoid duplicate registrations on extension host restart.
      for (const d of extensionContributionDisposersRef.current) {
        try { d(); } catch { /* ignore */ }
      }
      extensionContributionDisposersRef.current = [];

      for (const ext of exts) {
        if (ext.commands) {
          for (const cmd of ext.commands) {
            const disposeCmd = commandRegistry.registerCommand(
              cmd.command,
              cmd.title,
              () => {
                console.log(`Extension command not implemented: ${cmd.command}`);
              },
              { category: cmd.category, icon: cmd.icon }
            );
            extensionContributionDisposersRef.current.push(disposeCmd);
          }
        }
        if (ext.keybindings) {
          for (const kb of ext.keybindings) {
            const disposeKb = commandRegistry.registerKeybinding({
              command: kb.command,
              key: kb.key,
              mac: kb.mac,
              when: kb.when,
            }, 'extension');
            extensionContributionDisposersRef.current.push(disposeKb);
          }
        }
      }
    };

    const unsub = extensionHost.onLoaded((exts) => {
      void (async () => {
        latestExtensionsRef.current = exts;
        populateRegistries(exts);

        // Load only the active FSS icon theme contents (lazy).
        await ensureActiveIconThemeFssLoaded(exts, activeIconThemeRef.current);
        setExtensionLayers(exts, activeIconThemeRef.current);

        registerLanguages(exts);
        registerExtensionCommands(exts);
        void browserExtensionHostRef.current.reconcile(exts);

        // Load themes first, then refresh panels once themes are ready
        Promise.all([
          updateIconTheme(exts, activeIconThemeRef.current),
          updateColorTheme(exts, activeColorThemeRef.current),
        ]).then(() => {
          setThemesReady(true);
          if (leftPathRef.current) leftRef.current.navigateTo(leftPathRef.current, true);
          if (rightPathRef.current) rightRef.current.navigateTo(rightPathRef.current, true);
        });
      })();
    });
    extensionHost.start();
    return () => {
      unsub();
      void browserExtensionHostRef.current.dispose();
      for (const d of extensionContributionDisposersRef.current) {
        try { d(); } catch { /* ignore */ }
      }
      extensionContributionDisposersRef.current = [];
      extensionHost.dispose();
    };
  }, [settingsLoaded]);

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


  const leftFilteredEntries = useMemo(
    () => showHidden ? left.entries : left.entries.filter((e) => !e.meta.hidden),
    [showHidden, left.entries],
  );
  const rightFilteredEntries = useMemo(
    () => showHidden ? right.entries : right.entries.filter((e) => !e.meta.hidden),
    [showHidden, right.entries],
  );

  if (!left.currentPath || !right.currentPath || !themesReady) {
    return <div className="loading">Loading...</div>;
  }

  const activeCwd = requestedTerminalCwd ?? (activePanel === 'left' ? left.currentPath : right.currentPath);

  return (
    <div className="app">
      <TerminalController
        cwd={activeCwd}
        expanded={!panelsVisible}
        onCwdChange={handleTerminalCwd}
        onPromptActive={handlePromptActive}
        onWriteToTerminal={(write) => { writeToTerminalRef.current = write; }}
      >
        {({ body, toolbar }) => (
          <>
            <div className="terminal-and-panels">
              <div className={`terminal-background${panelsVisible ? '' : ' expanded'}`}>
                {body}
              </div>
              <div className={`panels-overlay${panelsVisible && promptActive ? '' : ' hidden'}`}
              >
                <PanelGroup
                  side="left"
                  active={activePanel === 'left'}
                  panel={left}
                  tabs={leftTabs}
                  activeIndex={leftActiveIndex}
                  onSelectTab={setLeftActiveIndex}
                  onDoubleClickTab={(i) => handlePinTab('left', i)}
                  onCloseTab={(i) => { void handleCloseTab('left', i); }}
                  onNewTab={() => handleNewTab('left')}
                  onReorderTabs={(from, to) => handleReorderTabs('left', from, to)}
                  filteredEntries={leftFilteredEntries}
                  editorFileSizeLimit={editorFileSizeLimit}
                  onActivatePanel={() => setActivePanel('left')}
                  onRememberExpectedTerminalCwd={rememberExpectedTerminalCwd}
                  onViewFile={handleViewFile}
                  onEditFile={handleEditFile}
                  onMoveToTrash={(path, name, isDir) => handleMoveToTrash(path, name, isDir, () => left.navigateTo(left.currentPath))}
                  onPermanentDelete={(path, name, isDir) => handlePermanentDelete(path, name, isDir, () => left.navigateTo(left.currentPath))}
                  onExecuteInTerminal={(cmd) => writeToTerminalRef.current(cmd)}
                  requestedActiveName={leftRequestedCursor}
                  requestedTopmostName={undefined}
                  initialPanelState={initialLeftPanel}
                  onStateChange={handleLeftStateChange}
                />
                <PanelGroup
                  side="right"
                  active={activePanel === 'right'}
                  panel={right}
                  tabs={rightTabs}
                  activeIndex={rightActiveIndex}
                  onSelectTab={setRightActiveIndex}
                  onDoubleClickTab={(i) => handlePinTab('right', i)}
                  onCloseTab={(i) => { void handleCloseTab('right', i); }}
                  onNewTab={() => handleNewTab('right')}
                  onReorderTabs={(from, to) => handleReorderTabs('right', from, to)}
                  filteredEntries={rightFilteredEntries}
                  editorFileSizeLimit={editorFileSizeLimit}
                  onActivatePanel={() => setActivePanel('right')}
                  onRememberExpectedTerminalCwd={rememberExpectedTerminalCwd}
                  onViewFile={handleViewFile}
                  onEditFile={handleEditFile}
                  onMoveToTrash={(path, name, isDir) => handleMoveToTrash(path, name, isDir, () => right.navigateTo(right.currentPath))}
                  onPermanentDelete={(path, name, isDir) => handlePermanentDelete(path, name, isDir, () => right.navigateTo(right.currentPath))}
                  onExecuteInTerminal={(cmd) => writeToTerminalRef.current(cmd)}
                  requestedActiveName={rightRequestedCursor}
                  requestedTopmostName={undefined}
                  initialPanelState={initialRightPanel}
                  onStateChange={handleRightStateChange}
                />
              </div>
            </div>
            {toolbar}
          </>
        )}
      </TerminalController>
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
          filePath={viewerFile?.path ?? ''}
          fileName={viewerFile?.name ?? ''}
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
      {editorExt && (() => {
        const exts = latestExtensionsRef.current;
        const allLanguages = exts.flatMap((e) => e.languages ?? []);
        const allGrammarRefs = exts.flatMap((e) => e.grammarRefs ?? []);
        const grammars = allGrammarRefs.map((gr) => ({
          contribution: gr.contribution,
          path: gr.path,
        }));
        return (
          <EditorContainer
            key={`editor:${editorExt.dirPath}:${editorExt.entry}`}
            extensionDirPath={editorExt.dirPath}
            entry={editorExt.entry}
            filePath={editorFile?.path ?? ''}
            fileName={editorFile?.name ?? ''}
            langId={editorFile?.langId ?? 'plaintext'}
            visible={editorFile != null && editorResolved != null}
            onClose={() => setEditorFile(null)}
            languages={allLanguages}
            grammars={grammars}
          />
        );
      })()}
      {showExtensions && (
        <ExtensionsPanel
          onClose={() => setShowExtensions(false)}
          onExtensionsChanged={() => {
            void (async () => {
              await browserExtensionHostRef.current.dispose();
              await extensionHost.restart();
            })();
          }}
          activeIconTheme={activeIconTheme}
          onIconThemeChange={(themeId) => {
            setActiveIconTheme(themeId);
            activeIconThemeRef.current = themeId;
            void (async () => {
              await ensureActiveIconThemeFssLoaded(latestExtensionsRef.current, themeId);
              setExtensionLayers(latestExtensionsRef.current, themeId);
              // Update icon resolver
              if (!themeId) {
                setIconTheme('fss');
              } else {
                const ext = latestExtensionsRef.current.find(e => `${e.ref.publisher}.${e.ref.name}` === themeId);
                if (ext?.vscodeIconThemePath) {
                  setIconTheme('vscode', ext.vscodeIconThemePath);
                } else if (ext?.iconThemeFssPath) {
                  setIconTheme('fss');
                } else {
                  setIconTheme('none');
                }
              }
              if (leftPathRef.current) leftRef.current.navigateTo(leftPathRef.current, true);
              if (rightPathRef.current) rightRef.current.navigateTo(rightPathRef.current, true);
            })();
          }}
          activeColorTheme={activeColorTheme}
          onColorThemeChange={(themeKey) => {
            setActiveColorTheme(themeKey);
            activeColorThemeRef.current = themeKey;
            if (!themeKey) {
              clearColorTheme();
            } else {
              const match = findColorTheme(latestExtensionsRef.current, themeKey);
              if (match) {
                loadAndApplyColorTheme(match.theme.jsonPath, match.theme.uiTheme).catch(() => clearColorTheme());
              }
            }
          }}
        />
      )}
      <DialogHolder />
      <CommandPalette open={commandPalette.open} onOpenChange={commandPalette.setOpen} />
    </div>
  );
}
