import { useAppRuntimeContext } from "@/appRuntimeContext";
import {
  panelsVisibleAtom,
  terminalFocusRequestKeyAtom,
} from "@/atoms";
import { activeTabAtom } from "@/entities/tab/model/tabsAtoms";
import type { TerminalProfile } from "@/features/bridge";
import { useBridge } from "@/features/bridge/useBridge";
import { useCommandRegistry } from "@dotdirfm/commands";
import { useActivePanelNavigation } from "@/features/panels/panelControllers";
import { normalizeTerminalPath } from "@/features/terminal/path";
import { useTerminalState, type TerminalState } from "@/features/terminal/useTerminalState";
import { useFocusContext } from "@/focusContext";
import { normalizePath } from "@/utils/path";
import { useAtomValue, useSetAtom } from "jotai";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

export interface TerminalController {
  activeCwd: string;
  profiles: TerminalProfile[];
  profilesLoaded: boolean;
  setAvailableProfiles: (profiles: TerminalProfile[]) => void;
  setProfilesLoaded: (loaded: boolean) => void;
  writeToTerminal: (data: string) => Promise<void>;
  runCommand: (cmd: string, cwd: string, options?: { restorePanels?: boolean }) => Promise<void>;
}

export type TerminalContextValue = TerminalController & TerminalState;

export function useProvideTerminal(): TerminalContextValue {
  const bridge = useBridge();
  const commandRegistry = useCommandRegistry();
  const focusContext = useFocusContext();
  const { navigateTo } = useActivePanelNavigation();
  const [profiles, setAvailableProfiles] = useState<TerminalProfile[]>([]);
  const [profilesLoaded, setProfilesLoaded] = useState(false);

  const panelsVisible = useAtomValue(panelsVisibleAtom);
  const setPanelsVisible = useSetAtom(panelsVisibleAtom);
  const setTerminalFocusRequestKey = useSetAtom(terminalFocusRequestKeyAtom);

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
  const setProfilesLoadedState = useCallback((loaded: boolean) => {
    setProfilesLoaded(loaded);
  }, []);

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
    async (cmd: string, cwd: string, options?: { restorePanels?: boolean }): Promise<void> => {
      if (!activeSession) return;
      const shouldRestorePanels = options?.restorePanels ?? true;
      restorePanelsAfterCommandSessionIdRef.current = shouldRestorePanels ? activeSession.id : null;
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
      profiles,
      profilesLoaded,
      setAvailableProfiles,
      setProfilesLoaded: setProfilesLoadedState,
      writeToTerminal,
      runCommand,
    }),
    [activeCwd, profiles, profilesLoaded, runCommand, setProfilesLoadedState, terminalState, writeToTerminal],
  );
}

export function TerminalProvider({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

export function useTerminal(): TerminalContextValue {
  return useAppRuntimeContext().terminal;
}
