import { useEffect, useMemo, useRef, useState } from 'react';
import { normalizePath } from './path';
import { bridge, type TerminalProfile } from './bridge';
import { TerminalView } from './terminal/TerminalView';
import { TerminalService, type TerminalServiceSnapshot } from './terminal/TerminalService';

const COMPACT_VISIBLE_HEIGHT = 40;

interface TerminalPanelProps {
  cwd: string;
  expanded?: boolean;
  onCwdChange?: (path: string) => void;
  onVisibleHeight?: (px: number) => void;
  onPromptActive?: (active: boolean) => void;
}

const emptySnapshot: TerminalServiceSnapshot = {
  sessions: [],
  activeSessionId: null,
};

export function TerminalPanel({ cwd, expanded = false, onCwdChange, onVisibleHeight, onPromptActive }: TerminalPanelProps) {
  const lastReportedCwdRef = useRef<string | null>(null);
  const service = useMemo(() => new TerminalService(), []);
  const [profiles, setProfiles] = useState<TerminalProfile[]>([]);
  const [profilesLoaded, setProfilesLoaded] = useState(false);
  const [snapshot, setSnapshot] = useState<TerminalServiceSnapshot>(emptySnapshot);

  useEffect(() => {
    onVisibleHeight?.(COMPACT_VISIBLE_HEIGHT);
    onPromptActive?.(true);
  }, [onPromptActive, onVisibleHeight]);

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
    const active = snapshot.sessions.find((session) => session.id === snapshot.activeSessionId);
    if (active?.cwd) {
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

  return (
    <div className="terminal-panel">
      <div className="terminal-body">
        {activeSession ? (
          <TerminalView key={activeSession.id} session={activeSession.session} expanded={expanded} />
        ) : (
          <div className="terminal-loading">Loading terminal...</div>
        )}
      </div>
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
            onClick={() => service.createSession(activeSession?.profileId ?? profiles[0]?.id)}
          >
            +
          </button>
        </div>
        <label className="terminal-profile-picker">
          <span className="terminal-profile-label">Shell</span>
          <select
            value={activeSession?.profileId ?? ''}
            disabled={!profilesLoaded || profiles.length === 0 || !activeSession}
            onChange={(event) => {
              service.switchActiveProfile(event.target.value);
            }}
          >
            {profiles.map((profile) => (
              <option key={profile.id} value={profile.id}>{profile.label}</option>
            ))}
          </select>
        </label>
        {activeSession && <div className="terminal-profile-shell">{profiles.find((profile) => profile.id === activeSession.profileId)?.shell}</div>}
        {activeSession?.error && <div className="terminal-status-error">{activeSession.error}</div>}
      </div>
    </div>
  );
}
