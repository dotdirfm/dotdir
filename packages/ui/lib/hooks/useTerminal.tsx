import {
  commandLineCwdAtom,
  panelsVisibleAtom,
  resolvedProfilesAtom,
  terminalFocusRequestKeyAtom,
  terminalProfilesLoadedAtom
} from "@/atoms";
import { activeTabAtom } from "@/entities/tab/model/tabsAtoms";
import { useBridge } from "@/features/bridge/useBridge";
import { commandRegistry } from "@/features/commands/commands";
import { focusContext } from "@/focusContext";
import { normalizeTerminalPath } from "@/terminal/path";
import { useTerminalState } from "@/terminal/useTerminalState";
import { normalizePath } from "@/utils/path";
import { useAtomValue, useSetAtom } from "jotai";
import { useCallback, useEffect, useRef } from "react";

interface UseTerminalOptions {
  onNavigatePanel: (path: string) => void;
}

export interface UseTerminalResult {
  activeCwd: string;
  writeToTerminal: (data: string) => Promise<void>;
  runCommand: (cmd: string, cwd: string) => Promise<void>;
}

export function useTerminal({ onNavigatePanel }: UseTerminalOptions): UseTerminalResult {
  const bridge = useBridge();
  const profiles = useAtomValue(resolvedProfilesAtom);
  const profilesLoaded = useAtomValue(terminalProfilesLoadedAtom);

  const panelsVisible = useAtomValue(panelsVisibleAtom);
  const setPanelsVisible = useSetAtom(panelsVisibleAtom);
  const setTerminalFocusRequestKey = useSetAtom(terminalFocusRequestKeyAtom);
  const setCommandLineCwd = useSetAtom(commandLineCwdAtom);

  const { activeSession, activeSessionId, setProfiles, setCurrentCwd, restartAll, dispose, writeToActiveSession, executeCommandInCwd } = useTerminalState();

  const activeTab = useAtomValue(activeTabAtom);

  const activePanelCwd = activeTab?.path ?? '';
  const activePanelCwdRef = useRef(activePanelCwd);
  activePanelCwdRef.current = activePanelCwd;

  const onNavigatePanelRef = useRef(onNavigatePanel);
  onNavigatePanelRef.current = onNavigatePanel;
  // Subscribe to active session command-start / command-finish events
  useEffect(() => {
    if (!activeSession) {
      commandRegistry.setContext("terminalCommandRunning", false);
      return;
    }
    const running = activeSession.session.getCapabilities().commandRunning;
    commandRegistry.setContext("terminalCommandRunning", running);

    return activeSession.session.subscribe((event) => {
      if (event.type === "command-start") {
        commandRegistry.setContext("terminalCommandRunning", true);
      } else if (event.type === "command-finish") {
        commandRegistry.setContext("terminalCommandRunning", false);
      } else if (event.type === "capabilities") {
        const r = event.capabilities.commandRunning;
        commandRegistry.setContext("terminalCommandRunning", r);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSessionId]);

  // Initialize sessions from profiles
  useEffect(() => {
    if (profilesLoaded && profiles.length > 0) {
      setProfiles(profiles, activePanelCwdRef.current);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profilesLoaded, profiles]);

  // Dispose all sessions on unmount
  useEffect(() => {
    return () => {
      dispose();
    };
  }, [dispose]);

  // Keep service cwd in sync with active panel
  useEffect(() => {
    setCurrentCwd(activePanelCwd);
  }, [activePanelCwd, setCurrentCwd]);

  // Restart sessions on reconnect
  useEffect(() => {
    if (!bridge.onReconnect) return;
    return bridge.onReconnect(() => restartAll());
  }, [restartAll]);

  // Forward terminal cwd changes to the active panel
  useEffect(() => {
    if (activeSession?.cwd && activeSession.cwdUserInitiated) {
      const normalized = normalizePath(activeSession.cwd);
      const normalizedTermPath = normalizeTerminalPath(normalized);
      if (normalizedTermPath === normalizeTerminalPath(activePanelCwdRef.current)) return;
      onNavigatePanelRef.current(normalizedTermPath);
    }
  }, [activeSession]);

  // Sync commandLineCwd atom
  const activeCwd = activePanelCwd;
  useEffect(() => {
    setCommandLineCwd(activeCwd);
  }, [activeCwd, setCommandLineCwd]);

  // Restore panel focus when panels become visible again
  useEffect(() => {
    if (!panelsVisible) return;
    const frame = requestAnimationFrame(() => {
      focusContext.request("panel");
    });
    return () => cancelAnimationFrame(frame);
  }, [panelsVisible]);

  const writeToTerminal = useCallback(
    (data: string): Promise<void> => {
      return writeToActiveSession(data);
    },
    [writeToActiveSession],
  );

  const runCommand = useCallback(
    async (cmd: string, cwd: string): Promise<void> => {
      setPanelsVisible(false);
      focusContext.request("terminal");
      setTerminalFocusRequestKey((k) => k + 1);
      await executeCommandInCwd(cmd, cwd);
    },
    [setPanelsVisible, setTerminalFocusRequestKey, executeCommandInCwd],
  );

  return { activeCwd, writeToTerminal, runCommand };
}
