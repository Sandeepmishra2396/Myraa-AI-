# MYRAA — Stage 10.7 Implementation Report
## Explainability: Decision Reasons, Evidence & Audit Visibility

**Execution Date:** 2026-11-19  
**Stage:** 10.7  
**Executive Status:** `PASS`

---

### 1. Executive Summary

MYRAA Stage 10.7 Explainability has been successfully implemented and verified. The explainability subsystem functions strictly as a read-only observer across the established MYRAA architecture, providing authorized users and administrators with transparent, evidence-grounded explanations of security decisions, policy enforcement, confirmation gates, task orchestration DAG lifecycles, and reminder occurrences.

All architectural boundaries and security invariants are strictly preserved:
- **AI = proposal, Security = decision, Firewall = enforcement, Executor = execution, Verifier = evidence**
- The explainability subsystem is purely read-only: it **never** overrides security decisions, alters risk scores, grants or revokes confirmations, triggers tool execution, modifies task plans, mutates audit logs, or treats explanations as execution authority.
- Exactly **129 unique `LIVE_TOOLS`** declarations preserved without modification.
- Emergency Stop and Security Lockdown remain absolute top-priority conditions.
- Sensitive credentials, API keys, bearer tokens, passwords, and private keys are strictly scrubbed, and user-supplied prompt-injection directives are defanged with `[DEFANGED_INSTRUCTION]` without mutating source audit ledgers.
- 100% test pass rate across focused Stage 10.7 explainability tests (`24/24 passed`).
- `npx tsc --noEmit` exited with code 0 (zero errors).
- Protected paths remained completely untouched.

---

### 2. Read-Only Discovery Findings (Batch A)

Before implementation, existing evidence sources across security, planning, reminders, and audit were inspected:

| Evidence area | Existing source | Available evidence | Missing evidence | Read-only integration |
|---|---|---|---|---|
| **Security decision** | `backend/security/SecurityPolicyEngine.ts` & `backend/security/SecurityAuditLogger.ts` | Decision type (`ALLOW`, `BLOCK`, `REQUIRE_CONFIRMATION`, `LOCKDOWN`, etc.), reason string, tool name, actor identity (`identityId`, `role`, `ipAddress`, `sessionId`), risk level (`LOW`, `MEDIUM`, `HIGH`, `CRITICAL`), timestamp, canonical SHA-256 hash. | Internal neural score calculations or factor sub-weights (deliberately not exposed to prevent evasion). | Query `SecurityAuditLogger` in-memory records and `security_audit.jsonl` filtered by event ID or actor identity. |
| **Risk assessment** | `backend/security/SecurityRiskEngine.ts` (evaluated via `SecurityPolicyEngine`) | Risk level, human-readable risk reasons (`reasons: string[]`), `requiresConfirmation: boolean`, `isCritical: boolean`. | Exact numerical weights and internal factors are scrubbed or sanitized before presentation. | Read recorded risk level and risk reasons from policy decision or audit event metadata. |
| **Confirmation** | `backend/security/SecurityPolicyEngine.ts` (`_consumedConfirmationTokens`) & `backend/planner/CheckpointManager.ts` | Token ID, tool name, argsHash, status (`CONFIRMED`, `REVOKED`, `ALREADY_CONFIRMED`), targetPath, issuedAt, expiresAt. | Raw tokens/signatures (deliberately redacted); expired/revoked reason details if token purged from memory. | Read status from `_consumedConfirmationTokens` / `SecurityAuditLogger` events (`TOOL_REQUIRE_CONFIRMATION`, `TOOL_CONFIRMED`). |
| **Tool execution** | `backend/security/ToolExecutionFirewall.ts` & `backend/planner/StepExecutor.ts` | Execution success/failure (`ok`, `error`), DLP sanitized result, `TOOL_ALLOW` or `ARGUMENT_VIOLATION` audit events, step phase, duration. | Direct execution stream or raw unsanitized output (deliberately suppressed by DLP and output firewall). | Read verified step outputs from `TaskCheckpoint.verifiedStepOutcomes` or firewall audit logs. |
| **Audit trail** | `backend/security/SecurityAuditLogger.ts` (`logs/security_audit.jsonl` + in-memory ledger) | Tamper-evident SHA-256 hash chain, event IDs, timestamps, event types (`TOOL_ALLOW`, `TOOL_BLOCKED`, `EMERGENCY_STOP_TRIGGERED`, etc.), actor identity, sanitized target and reason. | Events beyond in-memory window if log file unreadable; un-redacted credentials. | Read via `securityAuditLogger.getRecentEvents()`, `getEventsBySession()`, `getCanonicalEvents()`, or read file safely. |
| **Task orchestration** | `backend/planner/TaskOrchestrator.ts` & `backend/planner/PlanStore.ts` | `TaskPlan` status, `PlanStep[]` states and phases, `TaskCheckpoint[]` (version, safe boundary, completed/pending step IDs, verified outcomes, `uncertainStepIds`, `auditCorrelationId`), cancellation reasons. | In-flight transient sub-step memory if process abruptly crashed without reaching a checkpoint boundary. | Read persisted plans and checkpoints via `planStore.getPlanWithProjectIsolation(id, projectId)`. |
| **Reminders** | `backend/reminders/ReminderStore.ts`, `ReminderGovernance.ts`, `ReminderDeliveryManager.ts` | `Reminder` status, `approval` record (`approvedBy`, `approvedAt`, `contentHash`, `token`), `occurrences` (status: `scheduled`, `due`, `delivered`, `failed`, `delivery_unknown`, `claimedAt`, `deliveredAt`, `deliveryKey`), `auditCorrelationId`. | Persistent multi-instance delivery history (Stage 10.6 uses in-memory claim set, persistent record is in `occurrences`). | Read stored reminders and occurrences via `reminderStore.getReminderForUser(id, userId)` or `listRemindersForUser`. |

---

### 3. Actual Evidence Sources & Correlation Mechanisms

- **Correlation by Explicit IDs Only**:
  The explainability engine strictly rejects temporal proximity guessing. Correlation requires matching one or more explicit identifiers:
  1. `auditId` / `eventId`: Exact match on `SecurityAuditEvent.id` or `eventId`.
  2. `planId`: Exact match on `TaskPlan.id` and associated `TaskCheckpoint.id`.
  3. `stepId`: Exact match on `PlanStep.id` within a verified plan.
  4. `reminderId`: Exact match on `Reminder.id`.
  5. `occurrenceId`: Exact match on `ReminderOccurrence.occurrenceId`.
  6. `auditCorrelationId`: Cross-component link explicitly stamped during checkpoint creation, cancellation, or reminder delivery.
- **Verification Integrity**:
  An evidence record is marked `verified: true` only if rooted in a cryptographically signed hash (such as `SecurityAuditEvent.hash` matching SHA-256 integrity check) or durable store entity (`TaskCheckpoint`, `ReminderOccurrence`).
- **Limitation Disclosures**:
  If an evidence record cannot be located, the system marks the status as `"unavailable"` and emits explicit limitation notes rather than hallucinating or guessing.

---

### 4. Exact Files Created and Modified

#### Files Created:
1. `backend/explainability/ExplainabilityTypes.ts` — Type contracts, bounded limits, normalized reason categories, and explanation query schemas.
2. `backend/explainability/ExplainabilityFormatter.ts` — Secret scrubbing, regex credential redaction, prompt injection defanging, and human-readable reason interpretation generator.
3. `backend/explainability/ExplainabilityEvidenceReader.ts` — Read-only evidence reader querying audit logs, plan stores, checkpoints, and reminder stores with strict explicit correlation.
4. `backend/explainability/ExplainabilityService.ts` — Core service providing `explainSecurityDecision`, `explainTaskOrchestration`, `explainReminderLifecycle`, and `explainByCorrelationId` with strict identity and project authorization.
5. `backend/explainability/index.ts` — Public module barrel exports.
6. `tests/unit/explainability/explainability.test.ts` — Comprehensive 24-test unit test suite.

#### Files Modified:
- *None.* All implementation was contained strictly within `backend/explainability/**` and `tests/unit/explainability/**`.

---

### 5. Explanation Data Model & Supported Categories

#### 1. Core Distinction Between Explanation Facets:
- **Decision**: What the system actually decided (e.g. `ALLOW`, `BLOCK`, `REQUIRE_CONFIRMATION`, `DELIVERED`, `DELIVERY_UNKNOWN`, `PAUSED`).
- **Reason**: The recorded normalized reason category supporting that decision (e.g. `ROLE_PERMISSION_DENIED`, `PATH_TRAVERSAL_BLOCKED`, `CONFIRMATION_INVALID`, `EMERGENCY_STOP_ACTIVE`).
- **Evidence**: Verified records from audit ledgers, checkpoints, plan steps, and reminder occurrences.
- **Interpretation**: Safe, plain-language description explaining the policy or system rule behind the recorded facts.
- **Unknown**: Explicit list of facts that could not be verified or were absent from recorded evidence.

#### 2. Supported Event & Reason Categories:
- **Security Decisions**:
  - `ALLOWED`: Request permitted under active security policy and role permissions.
  - `ROLE_PERMISSION_DENIED`: Blocked because caller role lacks permission for the tool.
  - `CRITICAL_PATTERN_BLOCKED`: Blocked due to hazardous shell tokens, destructive script patterns, or critical security rules.
  - `PATH_TRAVERSAL_BLOCKED`: Blocked because target path resolves outside active workspace boundary.
  - `CONFIRMATION_REQUIRED`: State-altering or high-risk tool requiring explicit human approval.
  - `CONFIRMATION_INVALID`: Token argument hash mismatch or parameter tampering detected.
  - `CONFIRMATION_EXPIRED`: Confirmation token TTL (10 minutes) exceeded before execution.
  - `CONFIRMATION_REVOKED`: Confirmation token was explicitly revoked.
  - `EMERGENCY_STOP_ACTIVE`: Operation halted due to active global Emergency Stop.
  - `SECURITY_LOCKDOWN_ACTIVE`: Operation blocked due to fail-closed Security Lockdown mode.
  - `TOOL_DISABLED`: Operation blocked because tool was dynamically disabled by containment.
  - `EXECUTION_FAILED`: Security policy permitted the action, but tool runtime failed.
- **Task Orchestration**:
  - `PLAN_CREATED`: Task plan initialized.
  - `STEP_PENDING` / `STEP_RUNNING` / `STEP_COMPLETED` / `STEP_FAILED`: Step execution DAG transitions.
  - `AWAITING_APPROVAL`: Plan paused at safe checkpoint boundary awaiting confirmation.
  - `PLAN_CANCELLED`: Plan halted upon request; uncompleted modifying steps safely stopped.
  - `CHECKPOINT_CREATED`: Durable execution progress recorded at verified boundary.
  - `RECOVERY_ACCEPTED`: Plan safely restored from latest valid checkpoint.
  - `UNCERTAIN_SIDE_EFFECT` / `RECONCILIATION_REQUIRED`: Modifying steps interrupted mid-execution; manual human reconciliation mandatory.
- **Reminder Lifecycle**:
  - `PROPOSAL_CREATED` / `AWAITING_APPROVAL`: Drafted reminder awaiting explicit approval.
  - `APPROVAL_REVOKED` / `APPROVAL_HASH_MISMATCH`: Approval cleared due to parameter edits.
  - `REMINDER_SCHEDULED`: Approved and registered in precision scheduler.
  - `NOTIFICATION_DELIVERED`: Successfully dispatched to local notification hub.
  - `DELIVERY_UNKNOWN`: Notification hub returned indeterminate or unconfirmed outcome.
  - `DELIVERY_FAILED`: Suppressed by Emergency Stop, Lockdown, or system error.

---

### 6. Security Decision Explanation Behavior

- **Grounded in Actual Recorded Reasons**: Explanations reflect the exact recorded reason string and event type. A blocked action is never attributed to a policy unless that policy was recorded as the cause.
- **Preserved Invariant Distinctions**: Clear distinctions are maintained between role permission denials, suspicious pattern blocks, confirmation invalidation, and execution errors.
- **Safe Next Steps**: Safe, approved follow-up workflows are suggested (e.g. "Review proposed parameters and confirm via dialog", "Request role privileges from workspace administrator", "Reset Emergency Stop via designated recovery tool").
- **Zero Bypass Recommendations**: The engine **never** advises bypassing confirmation, modifying firewall rules, or circumventing stop conditions.
- **No Leaked Internal Mechanics**: Numerical risk weights, private scoring thresholds, and internal regex evasion patterns are not exposed.

---

### 7. Task and Reminder Explanation Behavior

- **Task Orchestrator & Checkpoint Integrity**:
  - Explains step status, target tool, phase, and dependencies.
  - Explains safe checkpoints, showing completed vs pending steps.
  - For interrupted destructive steps, explicitly reports `UNCERTAIN_SIDE_EFFECT` and notes that `forceReconciliation` alone does not prove changes succeeded without manual verification.
- **Reminders & Delivery Limitations**:
  - Explains proposal status, explicit approval requirement, and approval hash binding.
  - Explains delivery outcomes: `delivered`, `failed`, or `delivery_unknown`.
  - Discloses known limitations: clearly notes that delivery confirmation establishes local hub dispatch, and cross-restart multi-instance deduplication is bounded by persistent occurrence records.

---

### 8. Redaction, Prompt-Injection Defense & Evidence Integrity

- **Deep Secret Scrubbing (`ExplainabilityFormatter`)**:
  - Automatically scrubs:
    - Gemini / Google API keys (`AIza...[REDACTED]`)
    - OpenAI / Anthropic keys (`sk-...[REDACTED]`)
    - Sora / MYRAA token families (`sora_...[REDACTED]`, `myraa_...[REDACTED]`)
    - JWT tokens (`eyJ...[REDACTED]`)
    - Bearer authorization headers (`Bearer [REDACTED]`)
    - GitHub tokens (`gh_...[REDACTED]`)
    - AWS access keys (`AKIA...[REDACTED]`)
    - PEM private keys (`[PRIVATE_KEY_REDACTED]`)
    - Passwords, credentials, and authentication secrets
- **Prompt-Injection Defanging**:
  - User-controlled strings and audit payloads containing prompt-injection phrasing (`ignore all previous instructions`, `system prompt:`, `disregard all rules`, `developer mode`, `admin override`, `now act as`) are replaced with `[DEFANGED_INSTRUCTION]`.
- **Zero In-Place Mutation**:
  - Scrubbing operates strictly on cloned projections for presentation. Source audit ledgers, checkpoint records, and reminder files are **never** mutated. Hash chain integrity remains unbroken.
- **Fail-Closed Safeguard**:
  - If serialization or scrubbing throws an unexpected error, the formatter fails closed, returning `[REDACTION_ERROR_SAFEGUARD]` with `success: false`.
- **Bounded Output**:
  - Strings are capped at `MAX_EXPLANATION_TEXT_LENGTH = 5000` chars with `[TRUNCATED]`.
  - Evidence records are bounded to `MAX_EVIDENCE_PER_EXPLANATION = 20` items.

---

### 9. User and Project Isolation Evidence

- **Caller Authentication**: Every request requires a valid `SecurityContext.identityId`. Missing or empty identities throw `UNAUTHORIZED`.
- **Cross-User Protection**:
  - Standard users cannot access audit events where `actor.identityId !== context.identityId` (`CROSS_USER_ACCESS_DENIED`).
  - Administrators (`role === "admin"`) are permitted to inspect security events across the workspace for operational defense.
  - Reminders are strictly isolated by `userId`: User A cannot explain or inspect User B's reminders.
- **Cross-Project Isolation**:
  - Explaining a task plan requires project verification via `planStore.getPlanWithProjectIsolation(planId, projectId)`.
  - Reminders linked to Project A cannot be queried under Project B (`CROSS_PROJECT_ACCESS_DENIED`).
- **Event-ID Guessing Resistance**:
  - Possessing a raw event ID or UUID does not grant authorization. The underlying record's ownership is validated against `context.identityId`.

---

### 10. Focused Test Results

- **Command:** `npm test -- tests/unit/explainability/explainability.test.ts`
- **Result:** `PASS`
- **Exit Code:** `0`
- **Tests Passed:** `24 / 24` (0 failed, 0 skipped)
- **Duration:** `2.62s`

#### Breakdown of Tested Behaviors:
1. *Explanation Correctness & Category Classification* (7 tests):
   - `explains an ALLOWED decision with verified audit evidence and recorded reason` — PASS
   - `retains the exact recorded reason category for ROLE_PERMISSION_DENIED` — PASS
   - `distinguishes PATH_TRAVERSAL_BLOCKED from generic policy denial` — PASS
   - `distinguishes CONFIRMATION_REQUIRED, CONFIRMATION_INVALID, and CONFIRMATION_EXPIRED` — PASS
   - `distinguishes execution failure from policy/dispatch block` — PASS
   - `reports missing evidence as 'unavailable' and never represents unknown outcomes as success` — PASS
   - `explains EMERGENCY_STOP_ACTIVE and SECURITY_LOCKDOWN_ACTIVE with safe recovery guidance` — PASS
2. *Task & Reminder Evidence Grounding* (4 tests):
   - `explains task plan step lifecycle using verified plan records` — PASS
   - `explains uncertain side-effect and reconciliation requirement` — PASS
   - `explains reminder approval, delivery, and delivery_unknown without unsupported exactly-once claims` — PASS
   - `explainByCorrelationId correlates across plans, reminders, and audit records` — PASS
3. *Security & Data Handling* (6 tests):
   - `redacts API keys, tokens, credentials, and passwords from all explanation outputs` — PASS
   - `defangs prompt-injection instruction text embedded in evidence` — PASS
   - `never mutates the underlying source audit records during explanation generation` — PASS
   - `enforces bounded explanation text lengths` — PASS
   - `fails closed safely if redaction fails` — PASS
   - `handles malformed JSON lines in audit log file without throwing or crashing` — PASS
4. *Access Isolation & Authorization* (5 tests):
   - `denies cross-user security decision access (User B cannot view User A's audit event)` — PASS
   - `permits admin role to inspect security audit events across users` — PASS
   - `denies cross-user reminder explanation access (User B cannot view User A's reminder)` — PASS
   - `strictly isolates task plans between Project A and Project B` — PASS
   - `event-ID guessing does not bypass authorization` — PASS
5. *Architectural & Safety Invariants* (2 tests):
   - `never mutates security decisions or confirmation records during queries` — PASS
   - `strictly preserves LIVE_TOOLS invariant at exactly 129 tools` — PASS

---

### 11. TypeScript Compilation Result

- **Command:** `npx tsc --noEmit`
- **Result:** `PASS`
- **Exit Code:** `0`
- **Errors:** `0`

---

### 12. `LIVE_TOOLS` Registry Integrity

- **Command:** `npm test -- tests/unit/platform.test.ts -t "LIVE_TOOLS"`
- **Result:** `PASS`
- **Exit Code:** `0`
- **Total Declarations:** Exactly `129`
- **Unique Tool Names:** Exactly `129`
- **Tool Modifications:** `0`

---

### 13. Protected-File Verification

All out-of-scope and protected paths remained completely untouched:
- `backend/security/**` — UNTOUCHED
- `backend/server.ts` — UNTOUCHED
- `backend/tools/**` — UNTOUCHED
- `backend/ai/GeminiSessionFactory.ts` — UNTOUCHED
- `backend/planner/**` — UNTOUCHED
- `backend/reminders/**` — UNTOUCHED
- `backend/companion/**` — UNTOUCHED
- `backend/memory/**` — UNTOUCHED
- `backend/projects/**` — UNTOUCHED
- `backend/device/**` — UNTOUCHED
- `android/**` — UNTOUCHED
- `electron/**` — UNTOUCHED
- `desktop_agent/**` — UNTOUCHED
- All `LIVE_TOOLS` declarations — UNTOUCHED

---

### 14. Missing Evidence & Limitations Disclosure

- **Multi-Instance / Cross-Restart Exactly-Once Reminder Delivery**: Mark as `NOT VERIFIED`. The Stage 10.6 in-memory claim set ensures local single-process deduplication; cross-restart or multi-instance delivery history relies on persistent occurrence state in `reminders.json`. The explainability service explicitly notes this limitation in delivery explanations.
- **Unverified Resumption**: Mark as `NOT VERIFIED`. The orchestrator's `forceReconciliation` flag marks that an operator acknowledged an uncertain step, but does not prove the underlying disk or environmental side effect succeeded. The explainability service highlights that manual verification of workspace state is required.
- **Aged-out Audit Records**: If an event ID is queried after being rotated out of in-memory buffers and log files, the completeness status is safely marked `unavailable`.

---

### 15. Stage Boundary Confirmation

Stage 10.7 Explainability is complete.  
Stage 10.8 Final Regression and deployment workflows were **NOT** started.  
Execution has safely stopped to await user review and subsequent roadmap prompts.
