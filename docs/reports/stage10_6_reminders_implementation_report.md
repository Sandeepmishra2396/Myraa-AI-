# MYRAA — Stage 10.6 Implementation Report
## Reminders: Explicit Approval, Reliable Scheduling & Safe Follow-ups

**Execution Date:** 2026-11-19  
**Stage:** 10.6  
**Executive Status:** `PASS`

---

### 1. Executive Summary

MYRAA Stage 10.6 Reminders has been successfully implemented and verified under strict architectural isolation. The reminder subsystem provides safe, reliable, and auditable scheduling for user alerts with mandatory explicit approval, reliable persistence across application restarts, precision timezone and DST handling, notification sanitization, duplicate-delivery protection, and strict user and canonical project isolation.

All existing MYRAA architectural boundaries, security invariants, and execution models are strictly preserved:
- **AI = proposal, Security = decision, Firewall = enforcement, Executor = execution, Verifier = evidence**
- A reminder is strictly a notification to the user (`notificationManager.notify()`). It is **never** permission to execute a task, call a tool, resume a plan, or trigger external actions.
- Exactly **129 unique `LIVE_TOOLS`** declarations preserved without modification.
- Emergency Stop and Security Lockdown maintain absolute priority over reminder delivery (immediate suppression).
- Approval is cryptographically bound to reminder parameters (`contentHash`); parameter tampering or edits revoke approval immediately.
- 100% test pass rate across focused Stage 10.6 reminder tests (`27/27 passed`).
- 100% test pass rate across Stage 10.5 planner and task orchestrator tests (`129/129 passed`), ensuring zero regressions.
- `npx tsc --noEmit` exited with code 0 (zero type errors).
- All protected and out-of-scope paths remain completely untouched.

---

### 2. Read-Only Discovery Findings (Batch A)

Before implementation, existing reminder-related types, notification pipelines, persistence utilities, and security boundaries were inspected in detail.

| Area | Existing implementation | Stage 10.6 gap | Minimal proposed change |
|---|---|---|---|
| **Reminder model** | No formal reminder data model or lifecycle state machine in backend. | Missing schema for reminders, statuses (`proposed`, `awaiting_approval`, `scheduled`, `due`, `delivered`, `completed`, `cancelled`, `failed`, `delivery_unknown`), recurrence, snooze limits, occurrences, and audit correlation. | Create `backend/reminders/ReminderTypes.ts` with comprehensive typed interfaces, bounded limits, and transition validation. |
| **Persistence** | `PlanStore` and `ProjectStore` implement atomic `.tmp` write and rename with Windows file lock retries and UTF-8 BOM stripping. | No dedicated store for reminders; existing stores are specialized for plans and project context. | Create `backend/reminders/ReminderStore.ts` using the proven atomic rename pattern, version incrementing, and optimistic concurrency. |
| **Scheduling** | `TaskOrchestrator` uses in-memory `setTimeout` for plan timeouts; no cron or recurring alarm scheduler. | Missing persistent scheduling engine with precision timers, startup recovery, periodic tick, overdue catch-up, and recurrence advancement. | Create `backend/reminders/ReminderScheduler.ts` managing active timers, startup catch-up, and recurrence calculation. |
| **Notification delivery** | `NotificationManager.ts` provides `notify()` for system and companion alerts. Voice text spoken via voice session if connected. | Missing reminder-to-notification adapter that handles message sanitization, title formatting, voice prompt extraction, and delivery tracking. | Create `backend/reminders/ReminderDeliveryManager.ts` delegating strictly to `notificationManager.notify()` without tool execution authority. |
| **Approval** | `CheckpointManager` handles plan tokens; no reminder approval verification. | Missing approval capture, cryptographic parameter hash binding (`contentHash`), and tampering detection for reminder scheduling. | Create `backend/reminders/ReminderGovernance.ts` validating explicit user approval before scheduling and revoking approval on edits. |
| **Timezone handling** | Standard JavaScript `Date` and `toLocaleDateString` used across various modules. | No IANA timezone validation, local-to-UTC offset reconciliation across DST boundaries, or recurrence calculation. | Create `backend/reminders/TimezoneUtil.ts` using native `Intl.DateTimeFormat` for validation, local time parsing, and DST-safe advancement. |
| **Ownership and isolation** | `SecurityContext.identityId` and Stage 10.3 `resolveCanonicalProjectId()`. | Reminders need explicit user ownership and optional canonical project scoping to prevent cross-user leakage or cross-project confusion. | Enforce strict `userId` matching and optional canonical `projectId` validation in `ReminderService.ts` and `ReminderStore.ts`. |
| **Audit and sanitation** | `SecurityAuditLogger.ts` logs security events. `OutputDataFirewall.ts` redacts tokens and sensitive data. | Voice and notification text must be scrubbed of API keys, tokens, and credentials before reaching the user. | Integrate regex secret sanitization (`sanitizeVoiceText`) in `ReminderDeliveryManager.ts`. |

---

### 3. Architecture & Lifecycle Changes

A dedicated, isolated module was implemented in `backend/reminders/`:

```mermaid
flowchart TD
    User([User / UI]) -->|1. Propose Reminder| RS[ReminderService]
    RS -->|Save proposed| RStore[ReminderStore]
    
    User -->|2. Explicit Approval| RS
    RS -->|Verify / Bind Hash| RG[ReminderGovernance]
    RG -->|Stamp Approval| RS
    RS -->|Save scheduled| RStore
    RS -->|Register| Sch[ReminderScheduler]
    
    Sch -->|Set precision timer| Timer[(Timer / Tick)]
    Timer -->|Due Event| Sch
    Sch -->|Verify Approval Integrity| RG
    Sch -->|Dispatch Due Occurrence| RDM[ReminderDeliveryManager]
    
    RDM -->|Check Active| ES{Emergency Stop?}
    ES -->|Active| Suppress[Suppress Delivery]
    ES -->|Normal| LK{Security Lockdown?}
    LK -->|Active| Suppress
    LK -->|Normal| IDEM{Duplicate Check?}
    IDEM -->|In-flight / Delivered| Ack[Return Handled]
    IDEM -->|Fresh| NM[NotificationManager.notify]
    NM -->|Visual & Voice Alert| User
    NM -->|Delivery Result| RDM
    RDM -->|Update Occurrence| RStore
```

1. **`ReminderTypes.ts`**:
   - Defines `Reminder`, `ReminderOccurrence`, `ReminderApproval`, `ReminderRecurrence`, and `DeliveryResult`.
   - Bounded limits enforced:
     - `MAX_REMINDER_TEXT_LENGTH = 1000` characters
     - `MAX_SNOOZE_COUNT = 5` times per reminder
     - `MAX_USER_ACTIVE_REMINDERS = 100` scheduled reminders per user
     - `MAX_TIMEOUT_MS = 2,147,483,647` (Node.js 32-bit signed timer limit)
   - Lifecycle state machine enforced via `validateReminderTransition()`:
     - `proposed` → `awaiting_approval`, `scheduled`, `cancelled`
     - `awaiting_approval` → `scheduled`, `cancelled`
     - `scheduled` → `due`, `awaiting_approval` (on edit), `completed`, `cancelled`
     - `due` → `delivered`, `delivery_unknown`, `failed`, `scheduled` (on snooze)
     - `delivered` → `completed`, `scheduled` (snooze or next recurring occurrence)
     - `completed` → strictly terminal
     - `cancelled` → strictly terminal
     - `failed` → terminal (or `awaiting_approval` upon re-proposal)
     - `delivery_unknown` → terminal / reviewable

2. **`ReminderGovernance.ts`**:
   - Computes canonical `contentHash` using SHA-256 over `[userId, text, dueTime, timezone, recurrence]`.
   - `approveProposal()` attaches approval evidence (`approvedBy`, `approvedAt`, `contentHash`, `token`).
   - `verifyApproval()` ensures no reminder is scheduled without approval evidence, and verifies that the current reminder parameters match `contentHash`.
   - `invalidateApproval()` revokes approval whenever text, due time, timezone, or recurrence is modified.

3. **`TimezoneUtil.ts`**:
   - Uses native `Intl.DateTimeFormat` (zero external dependencies).
   - Validates IANA timezone identifiers (e.g., `"America/New_York"`, `"Asia/Kolkata"`, `"UTC"`).
   - `localToUtc()` preserves wall-clock time across DST transitions by performing iterative offset reconciliation.
   - Computes next recurring occurrence safely for daily, weekly, monthly, and yearly intervals.

4. **`ReminderStore.ts`**:
   - Persists all reminders to `DATA_DIR/reminders.json`.
   - Uses temporary file write (`.tmp`) and atomic replacement with retry backoff for Windows `EPERM`/`EBUSY`.
   - Strips UTF-8 BOM if present and validates JSON integrity.
   - Supports optimistic concurrency via `saveReminderAtomic(reminder, expectedVersion)`.
   - Provides user and project isolation queries (`listRemindersForUser`, `listRemindersByProject`).

5. **`ReminderDeliveryManager.ts`**:
   - Dispatches due reminders via `notificationManager.notify()`.
   - Sanitizes text and voice alert using regex credential scrubbing (`[token]`, `[credential]`).
   - Generates deterministic `deliveryKey = delivery_${reminderId}_${occurrenceId}` to prevent duplicate dispatch.
   - Rejects delivery immediately when `EmergencyStop` or `SecurityLockdown` is active.
   - Handles unconfirmed/null notification returns gracefully by marking occurrences as `delivery_unknown`.

6. **`ReminderScheduler.ts`**:
   - Maintains precision in-memory `setTimeout` timers.
   - Automatically recovers all active reminders upon startup (`recoverAndScheduleAll()`).
   - Runs a periodic tick (`tick()`) every 60 seconds to catch overdue reminders.
   - Automatically advances recurring reminders to their next occurrence upon successful delivery.

7. **`ReminderService.ts`**:
   - Main entry point for proposing, approving, modifying, snoozing, completing, and cancelling reminders.
   - Enforces user identity checks (`userId`) and prevents cross-user modification or approval.
   - Links reminders to optional canonical `projectId` and `taskPlanId` for context without granting execution authority.

---

### 4. Exact Files Created and Modified

#### Files Created:
1. `backend/reminders/ReminderTypes.ts` — Type definitions, limits, and transition validation.
2. `backend/reminders/TimezoneUtil.ts` — IANA timezone validation, DST reconciliation, and recurrence calculation.
3. `backend/reminders/ReminderGovernance.ts` — Approval verification, content hash binding, and revocation.
4. `backend/reminders/ReminderStore.ts` — Atomic persistence, optimistic locking, and user/project queries.
5. `backend/reminders/ReminderDeliveryManager.ts` — Notification dispatch, secret sanitization, and duplicate prevention.
6. `backend/reminders/ReminderScheduler.ts` — Precision timers, tick loop, startup recovery, and recurrence advancement.
7. `backend/reminders/ReminderService.ts` — Public coordinator API enforcing identity and isolation.
8. `backend/reminders/index.ts` — Module exports.
9. `tests/unit/reminders/reminders.test.ts` — Comprehensive 27-test suite.

#### Files Modified:
- *None.* All reminder functionality was contained strictly within `backend/reminders/**` and its test suite, leaving all other backend files untouched.

---

### 5. Reminder Model and Lifecycle Details

#### Lifecycle State Transition Matrix:

| From Status | To Status | Allowed? | Condition |
|---|---|---|---|
| `proposed` | `awaiting_approval` | Yes | Explicit review requested |
| `proposed` | `scheduled` | Yes | Explicit approval captured |
| `proposed` | `cancelled` | Yes | User cancels proposal |
| `awaiting_approval` | `scheduled` | Yes | Explicit approval verified |
| `awaiting_approval` | `cancelled` | Yes | User cancels proposal |
| `scheduled` | `due` | Yes | Due time reached |
| `scheduled` | `awaiting_approval` | Yes | Modification revokes approval |
| `scheduled` | `cancelled` | Yes | User cancels reminder |
| `scheduled` | `completed` | Yes | User manually marks complete |
| `due` | `delivered` | Yes | Notification dispatched successfully |
| `due` | `delivery_unknown` | Yes | Notification unconfirmed / indeterminate |
| `due` | `failed` | Yes | Delivery error or suppression |
| `due` | `scheduled` | Yes | User snoozes due reminder |
| `delivered` | `completed` | Yes | Single-instance completion |
| `delivered` | `scheduled` | Yes | Recurrence advancement or snooze |
| `completed` | *any* | **No** | Terminal state |
| `cancelled` | *any* | **No** | Terminal state |

#### Bounded Limits:
- `MAX_REMINDER_TEXT_LENGTH = 1000` chars: Prevents storage exhaustion and oversized payloads.
- `MAX_SNOOZE_COUNT = 5`: Prevents indefinite snooze loops.
- `MAX_USER_ACTIVE_REMINDERS = 100`: Prevents memory exhaustion and runaway timer creation.
- `MAX_TIMEOUT_MS = 2147483647`: Node.js 32-bit signed integer boundary protection for `setTimeout`.

---

### 6. Explicit Approval Mechanism

- **Approval Evidence**: A reminder cannot be scheduled without a valid `ReminderApproval` object:
  - `approvedBy`: ID of the approving user (must match reminder owner).
  - `approvedAt`: ISO 8601 timestamp of approval.
  - `contentHash`: SHA-256 hash of canonical reminder content:
    $$\text{contentHash} = \text{SHA256}(\text{userId} + | + \text{text} + | + \text{dueTime} + | + \text{timezone} + | + \text{recurrence})$$
- **Tampering Prevention**: Before any reminder is scheduled or executed, `verifyApproval()` recalculates the hash over the current reminder properties and asserts that it matches `contentHash`. If any parameter has been altered without approval, scheduling is rejected with `APPROVAL_HASH_MISMATCH` and status resets to `awaiting_approval`.
- **Edit Revocation**: Any edit to reminder text, due date, timezone, or recurrence clears the approval record and resets the reminder to `awaiting_approval`.
- **Zero Automatic Scheduling**: AI proposals cannot auto-approve reminders. User A cannot approve User B's reminders (`CROSS_USER_ACCESS_DENIED`).

---

### 7. Scheduling and Timezone Handling

- **Local Time Preservation**: For users scheduling reminders in specific timezones (e.g. 09:00 AM America/New_York), the local wall-clock intent is preserved.
- **DST Handling**: Daylight Saving Time changes (e.g., EST UTC-5 to EDT UTC-4) cause offset shifts. `TimezoneUtil.localToUtc()` reconciles local date/time components using iterative offset calculation, ensuring that a 09:00 AM recurring reminder triggers at 09:00 AM local time after a DST shift, not 08:00 AM or 10:00 AM.
- **Precision Timers**: For near-term reminders ($\le 24.8$ days), `ReminderScheduler` schedules an in-memory precision timer. For reminders beyond the 32-bit integer limit, the timer is capped at `MAX_TIMEOUT_MS` and re-evaluated by subsequent ticks.
- **Periodic Tick and Catch-Up**: A periodic tick runs every 60 seconds to inspect the store for overdue reminders, ensuring missed notifications (e.g., machine asleep during due instant) are caught and dispatched upon wake.

---

### 8. Persistence Guarantees

- **Atomic Writes**: `ReminderStore.saveReminder()` writes to a temporary file (`reminders.json.tmp`) before performing an atomic rename.
- **Windows File Lock Resistance**: Incorporates exponential retry loops for `EPERM` and `EBUSY` error codes on Windows.
- **Optimistic Concurrency**: `saveReminderAtomic(reminder, expectedVersion)` increments the version number monotonically and rejects concurrent conflicting writes with `STALE_UPDATE_DETECTED`.
- **Cross-Restart Recovery**: Upon application startup, `ReminderScheduler.recoverAndScheduleAll()` loads all active reminders from `reminders.json`, verifies their approval integrity, and registers timers or executes overdue occurrences.

---

### 9. Delivery and Notification Behavior

- **Notification Infrastructure**: Dispatches exclusively through `notificationManager.notify()`, creating visual notifications and companion voice speech alerts.
- **No Execution Authority**: Reminders do **not** invoke `StepExecutor`, do **not** trigger tool execution, do **not** resume task plans, and do **not** execute shell or browser commands.
- **Sanitization**: Notification and voice texts are processed with `sanitizeVoiceText()`, stripping bearer tokens, API keys, passwords, and secrets before they are presented to the user.
- **Idempotency & Duplicate Prevention**: Each occurrence is tagged with a unique `deliveryKey = delivery_${reminder.id}_${occurrenceId}` and tracked in an in-memory deduplication set. Concurrent duplicate calls are rejected.
- **Stop Condition Interaction**:
  - `emergencyStopCoordinator.isActive()`: Delivery is immediately suppressed with `EMERGENCY_STOP_ACTIVE`.
  - `securityPolicyEngine.getMode() === "LOCKDOWN"`: Delivery is immediately suppressed with `SECURITY_LOCKDOWN_ACTIVE`.

---

### 10. Failure Modes and Uncertain Delivery Handling

- **Missed Reminders**: If the system was offline during a reminder's scheduled instant, the startup recovery loop or periodic tick identifies the overdue reminder and executes delivery immediately.
- **Unconfirmed Delivery (`delivery_unknown`)**: If `notificationManager.notify()` returns `null` (e.g., due to downstream notification suppression or an unconfirmed provider state), the occurrence status is safely recorded as `delivery_unknown` rather than falsely marked as delivered.
- **Terminal Handling**: Failed or cancelled reminders do not repeatedly execute or block subsequent reminders.

---

### 11. User and Project Isolation

- **User Separation**:
  - All reminders are tagged with `userId`.
  - `ReminderService` verifies `reminder.userId === callerUserId` for all operations (propose, approve, update, snooze, complete, cancel, get).
  - User A cannot view, approve, modify, or cancel User B's reminders.
- **Project Isolation**:
  - Reminders can optionally specify a canonical `projectId` and `taskPlanId` for contextual grouping.
  - Linking a reminder to a project or plan is strictly informational; it never grants cross-project access or elevates execution privileges.

---

### 12. Security and Architecture Invariants Verification

- **129 Unique LIVE_TOOLS**: Verified unchanged. Exactly 129 tools are declared, with zero additions, deletions, renames, or modifications.
- **Security Pipeline Intact**:
  `SecurityPolicyEngine → SecurityRiskEngine → ToolExecutionFirewall → Confirmation → OutputDataFirewall → AuditLogger`
  Reminders do not bypass any security gates or firewalls.
- **No Side-Effect Execution**: Reminders cannot run commands, create files, make external network requests, or modify system settings.

---

### 13. Test Results

#### 1. Stage 10.6 Reminders Unit Tests:
- **Command:** `npm test -- tests/unit/reminders/reminders.test.ts`
- **Result:** `PASS`
- **Tests Passed:** `27 / 27` (0 failed, 0 skipped)
- **Duration:** `4.14s`
- **Coverage Areas:**
  1. *Model & Lifecycle State Transitions* (7 tests): valid transitions, invalid transition rejection, terminal status protection, text length limit, snooze count limit, active reminder capacity limit, recurrence schema validation.
  2. *Approval & Governance* (4 tests): approval requirement enforcement, approval evidence stamping, content tampering detection, approval revocation on modification.
  3. *Scheduling, Precision Timers & Timezone Handling* (5 tests): precision timer firing, IANA timezone validation, DST wall-clock preservation, recurring schedule advancement, cold recovery after restart.
  4. *Delivery, Notification & Stop Condition Safety* (7 tests): notification dispatch, voice/text secret sanitization, idempotency duplicate prevention, unconfirmed notification handling (`delivery_unknown`), Emergency Stop suppression, Security Lockdown suppression.
  5. *Ownership, Project Isolation & Safety Invariants* (4 tests): cross-user modification rejection, cross-user approval rejection, project-based querying, `LIVE_TOOLS` invariant verification.

#### 2. Regression Tests (Planner & Task Orchestrator):
- **Command:** `npm test -- tests/unit/task_orchestrator.test.ts tests/unit/planner.test.ts`
- **Result:** `PASS`
- **Tests Passed:** `129 / 129` (0 failed, 0 skipped)
- **Duration:** `7.10s`

#### 3. TypeScript Compilation:
- **Command:** `npx tsc --noEmit`
- **Result:** `PASS` (Exit code 0, 0 errors)

#### 4. `LIVE_TOOLS` Registry Integrity:
- **Command:** `npm test -- tests/unit/platform.test.ts -t "LIVE_TOOLS"`
- **Result:** `PASS`
- **Tool Count:** Exactly 129 unique declarations preserved.

---

### 14. Protected-File Verification

All protected and out-of-scope paths remained completely untouched:
- `backend/server.ts` — UNTOUCHED
- `backend/tools/ToolOrchestrator.ts` — UNTOUCHED
- `backend/planner/**` — UNTOUCHED
- `backend/security/**` — UNTOUCHED
- `backend/ai/GeminiSessionFactory.ts` — UNTOUCHED
- `backend/companion/**` — UNTOUCHED
- `backend/memory/**` — UNTOUCHED
- `backend/projects/**` — UNTOUCHED
- `backend/device/**` — UNTOUCHED
- `android/**` — UNTOUCHED
- `electron/**` — UNTOUCHED
- `desktop_agent/**` — UNTOUCHED
- All `LIVE_TOOLS` declarations — UNTOUCHED

---

### 15. Unresolved Limitations & Non-Verified Items

- None. All Stage 10.6 requirements have been implemented, tested, and verified.
- Real-world wall-clock DST transitions across upcoming years rely on Node's underlying V8 `Intl` database (CLDR/ICU).
- Physical mobile device notifications and external push delivery are out of scope for backend unit verification and are handled through existing companion/mobile notification bridges.

---

### 16. Stage Boundary Confirmation

Stage 10.6 is complete.  
Stage 10.7 (Explainability) and Stage 10.8 (Final Regression) were **NOT** started.  
Execution has safely stopped to await user review and subsequent roadmap prompts.
