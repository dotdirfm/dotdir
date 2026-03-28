/// OAuth 2.0 + PKCE sign-in flow for the desktop app.
///
/// The website (dotdir.dev) acts as the Authorization Server.
/// The app uses the custom URI scheme `dotdir://` as the redirect target so
/// the browser can hand control back after the user consents.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { AuthUser } from "./atoms";

const CLIENT_ID = "dotdir-desktop";
const REDIRECT_URI = "dotdir://auth/callback";
const DOTDIR_BASE = "https://dotdir.dev";

export interface StoredTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  userSub: string;
  userName: string | null;
  userEmail: string | null;
}

// ── PKCE helpers ─────────────────────────────────────────────────────

function generateCodeVerifier(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

async function generateCodeChallenge(verifier: string): Promise<string> {
  const data = new TextEncoder().encode(verifier);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

function generateState(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ── Token persistence (via Rust) ─────────────────────────────────────

export function loadStoredTokens(): Promise<StoredTokens | null> {
  return invoke<StoredTokens | null>("auth_load_tokens");
}

export function clearStoredTokens(): Promise<void> {
  return invoke("auth_clear_tokens");
}

// ── Network calls ─────────────────────────────────────────────────────

async function exchangeCode(
  code: string,
  codeVerifier: string,
): Promise<{ access_token: string; refresh_token: string; expires_in: number }> {
  const resp = await fetch(`${DOTDIR_BASE}/api/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: codeVerifier,
    }),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    let msg = `HTTP ${resp.status}`;
    try {
      const err = JSON.parse(body) as Record<string, unknown>;
      const detail = String(err.error_description ?? err.error ?? "");
      if (detail) msg += `: ${detail}`;
      else if (body) msg += `: ${body}`;
    } catch {
      if (body) msg += `: ${body}`;
    }
    throw new Error(msg);
  }
  return resp.json() as Promise<{ access_token: string; refresh_token: string; expires_in: number }>;
}

async function fetchUserInfo(accessToken: string): Promise<AuthUser> {
  const resp = await fetch(`${DOTDIR_BASE}/api/oauth/userinfo`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`Failed to fetch user info (HTTP ${resp.status})${body ? `: ${body}` : ""}`);
  }
  return resp.json() as Promise<AuthUser>;
}

export async function refreshStoredTokens(
  refreshToken: string,
): Promise<StoredTokens | null> {
  try {
    const resp = await fetch(`${DOTDIR_BASE}/api/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: CLIENT_ID,
        refresh_token: refreshToken,
      }),
    });
    if (!resp.ok) return null;
    const tokens = await resp.json() as { access_token: string; refresh_token: string; expires_in: number };
    const userInfo = await fetchUserInfo(tokens.access_token);
    const stored: StoredTokens = {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: Math.floor(Date.now() / 1000) + (tokens.expires_in ?? 3600),
      userSub: userInfo.sub,
      userName: userInfo.name ?? null,
      userEmail: userInfo.email ?? null,
    };
    await invoke("auth_store_tokens", { tokens: stored });
    return stored;
  } catch {
    return null;
  }
}

// ── Sign-in orchestration ─────────────────────────────────────────────

export function startSignIn(opts: {
  onSuccess: (user: AuthUser) => void;
  onError: (msg: string) => void;
  onStart: () => void;
  onEnd: () => void;
}): void {
  void (async () => {
    opts.onStart();

    const codeVerifier = generateCodeVerifier();
    const codeChallenge = await generateCodeChallenge(codeVerifier);
    const state = generateState();

    let unlisten: (() => void) | undefined;

    const timeoutId = setTimeout(() => {
      unlisten?.();
      opts.onEnd();
      opts.onError("Sign-in timed out. Please try again.");
    }, 5 * 60 * 1000);

    // Register callback listener BEFORE opening the browser to avoid any race.
    unlisten = await listen<string>("auth:callback", async (event) => {
      clearTimeout(timeoutId);
      unlisten?.();
      try {
        const url = new URL(event.payload);
        if (url.searchParams.get("state") !== state) {
          opts.onEnd();
          opts.onError("OAuth state mismatch. Please try again.");
          return;
        }
        const errorParam = url.searchParams.get("error");
        if (errorParam) {
          opts.onEnd();
          opts.onError(
            url.searchParams.get("error_description") ?? errorParam,
          );
          return;
        }
        const code = url.searchParams.get("code");
        if (!code) {
          opts.onEnd();
          opts.onError("No authorization code in callback.");
          return;
        }

        const tokens = await exchangeCode(code, codeVerifier);
        const userInfo = await fetchUserInfo(tokens.access_token);

        await invoke("auth_store_tokens", {
          tokens: {
            accessToken: tokens.access_token,
            refreshToken: tokens.refresh_token,
            expiresAt:
              Math.floor(Date.now() / 1000) + (tokens.expires_in ?? 3600),
            userSub: userInfo.sub,
            userName: userInfo.name ?? null,
            userEmail: userInfo.email ?? null,
          },
        });

        opts.onSuccess(userInfo);
        opts.onEnd();
      } catch (err) {
        opts.onEnd();
        opts.onError(err instanceof Error ? err.message : String(err));
      }
    });

    const params = new URLSearchParams({
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      response_type: "code",
      scope: "profile email",
      state,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
    });

    try {
      await openUrl(`${DOTDIR_BASE}/oauth/consent?${params}`);
    } catch (err) {
      clearTimeout(timeoutId);
      unlisten?.();
      opts.onEnd();
      opts.onError(err instanceof Error ? err.message : String(err));
    }
  })();
}
