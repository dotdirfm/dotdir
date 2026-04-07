import type { TerminalProfile } from "@/features/bridge";
import { useBridge } from "@/features/bridge/useBridge";
import { formatHiddenCd, normalizeTerminalPath } from "@/features/terminal/path";
import { terminalActiveSessionIdAtom, terminalSessionsAtom } from "@/features/terminal/terminalAtoms";
import { TerminalSession } from "@/features/terminal/TerminalSession";
import type { ManagedTerminalSession } from "@/features/terminal/types";
import { useFocusContext } from "@/focusContext";
import { useAtomValue, useSetAtom } from "jotai";
import { useCallback, useRef } from "react";

export type { ManagedTerminalSession };

// ── Persistence ───────────────────────────────────────────────────────────────

const TERMINAL_STATE_STORAGE_KEY = "dotdir.terminalSessions";

interface StoredTerminalSession {
  profileId: string;
}

interface StoredTerminalState {
  activeSessionId: string | null;
  sessions: StoredTerminalSession[];
}

function readStoredState(): StoredTerminalState | null {
  try {
    const raw = window.localStorage.getItem(TERMINAL_STATE_STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as StoredTerminalState;
  } catch {
    return null;
  }
}

function writeStoredState(sessions: ManagedTerminalSession[], activeSessionId: string | null): void {
  try {
    const state: StoredTerminalState = {
      activeSessionId,
      sessions: sessions.map((s) => ({ profileId: s.profileId })),
    };
    window.localStorage.setItem(TERMINAL_STATE_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Ignore storage errors.
  }
}

function makeSessionId(): string {
  return `term-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export interface TerminalState {
  sessions: ManagedTerminalSession[];
  activeSessionId: string | null;
  activeSession: ManagedTerminalSession | null;
  setProfiles: (profiles: TerminalProfile[], cwd: string) => void;
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

export function useTerminalState(): TerminalState {
  const bridge = useBridge();
  const focusContext = useFocusContext();
  const sessions = useAtomValue(terminalSessionsAtom);
  const setSessions = useSetAtom(terminalSessionsAtom);
  const activeSessionId = useAtomValue(terminalActiveSessionIdAtom);
  const setActiveSessionId = useSetAtom(terminalActiveSessionIdAtom);

  // Refs for reading current values in callbacks without stale closures
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const activeSessionIdRef = useRef(activeSessionId);
  activeSessionIdRef.current = activeSessionId;
  const profilesRef = useRef<TerminalProfile[]>([]);
  const currentCwdRef = useRef("");

  const activeSession = sessions.find((s) => s.id === activeSessionId) ?? null;

  const persistAndSet = useCallback(
    (newSessions: ManagedTerminalSession[], activeId: string | null) => {
      writeStoredState(newSessions, activeId);
      setSessions(newSessions);
      setActiveSessionId(activeId);
    },
    [setSessions, setActiveSessionId],
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

      // Use functional update: subscription fires async, so a ref may be stale
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
    (profiles: TerminalProfile[], cwd: string) => {
      profilesRef.current = profiles;
      currentCwdRef.current = cwd;

      const currentSessions = sessionsRef.current;
      if (currentSessions.length > 0) {
        setSessions(
          currentSessions.map((s) => {
            const profile = profiles.find((p) => p.id === s.profileId) ?? profiles[0];
            if (!profile) return s;
            return { ...s, profile, profileId: profile.id, profileLabel: profile.label };
          }),
        );
        return;
      }

      const stored = readStoredState();
      const storedProfileIds = stored?.sessions.map((s) => s.profileId) ?? [];
      const resolvedProfiles = storedProfileIds
        .map((id) => profiles.find((p) => p.id === id))
        .filter((p): p is TerminalProfile => p != null);
      const startProfiles = resolvedProfiles.length > 0 ? resolvedProfiles : profiles[0] ? [profiles[0]] : [];

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
    [setSessions, createManagedSession, persistAndSet],
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

  return {
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
  };
}
