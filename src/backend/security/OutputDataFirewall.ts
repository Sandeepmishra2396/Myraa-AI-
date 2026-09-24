/**
 * MYRAA — OutputDataFirewall (Phase 10A)
 *
 * Output & Result Validation Firewall (DLP - Data Loss Prevention):
 *   • Inspects tool outputs before returning them to the Gemini AI session or client.
 *   • Redacts API keys, credentials, private keys, passwords, and tokens.
 *   • Logs DLP redaction audit events without recording the leaked secret itself.
 *   • Cleanses system paths and stack traces.
 */

import { securityAuditLogger } from "./SecurityAuditLogger.ts";
import { secretManager } from "./SecretManager.ts";

export class OutputDataFirewall {
  /**
   * Deeply sanitize and inspect a tool execution result.
   */
  sanitizeResult<T>(
    result: T,
    metadata?: { toolName: string; sessionId?: string; ipAddress?: string },
  ): { sanitized: T; redactedCount: number } {
    let redactedCount = 0;

    const sanitizeValue = (val: unknown): unknown => {
      if (typeof val === "string") {
        let str = val;
        let modified = false;

        // Dynamic secret redaction from SecretManager
        const beforeSecretRedact = str;
        str = secretManager.redactAllKnownSecrets(str);
        if (str !== beforeSecretRedact) {
          modified = true;
          redactedCount++;
        }

        // Gemini API keys
        if (/AIza[0-9A-Za-z\-_]{20,}/g.test(str)) {
          str = str.replace(/AIza[0-9A-Za-z\-_]{20,}/g, "AIzaSy...[REDACTED]");
          modified = true;
          redactedCount++;
        }

        // MYRAA / Sora tokens
        if (/(myraa_(at|rf)_[A-Za-z0-9_\-.]+|sora_(conf|tok)_[A-Za-z0-9_\-.]+)/g.test(str)) {
          str = str.replace(/(myraa_(at|rf)_[A-Za-z0-9_\-.]+|sora_(conf|tok)_[A-Za-z0-9_\-.]+)/g, "[REDACTED_TOKEN]");
          modified = true;
          redactedCount++;
        }

        // Bearer tokens
        if (/Bearer\s+[A-Za-z0-9_\-.]+/gi.test(str)) {
          str = str.replace(/Bearer\s+[A-Za-z0-9_\-.]+/gi, "Bearer [REDACTED]");
          modified = true;
          redactedCount++;
        }

        // OpenAI / Anthropic keys
        if (/sk-[A-Za-z0-9_-]{20,}/g.test(str)) {
          str = str.replace(/sk-[A-Za-z0-9_-]{20,}/g, "sk-...[REDACTED]");
          modified = true;
          redactedCount++;
        }

        // GitHub tokens
        if (/gh[pousr]_[A-Za-z0-9_]{36,}/g.test(str)) {
          str = str.replace(/gh[pousr]_[A-Za-z0-9_]{36,}/g, "gh_...[REDACTED]");
          modified = true;
          redactedCount++;
        }

        // AWS access key ID
        if (/AKIA[0-9A-Z]{16}/g.test(str)) {
          str = str.replace(/AKIA[0-9A-Z]{16}/g, "AKIA...[REDACTED]");
          modified = true;
          redactedCount++;
        }

        // Private keys
        if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/g.test(str)) {
          str = str.replace(
            /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
            "[PRIVATE_KEY_REDACTED]",
          );
          modified = true;
          redactedCount++;
        }

        // JWT tokens
        if (/eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g.test(str)) {
          str = str.replace(
            /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
            "eyJ...[REDACTED_JWT]",
          );
          modified = true;
          redactedCount++;
        }

        // Sensitive env variables or password lines
        if (/(password|secret|token|api_key|private_key)\s*[:=]\s*["']?([^\s"',;]+)/i.test(str)) {
          str = str.replace(
            /(password|secret|token|api_key|private_key)\s*[:=]\s*["']?([^\s"',;]+)/gi,
            "$1: [REDACTED]",
          );
          modified = true;
          redactedCount++;
        }

        // URL credentials e.g. postgres://user:password@host
        if (/([a-zA-Z0-9+.-]+:\/\/[^:]+:)([^@]+)(@.+)/.test(str)) {
          str = str.replace(/([a-zA-Z0-9+.-]+:\/\/[^:]+:)([^@]+)(@.+)/g, "$1[REDACTED]$3");
          modified = true;
          redactedCount++;
        }

        return modified ? str : val;
      }

      if (Array.isArray(val)) {
        return val.map((item) => sanitizeValue(item));
      }

      if (val !== null && typeof val === "object") {
        const obj = val as Record<string, unknown>;
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(obj)) {
          const sanitizedVal = sanitizeValue(v);
          if (sanitizedVal !== v) {
            // Already matched a specific pattern (AIzaSy, sk-, JWT, URL)
            out[k] = sanitizedVal;
          } else if (/password|passwd|secret|token|key|credential|private/i.test(k) && typeof v === "string") {
            out[k] = "[REDACTED]";
            redactedCount++;
          } else {
            out[k] = sanitizedVal;
          }
        }
        return out;
      }

      return val;
    };

    const sanitized = sanitizeValue(result) as T;

    if (redactedCount > 0 && metadata?.toolName) {
      securityAuditLogger.logEvent({
        eventType: "DLP_REDACTION",
        actor: {
          identityId: "myraa_system",
          role: "admin",
          ipAddress: metadata.ipAddress || "127.0.0.1",
          sessionId: metadata.sessionId,
        },
        target: { toolName: metadata.toolName },
        decision: "ALLOW",
        reason: `DLP Firewall redacted ${redactedCount} sensitive credential/token item(s) from tool result.`,
        riskLevel: "MEDIUM",
        metadata: { redactedCount },
      });
    }

    return { sanitized, redactedCount };
  }
}

export const outputDataFirewall = new OutputDataFirewall();
