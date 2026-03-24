import type { TerminalProfile } from "../bridge";
import { TerminalSession } from "./TerminalSession";
import { formatHiddenCd, normalizeTerminalPath } from "./path";
import type { TerminalSessionStatus } from "./types";

const TERMINAL_STATE_STORAGE_KEY = "faraday.terminalSessions";

interface StoredTerminalSession {
  profileId: string;
}

interface StoredTerminalState {
  activeSessionId: string | null;
  sessions: StoredTerminalSession[];
}

export interface ManagedTerminalSession {
  id: string;
  session: TerminalSession;
  profile: TerminalProfile;
  profileId: string;
  profileLabel: string;
  cwd: string;
  cwdUserInitiated: boolean;
  status: TerminalSessionStatus;
  error?: string;
}

export interface TerminalServiceSnapshot {
  sessions: ManagedTerminalSession[];
  activeSessionId: string | null;
}

type Listener = () => void;

function readStoredState(): StoredTerminalState | null {
  try {
    const raw = window.localStorage.getItem(TERMINAL_STATE_STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as StoredTerminalState;
  } catch {
    return null;
  }
}

function writeStoredState(snapshot: TerminalServiceSnapshot): void {
  try {
    const state: StoredTerminalState = {
      activeSessionId: snapshot.activeSessionId,
      sessions: snapshot.sessions.map((session) => ({ profileId: session.profileId })),
    };
    window.localStorage.setItem(TERMINAL_STATE_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Ignore storage errors.
  }
}

function makeSessionId(): string {
  return `term-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export class TerminalService {
  private readonly listeners = new Set<Listener>();
  private sessions: ManagedTerminalSession[] = [];
  private activeSessionId: string | null = null;
  private profiles: TerminalProfile[] = [];
  private currentCwd = "";

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getSnapshot(): TerminalServiceSnapshot {
    return {
      sessions: this.sessions,
      activeSessionId: this.activeSessionId,
    };
  }

  setProfiles(profiles: TerminalProfile[], cwd: string): void {
    this.profiles = profiles;
    this.currentCwd = cwd;

    if (this.sessions.length > 0) {
      this.sessions = this.sessions.map((session) => this.relabelSession(session));
      this.emit();
      return;
    }

    const stored = readStoredState();
    // Try to restore stored profile IDs; fall back to first profile if none match
    const storedProfileIds = stored?.sessions.map((s) => s.profileId) ?? [];
    const resolvedProfiles = storedProfileIds.map((id) => profiles.find((p) => p.id === id)).filter((p): p is TerminalProfile => p != null);

    const startProfiles = resolvedProfiles.length > 0 ? resolvedProfiles : profiles[0] ? [profiles[0]] : [];

    for (const profile of startProfiles) {
      this.sessions.push(this.createManagedSession(profile, cwd));
    }

    this.activeSessionId =
      stored?.activeSessionId && this.sessions.some((session) => session.id === stored.activeSessionId)
        ? stored.activeSessionId
        : (this.sessions[0]?.id ?? null);

    this.persistAndEmit();
  }

  /** Update the tracked panel cwd (used as starting directory for new sessions). Does NOT cd the active shell. */
  setCurrentCwd(cwd: string): void {
    this.currentCwd = normalizeTerminalPath(cwd);
  }

  createSession(profileId?: string): void {
    const resolvedProfile = this.resolveProfile(profileId);
    if (!resolvedProfile) return;

    const managed = this.createManagedSession(resolvedProfile, this.currentCwd);
    this.sessions = [...this.sessions, managed];
    this.activeSessionId = managed.id;
    this.persistAndEmit();
  }

  activate(sessionId: string): void {
    if (!this.sessions.some((session) => session.id === sessionId)) return;
    this.activeSessionId = sessionId;
    this.persistAndEmit();
  }

  switchActiveProfile(profileId: string): void {
    const active = this.getActiveSession();
    const profile = this.resolveProfile(profileId);
    if (!active || !profile || active.profileId === profile.id) return;

    // Generate a new session ID so that Terminal.tsx's activeSessionId-dependent
    // subscribe effect re-runs and subscribes to the new session's events.
    const replacement = this.createManagedSession(profile, active.cwd || this.currentCwd);
    void active.session.dispose();
    this.sessions = this.sessions.map((session) => (session.id === active.id ? replacement : session));
    this.activeSessionId = replacement.id;
    this.persistAndEmit();
  }

  closeSession(sessionId: string): void {
    if (this.sessions.length <= 1) return;
    const closing = this.sessions.find((session) => session.id === sessionId);
    if (!closing) return;
    void closing.session.dispose();

    const nextSessions = this.sessions.filter((session) => session.id !== sessionId);
    this.sessions = nextSessions;
    if (this.activeSessionId === sessionId) {
      this.activeSessionId = nextSessions[nextSessions.length - 1]?.id ?? null;
    }
    this.persistAndEmit();
  }

  restartAll(): void {
    const previous = this.sessions;
    this.sessions = previous.map((session) => {
      const profile = this.resolveProfile(session.profileId) ?? session.profile;
      return this.createManagedSession(profile, session.cwd || this.currentCwd, session.id);
    });
    for (const session of previous) {
      void session.session.dispose();
    }
    this.persistAndEmit();
  }

  refreshActivePrompt(): void {
    const active = this.getActiveSession();
    if (!active) return;
    void active.session.refreshPrompt();
  }

  /** Write text to the active terminal session (e.g. to run a command). */
  async writeToActiveSession(data: string): Promise<void> {
    const active = this.getActiveSession();
    if (!active) return;
    await active.session.write(data);
  }

  /** Hidden cd to panel cwd, then run the user's command (command line). */
  async executeCommandInCwd(command: string, cwd: string): Promise<void> {
    const active = this.getActiveSession();
    if (!active) return;
    const normalizedCwd = normalizeTerminalPath(cwd);
    await active.session.writeHidden(formatHiddenCd(normalizedCwd, active.profile));
    const eol = active.profile.lineEnding === "\r\n" ? "\r\n" : "\n";
    await active.session.write(command + eol);
  }

  dispose(): void {
    for (const session of this.sessions) {
      void session.session.dispose();
    }
    this.sessions = [];
    this.activeSessionId = null;
    this.emit();
  }

  private getActiveSession(): ManagedTerminalSession | undefined {
    return this.sessions.find((session) => session.id === this.activeSessionId);
  }

  private resolveProfile(profileId?: string): TerminalProfile | undefined {
    if (profileId) {
      return this.profiles.find((profile) => profile.id === profileId) ?? this.profiles[0];
    }
    return this.profiles[0];
  }

  private createManagedSession(profile: TerminalProfile, cwd: string, sessionId = makeSessionId()): ManagedTerminalSession {
    const session = new TerminalSession(cwd, profile);
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
      if (event.type === "cwd") {
        managed.cwd = normalizeTerminalPath(event.cwd);
        managed.cwdUserInitiated = event.userInitiated;
      } else if (event.type === "status") {
        managed.status = event.status;
        managed.error = event.error;
      } else if (event.type === "launch") {
        managed.cwd = normalizeTerminalPath(event.launch.cwd);
      }
      this.emit();
    });

    session.start().catch(() => {
      // Session state already receives the error through its status event.
    });

    return managed;
  }

  private relabelSession(session: ManagedTerminalSession): ManagedTerminalSession {
    const profile = this.resolveProfile(session.profileId);
    if (!profile) return session;
    return {
      ...session,
      profile,
      profileId: profile.id,
      profileLabel: profile.label,
    };
  }

  private emit(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }

  private persistAndEmit(): void {
    writeStoredState(this.getSnapshot());
    this.emit();
  }
}
