import type { ReactNode } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { normalizePath } from './path';
import { bridge, type TerminalProfile } from './bridge';
import { TerminalView } from './terminal/TerminalView';
import { TerminalService, type TerminalServiceSnapshot } from './terminal/TerminalService';

interface TerminalPanelProps {
  cwd: string;
  expanded?: boolean;
  onCwdChange?: (path: string) => void;
  onPromptActive?: (active: boolean) => void;
  /** Called with a function that writes to the active terminal (for list.execute). */
  onWriteToTerminal?: (write: (data: string) => Promise<void>) => void;
}

interface TerminalToolbarProps {
  snapshot: TerminalServiceSnapshot;
  service: TerminalService;
  activeSessionId: string | null;
  activeProfileId: string | null;
  activeProfileShell: string | null;
  activeError: string | null;
  profiles: TerminalProfile[];
  profilesLoaded: boolean;
}

const emptySnapshot: TerminalServiceSnapshot = {
  sessions: [],
  activeSessionId: null,
};

export function TerminalToolbar({
  snapshot,
  service,
  activeSessionId,
  activeProfileId,
  activeProfileShell,
  activeError,
  profiles,
  profilesLoaded,
}: TerminalToolbarProps) {
  return (
    <div className="terminal-toolbar">
      <div className="terminal-tabs">
        {snapshot.sessions.map((session) => (
          <button
            key={session.id}
            type="button"
            className={`terminal-tab ${session.id === snapshot.activeSessionId ? 'active' : ''}`}
            onClick={() => service.activate(session.id)}
          >
            <span className={`terminal-tab-status status-${session.status}`} />
            <span className="terminal-tab-label">{session.profileLabel}</span>
            {snapshot.sessions.length > 1 && (
              <span
                className="terminal-tab-close"
                onClick={(event) => {
                  event.stopPropagation();
                  service.closeSession(session.id);
                }}
              >
                x
              </span>
            )}
          </button>
        ))}
        <button
          type="button"
          className="terminal-tab terminal-tab-add"
          onClick={() => service.createSession(activeProfileId ?? profiles[0]?.id)}
        >
          +
        </button>
      </div>
      <label className="terminal-profile-picker">
        <span className="terminal-profile-label">Shell</span>
        <select
          value={activeProfileId ?? ''}
          disabled={!profilesLoaded || profiles.length === 0 || !activeSessionId}
          onChange={(event) => {
            service.switchActiveProfile(event.target.value);
          }}
        >
          {profiles.map((profile) => (
            <option key={profile.id} value={profile.id}>{profile.label}</option>
          ))}
        </select>
      </label>
      {activeSessionId && <div className="terminal-profile-shell">{activeProfileShell ?? ''}</div>}
      {activeError && <div className="terminal-status-error">{activeError}</div>}
    </div>
  );
}

export function TerminalPanelBody({ activeSessionId, session, expanded = false }: { activeSessionId: string | null; session: unknown; expanded?: boolean }) {
  return (
    <div className="terminal-panel">
      <div className="terminal-body">
        {activeSessionId && session && typeof session === 'object' ? (
          <TerminalView key={activeSessionId} session={session as never} expanded={expanded} />
        ) : (
          <div className="terminal-loading">Loading terminal...</div>
        )}
      </div>
    </div>
  );
}

export function TerminalController({
  cwd,
  expanded = false,
  onCwdChange,
  onPromptActive,
  onWriteToTerminal,
  children,
}: TerminalPanelProps & { children: (slots: { body: ReactNode; toolbar: ReactNode }) => ReactNode }) {
  const lastReportedCwdRef = useRef<string | null>(null);
  const service = useMemo(() => new TerminalService(), []);
  const [profiles, setProfiles] = useState<TerminalProfile[]>([]);
  const [profilesLoaded, setProfilesLoaded] = useState(false);
  const [snapshot, setSnapshot] = useState<TerminalServiceSnapshot>(emptySnapshot);

  useEffect(() => {
    onPromptActive?.(true);
  }, [onPromptActive]);

  useEffect(() => {
    const cleanup = service.subscribe(() => {
      setSnapshot(service.getSnapshot());
    });
    setSnapshot(service.getSnapshot());
    return cleanup;
  }, [service]);

  useEffect(() => {
    let cancelled = false;

    bridge.utils.getTerminalProfiles()
      .then((loadedProfiles) => {
        if (cancelled) return;
        setProfiles(loadedProfiles);
        service.setProfiles(loadedProfiles, cwd);
        setProfilesLoaded(true);
      })
      .catch((error) => {
        console.error('Failed to load terminal profiles', error);
        if (!cancelled) {
          setProfilesLoaded(true);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [service]);

  useEffect(() => {
    return () => {
      service.dispose();
    };
  }, [service]);

  useEffect(() => {
    service.syncActiveCwd(cwd);
  }, [cwd, service]);

  useEffect(() => {
    onWriteToTerminal?.( (data: string) => service.writeToActiveSession(data) );
  }, [service, onWriteToTerminal]);

  useEffect(() => {
    const active = snapshot.sessions.find((session) => session.id === snapshot.activeSessionId);
    if (active?.cwd && active.cwdUserInitiated) {
      const normalized = normalizePath(active.cwd);
      if (lastReportedCwdRef.current === normalized) return;
      lastReportedCwdRef.current = normalized;
      onCwdChange?.(normalized);
    }
  }, [onCwdChange, snapshot]);

  useEffect(() => {
    if (!bridge.onReconnect) return undefined;
    return bridge.onReconnect(() => {
      service.restartAll();
    });
  }, [service]);

  const activeSession = snapshot.sessions.find((session) => session.id === snapshot.activeSessionId) ?? null;
  const activeProfileShell = activeSession
    ? profiles.find((profile) => profile.id === activeSession.profileId)?.shell ?? null
    : null;

  const body = (
    <TerminalPanelBody
      activeSessionId={activeSession?.id ?? null}
      session={activeSession?.session ?? null}
      expanded={expanded}
    />
  );

  const toolbar = (
    <TerminalToolbar
      snapshot={snapshot}
      service={service}
      activeSessionId={activeSession?.id ?? null}
      activeProfileId={activeSession?.profileId ?? null}
      activeProfileShell={activeProfileShell}
      activeError={activeSession?.error ?? null}
      profiles={profiles}
      profilesLoaded={profilesLoaded}
    />
  );

  return children({ body, toolbar });
}

export function TerminalPanel(props: TerminalPanelProps) {
  return (
    <TerminalController {...props}>
      {({ body, toolbar }) => (
        <>
          {body}
          {toolbar}
        </>
      )}
    </TerminalController>
  );
}
