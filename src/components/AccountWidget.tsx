/// Compact sign-in / account indicator that lives in the status bar.
import { isTauri as isTauriApp } from "@tauri-apps/api/core";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { useCallback, useState } from "react";
import { authSigningInAtom, authUserAtom } from "../atoms";
import { clearStoredTokens, startSignIn } from "../auth";

export function AccountWidget() {
  // Not shown in headless/browser mode — auth is only for the desktop app.
  if (!isTauriApp()) return null;

  return <AccountWidgetInner />;
}

function AccountWidgetInner() {
  const [authUser, setAuthUser] = useAtom(authUserAtom);
  const setSigningIn = useSetAtom(authSigningInAtom);
  const signingIn = useAtomValue(authSigningInAtom);
  const [error, setError] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);

  const handleSignIn = useCallback(() => {
    setError("");
    startSignIn({
      onStart: () => setSigningIn(true),
      onEnd: () => setSigningIn(false),
      onSuccess: (user) => setAuthUser(user),
      onError: (msg) => setError(msg),
    });
  }, [setAuthUser, setSigningIn]);

  const handleSignOut = useCallback(async () => {
    setMenuOpen(false);
    await clearStoredTokens();
    setAuthUser(null);
  }, [setAuthUser]);

  if (signingIn) {
    return (
      <div className="account-widget account-widget--loading">
        <span className="account-widget-label">Signing in…</span>
      </div>
    );
  }

  if (authUser) {
    const display = authUser.name ?? authUser.email ?? authUser.sub;
    const initial = display[0]?.toUpperCase() ?? "?";
    return (
      <div className="account-widget account-widget--signed-in">
        <button
          className="account-widget-btn"
          onClick={() => setMenuOpen((v) => !v)}
          title={authUser.email ?? authUser.sub}
        >
          <span className="account-widget-avatar">{initial}</span>
          <span className="account-widget-label">{display}</span>
        </button>
        {menuOpen && (
          <>
            <div
              className="account-widget-backdrop"
              onClick={() => setMenuOpen(false)}
            />
            <div className="account-widget-menu">
              <div className="account-widget-menu-email">
                {authUser.email ?? authUser.sub}
              </div>
              <button
                className="account-widget-menu-item"
                onClick={handleSignOut}
              >
                Sign out
              </button>
            </div>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="account-widget">
      {error && (
        <span className="account-widget-error" title={error}>
          ! {error}
        </span>
      )}
      <button className="account-widget-btn" onClick={handleSignIn}>
        Sign in
      </button>
    </div>
  );
}
