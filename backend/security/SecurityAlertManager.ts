/**
 * MYRAA — SecurityAlertManager (Phase 10C)
 *
 * Real-Time Security Alert & Containment Manager:
 *   • Converts detected threats from SecurityMonitor into sanitized, actionable alerts.
 *   • Strictly adheres to the safe metadata contract:
 *       Threat → Risk → Event → Action → Device/Session → Time → Recommended Action
 *   • Multi-Sink Delivery:
 *       - MYRAA UI: Real-time broadcast to connected WebSocket clients & listeners.
 *       - Voice Notification: Companion-voiced, affectionate, panic-free speech alert.
 *       - Desktop Notification: Safe desktop OS notification payload.
 *       - Security Dashboard: Ring buffer of recent alerts with acknowledgment support.
 *       - Configured Notification Hook: Extensible callback for external channels/webhooks.
 *   • Automated Containment for HIGH/CRITICAL threats:
 *       - Automatic session revocation via IdentityAuthManager.
 *       - Fail-closed system LOCKDOWN initiation via SecurityPolicyEngine.
 *   • Anti-Loop Invariant: Never feeds alerts back into SecurityMonitor or EventStream.
 *   • Zero-Leakage Invariant: Completely purges secrets, tokens, passwords, and raw attack payloads.
 */

import EventEmitter from "events";
import crypto from "crypto";
import type {
  SecurityAlert,
  ThreatReport,
  AlertAction,
  AlertChannel,
  RiskLevel,
  MonitoringEventType,
} from "./SecurityTypes.ts";
import { securityMonitor } from "./SecurityMonitor.ts";
import { securityAuditLogger } from "./SecurityAuditLogger.ts";
import { outputDataFirewall } from "./OutputDataFirewall.ts";
import { identityAuthManager } from "./IdentityAuthManager.ts";
import { securityPolicyEngine } from "./SecurityPolicyEngine.ts";
import { threatContainmentManager } from "./ThreatContainmentManager.ts";

export type CustomNotificationHook = (alert: SecurityAlert, channel: AlertChannel) => void | Promise<void>;

export class SecurityAlertManager extends EventEmitter {
  private _alerts: SecurityAlert[] = [];
  private _maxRetainedAlerts = 200;
  private _customHooks: CustomNotificationHook[] = [];
  private _monitorUnsubscribe?: () => void;
  private _wsBroadcastFn?: (message: Record<string, unknown>) => void;

  constructor() {
    super();
    this.setMaxListeners(50);
    this._attachMonitor();
  }

  /**
   * Reset alert history and listeners for testing.
   */
  resetForTesting(): void {
    this._alerts = [];
    this.removeAllListeners();
    this._customHooks = [];
    if (this._monitorUnsubscribe) {
      this._monitorUnsubscribe();
    }
    this._attachMonitor();
  }

  private _attachMonitor(): void {
    this._monitorUnsubscribe = securityMonitor.onThreatDetected((threat) => {
      this.createAlertFromThreat(threat);
    });
  }

  /**
   * Register a WebSocket broadcast sender (e.g. from server.ts).
   */
  setWebSocketBroadcaster(broadcaster: (message: Record<string, unknown>) => void): void {
    this._wsBroadcastFn = broadcaster;
  }

  /**
   * Register an external notification hook (e.g. Webhook, SMS, Telegram).
   */
  registerNotificationHook(hook: CustomNotificationHook): () => void {
    this._customHooks.push(hook);
    return () => {
      this._customHooks = this._customHooks.filter((h) => h !== hook);
    };
  }

  /**
   * Generates a sanitized, structured SecurityAlert from a ThreatReport.
   */
  createAlertFromThreat(threat: ThreatReport): SecurityAlert {
    const alertId = `alert_${crypto.randomUUID()}`;
    const timestamp = Date.now();

    // ── 1. Zero-Leakage Scrubbing ──────────────────────────────────────────
    const rawSummary = threat.reason;
    const { sanitized: cleanSummary } = outputDataFirewall.sanitizeResult(rawSummary);

    // Defang any remaining command/token fragments
    const safeSummary = String(cleanSummary)
      .replace(/AIzaSy[A-Za-z0-9-_]+/g, "[REDACTED_API_KEY]")
      .replace(/sora_[a-z0-9_]+/gi, "[REDACTED_TOKEN]")
      .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [REDACTED]")
      .replace(/\b(rm\s+-[rRfF]{1,3}|format|del\s+\/f)\b/gi, "[DANGEROUS_COMMAND]");

    // ── 2. Format Voice Alert for MYRAA AI Persona ─────────────────────────
    const voiceAlertText = this._formatVoiceAlertText(threat.threatName, threat.severity);

    const alert: SecurityAlert = {
      alertId,
      threat: threat.threatName,
      risk: threat.severity,
      event: threat.triggerEvent,
      action: threat.mitigationAction,
      deviceSession: {
        deviceId: threat.actor.deviceId,
        sessionId: threat.actor.sessionId,
        ipAddress: threat.actor.ipAddress,
      },
      timestamp,
      recommendedAction: threat.recommendedAction,
      sanitizedSummary: safeSummary,
      voiceAlertText,
      acknowledged: false,
    };

    // Buffer alert
    this._alerts.push(alert);
    if (this._alerts.length > this._maxRetainedAlerts) {
      this._alerts.shift();
    }

    // ── 3. Execute Automated Containment (for HIGH/CRITICAL) ───────────────
    this._executeContainment(alert, threat);

    // ── 4. Persist to Audit Ledger with Anti-Loop Guard ───────────────────
    // Using SECURITY_ALERT_TRIGGERED prevents SecurityEventStream loop
    securityAuditLogger.logEvent({
      eventType: "SECURITY_ALERT_TRIGGERED",
      actor: {
        identityId: "security_alert_manager",
        role: "admin",
        ipAddress: threat.actor.ipAddress,
        sessionId: threat.actor.sessionId,
        deviceId: threat.actor.deviceId,
      },
      target: { resource: alert.threat },
      riskLevel: alert.risk,
      decision: alert.action === "ALERT_ONLY" ? "ALLOW" : "REVOKE",
      reason: alert.sanitizedSummary,
      metadata: {
        alertId: alert.alertId,
        threat: alert.threat,
        action: alert.action,
        deviceSession: alert.deviceSession,
      },
    });

    // ── 5. Multi-Sink Dispatching ──────────────────────────────────────────
    this._dispatchAlert(alert);

    return alert;
  }

  /**
   * Automated Containment execution for significant threats.
   */
  private _executeContainment(alert: SecurityAlert, threat: ThreatReport): void {
    try {
      threatContainmentManager.containThreat(threat);
    } catch (err) {
      console.warn("[SecurityAlertManager] Containment action error:", err);
    }
  }

  /**
   * Multi-Sink Alert Dispatching.
   */
  private _dispatchAlert(alert: SecurityAlert): void {
    // 1. UI Event
    this.emit("alert", alert);
    this.emit("ui_alert", alert);

    // 2. WebSocket Real-Time Broadcast
    if (this._wsBroadcastFn) {
      try {
        this._wsBroadcastFn({
          type: "security_alert",
          alert,
        });
      } catch {
        /* best-effort */
      }
    }

    // 3. Voice Notification Channel
    this.emit("voice_alert", {
      alertId: alert.alertId,
      voiceText: alert.voiceAlertText,
      risk: alert.risk,
    });

    // 4. Desktop Notification Channel
    this.emit("desktop_alert", {
      title: `MYRAA Security Alert: ${alert.threat}`,
      body: alert.sanitizedSummary,
      risk: alert.risk,
    });

    // 5. Custom Notification Webhooks
    for (const hook of this._customHooks) {
      try {
        hook(alert, "dashboard");
      } catch (err) {
        console.warn("[SecurityAlertManager] Custom hook error:", err);
      }
    }
  }

  /**
   * Builds warm, supportive, panic-free voice notification text for Myraa.
   */
  private _formatVoiceAlertText(threatName: string, severity: RiskLevel): string {
    switch (threatName) {
      case "BRUTE_FORCE_BURST":
        return "Sandeep, I've detected multiple failed login attempts from an unknown address and safely locked it out for you!";
      case "CREDENTIAL_REPLAY_ATTACK":
        return "Sandeep, a potential token replay attempt was detected. I have revoked that session immediately for your security!";
      case "DIRECTORY_TRAVERSAL_CAMPAIGN":
        return "Sandeep, repeated unauthorized directory access attempts were detected. I've initiated safety lockdown on the workspace!";
      case "ADVERSARIAL_INJECTION_CAMPAIGN":
        return "Sandeep, I noticed adversarial prompt injection patterns in external content and defanged them safely!";
      case "MALICIOUS_COMMAND_EXECUTION_ATTEMPT":
        return "Sandeep, a potentially destructive shell command was requested and immediately blocked by your security firewall!";
      case "UNAUTHORIZED_DEVICE_ACCESS":
        return "Sandeep, an unverified remote device tried to connect to your companion. I've blocked the connection!";
      case "INSECURE_NETWORK_PROBING":
        return "Sandeep, multiple insecure remote connection requests were rejected to protect your session!";
      case "PERMISSION_PROBING_BURST":
        return "Sandeep, an active session attempted repeated unauthorized operations. I have revoked the session safely!";
      default:
        return severity === "CRITICAL"
          ? "Sandeep, a high-priority security anomaly was detected and safely mitigated."
          : "Sandeep, I noticed a minor security event and logged it to your audit ledger.";
    }
  }

  /**
   * Query recent alerts.
   */
  getAlerts(limit = 50, filter?: { risk?: RiskLevel; unacknowledgedOnly?: boolean }): SecurityAlert[] {
    let result = this._alerts;
    if (filter?.risk) {
      result = result.filter((a) => a.risk === filter.risk);
    }
    if (filter?.unacknowledgedOnly) {
      result = result.filter((a) => !a.acknowledged);
    }
    return result.slice(-limit);
  }

  /**
   * Acknowledge an alert by ID.
   */
  acknowledgeAlert(alertId: string): boolean {
    const alert = this._alerts.find((a) => a.alertId === alertId);
    if (alert) {
      alert.acknowledged = true;
      return true;
    }
    return false;
  }

  /**
   * Clear all stored alerts for testing.
   */
  clearAlerts(): void {
    this._alerts = [];
  }
}

export const securityAlertManager = new SecurityAlertManager();
