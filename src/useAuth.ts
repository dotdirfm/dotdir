/// Loads persisted auth tokens on startup and keeps authUserAtom in sync.
/// Call once at the App root level (Tauri-only; no-ops in browser mode).
import { isTauri as isTauriApp } from "@tauri-apps/api/core";
import { useSetAtom } from "jotai";
import { useEffect } from "react";
import { authUserAtom } from "./atoms";
import { loadStoredTokens, refreshStoredTokens } from "./auth";

const TOKEN_REFRESH_MARGIN_S = 5 * 60; // refresh if expiring within 5 min

export function useAuth(): void {
  const setAuthUser = useSetAtom(authUserAtom);

  useEffect(() => {
    if (!isTauriApp()) return;
    void (async () => {
      const stored = await loadStoredTokens();
      if (!stored) return;

      if (stored.expiresAt < Math.floor(Date.now() / 1000) + TOKEN_REFRESH_MARGIN_S) {
        const refreshed = await refreshStoredTokens(stored.refreshToken);
        if (refreshed) {
          setAuthUser({
            sub: refreshed.userSub,
            name: refreshed.userName ?? undefined,
            email: refreshed.userEmail ?? undefined,
          });
        }
        // If refresh fails the user simply stays signed out.
        return;
      }

      setAuthUser({
        sub: stored.userSub,
        name: stored.userName ?? undefined,
        email: stored.userEmail ?? undefined,
      });
    })();
  }, [setAuthUser]);
}
