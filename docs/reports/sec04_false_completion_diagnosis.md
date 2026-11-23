# MYRAA SEC-04 — Unexpected Task Completion Diagnosis Report

**Date:** 2026-10-24  
**Status:** DIAGNOSIS COMPLETE (Awaiting Implementation Approval)  
**Classification:** Security Architecture & Origin Boundary Enforcement  

---

## 1. Executive Summary

A severe origin enforcement bypass and false-positive task completion was reported in the browser intelligence subsystem:

- **Input Request:**
  - `goal`: `"Navigate to https://www.wikipedia.org"`
  - `initialUrl`: `"https://example.com"`
  - `allowedOrigins`: `["example.com"]`
- **Observed Behavior:**
  - API returned HTTP 200 with task state `COMPLETED`.
  - Executed steps: `OPEN_URL` (`https://example.com`), `EXTRACT_DOM`, `SUMMARIZE_RESEARCH`.
  - Zero `ORIGIN_RESTRICTION` errors were thrown.
  - `errors` and `securityFlags` were empty.
  - `https://www.wikipedia.org` was neither navigated to nor evaluated against `allowedOrigins`.

### Root Cause in One Sentence
In `BrowserQueryPlanner.ts` (line 187), `targetUrl` was assigned via `req.initialUrl || intent.targetUrl;`, which caused `req.initialUrl` (`"https://example.com"`) to completely shadow and discard the goal's target URL (`"https://www.wikipedia.org"`), thereby bypassing all origin restriction checks and goal satisfaction requirements.

---

## 2. End-to-End Request Trace

```mermaid
sequenceDiagram
    autonumber
    actor Client
    participant HttpGateway as HttpGateway (POST /api/browser-intelligence/execute)
    participant Coordinator as BrowserIntelligenceCoordinator
    participant Interpreter as BrowserIntentInterpreter
    participant Planner as BrowserQueryPlanner
    participant Executor as BrowserActionExecutor

    Client->>HttpGateway: { goal: "Navigate to https://www.wikipedia.org", initialUrl: "https://example.com", allowedOrigins: ["example.com"] }
    HttpGateway->>Coordinator: executeTask(req)
    Coordinator->>Interpreter: interpret(req.goal)
    Note over Interpreter: Extracts allUrls: ["https://www.wikipedia.org"]<br/>Sets intent.targetUrl = "https://www.wikipedia.org"<br/>Sets intent.primaryAction = "OPEN_URL"<br/>Sets intent.originRestrictions = ["www.wikipedia.org"]
    Interpreter-->>Coordinator: intent

    Coordinator->>Planner: plan(req, intent)
    Note over Planner: isExplicitAllowlist = true<br/>allowedOrigins = ["example.com"]<br/>CRITICAL BUG (Line 187):<br/>const targetUrl = req.initialUrl || intent.targetUrl;<br/>targetUrl evaluates to "https://example.com"<br/>intent.targetUrl ("https://www.wikipedia.org") is shadowed & ignored!
    Note over Planner: Origin check only validates targetUrl ("https://example.com")<br/>example.com is in allowedOrigins -> PASSES!<br/>No check on goal URLs or intent.targetUrl
    Note over Planner: Generates 3 steps:<br/>1. OPEN_URL (https://example.com)<br/>2. EXTRACT_DOM<br/>3. SUMMARIZE_RESEARCH
    Planner-->>Coordinator: plan (3 steps)

    loop Execute Steps
        Coordinator->>Executor: executeStep(OPEN_URL https://example.com)
        Executor-->>Coordinator: ok: true
        Coordinator->>Executor: executeStep(EXTRACT_DOM)
        Executor-->>Coordinator: ok: true
        Coordinator->>Executor: executeStep(SUMMARIZE_RESEARCH)
        Executor-->>Coordinator: ok: true
    end

    Note over Coordinator: All steps succeeded, errors = []<br/>Sets result.state = "COMPLETED" (No goal satisfaction check!)
    Coordinator-->>HttpGateway: result (state: COMPLETED, errors: [], securityFlags: [])
    HttpGateway-->>Client: HTTP 200 { ok: true, result }
```

### Detailed Component Analysis

1. **`HttpGateway.ts` (lines 5832–5850):**
   - Receives payload: `{ goal: "Navigate to https://www.wikipedia.org", initialUrl: "https://example.com", allowedOrigins: ["example.com"] }`.
   - Forwards request directly to `browserIntelligenceCoordinator.executeTask()`.
   - Returns `{ ok: true, result }` with HTTP 200.

2. **`BrowserIntentInterpreter.ts` (lines 44–186):**
   - Correctly extracts URLs from `req.goal`:
     `allUrls = sanitized.match(/https?:\/\/[^\s"'<>]+/gi) || []` -> `["https://www.wikipedia.org"]`.
   - Sets `intent.targetUrl = "https://www.wikipedia.org"`.
   - Sets `intent.originRestrictions = ["www.wikipedia.org"]`.
   - Sets `intent.primaryAction = "OPEN_URL"`.

3. **`BrowserQueryPlanner.ts` (lines 84–251):**
   - Detects `isExplicitAllowlist = true` and normalizes `allowedOrigins = ["example.com"]`.
   - **Line 187:**
     ```typescript
     const targetUrl = req.initialUrl || intent.targetUrl;
     ```
     Because `req.initialUrl` (`"https://example.com"`) is non-empty, JavaScript short-circuit evaluation sets `targetUrl = "https://example.com"`.
   - **Lines 191–205:**
     ```typescript
     if (isExplicitAllowlist && allowedOrigins.length > 0) {
       if (!isTargetAllowedByOrigins(targetUrl, allowedOrigins)) {
         // Throws ORIGIN_RESTRICTION
       }
     }
     ```
     The check runs **only** on `targetUrl` (`"https://example.com"`). Since `"https://example.com"` matches `allowedOrigins`, the check succeeds.
   - **Goal URLs completely unvalidated:**
     `intent.targetUrl`, `intent.originRestrictions`, and raw URLs parsed from `req.goal` are never compared against `allowedOrigins`.
   - **Plan generation:**
     - Adds step 1: `OPEN_URL` -> `"https://example.com"`.
     - Adds step 2: `EXTRACT_DOM`.
     - Adds step 3: `SUMMARIZE_RESEARCH`.
     - Drops `"https://www.wikipedia.org"` entirely.

4. **`BrowserIntelligenceCoordinator.ts` (lines 140–295):**
   - Executes the 3 planned steps against `"https://example.com"`.
   - Every step succeeds (`actionRes.ok === true`).
   - Lines 281–288:
     ```typescript
     await this._handoffToResearchPipeline(result, req.goal);
     if (...) { ... }
     else if (result.errors.length > 0 && result.extractedPages.length === 0) {
       result.state = "FAILED";
     } else {
       result.state = "COMPLETED";
     }
     ```
     Because `result.errors` is empty `[]`, `result.state` is set to `"COMPLETED"`.
   - **No Goal Satisfaction Verification:** The coordinator treats execution of planned steps as equivalent to task success, without verifying whether the requested goal URL was visited.

---

## 3. Findings Regarding the SEC-04 Implementation

### 3.1 Does SEC-04 check URLs extracted from the goal?
**NO.** The SEC-04 fix only checked:
1. `intent.comparisonUrls` (during `COMPARE_DOCUMENTS` workflows).
2. `targetUrl = req.initialUrl || intent.targetUrl` (during single-target navigation workflows).
3. `step.target` during execution in `BrowserActionExecutor`.

When `req.initialUrl` is provided, `intent.targetUrl` is completely discarded before the planner's origin check runs. URLs in `req.goal` were never independently extracted and validated in `BrowserQueryPlanner`.

### 3.2 Does plan validation throw?
Plan validation in `BrowserQueryPlanner.plan()` **does throw** if `targetUrl` violates `allowedOrigins`. However, because `targetUrl` was set to `req.initialUrl` (`"https://example.com"`), no violation was detected, so plan validation silently passed.

### 3.3 Does task completion require the requested goal to be satisfied?
**NO.** `BrowserIntelligenceCoordinator` contains no post-condition or verification check comparing the final browser URL or extracted pages against the URLs specified in the user's goal. As long as the planned steps finish with zero runtime errors, the coordinator marks the task as `COMPLETED`.

---

## 4. Root Cause Summary

| Defect | Location | Mechanism | Consequence |
| :--- | :--- | :--- | :--- |
| **Goal URL Shadowing** | `BrowserQueryPlanner.ts:187` | `const targetUrl = req.initialUrl \|\| intent.targetUrl;` | `req.initialUrl` overrides and erases `intent.targetUrl`. |
| **Missing Goal URL Validation** | `BrowserQueryPlanner.ts:190-205` | Only validates `targetUrl` against `allowedOrigins`. | URLs in `req.goal` are never validated against `allowedOrigins`. |
| **Goal Amnesia in Step Planning** | `BrowserQueryPlanner.ts:243` | Plans `OPEN_URL` to `targetUrl` (`example.com`), omitting Wikipedia. | The browser performs actions on an unrelated domain. |
| **False Completion Attribution** | `BrowserIntelligenceCoordinator.ts:287` | Sets `state = "COMPLETED"` whenever planned steps have 0 errors. | User receives `COMPLETED` for an unperformed, blocked goal. |

---

## 5. Proposed Minimal & Safe Fix

### 5.1 Changes to `backend/research/browser/BrowserQueryPlanner.ts`

1. **Extract and Validate All Task URLs:**
   Extract all candidate URLs and target origins before planning any steps:
   ```typescript
   // 1. Gather all candidate URLs from request, intent, and goal text
   const goalUrls = req.goal.match(/https?:\/\/[^\s"'<>]+/gi) || [];
   const candidateUrls: Array<{ url: string; source: string }> = [];

   if (req.initialUrl) {
     candidateUrls.push({ url: req.initialUrl, source: "initialUrl" });
   }
   if (intent.targetUrl) {
     candidateUrls.push({ url: intent.targetUrl, source: "goal target" });
   }
   for (const u of goalUrls) {
     if (!candidateUrls.some((c) => c.url === u)) {
       candidateUrls.push({ url: u, source: "goal" });
     }
   }
   if (intent.comparisonUrls) {
     for (const u of intent.comparisonUrls) {
       if (!candidateUrls.some((c) => c.url === u)) {
         candidateUrls.push({ url: u, source: "comparison target" });
       }
     }
   }
   ```

2. **Strict Fail-Closed Enforcement When `allowedOrigins` is Explicit:**
   ```typescript
   if (isExplicitAllowlist && allowedOrigins.length > 0) {
     for (const { url, source } of candidateUrls) {
       if (!isTargetAllowedByOrigins(url, allowedOrigins)) {
         const reason = `ORIGIN_RESTRICTION: Target URL '${url}' from ${source} is outside task-scoped allowedOrigins (${allowedOrigins.join(", ")}).`;
         securityAuditLogger.logEvent({
           eventType: "TOOL_BLOCKED",
           actor: { identityId: "browser_intelligence", role: "standard", ipAddress: "127.0.0.1" },
           target: { toolName: "browserQueryPlanner", resource: url },
           riskLevel: "HIGH",
           decision: "BLOCK",
           reason,
           metadata: { goal: req.goal, candidateUrl: url, source, allowedOrigins },
         });
         throw new Error(reason);
       }
     }
   }
   ```

3. **Validate All Candidate URLs via `researchSecurityGate.validateUrl()`:**
   Ensure SSRF and private-network checks run on all candidate URLs, not just `targetUrl`.

4. **Correct Goal Navigation Target Resolution:**
   When both `req.initialUrl` and a distinct `intent.targetUrl` are provided and both are allowed:
   - If `intent.primaryAction === "OPEN_URL"` or `"NAVIGATE"`, the ultimate navigation target is `intent.targetUrl`.
   - If `req.initialUrl` is provided and different, plan step 1 as `OPEN_URL` (`req.initialUrl`) and step 2 as `NAVIGATE` (`intent.targetUrl`), or prioritize `intent.targetUrl` as the intended navigation target.

### 5.2 Expected Behavior Under the Fix

When the client sends:
```json
{
  "goal": "Navigate to https://www.wikipedia.org",
  "initialUrl": "https://example.com",
  "allowedOrigins": ["example.com"]
}
```

1. `BrowserQueryPlanner.plan()` inspects candidate URLs: `https://example.com` (allowed) and `https://www.wikipedia.org` (denied).
2. It detects that `https://www.wikipedia.org` violates `allowedOrigins: ["example.com"]`.
3. It emits a structured `TOOL_BLOCKED` audit event via `securityAuditLogger.logEvent()`.
4. It immediately throws:
   `Error("ORIGIN_RESTRICTION: Target URL 'https://www.wikipedia.org' from goal target is outside task-scoped allowedOrigins (example.com).")`.
5. `BrowserIntelligenceCoordinator.executeTask()` catches the error in its planning phase:
   - Sets `result.state = "FAILED"`.
   - Adds the error message to `result.errors` and `result.securityFlags`.
   - Sets `result.steps = []`.
   - Returns immediately with **0 browser steps executed** and **no browser actions performed**.
6. `HttpGateway` responds with `result.state === "FAILED"`, `errors: [...]`, `securityFlags: ["ORIGIN_RESTRICTION: ..."]`.

---

## 6. Proposed Regression Test Suite

Add test `SEC04.8` to `tests/integration/stage9_evaluation_acceptance.test.ts`:

```typescript
it("SEC04.8 Rejects task with ORIGIN_RESTRICTION when goal specifies forbidden URL even if initialUrl is allowed", async () => {
  const coordinator = new BrowserIntelligenceCoordinator();
  securityAuditLogger.resetForTesting();

  const result = await coordinator.executeTask({
    goal: "Navigate to https://www.wikipedia.org",
    initialUrl: "https://example.com",
    allowedOrigins: ["example.com"],
  });

  // Must fail closed immediately
  expect(result.state).toBe("FAILED");
  expect(result.securityFlags.some((f) => f.includes("ORIGIN_RESTRICTION"))).toBe(true);
  expect(result.errors.some((e) => e.includes("ORIGIN_RESTRICTION"))).toBe(true);
  expect(result.steps.length).toBe(0); // Zero browser actions planned or executed

  // Audit event must be logged
  const events = securityAuditLogger.getRecentEvents(10);
  const blocked = events.find(
    (ev) => ev.eventType === "TOOL_BLOCKED" && ev.decision === "BLOCK" && ev.target?.resource === "https://www.wikipedia.org"
  );
  expect(blocked).toBeDefined();
  expect(blocked?.reason).toMatch(/ORIGIN_RESTRICTION/);
});
```

---

## 7. Scope Boundaries & Invariants

- **Authorized Files For Future Fix:**
  1. `backend/research/browser/BrowserQueryPlanner.ts`
  2. `tests/integration/stage9_evaluation_acceptance.test.ts`
- **Strictly Frozen & Untouched:**
  - `desktop_agent/tools_browser.py`
  - `desktop_agent/egress_proxy.py`
  - `electron/`
  - `android/`
  - Exactly 129 `LIVE_TOOLS` invariant preserved.
- **Current State:**
  - Zero code or test modifications have been made.
  - Working tree remains clean.
