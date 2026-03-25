import { useAtomValue, useSetAtom } from "jotai";
import { useCallback, useEffect, useRef } from "react";
import {
  commandLineCwdAtom,
  panelsVisibleAtom,
  promptActiveAtom,
  requestedTerminalCwdAtom,
  resolvedProfilesAtom,
  terminalFocusRequestKeyAtom,
  terminalProfilesLoadedAtom,
} from "./atoms";
import { bridge } from "./bridge";
import { commandRegistry } from "./commands";
import { focusContext } from "./focusContext";
import { normalizePath } from "./path";
import { normalizeTerminalPath } from "./terminal/path";
import { useTerminalState } from "./terminal/useTerminalState";

interface UseTerminalOptions {
  activePanelCwd: string;
  onNavigatePanel: (path: string) => void;
}

export interface UseTerminalResult {
  activeCwd: string;
  writeToTerminal: (data: string) => Promise<void>;
  runCommand: (cmd: string, cwd: string) => Promise<void>;
  rememberExpectedTerminalCwd: (path: string) => void;
}

export function useTerminal({ activePanelCwd, onNavigatePanel }: UseTerminalOptions): UseTerminalResult {
  const profiles = useAtomValue(resolvedProfilesAtom);
  const profilesLoaded = useAtomValue(terminalProfilesLoadedAtom);

  const panelsVisible = useAtomValue(panelsVisibleAtom);
  const setPanelsVisible = useSetAtom(panelsVisibleAtom);
  const setPromptActive = useSetAtom(promptActiveAtom);
  const setTerminalFocusRequestKey = useSetAtom(terminalFocusRequestKeyAtom);
  const requestedTerminalCwd = useAtomValue(requestedTerminalCwdAtom);
  const setRequestedTerminalCwd = useSetAtom(requestedTerminalCwdAtom);
  const setCommandLineCwd = useSetAtom(commandLineCwdAtom);

  const { activeSession, activeSessionId, setProfiles, setCurrentCwd, restartAll, dispose, writeToActiveSession, executeCommandInCwd } = useTerminalState();

  const activePanelCwdRef = useRef(activePanelCwd);
  activePanelCwdRef.current = activePanelCwd;
  const onNavigatePanelRef = useRef(onNavigatePanel);
  onNavigatePanelRef.current = onNavigatePanel;

  const hiddenForCommandRef = useRef(false);
  const promptHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Debounced handler: delay hiding panels to avoid flash on fast commands
  const handlePromptActive = useCallback(
    (active: boolean) => {
      if (promptHideTimerRef.current) {
        clearTimeout(promptHideTimerRef.current);
        promptHideTimerRef.current = null;
      }
      if (active) {
        setPromptActive(true);
        if (hiddenForCommandRef.current) {
          hiddenForCommandRef.current = false;
          setPanelsVisible(true);
        }
      } else {
        promptHideTimerRef.current = setTimeout(() => {
          setPromptActive(false);
        }, 60);
      }
    },
    [setPromptActive, setPanelsVisible],
  );

  // Subscribe to active session command-start / command-finish events
  useEffect(() => {
    if (!activeSession) {
      handlePromptActive(true);
      commandRegistry.setContext("terminalCommandRunning", false);
      return;
    }
    const running = activeSession.session.getCapabilities().commandRunning;
    handlePromptActive(!running);
    commandRegistry.setContext("terminalCommandRunning", running);

    return activeSession.session.subscribe((event) => {
      if (event.type === "command-start") {
        handlePromptActive(false);
        commandRegistry.setContext("terminalCommandRunning", true);
      } else if (event.type === "command-finish") {
        handlePromptActive(true);
        commandRegistry.setContext("terminalCommandRunning", false);
      } else if (event.type === "capabilities") {
        const r = event.capabilities.commandRunning;
        handlePromptActive(!r);
        commandRegistry.setContext("terminalCommandRunning", r);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSessionId, handlePromptActive]);

  // Initialize sessions from profiles
  useEffect(() => {
    if (profilesLoaded && profiles.length > 0) {
      setProfiles(profiles, activePanelCwd);
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
      setRequestedTerminalCwd(null);
    }
  }, [activeSession, setRequestedTerminalCwd]);

  // Sync commandLineCwd atom
  const activeCwd = requestedTerminalCwd ?? activePanelCwd;
  useEffect(() => {
    setCommandLineCwd(activeCwd);
  }, [activeCwd, setCommandLineCwd]);

  // Clear requestedTerminalCwd once the panel has navigated there
  useEffect(() => {
    if (!requestedTerminalCwd) return;
    if (normalizeTerminalPath(activePanelCwd) === requestedTerminalCwd) {
      setRequestedTerminalCwd(null);
    }
  }, [activePanelCwd, requestedTerminalCwd, setRequestedTerminalCwd]);

  // Restore panel focus when panels become visible again
  useEffect(() => {
    if (!panelsVisible) return;
    const frame = requestAnimationFrame(() => {
      focusContext.set("panel");
    });
    return () => cancelAnimationFrame(frame);
  }, [panelsVisible]);

  const rememberExpectedTerminalCwd = useCallback(
    (path: string) => {
      setRequestedTerminalCwd(normalizeTerminalPath(path));
    },
    [setRequestedTerminalCwd],
  );

  const writeToTerminal = useCallback(
    (data: string): Promise<void> => {
      return writeToActiveSession(data);
    },
    [writeToActiveSession],
  );

  const runCommand = useCallback(
    async (cmd: string, cwd: string): Promise<void> => {
      hiddenForCommandRef.current = true;
      setPanelsVisible(false);
      focusContext.set("terminal");
      setTerminalFocusRequestKey((k) => k + 1);
      await executeCommandInCwd(cmd, cwd);
    },
    [setPanelsVisible, setTerminalFocusRequestKey, executeCommandInCwd],
  );

  return { activeCwd, writeToTerminal, runCommand, rememberExpectedTerminalCwd };
}
