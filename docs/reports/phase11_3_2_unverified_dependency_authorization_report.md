# MYRAA — Phase 11.3.2: Unverified Dependency Authorization Provenance Audit Report

**Date:** 2026-11-22  
**Phase:** 11.3.2 — Unverified Dependency Authorization Provenance Audit  
**Target Repository:** `d:\SORA AI\Sora AI`  
**Verdict:** **PASS**

---

## 1. Executive Summary

Phase 11.3.2 executed a focused, rigorous security verification of the authorization provenance for downstream step execution following an unverified predecessor (`acknowledged_unverified`), specifically investigating the mechanism:

```typescript
step.allowUnverifiedDependency === true
```

The audit evaluated whether this property could be introduced or influenced by untrusted AI-generated plan proposals, external JSON payloads, or unprivileged callers to bypass dependency safety checks on destructive or modifying operations.

### Key Audit Findings & Remediations
1. **Vulnerability Identified in Phase 11.3.1 Prototype:** In the initial dependency safety implementation from Phase 11.3.1, `allowUnverifiedDependency` was checked directly on the step object (`(step as any).allowUnverifiedDependency === true`). An AI model or untrusted external instruction generating a plan could have set this property on a destructive step, thereby self-authorizing downstream execution on unverified predecessors without operator oversight.
2. **Untrusted Plan Trust Boundary Established:** Raw `allowUnverifiedDependency` properties on incoming plan step objects are now completely stripped during `validatePlanGraph`. Raw properties on step objects are never trusted.
3. **Cryptographically Scoped Continuation Authorization:** Continuation permission for destructive steps is now exclusively granted via an explicit, cryptographically signed `ContinuationAuthorization` record issued in-memory by an authenticated operator with `role === "admin"`.
4. **Strict Scope Bindings & Anti-Replay:** Every continuation authorization is tightly bound to `(planId, stepId, predecessorStepId, projectId, toolName)` with an HMAC-SHA256 signature, a strict 10-minute default TTL, and immediate fail-closed revocation on plan cancellation, restart, or emergency stop.
5. **Defense-in-Depth & Checkpoint Independence:** Continuation authorization only permits the orchestrator to mark a pending step as dependency-satisfied. It **never grants execution authority**. `StepExecutor.executeStep` and `ToolExecutionFirewall` continue to enforce mandatory `CheckpointManager` user approval tokens for all destructive steps.

All 40 tests in `tests/unit/task_recovery_verification.test.ts` (including 12 new negative security tests), all 36 `task_orchestrator` tests, all 93 `planner` tests, all 24 `explainability` tests, all 45 `reminder` tests, and the 129 `LIVE_TOOLS` invariant test passed with 0 failures and 0 TypeScript errors.

---

## 2. Property Provenance & Architecture

### 2.1 Where Was `allowUnverifiedDependency` Defined, Created, Modified, Persisted, and Consumed?
- **Phase 11.3.1 Origin:** In Phase 11.3.1, `isStepDependencySatisfied(step, dep, workspaceDir)` introduced a rule that destructive steps depending on an `acknowledged_unverified` predecessor would return `false` unless `(step as any).allowUnverifiedDependency === true`.
- **Definition:** The property was an ad-hoc field on `PlanStep`, not formalised in `PlannerTypes.ts`, making it possible for untrusted inputs to include arbitrary boolean flags.
- **Consumption:** It was consumed directly by `isStepDependencySatisfied` to override the block on destructive tools (`deleteFile`, `writeCodeFile`, `runCommand`, etc.).
- **Persistence:** In Phase 11.3.1, if a step containing this property was saved via `PlanStore`, the raw flag would persist into `plans/{planId}.json`.

### 2.2 Security Risks of Raw Property Trust
1. **Self-Authorizing AI Proposals:** In the MYRAA architecture, the AI acts as a **proposal generator**, while the security framework acts as the **decision authority**. Allowing an AI-generated plan to contain `"allowUnverifiedDependency": true` violated this boundary, as an AI proposal could grant itself permission to run destructive operations against unverified data.
2. **External JSON Injection:** Untrusted task inputs, imported plans, or external webhook prompts could include crafted plan structures with `allowUnverifiedDependency: true`.
3. **Privilege Escalation:** Unprivileged operators or standard users could craft recovery requests with steps flagged to bypass verification checks.

---

## 3. AI-Plan Trust Boundary & Sanitization

### 3.1 Plan Validation Sanitization (`validatePlanGraph`)
To prevent untrusted plan data from injecting self-authorizing flags, `TaskOrchestrator.validatePlanGraph` now scrubs the raw property from all incoming plan steps:

```typescript
// Strip raw untrusted continuation flags from AI-proposed or external steps
if ((step as any).allowUnverifiedDependency !== undefined) {
  delete (step as any).allowUnverifiedDependency;
}
```

Even if an attacker or LLM generates:
```json
{
  "id": "step-2",
  "toolName": "deleteFile",
  "dependsOn": ["step-1"],
  "allowUnverifiedDependency": true
}
```
The property is deleted during graph validation before the plan can be registered, scheduled, or executed.

### 3.2 Complete Rejection of Raw Step Flags in `isStepDependencySatisfied`
In `isStepDependencySatisfied`, raw properties on the `step` object are completely ignored. For any modifying or destructive step (`step.isDestructive || MODIFYING_TOOLS.has(step.toolName)`), the orchestrator delegates strictly to the authoritative verification method:

```typescript
if (step.isDestructive || MODIFYING_TOOLS.has(step.toolName)) {
  if (!TaskOrchestrator.verifyContinuationAuthorization(step, dep, plan)) {
    return false;
  }
}
```

---

## 4. Legitimate Authorization Source & Scoping

### 4.1 Authoritative Authorization Interface
Continuation authorization can only be generated through `TaskOrchestrator.grantContinuationAuthorization`:

```typescript
grantContinuationAuthorization(
  context: SecurityContext,
  plan: OrchestratedTaskPlan,
  stepId: string,
  predecessorStepId: string,
  options?: { ttlMs?: number; projectId?: string },
): ContinuationAuthorization
```

### 4.2 Security Invariants Enforced at Issuance
1. **Role Provenance:** Caller must present a valid `SecurityContext` where `context.role === "admin"`. Any call with `role: "standard"`, `role: "read_only"`, `role: "guest"`, or missing context throws:
   ```
   CROSS_ROLE_AUTHORIZATION_DENIED: Only an authenticated admin can authorize continuation on unverified dependencies.
   ```
2. **Emergency Stop & Lockdown Fail-Closed:**
   - If `emergencyStopCoordinator.isActive()`, throws `EMERGENCY_STOP_ACTIVE`.
   - If `securityPolicyEngine.getMode() === "LOCKDOWN"`, throws `SECURITY_LOCKDOWN`.
3. **Declared Dependency Integrity:** The step must genuinely declare a dependency on `predecessorStepId` (`step.dependsOn.includes(predecessorStepId)`). Phantom authorizations for unrelated steps are rejected with `INVALID_DEPENDENCY_RELATION`.
4. **Project Continuity & Isolation:** If the plan carries a canonical `projectId`, the authorization must match that `projectId`. Attempting cross-project continuation throws:
   ```
   CROSS_PROJECT_VIOLATION: Cannot authorize continuation for project 'project-beta' on plan belonging to project 'project-alpha'.
   ```

### 4.3 Cryptographic Structure & HMAC Signing
Every authorization record is signed using a module-internal secret (`CONTINUATION_SECRET`):

```typescript
export interface ContinuationAuthorization {
  id: string;
  planId: string;
  stepId: string;
  predecessorStepId: string;
  projectId?: string;
  toolName: string;
  authorizedBy: string;
  authorizedRole: "admin";
  authorizedAt: string;
  expiresAt: string;
  signature: string;
}
```

The signature is computed over:
`id:planId:stepId:predecessorStepId:projectId:toolName:authorizedBy:authorizedRole:authorizedAt:expiresAt`
using HMAC-SHA256. Any modification to any field invalidates the signature and causes verification to fail closed.

---

## 5. Defense-in-Depth: CheckpointManager & Security Gate Independence

A core security requirement of Phase 11.3.2 is that continuation permission **does not grant execution authority**.

### 5.1 Two-Tier Gate Separation

```
[ Plan Graph / Orchestrator ]
           │
           ▼
isStepDependencySatisfied()
   ├── Safe read-only step -> ALLOWED
   └── Modifying / Destructive step:
         └── Checks ContinuationAuthorization
               ├── Missing / Invalid / Expired -> BLOCKED (fails closed)
               └── Valid Admin HMAC Grant -> Step marked EXECUTABLE
                                                     │
                                                     ▼
                                    [ StepExecutor.executeStep ]
                                                     │
                                                     ▼
                                       CheckpointManager.consumeApproval()
                                         ├── Missing Token -> BLOCKED ("No checkpoint token found")
                                         ├── Unapproved Token -> BLOCKED
                                         ├── Expired Token -> BLOCKED
                                         └── Approved Token -> Consumed & Dispatched to ToolExecutionFirewall
```

### 5.2 Verification Evidence
In negative test 4.10, even after an operator granted continuation authorization allowing `step-2` (`deleteFile`) to be picked by `getNextExecutableStep`, directly attempting to execute the step via `stepExecutor.executeStep(s2, tmpDir)` immediately failed:
```
error: "No checkpoint token found for destructive step — execution refused."
```
Continuation authorization merely resolves dependency sequencing; execution requires an explicit, separate, human-in-the-loop checkpoint confirmation.

---

## 6. Plan Lifecycle, Revocation & Expiration

### 6.1 Strict Time-To-Live (TTL)
- Default TTL: 10 minutes (matching `CHECKPOINT_TTL_MS`).
- Minimum TTL: 1 second; Maximum TTL: 60 minutes.
- When `expiresAt` passes, `verifyContinuationAuthorization` immediately purges the grant and returns `false`.

### 6.2 Cancellation & Emergency Stop Revocation
- **Plan Cancellation (`cancelTask`):** `this.revokeContinuationGrants(planId)` is immediately called alongside `checkpointManager.expireAll(planId)`. All grants for that plan are pruned from memory.
- **Emergency Stop (`emergencyStop`):** All abort controllers are triggered, execution locks are released, and `TaskOrchestrator._continuationGrants.clear()` wipes all grants instantly.
- **Security Lockdown:** While the system is in `LOCKDOWN` mode, `verifyContinuationAuthorization` returns `false` unconditionally.

### 6.3 Volatile In-Memory Storage (Replay Defense)
Continuation authorizations are deliberately stored in memory only (`TaskOrchestrator._continuationGrants`) and **never persisted to disk** in `TaskPlan` files. If the server or desktop process restarts, all previous continuation permissions are wiped. The operator must re-authorize continuation through `recoverPlan(planId, { authorizeContinuationSteps: [...] })`.

---

## 7. Negative Test Verification Matrix

All scenarios were implemented and verified in `tests/unit/task_recovery_verification.test.ts` under Area 4:

| Test ID | Test Scenario | Expected Outcome | Result |
|---|---|---|---|
| **4.1** | Raw `allowUnverifiedDependency` in plan step | Stripped by `validatePlanGraph`; property becomes `undefined` | **PASS** |
| **4.2** | AI-generated plan with raw flag on destructive step | `isStepDependencySatisfied` = false; `getNextExecutableStep` = undefined | **PASS** |
| **4.3** | Non-admin (`standard`, `guest`) caller invokes grant | Throws `CROSS_ROLE_AUTHORIZATION_DENIED` | **PASS** |
| **4.4** | Step ID mismatch (grant for `step-2`, evaluated for `step-3`) | `step-2` = true; `step-3` = false (fails closed) | **PASS** |
| **4.5** | Plan ID mismatch (grant for `plan-A`, evaluated for `plan-B`) | `plan-A` = true; `plan-B` = false (fails closed) | **PASS** |
| **4.6** | Cross-project mismatch (`project-alpha` vs `project-beta`) | Throws `CROSS_PROJECT_VIOLATION` on grant; fails closed on evaluation | **PASS** |
| **4.7** | Expired authorization lifetime (`expiresAt` in past) | Fails closed (returns `false`); expired grant pruned from memory | **PASS** |
| **4.8** | Cryptographic signature tampering (corrupted hex) | Signature mismatch detected; fails closed (returns `false`) | **PASS** |
| **4.9** | Emergency stop active & SecurityPolicyEngine in `LOCKDOWN` | Grant throws `SECURITY_LOCKDOWN`; emergency stop wipes grants | **PASS** |
| **4.10** | CheckpointManager independence | Continuation grant does not allow execution without approved checkpoint token | **PASS** |
| **4.11** | `recoverPlan` with `authorizeContinuationSteps` | Admin succeeds with audit log; non-admin rejected with `CROSS_ROLE` denial | **PASS** |
| **4.12** | `cancelTask` revocation | All grants for plan revoked immediately upon cancellation | **PASS** |

---

## 8. Audit Evidence & Logging

When an operator authorizes continuation during plan recovery or via `grantContinuationAuthorization`, an entry is recorded in `plan.executionLog`:

```json
{
  "timestamp": "2026-11-22T14:55:00.000Z",
  "stepId": "step-2",
  "phase": "verify",
  "level": "info",
  "message": "continuation_authorized: Operator 'usr_operator_1' (admin) granted continuation on unverified predecessor 'step-1' for step 'step-2' (grantId: cont_7a8b9c, expires: 2026-11-22T15:05:00.000Z)."
}
```

This log is tamper-evident, recorded within the persistent plan history, and exposed to `ExplainabilityService` for diagnostic auditing.

---

## 9. Test Suite Execution Summary

```
 RUN  v5.0.1 D:/SORA AI/Sora AI

 ✓ tests/unit/task_recovery_verification.test.ts (40 tests) 127ms
   ✓ Phase 11.3: Task Recovery, Execution Evidence & Verified Completion (11)
   ✓ Phase 11.3.1: Postcondition Verification, Dependency Safety & Completion Gate Integrity (17)
   ✓ Phase 11.3.2: Unverified Dependency Authorization Provenance (12)

 ✓ tests/unit/planner.test.ts (93 tests) 1585ms
 ✓ tests/unit/task_orchestrator.test.ts (36 tests) 260ms
 ✓ tests/unit/explainability/explainability.test.ts (24 tests) 1678ms
 ✓ tests/unit/reminders/reminders.test.ts (27 tests) 2267ms
 ✓ tests/unit/reminders/reminder_reliability.test.ts (18 tests) 266ms

 Test Files  6 passed (6)
      Tests  238 passed (238)
```

- **Tool Invariant:** Exactly 129 `LIVE_TOOLS` preserved across all Gemini Live tool registries (0 added, 0 removed).
- **TypeScript Static Analysis:** `npx tsc --noEmit` exited with code 0 (clean compilation).

---

## 10. Remaining Limitations & Architectural Boundaries

1. **In-Memory Volatility:**
   - Continuation authorizations are stored exclusively in memory and not persisted across daemon restarts. This is an intentional security design choice to prevent token replay and stale authorization exploitation following crashes.
2. **Admin-Only Scope:**
   - Only operators with `role === "admin"` can grant continuation. If multi-role workflows require delegated authorization in future phases, a granular capability-based permission model must be designed.
3. **Predecessor Invariance:**
   - A continuation grant authorizes execution of a specific step despite an unverified predecessor; it does not change the predecessor's status from `acknowledged_unverified` to `completed`. The predecessor remains unverified in all audit records and score calculations.

---

## 11. Final Verdict

**VERDICT: PASS**

The authorization provenance of `step.allowUnverifiedDependency` has been audited and resolved. Untrusted AI plan proposals and external content can no longer self-authorize destructive actions. Continuation permissions are strictly bounded, cryptographically signed, role-restricted to administrators, time-limited, and completely decoupled from execution authority, which remains guarded by `CheckpointManager` and `SecurityPolicyEngine`.
