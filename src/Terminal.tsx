import type { ReactNode } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { normalizePath } from './path';
import { bridge, type TerminalProfile } from './bridge';
import { TerminalView } from './terminal/TerminalView';
import { TerminalService, type TerminalServiceSnapshot } from './terminal/TerminalService';

interface TerminalPanelProps {
  cwd: string;
  expanded?: boolean;
  focusRequestKey?: number;
  profiles?: TerminalProfile[];
  profilesLoaded?: boolean;
  onCwdChange?: (path: string) => void;
  onPromptActive?: (active: boolean) => void;
  /** Called when the active session starts or finishes a command. */
  onCommandRunningChange?: (running: boolean) => void;
  /** Called with a function that writes to the active terminal (for list.execute). */
  onWriteToTerminal?: (write: (data: string) => Promise<void>) => void;
  /** Called with a function that cd's to cwd and runs a command in the active terminal. */
  onExecuteCommand?: (execute: (command: string, cwd: string) => Promise<void>) => void;
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

export function TerminalPanelBody({
  activeSessionId,
  session,
  expanded = false,
  focusRequestKey = 0,
}: {
  activeSessionId: string | null;
  session: unknown;
  expanded?: boolean;
  focusRequestKey?: number;
}) {
  return (
    <div className="terminal-panel">
      <div className="terminal-body">
        {activeSessionId && session && typeof session === 'object' ? (
          <TerminalView key={activeSessionId} session={session as never} expanded={expanded} focusRequestKey={focusRequestKey} />
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
  focusRequestKey = 0,
  profiles: profilesProp = [],
  profilesLoaded: profilesLoadedProp = false,
  onCwdChange,
  onPromptActive,
  onCommandRunningChange,
  onWriteToTerminal,
  onExecuteCommand,
  children,
}: TerminalPanelProps & { children: (slots: { body: ReactNode; toolbar: ReactNode }) => ReactNode }) {
  const lastReportedCwdRef = useRef<string | null>(null);
  const service = useMemo(() => new TerminalService(), []);
  const [snapshot, setSnapshot] = useState<TerminalServiceSnapshot>(emptySnapshot);

  const onPromptActiveRef = useRef(onPromptActive);
  onPromptActiveRef.current = onPromptActive;
  const onCommandRunningChangeRef = useRef(onCommandRunningChange);
  onCommandRunningChangeRef.current = onCommandRunningChange;
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;

  useEffect(() => {
    const cleanup = service.subscribe(() => {
      setSnapshot(service.getSnapshot());
    });
    setSnapshot(service.getSnapshot());
    return cleanup;
  }, [service]);

  // Subscribe to command-start / command-finish events on the active session.
  // Resubscribes whenever the active session ID changes.
  useEffect(() => {
    const active = snapshotRef.current.sessions.find((s) => s.id === snapshotRef.current.activeSessionId);
    if (!active) {
      onPromptActiveRef.current?.(true);
      onCommandRunningChangeRef.current?.(false);
      return;
    }
    // Sync initial state for this session
    const running = active.session.getCapabilities().commandRunning;
    onPromptActiveRef.current?.(!running);
    onCommandRunningChangeRef.current?.(running);

    return active.session.subscribe((event) => {
      if (event.type === 'command-start') {
        onPromptActiveRef.current?.(false);
        onCommandRunningChangeRef.current?.(true);
      } else if (event.type === 'command-finish') {
        onPromptActiveRef.current?.(true);
        onCommandRunningChangeRef.current?.(false);
      } else if (event.type === 'capabilities') {
        const running = event.capabilities.commandRunning;
        onPromptActiveRef.current?.(!running);
        onCommandRunningChangeRef.current?.(running);
      }
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot.activeSessionId]);

  useEffect(() => {
    if (profilesLoadedProp && profilesProp.length > 0) {
      service.setProfiles(profilesProp, cwd);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [service, profilesLoadedProp, profilesProp]);

  useEffect(() => {
    return () => {
      service.dispose();
    };
  }, [service]);

  useEffect(() => {
    service.setCurrentCwd(cwd);
  }, [cwd, service]);

  useEffect(() => {
    onWriteToTerminal?.((data: string) => service.writeToActiveSession(data));
  }, [service, onWriteToTerminal]);

  useEffect(() => {
    onExecuteCommand?.((command: string, cwd: string) => service.executeCommandInCwd(command, cwd));
  }, [service, onExecuteCommand]);

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
    ? profilesProp.find((profile) => profile.id === activeSession.profileId)?.shell ?? null
    : null;

  const body = (
    <TerminalPanelBody
      activeSessionId={activeSession?.id ?? null}
      session={activeSession?.session ?? null}
      expanded={expanded}
      focusRequestKey={focusRequestKey}
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
      profiles={profilesProp}
      profilesLoaded={profilesLoadedProp}
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
