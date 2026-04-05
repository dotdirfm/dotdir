import { panelsVisibleAtom, terminalFocusRequestKeyAtom } from "@/atoms";
import { Tabs, type TabsItem } from "@/components/Tabs/Tabs";
import { TerminalView } from "@/features/terminal/TerminalView";
import { useTerminal } from "@/features/terminal/useTerminal";
import styles from "@/styles/terminal.module.css";
import { cx } from "@/utils/cssModules";
import { useAtomValue } from "jotai";
import { useMemo } from "react";
import { VscAdd } from "react-icons/vsc";

export function TerminalToolbar() {
  const { sessions, activeSessionId, activeSession, activate, createSession, closeSession, switchActiveProfile, profiles, profilesLoaded } = useTerminal();
  const activeProfileId = activeSession?.profileId ?? null;
  const activeProfileShell = activeSession ? (profiles.find((p) => p.id === activeSession.profileId)?.shell ?? null) : null;
  const activeError = activeSession?.error ?? null;
  const tabItems = useMemo<Array<TabsItem & { status: string }>>(
    () =>
      sessions.map((session) => ({
        id: session.id,
        label: session.profileLabel,
        status: session.status,
      })),
    [sessions],
  );

  return (
    <div className={styles["terminal-toolbar"]}>
      <Tabs
        items={tabItems}
        activeItemId={activeSessionId ?? ""}
        onSelectItem={activate}
        onCloseItem={sessions.length > 1 ? closeSession : undefined}
        renderItemContent={(item) => (
          <>
            <span className={cx(styles, "terminal-tab-status", `status-${item.status}`)} />
            <span className={styles["terminal-tab-label"]}>{item.label}</span>
          </>
        )}
        rightSlot={
          <button
            type="button"
            tabIndex={-1}
            className={styles["terminal-tab-add"]}
            onClick={() => createSession(activeProfileId ?? profiles[0]?.id)}
            aria-label="New terminal session"
            title="New terminal session"
          >
            <VscAdd aria-hidden className={styles["terminal-tab-add-icon"]} />
          </button>
        }
        variant="terminal"
      />
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
