# MYRAA — Stage 10.3 P0 Security Residual Remediation Report (`AUD-P0-01` – `AUD-P0-04`)

- **Scope:** Authorized Narrow Security Remediation of Residual Findings from `stage10_phase10_3_P0_final_acceptance_audit.md`
- **Date:** 2026-11-18
- **Authorized Files Modified:** Exactly the 6 authorized files (zero unauthorized edits)
- **Overall Remediation Status:** **`PASS`** *(automated security verification & static source inspection; live Gemini Cloud staging is `BLOCKED` and Chromium/Playwright browser DOM execution is `NOT VERIFIED`, recorded in Section 15)*

---

## 1. Executive Status (`AUD-P0-01` through `AUD-P0-04`)

| Finding | Severity | Status | Evidence Summary |
| :--- | :---: | :---: | :--- |
| `AUD-P0-01` | HIGH | **`PASS`** | Replaced raw `fc.args` stdout logging with safe structured logging (`action` + `argKeys` only); removed raw `providedToken` echo from `SecurityPolicyEngine.ts:958`; strengthened `SecurityAuditLogger.ts:68–124` redaction for full `sora_*` / `myraa_*` (incl. `-`/`.`), `AIza*`, 2/3-part JWTs, and nested credential objects. Verified `0` `sora_conf_` matches across entire test stdout/stderr and via dedicated 4-channel capture tests. |
| `AUD-P0-02` | HIGH | **`PASS`** | Removed `confirmationToken` from model-facing `ToolOrchestrator.dispatch()` blocked responses (`STRICT`/`PARANOID` now route blocked payloads through `outputDataFirewall` with zero tokens, and revoke undelivered generic tokens when session-bound). Implemented **Single-Mint Architecture**: `ToolOrchestrator._handleProjectTool()` emits a token-free `confirmation_required` event; `GeminiSessionFactory` is the sole authoritative minter bound to live `socketSessionId` (`toHaveBeenCalledTimes(1)` verified across `BALANCED`, `STRICT`, and `PARANOID` for both local `/live` and remote `/remote-live`). |
| `AUD-P0-03` | MEDIUM/HIGH | **`PASS`** | `GeminiSessionFactory.ts` now propagates server-minted local `/live` `clientWs.remoteSession` (`local_sess_<uuid>`, `role: "standard"`, `isLocal: true`) instead of passing `undefined`. Eliminated `(fc as any).securityContext` trust and the fail-open `local_operator` / `admin` fallback in `ToolOrchestrator.dispatch()`; omitted/malformed contexts fail closed with `MISSING_SECURITY_CONTEXT` and non-admin `missing_security_context` (`guest`) audit actor. Added `getProjectContinuity` to `MEDIUM_RISK_TOOLS` for uniform RBAC parity with `trackProjectTask`. |
| `AUD-P0-04` | LOW/MEDIUM | **`PASS`** | Upgraded `P0-09`, `P0-10`, `P0-12`, `P0-13`, and `P0-14` so each named test executes and asserts every claimed control directly inside its own block (public `dispatch(fc, undefined)`, post-persistence cache invalidation + replay, all 5 invalid-token classes, E-Stop/Lockdown on both `ToolOrchestrator` and `ConversationManager`, and 4-channel secret capture), plus added dedicated tests for `AUD-P0-01`, `AUD-P0-02`, and `AUD-P0-03`. |

---

## 2. Architecture Inspection Findings

1. **Dispatch Caller Audit:** Codebase-wide search confirmed `backend/ai/GeminiSessionFactory.ts:2873` is the **sole production caller** of `ToolOrchestrator.dispatch()` across `backend/`.
2. **Local `/live` Session Contract (`backend/server.ts`, untouched):** `LocalLiveSessionRegistry.establishLocalSession(clientWs)` attaches frozen, non-writable `clientWs.remoteSession` (`sessionId: "local_sess_<uuid>"`, `deviceId: "local_desktop"`, `role: "standard"`, `ipAddress`, `authenticated: true`, `isLocal: true`) and `clientWs.remoteSessionId`. Propagating this context from `GeminiSessionFactory.ts` aligns `server.ts`, `GeminiSessionFactory.ts`, `ToolOrchestrator.ts`, and `ConversationManager.ts` on identical session and role semantics (`standard`, `local_sess_<uuid>`).
3. **Single-Mint Token Authority:** `GeminiSessionFactory.ts` owns the live authenticated `clientWs` (`remoteSession.sessionId || remoteSessionId`), making it the sole natural authority to mint confirmation tokens for `confirmation_required` UI challenges while `ToolOrchestrator._handleProjectTool()` emits strictly token-free canonical decision metadata.
4. **Generic `STRICT`/`PARANOID` Confirmation Behavior:** Generic tools blocked by `STRICT`/`PARANOID` modes have no dedicated out-of-band confirmation UI channel; therefore `ToolOrchestrator.dispatch()` fails closed (`blocked: true`, `requiresConfirmation: true`, `status: "confirmation_required"`), never exposes a token to the model, and revokes any undelivered session-bound token minted by `SecurityPolicyEngine`. Project `trackProjectTask(action="confirm_decision")` preserves its non-mutating UI-challenge / fail-closed credential rejection behavior across `NORMAL`, `BALANCED`, `STRICT`, and `PARANOID` without weakening `add`, `update`, `switch`, or `record_decision`.
5. **No Stop Conditions Triggered:** All four findings were resolved cleanly within the six authorized files with zero modifications to `server.ts`, `ConversationManager.ts`, `ProjectDecisionStore.ts`, or any frozen boundary.

---

## 3. Exact Files and Line Ranges Changed

Only the **6 authorized files** were modified:

| File | Exact Line Ranges Changed | Summary of Change |
| :--- | :--- | :--- |
| `backend/ai/GeminiSessionFactory.ts` | `2558–2588`, `2833–2864` | Enforced fail-closed Single-Mint token issuance in `sendToClient` (blocks emission if `socketSessionId` is missing); propagated authenticated local `/live` `clientWs.remoteSession` (`local_sess_<uuid>`, `role: "standard"`, `isLocal: true`) into `callerSecContext` while preserving `/remote-live` `remoteDevice` propagation and passing `undefined` for unverified sockets. |
| `backend/tools/ToolOrchestrator.ts` | `244–257`, `279–435`, `664`, `1388–1424` | Replaced raw `fc.args` stdout log with safe structured `{ action?, argKeys }` log; eliminated `(fc as any).securityContext` and fail-open `local_operator`/`admin` fallback; routed blocked responses through `outputDataFirewall` with zero `confirmationToken` and revoked undelivered session-bound generic tokens; routed `STRICT`/`PARANOID` `confirm_decision` through deterministic non-token checks (`isToolDisabled`, trusted context, critical risk, arg validation) to `_handleProjectTool`; removed Token #1 minting in `_handleProjectTool` so it emits token-free `confirmation_required`. |
| `backend/security/SecurityPolicyEngine.ts` | `958` | Replaced `Checkpoint '${providedToken}' is invalid...` with generic token-free `Provided checkpoint credential is invalid or not approved (status: ...)`. |
| `backend/security/SecurityAuditLogger.ts` | `68–124` | Updated `sora_*` and `myraa_*` regexes to `[A-Za-z0-9_\-.]+`, broadened `AIza*` (>=16 chars), 2/3-part JWTs, inline key/value secrets, and recursive sensitive-key object/value redaction while preserving non-secret `tokenId` correlation UUIDs. |
| `backend/security/SecurityRiskEngine.ts` | `83` | Added `"getProjectContinuity"` to `MEDIUM_RISK_TOOLS` directly alongside `"trackProjectTask"` for uniform RBAC parity. |
| `tests/unit/phase10_project_continuity.test.ts` | `1367–1445`, `1530–1590`, `3736–4787` | Updated legacy tests for explicit trusted context & token-free `ToolOrchestrator` single-mint contract; upgraded `P0-09`, `P0-10`, `P0-12`, `P0-13`, `P0-14`; added dedicated `AUD-P0-03` (Batch A), `AUD-P0-01` (Batch B), and `AUD-P0-02` (Batch C) suites. |

---

## 4. Before / After Security Context Flow

### Before (`AUD-P0-03` Vulnerable)
```text
Local /live clientWs (remoteDevice=null, remoteSession={ sessionId:"local_sess_...", role:"standard" })
  -> GeminiSessionFactory: remoteDev ? {...} : undefined   (DROPPED local remoteSession!)
  -> ToolOrchestrator.dispatch(..., undefined)
  -> context || (fc as any).securityContext || { identityId:"local_operator", role:"admin", isLocal:true }
     (FAILED OPEN as admin with sessionId=undefined!)
```

### After (Fail-Closed & Parity-Aligned)
```text
Local /live clientWs (remoteDevice=null, remoteSession={ authenticated:true, isLocal:true, sessionId:"local_sess_...", deviceId:"local_desktop", role:"standard" })
  -> GeminiSessionFactory: callerSecContext = { identityId:"local_desktop", role:"standard", sessionId:"local_sess_...", deviceId:"local_desktop", ipAddress, isLocal:true }
  -> ToolOrchestrator.dispatch(..., callerSecContext)
  -> Strict validation of callerSecContext (NEVER reads fc.securityContext; NEVER synthesizes admin/local_operator)
  -> Missing or malformed context -> hasTrustedContext=false, policyContext={ identityId:"missing_security_context", role:"guest", isLocal:false }
     -> Blocks all MEDIUM/HIGH/CRITICAL tools with MISSING_SECURITY_CONTEXT and passes undefined to _handleProjectTool!
```

---

## 5. Local `/live` and Remote `/remote-live` Identity Propagation

Verified via real `LocalLiveSessionRegistry` + `GeminiSessionFactory.createSession()` (`Live.prototype.connect` test harness):

- **Local `/live`:** `LocalLiveSessionRegistry.establishLocalSession(ws)` mints unique `local_sess_<uuid>` with `role: "standard"`, `deviceId: "local_desktop"`, `isLocal: true`. `GeminiSessionFactory` propagates those exact values into `ToolOrchestrator.dispatch()`. Model-supplied `role: "admin"`, `identityId: "spoofed_admin"`, `sessionId: "spoofed_sess"`, `isLocal: false` are completely ignored.
- **Remote `/remote-live`:** `clientWs.remoteDevice` + `clientWs.remoteSession.sessionId` propagate `{ identityId: remoteDev.id, role: remoteDev.role || "standard", sessionId: socketSid, deviceId: remoteDev.id, ipAddress: remoteDev.lastIp, isLocal: false }`.
- **Unverified Socket (neither `remoteDevice` nor authenticated `remoteSession`):** `GeminiSessionFactory` passes `undefined`; `ToolOrchestrator.dispatch()` fails closed with `MISSING_SECURITY_CONTEXT` and logs non-admin `missing_security_context` (`guest`).

---

## 6. Per-Action RBAC Matrix (Through Public `ToolOrchestrator.dispatch()`)

| Tool | Action / Modifier | Outer Risk Tier | `admin` | `standard` (local `/live` or remote w/ `sessionId`) | `read_only` | `guest` | Remote w/o `sessionId` | Omitted / Malformed Context (`undefined` / invalid) |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| `trackProjectTask` | `list` / `resume` / `continuity` / `historical` (no `sessionSummary`) | `MEDIUM` | ALLOW | ALLOW | ALLOW | **BLOCK** (`PERMISSION_DENIED`) | ALLOW | **BLOCK** (`MISSING_SECURITY_CONTEXT`) |
| `trackProjectTask` | `add` / `update` / `switch` / `record_decision` | `MEDIUM` | ALLOW *(blocked in STRICT/PARANOID)* | ALLOW *(blocked in STRICT/PARANOID)* | **BLOCK** (`PERMISSION_DENIED`) | **BLOCK** (`PERMISSION_DENIED`) | **BLOCK** (`MISSING_SESSION_CONTEXT`) | **BLOCK** (`MISSING_SECURITY_CONTEXT`) |
| `trackProjectTask` | Any read action + `args.sessionSummary` | `MEDIUM` | ALLOW | ALLOW | **BLOCK** (`PERMISSION_DENIED`) | **BLOCK** (`PERMISSION_DENIED`) | **BLOCK** (`MISSING_SESSION_CONTEXT`) | **BLOCK** (`MISSING_SECURITY_CONTEXT`) |
| `trackProjectTask` | `confirm_decision` (no credential) | `MEDIUM` | UI Challenge Only *(token-free from orchestrator)* | UI Challenge Only *(token-free from orchestrator)* | **BLOCK** (`PERMISSION_DENIED`) | **BLOCK** (`PERMISSION_DENIED`) | **BLOCK** (`MISSING_SESSION_CONTEXT`) | **BLOCK** (`MISSING_SECURITY_CONTEXT`) |
| `trackProjectTask` | `confirm_decision` (any credential) | `MEDIUM` | **BLOCK** (`model_approval_prohibited`) | **BLOCK** (`model_approval_prohibited`) | **BLOCK** (`PERMISSION_DENIED`) | **BLOCK** (`PERMISSION_DENIED`) | **BLOCK** (`MISSING_SESSION_CONTEXT`) | **BLOCK** (`MISSING_SECURITY_CONTEXT`) |
| `getProjectContinuity` | `continuity` / `historical` | `MEDIUM` | ALLOW | ALLOW | ALLOW | **BLOCK** (`PERMISSION_DENIED`) | ALLOW | **BLOCK** (`MISSING_SECURITY_CONTEXT`) |
| `getProjectContinuity` | `switch` | `MEDIUM` | ALLOW | ALLOW | **BLOCK** (`PERMISSION_DENIED`) | **BLOCK** (`PERMISSION_DENIED`) | **BLOCK** (`MISSING_SESSION_CONTEXT`) | **BLOCK** (`MISSING_SECURITY_CONTEXT`) |

---

## 7. Credential Logging and Redaction Verification (`AUD-P0-01`)

1. **`ToolOrchestrator.dispatch()` (`lines 244–257`):** Logs strictly `[Function Call]: <name> { action?, argKeys: [...] }` — **zero arbitrary argument values** are logged, neutralizing known (`confirmationToken`, `checkpointId`, `_checkpointId`, `token`, `passcode`, `password`, `secret`, `apiKey`, `auth`, `proof`), nested, and unknown credential-like keys.
2. **`SecurityPolicyEngine.ts` (`line 958`):** Returns generic `Provided checkpoint credential is invalid or not approved (status: ...)` without echoing `providedToken`.
3. **`SecurityAuditLogger.ts` (`lines 68–124`):** Redacts full `sora_[A-Za-z0-9_\-.]+`, `myraa_[A-Za-z0-9_\-.]+`, `AIza[0-9A-Za-z\-_]{16,}`, 2/3-part JWTs, Bearer tokens, inline credential pairs, and nested sensitive-key objects while keeping safe correlation UUIDs (`tokenId`).
4. **Live Output Verification:**
   - Dedicated `AUD-P0-01 (Batch B)` test captures `console.log`, `console.warn`, `securityAuditLogger.onAuditLogged`, and tool error outputs using synthetic `sora_conf_` (with hyphens & `.sig`), `myraa_`, JWT, `AIza`, nested objects, unknown keys, and invalid checkpoint strings — **0 leaks**.
   - Whole-suite stdout/stderr scan of `phase10_project_continuity.test.ts` + `phase10_audio_continuity.test.ts`: **`sora_conf_` matches = `0`**.

---

## 8. `STRICT` / `PARANOID` Model-Response Token Exposure Verification (`AUD-P0-02`)

Verified across all four modes (`NORMAL` legacy alias, `BALANCED`, `STRICT`, `PARANOID`):
- `ToolOrchestrator.dispatch()` (`lines 402–434`) **never** includes `confirmationToken` in model `sendToolResponse()` output and routes all blocked payloads through `outputDataFirewall.sanitizeResult(...)`.
- Undelivered generic confirmation tokens minted by `SecurityPolicyEngine.evaluateRequest()` under `STRICT`/`PARANOID` are immediately revoked when `secContext.sessionId` is present.
- `trackProjectTask(action="add")` under `STRICT` and `PARANOID` stays **blocked** (`blocked: true, requiresConfirmation: true`), executes **zero** task mutations, and returns **zero** `sora_conf_` strings anywhere in nested or top-level response fields.
- `trackProjectTask(action="confirm_decision")` under `STRICT` and `PARANOID` executes deterministic non-token checks (`isToolDisabled`, `hasTrustedContext`, critical risk, arg validation) and routes into `_handleProjectTool` (preserving non-mutating UI challenge / `model_approval_prohibited` without minting any throwaway generic token).

---

## 9. Single-Mint Architecture and Session-Binding Evidence (`AUD-P0-02`)

Verified end-to-end through real `GeminiSessionFactory.createSession()` → `ToolOrchestrator.dispatch()` → `sendToClient` → `clientWs.send()` → `ConversationManager.handleConnection()`:

- **Local `/live` (`LocalLiveSessionRegistry`) under `STRICT` mode:**
  - `vi.spyOn(securityPolicyEngine, "generateConfirmationToken")` called **exactly once (`toHaveBeenCalledTimes(1)`)**.
  - Bound to `local_sess_<uuid>` (never `"local"`).
  - Model `sendToolResponse` contains zero `sora_conf_` tokens.
  - `ConversationManager` accepts the sole issued token and persists `confirmed: true`.
- **Remote `/remote-live` (`rem-sess-sm-01`):**
  - `generateConfirmationToken` called **exactly once (`toHaveBeenCalledTimes(1)`)**, bound to `rem-sess-sm-01`.
  - `ConversationManager` `reject_decision` revokes the sole token (`revoked: true`), leaves `confirmed: false`, and blocks replay (`CONFIRMATION_TOKEN_REPLAY`).
- **Missing `socketSessionId` Fail-Closed Guard (`GeminiSessionFactory.ts:2569–2573`):** Blocks `confirmation_required` emission and mints zero tokens if `clientWs` lacks an authenticated `socketSessionId`.

---

## 10. `P0-09` Through `P0-14` Corrected Test Evidence (`AUD-P0-04`)

| Test ID | Exact Behavior Verified Inside Named Test Block (`tests/unit/phase10_project_continuity.test.ts`) | Result |
| :--- | :--- | :---: |
| `P0-09` (`3736–3836`) | Calls public `orchestrator.dispatch(fc, ..., undefined)` across `record_decision`, `add`, `switch`, and `getProjectContinuity(switch)`, plus blank `identityId`, invalid role, and remote missing `sessionId`; asserts `MISSING_SECURITY_CONTEXT`/`MISSING_SESSION_CONTEXT`, zero store mutations, and zero `"admin"`/`"local_operator"`/`"local_user"` tool audit actors. | **PASS** |
| `P0-10` (`3919–3956`) | Verifies UI `confirm_decision` via `ConversationManager` WebSocket persists `confirmed: true` & `source: "user_confirmed"`, invokes `invalidateInstructionsCache()` once after persistence, and blocks token replay (`CONFIRMATION_TOKEN_REPLAY`). | **PASS** |
| `P0-11` (`3958–3986`) | Verifies UI `reject_decision` revokes capability (`revoked: true`), leaves `confirmed: false`, and blocks subsequent approval replay. | **PASS** |
| `P0-12` (`3988–4077`) | Independently exercises all 5 invalid-token classes inside `P0-12`: wrong session (`SESSION_MISMATCH`), wrong decisionId (`ARGS_MISMATCH`), wrong projectId (`ARGS_MISMATCH`), tampered signature (`SIGNATURE_INVALID`), and expired TTL (`TOKEN_EXPIRED`); verifies persisted decision remains `confirmed: false`. | **PASS** |
| `P0-13` (`4079–4141`) | Exercises both Emergency Stop and Security Lockdown on **both** `ToolOrchestrator.dispatch()` and `ConversationManager` `confirm_decision` WebSocket handler; verifies zero persisted mutations. | **PASS** |
| `P0-14` (`4143–4166`) | Captures all 4 channels (`console.log`, `console.warn`, `securityAuditLogger`, model `sendToolResponse`), verifies real `trustedActor.identityId` in audit logs, zero `"local_user"`/`"local_operator"`, and zero raw tokens or `sora_conf_` across all 4 channels. | **PASS** |

---

## 11. All Regression Commands, Counts, Skipped Tests, and Exit Codes

All commands were executed sequentially after the final edit:

| # | Exact Command | Exit Code | Passed | Failed | Skipped | Evidence Type |
| :-: | :--- | :-: | :-: | :-: | :-: | :--- |
| 1 | `npx vitest run --fileParallelism=false tests/unit/phase10_project_continuity.test.ts tests/unit/phase10_audio_continuity.test.ts` | `0` | 117 *(90 project + 27 audio)* | 0 | 0 | Automated Test (local + mocked WS/Live) |
| 2 | `npx vitest run --fileParallelism=false tests/unit/stage10_1_10_2_security_remediation.test.ts tests/unit/companion_core_phase1.test.ts tests/unit/gemini_live_auth_regression.test.ts` | `0` | 72 *(19 sec + 42 companion + 11 live auth)* | 0 | 0 | Automated Test (local + mocked WS) |
| 3 | `npx vitest run --fileParallelism=false tests/unit/planner.test.ts tests/unit/projects.test.ts` | `0` | 88 *(71 planner + 17 projects)* | 0 | 0 | Automated Test (local) |
| 4 | `npx vitest run --fileParallelism=false tests/e2e/cross_platform_e2e_phase29.test.ts -t "strictly preserves"` | `0` | 1 | 0 | 41 *(filtered by `-t`)* | Automated Test (local) |
| 5 | `npx tsc --noEmit` | `0` | 0 errors | 0 | — | Static Type Check |
| 6 | `npx tsx -e "import { LIVE_TOOLS } from './backend/ai/GeminiSessionFactory.ts'; ..."` | `0` | `129 / 129` unique | 0 | — | Programmatic Invariant Probe |
| **Aggregate (Non-Double-Counted)** | **8 distinct test files + `tsc` + `LIVE_TOOLS` probe** | **All `0`** | **278** | **0** | **41** *(filtered)* | **Automated / Static Verification** |

---

## 12. Exact `LIVE_TOOLS` Count and Uniqueness

Verified programmatically (`npx tsx -e`, exit code `0`):
- **Total declarations:** `129`
- **Unique tool names:** `129`
- **`trackProjectTask` actions (9):** `["list", "add", "update", "resume", "continuity", "historical", "switch", "record_decision", "confirm_decision"]`
- **`trackProjectTask` parameters (11):** `["action", "projectName", "title", "description", "status", "taskId", "date", "decisionId", "decisionType", "sessionSummary", "nextSteps"]`
- **`hasConfirmationToken`:** `false`
- **`hasGetProjectContinuity`:** `false`

---

## 13. Stage 10.1 / 10.2 and Stage 10.4.2 Regression Status

- **Stage 10.1 / 10.2 Governance & Memory Security:** **`PASS`** (`stage10_1_10_2_security_remediation.test.ts` 19/19, `companion_core_phase1.test.ts` 42/42).
- **Stage 10.4.2 Confirmation Revocation, Local `/live` Identity & Audio Continuity:** **`PASS`** (`phase10_audio_continuity.test.ts` 27/27, `gemini_live_auth_regression.test.ts` 11/11, `CR-01`..`CR-19` & Local `/live` tests inside `phase10_project_continuity.test.ts` all passed).
- **Planner & Projects Core:** **`PASS`** (`planner.test.ts` 71/71, `projects.test.ts` 17/17).

---

## 14. Frozen-Boundary Verification

All protected/frozen files and directories remained untouched (no Git commands, no package installs, no production calls):

| Frozen Boundary | Status | Last Modified Timestamp |
| :--- | :---: | :--- |
| `backend/server.ts` | Untouched | `2026-11-18 19:30:25` |
| `backend/conversation/ConversationManager.ts` | Untouched | `2026-11-18 20:46:30` |
| `backend/projects/ProjectDecisionStore.ts` | Untouched | `2026-11-18 20:49:17` |
| `backend/projects/ProjectStore.ts` | Untouched | `2026-11-18 20:49:17` |
| `backend/planner/PlannerCoordinator.ts` | Untouched | `2026-09-23 18:11:38` |
| `backend/planner/PlanStore.ts` | Untouched | `2026-11-18 20:45:51` |
| `backend/device/RemoteBridge.ts` | Untouched | `2026-09-26 23:46:12` |
| `android/` | Untouched | `2026-09-30 16:47:20` |
| `electron/` | Untouched | `2026-09-30 10:14:16` |
| `desktop_agent/` | Untouched | `2026-10-22 15:55:10` |

---

## 15. Blocked and Unverified Runtime Checks

| Check | Status | Details |
| :--- | :---: | :--- |
| Live Gemini Cloud Staging (`ai.live.connect` against Google Gemini Live API) | **`BLOCKED`** | No isolated staging environment authorized; production endpoints were never contacted. Mocked `@google/genai` `Live.prototype.connect` tests are classified strictly as automated tests, not live cloud verification. |
| Interactive Chromium / Playwright Browser DOM (`DecisionConfirmationModal.tsx`) | **`NOT VERIFIED`** | Out of scope for this backend/unit remediation; browser DOM rendering was not executed. |

---

## 16. Remaining Risks and Required Authorization (Out of Scope)

- **Generic `STRICT`/`PARANOID` Confirmation UI:** Non-project tools blocked with `REQUIRE_CONFIRMATION` in `STRICT`/`PARANOID` modes now fail closed without exposing confirmation tokens to the model. If an interactive approval UI is later desired for generic non-project tools in `STRICT`/`PARANOID` modes, that will require a dedicated out-of-band WebSocket & UI design in a separate authorized phase.
- **Explicitly Deferred (Out of Scope for This P0 Cycle):**
  - P1 `GAP-10.3-08` (`ProjectStore` cache/read-modify-write integrity) — not started.
  - P2 `TaskPlan.projectId` stamping & `PlannerCoordinator` changes — not started.
  - Independent P0 re-audit of this residual remediation cycle.
