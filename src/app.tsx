import { FsNode } from 'fss-lang';
import type { LayeredResolver, ThemeKind } from 'fss-lang';
import { createFsNode } from 'fss-lang/helpers';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { isTauri as isTauriApp } from '@tauri-apps/api/core';
import type { FsChangeType } from './types';
import { bridge } from './bridge';
import { FileList } from './FileList';
import { FileViewer } from './FileViewer';
import { FileEditor } from './FileEditor';
import { ImageViewer, isMediaFile, type MediaFileEntry } from './ImageViewer';
import { ModalDialog, type ModalDialogProps } from './ModalDialog';
import { TerminalPanel } from './Terminal';
import { ActionBar } from './ActionBar';
import { ExtensionsPanel } from './ExtensionsPanel';
import { CommandPalette, useCommandPalette } from './CommandPalette';
import { commandRegistry } from './commands';
import { DirectoryHandle, FileSystemObserver, type FileSystemChangeRecord, type HandleMeta } from './fsa';
import { createPanelResolver, invalidateFssCache, setExtensionLayers, syncLayers } from './fss';
import { extensionHost } from './extensionHostClient';
import { DEFAULT_EDITOR_FILE_SIZE_LIMIT, type LoadedExtension } from './extensions';
import { initUserSettings, onSettingsChange } from './userSettings';
import { languageRegistry } from './languageRegistry';
import { setIconTheme, setIconThemeKind } from './iconResolver';
import { basename, dirname, isRootPath, join } from './path';
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
    async (path: string) => {
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
  const [terminalVisibleHeight, setTerminalVisibleHeight] = useState(20);
  const [viewerFile, setViewerFile] = useState<{ path: string; name: string; size: number; panel: PanelSide } | null>(null);
  const [editorFile, setEditorFile] = useState<{ path: string; name: string; size: number; langId: string } | null>(null);
  const [showExtensions, setShowExtensions] = useState(false);
  const [activeIconTheme, setActiveIconTheme] = useState<string | undefined>(undefined);
  const [editorFileSizeLimit, setEditorFileSizeLimit] = useState(DEFAULT_EDITOR_FILE_SIZE_LIMIT);
  const activeIconThemeRef = useRef(activeIconTheme);
  activeIconThemeRef.current = activeIconTheme;
  const commandPalette = useCommandPalette();

  useEffect(() => {
    // Initialize settings with watch
    initUserSettings().then((s) => {
      if (s.iconTheme) setActiveIconTheme(s.iconTheme);
      if (s.editorFileSizeLimit !== undefined) setEditorFileSizeLimit(s.editorFileSizeLimit);
    });
    
    // Listen for settings changes
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

  const handleTerminalCwd = useCallback((path: string) => {
    const panel = activePanel === 'left' ? left : right;
    if (path !== panel.currentPath) {
      panel.navigateTo(path);
    }
  }, [activePanel, left, right]);

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

    return () => {
      for (const dispose of disposables) dispose();
    };
  }, [left, right, commandPalette]);

  const isBrowser = !isTauriApp();

  const leftPathRef = useRef(left.currentPath);
  leftPathRef.current = left.currentPath;
  const rightPathRef = useRef(right.currentPath);
  rightPathRef.current = right.currentPath;

  // Navigate panels immediately — don't wait for extensions
  useEffect(() => {
    const urlPath = isBrowser ? decodeURIComponent(window.location.pathname) : '';
    const hasUrlPath = urlPath.length > 1; // not just "/"

    if (hasUrlPath) {
      bridge.fsa.exists(urlPath).then(async (exists) => {
        if (exists) {
          left.navigateTo(urlPath);
        } else {
          const parent = await findExistingParent(urlPath);
          left.navigateTo(parent);
          showError(`Directory not found: ${urlPath}`);
        }
      });
      bridge.utils.getHomePath().then((home) => right.navigateTo(home));
    } else {
      bridge.utils.getHomePath().then((home) => {
        left.navigateTo(home);
        right.navigateTo(home);
      });
    }
  }, []);

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
      latestExtensionsRef.current = exts;
      setExtensionLayers(exts, activeIconThemeRef.current);
      updateIconTheme(exts, activeIconThemeRef.current);
      registerLanguages(exts);
      registerExtensionCommands(exts);
      if (leftPathRef.current) left.navigateTo(leftPathRef.current);
      if (rightPathRef.current) right.navigateTo(rightPathRef.current);
    });
    extensionHost.start();
    return () => {
      unsub();
      extensionHost.dispose();
    };
  }, []);

  // Sync active panel path to URL (browser mode only)
  const activePath = activePanel === 'left' ? left.currentPath : right.currentPath;
  useEffect(() => {
    if (isBrowser && activePath) {
      history.replaceState(null, '', activePath);
    }
  }, [activePath]);

  useEffect(() => {
    if (bridge.onReconnect) {
      return bridge.onReconnect(() => {
        left.navigateTo(leftPathRef.current);
        right.navigateTo(rightPathRef.current);
      });
    }
  }, []);



  if (!left.currentPath || !right.currentPath) {
    return <div className="loading">Loading...</div>;
  }

  const activeCwd = activePanel === 'left' ? left.currentPath : right.currentPath;
  const ACTION_BAR_HEIGHT = 24;

  return (
    <div className="app">
      <div className="terminal-background">
        <TerminalPanel cwd={activeCwd} onCwdChange={handleTerminalCwd} onVisibleHeight={setTerminalVisibleHeight} onPromptActive={setPromptActive} />
      </div>
      <div
        className={`panels-overlay${panelsVisible && promptActive ? '' : ' hidden'}`}
        style={{ bottom: `${terminalVisibleHeight + ACTION_BAR_HEIGHT}px` }}
      >
        <div className={`panel ${activePanel === 'left' ? 'active' : ''}`} onClick={() => setActivePanel('left')}>
          {left.navigating && <div className="panel-progress" />}
          <FileList
            currentPath={left.currentPath}
            parentNode={left.parentNode}
            entries={showHidden ? left.entries : left.entries.filter((e) => !e.meta.hidden)}
            onNavigate={left.navigateTo}
            onViewFile={handleViewFile}
            onEditFile={handleEditFile}
            editorFileSizeLimit={editorFileSizeLimit}
            active={activePanel === 'left'}
            resolver={left.resolver}
            requestedActiveName={leftRequestedCursor}
          />
        </div>
        <div className={`panel ${activePanel === 'right' ? 'active' : ''}`} onClick={() => setActivePanel('right')}>
          {right.navigating && <div className="panel-progress" />}
          <FileList
            currentPath={right.currentPath}
            parentNode={right.parentNode}
            entries={showHidden ? right.entries : right.entries.filter((e) => !e.meta.hidden)}
            onNavigate={right.navigateTo}
            onViewFile={handleViewFile}
            onEditFile={handleEditFile}
            editorFileSizeLimit={editorFileSizeLimit}
            active={activePanel === 'right'}
            resolver={right.resolver}
            requestedActiveName={rightRequestedCursor}
          />
        </div>
      </div>
      <ActionBar />
      {viewerFile &&
        (isMediaFile(viewerFile.name) ? (
          <ImageViewer
            filePath={viewerFile.path}
            fileName={viewerFile.name}
            fileSize={viewerFile.size}
            mediaFiles={mediaFiles}
            onClose={() => setViewerFile(null)}
            onNavigateMedia={handleNavigateMedia}
          />
        ) : (
          <FileViewer filePath={viewerFile.path} fileName={viewerFile.name} fileSize={viewerFile.size} onClose={() => setViewerFile(null)} />
        ))}
      {editorFile && (
        <FileEditor
          filePath={editorFile.path}
          fileName={editorFile.name}
          langId={editorFile.langId}
          onClose={() => setEditorFile(null)}
        />
      )}
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
            if (leftPathRef.current) left.navigateTo(leftPathRef.current);
            if (rightPathRef.current) right.navigateTo(rightPathRef.current);
          }}
        />
      )}
      {dialog && <ModalDialog {...dialog} onClose={() => setDialog(null)} />}
      <CommandPalette open={commandPalette.open} onOpenChange={commandPalette.setOpen} />
    </div>
  );
}

