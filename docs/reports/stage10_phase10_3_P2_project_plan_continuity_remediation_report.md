# MYRAA — Stage 10.3 P2 Project Plan Continuity Remediation Report
## `TaskPlan.projectId` Stamping | Explicit Project Ownership | Cross-Project Isolation

**Date:** 2026-11-18T23:10:00+05:30  
**Scope:** Stage 10.3 P2 Functional-Completeness Remediation (Authorized 5-file scope + 1 preferred existing test suite)  
**Source Finding:** [stage10_phase10_3_final_acceptance_R2.md](file:///d:/SORA%20AI/Sora%20AI/stage10_phase10_3_final_acceptance_R2.md) (`GAP-10.3-01` Plan Completeness)

---

## 1. Executive Status for P2

### **`PASS`** *(Pending Independent Read-Only Acceptance Audit)*

All three active production plan-creation paths (HTTP REST API, AI/Tool `ToolOrchestrator`, and Mobile Autonomous Workflow Engine) plus the core planner pipeline (`PlannerCoordinator` → `TaskPlanner` → `PlanStore` → `ProjectContinuityResolver`) now propagate, validate, and persist canonical `TaskPlan.projectId` values whenever explicit trusted project association exists, while preserving strict fail-closed cross-project isolation:

- **349 / 349** unique automated tests passed (`0` failed; `41` filtered-skipped in `cross_platform_e2e_phase29.test.ts` via `-t "strictly preserves"`), including **22 new permanent P2 persisted-state regression tests** in [tests/unit/planner.test.ts](file:///d:/SORA%20AI/Sora%20AI/tests/unit/planner.test.ts#L974-L1771).
- **`npx tsc --noEmit`** exited `0` (zero errors across backend, frontend, and test suites).
- **`LIVE_TOOLS`** preserved at strictly **129 / 129 unique declarations** (`trackProjectTask` retains 9 actions and `hasConfirmationToken: false`; `planTask` retains `["goal"]` with no model-controlled ownership field).
- **Zero frozen or unauthorized files were modified.**

*(Per P2 governance, P2 remains open until this report is reviewed and a separate independent read-only acceptance audit passes.)*

---

## 2. Initial Creation-Path Discovery Table (Batch A)

Full read-only repository scan across `backend/` confirmed **exactly 3 active production `createPlan()` call sites** and **1 internal `buildPlan()` call site** (`PlannerCoordinator.createPlan()`), all strictly within the five authorized files (note: actual paths in repository are `backend/gateway/HttpGateway.ts` and `backend/workflow/MobileWorkflowManager.ts`):

| Creation Path | File & Call Site | Explicit Project Identity Source (Before → After) | Trusted Resolution (After) | `projectId` Behavior (Before → After) |
|---|---|---|---|---|
| **HTTP / REST API** | [HttpGateway.ts](file:///d:/SORA%20AI/Sora%20AI/backend/gateway/HttpGateway.ts#L916-L964) (`POST /api/planner/plan`) | None → Optional `req.body.projectId` with `requireAuthenticatedClient` + `assertWriteRoleAllowed` + `assertSystemNotHalted` | Shared `resolveCanonicalProjectId(req.body.projectId, { secContext: req.authContext, requireAuthorizedContext: true })` | Always `undefined` → Canonical `proj.id` when explicitly supplied & authorized; `401`/`403` when unauthorized; `404` when invalid/unknown; `undefined` when omitted |
| **Tool / AI (Gemini Live)** | [ToolOrchestrator.ts](file:///d:/SORA%20AI/Sora%20AI/backend/tools/ToolOrchestrator.ts#L1954-L2078) (`_handlePlannerTool` → `planTask`) | None → Server-side per-session explicit project binding (`_explicitSessionProjects.get(secContext.sessionId)`), populated strictly via authorized `switch` or `setSessionProjectContext()` | Shared `resolveCanonicalProjectId(boundProjectId, { secContext: trustedSecContext, requireAuthorizedContext: true })`; ignores model-supplied `args.projectId` / `args.projectName` | Always `undefined` → Canonical `proj.id` when session has explicit verified project binding; `undefined` when unbound/ambiguous; RBAC blocks `guest`/`read_only`/missing context |
| **Mobile Workflow** | [MobileWorkflowManager.ts](file:///d:/SORA%20AI/Sora%20AI/backend/workflow/MobileWorkflowManager.ts#L75-L228) & [HttpGateway.ts](file:///d:/SORA%20AI/Sora%20AI/backend/gateway/HttpGateway.ts#L2571-L2630) (`POST /api/remote/workflow/execute`) | None → Optional `options.projectId` (from `req.body.projectId` on `/api/remote/workflow/execute` guarded by `requireLocalhostOrPairedDevice`) | Shared `resolveCanonicalProjectId(options.projectId, { secContext, requireAuthorizedContext: true })` | Always `undefined` → Canonical `proj.id` when explicitly supplied & authorized; `403`/`SECURITY_VIOLATION` when unauthorized; `400`/`INVALID_QUERY` when unknown/invalid; `undefined` when omitted |
| **Other existing callers** | None outside authorized 5 files (`PlannerCoordinator.ts` is the sole caller of `taskPlanner.buildPlan()`) | N/A | N/A | Verified zero hidden 4th production plan-creation path |

---

## 3. Root-Cause Analysis

1. **Missing propagation contract:** Although frozen [PlannerTypes.ts](file:///d:/SORA%20AI/Sora%20AI/backend/planner/PlannerTypes.ts#L323-L328) already defined `TaskPlan.projectId?: string`, frozen [PlanStore.ts](file:///d:/SORA%20AI/Sora%20AI/backend/planner/PlanStore.ts#L82-L114) already persisted full `TaskPlan` objects and filtered strictly by exact `projectId`, and frozen [ProjectContinuityResolver.ts](file:///d:/SORA%20AI/Sora%20AI/backend/projects/ProjectContinuityResolver.ts#L262-L274) already read `listPlansByProject(project.id)`, neither `PlannerCoordinator.createPlan()` nor `TaskPlanner.buildPlan()` accepted or stamped `projectId`.
2. **Unwired entry points:** None of the three production entry points (`HttpGateway`, `ToolOrchestrator`, `MobileWorkflowManager`) validated or forwarded explicit project identity into `PlannerCoordinator.createPlan()`.
3. **Active-project ordering hazard avoided:** Inspection of frozen [ProjectStore.ts](file:///d:/SORA%20AI/Sora%20AI/backend/projects/ProjectStore.ts#L249-L269) confirmed two critical hazards that P2 explicitly defends against:
   - `ProjectStore.getActiveProject()` falls back to `data.projects[0]` when `activeProjectId === null` — therefore no creation path ever falls back to `getActiveProject()` or global `activeProjectId`.
   - `ProjectStore.getProject(idOrPath)` matches both `p.id` and `path.resolve(p.rootPath)` — therefore `resolveCanonicalProjectId()` requires strict exact canonical ID equality (`proj.id === trimmed`) so filesystem paths like `"."` or `rootPath` strings cannot spoof a project ID.

---

## 4. Exact Authorized Files and Line Ranges Changed

| # | File (Authorized Scope) | Line Ranges Changed | Summary of Changes |
|---|---|---|---|
| 1 | [backend/planner/PlannerCoordinator.ts](file:///d:/SORA%20AI/Sora%20AI/backend/planner/PlannerCoordinator.ts#L45-L132), [L202-L240](file:///d:/SORA%20AI/Sora%20AI/backend/planner/PlannerCoordinator.ts#L202-L240) | `L45-L132`, `L202-L240` | Added shared `resolveCanonicalProjectId()` helper; updated `createPlan()` to accept optional `projectId`, validate canonically before build, pass canonical `projectId` to `taskPlanner.buildPlan()`, stamp/clear cleanly, persist via `planStore.savePlan()`, and include `projectId` in `plan_created` event metadata. |
| 2 | [backend/planner/TaskPlanner.ts](file:///d:/SORA%20AI/Sora%20AI/backend/planner/TaskPlanner.ts#L61-L80), [L239-L259](file:///d:/SORA%20AI/Sora%20AI/backend/planner/TaskPlanner.ts#L239-L259), [L306-L312](file:///d:/SORA%20AI/Sora%20AI/backend/planner/TaskPlanner.ts#L306-L312), [L598-L618](file:///d:/SORA%20AI/Sora%20AI/backend/planner/TaskPlanner.ts#L598-L618) | `L61-L80`, `L239-L259`, `L306-L312`, `L598-L618` | Extended `buildPlan()` and `_buildWorkflowPlan()` options with optional `projectId?: string` and propagated validated non-empty `projectId` into both standard and mobile workflow `TaskPlan` objects (omitted when absent). |
| 3 | [backend/gateway/HttpGateway.ts](file:///d:/SORA%20AI/Sora%20AI/backend/gateway/HttpGateway.ts#L915-L964), [L2582-L2629](file:///d:/SORA%20AI/Sora%20AI/backend/gateway/HttpGateway.ts#L2582-L2629) | `L915-L964`, `L2582-L2629` | Secured `POST /api/planner/plan` with existing `requireAuthenticatedClient`, `assertWriteRoleAllowed`, `assertSystemNotHalted`, and `resolveCanonicalProjectId()`; updated `POST /api/remote/workflow/execute` to pass optional `req.body.projectId` via 3rd argument and map `PERMISSION_DENIED` → `403` / `INVALID_QUERY` → `400`. |
| 4 | [backend/tools/ToolOrchestrator.ts](file:///d:/SORA%20AI/Sora%20AI/backend/tools/ToolOrchestrator.ts#L30), [L228-L278](file:///d:/SORA%20AI/Sora%20AI/backend/tools/ToolOrchestrator.ts#L228-L278), [L731-L738](file:///d:/SORA%20AI/Sora%20AI/backend/tools/ToolOrchestrator.ts#L731-L738), [L1318-L1324](file:///d:/SORA%20AI/Sora%20AI/backend/tools/ToolOrchestrator.ts#L1318-L1324), [L1546-L1552](file:///d:/SORA%20AI/Sora%20AI/backend/tools/ToolOrchestrator.ts#L1546-L1552), [L1954-L2078](file:///d:/SORA%20AI/Sora%20AI/backend/tools/ToolOrchestrator.ts#L1954-L2078) | `L30`, `L228-L278`, `L731-L738`, `L1318-L1324`, `L1546-L1552`, `L1954-L2078` | Added server-side per-session explicit project binding map (`_explicitSessionProjects`) + `setSessionProjectContext`/`clearSessionProjectContext`/`getSessionProjectContext`; bound canonical ID on authorized `switch` (`trackProjectTask` & `getProjectContinuity`); passed `trustedSecContext` into `_handlePlannerTool`; enforced RBAC, ignored model-supplied `projectId`/`projectName`, validated session binding via `resolveCanonicalProjectId()`, and kept unbound/ambiguous sessions unscoped. |
| 5 | [backend/workflow/MobileWorkflowManager.ts](file:///d:/SORA%20AI/Sora%20AI/backend/workflow/MobileWorkflowManager.ts#L29), [L75-L79](file:///d:/SORA%20AI/Sora%20AI/backend/workflow/MobileWorkflowManager.ts#L75-L79), [L159-L227](file:///d:/SORA%20AI/Sora%20AI/backend/workflow/MobileWorkflowManager.ts#L159-L227) | `L29`, `L75-L79`, `L159-L227` | Added optional 3rd parameter `options?: { projectId?: unknown }` to `executeVoiceWorkflow()` (leaving frozen `MobileWorkflowTypes.ts` untouched); validated explicit `projectId` via `resolveCanonicalProjectId()` with caller `secContext`, audited & blocked unauthorized/invalid requests, and forwarded canonical `projectId` to `plannerCoordinator.createPlan()`. |
| 6 | [tests/unit/planner.test.ts](file:///d:/SORA%20AI/Sora%20AI/tests/unit/planner.test.ts#L20-L50), [L974-L1771](file:///d:/SORA%20AI/Sora%20AI/tests/unit/planner.test.ts#L974-L1771) | `L20-L50`, `L974-L1771` | Added 22 permanent P2 regression tests (`P2-01` through `P2-22`) exercising real disk persistence, HTTP routes, ToolOrchestrator dispatch, Mobile workflows, and ProjectContinuityResolver end-to-end isolation. |

---

## 5. Before / After Plan Identity Propagation Architecture

### Before (Stage 10.3 R2)
```text
HTTP /api/planner/plan ─────────┐
Tool planTask(goal) ────────────┼─► PlannerCoordinator.createPlan(goal) ─► TaskPlanner.buildPlan(goal)
Mobile executeVoiceWorkflow() ──┘      (no projectId)                         (projectId = undefined)
                                                                                     │
                                                                                     ▼
                                                                             PlanStore.savePlan()
                                                                         (persisted without projectId)
                                                                                     │
                                                                                     ▼
                                                                    ProjectContinuityResolver.resolveProjectContext()
                                                                 (fail-closed excluded → plan invisible to project)
```

### After (Stage 10.3 P2)
```text
HTTP POST /api/planner/plan (requireAuthenticatedClient + assertWriteRoleAllowed + req.body.projectId) ──┐
Tool planTask(goal) (trustedSecContext + server-side _explicitSessionProjects[sessionId]) ───────────────┼─► resolveCanonicalProjectId()
Mobile executeVoiceWorkflow / /api/remote/workflow/execute (secContext + options.projectId) ─────────────┘     ├─ omitted ──► undefined (no active-project guess)
                                                                                                               ├─ unauthorized ──► DENY (403 / BLOCK)
                                                                                                               ├─ invalid/unknown ──► DENY / unscoped (no fallback)
                                                                                                               └─ resolved (exact proj.id)
                                                                                                                        │
                                                                                                                        ▼
                                                                                                        PlannerCoordinator.createPlan(goal, { projectId })
                                                                                                                        │ (re-validates canonical ID)
                                                                                                                        ▼
                                                                                                        TaskPlanner.buildPlan(goal, { projectId })
                                                                                                                        │ (stamps TaskPlan.projectId)
                                                                                                                        ▼
                                                                                                              PlanStore.savePlan(plan)
                                                                                                        (persisted in agent_plans.json verbatim)
                                                                                                                        │
                                                                                                                        ▼
                                                                                                    PlanStore.listPlansByProject(project.id)
                                                                                                                        │ (strict exact-ID filter intact)
                                                                                                                        ▼
                                                                                                ProjectContinuityResolver.resolveProjectContext()
                                                                                                (Project A sees A only; Project B sees B only; unscoped excluded)
```

---

## 6. Canonical Project Identity Validation (HTTP, Tool, Mobile)

All three paths delegate to the single shared resolver [resolveCanonicalProjectId()](file:///d:/SORA%20AI/Sora%20AI/backend/planner/PlannerCoordinator.ts#L74-L132) inside `PlannerCoordinator.ts`:

- **Shared validation rules:**
  1. `undefined` / `null` → `{ status: "omitted" }` (never consults `activeProjectId` or `projects[0]`).
  2. Authorization check when `secContext` or `requireAuthorizedContext` is passed: requires non-empty `identityId` and role in `{"admin", "standard"}`; denies `guest`, `read_only`, and unauthenticated callers (`{ status: "unauthorized" }`).
  3. Rejects non-string, blank, control-char (`\r`, `\n`, `\0`), >200-char, or `ContentSanitizer`-flagged prompt-injection inputs (`{ status: "invalid" }`).
  4. Looks up `projectStore.getProject(trimmed)` and enforces strict exact canonical equality `proj.id === trimmed` (blocks relative paths like `"."` and `rootPath` spoofing; fails closed on store error).
- **HTTP (`POST /api/planner/plan`):** Enforces `requireAuthenticatedClient` (`401`), `assertWriteRoleAllowed` (`403`), `assertSystemNotHalted` (`503`/`423`), and `resolveCanonicalProjectId()` (`403` unauthorized, `404` invalid/unknown, `201` with `projectId` stamped or `undefined` when omitted).
- **Tool/AI (`ToolOrchestrator._handlePlannerTool`):** Enforces trusted `secContext` (`MISSING_SECURITY_CONTEXT`) and write role (`PERMISSION_DENIED` for `guest`/`read_only`); logs `SUSPICIOUS_TOOL_CALL` and completely ignores any model-supplied `args.projectId` / `args.projectName` / `args.project`; resolves ONLY from server-side `_explicitSessionProjects.get(secContext.sessionId)` validated via `resolveCanonicalProjectId()`; clears stale binding if the project was deleted; never falls back to `projectStore.getActiveProject()`.
- **Mobile (`MobileWorkflowManager.executeVoiceWorkflow` + `POST /api/remote/workflow/execute`):** Preserves `requireLocalhostOrPairedDevice`, DLP, Emergency Stop, Lockdown, and Device Revocation; validates optional `options.projectId` via `resolveCanonicalProjectId(options.projectId, { secContext, requireAuthorizedContext: true })`; audits & blocks unauthorized (`403` / `SECURITY_VIOLATION`) and unknown/invalid (`400` / `INVALID_QUERY`) selections; leaves omitted selection unscoped.

---

## 7. PlannerCoordinator and TaskPlanner Propagation Evidence

- [PlannerCoordinator.createPlan()](file:///d:/SORA%20AI/Sora%20AI/backend/planner/PlannerCoordinator.ts#L202-L240) validates `options?.projectId` via `resolveCanonicalProjectId()` **before** invoking `taskPlanner.buildPlan()`, forwards only the verified canonical ID, confirms `plan.projectId` matches (or deletes it when unscoped), persists via frozen `planStore.savePlan(plan)`, and emits `projectId` in the `plan_created` event payload.
- [TaskPlanner.buildPlan()](file:///d:/SORA%20AI/Sora%20AI/backend/planner/TaskPlanner.ts#L69-L80) propagates `options.projectId` (when non-empty string) onto the returned `TaskPlan` in both standard 8-phase plans ([L239-L246](file:///d:/SORA%20AI/Sora%20AI/backend/planner/TaskPlanner.ts#L239-L246)) and mobile workflow plans ([L598-L605](file:///d:/SORA%20AI/Sora%20AI/backend/planner/TaskPlanner.ts#L598-L605)). Neither branch inspects `goal.objective` or `ProjectStore` to guess ownership.
- Verified by `P2-01` through `P2-04` (both in-memory return object, reloaded `new PlanStore().getPlan(plan.id)`, and raw JSON read from `agent_plans.json`).

---

## 8. Project A / B Isolation Evidence

Verified end-to-end across synthetic isolated projects `proj-p2-alpha` (`P2 Alpha Synthetic`) and `proj-p2-beta` (`P2 Beta Synthetic`) with real disk persistence and `ProjectContinuityResolver`:

- **Project A → Project A only:** `P2-18` and `P2-22` confirm Project A plans persist `projectId: "proj-p2-alpha"` and populate `resolveProjectContext("P2 Alpha Synthetic")` (`ctx.project.id`, `ctx.goal.objective`, `ctx.planSummary.recentGoals`, `ctx.planSummary.activePlans`).
- **Project A never leaks into Project B:** `P2-19` and `P2-22` confirm `PlanStore.listPlansByProject("proj-p2-beta")` and `resolveProjectContext("P2 Beta Synthetic")` never expose Project A plans (`ctxB.goal === undefined`, `ctxB.planSummary === undefined` before Project B has its own plan).
- **Project B → Project B only:** `P2-20` and `P2-22` confirm Project B plans appear exclusively in Project B continuity context and never leak into Project A even after switching `activeProjectId` back to Project A.
- Frozen [PlanStore.listPlansByProject()](file:///d:/SORA%20AI/Sora%20AI/backend/planner/PlanStore.ts#L106-L114) strict exact-ID filtering remains completely untouched.

---

## 9. Legacy Unscoped-Plan Behavior

- Plans created without an explicit project association (or legacy plans already stored without `projectId`) persist with `projectId` absent (`undefined`).
- `P2-03`, `P2-10`, `P2-14`, `P2-17`, `P2-21`, and `P2-22` verify that unscoped plans remain unscoped even when `ProjectStore.activeProjectId` is set to Project A, and remain strictly excluded from both Project A and Project B continuity contexts and `listPlansByProject()`.
- Zero automatic migration or silent reassignment was introduced.

---

## 10. Update / Resume Ownership Preservation

- Audited [PlannerCoordinator.ts](file:///d:/SORA%20AI/Sora%20AI/backend/planner/PlannerCoordinator.ts#L290-L470) (`executePlan`, `pausePlan`, `resumePlan`, `cancelPlan`, `confirmCheckpoint`) and frozen [PlanStore.ts](file:///d:/SORA%20AI/Sora%20AI/backend/planner/PlanStore.ts#L123-L131) (`updatePlan`): none of these operations alter or drop `plan.projectId`.
- Verified with real disk reload assertions in `P2-05` (`updatePlan` + `cancelPlan` after switching global active project to Project B preserves `proj-p2-alpha`), `P2-06` (`pausePlan` → switch active project to Project B → `resumePlan` preserves `proj-p2-alpha`), `P2-16` (mobile workflow full execution to `completed` preserves `proj-p2-beta`), and `P2-22` (full Batch E pause/resume lifecycle for both Project A and Project B preserves each plan's original `projectId` on disk).

---

## 11. Permanent Test Names and Persisted-State Assertions

All 22 required permanent regression tests added in [tests/unit/planner.test.ts](file:///d:/SORA%20AI/Sora%20AI/tests/unit/planner.test.ts#L974-L1771) verify persisted `agent_plans.json` state via fresh `new PlanStore().getPlan(...)` / `listPlansByProject(...)` and direct disk JSON reads (`readPersistedPlanFromDisk`), using isolated synthetic projects and temp directories cleaned up in `afterEach`:

| # | Test Name | Persisted-State Assertion Verified |
|---|---|---|
| 1 | `P2-01: createPlan() with valid Project A ID stamps Project A in TaskPlanner and persisted PlanStore` | `TaskPlanner.buildPlan`, `reloaded.projectId === projA.id`, and raw disk JSON `onDisk.projectId === projA.id` |
| 2 | `P2-02: createPlan() with valid Project B ID stamps Project B in persisted PlanStore` | `reloaded.projectId === projB.id` and raw disk JSON `onDisk.projectId === projB.id` |
| 3 | `P2-03: createPlan() with missing project identity remains undefined even when Project A is globally active` | `reloaded.projectId === undefined` and `onDisk.projectId === undefined` while `activeProjectId === projA.id` |
| 4 | `P2-04: createPlan() with unknown, path-like, or injection project ID never attaches to another project` | Unknown ID, `projA.rootPath`, and `"."` all persist `projectId === undefined`; injection rejected by `resolveCanonicalProjectId` |
| 5 | `P2-05: updating an existing plan preserves its original projectId on disk` | `updatePlan` + `cancelPlan` after global switch to Project B preserves `onDisk.projectId === projA.id` |
| 6 | `P2-06: pausing and resuming a plan preserves its original projectId across active-project switch` | `pausePlan` → switch to Project B → `resumePlan` preserves `onDisk.projectId === projA.id` |
| 7 | `P2-07: HTTP POST /api/planner/plan with authenticated Project A selection stamps Project A on disk` | Real Express HTTP `201` + `reloaded.projectId === projA.id` + `onDisk.projectId === projA.id` |
| 8 | `P2-08: HTTP POST /api/planner/plan with authenticated Project B selection stamps Project B on disk` | Real Express HTTP `201` + `reloaded.projectId === projB.id` |
| 9 | `P2-09: HTTP POST /api/planner/plan denies unauthenticated, read_only/guest, and unknown project association` | `401`, `403`, `403`, `404` + persisted plan count unchanged (`afterCount === beforeCount`) |
| 10 | `P2-10: HTTP POST /api/planner/plan with missing projectId does not infer global active project` | Real HTTP `201` while Project A active + `reloaded.projectId === undefined` |
| 11 | `P2-11: ToolOrchestrator planTask with explicit Project A session context stamps Project A on disk` | Real `trackProjectTask(switch)` → `planTask` dispatch + `reloaded.projectId === projA.id` |
| 12 | `P2-12: ToolOrchestrator planTask with explicit Project B session context stamps Project B on disk` | Real `trackProjectTask(switch)` → `planTask` dispatch + `reloaded.projectId === projB.id` |
| 13 | `P2-13: ToolOrchestrator ignores model-supplied spoofed projectId and blocks unauthorized roles` | Spoofed `args.projectId = projB.id` ignored (`reloaded.projectId === projA.id`); `read_only` role blocked with no plan created |
| 14 | `P2-14: ToolOrchestrator planTask with missing or ambiguous project selection does not infer active project` | Fresh session AND post-ambiguous-switch session both persist `reloaded.projectId === undefined` while Project A active |
| 15 | `P2-15: Mobile workflow with valid Project A selection stamps Project A on disk (direct & HTTP)` | Direct `executeVoiceWorkflow` AND real HTTP `POST /api/remote/workflow/execute` both persist `projectId === projA.id` |
| 16 | `P2-16: Mobile workflow with valid Project B selection stamps Project B on disk and preserves it after execution` | Full `autoExecute: true` completion persists `reloaded.projectId === projB.id` and `onDisk.projectId === projB.id` |
| 17 | `P2-17: Mobile workflow denies untrusted/unknown project selection and leaves missing selection unscoped` | `read_only` denied (`SECURITY_VIOLATION`), unknown HTTP `400` with zero plans persisted, omitted persists `projectId === undefined` |
| 18 | `P2-18: Project A plans appear in Project A continuity context after reload` | `ProjectContinuityResolver.resolveProjectContext(projA.name)` surfaces Project A `goal.objective` and `planSummary.recentGoals` |
| 19 | `P2-19: Project A plans never appear in Project B continuity context` | `listPlansByProject(projB.id)` and `resolveProjectContext(projB.name)` strictly exclude Project A plan |
| 20 | `P2-20: Project B plans appear in Project B continuity context and never leak into Project A` | Project B plan visible in Project B context and absent from Project A context |
| 21 | `P2-21: Legacy unscoped plans remain strictly excluded from both Project A and Project B contexts` | Unscoped plan absent from both `listPlansByProject` calls and both continuity contexts |
| 22 | `P2-22: Full Batch E lifecycle — switching projects, updating, and resuming never leaks or reassigns plans` | All 16 Batch E steps verified against reloaded stores and raw disk JSON |

---

## 12. Exact Regression Commands, Counts, Skipped Tests & Exit Codes

All commands executed locally from `d:\SORA AI\Sora AI` (zero production or live Gemini Cloud contact):

| # | Exact Command | Exit Code | Passed | Failed | Skipped | Classification |
|---|---|---|---|---|---|---|
| 1 | `npx vitest run --fileParallelism=false tests/unit/planner.test.ts` | `0` | **93** *(71 existing + 22 new P2)* | `0` | `0` | `PASS — AUTOMATED TEST` |
| 2 | `npx vitest run --fileParallelism=false tests/unit/projects.test.ts` | `0` | **21** | `0` | `0` | `PASS — AUTOMATED TEST` |
| 3 | `npx vitest run --fileParallelism=false tests/unit/phase10_project_continuity.test.ts tests/unit/phase10_audio_continuity.test.ts` | `0` | **117** *(90 + 27)* | `0` | `0` | `PASS — AUTOMATED TEST` |
| 4 | `npx vitest run --fileParallelism=false tests/unit/companion_core_phase1.test.ts tests/unit/stage10_1_10_2_security_remediation.test.ts tests/unit/gemini_live_auth_regression.test.ts` | `0` | **72** *(42 + 19 + 11)* | `0` | `0` | `PASS — AUTOMATED TEST` |
| 5 | `npx vitest run --fileParallelism=false tests/integration/mobile_workflow.test.ts` | `0` | **30** | `0` | `0` | `PASS — AUTOMATED TEST` |
| 6 | `npx vitest run --fileParallelism=false tests/integration/code_modification_permission_verification.test.ts` | `0` | **15** | `0` | `0` | `PASS — AUTOMATED TEST` |
| 7 | `npx vitest run --fileParallelism=false tests/e2e/cross_platform_e2e_phase29.test.ts -t "strictly preserves"` | `0` | **1** | `0` | **41** *(filtered by `-t`)* | `PASS — AUTOMATED TEST` *(Test 1.1 only; 41 filtered-skipped not claimed passed)* |
| 8 | `npx tsc --noEmit` | `0` | N/A | `0` | `0` | `PASS — TYPECHECK` |
| 9 | `npx tsx -e "import { LIVE_TOOLS } from './backend/ai/GeminiSessionFactory.ts'; ..."` | `0` | N/A | `0` | `0` | `PASS — REAL RUNTIME PROBE` |
| 10 | `npx tsx -e "import { ProjectStore, projectStore } from './backend/projects/ProjectStore.ts'; console.log(JSON.stringify({ directEsmImportOk: projectStore instanceof ProjectStore })); process.exit(0);"` | `0` | N/A | `0` | `0` | `PASS — REAL RUNTIME PROBE` |

### Reconciled Aggregate Count (Zero Double-Counting)
- **Unique automated tests executed across Commands #1–#7:** `93 + 21 + 117 + 72 + 30 + 15 + 1` = **349 passed, 0 failed, 41 filtered-skipped**.
- The 41 skipped tests in `tests/e2e/cross_platform_e2e_phase29.test.ts` were skipped solely due to `-t "strictly preserves"` filtering and are **not** claimed as passed.

---

## 13. `LIVE_TOOLS` 129 / 129 Verification

Programmatic runtime probe output (Command #9, exit code `0`):
```json
{
  "total": 129,
  "unique": 129,
  "duplicates": 0,
  "trackProjectTaskActions": 9,
  "trackProjectTaskHasConfirmationToken": false,
  "planTaskParams": ["goal"]
}
```
- Exactly **129 declarations / 129 unique tool names / 0 duplicates**.
- `trackProjectTask` retains all **9 actions** and **no `confirmationToken` parameter**.
- `planTask` retains strictly `["goal"]` — zero model-facing project-ownership fields added.

---

## 14. P0 / P1 Regression Evidence

- **P0 Security (`GAP-10.3-04`, `AUD-P0-01`..`AUD-P0-04`):** `tests/unit/phase10_project_continuity.test.ts` (**90 / 90 passed**) confirms no credential logging, no model-visible confirmation tokens, single-mint authenticated UI confirmation, fail-closed missing security context, local `/live` & remote `/remote-live` identity propagation, RBAC enforcement, Emergency Stop, and Security Lockdown remain intact.
- **P1 Persistence Integrity (`GAP-10.3-08`, `AUD-P1-01`):** `tests/unit/projects.test.ts` (**21 / 21 passed**) + standalone ESM import probe (`{"directEsmImportOk":true}`) confirm shared per-file transaction queue, serialized cold-load hydration, copy-on-write post-rename cache publication, failed-write cache/disk consistency, queue recovery, and defensive cloning remain intact.
- **Stage 10.1 / 10.2 & Stage 10.4.2:** `companion_core_phase1.test.ts` (`42/42`), `stage10_1_10_2_security_remediation.test.ts` (`19/19`), `gemini_live_auth_regression.test.ts` (`11/11`), and `phase10_audio_continuity.test.ts` (`27/27`) all pass with zero regressions.

---

## 15. Frozen-Boundary Verification

File metadata check confirmed **zero modifications** to all frozen/protected files and directories during P2 implementation:

| Frozen / Protected Boundary | Size & Last Modified Timestamp | Status |
|---|---|---|
| [backend/planner/PlanStore.ts](file:///d:/SORA%20AI/Sora%20AI/backend/planner/PlanStore.ts) | `5,570` bytes · `2026-11-18 20:45:51` | Untouched |
| [backend/planner/PlannerTypes.ts](file:///d:/SORA%20AI/Sora%20AI/backend/planner/PlannerTypes.ts) | `11,610` bytes · `2026-11-18 20:45:51` | Untouched |
| [backend/projects/ProjectStore.ts](file:///d:/SORA%20AI/Sora%20AI/backend/projects/ProjectStore.ts) | `13,140` bytes · `2026-11-18 22:30:51` | Untouched |
| [backend/projects/ProjectManager.ts](file:///d:/SORA%20AI/Sora%20AI/backend/projects/ProjectManager.ts) | `15,588` bytes · `2026-11-18 20:47:35` | Untouched |
| [backend/projects/ProjectDecisionStore.ts](file:///d:/SORA%20AI/Sora%20AI/backend/projects/ProjectDecisionStore.ts) | `10,857` bytes · `2026-11-18 20:49:17` | Untouched |
| [backend/projects/ProjectContinuityResolver.ts](file:///d:/SORA%20AI/Sora%20AI/backend/projects/ProjectContinuityResolver.ts) | `30,603` bytes · `2026-11-18 20:49:16` | Untouched |
| [backend/ai/GeminiSessionFactory.ts](file:///d:/SORA%20AI/Sora%20AI/backend/ai/GeminiSessionFactory.ts) | `113,969` bytes · `2026-11-18 21:48:26` | Untouched |
| [backend/conversation/ConversationManager.ts](file:///d:/SORA%20AI/Sora%20AI/backend/conversation/ConversationManager.ts) | `53,961` bytes · `2026-11-18 20:46:30` | Untouched |
| [backend/server.ts](file:///d:/SORA%20AI/Sora%20AI/backend/server.ts) | `47,077` bytes · `2026-11-18 19:30:25` | Untouched |
| [backend/device/RemoteBridge.ts](file:///d:/SORA%20AI/Sora%20AI/backend/device/RemoteBridge.ts) | `60,130` bytes · `2026-09-26 23:46:12` | Untouched |
| [backend/workflow/MobileWorkflowTypes.ts](file:///d:/SORA%20AI/Sora%20AI/backend/workflow/MobileWorkflowTypes.ts) | `3,201` bytes · `2026-09-23 16:49:57` | Untouched |
| `backend/security/*`, `android/`, `electron/`, `desktop_agent/`, `package.json`, `tsconfig.json` | Zero edits | Untouched |

---

## 16. Remaining Limitations and Blocked Checks

1. **Single-tenant project model:** MYRAA's `ProjectContext` schema ([ProjectTypes.ts](file:///d:/SORA%20AI/Sora%20AI/backend/projects/ProjectTypes.ts#L78-L92)) does not currently store per-project `ownerId` / ACL lists; authorization therefore enforces MYRAA's existing role-based model (`admin`/`standard` write roles permitted; `unauthenticated`/`guest`/`read_only` denied). If multi-user per-project ACLs are introduced in a future stage, `resolveCanonicalProjectId()` is the single centralized hook where per-project ownership checks should be enforced.
2. **Session-scoped tool binding lifetime:** `ToolOrchestrator._explicitSessionProjects` is in-memory per `ToolOrchestrator` instance and keyed by authenticated `sessionId`. A fresh WebSocket session starts unbound (fail-closed unscoped) until the user explicitly switches/selects a project in that session; this intentionally prevents accidental cross-project attachment to stale global `activeProjectId`.
3. **Live Gemini Cloud & Chromium UI E2E (`BLOCKED` / `NOT VERIFIED`):** Live Gemini Cloud staging rotation and real Chromium/Playwright frontend DOM testing remain outside this local offline implementation scope; production (`myraa-ai-q0h3.onrender.com`) was not contacted.
4. **41 filtered-skipped tests in Phase 29 E2E:** Only Test 1.1 (`strictly preserves`) was executed in `cross_platform_e2e_phase29.test.ts` per Section 9.

---

## 17. Explicit Scope-Compliance Confirmation

- **Authorized source files modified (exact 5):**
  1. [backend/planner/PlannerCoordinator.ts](file:///d:/SORA%20AI/Sora%20AI/backend/planner/PlannerCoordinator.ts)
  2. [backend/planner/TaskPlanner.ts](file:///d:/SORA%20AI/Sora%20AI/backend/planner/TaskPlanner.ts)
  3. [backend/gateway/HttpGateway.ts](file:///d:/SORA%20AI/Sora%20AI/backend/gateway/HttpGateway.ts) *(prompt referred to `backend/http/HttpGateway.ts`; verified canonical path in repo)*
  4. [backend/tools/ToolOrchestrator.ts](file:///d:/SORA%20AI/Sora%20AI/backend/tools/ToolOrchestrator.ts)
  5. [backend/workflow/MobileWorkflowManager.ts](file:///d:/SORA%20AI/Sora%20AI/backend/workflow/MobileWorkflowManager.ts) *(prompt referred to `backend/workflows/MobileWorkflowManager.ts`; verified canonical path in repo)*
- **Authorized test files modified (exact 1):**
  1. [tests/unit/planner.test.ts](file:///d:/SORA%20AI/Sora%20AI/tests/unit/planner.test.ts)
- **Deliverable created:** [stage10_phase10_3_P2_project_plan_continuity_remediation_report.md](file:///d:/SORA%20AI/Sora%20AI/stage10_phase10_3_P2_project_plan_continuity_remediation_report.md)
- **Zero Git operations executed.**
- **Zero dependency or configuration files modified.**
- **Zero production or live Gemini Cloud requests issued.**
- **All unrelated working-tree changes preserved.**

---

**FINAL IMPLEMENTATION STATUS: `PASS`** *(Awaiting separate independent read-only acceptance audit to close Stage 10.3 P2.)*
