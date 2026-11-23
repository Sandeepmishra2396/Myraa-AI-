# MYRAA — Stage 10.3 P1 Persistence Integrity Remediation Report (`GAP-10.3-08`)

- **Remediation Target:** `GAP-10.3-08` from `stage10_phase10_3_final_acceptance_R2.md` — `ProjectStore` Cache Consistency & Concurrent Write Safety
- **Date:** 2026-11-18
- **Authorized Source File Modified:** `backend/projects/ProjectStore.ts` ONLY (zero other source or tracked test files modified)
- **Final Status:** **`PASS`**

---

## 1. Executive Status for `GAP-10.3-08`

| Requirement | Status | Verification Basis |
| :--- | :---: | :--- |
| Full read-modify-write transaction serialization per canonical file path | **`PASS`** | Source inspection + Batch E (`E2`, `E3`) |
| Multi-instance same-file serialization (including equivalent non-normalized path forms) | **`PASS`** | Source inspection + Batch E (`E3`: 28 interleaved ops, 0 lost updates) |
| Copy-on-write mutation isolation & cache publication strictly after `fs.rename` success | **`PASS`** | Source inspection + Batch E (`E4`, `E6`) |
| Failed-write cache & disk consistency (zero partial/unpersisted memory state) | **`PASS`** | Source inspection + Batch E (`E4`: `saveProject`, `setActiveProject`, `deleteProject`, `ProjectManager.addTask`) |
| Queue failure recovery without poisoning subsequent queued transactions | **`PASS`** | Source inspection + Batch E (`E5`) |
| Defensive cloning against external caller mutation of cached references | **`PASS`** | Source inspection + Batch E (`E4`, `E8`) |
| Path-keyed cache isolation across distinct data files | **`PASS`** | Source inspection + Batch E (`E7`) |
| Post-persistence instruction-cache invalidation & zero circular ESM import | **`PASS`** | Source inspection + standalone ESM import + Batch E (`E4`, `E8`) + Vitest `GAP-10.3-06` |
| Existing regression suites, `tsc`, and `LIVE_TOOLS` 129/129 invariants | **`PASS`** | 8 test files (278 passed, 0 failed, 41 filtered-skipped), `tsc --noEmit` (0 errors), `LIVE_TOOLS` 129/129 |

**Final Finding Status (`GAP-10.3-08`):** **`PASS`**

---

## 2. Root-Cause Analysis (Batch A Inspection)

Direct inspection of `backend/projects/ProjectStore.ts` (prior 228-line implementation) and its callers (`ProjectManager.ts`, `ProjectContinuityResolver.ts`, `ToolOrchestrator.ts`) identified five concrete integrity defects:

1. **In-place cache mutation before disk persistence (`lines 76, 166, 184, 186, 190, 203, 205`):** `load()` returned the live module-global `_cache` object directly; `setActiveProject()`, `saveProject()`, and `deleteProject()` mutated `_cache` in place before `await this.save(data)`. Any disk write or rename failure left the failed candidate mutation permanently visible in memory while disk kept the old state.
2. **Write-only per-instance serialization (`lines 41, 106`):** `private writeQueue` was per-instance and wrapped only `save()`. All read-modify-write sequences (`load() → mutate → save()`) ran outside the queue, allowing concurrent operations on one instance or across multiple `ProjectStore` instances pointing to the same file to read identical stale snapshots and overwrite each other.
3. **Global cache shared across different file paths (`line 27`):** A single module-level `let _cache: ProjectsStoreData | null` was shared across all `ProjectStore` instances regardless of `customFilePath`, allowing distinct files to contaminate each other's cache.
4. **Mutable references leaked to callers (`lines 76, 141, 154, 156`):** `ProjectManager.addTask()` (`line 170`), `updateTask()` (`lines 188–191`), and `updateLastSession()` (`line 217`) mutate the object returned by `getActiveProject()` directly before calling `saveProject(project)`. Without defensive deep cloning on read and write, a failed `saveProject()` after `ProjectManager` mutation corrupted the shared cache.
5. **Silent instruction-cache fallback errors (`lines 54–69`):** Catch blocks silently swallowed invalidation errors without surfacing an explicit secret-free warning.

---

## 3. Exact Source File and Line Ranges Changed

- **Only file modified:** `backend/projects/ProjectStore.ts` (`lines 1–358`, full file refactored strictly within permitted scope).
- **Zero other source or tracked test files were modified.**

---

## 4. Before / After Transaction Architecture

### Before
```text
Caller -> load() [returns live mutable global _cache]
       -> mutate _cache IN PLACE  <-- CORRUPTS MEMORY BEFORE PERSISTENCE
       -> save(data) [per-instance writeQueue only]
          -> writeFile(tmp) -> rename(tmp, file) -> _cache = data
       (Concurrent readers/writers read stale snapshots & overwrite each other;
        failed writes leave mutated _cache in memory.)
```

### After
```text
Caller -> runFileTransaction(canonicalFileKey(filePath), async () => {
            1. candidate = await _readLatestLocked()      // deep structuredClone of committed state
            2. mutate candidate ONLY                      // published cache untouched
            3. await _atomicPersistAndPublishLocked(candidate)
                 -> writeFile(uniqueTmpInDestDir, JSON)
                 -> retryable fs.rename(uniqueTmp, filePath) [EPERM/EBUSY up to 5 attempts]
                 -> ON RENAME SUCCESS ONLY: _cacheByFile.set(fileKey, cloneStoreData(candidate))
                 -> ON ANY ERROR: unlink ONLY uniqueTmp, leave cache & disk untouched, rethrow
          })
       -> ONLY after transaction commits & actually mutated:
          (for deleteProject: decisionStore.deleteByProject(id))
          await _invalidateInstructionsCache()
```

---

## 5. Queue Design and Keying Strategy

- **Canonical File Key (`ProjectStore.ts:39–42`):**
  ```ts
  function canonicalFileKey(filePath: string): string {
    const resolved = path.resolve(filePath);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  }
  ```
  Equivalent path forms (e.g., `dir/projects.json` vs `dir/sub/../projects.json`, or Windows case differences) resolve to the **exact same canonical key**.
- **Shared Module-Level Queue Map (`ProjectStore.ts:35, 57–75`):**
  - `_fileQueues = new Map<string, Promise<unknown>>()` is shared across all `ProjectStore` instances in the Node.js process.
  - `runFileTransaction(fileKey, operation)` chains `next = prev.then(operation, operation)` and stores `tail = next.then(() => undefined, () => undefined)` in `_fileQueues`, deleting the map entry in `tail.finally(...)` when no newer operation superseded it.
- **No Nested-Queue Deadlocks:**
  - Public `save()`, `setActiveProject()`, `saveProject()`, and `deleteProject()` each acquire `runFileTransaction(this.fileKey, ...)` at the public boundary and call internal locked helpers (`_readLatestLocked()`, `_atomicPersistAndPublishLocked()`) directly — never re-entering public `this.save()` from inside a transaction.

---

## 6. Same-Instance Concurrency Evidence (`E2`)

Executed via isolated temporary harness against `os.tmpdir()` (cleaned up post-run):
- Launched **20 concurrent `saveProject()`** operations on a single `ProjectStore` instance via `Promise.all(...)`.
- Verified:
  - Disk JSON contains all **20/20** projects (zero lost updates).
  - In-memory `store.load()` matches disk JSON via `assert.deepStrictEqual`.
- **Result:** `PASS (20/20 preserved)`.

---

## 7. Multi-Instance Same-File Concurrency Evidence (`E3`)

Executed via isolated temporary harness:
- Instantiated two independent `ProjectStore` instances pointing to the **same file via two different path representations**: `path.join(dir, "projects.json")` and `path.join(dir, "sub", "..", "projects.json")`.
- Launched **24 concurrent `saveProject()`** calls interleaved across `instA` (12) and `instB` (12), followed by **4 concurrent mixed mutations** (`instA.saveProject` update, `instB.setActiveProject`, `instA.deleteProject`, `instB.saveProject` insert) — **28 interleaved multi-instance operations total**.
- Verified:
  - Final disk JSON contains exact expected **24** projects (`12 + 12 - 1 + 1`), updated name on `instA-0`, deleted `instB-11` absent, `instB-extra` present, `activeProjectId === "instB-5"`.
  - Both `instA.load()` and `instB.load()` equal the exact disk JSON.
- **Result:** `PASS (28 interleaved ops, 0 lost updates)`.

---

## 8. Failed-Write Cache Consistency Evidence (`E4`)

Executed via isolated temporary harness injecting `EACCES` on `fs.rename` for the synthetic test file:
- Established baseline with `base-a` (active) and `base-b`.
- Verified defensive cloning first: mutating the object returned by `getActiveProject()` (`name = "MUTATED_OUTSIDE"`, pushing an injected task) did **not** alter subsequent `getActiveProject()` reads.
- With `fs.rename` forced to throw `EACCES`:
  - `saveProject("fail-c")` rejected (`/EACCES/`).
  - `setActiveProject("base-b")` rejected (`/EACCES/`).
  - `deleteProject("base-a")` rejected (`/EACCES/`).
  - `ProjectManager.addTask(...)` (which mutates its returned project clone before calling `saveProject`) rejected (`/EACCES/`).
- Verified after all 4 failures:
  - Disk JSON matched baseline identically.
  - `store.load()`, `getActiveProject()` (`base-a`, `tasks.length === 1`), and `getProject("fail-c")` (`undefined`) matched baseline identically.
  - Instructions cache invalidator count remained unchanged (`0` invalidations on failed writes).
  - Zero orphan `.tmp` files remained in the directory.
- **Result:** `PASS`.

---

## 9. Queue Recovery Evidence (`E5`)

Executed immediately after `E4` with `fs.rename` configured to fail with `EIO` on the first queued operation only:
- Submitted `[saveProject("fail-queued"), saveProject("recover-1"), saveProject("recover-2")]` concurrently via `Promise.allSettled`.
- Verified:
  - First promise `rejected` (`EIO`); second and third `fulfilled`.
  - Final disk JSON and in-memory `store.load()` contain `recover-1` and `recover-2`, and do **not** contain `fail-queued`.
  - Zero unhandled rejections and zero queue poisoning.
- **Result:** `PASS`.

---

## 10. Atomic Rename and Temporary-File Cleanup Evidence (`E6`)

Verified in `ProjectStore.ts:154–189` and exercised in Batch E (`E6`):
- **Unique Temp Filenames in Destination Directory:** `.${base}.${process.pid}.${Date.now()}.${crypto.randomUUID()}.tmp` inside `path.dirname(this.filePath)` (verified unique across operations and located in exact destination directory).
- **Transient Rename Retry (`EBUSY` / `EPERM`):** Simulated 2 transient lock errors (`EBUSY`, then `EPERM`) followed by success -> verified both retries executed with backoff, `store.load()` still saw `0` projects *before* rename succeeded, and published `1` project strictly *after* rename succeeded.
- **Own-Temp-Only Cleanup & Target Preservation:** Placed an unrelated `.projects.json.foreign.tmp` file in the same directory during a fatal `ENOSPC` rename failure -> verified the failing operation's own temp file was unlinked, the foreign `.tmp` file remained intact (`"foreign-op-data"`), the prior committed target file remained intact, and `ENOSPC` propagated to the caller.
- **Missing Parent Directory Behavior Preserved:** Writing to a non-existent directory continues to fail cleanly with `ENOENT` (verified by `Batch 5 (GAP-10.3-07)` in `phase10_project_continuity.test.ts`).
- **Result:** `PASS`.

---

## 11. Cache Isolation Assessment for Different Paths (`E7`)

- Replaced global `let _cache` with `_cacheByFile = new Map<string, ProjectsStoreData>()` keyed by `canonicalFileKey(this.filePath)`.
- `clearCache()` removes only `_cacheByFile.delete(this.fileKey)`.
- Verified in `E7`: `storeX(dirX/projects.json)` and `storeY(dirY/projects.json)` maintain completely isolated caches and disk files; `storeX.clearCache()` leaves `storeY`'s cache intact.
- **Result:** `PASS`.

---

## 12. Instruction-Cache Invalidation Behavior (Batch D)

- Preserved `registerInstructionsCacheInvalidator()` and lazy dynamic `import("../ai/GeminiSessionFactory.ts")` — **zero static import** of `GeminiSessionFactory.ts` (standalone ESM import verified with exit code `0`, plus `Batch 5 (GAP-10.3-06)` passed).
- Invalidation executes **strictly after** `runFileTransaction` commits and publishes cache, and **only** when state actually changed:
  - Not called on failed writes (`E4`).
  - Not called on no-op `setActiveProject("non-existent-id")` or no-op `deleteProject("non-existent-id")` (`E8`).
  - Called once on successful `saveProject`, active `setActiveProject`, and actual `deleteProject` (`E8`).
- If a registered invalidator or fallback import fails, logs an explicit secret-free `console.warn` without rolling back or failing an already-persisted mutation.

---

## 13. Existing Project API Compatibility (`E1`, `E8`)

All existing exports, constructor signatures, method signatures, and persisted JSON schema (`{ activeProjectId, projects }`) remain 100% backward-compatible:
- `ProjectStore` constructor `(customFilePath?, customDecisionStore?)`
- `projectStore` singleton export
- `registerInstructionsCacheInvalidator(fn)`
- `load()`, `save()`, `getProject()`, `getActiveProject()`, `setActiveProject()`, `saveProject()`, `deleteProject()`, `clearCache()`
- Verified end-to-end with `ProjectManager` (`addTask`, `updateTask`, `getTasks`, `updateLastSession`, `getProjectContextCard`), `ProjectContinuityResolver` (`switchProject`, `resolveProjectContext`), and `ProjectDecisionStore` orphan-decision cleanup on `deleteProject`.

---

## 14. Exact Regression Commands and Results

All commands were executed sequentially after the final edit to `backend/projects/ProjectStore.ts`:

| # | Exact Command | Exit Code | Passed | Failed | Skipped | Classification |
| :-: | :--- | :-: | :-: | :-: | :-: | :--- |
| 1 | Isolated Batch E Runtime Harness (`verify_p1_project_store.mts`, cleaned up post-run) | `0` | 8 (`E1`–`E8`) | 0 | 0 | Local Isolated Runtime Verification |
| 2 | `npx vitest run --fileParallelism=false tests/unit/projects.test.ts tests/unit/planner.test.ts` | `0` | 88 *(17 projects + 71 planner)* | 0 | 0 | Automated Unit Suite |
| 3 | `npx vitest run --fileParallelism=false tests/unit/phase10_project_continuity.test.ts tests/unit/phase10_audio_continuity.test.ts` | `0` | 117 *(90 project + 27 audio)* | 0 | 0 | Automated Unit/Mocked-WS Suite |
| 4 | `npx vitest run --fileParallelism=false tests/unit/companion_core_phase1.test.ts tests/unit/stage10_1_10_2_security_remediation.test.ts tests/unit/gemini_live_auth_regression.test.ts` | `0` | 72 *(42 companion + 19 sec + 11 live auth)* | 0 | 0 | Automated Security/Regression Suite |
| 5 | `npx vitest run --fileParallelism=false tests/e2e/cross_platform_e2e_phase29.test.ts -t "strictly preserves"` | `0` | 1 | 0 | 41 *(filtered by `-t`)* | Automated E2E Invariant Check |
| 6 | `npx tsc --noEmit` | `0` | 0 errors | 0 | — | TypeScript Static Check |
| 7 | Standalone ESM import probe (`npx tsx -e "import { ProjectStore, ... } from './backend/projects/ProjectStore.ts'; ..."`) | `0` | 1 | 0 | — | Module Isolation Probe |
| 8 | Programmatic `LIVE_TOOLS` probe (`npx tsx -e "import { LIVE_TOOLS } ..."`) | `0` | `129 / 129` unique | 0 | — | Tool Schema Invariant Probe |
| **Aggregate Vitest (Non-Double-Counted)** | **8 distinct tracked test files** | **All `0`** | **278** | **0** | **41** *(filtered)* | **Automated Verification** |

---

## 15. `LIVE_TOOLS` 129/129 Verification

Programmatic probe output (exit code `0`):
```json
{"total":129,"unique":129,"hasConfirmationToken":false,"hasGetProjectContinuity":false}
```
All P0 security invariants (`129/129` unique tools, no `confirmationToken` in model schema, no model-callable approval, single-mint session-bound confirmation, zero credential logging, local `/live` identity propagation, fail-closed context, Stage 10.1/10.2 memory governance, Stage 10.4.2 token lifecycle and audio continuity) remain intact.

---

## 16. Frozen-Boundary Verification

Verified via direct file modification timestamps (no Git operations executed; temporary harness deleted: `Harness still exists: False`):

| Protected / Frozen Boundary | Status | Last Modified Timestamp |
| :--- | :---: | :--- |
| `backend/server.ts` | Untouched | `2026-11-18 19:30:25` |
| `backend/ai/GeminiSessionFactory.ts` | Untouched | `2026-11-18 21:48:26` |
| `backend/projects/ProjectManager.ts` | Untouched | `2026-11-18 20:47:35` |
| `backend/projects/ProjectDecisionStore.ts` | Untouched | `2026-11-18 20:49:17` |
| `backend/projects/ProjectContinuityResolver.ts` | Untouched | `2026-11-18 20:49:16` |
| `backend/planner/PlannerCoordinator.ts` | Untouched | `2026-09-23 18:11:38` |
| `backend/planner/PlanStore.ts` | Untouched | `2026-11-18 20:45:51` |
| `backend/tools/ToolOrchestrator.ts` | Untouched | `2026-11-18 21:48:50` |
| `backend/conversation/ConversationManager.ts` | Untouched | `2026-11-18 20:46:30` |
| `backend/security/SecurityPolicyEngine.ts` | Untouched | `2026-11-18 21:46:24` |
| `backend/security/SecurityAuditLogger.ts` | Untouched | `2026-11-18 21:46:24` |
| `backend/security/SecurityRiskEngine.ts` | Untouched | `2026-11-18 21:43:43` |
| `backend/device/RemoteBridge.ts` | Untouched | `2026-09-26 23:46:12` |
| `tests/unit/phase10_project_continuity.test.ts` | Untouched | `2026-11-18 21:55:00` |
| `tests/unit/projects.test.ts` | Untouched | `2026-10-04 17:46:35` |
| `android/` / `electron/` / `desktop_agent/` | Untouched | Unchanged |

---

## 17. Process-Local vs. Cross-Process Locking Limitation

- **What IS guaranteed:** The module-level `_fileQueues` map keyed by canonical resolved file path guarantees strict serializability for all concurrent mutations across one or multiple `ProjectStore` instances **within the same Node.js process**.
- **What is NOT claimed:** This does **not** provide cross-process OS file locking (`flock`) or multi-host distributed locking. If MYRAA is ever deployed with multiple independent Node.js worker processes or multiple hosts sharing a single `projects.json` file concurrently, an OS-level or external transactional store would be required under a separate architectural phase.

---

## 18. Blocked or Unverified Requirements

- **Tracked permanent concurrency unit tests:** Intentionally not added to tracked test files because Section 1 prohibited modifying tracked test source files; all concurrency, failed-write, queue-recovery, rename-retry, and cache-isolation tests were independently executed via the isolated temporary harness (and cleaned up afterward).
- **Live Gemini Cloud staging / Chromium Playwright DOM:** Out of scope for this P1 persistence task (`BLOCKED` / `NOT VERIFIED`, unchanged from P0 R3 audit).
- **Out-of-scope P2 work (`TaskPlan.projectId` stamping / `PlannerCoordinator.ts`):** Not started.

---

## 19. Scope Compliance Confirmation

Explicitly confirmed: **ONLY `backend/projects/ProjectStore.ts`** was modified as a source file. Zero other source files, zero tracked test files, zero dependencies, zero configuration files, and zero Git operations were modified or executed. Temporary verification harness and synthetic temporary directories were completely cleaned up.

---

## Final Status

**`PASS`**
