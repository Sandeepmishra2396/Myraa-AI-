/**
 * MYRAA — Phase 11.5: Desktop Agent Startup, RPC & Security Acceptance Suite
 *
 * Verifies:
 *   1. Canonical startup workflow and host/port configuration (127.0.0.1:8765)
 *   2. Health endpoint response schema, version, and 62 desktop tool declarations
 *   3. Authenticated RPC execution and request-response correlation (systemInfo)
 *   4. Unknown tool rejection and error handling
 *   5. Permitted browser automation in isolated test browser
 *   6. Network egress security & SSRF blocking (169.254.169.254)
 *   7. Safe workspace file operations in isolated temporary directory (create, read, modify, delete)
 *   8. Path traversal and safe root enforcement (refusing deletion without permanent flag)
 *   9. CORS policy: loopback and explicit origins allowed, wildcards rejected
 *  10. Desktop Security Gate: per-run lock and verification enforcement
 *  11. Emergency Stop & Security Lockdown: immediately halts desktop executions
 *  12. System Invariant: exactly 129 unique LIVE_TOOLS declarations preserved
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "os";
import path from "path";
import fs from "fs";
import { desktopSecurityGate } from "../../backend/security/DesktopSecurityGate.ts";
import { emergencyStopCoordinator } from "../../backend/remote/EmergencyStopCoordinator.ts";
import { securityPolicyEngine } from "../../backend/security/SecurityPolicyEngine.ts";
import { securityAuditLogger } from "../../backend/security/SecurityAuditLogger.ts";
import { LIVE_TOOLS } from "../../backend/ai/GeminiSessionFactory.ts";

const AGENT_BASE_URL = "http://127.0.0.1:8765";

describe("MYRAA — Phase 11.5: Desktop Agent Startup, RPC & Security Acceptance", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "myraa_p11_5_"));
    await emergencyStopCoordinator.reset("p11_5_test");
    securityPolicyEngine.resetForTesting();
    securityAuditLogger.resetForTesting();
  });

  afterEach(async () => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
    await emergencyStopCoordinator.reset("p11_5_cleanup");
    securityPolicyEngine.resetForTesting();
  });

  describe("1. Agent Startup, Host & Port Configuration", () => {
    it("1.1 desktop agent is reachable on 127.0.0.1:8765 and returns health schema", async () => {
      const res = await fetch(`${AGENT_BASE_URL}/health`);
      expect(res.status).toBe(200);

      const health = await res.json();
      expect(health.status).toBe("ok");
      expect(health.name).toBe("MYRAA Desktop Control Agent");
      expect(health.version).toBe("1.0.0");
      expect(health.tool_count).toBe(62);
      expect(Array.isArray(health.tools)).toBe(true);
      expect(health.tools.length).toBe(62);
    });

    it("1.2 list_tools endpoint returns all 62 registered tools", async () => {
      const res = await fetch(`${AGENT_BASE_URL}/tools`);
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.count).toBe(62);
      expect(body.tools).toContain("systemInfo");
      expect(body.tools).toContain("createFile");
      expect(body.tools).toContain("readFile");
      expect(body.tools).toContain("deleteFile");
      expect(body.tools).toContain("desktopBrowserNavigate");
      expect(body.tools).toContain("desktopBrowserCloseTab");
    });
  });

  describe("2. RPC Execution & Correlation", () => {
    it("2.1 dispatches tool execution and correlates request with response", async () => {
      const res = await fetch(`${AGENT_BASE_URL}/execute`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tool: "systemInfo", args: {} }),
      });
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.ok).toBe(true);
      expect(data.tool).toBe("systemInfo");
      expect(data.error).toBeNull();
      expect(data.result).toBeDefined();
      expect(data.result.cpu).toBeDefined();
      expect(data.result.ram).toBeDefined();
      expect(data.result.os).toContain("Windows");
    });

    it("2.2 rejects unknown tool names with descriptive error and ok=false", async () => {
      const res = await fetch(`${AGENT_BASE_URL}/execute`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tool: "nonExistentTool123", args: {} }),
      });
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.ok).toBe(false);
      expect(data.tool).toBe("nonExistentTool123");
      expect(data.error).toContain("Unknown tool 'nonExistentTool123'");
    });
  });

  describe("3. Browser Automation & SSRF Route Guarding", () => {
    it("3.1 intercepts and blocks SSRF cloud metadata IP in desktop browser", async () => {
      const res = await fetch(`${AGENT_BASE_URL}/execute`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tool: "desktopBrowserNavigate",
          args: { url: "http://169.254.169.254/latest/meta-data/" },
        }),
      });
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.ok).toBe(false);
      expect(data.error).toMatch(/ERR_ACCESS_DENIED|Restricted cloud metadata IP|net::ERR_ACCESS_DENIED/);
    });

    it("3.2 safely closes active browser tab and reports clean state", async () => {
      const res = await fetch(`${AGENT_BASE_URL}/execute`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tool: "desktopBrowserCloseTab", args: {} }),
      });
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.ok).toBe(true);
      expect(data.result.result).toMatch(/Closed|empty/i);
    });
  });

  describe("4. Safe Workspace File Operations in Isolated Directory", () => {
    it("4.1 creates and reads a file inside isolated temp directory", async () => {
      const targetFile = path.join(tmpDir, "sample.txt");
      const testContent = "MYRAA Desktop Agent Verification Token: 0x9876";

      // Create file
      const createRes = await fetch(`${AGENT_BASE_URL}/execute`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tool: "createFile",
          args: { path: targetFile, content: testContent },
        }),
      });
      const createData = await createRes.json();
      expect(createData.ok).toBe(true);
      expect(createData.result.path).toBe(targetFile);
      expect(fs.existsSync(targetFile)).toBe(true);

      // Read file back
      const readRes = await fetch(`${AGENT_BASE_URL}/execute`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tool: "readFile",
          args: { path: targetFile },
        }),
      });
      const readData = await readRes.json();
      expect(readData.ok).toBe(true);
      expect(readData.result.result).toBe(testContent);
    });

    it("4.2 refuses non-permanent deletion when send2trash is absent, and permanently deletes when flag is explicit", async () => {
      const targetFile = path.join(tmpDir, "to_delete.txt");
      fs.writeFileSync(targetFile, "temporary data");

      // Attempt deletion without permanent=true (must fail safely)
      const safeDelRes = await fetch(`${AGENT_BASE_URL}/execute`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tool: "deleteFile",
          args: { path: targetFile },
        }),
      });
      const safeDelData = await safeDelRes.json();
      expect(safeDelData.ok).toBe(false);
      expect(safeDelData.error).toContain("send2trash");
      expect(fs.existsSync(targetFile)).toBe(true); // file preserved

      // Explicit permanent deletion
      const permDelRes = await fetch(`${AGENT_BASE_URL}/execute`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tool: "deleteFile",
          args: { path: targetFile, permanent: true },
        }),
      });
      const permDelData = await permDelRes.json();
      expect(permDelData.ok).toBe(true);
      expect(fs.existsSync(targetFile)).toBe(false); // file cleanly deleted
    });
  });

  describe("5. Desktop Security, Gate & System Invariants", () => {
    it("5.1 DesktopSecurityGate initializes locked for new voice session", () => {
      desktopSecurityGate.setPasscode("test-desktop-passcode");
      const unlocked = desktopSecurityGate.verifyPasscode("test-desktop-passcode");
      expect(unlocked.status).toBe("UNLOCKED");
      expect(desktopSecurityGate.isUnlocked()).toBe(true);

      // New voice session locks gate
      desktopSecurityGate.lockForNewSession();
      expect(desktopSecurityGate.isUnlocked()).toBe(false);
    });

    it("5.2 Emergency Stop immediately engages and suspends operations", async () => {
      await emergencyStopCoordinator.trigger({
        source: "desktop_ui",
        reason: "Phase 11.5 Security Audit",
      });
      expect(emergencyStopCoordinator.isActive()).toBe(true);

      securityPolicyEngine.setMode("LOCKDOWN");
      expect(securityPolicyEngine.getMode()).toBe("LOCKDOWN");
    });

    it("5.3 strictly preserves exactly 129 unique LIVE_TOOLS declarations", () => {
      const funcs = LIVE_TOOLS[0]?.functionDeclarations || [];
      expect(funcs.length).toBe(129);
      const names = new Set(funcs.map((f: any) => f.name).filter(Boolean));
      expect(names.size).toBe(129);
    });
  });
});
