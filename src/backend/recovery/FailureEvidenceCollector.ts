/**
 * MYRAA — Phase 25: Self-Correction & Failure Recovery Engine
 * FailureEvidenceCollector
 *
 * Gathers failure evidence from tool execution outcomes, exit codes, stdout/stderr,
 * and system context while strictly redacting sensitive tokens and secrets.
 * Categorizes evidence by epistemic status (OBSERVED_FACT vs INFERENCE).
 */

import crypto from "crypto";
import type {
  FailureEvidence,
  FailureEvent,
  FailureSeverity,
  FailureErrorType,
  EpistemicStatus,
} from "./SelfCorrectionTypes.ts";

export class FailureEvidenceCollector {
  private static readonly SECRET_PATTERNS = [
    /AIza[0-9A-Za-z-_]{30,45}/g, // Google API keys
    /sk-[0-9A-Za-z]{30,}/g, // OpenAI/Standard API keys
    /ghp_[0-9A-Za-z]{30,}/g, // GitHub tokens
    /Bearer\s+[A-Za-z0-9\-_.]+/gi, // Bearer tokens
    /password["']?\s*[:=]\s*["']?[^"'\s,]+/gi, // Passwords in json/cli
    /api[_-]?key["']?\s*[:=]\s*["']?[^"'\s,]+/gi, // Api key in json/cli
    /secret["']?\s*[:=]\s*["']?[^"'\s,]+/gi, // Secrets
  ];

  /**
   * Redacts sensitive secrets, credentials, and tokens from strings.
   */
  public redactSecrets(input: string): string {
    if (!input || typeof input !== "string") return "";
    let sanitized = input;
    for (const pattern of FailureEvidenceCollector.SECRET_PATTERNS) {
      sanitized = sanitized.replace(pattern, "[REDACTED_SECRET]");
    }
    return sanitized;
  }

  /**
   * Builds a structured FailureEvidence entry.
   */
  public createEvidence(
    key: string,
    value: unknown,
    source: string,
    epistemicStatus: EpistemicStatus = "OBSERVED_FACT"
  ): FailureEvidence {
    const sanitizedVal =
      typeof value === "string"
        ? this.redactSecrets(value)
        : typeof value === "object" && value !== null
        ? JSON.parse(this.redactSecrets(JSON.stringify(value)))
        : value;

    return {
      key: this.redactSecrets(key),
      value: sanitizedVal,
      source: this.redactSecrets(source),
      epistemicStatus,
      timestamp: Date.now(),
    };
  }

  /**
   * Compiles a complete FailureEvent from execution telemetry.
   */
  public collectFailure(params: {
    actionId?: string;
    taskId?: string;
    toolName?: string;
    operation: string;
    errorType: FailureErrorType;
    exitCode?: number;
    stdout?: string;
    stderr?: string;
    errorMessage?: string;
    targetResource?: string;
    severity?: FailureSeverity;
    confidence?: number;
    context?: Record<string, unknown>;
  }): FailureEvent {
    const id = `fail_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`;
    const actionId = params.actionId || `act_${Date.now()}`;
    const evidenceList: FailureEvidence[] = [];

    // 1. Observed exit code
    if (typeof params.exitCode === "number") {
      evidenceList.push(
        this.createEvidence(
          "exitCode",
          params.exitCode,
          params.toolName || "process",
          "OBSERVED_FACT"
        )
      );
    }

    // 2. Observed stdout
    if (params.stdout) {
      const sanitizedOut = this.redactSecrets(params.stdout.slice(-1000));
      evidenceList.push(
        this.createEvidence(
          "stdoutSnippet",
          sanitizedOut,
          params.toolName || "process",
          "OBSERVED_FACT"
        )
      );
    }

    // 3. Observed stderr
    if (params.stderr) {
      const sanitizedErr = this.redactSecrets(params.stderr.slice(-1000));
      evidenceList.push(
        this.createEvidence(
          "stderrSnippet",
          sanitizedErr,
          params.toolName || "process",
          "OBSERVED_FACT"
        )
      );
    }

    // 4. Observed error message
    if (params.errorMessage) {
      evidenceList.push(
        this.createEvidence(
          "errorMessage",
          this.redactSecrets(params.errorMessage),
          params.toolName || "runtime",
          "OBSERVED_FACT"
        )
      );
    }

    // 5. Target resource
    if (params.targetResource) {
      evidenceList.push(
        this.createEvidence(
          "targetResource",
          this.redactSecrets(params.targetResource),
          "parameters",
          "OBSERVED_FACT"
        )
      );
    }

    // 6. Context variables
    if (params.context) {
      for (const [k, v] of Object.entries(params.context)) {
        evidenceList.push(
          this.createEvidence(k, v, "context", "OBSERVED_FACT")
        );
      }
    }

    return {
      id,
      actionId,
      taskId: params.taskId,
      toolName: params.toolName,
      operation: params.operation,
      timestamp: Date.now(),
      errorType: params.errorType,
      exitCode: params.exitCode,
      stdout: params.stdout ? this.redactSecrets(params.stdout.slice(-2000)) : undefined,
      stderr: params.stderr ? this.redactSecrets(params.stderr.slice(-2000)) : undefined,
      errorMessage: params.errorMessage ? this.redactSecrets(params.errorMessage) : undefined,
      evidence: evidenceList,
      confidence: params.confidence ?? 0.9,
      severity: params.severity || "MEDIUM",
      targetResource: params.targetResource ? this.redactSecrets(params.targetResource) : undefined,
      context: params.context,
    };
  }
}

export const failureEvidenceCollector = new FailureEvidenceCollector();
