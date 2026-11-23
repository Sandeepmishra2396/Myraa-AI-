# MYRAA — Stage 10 Phase 1: Final Implementation Specification
## Companion Core — Persona Management & Governing Memory Gate

**Document ID:** `stage10_phase1_final_implementation_spec.md`  
**Generated:** 2026-10-30T23:14:00+05:30  
**Author:** Antigravity AI Engineering Platform  
**Scope:** Stage 10 Phase 1 (Combined Tracks 10.1 & 10.2)  
**Mode:** Implementation Specification Only. Read-Only Planning. ZERO production code, tests, or configurations modified.  
**Prerequisite:** Requires explicit operator review and written approval prior to execution.

---

## 1. Executive Summary & Phase 1 Scope

Stage 10 Phase 1 establishes the bedrock identity, session context, and memory sovereignty mechanisms of the MYRAA Companion Core. To guarantee that user preferences and long-term memory cannot be silently corrupted or manipulated by untrusted conversation turns or malicious agent tools, Phase 1 delivers **Phase 10.1 (CompanionPersona)** and **Phase 10.2 (GoverningMemoryLayer)** as a single, combined, gated unit.

### Core Objectives
1. **Persona & Preferences (Tier 2):** Provide dedicated storage (`companion_persona.json`) for user communication preferences, avatar settings, and display name, strictly isolated from the episodic memory system.
2. **Governing Memory Gate (Tier 3 Gate):** Establish an immutable security checkpoint required for every permanent write to `memories.json`, defaulting to `"always_ask"` with cryptographic payload binding.
3. **Session Context Ring Buffer (Tier 1):** Provide a fast, transient, in-memory 50-turn conversation buffer with automatic DLP redaction and zero unsolicited disk writes.
4. **Preserve Invariants:** 129 LIVE_TOOLS preserved, zero regressions in existing test suites (Stages 1–9: 252/252 PASS, Units: 338/338 PASS).

---

## 2. File Architecture & Necessity Assessment

To avoid code bloat and unnecessary architectural duplication, each proposed file for Phase 1 has been rigorously evaluated against existing Stage 1–9 components.

### 2.1 Proposed New Files (5 Total) — Necessity Audit

| File Path | Necessity | Rationale & Architectural Safeguards |
|:---|:---:|:---|
| `backend/companion/CompanionPersonaTypes.ts` | **MANDATORY** | Pure TypeScript type definitions (`CompanionPersona`, `CommunicationStyle`). Zero runtime dependencies or side effects. |
| `backend/companion/CompanionPersonaStore.ts` | **MANDATORY** | Atomic persistence manager for `companion_persona.json`. Adopts the battle-tested atomic write pattern from `backend/companion/CompanionStore.ts` (write to `.tmp` → atomic rename with EPERM retry). Strictly isolated from `MemorySearch` and `MemoryDeduplicator`. |
| `backend/companion/GoverningMemoryTypes.ts` | **MANDATORY** | Type contracts for memory approval (`MemoryWriteRequest`, `MemoryWritePolicy`, `MemoryWriteApproval`, `MemoryWriteAction`). Includes cryptographic `payloadHash` field. |
| `backend/companion/GoverningMemoryGate.ts` | **MANDATORY** | In-memory pending-request registry, SHA-256 payload verification, 24-hour expiration reaper, and security audit integration. Does NOT write directly to disk; delegates to `MemoryManager.add()` only upon verified user approval. |
| `backend/companion/SessionContextManager.ts` | **MANDATORY** | Transient in-memory 50-turn ring buffer. Sanitizes all inputs via `ContentSanitizer`. Prevents silent disk growth (zero file writes). Distinct from project-scoped `backend/projects/ContextManager.ts`. |

### 2.2 Proposed Modified Files (3 Total) — Scoped Additions

| File Path | Modification Scope | Safeguards & Boundary Rules |
|:---|:---|:---|
| `backend/intelligence/UserPreferenceResolver.ts` | **MINIMAL (Additive)** | Add optional `loadFromPersonaStore(store: CompanionPersonaStore)` method. On initialization, if `companion_persona.json` exists, overlay persona communication preferences onto the internal map. Invariant preserved: explicit current turn instruction ALWAYS overrides persona defaults. |
| `backend/companion/CompanionCoordinator.ts` | **MINIMAL (Additive)** | In `start()`, instantiate `GoverningMemoryGate.getInstance()` and launch the 1-hour periodic `expireStale()` timer. In `stop()`, clear the timer. ~6 lines of code added. |
| `backend/server.ts` | **MINIMAL (Additive)** | Mount 5 local-only REST routes under `/api/companion/`. Zero modifications to existing routes or middleware. |

### 2.3 Files Explicitly Excluded from Phase 1

> [!CAUTION]
> The following files are strictly **FROZEN** and must NOT be touched during Phase 1:
> - `backend/memory/MemoryManager.ts` — Phase 1 routes call `MemoryManager.add()` externally upon user approval; internal wrapping of `MemoryManager` methods is deferred to Phase 2.
> - `backend/brain/AdaptivePromptSynthesizer.ts` — Prompt synthesis changes are deferred to Phase 10.4 (`AdaptiveContextRetriever`).
> - `backend/planner/PlannerCoordinator.ts` — Planner events are deferred to Phase 10.5 (`CompanionTaskOrchestrator`).
> - `backend/ai/GeminiSessionFactory.ts` — READ ONLY. Zero tool declarations added or removed.
> - `electron/`, `android/`, `desktop_agent/tools_browser.py`, `desktop_agent/egress_proxy.py`.
> - All Stage 1 through Stage 9 test files.

---

## 3. Data Models & Interfaces

### 3.1 Companion Persona Types
```typescript
// backend/companion/CompanionPersonaTypes.ts

export type VerbosityLevel = "concise" | "normal" | "detailed";
export type FormalityLevel = "casual" | "professional";
export type EmotionalTone = "warm" | "neutral" | "direct";

export interface CommunicationStyle {
  verbosity: VerbosityLevel;
  formality: FormalityLevel;
  emotionalTone: EmotionalTone;
}

export interface CompanionPersona {
  id: string;                        // Fixed: "persona_default"
  displayName: string;               // e.g., "MYRAA"
  avatarStyle: "idle" | "talking" | "thinking";
  preferredLanguage: string;         // "hinglish" | "english" | "hindi"
  communicationStyle: CommunicationStyle;
  customPromptPrefix?: string;       // User-defined system instructions
  updatedAt: string;                 // ISO8601
  createdAt: string;                 // ISO8601
}
```

### 3.2 Governing Memory Types
```typescript
// backend/companion/GoverningMemoryTypes.ts
import { EnhancedMemory, MemorySource } from "../memory/MemoryTypes";

export type MemoryWriteAction = "CREATE" | "UPDATE" | "ARCHIVE";

export type MemoryWritePolicy =
  | "always_ask"                    // MANDATORY DEFAULT: all writes require user approval
  | "auto_approve_high_confidence"  // UNRECOMMENDED OPT-IN: confidence >= 0.85
  | "session_only";                 // Reject all long-term persistence attempts

export interface MemoryWriteRequest {
  id: string;                       // UUID v4
  requestedAt: string;              // ISO8601
  action: MemoryWriteAction;
  proposedMemory: Partial<EnhancedMemory>;
  payloadHash: string;              // SHA-256 of canonical JSON string of proposedMemory
  reason: string;                   // Human-readable explanation shown in confirmation modal
  confidence: number;               // 0.0 to 1.0
  source: MemorySource;
  userId: string;                   // "default"
  provenance: string;               // Originating turn or detector trace ID
  approved?: boolean;               // undefined = pending, true = approved, false = rejected
  approvedAt?: string;
  rejectedAt?: string;
  oneTimeToken: string;             // Ephemeral token bound to payloadHash
  expiresAt: string;                // Date.now() + 24 hours
}

export interface MemoryWriteApproval {
  requestId: string;
  approved: boolean;
  token: string;
  modifiedMemory?: Partial<EnhancedMemory>; // If user edited memory in approval dialog
}
```

### 3.3 Session Context Types
```typescript
// backend/companion/SessionContextTypes.ts

export interface SessionContextEntry {
  turnId: string;
  timestamp: string;                // ISO8601
  role: "user" | "assistant" | "system";
  content: string;                  // Sanitized via ContentSanitizer
  topics?: string[];
  sensitiveRedacted: boolean;
}

export interface SessionContextConfig {
  maxRingBufferSize: number;        // Immutable: 50 turns
  sessionTimeoutMs: number;         // 30 minutes
}
```

---

## 4. Permission Boundaries & Security Architecture

```
+-----------------------------------------------------------------------------------+
| USER INTERACTION (Frontend / Localhost UI)                                        |
+-----------------------------------------------------------------------------------+
       |                                                |
       | PUT /api/companion/persona                     | POST /api/companion/memory/...
       v                                                v
+-------------------------------+              +------------------------------------+
| Tier 2: CompanionPersonaStore |              | Tier 3 Gate: GoverningMemoryGate   |
| Writes: companion_persona.json|              | In-Memory Registry (24h Expiry)    |
| Atomic tmp->rename            |              | SHA-256 Payload Hash Verification  |
+-------------------------------+              +------------------------------------+
                                                        | User Approved & Token Valid
                                                        v
                                               +------------------------------------+
                                               | backend/memory/MemoryManager.ts    |
                                               | Writes: memories.json              |
                                               +------------------------------------+

+-----------------------------------------------------------------------------------+
| CONVERSATION IN-FLIGHT (Tier 1: Transient)                                        |
| SessionContextManager: In-memory ring buffer (50 turns) -> ContentSanitizer applied|
| Zero disk writes permitted                                                        |
+-----------------------------------------------------------------------------------+
```

### 4.1 Storage Tier Separation Invariants
1. **Tier 1 (Session Context):** Pure RAM storage. Absolutely no writes to disk by default. All turns pass through `ContentSanitizer.sanitize()` before being placed in the buffer.
2. **Tier 2 (User Preferences):** Persisted in `companion_persona.json`. Never read or queried by `MemorySearch`, `MemoryExtractor`, or `MemoryDeduplicator`.
3. **Tier 3 (Governed Memory):** Persisted in `memories.json`. Completely closed to background agent writes. Only `GoverningMemoryGate.approveWrite()` can trigger `MemoryManager.add()`.

### 4.2 Cryptographic Payload Binding
- At creation time, `GoverningMemoryGate.requestWrite()` computes:
  $$\text{payloadHash} = \text{SHA-256}(\text{canonicalJson}(\text{proposedMemory}))$$
- An ephemeral `oneTimeToken` is generated and bound to `(id + payloadHash + userId + expiresAt)`.
- If an attacker or compromised component mutates the payload before `approveWrite()` is submitted, the hashes mismatch.
- Upon mismatch:
  1. The gate throws `PAYLOAD_TAMPERED`.
  2. The request is immediately invalidated.
  3. A high-risk audit event `MEMORY_WRITE_TAMPERED` is logged via `SecurityAuditLogger`.
  4. Zero writes occur to `memories.json`.

---

## 5. Precise Failure Behaviors

| Scenario | Component | Expected System Behavior | Audit Action |
|:---|:---|:---|:---|
| Missing `companion_persona.json` on boot | `CompanionPersonaStore` | Loads default persona (`MYRAA`, `idle`, `hinglish`, `normal/casual/warm`), writes initial file atomically. Never throws. | Log `PERSONA_INITIALIZED` |
| Corrupted `companion_persona.json` | `CompanionPersonaStore` | Catches JSON parse error, logs error, loads defaults safely in-memory. Does NOT overwrite corrupted file until valid save. | Log `PERSONA_CORRUPTION_FALLBACK` |
| `requestWrite()` with `policy="session_only"` | `GoverningMemoryGate` | Throws `POLICY_PROHIBITS_WRITE` synchronously. Request is discarded. Zero records stored. | None (blocked by contract) |
| `approveWrite()` with tampered payload | `GoverningMemoryGate` | Throws `PAYLOAD_TAMPERED`. Request removed from registry. Zero memory writes. | Log `MEMORY_WRITE_TAMPERED` (HIGH) |
| `approveWrite()` on expired request (> 24h) | `GoverningMemoryGate` | Throws `REQUEST_EXPIRED`. Zero memory writes. | Log `MEMORY_WRITE_EXPIRED` (LOW) |
| Double-approval of same `requestId` | `GoverningMemoryGate` | Idempotent handling: second call detects `approved === true`, returns existing memory without invoking `MemoryManager.add()` again. | None |
| Rejection of request | `GoverningMemoryGate` | Sets `approved: false`, purges proposed memory from RAM, zero disk write. | Log `MEMORY_WRITE_REJECTED` |
| `appendTurn()` exceeds 50 turns | `SessionContextManager` | Drops the oldest turn (index 0), appends new turn at index 49. Invariant: `turns.length <= 50`. | None |
| `appendTurn()` with API key or secret | `SessionContextManager` | Passes through `ContentSanitizer`. Secrets replaced with `[REDACTED_*]`. Raw secret never enters RAM. | Log `CONTENT_SANITIZED` |

---

## 6. Comprehensive Test Specification (21 Unit Tests + 6 Regression Gates)

### 6.1 Test Suite: `tests/unit/companion_core_phase1.test.ts`

#### Group 1: CompanionPersonaStore (5 Tests)
- `CP01.1`: Default persona loads successfully when `companion_persona.json` does not exist.
- `CP01.2`: Persona modifications persist across store `save()` and `load()` cycles.
- `CP01.3`: `PUT /api/companion/persona` updates `displayName` and persists atomically via temporary file.
- `CP01.4`: `CommunicationStyle` fields (`verbosity`, `formality`, `emotionalTone`) serialize and deserialize cleanly.
- `CP01.5`: Storage isolation: `companion_persona.json` content is never indexed or returned by `MemorySearch`.

#### Group 2: GoverningMemoryGate (10 Tests)
- `CP02.1`: `requestWrite()` generates a valid pending `MemoryWriteRequest` with `payloadHash` and `approved=undefined`.
- `CP02.2`: `approveWrite()` with matching `payloadHash` calls `MemoryManager.add()` exactly once and logs `MEMORY_WRITE_APPROVED`.
- `CP02.3`: `rejectWrite()` marks request rejected, does NOT invoke `MemoryManager.add()`, and logs `MEMORY_WRITE_REJECTED`.
- `CP02.4`: `expireStale()` purges requests older than 24 hours without triggering memory persistence.
- `CP02.5`: Default policy `"always_ask"` prevents auto-approval even when `confidence = 0.99`.
- `CP02.6`: Opt-in policy `"auto_approve_high_confidence"` automatically approves when `confidence >= 0.85`.
- `CP02.7`: Policy `"session_only"` immediately throws an error on `requestWrite()`, creating zero pending entries.
- `CP02.8`: Attempting to approve an unknown or non-existent `requestId` throws `REQUEST_NOT_FOUND`.
- `CP02.9`: Tamper resistance: Modifying `proposedMemory` after request issuance causes `approveWrite()` to fail-closed with `PAYLOAD_TAMPERED`.
- `CP02.10`: Double-approve idempotency: Invoking `approveWrite()` twice on the same request results in a no-op on the second call with zero duplicate writes.

#### Group 3: SessionContextManager (6 Tests)
- `CP03.1`: `appendTurn()` stores conversation turns and `getTurns()` retrieves them in exact FIFO order.
- `CP03.2`: Turn buffer bound: The 51st call to `appendTurn()` evicts turn 0, maintaining exactly 50 turns.
- `CP03.3`: `clearSession()` flushes all turns and resets the buffer to empty.
- `CP03.4`: DLP Sanitization: Turns containing Google AI API key strings (`AIza...`) are redacted to `[REDACTED_GEMINI_KEY]`.
- `CP03.5`: Zero disk persistence: Calling `appendTurn()` 100 times creates zero files on disk.
- `CP03.6`: Defensive copy: Mutating the array returned by `getTurns()` does not alter the internal ring buffer.

### 6.2 Regression Gates (6 Mandatory Checks)
- `REG-P1.1`: `npx tsc --noEmit` exits with code 0 (zero compile or type errors).
- `REG-P1.2`: `npx tsx` dynamic tool count check outputs `COUNT=129 UNIQUE=129`.
- `REG-P1.3`: Unit test suite: `npx vitest run tests/unit/` reports 359/359 passing (338 existing + 21 new).
- `REG-P1.4`: Stage regression: `npx vitest run tests/integration/stage1_*` through `stage9_*` reports 252/252 passing.
- `REG-P1.5`: Production build: `npm run build` exits with code 0.
- `REG-P1.6`: File tree cleanliness: `git status --porcelain` reveals zero untracked `.db`, `.sqlite`, or `.bin` files.

---

## 7. Downstream Planning: PlanStore Audit Mandate

> [!IMPORTANT]
> **Mandatory Action Before Phase 10.3 (ProjectContinuityEngine):**
> Prior to authoring any new code for `ProjectContinuityStore.ts`, the developer must inspect [`backend/planner/PlanStore.ts`](file:///d:/SORA AI/Sora AI/backend/planner/PlanStore.ts).
> - If `PlanRecord` already stores task goals, execution status, step sequences, and project identifiers, `ProjectContinuityStore` must be implemented solely as a **read-only aggregation view** over `PlanStore`.
> - Creating a separate, redundant `project_continuity.json` file is strictly prohibited if `PlanStore` already contains the requisite state.

---

## 8. Pre-Implementation Verification Checklist

Before any code is modified for Phase 1, the following baseline commands must be executed and confirmed:

```bash
# 1. Verify TypeScript compiles cleanly
npx tsc --noEmit

# 2. Verify tool count invariant
npx tsx -e "import { GeminiSessionFactory } from './backend/ai/GeminiSessionFactory'; const tools = GeminiSessionFactory.getLiveTools(); console.log('COUNT=' + tools.length + ' UNIQUE=' + new Set(tools.map(t => t.name)).size);"

# 3. Verify Stage 1-9 regression baseline
npx vitest run tests/integration/stage1_ tests/integration/stage2_ tests/integration/stage3_ tests/integration/stage4_ tests/integration/stage5_ tests/integration/stage6_ tests/integration/stage7_ tests/integration/stage8_ tests/integration/stage9_
```

---

## 9. Operator Approval Gate

> [!IMPORTANT]
> **STOP AND WAIT FOR OPERATOR APPROVAL.**
> All three planning deliverables are complete and aligned:
> 1. `myraa_p0_final_closure_report.md` (P0 closure evidence reconciled)
> 2. `stage10_companion_core_architecture_proposal.md` (Full 7-pillar architecture specification)
> 3. `stage10_phase1_final_implementation_spec.md` (Precise Phase 1 implementation guide)
>
> Zero production code, tests, configuration, or database files have been modified. No changes will be implemented until the operator reviews these documents and gives explicit written authorization.

---

*Report generated by Antigravity AI Engineering Platform — Phase 1 Implementation Specification. All rights reserved.*
