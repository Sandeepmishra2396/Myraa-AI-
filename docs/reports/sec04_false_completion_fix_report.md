# MYRAA SEC-04 — False-Completion Fix & Security Closure Report

**Status:** COMPLETE & VERIFIED  
**Date:** 2026-10-24  
**Classification:** Security Architecture & Origin Boundary Enforcement  

---

## 1. Executive Summary

Under **SEC-04**, an investigation into false task completion revealed that submitting a conflicting goal (`Navigate to https://www.wikipedia.org`) with an initial URL (`https://example.com`) and explicit `allowedOrigins: ["example.com"]` returned HTTP 200 with state `COMPLETED` and executed actions on `example.com` instead of failing closed.

The approved minimal fix was implemented with strict adherence to the two authorized files:
1. `backend/research/browser/BrowserQueryPlanner.ts`
2. `tests/integration/stage9_evaluation_acceptance.test.ts`

All regression suites, TypeScript type checks, production builds, and the strict 129 `LIVE_TOOLS` invariant passed cleanly with zero regressions.

---

## 2. Root Cause & Implemented Fixes

### 2.1 Comprehensive Pre-Planning URL Extraction
- **Defect:** `const targetUrl = req.initialUrl || intent.targetUrl;` caused `req.initialUrl` to shadow and discard `intent.targetUrl` and any URLs extracted from `req.goal`.
- **Fix:** Before generating any execution steps, all candidate URLs from all sources are collected into a typed manifest:
  - `req.initialUrl` (source: `"initialUrl"`)
  - `intent.targetUrl` (source: `"goal target"`)
  - `intent.comparisonUrls` (source: `"comparison target"`)
  - Raw URLs extracted from `req.goal` via `/https?:\/\/[^\s"'<>]+/gi` (source: `"goal"`)

### 2.2 Strict Fail-Closed Origin Boundary Enforcement
- **Defect:** Origin checks previously evaluated only the shadowed `targetUrl` (`example.com`).
- **Fix:**
  - When `allowedOrigins` is explicitly specified (`Array.isArray(req.allowedOrigins)`):
    - **Empty Allowlist Fail-Closed:** If `allowedOrigins.length === 0`, planning fails closed immediately with `ORIGIN_RESTRICTION: Explicit allowedOrigins is empty (fail-closed)`.
    - **Candidate URL Validation:** Every candidate URL is verified against `allowedOrigins` using `isTargetAllowedByOrigins()`.
    - If ANY candidate URL is outside `allowedOrigins`:
      - Emits a structured `TOOL_BLOCKED` event via `securityAuditLogger.logEvent()`.
      - Immediately throws `new Error("ORIGIN_RESTRICTION: Target URL '...' from ... is outside task-scoped allowedOrigins (...)")`.
  - Planning fails closed before a single browser step is queued.
  - `BrowserIntelligenceCoordinator` catches the error, sets `result.state = "FAILED"`, appends to `result.securityFlags` and `result.errors`, and returns `steps = []` (**zero browser actions executed**).

### 2.3 SSRF & Private Network Validation Across All Candidate URLs
- **Fix:** Every candidate URL is also validated against `researchSecurityGate.validateUrl()`. If any candidate URL (whether in `initialUrl` or in `goal`) targets private/loopback IPs, it fails closed during planning with a `SECURITY_VIOLATION`.

### 2.4 Preservation of Intended Goal Navigation
- **Defect:** When `initialUrl` and a distinct `intent.targetUrl` were both allowed, `intent.targetUrl` was dropped.
- **Fix:** If both `initialUrl` and `goalTargetUrl` are provided and both are permitted by `allowedOrigins`:
  - Step 1: `OPEN_URL` -> `initialUrl` (opens starting location).
  - Step 2: `NAVIGATE` -> `goalTargetUrl` (navigates to user's intended goal destination).
  - Subsequent extraction and research handoff steps operate on the goal destination.

### 2.5 Preserving Backward-Compatible Auto-Derivation
- When `req.allowedOrigins` is omitted (`undefined`), origins are auto-derived from candidate URLs, preserving full compatibility for open research tasks.

---

## 3. Scope Boundaries & Files Modified

| File | Status | Modifications |
| :--- | :--- | :--- |
| `backend/research/browser/BrowserQueryPlanner.ts` | Authorized | Implemented candidate URL gathering (`initialUrl`, `goal target`, `comparison target`, `goal`); enforced strict fail-closed origin checks on every URL; enforced fail-closed empty allowlist; validated all candidate URLs against SSRF gate; preserved dual-step navigation for valid distinct targets. |
| `tests/integration/stage9_evaluation_acceptance.test.ts` | Authorized | Added regression tests `SEC04.8` (reproducing exact Wikipedia/example.com failure), `SEC04.9` (empty allowlist fail-closed), `SEC04.10` (dual-target navigation preservation), and `SEC04.11` (SSRF gate validation during planning). |

*No other files were modified. All frozen files (`desktop_agent/tools_browser.py`, `electron/`, `android/`) remain untouched.*

---

## 4. Verification Evidence & Quality Gates

| Gate / Suite | Command | Total | Passed | Failed | Exit Code | Result |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: |
| **Stage 9 Acceptance Suite** | `npx vitest run tests/integration/stage9_evaluation_acceptance.test.ts` | 77 | 77 | 0 | 0 | **PASS** |
| **Stage 1 Coordinator Suite** | `npx vitest run tests/integration/stage1_browser_intelligence_coordinator.test.ts` | 18 | 18 | 0 | 0 | **PASS** |
| **Full Unit Test Suite** | `npx vitest run tests/unit/` | 338 | 338 | 0 | 0 | **PASS** |
| **TypeScript Typecheck** | `npx tsc --noEmit` | — | — | 0 errors | 0 | **PASS** |
| **Production Build** | `npm run build` | — | — | Bundle generated | 0 | **PASS** |
| **Live Tool Count Invariant** | `LIVE_TOOLS[0].functionDeclarations` check | 129 | 129 | 0 | 0 | **PASS** |
| **Working Tree Scope Integrity** | File modification timestamp check | — | Strictly 2 files | 0 unauthorized | 0 | **PASS** |

### 4.1 Regression Verification of the Exact Reported Payload
Test `SEC04.8` executed:
```typescript
const result = await coordinator.executeTask({
  goal: "Navigate to https://www.wikipedia.org",
  initialUrl: "https://example.com",
  allowedOrigins: ["example.com"],
});
```
**Observed Output:**
- `result.state`: `"FAILED"` (was previously `"COMPLETED"`)
- `result.securityFlags`: `["ORIGIN_RESTRICTION: Target URL 'https://www.wikipedia.org' from goal target is outside task-scoped allowedOrigins (example.com)."]`
- `result.errors`: `["Planning error: ORIGIN_RESTRICTION: Target URL 'https://www.wikipedia.org' from goal target is outside task-scoped allowedOrigins (example.com)."]`
- `result.steps.length`: `0` (zero steps planned, zero browser actions executed)
- `afterUrl === beforeUrl`: browser page was completely untouched
- `securityAuditLogger`: logged event `TOOL_BLOCKED` with decision `BLOCK`, target `https://www.wikipedia.org`, and reason `ORIGIN_RESTRICTION`

---

## 5. Security & Invariant Checklist

- [x] **Conflicting Goal Rejection:** Conflicting goal URLs are rejected during planning with `ORIGIN_RESTRICTION`.
- [x] **Zero Browser Actions:** Rejection during planning halts immediately, returning state `FAILED` and `steps = []`.
- [x] **Audit Telemetry:** `TOOL_BLOCKED` events recorded for all origin rejections with full metadata.
- [x] **SSRF Validation:** All candidate URLs checked against SSRF and private-network gates.
- [x] **Empty Allowlist Fail-Closed:** Explicit `allowedOrigins: []` fails closed immediately.
- [x] **Dual Navigation Preserved:** When starting URL and goal destination are both allowed, both are navigated in sequence.
- [x] **Omitted Allowlist Compatibility:** Unspecified allowlists continue to auto-derive target origins safely.
- [x] **Strict 129 Tool Invariant:** Exactly 129 unique Gemini Live tools preserved in `LIVE_TOOLS`.
- [x] **Strict Two-File Scope:** Only `BrowserQueryPlanner.ts` and `stage9_evaluation_acceptance.test.ts` were edited.
