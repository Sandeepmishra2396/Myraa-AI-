/**
 * MYRAA — SecurityMonitor (Phase 10C)
 *
 * Deterministic Intrusion Detection System (IDS) & Anomaly Monitor:
 *   • Continuous stream-based security monitoring.
 *   • Sliding-window event correlation across IP addresses, sessions, and devices.
 *   • Configurable, deterministic threshold detection for:
 *     - Brute-force authentication bursts
 *     - Token replay and reuse attacks
 *     - Permission escalation and probing bursts
 *     - Path traversal and unauthorized filesystem escape campaigns
 *     - Adversarial prompt-injection campaigns
 *     - Malicious command execution attempts
 *     - Unknown device anomalies
 *     - Sensitive data exfiltration spikes
 *   • Zero-leakage: Threat reports contain only sanitized, non-executable metadata.
 *   • Loop-prevention: Internal alerts never loop back into the monitor.
 */

import type {
  NormalizedSecurityEvent,
  MonitoringEventType,
  RiskLevel,
  SecurityMonitorThresholds,
  ThreatReport,
  AlertAction,
} from "./SecurityTypes.ts";
import { DEFAULT_MONITOR_THRESHOLDS } from "./SecurityTypes.ts";
import { securityEventStream } from "./SecurityEventStream.ts";

export class SecurityMonitor {
  private _thresholds: SecurityMonitorThresholds = { ...DEFAULT_MONITOR_THRESHOLDS };
  private _ipEvents = new Map<string, NormalizedSecurityEvent[]>();
  private _sessionEvents = new Map<string, NormalizedSecurityEvent[]>();
  private _deviceEvents = new Map<string, NormalizedSecurityEvent[]>();
  private _threatListeners: Array<(threat: ThreatReport) => void> = [];
  private _detectedThreats: ThreatReport[] = [];
  private _unsubscribeStream?: () => void;

  constructor() {
    this._attachStream();
  }

  /**
   * Reset monitor state for testing.
   */
  resetForTesting(): void {
    this._thresholds = { ...DEFAULT_MONITOR_THRESHOLDS };
    this._ipEvents.clear();
    this._sessionEvents.clear();
    this._deviceEvents.clear();
    this._detectedThreats = [];
    this._threatListeners = [];
    if (this._unsubscribeStream) {
      this._unsubscribeStream();
    }
    this._attachStream();
  }

  private _attachStream(): void {
    this._unsubscribeStream = securityEventStream.onEvent((event) => {
      this.evaluateEvent(event);
    });
  }

  /**
   * Threshold configuration getters/setters.
   */
  getThresholds(): SecurityMonitorThresholds {
    return { ...this._thresholds };
  }

  setThresholds(custom: Partial<SecurityMonitorThresholds>): void {
    this._thresholds = { ...this._thresholds, ...custom };
  }

  /**
   * Register a listener for correlated threat reports.
   */
  onThreatDetected(listener: (threat: ThreatReport) => void): () => void {
    this._threatListeners.push(listener);
    return () => {
      this._threatListeners = this._threatListeners.filter((l) => l !== listener);
    };
  }

  /**
   * Evaluates an incoming normalized security event against correlation windows.
   */
  evaluateEvent(event: NormalizedSecurityEvent): ThreatReport | null {
    // ── Loop-Prevention: Ignore internal alert notifications ──────────────────
    if (event.isAlertNotification || (event.eventType as string) === "SECURITY_ALERT_TRIGGERED") {
      return null;
    }

    const now = event.timestamp || Date.now();
    const ip = event.actor.ipAddress || "unknown";
    const sessionId = event.actor.sessionId;
    const deviceId = event.actor.deviceId;

    // Buffer into sliding windows
    this._recordInWindow(this._ipEvents, ip, event, 300_000, now);
    if (sessionId) {
      this._recordInWindow(this._sessionEvents, sessionId, event, 300_000, now);
    }
    if (deviceId) {
      this._recordInWindow(this._deviceEvents, deviceId, event, 300_000, now);
    }

    let threat: ThreatReport | null = null;

    // ── 1. Immediate Critical Threats ────────────────────────────────────────

    // A. Token Reuse / Replay Attack (Immediate CRITICAL)
    if (event.eventType === "TOKEN_REUSE") {
      threat = {
        threatName: "CREDENTIAL_REPLAY_ATTACK",
        severity: "CRITICAL",
        triggerEvent: "TOKEN_REUSE",
        occurrences: 1,
        windowMs: 0,
        actor: {
          identityId: event.actor.identityId,
          ipAddress: ip,
          sessionId,
          deviceId,
        },
        mitigationAction: "SESSION_REVOKED",
        recommendedAction: "Revoke compromised token family immediately and require full credential re-authentication.",
        reason: `Cryptographic token replay detected from IP ${ip}. Token family invalidated.`,
      };
    }

    // B. Destructive / Malicious Shell Command Attempt (Immediate CRITICAL)
    else if (event.eventType === "COMMAND_BLOCKED" && event.severity === "CRITICAL") {
      threat = {
        threatName: "MALICIOUS_COMMAND_EXECUTION_ATTEMPT",
        severity: "CRITICAL",
        triggerEvent: "COMMAND_BLOCKED",
        occurrences: 1,
        windowMs: 0,
        actor: {
          identityId: event.actor.identityId,
          ipAddress: ip,
          sessionId,
          deviceId,
        },
        mitigationAction: "COMMAND_TERMINATED",
        recommendedAction: "Inspect actor command history and verify active session authorization.",
        reason: `Destructive shell command execution was blocked for ${event.actor.identityId} (${event.summary}).`,
      };
    }

    // ── 2. Correlated Sliding-Window Burst Threats ───────────────────────────

    // C. Brute Force Authentication Burst (Threshold: >= failedLoginsThreshold within window)
    if (!threat && event.eventType === "LOGIN_FAILED") {
      const windowEvents = this._getEventsInWindow(
        this._ipEvents,
        ip,
        this._thresholds.failedLoginsWindowMs,
        now,
      );
      const loginFailures = windowEvents.filter((e) => e.eventType === "LOGIN_FAILED");

      if (loginFailures.length >= this._thresholds.failedLoginsThreshold) {
        threat = {
          threatName: "BRUTE_FORCE_BURST",
          severity: "CRITICAL",
          triggerEvent: "LOGIN_FAILED",
          occurrences: loginFailures.length,
          windowMs: this._thresholds.failedLoginsWindowMs,
          actor: {
            identityId: event.actor.identityId,
            ipAddress: ip,
            sessionId,
            deviceId,
          },
          mitigationAction: "DEVICE_QUARANTINED",
          recommendedAction: "Enforce IP address lockout and trigger progressive step-up re-authentication.",
          reason: `Detected ${loginFailures.length} failed login attempts from IP ${ip} within ${Math.round(this._thresholds.failedLoginsWindowMs / 1000)}s.`,
        };
      }
    }

    // D. Path Traversal Attack Campaign (Threshold: >= pathTraversalThreshold within window)
    if (!threat && event.eventType === "PATH_TRAVERSAL_ATTEMPT") {
      const windowEvents = this._getEventsInWindow(
        this._ipEvents,
        ip,
        this._thresholds.pathTraversalWindowMs,
        now,
      );
      const traversalAttempts = windowEvents.filter((e) => e.eventType === "PATH_TRAVERSAL_ATTEMPT");

      if (traversalAttempts.length >= this._thresholds.pathTraversalThreshold) {
        threat = {
          threatName: "DIRECTORY_TRAVERSAL_CAMPAIGN",
          severity: "CRITICAL",
          triggerEvent: "PATH_TRAVERSAL_ATTEMPT",
          occurrences: traversalAttempts.length,
          windowMs: this._thresholds.pathTraversalWindowMs,
          actor: {
            identityId: event.actor.identityId,
            ipAddress: ip,
            sessionId,
            deviceId,
          },
          mitigationAction: "LOCKDOWN_INITIATED",
          recommendedAction: "Audit workspace target paths and verify client application integrity.",
          reason: `Repeated directory traversal (..) attempts detected from ${event.actor.identityId} (${traversalAttempts.length} attempts).`,
        };
      }
    }

    // E. Adversarial Prompt-Injection Campaign (Threshold: >= promptInjectionThreshold within window)
    if (!threat && event.eventType === "PROMPT_INJECTION_DETECTED") {
      const windowEvents = this._getEventsInWindow(
        this._ipEvents,
        ip,
        this._thresholds.promptInjectionWindowMs,
        now,
      );
      const injectionAttempts = windowEvents.filter((e) => e.eventType === "PROMPT_INJECTION_DETECTED");

      if (injectionAttempts.length >= this._thresholds.promptInjectionThreshold) {
        threat = {
          threatName: "ADVERSARIAL_INJECTION_CAMPAIGN",
          severity: "CRITICAL",
          triggerEvent: "PROMPT_INJECTION_DETECTED",
          occurrences: injectionAttempts.length,
          windowMs: this._thresholds.promptInjectionWindowMs,
          actor: {
            identityId: event.actor.identityId,
            ipAddress: ip,
            sessionId,
            deviceId,
          },
          mitigationAction: "ALERT_ONLY",
          recommendedAction: "Review external data sources and quarantine hostile documents or web URLs.",
          reason: `Multiple prompt injection attempts (${injectionAttempts.length}) detected from external input sources.`,
        };
      }
    }

    // F. Permission Escalation & Probing Burst (Threshold: >= permissionFailuresThreshold within window)
    if (!threat && (event.eventType === "MULTIPLE_PERMISSION_FAILURES" || event.summary?.includes("PERMISSION_DENIED"))) {
      const windowEvents = sessionId
        ? this._getEventsInWindow(this._sessionEvents, sessionId, this._thresholds.permissionFailuresWindowMs, now)
        : this._getEventsInWindow(this._ipEvents, ip, this._thresholds.permissionFailuresWindowMs, now);

      const permFailures = windowEvents.filter(
        (e) => e.eventType === "MULTIPLE_PERMISSION_FAILURES" || e.summary?.includes("PERMISSION_DENIED"),
      );

      if (permFailures.length >= this._thresholds.permissionFailuresThreshold) {
        threat = {
          threatName: "PERMISSION_PROBING_BURST",
          severity: "HIGH",
          triggerEvent: "MULTIPLE_PERMISSION_FAILURES",
          occurrences: permFailures.length,
          windowMs: this._thresholds.permissionFailuresWindowMs,
          actor: {
            identityId: event.actor.identityId,
            ipAddress: ip,
            sessionId,
            deviceId,
          },
          mitigationAction: "SESSION_REVOKED",
          recommendedAction: "Revoke caller session and re-verify role assignments.",
          reason: `Actor ${event.actor.identityId} repeatedly attempted unauthorized operations (${permFailures.length} unauthorized attempts).`,
        };
      }
    }

    // G. Unknown Device Connection Anomaly
    if (!threat && event.eventType === "UNKNOWN_DEVICE") {
      threat = {
        threatName: "UNAUTHORIZED_DEVICE_ACCESS",
        severity: "HIGH",
        triggerEvent: "UNKNOWN_DEVICE",
        occurrences: 1,
        windowMs: 0,
        actor: {
          identityId: event.actor.identityId,
          ipAddress: ip,
          sessionId,
          deviceId,
        },
        mitigationAction: "DEVICE_QUARANTINED",
        recommendedAction: "Verify physical device owner and check device pairing records.",
        reason: `Unpaired or unknown remote device ${deviceId || "unspecified"} attempted connection from ${ip}.`,
      };
    }

    // H. Insecure Network Probing Burst (Threshold: >= networkAnomalyThreshold within window)
    if (!threat && event.eventType === "UNUSUAL_NETWORK_REQUEST") {
      const windowEvents = this._getEventsInWindow(
        this._ipEvents,
        ip,
        this._thresholds.networkAnomalyWindowMs,
        now,
      );
      const networkAnomalies = windowEvents.filter((e) => e.eventType === "UNUSUAL_NETWORK_REQUEST");

      if (networkAnomalies.length >= this._thresholds.networkAnomalyThreshold) {
        threat = {
          threatName: "INSECURE_NETWORK_PROBING",
          severity: "HIGH",
          triggerEvent: "UNUSUAL_NETWORK_REQUEST",
          occurrences: networkAnomalies.length,
          windowMs: this._thresholds.networkAnomalyWindowMs,
          actor: {
            identityId: event.actor.identityId,
            ipAddress: ip,
            sessionId,
            deviceId,
          },
          mitigationAction: "DEVICE_QUARANTINED",
          recommendedAction: "Enforce TLS/HTTPS proxies and block unencrypted remote requests.",
          reason: `Repeated unencrypted remote connection attempts (${networkAnomalies.length}) rejected from IP ${ip}.`,
        };
      }
    }

    // I. Data Access Anomaly
    if (!threat && event.eventType === "DATA_ACCESS_ANOMALY" && event.severity === "CRITICAL") {
      threat = {
        threatName: "SENSITIVE_DATA_EXFILTRATION_RISK",
        severity: "HIGH",
        triggerEvent: "DATA_ACCESS_ANOMALY",
        occurrences: 1,
        windowMs: 0,
        actor: {
          identityId: event.actor.identityId,
          ipAddress: ip,
          sessionId,
          deviceId,
        },
        mitigationAction: "ALERT_ONLY",
        recommendedAction: "Review DLP redaction history and verify sensitive file access permissions.",
        reason: `Anomalous access pattern or potential data exfiltration attempt detected (${event.summary}).`,
      };
    }

    if (threat) {
      this._detectedThreats.push(threat);
      if (this._detectedThreats.length > 500) {
        this._detectedThreats.shift();
      }

      for (const listener of this._threatListeners) {
        try {
          listener(threat);
        } catch (err) {
          console.warn("[SecurityMonitor] Threat listener error:", err);
        }
      }
    }

    return threat;
  }

  getDetectedThreats(limit = 50): ThreatReport[] {
    return this._detectedThreats.slice(-limit);
  }

  // ---------------------------------------------------------------------------
  // Correlation Window Management Helpers
  // ---------------------------------------------------------------------------

  private _recordInWindow(
    map: Map<string, NormalizedSecurityEvent[]>,
    key: string,
    event: NormalizedSecurityEvent,
    maxRetentionMs: number,
    now: number,
  ): void {
    const list = map.get(key) || [];
    list.push(event);

    // Prune old events outside retention window
    const cutoff = now - maxRetentionMs;
    const pruned = list.filter((e) => e.timestamp >= cutoff);
    map.set(key, pruned);
  }

  private _getEventsInWindow(
    map: Map<string, NormalizedSecurityEvent[]>,
    key: string,
    windowMs: number,
    now: number,
  ): NormalizedSecurityEvent[] {
    const list = map.get(key) || [];
    const cutoff = now - windowMs;
    return list.filter((e) => e.timestamp >= cutoff);
  }
}

export const securityMonitor = new SecurityMonitor();
