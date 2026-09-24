/**
 * MYRAA — SecurityEventStream (Phase 10C)
 *
 * Continuous Security Event Stream:
 *   • Real-time Pub/Sub security telemetry event pipeline.
 *   • Ingests and normalizes raw audit events from SecurityAuditLogger.
 *   • Provides structured filtering, querying, and subscription for SecurityMonitor (IDS).
 *   • Zero-leakage guarantee: every event payload is scrubbed by OutputDataFirewall.
 *   • Loop-Prevention: Internal alerts are flagged so they never trigger recursive monitor loops.
 */

import EventEmitter from "events";
import crypto from "crypto";
import type {
  NormalizedSecurityEvent,
  MonitoringEventType,
  RiskLevel,
  SecurityAuditEvent,
  AuditEventType,
} from "./SecurityTypes.ts";
import { securityAuditLogger } from "./SecurityAuditLogger.ts";
import { outputDataFirewall } from "./OutputDataFirewall.ts";

export class SecurityEventStream extends EventEmitter {
  private _eventBuffer: NormalizedSecurityEvent[] = [];
  private _maxBufferSize = 1000;
  private _auditUnsubscribe?: () => void;

  constructor() {
    super();
    this.setMaxListeners(50);
    this._attachAuditLogger();
  }

  /**
   * Reset the stream buffer and listeners for isolated unit testing.
   */
  resetForTesting(): void {
    this._eventBuffer = [];
    this.removeAllListeners();
    if (this._auditUnsubscribe) {
      this._auditUnsubscribe();
    }
    this._attachAuditLogger();
  }

  private _attachAuditLogger(): void {
    this._auditUnsubscribe = securityAuditLogger.onAuditLogged((auditEvent) => {
      this._ingestAuditEvent(auditEvent);
    });
  }

  /**
   * Converts a SecurityAuditEvent into a NormalizedSecurityEvent and broadcasts it.
   */
  private _ingestAuditEvent(audit: SecurityAuditEvent): void {
    // Ignore internal alert logging to prevent recursive feedback loops and double-ingestion
    if (audit.eventType === "SECURITY_ALERT_TRIGGERED" || audit.metadata?._streamOrigin) {
      return;
    }

    const eventType = this._mapAuditEventToMonitoring(audit.eventType, audit.reason);
    const severity = audit.riskLevel || this._inferSeverity(eventType);

    const normalized: NormalizedSecurityEvent = {
      id: audit.id || crypto.randomUUID(),
      timestamp: new Date(audit.timestamp).getTime() || Date.now(),
      eventType,
      severity,
      actor: {
        identityId: audit.actor?.identityId || "unknown",
        role: audit.actor?.role || "guest",
        ipAddress: audit.actor?.ipAddress || "127.0.0.1",
        sessionId: audit.actor?.sessionId,
        deviceId: audit.actor?.deviceId,
        isLocal:
          audit.actor?.ipAddress === "127.0.0.1" ||
          audit.actor?.ipAddress === "::1" ||
          audit.actor?.ipAddress === "localhost",
      },
      target: audit.target
        ? {
            toolName: audit.target.toolName,
            resource: audit.target.resource,
          }
        : undefined,
      summary: audit.reason || `Security audit event ${eventType}`,
      details: audit.metadata || {},
      isAlertNotification: false,
    };

    this.publish(normalized, false);
  }

  /**
   * Publish a normalized event to the stream and notify subscribers.
   */
  publish(
    event: Partial<NormalizedSecurityEvent> & { eventType: MonitoringEventType },
    persistToAudit = true,
  ): NormalizedSecurityEvent {
    const timestamp = event.timestamp || Date.now();
    const id = event.id || crypto.randomUUID();
    const severity = event.severity || this._inferSeverity(event.eventType);

    // Deep DLP scrub of summary and details to guarantee zero secret leakage
    const rawDetails = event.details || {};
    const { sanitized: cleanDetails } = outputDataFirewall.sanitizeResult(rawDetails);
    const { sanitized: cleanSummary } = outputDataFirewall.sanitizeResult(
      event.summary || `Security event ${event.eventType}`,
    );

    const normalized: NormalizedSecurityEvent = {
      id,
      timestamp,
      eventType: event.eventType,
      severity,
      actor: {
        identityId: event.actor?.identityId || "unknown",
        role: event.actor?.role || "guest",
        ipAddress: event.actor?.ipAddress || "127.0.0.1",
        sessionId: event.actor?.sessionId,
        deviceId: event.actor?.deviceId,
        isLocal:
          event.actor?.isLocal ??
          (event.actor?.ipAddress === "127.0.0.1" ||
            event.actor?.ipAddress === "::1" ||
            event.actor?.ipAddress === "localhost"),
      },
      target: event.target,
      summary: cleanSummary,
      details: (cleanDetails as Record<string, unknown>) || {},
      isAlertNotification: event.isAlertNotification || false,
    };

    // Buffer normalized event
    this._eventBuffer.push(normalized);
    if (this._eventBuffer.length > this._maxBufferSize) {
      this._eventBuffer.shift();
    }

    // Persist to audit ledger if requested and not an alert notification
    if (persistToAudit && !normalized.isAlertNotification) {
      securityAuditLogger.logEvent({
        eventType: normalized.eventType as AuditEventType,
        actor: {
          identityId: normalized.actor.identityId,
          role: normalized.actor.role,
          ipAddress: normalized.actor.ipAddress,
          sessionId: normalized.actor.sessionId,
          deviceId: normalized.actor.deviceId,
        },
        target: normalized.target,
        riskLevel: normalized.severity,
        decision: normalized.severity === "CRITICAL" ? "BLOCK" : "ALLOW",
        reason: normalized.summary,
        metadata: { ...normalized.details, _streamOrigin: true },
      });
    }

    // Broadcast on generic channel and specific eventType channel
    this.emit("security_event", normalized);
    this.emit(normalized.eventType, normalized);

    return normalized;
  }

  /**
   * Subscribe to all security events.
   */
  onEvent(listener: (event: NormalizedSecurityEvent) => void): () => void {
    this.on("security_event", listener);
    return () => {
      this.off("security_event", listener);
    };
  }

  /**
   * Get recent normalized events from buffer.
   */
  getRecentEvents(limit = 100): NormalizedSecurityEvent[] {
    return this._eventBuffer.slice(-limit);
  }

  /**
   * Query buffer with custom filter.
   */
  filterEvents(predicate: (event: NormalizedSecurityEvent) => boolean): NormalizedSecurityEvent[] {
    return this._eventBuffer.filter(predicate);
  }

  // ---------------------------------------------------------------------------
  // Classification & Mapping Helpers
  // ---------------------------------------------------------------------------

  private _mapAuditEventToMonitoring(auditType: AuditEventType, reason = ""): MonitoringEventType {
    const lowerReason = (reason || "").toLowerCase();
    switch (auditType) {
      case "AUTH_FAILURE":
      case "LOGIN_FAILED":
        return "LOGIN_FAILED";
      case "UNKNOWN_DEVICE":
        return "UNKNOWN_DEVICE";
      case "TOKEN_REPLAY_DETECTED":
      case "TOKEN_REUSE":
        return "TOKEN_REUSE";
      case "PROMPT_INJECTION_DETECTED":
        return "PROMPT_INJECTION_DETECTED";
      case "PATH_TRAVERSAL_ATTEMPT":
        return "PATH_TRAVERSAL_ATTEMPT";
      case "ARGUMENT_VIOLATION":
        if (lowerReason.includes("traversal") || lowerReason.includes("outside the authorized workspace")) {
          return "PATH_TRAVERSAL_ATTEMPT";
        }
        if (lowerReason.includes("ssrf") || lowerReason.includes("target url is restricted") || lowerReason.includes("loopback")) {
          return "UNUSUAL_NETWORK_REQUEST";
        }
        if (lowerReason.includes("fenced") || lowerReason.includes("untrusted")) {
          return "UNTRUSTED_FILE";
        }
        return "SUSPICIOUS_TOOL_CALL";
      case "CRITICAL_COMMAND_BLOCKED":
      case "COMMAND_BLOCKED":
        return "COMMAND_BLOCKED";
      case "INSECURE_TRANSPORT_REJECTED":
      case "UNUSUAL_NETWORK_REQUEST":
        return "UNUSUAL_NETWORK_REQUEST";
      case "MULTIPLE_PERMISSION_FAILURES":
        return "MULTIPLE_PERMISSION_FAILURES";
      case "TOOL_BLOCKED":
        if (lowerReason.includes("permission") || lowerReason.includes("role '")) {
          return "MULTIPLE_PERMISSION_FAILURES";
        }
        if (lowerReason.includes("lockdown")) {
          return "SECURITY_POLICY_VIOLATION";
        }
        return "SUSPICIOUS_TOOL_CALL";
      case "SESSION_REVOKED":
      case "REMOTE_SESSION_ANOMALY":
        return "REMOTE_SESSION_ANOMALY";
      case "DLP_REDACTION":
      case "DATA_ENCRYPTION_ERROR":
      case "DATA_ACCESS_ANOMALY":
        return "DATA_ACCESS_ANOMALY";
      case "SECURITY_LOCKDOWN":
      case "SECURITY_POLICY_VIOLATION":
        return "SECURITY_POLICY_VIOLATION";
      case "SUSPICIOUS_ACTIVITY":
      case "SUSPICIOUS_TOOL_CALL":
      default:
        return "SUSPICIOUS_TOOL_CALL";
    }
  }

  private _inferSeverity(type: MonitoringEventType): RiskLevel {
    switch (type) {
      case "TOKEN_REUSE":
      case "COMMAND_BLOCKED":
      case "SECURITY_POLICY_VIOLATION":
        return "CRITICAL";
      case "LOGIN_FAILED":
      case "PROMPT_INJECTION_DETECTED":
      case "PATH_TRAVERSAL_ATTEMPT":
      case "MULTIPLE_PERMISSION_FAILURES":
      case "REMOTE_SESSION_ANOMALY":
        return "HIGH";
      case "UNKNOWN_DEVICE":
      case "SUSPICIOUS_TOOL_CALL":
      case "UNUSUAL_NETWORK_REQUEST":
      case "DATA_ACCESS_ANOMALY":
        return "MEDIUM";
      case "UNTRUSTED_FILE":
      default:
        return "LOW";
    }
  }
}

export const securityEventStream = new SecurityEventStream();
