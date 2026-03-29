import { panelsVisibleAtom, resolvedProfilesAtom, terminalFocusRequestKeyAtom, terminalProfilesLoadedAtom } from "@/atoms";
import { TerminalView } from "@/terminal/TerminalView";
import { useTerminalState } from "@/terminal/useTerminalState";
import { useAtomValue } from "jotai";

export function TerminalToolbar() {
  const profiles = useAtomValue(resolvedProfilesAtom);
  const profilesLoaded = useAtomValue(terminalProfilesLoadedAtom);
  const { sessions, activeSessionId, activeSession, activate, createSession, closeSession, switchActiveProfile } = useTerminalState();
  const activeProfileId = activeSession?.profileId ?? null;
  const activeProfileShell = activeSession ? (profiles.find((p) => p.id === activeSession.profileId)?.shell ?? null) : null;
  const activeError = activeSession?.error ?? null;

  return (
    <div className="terminal-toolbar">
      <div className="terminal-tabs">
        {sessions.map((session) => (
          <button
            key={session.id}
            type="button"
            className={`terminal-tab ${session.id === activeSessionId ? "active" : ""}`}
            onClick={() => activate(session.id)}
          >
            <span className={`terminal-tab-status status-${session.status}`} />
            <span className="terminal-tab-label">{session.profileLabel}</span>
            {sessions.length > 1 && (
              <span
                className="terminal-tab-close"
                onClick={(event) => {
                  event.stopPropagation();
                  closeSession(session.id);
                }}
              >
                x
              </span>
            )}
          </button>
        ))}
        <button type="button" className="terminal-tab terminal-tab-add" onClick={() => createSession(activeProfileId ?? profiles[0]?.id)}>
          +
        </button>
      </div>
      <label className="terminal-profile-picker">
        <span className="terminal-profile-label">Shell</span>
        <select
          value={activeProfileId ?? ""}
          disabled={!profilesLoaded || profiles.length === 0 || !activeSessionId}
          onChange={(event) => switchActiveProfile(event.target.value)}
        >
          {profiles.map((profile) => (
            <option key={profile.id} value={profile.id}>
              {profile.label}
            </option>
          ))}
        </select>
      </label>
      {activeSessionId && <div className="terminal-profile-shell">{activeProfileShell ?? ""}</div>}
      {activeError && <div className="terminal-status-error">{activeError}</div>}
    </div>
  );
}

export function TerminalPanelBody() {
  const { activeSession } = useTerminalState();
  const panelsVisible = useAtomValue(panelsVisibleAtom);
  const focusRequestKey = useAtomValue(terminalFocusRequestKeyAtom);

  return (
    <div className="terminal-panel">
      <div className="terminal-body">
        {activeSession ? (
          <TerminalView
            key={activeSession.id}
            session={activeSession.session}
            expanded={!panelsVisible}
            focusRequestKey={focusRequestKey}
          />
        ) : (
          <div className="terminal-loading">Loading terminal...</div>
        )}
      </div>
    </div>
  );
}
