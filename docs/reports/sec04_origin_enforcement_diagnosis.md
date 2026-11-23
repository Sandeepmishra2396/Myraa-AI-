# MYRAA SEC-04 — Origin Enforcement Evidence Diagnosis

**Status:** DIAGNOSIS COMPLETE — REVIEW REQUIRED BEFORE IMPLEMENTATION  
**Date:** October 22, 2026  
**Investigator:** Antigravity AI Engineering Platform  
**Target:** Task-scoped `allowedOrigins` configuration, enforcement, and inspection across UI, API, and Core Security Architecture.

---

## 1. Executive Summary & Core Verdict

A read-only architectural investigation was conducted across `frontend/`, `backend/gateway/HttpGateway.ts`, `backend/research/browser/`, `backend/security/SecurityPolicyEngine.ts`, `backend/security/SecurityAuditLogger.ts`, and `backend/tasks/TaskManager.ts`.

### Key Verdict:
1. **Enforcement exists at the action level**: `BrowserActionExecutor._validateOriginAndSsrf()` correctly denies navigation to unapproved hostnames with `ORIGIN_RESTRICTION: Target '<host>' is outside task-scoped origins (<allowedOrigins>).`
2. **Planner Auto-Widening Defeat (Critical Gap)**: When tasks are created via `POST /api/browser-intelligence/execute`, `BrowserQueryPlanner.ts` (lines 46–48 and 122–124) automatically and silently appends any URL hostname found in `goal` or `comparisonUrls` into `allowedOrigins`. A task created with `allowedOrigins: ["example.com"]` and goal `"Navigate to https://www.wikipedia.org"` has its `allowedOrigins` widened to `["example.com", "www.wikipedia.org"]`, completely neutralizing the origin boundary at planning time.
3. **No UI Affordance**: Neither `BrowserAgent.tsx` nor `frontend/App.tsx` exposes task-scoped `allowedOrigins`. The UI browser agent operates solely on ephemeral tool triggers (`browserOpen`, `browserSearch`, etc.) without origin constraints.
4. **Security Policy & Telemetry Disconnect**: `SecurityPolicyEngine` has zero awareness of `allowedOrigins`. Furthermore, `BrowserActionExecutor` never logs `ORIGIN_RESTRICTION` rejections to `securityAuditLogger` or `SecurityEventStream`. Rejections exist only as in-memory strings in transient API responses.
5. **Coordinator Retry Waste**: `BrowserIntelligenceCoordinator` does not treat `ORIGIN_RESTRICTION` as a fatal security violation (it checks only `SECURITY_VIOLATION`), causing it to fruitlessly retry the blocked step `maxRetries` times with exponential backoff before marking the task failed.

---

## 2. End-to-End Architectural Trace

```
[ User Request / API Client ]
             │
             ├── (UI: No input exists)
             │
             ▼
[ POST /api/browser-intelligence/execute ] (HttpGateway.ts:5832)
   Body: { goal, initialUrl, allowedOrigins: ["example.com"] }
             │
             ▼
[ BrowserIntelligenceCoordinator.executeTask ] (BrowserIntelligenceCoordinator.ts:70)
   - Assigns taskId: `btask_<hex>`
   - Emits initiation audit: TOOL_ALLOW (SecurityAuditLogger)
             │
             ▼
[ BrowserIntentInterpreter.interpret ] (BrowserIntentInterpreter.ts:39)
   - Extracts targetUrl and originRestrictions from natural language
             │
             ▼
[ BrowserQueryPlanner.plan ] (BrowserQueryPlanner.ts:23)
   - Line 32: allowedOrigins = [...(req.allowedOrigins || intent.originRestrictions)]
   - [GAP 1 BUG]: Lines 122-124 & 46-48:
       if (!allowedOrigins.includes(parsed.hostname)) {
           allowedOrigins.push(parsed.hostname);  <-- SILENT MUTATION / AUTO-WIDENING!
       }
             │
             ▼
[ BrowserIntelligenceCoordinator step execution loop ] (line 191)
   - Invokes `browserActionExecutor.executeStep(step, { allowedOrigins: plan.allowedOrigins })`
             │
             ▼
[ BrowserActionExecutor.executeStep ] (BrowserActionExecutor.ts:82)
   - Invokes `_validateOriginAndSsrf(targetUrl, context.allowedOrigins)` (line 624)
   - Checks hostname matching (parsed.hostname === origin || .endsWith)
   - If not allowed:
       Returns `{ ok: false, error: "ORIGIN_RESTRICTION: Target ... is outside task-scoped origins (...)." }`
   - [GAP 2]: Zero audit logging to SecurityAuditLogger or SecurityPolicyEngine!
   - [GAP 3]: Coordinator does not halt immediately; retries 3x with backoff!
   - If allowed: Calls `callDesktopAgent("desktopBrowserOpen", { url })` -> Chromium Playwright
```

---

## 3. Exact UI Action & API Request Needed to Create Restricted Task

### 3.1 UI Action
**Does not exist.**  
Search of the entire frontend codebase (`frontend/App.tsx`, `frontend/components/BrowserAgent.tsx`, `frontend/components/SettingsPanel.tsx`) confirms:
- `allowedOrigins` does not appear in any `.tsx` or `.ts` file under `frontend/`.
- The UI Browser Agent is directly hooked to live Gemini tool calls (`browserOpen`, `browserSearch`, `browserTabAction`). It has no mechanism for task creation, task IDs, or origin restrictions.

### 3.2 Existing API Request
The only existing interface to configure `allowedOrigins` is the localhost HTTP Gateway endpoint:

**Endpoint:** `POST http://127.0.0.1:3000/api/browser-intelligence/execute`  
**Headers:** `Content-Type: application/json`  
**Request Body:**
```json
{
  "goal": "Inspect Example Domain",
  "initialUrl": "https://example.com",
  "allowedOrigins": ["example.com"],
  "timeoutMs": 30000,
  "maxRetries": 1
}
```

**Expected Response (200 OK):**
```json
{
  "ok": true,
  "result": {
    "taskId": "btask_1792670680573_55fce9",
    "state": "COMPLETED",
    "steps": [
      {
        "action": "OPEN_URL",
        "target": "https://example.com",
        "status": "COMPLETED"
      },
      {
        "action": "EXTRACT_DOM",
        "status": "COMPLETED"
      },
      {
        "action": "SUMMARIZE_RESEARCH",
        "status": "COMPLETED"
      }
    ],
    "errors": [],
    "securityFlags": []
  }
}
```

---

## 4. Reproducible Steps to Attempt Navigation to Wikipedia & Observed Evidence

### 4.1 Empirical Test 1: Task Creation with Conflicting Goal (`executeTask`)
Attempting to create a task navigating to `https://www.wikipedia.org` while specifying `allowedOrigins: ["example.com"]`.

**Execution Command:**
```bash
npx tsx -e "
(async () => {
  const { browserIntelligenceCoordinator } = await import('./backend/research/browser/BrowserIntelligenceCoordinator.ts');
  const res = await browserIntelligenceCoordinator.executeTask({
    goal: 'Navigate to https://www.wikipedia.org',
    allowedOrigins: ['example.com'],
    timeoutMs: 10000,
    maxRetries: 1,
  });
  console.log('TASK_ID:', res.taskId);
  console.log('STATE:', res.state);
  console.log('ERRORS:', res.errors);
  console.log('STEPS:', res.steps);
})();"
```

**Observed Output:**
```
TASK_ID: btask_1792670659752_fb1ac8
STATE: COMPLETED
ERRORS: []
SECURITY_FLAGS: []
STEPS: [
  { action: 'OPEN_URL', target: 'https://www.wikipedia.org', status: 'COMPLETED' },
  { action: 'EXTRACT_DOM', status: 'COMPLETED' },
  { action: 'SUMMARIZE_RESEARCH', status: 'COMPLETED' }
]
```

**Evidence Finding:**
The navigation to `www.wikipedia.org` was **NOT blocked**.  
`BrowserQueryPlanner.ts:123` inspected `targetUrl = "https://www.wikipedia.org"` and executed:
```ts
if (!allowedOrigins.includes(parsed.hostname)) {
  allowedOrigins.push(parsed.hostname);
}
```
This expanded `allowedOrigins` to `["example.com", "www.wikipedia.org"]`, bypassing the caller's restriction entirely.

---

### 4.2 Empirical Test 2: Action-Level Enforcement (`executeAction`)
Attempting discrete navigation to `https://www.wikipedia.org` with explicit `allowedOrigins: ["example.com"]`.

**Execution Command:**
```bash
npx tsx -e "
(async () => {
  const { browserActionExecutor } = await import('./backend/research/browser/BrowserActionExecutor.ts');
  const { securityAuditLogger } = await import('./backend/security/SecurityAuditLogger.ts');
  const { browserTabManager } = await import('./backend/research/browser/BrowserTabManager.ts');
  
  const beforeUrl = browserTabManager.getActiveTab()?.url || 'about:blank';
  const beforeEvents = (securityAuditLogger.getRecentEvents?.(10) || []).length;

  const res = await browserActionExecutor.executeStep({
    stepId: 'sec04_probe',
    action: 'NAVIGATE',
    target: 'https://www.wikipedia.org',
    status: 'PENDING',
    retries: 0,
    maxRetries: 1,
  }, {
    allowedOrigins: ['example.com'],
  });

  const afterUrl = browserTabManager.getActiveTab()?.url || 'about:blank';
  const afterEvents = (securityAuditLogger.getRecentEvents?.(10) || []).length;

  console.log('RESULT:', JSON.stringify(res, null, 2));
  console.log('ACTIVE_URL_BEFORE:', beforeUrl, 'AFTER:', afterUrl);
  console.log('AUDIT_EVENTS_BEFORE:', beforeEvents, 'AFTER:', afterEvents);
})();"
```

**Observed Output:**
```json
RESULT: {
  "ok": false,
  "error": "ORIGIN_RESTRICTION: Target 'www.wikipedia.org' is outside task-scoped origins (example.com)."
}
ACTIVE_URL_BEFORE: about:blank AFTER: about:blank
AUDIT_EVENTS_BEFORE: 0 AFTER: 0
```

**Evidence Finding:**
1. **Pre-flight rejection works**: The target URL was rejected before any network traffic or Playwright IPC was initiated.
2. **Zero URL Mutation**: The active tab URL remained `about:blank`.
3. **Zero Telemetry**: `securityAuditLogger` remained at 0 events. No audit record was created.
4. **No Task ID**: `executeAction` is stateless and does not bind to an existing task ID.

---

## 5. Taxonomy of Failure Modes

To ensure verification is objective and grounded, here is how each failure mode is distinguished:

| Failure Mode | Trigger Point | Error Signature / Telemetry | Browser / Socket Impact |
|---|---|---|---|
| **Origin Policy Denial** | Node.js `BrowserActionExecutor._validateOriginAndSsrf()` | Error string: `ORIGIN_RESTRICTION: Target '<host>' is outside task-scoped origins (...)`. Currently **no** audit log entry. | **Zero network impact.** No command is sent to Chromium or Desktop Agent. Browser tab and active URL are completely untouched. |
| **SSRF Policy Denial** | Node.js `ResearchSecurityGate.validateUrl()` | Error string: `SECURITY_VIOLATION: Navigation to '<url>' blocked: <reason>`. Emits threat containment alert. | **Zero network impact.** Blocked before socket creation. |
| **Proxy Egress Denial (AC14)** | Python `egress_proxy.py:274` | HTTP 403 Forbidden / `net::ERR_ACCESS_DENIED`. Logged in Python proxy log as restricted destination. | Chromium TCP connection reaches local proxy `127.0.0.1:<port>`, proxy terminates with 403. Outbound connection never reaches external target. |
| **Browser Closure (NF-02)** | Python `tools_browser.py:233` | `Target page, context or browser has been closed` / `TargetClosedError`. | Playwright browser process crashed or tab closed unexpectedly. Auto-recovered by NF-02 lifecycle handler. |
| **Navigation / DNS Failure** | Chromium network stack | `net::ERR_NAME_NOT_RESOLVED` or `net::ERR_CONNECTION_REFUSED`. | Chromium attempted egress via proxy, upstream DNS returned NXDOMAIN or host refused connection. |
| **Missing Telemetry** | Architectural gap in `BrowserActionExecutor` | `securityAuditLogger.getRecentEvents()` count does not increment on origin block. | System denies navigation, but security operations/SOC has zero audit record of the incident. |

---

## 6. Root Cause & Detailed Gap Analysis

### Gap 1: Query Planner Auto-Widening (`BrowserQueryPlanner.ts`)
- **Location:** `backend/research/browser/BrowserQueryPlanner.ts` lines 46–48 and lines 122–124:
  ```ts
  try {
    const parsed = new URL(targetUrl);
    if (!allowedOrigins.includes(parsed.hostname)) {
      allowedOrigins.push(parsed.hostname); // BUG: Overwrites caller's explicit restriction!
    }
  } catch { /* ... */ }
  ```
- **Consequence:** If the caller specifies `allowedOrigins: ["example.com"]`, but the goal asks to visit `wikipedia.org`, the planner automatically pushes `www.wikipedia.org` into `allowedOrigins`. The security policy is silently defeated.

### Gap 2: Disconnection from `SecurityAuditLogger` and `SecurityPolicyEngine`
- **Location:** `backend/research/browser/BrowserActionExecutor.ts` lines 638–644:
  ```ts
  if (!isAllowed) {
    return {
      ok: false,
      error: `ORIGIN_RESTRICTION: Target '${parsed.hostname}' is outside task-scoped origins (${allowedOrigins.join(", ")}).`,
    };
  }
  ```
- **Consequence:** Rejections are returned as unlogged action errors. They are never recorded in `securityAuditLogger`, never logged to `SecurityEventStream`, and never reflected in security risk scores.

### Gap 3: Coordinator Retries on Policy Denial instead of Fast-Fail
- **Location:** `backend/research/browser/BrowserIntelligenceCoordinator.ts` lines 238–243:
  ```ts
  if (step.error?.includes("SECURITY_VIOLATION") || step.error?.includes("CONFIRMATION_REQUIRED")) {
    result.securityFlags.push(step.error);
    result.state = "FAILED";
    break;
  }
  ```
- **Consequence:** `ORIGIN_RESTRICTION` is not recognized as a fatal security halt. The coordinator retries the exact same prohibited step 3 times with backoff delays before finally concluding the step failed.

### Gap 4: Absence of UI Task Management
- **Location:** `frontend/components/BrowserAgent.tsx` and `frontend/App.tsx`.
- **Consequence:** Task-scoped browsing is only accessible via raw HTTP API. The UI has no controls to define `allowedOrigins`, display active task IDs, or view origin violation notices.

---

## 7. Proposed Minimal Fix Plan (For User Review & Approval)

To establish robust, verifiable origin enforcement without expanding scope beyond necessary boundaries:

### Proposed Files to Change:
1. `backend/research/browser/BrowserQueryPlanner.ts`:
   - Do **NOT** auto-push `targetUrl` or `comparisonUrls` into `allowedOrigins` if `req.allowedOrigins` was explicitly provided.
   - If `req.allowedOrigins` was provided and target URL is outside it: either fail plan creation with `ORIGIN_RESTRICTION` or keep `allowedOrigins` strictly frozen so execution enforces the block.
2. `backend/research/browser/BrowserActionExecutor.ts`:
   - Import `securityAuditLogger`.
   - Log an explicit `TOOL_BLOCKED` event to `securityAuditLogger` on `ORIGIN_RESTRICTION` (recording actor, target hostname, allowedOrigins, and auditId).
3. `backend/research/browser/BrowserIntelligenceCoordinator.ts`:
   - Add `ORIGIN_RESTRICTION` to fatal security check in line 239 (`step.error?.includes("ORIGIN_RESTRICTION")`), appending to `securityFlags` and failing fast without retrying.
4. `tests/integration/stage9_evaluation_acceptance.test.ts`:
   - Add automated test verifying that creating a task with `allowedOrigins: ["example.com"]` and attempting navigation to `https://www.wikipedia.org` generates an explicit origin denial, halts without retrying, logs a `TOOL_BLOCKED` audit event, and leaves active URL at `about:blank`.

---

## 8. Verification & Review Checkpoint

- **Code Edits Made:** 0 (Investigation was strictly read-only).
- **Working Tree:** Preserved with existing NF-02, NF-03, and AC14 fixes intact.
- **Tools Count:** Preserved at exactly 129 `LIVE_TOOLS`.
- **Awaiting Approval:** Do not implement until you explicitly review and approve the findings and proposed minimal fix plan.
