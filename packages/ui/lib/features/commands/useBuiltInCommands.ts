import {
  commandPaletteOpenAtom,
  loadedExtensionsAtom,
  panelsVisibleAtom,
  terminalFocusRequestKeyAtom,
} from "@/atoms";
import { useDialog } from "@/dialogs/dialogContext";
import type { LanguageOption } from "@/dialogs/OpenCreateFileDialog";
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
import { useBridge } from "@/features/bridge/useBridge";
import { useCommandLine } from "@/features/command-line/useCommandLine";
import { useCommandRegistry } from "@/features/commands/commands";
import { registerAppBuiltInKeybindings, registerFileListKeybindings } from "@/features/commands/registerKeybindings";
import { runCommandSequence, type RunCommandsArgs } from "@/features/commands/runCommands";
import { useActivePanelNavigation } from "@/features/panels/panelControllers";
import { DEFAULT_EDITOR_FILE_SIZE_LIMIT } from "@/features/settings/userSettings";
import { useUserSettings } from "@/features/settings/useUserSettings";
import { useTerminal } from "@/features/terminal/useTerminal";
import { useFocusContext } from "@/focusContext";
import { basename } from "@/utils/path";
import { isTauri as isTauriApp } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
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
  const bridgeRef = useRef(bridge);
  bridgeRef.current = bridge;
  const { navigateTo, cancelNavigation, getPanel, activePanelSide } = useActivePanelNavigation();
  const commandRegistry = useCommandRegistry();
  const focusContext = useFocusContext();
  const focusContextRef = useRef(focusContext);
  focusContextRef.current = focusContext;
  const { showDialog } = useDialog();
  const showDialogRef = useRef(showDialog);
  showDialogRef.current = showDialog;

  const { paste: pasteToCommandLine } = useCommandLine();
  const pasteToCommandLineRef = useRef(pasteToCommandLine);
  pasteToCommandLineRef.current = pasteToCommandLine;

  const { runCommand, activeCwd, activeSession } = useTerminal();
  const runCommandRef = useRef(runCommand);
  runCommandRef.current = runCommand;
  const activeCwdRef = useRef(activeCwd);
  activeCwdRef.current = activeCwd;
  const activeSessionRef = useRef(activeSession);
  activeSessionRef.current = activeSession;

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
  const setActivePanel = useSetAtom(activePanelSideAtom);
  const [leftTabs, setLeftTabs] = useAtom(leftTabsAtom);
  const [rightTabs, setRightTabs] = useAtom(rightTabsAtom);
  const [leftActiveTabId, setLeftActiveTabId] = useAtom(leftActiveTabIdAtom);
  const [rightActiveTabId, setRightActiveTabId] = useAtom(rightActiveTabIdAtom);
  const leftActiveTab = useAtomValue(leftActiveTabAtom);
  const rightActiveTab = useAtomValue(rightActiveTabAtom);
  const setPanelsVisible = useSetAtom(panelsVisibleAtom);
  const setTerminalFocusRequestKey = useSetAtom(terminalFocusRequestKeyAtom);
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
      commandRegistry.registerCommand("toggleHiddenFiles", () => {
        const next = !settingsRef.current.showHidden;
        updateSettings({ showHidden: next });
      }),
    );

    disposables.push(
      commandRegistry.registerCommand("runCommands", async (args) => {
        const payload = (args ?? null) as RunCommandsArgs | null;
        if (!payload || !Array.isArray(payload.commands)) return;
        await runCommandSequence(commandRegistry, payload.commands);
      }),
    );

    disposables.push(
      commandRegistry.registerCommand("togglePanels", () =>
        setPanelsVisible((v) => {
          if (activeSessionRef.current?.session.getCapabilities().commandRunning) {
            return v;
          }
          const next = !v;
          if (next) {
            focusContextRef.current.request("panel");
          } else {
            setTerminalFocusRequestKey((k) => k + 1);
          }
          return next;
        }),
      ),
    );

    disposables.push(
      commandRegistry.registerCommand("showExtensions", () =>
        showDialogRef.current({
          type: "extensions",
        }),
      ),
    );
    disposables.push(commandRegistry.registerCommand("showCommandPalette", () => setCommandPaletteOpen((o) => !o)));
    disposables.push(commandRegistry.registerCommand("closeViewer", () => depsRef.current.onRequestCloseViewer()));
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
      commandRegistry.registerCommand("dotdir.panelEscape", async () => {
        const panel = getPanelRef.current(activePanelSideRef.current);
        if (panel?.navigating) {
          cancelNavigationRef.current?.();
          return;
        }

        if (commandRegistry.getContext("commandLineHasText")) {
          await commandRegistry.executeCommand("commandLine.clear");
          return;
        }

        if (activeTabRef.current?.type === "preview") {
          await commandRegistry.executeCommand("closeTab");
          return;
        }

        if (await closePreviewOnSide(activePanelSideRef.current === "left" ? "right" : "left")) {
          return;
        }

        if (viewerOpenRef.current) {
          await commandRegistry.executeCommand("closeViewer");
        }
      }),
    );

    // ── File ──────────────────────────────────────────────────────────────────

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
        showDialogRef.current({
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
        await runCommandRef.current(arg, activeCwdRef.current);
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

    disposables.push(
      commandRegistry.registerCommand("pasteLeftPanelPath", () => {
        const path = leftActiveTabRef.current?.type === "filelist" ? leftActiveTabRef.current.path : "";
        if (!path) return;
        const arg = /^[a-zA-Z0-9._+/:-]+$/.test(path) ? path : JSON.stringify(path);
        pasteToCommandLineRef.current(arg);
      }),
    );
    disposables.push(
      commandRegistry.registerCommand("pasteRightPanelPath", () => {
        const path = rightActiveTabRef.current?.type === "filelist" ? rightActiveTabRef.current.path : "";
        if (!path) return;
        const arg = /^[a-zA-Z0-9._+/:-]+$/.test(path) ? path : JSON.stringify(path);
        pasteToCommandLineRef.current(arg);
      }),
    );

    // ── Keybindings ───────────────────────────────────────────────────────────

    disposables.push(...registerAppBuiltInKeybindings(commandRegistry));
    disposables.push(...registerFileListKeybindings(commandRegistry));

    return () => {
      for (const d of disposables) d();
    };
  }, [
    commandRegistry,
    setActivePanel,
    setLeftTabs,
    setRightTabs,
    setLeftActiveTabId,
    setRightActiveTabId,
    setPanelsVisible,
    setCommandPaletteOpen,
    updateSettings,
    setTerminalFocusRequestKey,
  ]);
}
