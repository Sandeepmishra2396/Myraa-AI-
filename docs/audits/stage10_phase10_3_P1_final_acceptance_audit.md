# MYRAA — Stage 10.3 P1 Final Independent Acceptance Audit (`GAP-10.3-08`)

- **Audit Mode:** STRICT READ-ONLY — Independent Principal Backend Architecture, Persistence Reliability & Security Verification
- **Date:** 2026-11-18
- **Audited Remediation Report:** `stage10_phase10_3_P1_project_store_integrity_remediation_report.md`
- **Audited Source File:** `backend/projects/ProjectStore.ts` (`lines 1–358`)
- **Executive Verdict:** **`FAIL`** *(Warm-cache write-write serialization, multi-instance same-file writes, failed-write cache integrity, queue recovery, deep defensive cloning, atomic rename/cleanup, path-keyed cache isolation, and all 278 tracked tests passed. However, independent read-only auditing empirically reproduced an in-process cold-cache `load()` vs. concurrent `saveProject()` race (`AUD-P1-01`, HIGH) at `ProjectStore.ts:196–219` that clobbers the published cache with a stale snapshot and causes a permanent lost update on the next write.)*

---

## 1. Executive Verdict

**Verdict: `FAIL`**

### Rationale Against Section 11 Verdict Rules

- **Verified Closed:**
  - In-place cache mutation before persistence is eliminated (`_readLatestLocked()` + `_atomicPersistAndPublishLocked()` publish cache strictly after `fs.rename` succeeds).
  - Concurrent same-instance (25/25) and multi-instance same-file (33 interleaved ops across equivalent path forms) write-write mutations preserve all updates with zero lost updates.
  - Failed writes (JSON serialization failure, `writeFile` `EACCES`, 5-attempt `EBUSY` rename exhaustion, `unlink` failure during cleanup, `ProjectManager.addTask` external mutation) leave both disk and published cache intact and never invalidate instructions cache.
  - Rejected transactions recover cleanly with zero queue poisoning and zero unhandled rejections.
  - Deep nested defensive cloning (`structuredClone`) isolates all nested objects/arrays (`tasks`, `frameworks`, `manifest.dependencies`, `architectureMap.layers`, `git.recentCommits`, `lastSession`).
  - Path-keyed `_cacheByFile` prevents cross-file contamination.
  - Existing APIs, `ProjectManager`, `ProjectContinuityResolver`, `ProjectDecisionStore`, standalone ESM import, `tsc --noEmit`, `LIVE_TOOLS` 129/129, and all 278 tracked regression tests pass with zero frozen-boundary violations.
- **Why the Verdict MUST Be `FAIL` (`AUD-P1-01` — HIGH):**
  - Under Section 11 Verdict Rules, **`FAIL`** is mandatory whenever *"Concurrent in-process operations can lose successful updates."*
  - At `backend/projects/ProjectStore.ts:196–219`, `load()` runs `await fs.readFile(this.filePath, "utf-8")` **outside** `runFileTransaction()` on a cold cache miss (e.g., process startup during `prewarmInstructions()` or after `clearCache()`) and then **unconditionally calls `_cacheByFile.set(this.fileKey, ...)`** (`lines 209, 214`).
  - Our independent read-only runtime harness (`audit_p1_verify.mts`) empirically proved:
    1. Cold `load()` reads pre-write disk (`ENOENT` / stale snapshot).
    2. Concurrent `saveProject(A)` commits `[A]` to disk and publishes `[A]` to `_cacheByFile`.
    3. Cold `load()` resumes and overwrites `_cacheByFile` with the stale/empty snapshot (`coldRaceClobberedCache: true`).
    4. Subsequent `saveProject(B)` reads the clobbered `_cacheByFile` via `_readLatestLocked()` and overwrites disk with `[B]`, **permanently losing committed project `A`** (`coldRaceLostUpdateOnNextWrite: true`).

---

## 2. Finding-by-Finding Closure Matrix

| Area / Finding ID | Requirement | Independent Status | Classification | Evidence |
| :--- | :--- | :---: | :--- | :--- |
| `GAP-10.3-08` (Write-Write Queue) | Same-instance & multi-instance same-file write serialization | **CLOSED (write-write)** | `PASS — SOURCE INSPECTION`, `PASS — ISOLATED HARNESS` | `_fileQueues` keyed by `canonicalFileKey`; 25 same-instance & 33 multi-instance interleaved ops preserved with 0 lost updates. |
| `GAP-10.3-08` (Post-Rename Cache Publish) | Copy-on-write isolation & failed-write cache/disk integrity | **CLOSED** | `PASS — SOURCE INSPECTION`, `PASS — ISOLATED HARNESS` | Cache published only at `line 171` after `fs.rename`; BigInt, `writeFile`, 5x `EBUSY` exhaustion, `unlink` failure all left cache & disk intact. |
| `GAP-10.3-08` (Queue Recovery) | Failed transactions do not poison queue or emit unhandled rejections | **CLOSED** | `PASS — SOURCE INSPECTION`, `PASS — ISOLATED HARNESS` | `tail` absorbs rejections, cleans idle entries safely; `0` unhandled rejections observed. |
| `GAP-10.3-08` (Cache Isolation & Deep Clone) | Path-keyed cache isolation & nested defensive copies | **CLOSED** | `PASS — SOURCE INSPECTION`, `PASS — ISOLATED HARNESS` | `_cacheByFile` isolated per canonical path; `structuredClone` protects all nested arrays/objects. |
| **`AUD-P1-01`** *(New — Batch B/C/D)* | Cold-cache `load()` cannot clobber a concurrent committed write and cause a lost update | **OPEN (HIGH)** | **`FAIL`** | Empirically reproduced in `ProjectStore.ts:196–219`: `coldRaceClobberedCache: true`, `coldRaceLostUpdateOnNextWrite: true`. |
| `GAP-10.3-08` (API, ESM & Regressions) | Compatibility, instruction-cache invalidation, ESM safety, 129/129 `LIVE_TOOLS` | **CLOSED** | `PASS — AUTOMATED TEST`, `PASS — SOURCE INSPECTION` | 8 tracked suites (278 passed, 0 failed, 41 filtered-skipped), `tsc` (0 errors), standalone ESM OK, `LIVE_TOOLS` 129/129. |
| Deployment Topology (Cross-Process) | Establish whether cloud deployment is single-process | **UNVERIFIED (Cloud)** | `NOT VERIFIED` *(Local Desktop = single process verified)* | Local Electron (`electron/main.cjs:113, 183`) & `package.json` run single Node.js process; cloud Render scaling config absent from repo. |

---

## 3. Source-Level Transaction Architecture Review

Inspected `backend/projects/ProjectStore.ts` (`lines 1–358`):
- **Constructor (`lines 88–92`):** Resolves `this.filePath = path.resolve(customFilePath || PROJECTS_FILE)` and computes `this.fileKey = canonicalFileKey(this.filePath)`.
- **Public mutation entry points (`save`, `setActiveProject`, `saveProject`, `deleteProject` at `lines 226–348`):** Every public mutator wraps its entire read-modify-write cycle inside `runFileTransaction(this.fileKey, ...)`, clones input/state before mutation, and calls internal `_readLatestLocked()` + `_atomicPersistAndPublishLocked()` directly (zero recursive lock acquisition).
- **Read path (`load()` at `lines 196–220`):** Fast-paths cache hit via `_cacheByFile.get(this.fileKey)` returning `cloneStoreData(cached)`. On cold cache miss, performs `fs.readFile` **outside** `runFileTransaction` and unconditionally calls `_cacheByFile.set(this.fileKey, ...)` (`lines 209, 214`), introducing `AUD-P1-01`.

---

## 4. Queue Correctness Analysis (Batch A)

Inspected `canonicalFileKey()` (`lines 38–41`), `_fileQueues` (`line 34`), and `runFileTransaction()` (`lines 56–73`):

1. **Canonical Path Keying:** `path.resolve(filePath)` + `.toLowerCase()` on `win32` normalizes relative paths, `..`, `.`, and Windows drive/case differences into one key.
   - **Supported Path Guarantee Caveat:** `path.resolve()` is purely lexical. It does **not** dereference OS symbolic links, Windows NTFS junctions/reparse points, hard links, or case-insensitive macOS APFS paths (`darwin` does not lowercase). Two aliases via symlink/junction pointing to the same inode would map to different queue/cache keys.
2. **File Isolation:** Distinct canonical paths use independent queue entries in `_fileQueues`.
3. **Multi-Instance Sharing:** Module-level `_fileQueues` is shared across all `ProjectStore` instances in the process.
4. **Full Read-Modify-Write Coverage:** `setActiveProject`, `saveProject`, `deleteProject`, and direct `save` execute completely inside `runFileTransaction`.
5. **Deadlock Freedom:** Internal helpers `_readLatestLocked()` and `_atomicPersistAndPublishLocked()` never call `runFileTransaction()` or public `save()`.
6. **Failure Isolation & Queue Cleanup:** `tail = next.then(() => undefined, () => undefined)` prevents queue poisoning and prevents unhandled rejections; `tail.finally(() => { if (_fileQueues.get(fileKey) === tail) _fileQueues.delete(fileKey); })` uses strict reference equality so cleanup can never delete a newer queued transaction and map entries do not leak after work settles.

---

## 5. Cache Publication and Failed-Write Analysis (Batch B)

Inspected `_atomicPersistAndPublishLocked()` (`lines 156–190`) and all mutators (`lines 226–348`):

- **Ordering Verified:** `READ LATEST → CLONE → MUTATE → JSON.stringify → writeFile(uniqueTmp) → fs.rename(uniqueTmp, filePath) → _cacheByFile.set(fileKey, clone)` is strictly enforced.
- **Error-Path Audit (All Verified in Source & Isolated Harness):**
  - **JSON serialization failure (e.g. `BigInt`):** Throws at `line 163` before temp write, rename, or cache set; disk & cache unchanged; error propagates.
  - **`fs.writeFile` failure (`EACCES`):** Caught at `line 181`; unlinks own `tmpFile` (if created); rethrows `EACCES`; disk & cache unchanged.
  - **`fs.rename` transient errors (`EPERM`/`EBUSY`):** Retries up to 5 total attempts (`attempt = 0..4`) with `20 * (attempt + 1)` ms backoff (`20, 40, 60, 80ms`); cache is NOT published during retries.
  - **Retry exhaustion (5th failure):** Throws `err`; unlinks own `tmpFile`; rethrows `EBUSY`; disk & cache unchanged.
  - **Temp cleanup failure (`fs.unlink` throws):** Caught in inner `try/catch` (`lines 183–187`) so the original persistence error still propagates at `line 188`.
  - **No post-failure publication path:** `_cacheByFile.set(...)` exists solely on `line 171` immediately after `await fs.rename(...)` succeeds.
  - **No post-failure instruction invalidation:** `_invalidateInstructionsCache()` runs only after `await runFileTransaction(...)` resolves.

---

## 6. Same-Instance and Multi-Instance Concurrency Evidence (Batch D)

Note: The implementation's original temporary harness (`verify_p1_project_store.mts`) was cleaned up prior to this audit (confirmed `False`), so this audit wrote and executed an **independent temporary read-only verification harness** (`audit_p1_verify.mts` in scratch dir against `os.tmpdir()`, deleted immediately post-run — confirmed `Audit harness exists: False`):

| Scenario | Independent Audit Harness Result |
| :--- | :--- |
| Same-instance concurrency (25 concurrent `saveProject`) | `PASS (25/25)` — disk JSON and `load()` match identically |
| Multi-instance same-file concurrency (`dir/projects.json` vs `dir/nested/../projects.json`, 33 interleaved ops incl. `saveProject`, `setActiveProject`, `deleteProject`) | `PASS (33 interleaved ops, 0 lost updates)` — both instances & disk match identically |
| Failed writes (BigInt serialization, `writeFile` `EACCES`, 5x `EBUSY` rename exhaustion, `unlink` failure during cleanup) + queue recovery | `PASS` — disk & cache unchanged on every failure; subsequent write commits cleanly; `0` unhandled rejections |
| Deep nested defensive cloning (`frameworks`, `manifest.dependencies`, `architectureMap.layers`, `git.recentCommits`, `tasks`, `lastSession`) | `PASS` — mutating every nested structure on returned project left published cache untouched |
| Secondary `decisionStore.deleteByProject()` failure & invalidator failure truthfulness | `PASS` — persisted `deleteProject` still returned `true`, warned cleanly, did not roll back committed state |
| **Cold-cache `load()` vs. concurrent `saveProject()` race (`AUD-P1-01`)** | **`FAIL`** — `coldRaceClobberedCache: true`, `coldRaceLostUpdateOnNextWrite: true` |

---

## 7. Cache Isolation and Defensive-Copy Assessment (Batch C)

- `_cacheByFile` isolates state per canonical resolved path (`line 35`), and `clearCache()` deletes only `this.fileKey` (`line 354`).
- `load()`, `getProject()`, `getActiveProject()`, `_readLatestLocked()`, `save()`, and `saveProject()` all apply `structuredClone` (`lines 43–49`), isolating every nested field of `ProjectContext` (`tasks`, `frameworks`, `manifest`, `architectureMap`, `git`, `lastSession`).
- **Residual Cold-Cache Defect (`AUD-P1-01`):** While warm cache reads are isolated and safe, a cold-miss `load()` (`lines 202–215`) can write stale pre-write disk data over a newer committed entry in `_cacheByFile`.

---

## 8. Atomic Rename and Cleanup Assessment

- Temp filename format: `.${base}.${process.pid}.${Date.now()}.${crypto.randomUUID()}.tmp` inside `path.dirname(this.filePath)` (`lines 157–162`).
- Confirmed unique across operations, located in exact destination directory, retries only `EPERM`/`EBUSY`, cleans up only its own `tmpFile` (independent audit verified foreign `.projects.json.foreign.tmp` survived fatal rename failure), preserves previous target file on failure, and rejects with `ENOENT` when parent directory does not exist (`Batch 5 GAP-10.3-07`).

---

## 9. `ProjectManager` and `ProjectContinuityResolver` Integration (Batch E)

- **API & Schema Compatibility:** All exports (`ProjectStore`, `projectStore`, `registerInstructionsCacheInvalidator`), constructor parameters `(customFilePath?, customDecisionStore?)`, method signatures, return types, project ordering, and persisted JSON schema `{ activeProjectId, projects }` are 100% preserved.
- **`ProjectManager` (`addTask`, `updateTask`, `getTasks`, `updateLastSession`, `getProjectContextCard`):** Works seamlessly with defensive clones; caller mutation on returned project objects no longer corrupts `_cacheByFile` if `saveProject()` fails.
- **`ProjectContinuityResolver` (`switchProject`, `resolveProjectContext`) & `ProjectDecisionStore` (`deleteByProject`):** Verified via `phase10_project_continuity.test.ts` (90/90) and independent audit harness; secondary `deleteByProject()` failure logs a warning without falsely rolling back or hiding an already-persisted project deletion.

---

## 10. Instruction-Cache Invalidation and ESM Evidence (Batch F)

- Zero static import of `GeminiSessionFactory.ts` (`ProjectStore.ts:17–22` imports only `crypto`, `fs/promises`, `path`, `../server_paths.ts`, `./ProjectTypes.ts`, `./ProjectDecisionStore.ts`).
- Standalone ESM import probe exited with code `0` (`esmProjectStore: true`).
- Invalidation runs strictly after `runFileTransaction()` commits and only on actual state change (`setActiveProject` returning `mutated === true`, `saveProject`, `deleteProject` returning `deleted === true`).
- Registered invalidator throwing logs an explicit secret-free warning (`[ProjectStore] Registered instructions cache invalidator failed; attempting lazy fallback: ...`) and falls back to lazy dynamic import without rolling back the persisted mutation.

---

## 11. Exact Regression Commands and Results (Batch G — Fresh Independent Run)

| # | Exact Command | Exit Code | Passed | Failed | Skipped | Classification |
| :-: | :--- | :-: | :-: | :-: | :-: | :--- |
| 1 | `npx vitest run --fileParallelism=false tests/unit/projects.test.ts tests/unit/planner.test.ts` | `0` | 88 *(17 projects + 71 planner)* | 0 | 0 | `PASS — AUTOMATED TEST` |
| 2 | `npx vitest run --fileParallelism=false tests/unit/phase10_project_continuity.test.ts tests/unit/phase10_audio_continuity.test.ts` | `0` | 117 *(90 project + 27 audio)* | 0 | 0 | `PASS — AUTOMATED TEST` |
| 3 | `npx vitest run --fileParallelism=false tests/unit/companion_core_phase1.test.ts tests/unit/stage10_1_10_2_security_remediation.test.ts tests/unit/gemini_live_auth_regression.test.ts` | `0` | 72 *(42 companion + 19 sec + 11 live auth)* | 0 | 0 | `PASS — AUTOMATED TEST` |
| 4 | `npx vitest run --fileParallelism=false tests/e2e/cross_platform_e2e_phase29.test.ts -t "strictly preserves"` | `0` | 1 | 0 | 41 *(filtered by `-t`; NOT claimed passed)* | `PASS — AUTOMATED TEST` |
| 5 | `npx tsc --noEmit` | `0` | 0 errors | 0 | — | `PASS — AUTOMATED TEST` |
| 6 | Standalone ESM + `LIVE_TOOLS` probe (`npx tsx -e ...`) | `0` | `esmProjectStore: true`, `129 / 129` | 0 | — | `PASS — AUTOMATED TEST` |
| 7 | Independent Audit Runtime Harness (`audit_p1_verify.mts`, deleted post-run) | `0` *(completed with defect recorded)* | 5 of 6 checks | 1 (`AUD-P1-01` cold-load race reproduced) | 0 | `FAIL — ISOLATED RUNTIME HARNESS` |
| **Aggregate Tracked Vitest (Non-Double-Counted)** | **8 distinct tracked test files** | **All `0`** | **278** | **0** | **41** *(filtered)* | `PASS — AUTOMATED TEST` |

---

## 12. `LIVE_TOOLS` 129/129 Verification

Independent programmatic probe output (exit code `0`):
```json
{"esmProjectStore":true,"liveToolsTotal":129,"liveToolsUnique":129,"hasConfirmationToken":false,"hasGetProjectContinuity":false}
```
All P0 security invariants (`129/129` unique tools, no `confirmationToken`, no model-callable approval, single-mint session-bound human confirmation, zero credential logging, local `/live` context, Stage 10.1/10.2 memory governance, Stage 10.4.2 token lifecycle & audio continuity) remain intact.

---

## 13. Frozen-Boundary Verification

Verified via direct file modification timestamps (zero Git operations; zero files modified by this audit; temporary audit harness removed: `Audit harness exists: False`):

- **Modified during P1:** ONLY `backend/projects/ProjectStore.ts` (`2026-11-18 22:13:33`).
- **Untouched Frozen Boundaries:**
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
  - `tests/unit/projects.test.ts` (`2026-10-04 17:46:35`)
  - `android/`, `electron/`, `desktop_agent/` (untouched)

---

## 14. Process-Local vs. Cross-Process Limitations

- **Same-Process Concurrency:** `_fileQueues` synchronizes concurrent mutations across one or more `ProjectStore` instances inside the **same Node.js process** (subject to closing `AUD-P1-01` for cold-cache `load()`).
- **Cross-Process / Multi-Host:** No OS-level file lock (`flock`) or distributed lock exists. Independent Node.js processes or multiple hosts sharing a `projects.json` file are **not** protected against lost updates.
- **Deployment Topology Assessment (from Repo Evidence):**
  - **Local Desktop (Electron / Dev):** `electron/main.cjs:113, 183` enforces `app.requestSingleInstanceLock()` and spawns **one** `dist/server.cjs` Node.js child process; `package.json:16, 18` starts a single Node.js process with zero `cluster`/`worker_threads` usage in `backend/server.ts`. Single-process topology is verified for local desktop.
  - **Cloud Hosting (`myraa-ai-q0h3.onrender.com`):** No `render.yaml`, `Dockerfile`, or replica/scaling configuration exists in the workspace; cloud multi-process/multi-replica topology is **`NOT VERIFIED`**.

---

## 15. Remaining Risks and Exact Authorization Required

### Blocking Defect Requiring Narrow Follow-Up Fix (`AUD-P1-01` — HIGH)
- **File & Lines:** `backend/projects/ProjectStore.ts` (`lines 196–220`, `load()` ONLY).
- **Exact Fix Required:** On a cold cache miss (`_cacheByFile.get(this.fileKey) === undefined`), serialize cold cache hydration through `runFileTransaction(this.fileKey, ...)` (checking `_cacheByFile.get(this.fileKey)` again inside the transaction before reading disk or setting `_cacheByFile`), while keeping warm cache hits (`_cacheByFile.get(this.fileKey) !== undefined`) synchronous and lock-free. This guarantees a cold `load()` can never overwrite a committed transaction's cache entry and eliminates the reproduced lost update completely.
- **Authorization Required:** Narrow re-authorization limited strictly to `backend/projects/ProjectStore.ts` (`load()` cold-miss hydration) + optional authorization to add permanent unit tests for `GAP-10.3-08` and `AUD-P1-01` into `tests/unit/projects.test.ts` (if tracked regression coverage is desired).

### Non-Blocking Architectural Limitations (Documented)
1. **Filesystem Aliasing:** `canonicalFileKey()` uses lexical `path.resolve()` (+ lowercase on `win32`) and does not resolve OS symlinks, NTFS junctions, hard links, or macOS case-insensitive APFS aliases.
2. **Cross-Process / Multi-Replica Cloud Topology:** Unverified for cloud deployments (`NOT VERIFIED`); process-local queuing applies only within a single Node.js process.
3. **Out-of-Scope Work Not Started:** P2 `TaskPlan.projectId` stamping and `PlannerCoordinator.ts` remain untouched.
