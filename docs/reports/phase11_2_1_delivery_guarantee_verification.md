# MYRAA — Phase 11.2.1: Cross-Process Atomic Claim & Notification Delivery Evidence Verification Report

**Execution Timestamp:** 2026-11-22T13:57:00+05:30  
**Phase:** Phase 11.2.1 — Verification of Reliability Guarantees  
**Target Subsystems:** `backend/reminders/` (`ReminderStore`, `ReminderScheduler`, `ReminderDeliveryManager`), `backend/companion/` (`NotificationManager`, `CompanionStore`)  
**Overall Verdict:** **PASS (with Documented Single-Process Desktop Architectural Boundaries)**

---

## 1. Executive Summary & Verdict

Phase 11.2.1 performs a focused verification of two foundational reliability guarantees introduced in Phase 11.2:
1. The **atomicity boundary** of the persistent occurrence delivery claim mechanism across shared stores, independent store instances, multiple Node.js processes, and separate machines.
2. The **evidence boundary** of notification delivery: exactly what successful completion of `notificationManager.notify()` proves versus what it does not prove.
3. The **recovery correctness** of crash windows and lease protection.
4. The preservation of all security boundaries and the 129 `LIVE_TOOLS` invariant.

### Summary of Findings:
- **Same-Process Concurrency:** **VERIFIED & SECURE.** Multiple scheduler workers sharing a single `ReminderStore` instance (such as the production `reminderStore` singleton) are strictly serialized via an in-process promise queue (`this._writeQueue`). Concurrent claim races result in exactly 1 claim and 0 duplicate dispatches.
- **Independent Store Instances in Same Process:** **BOUNDARY IDENTIFIED.** Independent instances of `new ReminderStore()` maintain separate instance-level promise queues. Concurrent claims across uncoordinated instances race at the filesystem read pass and both acquire claims. In production, this is prevented because all services bind to the module singleton `reminderStore`.
- **Cross-Process Concurrency:** **ARCHITECTURAL LIMITATION DOCUMENTED.** The atomic `.tmp` + `fs.rename` mechanism prevents corrupt or partial JSON writes, but does **not** provide cross-process mutual exclusion for read-modify-write cycles. Two independent Node.js processes racing on the same storage file can both read an unclaimed occurrence and both write claims. Claim safety across multiple processes is **not guaranteed** by the local filesystem JSON store without an OS-level lockfile or database.
- **Multi-Machine Concurrency:** **UNSUPPORTED.** MYRAA is designed as a local single-user desktop application. No distributed locking mechanism (Raft, Redis, Postgres) exists or is supported.
- **Notification Delivery Evidence:** **RIGOROUSLY DELINEATED.** A status of `"delivered"` proves **backend persistence to `companion_notifications.json` and local `eventBus` emission**. It does **not** prove UI DOM pixel rendering, audio speaker output, or physical OS device notification display.
- **Lease Protection:** **VERIFIED.** Schedulers executing recovery will **not** steal or reset a valid, unexpired lease held by an active in-flight worker.
- **Security & Tools Invariants:** **PRESERVED.** All 129 `LIVE_TOOLS` declarations remain intact and frozen.

**Verification Verdict:** **PASS** (Single-Process Desktop Scope fully verified; multi-process and delivery evidence boundaries formally documented).

---

## 2. Cross-Process Atomic Claim Verification

We investigated the concurrency boundary of `claimOccurrenceAtomic` across four operational models:

### 2.1 Model 1: Multiple Scheduler Workers Sharing One ReminderStore Instance
- **Implementation:** `this.serialize(...)` in `backend/reminders/ReminderStore.ts` wraps all mutating operations in an instance promise chain:
  ```typescript
  private _writeQueue: Promise<unknown> = Promise.resolve();
  private async serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this._writeQueue.then(operation, operation);
    this._writeQueue = next.catch(() => {});
    return next as Promise<T>;
  }
  ```
- **Evidence:** Tested in `tests/unit/reminders/reminder_reliability.test.ts` (`ensures two concurrent scheduler workers process due reminder with zero duplicate dispatches`).
- **Result:** **CLAIM SAFETY HOLDS (100%).** When Worker 1 and Worker 2 invoke `processDueReminder()` simultaneously via `Promise.all`, the event loop executes Worker 1's claim entirely, writes `claimed` status to disk, and Worker 2 subsequently reads the updated disk state, being rejected with `OCCURRENCE_ALREADY_CLAIMED`.

### 2.2 Model 2: Multiple Independent ReminderStore Instances in One Process
- **Implementation:** If code creates `storeA = new ReminderStore()` and `storeB = new ReminderStore()` in the same process, `_writeQueue` is allocated per instance.
- **Evidence:** Empirically verified in `tests/unit/reminders/reminder_reliability.test.ts` (`verifies persistence boundary: independent ReminderStore instances without shared queue race on concurrent claims`):
  ```typescript
  const [resA, resB] = await Promise.all([
    unsharedStoreA.claimOccurrenceAtomic(reminder.id, occId, "worker_unshared_A"),
    unsharedStoreB.claimOccurrenceAtomic(reminder.id, occId, "worker_unshared_B"),
  ]);
  // Both resA.claimed and resB.claimed returned true
  ```
- **Result:** **CLAIM SAFETY DOES NOT APPLY ACROSS INDEPENDENT INSTANCES.** Because the queue is instance-scoped, independent instances race on the `readReminders()` file I/O. Both observe `status: "due"` before either commits.
- **Production Assessment:** In production MYRAA, `ReminderScheduler` and `ReminderService` both default to and share the module singleton `reminderStore` (`export const reminderStore = new ReminderStore()`). Thus, this race does not occur during normal single-process application execution, but the architectural boundary is documented.

### 2.3 Model 3: Multiple Independent Node.js Processes Accessing the Same Storage File
- **Implementation:** Two distinct Node.js processes (e.g. separate PID 1001 and PID 1002) accessing `DATA_DIR/reminders.json`.
- **Evidence:** Empirically tested via spawned child processes against an isolated temporary `reminders.json` store:
  ```json
  Process 1: { "worker": "process_1", "claimed": true }
  Process 2: { "worker": "process_2", "claimed": true }
  ```
- **Mechanism Analysis:** In Node.js, heap memory is isolated per process. Process 1's promise queue has zero awareness of Process 2's queue. While `fs.rename` ensures atomic file replacement (preventing partial/torn JSON files), it does **not** provide mutual exclusion for read-modify-write transactions. Process 1 and Process 2 both read the file while `status === "due"`, both evaluate the occurrence as unclaimed, and both execute atomic write passes, overwriting each other.
- **Result:** **CLAIM SAFETY CANNOT BE GUARANTEED ACROSS MULTIPLE PROCESSES.**
- **Architectural Scope:** MYRAA is an Electron desktop application running a single local backend process (`server.ts`). Running multiple server processes against the same data directory is not a supported deployment configuration. If multi-process safety is ever required in future phases, an OS-level advisory file lock (`proper-lockfile` / `flock`) or transactional database (SQLite / WAL) must be formally approved and implemented.

### 2.4 Model 4: Multiple Application Instances on Separate Machines
- **Implementation:** Multiple physical or virtual machines accessing shared storage.
- **Result:** **UNSUPPORTED.** Local filesystem paths (`%APPDATA%`) are strictly host-local. Network file systems (NFS/SMB) do not guarantee POSIX rename atomicity for Node.js, and no distributed consensus coordinator (Raft/etcd/Redis) is deployed.

### Summary Table: Concurrency Boundary Matrix
| Concurrency Level | Implementation Mechanism | Mutual Exclusion Guaranteed? | Production Status |
| :--- | :--- | :---: | :---: |
| **Shared Store Instance (Same Process)** | In-process promise queue (`_writeQueue`) | **YES** | Active (Production Standard) |
| **Independent Store Instances (Same Process)** | Instance-scoped promise queues | **NO** | Mitigated via singleton pattern |
| **Cross-Process (Same Host)** | Ephemeral `.tmp` + `fs.rename` | **NO** | Unsupported deployment model |
| **Multi-Machine (Separate Hosts)** | None (Host-local JSON files) | **NO** | Unsupported deployment model |

---

## 3. Notification Delivery Evidence

We traced the execution pathway:
$$\text{ReminderDeliveryManager} \longrightarrow \text{notificationManager.notify()} \longrightarrow \text{companionStore.saveNotification()}$$

### Delineation of Delivery Evidence:
1. **Notification Persistence: PROVED.**
   - `await companionStore.saveNotification(item)` writes the `NotificationItem` to `DATA_DIR/companion_notifications.json` using atomic temporary file write and Windows retry-safe renaming.
   - Successful return proves the notification record is durably committed to disk.
2. **Event Emission: PROVED.**
   - `eventBus.emit("notification:created", { ... })` executes synchronously in the Node.js process.
   - Proves all in-process event listeners registered on `eventBus` received the event.
3. **UI Rendering: NOT PROVED.**
   - The backend `eventBus` does not know whether a frontend WebSocket client or Electron browser window is active, focused, minimized, or open.
   - There is no DOM rendering acknowledgement (ACK) returned from the React frontend to the backend notification manager.
4. **Audio Playback: NOT PROVED.**
   - If `voiceEligible` is true (voice enabled, level eligible, and quiet hours inactive), `"notification:voice"` is emitted.
   - However, actual sound wave generation depends on local audio drivers, physical speaker connectivity, and OS master volume. Furthermore, if quiet hours are active, voice output is intentionally suppressed.
5. **Physical Device Notification Display: NOT PROVED.**
   - In desktop/mobile environments, displaying an OS-level system tray toast or mobile push banner requires OS notification service integration and user permissions.
   - `notificationManager.notify()` records the alert internally; it does not receive or track an OS-level delivery confirmation.

### Conclusion on Delivery Terminology:
- In MYRAA, occurrence status `"delivered"` represents **Durable Notification Hub Persistence & Event Dispatch**.
- It must **never** be cited as proof of physical human perception, screen illumination, or audio playback.
- The existing terminology (**duplicate-resistant / effectively-once dispatch**) is justified for backend dispatch, but must not be conflated with physical device receipt.

---

## 4. Recovery Correctness Verification

We verified crash recovery across both critical failure windows and evaluated unexpired lease safety:

### 4.1 Crash Window 1: Claim Persisted, Notification Not Dispatched
- **Scenario:** The scheduler claims an occurrence on disk (`status: "claimed"`, `leaseExpiresAt: t + 30s`), but the process terminates before `notificationManager.notify()` is invoked.
- **Verification:**
  - Upon restart after lease expiration, `recoverInterruptedClaims()` queries `companionStore.listNotifications()`.
  - No matching `deliveryKey` is found in the notification store.
  - The occurrence is safely reset to `"due"`, clearing the expired lease and worker ID.
  - The subsequent scheduler tick claims and delivers the occurrence normally.
- **Result:** **VERIFIED (PASS).**

### 4.2 Crash Window 2: Notification Persisted, Outcome Not Committed
- **Scenario:** `notificationManager.notify()` completes and writes to `companion_notifications.json`, but the process terminates before `commitDeliveryOutcomeAtomic()` commits `status: "delivered"` to `reminders.json`.
- **Verification:**
  - Upon restart after lease expiration, `recoverInterruptedClaims()` inspects `companionStore.listNotifications()`.
  - It identifies an existing notification with `dedupKey === occ.deliveryKey`.
  - It reconciles the occurrence to `"delivered"`, stamps `deliveredAt`, and clears the lease.
  - Zero duplicate notifications are emitted.
- **Result:** **VERIFIED (PASS).**

### 4.3 Unexpired Lease Protection
- **Scenario:** A worker holds an active claim lease expiring 25 seconds in the future. Another scheduler instance starts up and runs `recoverInterruptedClaims()`.
- **Verification:**
  - Tested in `tests/unit/reminders/reminder_reliability.test.ts` (`preserves an active worker's valid unexpired lease without stealing or resetting during recovery`).
  - `recoverInterruptedClaims()` explicitly checks `if (now >= leaseExpires)`.
  - Because `now < leaseExpires`, the active claim is **completely untouched**:
    - `status` remains `"claimed"`.
    - `claimedBy` remains `"worker_active_in_flight"`.
    - `claimLeaseExpiresAt` is preserved.
  - Any attempt by the new scheduler to claim the occurrence while the lease is unexpired is rejected with `OCCURRENCE_ALREADY_CLAIMED`.
- **Result:** **VERIFIED (PASS).** An active worker's valid lease cannot be stolen merely because another scheduler started.

---

## 5. Security & Invariant Preservation

All architectural and security invariants were re-evaluated and confirmed:

| Security Boundary | Enforcement Location | Verified Behavior | Status |
| :--- | :--- | :--- | :---: |
| **Reminder Approval** | `ReminderGovernance.ts` | Tampered content hash or missing approval strictly prohibits scheduling and delivery. | **PASS** |
| **User Ownership** | `ReminderStore.ts`, `ReminderService.ts` | User A cannot read, snooze, modify, complete, or cancel User B's reminders. | **PASS** |
| **Emergency Stop** | `ReminderDeliveryManager.ts` | Delivery immediately aborted when `emergencyStopCoordinator.isActive() === true`. | **PASS** |
| **Security Lockdown** | `ReminderDeliveryManager.ts` | Delivery immediately suppressed when `securityPolicyEngine.getMode() === "LOCKDOWN"`. | **PASS** |
| **Voice Sanitization** | `NotificationManager.ts` | Spoken text strips tokens, passwords, bearer credentials, and API keys. | **PASS** |
| **Tool Execution** | Architectural Invariant | Reminder text is **never** dispatched to `ToolOrchestrator` or executed as code. | **PASS** |
| **LIVE_TOOLS Invariant** | `GeminiSessionFactory.ts` | Exactly 129 unique tool function declarations; object is frozen. | **PASS** |

---

## 6. Test Results & Metrics

All tests were executed using Vitest v5.0.1 on Windows:

| Test Suite | File | Tests Run | Passed | Failed |
| :--- | :--- | :---: | :---: | :---: |
| **Reminder Reliability Suite** | `tests/unit/reminders/reminder_reliability.test.ts` | 18 | 18 | 0 |
| **Stage 10.6 Baseline Suite** | `tests/unit/reminders/reminders.test.ts` | 27 | 27 | 0 |
| **Phase 21 Predictive Engine** | `tests/integration/phase21_predictive_proactive_engine.test.ts` | 27 | 27 | 0 |
| **Total Test Count** | | **72** | **72** | **0** |

- **Static Type Check:** `npm run lint` (`tsc --noEmit`): **0 errors**.
- **Tool Invariant:** `LIVE_TOOLS` length verified at **129**.

---

## 7. Remaining Limitations & Recommendations

1. **Single-Process Constraint:**
   - The current architecture provides atomic claim safety strictly within a single Node.js process using `reminderStore` singleton serialization.
   - It does **not** support concurrent multi-process access to the same storage directory.
   - *Recommendation:* If multi-process desktop daemon clustering is ever introduced, implement file-level OS advisory locking (`fs.open` with `O_EXCL` or `proper-lockfile`).
2. **Delivery Acknowledgement Scope:**
   - Status `"delivered"` indicates backend persistence and event dispatch.
   - *Recommendation:* If future features require UI-visible acknowledgement, implement a client-to-server WebSocket ACK protocol (`notification:rendered`) before marking an occurrence as confirmed on the display.
3. **Lease Latency Window:**
   - If a worker process terminates abruptly mid-delivery, the occurrence remains claimed until `DEFAULT_CLAIM_LEASE_MS` (30 seconds) elapses.
   - *Recommendation:* 30 seconds is appropriate for desktop environments; do not reduce below 10 seconds to avoid false lease expirations under CPU load.

---

**Report Certification:**  
*Lead Architect & Test Integrity Verifier: MYRAA Platform Engineering*  
*Status:* **PASSED & SEALED**
