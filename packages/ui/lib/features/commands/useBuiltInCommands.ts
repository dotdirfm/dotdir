import { commandPaletteOpenAtom, panelsVisibleAtom } from "@/atoms";
import { useDialog } from "@/dialogs/dialogContext";
import {
  activePanelSideAtom,
  activeTabAtom,
  createFilelistTab,
  leftActiveTabAtom,
  leftActiveTabIdAtom,
  leftTabsAtom,
  rightActiveTabAtom,
  rightActiveTabIdAtom,
  rightTabsAtom,
} from "@/entities/tab/model/tabsAtoms";
import type { FileSearchRequest } from "@/features/bridge";
import { useBridge } from "@/features/bridge/useBridge";
import { useCommandLine } from "@/features/command-line/useCommandLine";
import {
  CLEAR,
  CLOSE_EDITOR,
  CLOSE_TAB,
  CLOSE_VIEWER,
  CURSOR_DOCUMENT_END,
  CURSOR_DOCUMENT_START,
  CURSOR_DOWN,
  CURSOR_END,
  CURSOR_HOME,
  CURSOR_LEFT,
  CURSOR_PAGE_DOWN,
  CURSOR_PAGE_UP,
  CURSOR_RIGHT,
  CURSOR_UP,
  CURSOR_WORD_LEFT,
  CURSOR_WORD_RIGHT,
  DOTDIR_CANCEL_NAVIGATION,
  DOTDIR_CLOSE_WINDOW,
  DOTDIR_EDITOR_FIND,
  DOTDIR_EDITOR_SAVE,
  DOTDIR_EXIT,
  DOTDIR_FOCUS_LEFT_PANEL,
  DOTDIR_FOCUS_RIGHT_PANEL,
  DOTDIR_NEW_WINDOW,
  DOTDIR_PANEL_ESCAPE,
  EDIT_FILE,
  LIST_MAKE_DIR,
  OPEN_CREATE_FILE,
  PASTE_LEFT_PANEL_PATH,
  PASTE_RIGHT_PANEL_PATH,
  RUN_COMMANDS,
  SELECT_ALL,
  SELECT_DOWN,
  SELECT_END,
  SELECT_HOME,
  SELECT_LEFT,
  SELECT_PAGE_DOWN,
  SELECT_PAGE_UP,
  SELECT_RIGHT,
  SELECT_UP,
  SELECT_WORD_LEFT,
  SELECT_WORD_RIGHT,
  SHELL_EXECUTE,
  SHOW_COMMAND_PALETTE,
  SHOW_EXTENSIONS,
  SHOW_FIND_FILES,
  SHOW_SETTINGS,
  SWITCH_PANEL,
  TERMINAL_FOCUS,
  TOGGLE_HIDDEN_FILES,
  TOGGLE_PANELS,
  VIEW_FILE,
} from "@/features/commands/commandIds";
import { useCommandRegistry } from "@/features/commands/commands";
import { registerAppBuiltInKeybindings, registerFileListKeybindings } from "@/features/commands/registerKeybindings";
import { runCommandSequence, type RunCommandsArgs } from "@/features/commands/runCommands";
import { DOTDIR_MONACO_EXECUTE_ACTION } from "@/features/extensions/builtins/monacoCommandBridge";
import { executeMountedExtensionCommand } from "@/features/extensions/extensionCommandHandlers";
import { useLoadedExtensions } from "@/features/extensions/useLoadedExtensions";
import { useLanguageRegistry } from "@/features/languages/languageRegistry";
import { useActivePanelNavigation } from "@/features/panels/panelControllers";
import { DEFAULT_EDITOR_FILE_SIZE_LIMIT } from "@/features/settings/userSettings";
import { useShowHidden, useUserSettings } from "@/features/settings/useUserSettings";
import { useTerminal } from "@/features/terminal/useTerminal";
import { useUiState } from "@/features/ui-state/uiState";
import { useFocusContext } from "@/focusContext";
import { basename } from "@/utils/path";
import { isTauri as isTauriApp } from "@tauri-apps/api/core";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { useEffect, useRef } from "react";

export interface BuiltInCommandDeps {
  onOpenCreateFileConfirm: (path: string, name: string, langId: string) => Promise<void>;
  onViewFile: (filePath: string, fileName: string, fileSize: number) => void;
  onEditFile: (filePath: string, fileName: string, fileSize: number, langId: string) => void;
  onRequestCloseViewer: () => void;
  onRequestCloseEditor: () => void;
  viewerOpen: boolean;
}

export function useBuiltInCommands(deps: BuiltInCommandDeps): void {
  const bridge = useBridge();
  const { ensureWindow, flushCurrentWindowLayout, flushCurrentWindowState, getCurrentWindowId, getWindowIds, removeWindow } = useUiState();
  const bridgeRef = useRef(bridge);
  bridgeRef.current = bridge;
  const { navigateTo, cancelNavigation, getPanel, focusFileList, activePanelSide } = useActivePanelNavigation();
  const commandRegistry = useCommandRegistry();
  const focusContext = useFocusContext();
  const focusContextRef = useRef(focusContext);
  focusContextRef.current = focusContext;
  const { showDialog, replaceDialog } = useDialog();
  const languageRegistry = useLanguageRegistry();
  const showDialogRef = useRef(showDialog);
  showDialogRef.current = showDialog;
  const replaceDialogRef = useRef(replaceDialog);
  replaceDialogRef.current = replaceDialog;
  const languageRegistryRef = useRef(languageRegistry);
  languageRegistryRef.current = languageRegistry;

  const { paste: pasteToCommandLine } = useCommandLine();

  const { runCommand, activeCwd, activeSession } = useTerminal();
  const runCommandRef = useRef(runCommand);
  runCommandRef.current = runCommand;
  const activeCwdRef = useRef(activeCwd);
  activeCwdRef.current = activeCwd;
  const activeSessionRef = useRef(activeSession);
  activeSessionRef.current = activeSession;
  const ensureWindowRef = useRef(ensureWindow);
  ensureWindowRef.current = ensureWindow;
  const removeWindowRef = useRef(removeWindow);
  removeWindowRef.current = removeWindow;
  const flushCurrentWindowLayoutRef = useRef(flushCurrentWindowLayout);
  flushCurrentWindowLayoutRef.current = flushCurrentWindowLayout;
  const flushCurrentWindowStateRef = useRef(flushCurrentWindowState);
  flushCurrentWindowStateRef.current = flushCurrentWindowState;
  const getCurrentWindowIdRef = useRef(getCurrentWindowId);
  getCurrentWindowIdRef.current = getCurrentWindowId;
  const getWindowIdsRef = useRef(getWindowIds);
  getWindowIdsRef.current = getWindowIds;

  // Updated every render so command handlers always see the latest callbacks.
  const depsRef = useRef(deps);
  depsRef.current = deps;

  // loadedExtensions changes as extensions load; keep a ref for call-time reads.
  const loadedExtensions = useLoadedExtensions();
  const loadedExtensionsRef = useRef(loadedExtensions);
  loadedExtensionsRef.current = loadedExtensions;

  const { settings } = useUserSettings();
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  const { setShowHidden } = useShowHidden();

  // Atom setters are stable (Jotai guarantee) — safe to capture in the effect.
  const setActivePanel = useSetAtom(activePanelSideAtom);
  const [leftTabs, setLeftTabs] = useAtom(leftTabsAtom);
  const [rightTabs, setRightTabs] = useAtom(rightTabsAtom);
  const [leftActiveTabId, setLeftActiveTabId] = useAtom(leftActiveTabIdAtom);
  const [rightActiveTabId, setRightActiveTabId] = useAtom(rightActiveTabIdAtom);
  const leftActiveTab = useAtomValue(leftActiveTabAtom);
  const rightActiveTab = useAtomValue(rightActiveTabAtom);
  const setPanelsVisible = useSetAtom(panelsVisibleAtom);
  const setCommandPaletteOpen = useSetAtom(commandPaletteOpenAtom);

  const leftActiveTabRef = useRef(leftActiveTab);
  leftActiveTabRef.current = leftActiveTab;
  const rightActiveTabRef = useRef(rightActiveTab);
  rightActiveTabRef.current = rightActiveTab;
  const leftTabsRef = useRef(leftTabs);
  leftTabsRef.current = leftTabs;
  const rightTabsRef = useRef(rightTabs);
  rightTabsRef.current = rightTabs;
  const leftActiveTabIdRef = useRef(leftActiveTabId);
  leftActiveTabIdRef.current = leftActiveTabId;
  const rightActiveTabIdRef = useRef(rightActiveTabId);
  rightActiveTabIdRef.current = rightActiveTabId;
  const navigateToRef = useRef(navigateTo);
  navigateToRef.current = navigateTo;
  const cancelNavigationRef = useRef(cancelNavigation);
  cancelNavigationRef.current = cancelNavigation;
  const focusFileListRef = useRef(focusFileList);
  focusFileListRef.current = focusFileList;

  // const panelRef = useRef(activePanelSideRef.current === "left" ? leftRef.current : rightRef.current);
  // panelRef.current = activePanelSideRef.current === "left" ? leftRef.current : rightRef.current;

  const activeTab = useAtomValue(activeTabAtom);
  const activeTabRef = useRef(activeTab);
  activeTabRef.current = activeTab;
  const viewerOpenRef = useRef(deps.viewerOpen);
  viewerOpenRef.current = deps.viewerOpen;
  const activePanelSideRef = useRef(activePanelSide);
  activePanelSideRef.current = activePanelSide;
  const getPanelRef = useRef(getPanel);
  getPanelRef.current = getPanel;

  useEffect(() => {
    const disposables: Array<() => void> = [];
    const isEditorFocusActive = () => focusContextRef.current.is("editor");
    const registerEditorMovementCommand = (commandId: string, monacoCommandId: string) => {
      disposables.push(
        commandRegistry.registerCommand(
          commandId,
          async () => {
            await executeMountedExtensionCommand(DOTDIR_MONACO_EXECUTE_ACTION, [monacoCommandId]);
          },
          { isActive: isEditorFocusActive },
        ),
      );
    };

    const closePreviewOnSide = async (side: "left" | "right"): Promise<boolean> => {
      const activePreview = side === "left" ? leftActiveTabRef.current : rightActiveTabRef.current;
      if (!activePreview || activePreview.type !== "preview") return false;

      const tabsRef = side === "left" ? leftTabsRef : rightTabsRef;
      const activeIdRef = side === "left" ? leftActiveTabIdRef : rightActiveTabIdRef;
      const setTabs = side === "left" ? setLeftTabs : setRightTabs;
      const setActiveTabId = side === "left" ? setLeftActiveTabId : setRightActiveTabId;

      const closeNow = async () => {
        const currentTabs = tabsRef.current;
        if (currentTabs.length > 1) {
          const idx = currentTabs.findIndex((t) => t.id === activePreview.id);
          const next = currentTabs.filter((t) => t.id !== activePreview.id);
          if (activeIdRef.current === activePreview.id) {
            setActiveTabId(next[Math.min(idx, next.length - 1)]?.id ?? "");
          }
          setTabs(next);
          return;
        }

        const home = await bridgeRef.current.utils.getHomePath();
        const newTab = createFilelistTab(home);
        setTabs([newTab]);
        setActiveTabId(newTab.id);
      };

      if (activePreview.mode === "editor" && activePreview.dirty) {
        showDialogRef.current({
          type: "message",
          title: "Unsaved Changes",
          message: `Close "${activePreview.name}" and discard unsaved changes?`,
          buttons: [
            { label: "Cancel", default: true },
            { label: "Discard", onClick: () => void closeNow() },
          ],
        });
        return true;
      }

      await closeNow();
      return true;
    };

    // ── View ──────────────────────────────────────────────────────────────────

    disposables.push(
      commandRegistry.registerCommand(TOGGLE_HIDDEN_FILES, () => {
        const next = !settingsRef.current.showHidden;
        setShowHidden(next);
      }),
    );

    disposables.push(
      commandRegistry.registerCommand(RUN_COMMANDS, async (args) => {
        const payload = (args ?? null) as RunCommandsArgs | null;
        if (!payload || !Array.isArray(payload.commands)) return;
        await runCommandSequence(commandRegistry, payload.commands);
      }),
    );

    disposables.push(
      commandRegistry.registerCommand(TOGGLE_PANELS, () =>
        setPanelsVisible((v) => {
          if (activeSessionRef.current?.session.getCapabilities().commandRunning) {
            return v;
          }
          const next = !v;
          if (next) {
            focusContextRef.current.request("panel");
          } else {
            void commandRegistry.executeCommand(TERMINAL_FOCUS);
          }
          return next;
        }),
      ),
    );

    disposables.push(
      commandRegistry.registerCommand(SHOW_EXTENSIONS, () =>
        showDialogRef.current({
          type: "extensions",
        }),
      ),
    );
    disposables.push(
      commandRegistry.registerCommand(SHOW_SETTINGS, () =>
        showDialogRef.current({
          type: "settings",
        }),
      ),
    );
    disposables.push(
      commandRegistry.registerCommand(SHOW_FIND_FILES, async () => {
        const currentPath =
          activeTabRef.current?.type === "filelist" ? activeTabRef.current.path : await bridgeRef.current.utils.getHomePath();
        const [homePath, mountedRoots] = await Promise.all([
          bridgeRef.current.utils.getHomePath(),
          bridgeRef.current.utils.getMountedRoots(),
        ]);
        const initialRequest: FileSearchRequest = {
          startPath: currentPath,
          ignoreDirsEnabled: true,
          ignoreDirs: [".git", "node_modules", "dist"],
          filePattern: "*",
          contentPattern: "",
          recursive: true,
          followSymlinks: false,
          shellPatterns: true,
          caseSensitiveFileName: false,
          wholeWords: false,
          regex: false,
          caseSensitiveContent: false,
          allCharsets: false,
          firstHit: false,
          skipHidden: false,
        };
        const suggestionRoots = [
          { id: "current", label: "Current Panel", path: currentPath },
          { id: "home", label: "Home", path: homePath },
          ...mountedRoots
            .filter((root) => root !== homePath && root !== currentPath)
            .map((root) => ({ id: `root:${root}`, label: root, path: root })),
        ];
        const openResults = (request: FileSearchRequest) => {
          replaceDialogRef.current({
            type: "findFilesResults",
            request,
            onAgain: (nextRequest) => {
              replaceDialogRef.current({
                type: "findFiles",
                initialRequest: nextRequest,
                suggestionRoots,
                onConfirm: openResults,
                onCancel: () => {},
              });
            },
            onClose: () => {},
            onChdir: (path) => {
              void navigateToRef.current(path);
            },
            onViewFile: async (path) => {
              const stat = await bridgeRef.current.fs.stat(path);
              depsRef.current.onViewFile(path, basename(path), stat.size);
            },
            onEditFile: async (path) => {
              const stat = await bridgeRef.current.fs.stat(path);
              depsRef.current.onEditFile(path, basename(path), stat.size, languageRegistryRef.current.getLanguageForFilename(basename(path)));
            },
          });
        };
        showDialogRef.current({
          type: "findFiles",
          initialRequest,
          suggestionRoots,
          onConfirm: openResults,
          onCancel: () => {},
        });
      }),
    );
    disposables.push(commandRegistry.registerCommand(SHOW_COMMAND_PALETTE, () => setCommandPaletteOpen((o) => !o)));
    disposables.push(commandRegistry.registerCommand(CLOSE_VIEWER, () => depsRef.current.onRequestCloseViewer()));
    disposables.push(commandRegistry.registerCommand(CLOSE_EDITOR, () => depsRef.current.onRequestCloseEditor()));
    disposables.push(
      commandRegistry.registerCommand(DOTDIR_EDITOR_SAVE, async () => {
        await executeMountedExtensionCommand("dotdir.save", []);
      }),
    );
    disposables.push(
      commandRegistry.registerCommand(DOTDIR_EDITOR_FIND, async () => {
        await executeMountedExtensionCommand(DOTDIR_MONACO_EXECUTE_ACTION, ["actions.find"]);
      }),
    );
    registerEditorMovementCommand(CURSOR_UP, "cursorUp");
    registerEditorMovementCommand(CURSOR_DOWN, "cursorDown");
    registerEditorMovementCommand(CURSOR_LEFT, "cursorLeft");
    registerEditorMovementCommand(CURSOR_RIGHT, "cursorRight");
    registerEditorMovementCommand(CURSOR_HOME, "cursorHome");
    registerEditorMovementCommand(CURSOR_END, "cursorEnd");
    registerEditorMovementCommand(CURSOR_DOCUMENT_START, "cursorTop");
    registerEditorMovementCommand(CURSOR_DOCUMENT_END, "cursorBottom");
    registerEditorMovementCommand(CURSOR_PAGE_UP, "cursorPageUp");
    registerEditorMovementCommand(CURSOR_PAGE_DOWN, "cursorPageDown");
    registerEditorMovementCommand(CURSOR_WORD_LEFT, "cursorWordLeft");
    registerEditorMovementCommand(CURSOR_WORD_RIGHT, "cursorWordRight");
    registerEditorMovementCommand(SELECT_UP, "cursorUpSelect");
    registerEditorMovementCommand(SELECT_DOWN, "cursorDownSelect");
    registerEditorMovementCommand(SELECT_LEFT, "cursorLeftSelect");
    registerEditorMovementCommand(SELECT_RIGHT, "cursorRightSelect");
    registerEditorMovementCommand(SELECT_HOME, "cursorHomeSelect");
    registerEditorMovementCommand(SELECT_END, "cursorEndSelect");
    registerEditorMovementCommand(SELECT_PAGE_UP, "cursorPageUpSelect");
    registerEditorMovementCommand(SELECT_PAGE_DOWN, "cursorPageDownSelect");
    registerEditorMovementCommand(SELECT_WORD_LEFT, "cursorWordLeftSelect");
    registerEditorMovementCommand(SELECT_WORD_RIGHT, "cursorWordRightSelect");
    registerEditorMovementCommand(SELECT_ALL, "editor.action.selectAll");

    // ── Navigation ────────────────────────────────────────────────────────────

    disposables.push(
      commandRegistry.registerCommand(SWITCH_PANEL, () => {
        const nextSide = activePanelSideRef.current === "left" ? "right" : "left";
        setActivePanel(nextSide);
        requestAnimationFrame(() => {
          focusContextRef.current.request("panel");
          focusFileListRef.current(nextSide);
        });
      }),
    );
    disposables.push(
      commandRegistry.registerCommand(DOTDIR_FOCUS_LEFT_PANEL, () => {
        setActivePanel("left");
        requestAnimationFrame(() => {
          focusContextRef.current.request("panel");
          focusFileListRef.current("left");
        });
      }),
    );
    disposables.push(
      commandRegistry.registerCommand(DOTDIR_FOCUS_RIGHT_PANEL, () => {
        setActivePanel("right");
        requestAnimationFrame(() => {
          focusContextRef.current.request("panel");
          focusFileListRef.current("right");
        });
      }),
    );

    disposables.push(
      commandRegistry.registerCommand(DOTDIR_CANCEL_NAVIGATION, () => {
        cancelNavigationRef.current?.();
      }),
    );

    disposables.push(
      commandRegistry.registerCommand(DOTDIR_PANEL_ESCAPE, async () => {
        const panel = getPanelRef.current(activePanelSideRef.current);
        if (panel?.navigating) {
          cancelNavigationRef.current?.();
          return;
        }

        if (commandRegistry.getContext("commandLineHasText")) {
          await commandRegistry.executeCommand(CLEAR);
          return;
        }

        if (activeTabRef.current?.type === "preview") {
          await commandRegistry.executeCommand(CLOSE_TAB);
          return;
        }

        if (await closePreviewOnSide(activePanelSideRef.current === "left" ? "right" : "left")) {
          return;
        }

        if (viewerOpenRef.current) {
          await commandRegistry.executeCommand(CLOSE_VIEWER);
        }
      }),
    );

    // ── File ──────────────────────────────────────────────────────────────────

    disposables.push(
      commandRegistry.registerCommand(OPEN_CREATE_FILE, () => {
        if (activeTabRef.current?.type !== "filelist") return;
        const currentPath = activeTabRef.current.path;
        const { onOpenCreateFileConfirm } = depsRef.current;
        showDialogRef.current({
          type: "openCreateFile",
          currentPath,
          onConfirm: onOpenCreateFileConfirm,
          onCancel: () => {},
        });
      }),
    );

    disposables.push(
      commandRegistry.registerCommand(LIST_MAKE_DIR, () => {
        if (activeTabRef.current?.type !== "filelist") return;
        const currentPath = activeTabRef.current.path;
        showDialogRef.current({
          type: "makeFolder",
          currentPath,
          onConfirm: async (result) => {
            const join = (name: string) => (currentPath ? `${currentPath.replace(/\/?$/, "")}/${name}` : name);
            if (result.mode === "single") {
              const fullPath = join(result.name);
              if (bridgeRef.current.fs.createDir) await bridgeRef.current.fs.createDir(fullPath);
              void navigateToRef.current(fullPath);
              return;
            }
            for (const name of result.names) {
              const fullPath = join(name);
              if (bridgeRef.current.fs.createDir) await bridgeRef.current.fs.createDir(fullPath);
            }
            void navigateToRef.current(currentPath);
          },
          onCancel: () => {},
        });
      }),
    );

    // ── Application ───────────────────────────────────────────────────────────

    disposables.push(
      commandRegistry.registerCommand(DOTDIR_NEW_WINDOW, async () => {
        if (!bridgeRef.current.window) return;
        const current = await bridgeRef.current.window.getCurrentState();
        const windowId = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `window-${Date.now()}`;

        await ensureWindowRef.current(windowId);
        try {
          await bridgeRef.current.window.create({
            id: windowId,
            width: current.width,
            height: current.height,
            x: current.x + 40,
            y: current.y + 40,
            isMaximized: false,
          });
        } catch (err) {
          await removeWindowRef.current(windowId);
          throw err;
        }
      }),
    );

    disposables.push(
      commandRegistry.registerCommand(DOTDIR_CLOSE_WINDOW, async () => {
        await Promise.all([flushCurrentWindowLayoutRef.current(), flushCurrentWindowStateRef.current()]);

        if (bridgeRef.current.window) {
          const currentWindowId = await getCurrentWindowIdRef.current();
          const windowIds = await getWindowIdsRef.current();
          if (windowIds.length > 1) {
            await removeWindowRef.current(currentWindowId);
          } else {
            await ensureWindowRef.current(currentWindowId);
          }
          await bridgeRef.current.window.closeCurrent();
          return;
        }

        window.close();
      }),
    );

    disposables.push(
      commandRegistry.registerCommand(DOTDIR_EXIT, async () => {
        await Promise.all([flushCurrentWindowLayoutRef.current(), flushCurrentWindowStateRef.current()]);

        if (bridgeRef.current.window?.exitApp) {
          await bridgeRef.current.window.exitApp();
          return;
        }

        if (bridgeRef.current.window) {
          await bridgeRef.current.window.closeCurrent();
          return;
        }

        if (isTauriApp()) return;
        window.close();
      }),
    );

    // ── Terminal ──────────────────────────────────────────────────────────────

    disposables.push(
      commandRegistry.registerCommand(SHELL_EXECUTE, async (path: unknown) => {
        const name = basename(path as string);
        const arg = /^[a-zA-Z0-9._+-]+$/.test(name) ? `./${name}` : `./${JSON.stringify(name)}`;
        await runCommandRef.current(arg, activeCwdRef.current);
      }),
    );

    // ── Viewer / Editor ───────────────────────────────────────────────────────

    disposables.push(
      commandRegistry.registerCommand(VIEW_FILE, (path: unknown, name: unknown, size: unknown) => {
        depsRef.current.onViewFile(path as string, name as string, size as number);
      }),
    );

    disposables.push(
      commandRegistry.registerCommand(EDIT_FILE, (path: unknown, name: unknown, size: unknown, langId: unknown) => {
        const limit = settingsRef.current.editorFileSizeLimit ?? DEFAULT_EDITOR_FILE_SIZE_LIMIT;
        if (limit > 0 && (size as number) > limit) return;
        depsRef.current.onEditFile(path as string, name as string, size as number, langId as string);
      }),
    );

    disposables.push(
      commandRegistry.registerCommand(PASTE_LEFT_PANEL_PATH, () => {
        const path = leftActiveTabRef.current?.type === "filelist" ? leftActiveTabRef.current.path : "";
        if (!path) return;
        const arg = /^[a-zA-Z0-9._+/:-]+$/.test(path) ? path : JSON.stringify(path);
        pasteToCommandLine(arg);
      }),
    );
    disposables.push(
      commandRegistry.registerCommand(PASTE_RIGHT_PANEL_PATH, () => {
        const path = rightActiveTabRef.current?.type === "filelist" ? rightActiveTabRef.current.path : "";
        if (!path) return;
        const arg = /^[a-zA-Z0-9._+/:-]+$/.test(path) ? path : JSON.stringify(path);
        pasteToCommandLine(arg);
      }),
    );

    // ── Keybindings ───────────────────────────────────────────────────────────

    disposables.push(...registerAppBuiltInKeybindings(commandRegistry));
    disposables.push(...registerFileListKeybindings(commandRegistry));

    return () => {
      for (const d of disposables) d();
    };
    // Intentionally register built-in commands once. Call-time behavior reads
    // the latest state through refs above, so dependency churn here only causes
    // unnecessary unregister/register storms.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pasteToCommandLine, commandRegistry]);
}
