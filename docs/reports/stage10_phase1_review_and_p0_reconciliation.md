# MYRAA — Stage 10 Phase 1 Review & P0 Evidence Reconciliation

**Document ID:** `stage10_phase1_review_and_p0_reconciliation.md`  
**Generated:** 2026-10-30T23:02:42+05:30  
**Mode:** Read-only review. No production code, tests, configuration, databases, or existing reports were modified.  
**Status:** AWAITING EXPLICIT OPERATOR APPROVAL before any Stage 10 implementation begins.

---

## Part 1 — P0 Evidence Reconciliation

### 1.1 NF-01, NF-04, NF-05 Status Audit

The `myraa_p0_final_closure_report.md` correctly marks all three as **REQUIRES MANUAL EXECUTION**. However, the evidence citations require clarification to avoid any accidental promotion to PASS.

#### NF-01 — Browser Navigation & DOM Extraction

| Evidence Available | What It Proves | What It Does NOT Prove |
|:---|:---|:---|
| AC14 test 14.10 — real Chromium navigation to `https://example.com` returns HTTP 200 with title verified | Chromium can navigate through DNS-pinning proxy to a public site | That MYRAA's full chat-driven DOM extraction pipeline (tool call → Python agent → content extraction → natural-language response) works end-to-end |
| Stage 1–9 regression (stage1 `BrowserIntelligenceCoordinator`) — PASS | Browser research coordination pipeline is functional in the test harness | Live voice/chat → tool orchestration → desktop agent → DOM text → response assembly in a running instance |

**Reconciled Status: PENDING MANUAL EXECUTION — NOT PASS**  
The available automated evidence covers the *transport layer* (proxy + Chromium navigation) and *unit-level browser coordination*. It does not substitute for the full MYRAA chat-driven end-to-end flow. No live DOM extraction output has been captured. NF-01 remains open.

> [!CAUTION]
> The closure report's NF-01 evidence section ("AC14 test 14.10 confirms...") may give a misleading impression that this test is *substantially* verified. It is not. The test was never submitted via the live MYRAA chat interface and no DOM extraction response was observed. The status must remain PENDING MANUAL EXECUTION.

#### NF-04 — Document Comparison & Semantic Diffing

| Evidence Available | What It Proves | What It Does NOT Prove |
|:---|:---|:---|
| `stage4_document_comparison.test.ts` — 27/27 PASS | `DocumentComparator`, `EpistemicVerifier`, contradiction detection logic is correct in isolation | Live MYRAA chat-to-comparison pipeline with the specific API v1/v2 prompt; presence of breaking-change label in actual response |

**Reconciled Status: PENDING MANUAL EXECUTION — NOT PASS**  
Stage 4 unit/integration tests verify the underlying comparison engine. They do not verify the full path: user submits a freeform comparison prompt → intent is routed correctly → doc comparison tools are invoked → breaking changes are surfaced in the response. NF-04 remains open.

#### NF-05 — Epistemic Labels & Contradiction Detection

| Evidence Available | What It Proves | What It Does NOT Prove |
|:---|:---|:---|
| `AC 3 — Contradiction Detection Accuracy & Epistemic Labeling` — 6 tests PASS | `ContradictionDetector` and `EpistemicVerifier` classify claims correctly in test fixtures | Live MYRAA chat response containing `FACT`/`HYPOTHESIS` badges and an explicit contradiction warning for the 10 MB vs 50 MB payload claim pair |

**Reconciled Status: PENDING MANUAL EXECUTION — NOT PASS**  
The epistemic labeling pipeline is verified at the unit level. It has not been exercised via the live voice/chat interface for the specific conflicting-claims prompt. NF-05 remains open.

---

### 1.2 P0 Unresolved Limitations — Complete Register

| ID | Item | Severity | Full Status |
|:---|:---|:---:|:---|
| **L-01** | **ADV-02 Rapid Task Cancellation** | **MEDIUM** | **NOT VERIFIED.** No automated test exists. No manual execution occurred. Sole item in P0 with zero evidence of any kind. Blocks full unconditional P0 closure. |
| **L-02** | **NF-01 Browser Navigation (manual)** | LOW | **PENDING.** Transport layer verified; end-to-end chat pipeline not executed. |
| **L-03** | **NF-04 Document Comparison (manual)** | LOW | **PENDING.** Engine verified in isolation; live chat path not executed. |
| **L-04** | **NF-05 Epistemic Labels (manual)** | LOW | **PENDING.** Pipeline verified in isolation; live chat path not executed. |
| **L-05** | **SEC-04 Origin test (manual)** | LOW | **PENDING.** 11 automated regression tests pass; live `allowedOrigins` configuration + navigation attempt not executed via running MYRAA. |
| **L-06** | **F1/F2 — E2E live-server tests** | LOW | **RECONCILED (non-regression).** `phase11_live_production_e2e.test.ts` and `phase12_release_packaging_e2e.test.ts` fail because Render.com server is sleeping (HTTP 503). Infrastructure issue, not code regression. Remediation: mark `skip` or environment-gate. |
| **L-07** | **F3 — Stale `toBe(130)` assertion** | LOW | **RECONCILED (non-regression).** `phase4_full_orchestrator.test.ts` contains a stale expected count from before the tool consolidation to 129. Remediation: update `toBe(129)` in one line when authorized. |
| **L-08** | **F4 — Device context isolation** | LOW | **RECONCILED (non-regression).** `phase5_device_aware_intelligence.test.ts` has a test isolation issue — `CURRENT_DEVICE` global state leaks between workers in the 83-file parallel suite. Passes in isolation. Remediation: `beforeEach` registry reset. |
| **L-09** | **F5 — WebSocket timing** | LOW | **RECONCILED (non-regression).** `remote_browser_assistant.test.ts` flaky under 83-worker load. Passes in isolation. Remediation: `vi.waitFor()` or timeout increase. |
| **L-10** | **`javascript:` / `data:` scheme** | LOW | **DOCUMENTED RESIDUAL RISK.** No network path; Playwright + ContentSanitizer isolation accepted. No further action in P0 scope. |
| **L-11** | **Synchronous `socket.getaddrinfo`** | LOW | **DOCUMENTED RESIDUAL RISK.** Latency-only impact on slow DNS. Not a security hole. |

**P0 Final Verdict remains: CONDITIONAL PASS**  
Full unconditional closure requires: (a) ADV-02 manual or automated execution, (b) NF-01, NF-04, NF-05, SEC-04 manual execution, (c) operator acknowledgment of L-06 through L-11.

---

## Part 2 — Stage 10 Architecture Review

### 2.1 Review of Nine Proposed Components

#### Component R1 — `CompanionPersonaStore` (Phase 10.1) ✅ Sound

**Assessment:** Well-justified. `UserPreferenceResolver` exists but stores preferences only in-memory (no disk persistence). `CognitiveMemoryStore` stores learned preferences but at the category/key level, not as a cohesive profile with language, avatar style, and user alias. `CompanionPersona` as a typed, persisted, separate record is not a duplication.

**Risk:** LOW. The proposal correctly narrows this to a new file + minimal extension of `UserPreferenceResolver` and `AdaptivePromptSynthesizer`. No existing storage is mutated.

**Note:** `CompanionPersonaTypes.ts` is sufficient; do not extend `CompanionTypes.ts` (Phase 6 companion types) to avoid coupling the persona concept to the background-task companion infrastructure.

#### Component R2 — `SessionContextManager` (Phase 10.2) ✅ Sound, with caveat

**Assessment:** Justified. `ContextManager` in `backend/projects/` owns the `BASE_INSTRUCTIONS` string and merges memory blocks before Gemini sessions — it is not a conversation ring buffer. No existing component maintains an ordered, bounded, session-scoped ring buffer of user/assistant turn pairs.

**Caution — `userMessage` in storage:** The proposed `SessionContextEntry` stores the raw `userMessage` string. Since `ContextManager.ts` shows `BASE_INSTRUCTIONS` contains highly personalized content (user's name, language, emotional cues), session messages may contain similarly sensitive content. All `SessionContextEntry` writes **must** pass through `ContentSanitizer` before any ring buffer storage, even in-memory.

**Risk:** LOW if in-memory by default (as proposed). MEDIUM if disk persistence is enabled — requires full `OutputDataFirewall` + `ContentSanitizer` chain before write.

#### Component R3 — `GoverningMemoryGate` (Phase 10.2) ✅ Critical, correctly prioritized

**Assessment:** This is the most important component in Stage 10. `MemoryManager` currently provides `add()`, `update()`, and `remove()` methods directly. There is no approval layer between a call to `add()` and a write to `memories.json`. `CheckpointManager` provides per-step approval for destructive plan actions, but it is plan-scoped and cannot be reused as a general memory write gate without significant rework.

**Risk:** MEDIUM-HIGH if skipped or deferred. If any Stage 10 phase (10.1, 10.3, 10.4) writes to `memories.json` before this gate is in place, the invariant "no unauthorized permanent memory writes" is broken.

**Sequencing constraint (critical):** `GoverningMemoryGate` must be **fully implemented and tested before any other Stage 10 component makes a `MemoryManager.add()` call**. The Phase 10.1 `CompanionPersonaStore` must write to its own file (`companion_persona.json`) — NOT to `memories.json` — until Phase 10.2 is complete.

#### Component R4 — `ProjectContinuityStore` (Phase 10.3) ⚠️ Potential duplication — needs scoping

**Assessment:** `ProjectStore` already contains `ProjectTask[]` on each project, plus `lastSession: LastSessionContext` (confirmed by `ProjectTypes.ts` showing `LastSessionContext` with `timestamp` and `summary` fields). `PlanStore` persists full plan records including step status.

**Risk of duplication:** `TaskHistoryEntry` in the proposal is very similar to a `PlanRecord` summary. Before building `ProjectContinuityStore`, the implementor must audit whether `PlanStore.listPlans()` filtered by `projectId` already provides sufficient task history. If it does, `ProjectContinuityStore` reduces to a thin read-aggregation facade over existing stores — not a new storage layer.

**Recommendation:** Audit `PlanStore` schema before Phase 10.3 implementation. If `PlanStore` already holds the needed data, `ProjectContinuityStore` should be a read-only aggregation view, not a new `project_continuity.json` file. This avoids a second source of truth for task history.

#### Component R5 — `AdaptiveContextRetriever` (Phase 10.4) ✅ Sound, high value

**Assessment:** Currently, context injection into Gemini happens via `formatSystemInstructionsWithMemories()` in `server_memory.ts`, which calls `MemoryManager.getRelevantContext()` alone. There is no unified ranker that combines `MemoryManager`, `CognitiveMemoryStore`, and `ProjectManager` output. The `AdaptiveContextRetriever` fills a genuine architectural gap.

**Risk:** MEDIUM. Modifying `AdaptivePromptSynthesizer.ts` directly affects the system instruction injected into every Gemini session. Any regression here impacts all capabilities across Stages 1–9. This phase requires the most careful regression testing.

**Important constraint:** The `contextCharBudget` (proposed: 4000 chars) must be enforced strictly. An unbounded context block is a prompt injection vector — memory entries written by a malicious or compromised source could attempt to hijack Gemini's behavior via the context payload.

#### Component R6 — `CompanionTaskOrchestrator` (Phase 10.5) ⚠️ Scope creep risk

**Assessment:** The proposal adds `TASK_PROGRESS` events to `EventBus`, modifies `PlannerCoordinator` to emit them, and adds a new `CompanionTaskOrchestrator` wrapper. This is the broadest modification set in Stage 10 — it touches `PlannerCoordinator.ts`, which is a core execution path used by all existing Stage 1–9 plan-driven operations.

**Risk:** HIGH. Modifying `PlannerCoordinator.ts` without extensive regression testing could break existing plan execution, step sequencing, checkpoint approval flow, and emergency stop propagation. This is the most regression-sensitive change in the proposal.

**Recommendation:** Strictly scope Phase 10.5 to **adding event emission only** (no behavior changes to step execution logic). `EventBus` event emission should be a fire-and-forget non-blocking call. The `CompanionTaskOrchestrator` wrapper should be a facade that calls `PlannerCoordinator` unchanged — not a replacement or subclass of it.

**ADV-02 opportunity:** Phase 10.5 is the natural place to add an automated rapid-cancellation test (`CANCELLED` state propagation), closing the L-01 gap without requiring a separate live manual test.

#### Component R7 — `ReminderStore` (Phase 10.6) ✅ Sound

**Assessment:** `NotificationManager` and `TaskScheduler` handle transient background notifications and scheduled tasks. There is no persistent, user-approved reminder registry. The distinction between a `NotificationItem` (ephemeral, generated by monitors) and a `Reminder` (persistent, user-approved, recurring) is architecturally clear and correct.

**Risk:** LOW. New file only; existing `NotificationManager` is lightly extended to consume due reminders.

**Security constraint:** The `approvedBy: "user_explicit"` enforcement is the correct pattern (mirrors SEC-07 AI self-approval prevention). However, the gate must be enforced in `GoverningMemoryGate` (Phase 10.2) — reminder creation must go through the same approval infrastructure, not a parallel ad-hoc gate. This ensures one consistent approval record across all write operations.

#### Component R8 — `CompanionExplainabilityService` (Phase 10.7) ✅ Sound, lower priority

**Assessment:** `IntelligenceTraceManager` already exists (`backend/intelligence/IntelligenceTrace.ts`) with `recordTrace()`, `getTrace(traceId)`, and `listTraces(limit)`. The service has built-in secret sanitization via `sanitizeData()`. The trace is already in-memory and bounded at 200 records.

**Key finding:** `CompanionExplainabilityService` is largely a **thin REST adapter** over the already-implemented `IntelligenceTraceManager`. The primary work is:
1. Mounting a `GET /api/companion/explain/:traceId` endpoint
2. Mapping `IntelligenceTraceRecord` to the `ExplainabilityTrace` response shape
3. Applying `OutputDataFirewall` on the response

This is approximately 1–2 hours of work, not 2 days. The proposal overestimates complexity.

**Risk:** VERY LOW. `IntelligenceTraceManager` already sanitizes; REST adapter is read-only.

#### Component R9 — `UncertaintyBeacon` (Phase 10.7) ⚠️ Highest uncertainty — defer

**Assessment:** This component has no precedent in the codebase. It requires MYRAA to assess its own confidence and proactively interrupt the conversation to request clarification. The confidence score in `IntelligenceTraceRecord` could provide a raw signal, but:
1. There is no defined protocol for how `UncertaintyBeacon` injects a clarification request into an active Gemini Live session
2. Proactive interruption of a voice session is UX-sensitive — premature or excessive uncertainty flags would be disruptive
3. The threshold (confidence < 0.4) is arbitrary without empirical validation

**Recommendation:** Defer `UncertaintyBeacon` to a separate Phase 10.7b after Phase 10.7a (ExplainabilityService) is stable. Define the UX contract first (does it interrupt? does it append a clarifying question to the response?), then implement.

**Risk:** MEDIUM if included in Phase 10.7. LOW if deferred.

---

### 2.2 Existing Component Reuse Assessment

| Claimed Reuse | Verified? | Actual Status |
|:---|:---:|:---|
| `MemoryManager` read path reused by `AdaptiveContextRetriever` | ✅ | Confirmed. `MemoryManager.searchMemories()` and `getRelevantContext()` are clean read-only paths |
| `CognitiveLearningCoordinator` reused as-is | ✅ | Confirmed. No modification required — `CognitiveMemoryStore` has its own query interface |
| `CompanionCoordinator` + `EventBus` extended for `TASK_PROGRESS` | ⚠️ | Partially. `EventBus` extension is low-risk; `CompanionCoordinator` already subscribes to events — adding one subscription is safe |
| `CheckpointManager` reused for `GoverningMemoryGate` | ❌ | **Incorrect.** `CheckpointManager` is plan-step-scoped with cryptographic token binding to `(stepId + toolName + serializedArgs)`. It cannot be reused as a general memory-write gate. `GoverningMemoryGate` must be a separate implementation |
| `PlanStore` / `PlannerCoordinator` used for task history | ⚠️ | `PlanStore` likely already stores sufficient task history; `ProjectContinuityStore` may be unnecessary duplication — needs audit |
| `IntelligenceTraceManager` reused by `CompanionExplainabilityService` | ✅ | Fully confirmed. `getTrace()` and `listTraces()` already exist and are sanitized |
| `ProactiveCooldownManager` reused by `ProactiveReminderEngine` | ✅ | Confirmed. Can limit reminder notification frequency |

---

### 2.3 Identified Architectural Risks

| Risk ID | Risk | Phase | Severity | Mitigation |
|:---|:---|:---:|:---:|:---|
| **SR-01** | `GoverningMemoryGate` implemented after other phases begin writing to `memories.json` | 10.1–10.3 | **HIGH** | Gate must be Phase 10.2 and **completed before any other component writes to `memories.json`**. `CompanionPersonaStore` must write to a separate file |
| **SR-02** | `AdaptiveContextRetriever` modifies context injection with an unbounded or poorly-sanitized block | 10.4 | **HIGH** | Hard `contextCharBudget` enforcement + `OutputDataFirewall` on assembled block before injection. Regression test for prompt injection via crafted memory content |
| **SR-03** | `PlannerCoordinator.ts` modification for `TASK_PROGRESS` events introduces regression in plan execution | 10.5 | **HIGH** | Event emission must be fire-and-forget, non-blocking. Stage 1–9 full regression suite must pass before Phase 10.5 merges |
| **SR-04** | `ProjectContinuityStore` creates a second source of truth for task history alongside `PlanStore` | 10.3 | **MEDIUM** | Audit `PlanStore` schema first. If data already exists, use a read-only aggregation view |
| **SR-05** | `SessionContextEntry.userMessage` stored without sanitization | 10.2 | **MEDIUM** | All ring buffer writes must pass `ContentSanitizer` before storage |
| **SR-06** | `UncertaintyBeacon` proactively interrupts voice sessions causing UX disruption | 10.7 | **MEDIUM** | Defer to Phase 10.7b; define UX contract first |
| **SR-07** | Reminder creation bypasses `GoverningMemoryGate` through a parallel ad-hoc approval path | 10.6 | **MEDIUM** | Route reminder creation through `GoverningMemoryGate` — single approval infrastructure for all persistent writes |
| **SR-08** | `CompanionPersonaStore` writes persona as `memory` category entries, creating coupling with memory deduplication | 10.1 | **LOW** | Persona must write to `companion_persona.json` (its own file), not `memories.json`. Zero coupling with `MemoryDeduplicator` |
| **SR-09** | Phase 10.7 `ExplainabilityService` scope overestimated (~2 days); creates schedule buffer waste | 10.7 | **LOW** | Rescope to ~4 hours. Use as buffer for Phase 10.4 or 10.5 regressions |

---

### 2.4 Unnecessary Duplication Findings

| Finding | Detail | Recommendation |
|:---|:---|:---|
| `ProjectContinuityStore` vs `PlanStore` | `PlanStore` persists full plan records with step status, timestamps, and `goalId`. `TaskHistoryEntry` is a summarized view of the same data | Audit `PlanStore` first. If sufficient, `ProjectContinuityStore` = read-only aggregation view, no new `.json` file |
| `GoverningMemoryGate` vs `CheckpointManager` | Proposal says "existing `CheckpointManager` is plan-scoped" but then lists it as a reuse candidate — this is contradictory | Confirm: `GoverningMemoryGate` is a NEW component. Do not attempt to extend `CheckpointManager` |
| `CompanionPersonaTypes.ts` vs extending `CognitiveTypes.ts` | `CognitiveMemory` already has `category: "preference"` with key/value pairs. A `CompanionPersona` record could theoretically be stored there | Keep them separate. `CognitiveLearningCoordinator` applies learning signals to cognitive memories — persona is static user configuration, not a learned signal |
| Two test files (`companion_core.test.ts` + `stage10_companion_core.test.ts`) | Proposal creates both a unit test file and an integration test file — this is correct architecture but the split criteria need to be explicit | Unit tests = pure function testing (types, stores, ranking logic). Integration test = full flow via running server with mocked Gemini |

---

### 2.5 Security-Sensitive Decision Review

| Decision | Security Assessment | Recommendation |
|:---|:---|:---|
| **`MemoryWritePolicy: "auto_approve_high_confidence"` (confidence ≥ 0.85)** | **Concern.** Confidence scores are computed internally by `CognitiveLearningCoordinator`. There is no proof that these scores are resistant to adversarial manipulation via crafted user inputs. A jailbreak prompt designed to look like an explicit user statement could receive confidence 0.9+ | Default MUST be `"always_ask"`. `"auto_approve_high_confidence"` must remain an opt-in requiring explicit operator configuration, as proposed. Never make it the default in any phase. |
| **`contextCharBudget` for context injection** | **Concern.** If `OutputDataFirewall` runs AFTER context assembly and BEFORE injection, it might silently truncate redacted content — leaving an undersized context block. If it runs BEFORE assembly, it doesn't see cross-entry injection attacks | The `OutputDataFirewall` should run on each `ContextSource.content` INDIVIDUALLY before ranking, and then again on the final assembled block |
| **`approvedBy: "user_explicit"` only value for reminders** | **Sound.** Matches SEC-07 AI self-approval prevention pattern. | Enforce this at the type level (TypeScript literal type). Any code path that can set `approvedBy` to any other value should fail TypeScript compilation |
| **Session ring buffer in-memory by default** | **Sound.** Prevents silent disk writes. | Disk persistence opt-in must route through `GoverningMemoryGate` like any other persistent write |
| **REST API `local-only` auth** | **Reasonable.** MYRAA is a desktop app and the server binds to localhost. | Confirm that the Electron IPC / HttpGateway already enforces localhost-only binding before Stage 10 adds new endpoints. If not, add the check in `HttpGateway.ts` |

---

## Part 3 — Recommended Stage 10 Phase 1 Scope

### 3.1 Rationale for Minimum Viable First Phase

Based on the risk analysis above, the safest and most impactful starting point for Stage 10 is **`GoverningMemoryGate` (Phase 10.2) — not `CompanionPersona` (Phase 10.1)** as originally proposed.

**Why lead with the gate, not the persona?**

1. The gate is the **security foundation** for all other phases. If any other phase runs first and writes to `memories.json`, the "no unauthorized permanent memory writes" invariant is already violated before the gate exists.
2. Phase 10.1 (`CompanionPersona`) writes to `companion_persona.json` — a new, separate file with no existing readers. Its risk profile is actually lower than Phase 10.2, meaning it does not need the gate to be safe on its own.
3. However, if Phase 10.1 is presented as "done" and the team begins Phase 10.3 or 10.4 before Phase 10.2 is complete, Stage 10 will be producing ungated persistent writes.

**Recommended Phase 1 execution order:**

```
Step A: CompanionPersonaStore + Types (new files only, no existing modifications)
Step B: GoverningMemoryGate + GoverningMemoryTypes + SessionContextManager
Step C: REST endpoints for approval workflow
Step D: Unit tests + integration smoke test
Step E: Full regression validation (Stage 1–9 suite must stay green)
```

This corresponds to **Phase 10.1 + Phase 10.2 combined as a single gated unit** — they are delivered together, and no downstream phase (10.3–10.7) begins until both pass acceptance criteria.

---

### 3.2 Phase 1 Scope Definition

**Name:** Companion Core — Persona & Governing Memory Gate  
**Tracks:** 10.1 (CompanionPersona) + 10.2 (GoverningMemoryLayer)  
**Duration:** ~5 days  
**No. of new files:** 5  
**No. of modified files:** 3 (narrow, scoped)

#### New Files (Phase 1)

| File | Purpose | Notes |
|:---|:---|:---|
| `backend/companion/CompanionPersonaTypes.ts` | `CompanionPersona` interface; `CommunicationStyle` sub-type | Types only — zero side effects |
| `backend/companion/CompanionPersonaStore.ts` | Load/save `companion_persona.json`; atomic write via pattern from `CompanionStore.ts`; singleton export | Copy atomic write pattern from `CompanionStore.ts` (tmp → rename) |
| `backend/companion/GoverningMemoryTypes.ts` | `MemoryWriteRequest`, `MemoryWritePolicy`, `MemoryWriteApproval` | Types only — zero side effects |
| `backend/companion/GoverningMemoryGate.ts` | In-memory pending-request registry; `requestWrite()` / `approveWrite()` / `rejectWrite()` / `expireStale()` methods; default policy `"always_ask"` | Does NOT write to `memories.json` itself — only calls `MemoryManager.add/update()` on approved requests |
| `backend/companion/SessionContextManager.ts` | In-memory ring buffer (50 turns); `appendTurn()` / `getTurns()` / `clearSession()` — NO disk write by default; all entries sanitized by `ContentSanitizer` | Disk persistence is a Phase 10.2b concern, not Phase 1 |

#### Modified Files (Phase 1)

| File | Change | Scope |
|:---|:---|:---|
| `backend/intelligence/UserPreferenceResolver.ts` | Add optional `loadFromPersonaStore(store: CompanionPersonaStore)` method; on construction, check for `companion_persona.json` and populate `_preferences` map | Additive only — existing default profile path unchanged |
| `backend/companion/CompanionCoordinator.ts` | On `start()`, instantiate `GoverningMemoryGate` singleton and begin `expireStale()` timer (24h purge) | Add ~5 lines; existing start/stop lifecycle unchanged |
| `backend/server.ts` | Mount `GET/PUT /api/companion/persona`, `GET /api/companion/memory/requests`, `POST .../approve`, `POST .../reject` endpoints | Additive REST routes only; no existing routes changed |

#### Files Explicitly NOT Modified in Phase 1

| File | Reason |
|:---|:---|
| `backend/memory/MemoryManager.ts` | No `requestLongTermWrite()` method added yet — gate operates by wrapping the existing `add()` call from the REST approval endpoint only. Full `MemoryManager` integration is Phase 2. |
| `backend/brain/AdaptivePromptSynthesizer.ts` | Persona context injection deferred to Phase 10.4 (AdaptiveContextRetriever) to avoid touching prompt assembly before the gate is stable |
| `backend/ai/GeminiSessionFactory.ts` | READ ONLY throughout — no tool additions or removals |
| Any test file from Stage 1–9 | Frozen per invariant |

---

### 3.3 Phase 1 Acceptance Criteria

#### AC-P1.1 — CompanionPersona Persistence
- `CompanionPersonaStore` loads default persona on first run if `companion_persona.json` does not exist
- `PUT /api/companion/persona` persists changes to `companion_persona.json` atomically (tmp → rename pattern)
- `GET /api/companion/persona` returns the persisted persona after restart
- `companion_persona.json` is NOT indexed by `MemoryDeduplicator` or `MemorySearch`
- TypeScript: `npx tsc --noEmit` exits 0 after Phase 1 additions

#### AC-P1.2 — Governing Memory Gate Core
- `GoverningMemoryGate.requestWrite(proposed, reason, confidence, source)` creates a `MemoryWriteRequest` with `approved: undefined` (pending) and `expiresAt: now + 24h`
- `POST /api/companion/memory/requests/:id/approve` sets `approved: true`, calls `MemoryManager.add()`, and emits `SecurityAuditLogger.logEvent("MEMORY_WRITE_APPROVED", ...)`
- `POST /api/companion/memory/requests/:id/reject` sets `approved: false`, discards the proposed memory (NO write to `memories.json`), logs `MEMORY_WRITE_REJECTED`
- Requests older than 24 hours are auto-expired by `expireStale()` without any `memories.json` write
- With policy `"session_only"`: `requestWrite()` throws immediately, zero pending requests created
- With policy `"always_ask"` (default): no request is ever auto-approved regardless of confidence value

#### AC-P1.3 — Session Context Ring Buffer
- `appendTurn()` stores entries in memory; `getTurns()` returns in insertion order
- When `appendTurn()` is called with 51st entry, the first entry is evicted (ring buffer bound)
- All stored entries have been processed through `ContentSanitizer` (verified by testing that a `userMessage` containing a raw API key pattern is stored with `[REDACTED]`)
- No file is written to disk by default (`companion_session.json` does not appear in working tree)

#### AC-P1.4 — Security & Invariant Gates
- `npx tsc --noEmit` exits 0 (zero TypeScript errors)
- `npx tsx` live check: `COUNT=129 UNIQUE=129` (LIVE_TOOLS invariant unchanged)
- `npx vitest run tests/unit/` — all existing 338 tests pass PLUS new Phase 1 unit tests pass
- `npx vitest run tests/integration/stage1_*` through `stage9_*` — 252/252 pass (zero regressions in existing suites)
- `npm run build` exits 0 (production bundle clean)
- `git status --porcelain | Select-String "\.db$|\.sqlite$|\.bin$"` — empty (no artifact files)
- `companion_persona.json` does NOT appear as a tracked git artifact
- Zero modifications to: `electron/`, `android/`, `desktop_agent/tools_browser.py`, `desktop_agent/egress_proxy.py`, `backend/ai/GeminiSessionFactory.ts`

---

### 3.4 Phase 1 Regression Test Specification

New test file: **`tests/unit/companion_core_phase1.test.ts`**

> [!NOTE]
> Test file path and structure are specified here for planning purposes only. No test file is created by this document.

#### Unit Tests — CompanionPersonaStore

```
CP01.1  Default persona loads when companion_persona.json does not exist
CP01.2  Persona persists across store.save() / store.load() cycle
CP01.3  PUT /api/companion/persona updates displayName and persists
CP01.4  communicationStyle fields (verbosity, formality, emotionalTone) round-trip correctly
CP01.5  Persona file is NOT queried by MemorySearch (isolation test)
```

#### Unit Tests — GoverningMemoryGate

```
CP02.1  requestWrite() creates a pending MemoryWriteRequest with approved=undefined
CP02.2  approveWrite() calls MemoryManager.add() exactly once and logs MEMORY_WRITE_APPROVED
CP02.3  rejectWrite() does NOT call MemoryManager.add() and logs MEMORY_WRITE_REJECTED
CP02.4  expireStale() discards requests older than 24h without calling MemoryManager.add()
CP02.5  policy="always_ask": requestWrite with confidence=0.99 remains pending (no auto-approve)
CP02.6  policy="auto_approve_high_confidence": requestWrite with confidence>=0.85 is auto-approved synchronously
CP02.7  policy="session_only": requestWrite throws immediately, zero requests created
CP02.8  Approving a non-existent request ID throws a clear error (no silent failure)
CP02.9  SecurityAuditLogger receives a structured event on both approval and rejection
CP02.10 Double-approve of the same request ID is idempotent (second call is no-op, no double write)
```

#### Unit Tests — SessionContextManager

```
CP03.1  appendTurn() stores entry; getTurns() returns it in insertion order
CP03.2  51st appendTurn() evicts the first entry (ring buffer bound at 50)
CP03.3  clearSession() empties the buffer
CP03.4  userMessage containing "AIza..." API key pattern is stored as "[REDACTED_GEMINI_KEY]"
CP03.5  No file is created in the working tree after 100 appendTurn() calls
CP03.6  getTurns() returns a copy (mutations to the result do not affect the buffer)
```

#### Regression Gate Tests (executed, not new)

```
REG-P1.1  npx tsc --noEmit → exit 0, zero errors
REG-P1.2  npx tsx live LIVE_TOOLS check → COUNT=129 UNIQUE=129
REG-P1.3  npx vitest run tests/unit/ → 338+ pass, 0 fail
REG-P1.4  npx vitest run stage1..stage9 (9 files) → 252 pass, 0 fail
REG-P1.5  npm run build → exit 0
REG-P1.6  git status artifact check → no .db/.sqlite/.bin files
```

---

### 3.5 Response to the Six Open Questions

| # | Question | Recommendation |
|:---|:---|:---|
| **Q1** | Memory write policy default? | **`"always_ask"` must be the default.** `"auto_approve_high_confidence"` is a security risk — confidence scores can be manipulated by adversarial inputs. The operator may opt into it explicitly via `companion_preferences.json`, but it must never be the out-of-box default. |
| **Q2** | Session persistence opt-in? | **In-memory only by default.** Disk persistence requires a separate operator action (`PUT /api/companion/preferences` with `sessionPersistenceEnabled: true`). When enabled, writes must route through `GoverningMemoryGate` — session data is personal conversation history. |
| **Q3** | Reminder scope? | **Project-scoped when a project is active; globally scoped otherwise.** The `Reminder.projectId?: string` optional field handles both cases. Default is global (no `projectId`). |
| **Q4** | ADV-02 automation? | **Yes — include in Phase 10.5.** `CompanionTaskOrchestrator` wraps `PlannerCoordinator` and has full visibility into cancellation signal propagation. Add `ADV02.1 Task cancellation within 2s transitions to CANCELLED state` and `ADV02.2 Browser stops loading on task cancel` as acceptance tests. This formally closes the L-01 P0 gap with automated evidence. |
| **Q5** | LIVE_TOOLS adjustment? | **Zero adjustments for Stage 10 as designed.** All companion operations route through REST API, not LIVE_TOOLS. If a future requirement demands AI-callable reminder or approval tools, designate specific existing tools for retirement with explicit operator authorization at that time. The 129-count invariant must be enforced at every phase gate. |
| **Q6** | Explainability verbosity? | **On user query only (Phase 10.7a).** Proactive volunteering of explanations (the `UncertaintyBeacon` behavior) is deferred to Phase 10.7b with a separate UX design review. In 10.7a, explanations are available via `/api/companion/explain/:traceId` on demand only. |

---

## Part 4 — Summary & Go/No-Go Checklist

### Pre-Implementation Checklist (Must be Verified Before Phase 1 Begins)

| Check | Requirement | How to Verify |
|:---|:---:|:---|
| P0 L-01 acknowledged | ADV-02 remains NOT VERIFIED; operator accepts CONDITIONAL PASS state until automated test added in Phase 10.5 | Explicit operator sign-off |
| P0 L-02 through L-05 acknowledged | NF-01, NF-04, NF-05, SEC-04 manual tests remain pending | Explicit operator sign-off |
| LIVE_TOOLS baseline confirmed | Exactly 129 at Phase 1 start | `npx tsx` live check → `COUNT=129 UNIQUE=129` |
| Stage 1–9 baseline confirmed | 252/252 passing before first Phase 1 line is written | `npx vitest run stage1..stage9` |
| TypeScript baseline confirmed | Zero compile errors | `npx tsc --noEmit` → exit 0 |
| Frozen areas identified | `electron/`, `android/`, `desktop_agent/tools_browser.py`, `desktop_agent/egress_proxy.py`, `backend/ai/GeminiSessionFactory.ts` | Documented in Phase 1 scope |
| `companion_persona.json` write path isolated | New file does NOT go to `memories.json` | Type-level constraint in `CompanionPersonaStore` |
| `PlanStore` audited | Determine whether `ProjectContinuityStore` is needed before Phase 10.3 begins | Read `backend/planner/PlanStore.ts` schema |

### Phase 1 Go Condition

> [!IMPORTANT]
> Implementation of Stage 10 Phase 1 may only begin after ALL of the following are true:
>
> 1. Operator has provided **explicit written approval** of this review document
> 2. The pre-implementation checklist above is verified and signed off
> 3. LIVE_TOOLS live execution confirms COUNT=129 UNIQUE=129 at the moment work begins
> 4. Stage 1–9 regression suite confirms 252/252 (or current baseline) at the moment work begins

---

*Read-only review completed 2026-10-30T23:02:42+05:30. No production code, tests, configuration, databases, or existing reports were modified. All findings are based on direct inspection of source files and existing report documents.*
