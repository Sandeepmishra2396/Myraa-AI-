/**
 * MYRAA — SecretManager (Phase 10F)
 *
 * Centralized Secret Management & Zero-Leakage Governance:
 *   • Single source of truth for all API keys, secrets, and credentials.
 *   • Multi-tier lookup: Process Environment + AES-256-GCM Encrypted Store (SecureSecretStore).
 *   • Strict RBAC: Access to raw secret values is restricted strictly to admin role
 *     or allowlisted internal subsystems ("gemini_session_factory", "auth_manager", "network_security", "system").
 *   • Rejects and audits any access attempt from guest, read_only, standard, or unauthorized caller.
 *   • Full Secret Lifecycle: rotation, revocation, version tracking, and audit logging.
 *   • Zero raw-secret exposure guarantee:
 *       - Never logs secret values in audit events, alerts, or error messages.
 *       - Masked representations for status/dashboards (getMaskedSecret).
 *       - redactAllKnownSecrets() dynamically redacts all known active secret strings.
 *       - sanitizeModelContext() purges any potential secret from Gemini/LLM prompt context.
 *   • Accidental Hardcoded Secret Scanner:
 *       - Detects Gemini, OpenAI, AWS, GitHub, Slack tokens, private keys, and secret assignments.
 *       - Audits HARDCODED_SECRET_DETECTED.
 */

import {
  SecurityContext,
  SecretMetadata,
  HardcodedSecretFinding,
} from "./SecurityTypes.ts";
import { secureSecretStore, SecureSecretStore } from "./DataProtectionService.ts";
import { securityAuditLogger } from "./SecurityAuditLogger.ts";

export const ALLOWLISTED_INTERNAL_SUBSYSTEMS = new Set([
  "gemini_session_factory",
  "auth_manager",
  "network_security",
  "system",
]);

export interface CallerContext {
  role?: string;
  subsystem?: string;
  identityId?: string;
  ipAddress?: string;
  sessionId?: string;
}

export class SecretManager {
  private _store: SecureSecretStore;
  private _metadata = new Map<string, SecretMetadata>();

  constructor(store: SecureSecretStore = secureSecretStore) {
    this._store = store;
    this._bootstrapKnownKeys();
  }

  private _bootstrapKnownKeys(): void {
    const knownKeys = [
      "GEMINI_API_KEY",
      "TAVILY_API_KEY",
      "SESSION_SECRET",
      "MYRAA_MASTER_KEY",
      "MYRAA_SECURITY_SECRET",
    ];

    for (const key of knownKeys) {
      this._metadata.set(key, {
        keyName: key,
        version: 1,
        createdAt: Date.now(),
        revoked: false,
        subsystemAllowlist: ["gemini_session_factory", "system", "auth_manager"],
        description: `Core system secret: ${key}`,
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Authorization Checks (RBAC & Subsystem Allowlisting)
  // ---------------------------------------------------------------------------

  private _isAuthorized(
    caller?: SecurityContext | CallerContext,
    meta?: SecretMetadata,
  ): boolean {
    if (!caller) return false;

    // Role check: Only admin has direct clearance
    if (caller.role === "admin") {
      return true;
    }

    // Subsystem check: Allowlisted internal callers
    const subsystem = (caller as CallerContext).subsystem;
    if (subsystem) {
      if (ALLOWLISTED_INTERNAL_SUBSYSTEMS.has(subsystem)) {
        return true;
      }
      if (meta?.subsystemAllowlist && meta.subsystemAllowlist.includes(subsystem)) {
        return true;
      }
    }

    return false;
  }

  // ---------------------------------------------------------------------------
  // Secret Access & Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Retrieves raw secret value. Strictly enforces RBAC.
   * Throws SECRET_ACCESS_DENIED if caller is not authorized.
   * Throws SECRET_REVOKED if secret has been revoked.
   * NEVER logs secret value.
   */
  getSecret(
    keyName: string,
    caller?: SecurityContext | CallerContext,
  ): string | undefined {
    const meta = this._metadata.get(keyName);

    // 1. Enforce RBAC
    if (!this._isAuthorized(caller, meta)) {
      const actorRole = caller?.role || "unauthenticated";
      const subsystem = (caller as CallerContext)?.subsystem || "unknown";

      securityAuditLogger.logEvent({
        eventType: "SECRET_ACCESS_DENIED",
        actor: {
          identityId: (caller as any)?.identityId || "unknown_caller",
          role: (caller?.role as any) || "guest",
          ipAddress: caller?.ipAddress || "127.0.0.1",
          sessionId: caller?.sessionId,
        },
        target: { resource: keyName },
        decision: "BLOCK",
        reason: `SECRET_ACCESS_DENIED: Role '${actorRole}' / subsystem '${subsystem}' is not authorized to access secret '${keyName}'.`,
        riskLevel: "CRITICAL",
        metadata: { keyName, actorRole, subsystem },
      });

      throw new Error(
        `SECRET_ACCESS_DENIED: Access to secret '${keyName}' denied for role '${actorRole}' and subsystem '${subsystem}'.`,
      );
    }

    // 2. Check Revocation
    if (meta?.revoked) {
      throw new Error(`SECRET_REVOKED: Secret '${keyName}' has been revoked and cannot be retrieved.`);
    }

    // 3. Multi-Tier Resolution: Encrypted store -> Environment
    let value = this._store.getSecret(keyName);
    if (!value && process.env[keyName]) {
      value = process.env[keyName];
    }

    // 4. Audit Log Access (WITHOUT value)
    securityAuditLogger.logEvent({
      eventType: "SECRET_ACCESSED",
      actor: {
        identityId: (caller as any)?.identityId || "authorized_actor",
        role: (caller?.role as any) || "admin",
        ipAddress: caller?.ipAddress || "127.0.0.1",
        sessionId: caller?.sessionId,
      },
      target: { resource: keyName },
      decision: "ALLOW",
      reason: `Secret '${keyName}' accessed by authorized actor.`,
      riskLevel: "LOW",
      metadata: {
        keyName,
        subsystem: (caller as CallerContext)?.subsystem,
        version: meta?.version || 1,
      },
    });

    return value;
  }

  /**
   * Sets or updates a secret in the encrypted at-rest store.
   * Strictly enforces admin or authorized subsystem permissions.
   */
  setSecret(
    keyName: string,
    value: string,
    caller?: SecurityContext | CallerContext,
    options: { description?: string; subsystemAllowlist?: string[] } = {},
  ): void {
    const existingMeta = this._metadata.get(keyName);

    if (!this._isAuthorized(caller, existingMeta)) {
      throw new Error(
        `SECRET_ACCESS_DENIED: Setting secret '${keyName}' requires admin role or authorized subsystem.`,
      );
    }

    if (!value || typeof value !== "string") {
      throw new Error("INVALID_SECRET_VALUE: Secret value must be a non-empty string.");
    }

    // Store in encrypted persistence
    this._store.setSecret(keyName, value);

    // Update metadata
    const version = (existingMeta?.version || 0) + 1;
    this._metadata.set(keyName, {
      keyName,
      version,
      createdAt: existingMeta?.createdAt || Date.now(),
      rotatedAt: existingMeta ? Date.now() : undefined,
      revoked: false,
      subsystemAllowlist: options.subsystemAllowlist || existingMeta?.subsystemAllowlist || [
        "gemini_session_factory",
        "system",
      ],
      description: options.description || existingMeta?.description,
    });

    securityAuditLogger.logEvent({
      eventType: "SECRET_ROTATED",
      actor: {
        identityId: (caller as any)?.identityId || "system",
        role: (caller?.role as any) || "admin",
        ipAddress: caller?.ipAddress || "127.0.0.1",
      },
      target: { resource: keyName },
      decision: "ALLOW",
      reason: `Secret '${keyName}' stored/updated (version ${version}).`,
      riskLevel: "MEDIUM",
      metadata: { keyName, version },
    });
  }

  /**
   * Rotates an existing secret to a new value.
   */
  rotateSecret(
    keyName: string,
    newValue: string,
    caller?: SecurityContext | CallerContext,
  ): void {
    this.setSecret(keyName, newValue, caller);
  }

  /**
   * Revokes a secret. Immediately renders it inaccessible.
   */
  revokeSecret(
    keyName: string,
    caller?: SecurityContext | CallerContext,
  ): void {
    const meta = this._metadata.get(keyName);

    if (!this._isAuthorized(caller, meta)) {
      throw new Error(`SECRET_ACCESS_DENIED: Revoking secret '${keyName}' requires admin privileges.`);
    }

    this._store.deleteSecret(keyName);

    if (meta) {
      meta.revoked = true;
      meta.rotatedAt = Date.now();
    } else {
      this._metadata.set(keyName, {
        keyName,
        version: 1,
        createdAt: Date.now(),
        revoked: true,
      });
    }

    securityAuditLogger.logEvent({
      eventType: "SECRET_REVOKED",
      actor: {
        identityId: (caller as any)?.identityId || "system",
        role: (caller?.role as any) || "admin",
        ipAddress: caller?.ipAddress || "127.0.0.1",
      },
      target: { resource: keyName },
      decision: "ALLOW",
      reason: `Secret '${keyName}' revoked.`,
      riskLevel: "HIGH",
      metadata: { keyName },
    });
  }

  /**
   * Checks whether a secret exists and has not been revoked.
   */
  hasSecret(keyName: string): boolean {
    const meta = this._metadata.get(keyName);
    if (meta?.revoked) return false;
    return this._store.hasSecret(keyName) || Boolean(process.env[keyName]);
  }

  // ---------------------------------------------------------------------------
  // Zero-Leakage Views & Masking
  // ---------------------------------------------------------------------------

  /**
   * Returns a safe masked version of a secret for UI/monitoring display.
   * e.g. "AIzaSy...****...3f8a" or "sora_...****...1234"
   */
  getMaskedSecret(keyName: string): string {
    const meta = this._metadata.get(keyName);
    if (meta?.revoked) {
      return "[REVOKED]";
    }

    let val = this._store.getSecret(keyName) || process.env[keyName];
    if (!val) return "[NOT_SET]";

    if (val.length <= 8) {
      return "********";
    }

    const start = val.slice(0, 4);
    const end = val.slice(-4);
    return `${start}...****...${end}`;
  }

  /**
   * Returns secret metadata without exposing any raw secret values.
   */
  listSecretMetadata(): SecretMetadata[] {
    return Array.from(this._metadata.values()).map((m) => ({
      ...m,
      subsystemAllowlist: m.subsystemAllowlist ? [...m.subsystemAllowlist] : undefined,
    }));
  }

  /**
   * Redacts all known active secret values from any string text.
   * Used before persisting audit records, sending text to frontend, or passing to LLM.
   */
  redactAllKnownSecrets(text: string): string {
    if (!text || typeof text !== "string") return text;

    let sanitized = text;

    // Collect all candidate secret strings
    const secretsToMask = new Set<string>();

    for (const key of this._metadata.keys()) {
      const meta = this._metadata.get(key);
      if (meta?.revoked) continue;

      const storeVal = this._store.getSecret(key);
      if (storeVal && storeVal.length >= 4) {
        secretsToMask.add(storeVal);
      }

      const envVal = process.env[key];
      if (envVal && envVal.length >= 4) {
        secretsToMask.add(envVal);
      }
    }

    for (const secret of secretsToMask) {
      const escaped = secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const regex = new RegExp(escaped, "g");
      sanitized = sanitized.replace(regex, "[REDACTED_SECRET]");
    }

    return sanitized;
  }

  /**
   * Cleanses potential secrets, API keys, and credentials before injecting into Gemini model context.
   */
  sanitizeModelContext(contextText: string): string {
    if (!contextText || typeof contextText !== "string") return contextText;

    let cleaned = this.redactAllKnownSecrets(contextText);

    // Also strip generic API key patterns
    cleaned = cleaned.replace(/AIza[0-9A-Za-z\-_]{20,}/g, "AIzaSy...[REDACTED]");
    cleaned = cleaned.replace(/AQ\.[0-9A-Za-z\-_.]{15,}/g, "AQ...[REDACTED]");
    cleaned = cleaned.replace(/ya29\.[0-9A-Za-z\-_.]{15,}/g, "ya29...[REDACTED]");
    cleaned = cleaned.replace(/sk-[A-Za-z0-9_-]{20,}/g, "sk-...[REDACTED]");
    cleaned = cleaned.replace(/AKIA[0-9A-Z]{16}/g, "AKIA...[REDACTED]");
    cleaned = cleaned.replace(/gh[pousr]_[A-Za-z0-9_]{36,}/g, "gh_...[REDACTED]");

    return cleaned;
  }

  // ---------------------------------------------------------------------------
  // Static Analysis: Hardcoded Secret Detection
  // ---------------------------------------------------------------------------

  /**
   * Scans content or source code to detect accidentally hardcoded secrets.
   */
  detectHardcodedSecrets(
    content: string,
    filePath = "memory",
  ): HardcodedSecretFinding[] {
    const findings: HardcodedSecretFinding[] = [];
    if (!content || typeof content !== "string") return findings;

    const lines = content.split(/\r?\n/);

    const patterns: Array<{
      type: string;
      regex: RegExp;
      confidence: "LOW" | "MEDIUM" | "HIGH";
    }> = [
      {
        type: "Google / Gemini API Key",
        regex: /(?:AIza[0-9A-Za-z\-_]{20,}|AQ\.[0-9A-Za-z\-_.]{20,})/,
        confidence: "HIGH",
      },
      {
        type: "Google OAuth Access Token",
        regex: /ya29\.[0-9A-Za-z\-_.]{20,}/,
        confidence: "HIGH",
      },
      {
        type: "OpenAI API Key",
        regex: /sk-[A-Za-z0-9_-]{20,}/,
        confidence: "HIGH",
      },
      {
        type: "AWS Access Key",
        regex: /AKIA[0-9A-Z]{16}/,
        confidence: "HIGH",
      },
      {
        type: "GitHub Token",
        regex: /gh[pousr]_[A-Za-z0-9_]{36,}/,
        confidence: "HIGH",
      },
      {
        type: "Slack Token",
        regex: /xox[baprs]-[0-9A-Za-z]{10,}/,
        confidence: "HIGH",
      },
      {
        type: "Private RSA/EC Key",
        regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
        confidence: "HIGH",
      },
      {
        type: "Generic Secret Assignment",
        regex: /(?:api_key|apikey|secret_key|client_secret|auth_token|password)\s*[:=]\s*["']([A-Za-z0-9_\-.~!@#$%^&*+=/]{8,})["']/i,
        confidence: "MEDIUM",
      },
    ];

    for (let i = 0; i < lines.length; i++) {
      const lineText = lines[i];
      const lineNum = i + 1;

      // Skip obvious placeholders or mock/test markers
      if (
        lineText.includes("[REDACTED") ||
        lineText.includes("YOUR_") ||
        lineText.includes("example_") ||
        lineText.includes("dummy_") ||
        lineText.includes("mock_")
      ) {
        continue;
      }

      for (const p of patterns) {
        const match = lineText.match(p.regex);
        if (match) {
          const sample = match[0];
          const masked =
            sample.length > 8
              ? `${sample.slice(0, 3)}...${sample.slice(-3)}`
              : "********";

          findings.push({
            filePath,
            line: lineNum,
            secretType: p.type,
            maskedSample: masked,
            confidence: p.confidence,
          });
          break; // One finding per line is sufficient
        }
      }
    }

    if (findings.length > 0) {
      securityAuditLogger.logEvent({
        eventType: "HARDCODED_SECRET_DETECTED",
        actor: { identityId: "secret_scanner", role: "admin", ipAddress: "127.0.0.1" },
        decision: "AUDIT",
        reason: `Detected ${findings.length} hardcoded secret finding(s) in ${filePath}.`,
        riskLevel: "HIGH",
        metadata: {
          filePath,
          count: findings.length,
          types: findings.map((f) => f.secretType),
        },
      });
    }

    return findings;
  }

  // ---------------------------------------------------------------------------
  // Test Isolation
  // ---------------------------------------------------------------------------

  clearForTesting(): void {
    this._metadata.clear();
    this._store.clearForTesting();
    this._bootstrapKnownKeys();
  }
}

export const secretManager = new SecretManager();
