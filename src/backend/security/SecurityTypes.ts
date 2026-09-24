/**
 * MYRAA — SecurityTypes (Phase 10A)
 *
 * Core type declarations and contracts for the MYRAA Security Foundation:
 *   • Identity & Session Management
 *   • Token Families & Replay Detection
 *   • Deterministic Security Policy Engine & Risk Levels
 *   • Tamper-Evident Audit Logging
 */

export type RiskLevel = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export type IdentityRole = "admin" | "standard" | "read_only" | "guest";

export type SecurityMode = "BALANCED" | "STRICT" | "PARANOID" | "LOCKDOWN";

export type DecisionType =
  | "ALLOW"
  | "AUDIT"
  | "REQUIRE_CONFIRMATION"
  | "CONFIRMATION_REQUIRED"
  | "BLOCK"
  | "CONTAINMENT"
  | "LOCKDOWN"
  | "SESSION_REVOKED"
  | "REVOKE"
  | "TOOL_DISABLED"
  | "TAMPER_DETECTED"
  | "CHALLENGE_PIN";

export type AuditEventType =
  | "AUTH_SUCCESS"
  | "AUTH_FAILURE"
  | "LOGIN_FAILED"
  | "UNKNOWN_DEVICE"
  | "TOKEN_REFRESH"
  | "TOKEN_REPLAY_DETECTED"
  | "TOKEN_REUSE"
  | "SESSION_CREATED"
  | "SESSION_REVOKED"
  | "DEVICE_REVOKED"
  | "BRUTE_FORCE_LOCKOUT"
  | "STEP_UP_CHALLENGE"
  | "STEP_UP_VERIFIED"
  | "STEP_UP_FAILED"
  | "TOOL_ALLOW"
  | "TOOL_REQUIRE_CONFIRMATION"
  | "TOOL_CONFIRMED"
  | "TOOL_BLOCKED"
  | "ARGUMENT_VIOLATION"
  | "CRITICAL_COMMAND_BLOCKED"
  | "COMMAND_BLOCKED"
  | "SUSPICIOUS_TOOL_CALL"
  | "PATH_TRAVERSAL_ATTEMPT"
  | "UNTRUSTED_FILE"
  | "UNUSUAL_NETWORK_REQUEST"
  | "MULTIPLE_PERMISSION_FAILURES"
  | "REMOTE_SESSION_ANOMALY"
  | "DATA_ACCESS_ANOMALY"
  | "SECURITY_POLICY_VIOLATION"
  | "DLP_REDACTION"
  | "SECURITY_LOCKDOWN"
  | "SUSPICIOUS_ACTIVITY"
  | "PROMPT_INJECTION_DETECTED"
  | "INSECURE_TRANSPORT_REJECTED"
  | "DATA_ENCRYPTION_ERROR"
  | "SECURITY_ALERT_TRIGGERED"
  | "CONTAINMENT_TRIGGERED"
  | "CONTAINMENT_LIFTED"
  | "TAMPER_DETECTED"
  | "BASELINE_UPDATED"
  | "BASELINE_REJECTED"
  | "TOOL_DISABLED"
  | "TOOL_ENABLED"
  | "LOCKDOWN_RESET"
  | "LOCKDOWN_INITIATED"
  | "SECRET_ACCESSED"
  | "SECRET_ROTATED"
  | "SECRET_REVOKED"
  | "SECRET_ACCESS_DENIED"
  | "SSRF_BLOCKED"
  | "RATE_LIMIT_EXCEEDED"
  | "WEBHOOK_VERIFIED"
  | "WEBHOOK_FAILED"
  | "HARDCODED_SECRET_DETECTED"
  // Phase 28 — Mobile Emergency & Security Layer
  | "EMERGENCY_STOP_TRIGGERED"
  | "LOST_DEVICE_ENABLED"
  | "LOST_DEVICE_RECOVERED"
  | "LOGOUT_ALL_DEVICES"
  | "ADMIN_RECOVERY";

export type MonitoringEventType =
  | "LOGIN_FAILED"
  | "UNKNOWN_DEVICE"
  | "TOKEN_REUSE"
  | "SUSPICIOUS_TOOL_CALL"
  | "PROMPT_INJECTION_DETECTED"
  | "UNTRUSTED_FILE"
  | "PATH_TRAVERSAL_ATTEMPT"
  | "COMMAND_BLOCKED"
  | "UNUSUAL_NETWORK_REQUEST"
  | "MULTIPLE_PERMISSION_FAILURES"
  | "REMOTE_SESSION_ANOMALY"
  | "DATA_ACCESS_ANOMALY"
  | "SECURITY_POLICY_VIOLATION";

export interface PromptInjectionScanResult {
  hasInjectionAttempt: boolean;
  score: number; // 0 - 100
  matchedPatterns: string[];
  sanitizedText: string;
}

export interface ContentSandboxResult {
  contentType: "document" | "web" | "screen_ocr" | "youtube" | "tool_result" | "external_api";
  fencedText: string;
  injectionScan: PromptInjectionScanResult;
  isUntrusted: true;
}

export interface SecurityContext {
  identityId: string;
  role: IdentityRole;
  sessionId?: string;
  deviceId?: string;
  ipAddress: string;
  userAgent?: string;
  isLocal: boolean;
  isStepUpAuthenticated?: boolean;
}

export type OperationType = "query" | "modify" | "execute" | "security_config";

export interface RiskFactors {
  toolSensitivity: {
    category: "benign" | "network_browser" | "state_altering" | "critical_system";
    baseScore: number;
  };
  operationType: {
    type: OperationType;
    score: number;
  };
  role: {
    role: IdentityRole;
    score: number;
  };
  trustLevel: {
    level: "local" | "paired_trusted" | "remote_unpaired";
    score: number;
  };
  argumentValidation: {
    traversalAttempt?: boolean;
    dangerousFlags?: boolean;
    protectedPathTarget?: boolean;
    fencedUntrustedData?: boolean;
    score: number;
  };
  networkDestination?: {
    isPrivateOrRestricted?: boolean;
    isLoopback?: boolean;
    score: number;
  };
  threatState: {
    mode: SecurityMode;
    containmentActive?: boolean;
    score: number;
  };
  rawScore: number;
  finalScore: number;
}

export interface RiskEvaluation {
  level: RiskLevel;
  score: number; // 0 - 100
  reasons: string[];
  requiresConfirmation: boolean;
  isCritical: boolean;
  factors?: RiskFactors;
}

export interface PolicyDecision {
  decision: DecisionType;
  allowed: boolean;
  risk: RiskEvaluation;
  confirmationToken?: string;
  reason?: string;
  auditId: string;
}

export interface CanonicalAuditRecord {
  timestamp: string;
  eventId: string;
  deviceSession: string;
  action: string;
  tool: string;
  riskLevel: RiskLevel;
  decision: DecisionType;
  reason: string;
  metadata?: Record<string, unknown>;
  prevHash: string;
  hash: string;
}

export interface SecurityAuditEvent {
  id: string;
  timestamp: string;
  eventType: AuditEventType;
  actor: {
    identityId: string;
    role: IdentityRole;
    ipAddress: string;
    sessionId?: string;
    deviceId?: string;
    isLocal?: boolean;
  };
  target?: {
    toolName?: string;
    resource?: string;
  };
  riskLevel?: RiskLevel;
  decision: DecisionType;
  reason?: string;
  metadata?: Record<string, unknown>;
  prevHash: string;
  hash: string;
  // Canonical Phase 10E metadata fields
  eventId?: string;
  deviceSession?: string;
  action?: string;
  tool?: string;
}

export interface SessionRecord {
  sessionId: string;
  deviceId: string;
  identityId: string;
  role: IdentityRole;
  createdAt: number;
  expiresAt: number;
  lastActivityAt: number;
  ipAddress: string;
  userAgent: string;
  revoked: boolean;
  revokedReason?: string;
  isStepUpAuthenticated?: boolean;
  stepUpExpiresAt?: number;
}

export interface TokenFamily {
  familyId: string;
  sessionId: string;
  currentRefreshTokenHash: string;
  usedRefreshTokenHashes: string[];
  revoked: boolean;
  createdAt: number;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresInSeconds: number;
  tokenType: "Bearer";
  role: IdentityRole;
  sessionId: string;
}

export interface ConfirmationTokenPayload {
  tokenId: string;
  toolName: string;
  argsHash: string;
  sessionId: string;
  issuedAt: number;
  expiresAt: number;
}

// ---------------------------------------------------------------------------
// Security Constants & Timeouts
// ---------------------------------------------------------------------------
export const ACCESS_TOKEN_TTL_MS = 15 * 60 * 1000; // 15 minutes (short-lived)
export const REFRESH_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
export const STEP_UP_TTL_MS = 3 * 60 * 1000; // 3 minutes challenge code window
export const STEP_UP_GRACE_MS = 5 * 60 * 1000; // 5 minutes grace period after verification
export const AUTH_MAX_FAILED_ATTEMPTS = 5;
export const AUTH_LOCKOUT_MS = 15 * 60 * 1000; // 15 minutes brute-force lockout
export const CONFIRMATION_TOKEN_TTL_MS = 5 * 60 * 1000; // 5 minutes

// ---------------------------------------------------------------------------
// Phase 10C: Monitoring & Alert Contracts
// ---------------------------------------------------------------------------

export interface NormalizedSecurityEvent {
  id: string;
  timestamp: number;
  eventType: MonitoringEventType;
  severity: RiskLevel;
  actor: {
    identityId: string;
    role: IdentityRole;
    ipAddress: string;
    sessionId?: string;
    deviceId?: string;
    isLocal?: boolean;
  };
  target?: {
    toolName?: string;
    resource?: string;
  };
  summary: string;
  details: Record<string, unknown>;
  /** Set to true on system-generated alert events to prevent alert -> monitor feedback loops */
  isAlertNotification?: boolean;
}

export type AlertAction =
  | "ALERT_ONLY"
  | "SESSION_REVOKED"
  | "DEVICE_QUARANTINED"
  | "LOCKDOWN_INITIATED"
  | "COMMAND_TERMINATED"
  | "CONTAINMENT_ACTIVE"
  | "TOOL_DISABLED";

export interface SecurityAlert {
  alertId: string;
  threat: string;            // Threat classification
  risk: RiskLevel;           // LOW | MEDIUM | HIGH | CRITICAL
  event: MonitoringEventType; // Associated event type
  action: AlertAction;       // Automated containment action taken
  deviceSession: {
    deviceId?: string;
    sessionId?: string;
    ipAddress: string;
  };
  timestamp: number;
  recommendedAction: string; // Remediation advice for user/admin
  sanitizedSummary: string;  // Plain English safe explanation (zero secrets)
  voiceAlertText: string;    // Human/companion friendly voice announcement
  acknowledged?: boolean;
}

export type AlertChannel = "ui" | "voice" | "desktop" | "dashboard" | "webhook";

export interface SecurityMonitorThresholds {
  failedLoginsThreshold: number;       // default: 3 failures
  failedLoginsWindowMs: number;        // default: 60,000 ms (1 min)
  permissionFailuresThreshold: number; // default: 3 failures
  permissionFailuresWindowMs: number;  // default: 60,000 ms
  pathTraversalThreshold: number;      // default: 2 attempts
  pathTraversalWindowMs: number;       // default: 60,000 ms
  promptInjectionThreshold: number;    // default: 2 attempts
  promptInjectionWindowMs: number;     // default: 120,000 ms
  suspiciousToolBurstThreshold: number;// default: 3 blocks
  suspiciousToolBurstWindowMs: number; // default: 60,000 ms
  networkAnomalyThreshold: number;     // default: 3 rejections
  networkAnomalyWindowMs: number;      // default: 60,000 ms
}

export const DEFAULT_MONITOR_THRESHOLDS: SecurityMonitorThresholds = {
  failedLoginsThreshold: 3,
  failedLoginsWindowMs: 60_000,
  permissionFailuresThreshold: 3,
  permissionFailuresWindowMs: 60_000,
  pathTraversalThreshold: 2,
  pathTraversalWindowMs: 60_000,
  promptInjectionThreshold: 2,
  promptInjectionWindowMs: 120_000,
  suspiciousToolBurstThreshold: 3,
  suspiciousToolBurstWindowMs: 60_000,
  networkAnomalyThreshold: 3,
  networkAnomalyWindowMs: 60_000,
};

export interface ThreatReport {
  threatName: string;
  severity: RiskLevel;
  triggerEvent: MonitoringEventType;
  occurrences: number;
  windowMs: number;
  actor: {
    identityId: string;
    ipAddress: string;
    sessionId?: string;
    deviceId?: string;
  };
  target?: {
    toolName?: string;
    resource?: string;
  };
  mitigationAction: AlertAction;
  recommendedAction: string;
  reason: string;
}

// ---------------------------------------------------------------------------
// Phase 10D: Threat Containment & Tamper Detection Contracts
// ---------------------------------------------------------------------------

export type ContainmentAction =
  | "BLOCK_OPERATION"
  | "REVOKE_SESSION"
  | "DISABLE_TOOL"
  | "TERMINATE_REMOTE"
  | "INITIATE_LOCKDOWN"
  | "PRESERVE_EVIDENCE"
  | "ALERT_USER";

export interface ContainmentRecord {
  containmentId: string;
  timestamp: number;
  threatName: string;
  severity: RiskLevel;
  actor: {
    identityId: string;
    role?: string;
    ipAddress: string;
    sessionId?: string;
    deviceId?: string;
    isLocal?: boolean;
  };
  target?: {
    toolName?: string;
    resource?: string;
  };
  actionsTaken: ContainmentAction[];
  evidenceId: string;
  active: boolean;
  reason: string;
  disabledTools?: string[];
  revertedAt?: number;
  revertedBy?: string;
}

export interface ForensicEvidence {
  evidenceId: string;
  timestamp: number;
  threatName: string;
  severity: RiskLevel;
  actor: {
    identityId: string;
    role?: string;
    ipAddress: string;
    sessionId?: string;
    deviceId?: string;
  };
  triggerEvent: MonitoringEventType | "INTEGRITY_TAMPER";
  sanitizedDetails: Record<string, unknown>;
  evidenceHash: string; // SHA-256 of canonical JSON payload
  immutable: true;
}

export interface TamperViolation {
  filePath: string;
  type: "MODIFIED" | "DELETED" | "UNEXPECTED_FILE" | "SIGNATURE_INVALID";
  expectedHash?: string;
  actualHash?: string;
  detectedAt: number;
  reason: string;
}

export interface TamperReport {
  timestamp: number;
  tampered: boolean;
  violations: TamperViolation[];
  baselineSignatureValid: boolean;
  filesChecked: number;
}

export interface BaselineManifest {
  version: string;
  createdAt: number;
  updatedAt: number;
  signature: string; // HMAC-SHA256 signature
  files: Record<string, { sha256: string; size: number }>;
}

// ==========================================
// Phase 10F — Network Security & Secret Management
// ==========================================

export interface NetworkSecurityConfig {
  allowedDomains?: string[];
  blockedDomains?: string[];
  maxRedirects?: number; // default 5
  timeoutMs?: number; // default 10,000 (10s)
  maxResponseBytes?: number; // default 10 * 1024 * 1024 (10MB)
  rateLimitPerDomainPerMin?: number; // default 30
  dnsRebindingProtection?: boolean; // default true
}

export interface GuardedFetchOptions extends RequestInit {
  timeoutMs?: number;
  maxRedirects?: number;
  maxResponseBytes?: number;
  skipDnsRebinding?: boolean;
  callerSubsystem?: string;
  context?: SecurityContext;
}

export interface GuardedResponse {
  url: string;
  status: number;
  statusText: string;
  headers: Headers;
  redirectHops: string[];
  ok: boolean;
  text(): Promise<string>;
  json<T = unknown>(): Promise<T>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface WebhookValidationOptions {
  payload: string | Buffer;
  signatureHeader: string;
  secret: string;
  algorithm?: "sha256" | "sha1";
  toleranceSeconds?: number;
  timestampHeader?: string;
}

export interface WebhookValidationResult {
  valid: boolean;
  reason?: string;
  timestamp?: number;
}

export interface SecretMetadata {
  keyName: string;
  version: number;
  createdAt: number;
  rotatedAt?: number;
  revoked: boolean;
  subsystemAllowlist?: string[];
  description?: string;
}

export interface SecretAccessAudit {
  keyName: string;
  accessorRole: string;
  accessorSubsystem?: string;
  action: "GET" | "SET" | "ROTATE" | "REVOKE";
  success: boolean;
  timestamp: number;
  reason?: string;
}

export interface HardcodedSecretFinding {
  filePath: string;
  line: number;
  secretType: string;
  maskedSample: string;
  confidence: "LOW" | "MEDIUM" | "HIGH";
}

