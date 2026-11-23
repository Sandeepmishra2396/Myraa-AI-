# MYRAA — Stage 10.3 P1 Final Race-Condition Remediation Report (`AUD-P1-01`)

- **Remediation Target:** `AUD-P1-01` (HIGH) from `stage10_phase10_3_P1_final_acceptance_audit.md` — Cold-Cache `load()` vs. Concurrent Write Lost-Update Race
- **Date:** 2026-11-18
- **Authorized Files Modified:** Exactly the 2 authorized files (`backend/projects/ProjectStore.ts` and `tests/unit/projects.test.ts`)
- **Remediation Status (`AUD-P1-01`):** **`PASS`** *(Note: Overall P1 acceptance remains pending a separate independent read-only acceptance audit.)*

---

## 1. Executive Status for `AUD-P1-01`

| Control | Status | Verification Basis |
| :--- | :---: | :--- |
| Warm-cache fast path preserved without acquiring `_fileQueues` | **`PASS`** | Source inspection (`ProjectStore.ts:200–203`) + `AUD-P1-01 Test 3` |
| Cold-cache hydration serialized inside shared `runFileTransaction(this.fileKey, ...)` | **`PASS`** | Source inspection (`ProjectStore.ts:205–229`) + `AUD-P1-01 Tests 1–3` |
| Post-queue cache re-check prevents stale snapshot overwrite | **`PASS`** | Source inspection (`ProjectStore.ts:206–209`) + `AUD-P1-01 Tests 1 & 2` |
| Zero lost updates across concurrent cold `load()` + `saveProject(A)` + `saveProject(B)` | **`PASS`** | Deterministic barrier test (`AUD-P1-01 Test 1`) verifying disk JSON === cache |
| Cold-load read error does not poison queue or cache partial/empty state; `ENOENT` preserved | **`PASS`** | Deterministic test (`AUD-P1-01 Test 4`) |
| All 8 regression suites, `tsc --noEmit`, standalone ESM, and `LIVE_TOOLS` 129/129 | **`PASS`** | 282 passed, 0 failed, 41 filtered-skipped, exit code `0` across all commands |

**Final Finding Status (`AUD-P1-01`):** **`PASS`**

---

## 2. Exact Root Cause and Race Ordering

In the prior `ProjectStore.load()` (`lines 196–220`):
1. Cache started cold (`_cacheByFile.get(this.fileKey) === undefined`, e.g., process startup during `prewarmInstructions()` or after `clearCache()`).
2. `load()` began `await fs.readFile(this.filePath, "utf-8")` **outside** `runFileTransaction()`, reading the pre-write baseline (or `ENOENT`).
3. Concurrently, `saveProject(A)` acquired `runFileTransaction(this.fileKey, ...)`, persisted `[baseline, A]` to disk, and published `[baseline, A]` into `_cacheByFile`.
4. The suspended `load()` resumed and unconditionally executed `_cacheByFile.set(this.fileKey, staleData)`, **clobbering `[baseline, A]`** in `_cacheByFile`.
5. A subsequent `saveProject(B)` entered `_readLatestLocked()`, read the clobbered stale cache without `A`, wrote `[baseline, B]` to disk, and **permanently lost committed project `A`**.

---

## 3. Exact Files and Line Ranges Changed

Only the **2 authorized files** were modified:

| File | Exact Line Ranges Changed | Summary of Change |
| :--- | :--- | :--- |
| `backend/projects/ProjectStore.ts` | `192–230` | Wrapped cold-cache hydration in `load()` inside existing `runFileTransaction(this.fileKey, ...)` with post-queue `_cacheByFile.get(this.fileKey)` re-check while keeping the warm-cache fast path (`lines 200–203`) synchronous and lock-free. Zero changes to any other method. |
| `tests/unit/projects.test.ts` | `14`, `208–536` | Imported `vi` from `vitest` and added 4 permanent deterministic regression tests (`AUD-P1-01 Test 1` through `AUD-P1-01 Test 4`) inside `describe("Phase 3: ProjectStore", ...)`. Zero modifications to existing tests. |

---

## 4. Before / After Cold-Load Behavior

### Before (`AUD-P1-01` Vulnerable)
```text
load():
  WARM CACHE HIT -> return clone
  COLD MISS      -> await fs.readFile() [OUTSIDE QUEUE]
                 -> _cacheByFile.set(key, staleData) [UNCONDITIONAL OVERWRITE!]
                 -> return clone
```

### After (Serialized Cold Hydration with Cache Re-Check)
```text
load():
  WARM CACHE HIT -> return cloneStoreData(cached) [LOCK-FREE FAST PATH]
  COLD MISS      -> runFileTransaction(this.fileKey, async () => {
                      RE-CHECK _cacheByFile.get(this.fileKey)
                      IF HIT -> return cloneStoreData(latestCached) [NO DISK READ, NO OVERWRITE]
                      ELSE   -> await fs.readFile() [INSIDE SHARED FILE QUEUE]
                             -> parse & _cacheByFile.set(this.fileKey, cloneStoreData(data))
                             -> return cloneStoreData(data)
                             (on ENOENT: cache & return empty clone;
                              on non-ENOENT error: log & return empty WITHOUT caching)
                    })
```

- Uses the exact existing `_fileQueues` / `runFileTransaction` boundary — **no second queue**, **no nested lock** (none of the internal locked helpers call `this.load()`), and **no instruction-cache invalidation** on read hydration.

---

## 5. Warm-Cache Fast-Path Verification

- `ProjectStore.ts:200–203` checks `_cacheByFile.get(this.fileKey)` **before** calling `runFileTransaction()`, immediately returning `cloneStoreData(cached)`.
- Verified by `AUD-P1-01 Test 3`: after cold hydration reads disk once (`targetReadCount === 1`), subsequent warm `await store.load()` returns an isolated defensive clone with `targetReadCount` remaining `1` (zero disk I/O, zero queue acquisition).

---

## 6. Cold Hydration Transaction and Re-Check Evidence

- `ProjectStore.ts:205–209` re-checks `_cacheByFile.get(this.fileKey)` immediately upon acquiring `runFileTransaction(this.fileKey, ...)`.
- Verified by **`AUD-P1-01 Test 2`**: while `saveProject(proj-ahead)` holds the file queue paused mid-rename (before cache publication), a waiting cold `load()` enters `runFileTransaction()` behind it; once `saveProject` completes rename and publishes `["base-w", "proj-ahead"]`, the waiting `load()` hits the re-check inside the transaction, returns `["base-w", "proj-ahead"]`, performs **0** additional `fs.readFile` calls (`expect(readsAfterWriteEntered).toBe(0)`), and matches disk JSON identically.

---

## 7. Permanent Regression Test Names and Assertions

Added permanently to `tests/unit/projects.test.ts` (`lines 208–536`):

1. **`AUD-P1-01 Test 1: cold load does not clobber a concurrent committed write or cause lost updates`**
   - Uses a deterministic `readEntered` / `readGate` barrier on `fs.readFile` to pause cold `load()` on baseline `base-0`, concurrently starts `store2.saveProject(proj-a)` on a second `ProjectStore` instance targeting the same canonical file, releases the barrier, awaits both, then runs `store.saveProject(proj-b)`.
   - Asserts `base-0`, `proj-a`, and `proj-b` all exist in parsed disk JSON and `await store.load()`, and `memState` equals `diskJson`.
2. **`AUD-P1-01 Test 2: waiting cold load observes preceding committed write via cache re-check without stale disk overwrite`**
   - Uses a deterministic `renameEntered` / `renameGate` barrier on `fs.rename` to hold `saveProject(proj-ahead)` in the queue before cache publication, starts a waiting cold `load()`, releases rename, and asserts the waiting `load()` returns `["base-w", "proj-ahead"]` with `0` extra `fs.readFile` calls and exact disk/cache equality.
3. **`AUD-P1-01 Test 3: concurrent cold loads serialize hydration, read disk once, and return isolated defensive clones`**
   - Pauses the first cold `load()` with a deterministic barrier, launches 4 more concurrent cold `load()` calls (5 total), releases the barrier, asserts `fs.readFile` ran **exactly once** (`targetReadCount === 1`), verifies deep defensive isolation (mutating `results[0].projects[0].name` and `tasks` leaves `results[1..4]` and warm `store.load()` unaffected), and verifies warm fast-path keeps `targetReadCount === 1`.
4. **`AUD-P1-01 Test 4: cold load read error does not poison queue or publish partial state, and preserves ENOENT initialization`**
   - Forces transient `EACCES` on cold `load()` against a persisted baseline (`err-base`), verifies graceful `{ activeProjectId: null, projects: [] }` return without polluting cache (next `load()` recovers `["err-base"]`), verifies subsequent `saveProject(err-next)` preserves `["err-base", "err-next"]` on disk and cache, and verifies brand-new missing file (`ENOENT`) initializes cleanly and persists subsequent saves.

---

## 8. Deterministic Concurrency Evidence

- Zero `setTimeout`-based race assumptions: Tests 1, 2, and 3 coordinate exact interleavings using explicit `Promise` barriers (`readEntered`/`readGate`, `renameEntered`/`renameGate`, `firstReadEntered`/`firstReadGate`) and clean up all `vi.spyOn` mocks in `finally` blocks.
- Under the previous unserialized `load()`, Test 1's interleaving allowed `store2.saveProject(proj-a)` to commit while `store.load()` held the baseline read, clobbering `_cacheByFile` on resume and causing `store.saveProject(proj-b)` to permanently drop `proj-a`. With the fix, `store2.saveProject(proj-a)` deterministically queues behind the cold hydration transaction, preserving all three projects (`base-0`, `proj-a`, `proj-b`).

---

## 9. Disk / Cache Equality After Concurrent Operations

Every concurrency test (`AUD-P1-01 Tests 1–4`) explicitly parses the persisted `tempFile` via `JSON.parse(await fs.readFile(tempFile, "utf-8"))` and asserts `expect(await store.load()).toEqual(diskJson)` — confirming 100% disk/cache parity.

---

## 10. Queue Failure and Recovery Evidence

- `AUD-P1-01 Test 4` proves that a non-`ENOENT` cold-load error (`EACCES`) does not poison `_fileQueues`, does not cache empty/partial state, and allows subsequent reads and writes (`err-base`, `err-next`) to complete cleanly.
- All prior failed-write integrity and queue-recovery behavior in `ProjectStore.ts` (`_atomicPersistAndPublishLocked`, `runFileTransaction`, `Batch 5 GAP-10.3-07`) remained untouched and passing.

---

## 11. All Regression Commands, Exit Codes, and Test Counts (Non-Double-Counted)

| # | Exact Command | Exit Code | Passed | Failed | Skipped | Classification |
| :-: | :--- | :-: | :-: | :-: | :-: | :--- |
| 1 | `npx vitest run --fileParallelism=false tests/unit/projects.test.ts` | `0` | 21 *(17 prior + 4 `AUD-P1-01`)* | 0 | 0 | Automated Unit Suite |
| 2 | `npx vitest run --fileParallelism=false tests/unit/planner.test.ts` | `0` | 71 | 0 | 0 | Automated Unit Suite |
| 3 | `npx vitest run --fileParallelism=false tests/unit/phase10_project_continuity.test.ts tests/unit/phase10_audio_continuity.test.ts` | `0` | 117 *(90 project + 27 audio)* | 0 | 0 | Automated Unit/Mocked-WS Suite |
| 4 | `npx vitest run --fileParallelism=false tests/unit/companion_core_phase1.test.ts tests/unit/stage10_1_10_2_security_remediation.test.ts tests/unit/gemini_live_auth_regression.test.ts` | `0` | 72 *(42 companion + 19 sec + 11 live auth)* | 0 | 0 | Automated Security/Regression Suite |
| 5 | `npx vitest run --fileParallelism=false tests/e2e/cross_platform_e2e_phase29.test.ts -t "strictly preserves"` | `0` | 1 | 0 | 41 *(filtered by `-t`; not claimed passed)* | Automated E2E Invariant Check |
| 6 | `npx tsc --noEmit` | `0` | 0 errors | 0 | — | TypeScript Static Check |
| 7 | Standalone ESM + `LIVE_TOOLS` probe (`npx tsx -e ...`) | `0` | `esmProjectStore: true`, `129 / 129` | 0 | — | Module & Schema Invariant Probe |
| **Aggregate Vitest (Non-Double-Counted)** | **8 distinct tracked test files** | **All `0`** | **282** | **0** | **41** *(filtered)* | **Automated Verification** |

---

## 12. `LIVE_TOOLS` 129/129 Verification

Programmatic probe output (exit code `0`):
```json
{"esmProjectStore":true,"liveToolsTotal":129,"liveToolsUnique":129,"hasConfirmationToken":false,"hasGetProjectContinuity":false}
```

---

## 13. P0 Security and Stage 10.1 / 10.2 / 10.4.2 Regression Status

- **Stage 10.3 P0 Security (`GAP-10.3-04`, `AUD-P0-01`..`AUD-P0-04`):** **`PASS`** (`phase10_project_continuity.test.ts` 90/90, `LIVE_TOOLS` 129/129 without `confirmationToken`).
- **Stage 10.1 / 10.2 Governance & Memory Security:** **`PASS`** (`stage10_1_10_2_security_remediation.test.ts` 19/19, `companion_core_phase1.test.ts` 42/42).
- **Stage 10.4.2 Confirmation Revocation, Local `/live` Auth & Audio Continuity:** **`PASS`** (`phase10_audio_continuity.test.ts` 27/27, `gemini_live_auth_regression.test.ts` 11/11).

---

## 14. Frozen-Boundary Verification

Verified via file modification timestamps (no Git operations, no dependencies, no config changes):
- **Only 2 Authorized Files Modified:**
  - `backend/projects/ProjectStore.ts` (`2026-11-18 22:30:51`)
  - `tests/unit/projects.test.ts` (`2026-11-18 22:31:31`)
- **All Frozen Files Untouched:**
  - `backend/server.ts` (`2026-11-18 19:30:25`)
  - `backend/ai/GeminiSessionFactory.ts` (`2026-11-18 21:48:26`)
  - `backend/projects/ProjectManager.ts` (`2026-11-18 20:47:35`)
  - `backend/projects/ProjectDecisionStore.ts` (`2026-11-18 20:49:17`)
  - `backend/projects/ProjectContinuityResolver.ts` (`2026-11-18 20:49:16`)
  - `backend/planner/PlannerCoordinator.ts` (`2026-09-23 18:11:38`)
  - `backend/planner/PlanStore.ts` (`2026-11-18 20:45:51`)
  - `backend/tools/ToolOrchestrator.ts` (`2026-11-18 21:48:50`)
  - `backend/conversation/ConversationManager.ts` (`2026-11-18 20:46:30`)
  - `backend/security/SecurityPolicyEngine.ts` (`2026-11-18 21:46:24`)
  - `backend/security/SecurityAuditLogger.ts` (`2026-11-18 21:46:24`)
  - `backend/security/SecurityRiskEngine.ts` (`2026-11-18 21:43:43`)
  - `backend/device/RemoteBridge.ts` (`2026-09-26 23:46:12`)
  - `tests/unit/phase10_project_continuity.test.ts` (`2026-11-18 21:55:00`)
  - `android/`, `electron/`, `desktop_agent/` (untouched)

---

## 15. Cross-Process Limitation vs. Same-Process Guarantees

- **Same-Process Guarantee:** All concurrent reads (cold hydration) and writes (`save`, `saveProject`, `setActiveProject`, `deleteProject`) across one or more `ProjectStore` instances sharing a canonical resolved file path inside **one Node.js process** are serialized through `_fileQueues` with zero lost updates.
- **Cross-Process / Multi-Host Limitation:** `_fileQueues` is an in-memory Node.js Map and does **not** synchronize independent OS processes or multi-replica cloud hosts sharing a file. Local Electron desktop (`electron/main.cjs:113, 183`) runs a single backend process; cloud Render replica/scaling configuration remains unverified (`NOT VERIFIED`).

---

## 16. Remaining Blocked or Unverified Checks

- **Independent Read-Only P1 R2 Acceptance Audit:** Pending separate independent audit to formally close P1.
- **Cloud Multi-Replica Deployment Topology:** `NOT VERIFIED` (no Render/Docker scaling manifest in repo).
- **Live Gemini Cloud Staging (`BLOCKED`) & Chromium/Playwright Browser DOM (`NOT VERIFIED`):** Unchanged, out of scope for P1.
- **Out-of-Scope P2 (`TaskPlan.projectId` stamping / `PlannerCoordinator.ts`):** Not started.

---

## Final Status (`AUD-P1-01`)

**`PASS`**
