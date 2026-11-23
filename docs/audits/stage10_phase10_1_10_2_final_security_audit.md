# MYRAA — STAGE 10.1 + 10.2
# FINAL COMPANION FOUNDATION & MEMORY GOVERNANCE SECURITY AUDIT

**Role:** Principal Security Engineer, Application Security Auditor, Senior AI Systems Architect  
**Date:** 2026-11-18  
**Audit Mode:** Independent Read-Only Security Audit (zero code, test, or configuration changes performed)  
**Overall Verdict:** **`FAIL — CRITICAL SECURITY FINDINGS`**

---

## 1. Executive Security Verdict

```
══════════════════════════════════════════════════════════════════════════════
OVERALL SECURITY AUDIT VERDICT: FAIL — CRITICAL SECURITY FINDINGS
══════════════════════════════════════════════════════════════════════════════
Confirmed Findings: 3 CRITICAL | 4 HIGH | 3 MEDIUM (10 Total)
Core Governance Strengths Verified:
  • MemoryStore.save() blocks direct unauthenticated calls via private ALS
    (FORBIDDEN_STORAGE_WRITE)
  • GoverningMemoryGate defaults to "always_ask" with timing-safe token check
    and bounded 500-entry proposal queue
  • POST /api/memories and POST /api/companion/memory/propose redact
    oneTimeToken from HTTP responses
  • LIVE_TOOLS invariant intact (129 declarations, 129 unique names)
  • Stage 10.4.2 tests (102/102) and TypeScript compilation (exit 0) intact

Blocking Critical Findings Preventing Acceptance:
  1. FINDING-AUD-01 [CRITICAL]: ApprovedMemoryPersistenceAdapter.commitApproved()
     verifies GovernanceProof signature/expiry but NEVER verifies binding to the
     supplied MemoryWriteRequest (requestId, action, userId, payloadHash,
     targetMemoryId). Any valid proof can commit a substituted payload/action.
  2. FINDING-AUD-02 [CRITICAL]: Raw 32-byte HMAC secret is publicly exported via
     getInternalPersistenceSecret() (GoverningMemorySecret.ts +
     GoverningMemoryGate.ts), and runAuthorizedPersistence() does not enforce
     single-use proof consumption.
  3. FINDING-AUD-03 [CRITICAL]: Unauthenticated REST endpoints expose memory
     read/propose/delete/archive (/api/memories*), unauthenticated direct-to-disk
     memory writes bypassing governance (/api/brain/learn, /api/brain/feedback,
     /api/brain/preferences/:id), unauthenticated /api/ux/memory & /api/companion/*
     mutations, and an unauthenticated /api/security/step-up/request endpoint
     that returns the plaintext 6-digit step-up PIN in the HTTP JSON response.
══════════════════════════════════════════════════════════════════════════════
```

---

## 2. Audited Component and API Inventory

### Stage 10.1 — Companion Foundation

| Component | File | Status | Summary |
|---|---|---:|---|
| Persona Types | `backend/companion/CompanionPersonaTypes.ts` | `PASS` | Defines `CompanionPersona` (`id`, `displayName`, `avatarStyle`, `preferredLanguage`, `communicationStyle`, `customPromptPrefix`). |
| Persona Store | `backend/companion/CompanionPersonaStore.ts` | `FAIL` | Atomic writes & BOM handling work, but `savePersona()` performs zero schema/authorization validation (`L119-L135`). |
| Governing Memory Types | `backend/companion/GoverningMemoryTypes.ts` | `PASS` | Defines `MemoryWriteRequest`, `PublicMemoryWriteRequest`, `MemoryApprovalContext`, `GovernanceProof`. |
| Governing Memory Secret | `backend/companion/GoverningMemorySecret.ts` | `FAIL` | Exports raw 32-byte HMAC secret `Buffer` publicly via `getInternalPersistenceSecret()` (`L11-L13`). |
| Governing Memory Gate | `backend/companion/GoverningMemoryGate.ts` | `FAIL` | Default `"always_ask"`, timing-safe comparison, 500-entry bound work; fails on missing Emergency Stop/Lockdown gates, unprotected `setPolicy()`, missing RBAC/session binding, `"local_operator"` actor bypass, and sensitive-category step-up bypass on auto-approve and UPDATE/DELETE/MERGE (`L68-L70`, `L151-L170`, `L214-L251`, `L356-L377`). |
| Session Context Manager | `backend/companion/SessionContextManager.ts` | `FAIL` | RAM-only + FIFO 50-turn bound + `AIza`/DLP/injection sanitization work; fails on single global unpartitioned `_turns` array (no session isolation) and un-enforced `sessionTimeoutMs` (`L32-L125`). |
| User Preference Resolver | `backend/intelligence/UserPreferenceResolver.ts` | `FAIL` | Explicit utterance override works; lacks preference provenance tracking and is mutable via unauthenticated `POST /api/intelligence/context` (`HttpGateway.ts:5361-5372`). |
| Companion Coordinator | `backend/companion/CompanionCoordinator.ts` | `PASS` | Checks `emergencyStopCoordinator.isActive()` on `scheduleTask`/`triggerCheck`, enforces SSRF validation on deployment monitors, runs hourly `expireStale()`. *(API routes wrapping it in `HttpGateway.ts:698-824` lack auth — tracked under `FINDING-AUD-03`.)* |
| Companion API (`server.ts`) | `backend/server.ts` (`L272-L538`) | `FAIL` | Approve/reject enforce `requireLocalhost` + `requireOperatorSession`, but omit Emergency Stop, Lockdown, RBAC, and rejection actor checks; `PUT /api/companion/persona` lacks operator auth and fails to validate `customPromptPrefix`, `avatarStyle`, `preferredLanguage`, `communicationStyle`. |

### Stage 10.2 — Memory Governance

| Component | File | Status | Summary |
|---|---|---:|---|
| Persistence Context | `backend/memory/MemoryPersistenceContext.ts` | `FAIL` | Private `AsyncLocalStorage` (`_storageContext`) blocks direct `MemoryStore.save()` calls (`PASS`), but exported `runAuthorizedPersistence()` lacks consumed-proof tracking and `verifyGovernanceProof()` does not bind proof to request payload (`FAIL`). |
| Approved Persistence Adapter | `backend/memory/ApprovedMemoryPersistenceAdapter.ts` | `FAIL` | Enforces replay/in-flight checks on `proofId` (`PASS`), but fails to verify `proof.payload` matches `request` (`FINDING-AUD-01`), lacks target ownership checks, and consumes `proofId` after `store.save()` instead of fail-closed before persistence (`L111-L177`, `L194-L271`). |
| Memory Store | `backend/memory/MemoryStore.ts` | `FAIL` | `save()` calls `assertActivePersistenceSession()` (`PASS`), but uses fixed `memories.json.tmp` without write serialization (`L124-L128`), creating a concurrent rename race. |
| Memory Manager | `backend/memory/MemoryManager.ts` | `FAIL` | Routes CRUD mutations through `GoverningMemoryGate` (`PASS`), but `updateMemory`/`deleteMemory`/`mergeMemory` omit target `category` (bypassing step-up), return optimistic pre-approval results, and `getRelevantContext()` still calls `this.store.save()` outside ALS (`L389`). |
| Shared Memory Manager | `backend/memory/SharedMemoryManager.ts` | `FAIL` | Enforces Emergency Stop, Lockdown, DLP on direct calls and routes mutations to `GoverningMemoryGate`; fails on missing `category` for UPDATE/DELETE, unfiltered WS broadcasts of all memories (`L146-L162`), and 13 broken legacy unit tests. |
| Memory Extractor & `server_memory.ts` | `backend/memory/MemoryExtractor.ts`, `backend/server_memory.ts` | `FAIL` | Legacy `saveMemories()` is now a no-op warning (`PASS`), and `processConversationSlice()` routes transactions to `governingMemoryGate.requestWrite()`; however `formatSystemInstructionsWithMemories()` interpolates stored `m.text` verbatim into Gemini's system prompt without prompt-injection fencing (`server_memory.ts:65-105`). |
| Alternate Memory Stores | `backend/brain/CognitiveMemoryStore.ts`, `backend/gateway/HttpGateway.ts` | `FAIL` | `CognitiveMemoryStore` writes directly to `DATA_DIR/cognitive_memories.json` via unauthenticated `/api/brain/learn`, `/api/brain/feedback`, `/api/brain/preferences/:id` and injects directly into Gemini's system prompt (`ContextManager.ts:255-259`), bypassing `GoverningMemoryGate` entirely. |

---

## 3. Actual Memory-Write Call-Path Map

| Entry Point | File & Lines | Auth / Gate at Entry | Reaches `GoverningMemoryGate`? | Reaches Disk Directly (Bypass)? | Governance Verdict |
|---|---|---|---|---|---|
| `POST /api/memories` | `HttpGateway.ts:227-262` | **None** (no localhost/auth/ES/lockdown) | Yes (`requestWrite` CREATE; `oneTimeToken` omitted from HTTP response) | No (unless policy set to auto-approve) | `FAIL` (unauthenticated queue spam / forged `local_operator` attribution) |
| `PATCH /api/memories/:id` | `HttpGateway.ts:310-346` | **None** | Yes (`requestWrite` UPDATE, omits `category`) | No | `FAIL` (unauthenticated + step-up bypass on sensitive category) |
| `DELETE /api/memories/:id` | `HttpGateway.ts:264-273` | **None** | Yes (`memoryManager.deleteMemory` → `requestWrite` DELETE, omits `category`) | No | `FAIL` (unauthenticated + misleading HTTP 200 `{success:true}` + step-up bypass) |
| `POST /api/memories/:id/archive` | `HttpGateway.ts:349-361` | **None** | Yes (`memoryManager.archiveMemory` → `requestWrite` UPDATE, omits `category`) | No | `FAIL` (unauthenticated + misleading HTTP 200 + step-up bypass) |
| `POST /api/companion/memory/propose` | `server.ts:425-449` | `requireLocalhost` only (no operator auth / ES / lockdown) | Yes (`requestWrite` CREATE; `oneTimeToken` omitted) | No | `FAIL` (no operator session / ES / lockdown / DLP / injection check) |
| `POST /api/companion/memory/(requests/:id/approve\|approve/:id)` | `server.ts:452-517` | `requireLocalhost` + `requireOperatorSession` | Calls `governingMemoryGate.approveWrite()` → `ApprovedMemoryPersistenceAdapter` → `MemoryStore.save()` | No (governed path) | `FAIL` (no ES/lockdown/RBAC; step-up bypassable via `/api/security/step-up/request` & UPDATE/DELETE missing category) |
| `POST /api/companion/memory/(requests/:id/reject\|reject/:id)` | `server.ts:520-537` | `requireLocalhost` + `requireOperatorSession` | Calls `governingMemoryGate.rejectWrite()` | No | `FAIL` (no actor ownership, RBAC, ES, or lockdown check) |
| `POST /api/remote/memory` & `PATCH /api/remote/memory/:id` | `HttpGateway.ts:1334-1524` | `requireLocalhostOrPairedDevice` + `isDlpClean` | Yes (`requestWrite`, no ES/lockdown pre-check before `requestWrite`) | No | `FAIL` (skips ES/Lockdown; PATCH omits `category` & `existing` check) |
| `DELETE /api/remote/memory/:id` | `HttpGateway.ts:1527-1554` | `requireLocalhostOrPairedDevice` | Yes (`sharedMemoryManager.deleteMemory` checks ES/lockdown → `requestWrite`) | No | `FAIL` (omits `category` for step-up; returns misleading `{success:true}`) |
| `POST /api/remote/memory/sync` | `HttpGateway.ts:1557-1612` | `requireLocalhostOrPairedDevice` | Yes (`requestWrite` directly — **skips** `isDlpClean`, ES, Lockdown!) | No | `FAIL` (bypasses DLP, ES, Lockdown, and `SharedMemoryManager.syncBatch()`) |
| `saveCustomMemory` Gemini tool | `ToolOrchestrator.ts:508-515, 1353-1415` | `EmergencyStop` → `SecurityPolicyEngine` (`MEDIUM` risk = `AUDIT`) → `OutputDataFirewall` | Yes (`requestWrite` CREATE; no `oneTimeToken` in tool response) | No | `PASS` for proposal gating; `FAIL` for missing DLP/prompt-injection check |
| `StepExecutor` `sharedMemory` (`create`/`save`) | `StepExecutor.ts:139-168` | Planner step context (no ES/Lockdown/DLP call on `create`/`save` branch) | Yes (`requestWrite` directly, skipping `sharedMemoryManager` guards) | No | `FAIL` (skips DLP, ES, Lockdown checks) |
| Background `extractAndApply` / `processConversationSlice` | `GeminiSessionFactory.ts:2672`, `MemoryExtractor.ts:34`, `server_memory.ts:286-335` | Internal background trigger | Yes (`requestWrite` ADD/UPDATE/REMOVE) | No (`saveMemories()` is a no-op warning) | `PASS` for disk gating; `FAIL` for missing injection/DLP filtering & UPDATE/DELETE missing category |
| `POST /api/brain/learn`, `POST /api/brain/feedback`, `DELETE /api/brain/preferences/:id` | `HttpGateway.ts:5426-5504` → `CognitiveMemoryStore.ts:83-100` | **None** | **NO** | **YES — Direct atomic write to `DATA_DIR/cognitive_memories.json`**, injected into Gemini system prompt (`ContextManager.ts:255-259`) | `FAIL` (**CRITICAL bypass** of memory governance) |
| `POST /api/ux/memory` | `HttpGateway.ts:4679-4770` | **None** | **NO** | In-memory `SharedAccountMemoryManager` mutation with client-supplied `accountId`/`deviceId` | `FAIL` (unauthenticated cross-account/device mutation) |
| Direct `memoryStore.save()` | `MemoryStore.ts:121-141` | `assertActivePersistenceSession()` | Blocked (`FORBIDDEN_STORAGE_WRITE`) unless inside `runAuthorizedPersistence()` | Blocked directly, **bypassable in-process** via exported `getInternalPersistenceSecret()` + `runAuthorizedPersistence()` | `FAIL` (`FINDING-AUD-02`) |

---

## 4. Approval and Persistence Security Analysis

### 4.1 What Works Properly
1. **Default Policy (`GoverningMemoryGate.ts:40`):** `_policy` initializes to `"always_ask"`.
2. **Direct `MemoryStore.save()` Blocking (`MemoryStore.ts:121-122`, `MemoryPersistenceContext.ts:194-228`):** The underlying `AsyncLocalStorage` (`_storageContext`) and active session map (`_activeSessions`) are module-private; calling `memoryStore.save()` directly or passing `{ authorized: true }` fails with `FORBIDDEN_STORAGE_WRITE` and logs a `CRITICAL` audit event.
3. **One-Time Token Redaction in Public Lists & HTTP Propose (`GoverningMemoryGate.ts:413-424`, `HttpGateway.ts:253-258`, `server.ts:440-445`):** `listPendingRequests()` strips `oneTimeToken`, and HTTP proposal responses return only `{ status, requestId, message, proposedMemory }`.
4. **Timing-Safe Comparisons:** Both `GoverningMemoryGate.approveWrite()` (`L259`) and `MemoryPersistenceContext.verifyGovernanceProof()` (`L112`) use `crypto.timingSafeEqual()`.
5. **Proposal Queue Bound:** `GoverningMemoryGate.requestWrite()` enforces `MAX_PENDING_PROPOSALS = 500` (`L36, L112-L117`).

### 4.2 Critical & High Flaws in Approval / Persistence / Concurrency
1. **Unbound `GovernanceProof` (`FINDING-AUD-01`):** `ApprovedMemoryPersistenceAdapter.commitApproved(request, proof)` (`L111-L159`) verifies `proof` in isolation without checking that `proof.payload.{requestId, action, userId, payloadHash, targetMemoryId, destinationStorage}` matches `request` and `computePayloadHash(request.proposedMemory)`.
2. **Exported HMAC Signing Key & Replayable `runAuthorizedPersistence()` (`FINDING-AUD-02`):** `getInternalPersistenceSecret()` is exported from `GoverningMemorySecret.ts:11` and re-exported from `GoverningMemoryGate.ts:25`. Moreover, `runAuthorizedPersistence()` (`MemoryPersistenceContext.ts:141-182`) removes `proofId` from `_activeSessions` in `finally` without recording it in a consumed-proof set, so sequential replay against `runAuthorizedPersistence()` succeeds within the 60s expiry window.
3. **Unprotected Policy Escalation & Sensitive Auto-Approval (`FINDING-AUD-05`):** `governingMemoryGate.setPolicy()` (`L68-L70`) has no admin/human authentication or audit log; `_executeAutoApproval()` (`L151-L170`) omits step-up verification for sensitive categories (`identity`, `credentials`, `behavior`).
4. **Concurrency & Failure Semantics Defects:**
   - **Shared `.tmp` Filename Race (`MemoryStore.ts:124-127`):** `MemoryStore.save()` writes to a static `MEMORY_FILE + ".tmp"` with no write-serialization queue. Two concurrent approvals with distinct `proofId`s race on `memories.json.tmp`, risking lost updates or `ENOENT`/`EPERM` rename failures on Windows.
   - **Post-Persist Proof Consumption (`ApprovedMemoryPersistenceAdapter.ts:156-161`):** `_consumedProofIds.add(proofId)` runs *after* `this.store.save()`. If disk I/O fails ambiguously, the proof remains unconsumed and reusable within 60s.
   - **Zombie Proposal on Persistence Failure (`GoverningMemoryGate.ts:279, 322-325`):** `request.oneTimeToken` is wiped before `_persistApproved()`, while `request.approved` is set only after `_persistApproved()` succeeds — if persistence throws, the request stays pending forever with an empty token until 24h expiry.
   - **No-Op Audit Noise on Read (`MemoryManager.ts:383-390`):** `getRelevantContext()` calls `this.store.save(updated).catch(() => {})` outside any persistence session, emitting a `CRITICAL` `FORBIDDEN_STORAGE_WRITE` audit event on every read with `touchLastAccessed = true`.

---

## 5. Authentication, Session-Isolation & Security-Chain Verification

### 5.1 Security Architecture Chain Verification

Target chain: `SecurityPolicyEngine → SecurityRiskEngine → ToolExecutionFirewall → Confirmation → OutputDataFirewall → AuditLogger`

| Operation / Entry Point | PolicyEngine | RiskEngine | ToolExecutionFirewall | Confirmation / Gate | OutputDataFirewall | AuditLogger | Status |
|---|---|---|---|---|---|---|---|
| `saveCustomMemory` (Gemini Live Tool) | Yes (`ToolOrchestrator.ts:279`) | Yes (`MEDIUM` — `SecurityRiskEngine.ts:83`) | **No** (bypassed in `ToolOrchestrator.ts`, uses direct `evaluateRequest`) | `GoverningMemoryGate` proposal (`always_ask`) | Yes (on tool response, `ToolOrchestrator.ts:310`) | Yes | `FAIL` (no DLP/injection check on proposed memory; `ToolExecutionFirewall` not invoked) |
| `POST/PATCH/DELETE /api/memories*` (`HttpGateway.ts`) | **No** | **No** | **No** | `GoverningMemoryGate` proposal only | **No** | Only at approve/reject | `FAIL` (completely unauthenticated) |
| `POST /api/companion/memory/propose` (`server.ts`) | **No** (`requireLocalhost` only) | **No** | **No** | `GoverningMemoryGate` proposal | **No** | Only at approve/reject | `FAIL` (missing operator auth, ES, lockdown, DLP) |
| `POST /api/companion/memory/*/approve` (`server.ts`) | **No** (`requireLocalhost` + `requireOperatorSession`) | **No** | **No** | `oneTimeToken` + partial step-up | **No** | Yes | `FAIL` (no ES/lockdown/RBAC; step-up bypassable) |
| `PUT /api/companion/persona` (`server.ts`) | **No** (`requireLocalhost` only) | **No** | **No** | None | **No** | **No** | `FAIL` (no operator auth, no audit, incomplete validation) |
| `POST /api/brain/learn`, `/api/brain/feedback` | **No** | **No** | **No** | **None** | **No** | **No** | `FAIL` (direct disk write bypass) |
| `StepExecutor` (`sharedMemory` create/save) | Upstream planner gate only | Upstream only | **No** | `GoverningMemoryGate` proposal | **No** | Only at approve/reject | `FAIL` (bypasses `SharedMemoryManager` ES/Lockdown/DLP) |

### 5.2 Authentication & Session-Isolation Findings
1. **Plaintext Step-Up PIN Disclosure & Unauthenticated Step-Up Endpoints (`HttpGateway.ts:4004-4037`, `IdentityAuthManager.ts:665-710`):** `POST /api/security/step-up/request` requires zero authentication and returns `pin` in cleartext JSON; `POST /api/security/step-up/verify` also requires zero authentication. Any caller knowing a `sessionId` can self-elevate to `isStepUpAuthenticated = true` for 5 minutes.
2. **CORS Enforcement Gap (`HttpGateway.ts:161-196`):** Disallowed `Origin` headers are rejected with `403` **only** when `req.method === "OPTIONS"` (`L187-L189`). Simple cross-origin `GET`/`POST` requests (e.g. `text/plain` or form posts) proceed through to handlers without blocking.
3. **Missing Session Binding in `GoverningMemoryGate` & `SessionContextManager`:**
   - `MemoryWriteRequest` has no `sessionId`; approvals are not bound to an originating session.
   - `SessionContextManager` singleton (`SessionContextManager.ts:33, 127`) uses one unpartitioned global `_turns` array for all sessions and never enforces `sessionTimeoutMs`.
4. **Desktop Operator Identity (`server.ts:272-287`, `IdentityAuthManager.ts:245-302`):** `requireOperatorSession` correctly enforces HMAC-SHA256 `myraa_at_` access token signature, 15m TTL expiry (`exp < nowSec`), session revocation, and token-family revocation (`PASS`), **but** does not enforce RBAC (`guest`/`read_only` can reach `handleApprove`/`handleReject`), Emergency Stop, or Security Lockdown.

---

## 6. Attack-Scenario Test Matrix

| # | Attack Scenario | Verification Method | Actual Behaviour Observed | Status | Finding Ref |
|---|---|---|---|---:|---|
| 1 | Unauthenticated memory write | Source trace (`HttpGateway.ts:227, 5426`) | `POST /api/memories` accepts unauthenticated proposals (no auth middleware); `POST /api/brain/learn` writes directly to `cognitive_memories.json` unauthenticated. | `FAIL` | `FINDING-AUD-03` |
| 2 | Unauthorized persona update | Source trace (`server.ts:393-412`, `CompanionPersonaStore.ts:119`) | `PUT /api/companion/persona` requires only `requireLocalhost` (no operator token, no RBAC/ES/Lockdown), and `validatePersonaPayload()` skips `customPromptPrefix`, `avatarStyle`, `preferredLanguage`, `communicationStyle`. | `FAIL` | `FINDING-AUD-04` |
| 3 | Direct `MemoryStore.save()` persistence attempt | Executed test (`companion_core_phase1.test.ts` `SEC-T02.07`, `SEC-T02.13`) + source trace | Direct `memoryStore.save()` throws `FORBIDDEN_STORAGE_WRITE` (`PASS`); however in-process callers can import `getInternalPersistenceSecret()` + `runAuthorizedPersistence()` to bypass (`FAIL`). | `FAIL` | `FINDING-AUD-02` |
| 4 | Forged governance proof | Executed test (`companion_core_phase1.test.ts` `SEC-T02.09`) + source trace | Random/wrong-HMAC proofs are rejected (`UNAUTHORIZED_PERSISTENCE_CALL`); however `getInternalPersistenceSecret()` is exported, enabling in-process forgery. | `FAIL` | `FINDING-AUD-02` |
| 5 | Expired governance proof (>60s) | Executed test (`companion_core_phase1.test.ts` `SEC-T02.08`) + source trace (`MemoryPersistenceContext.ts:86-97`) | Throws `GOVERNANCE_PROOF_EXPIRED` and logs `TOOL_BLOCKED` audit event. | `PASS` | — |
| 6 | Replayed governance proof | Executed test (`companion_core_phase1.test.ts` `SEC-T02.10`) + source trace | Blocked in `ApprovedMemoryPersistenceAdapter` (`GOVERNANCE_PROOF_ALREADY_CONSUMED`), **but NOT blocked** if called sequentially via exported `runAuthorizedPersistence()`. | `FAIL` | `FINDING-AUD-02` |
| 7 | Governance proof reused with a different payload | Source trace (`ApprovedMemoryPersistenceAdapter.ts:111-159`, `MemoryPersistenceContext.ts:74-128`) | **Confirmed bypass:** `commitApproved(otherRequest, validProof)` never checks `proof.payload.{requestId, action, userId, payloadHash, targetMemoryId}` against `otherRequest`. | `FAIL` | `FINDING-AUD-01` |
| 8 | Cross-actor approval | Executed test (`companion_core_phase1.test.ts` `SEC-T01.04`) + source trace (`GoverningMemoryGate.ts:214-251`) | Distinct non-`local_operator` actors are blocked (`UNAUTHORIZED_ACTOR`), **but** `actorId === "local_operator"` (also the default when `context` is omitted) bypasses ownership for all users, and `rejectWrite()` has no actor check. | `FAIL` | `FINDING-AUD-05` |
| 9 | Cross-session approval | Source trace (`GoverningMemoryGate.ts:176-251`, `GoverningMemoryTypes.ts:18-34`) | `MemoryWriteRequest` has no `sessionId`; any other session of the same actor (or `local_operator`) can approve the proposal. | `FAIL` | `FINDING-AUD-05` |
| 10 | Caller-controlled `{ authorized: true }` bypass | Executed test (`companion_core_phase1.test.ts` `SEC-T02.13`) + source trace (`MemoryStore.ts:121`, `MemoryPersistenceContext.ts:44`) | `MemoryStore.save()` accepts no authorization parameter and `_storageContext` ALS is private; `{ authorized: true }` cannot bypass `MemoryStore.save()`. | `PASS` | — |
| 11 | Memory write through legacy or alternate API paths | Source trace (`server_memory.ts:29`, `HttpGateway.ts:4679, 5426`, `CognitiveMemoryStore.ts:83`) | Legacy `saveMemories()` is blocked (`PASS`), **but** `/api/brain/learn`, `/api/brain/feedback`, `/api/brain/preferences/:id` write directly to `cognitive_memories.json`, and `/api/ux/memory` mutates shared state without auth/governance. | `FAIL` | `FINDING-AUD-03` |
| 12 | WebSocket token & sensitive memory exposure | Source trace (`CompanionCoordinator.ts:66-93`, `SharedMemoryManager.ts:118-163`, `GeminiSessionFactory.ts:2679`) | `oneTimeToken` and `GovernanceProof` are **never** broadcast over WebSocket (`PASS`); however `SharedMemoryManager._broadcastSync()` and `GeminiSessionFactory` `memory_sync` broadcast full memory arrays (including sensitive `identity`/`behavior` memories) without redaction or step-up gating (`FAIL`). | `FAIL` | `FINDING-AUD-09` |
| 13 | Prompt-injection content inside stored memory | Source trace (`GoverningMemoryGate.ts:98-149`, `server_memory.ts:65-105`, `MemoryManager.ts:351-354`) | Stored memory text is NOT scanned/defanged at proposal or persistence time and is interpolated verbatim without `<<<UNTRUSTED_...>>>` fencing into Gemini's privileged system prompt. | `FAIL` | `FINDING-AUD-06` |
| 14 | Secret or credential leakage into session context | Executed test (`companion_core_phase1.test.ts` CP03.4) + source trace (`SessionContextManager.ts:56-76`, `OutputDataFirewall.ts:45`) | `AIza...`, `Bearer`, `sk-`, `myraa_at_`, `myraa_rf_`, `sora_conf_`, PEM keys are redacted in `SessionContextManager`; minor gap: `sora_dev_` device tokens are missing from `OutputDataFirewall.ts:45` and `SessionContextManager` lacks session isolation/TTL expiry. | `FAIL` | `FINDING-AUD-08` |
| 15 | Unauthorized update, merge, or deletion | Source trace (`HttpGateway.ts:264-361`, `ApprovedMemoryPersistenceAdapter.ts:194-271`) | `PATCH/DELETE/archive /api/memories/:id` have no auth; `ApprovedMemoryPersistenceAdapter` enforces no target ownership check on `UPDATE`/`DELETE`/`ARCHIVE`/`MERGE`. | `FAIL` | `FINDING-AUD-03`, `FINDING-AUD-07` |
| 16 | Sensitive memory access/mutation without step-up auth | Source trace (`HttpGateway.ts:4004-4037`, `GoverningMemoryGate.ts:151-170, 221-227`, `server.ts:469-489`) | Step-up is enforced on `CREATE` of `identity`/`credentials`/`behavior`, **but bypassed** via: (a) unauthenticated `POST /api/security/step-up/request` returning plaintext PIN, (b) `UPDATE`/`DELETE`/`MERGE`/`ARCHIVE` omitting `category` in `proposedMemory`, (c) `GET /api/memories` returning sensitive memories unauthenticated, and (d) `_executeAutoApproval()` skipping step-up. | `FAIL` | `FINDING-AUD-03`, `FINDING-AUD-05`, `FINDING-AUD-07` |
| 17 | Approval attempted during Emergency Stop or Security Lockdown | Source trace (`GoverningMemoryGate.ts:98-377`, `server.ts:425-538`) | Neither `GoverningMemoryGate` nor `/api/companion/memory/*` endpoints check `emergencyStopCoordinator.isActive()` or `securityPolicyEngine.getMode() === "LOCKDOWN"`. | `FAIL` | `FINDING-AUD-05` |

---

## 7. Exact Executed Test Commands and Results

All tests were executed without modifying any source, test, or configuration files.

| # | Exact Command | Exit Code | Passed | Failed | Skipped | Per-File Breakdown |
|---|---|---:|---:|---:|---:|---|
| 1 | `npx vitest run --fileParallelism=false tests/unit/companion.test.ts tests/unit/companion_core_phase1.test.ts tests/unit/memory.test.ts tests/unit/shared_memory.test.ts` | `1` | `144` | `20` | `0` | `companion.test.ts`: **37/37 PASS**; `companion_core_phase1.test.ts`: **42/42 PASS**; `memory.test.ts`: **58 PASS, 7 FAIL**; `shared_memory.test.ts`: **7 PASS, 13 FAIL** |
| 2 | `npx vitest run --fileParallelism=false tests/integration/security_foundation.test.ts tests/integration/prompt_injection_and_data_protection.test.ts tests/integration/desktop_rpc_and_cors_security.test.ts tests/integration/phase7_shared_account_memory.test.ts` | `0` | `85` | `0` | `0` | `security_foundation.test.ts`: **28/28 PASS**; `prompt_injection_and_data_protection.test.ts`: **26/26 PASS**; `desktop_rpc_and_cors_security.test.ts`: **15/15 PASS**; `phase7_shared_account_memory.test.ts`: **16/16 PASS** |
| 3 | `npx vitest run --fileParallelism=false tests/unit/projects.test.ts tests/unit/planner.test.ts tests/unit/phase10_project_continuity.test.ts tests/unit/phase10_audio_continuity.test.ts tests/integration/comprehensive_security_suite.test.ts tests/integration/stage8_security_boundary_audit.test.ts` | `0` | `248` | `0` | `0` | `projects.test.ts`: **17/17 PASS**; `planner.test.ts`: **71/71 PASS**; `phase10_project_continuity.test.ts`: **75/75 PASS**; `phase10_audio_continuity.test.ts`: **27/27 PASS**; `comprehensive_security_suite.test.ts`: **40/40 PASS**; `stage8_security_boundary_audit.test.ts`: **18/18 PASS** |
| 4 | `npx tsc --noEmit --skipLibCheck` | `0` | — | — | — | 0 TypeScript errors |
| 5 | `npx tsx -e "import { LIVE_TOOLS } from './backend/ai/GeminiSessionFactory.ts'; const d = LIVE_TOOLS.flatMap((t: any) => t.functionDeclarations || []); const u = new Set(d.map((x: any) => x.name)); console.log('LIVE_TOOLS_DECLARATIONS=' + d.length + ' UNIQUE_NAMES=' + u.size);"` | `0` | — | — | — | `LIVE_TOOLS_DECLARATIONS=129 UNIQUE_NAMES=129` |

**Executed Runtime Summary:** 14 test files executed — **477 passed, 20 failed, 0 skipped**.  
The 20 failures occur in legacy unit suites (`tests/unit/memory.test.ts`: 7 failures; `tests/unit/shared_memory.test.ts`: 13 failures) because `MemoryManager` and `SharedMemoryManager` now enqueue proposals in `GoverningMemoryGate` (`always_ask`) rather than persisting synchronously while still returning optimistic in-memory records, causing assertions on persisted disk state, dedup IDs, LWW updates, offline batch sync, and broadcast events to fail.

---

## 8. Confirmed Vulnerabilities (With File Paths & Line References)

| ID | Severity | Status | File Paths & Lines | Summary |
|---|---:|---:|---|---|
| **FINDING-AUD-01** | **CRITICAL** | `FAIL` | `backend/memory/ApprovedMemoryPersistenceAdapter.ts:111-159`, `backend/memory/MemoryPersistenceContext.ts:74-128` | `commitApproved(request, proof)` never verifies that `proof.payload` (`requestId`, `action`, `userId`, `payloadHash`, `targetMemoryId`, `destinationStorage`) matches the supplied `request` or recomputed hash of `request.proposedMemory`. |
| **FINDING-AUD-02** | **CRITICAL** | `FAIL` | `backend/companion/GoverningMemorySecret.ts:11-13`, `backend/companion/GoverningMemoryGate.ts:24-25`, `backend/memory/MemoryPersistenceContext.ts:141-182` | Raw 32-byte HMAC secret `INTERNAL_PERSISTENCE_SECRET` is publicly exported via `getInternalPersistenceSecret()`, and exported `runAuthorizedPersistence()` lacks single-use consumed-proof tracking, allowing in-process proof forgery and sequential replay directly against `MemoryStore.save()`. |
| **FINDING-AUD-03** | **CRITICAL** | `FAIL` | `backend/gateway/HttpGateway.ts:217-378, 698-824, 1557-1612, 4004-4037, 4679-4770, 5426-5504`, `backend/brain/CognitiveMemoryStore.ts:83-100`, `backend/projects/ContextManager.ts:255-259` | (a) `POST /api/security/step-up/request` is unauthenticated and returns plaintext 6-digit `pin` in HTTP JSON; `/verify` is also unauthenticated. (b) `/api/brain/learn`, `/api/brain/feedback`, `/api/brain/preferences/:id` are unauthenticated and write directly to `cognitive_memories.json`, bypassing governance and injecting into Gemini's system prompt. (c) `/api/memories*`, `/api/ux/memory`, and non-DELETE `/api/companion/*` lack auth/localhost guards. (d) `/api/remote/memory/sync` bypasses DLP, Emergency Stop, and Lockdown. |
| **FINDING-AUD-04** | **HIGH** | `FAIL` | `backend/server.ts:292-412`, `backend/companion/CompanionPersonaStore.ts:119-135`, `backend/gateway/HttpGateway.ts:165-190` | `PUT /api/companion/persona` lacks operator session auth, Emergency Stop/Lockdown checks, and audit logging; `validatePersonaPayload()` omits validation of actual `CompanionPersona` fields (`customPromptPrefix`, `avatarStyle`, `preferredLanguage`, `communicationStyle`), allowing unsanitized prompt injection up to 10 KB; CORS only rejects bad origins on `OPTIONS`. |
| **FINDING-AUD-05** | **HIGH** | `FAIL` | `backend/companion/GoverningMemoryGate.ts:68-70, 98-170, 214-251, 356-377`, `backend/server.ts:425-538` | No Emergency Stop or Security Lockdown enforcement on memory propose/approve/reject; no RBAC check (`guest`/`read_only` permitted); no `sessionId` binding on proposals; `"local_operator"` wildcard (and default context) bypasses actor ownership; `setPolicy()` is unprotected and `_executeAutoApproval()` skips step-up for sensitive categories; `rejectWrite()` ignores caller actor identity. |
| **FINDING-AUD-06** | **HIGH** | `FAIL` | `backend/server_memory.ts:65-105`, `backend/memory/MemoryManager.ts:346-375`, `backend/companion/GoverningMemoryGate.ts:98-149`, `backend/planner/StepExecutor.ts:152-168` | Stored memories are never scanned/defanged for prompt injection or screened for secrets (outside `SharedMemoryManager` DLP) before proposal/persistence, and are interpolated verbatim without `<<<UNTRUSTED_...>>>` fencing into Gemini's system prompt. `StepExecutor` `sharedMemory` create/save bypasses `SharedMemoryManager` ES/Lockdown/DLP checks. |
| **FINDING-AUD-07** | **HIGH** | `FAIL` | `backend/companion/GoverningMemoryGate.ts:221-227`, `backend/server.ts:469-489`, `backend/memory/ApprovedMemoryPersistenceAdapter.ts:193-271`, `backend/memory/MemoryManager.ts:182-294`, `backend/gateway/HttpGateway.ts:264-273, 349-361, 1527-1554` | `UPDATE`/`DELETE`/`ARCHIVE`/`MERGE` proposals omit target `category`, completely bypassing step-up authentication on sensitive memories; adapter enforces no target record ownership check; `expectedVersion` optimistic locking is unwired; HTTP delete/archive endpoints falsely return HTTP `200` on queued proposals. |
| **FINDING-AUD-08** | **MEDIUM** | `FAIL` | `backend/companion/SessionContextManager.ts:32-127`, `backend/security/OutputDataFirewall.ts:45` | `sessionContextManager` singleton stores all turns in one global unpartitioned array (cross-session bleed), never enforces `sessionTimeoutMs`, and `OutputDataFirewall` regex omits `sora_dev_` device tokens. |
| **FINDING-AUD-09** | **MEDIUM** | `FAIL` | `backend/memory/MemoryStore.ts:124-141`, `backend/memory/ApprovedMemoryPersistenceAdapter.ts:156-161`, `backend/companion/GoverningMemoryGate.ts:279, 322-325`, `backend/memory/MemoryManager.ts:383-390`, `backend/memory/SharedMemoryManager.ts:146-162`, `backend/ai/GeminiSessionFactory.ts:2679` | Static `memories.json.tmp` without write queue causes concurrent save races; `proofId` consumed after `store.save()` (not fail-closed); persistence failure after token wipe leaves unapprovable zombie proposals; `getRelevantContext()` triggers `FORBIDDEN_STORAGE_WRITE` audit spam on reads; WS `memory_sync` broadcasts sensitive memory categories unfiltered. |
| **FINDING-AUD-10** | **MEDIUM** | `FAIL` | `backend/intelligence/UserPreferenceResolver.ts:13-111`, `backend/gateway/HttpGateway.ts:5361-5379` | `POST /api/intelligence/context` is unauthenticated and mutates `userPreferenceResolver.updatePreferences()` (including `autoConfirmLowRisk`, `preferredWorkspace`) with zero schema validation or provenance tracking. |

---

## 9. Unverified or Blocked Checks

| Check | Status | Reason |
|---|---|---|
| Browser / UI end-to-end verification of Memory Confirmation Modal & Persona Editor | `BLOCKED` | No headless browser / DOM test runner (`jsdom`, `happy-dom`, `@testing-library/react`, Playwright UI harness) is configured in Vitest, and live server/browser launch is out of scope for this read-only audit. |
| Live Gemini Cloud API background consolidation (`extractAndApply` against real model) | `BLOCKED` | Cloud/production network requests are prohibited by audit restrictions (§5). |
| Multi-process race verification on `memories.json.tmp` | `NOT VERIFIED` | Identified via static code inspection (`MemoryStore.ts:124`); no live concurrent-process harness executed during read-only audit. |

---

## 10. Recommended Remediation (Per Finding)

1. **`FINDING-AUD-01` (Proof-to-Request Binding):** Update `verifyGovernanceProof(proof, request)` and `ApprovedMemoryPersistenceAdapter.commitApproved()` to recompute `computePayloadHash(request.proposedMemory)` and assert exact equality on `proof.payload.requestId === request.id`, `action`, `userId`, `payloadHash`, `destinationStorage === "memories.json"`, and `targetMemoryId === request.proposedMemory.id`.
2. **`FINDING-AUD-02` (Secret Encapsulation & Single-Use Context):** Remove public exports of `getInternalPersistenceSecret()`. Colocate proof minting and verification behind a non-exported secret (or private module-internal verifier closure passed via registration), move `_consumedProofIds` consumption into `runAuthorizedPersistence()` *before* invoking `fn()`, and keep `runAuthorizedPersistence` strictly internal to `ApprovedMemoryPersistenceAdapter`.
3. **`FINDING-AUD-03` (API Auth & Alternate Persistence Governance):**
   - Immediately protect `POST /api/security/step-up/request` and `/verify` with `requireLocalhost` + `requireOperatorSession`, bind challenges to `req.operatorSession.sessionId`, and deliver the PIN strictly out-of-band (never in the HTTP response body to untrusted/remote callers).
   - Add `requireLocalhost` + `requireOperatorSession` (or `requireLocalhostOrPairedDevice`) plus Emergency Stop / Lockdown / RBAC gates to `/api/memories*`, `/api/companion/*`, `/api/ux/memory`, and `/api/brain/*`.
   - Route `CognitiveMemoryStore` writes through `GoverningMemoryGate` (or a unified governed persistence adapter) and enforce `isDlpClean` + ES/Lockdown in `/api/remote/memory/sync`.
4. **`FINDING-AUD-04` (Persona Security):** Require `requireOperatorSession` + Emergency Stop + Lockdown + audit logging on `PUT /api/companion/persona`. Validate `customPromptPrefix` (max length + `contentSanitizer.scanForPromptInjection()`), `avatarStyle`, `preferredLanguage`, and `communicationStyle` in both `validatePersonaPayload()` and `CompanionPersonaStore.savePersona()`. Reject disallowed `Origin` headers on all non-safe HTTP methods, not only `OPTIONS`.
5. **`FINDING-AUD-05` (GoverningMemoryGate Hardening):** Enforce `emergencyStopCoordinator.isActive()` and `securityPolicyEngine.getMode() === "LOCKDOWN"` at entry to `requestWrite`, `approveWrite`, `rejectWrite`, and HTTP handlers. Enforce RBAC (block `guest`/`read_only`), bind `sessionId` on `MemoryWriteRequest`, remove the `"local_operator"` wildcard/default-context fallback, require explicit admin + step-up authorization with audit logging to change `setPolicy()`, require step-up even on auto-approve (or forbid auto-approval for sensitive categories), and pass authenticated actor context into `rejectWrite()`.
6. **`FINDING-AUD-06` (Injection & DLP Defense on Stored Memories):** Run `isDlpClean()` and `contentSanitizer.scanForPromptInjection()` in `GoverningMemoryGate.requestWrite()` and `StepExecutor.ts`; fence all memories injected by `formatSystemInstructionsWithMemories()` and `MemoryManager.getRelevantContext()` with untrusted-data delimiters and neutralize directive patterns.
7. **`FINDING-AUD-07` (Update/Delete/Merge Governance):** Resolve the target record from `MemoryStore` inside `approveWrite()` / `handleApprove` so sensitive-category step-up checks evaluate the **existing** record's `category` on `UPDATE`/`DELETE`/`ARCHIVE`/`MERGE`. Enforce target ownership in `ApprovedMemoryPersistenceAdapter._applyMemoryMutation()`, wire `expectedVersion` into `MemoryWriteRequest`, return HTTP `202` (`pending_approval`) on queued delete/archive endpoints, and align `memory.test.ts` & `shared_memory.test.ts` with governed proposal semantics.
8. **`FINDING-AUD-08` (SessionContextManager Isolation & TTL):** Partition `_turns` by `sessionId` (`Map<string, SessionContextEntry[]>`), enforce `sessionTimeoutMs` eviction on read/write, and add `sora_dev_` to `OutputDataFirewall.ts:45`.
9. **`FINDING-AUD-09` (Persistence Concurrency & WS Filtering):** Serialize `MemoryStore.save()` with a write queue and unique PID+timestamp+random `.tmp` filenames; consume `proofId` fail-closed before disk write; mark failed-persistence requests terminal instead of leaving token-less zombies; remove the unauthenticated `this.store.save()` call inside `MemoryManager.getRelevantContext()`; filter sensitive categories from unstepped WS `memory_sync` broadcasts.
10. **`FINDING-AUD-10` (Preference Resolver Auth & Provenance):** Protect `POST /api/intelligence/context` with `requireLocalhost` / operator auth, validate allowed preference fields (forbid unauthenticated `autoConfirmLowRisk` / `preferredWorkspace` changes), and track per-field provenance (`persona` | `cognitive` | `operator`).

---

## 11. `LIVE_TOOLS` and Frozen-Subsystem Verification

- **`LIVE_TOOLS` Runtime Count:** `129` declarations, `129` unique names (`exit 0`, zero changes).
- **Stage 10.4.2 Preservation:** `phase10_audio_continuity.test.ts` (27/27) and `phase10_project_continuity.test.ts` (75/75) pass (`102/102`); TypeScript compiles cleanly (`exit 0`).
- **Frozen Subsystems:** Zero modifications performed to `android/`, `Desktop/`, `desktop_agent/`, `backend/device/RemoteBridge.ts`, `backend/planner/PlannerCoordinator.ts`, `backend/tools/ToolOrchestrator.ts`, or any code/test/config file during this read-only audit.

---

## 12. Final Acceptance Recommendation

**Verdict:** **`FAIL — CRITICAL SECURITY FINDINGS`**

Do **not** accept Stage 10.1 + 10.2 for production closure until all three `CRITICAL` findings (`FINDING-AUD-01`, `FINDING-AUD-02`, `FINDING-AUD-03`) and four `HIGH` findings (`FINDING-AUD-04` through `FINDING-AUD-07`) are remediated under an explicit remediation scope, and the 20 failing tests in `tests/unit/memory.test.ts` and `tests/unit/shared_memory.test.ts` are reconciled with governed memory semantics.
