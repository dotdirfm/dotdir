import { isTauri as isTauriApp } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { RefObject, useEffect, useRef } from "react";
import {
  activePanelAtom,
  commandPaletteOpenAtom,
  editorFileAtom,
  loadedExtensionsAtom,
  panelsVisibleAtom,
  showExtensionsAtom,
  showHiddenAtom,
  viewerFileAtom,
} from "./atoms";
import { bridge } from "./bridge";
import { commandRegistry } from "./commands";
import { isContainerPath, parseContainerPath } from "./containerPath";
import type { DialogSpec } from "./dialogContext";
import { focusContext } from "./focusContext";
import { getActiveFileListHandlers } from "./fileListHandlers";
import { getActivePanelGroupHandlers } from "./panelGroupHandlers";
import type { LanguageOption } from "./OpenCreateFileDialog";
import { basename, dirname } from "./path";
import { registerAppBuiltInKeybindings, registerFileListKeybindings } from "./registerKeybindings";
import { useUserSettings } from "./useUserSettings";

interface PanelHandle {
  currentPath: string;
  navigateTo: (path: string, force?: boolean, cursorName?: string) => Promise<void>;
  cancelNavigation: () => void;
}

export interface BuiltInCommandDeps {
  leftRef: RefObject<PanelHandle>;
  rightRef: RefObject<PanelHandle>;
  onPreviewInOppositePanel: () => void;
  onOpenCurrentFolderInOppositeCurrentTab: () => void;
  onOpenCurrentFolderInOppositeNewTab: () => void;
  onOpenSelectedFolderInOppositeCurrentTab: () => void;
  onOpenSelectedFolderInOppositeNewTab: () => void;
  onOpenCreateFileConfirm: (path: string, name: string, langId: string) => Promise<void>;
  showDialog: (spec: DialogSpec) => void;
  onViewFile: (filePath: string, fileName: string, fileSize: number) => void;
  onEditFile: (filePath: string, fileName: string, fileSize: number, langId: string) => void;
  onExecuteInTerminal: (cmd: string) => Promise<void>;
  editorFileSizeLimit: number;
}

export function useBuiltInCommands(deps: BuiltInCommandDeps): void {
  // Updated every render so command handlers always see the latest callbacks.
  const depsRef = useRef(deps);
  depsRef.current = deps;

  // loadedExtensions changes as extensions load; keep a ref for call-time reads.
  const loadedExtensions = useAtomValue(loadedExtensionsAtom);
  const loadedExtensionsRef = useRef(loadedExtensions);
  loadedExtensionsRef.current = loadedExtensions;

  const { updateSettings } = useUserSettings();

  // Atom setters are stable (Jotai guarantee) — safe to capture in the effect.
  const [activePanel, setActivePanel] = useAtom(activePanelAtom);
  const setShowHidden = useSetAtom(showHiddenAtom);
  const setPanelsVisible = useSetAtom(panelsVisibleAtom);
  const setShowExtensions = useSetAtom(showExtensionsAtom);
  const setViewerFile = useSetAtom(viewerFileAtom);
  const setEditorFile = useSetAtom(editorFileAtom);
  const setCommandPaletteOpen = useSetAtom(commandPaletteOpenAtom);

  const activePanelRef = useRef(activePanel);
  activePanelRef.current = activePanel;

  useEffect(() => {
    const disposables: Array<() => void> = [];

    // ── View ──────────────────────────────────────────────────────────────────

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
            if (next) focusContext.set("panel");
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

    disposables.push(
      commandRegistry.registerCommand("faraday.showCommandPalette", "Show All Commands", () => setCommandPaletteOpen((o) => !o), { category: "View" }),
    );

    disposables.push(
      commandRegistry.registerCommand("faraday.closeViewer", "Close Viewer", () => setViewerFile(null), {
        category: "View",
      }),
    );

    disposables.push(
      commandRegistry.registerCommand("faraday.closeEditor", "Close Editor", () => setEditorFile(null), {
        category: "View",
      }),
    );

    // ── Navigation ────────────────────────────────────────────────────────────

    disposables.push(
      commandRegistry.registerCommand("faraday.switchPanel", "Switch Panel", () => setActivePanel((s) => (s === "left" ? "right" : "left")), {
        category: "Navigation",
      }),
    );

    disposables.push(
      commandRegistry.registerCommand("faraday.focusLeftPanel", "Focus Left Panel", () => setActivePanel("left"), {
        category: "Navigation",
      }),
    );

    disposables.push(
      commandRegistry.registerCommand("faraday.focusRightPanel", "Focus Right Panel", () => setActivePanel("right"), {
        category: "Navigation",
      }),
    );

    disposables.push(
      commandRegistry.registerCommand(
        "faraday.cancelNavigation",
        "Cancel Navigation",
        () => {
          depsRef.current.leftRef.current.cancelNavigation();
          depsRef.current.rightRef.current.cancelNavigation();
        },
        { category: "Navigation" },
      ),
    );

    disposables.push(
      commandRegistry.registerCommand(
        "faraday.goToParent",
        "Go to Parent Directory",
        () => {
          const { leftRef, rightRef } = depsRef.current;
          const panel = activePanelRef.current === "left" ? leftRef.current : rightRef.current;
          const currentPath = panel.currentPath;
          if (isContainerPath(currentPath)) {
            const { containerFile, innerPath } = parseContainerPath(currentPath);
            if (innerPath === "/" || innerPath === "") {
              void panel.navigateTo(dirname(containerFile), false, basename(containerFile));
              return;
            }
          }
          const parent = dirname(currentPath);
          if (parent !== currentPath) void panel.navigateTo(parent);
        },
        { category: "Navigation" },
      ),
    );

    disposables.push(
      commandRegistry.registerCommand(
        "faraday.goHome",
        "Go to Home Directory",
        async () => {
          const { leftRef, rightRef } = depsRef.current;
          const home = await bridge.utils.getHomePath();
          const panel = activePanelRef.current === "left" ? leftRef.current : rightRef.current;
          void panel.navigateTo(home);
        },
        { category: "Navigation" },
      ),
    );

    // ── File ──────────────────────────────────────────────────────────────────

    disposables.push(
      commandRegistry.registerCommand(
        "faraday.refresh",
        "Refresh",
        () => {
          const { leftRef, rightRef } = depsRef.current;
          const panel = activePanelRef.current === "left" ? leftRef.current : rightRef.current;
          void panel.navigateTo(panel.currentPath);
        },
        { category: "File" },
      ),
    );

    disposables.push(
      commandRegistry.registerCommand(
        "faraday.newTab",
        "New Tab",
        () => {
          void getActivePanelGroupHandlers()?.newTab();
        },
        { category: "File" },
      ),
    );

    disposables.push(
      commandRegistry.registerCommand(
        "faraday.closeTab",
        "Close Tab",
        () => {
          void getActivePanelGroupHandlers()?.closeActiveTab();
        },
        { category: "File" },
      ),
    );

    disposables.push(
      commandRegistry.registerCommand("faraday.previewInOppositePanel", "Show Preview in Opposite Panel", () => depsRef.current.onPreviewInOppositePanel(), {
        category: "File",
      }),
    );

    disposables.push(
      commandRegistry.registerCommand(
        "faraday.openCurrentFolderInOppositePanelCurrentTab",
        "Open Current Folder in Opposite Panel (Current Tab)",
        () => depsRef.current.onOpenCurrentFolderInOppositeCurrentTab(),
        { category: "File" },
      ),
    );

    disposables.push(
      commandRegistry.registerCommand(
        "faraday.openCurrentFolderInOppositePanelNewTab",
        "Open Current Folder in Opposite Panel (New Tab)",
        () => depsRef.current.onOpenCurrentFolderInOppositeNewTab(),
        { category: "File" },
      ),
    );

    disposables.push(
      commandRegistry.registerCommand(
        "faraday.openSelectedFolderInOppositePanelCurrentTab",
        "Open Selected Folder in Opposite Panel (Current Tab)",
        () => depsRef.current.onOpenSelectedFolderInOppositeCurrentTab(),
        { category: "File" },
      ),
    );

    disposables.push(
      commandRegistry.registerCommand(
        "faraday.openSelectedFolderInOppositePanelNewTab",
        "Open Selected Folder in Opposite Panel (New Tab)",
        () => depsRef.current.onOpenSelectedFolderInOppositeNewTab(),
        { category: "File" },
      ),
    );

    disposables.push(
      commandRegistry.registerCommand(
        "faraday.openCreateFile",
        "Open / Create File",
        () => {
          const { leftRef, rightRef, showDialog, onOpenCreateFileConfirm } = depsRef.current;
          const panel = activePanelRef.current === "left" ? leftRef.current : rightRef.current;
          const currentPath = panel.currentPath;
          const langList = loadedExtensionsRef.current.flatMap((e) => e.languages ?? []);
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
            onConfirm: onOpenCreateFileConfirm,
            onCancel: () => {},
          });
        },
        { category: "File" },
      ),
    );

    disposables.push(
      commandRegistry.registerCommand(
        "faraday.makeFolder",
        "Make Folder",
        () => {
          const { leftRef, rightRef, showDialog } = depsRef.current;
          const panel = activePanelRef.current === "left" ? leftRef.current : rightRef.current;
          const currentPath = panel.currentPath;
          showDialog({
            type: "makeFolder",
            currentPath,
            onConfirm: async (result) => {
              const join = (name: string) => (currentPath ? `${currentPath.replace(/\/?$/, "")}/${name}` : name);
              if (result.mode === "single") {
                const fullPath = join(result.name);
                if (bridge.fs.createDir) await bridge.fs.createDir(fullPath);
                void panel.navigateTo(fullPath);
                return;
              }
              for (const name of result.names) {
                const fullPath = join(name);
                if (bridge.fs.createDir) await bridge.fs.createDir(fullPath);
              }
              void panel.navigateTo(currentPath);
            },
            onCancel: () => {},
          });
        },
        { category: "File" },
      ),
    );

    // ── Application ───────────────────────────────────────────────────────────

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

    // ── Terminal ──────────────────────────────────────────────────────────────

    disposables.push(
      commandRegistry.registerCommand(
        "terminal.execute",
        "Execute in Terminal",
        async (path: unknown) => {
          const name = basename(path as string);
          const arg = /^[a-zA-Z0-9._+-]+$/.test(name) ? `./${name}` : `./${JSON.stringify(name)}`;
          await depsRef.current.onExecuteInTerminal(`${arg}\r`);
        },
        { category: "Terminal" },
      ),
    );

    // ── Viewer / Editor ───────────────────────────────────────────────────────

    disposables.push(
      commandRegistry.registerCommand(
        "faraday.viewFile",
        "View File",
        (path: unknown, name: unknown, size: unknown) => {
          depsRef.current.onViewFile(path as string, name as string, size as number);
        },
        { category: "File" },
      ),
    );

    disposables.push(
      commandRegistry.registerCommand(
        "faraday.editFile",
        "Edit File",
        (path: unknown, name: unknown, size: unknown, langId: unknown) => {
          const limit = depsRef.current.editorFileSizeLimit;
          if (limit > 0 && (size as number) > limit) return;
          depsRef.current.onEditFile(path as string, name as string, size as number, langId as string);
        },
        { category: "File" },
      ),
    );

    // ── File List ─────────────────────────────────────────────────────────────

    const nav = "Navigation";
    disposables.push(commandRegistry.registerCommand("list.cursorUp", "Cursor Up", () => getActiveFileListHandlers()?.cursorUp(), { category: nav }));
    disposables.push(commandRegistry.registerCommand("list.cursorDown", "Cursor Down", () => getActiveFileListHandlers()?.cursorDown(), { category: nav }));
    disposables.push(
      commandRegistry.registerCommand("list.cursorLeft", "Cursor Left (Previous Column)", () => getActiveFileListHandlers()?.cursorLeft(), { category: nav }),
    );
    disposables.push(
      commandRegistry.registerCommand("list.cursorRight", "Cursor Right (Next Column)", () => getActiveFileListHandlers()?.cursorRight(), { category: nav }),
    );
    disposables.push(commandRegistry.registerCommand("list.cursorHome", "Cursor to First", () => getActiveFileListHandlers()?.cursorHome(), { category: nav }));
    disposables.push(commandRegistry.registerCommand("list.cursorEnd", "Cursor to Last", () => getActiveFileListHandlers()?.cursorEnd(), { category: nav }));
    disposables.push(
      commandRegistry.registerCommand("list.cursorPageUp", "Cursor Page Up", () => getActiveFileListHandlers()?.cursorPageUp(), { category: nav }),
    );
    disposables.push(
      commandRegistry.registerCommand("list.cursorPageDown", "Cursor Page Down", () => getActiveFileListHandlers()?.cursorPageDown(), { category: nav }),
    );
    disposables.push(commandRegistry.registerCommand("list.selectUp", "Select Up", () => getActiveFileListHandlers()?.selectUp(), { category: nav }));
    disposables.push(commandRegistry.registerCommand("list.selectDown", "Select Down", () => getActiveFileListHandlers()?.selectDown(), { category: nav }));
    disposables.push(commandRegistry.registerCommand("list.selectLeft", "Select Left", () => getActiveFileListHandlers()?.selectLeft(), { category: nav }));
    disposables.push(commandRegistry.registerCommand("list.selectRight", "Select Right", () => getActiveFileListHandlers()?.selectRight(), { category: nav }));
    disposables.push(commandRegistry.registerCommand("list.selectHome", "Select to First", () => getActiveFileListHandlers()?.selectHome(), { category: nav }));
    disposables.push(commandRegistry.registerCommand("list.selectEnd", "Select to Last", () => getActiveFileListHandlers()?.selectEnd(), { category: nav }));
    disposables.push(
      commandRegistry.registerCommand("list.selectPageUp", "Select Page Up", () => getActiveFileListHandlers()?.selectPageUp(), { category: nav }),
    );
    disposables.push(
      commandRegistry.registerCommand("list.selectPageDown", "Select Page Down", () => getActiveFileListHandlers()?.selectPageDown(), { category: nav }),
    );
    disposables.push(commandRegistry.registerCommand("list.execute", "Execute in Terminal", () => getActiveFileListHandlers()?.execute(), { category: nav }));
    disposables.push(commandRegistry.registerCommand("list.open", "Open", () => getActiveFileListHandlers()?.open(), { category: nav }));
    disposables.push(commandRegistry.registerCommand("list.viewFile", "View File", () => getActiveFileListHandlers()?.viewFile(), { category: nav }));
    disposables.push(commandRegistry.registerCommand("list.editFile", "Edit File", () => getActiveFileListHandlers()?.editFile(), { category: nav }));
    disposables.push(
      commandRegistry.registerCommand("list.moveToTrash", "Move to Trash", () => getActiveFileListHandlers()?.moveToTrash(), { category: "File" }),
    );
    disposables.push(
      commandRegistry.registerCommand("list.permanentDelete", "Permanently Delete", () => getActiveFileListHandlers()?.permanentDelete(), { category: "File" }),
    );
    disposables.push(commandRegistry.registerCommand("list.copy", "Copy", () => getActiveFileListHandlers()?.copy(), { category: "File" }));
    disposables.push(commandRegistry.registerCommand("list.move", "Move", () => getActiveFileListHandlers()?.move(), { category: "File" }));
    disposables.push(commandRegistry.registerCommand("list.rename", "Rename", () => getActiveFileListHandlers()?.rename(), { category: "File" }));
    disposables.push(
      commandRegistry.registerCommand("list.pasteFilename", "Paste Filename to Command Line", () => getActiveFileListHandlers()?.pasteFilename(), {
        category: "File",
      }),
    );
    disposables.push(
      commandRegistry.registerCommand("list.pastePath", "Paste Path to Command Line", () => getActiveFileListHandlers()?.pastePath(), { category: "File" }),
    );

    // ── Keybindings ───────────────────────────────────────────────────────────

    disposables.push(...registerAppBuiltInKeybindings(commandRegistry));
    disposables.push(...registerFileListKeybindings(commandRegistry));

    return () => {
      for (const d of disposables) d();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- atom setters and updateSettings are stable; effect intentionally runs once
  }, [setActivePanel, setShowHidden, setPanelsVisible, setShowExtensions, setViewerFile, setEditorFile, setCommandPaletteOpen, updateSettings]);
}
