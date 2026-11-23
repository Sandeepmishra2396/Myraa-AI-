# MYRAA — STAGE 10, PHASE 10.3: PROJECT CONTINUITY ENGINE
## R1.1 Targeted Final Acceptance Audit Report
### Strict Read-Only Verification

**Auditor:** Principal Software Architect & AI Systems Security Auditor  
**Date:** 2026-11-03T10:42:00+05:30  
**Phase:** Stage 10, Phase 10.3 (Project Continuity Engine)  
**Audit Round:** R1.1  
**Audit Mode:** STRICT READ-ONLY (No code, test, configuration, or working-tree mutations)  
**Overall Acceptance Verdict:** **OPEN — CRITICAL DATA INTEGRITY & ARCHITECTURE REQUIREMENTS UNRESOLVED**

---

### Executive Summary

An independent, rigorous, read-only audit of the Stage 10 Phase 10.3 Project Continuity Engine (remediation round R1) was conducted against source code, runtime call paths, cryptographic boundaries, and test execution evidence.

While several key backend security controls (cryptographic token issuance, single-use consumption, write serialization queue, DLP redaction in OutputDataFirewall, and untrusted prompt fencing) were verified, this audit has uncovered **three critical unresolved defects**:
1. **Historical Task Inversion & False Completion Attribution:** The historical task reconstruction algorithm in `ProjectContinuityResolver.getHistoricalTasks()` relies on mutable `updatedAt` timestamps rather than an immutable transition history. In 4 out of 5 audited real-world scenarios, it produces mathematically and logically false status claims without disclosing limitations.
2. **Same-Session System Instruction Leak (Mid-Session Vulnerability):** In an active Gemini Live session, system instructions are immutably established at WebSocket handshake. Calling `invalidateInstructionsCache()` clears the module cache for future sessions, but the **currently running live session continues executing with Project A's system instructions**, retaining Project A context mid-session.
3. **Missing Frontend Confirmation UI Path:** While the backend emits `confirmation_required` via `sendToClient`, the frontend WebSocket client (`frontend/lib/audio.ts`) has **no handler** for `confirmation_required` and provides no UI dialog, prompt, or button for human operator review and confirmation.

Consequently, the previous claim of `PASS` is rejected, and the phase is classified as **OPEN**.

---

### 1. LIVE_TOOLS Count Discrepancy Investigation

#### 1.1 Invariant Check
The established invariant requires:
- **129 LIVE_TOOLS declarations**
- **129 unique tool names**

The R1 report stated:
- "126 declarations / 126 unique tools"

#### 1.2 Inspection Findings
Inspection of `backend/ai/GeminiSessionFactory.ts` lines 90–2480 reveals:
- **Actual current declarations count:** **129**
- **Actual unique tool names count:** **129**
- **Disappeared declarations:** **0** (No tool was removed or lost)

#### 1.3 Root Cause of the Discrepancy
In `tests/e2e/cross_platform_e2e_phase29.test.ts`, lines 98–104:
```ts
it("1.1 strictly preserves exactly 126 Gemini Live tools in LIVE_TOOLS", () => {
  const decls = LIVE_TOOLS[0].functionDeclarations;
  expect(decls.length).toBe(129);
  const uniqueNames = new Set(decls.map((d: any) => d.name));
  expect(uniqueNames.size).toBe(129);
  expect(uniqueNames.has("triggerEmergencyStop")).toBe(true);
});
```
The test title contains the legacy label `"126 Gemini Live tools"`, while the actual assertion checks `expect(decls.length).toBe(129)` and `expect(uniqueNames.size).toBe(129)`. Both assertions pass.
The R1 implementation report inadvertently quoted the literal test title ("126 tools verified in LIVE_TOOLS") instead of the evaluated assertion value (`129`).
All 129 tool contracts remain 100% intact.

**Invariant Classification:** **CLOSED (129/129 Verified Intact — Documentation Erratum Resolved)**

---

### 2. Historical Task Status — Critical Data Integrity Audit

#### 2.1 Code Under Inspection
In `backend/projects/ProjectContinuityResolver.ts` (`getHistoricalTasks` lines 385–418):
```ts
for (const t of tasks) {
  const createdMs = t.createdAt ? new Date(t.createdAt).getTime() : 0;
  const updatedMs = t.updatedAt ? new Date(t.updatedAt).getTime() : createdMs;

  if (createdMs > endMs) continue;
  hasHistoricalEvidence = true;

  if (t.status === "done") {
    if (updatedMs >= startMs && updatedMs <= endMs) {
      completedOnDate.push({ taskId: t.id, title: t.title, status: "done" });
    } else if (updatedMs > endMs) {
      pendingOnDate.push({ taskId: t.id, title: t.title, status: "in_progress" });
    }
  } else {
    pendingOnDate.push({ taskId: t.id, title: t.title, status: t.status });
  }
}
```

#### 2.2 Scenario-by-Scenario Proof Analysis

| Scenario | Real Historical Event | Algorithm Evaluation Path | Emitted Classification | Provability Verdict |
| :--- | :--- | :--- | :--- | :--- |
| **A. Task pending on target date, completed afterward, remains completed** | Task created before target date. On target date it was pending. Completed afterward (`updatedMs > endMs`). | `t.status === "done" && updatedMs > endMs` -> pushes to `pendingOnDate` with hardcoded `status: "in_progress"`. | **Pending (`in_progress`)** | **PARTIALLY SOUND, ARBITRARY STATUS**: Identifies as pending, but hardcodes `"in_progress"` even if the task was `"todo"` or `"blocked"`. |
| **B. Task completed on target date, reopened afterward** | Task completed on target date. Reopened afterward to `"todo"` or `"in_progress"`. | Current `t.status !== "done"` -> falls into `else` branch -> pushes to `pendingOnDate` with current status. `completedOnDate` is empty. | **Pending (`todo`/`in_progress`)** | **PROVABLY FALSE**: Task was completed on target date, but algorithm reports it as pending on target date and misses the completion entirely. |
| **C. Task completed before target date, then edited on target date without status transition** | Task completed 5 days before target date. On target date, user edits description (typo fix). `projectManager.updateTask` updates `updatedAt` to target date. | Current `t.status === "done"`. `updatedMs` falls within `startMs <= updatedMs <= endMs`. Pushes to `completedOnDate`. | **Completed on Target Date** | **PROVABLY FALSE / FABRICATED COMPLETION**: Non-status metadata edit on target date causes algorithm to falsely claim the task was completed on the target date. |
| **D. Task completed on target date, description edited later** | Task completed on target date. 2 days later, description edited. `updatedAt` is updated to 2 days later (`updatedMs > endMs`). | Current `t.status === "done"`. `updatedMs > endMs` -> pushes to `pendingOnDate` as `"in_progress"`. | **Pending (`in_progress`)** | **PROVABLY FALSE / INVERTED STATUS**: Task was completed on target date, but editing description later causes algorithm to claim it was PENDING on the target date. |
| **E. Task completed on target date, reopened and completed again later** | Task completed on target date, reopened later, completed again. `updatedAt` reflects second completion (`updatedMs > endMs`). | Current `t.status === "done"`. `updatedMs > endMs` -> pushes to `pendingOnDate` as `"in_progress"`. | **Pending (`in_progress`)** | **PROVABLY FALSE**: Task was completed on target date, but algorithm classifies it as pending. |

#### 2.3 Historical Limitation Disclosure Deficiency
Lines 421–426 state:
```ts
let historicalLimitation: string | undefined;
if (!hasHistoricalEvidence || (pendingOnDate.length === 0 && completedOnDate.length === 0)) {
  historicalLimitation =
    `No historical tasks recorded as active on ${dateStr} for project '${project.name}'. ` +
    `MYRAA does not invent pending tasks when historical records are unavailable.`;
}
```
When tasks exist, `historicalLimitation` is **`undefined`**. The system presents the inferred statuses as factual without disclosing to the AI or user that in-place mutations make historical reconstruction speculative.

**Mandatory Rule Assessment:**  
Without immutable append-only transition logs (e.g. `TaskTransitionStore` or `taskHistory: [{ status, timestamp }]`), in-place mutated records cannot prove past status. Claiming precise status in Scenarios B, C, D, and E violates data integrity invariants.

**Classification:** **OPEN — CRITICAL DATA INTEGRITY DEFECT**

---

### 3. Active Gemini Session Cache Isolation Audit

#### 3.1 Architecture Inspection
The lifecycle of system instructions and Gemini Live sessions was traced:
1. `backend/projects/ContextManager.ts` compiles system instructions:
   `buildCompleteSystemInstructions()` calls `projectContinuityResolver.buildContinuityCard()`, which bakes active project metadata into the prompt string.
2. `backend/ai/GeminiSessionFactory.ts`:
   - `getCachedInstructions()` caches this string in `_instructionsCache` (TTL: 90s).
   - `createSession()` passes `instructions` to `client.aio.live.connect({ config: { systemInstruction: instructions, ... } })`.
   - The returned `aiSession` is a stateful WebSocket connection to the Gemini Live server.
3. `ToolOrchestrator.ts` handling `trackProjectTask` with `action: "switch"`:
   - Invokes `projectContinuityResolver.switchProject(projectName)`.
   - Calls `invalidateInstructionsCache()`, clearing `_instructionsCache = null`.
   - Sends tool response: `{ switched: true, project: "Project B", continuity: ctx }`.

#### 3.2 Mid-Session Leak Analysis
- **Gemini Live WebSocket protocol reality:** `systemInstruction` is a session-setup parameter sent only during the initial connection handshake. There is no protocol message in Gemini Live to dynamically replace or update `systemInstruction` on an open connection.
- **Result during a live conversation:**
  When a user switches from Project A to Project B within the same continuous session:
  - `_instructionsCache` is cleared for *future* connections.
  - But the **currently active `aiSession` is neither rotated nor reconnected**.
  - Its authoritative system prompt still contains:
    `=== PROJECT CONTINUITY (Phase 10.3) === [PROJECT_CONTEXT: proj-alpha] Project: Project A ...`
  - While the model received a tool result indicating a switch occurred, the top-level system persona and instructions remain permanently pinned to Project A for the remainder of that WebSocket session.
  - If the user asks general questions without repeating the project name, the AI operates under Project A's system instructions.

**Classification:** **VERIFIED VULNERABLE**

---

### 4. Human Confirmation Trust Boundary Audit

#### 4.1 Backend Verification (Verified Robust)
1. **Token Binding:** `SecurityPolicyEngine.generateConfirmationToken` calculates `argsHash = sha256({ action: "confirm_decision", decisionId, projectId })`. Tokens are bound to the specific decision and project.
2. **AI Token Redaction:** `OutputDataFirewall.sanitizeResult` redacts `sora_conf_...` to `[REDACTED_TOKEN]` in all session responses. The AI cannot inspect or steal confirmation tokens.
3. **Single-Use Consumption:** `_consumedConfirmationTokens.add(tokenId)` prevents replay. Replays fail with `CONFIRMATION_TOKEN_REPLAY`.
4. **Token Expiration:** 5-minute TTL (`CONFIRMATION_TOKEN_TTL_MS = 300_000`) is strictly enforced.
5. **Cross-Project Rejection:** `ProjectDecisionStore` and `ToolOrchestrator` enforce `decision.projectId === currentProjectId` before evaluating confirmation tokens.

#### 4.2 Frontend Trust Boundary Gap (CRITICAL)
Inspection of `frontend/lib/audio.ts` (the WebSocket message processor for the frontend) reveals:
- Lines 866–1045 handle `pong`, `error`, `status`, `audio`, `interrupted`, `speech_prosody`, `turnComplete`, `transcription`, `memory_sync`, `code_change`, `companion_notification`, `emergency_stop`, `toolCall`, and `desktop_tool_call`.
- **There is NO handler for `data.type === "confirmation_required"`**.
- Incoming `confirmation_required` packets delivered via `sendToClient` fall off the end of `_handleWsMessage` and are silently discarded.
- No UI modal, toast, review dialog, or confirmation button exists in the frontend UI to display the decision to the human operator.
- The human operator has no interface to submit the confirmation token.
- In production, calling `confirm_decision` puts the tool into a dead-end state: the AI is blocked awaiting confirmation, but the human is never prompted to approve it.

**Classification:** **OPEN — HUMAN CONFIRMATION UI PATH MISSING**

---

### 5. Security & Scope Integrity Reconfirmation

| Security Control | Implementation Verification | Status |
| :--- | :--- | :--- |
| **Cross-Project Decision Isolation** | Enforced at store level (`expectedProjectId`) and tool orchestrator level (`cross_project_violation`). | **VERIFIED INTACT** |
| **Decision Persistence Serialization** | Mutating operations serialized via `writeQueue: Promise<unknown>` in `ProjectDecisionStore`. Atomic `.tmp` rename with backoff. | **VERIFIED INTACT** |
| **Confirmed Decision Immutability** | Attempting to update description on confirmed decision throws `Immutability violation`. Idempotent confirmations preserve original `confirmedAt`. | **VERIFIED INTACT** |
| **Security Audit Logging** | `securityAuditLogger.logEvent` records `TOOL_ALLOW`, `TOOL_REQUIRE_CONFIRMATION`, `TOOL_CONFIRMED`, `TOOL_BLOCKED` with hash chaining. | **VERIFIED INTACT** |
| **Emergency Stop Behavior** | `emergencyStopCoordinator.isActive()` blocks decision recording and confirmation with explicit exception. | **VERIFIED INTACT** |
| **Project Deletion Consistency** | `ProjectStore.deleteProject` calls `projectDecisionStore.deleteByProject(id)` to prevent orphaned records. | **VERIFIED INTACT** |
| **Untrusted Content Fencing** | `buildContinuityCard` wraps output in `<<<UNTRUSTED_DOCUMENT_DATA>>>` with security directive. | **VERIFIED INTACT** |
| **Phase 2 Memory Governance** | `tests/unit/companion_core_phase1.test.ts` passes 42/42 tests (`GoverningMemoryGate`, `GovernanceProof`, `AsyncLocalStorage`). | **VERIFIED INTACT** |
| **Frozen Subsystems** | `android/`, `electron/`, `desktop_agent/`, `PlannerCoordinator.ts`, Remote Bridge remain 100% untouched. | **VERIFIED INTACT** |
| **Working Tree Modifications** | All pre-existing unstaged modifications in working tree are preserved. | **VERIFIED INTACT** |

---

### 6. Test Execution Evidence

#### 6.1 Actually Executed and Passed
1. **`tests/unit/phase10_project_continuity.test.ts`**
   - Result: **48 passed / 48 total** (355ms)
   - Scope: Store serialization, project resolution, context assembly, cache invalidation spy, prompt fencing, cascading delete, token replay rejection.
2. **`tests/unit/projects.test.ts`**
   - Result: **17 passed / 17 total** (609ms)
   - Scope: ProjectStore, ProjectManager, active project pointer, project task tracking.
3. **`tests/unit/planner.test.ts`**
   - Result: **71 passed / 71 total** (538ms)
   - Scope: PlannerCoordinator, dispatch safety gate, path traversal defenses, checkpoint approval lifecycle.
4. **`tests/unit/companion_core_phase1.test.ts`**
   - Result: **42 passed / 42 total** (406ms)
   - Scope: Phase 1 & 2 Memory Governance, `GoverningMemoryGate`, `GovernanceProof`, proof consumption.
5. **`tests/e2e/cross_platform_e2e_phase29.test.ts` (`strictly preserves`)**
   - Result: **1 passed / 1 executed** (32ms)
   - Scope: Verifies exactly 129 tools declared in `LIVE_TOOLS`.
6. **`npx tsc --noEmit`**
   - Result: **Exit Code 0** (0 type errors across entire codebase).

#### 6.2 Executed and Failed (Legacy Test Suites)
1. **`tests/unit/memory.test.ts`** (7 failed / 65 total)
   - Cause: Legacy unit tests expect Phase 1 behavior (`status: 'active'`), whereas Phase 2 `GoverningMemoryGate` deliberately sets unapproved memories to `pending_approval`.
2. **`tests/unit/shared_memory.test.ts`** (13 failed / 20 total)
   - Cause: Same Phase 2 governance enforcement.

#### 6.3 Inspected But Not Executed
- Android mobile test suites (`StandaloneMobileLaunchUxTest.kt`): Inspected for mobile tool call bindings.
- Electron native binary tests: Read-only inspection.

---

### 7. Unresolved Findings Summary

```
================================================================================
FINDING ID       SEVERITY   SUBSYSTEM                   ISSUE DESCRIPTION
================================================================================
SEC-P3-03-R1.1   HIGH       ProjectContinuityResolver   Historical status inversion: Mutable
                                                        updatedAt causes false completion date
                                                        attribution and status inversion (Scenarios
                                                        B, C, D, E). Limitation disclosure omitted.

SEC-P3-04-R1.1   HIGH       GeminiSessionFactory /      Mid-session context leak: Active Gemini Live
                            ConversationManager         WebSocket session retains Project A system
                                                        instructions after project switch. Cache
                                                        invalidation only affects future sessions.

SEC-P3-01-R1.1   HIGH       Frontend UI / AudioWS       Missing human approval UI path: Frontend
                                                        discards confirmation_required event; no UI
                                                        modal/action exists for operator approval.
================================================================================
```

---

### 8. Architectural Recommendations & Operator Authorizations Required

To achieve closure in Phase 10.3 without violating architecture or security boundaries:

1. **Historical Task Truthfulness:**
   - Modify `ProjectContinuityResolver.getHistoricalTasks()`: When query targets a past date, unless immutable state transition records exist, return tasks created on/before target date with an explicit limitation:
     `"Historical task status cannot be proven without audit logs. Reconstructed from creation timestamp only."`
   - Never classify tasks as `"done"` on a historical date based solely on mutable `updatedAt`.
2. **Active Live Session Rotation on Project Switch:**
   - In `ToolOrchestrator.ts` or `ConversationManager.ts`: When `action === "switch"` succeeds, trigger a graceful session rotation (`session.recreate()` or `createOrRotateGeminiSession(true)`) so the new WebSocket connection connects with Project B's freshly compiled `systemInstruction`.
3. **Frontend Confirmation Modal Component:**
   - In `frontend/lib/audio.ts`: Add `confirmation_required` listener that triggers a confirmation modal in `App.tsx` / `AvatarRenderer.tsx`.
   - Provide "Approve" button that dispatches `trackProjectTask` with `{ action: "confirm_decision", decisionId, confirmationToken }`.
4. **LIVE_TOOLS Schema Declaration Update (Operator Authorization Required):**
   - Formally authorize updating `trackProjectTask` schema in `GeminiSessionFactory.ts` to document `decisionId`, `decisionType`, and `confirmationToken` parameters.

---

### 9. Final Acceptance Verdict

- **129/129 LIVE_TOOLS Invariant:** Verified intact.
- **Backend Token Governance:** Verified cryptographically sound.
- **Historical Reconstruction Logic:** **FAILED (Unproven status claims in Scenarios B, C, D, E).**
- **Same-Session Isolation:** **FAILED (Active session retains Project A system prompt).**
- **Human Confirmation UI Path:** **FAILED (Frontend handler missing).**

**FINAL VERDICT:** **OPEN — REMEDIATION REQUIRED**

*(Strict read-only rules maintained: No source files, tests, or configurations modified during this audit. Phase 10.4 has not been started.)*
