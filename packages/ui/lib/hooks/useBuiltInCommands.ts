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
import { activePanelSideAtom, activeTabAtom, leftActiveTabAtom, rightActiveTabAtom } from "@/entities/tab/model/tabsAtoms";
import { useBridge } from "@/features/bridge/useBridge";
import { useCommandRegistry } from "@/features/commands/commands";
import { DEFAULT_EDITOR_FILE_SIZE_LIMIT } from "@/features/settings/userSettings";
import { useUserSettings } from "@/features/settings/useUserSettings";
import { useFocusContext } from "@/focusContext";
import { useActivePanelNavigation } from "@/panelControllers";
import { registerAppBuiltInKeybindings, registerFileListKeybindings } from "@/registerKeybindings";
import { basename } from "@/utils/path";
import { isTauri as isTauriApp } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useAtomValue, useSetAtom } from "jotai";
import { useEffect, useRef } from "react";
import { useCommandLine } from "../features/command-line/useCommandLine";
import { useTerminal } from "../features/terminal/useTerminal";

export interface BuiltInCommandDeps {
  onOpenCreateFileConfirm: (path: string, name: string, langId: string) => Promise<void>;
  onViewFile: (filePath: string, fileName: string, fileSize: number) => void;
  onEditFile: (filePath: string, fileName: string, fileSize: number, langId: string) => void;
  onRequestCloseEditor: () => void;
}

export function useBuiltInCommands(deps: BuiltInCommandDeps): void {
  const bridge = useBridge();
  const bridgeRef = useRef(bridge);
  bridgeRef.current = bridge;
  const { navigateTo, cancelNavigation } = useActivePanelNavigation();
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

  const { writeToTerminal } = useTerminal();
  const writeToTerminalRef = useRef(writeToTerminal);
  writeToTerminalRef.current = writeToTerminal;

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
  const leftActiveTab = useAtomValue(leftActiveTabAtom);
  const rightActiveTab = useAtomValue(rightActiveTabAtom);
  const setPanelsVisible = useSetAtom(panelsVisibleAtom);
  const setTerminalFocusRequestKey = useSetAtom(terminalFocusRequestKeyAtom);
  const setShowExtensions = useSetAtom(showExtensionsAtom);
  const setViewerFile = useSetAtom(viewerFileAtom);
  const setEditorFile = useSetAtom(editorFileAtom);
  const setCommandPaletteOpen = useSetAtom(commandPaletteOpenAtom);

  const leftActiveTabRef = useRef(leftActiveTab);
  leftActiveTabRef.current = leftActiveTab;
  const rightActiveTabRef = useRef(rightActiveTab);
  rightActiveTabRef.current = rightActiveTab;
  const navigateToRef = useRef(navigateTo);
  navigateToRef.current = navigateTo;
  const cancelNavigationRef = useRef(cancelNavigation);
  cancelNavigationRef.current = cancelNavigation;

  // const panelRef = useRef(activePanelSideRef.current === "left" ? leftRef.current : rightRef.current);
  // panelRef.current = activePanelSideRef.current === "left" ? leftRef.current : rightRef.current;

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
            focusContextRef.current.request("panel");
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
        await writeToTerminalRef.current(`${arg}\r`);
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
    setPanelsVisible,
    setShowExtensions,
    setViewerFile,
    setEditorFile,
    setCommandPaletteOpen,
    updateSettings,
    setTerminalFocusRequestKey,
  ]);
}
