import {
  commandLineCwdAtom,
  panelsVisibleAtom,
  resolvedProfilesAtom,
  terminalFocusRequestKeyAtom,
  terminalProfilesLoadedAtom,
} from "@/atoms";
import { activeTabAtom } from "@/entities/tab/model/tabsAtoms";
import { useBridge } from "@/features/bridge/useBridge";
import { useCommandRegistry } from "@/features/commands/commands";
import { normalizeTerminalPath } from "@/features/terminal/path";
import { useTerminalState, type TerminalState } from "@/features/terminal/useTerminalState";
import { useFocusContext } from "@/focusContext";
import { useActivePanelNavigation } from "@/panelControllers";
import { normalizePath } from "@/utils/path";
import { useAtomValue, useSetAtom } from "jotai";
import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react";

export interface TerminalController {
  activeCwd: string;
  writeToTerminal: (data: string) => Promise<void>;
  runCommand: (cmd: string, cwd: string) => Promise<void>;
}

type TerminalContextValue = TerminalController & TerminalState;

const TerminalContext = createContext<TerminalContextValue | null>(null);

function useProvideTerminal(): TerminalContextValue {
  const bridge = useBridge();
  const commandRegistry = useCommandRegistry();
  const focusContext = useFocusContext();
  const { navigateTo } = useActivePanelNavigation();
  const profiles = useAtomValue(resolvedProfilesAtom);
  const profilesLoaded = useAtomValue(terminalProfilesLoadedAtom);

  const panelsVisible = useAtomValue(panelsVisibleAtom);
  const setPanelsVisible = useSetAtom(panelsVisibleAtom);
  const setTerminalFocusRequestKey = useSetAtom(terminalFocusRequestKeyAtom);
  const setCommandLineCwd = useSetAtom(commandLineCwdAtom);

  const terminalState = useTerminalState();
  const {
    activeSession,
    activeSessionId,
    setProfiles,
    setCurrentCwd,
    restartAll,
    dispose,
    writeToActiveSession,
    executeCommandInCwd,
  } = terminalState;

  const activeTab = useAtomValue(activeTabAtom);
  const activePanelCwd = activeTab?.path ?? "";
  const activePanelCwdRef = useRef(activePanelCwd);
  activePanelCwdRef.current = activePanelCwd;
  const restorePanelsAfterCommandSessionIdRef = useRef<string | null>(null);

  const onNavigatePanelRef = useRef(navigateTo);
  onNavigatePanelRef.current = navigateTo;

  useEffect(() => {
    if (!activeSession) {
      restorePanelsAfterCommandSessionIdRef.current = null;
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
        if (restorePanelsAfterCommandSessionIdRef.current === activeSession.id) {
          restorePanelsAfterCommandSessionIdRef.current = null;
          setPanelsVisible(true);
        }
      } else if (event.type === "capabilities") {
        commandRegistry.setContext("terminalCommandRunning", event.capabilities.commandRunning);
      }
    });
  }, [activeSession, activeSessionId, commandRegistry, setPanelsVisible]);

  useEffect(() => {
    if (profilesLoaded && profiles.length > 0) {
      setProfiles(profiles, activePanelCwdRef.current);
    }
  }, [profilesLoaded, profiles, setProfiles]);

  useEffect(() => {
    return () => {
      dispose();
    };
  }, [dispose]);

  useEffect(() => {
    setCurrentCwd(activePanelCwd);
  }, [activePanelCwd, setCurrentCwd]);

  useEffect(() => {
    if (!bridge.onReconnect) return;
    return bridge.onReconnect(() => restartAll());
  }, [bridge, restartAll]);

  useEffect(() => {
    if (activeSession?.cwd && activeSession.cwdUserInitiated) {
      const normalized = normalizePath(activeSession.cwd);
      const normalizedTermPath = normalizeTerminalPath(normalized);
      if (normalizedTermPath === normalizeTerminalPath(activePanelCwdRef.current)) return;
      void onNavigatePanelRef.current(normalizedTermPath);
    }
  }, [activeSession]);

  const activeCwd = activePanelCwd;
  useEffect(() => {
    setCommandLineCwd(activeCwd);
  }, [activeCwd, setCommandLineCwd]);

  useEffect(() => {
    if (!panelsVisible) return;
    const frame = requestAnimationFrame(() => {
      focusContext.request("panel");
    });
    return () => cancelAnimationFrame(frame);
  }, [focusContext, panelsVisible]);

  const writeToTerminal = useCallback(
    (data: string): Promise<void> => writeToActiveSession(data),
    [writeToActiveSession],
  );

  const runCommand = useCallback(
    async (cmd: string, cwd: string): Promise<void> => {
      if (!activeSession) return;
      restorePanelsAfterCommandSessionIdRef.current = activeSession.id;
      setPanelsVisible(false);
      focusContext.request("terminal");
      setTerminalFocusRequestKey((k) => k + 1);
      try {
        await executeCommandInCwd(cmd, cwd);
      } catch (error) {
        if (restorePanelsAfterCommandSessionIdRef.current === activeSession.id) {
          restorePanelsAfterCommandSessionIdRef.current = null;
          setPanelsVisible(true);
        }
        throw error;
      }
    },
    [activeSession, executeCommandInCwd, focusContext, setPanelsVisible, setTerminalFocusRequestKey],
  );

  return useMemo(
    () => ({
      ...terminalState,
      activeCwd,
      writeToTerminal,
      runCommand,
    }),
    [activeCwd, runCommand, terminalState, writeToTerminal],
  );
}

export function TerminalProvider({ children }: { children: ReactNode }) {
  const value = useProvideTerminal();
  return createElement(TerminalContext.Provider, { value }, children);
}

export function useTerminal(): TerminalContextValue {
  const value = useContext(TerminalContext);
  if (!value) throw new Error("useTerminal must be used within TerminalProvider");
  return value;
}
