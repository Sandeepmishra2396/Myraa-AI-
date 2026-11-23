# MYRAA — Stage 10.3 P0 Final Independent Acceptance Audit (`GAP-10.3-04`)

- **Audit Mode:** STRICT READ-ONLY — Independent Principal Application Security & Backend Architecture Verification
- **Date:** 2026-11-18
- **Audited Remediation Report:** `stage10_phase10_3_P0_confirmation_security_remediation_report.md`
- **Audited Target Finding:** `GAP-10.3-04` (HIGH) from `stage10_phase10_3_final_acceptance_R2.md`
- **Executive Verdict:** **`FAIL`** *(Core model-callable decision-approval bypass is CLOSED, but independent auditing confirmed reachable credential-disclosure paths in stdout logging and `STRICT`/`PARANOID` tool responses, double token minting, and a fail-open `admin` fallback / local `/live` session-context drop in the audited execution chain that violate `PASS` acceptance gates.)*

---

## 1. Executive Verdict

**Verdict: `FAIL`**

### Rationale Against Section 12 Verdict Rules

1. **What Passed Independently:**
   - **Model-callable decision approval is eliminated (`PASS — SOURCE INSPECTION`, `PASS — AUTOMATED TEST`):** `confirmationToken` is removed from `LIVE_TOOLS.trackProjectTask`, `LIVE_TOOLS` remains exactly **129 declarations / 129 unique names**, `_handleProjectTool` has zero `confirmDecision` or `checkpointManager` calls, and `ConversationManager.ts:1022` is the **sole live runtime caller** of `projectDecisionStore.confirmDecision()` across the entire `backend/` codebase.
   - **Legacy planner checkpoint fallback is unreachable (`PASS — SOURCE INSPECTION`, `PASS — AUTOMATED TEST`):** Zero references to `checkpointManager` exist inside `_handleProjectTool` (`ToolOrchestrator.ts:890–1394`); `confirmCheckpoint` cannot indirectly confirm project decisions.
   - **Authenticated human WebSocket confirmation route is sound (`PASS — SOURCE INSPECTION`, `PASS — AUTOMATED TEST`):** `ConversationManager.ts:844–1295` independently enforces live socket session extraction, RBAC, Emergency Stop, Security Lockdown, server-canonical decision lookup, HMAC/TTL/argsHash/session match, single-use consumption, explicit rejection revocation, and post-persistence cache invalidation.
   - **Frozen boundaries & regressions preserved (`PASS — AUTOMATED TEST`):** All 275 distinct tests across 8 suites, `npx tsc --noEmit`, and `LIVE_TOOLS` checks exited with code `0`; all 11 frozen files/directories remained untouched.

2. **Why the Audit Verdict MUST Be `FAIL` (Blocking Residual Findings):**
   - **`AUD-P0-01` (HIGH — Reachable Plaintext Credential Logging Leak):** `backend/tools/ToolOrchestrator.ts:244` executes `console.log(\`[Function Call]: \${fc.name}\`, fc.args);` unconditionally **before** any security check, redaction, or block. During independent test execution (`phase10_project_continuity.test.ts`), live signed `sora_conf_<redacted>` confirmation tokens were printed verbatim in plaintext to stdout. Secondary leak/redaction gaps also exist at `backend/security/SecurityPolicyEngine.ts:958` (echoes raw non-`sora_conf_` `providedToken` into `rejectReason` / `console.warn` / error output / audit) and `backend/security/SecurityAuditLogger.ts:74` (regex `/sora_[a-z0-9_]+/gi` stops at `-` and `.` in base64url/HMAC tokens).
   - **`AUD-P0-02` (HIGH — Model Tool Output Token Leak in `STRICT`/`PARANOID` Modes + Double Token Minting):**
     - In `STRICT` or `PARANOID` security mode, `SecurityPolicyEngine.ts:907–934` generates a signed `sora_conf_*` token for `trackProjectTask` (`MEDIUM_RISK_TOOLS`) and `ToolOrchestrator.ts:288–304` returns `confirmationToken: policyDecision.confirmationToken` **directly into model tool output** via raw `session.sendToolResponse()` (bypassing `outputDataFirewall`).
     - In `NORMAL`/`BALANCED` mode, `ToolOrchestrator.ts:1247` mints Token #1 and `GeminiSessionFactory.ts:2569` mints Token #2 (overwriting Token #1 without revoking it). On `/remote-live`, Token #1 remains a live, unrevoked, session-bound stateless HMAC capability for its 5-minute TTL; on local `/live`, Token #1 is minted with fallback `sessionId: "local"` instead of the socket's real `local_sess_<uuid>`.
   - **`AUD-P0-03` (MEDIUM/HIGH — Local `/live` Context Drop & Fail-Open Admin Fallback in `ToolOrchestrator.dispatch()`):**
     - `GeminiSessionFactory.ts:2825–2837` only populates `callerSecContext` when `clientWs.remoteDevice` is truthy, ignoring `clientWs.remoteSession` (`role: "standard"`, `sessionId: "local_sess_<uuid>"`, attached by `server.ts:202–230`) on local `/live` sockets and passing `undefined`.
     - `ToolOrchestrator.ts:267–272` fails **OPEN** when `context` is omitted, silently elevating calls to `{ identityId: "local_operator", role: "admin", ipAddress: "127.0.0.1", isLocal: true }` with `sessionId: undefined` (and also trusts `(fc as any).securityContext`). This breaks role parity with `server.ts`/`ConversationManager.ts` (`standard` vs `admin`), omits `local_sess_<uuid>` from `_handleProjectTool` audit events, and means missing `context` at the public `dispatch()` boundary does not fail closed.

Under Section 12 Verdict Rules (*"`FAIL` if any approval bypass, session-binding weakness, RBAC bypass, credential leak, or unsubstantiated critical/high claim remains"*), `PASS` and `CONDITIONAL PASS` are both prohibited until `AUD-P0-01`, `AUD-P0-02`, and `AUD-P0-03` are remediated under explicit narrow authorization.

---

## 2. Independent Finding-by-Finding Closure Matrix

| Audit Area / Finding ID | Requirement | Independent Verification Status | Classification | Evidence Summary |
| :--- | :--- | :---: | :--- | :--- |
| `GAP-10.3-04` (Core Bypass) | Model-callable `trackProjectTask(confirm_decision)` cannot approve decisions | **CLOSED** | `PASS — SOURCE INSPECTION`, `PASS — AUTOMATED TEST` | `confirmationToken` absent from `LIVE_TOOLS`; `confirm_decision` never calls `confirmDecision()`; any supplied credential returns `model_approval_prohibited`; `P0-01..P0-05` verified against persisted store. |
| `GAP-10.3-04` (Legacy Fallback) | `checkpointManager.get()` fallback unreachable from `_handleProjectTool` | **CLOSED** | `PASS — SOURCE INSPECTION`, `PASS — AUTOMATED TEST` | `0` `checkpointManager` references in `ToolOrchestrator.ts:890–1394`; `P0-04`/`P0-05` prove pending and approved planner checkpoints fail closed. |
| `GAP-10.3-04` (Schema Invariant) | `LIVE_TOOLS` preserves exactly 129 declarations and 129 unique names | **CLOSED** | `PASS — SOURCE INSPECTION`, `PASS — AUTOMATED TEST` | Programmatic `tsx` check confirms `total: 129`, `unique: 129`, `hasConfirmationToken: false`, `hasGetProjectContinuity: false`. |
| `GAP-10.3-04` (Internal RBAC) | `_handleProjectTool` denies `guest`/`read_only` on mutating actions & removes `"local_user"` | **CLOSED (within `_handleProjectTool`)** | `PASS — SOURCE INSPECTION`, `PASS — AUTOMATED TEST` | `enforceProjectMutationAuth()` blocks `guest`/`read_only`, Emergency Stop, Lockdown, malformed `secContext`, and remote missing `sessionId`; `0` hardcoded `"local_user"` actors remain. |
| **`AUD-P0-01`** *(New — Batch D)* | No plaintext credential/token leak in stdout or error/audit logging | **OPEN (HIGH)** | `FAIL` | `ToolOrchestrator.ts:244` prints raw `fc.args` (observed live `sora_conf_<redacted>` in stdout); `SecurityPolicyEngine.ts:958` echoes raw `providedToken` in `rejectReason`; `SecurityAuditLogger.ts:74` regex misses `-`/`.` in `sora_conf_*` tokens. |
| **`AUD-P0-02`** *(New — Batch B)* | Confirmation token never appears in model tool output; no unintended duplicate token capability | **OPEN (HIGH)** | `FAIL` | `ToolOrchestrator.ts:297` returns `policyDecision.confirmationToken` directly to model via unguarded `session.sendToolResponse()` in `STRICT`/`PARANOID` mode; `ToolOrchestrator.ts:1247` + `GeminiSessionFactory.ts:2569` double-mint tokens without revoking Token #1. |
| **`AUD-P0-03`** *(New — Batch C)* | Missing/untrusted security context fails closed at public boundary; local `/live` preserves server-minted session & role | **OPEN (MEDIUM/HIGH)** | `FAIL` | `GeminiSessionFactory.ts:2828` ignores `clientWs.remoteSession` on local `/live` (`role: "standard"`, `local_sess_<uuid>`), passing `undefined`; `ToolOrchestrator.ts:267–272` fails open to `role: "admin"`, `sessionId: undefined` and accepts `(fc as any).securityContext`. |
| **`AUD-P0-04`** *(New — Batch E)* | Accuracy of implementation report test claims (`P0-09`, `P0-10`, `P0-12`, `P0-13`, `P0-14`) | **OPEN (LOW/MEDIUM)** | `FAIL` | Report overstated per-test assertions inside `P0-10`/`P0-12`/`P0-13` (assertions exist in earlier tests in the same file, not inside those named blocks); `P0-09` bypassed `dispatch()`; `P0-14` omitted stdout verification. |

---

## 3. Model-Callable Approval Reachability Analysis (Batch A)

Codebase-wide searches across `backend/**/*.ts` for `confirmDecision`, `confirm_decision`, `projectDecisionStore`, `projectContinuityResolver`, `trackProjectTask`, `getProjectContinuity`, and `confirmCheckpoint` confirmed:

1. **Schema Check (`backend/ai/GeminiSessionFactory.ts:1344–1414`):**
   - `trackProjectTask` exposes 9 actions: `list`, `add`, `update`, `resume`, `continuity`, `historical`, `switch`, `record_decision`, `confirm_decision`.
   - Parameters are strictly: `action`, `projectName`, `title`, `description`, `status`, `taskId`, `date`, `decisionId`, `decisionType`, `sessionSummary`, `nextSteps`.
   - `confirmationToken` is absent (`hasConfirmationToken: false`). No alternate parameter exists for approval credentials.
   - `LIVE_TOOLS` contains **129 declarations** and **129 unique names** (`hasGetProjectContinuity: false`).
2. **Dispatcher Check (`backend/tools/ToolOrchestrator.ts:1163–1289`):**
   - `args.confirmationToken ?? args.checkpointId ?? args._checkpointId ?? args.token` is inspected first; any non-empty value immediately fails closed with `{ success: false, blocked: true, decision: "BLOCK", error: "model_approval_prohibited" }`, emits zero `sendToClient`, and never touches `ProjectDecisionStore`.
   - Calling `confirm_decision` without credentials validates `decisionId`, project ownership (`cross_project_violation`), and `already_confirmed`, then emits `{ type: "confirmation_required", ... }` to `sendToClient` and returns `{ success: false, decision: "REQUIRE_CONFIRMATION", status: "confirmation_required", requiresConfirmation: true, modelApprovalProhibited: true, decisionId, projectId }` — **without** `confirmationToken` in `output` and **without** mutating `ProjectDecisionStore`.
   - `args.sessionSummary` write side effect (`line 1320`) is explicitly guarded with `&& action !== "confirm_decision"`.
3. **Complete Persistence Caller Graph:**
   - `ProjectDecisionStore.confirmDecision()` (`backend/projects/ProjectDecisionStore.ts:164`) has only **two** call sites in `backend/`:
     - `backend/conversation/ConversationManager.ts:1022` — **sole active runtime caller** (authenticated human WebSocket route).
     - `backend/projects/ProjectContinuityResolver.ts:584` — inside `ProjectContinuityResolver.confirmDecision()` (`line 566`), which has **zero** callers anywhere in `backend/`.
   - `ProjectDecisionStore.updateDecision()` (`lines 216–220`) rejects direct mutation of `confirmed`, and `saveDecision()` (`lines 107–111`) rejects overwriting already-confirmed decisions.
   - `backend/planner/StepExecutor.ts:88–90` returns `{ result: "Task tracking skipped in planner context." }` for `trackProjectTask`.
   - `ToolOrchestrator.ts:1830–1880` (`confirmCheckpoint`) calls `plannerCoordinator.confirmCheckpoint()` and `securityPolicyEngine.verifyAndConsumeConfirmation(..., "confirmCheckpoint", ...)`; even if pre-approval is recorded for `trackProjectTask` or `GeminiSessionFactory.ts:2851–2863` attaches `confToken` to `trackProjectTask` in a multi-call batch, `_handleProjectTool` still rejects any `confirm_decision` call with credentials and never calls `confirmDecision()`.
   - `checkpointManager` occurrences in `ToolOrchestrator.ts` exist solely at lines `31` (import), `1630`, `1637` (desktop dispatch safety gate), and `1792` (planner status read) — **completely unreachable** from `_handleProjectTool` (`lines 890–1394`).

**Batch A Conclusion:** Model-callable decision approval and the legacy `checkpointManager` fallback are **100% eliminated and unreachable** (`PASS — SOURCE INSPECTION`, `PASS — AUTOMATED TEST`).

---

## 4. Human Confirmation Route Security Trace (Batch B)

Full end-to-end trace inspected directly in source:

`ToolOrchestrator._handleProjectTool (1247–1275)` → `GeminiSessionFactory sendToClient wrapper (2554–2590)` → `frontend/lib/audio.ts (1006–1028, 1120–1155)` & `DecisionConfirmationModal.tsx (1–120)` → `ConversationManager.ts (844–1295)` → `SecurityPolicyEngine.ts (318–565)` → `ProjectDecisionStore.ts (164–192)`.

### Verified Controls (`PASS — SOURCE INSPECTION`, `PASS — AUTOMATED TEST`)
- **Frontend UI Independence:** `frontend/lib/audio.ts:1120–1155` sends `{ type: "confirm_decision", decisionId, projectId, confirmationToken }` or `{ type: "reject_decision", decisionId, projectId, confirmationToken }` directly over the authenticated WebSocket to `ConversationManager`; it never invokes `trackProjectTask(confirm_decision)` for approval/rejection.
- **Server-Side WebSocket Enforcement (`ConversationManager.ts:844–1295`):**
  1. Extracts live `socketSessionId` from `!flags.isClientClosed && clientWs.readyState === 1 ? clientWs.remoteSession?.sessionId || clientWs.remoteSessionId : undefined` (`lines 858–861`, `1092–1095`); fails closed with `MISSING_SESSION_CONTEXT`.
  2. Denies `guest` and `read_only` (`lines 887`, `1131`).
  3. Enforces Emergency Stop (`lines 908`, `1152`) and Security Lockdown (`lines 929`, `1173`).
  4. Fetches canonical `decision = await projectDecisionStore.getDecision(decisionId)` (`lines 950`, `1194`) and rejects any client-supplied `projectId !== decision.projectId` with `ARGS_MISMATCH` (`lines 962`, `1206`).
  5. Builds `canonicalArgs = { action: "confirm_decision", decisionId: decision.id, projectId: decision.projectId }` from server state only.
  6. Atomically verifies and consumes token BEFORE persistence with `{ requireSessionMatch: true }` (`lines 988–994`), or atomically revokes token on rejection (`lines 1232–1237`).
  7. Calls `projectDecisionStore.confirmDecision(decision.id, decision.projectId)` (`line 1022`) and calls `invalidateInstructionsCache()` (`line 1030`) **only after** persistence succeeds; on store failure, token remains consumed (fail-closed, `lines 1065–1086`).
- **Cryptographic & Lifecycle Controls (`SecurityPolicyEngine.ts:318–565`):** Enforces HMAC-SHA256 with `crypto.timingSafeEqual`, `processBootId` generation check, strict `sessionId` equality when `requireSessionMatch: true` (no `"local"` bypass), 5-minute TTL, tool binding, SHA-256 canonical `argsHash`, and synchronous in-memory one-time `_consumeTokenId()` for both `CONFIRMED` and `REVOKED`.

### Defects Identified in Batch B (`AUD-P0-02` — HIGH — `FAIL`)
1. **Model Tool Output Token Leak in `STRICT` / `PARANOID` Modes (`ToolOrchestrator.ts:279–306` + `SecurityPolicyEngine.ts:907–934`):**
   - Because `trackProjectTask` is in `MEDIUM_RISK_TOOLS` (`SecurityRiskEngine.ts:82`), switching `securityPolicyEngine` to `"STRICT"` or `"PARANOID"` causes `evaluateRequest()` (`line 907`) to mint a valid signed `sora_conf_*` token (`line 914`) and return it in `policyDecision.confirmationToken`.
   - `ToolOrchestrator.ts:288–304` immediately transmits `output: { ..., confirmationToken: policyDecision.confirmationToken }` directly back to Gemini via **raw `session.sendToolResponse()`** (before `guardedSession` / `outputDataFirewall` is constructed at line 309).
   - This directly violates *"The confirmation token never appears in model tool output"* and also prevents `trackProjectTask(confirm_decision)` from reaching `_handleProjectTool` to open the human UI modal in `STRICT`/`PARANOID` mode.
2. **Double Token Generation Without Revocation (`ToolOrchestrator.ts:1247` + `GeminiSessionFactory.ts:2569`):**
   - `ToolOrchestrator.ts:1247` generates **Token #1** (`tokenId = UUID_1`) using `secContext?.sessionId` (`undefined` -> `"local"` on local `/live`; `socketSid` on `/remote-live`).
   - `GeminiSessionFactory.ts:2566–2579` intercepts `outgoing.type === "confirmation_required"` and generates **Token #2** (`tokenId = UUID_2`) bound to `socketSessionId`, replacing `outgoing.confirmationToken` before `clientWs.send(...)`.
   - Token #1 is never sent over `clientWs.send` (so an external browser client does not receive it in the standard `GeminiSessionFactory` path), **but** Token #1 is never revoked:
     - On `/remote-live`, Token #1 is a valid, unrevoked, session-bound stateless HMAC token for the same `socketSid` and `canonicalArgs` for 5 minutes (if any alternate `sendToClient` sink or telemetry hook observes the pre-wrapper object, it holds an alternate usable capability).
     - On local `/live`, Token #1 is bound to `"local"` (cannot pass `ConversationManager` for a `local_sess_<uuid>` socket, but represents unnecessary token minting with the wrong session context).
   - **Recommended architecture (for future authorized fix):** Mint the confirmation token **once** (either pass live `socketSessionId` cleanly into `callerSecContext` so `ToolOrchestrator` mints a single session-bound token and `GeminiSessionFactory` only verifies/rejects unbound tokens, OR let `ToolOrchestrator` omit the token and have `GeminiSessionFactory` be the sole minter bound to `socketSessionId`).

---

## 5. Trusted Security Context and RBAC Assessment (Batch C)

### Complete Call-Chain Trace
1. **WebSocket Upgrade & Connection (`backend/server.ts:179–233`, `937–1016`):**
   - `/remote-live` (or any tokened upgrade): validates paired device credential via `remoteSecurityCoordinator.authenticateRemoteCredential(...)`, attaches `clientWs.remoteDevice`, and registers `remoteSessionManager.registerClient(...)` (attaching `clientWs.remoteSession` + `clientWs.remoteSessionId`).
   - Local `/live` (unauthenticated loopback): validates loopback IP, non-proxied headers, and same-origin/non-CSWSH `Origin`, marks a private `WeakMap` upgrade token, and calls `localLiveSessionRegistry.establishLocalSession(clientWs)` (`lines 179–233`), which attaches frozen, non-writable `clientWs.remoteSession = { sessionId: "local_sess_<uuid>", deviceId: "local_desktop", role: "standard", ipAddress, isLocal: true }` and `clientWs.remoteSessionId`.
2. **Gemini Tool-Call Context Construction (`backend/ai/GeminiSessionFactory.ts:2825–2837`):**
   - **Remote `/remote-live`:** `remoteDev` is populated -> builds `callerSecContext = { identityId: remoteDev.id, role: remoteDev.role || "standard", sessionId: socketSid, deviceId: remoteDev.id, ipAddress: remoteDev.lastIp || "127.0.0.1", isLocal: false }`. Model-supplied args cannot override these fields (`fc` is constructed as `{ name, args, id }`).
   - **Local `/live` (DEFECT `AUD-P0-03`):** `remoteDev` is `null`, so `callerSecContext` is set to **`undefined`**, completely discarding `clientWs.remoteSession` (`sessionId: "local_sess_<uuid>"`, `role: "standard"`, `deviceId: "local_desktop"`).
3. **Public Dispatch Gate (`backend/tools/ToolOrchestrator.ts:267–272` — DEFECT `AUD-P0-03`):**
   - `const secContext: SecurityContext = context || (fc as any).securityContext || { identityId: "local_operator", role: "admin", ipAddress: "127.0.0.1", isLocal: true };`
   - Any call to `dispatch()` omitting `context` (including **every local `/live` tool call** from `GeminiSessionFactory`) silently falls back to **`role: "admin"`, `identityId: "local_operator"`, `sessionId: undefined`, `isLocal: true`**, AND accepts an untrusted `(fc as any).securityContext` property if present on `fc`.
4. **Project Tool Guard (`backend/tools/ToolOrchestrator.ts:902–1112`, `1348–1355`):**
   - Validates `hasValidSecContext` (`identityId` non-empty, `role` in `{"admin", "standard", "read_only", "guest"}`), checks Emergency Stop, Security Lockdown, non-empty `sessionId` when `!secContext.isLocal`, and blocks `guest`/`read_only` for all mutating/sensitive actions (`add`, `update`, `switch`, `record_decision`, `confirm_decision`, non-empty `args.sessionSummary`, and `getProjectContinuity(action="switch")`).
   - Records `trustedAuditActor` from `secContext` (zero hardcoded `"local_user"` literals remain in `_handleProjectTool`).

### Actual Implemented Per-Action RBAC Matrix (Through Public `ToolOrchestrator.dispatch()`)

| Tool | Action / Modifier | Outer `SecurityPolicyEngine` (`BALANCED`) | `_handleProjectTool` | `admin` | `standard` | `read_only` | `guest` | Remote w/o `sessionId` | Malformed explicit `ctx` | Omitted `ctx` (`undefined`) at `dispatch()` |
| :--- | :--- | :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| `trackProjectTask` | `list` / `resume` / `continuity` / `historical` (no `sessionSummary`) | `MEDIUM` (`guest` **BLOCKED**) | Read-only (no mutation gate) | ALLOW | ALLOW | ALLOW | **BLOCK** *(outer)* | ALLOW | ALLOW* | ALLOW *(defaults to local admin)* |
| `trackProjectTask` | `add` / `update` / `switch` / `record_decision` | `MEDIUM` (`guest` **BLOCKED**) | `enforceProjectMutationAuth()` | ALLOW | ALLOW | **BLOCK** (`PERMISSION_DENIED`) | **BLOCK** (`PERMISSION_DENIED`) | **BLOCK** (`MISSING_SESSION_CONTEXT`) | **BLOCK** (`MISSING_SECURITY_CONTEXT`) | **ALLOW — FAILS OPEN (`AUD-P0-03`)** |
| `trackProjectTask` | Any read action + `args.sessionSummary` | `MEDIUM` (`guest` **BLOCKED**) | `enforceProjectMutationAuth()` | ALLOW | ALLOW | **BLOCK** (`PERMISSION_DENIED`) | **BLOCK** (`PERMISSION_DENIED`) | **BLOCK** (`MISSING_SESSION_CONTEXT`) | **BLOCK** (`MISSING_SECURITY_CONTEXT`) | **ALLOW — FAILS OPEN (`AUD-P0-03`)** |
| `trackProjectTask` | `confirm_decision` (no credential) | `MEDIUM` (`guest` **BLOCKED**) | `enforceProjectMutationAuth()` -> UI prompt only | UI Prompt Only | UI Prompt Only | **BLOCK** (`PERMISSION_DENIED`) | **BLOCK** (`PERMISSION_DENIED`) | **BLOCK** (`MISSING_SESSION_CONTEXT`) | **BLOCK** (`MISSING_SECURITY_CONTEXT`) | **UI Prompt Only (`sessionId: undefined` -> Token #1 `"local"`)** |
| `trackProjectTask` | `confirm_decision` (any credential) | `MEDIUM` (`guest` **BLOCKED**) | `enforceProjectMutationAuth()` -> `model_approval_prohibited` | **BLOCK** | **BLOCK** | **BLOCK** | **BLOCK** | **BLOCK** | **BLOCK** | **BLOCK** (`model_approval_prohibited`) |
| `getProjectContinuity` | `continuity` / `historical` | `LOW` *(unlisted in `SecurityRiskEngine`)* | Read-only | ALLOW | ALLOW | ALLOW | **ALLOW** *(inconsistent w/ `trackProjectTask`)* | ALLOW | ALLOW* | ALLOW |
| `getProjectContinuity` | `switch` | `LOW` *(unlisted)* | `enforceProjectMutationAuth()` | ALLOW | ALLOW | **BLOCK** (`PERMISSION_DENIED`) | **BLOCK** (`PERMISSION_DENIED`) | **BLOCK** (`MISSING_SESSION_CONTEXT`) | **BLOCK** (`MISSING_SECURITY_CONTEXT`) | **ALLOW — FAILS OPEN (`AUD-P0-03`)** |

*\*Read-only calls with malformed explicit `ctx` still undergo outer `SecurityPolicyEngine` Lockdown/EmergencyStop/argument checks and `contentSanitizer.scanForPromptInjection` on `projectName`.*

---

## 6. Credential and Argument Logging Assessment (Batch D)

**Status: `FAIL` (`AUD-P0-01` — HIGH)**

Direct inspection of `ToolOrchestrator.ts`, `SecurityPolicyEngine.ts`, `SecurityAuditLogger.ts`, `GeminiSessionFactory.ts`, and `ConversationManager.ts`, corroborated by live Vitest stdout output:

1. **Unredacted Stdout Argument Logging (`backend/tools/ToolOrchestrator.ts:244`) — HIGH:**
   - Exact code:
     ```ts
     console.log(`[Function Call]: ${fc.name}`, fc.args);
     ```
   - Runs as the **very first line** of `ToolOrchestrator.dispatch()` — before Emergency Stop, Lockdown, RBAC, `SecurityPolicyEngine`, or `_handleProjectTool`.
   - **Observed live proof in independent test run (`phase10_project_continuity.test.ts`):** When `trackProjectTask(action="confirm_decision", confirmationToken="sora_conf_<redacted>")` was dispatched, the full base64url payload AND HMAC signature of the live confirmation token were written in plaintext to stdout.
   - Removing `confirmationToken` from `LIVE_TOOLS.trackProjectTask` does **NOT** stop this leak: prompt injection, unexpected model-supplied arguments, `confirmCheckpoint`, any other tool carrying tokens/passcodes/proofs, or `GeminiSessionFactory.ts:2858` (multi-call batch token injection) all pass straight through line 244 and dump secrets to stdout/server logs.
2. **Error-Path Token Echo (`backend/security/SecurityPolicyEngine.ts:958` → `ToolOrchestrator.ts:287, 294` + `SecurityPolicyEngine.ts:975`) — MEDIUM:**
   - When a non-`sora_conf_` string is supplied in `confirmationToken`/`checkpointId` on a tool requiring confirmation (or in `STRICT`/`PARANOID` mode), `SecurityPolicyEngine.ts:958` constructs:
     ```ts
     rejectReason = `Checkpoint '${providedToken}' is invalid or not approved (status: ${cp?.status || "not found"}).`;
     ```
   - This echoes arbitrary attacker- or client-supplied credential strings into `console.warn` (`ToolOrchestrator.ts:287`), tool error output (`ToolOrchestrator.ts:294`), and `securityAuditLogger` (`SecurityPolicyEngine.ts:975`).
3. **Incomplete `sora_conf_` Redaction Regex in `SecurityAuditLogger` (`backend/security/SecurityAuditLogger.ts:74`) — LOW/MEDIUM:**
   - Line 74 uses `/sora_[a-z0-9_]+/gi`, which does **not** include `-` or `.`. Because `sora_conf_<base64url>.<hmac_base64url>` contains `-` and `.`, any `sora_conf_*` token passed inside a free-form audit string would leave its `.signature` (and anything after the first `-`) unredacted.
   - *Mitigating factor:* `_handleProjectTool` (`lines 1176–1190`, `1256–1264`) and `ConversationManager.ts` (`lines 997–1010`, `1031–1045`, `1265–1278`) never place raw tokens in audit fields (logging only `decisionId`, `projectId`, `tokenId`, `argsHash`), so persisted audit logs for project decisions do not currently leak `sora_conf_*` tokens.

---

## 7. `P0-01` Through `P0-14` Test-Quality Review (Batch E)

Direct line-by-line inspection of `tests/unit/phase10_project_continuity.test.ts` (`lines 3470–3964` and `1335–1455`):

| Test Range | Actual Assertions Verified in Code | Persisted Store Checked? | Independent Quality Assessment |
| :--- | :--- | :---: | :--- |
| `P0-01` (`3507–3512`) | `LIVE_TOOLS` count 129, unique 129, `trackProjectTask.parameters.properties.confirmationToken === undefined` | N/A | **Strong (`PASS`)** |
| `P0-02..P0-05` (`3514–3606`) | Genuine HMAC `sora_conf_*`, plain UUID, pending planner checkpoint, approved planner checkpoint across `confirmationToken`, `checkpointId`, `_checkpointId`, `token` all return `model_approval_prohibited`, `blocked: true`, `0` client events | **Yes** (`projectDecisionStore.getDecision(dec.id)` verified `confirmed === false`, `source === "ai_proposed"`) | **Strong (`PASS`)** |
| `P0-06..P0-08` (`3608–3709`) | `guest` and `read_only` denied (`PERMISSION_DENIED`) on `add`, `update`, `switch`, `record_decision`, `confirm_decision`, `resume+sessionSummary`, `getProjectContinuity(switch)`; `read_only` allowed on `list`, `continuity`, `historical`, `resume` | **Yes** (`projectStore.getActiveProject()` tasks/activeId and `projectDecisionStore.listByProject()` verified unchanged) | **Strong (`PASS`)** |
| `P0-09` (`3711–3766`) | Empty `identityId`, invalid role, remote missing `sessionId` via `dispatch()`; `undefined` tested **only** via private `(orchestrator as any)._handleProjectTool(...)` | **Yes** (`listByProject().length === 0`) | **Gap (`AUD-P0-03`/`AUD-P0-04`)**: Bypassing `dispatch()` masked the public `dispatch(..., undefined)` fail-open admin default (`ToolOrchestrator.ts:267`). |
| `P0-10` (`3856–3870`) | Valid UI `confirm_decision` via mocked `ConversationManager` WebSocket returns `decision_confirmed` and persists `confirmed: true` | **Yes** (`getDecision(decApprove.id)?.confirmed === true`) | **Partial (`AUD-P0-04`)**: Does not assert `invalidateInstructionsCache()` or approval-token replay inside `P0-10` (both are covered in earlier tests in the same file, lines `1434+` and Batch 3). |
| `P0-11` (`3871–3899`) | Valid UI `reject_decision` returns `decision_rejected` (`revoked: true`), leaves `confirmed: false`, and subsequent approval replay fails with `CONFIRMATION_TOKEN_REPLAY` | **Yes** (`getDecision(decReject.id)?.confirmed === false`) | **Strong (`PASS`)** |
| `P0-12` (`3901–3920`) | Tests `wrongSessToken` (`SESSION_MISMATCH`) | Implicitly unchanged | **Overstated in report (`AUD-P0-04`)**: Report claimed `P0-12` tested expired, wrong-decisionId, and wrong-projectId tokens inside `P0-12`; those are tested earlier in `CR-01`..`CR-05` / `SEC-P3-R1.2-03`, not in `P0-12`. |
| `P0-13` (`3922–3947`) | Tests Emergency Stop and Security Lockdown on `orchestrator.dispatch()` | N/A | **Overstated in report (`AUD-P0-04`)**: Comment and report claimed `P0-13` blocked both `ToolOrchestrator` and `ConversationManager`, but lines `3922–3947` only invoked `orchestrator.dispatch()` (`ConversationManager` E-Stop/Lockdown are verified earlier in the file). |
| `P0-14` (`3949–3959`) | Spies on `securityAuditLogger.logEvent`; verifies `trustedActor.identityId`, zero `"local_user"`, zero raw tokens / `sora_conf_` in `auditedEvents` | N/A | **Gap (`AUD-P0-01`/`AUD-P0-04`)**: Does not inspect stdout (`console.log`), missing the live plaintext `sora_conf_*` leak at `ToolOrchestrator.ts:244`. |

---

## 8. Exact Regression Commands and Results (Independent Execution)

All commands were executed independently during this read-only audit with zero edits to source or tests:

| # | Exact Command | Exit Code | Passed | Failed | Skipped | Classification |
| :-: | :--- | :-: | :-: | :-: | :-: | :--- |
| 1 | `npx vitest run --fileParallelism=false tests/unit/phase10_project_continuity.test.ts tests/unit/phase10_audio_continuity.test.ts` | `0` | 114 *(87 project + 27 audio)* | 0 | 0 | `PASS — AUTOMATED TEST` |
| 2 | `npx vitest run --fileParallelism=false tests/unit/stage10_1_10_2_security_remediation.test.ts tests/unit/companion_core_phase1.test.ts tests/unit/gemini_live_auth_regression.test.ts` | `0` | 72 *(19 sec + 42 companion + 11 live auth)* | 0 | 0 | `PASS — AUTOMATED TEST` |
| 3 | `npx vitest run --fileParallelism=false tests/unit/planner.test.ts tests/unit/projects.test.ts` | `0` | 88 *(71 planner + 17 projects)* | 0 | 0 | `PASS — AUTOMATED TEST` |
| 4 | `npx vitest run --fileParallelism=false tests/e2e/cross_platform_e2e_phase29.test.ts -t "strictly preserves"` | `0` | 1 | 0 | 41 *(filtered out by `-t`)* | `PASS — AUTOMATED TEST` |
| 5 | `npx tsc --noEmit` | `0` | 0 errors | 0 | — | `PASS — AUTOMATED TEST` |
| 6 | `npx tsx -e "import { LIVE_TOOLS } from './backend/ai/GeminiSessionFactory.ts'; ..."` | `0` | `129 / 129` unique | 0 | — | `PASS — AUTOMATED TEST` |
| **Aggregate (Non-Double-Counted)** | **8 distinct test files + `tsc` + `LIVE_TOOLS` probe** | **All `0`** | **275** | **0** | **41** *(filtered)* | `PASS — AUTOMATED TEST` |

- **Filtered Skips Explanation:** In Command 4 (`tests/e2e/cross_platform_e2e_phase29.test.ts`), the file contains 42 tests; `-t "strictly preserves"` intentionally selected only test `1.1 strictly preserves exactly 126 Gemini Live tools in LIVE_TOOLS` (which asserts the `LIVE_TOOLS` invariant) and skipped the other 41 non-matching tests.
- **Mocking Notice:** `ConversationManager` WebSocket tests (`phase10_project_continuity.test.ts`, `phase10_audio_continuity.test.ts`, `gemini_live_auth_regression.test.ts`) use mocked `GeminiSessionFactory` / in-memory WebSocket stubs and do **not** represent live Gemini Cloud or real browser DOM execution.

---

## 9. Stage 10.1 / 10.2 and Stage 10.4.2 Integrity

Inspected source (`SecurityPolicyEngine.ts`, `ConversationManager.ts`, `server.ts`, `ProjectDecisionStore.ts`) and executed regression suites:

- **Memory governance & approval proofs (Stage 10.1/10.2):** Intact (`stage10_1_10_2_security_remediation.test.ts` 19/19, `companion_core_phase1.test.ts` 42/42 — `PASS — AUTOMATED TEST`).
- **Confirmation HMAC/session binding, expiry, one-time consumption, explicit rejection revocation (Stage 10.4.2):** Intact in `SecurityPolicyEngine.ts:318–565` and `ConversationManager.ts:844–1295` (`CR-01`..`CR-05` in `phase10_project_continuity.test.ts` passed — `PASS — AUTOMATED TEST`, `PASS — SOURCE INSPECTION`).
- **Emergency Stop & Security Lockdown:** Intact across `server.ts:967–983`, `ConversationManager.ts:907–946, 1151–1190`, `ToolOrchestrator.ts:247–264, 930–970`, and `SecurityPolicyEngine.ts:678–714` (`PASS — SOURCE INSPECTION`, `PASS — AUTOMATED TEST`).
- **Local `/live` authentication & loopback/CSWSH restrictions:** Intact in `server.ts:63–260, 930–1016` and verified by `gemini_live_auth_regression.test.ts` (11/11 — `PASS — AUTOMATED TEST`). *(Note: `GeminiSessionFactory.ts:2828` still fails to propagate `clientWs.remoteSession` into `ToolOrchestrator.dispatch()` — tracked as `AUD-P0-03`.)*
- **Audio queue bounds, PCM frame validation, and epoch isolation:** Intact (`phase10_audio_continuity.test.ts` 27/27 — `PASS — AUTOMATED TEST`).

---

## 10. Frozen-Boundary Verification

Verified file and directory modification timestamps (read-only; no Git commands executed):

| Frozen Boundary | Status | Last Modified Timestamp | Verification |
| :--- | :---: | :--- | :--- |
| `backend/planner/PlannerCoordinator.ts` | Untouched | `2026-09-23 18:11:38` | `PASS — SOURCE INSPECTION` |
| `backend/planner/PlanStore.ts` | Untouched | `2026-11-18 20:45:51` | `PASS — SOURCE INSPECTION` |
| `backend/projects/ProjectStore.ts` | Untouched | `2026-11-18 20:49:17` | `PASS — SOURCE INSPECTION` |
| `backend/projects/ProjectDecisionStore.ts` | Untouched | `2026-11-18 20:49:17` | `PASS — SOURCE INSPECTION` |
| `backend/conversation/ConversationManager.ts` | Untouched | `2026-11-18 20:46:30` | `PASS — SOURCE INSPECTION` |
| `backend/security/SecurityPolicyEngine.ts` | Untouched | `2026-11-18 15:33:31` | `PASS — SOURCE INSPECTION` |
| `backend/security/SecurityRiskEngine.ts` | Untouched | `2026-10-06 13:11:39` | `PASS — SOURCE INSPECTION` |
| `backend/device/RemoteBridge.ts` | Untouched | `2026-09-26 23:46:12` | `PASS — SOURCE INSPECTION` |
| `android/` | Untouched | `2026-09-30 16:47:20` | `PASS — SOURCE INSPECTION` |
| `electron/` | Untouched | `2026-09-30 10:14:16` | `PASS — SOURCE INSPECTION` |
| `desktop_agent/` | Untouched | `2026-10-22 15:55:10` | `PASS — SOURCE INSPECTION` |

Only the previously authorized P0 scope (`backend/tools/ToolOrchestrator.ts`, `backend/ai/GeminiSessionFactory.ts`, `tests/unit/phase10_project_continuity.test.ts`) showed P0 remediation timestamps (`2026-11-18 21:18–21:19`). No files were modified by this audit.

---

## 11. Blocked and Unverified Runtime Checks

| Runtime Surface | Classification | Details |
| :--- | :---: | :--- |
| Live Gemini Cloud Staging (`ai.live.connect` against Google Gemini Live API) | `BLOCKED` | Production/staging external network calls are prohibited in this audit environment; no live Gemini Cloud session was opened. |
| Interactive Chromium / Playwright Browser DOM (`DecisionConfirmationModal.tsx` Approve / Reject / Dismiss flows) | `NOT VERIFIED` | No real browser / Playwright runner was executed; frontend wiring (`frontend/lib/audio.ts`, `frontend/components/DecisionConfirmationModal.tsx`) was verified by `PASS — SOURCE INSPECTION` only. |
| Local Backend Server + Live Loopback WebSocket Runtime (`/live`, `/remote-live`) | `NOT VERIFIED` | Not started in this read-only audit; WebSocket confirmation and audio flows were exercised via mocked `GeminiSessionFactory` and in-memory WS mocks (`PASS — AUTOMATED TEST`). |

---

## 12. Residual Defects and Exact Authorization Required

No code changes were made during this audit. Closing the `FAIL` verdict requires the following **narrow, targeted authorizations**:

1. **Fix `AUD-P0-01` (HIGH — Credential Logging & Error Echo Leak):**
   - **Required Authorization:** Narrow frozen-file exception for:
     - `backend/tools/ToolOrchestrator.ts` (`line 244`): Sanitize/redact sensitive keys (`confirmationToken`, `checkpointId`, `_checkpointId`, `token`, `passcode`, `password`, `secret`, `apiKey`, `auth`, `proof`) and any `sora_*` / `myraa_*` / `AIza*` / JWT values before `console.log` (or log only tool name + allowlisted non-secret metadata/keys).
     - `backend/security/SecurityPolicyEngine.ts` (`line 958`): Stop interpolating raw `providedToken` into `rejectReason` (replace with generic `"Provided checkpoint credential is invalid or not approved."`).
     - `backend/security/SecurityAuditLogger.ts` (`line 74`): Update `sora_` redaction regex to `/sora_[A-Za-z0-9_\-.]+/gi` so full base64url + `.signature` tokens are redacted.
2. **Fix `AUD-P0-02` (HIGH — `STRICT`/`PARANOID` Model-Output Token Leak & Double Token Generation):**
   - **Required Authorization:** Narrow frozen-file exception for:
     - `backend/tools/ToolOrchestrator.ts` (`lines 286–305` and `1247–1275`): Never include `confirmationToken` in model `session.sendToolResponse(...)` output (route confirmation tokens strictly out-of-band via `sendToClient`, and route `output` through `outputDataFirewall` or strip `confirmationToken` unconditionally). Eliminate double token generation so only one token bound to the live authenticated `socketSessionId` is minted.
     - `backend/ai/GeminiSessionFactory.ts` (`lines 2559–2580`): Align single-mint session binding with `ToolOrchestrator.ts` so no unrevoked duplicate token is created.
3. **Fix `AUD-P0-03` (MEDIUM/HIGH — Local `/live` Context Propagation & Fail-Open Admin Default):**
   - **Required Authorization:** Narrow exception for:
     - `backend/ai/GeminiSessionFactory.ts` (`lines 2825–2837`): Populate `callerSecContext` from `clientWs.remoteSession` for local `/live` sockets (`identityId: remoteSession.deviceId`, `role: remoteSession.role`, `sessionId: socketSid`, `ipAddress: remoteSession.ipAddress`, `isLocal: true`) instead of passing `undefined`.
     - `backend/tools/ToolOrchestrator.ts` (`lines 267–272`): Remove `(fc as any).securityContext` trust and remove the fail-open `role: "admin"` fallback when `context` is omitted (fail closed on missing `context` for mutating/sensitive tools, or require explicit server-constructed local context).
     - Optional consistency alignment: `backend/security/SecurityRiskEngine.ts` (`line 82`) — include `getProjectContinuity` alongside `trackProjectTask` in `MEDIUM_RISK_TOOLS` so `guest` read-only policy is uniform across both aliases.
4. **Fix `AUD-P0-04` (LOW/MEDIUM — Test Suite Hardening):**
   - **Required Authorization:** `tests/unit/phase10_project_continuity.test.ts` — Add automated assertions verifying:
     - Stdout (`console.log` spy) never contains `sora_conf_` or raw credentials when `dispatch()` is called with credential arguments.
     - `STRICT`/`PARANOID` mode never returns `confirmationToken` in model `sendToolResponse` output.
     - Local `/live` `clientWs.remoteSession` (`role: "standard"`, `local_sess_<uuid>`) propagates to `dispatch()` and emits only a single `local_sess_<uuid>`-bound token.
     - Public `dispatch(..., undefined)` fails closed for mutating project actions.
     - Explicit `P0-10`/`P0-12`/`P0-13` assertions inside their named blocks (or aligned test naming).
