/**
 * MYRAA — Step 8: Advanced Browser Research Agent
 * ResearchSecurityGate
 *
 * Security invariant: ALL web content = UNTRUSTED_EXTERNAL_CONTENT.
 * This gate enforces:
 *   1. Prompt-injection detection & neutralization (via existing ContentSanitizer)
 *   2. SSRF-safe URL validation (via existing PermissionManager)
 *   3. Secret redaction from fetched content
 *   4. Audit trail for all security events
 *
 * Researcher CANNOT bypass this gate. No research action executes without
 * passing through the SecurityPolicyEngine.
 */

import { contentSanitizer } from "../security/ContentSanitizer.ts";
import { isSsrfSafeUrl } from "../security/PermissionManager.ts";
import { securityAuditLogger } from "../security/SecurityAuditLogger.ts";
import { multiAgentContextManager } from "../multiagent/MultiAgentContextManager.ts";

export interface ResearchSecurityCheckResult {
  allowed: boolean;
  reason: string;
  sanitizedContent?: string;
  injectionDetected: boolean;
  redactedSecrets: boolean;
}

// Known malicious prompt-injection patterns that specifically target research agents
const RESEARCH_INJECTION_PATTERNS: RegExp[] = [
  /ignore\s+(previous|prior|all)\s+(instructions?|rules?|prompts?)/gi,
  /run\s+this\s+command/gi,
  /upload\s+(your|the)\s+\.env/gi,
  /send\s+(api\s+key|apikey|token|secret)/gi,
  /disable\s+security/gi,
  /system\s+prompt\s*(=|:|\?)/gi,
  /reveal\s+(your\s+)?(instructions?|system|prompt)/gi,
  /act\s+as\s+(?:an?\s+)?(?:unrestricted|uncensored|dan|jailbroken)/gi,
  /you\s+are\s+now\s+(?:in\s+)?(?:developer|god|admin|root)\s+mode/gi,
  /\[\s*tool_call\s*\]/gi,
  /\{\s*"tool"\s*:/gi,
];

export class ResearchSecurityGate {
  /**
   * Validates a URL is safe to fetch (no SSRF, no private IPs, no localhost).
   * Localhost research is allowed only for project bridge (local files, not HTTP).
   */
  public async validateUrl(url: string): Promise<{ safe: boolean; reason: string }> {
    try {
      const parsed = new URL(url);
      // Allow only http/https
      if (!["http:", "https:"].includes(parsed.protocol)) {
        return { safe: false, reason: `Protocol not allowed: ${parsed.protocol}` };
      }

      const result = await isSsrfSafeUrl(url);
      if (!result.safe) {
        securityAuditLogger.logEvent({
          eventType: "UNUSUAL_NETWORK_REQUEST",
          actor: { identityId: "research_agent", role: "standard", ipAddress: "127.0.0.1" },
          target: { resource: url },
          decision: "BLOCK",
          reason: `Research gate blocked SSRF-risky URL: ${url}`,
          riskLevel: "HIGH",
        });
        return { safe: false, reason: result.reason || "URL failed SSRF safety check" };
      }

      return { safe: true, reason: "URL passed all security checks" };
    } catch (err: any) {
      return { safe: false, reason: `Invalid URL: ${err?.message}` };
    }
  }

  /**
   * Sanitizes fetched web content — strips prompt injections and secrets,
   * wraps in UNTRUSTED_WEB boundary markers.
   */
  public sanitizeWebContent(rawContent: string, sourceUrl: string): ResearchSecurityCheckResult {
    if (!rawContent || typeof rawContent !== "string") {
      return {
        allowed: false,
        reason: "Empty or invalid content",
        injectionDetected: false,
        redactedSecrets: false,
      };
    }

    // 1. Detect research-specific injections
    let injectionDetected = false;
    let sanitized = rawContent;
    for (const pattern of RESEARCH_INJECTION_PATTERNS) {
      if (pattern.test(rawContent)) {
        injectionDetected = true;
        sanitized = sanitized.replace(pattern, "[INJECTION_ATTEMPT_NEUTRALIZED]");
        securityAuditLogger.logEvent({
          eventType: "SECURITY_POLICY_VIOLATION",
          actor: { identityId: "research_agent", role: "standard", ipAddress: "external" },
          target: { resource: sourceUrl },
          decision: "BLOCK",
          reason: `Prompt injection detected in web content from: ${sourceUrl}`,
          riskLevel: "HIGH",
        });
      }
    }

    // 2. Run through ContentSanitizer (existing system) — sanitizeWebContent wraps in UNTRUSTED_WEB fencing
    const sandboxResult = contentSanitizer.sanitizeWebContent(sanitized, { url: sourceUrl });
    sanitized = sandboxResult.injectionScan.sanitizedText;

    // 3. Redact any leaked secrets
    const redacted = multiAgentContextManager.redactSecrets(sanitized);
    const redactedSecrets = redacted !== sanitized;
    sanitized = redacted;

    // 4. Truncate to 50KB max per source to prevent context flooding
    const MAX_CONTENT_BYTES = 50_000;
    if (sanitized.length > MAX_CONTENT_BYTES) {
      sanitized = sanitized.slice(0, MAX_CONTENT_BYTES) + "\n[CONTENT_TRUNCATED_FOR_SAFETY]";
    }

    return {
      allowed: true,
      reason: "Content sanitized and sandboxed",
      sanitizedContent: sanitized,
      injectionDetected,
      redactedSecrets,
    };
  }

  /**
   * Validates a research claim before adding it to the evidence chain.
   * Ensures the claim text itself does not contain injection attempts.
   */
  public validateClaim(claimText: string): { valid: boolean; sanitizedClaim: string } {
    let hasInjection = false;
    for (const pattern of RESEARCH_INJECTION_PATTERNS) {
      if (pattern.test(claimText)) {
        hasInjection = true;
        break;
      }
    }
    if (claimText.includes("[DISARMED_INJECTION_PHRASE]") || claimText.includes("[DEFANGED_")) {
      hasInjection = true;
    }
    if (hasInjection) {
      return { valid: false, sanitizedClaim: "[CLAIM_REJECTED_INJECTION_DETECTED]" };
    }

    const sanitized = multiAgentContextManager.sanitizeUntrustedInput(claimText);
    // Truncate individual claims to 2KB
    const truncated = sanitized.length > 2000 ? sanitized.slice(0, 2000) + "…" : sanitized;
    return { valid: true, sanitizedClaim: truncated };
  }
}

export const researchSecurityGate = new ResearchSecurityGate();
