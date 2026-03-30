import {
  commandPaletteOpenAtom,
  editorFileAtom,
  loadedExtensionsAtom,
  panelsVisibleAtom,
  showExtensionsAtom,
  terminalFocusRequestKeyAtom,
  viewerFileAtom,
} from "@/atoms";
import type { DialogSpec } from "@/dialogs/dialogContext";
import type { LanguageOption } from "@/dialogs/OpenCreateFileDialog";
import { activePanelSideAtom, activeTabAtom } from "@/entities/tab/model/tabsAtoms";
import { useBridge } from "@/features/bridge/useBridge";
import { commandRegistry } from "@/features/commands/commands";
import { DEFAULT_EDITOR_FILE_SIZE_LIMIT } from "@/features/settings/userSettings";
import { useUserSettings } from "@/features/settings/useUserSettings";
import { getActiveFileListHandlers } from "@/fileListHandlers";
import { focusContext } from "@/focusContext";
import { getActivePanelGroupHandlers } from "@/panelGroupHandlers";
import { registerAppBuiltInKeybindings, registerFileListKeybindings } from "@/registerKeybindings";
import { isContainerPath, parseContainerPath } from "@/utils/containerPath";
import { basename, dirname } from "@/utils/path";
import { isTauri as isTauriApp } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { RefObject, useEffect, useRef } from "react";

interface PanelHandle {
  currentPath: string;
  navigateTo: (path: string, force?: boolean, cursorName?: string) => Promise<void>;
  cancelNavigation: () => void;
}

export interface BuiltInCommandDeps {
  leftRef: RefObject<PanelHandle | undefined>;
  rightRef: RefObject<PanelHandle | undefined>;
  onPreviewInOppositePanel: () => void;
  onEditInOppositePanel: () => void;
  openCurrentDirInOppositePanelCurrentTab: () => void;
  openCurrentDirInOppositePanelNewTab: () => void;
  openSelectedDirInOppositePanelCurrentTab: () => void;
  openSelectedDirInOppositePanelNewTab: () => void;
  onOpenCreateFileConfirm: (path: string, name: string, langId: string) => Promise<void>;
  showDialog: (spec: DialogSpec) => void;
  onViewFile: (filePath: string, fileName: string, fileSize: number) => void;
  onEditFile: (filePath: string, fileName: string, fileSize: number, langId: string) => void;
  onRequestCloseEditor: () => void;
  onExecuteInTerminal: (cmd: string) => Promise<void>;
}

export function useBuiltInCommands(deps: BuiltInCommandDeps): void {
  const bridge = useBridge();

  // Updated every render so command handlers always see the latest callbacks.
  const depsRef = useRef(deps);
  depsRef.current = deps;

  // loadedExtensions changes as extensions load; keep a ref for call-time reads.
  const loadedExtensions = useAtomValue(loadedExtensionsAtom);
  const loadedExtensionsRef = useRef(loadedExtensions);
  loadedExtensionsRef.current = loadedExtensions;

  const { settings, updateSettings } = useUserSettings();
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  // Atom setters are stable (Jotai guarantee) — safe to capture in the effect.
  const [activePanel, setActivePanel] = useAtom(activePanelSideAtom);
  const setPanelsVisible = useSetAtom(panelsVisibleAtom);
  const setTerminalFocusRequestKey = useSetAtom(terminalFocusRequestKeyAtom);
  const setShowExtensions = useSetAtom(showExtensionsAtom);
  const setViewerFile = useSetAtom(viewerFileAtom);
  const setEditorFile = useSetAtom(editorFileAtom);
  const setCommandPaletteOpen = useSetAtom(commandPaletteOpenAtom);

  const activePanelSideRef = useRef(activePanel);
  activePanelSideRef.current = activePanel;

  const { leftRef, rightRef } = depsRef.current;
  const panelRef = useRef(activePanelSideRef.current === "left" ? leftRef.current : rightRef.current);
  panelRef.current = activePanelSideRef.current === "left" ? leftRef.current : rightRef.current;

  const activeTab = useAtomValue(activeTabAtom);
  const activeTabRef = useRef(activeTab);
  activeTabRef.current = activeTab;

  useEffect(() => {
    const disposables: Array<() => void> = [];

    // ── View ──────────────────────────────────────────────────────────────────

    disposables.push(
      commandRegistry.registerCommand("toggleHiddenFiles", () => {
        const next = !settingsRef.current.showHidden;
        updateSettings({ showHidden: next });
      }),
    );

    disposables.push(
      commandRegistry.registerCommand("togglePanels", () =>
        setPanelsVisible((v) => {
          const next = !v;
          if (next) {
            focusContext.request("panel");
          } else {
            setTerminalFocusRequestKey((k) => k + 1);
          }
          return next;
        }),
      ),
    );

    disposables.push(commandRegistry.registerCommand("showExtensions", () => setShowExtensions(true)));
    disposables.push(commandRegistry.registerCommand("showCommandPalette", () => setCommandPaletteOpen((o) => !o)));
    disposables.push(commandRegistry.registerCommand("closeViewer", () => setViewerFile(null)));
    disposables.push(commandRegistry.registerCommand("closeEditor", () => depsRef.current.onRequestCloseEditor()));

    // ── Navigation ────────────────────────────────────────────────────────────

    disposables.push(commandRegistry.registerCommand("switchPanel", () => setActivePanel((s) => (s === "left" ? "right" : "left"))));
    disposables.push(commandRegistry.registerCommand("dotdir.focusLeftPanel", () => setActivePanel("left")));
    disposables.push(commandRegistry.registerCommand("dotdir.focusRightPanel", () => setActivePanel("right")));

    disposables.push(
      commandRegistry.registerCommand("dotdir.cancelNavigation", () => {
        depsRef.current.leftRef.current?.cancelNavigation();
        depsRef.current.rightRef.current?.cancelNavigation();
      }),
    );

    disposables.push(
      commandRegistry.registerCommand("panel.goToParent", () => {
        if (!panelRef.current) return;
        if (activeTabRef.current?.type !== "filelist") return;
        const currentPath = activeTabRef.current.path;
        if (isContainerPath(currentPath)) {
          const { containerFile, innerPath } = parseContainerPath(currentPath);
          if (innerPath === "/" || innerPath === "") {
            void panelRef.current.navigateTo(dirname(containerFile), false, basename(containerFile));
            return;
          }
        }
        const parent = dirname(currentPath);
        if (parent !== currentPath) void panelRef.current.navigateTo(parent);
      }),
    );

    disposables.push(
      commandRegistry.registerCommand("panel.goHome", async () => {
        if (!panelRef.current) return;
        const home = await bridge.utils.getHomePath();
        void panelRef.current.navigateTo(home);
      }),
    );

    // ── File ──────────────────────────────────────────────────────────────────

    disposables.push(
      commandRegistry.registerCommand("panel.refresh", () => {
        void panelRef.current?.navigateTo(panelRef.current.currentPath);
      }),
    );

    disposables.push(commandRegistry.registerCommand("newTab", () => void getActivePanelGroupHandlers()?.newTab()));
    disposables.push(commandRegistry.registerCommand("closeTab", () => void getActivePanelGroupHandlers()?.closeActiveTab()));
    disposables.push(commandRegistry.registerCommand("previewInOppositePanel", () => depsRef.current.onPreviewInOppositePanel()));
    disposables.push(commandRegistry.registerCommand("editInOppositePanel", () => depsRef.current.onEditInOppositePanel()));
    disposables.push(
      commandRegistry.registerCommand("openCurrentDirInOppositePanelCurrentTab", () => depsRef.current.openCurrentDirInOppositePanelCurrentTab()),
    );
    disposables.push(commandRegistry.registerCommand("openCurrentDirInOppositePanelNewTab", () => depsRef.current.openCurrentDirInOppositePanelNewTab()));
    disposables.push(
      commandRegistry.registerCommand("openSelectedDirInOppositePanelCurrentTab", () => depsRef.current.openSelectedDirInOppositePanelCurrentTab()),
    );
    disposables.push(commandRegistry.registerCommand("openSelectedDirInOppositePanelNewTab", () => depsRef.current.openSelectedDirInOppositePanelNewTab()));

    disposables.push(
      commandRegistry.registerCommand("openCreateFile", () => {
        if (activeTabRef.current?.type !== "filelist") return;
        const currentPath = activeTabRef.current.path;
        const { showDialog, onOpenCreateFileConfirm } = depsRef.current;
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
      commandRegistry.registerCommand("panel.makeDir", () => {
        if (!panelRef.current || activeTabRef.current?.type !== "filelist") return;
        const currentPath = activeTabRef.current.path;
        const { showDialog } = depsRef.current;
        showDialog({
          type: "makeFolder",
          currentPath,
          onConfirm: async (result) => {
            const join = (name: string) => (currentPath ? `${currentPath.replace(/\/?$/, "")}/${name}` : name);
            if (result.mode === "single") {
              const fullPath = join(result.name);
              if (bridge.fs.createDir) await bridge.fs.createDir(fullPath);
              void panelRef.current?.navigateTo(fullPath);
              return;
            }
            for (const name of result.names) {
              const fullPath = join(name);
              if (bridge.fs.createDir) await bridge.fs.createDir(fullPath);
            }
            void panelRef.current?.navigateTo(currentPath);
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
      commandRegistry.registerCommand("viewFile", (path: unknown, name: unknown, size: unknown) => {
        depsRef.current.onViewFile(path as string, name as string, size as number);
      }),
    );

    disposables.push(
      commandRegistry.registerCommand("editFile", (path: unknown, name: unknown, size: unknown, langId: unknown) => {
        const limit = settingsRef.current.editorFileSizeLimit ?? DEFAULT_EDITOR_FILE_SIZE_LIMIT;
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
  }, [setActivePanel, setPanelsVisible, setShowExtensions, setViewerFile, setEditorFile, setCommandPaletteOpen, updateSettings]);
}
