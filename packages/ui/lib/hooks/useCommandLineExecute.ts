import { useDialog } from "@/dialogs/dialogContext";
import { activeTabAtom } from "@/entities/tab/model/tabsAtoms";
import { useBridge } from "@/features/bridge/useBridge";
import { isExistingDirectory, parseCdCommand, resolveCdPath } from "@/features/navigation/lib/commandLineCd";
import { useUserSettings } from "@/features/settings/useUserSettings";
import { useActivePanelNavigation } from "@/panelControllers";
import { normalizeTerminalPath } from "@/terminal/path";
import { normalizePath, resolveDotSegments } from "@/utils/path";
import { useAtomValue } from "jotai";
import { useCallback, useRef } from "react";

type UseCommandLineExecuteArgs = {
  activeCwd: string;
  runCommand: (cmd: string, cwd: string) => Promise<void> | void;
};

export function useCommandLineExecute({ activeCwd, runCommand }: UseCommandLineExecuteArgs) {
  const bridge = useBridge();
  const { settings, updateSettings } = useUserSettings();
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const activeTab = useAtomValue(activeTabAtom);
  const activeTabRef = useRef(activeTab);
  activeTabRef.current = activeTab;
  const activeCwdRef = useRef(activeCwd);
  activeCwdRef.current = activeCwd;
  const runCommandRef = useRef(runCommand);
  runCommandRef.current = runCommand;
  const { activePanelSide, getPanel } = useActivePanelNavigation();
  const { showDialog } = useDialog();

  return useCallback(
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
}
