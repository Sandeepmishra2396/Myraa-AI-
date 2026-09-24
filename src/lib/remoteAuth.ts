import { StoredRemoteSession, STORAGE_KEY } from "../components/remote/CloudPairingModal";

export type { StoredRemoteSession };
export { STORAGE_KEY };

export interface RefreshResult {
  success: boolean;
  session?: StoredRemoteSession;
  error?: string;
}

/**
 * Attempts to refresh the remote session access token using the rotating refresh token
 * and/or durable device token. Updates localStorage on success.
 */
export async function refreshRemoteSession(
  session: StoredRemoteSession,
  onUpdate?: (updated: StoredRemoteSession) => void,
): Promise<RefreshResult> {
  if (!session.refreshToken && !session.token) {
    return { success: false, error: "No refresh token or device token available." };
  }

  try {
    const res = await fetch("/api/remote/token/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        refreshToken: session.refreshToken,
        deviceToken: session.token,
      }),
    });

    const data = await res.json();
    if (!res.ok) {
      return { success: false, error: data.error || `Refresh failed with HTTP ${res.status}` };
    }

    const updated: StoredRemoteSession = {
      ...session,
      accessToken: data.accessToken,
      refreshToken: data.refreshToken || session.refreshToken,
    };

    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
    } catch {
      /* ignore storage quota/security errors */
    }

    onUpdate?.(updated);
    return { success: true, session: updated };
  } catch (err: any) {
    return { success: false, error: err.message || "Network error refreshing session." };
  }
}

/**
 * Execute an authenticated fetch for remote companion endpoints.
 * Automatically handles token expiry (401 / TOKEN_EXPIRED) by transparently
 * refreshing the access token and retrying the request.
 */
export async function authenticatedRemoteFetch(
  url: string,
  options: RequestInit = {},
  session: StoredRemoteSession,
  onUpdate?: (updated: StoredRemoteSession) => void,
): Promise<{ response: Response; updatedSession?: StoredRemoteSession }> {
  // Determine primary token to use
  let currentToken = session.accessToken || session.token;
  let currentSession = { ...session };

  const buildHeaders = (tok: string): HeadersInit => {
    const baseHeaders: Record<string, string> = {
      Authorization: `Bearer ${tok}`,
    };
    if (options.body && !(options.headers as any)?.["Content-Type"]) {
      baseHeaders["Content-Type"] = "application/json";
    }
    return { ...baseHeaders, ...(options.headers as Record<string, string>) };
  };

  // 1. Initial attempt
  let res = await fetch(url, {
    ...options,
    headers: buildHeaders(currentToken),
  });

  // 2. If 401 Unauthorized, attempt refresh if we have a refresh token or device token
  if (res.status === 401 && (currentSession.refreshToken || currentSession.token)) {
    // If we used accessToken and it failed, try refreshing first
    const refreshResult = await refreshRemoteSession(currentSession, onUpdate);
    if (refreshResult.success && refreshResult.session?.accessToken) {
      currentSession = refreshResult.session;
      currentToken = refreshResult.session.accessToken;
      // Retry with fresh access token
      res = await fetch(url, {
        ...options,
        headers: buildHeaders(currentToken),
      });
      return { response: res, updatedSession: currentSession };
    }

    // If refresh failed but we have a durable device token that wasn't used yet
    if (currentSession.token && currentToken !== currentSession.token) {
      currentToken = currentSession.token;
      res = await fetch(url, {
        ...options,
        headers: buildHeaders(currentToken),
      });
      return { response: res, updatedSession: currentSession };
    }
  }

  return { response: res };
}

/**
 * Safely parse JSON payload from a signed token (works in both Browser and Node.js).
 */
export function parseTokenPayload(token: string): Record<string, any> | null {
  try {
    const dotIdx = token.indexOf(".");
    if (dotIdx === -1) return null;
    const rawPayload = token.slice(token.startsWith("myraa_at_") ? "myraa_at_".length : 0, dotIdx);
    let b64 = rawPayload.replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4 !== 0) {
      b64 += "=";
    }
    const jsonStr = typeof atob === "function"
      ? atob(b64)
      : Buffer.from(b64, "base64").toString("utf-8");
    return JSON.parse(jsonStr);
  } catch {
    return null;
  }
}

/**
 * Resolves a valid access token or durable device token for remote WebSocket connection.
 * If the current access token is missing, expired, or expiring soon (< 30s), attempts an automatic refresh.
 */
export async function getValidRemoteWsToken(
  onUpdate?: (updated: StoredRemoteSession) => void,
): Promise<string | null> {
  if (typeof localStorage === "undefined") return null;
  let sess: StoredRemoteSession | null = null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) sess = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!sess) return null;

  // Check if accessToken is valid and not expired
  if (sess.accessToken && sess.accessToken.startsWith("myraa_at_")) {
    const payload = parseTokenPayload(sess.accessToken);
    const nowSec = Math.floor(Date.now() / 1000);
    if (payload?.exp && payload.exp > nowSec + 30) {
      return sess.accessToken;
    }
  }

  // Token is expired, expiring, or missing -> attempt refresh
  if (sess.refreshToken || sess.token) {
    const refreshRes = await refreshRemoteSession(sess, onUpdate);
    if (refreshRes.success && refreshRes.session?.accessToken) {
      return refreshRes.session.accessToken;
    }
  }

  // Fallback to durable device token or whatever token is stored
  return sess.accessToken || sess.token || null;
}
