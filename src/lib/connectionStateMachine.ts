/**
 * MYRAA — Canonical Connection State Machine & Reconnect Controller
 *
 * Shared across Cloud Web, Windows Desktop, and Android Companion clients.
 *
 * Responsibilities:
 *   1. Enforces canonical connection states:
 *      DISCONNECTED -> CONNECTING -> AUTHENTICATING -> CONNECTED ->
 *      RESTORING_SESSION -> STARTING_GEMINI -> READY
 *      (plus AUTH_EXPIRED, REFRESHING_AUTH, RECONNECTING, FAILED)
 *   2. Centralized Reconnect Controller:
 *      - Exponential backoff + bounded jitter
 *      - Single active WebSocket attempt at a time (generation-guarded)
 *      - Resets reconnect counter ONLY after stable READY state
 *      - Respects terminal security states (DEVICE_REVOKED, SECURITY_LOCKDOWN, EMERGENCY_STOP)
 *   3. Platform-aware WebSocket Heartbeat tracking (ping / pong timeout detection)
 *   4. Safe Diagnostic Logging (correlationId, hashed deviceId, zero secret leakage)
 */

export type CanonicalConnectionState =
  | "DISCONNECTED"
  | "CONNECTING"
  | "AUTHENTICATING"
  | "CONNECTED"
  | "AUTH_EXPIRED"
  | "REFRESHING_AUTH"
  | "RECONNECTING"
  | "RESTORING_SESSION"
  | "STARTING_GEMINI"
  | "READY"
  | "FAILED";

export type GeminiSessionState =
  | "IDLE"
  | "STARTING"
  | "STARTING_GEMINI"
  | "READY"
  | "RECREATING"
  | "DEGRADED"
  | "CLOSED"
  | "FAILED";

export type RemoteFailureClass =
  | "NONE"
  | "RENDER_SLEEP_OR_RESTART"
  | "AUTH_EXPIRED"
  | "REFRESH_EXPIRED"
  | "SESSION_NOT_FOUND"
  | "GEMINI_TRANSIENT_CLOSE"
  | "GEMINI_AUTH_FAILURE"
  | "HEARTBEAT_TIMEOUT"
  | "NETWORK_INTERRUPTION"
  | "DEVICE_REVOKED"
  | "SECURITY_LOCKDOWN"
  | "EMERGENCY_STOP"
  | "MAX_RECONNECTS_EXCEEDED";

export type AuthLifecycleState =
  | "unauthenticated"
  | "valid"
  | "expiring_soon"
  | "expired"
  | "refreshing"
  | "fallback_device_token"
  | "revoked";

export interface SafeDiagnosticMetadata {
  correlationId: string;
  deviceIdHash: string;
  sessionState: CanonicalConnectionState;
  authState: AuthLifecycleState;
  websocketState: "CLOSED" | "CONNECTING" | "OPEN" | "CLOSING";
  closeCode: number | null;
  closeReason: string;
  reconnectAttempt: number;
  accessTokenExpiresInSec: number | null;
  geminiState: GeminiSessionState;
  lastFailureClass: RemoteFailureClass;
  lastHeartbeat: string | null;
}

/**
 * Scrubs any token, API key, or secret material from diagnostic strings.
 * Guarantees zero secret leakage in browser console or server logs.
 */
export function sanitizeDiagnosticString(input: string | undefined | null): string {
  if (!input) return "";
  return String(input)
    .replace(/myraa_at_[A-Za-z0-9._-]+/g, "myraa_at_[REDACTED]")
    .replace(/myraa_rf_[A-Za-z0-9._-]+/g, "myraa_rf_[REDACTED]")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.myraa_rf_[A-Za-z0-9._-]+/gi, "[REDACTED_REFRESH_TOKEN]")
    .replace(/sora_dev_[A-Za-z0-9._-]+/g, "sora_dev_[REDACTED]")
    .replace(/AIza[0-9A-Za-z_-]{15,}/g, "AIzaSy...[REDACTED]")
    .replace(/AQ\.[0-9A-Za-z._-]{15,}/g, "AQ....[REDACTED]")
    .replace(/ya29\.[0-9A-Za-z._-]+/g, "ya29....[REDACTED]")
    .replace(/auth_tokens\/[0-9A-Za-z._/-]+/g, "auth_tokens/[REDACTED]")
    .replace(/Bearer\s+[A-Za-z0-9._/-]+/gi, "Bearer [REDACTED]");
}

/**
 * Deterministic, environment-agnostic non-reversible hash for deviceId logging.
 * Works identically in Browser and Node.js without exposing raw device identifiers.
 */
export function hashDeviceIdSafe(deviceId: string | undefined | null): string {
  if (!deviceId || typeof deviceId !== "string") return "anon";
  const clean = deviceId.trim();
  if (!clean) return "anon";
  // Dual 32-bit FNV-1a -> 16-char hex digest
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < clean.length; i++) {
    const c = clean.charCodeAt(i);
    h1 ^= c;
    h1 = Math.imul(h1, 0x01000193);
    h2 ^= c ^ (i & 0xff);
    h2 = Math.imul(h2, 0x811c9dc5);
  }
  const hex1 = (h1 >>> 0).toString(16).padStart(8, "0");
  const hex2 = (h2 >>> 0).toString(16).padStart(8, "0");
  return `dev_${(hex1 + hex2).slice(0, 12)}`;
}

/**
 * Generates a unique correlation ID for tracing a connection/reconnect lifecycle.
 */
export function createCorrelationId(prefix = "conn"): string {
  const rand = Math.random().toString(36).slice(2, 10);
  const ts = Date.now().toString(36);
  return `${prefix}_${ts}_${rand}`;
}

/**
 * Formats a structured, secret-safe diagnostic log object.
 */
export function formatSafeConnectionDiag(meta: Partial<SafeDiagnosticMetadata>): SafeDiagnosticMetadata {
  return {
    correlationId: meta.correlationId || createCorrelationId(),
    deviceIdHash: meta.deviceIdHash || "anon",
    sessionState: meta.sessionState || "DISCONNECTED",
    authState: meta.authState || "unauthenticated",
    websocketState: meta.websocketState || "CLOSED",
    closeCode: meta.closeCode ?? null,
    closeReason: sanitizeDiagnosticString(meta.closeReason || ""),
    reconnectAttempt: meta.reconnectAttempt ?? 0,
    accessTokenExpiresInSec: meta.accessTokenExpiresInSec ?? null,
    geminiState: meta.geminiState || "IDLE",
    lastFailureClass: meta.lastFailureClass || "NONE",
    lastHeartbeat: meta.lastHeartbeat ?? null,
  };
}

/**
 * Classify a WebSocket close event or error message into a canonical failure class.
 */
export function classifyDisconnectFailure(
  closeCode: number | null | undefined,
  rawReason: string | undefined | null,
  authExpired = false,
): { failureClass: RemoteFailureClass; isTerminalSecurityStop: boolean } {
  const reason = sanitizeDiagnosticString(rawReason);

  if (closeCode === 4401 || /DEVICE_REVOKED|Device revoked/i.test(reason)) {
    return { failureClass: "DEVICE_REVOKED", isTerminalSecurityStop: true };
  }
  if (closeCode === 4403 || /SECURITY_LOCKDOWN|423 Locked/i.test(reason)) {
    return { failureClass: "SECURITY_LOCKDOWN", isTerminalSecurityStop: true };
  }
  if (/EMERGENCY_STOP|503 Service Unavailable/i.test(reason)) {
    return { failureClass: "EMERGENCY_STOP", isTerminalSecurityStop: true };
  }
  if (/GEMINI_AUTH_FAILED|NO_SERVER_API_KEY|SERVER_API_KEY_PLACEHOLDER|NO_API_KEY|credential is invalid/i.test(reason)) {
    return { failureClass: "GEMINI_AUTH_FAILURE", isTerminalSecurityStop: true };
  }
  if (authExpired || /TOKEN_EXPIRED/i.test(reason)) {
    return { failureClass: "AUTH_EXPIRED", isTerminalSecurityStop: false };
  }
  if (/SESSION_NOT_FOUND/i.test(reason)) {
    return { failureClass: "SESSION_NOT_FOUND", isTerminalSecurityStop: false };
  }
  if (/HEARTBEAT_TIMEOUT|pong timeout/i.test(reason)) {
    return { failureClass: "HEARTBEAT_TIMEOUT", isTerminalSecurityStop: false };
  }
  if (closeCode === 1006 || closeCode === 1001 || closeCode === 1012 || closeCode === 1013) {
    return { failureClass: "RENDER_SLEEP_OR_RESTART", isTerminalSecurityStop: false };
  }
  if (closeCode === 1011 || /GEMINI_SESSION_CLOSED/i.test(reason)) {
    return { failureClass: "GEMINI_TRANSIENT_CLOSE", isTerminalSecurityStop: false };
  }
  return { failureClass: "NETWORK_INTERRUPTION", isTerminalSecurityStop: false };
}

export interface ReconnectControllerOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  jitterRatio?: number;
  platform?: "browser" | "desktop" | "android";
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
  onStateChange?: (state: CanonicalConnectionState, diag: SafeDiagnosticMetadata) => void;
  onHeartbeatTimeout?: () => void;
}

/**
 * Centralized Reconnect & Connection State Machine Controller.
 * Prevents duplicate sockets, overlapping reconnect timers, and premature backoff resets.
 */
export class RemoteReconnectController {
  private _state: CanonicalConnectionState = "DISCONNECTED";
  private _geminiState: GeminiSessionState = "IDLE";
  private _authState: AuthLifecycleState = "unauthenticated";
  private _lastFailureClass: RemoteFailureClass = "NONE";
  private _lastCloseCode: number | null = null;
  private _lastCloseReason = "";
  private _reconnectAttempt = 0;
  private _correlationId: string = createCorrelationId();
  private _deviceIdHash = "anon";
  private _lastHeartbeat: string | null = null;
  private _lastPongTimestamp = 0;
  private _accessTokenExpiresInSec: number | null = null;

  private _connectionGeneration = 0;
  private _reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private _heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private _isTerminalStop = false;
  private _isIntentionalClose = false;

  public readonly maxAttempts: number;
  public readonly baseDelayMs: number;
  public readonly maxDelayMs: number;
  public readonly jitterRatio: number;
  public readonly heartbeatIntervalMs: number;
  public readonly heartbeatTimeoutMs: number;

  private _onStateChange?: (state: CanonicalConnectionState, diag: SafeDiagnosticMetadata) => void;
  private _onHeartbeatTimeout?: () => void;

  constructor(options: ReconnectControllerOptions = {}) {
    const isMobile = options.platform === "android";
    this.maxAttempts = options.maxAttempts ?? 12;
    this.baseDelayMs = options.baseDelayMs ?? 1000;
    this.maxDelayMs = options.maxDelayMs ?? 30000;
    this.jitterRatio = options.jitterRatio ?? 0.2;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? (isMobile ? 30000 : 25000);
    this.heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? (isMobile ? 65000 : 55000);
    this._onStateChange = options.onStateChange;
    this._onHeartbeatTimeout = options.onHeartbeatTimeout;
  }

  public getState(): CanonicalConnectionState {
    return this._state;
  }

  public getGeminiState(): GeminiSessionState {
    return this._geminiState;
  }

  public getReconnectAttempt(): number {
    return this._reconnectAttempt;
  }

  public getCorrelationId(): string {
    return this._correlationId;
  }

  public getGeneration(): number {
    return this._connectionGeneration;
  }

  public isTerminalStopped(): boolean {
    return this._isTerminalStop;
  }

  public hasAttemptInFlight(): boolean {
    return this._state === "CONNECTING" || this._state === "AUTHENTICATING";
  }

  public setDeviceId(deviceId: string | undefined | null): void {
    this._deviceIdHash = hashDeviceIdSafe(deviceId);
  }

  public setAuthMetadata(authState: AuthLifecycleState, expiresInSec: number | null = null): void {
    this._authState = authState;
    this._accessTokenExpiresInSec = expiresInSec;
  }

  public setGeminiState(geminiState: GeminiSessionState): void {
    this._geminiState = geminiState;
    if ((geminiState === "STARTING_GEMINI" || geminiState === "STARTING") && this._state === "CONNECTED") {
      this.transitionTo("STARTING_GEMINI", "OPEN");
    } else if (geminiState === "READY") {
      this.markStableReady();
    }
  }

  public onSocketOpen(): void {
    this.transitionTo("CONNECTED", "OPEN");
  }

  public triggerTerminalSecurityStop(failureClass: RemoteFailureClass, reason: string): void {
    this._isTerminalStop = true;
    this._lastFailureClass = failureClass;
    this._lastCloseReason = sanitizeDiagnosticString(reason);
    this.cancelPendingReconnect();
    this.stopHeartbeat();
    this.transitionTo("FAILED", "CLOSED");
  }

  /**
   * Transitions the state machine and emits a safe diagnostic snapshot.
   */
  public transitionTo(
    nextState: CanonicalConnectionState,
    wsReadyState: "CLOSED" | "CONNECTING" | "OPEN" | "CLOSING" = "CLOSED",
  ): SafeDiagnosticMetadata {
    this._state = nextState;
    const diag = this.getDiagnostics(wsReadyState);
    this._onStateChange?.(nextState, diag);
    return diag;
  }

  /**
   * Begins a new connection attempt and increments the generation counter
   * so any stale socket callbacks from prior attempts are ignored.
   */
  public beginConnectAttempt(isReconnect = false): { generation: number; correlationId: string } {
    this.cancelPendingReconnect();
    this._isIntentionalClose = false;
    this._isTerminalStop = false;
    this._connectionGeneration += 1;
    if (!isReconnect) {
      this._correlationId = createCorrelationId();
    }
    this.transitionTo(isReconnect ? "RECONNECTING" : "CONNECTING", "CONNECTING");
    return {
      generation: this._connectionGeneration,
      correlationId: this._correlationId,
    };
  }

  /**
   * Verifies whether a callback belongs to the currently active socket generation.
   */
  public isCurrentGeneration(generation: number): boolean {
    return generation === this._connectionGeneration && !this._isIntentionalClose;
  }

  /**
   * Marks the connection as stably READY (authenticated + Gemini Live ready).
   * Resets the exponential backoff counter ONLY at this point.
   */
  public markStableReady(): void {
    this._reconnectAttempt = 0;
    this._lastFailureClass = "NONE";
    this._geminiState = "READY";
    this._lastPongTimestamp = Date.now();
    this._lastHeartbeat = new Date().toISOString();
    this.transitionTo("READY", "OPEN");
  }

  /**
   * Records a heartbeat pong or incoming traffic from the server.
   */
  public recordHeartbeat(): void {
    this._lastPongTimestamp = Date.now();
    this._lastHeartbeat = new Date().toISOString();
  }

  /**
   * Starts the periodic client-side ping and dead-socket timeout detector.
   */
  public startHeartbeat(sendPing: () => void): void {
    this.stopHeartbeat();
    this._lastPongTimestamp = Date.now();
    this._lastHeartbeat = new Date().toISOString();

    this._heartbeatInterval = setInterval(() => {
      const elapsed = Date.now() - this._lastPongTimestamp;
      if (elapsed > this.heartbeatTimeoutMs) {
        this._lastFailureClass = "HEARTBEAT_TIMEOUT";
        this._lastCloseReason = `Heartbeat timeout (${Math.round(elapsed / 1000)}s without server response)`;
        this.stopHeartbeat();
        this._onHeartbeatTimeout?.();
        return;
      }
      try {
        sendPing();
      } catch {
        /* ignore send errors; onclose will handle */
      }
    }, this.heartbeatIntervalMs);
  }

  public stopHeartbeat(): void {
    if (this._heartbeatInterval !== null) {
      clearInterval(this._heartbeatInterval);
      this._heartbeatInterval = null;
    }
  }

  /**
   * Computes exponential backoff with bounded jitter for a given 0-based attempt index.
   */
  public computeBackoffMs(attemptIndex = this._reconnectAttempt, deterministicJitter = false): number {
    const exp = Math.min(this.baseDelayMs * Math.pow(2, attemptIndex), this.maxDelayMs);
    if (deterministicJitter || this.jitterRatio <= 0) {
      return Math.round(exp);
    }
    const jitterWindow = exp * this.jitterRatio;
    const jitter = Math.random() * jitterWindow;
    return Math.min(Math.round(exp + jitter), this.maxDelayMs);
  }

  /**
   * Handles a socket close event and schedules a single deduplicated reconnect if eligible.
   */
  public scheduleReconnect(
    closeCode: number | null,
    rawReason: string,
    executeReconnect: (attempt: number, delayMs: number) => Promise<void> | void,
    options?: { authExpired?: boolean; deterministicJitter?: boolean },
  ): { scheduled: boolean; delayMs: number; attempt: number; failureClass: RemoteFailureClass } {
    this.stopHeartbeat();
    this._lastCloseCode = closeCode;
    this._lastCloseReason = sanitizeDiagnosticString(rawReason);

    if (this._isIntentionalClose) {
      this.transitionTo("DISCONNECTED", "CLOSED");
      return { scheduled: false, delayMs: 0, attempt: this._reconnectAttempt, failureClass: "NONE" };
    }

    const { failureClass, isTerminalSecurityStop } = classifyDisconnectFailure(
      closeCode,
      this._lastCloseReason,
      options?.authExpired,
    );
    this._lastFailureClass = failureClass;

    if (isTerminalSecurityStop) {
      this._isTerminalStop = true;
      this.cancelPendingReconnect();
      this.transitionTo("FAILED", "CLOSED");
      return { scheduled: false, delayMs: 0, attempt: this._reconnectAttempt, failureClass };
    }

    if (this._reconnectAttempt >= this.maxAttempts) {
      this._lastFailureClass = "MAX_RECONNECTS_EXCEEDED";
      this.cancelPendingReconnect();
      this.transitionTo("FAILED", "CLOSED");
      return {
        scheduled: false,
        delayMs: 0,
        attempt: this._reconnectAttempt,
        failureClass: "MAX_RECONNECTS_EXCEEDED",
      };
    }

    // Deduplicate: if a reconnect timer is already pending, cancel it before scheduling the new one
    this.cancelPendingReconnect();

    const delayMs = this.computeBackoffMs(this._reconnectAttempt, options?.deterministicJitter);
    this._reconnectAttempt += 1;
    const currentAttempt = this._reconnectAttempt;

    this.transitionTo("RECONNECTING", "CLOSED");

    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      if (this._isIntentionalClose || this._isTerminalStop) return;
      executeReconnect(currentAttempt, delayMs);
    }, delayMs);

    return {
      scheduled: true,
      delayMs,
      attempt: currentAttempt,
      failureClass,
    };
  }

  public cancelPendingReconnect(): void {
    if (this._reconnectTimer !== null) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
  }

  /**
   * Explicitly disconnects and stops all timers/reconnect loops.
   */
  public markIntentionalDisconnect(): void {
    this._isIntentionalClose = true;
    this._connectionGeneration += 1;
    this.cancelPendingReconnect();
    this.stopHeartbeat();
    this._reconnectAttempt = 0;
    this._geminiState = "CLOSED";
    this.transitionTo("DISCONNECTED", "CLOSED");
  }

  public getDiagnostics(
    wsReadyState: "CLOSED" | "CONNECTING" | "OPEN" | "CLOSING" = "CLOSED",
  ): SafeDiagnosticMetadata {
    return formatSafeConnectionDiag({
      correlationId: this._correlationId,
      deviceIdHash: this._deviceIdHash,
      sessionState: this._state,
      authState: this._authState,
      websocketState: wsReadyState,
      closeCode: this._lastCloseCode,
      closeReason: this._lastCloseReason,
      reconnectAttempt: this._reconnectAttempt,
      accessTokenExpiresInSec: this._accessTokenExpiresInSec,
      geminiState: this._geminiState,
      lastFailureClass: this._lastFailureClass,
      lastHeartbeat: this._lastHeartbeat,
    });
  }
}
