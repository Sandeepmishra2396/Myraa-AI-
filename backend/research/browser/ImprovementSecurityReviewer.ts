/**
 * MYRAA — Advanced Browser Intelligence & Adaptive Knowledge System
 * ImprovementSecurityReviewer.ts
 *
 * Stage 7: Phase 26 Security Reviewer for Self-Improvement Candidates.
 *
 * Defenses:
 *   - Scans candidate payload for prompt injection, jailbreaks, and persona overrides.
 *   - Blocks destructive system commands and hostile code execution vectors.
 *   - Rejects privilege escalation keys and security bypass flags.
 *   - Blocks private IP, loopback, and SSRF targets.
 *   - Confirms hard safety gates were not breached during evaluation.
 */

import { contentSanitizer } from "../../security/ContentSanitizer.ts";
import type {
  EvaluationReport,
  ImprovementCandidate,
  ImprovementSecurityReview,
} from "./SelfImprovementTypes.ts";

export class ImprovementSecurityReviewer {
  private readonly _destructiveCommandPatterns: RegExp[] = [
    /\brm\s+(-[rfRF]{1,3}\b|--recursive|--force)/,
    /\bformat\s+[a-zA-Z]:/i,
    /\bdel\s+(\/[fFqQsS]\s+)+[a-zA-Z*?]/i,
    /\bmkfs(\.[a-zA-Z0-9]+)?\b/,
    /\bdd\s+if=.*of=\/dev/i,
    /\bchmod\s+(-R\s+)?777\b/,
    />\s*\/dev\/sd[a-z]/,
  ];

  private readonly _forbiddenOverrideKeys: RegExp[] = [
    /^(bypassSecurity|disableFirewall|grantAdmin|selfApprove|allowSelfApproval|overridePolicy|isPrivileged|rootAccess)$/i,
    /^(elevateRole|disableAudit|unrestrictedExecution|skipConfirmation)$/i,
  ];

  private readonly _privateIpPatterns: RegExp[] = [
    /\b(https?:\/\/)?(127\.0\.0\.1|localhost|0\.0\.0\.0)\b/i,
    /\b(https?:\/\/)?(192\.168\.\d{1,3}\.\d{1,3})\b/,
    /\b(https?:\/\/)?(10\.\d{1,3}\.\d{1,3}\.\d{1,3})\b/,
    /\b(https?:\/\/)?(172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/,
    /\b(https?:\/\/)?(169\.254\.\d{1,3}\.\d{1,3})\b/,
    /\b(https?:\/\/)?(\[?::1\]?)\b/,
  ];

  private readonly _promptInjectionPatterns: RegExp[] = [
    /system\s+instructions?:/i,
    /ignore\s+(?:all\s+)?previous\s+instructions/i,
    /disregard\s+(?:all\s+)?prior\s+guidelines/i,
    /you\s+are\s+now\s+in\s+developer\s+mode/i,
    /\bdeveloper\s+mode\b/i,
    /\bdan\s+mode\b/i,
    /bypass\s+(?:security|safety)\s+protocols/i,
    /\bbypass\s+security\b/i,
    /grant\s+(?:admin|root|superuser)\s+access/i,
    /exfiltrate\s+(?:token|key|password|secret)/i,
  ];

  /**
   * Conducts authoritative Phase 26 security review of an improvement candidate.
   */
  public reviewSecurity(
    candidate: ImprovementCandidate,
    report?: EvaluationReport,
  ): ImprovementSecurityReview {
    const violations: string[] = [];
    let injectionDetected = false;
    let privilegeEscalationAttempt = false;
    let containsDangerousCommands = false;
    let containsPrivateIpOrSsrf = false;
    let containsForbiddenKeys = false;
    let riskScore = 0;

    // 1. Verify Hard Safety Gate Outcome from Evaluation
    if (report && (!report.hardSafetyPassed || report.hardSafetyViolationsCount > 0)) {
      violations.push(
        `EVALUATION_HARD_SAFETY_FAILURE: Candidate failed ${report.hardSafetyViolationsCount} hard safety fixtures.`,
      );
      riskScore += 70;
    }

    // 2. Scan Proposed Payload for Malicious Injections & Destructive Patterns
    const payloadStr = JSON.stringify(candidate.proposedPayload);

    // Prompt injection check
    const scan = contentSanitizer.scanForPromptInjection(payloadStr);
    if (scan.hasInjectionAttempt) {
      injectionDetected = true;
      violations.push(`Prompt injection detected in candidate payload (${scan.matchedPatterns.join(", ")})`);
      riskScore += 50;
    }

    for (const rx of this._promptInjectionPatterns) {
      if (rx.test(payloadStr)) {
        injectionDetected = true;
        violations.push(`Prompt injection detected in candidate payload: pattern=${rx.source}`);
        riskScore += 50;
        break;
      }
    }

    // Destructive commands check
    for (const rx of this._destructiveCommandPatterns) {
      if (rx.test(payloadStr)) {
        containsDangerousCommands = true;
        violations.push(`Destructive command detected in candidate payload: ${rx.source}`);
        riskScore += 60;
      }
    }

    // Forbidden override keys check
    for (const key of Object.keys(candidate.proposedPayload)) {
      for (const rx of this._forbiddenOverrideKeys) {
        if (rx.test(key)) {
          containsForbiddenKeys = true;
          violations.push(`Forbidden override key detected in candidate payload: "${key}"`);
          riskScore += 50;
        }
      }
    }

    // SSRF / Loopback check
    for (const rx of this._privateIpPatterns) {
      if (rx.test(payloadStr)) {
        containsPrivateIpOrSsrf = true;
        violations.push(`Private IP or loopback SSRF target detected in candidate payload: ${rx.source}`);
        riskScore += 40;
      }
    }

    // Text field checks (name, description, rationale)
    const textFields = [candidate.name, candidate.description, candidate.provenance.rationale];
    for (const text of textFields) {
      for (const rx of this._promptInjectionPatterns) {
        if (rx.test(text)) {
          injectionDetected = true;
          violations.push(`Prompt injection in metadata: ${rx.source}`);
          riskScore += 40;
          break;
        }
      }
    }

    riskScore = Math.min(100, riskScore);
    const sanitizedClean = violations.length === 0;
    const verdict = sanitizedClean ? "PASSED" : "REJECTED";

    return {
      verdict,
      riskScore,
      reviewedAt: Date.now(),
      reviewer: "Phase26SecurityAuthority",
      injectionDetected,
      privilegeEscalationAttempt,
      containsDangerousCommands,
      containsPrivateIpOrSsrf,
      containsForbiddenKeys,
      sanitizedClean,
      violations,
    };
  }
}

export const improvementSecurityReviewer = new ImprovementSecurityReviewer();
