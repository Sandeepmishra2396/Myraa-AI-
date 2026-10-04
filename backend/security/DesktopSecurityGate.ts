/**
 * MYRAA — DesktopSecurityGate
 *
 * Dedicated security and authorization gate for Desktop Control mode:
 *   • Gated Passcode: "Mummy Ka Beta" (case-insensitive, trimmed)
 *   • When the user requests desktop control ("desktop control karo"):
 *       Gate challenges the user: "Code bolo taaki mai desktop ko control kar saku"
 *   • When the user speaks/provides "Mummy Ka Beta":
 *       Gate unlocks and authorizes desktop control actions.
 *   • Comprehensive audit logging and security policy integration.
 */

import { securityAuditLogger } from "./SecurityAuditLogger.ts";

export type DesktopGateStatus = "LOCKED" | "AWAITING_CODE" | "UNLOCKED";

export interface DesktopGateVerifyResult {
  success: boolean;
  message: string;
  status: DesktopGateStatus;
  failedAttempts?: number;
}

export const AUTHORIZED_DESKTOP_PASSCODE = "Mummy Ka Beta";
export const DESKTOP_CHALLENGE_PROMPT = "Code bolo taaki mai desktop ko control kar saku";

export class DesktopSecurityGate {
  private _status: DesktopGateStatus = "LOCKED";
  private _unlockedAt: number | null = null;
  private _unlockedBy: string | null = null;
  private _failedAttempts = 0;
  private _maxFailedAttempts = 5;

  constructor() {
    this.reset();
  }

  public reset(): void {
    this._status = "LOCKED";
    this._unlockedAt = null;
    this._unlockedBy = null;
    this._failedAttempts = 0;
  }

  /**
   * Check if desktop control is currently unlocked and authorized.
   */
  public isUnlocked(): boolean {
    return this._status === "UNLOCKED";
  }

  /**
   * Get current gate status details.
   */
  public getStatus(): {
    unlocked: boolean;
    status: DesktopGateStatus;
    unlockedAt: number | null;
    failedAttempts: number;
    challengePrompt: string;
  } {
    return {
      unlocked: this.isUnlocked(),
      status: this._status,
      unlockedAt: this._unlockedAt,
      failedAttempts: this._failedAttempts,
      challengePrompt: DESKTOP_CHALLENGE_PROMPT,
    };
  }

  /**
   * Triggered when user asks to control desktop ("desktop control karo").
   * Moves gate to AWAITING_CODE if not already unlocked.
   */
  public requestDesktopControl(): {
    alreadyUnlocked: boolean;
    challengeRequired: boolean;
    prompt: string;
  } {
    if (this._status === "UNLOCKED") {
      return {
        alreadyUnlocked: true,
        challengeRequired: false,
        prompt: "Desktop control already authorized hai. Main aapke desktop ko control karne ke liye taiyaar hoon!",
      };
    }

    this._status = "AWAITING_CODE";
    securityAuditLogger.logEvent({
      eventType: "SECURITY_POLICY_VIOLATION",
      actor: { identityId: "local_operator", role: "standard", ipAddress: "127.0.0.1", isLocal: true },
      decision: "REQUIRE_CONFIRMATION",
      reason: `Desktop control requested. Challenge issued: '${DESKTOP_CHALLENGE_PROMPT}'`,
      riskLevel: "HIGH",
    });

    return {
      alreadyUnlocked: false,
      challengeRequired: true,
      prompt: DESKTOP_CHALLENGE_PROMPT,
    };
  }

  /**
   * Normalize input code for robust natural spoken comparison.
   * Handles whitespace, casing, and common speech-to-text variations.
   */
  private _normalizeCode(input: string): string {
    return (input || "")
      .toLowerCase()
      .replace(/[.,!?;:'"“”]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  /**
   * Verifies the provided passcode against the authorized secret: "Mummy Ka Beta".
   */
  public verifyPasscode(inputCode: string, actorId = "local_operator"): DesktopGateVerifyResult {
    const normalizedInput = this._normalizeCode(inputCode);
    const normalizedTarget = this._normalizeCode(AUTHORIZED_DESKTOP_PASSCODE);

    // Also accept clean variations like "mummy ka beta", "mummykabeta"
    const isMatch =
      normalizedInput === normalizedTarget ||
      normalizedInput.replace(/\s+/g, "") === normalizedTarget.replace(/\s+/g, "") ||
      normalizedInput.includes(normalizedTarget);

    if (isMatch) {
      this._status = "UNLOCKED";
      this._unlockedAt = Date.now();
      this._unlockedBy = actorId;
      this._failedAttempts = 0;

      securityAuditLogger.logEvent({
        eventType: "TOOL_ENABLED",
        actor: { identityId: actorId, role: "admin", ipAddress: "127.0.0.1", isLocal: true },
        decision: "ALLOW",
        reason: "Desktop control authorized with correct secret code 'Mummy Ka Beta'.",
        riskLevel: "LOW",
      });

      return {
        success: true,
        message: "Code verified! 'Mummy Ka Beta' confirm ho gaya hai. Desktop control mode activate ho gaya hai. Ab aap jo bhi bolenge—file manager, D drive, apps ya koi bhi desktop action—main turant perform karungi!",
        status: "UNLOCKED",
      };
    }

    this._failedAttempts++;
    securityAuditLogger.logEvent({
      eventType: "SECURITY_POLICY_VIOLATION",
      actor: { identityId: actorId, role: "standard", ipAddress: "127.0.0.1", isLocal: true },
      decision: "BLOCK",
      reason: `Desktop control code verification failed (attempt ${this._failedAttempts}). Provided: '${inputCode}'`,
      riskLevel: "HIGH",
    });

    return {
      success: false,
      message: `Galat code hai. Desktop control access denied. Kripya sahi code batayein: '${DESKTOP_CHALLENGE_PROMPT}'.`,
      status: this._status,
      failedAttempts: this._failedAttempts,
    };
  }

  /**
   * Lock desktop control mode.
   */
  public lock(reason = "User requested lock"): { success: boolean; message: string } {
    this._status = "LOCKED";
    this._unlockedAt = null;
    this._unlockedBy = null;

    securityAuditLogger.logEvent({
      eventType: "TOOL_DISABLED",
      actor: { identityId: "local_operator", role: "admin", ipAddress: "127.0.0.1", isLocal: true },
      decision: "BLOCK",
      reason: `Desktop control locked: ${reason}`,
      riskLevel: "LOW",
    });

    return {
      success: true,
      message: "Desktop control locked ho gaya hai.",
    };
  }
}

export const desktopSecurityGate = new DesktopSecurityGate();
