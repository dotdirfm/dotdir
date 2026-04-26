import {
  panelsVisibleAtom,
  terminalFocusRequestKeyAtom,
} from "@/atoms";
import { activeTabAtom } from "@/entities/tab/model/tabsAtoms";
import type { TerminalProfile } from "@/features/bridge";
import { useBridge } from "@/features/bridge/useBridge";
import { useCommandRegistry } from "@/features/commands/commands";
import { useActivePanelNavigation } from "@/features/panels/panelControllers";
import { formatHiddenCd, normalizeTerminalPath } from "@/features/terminal/path";
import { terminalActiveSessionIdAtom, terminalSessionsAtom } from "@/features/terminal/terminalAtoms";
import { TerminalSession } from "@/features/terminal/TerminalSession";
import type { ManagedTerminalSession } from "@/features/terminal/types";
import { useUiState } from "@/features/ui-state/uiState";
import { useFocusContext } from "@/focusContext";
import { normalizePath } from "@/utils/path";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

function makeSessionId(): string {
  return `term-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// ── Types ─────────────────────────────────────────────────────────────────────

export type { ManagedTerminalSession };

export interface TerminalState {
  sessions: ManagedTerminalSession[];
  activeSessionId: string | null;
  activeSession: ManagedTerminalSession | null;
  setProfiles: (profiles: TerminalProfile[], cwd: string) => Promise<void>;
  setCurrentCwd: (cwd: string) => void;
  createSession: (profileId?: string) => void;
  activate: (sessionId: string) => void;
  closeSession: (sessionId: string) => void;
  switchActiveProfile: (profileId: string) => void;
  restartAll: () => void;
  refreshActivePrompt: () => void;
  writeToActiveSession: (data: string) => Promise<void>;
  executeCommandInCwd: (command: string, cwd: string) => Promise<void>;
  dispose: () => void;
}

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

// ── Provider hook (called once at app root) ───────────────────────────────────

const TerminalContext = createContext<TerminalContextValue | null>(null);

export function useProvideTerminal(): TerminalContextValue {
  const uiState = useUiState();
  const bridge = useBridge();
  const commandRegistry = useCommandRegistry();
  const focusContext = useFocusContext();
  const { navigateTo } = useActivePanelNavigation();
  const [profiles, setAvailableProfiles] = useState<TerminalProfile[]>([]);
  const [profilesLoaded, setProfilesLoaded] = useState(false);

  const [panelsVisible, setPanelsVisible] = useAtom(panelsVisibleAtom);
  const setTerminalFocusRequestKey = useSetAtom(terminalFocusRequestKeyAtom);
  const [sessions, setSessions] = useAtom(terminalSessionsAtom);
  const [activeSessionId, setActiveSessionId] = useAtom(terminalActiveSessionIdAtom);

  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const activeSessionIdRef = useRef(activeSessionId);
  activeSessionIdRef.current = activeSessionId;
  const profilesRef = useRef<TerminalProfile[]>([]);
  const currentCwdRef = useRef("");

  const activeSession = sessions.find((s) => s.id === activeSessionId) ?? null;

  const persistAndSet = useCallback(
    (newSessions: ManagedTerminalSession[], activeId: string | null) => {
      uiState.updateCurrentWindowLayout({
        terminalSessions: {
          activeSessionId: activeId,
          sessions: newSessions.map((s) => ({ profileId: s.profileId })),
        },
      });
      setSessions(newSessions);
      setActiveSessionId(activeId);
    },
    [uiState, setSessions, setActiveSessionId],
  );

  const createManagedSession = useCallback(
    (profile: TerminalProfile, cwd: string, sessionId = makeSessionId()): ManagedTerminalSession => {
      const session = new TerminalSession(bridge, cwd, profile, () => focusContext.is("terminal"));
      const managed: ManagedTerminalSession = {
        id: sessionId,
        session,
        profile,
        profileId: profile.id,
        profileLabel: profile.label,
        cwd: normalizeTerminalPath(cwd),
        cwdUserInitiated: false,
        status: "idle",
      };

      session.subscribe((event) => {
        setSessions((prev) => {
          const current = prev.find((s) => s.id === sessionId);
          if (!current) return prev;
          let updated: ManagedTerminalSession | null = null;
          if (event.type === "cwd") {
            updated = { ...current, cwd: normalizeTerminalPath(event.cwd), cwdUserInitiated: event.userInitiated };
          } else if (event.type === "status") {
            updated = { ...current, status: event.status, error: event.error };
          } else if (event.type === "launch") {
            updated = { ...current, cwd: normalizeTerminalPath(event.launch.cwd) };
          }
          return updated ? prev.map((s) => (s.id === sessionId ? updated! : s)) : prev;
        });
      });

      session.start().catch(() => {});
      return managed;
    },
    [bridge, focusContext, setSessions],
  );

  const setProfiles = useCallback(
    async (newProfiles: TerminalProfile[], cwd: string) => {
      profilesRef.current = newProfiles;
      currentCwdRef.current = cwd;

      const currentSessions = sessionsRef.current;
      if (currentSessions.length > 0) {
        setSessions(
          currentSessions.map((s) => {
            const profile = newProfiles.find((p) => p.id === s.profileId) ?? newProfiles[0];
            if (!profile) return s;
            return { ...s, profile, profileId: profile.id, profileLabel: profile.label };
          }),
        );
        return;
      }

      const layout = await uiState.loadCurrentWindowLayout();
      const stored = layout.terminalSessions ?? null;
      const storedProfileIds = stored?.sessions.map((s) => s.profileId) ?? [];
      const resolvedProfiles = storedProfileIds
        .map((id) => newProfiles.find((p) => p.id === id))
        .filter((p): p is TerminalProfile => p != null);
      const startProfiles = resolvedProfiles.length > 0 ? resolvedProfiles : newProfiles[0] ? [newProfiles[0]] : [];

      const newSessions: ManagedTerminalSession[] = [];
      for (const profile of startProfiles) {
        newSessions.push(createManagedSession(profile, cwd));
      }

      const activeId =
        stored?.activeSessionId && newSessions.some((s) => s.id === stored.activeSessionId)
          ? stored.activeSessionId
          : (newSessions[0]?.id ?? null);

      persistAndSet(newSessions, activeId);
    },
    [uiState, setSessions, createManagedSession, persistAndSet],
  );

  const setCurrentCwd = useCallback((cwd: string) => {
    currentCwdRef.current = normalizeTerminalPath(cwd);
  }, []);

  const createSession = useCallback(
    (profileId?: string) => {
      const profile = profilesRef.current.find((p) => p.id === profileId) ?? profilesRef.current[0];
      if (!profile) return;
      const managed = createManagedSession(profile, currentCwdRef.current);
      persistAndSet([...sessionsRef.current, managed], managed.id);
    },
    [createManagedSession, persistAndSet],
  );

  const activate = useCallback(
    (sessionId: string) => {
      const currentSessions = sessionsRef.current;
      if (!currentSessions.some((s) => s.id === sessionId)) return;
      persistAndSet(currentSessions, sessionId);
    },
    [persistAndSet],
  );

  const closeSession = useCallback(
    (sessionId: string) => {
      const currentSessions = sessionsRef.current;
      if (currentSessions.length <= 1) return;
      const closing = currentSessions.find((s) => s.id === sessionId);
      if (!closing) return;
      void closing.session.dispose();
      const next = currentSessions.filter((s) => s.id !== sessionId);
      const activeId =
        activeSessionIdRef.current === sessionId ? (next[next.length - 1]?.id ?? null) : activeSessionIdRef.current;
      persistAndSet(next, activeId);
    },
    [persistAndSet],
  );

  const switchActiveProfile = useCallback(
    (profileId: string) => {
      const currentSessions = sessionsRef.current;
      const active = currentSessions.find((s) => s.id === activeSessionIdRef.current);
      const profile = profilesRef.current.find((p) => p.id === profileId) ?? profilesRef.current[0];
      if (!active || !profile || active.profileId === profile.id) return;
      const replacement = createManagedSession(profile, active.cwd || currentCwdRef.current);
      void active.session.dispose();
      persistAndSet(
        currentSessions.map((s) => (s.id === active.id ? replacement : s)),
        replacement.id,
      );
    },
    [createManagedSession, persistAndSet],
  );

  const restartAll = useCallback(() => {
    const previous = sessionsRef.current;
    const newSessions = previous.map((s) => {
      const profile = profilesRef.current.find((p) => p.id === s.profileId) ?? s.profile;
      return createManagedSession(profile, s.cwd || currentCwdRef.current, s.id);
    });
    for (const s of previous) void s.session.dispose();
    persistAndSet(newSessions, activeSessionIdRef.current);
  }, [createManagedSession, persistAndSet]);

  const refreshActivePrompt = useCallback(() => {
    const active = sessionsRef.current.find((s) => s.id === activeSessionIdRef.current);
    void active?.session.refreshPrompt();
  }, []);

  const writeToActiveSession = useCallback(async (data: string): Promise<void> => {
    const active = sessionsRef.current.find((s) => s.id === activeSessionIdRef.current);
    if (!active) return;
    await active.session.write(data);
  }, []);

  const executeCommandInCwd = useCallback(async (command: string, cwd: string): Promise<void> => {
    const active = sessionsRef.current.find((s) => s.id === activeSessionIdRef.current);
    if (!active) return;
    const normalizedCwd = normalizeTerminalPath(cwd);
    await active.session.writeHidden(formatHiddenCd(normalizedCwd, active.profile));
    const eol = active.profile.lineEnding === "\r\n" ? "\r\n" : "\n";
    await active.session.write(command + eol);
  }, []);

  const dispose = useCallback(() => {
    for (const s of sessionsRef.current) void s.session.dispose();
    setSessions([]);
    setActiveSessionId(null);
  }, [setSessions, setActiveSessionId]);

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
      void setProfiles(profiles, activePanelCwdRef.current);
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
      sessions,
      activeSessionId,
      activeSession,
      setProfiles,
      setCurrentCwd,
      createSession,
      activate,
      closeSession,
      switchActiveProfile,
      restartAll,
      refreshActivePrompt,
      writeToActiveSession,
      executeCommandInCwd,
      dispose,
      activeCwd,
      profiles,
      profilesLoaded,
      setAvailableProfiles,
      setProfilesLoaded: setProfilesLoadedState,
      writeToTerminal,
      runCommand,
    }),
    [
      sessions,
      activeSessionId,
      activeSession,
      setProfiles,
      setCurrentCwd,
      createSession,
      activate,
      closeSession,
      switchActiveProfile,
      restartAll,
      refreshActivePrompt,
      writeToActiveSession,
      executeCommandInCwd,
      dispose,
      activeCwd,
      profiles,
      profilesLoaded,
      runCommand,
      setProfilesLoadedState,
      writeToTerminal,
    ],
  );
}

export function TerminalProvider({ children }: { children: ReactNode }) {
  const value = useProvideTerminal();
  return <TerminalContext.Provider value={value}>{children}</TerminalContext.Provider>;
}

export function useTerminal(): TerminalContextValue {
  const value = useContext(TerminalContext);
  if (!value) throw new Error("TerminalProvider not mounted");
  return value;
}
