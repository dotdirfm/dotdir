import { useAppRuntimeContext } from "@/appRuntimeContext";
import { useDialog } from "@/dialogs/dialogContext";
import { activeTabAtom } from "@/entities/tab/model/tabsAtoms";
import { useBridge } from "@/features/bridge/useBridge";
import { parseCdCommand, resolveCdPath } from "@/features/command-line/commandLineCd";
import { isExistingDirectory } from "@/features/file-system/utils";
import { useActivePanelNavigation } from "@/features/panels/panelControllers";
import { useUserSettings } from "@/features/settings/useUserSettings";
import { normalizeTerminalPath } from "@/features/terminal/path";
import type { TerminalContextValue } from "@/features/terminal/useTerminal";
import { normalizePath, resolveDotSegments } from "@/utils/path";
import { useAtomValue } from "jotai";
import {
  useCallback,
  useMemo,
  useRef,
  type ReactNode,
} from "react";

export type CommandLineContextValue = {
  execute: (cmd: string) => Promise<void>;
  paste: (text: string) => void;
  setPasteHandler: (handler: ((text: string) => void) | null) => void;
};

export function useProvideCommandLine(terminal: Pick<TerminalContextValue, "activeCwd" | "runCommand">): CommandLineContextValue {
  const bridge = useBridge();
  const { settings, updateSettings } = useUserSettings();
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const activeTab = useAtomValue(activeTabAtom);
  const activeTabRef = useRef(activeTab);
  activeTabRef.current = activeTab;
  const { activeCwd, runCommand } = terminal;
  const activeCwdRef = useRef(activeCwd);
  activeCwdRef.current = activeCwd;
  const runCommandRef = useRef(runCommand);
  runCommandRef.current = runCommand;
  const { activePanelSide, getPanel } = useActivePanelNavigation();
  const { showDialog } = useDialog();
  const pasteHandlerRef = useRef<((text: string) => void) | null>(null);

  const setPasteHandler = useCallback((handler: ((text: string) => void) | null) => {
    pasteHandlerRef.current = handler;
  }, []);

  const paste = useCallback((text: string) => {
    pasteHandlerRef.current?.(text);
  }, []);

  const execute = useCallback(
    async (cmd: string) => {
      const parsed = parseCdCommand(cmd);
      if (!parsed) {
        void runCommandRef.current(cmd, activeCwdRef.current);
        return;
      }
      if (parsed.kind === "error") {
        showDialog({
          type: "message",
          title: "cd",
          message: parsed.message,
          variant: "error",
        });
        return;
      }

      const cwd = activeTabRef.current?.path;
      if (!cwd) return;

      if (parsed.kind === "setAlias") {
        updateSettings({
          pathAliases: {
            ...settingsRef.current.pathAliases,
            [parsed.alias]: normalizeTerminalPath(cwd),
          },
        });
        return;
      }

      if (parsed.kind === "goAlias") {
        const raw = settingsRef.current.pathAliases?.[parsed.alias];
        if (!raw) {
          showDialog({
            type: "message",
            title: "cd",
            message: `Unknown alias: ${parsed.alias}`,
            variant: "error",
          });
          return;
        }

        const path = normalizeTerminalPath(resolveDotSegments(normalizePath(raw)));
        if (!(await isExistingDirectory(bridge, path))) {
          showDialog({
            type: "message",
            title: "cd",
            message: `Folder not found: ${path}`,
            variant: "error",
          });
          return;
        }

        await getPanel(activePanelSide)?.navigateTo(path);
        return;
      }

      if (parsed.kind === "chdir") {
        const target = await resolveCdPath(bridge, parsed.pathArg, cwd);
        if (!(await isExistingDirectory(bridge, target))) {
          showDialog({
            type: "message",
            title: "cd",
            message: `Path not found: ${target}`,
            variant: "error",
          });
          return;
        }

        await getPanel(activePanelSide)?.navigateTo(target);
      }
    },
    [activePanelSide, bridge, getPanel, showDialog, updateSettings],
  );

  return useMemo(
    () => ({
      execute,
      paste,
      setPasteHandler,
    }),
    [execute, paste, setPasteHandler],
  );
}

export function CommandLineProvider({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

export function useCommandLine() {
  const { commandLine } = useAppRuntimeContext();
  return {
    execute: commandLine.execute,
    paste: commandLine.paste,
  };
}

export function useCommandLineRegistration() {
  const { commandLine } = useAppRuntimeContext();
  return {
    setPasteHandler: commandLine.setPasteHandler,
  };
}
