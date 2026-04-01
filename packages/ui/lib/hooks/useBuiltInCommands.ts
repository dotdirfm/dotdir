import {
  commandPaletteOpenAtom,
  editorFileAtom,
  loadedExtensionsAtom,
  panelsVisibleAtom,
  showExtensionsAtom,
  terminalFocusRequestKeyAtom,
  viewerFileAtom,
} from "@/atoms";
import { useDialog } from "@/dialogs/dialogContext";
import type { LanguageOption } from "@/dialogs/OpenCreateFileDialog";
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
import { useCommandRegistry } from "@/features/commands/commands";
import { DEFAULT_EDITOR_FILE_SIZE_LIMIT } from "@/features/settings/userSettings";
import { useUserSettings } from "@/features/settings/useUserSettings";
import { useGetFileListHandlers } from "@/fileListHandlers";
import { useFocusContext } from "@/focusContext";
import { getActivePanelGroupHandlers } from "@/panelGroupHandlers";
import { registerAppBuiltInKeybindings, registerFileListKeybindings } from "@/registerKeybindings";
import { isContainerPath, parseContainerPath } from "@/utils/containerPath";
import { basename, dirname } from "@/utils/path";
import { isTauri as isTauriApp } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { FsNode } from "fss-lang";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { useEffect, useRef } from "react";

export interface BuiltInCommandDeps {
  navigateTo: (path: string) => void;
  cancelNavigation: () => void;
  onOpenCreateFileConfirm: (path: string, name: string, langId: string) => Promise<void>;
  onViewFile: (filePath: string, fileName: string, fileSize: number) => void;
  onEditFile: (filePath: string, fileName: string, fileSize: number, langId: string) => void;
  onRequestCloseEditor: () => void;
  onExecuteInTerminal: (cmd: string) => Promise<void>;
}

export function useBuiltInCommands(deps: BuiltInCommandDeps): void {
  const bridge = useBridge();
  const commandRegistry = useCommandRegistry();
  const focusContext = useFocusContext();
  const getFileListHandlers = useGetFileListHandlers();
  const { showDialog } = useDialog();

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
  const leftActiveTab = useAtomValue(leftActiveTabAtom);
  const rightActiveTab = useAtomValue(rightActiveTabAtom);
  const [leftTabs, setLeftTabs] = useAtom(leftTabsAtom);
  const [rightTabs, setRightTabs] = useAtom(rightTabsAtom);
  const [leftActiveTabId, setLeftActiveTabId] = useAtom(leftActiveTabIdAtom);
  const [rightActiveTabId, setRightActiveTabId] = useAtom(rightActiveTabIdAtom);
  const setPanelsVisible = useSetAtom(panelsVisibleAtom);
  const setTerminalFocusRequestKey = useSetAtom(terminalFocusRequestKeyAtom);
  const setShowExtensions = useSetAtom(showExtensionsAtom);
  const setViewerFile = useSetAtom(viewerFileAtom);
  const setEditorFile = useSetAtom(editorFileAtom);
  const setCommandPaletteOpen = useSetAtom(commandPaletteOpenAtom);

  const activePanelSideRef = useRef(activePanel);
  activePanelSideRef.current = activePanel;
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

  const navigateToRef = useRef(deps.navigateTo);
  navigateToRef.current = deps.navigateTo;
  const cancelNavigationRef = useRef(deps.cancelNavigation);
  cancelNavigationRef.current = deps.cancelNavigation;

  // const panelRef = useRef(activePanelSideRef.current === "left" ? leftRef.current : rightRef.current);
  // panelRef.current = activePanelSideRef.current === "left" ? leftRef.current : rightRef.current;

  const activeTab = useAtomValue(activeTabAtom);
  const activeTabRef = useRef(activeTab);
  activeTabRef.current = activeTab;

  const getFileListStateForSide = (side: "left" | "right") => {
    const tab = side === "left" ? leftActiveTabRef.current : rightActiveTabRef.current;
    return tab?.type === "filelist" ? tab : null;
  };

  const getSelectedEntryForSide = (side: "left" | "right"): FsNode | undefined => {
    const fileListTab = getFileListStateForSide(side);
    if (!fileListTab) return undefined;
    const selectedName = fileListTab.selectedEntryNames?.[0] ?? fileListTab.activeEntryName;
    return selectedName ? fileListTab.entries.find((entry) => entry.name === selectedName) : undefined;
  };

  useEffect(() => {
    const disposables: Array<() => void> = [];
    const getActiveFileListHandlers = () => getFileListHandlers(activePanelSideRef.current);

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
        cancelNavigationRef.current?.();
      }),
    );

    disposables.push(
      commandRegistry.registerCommand("filelist.goToParent", () => {
        if (activeTabRef.current?.type !== "filelist") return;
        const currentPath = activeTabRef.current.path;
        if (isContainerPath(currentPath)) {
          const { containerFile, innerPath } = parseContainerPath(currentPath);
          if (innerPath === "/" || innerPath === "") {
            void navigateToRef.current(dirname(containerFile));
            return;
          }
        }
        const parent = dirname(currentPath);
        if (parent !== currentPath) void navigateToRef.current(parent);
      }),
    );

    disposables.push(
      commandRegistry.registerCommand("filelist.goHome", async () => {
        const home = await bridge.utils.getHomePath();
        void navigateToRef.current(home);
      }),
    );

    // ── File ──────────────────────────────────────────────────────────────────

    disposables.push(
      commandRegistry.registerCommand("filelist.refresh", () => {
        if (activeTabRef.current?.type !== "filelist") return;
        const currentPath = activeTabRef.current.path;
        void navigateToRef.current(currentPath);
      }),
    );

    disposables.push(commandRegistry.registerCommand("newTab", () => void getActivePanelGroupHandlers()?.newTab()));
    disposables.push(commandRegistry.registerCommand("closeTab", () => void getActivePanelGroupHandlers()?.closeActiveTab()));
    disposables.push(
      commandRegistry.registerCommand("openCurrentDirInOppositePanelCurrentTab", () => {
        const side = activePanelSideRef.current;
        const opposite = OPPOSITE_PANEL[side];
        const fileListTab = getFileListStateForSide(side);
        if (!fileListTab) return;
        const path = fileListTab.path;
        const activeOppositeTabId = (opposite === "left" ? leftActiveTabIdRef : rightActiveTabIdRef).current;
        const setTabs = opposite === "left" ? setLeftTabs : setRightTabs;
        setTabs((prev) => prev.map((tab) => (tab.id === activeOppositeTabId && tab.type === "filelist" ? { ...tab, path } : tab)));
        setActivePanel(opposite);
      }),
    );
    disposables.push(
      commandRegistry.registerCommand("openCurrentDirInOppositePanelNewTab", () => {
        const side = activePanelSideRef.current;
        const opposite = OPPOSITE_PANEL[side];
        const fileListTab = getFileListStateForSide(side);
        if (!fileListTab) return;
        const newTab = createFilelistTab(fileListTab.path);
        const setTabs = opposite === "left" ? setLeftTabs : setRightTabs;
        const setActiveId = opposite === "left" ? setLeftActiveTabId : setRightActiveTabId;
        setTabs((prev) => [...prev, newTab]);
        setActiveId(newTab.id);
        setActivePanel(opposite);
      }),
    );
    disposables.push(
      commandRegistry.registerCommand("openSelectedDirInOppositePanelCurrentTab", () => {
        const side = activePanelSideRef.current;
        const entry = getSelectedEntryForSide(side);
        if (!entry || entry.type !== "folder") return;
        const opposite = OPPOSITE_PANEL[side];
        const activeOppositeTabId = (opposite === "left" ? leftActiveTabIdRef : rightActiveTabIdRef).current;
        const setTabs = opposite === "left" ? setLeftTabs : setRightTabs;
        setTabs((prev) => prev.map((tab) => (tab.id === activeOppositeTabId && tab.type === "filelist" ? { ...tab, path: entry.path as string } : tab)));
        setActivePanel(opposite);
      }),
    );
    disposables.push(
      commandRegistry.registerCommand("openSelectedDirInOppositePanelNewTab", () => {
        const side = activePanelSideRef.current;
        const entry = getSelectedEntryForSide(side);
        if (!entry || entry.type !== "folder") return;
        const opposite = OPPOSITE_PANEL[side];
        const newTab = createFilelistTab(entry.path as string);
        const setTabs = opposite === "left" ? setLeftTabs : setRightTabs;
        const setActiveId = opposite === "left" ? setLeftActiveTabId : setRightActiveTabId;
        setTabs((prev) => [...prev, newTab]);
        setActiveId(newTab.id);
        setActivePanel(opposite);
      }),
    );
    disposables.push(
      commandRegistry.registerCommand("previewInOppositePanel", () => {
        const side = activePanelSideRef.current;
        const entry = getSelectedEntryForSide(side);
        if (!entry || entry.type !== "file") return;
        const opposite = OPPOSITE_PANEL[side];
        const tabs = (opposite === "left" ? leftTabsRef : rightTabsRef).current;
        const setTabs = opposite === "left" ? setLeftTabs : setRightTabs;
        const setActiveId = opposite === "left" ? setLeftActiveTabId : setRightActiveTabId;
        const tempTab = tabs.find((tab) => tab.type === "preview" && tab.isTemp);
        const path = entry.path as string;
        const name = entry.name;
        const size = Number(entry.meta.size);
        if (tempTab && tempTab.type === "preview") {
          setTabs((prev) => prev.map((tab) => (tab.id === tempTab.id ? { ...tab, path, name, size, sourcePanel: side, mode: "viewer", dirty: false } : tab)));
          setActiveId(tempTab.id);
        } else {
          const newTab = createPreviewTab(path, name, size, side, { mode: "viewer" });
          setTabs((prev) => [...prev, newTab]);
          setActiveId(newTab.id);
        }
        setActivePanel(opposite);
      }),
    );
    disposables.push(
      commandRegistry.registerCommand("editInOppositePanel", () => {
        const side = activePanelSideRef.current;
        const entry = getSelectedEntryForSide(side);
        if (!entry || entry.type !== "file") return;
        const opposite = OPPOSITE_PANEL[side];
        const tabs = (opposite === "left" ? leftTabsRef : rightTabsRef).current;
        const setTabs = opposite === "left" ? setLeftTabs : setRightTabs;
        const setActiveId = opposite === "left" ? setLeftActiveTabId : setRightActiveTabId;
        const tempTab = tabs.find((tab) => tab.type === "preview" && tab.isTemp);
        const path = entry.path as string;
        const name = entry.name;
        const size = Number(entry.meta.size);
        const langId = typeof entry.lang === "string" && entry.lang ? entry.lang : "plaintext";
        if (tempTab && tempTab.type === "preview") {
          setTabs((prev) =>
            prev.map((tab) => (tab.id === tempTab.id ? { ...tab, path, name, size, sourcePanel: side, mode: "editor", langId, dirty: false } : tab)),
          );
          setActiveId(tempTab.id);
        } else {
          const newTab = createPreviewTab(path, name, size, side, { mode: "editor", langId });
          setTabs((prev) => [...prev, newTab]);
          setActiveId(newTab.id);
        }
        setActivePanel(opposite);
      }),
    );

    disposables.push(
      commandRegistry.registerCommand("openCreateFile", () => {
        if (activeTabRef.current?.type !== "filelist") return;
        const currentPath = activeTabRef.current.path;
        const { onOpenCreateFileConfirm } = depsRef.current;
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
      commandRegistry.registerCommand("list.makeDir", () => {
        if (activeTabRef.current?.type !== "filelist") return;
        const currentPath = activeTabRef.current.path;
        showDialog({
          type: "makeFolder",
          currentPath,
          onConfirm: async (result) => {
            const join = (name: string) => (currentPath ? `${currentPath.replace(/\/?$/, "")}/${name}` : name);
            if (result.mode === "single") {
              const fullPath = join(result.name);
              if (bridge.fs.createDir) await bridge.fs.createDir(fullPath);
              void navigateToRef.current(fullPath);
              return;
            }
            for (const name of result.names) {
              const fullPath = join(name);
              if (bridge.fs.createDir) await bridge.fs.createDir(fullPath);
            }
            void navigateToRef.current(currentPath);
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

    disposables.push(commandRegistry.registerCommand("filelist.cursorUp", () => getActiveFileListHandlers()?.cursorUp()));
    disposables.push(commandRegistry.registerCommand("filelist.cursorDown", () => getActiveFileListHandlers()?.cursorDown()));
    disposables.push(commandRegistry.registerCommand("filelist.cursorLeft", () => getActiveFileListHandlers()?.cursorLeft()));
    disposables.push(commandRegistry.registerCommand("filelist.cursorRight", () => getActiveFileListHandlers()?.cursorRight()));
    disposables.push(commandRegistry.registerCommand("filelist.cursorHome", () => getActiveFileListHandlers()?.cursorHome()));
    disposables.push(commandRegistry.registerCommand("filelist.cursorEnd", () => getActiveFileListHandlers()?.cursorEnd()));
    disposables.push(commandRegistry.registerCommand("filelist.cursorPageUp", () => getActiveFileListHandlers()?.cursorPageUp()));
    disposables.push(commandRegistry.registerCommand("filelist.cursorPageDown", () => getActiveFileListHandlers()?.cursorPageDown()));
    disposables.push(commandRegistry.registerCommand("filelist.selectUp", () => getActiveFileListHandlers()?.selectUp()));
    disposables.push(commandRegistry.registerCommand("filelist.selectDown", () => getActiveFileListHandlers()?.selectDown()));
    disposables.push(commandRegistry.registerCommand("filelist.selectLeft", () => getActiveFileListHandlers()?.selectLeft()));
    disposables.push(commandRegistry.registerCommand("filelist.selectRight", () => getActiveFileListHandlers()?.selectRight()));
    disposables.push(commandRegistry.registerCommand("filelist.selectHome", () => getActiveFileListHandlers()?.selectHome()));
    disposables.push(commandRegistry.registerCommand("filelist.selectEnd", () => getActiveFileListHandlers()?.selectEnd()));
    disposables.push(commandRegistry.registerCommand("filelist.selectPageUp", () => getActiveFileListHandlers()?.selectPageUp()));
    disposables.push(commandRegistry.registerCommand("filelist.selectPageDown", () => getActiveFileListHandlers()?.selectPageDown()));
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
  }, [
    commandRegistry,
    bridge,
    cancelNavigationRef,
    focusContext,
    setActivePanel,
    setPanelsVisible,
    setShowExtensions,
    setViewerFile,
    setEditorFile,
    setCommandPaletteOpen,
    updateSettings,
    setTerminalFocusRequestKey,
    setLeftTabs,
    setRightTabs,
    setLeftActiveTabId,
    setRightActiveTabId,
    getFileListHandlers,
    showDialog,
  ]);
}
