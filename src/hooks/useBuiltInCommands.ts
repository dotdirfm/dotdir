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
} from "../atoms";
import { bridge } from "../bridge";
import { commandRegistry } from "../commands";
import { isContainerPath, parseContainerPath } from "../containerPath";
import type { DialogSpec } from "../dialogs/dialogContext";
import { focusContext } from "../focusContext";
import { getActiveFileListHandlers } from "../fileListHandlers";
import { getActivePanelGroupHandlers } from "../panelGroupHandlers";
import type { LanguageOption } from "../dialogs/OpenCreateFileDialog";
import { basename, dirname } from "../path";
import { registerAppBuiltInKeybindings, registerFileListKeybindings } from "../registerKeybindings";
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
      commandRegistry.registerCommand("dotdir.toggleHiddenFiles", () =>
        setShowHidden((h) => {
          const next = !h;
          updateSettings({ showHidden: next });
          return next;
        }),
      ),
    );

    disposables.push(
      commandRegistry.registerCommand("dotdir.togglePanels", () =>
        setPanelsVisible((v) => {
          const next = !v;
          if (next) focusContext.set("panel");
          return next;
        }),
      ),
    );

    disposables.push(commandRegistry.registerCommand("dotdir.showExtensions", () => setShowExtensions(true)));
    disposables.push(commandRegistry.registerCommand("dotdir.showCommandPalette", () => setCommandPaletteOpen((o) => !o)));
    disposables.push(commandRegistry.registerCommand("dotdir.closeViewer", () => setViewerFile(null)));
    disposables.push(commandRegistry.registerCommand("dotdir.closeEditor", () => setEditorFile(null)));

    // ── Navigation ────────────────────────────────────────────────────────────

    disposables.push(commandRegistry.registerCommand("dotdir.switchPanel", () => setActivePanel((s) => (s === "left" ? "right" : "left"))));
    disposables.push(commandRegistry.registerCommand("dotdir.focusLeftPanel", () => setActivePanel("left")));
    disposables.push(commandRegistry.registerCommand("dotdir.focusRightPanel", () => setActivePanel("right")));

    disposables.push(
      commandRegistry.registerCommand("dotdir.cancelNavigation", () => {
        depsRef.current.leftRef.current.cancelNavigation();
        depsRef.current.rightRef.current.cancelNavigation();
      }),
    );

    disposables.push(
      commandRegistry.registerCommand("dotdir.goToParent", () => {
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
      }),
    );

    disposables.push(
      commandRegistry.registerCommand("dotdir.goHome", async () => {
        const { leftRef, rightRef } = depsRef.current;
        const home = await bridge.utils.getHomePath();
        const panel = activePanelRef.current === "left" ? leftRef.current : rightRef.current;
        void panel.navigateTo(home);
      }),
    );

    // ── File ──────────────────────────────────────────────────────────────────

    disposables.push(
      commandRegistry.registerCommand("dotdir.refresh", () => {
        const { leftRef, rightRef } = depsRef.current;
        const panel = activePanelRef.current === "left" ? leftRef.current : rightRef.current;
        void panel.navigateTo(panel.currentPath);
      }),
    );

    disposables.push(commandRegistry.registerCommand("dotdir.newTab", () => void getActivePanelGroupHandlers()?.newTab()));
    disposables.push(commandRegistry.registerCommand("dotdir.closeTab", () => void getActivePanelGroupHandlers()?.closeActiveTab()));
    disposables.push(commandRegistry.registerCommand("dotdir.previewInOppositePanel", () => depsRef.current.onPreviewInOppositePanel()));
    disposables.push(
      commandRegistry.registerCommand("dotdir.openCurrentFolderInOppositePanelCurrentTab", () => depsRef.current.onOpenCurrentFolderInOppositeCurrentTab()),
    );
    disposables.push(
      commandRegistry.registerCommand("dotdir.openCurrentFolderInOppositePanelNewTab", () => depsRef.current.onOpenCurrentFolderInOppositeNewTab()),
    );
    disposables.push(
      commandRegistry.registerCommand("dotdir.openSelectedFolderInOppositePanelCurrentTab", () => depsRef.current.onOpenSelectedFolderInOppositeCurrentTab()),
    );
    disposables.push(
      commandRegistry.registerCommand("dotdir.openSelectedFolderInOppositePanelNewTab", () => depsRef.current.onOpenSelectedFolderInOppositeNewTab()),
    );

    disposables.push(
      commandRegistry.registerCommand("dotdir.openCreateFile", () => {
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
      }),
    );

    disposables.push(
      commandRegistry.registerCommand("dotdir.makeFolder", () => {
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
      }),
    );

    // ── Application ───────────────────────────────────────────────────────────

    disposables.push(
      commandRegistry.registerCommand("dotdir.exit", async () => {
        if (isTauriApp()) {
          await getCurrentWindow().close();
        } else {
          window.close();
        }
      }),
    );

    // ── Terminal ──────────────────────────────────────────────────────────────

    disposables.push(
      commandRegistry.registerCommand("terminal.execute", async (path: unknown) => {
        const name = basename(path as string);
        const arg = /^[a-zA-Z0-9._+-]+$/.test(name) ? `./${name}` : `./${JSON.stringify(name)}`;
        await depsRef.current.onExecuteInTerminal(`${arg}\r`);
      }),
    );

    // ── Viewer / Editor ───────────────────────────────────────────────────────

    disposables.push(
      commandRegistry.registerCommand("dotdir.viewFile", (path: unknown, name: unknown, size: unknown) => {
        depsRef.current.onViewFile(path as string, name as string, size as number);
      }),
    );

    disposables.push(
      commandRegistry.registerCommand("dotdir.editFile", (path: unknown, name: unknown, size: unknown, langId: unknown) => {
        const limit = depsRef.current.editorFileSizeLimit;
        if (limit > 0 && (size as number) > limit) return;
        depsRef.current.onEditFile(path as string, name as string, size as number, langId as string);
      }),
    );

    // ── File List ─────────────────────────────────────────────────────────────

    disposables.push(commandRegistry.registerCommand("list.cursorUp", () => getActiveFileListHandlers()?.cursorUp()));
    disposables.push(commandRegistry.registerCommand("list.cursorDown", () => getActiveFileListHandlers()?.cursorDown()));
    disposables.push(commandRegistry.registerCommand("list.cursorLeft", () => getActiveFileListHandlers()?.cursorLeft()));
    disposables.push(commandRegistry.registerCommand("list.cursorRight", () => getActiveFileListHandlers()?.cursorRight()));
    disposables.push(commandRegistry.registerCommand("list.cursorHome", () => getActiveFileListHandlers()?.cursorHome()));
    disposables.push(commandRegistry.registerCommand("list.cursorEnd", () => getActiveFileListHandlers()?.cursorEnd()));
    disposables.push(commandRegistry.registerCommand("list.cursorPageUp", () => getActiveFileListHandlers()?.cursorPageUp()));
    disposables.push(commandRegistry.registerCommand("list.cursorPageDown", () => getActiveFileListHandlers()?.cursorPageDown()));
    disposables.push(commandRegistry.registerCommand("list.selectUp", () => getActiveFileListHandlers()?.selectUp()));
    disposables.push(commandRegistry.registerCommand("list.selectDown", () => getActiveFileListHandlers()?.selectDown()));
    disposables.push(commandRegistry.registerCommand("list.selectLeft", () => getActiveFileListHandlers()?.selectLeft()));
    disposables.push(commandRegistry.registerCommand("list.selectRight", () => getActiveFileListHandlers()?.selectRight()));
    disposables.push(commandRegistry.registerCommand("list.selectHome", () => getActiveFileListHandlers()?.selectHome()));
    disposables.push(commandRegistry.registerCommand("list.selectEnd", () => getActiveFileListHandlers()?.selectEnd()));
    disposables.push(commandRegistry.registerCommand("list.selectPageUp", () => getActiveFileListHandlers()?.selectPageUp()));
    disposables.push(commandRegistry.registerCommand("list.selectPageDown", () => getActiveFileListHandlers()?.selectPageDown()));
    disposables.push(commandRegistry.registerCommand("list.execute", () => getActiveFileListHandlers()?.execute()));
    disposables.push(commandRegistry.registerCommand("list.open", () => getActiveFileListHandlers()?.open()));
    disposables.push(commandRegistry.registerCommand("list.viewFile", () => getActiveFileListHandlers()?.viewFile()));
    disposables.push(commandRegistry.registerCommand("list.editFile", () => getActiveFileListHandlers()?.editFile()));
    disposables.push(commandRegistry.registerCommand("list.moveToTrash", () => getActiveFileListHandlers()?.moveToTrash()));
    disposables.push(commandRegistry.registerCommand("list.permanentDelete", () => getActiveFileListHandlers()?.permanentDelete()));
    disposables.push(commandRegistry.registerCommand("list.copy", () => getActiveFileListHandlers()?.copy()));
    disposables.push(commandRegistry.registerCommand("list.move", () => getActiveFileListHandlers()?.move()));
    disposables.push(commandRegistry.registerCommand("list.rename", () => getActiveFileListHandlers()?.rename()));
    disposables.push(commandRegistry.registerCommand("list.pasteFilename", () => getActiveFileListHandlers()?.pasteFilename()));
    disposables.push(commandRegistry.registerCommand("list.pastePath", () => getActiveFileListHandlers()?.pastePath()));

    // ── Keybindings ───────────────────────────────────────────────────────────

    disposables.push(...registerAppBuiltInKeybindings(commandRegistry));
    disposables.push(...registerFileListKeybindings(commandRegistry));

    return () => {
      for (const d of disposables) d();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- atom setters and updateSettings are stable; effect intentionally runs once
  }, [setActivePanel, setShowHidden, setPanelsVisible, setShowExtensions, setViewerFile, setEditorFile, setCommandPaletteOpen, updateSettings]);
}
