/**
 * MYRAA — Advanced Browser Intelligence & Adaptive Knowledge System
 * SkillProposalSecurityReviewer.ts
 *
 * Stage 6: Phase 26 Security Reviewer for Candidate Skill Proposals.
 *
 * Strict Defenses:
 *   - Scans for prompt injection attacks in names, descriptions, triggers, and parameters.
 *   - Blocks destructive system commands and arbitrary code execution vectors.
 *   - Rejects privilege escalation attempts and forbidden override keys.
 *   - Blocks SSRF, loopback, and private IP destinations.
 *   - Enforces risk classification and mandatory confirmation gates.
 */

import { contentSanitizer } from "../../security/ContentSanitizer.ts";
import { CRITICAL_TOOLS, HIGH_RISK_TOOLS } from "../../security/SecurityRiskEngine.ts";
import type {
  CandidateWorkflow,
  SkillRiskLevel,
  SkillSecurityReview,
} from "./SkillProposalTypes.ts";

export class SkillProposalSecurityReviewer {
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
    /\b(https?:\/\/)?(169\.254\.\d{1,3}\.\d{1,3})\b/, // link-local
    /\b(https?:\/\/)?(\[?::1\]?)\b/, // IPv6 loopback
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
   * Conducts authoritative Phase 26 security review of a candidate workflow proposal.
   */
  public reviewSecurity(workflow: CandidateWorkflow): SkillSecurityReview {
    const violations: string[] = [];
    let injectionDetected = false;
    let privilegeEscalationAttempt = false;
    let containsDangerousCommands = false;
    let containsPrivateIpOrSsrf = false;
    let containsForbiddenKeys = false;
    let riskScore = 0;

    // 1. Scan for Prompt Injections across all textual fields
    const textFieldsToScan = [
      workflow.name,
      workflow.description,
      workflow.intendedOutcome,
      workflow.failureRecoveryStrategy,
      ...workflow.triggerPatterns,
      ...workflow.regressionTestRequirements,
    ];

    for (const text of textFieldsToScan) {
      if (!text) continue;
      const scan = contentSanitizer.scanForPromptInjection(text);
      if (scan.hasInjectionAttempt) {
        injectionDetected = true;
        violations.push(`Prompt injection detected in workflow text: patterns=${scan.matchedPatterns.join(", ")}, snippet="${text.slice(0, 60)}"`);
        riskScore += 50;
      }
      for (const rx of this._promptInjectionPatterns) {
        if (rx.test(text)) {
          injectionDetected = true;
          violations.push(`Prompt injection detected in workflow text: pattern=${rx.source}, snippet="${text.slice(0, 60)}"`);
          riskScore += 50;
          break;
        }
      }
    }

    // 2. Scan Ordered Steps
    for (const step of workflow.orderedSteps) {
      const stepTool = step.toolName;

      // Destructive command check
      const inputStr = JSON.stringify(step.inputTemplate);
      for (const rx of this._destructiveCommandPatterns) {
        if (rx.test(inputStr)) {
          containsDangerousCommands = true;
          violations.push(`Destructive command pattern detected in step ${step.stepIndex} (${stepTool}): ${rx.source}`);
          riskScore += 60;
        }
      }

      // Forbidden override keys check
      for (const key of Object.keys(step.inputTemplate)) {
        for (const rx of this._forbiddenOverrideKeys) {
          if (rx.test(key)) {
            containsForbiddenKeys = true;
            violations.push(`Forbidden security override key detected in step ${step.stepIndex}: "${key}"`);
            riskScore += 50;
          }
        }
      }

      // Check for private IP / loopback / SSRF in inputTemplate
      for (const rx of this._privateIpPatterns) {
        if (rx.test(inputStr)) {
          containsPrivateIpOrSsrf = true;
          violations.push(`Private IP or loopback SSRF target detected in step ${step.stepIndex}: ${rx.source}`);
          riskScore += 40;
        }
      }

      // Scan parameters for injection
      const paramScan = contentSanitizer.scanForPromptInjection(inputStr);
      if (paramScan.hasInjectionAttempt) {
        injectionDetected = true;
        violations.push(`Prompt injection detected in step ${step.stepIndex} parameters (${paramScan.matchedPatterns.join(", ")})`);
        riskScore += 50;
      }
    }

    // 3. Verify Risk Classification Alignment
    let requiredSecurityLevel: SkillRiskLevel = "LOW";
    let confirmationRequired = false;

    const usesCriticalTool = workflow.orderedSteps.some((s) => CRITICAL_TOOLS.has(s.toolName));
    const usesHighRiskTool = workflow.orderedSteps.some((s) => HIGH_RISK_TOOLS.has(s.toolName));

    if (usesCriticalTool) {
      requiredSecurityLevel = "CRITICAL";
      confirmationRequired = true;
      riskScore += 30;
    } else if (usesHighRiskTool) {
      requiredSecurityLevel = "HIGH";
      confirmationRequired = true;
      riskScore += 20;
    } else if (workflow.orderedSteps.length > 3) {
      requiredSecurityLevel = "MEDIUM";
      riskScore += 10;
    }

    // If workflow claims a lower risk level than required -> privilege escalation attempt!
    if (
      (requiredSecurityLevel === "CRITICAL" && workflow.riskLevel !== "CRITICAL") ||
      (requiredSecurityLevel === "HIGH" && workflow.riskLevel === "LOW")
    ) {
      privilegeEscalationAttempt = true;
      violations.push(
        `Privilege escalation: Workflow declared riskLevel=${workflow.riskLevel}, but required security level is ${requiredSecurityLevel}.`,
      );
      riskScore += 50;
    }

    riskScore = Math.min(100, riskScore);
    const sanitizedClean = violations.length === 0;
    const verdict = sanitizedClean ? "PASSED" : "REJECTED";

    return {
      verdict,
      riskScore,
      reviewTimestamp: Date.now(),
      reviewer: "Phase26SecurityAuthority",
      injectionDetected,
      privilegeEscalationAttempt,
      containsDangerousCommands,
      containsPrivateIpOrSsrf,
      containsForbiddenKeys,
      sanitizedClean,
      requiredSecurityLevel,
      confirmationRequired,
      violations,
    };
  }
}

export const skillProposalSecurityReviewer = new SkillProposalSecurityReviewer();
