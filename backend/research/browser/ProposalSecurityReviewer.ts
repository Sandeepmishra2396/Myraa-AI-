/**
 * MYRAA — Advanced Browser Intelligence & Adaptive Knowledge System
 * ProposalSecurityReviewer.ts
 *
 * Stage 5: Security Review Stage.
 *
 * Enforces Phase 26 Security Authority Separation for knowledge and skill proposals:
 *   - Aggressively scans for prompt injection and jailbreak payloads.
 *   - Detects forbidden privilege escalation, bypass keys, and self-approval flags.
 *   - Prohibits destructive system commands and arbitrary code execution.
 *   - Detects SSRF vectors targeting loopback or private network infrastructure.
 *   - INVARIANT: Any detected security violation results in immediate REJECTION.
 */

import type {
  AdaptiveProposal,
  SecurityReviewRecord,
  SecurityReviewVerdict,
} from "./AdaptiveIngestionTypes.ts";

/**
 * Disallowed keys in proposals attempting to smuggle security overrides or privileges.
 */
const FORBIDDEN_OVERRIDE_KEYS = new Set<string>([
  "bypasssecurity",
  "forceexecute",
  "skipconfirmation",
  "overriderisk",
  "adminexecute",
  "elevated",
  "elevateprivilege",
  "ignorefirewall",
  "ignorelockdown",
  "ignoreemergencystop",
  "allowbypass",
  "skipvalidation",
  "trustmodel",
  "root",
  "sudo",
  "superuser",
  "bypassrbac",
  "bypasspolicy",
  "bypasssandbox",
  "selfapprove",
  "autoapprove",
  "unrestricted",
]);

/**
 * Dangerous shell/OS command fragments that indicate sabotage or host attacks.
 */
const DESTRUCTIVE_COMMAND_PATTERNS: RegExp[] = [
  /\brm\s+-(?:r|f|rf|fr)\s+[/~*]/i,
  /\bdrop\s+(?:table|database|schema)\b/i,
  /\btruncate\s+(?:table)?\b/i,
  /\bformat\s+[a-z]:/i,
  /\bkill\s+-9\s+1\b/i,
  /\bshutdown\s+-[rshf]\b/i,
  /\bmkfs\b/i,
  /\bdd\s+if=\/dev\/zero\b/i,
  /\b(del|erase)\s+\/[fq]\s+[a-z]:/i,
];

/**
 * Prompt injection signatures attempting to hijack assistant governance.
 */
const PROMPT_INJECTION_PATTERNS: RegExp[] = [
  /system\s+instructions?:/i,
  /ignore\s+(?:all\s+)?previous\s+instructions/i,
  /disregard\s+(?:all\s+)?prior\s+guidelines/i,
  /you\s+are\s+now\s+in\s+developer\s+mode/i,
  /dan\s+mode\s+enabled/i,
  /bypass\s+(?:security|safety)\s+protocols/i,
  /grant\s+(?:admin|root|superuser)\s+access/i,
  /exfiltrate\s+(?:token|key|password|secret)/i,
];

/**
 * Loopback and private IP SSRF patterns.
 */
const SSRF_TARGET_PATTERNS: RegExp[] = [
  /\b(?:127\.\d{1,3}\.\d{1,3}\.\d{1,3})\b/,
  /\blocalhost\b/i,
  /\b(?:169\.254\.\d{1,3}\.\d{1,3})\b/,
  /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3})\b/,
  /\b(?:192\.168\.\d{1,3}\.\d{1,3})\b/,
  /\b(?:172\.(?:1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3})\b/,
];

export class ProposalSecurityReviewer {
  /**
   * Scans a proposal for prompt injections, privilege escalations, and destructive actions.
   */
  public review(proposal: AdaptiveProposal): SecurityReviewRecord {
    const securityConcerns: string[] = [];
    const forbiddenKeysDetected: string[] = [];
    let injectionDetected = false;
    let privilegeEscalationAttempt = false;
    let riskScore = 0.05; // Base baseline risk
    let verdict: SecurityReviewVerdict = "APPROVED";

    const stringified = JSON.stringify(proposal).toLowerCase();

    // ── 1. Forbidden Key Scanning ─────────────────────────────────────────────
    for (const forbidden of FORBIDDEN_OVERRIDE_KEYS) {
      if (stringified.includes(`"${forbidden}"`) || stringified.includes(`"${forbidden}:`)) {
        forbiddenKeysDetected.push(forbidden);
        privilegeEscalationAttempt = true;
        securityConcerns.push(`Smuggled forbidden override key detected: "${forbidden}".`);
        riskScore = Math.max(riskScore, 0.95);
        verdict = "REJECTED";
      }
    }

    // Check payload attributes directly
    if (proposal.payload.kind === "KNOWLEDGE") {
      const attrs = proposal.payload.attributes || {};
      for (const key of Object.keys(attrs)) {
        if (FORBIDDEN_OVERRIDE_KEYS.has(key.toLowerCase())) {
          forbiddenKeysDetected.push(key);
          privilegeEscalationAttempt = true;
          securityConcerns.push(`Forbidden attribute key "${key}" detected in knowledge payload.`);
          riskScore = 1.0;
          verdict = "REJECTED";
        }
      }
    }

    // ── 2. Prompt Injection Scanning ──────────────────────────────────────────
    const targetTexts: string[] = [
      proposal.title,
      proposal.description,
      proposal.payload.kind === "KNOWLEDGE" ? proposal.payload.summary : proposal.payload.description,
      ...proposal.provenance.sourceExcerpts,
    ];

    if (proposal.payload.kind === "SKILL") {
      targetTexts.push(...proposal.payload.triggerPatterns);
      for (const step of proposal.payload.workflowSteps) {
        targetTexts.push(step.action, JSON.stringify(step.params));
      }
    }

    for (const text of targetTexts) {
      if (!text) continue;
      for (const pattern of PROMPT_INJECTION_PATTERNS) {
        if (pattern.test(text)) {
          injectionDetected = true;
          securityConcerns.push(`Prompt injection signature detected: "${pattern.source}".`);
          riskScore = 1.0;
          verdict = "REJECTED";
          break;
        }
      }
    }

    // ── 3. Destructive Command Scanning ───────────────────────────────────────
    for (const text of targetTexts) {
      if (!text) continue;
      for (const pattern of DESTRUCTIVE_COMMAND_PATTERNS) {
        if (pattern.test(text)) {
          securityConcerns.push(`Destructive host command signature detected: "${pattern.source}".`);
          riskScore = 1.0;
          verdict = "REJECTED";
          break;
        }
      }
    }

    // ── 4. SSRF & Loopback Target Scanning in Skill Actions ────────────────────
    if (proposal.payload.kind === "SKILL") {
      for (const step of proposal.payload.workflowSteps) {
        const stepStr = JSON.stringify(step.params);
        for (const pattern of SSRF_TARGET_PATTERNS) {
          if (pattern.test(stepStr)) {
            securityConcerns.push(`SSRF target to private/loopback network detected in step "${step.stepId}".`);
            riskScore = 0.95;
            verdict = "REJECTED";
            break;
          }
        }
      }

      // Check required permissions
      if (proposal.payload.requiredPermissions.some((p) => /root|admin|superuser|all/i.test(p))) {
        privilegeEscalationAttempt = true;
        securityConcerns.push("Excessive or root-level permissions requested by candidate skill.");
        riskScore = 0.90;
        verdict = "REJECTED";
      }

      // Non-sandboxed skill check
      if (!proposal.payload.sandboxed) {
        securityConcerns.push("Candidate skill is not declared as sandboxed.");
        riskScore = Math.max(riskScore, 0.70);
        verdict = "REJECTED";
      }
    }

    // ── 5. Arbitrary Code Evaluation Scanning ─────────────────────────────────
    if (/\b(eval\s*\(|new\s+Function\s*\(|child_process|execSync)\b/i.test(stringified)) {
      securityConcerns.push("Arbitrary code evaluation pattern detected in proposal.");
      riskScore = 1.0;
      verdict = "REJECTED";
    }

    return {
      verdict,
      riskScore,
      securityConcerns,
      injectionDetected,
      privilegeEscalationAttempt,
      forbiddenKeysDetected: [...new Set(forbiddenKeysDetected)],
      reviewedAt: Date.now(),
    };
  }
}

export const proposalSecurityReviewer = new ProposalSecurityReviewer();
