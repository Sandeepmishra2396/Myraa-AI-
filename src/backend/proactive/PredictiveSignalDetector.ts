/**
 * MYRAA — Phase 21: Predictive / Proactive Engine
 * PredictiveSignalDetector
 *
 * Scans raw outputs, terminal streams, compiler diagnostics, test runs,
 * and runtime logs to extract structured proactive signals and evidence.
 */

import type {
  ProactiveEventType,
  ProactiveEvidence,
  RawProactiveSignal,
} from "./ProactiveTypes.ts";

export class PredictiveSignalDetector {
  /**
   * Scans a raw incoming signal and returns classified event type and extracted evidence.
   */
  public detectSignal(
    signal: RawProactiveSignal,
    now = Date.now()
  ): { eventType: ProactiveEventType; evidence: ProactiveEvidence } | null {
    const raw = signal.rawText || "";
    if (!raw.trim()) return null;

    // ── 1. TypeScript Compiler Diagnostics (TSxxxx) ──────────────────────────
    const tsFileMatch = raw.match(
      /([a-zA-Z0-9_./\\-]+\.tsx?):(\d+):(\d+)\s*-\s*error\s+TS(\d+):\s*(.+)/i
    );
    if (tsFileMatch) {
      const [, filePath, lineStr, colStr, errorCode, message] = tsFileMatch;
      return {
        eventType: "TYPE_ERROR",
        evidence: {
          source: "compiler",
          rawOutput: raw.slice(0, 1000),
          filePath,
          lineNumber: parseInt(lineStr, 10),
          columnNumber: parseInt(colStr, 10),
          errorCode: `TS${errorCode}`,
          errorSignature: `TS${errorCode}:${filePath}:${lineStr}`,
          command: signal.command,
          exitCode: signal.exitCode ?? 1,
          capturedAt: now,
        },
      };
    }

    const tsGenericMatch = raw.match(/error\s+TS(\d+):\s*(.+)/i);
    if (tsGenericMatch) {
      const [, errorCode, message] = tsGenericMatch;
      return {
        eventType: "TYPE_ERROR",
        evidence: {
          source: "compiler",
          rawOutput: raw.slice(0, 1000),
          filePath: signal.file,
          errorCode: `TS${errorCode}`,
          errorSignature: `TS${errorCode}:${message.slice(0, 40).trim()}`,
          command: signal.command,
          exitCode: signal.exitCode ?? 1,
          capturedAt: now,
        },
      };
    }

    // ── 2. Test Runner Failures (Vitest / Jest / TestSuite) ───────────────────
    const testFailMatch =
      raw.match(/FAIL\s+([a-zA-Z0-9_./\\-]+\.test\.[jt]sx?)/i) ||
      raw.match(/(\d+)\s+failed/i) ||
      raw.match(/AssertionError:\s*(.+)/i);

    if (testFailMatch && (signal.command?.includes("test") || /vitest|jest|mocha|pytest/i.test(raw))) {
      const failedFile = raw.match(/FAIL\s+([a-zA-Z0-9_./\\-]+\.test\.[jt]sx?)/i)?.[1] || signal.file;
      const signature = `TEST_FAIL:${failedFile || "suite"}:${(testFailMatch[1] || "").slice(0, 30)}`;
      return {
        eventType: "TEST_FAILED",
        evidence: {
          source: "test_runner",
          rawOutput: raw.slice(0, 1000),
          filePath: failedFile,
          errorSignature: signature,
          command: signal.command,
          exitCode: signal.exitCode ?? 1,
          capturedAt: now,
        },
      };
    }

    // ── 3. Build Tool Failures (Vite / Esbuild / Rollup / Webpack) ────────────
    const isBuildCommand =
      signal.command?.includes("build") ||
      /vite build|esbuild|npm run build|webpack|tsc --build/i.test(raw);

    const hasBuildError =
      (signal.exitCode !== undefined && signal.exitCode !== 0 && isBuildCommand) ||
      /\[build:error\]|vite.*building for production[\s\S]*?(error|failed|Error:)/i.test(raw) ||
      /npm ERR!.*lifecycle/i.test(raw) ||
      /Build failed with \d+ error/i.test(raw);

    if (hasBuildError) {
      return {
        eventType: "BUILD_FAILED",
        evidence: {
          source: "terminal",
          rawOutput: raw.slice(0, 1000),
          filePath: signal.file,
          command: signal.command,
          exitCode: signal.exitCode ?? 1,
          errorSignature: `BUILD_ERROR:${signal.project || "default"}:${raw.slice(0, 40).trim()}`,
          capturedAt: now,
        },
      };
    }

    // ── 4. Runtime Crash / Uncaught Exceptions / EADDRINUSE ──────────────────
    const isAddrInUse = /EADDRINUSE.*:(\d+)/i.test(raw) || /address already in use/i.test(raw);
    if (isAddrInUse) {
      const port = raw.match(/:(\d+)/)?.[1] || "port";
      return {
        eventType: "RUNTIME_ERROR",
        evidence: {
          source: "runtime",
          rawOutput: raw.slice(0, 1000),
          errorCode: "EADDRINUSE",
          errorSignature: `EADDRINUSE:${port}`,
          command: signal.command,
          exitCode: signal.exitCode ?? 1,
          capturedAt: now,
        },
      };
    }

    const runtimeMatch = raw.match(
      /\b(ReferenceError|TypeError|SyntaxError|RangeError|URIError|UnhandledPromiseRejection|uncaughtException):\s*(.+)/i
    );
    if (runtimeMatch) {
      const [, errType, errMsg] = runtimeMatch;
      return {
        eventType: "RUNTIME_ERROR",
        evidence: {
          source: "runtime",
          rawOutput: raw.slice(0, 1000),
          filePath: signal.file,
          errorCode: errType,
          errorSignature: `${errType}:${errMsg.slice(0, 40).trim()}`,
          command: signal.command,
          exitCode: signal.exitCode ?? 1,
          capturedAt: now,
        },
      };
    }

    // ── 5. Stalled / Stuck Task ──────────────────────────────────────────────
    if (/task.*stalled|task.*timeout|process.*hung/i.test(raw) || signal.task === "stalled") {
      return {
        eventType: "TASK_STALLED",
        evidence: {
          source: "task_monitor",
          rawOutput: raw.slice(0, 1000),
          filePath: signal.file,
          errorSignature: `TASK_STALLED:${signal.task || "unknown"}`,
          command: signal.command,
          capturedAt: now,
        },
      };
    }

    // ── 6. Project Warnings / Missing Config ──────────────────────────────────
    if (/missing required environment variable|no \.env file found|MODULE_NOT_FOUND/i.test(raw)) {
      const missingMod = raw.match(/Cannot find module ['"]([^'"]+)['"]/)?.[1];
      return {
        eventType: "PROJECT_WARNING",
        evidence: {
          source: "system",
          rawOutput: raw.slice(0, 1000),
          filePath: signal.file,
          errorCode: missingMod ? "MODULE_NOT_FOUND" : "MISSING_CONFIG",
          errorSignature: missingMod ? `MISSING_DEP:${missingMod}` : "PROJECT_WARNING_CONFIG",
          command: signal.command,
          capturedAt: now,
        },
      };
    }

    // ── 7. Workflow Pattern Detection ────────────────────────────────────────
    if (/workflow:pattern|repeated_sequence/i.test(raw)) {
      return {
        eventType: "WORKFLOW_PATTERN",
        evidence: {
          source: "system",
          rawOutput: raw.slice(0, 1000),
          errorSignature: `WORKFLOW:${signal.command || "sequence"}`,
          capturedAt: now,
        },
      };
    }

    // ── 8. Safe Suggestions (e.g., git dirty before release) ─────────────────
    if (/uncommitted changes|working tree clean/i.test(raw)) {
      return {
        eventType: "SAFE_SUGGESTION",
        evidence: {
          source: "git",
          rawOutput: raw.slice(0, 1000),
          errorSignature: `GIT_STATUS:${raw.slice(0, 30)}`,
          capturedAt: now,
        },
      };
    }

    return null;
  }
}

export const predictiveSignalDetector = new PredictiveSignalDetector();
