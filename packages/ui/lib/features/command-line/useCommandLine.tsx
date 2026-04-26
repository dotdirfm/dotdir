import { useDialog } from "@/dialogs/dialogContext";
import { activeTabAtom } from "@/entities/tab/model/tabsAtoms";
import { useBridge } from "@/features/bridge/useBridge";
import { parseCdCommand, resolveCdPath } from "@/features/command-line/commandLineCd";
import { COMMANDLINE_INSERT_TEXT } from "@/features/commands/commandIds";
import { useCommandRegistry } from "@/features/commands/commands";
import { isExistingDirectory } from "@/features/file-system/utils";
import { useActivePanelNavigation } from "@/features/panels/panelControllers";
import { useUserSettings } from "@/features/settings/useUserSettings";
import { normalizeTerminalPath } from "@/features/terminal/path";
import type { TerminalContextValue } from "@/features/terminal/useTerminal";
import { useTerminal } from "@/features/terminal/useTerminal";
import { normalizePath, resolveDotSegments } from "@/utils/path";
import { useAtomValue } from "jotai";
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  type ReactNode,
} from "react";

export type CommandLineContextValue = {
  execute: (cmd: string) => Promise<void>;
  paste: (text: string) => void;
};

function useProvideCommandLine(terminal: Pick<TerminalContextValue, "activeCwd" | "runCommand">): CommandLineContextValue {
  const bridge = useBridge();
  const commandRegistry = useCommandRegistry();
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

  const paste = useCallback((text: string) => {
    void commandRegistry.executeCommand(COMMANDLINE_INSERT_TEXT, text);
  }, [commandRegistry]);

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
    }),
    [execute, paste],
  );
}

const CommandLineContext = createContext<CommandLineContextValue | null>(null);

export function CommandLineProvider({ children }: { children: ReactNode }) {
  const terminal = useTerminal();
  const value = useProvideCommandLine(terminal);
  return <CommandLineContext.Provider value={value}>{children}</CommandLineContext.Provider>;
}

export function useCommandLine() {
  const commandLine = useContext(CommandLineContext);
  if (!commandLine) throw new Error("CommandLineProvider not mounted");
  return {
    execute: commandLine.execute,
    paste: commandLine.paste,
  };
}
