import { StoredRemoteSession, STORAGE_KEY } from "../components/remote/CloudPairingModal";

export type { StoredRemoteSession };
export { STORAGE_KEY };

/**
 * Proactive safety window (in seconds) before access-token expiration.
 * Any access token expiring within 90 seconds (inside the 60–120s safety window)
 * is refreshed proactively before opening a WebSocket or firing an API call.
 */
export const ACCESS_TOKEN_SAFETY_WINDOW_SEC = 90;

export interface RefreshResult {
  success: boolean;
  session?: StoredRemoteSession;
  error?: string;
}

export interface TokenExpiryMetadata {
  expiresAtSec: number | null;
  expiresAtIso: string | null;
  expiresInSec: number | null;
  isExpired: boolean;
  isExpiringSoon: boolean;
}

/**
 * Single shared in-flight refresh promise.
 * Prevents concurrent callers (e.g. App.tsx session check + MyraAudioSession WS connect +
 * multimodal polling) from sending duplicate refresh requests with the same rotating
 * refreshToken, which would otherwise trigger server-side TOKEN_REPLAY_DETECTED lockdown.
 */
let _inflightRefreshPromise: Promise<RefreshResult> | null = null;

export function resetRemoteAuthForTesting(): void {
  _inflightRefreshPromise = null;
}

export function hasInflightRefresh(): boolean {
  return _inflightRefreshPromise !== null;
}

/**
 * Safely parse JSON payload from a signed token (works in both Browser and Node.js).
 */
export function parseTokenPayload(token: string): Record<string, any> | null {
  try {
    if (!token || typeof token !== "string") return null;
    const dotIdx = token.indexOf(".");
    if (dotIdx === -1) return null;
    const rawPayload = token.slice(token.startsWith("myraa_at_") ? "myraa_at_".length : 0, dotIdx);
    let b64 = rawPayload.replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4 !== 0) {
      b64 += "=";
    }
    const jsonStr =
      typeof atob === "function"
        ? atob(b64)
        : Buffer.from(b64, "base64").toString("utf-8");
    return JSON.parse(jsonStr);
  } catch {
    return null;
  }
}

/**
 * Inspects access token expiration metadata without ever exposing or logging the raw token.
 */
export function getAccessTokenExpiryInfo(
  tokenOrSession?: string | StoredRemoteSession | null,
  safetyWindowSec: number = ACCESS_TOKEN_SAFETY_WINDOW_SEC,
): TokenExpiryMetadata {
  let token: string | undefined | null = null;
  if (typeof tokenOrSession === "string") {
    token = tokenOrSession;
  } else if (tokenOrSession && typeof tokenOrSession === "object") {
    token = tokenOrSession.accessToken;
  } else if (typeof localStorage !== "undefined") {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        token = parsed?.accessToken;
      }
    } catch {
      token = null;
    }
  }

  if (!token || typeof token !== "string" || !token.startsWith("myraa_at_")) {
    return {
      expiresAtSec: null,
      expiresAtIso: null,
      expiresInSec: null,
      isExpired: true,
      isExpiringSoon: true,
    };
  }
  const payload = parseTokenPayload(token);
  if (!payload || typeof payload.exp !== "number") {
    return {
      expiresAtSec: null,
      expiresAtIso: null,
      expiresInSec: null,
      isExpired: true,
      isExpiringSoon: true,
    };
  }
  const nowSec = Math.floor(Date.now() / 1000);
  const expiresInSec = payload.exp - nowSec;
  return {
    expiresAtSec: payload.exp,
    expiresAtIso: new Date(payload.exp * 1000).toISOString(),
    expiresInSec,
    isExpired: expiresInSec <= 0,
    isExpiringSoon: expiresInSec <= safetyWindowSec,
  };
}

/**
 * Attempts to refresh the remote session access token using the rotating refresh token
 * and/or durable device token. Deduplicates concurrent refresh attempts via a single
 * shared in-flight promise and updates localStorage on success.
 */
export async function refreshRemoteSession(
  session: StoredRemoteSession,
  onUpdate?: (updated: StoredRemoteSession) => void,
): Promise<RefreshResult> {
  // Always read latest stored session if available so we never send a stale rotated refreshToken
  let latestSession = session;
  if (typeof localStorage !== "undefined") {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as StoredRemoteSession;
        if (parsed && (parsed.refreshToken || parsed.token)) {
          latestSession = { ...session, ...parsed };
        }
      }
    } catch {
      /* ignore */
    }
  }

  if (!latestSession.refreshToken && !latestSession.token) {
    return { success: false, error: "No refresh token or device token available." };
  }

  // If a refresh is already in-flight, share its result instead of issuing a second rotation request
  if (_inflightRefreshPromise) {
    const sharedResult = await _inflightRefreshPromise;
    if (sharedResult.success && sharedResult.session) {
      onUpdate?.(sharedResult.session);
    }
    return sharedResult;
  }

  const performRefresh = async (): Promise<RefreshResult> => {
    try {
      const res = await fetch("/api/remote/token/refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          refreshToken: latestSession.refreshToken,
          deviceToken: latestSession.token,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        return { success: false, error: data.error || `Refresh failed with HTTP ${res.status}` };
      }

      const updated: StoredRemoteSession = {
        ...latestSession,
        accessToken: data.accessToken,
        refreshToken: data.refreshToken || latestSession.refreshToken,
      };

      if (typeof localStorage !== "undefined") {
        try {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
        } catch {
          /* ignore storage quota/security errors */
        }
      }

      return { success: true, session: updated };
    } catch (err: any) {
      return { success: false, error: err?.message || "Network error refreshing session." };
    }
  };

  _inflightRefreshPromise = performRefresh();
  try {
    const result = await _inflightRefreshPromise;
    if (result.success && result.session) {
      onUpdate?.(result.session);
    }
    return result;
  } finally {
    _inflightRefreshPromise = null;
  }
}

/**
 * Execute an authenticated fetch for remote companion endpoints.
 * Proactively refreshes expiring access tokens before sending, and automatically
 * handles 401 / TOKEN_EXPIRED by refreshing and falling back to the durable device token.
 */
export async function authenticatedRemoteFetch(
  url: string,
  options: RequestInit = {},
  session: StoredRemoteSession,
  onUpdate?: (updated: StoredRemoteSession) => void,
): Promise<{ response: Response; updatedSession?: StoredRemoteSession }> {
  let currentSession = { ...session };

  // Proactively check if accessToken is expired or expiring within safety window
  if (currentSession.accessToken && currentSession.accessToken.startsWith("myraa_at_")) {
    const expiry = getAccessTokenExpiryInfo(currentSession.accessToken, ACCESS_TOKEN_SAFETY_WINDOW_SEC);
    if (expiry.isExpiringSoon && (currentSession.refreshToken || currentSession.token)) {
      const proactiveRefresh = await refreshRemoteSession(currentSession, onUpdate);
      if (proactiveRefresh.success && proactiveRefresh.session) {
        currentSession = proactiveRefresh.session;
      } else if (expiry.isExpired) {
        // Never use an expired accessToken if proactive refresh failed; fall back to durable device token
        currentSession = { ...currentSession, accessToken: undefined };
      }
    }
  }

  let currentToken = currentSession.accessToken || currentSession.token;

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
    const refreshResult = await refreshRemoteSession(currentSession, onUpdate);
    if (refreshResult.success && refreshResult.session?.accessToken) {
      currentSession = refreshResult.session;
      currentToken = refreshResult.session.accessToken;
      res = await fetch(url, {
        ...options,
        headers: buildHeaders(currentToken),
      });
      return { response: res, updatedSession: currentSession };
    }

    // If refresh failed, fall back to durable device token (sora_dev_...) if available
    if (currentSession.token && currentToken !== currentSession.token) {
      currentToken = currentSession.token;
      res = await fetch(url, {
        ...options,
        headers: buildHeaders(currentToken),
      });
      return { response: res, updatedSession: currentSession };
    }
  }

  return { response: res, updatedSession: currentSession };
}

export interface GetValidWsTokenOptions {
  forceRefresh?: boolean;
  safetyWindowSec?: number;
}

/**
 * Resolves a valid access token or durable device token for remote WebSocket connection.
 * - Proactively refreshes when the current access token is missing, expired, or within
 *   the 90-second safety window (or when forceRefresh=true after a 1006 handshake failure).
 * - NEVER returns an expired accessToken when a durable device token (sora_dev_...) is available.
 */
export async function getValidRemoteWsToken(
  onUpdate?: (updated: StoredRemoteSession) => void,
  options?: GetValidWsTokenOptions,
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

  const safetyWindowSec = options?.safetyWindowSec ?? ACCESS_TOKEN_SAFETY_WINDOW_SEC;
  const forceRefresh = Boolean(options?.forceRefresh);

  // 1. Check if accessToken is present, valid, and outside the proactive expiry window
  const expiryInfo = getAccessTokenExpiryInfo(sess.accessToken, safetyWindowSec);
  if (!forceRefresh && sess.accessToken && !expiryInfo.isExpiringSoon) {
    return sess.accessToken;
  }

  // 2. Token is expired, expiring soon, missing, or forceRefresh was requested -> refresh
  if (sess.refreshToken || sess.token) {
    const refreshRes = await refreshRemoteSession(sess, onUpdate);
    if (refreshRes.success && refreshRes.session?.accessToken) {
      return refreshRes.session.accessToken;
    }
  }

  // 3. Refresh failed (e.g. Render instance still waking up or network glitch):
  //    - If the accessToken is NOT actually expired yet and forceRefresh wasn't set, we can still use it.
  //    - If the accessToken IS expired (or forceRefresh was requested after a 1006 rejection),
  //      NEVER return the expired accessToken; return the durable device token (sora_dev_...) instead!
  if (!forceRefresh && sess.accessToken && !expiryInfo.isExpired) {
    return sess.accessToken;
  }

  if (sess.token && sess.token.startsWith("sora_dev_")) {
    return sess.token;
  }

  return null;
}
