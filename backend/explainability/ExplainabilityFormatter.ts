/**
 * MYRAA — ExplainabilityFormatter (Stage 10.7)
 *
 * Grounded formatting, secret scrubbing, prompt-injection defanging,
 * and safe explanation generation:
 *   - Strictly redacts secrets, credentials, API keys, tokens, and private keys
 *   - Defangs untrusted prompt-injection text embedded in evidence
 *   - Normalizes security reasons into safe, user-understandable categories
 *   - Emits safe next steps without ever recommending security bypasses
 *   - Never mutates underlying source records
 */

import {
  MAX_EXPLANATION_TEXT_LENGTH,
  MAX_REASON_LENGTH,
  SecurityReasonCategory,
  TaskReasonCategory,
  ReminderReasonCategory,
} from "./ExplainabilityTypes.ts";

export class ExplainabilityFormatter {
  /**
   * Deeply sanitizes any value for presentation.
   * Strips credentials, API keys, tokens, and defangs prompt injection.
   * Returns a clean clone without mutating the source input.
   */
  sanitizeForExplanation<T>(input: T): { result: T; success: boolean } {
    try {
      const cloned = JSON.parse(JSON.stringify(input));
      const cleaned = this._recursiveSanitize(cloned);
      return { result: cleaned as T, success: true };
    } catch {
      // Fail closed if serialization or redaction fails
      return { result: "[REDACTION_ERROR_SAFEGUARD]" as unknown as T, success: false };
    }
  }

  /**
   * Sanitizes text strings for secrets and prompt injection phrases.
   */
  sanitizeText(input: string): string {
    if (typeof input !== "string") return "";

    let str = input;

    // Mask Gemini / Google API keys
    str = str.replace(/AIza[0-9A-Za-z\-_]{16,}/g, "AIza...[REDACTED]");
    // Mask sora_* tokens
    str = str.replace(/sora_[A-Za-z0-9_\-.]+/gi, "sora_...[REDACTED]");
    // Mask myraa_* tokens
    str = str.replace(/myraa_[A-Za-z0-9_\-.]+/gi, "myraa_...[REDACTED]");
    // Mask sk- keys (OpenAI / Anthropic)
    str = str.replace(/sk-[A-Za-z0-9_-]{20,}/g, "sk-...[REDACTED]");
    // Mask JWT base64url payloads
    str = str.replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?/g, "eyJ...[REDACTED]");
    // Mask Bearer tokens
    str = str.replace(/Bearer\s+[A-Za-z0-9_\-\.]+/gi, "Bearer [REDACTED]");
    // Mask GitHub tokens
    str = str.replace(/gh[pousr]_[A-Za-z0-9_]{36,}/g, "gh_...[REDACTED]");
    // Mask AWS Access Keys
    str = str.replace(/AKIA[0-9A-Z]{16}/g, "AKIA...[REDACTED]");
    // Mask private keys
    str = str.replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[PRIVATE_KEY_REDACTED]");
    // Mask SSN & Credit cards
    str = str.replace(/\b\d{3}-\d{2}-\d{4}\b/g, "[SSN_REDACTED]");
    str = str.replace(/\b(?:\d{4}-){3}\d{4}\b/g, "[CC_REDACTED]");

    // Mask credential values in key-value structures
    str = str.replace(
      /(password|passwd|passcode|secret|token|checkpointId|_checkpointId|apiKey|api_key|proof|authorization|credential)["']?\s*[:=]\s*["']?([^"',\s}]+)/gi,
      "$1: [REDACTED]",
    );

    // Defang prompt injection instruction phrases
    str = str.replace(
      /\b(ignore\s+(all\s+)?previous\s+instructions|disregard\s+all\s+rules|developer\s+mode|admin\s+override|now\s+act\s+as)\b|system\s+prompt\s*:/gi,
      "[DEFANGED_INSTRUCTION]",
    );

    // Bound maximum text length
    if (str.length > MAX_EXPLANATION_TEXT_LENGTH) {
      str = str.slice(0, MAX_EXPLANATION_TEXT_LENGTH) + "… [TRUNCATED]";
    }

    return str;
  }

  private _recursiveSanitize(obj: any): any {
    if (obj === null || obj === undefined) return obj;

    if (typeof obj === "string") {
      return this.sanitizeText(obj);
    }

    if (Array.isArray(obj)) {
      return obj.map((item) => this._recursiveSanitize(item));
    }

    if (typeof obj === "object") {
      const sanitizedObj: Record<string, any> = {};
      for (const [key, value] of Object.entries(obj)) {
        // Redact values for sensitive property keys directly
        if (/token|password|secret|auth|bearer|apiKey|api_key|credential|signature|hash/i.test(key) && key !== "deliveryKey") {
          if (key === "hash" || key === "prevHash" || key === "contentHash") {
            // Keep verification hashes if they are standard sha256 digests
            sanitizedObj[key] = typeof value === "string" && /^[a-f0-9]{64}$/i.test(value)
              ? value
              : "[REDACTED_HASH]";
          } else {
            sanitizedObj[key] = "[REDACTED]";
          }
        } else {
          sanitizedObj[key] = this._recursiveSanitize(value);
        }
      }
      return sanitizedObj;
    }

    return obj;
  }

  /**
   * Normalizes raw security audit events and recorded reasons into standard categories.
   */
  classifySecurityReason(params: {
    decision?: string;
    eventType?: string;
    reason?: string;
  }): SecurityReasonCategory {
    const dec = (params.decision || "").toUpperCase();
    const event = (params.eventType || "").toUpperCase();
    const reason = (params.reason || "");

    if (reason.includes("EMERGENCY_STOP") || event.includes("EMERGENCY_STOP")) {
      return "EMERGENCY_STOP_ACTIVE";
    }
    if (reason.includes("SECURITY_LOCKDOWN") || dec === "LOCKDOWN" || event.includes("LOCKDOWN")) {
      return "SECURITY_LOCKDOWN_ACTIVE";
    }
    if (reason.includes("TOOL_DISABLED") || event.includes("TOOL_DISABLED")) {
      return "TOOL_DISABLED";
    }
    if (reason.includes("CONTAINMENT") || dec === "CONTAINMENT") {
      return "CONTAINMENT_ACTIVE";
    }
    if (reason.includes("PERMISSION_DENIED") || reason.includes("Role '")) {
      return "ROLE_PERMISSION_DENIED";
    }
    if (reason.includes("CRITICAL_SECURITY_BLOCK") || reason.includes("Malicious/suspicious pattern")) {
      return "CRITICAL_PATTERN_BLOCKED";
    }
    if (reason.includes("path") && (reason.includes("traversal") || reason.includes("outside the active workspace"))) {
      return "PATH_TRAVERSAL_BLOCKED";
    }
    if (event === "PATH_TRAVERSAL_ATTEMPT") {
      return "PATH_TRAVERSAL_BLOCKED";
    }
    if (reason.includes("CONFIRMATION_EXPIRED") || reason.includes("token expired") || reason.includes("expired")) {
      return "CONFIRMATION_EXPIRED";
    }
    if (reason.includes("CONFIRMATION_REVOKED") || reason.includes("token was revoked") || reason.includes("revoked")) {
      return "CONFIRMATION_REVOKED";
    }
    if (reason.includes("CONFIRMATION_INVALID") || reason.includes("argsHash mismatch")) {
      return "CONFIRMATION_INVALID";
    }
    if (dec === "REQUIRE_CONFIRMATION" || dec === "CONFIRMATION_REQUIRED" || event === "TOOL_REQUIRE_CONFIRMATION") {
      return "CONFIRMATION_REQUIRED";
    }
    if (reason.includes("Tool execution failed") || reason.includes("execution failed")) {
      return "EXECUTION_FAILED";
    }
    if (event === "DLP_REDACTION") {
      return "DLP_OUTPUT_REDACTED";
    }
    if (dec === "ALLOW" || event === "TOOL_ALLOW" || event === "TOOL_CONFIRMED") {
      return "ALLOWED";
    }

    return "UNKNOWN_DECISION";
  }

  /**
   * Generates a safe, factual interpretation for a security decision.
   */
  generateSecurityInterpretation(category: SecurityReasonCategory, details: {
    toolName?: string;
    role?: string;
    reason?: string;
  }): { interpretation: string; safeNextSteps: string[] } {
    const tool = details.toolName ? `'${details.toolName}'` : "the requested tool";
    const role = details.role ? `'${details.role}'` : "the current role";

    switch (category) {
      case "ALLOWED":
        return {
          interpretation: `Action was permitted under current security policy and role permissions.`,
          safeNextSteps: [],
        };
      case "ROLE_PERMISSION_DENIED":
        return {
          interpretation: `Action was blocked because role ${role} lacks permission to execute ${tool}.`,
          safeNextSteps: [
            "Request the required role privileges from the workspace administrator.",
            "Verify whether a non-modifying read-only alternative tool is available.",
          ],
        };
      case "CRITICAL_PATTERN_BLOCKED":
        return {
          interpretation: `Action was blocked because the request contained a potentially dangerous command or pattern prohibited by security policy.`,
          safeNextSteps: [
            "Review command arguments and remove hazardous shell or execution flags.",
            "Consult security guidelines for approved syntax and command templates.",
          ],
        };
      case "PATH_TRAVERSAL_BLOCKED":
        return {
          interpretation: `Action was blocked because the targeted file path resolves outside authorized workspace boundaries.`,
          safeNextSteps: [
            "Specify a relative path situated strictly within the active workspace root.",
          ],
        };
      case "CONFIRMATION_REQUIRED":
        return {
          interpretation: `Action requires explicit human confirmation before execution because it is classified as a state-altering or high-risk operation.`,
          safeNextSteps: [
            "Review the proposed parameters and confirm the operation via the user confirmation dialog.",
          ],
        };
      case "CONFIRMATION_INVALID":
        return {
          interpretation: `Action was blocked because the confirmation token did not match the current parameters or was tampered with.`,
          safeNextSteps: [
            "Re-issue the request and confirm with matching arguments without manual modification.",
          ],
        };
      case "CONFIRMATION_EXPIRED":
        return {
          interpretation: `Action was blocked because the confirmation token expired before execution was dispatched.`,
          safeNextSteps: [
            "Re-issue the operation and confirm within the active 10-minute confirmation window.",
          ],
        };
      case "CONFIRMATION_REVOKED":
        return {
          interpretation: `Action was blocked because the confirmation token was explicitly revoked prior to execution.`,
          safeNextSteps: [
            "Re-evaluate the operation and request fresh confirmation if still intended.",
          ],
        };
      case "EMERGENCY_STOP_ACTIVE":
        return {
          interpretation: `Action was halted because Emergency Stop is currently active across the system.`,
          safeNextSteps: [
            "Wait for the active incident to clear, or reset the Emergency Stop via the authorized recovery tool if you are an administrator.",
          ],
        };
      case "SECURITY_LOCKDOWN_ACTIVE":
        return {
          interpretation: `Action was blocked because the system is in fail-closed Security Lockdown mode.`,
          safeNextSteps: [
            "Only approved emergency recovery tools are permitted until an administrator resets the lockdown.",
          ],
        };
      case "TOOL_DISABLED":
        return {
          interpretation: `Action was blocked because ${tool} has been dynamically disabled by automated security containment.`,
          safeNextSteps: [
            "Contact a system administrator to review the containment event and re-enable the tool if safe.",
          ],
        };
      case "EXECUTION_FAILED":
        return {
          interpretation: `The security pipeline permitted the action, but tool execution encountered a runtime or environment error.`,
          safeNextSteps: [
            "Inspect error message details, verify prerequisite files or environments, and retry.",
          ],
        };
      default:
        return {
          interpretation: `The request was evaluated by security policy: ${details.reason || "Outcome recorded in audit ledger."}`,
          safeNextSteps: [],
        };
    }
  }

  /**
   * Generates a safe factual interpretation for task orchestration events.
   */
  generateTaskInterpretation(category: TaskReasonCategory, details: {
    planId: string;
    stepId?: string;
    uncertainStepIds?: string[];
  }): { interpretation: string; safeNextSteps: string[] } {
    switch (category) {
      case "AWAITING_APPROVAL":
        return {
          interpretation: `The task plan reached a safe boundary and paused, awaiting user approval for downstream modifying steps.`,
          safeNextSteps: [
            "Review the pending plan steps and provide confirmation to resume execution.",
          ],
        };
      case "PLAN_CANCELLED":
        return {
          interpretation: `The task plan was cancelled upon request. All pending steps were halted and uncompleted modifying steps were cancelled.`,
          safeNextSteps: [
            "Create a new plan if work needs to be restarted.",
          ],
        };
      case "UNCERTAIN_SIDE_EFFECT":
      case "RECONCILIATION_REQUIRED":
        return {
          interpretation: `One or more modifying steps were interrupted mid-execution (${details.uncertainStepIds?.join(", ") || "uncertain steps"}). The actual outcome on disk or external state cannot be deterministically verified without human review.`,
          safeNextSteps: [
            "Inspect the filesystem and git status to manually verify whether changes were made.",
            "Provide explicit reconciliation before attempting to resume the plan.",
          ],
        };
      case "CHECKPOINT_CREATED":
        return {
          interpretation: `A durable execution checkpoint was saved at a verified safe execution boundary.`,
          safeNextSteps: [],
        };
      case "RECOVERY_ACCEPTED":
        return {
          interpretation: `The plan was successfully restored to the latest safe checkpoint. Interrupted safe steps were reset to pending.`,
          safeNextSteps: [
            "Review resumed plan state and continue execution.",
          ],
        };
      case "RECOVERY_BLOCKED":
        return {
          interpretation: `Recovery was blocked due to an active stop condition, unverified checkpoint, or unresolved uncertain steps.`,
          safeNextSteps: [
            "Resolve any active stop conditions or reconcile uncertain steps before retrying recovery.",
          ],
        };
      case "STEP_COMPLETED":
        return {
          interpretation: `The step completed successfully and its outcome was verified against expected criteria.`,
          safeNextSteps: [],
        };
      case "STEP_FAILED":
        return {
          interpretation: `The step failed during execution and did not achieve its verified outcome.`,
          safeNextSteps: [
            "Review step error logs and adjust plan parameters or fix workspace prerequisites.",
          ],
        };
      default:
        return {
          interpretation: `Task plan event recorded: ${category}.`,
          safeNextSteps: [],
        };
    }
  }

  /**
   * Generates a safe factual interpretation for reminder lifecycle events.
   */
  generateReminderInterpretation(category: ReminderReasonCategory, details: {
    text?: string;
    dueTime?: string;
    deliveryOutcome?: string;
  }): { interpretation: string; safeNextSteps: string[], limitations: string[] } {
    const limitations: string[] = [];

    switch (category) {
      case "PROPOSAL_CREATED":
      case "AWAITING_APPROVAL":
        return {
          interpretation: `Reminder was drafted and is awaiting explicit user approval. It is not scheduled and will not trigger until approved.`,
          safeNextSteps: ["Review reminder details and explicitly approve scheduling."],
          limitations,
        };
      case "APPROVAL_REVOKED":
      case "APPROVAL_HASH_MISMATCH":
        return {
          interpretation: `Reminder approval was revoked because text, due time, timezone, or recurrence was modified. It must be approved again before scheduling.`,
          safeNextSteps: ["Review modified reminder parameters and approve the updated proposal."],
          limitations,
        };
      case "REMINDER_SCHEDULED":
        return {
          interpretation: `Reminder was approved and registered with the scheduler. It will trigger at the designated due time.`,
          safeNextSteps: [],
          limitations,
        };
      case "NOTIFICATION_DELIVERED":
        return {
          interpretation: `Notification was successfully delivered to the user notification hub at the scheduled time.`,
          safeNextSteps: [],
          limitations: [
            "Note: Delivery confirmation confirms notification dispatch to the local notification hub. Multi-instance or cross-restart deduplication is bounded by recorded occurrence state.",
          ],
        };
      case "DELIVERY_UNKNOWN":
        return {
          interpretation: `Notification dispatch was attempted, but the notification hub returned an indeterminate result or was suppressed. Delivery outcome cannot be confirmed.`,
          safeNextSteps: [
            "Check local notification center or companion app to confirm alert receipt.",
          ],
          limitations: [
            "Outcome is recorded as delivery_unknown to prevent false confirmation of receipt.",
          ],
        };
      case "DELIVERY_FAILED":
        return {
          interpretation: `Notification delivery failed or was suppressed by an active Emergency Stop or Security Lockdown.`,
          safeNextSteps: [
            "Ensure system stop conditions are resolved.",
          ],
          limitations,
        };
      default:
        return {
          interpretation: `Reminder event recorded: ${category}.`,
          safeNextSteps: [],
          limitations,
        };
    }
  }
}

export const explainabilityFormatter = new ExplainabilityFormatter();
