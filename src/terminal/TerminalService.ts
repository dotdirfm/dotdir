import type { TerminalProfile } from '../bridge';
import { TerminalSession } from './TerminalSession';
import type { TerminalSessionStatus } from './types';

const TERMINAL_STATE_STORAGE_KEY = 'faraday.terminalSessions';

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
  profileId: string;
  profileLabel: string;
  cwd: string;
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
  private currentCwd = '';

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
    const profileIds = stored?.sessions
      .map((session) => session.profileId)
      .filter((profileId) => profiles.some((profile) => profile.id === profileId)) ?? [];

    if (profileIds.length === 0 && profiles[0]) {
      profileIds.push(profiles[0].id);
    }

    for (const profileId of profileIds) {
      this.sessions.push(this.createManagedSession(profileId, cwd));
    }

    this.activeSessionId = stored?.activeSessionId && this.sessions.some((session) => session.id === stored.activeSessionId)
      ? stored.activeSessionId
      : this.sessions[0]?.id ?? null;

    this.persistAndEmit();
  }

  syncActiveCwd(cwd: string): void {
    this.currentCwd = cwd;
    const active = this.getActiveSession();
    if (!active) return;
    void active.session.syncToCwd(cwd);
  }

  createSession(profileId?: string): void {
    const resolvedProfile = this.resolveProfile(profileId);
    if (!resolvedProfile) return;

    const managed = this.createManagedSession(resolvedProfile.id, this.currentCwd);
    this.sessions = [...this.sessions, managed];
    this.activeSessionId = managed.id;
    this.persistAndEmit();
  }

  activate(sessionId: string): void {
    if (!this.sessions.some((session) => session.id === sessionId)) return;
    this.activeSessionId = sessionId;
    this.persistAndEmit();
    const active = this.getActiveSession();
    if (active) {
      void active.session.syncToCwd(this.currentCwd);
    }
  }

  switchActiveProfile(profileId: string): void {
    const active = this.getActiveSession();
    const profile = this.resolveProfile(profileId);
    if (!active || !profile || active.profileId === profile.id) return;

    const replacement = this.createManagedSession(profile.id, active.cwd || this.currentCwd, active.id);
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
    this.sessions = previous.map((session) =>
      this.createManagedSession(session.profileId, session.cwd || this.currentCwd, session.id),
    );
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

  private createManagedSession(profileId: string, cwd: string, sessionId = makeSessionId()): ManagedTerminalSession {
    const profile = this.resolveProfile(profileId);
    const session = new TerminalSession(cwd, profile?.id);
    const managed: ManagedTerminalSession = {
      id: sessionId,
      session,
      profileId: profile?.id ?? profileId,
      profileLabel: profile?.label ?? profileId,
      cwd,
      status: 'idle',
    };

    session.subscribe((event) => {
      if (event.type === 'cwd') {
        managed.cwd = event.cwd;
      } else if (event.type === 'status') {
        managed.status = event.status;
        managed.error = event.error;
      } else if (event.type === 'launch') {
        managed.profileId = event.launch.profileId;
        managed.profileLabel = event.launch.profileLabel;
        managed.cwd = event.launch.cwd;
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
