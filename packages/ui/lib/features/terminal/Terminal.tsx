import { panelsVisibleAtom, terminalFocusRequestKeyAtom } from "@/atoms";
import { TerminalView } from "@/features/terminal/TerminalView";
import { useTerminal } from "@/features/terminal/useTerminal";
import styles from "@/styles/terminal.module.css";
import { cx } from "@/utils/cssModules";
import { useAtomValue } from "jotai";

export function TerminalToolbar() {
  const { sessions, activeSessionId, activeSession, activate, createSession, closeSession, switchActiveProfile, profiles, profilesLoaded } = useTerminal();
  const activeProfileId = activeSession?.profileId ?? null;
  const activeProfileShell = activeSession ? (profiles.find((p) => p.id === activeSession.profileId)?.shell ?? null) : null;
  const activeError = activeSession?.error ?? null;

  return (
    <div className={styles["terminal-toolbar"]}>
      <div className={styles["terminal-tabs"]}>
        {sessions.map((session) => (
          <button
            key={session.id}
            tabIndex={-1}
            type="button"
            className={cx(styles, "terminal-tab", session.id === activeSessionId && "active")}
            onClick={() => activate(session.id)}
          >
            <span className={cx(styles, "terminal-tab-status", `status-${session.status}`)} />
            <span className={styles["terminal-tab-label"]}>{session.profileLabel}</span>
            {sessions.length > 1 && (
              <span
                className={styles["terminal-tab-close"]}
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
        <button
          type="button"
          tabIndex={-1}
          className={cx(styles, "terminal-tab", "terminal-tab-add")}
          onClick={() => createSession(activeProfileId ?? profiles[0]?.id)}
        >
          +
        </button>
      </div>
      <label className={styles["terminal-profile-picker"]}>
        <span className={styles["terminal-profile-label"]}>Shell</span>
        <select
          tabIndex={-1}
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
      {activeSessionId && <div className={styles["terminal-profile-shell"]}>{activeProfileShell ?? ""}</div>}
      {activeError && <div className={styles["terminal-status-error"]}>{activeError}</div>}
    </div>
  );
}

export function Terminal() {
  const { activeSession } = useTerminal();
  const panelsVisible = useAtomValue(panelsVisibleAtom);
  const focusRequestKey = useAtomValue(terminalFocusRequestKeyAtom);

  return (
    <div className={styles["terminal-panel"]}>
      <div className={styles["terminal-body"]}>
        {activeSession ? (
          <TerminalView key={activeSession.id} session={activeSession.session} expanded={!panelsVisible} focusRequestKey={focusRequestKey} />
        ) : (
          <div className={styles["terminal-loading"]}>Loading terminal...</div>
        )}
      </div>
    </div>
  );
}
