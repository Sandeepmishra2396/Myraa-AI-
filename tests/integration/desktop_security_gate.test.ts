import { describe, it, expect, beforeEach } from "vitest";
import {
  DesktopSecurityGate,
  AUTHORIZED_DESKTOP_PASSCODE,
  DESKTOP_CHALLENGE_PROMPT,
} from "../../backend/security/DesktopSecurityGate.ts";

describe("DesktopSecurityGate — Code-Gated Desktop Control", () => {
  let gate: DesktopSecurityGate;

  beforeEach(() => {
    gate = new DesktopSecurityGate();
  });

  it("initializes in LOCKED state by default", () => {
    expect(gate.isUnlocked()).toBe(false);
    const status = gate.getStatus();
    expect(status.status).toBe("LOCKED");
    expect(status.unlocked).toBe(false);
    expect(status.unlockedAt).toBeNull();
    expect(status.failedAttempts).toBe(0);
    expect(status.challengePrompt).toBe(DESKTOP_CHALLENGE_PROMPT);
  });

  it("issues challenge prompt when desktop control is requested", () => {
    const res = gate.requestDesktopControl();
    expect(res.alreadyUnlocked).toBe(false);
    expect(res.challengeRequired).toBe(true);
    expect(res.prompt).toBe("Code bolo taaki mai desktop ko control kar saku");
    expect(gate.getStatus().status).toBe("AWAITING_CODE");
  });

  it("rejects incorrect passcode and tracks failed attempts", () => {
    const result = gate.verifyPasscode("Wrong Code 123");
    expect(result.success).toBe(false);
    expect(result.status).toBe("LOCKED");
    expect(gate.isUnlocked()).toBe(false);
    expect(result.failedAttempts).toBe(1);
    expect(result.message).toContain("Galat code hai");
    expect(result.message).toContain("Code bolo taaki mai desktop ko control kar saku");
  });

  it("verifies and unlocks with exact passcode 'Mummy Ka Beta'", () => {
    const result = gate.verifyPasscode("Mummy Ka Beta");
    expect(result.success).toBe(true);
    expect(result.status).toBe("UNLOCKED");
    expect(gate.isUnlocked()).toBe(true);
    expect(result.message).toContain("Code verified!");
    expect(result.message).toContain("Mummy Ka Beta");
    expect(gate.getStatus().unlocked).toBe(true);
  });

  it("verifies case-insensitively and handles whitespace/punctuation variations", () => {
    const variations = [
      "mummy ka beta",
      "MUMMY KA BETA",
      "mummy  ka   beta",
      "Mummy Ka Beta!",
      "mummy ka beta.",
      "code: mummy ka beta",
    ];

    for (const v of variations) {
      gate.reset();
      const result = gate.verifyPasscode(v);
      expect(result.success).toBe(true);
      expect(gate.isUnlocked()).toBe(true);
    }
  });

  it("reports already unlocked when requested again after authorization", () => {
    gate.verifyPasscode("Mummy Ka Beta");
    expect(gate.isUnlocked()).toBe(true);

    const req = gate.requestDesktopControl();
    expect(req.alreadyUnlocked).toBe(true);
    expect(req.challengeRequired).toBe(false);
  });

  it("locks desktop control on demand", () => {
    gate.verifyPasscode("Mummy Ka Beta");
    expect(gate.isUnlocked()).toBe(true);

    const lockRes = gate.lock();
    expect(lockRes.success).toBe(true);
    expect(gate.isUnlocked()).toBe(false);
    expect(gate.getStatus().status).toBe("LOCKED");
  });
});
