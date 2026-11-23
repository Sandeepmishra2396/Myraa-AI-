# MYRAA SEC-04 — Task-Scoped Origin Enforcement Fix & Security Closure Report

**Status:** COMPLETE & VERIFIED  
**Date:** 2026-10-24  
**Classification:** Security Architecture & Origin Boundary Hardening  

---

## 1. Executive Summary

Under **SEC-04**, MYRAA was diagnosed with an origin-enforcement bypass whereby:
1. `BrowserQueryPlanner.ts` silently widened task-scoped `allowedOrigins` by auto-deriving and appending any requested URL hostname.
2. `BrowserActionExecutor.ts` lacked robust subdomain/suffix boundary enforcement and did not emit `SecurityAuditLogger` telemetry for origin denials.
3. `BrowserIntelligenceCoordinator.ts` retried origin violations up to `maxRetries` instead of failing fast immediately on `ORIGIN_RESTRICTION`.

The approved fix was implemented with strict adherence to the authorized file boundary:
- `backend/research/browser/BrowserQueryPlanner.ts`
- `backend/research/browser/BrowserActionExecutor.ts`
- `backend/research/browser/BrowserIntelligenceCoordinator.ts`
- `tests/integration/stage9_evaluation_acceptance.test.ts`

All test suites, production build, TypeScript type checks, and the strict 129 `LIVE_TOOLS` invariant passed cleanly with 0 regressions.

---

## 2. Root Cause & Architectural Resolution

### 2.1 Planner Allowlist Widening Prevention
- **Root Cause:** In `BrowserQueryPlanner.ts`, when preparing the search plan, the planner examined `targetUrl` and `comparisonUrls` and unconditionally executed:
  ```typescript
  if (!allowedOrigins.includes(parsed.hostname)) {
    allowedOrigins.push(parsed.hostname);
  }
  ```
  This defeated caller-specified constraints by mutating the allowlist.
- **Resolution:**
  - Added an `isExplicitAllowlist = Array.isArray(req.allowedOrigins)` guard.
  - When explicit, `allowedOrigins` is preserved as an immutable list.
  - The planner validates `targetUrl` and all `comparisonUrls` using `isTargetAllowedByOrigins()`. If any target falls outside `allowedOrigins`, it logs a `TOOL_BLOCKED` event via `securityAuditLogger` and throws an `ORIGIN_RESTRICTION` error.
  - When omitted (`req.allowedOrigins === undefined`), documented auto-derivation behavior is preserved.

### 2.2 Robust Origin Normalization & Deceptive Suffix Protection
- **Root Cause:** Simple string containment (`origin.includes("...")`) or improper matching allows suffix deception attacks (e.g., `example.com.evil.org` matching `example.com`).
- **Resolution:**
  - Implemented `normalizeOrigin(raw: string): string` to extract clean lowercase hostnames without protocols or ports.
  - Implemented `isHostnameAllowedByOrigin(target, origin)`:
    ```typescript
    export function isHostnameAllowedByOrigin(targetUrlOrHostname: string, rawOrigin: string): boolean {
      const normTarget = normalizeOrigin(targetUrlOrHostname);
      const normOrigin = normalizeOrigin(rawOrigin);
      if (normTarget === normOrigin) return true;
      if (normTarget.endsWith("." + normOrigin)) return true; // Subdomain allowed
      return false; // Blocks deceptive suffixes like example.com.evil.org
    }
    ```

### 2.3 Comprehensive Navigation Vector Enforcement & Security Audit Telemetry
- **Root Cause:** Origin checking was only partially implemented in `BrowserActionExecutor.ts` and did not record structured audit telemetry.
- **Resolution:**
  - Integrated `securityAuditLogger.logEvent()` emitting `TOOL_BLOCKED` events with risk level `HIGH`, decision `BLOCK`, target URL/hostname, configured `allowedOrigins`, and `taskId`.
  - Enforced `isTargetAllowedByOrigins()` across all navigation operations: `OPEN_URL`, `NAVIGATE`, and `OPEN_TAB`.
  - Added `taskId` forwarding through the execution context from coordinator down to individual action step executions.

### 2.4 Fail-Fast Termination in Coordinator
- **Root Cause:** The coordinator retry loop treated origin security denials as standard transient execution failures, retrying them repeatedly.
- **Resolution:**
  - In `BrowserIntelligenceCoordinator.ts`:
    - Updated planning error handler to flag `ORIGIN_RESTRICTION` as a fatal security failure:
      ```typescript
      if (err.message?.includes("ORIGIN_RESTRICTION") || err.message?.includes("SECURITY")) {
        result.securityFlags.push(err.message);
      }
      ```
    - Added fail-fast break in the step retry loop on `ORIGIN_RESTRICTION` (0 retries, immediate loop break).
    - Added fatal halt condition marking state as `"FAILED"` and terminating task orchestration immediately.

---

## 3. Files Modified (Strict Scope Adherence)

| File | Status | Modifications |
| :--- | :--- | :--- |
| `backend/research/browser/BrowserQueryPlanner.ts` | Authorized | Exported normalization & matching helpers; enforced immutable explicit allowlist; throw `ORIGIN_RESTRICTION` & emit `TOOL_BLOCKED` audit event on plan boundary violation. |
| `backend/research/browser/BrowserActionExecutor.ts` | Authorized | Added `taskId` to context; imported `securityAuditLogger` & `isTargetAllowedByOrigins`; enforced origin gates on `OPEN_URL`, `NAVIGATE`, `OPEN_TAB`; logged `TOOL_BLOCKED` audits on denial. |
| `backend/research/browser/BrowserIntelligenceCoordinator.ts` | Authorized | Threaded `taskId` into action executions; treated `ORIGIN_RESTRICTION` as fatal security denial; broke retry loop immediately (0 retries). |
| `tests/integration/stage9_evaluation_acceptance.test.ts` | Authorized | Added 7 comprehensive regression tests (`SEC04.1` through `SEC04.7`) verifying all boundary conditions, deceptive suffix prevention, and audit logging. |

*No other files were modified. All frozen directories and previous fixes were preserved intact.*

---

## 4. Test Evidence & Quality Gate Verification

| Gate / Suite | Command | Total | Passed | Failed | Exit Code | Result |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: |
| **Stage 9 Acceptance Suite** | `npx vitest run tests/integration/stage9_evaluation_acceptance.test.ts` | 73 | 73 | 0 | 0 | **PASS** |
| **Stage 1 Coordinator Suite** | `npx vitest run tests/integration/stage1_browser_intelligence_coordinator.test.ts` | 18 | 18 | 0 | 0 | **PASS** |
| **Full Unit Test Suite** | `npx vitest run tests/unit/` | 338 | 338 | 0 | 0 | **PASS** |
| **TypeScript Typecheck** | `npx tsc --noEmit` | — | — | 0 errors | 0 | **PASS** |
| **Production Build** | `npm run build` | — | — | Bundle generated | 0 | **PASS** |
| **Live Tool Count Invariant** | `LIVE_TOOLS[0].functionDeclarations` check | 129 | 129 | 0 | 0 | **PASS** |
| **Working Tree Scope Integrity** | `git status --porcelain` check | — | Strictly 4 files | 0 unauthorized | 0 | **PASS** |

### 4.1 Stage 9 SEC-04 Test Breakdown
- `SEC04.1`: Explicit allowlist is strictly preserved without widening or mutating caller constraints.
- `SEC04.2`: Planner fails closed immediately when requested goal/targetUrl violates explicit `allowedOrigins`.
- `SEC04.3`: Denials emit structured `TOOL_BLOCKED` events via `securityAuditLogger`.
- `SEC04.4`: Coordinator treats `ORIGIN_RESTRICTION` as a fatal security violation with fail-fast abort (0 retries).
- `SEC04.5`: Permitted in-scope URLs and legitimate subdomains navigate successfully.
- `SEC04.6`: Deceptive domain suffix attacks (e.g., `example.com.evil.org`) are rejected deterministically.
- `SEC04.7`: Backward-compatible auto-derivation is preserved when `allowedOrigins` is omitted.

---

## 5. Security & Invariant Checklist

- [x] **No Allowlist Widening:** Explicit `allowedOrigins` arrays cannot be mutated or widened by planner or executor.
- [x] **Fail-Closed Execution:** Any out-of-scope navigation attempts throw `ORIGIN_RESTRICTION` and halt immediately.
- [x] **Audit Telemetry:** Every blocked origin attempt logs a `TOOL_BLOCKED` audit event with full task and URL details.
- [x] **Deceptive Suffix Defense:** Hostname checking requires exact match or dotted subdomain prefix.
- [x] **Strict 129 Tool Invariant:** Exactly 129 unique Gemini Live tools preserved in `LIVE_TOOLS`.
- [x] **Scope Containment:** Strictly the 4 authorized files were edited. Frozen directories (`desktop_agent/tools_browser.py`, `electron/`, `android/`) were untouched.
- [x] **Prior Fix Integrity:** AC14 DNS-pinning proxy, NF-02 browser lifecycle recovery, and NF-03 tab switching fixes remain completely operational and green.
