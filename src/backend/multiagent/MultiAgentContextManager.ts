/**
 * MYRAA — Phase 22: Multi-Agent Brain
 * MultiAgentContextManager
 *
 * Implements context minimization, untrusted input tagging, and secret redaction.
 * Ensures agents only receive the minimum information necessary and cannot
 * leak or consume raw API keys, passwords, or bearer tokens.
 */

import type { AgentRole } from "./MultiAgentTypes.ts";

export class MultiAgentContextManager {
  private _secretPatterns: RegExp[] = [
    /(?:api[_-]?key|token|password|secret|authorization)\s*[:=]\s*(?:bearer\s+)?['"]?([a-zA-Z0-9_\-.]{8,})['"]?/gi,
    /\b(?:bearer)\s+([a-zA-Z0-9_\-.]{8,})/gi,
    /sk-[a-zA-Z0-9_\-]{20,}/g,
    /AIzaSy[a-zA-Z0-9_\-]{33}/g,
    /-----BEGIN [A-Z ]+ PRIVATE KEY-----[\s\S]+?-----END [A-Z ]+ PRIVATE KEY-----/g,
  ];

  /**
   * Redacts sensitive credentials, tokens, and keys from any text or object.
   */
  public redactSecrets(input: string): string {
    if (!input || typeof input !== "string") return input;
    let redacted = input;
    for (const pattern of this._secretPatterns) {
      redacted = redacted.replace(pattern, (match, ...args) => {
        if (typeof args[0] === "string" && args[0].length > 0) {
          return match.replace(args[0], "[REDACTED_SECRET]");
        }
        return "[REDACTED_SECRET]";
      });
    }
    return redacted;
  }

  /**
   * Prepares a scoped, minimized context object for a specific agent role.
   * Strips out unrelated private state and redacts potential secrets.
   */
  public prepareScopedContext(
    role: AgentRole,
    rawContext: Record<string, unknown>
  ): Record<string, unknown> {
    const scoped: Record<string, unknown> = {};

    switch (role) {
      case "planner": {
        scoped.goal = rawContext.goal;
        scoped.project = rawContext.project;
        scoped.currentFile = rawContext.currentFile;
        scoped.userPreferences = rawContext.userPreferences;
        scoped.availableCapabilities = rawContext.availableCapabilities;
        break;
      }

      case "researcher": {
        scoped.query = rawContext.query || rawContext.goal;
        scoped.searchDomains = rawContext.searchDomains || ["docs", "knowledge"];
        scoped.isExternalContentUntrusted = true;
        break;
      }

      case "coder": {
        scoped.project = rawContext.project;
        scoped.file = rawContext.file || rawContext.currentFile;
        scoped.diagnosticOutput = rawContext.diagnosticOutput;
        scoped.targetCodeSnippet = rawContext.targetCodeSnippet;
        break;
      }

      case "critic": {
        scoped.goal = rawContext.goal;
        scoped.proposedPlan = rawContext.proposedPlan;
        scoped.specialistFindings = rawContext.specialistFindings;
        scoped.securityMode = rawContext.securityMode;
        break;
      }

      case "executor": {
        scoped.approvedAction = rawContext.approvedAction;
        scoped.targetDevice = rawContext.targetDevice;
        scoped.confirmationToken = rawContext.confirmationToken;
        break;
      }

      case "verifier": {
        scoped.expectedOutcome = rawContext.expectedOutcome;
        scoped.actualOutput = rawContext.actualOutput;
        scoped.exitCode = rawContext.exitCode;
        scoped.targetFile = rawContext.targetFile;
        break;
      }
    }

    return JSON.parse(this.redactSecrets(JSON.stringify(scoped)));
  }

  /**
   * Sanitizes external untrusted content (e.g. from web or docs) to prevent prompt injection.
   */
  public sanitizeUntrustedInput(content: string): string {
    if (!content || typeof content !== "string") return "";
    let sanitized = content;

    // Disarm prompt injection phrases targeting system instructions
    sanitized = sanitized.replace(
      /\b(ignore (?:all )?previous instructions|you are now|system override|elevate privileges|disable security|grant full access)\b/gi,
      "[DISARMED_INJECTION_PHRASE]"
    );

    return this.redactSecrets(sanitized);
  }
}

export const multiAgentContextManager = new MultiAgentContextManager();
