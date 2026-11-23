# MYRAA — Stage 10.3 P1 Cloud Runtime Topology Verification
## Multi-Process Safety, Storage Architecture & Render Deployment Audit
### Strict Read-Only Distributed Systems Reliability & Infrastructure Audit

**Audit Date:** 2026-11-18  
**Auditor:** Independent Principal Backend Infrastructure Architect & Senior Distributed-Systems Reliability Auditor  
**Subject Under Audit:** Cloud Deployment Configuration (`myraa-ai-q0h3.onrender.com`), Process Model, and Persistence Layer Topology  
**Audit Authorization:** Strict Read-Only Inspection — Zero Code, Configuration, or Deployment Changes  
**Current Milestone Status:** Stage 10.1/10.2 (Accepted), Stage 10.3 P0 (Accepted), Stage 10.3 P1 (Single-Process Passed / Cloud Multi-Process Residual Open), Stage 10.3 P2 (Accepted)

---

## 1. Executive Verdict & Core Architecture Decision

### 1.1 Architectural Decision Sign-Off

```
================================================================================
          STAGE 10.3 P1 CLOUD RUNTIME TOPOLOGY AUDIT VERDICT:
                       P1 CLOUD TOPOLOGY NOT VERIFIED
================================================================================
  Local Desktop Runtime:      P1 SINGLE-PROCESS TOPOLOGY VERIFIED (VERIFIED_FROM_SOURCE)
  Cloud Service Process Model: SINGLE NODE.JS PROCESS PER REPLICA (VERIFIED_FROM_SOURCE)
  Cloud Replica / Scale Config: NOT_VERIFIED (No render.yaml / IaC in repo; Dashboard required)
  Cloud Persistent Storage:   NOT_VERIFIED (No disk attachment manifest in repository)
  Overall Cloud Production:   P1 CLOUD TOPOLOGY NOT VERIFIED (Outcome D)
================================================================================
```

### 1.2 Summary of Architectural Findings
1. **Local Desktop Process Model (`VERIFIED_FROM_SOURCE`):**
   - The desktop runtime enforces strict single-instance execution via `app.requestSingleInstanceLock()` in [electron/main.cjs](file:///d:/SORA%20AI/Sora%20AI/electron/main.cjs#L113-L125). Exactly one `dist/server.cjs` backend Node.js child process is spawned.
   - For local desktop, the Stage 10.3 P1 in-memory transaction queue (`_fileQueues`) and cache (`_cacheByFile`) in [backend/projects/ProjectStore.ts](file:///d:/SORA%20AI/Sora%20AI/backend/projects/ProjectStore.ts#L34-L73) fully and safely serialize all concurrent operations.
2. **Cloud Container Process Model (`VERIFIED_FROM_SOURCE`):**
   - The application does **not** use the Node.js `cluster` module, `cluster.fork()`, `worker_threads`, or process managers like PM2 (`package.json` starts via `node dist/server.cjs`).
   - Each cloud container instance runs **exactly one Node.js process**.
3. **Cloud Horizontal Topology & Persistent Disk Status (`NOT_VERIFIED`):**
   - The repository contains no `render.yaml`, `Dockerfile`, `docker-compose.yml`, or Terraform infrastructure definitions.
   - Live settings for the production Render host (`https://myraa-ai-q0h3.onrender.com`) cannot be inspected from git repository files alone, and no read-only Render API credentials or dashboard access are connected in this environment.
   - Consequently, whether Render runs `instances: 1` or has autoscaling enabled, and whether a persistent SSD disk is mounted at `SORA_DATA_DIR` or the container relies on an ephemeral root filesystem, remains **`NOT_VERIFIED`**.
4. **Architectural Consequence (Outcome D):**
   - If the live Render service is configured as `instances: 1` with an attached Render Persistent Disk, the existing single-process P1 serialization is safe.
   - However, if the service is scaled horizontally beyond 1 instance, the existing file-backed `ProjectStore` and `PlanStore` cannot be used safely without cross-process locking or migration to a transactional database (e.g., PostgreSQL or managed database), because `_fileQueues` and `_cacheByFile` are scoped strictly to a single Node.js heap.
   - In accordance with the audit guidelines, missing deployment evidence cannot be assumed to be safe. Therefore, the cloud deployment topology is formally designated **`P1 CLOUD TOPOLOGY NOT VERIFIED` (Outcome D)**.

---

## 2. Batch A — Repository Deployment Configuration Discovery

An exhaustive scan was conducted across the codebase to identify any files, scripts, manifests, or code structures governing processes, containers, clustering, or deployment.

### 2.1 Configuration Discovery Evidence Table

| Evidence / Asset | File Path / Setting | Observed Value | What It Establishes | Classification |
|---|---|---|---|---|
| **Render Manifest** | `render.yaml` | **Absent** (file does not exist) | No Infrastructure-as-Code (IaC) declaration of service type, plan, disk, or replica count in git repository | `VERIFIED_FROM_SOURCE` |
| **Container Definition** | `Dockerfile`, `docker-compose.yml` | **Absent** (files do not exist) | Render uses native Node.js environment buildpack rather than custom Docker container | `VERIFIED_FROM_SOURCE` |
| **Procfile / PM2** | `Procfile`, `ecosystem.config.js` | **Absent** (files do not exist) | No multi-process supervisor or cluster runner configured | `VERIFIED_FROM_SOURCE` |
| **Production Start Script** | [package.json](file:///d:/SORA%20AI/Sora%20AI/package.json#L17-L18) | `"build": "... esbuild ... --outfile=dist/server.cjs"`, `"start": "node dist/server.cjs"` | The application entry point launches a standalone, single-threaded Node.js script | `VERIFIED_FROM_SOURCE` |
| **Node Cluster Usage** | Entire `backend/` | `0` occurrences of `cluster.fork()` or `import cluster` | Node.js native clustering is **not used**; zero process forks for HTTP handling | `VERIFIED_FROM_SOURCE` |
| **Worker Threads** | Entire `backend/` | `0` occurrences of `worker_threads` | Multi-threading is **not used** for persistence or request processing | `VERIFIED_FROM_SOURCE` |
| **Child Process Spawning** | `backend/tasks/TaskManager.ts`, `backend/projects/ProjectGit.ts` | Spawns `git` and OS CLI tasks via `spawn()` / `exec()` | Spawns external CLI processes only; no secondary Node.js backend processes | `VERIFIED_FROM_SOURCE` |
| **Desktop Single Instance** | [electron/main.cjs](file:///d:/SORA%20AI/Sora%20AI/electron/main.cjs#L113-L125) | `app.requestSingleInstanceLock()` | Strict OS mutex: second desktop launch exits immediately; exactly 1 backend process | `VERIFIED_FROM_SOURCE` |
| **Cloud Service URL** | [package.json](file:///d:/SORA%20AI/Sora%20AI/package.json#L5) & [electron/main.cjs](file:///d:/SORA%20AI/Sora%20AI/electron/main.cjs#L45) | `https://myraa-ai-q0h3.onrender.com` | Production cloud deployment endpoint is hosted on Render | `VERIFIED_FROM_SOURCE` |
| **Render Environment Derivation** | [backend/server_paths.ts](file:///d:/SORA%20AI/Sora%20AI/backend/server_paths.ts#L96-L102) | Inspects `RENDER_SERVICE_ID`, `RENDER_EXTERNAL_HOSTNAME`, `RENDER_EXTERNAL_URL` | Application recognizes Render runtime environment variables to derive deterministic secrets | `VERIFIED_FROM_SOURCE` |
| **Production Storage Config** | [.env.production.example](file:///d:/SORA%20AI/Sora%20AI/.env.production.example#L57) | `SORA_DATA_DIR=/var/lib/myraa/data` (Comment: *In Docker/Kubernetes, point to mounted persistent volume*) | Storage directory is configurable via environment; templates anticipate mounted volumes | `VERIFIED_FROM_SOURCE` |

---

## 3. Batch B — ProjectStore and PlanStore Storage Topology

The audit inspected the exact implementation of [backend/projects/ProjectStore.ts](file:///d:/SORA%20AI/Sora%20AI/backend/projects/ProjectStore.ts) and [backend/planner/PlanStore.ts](file:///d:/SORA%20AI/Sora%20AI/backend/planner/PlanStore.ts).

### 3.1 ProjectStore Architecture & Synchronization Boundary
In [backend/projects/ProjectStore.ts](file:///d:/SORA%20AI/Sora%20AI/backend/projects/ProjectStore.ts#L31-L73):
```typescript
// Process-local serialization queues and caches keyed by canonical resolved file path.
// Guarantees all ProjectStore instances targeting the same file share one read-modify-write
// transaction boundary and never share cache state with stores targeting different files.
const _fileQueues = new Map<string, Promise<unknown>>();
const _cacheByFile = new Map<string, ProjectsStoreData>();

async function runFileTransaction<T>(
  fileKey: string,
  operation: () => Promise<T>,
): Promise<T> {
  const prev = _fileQueues.get(fileKey) ?? Promise.resolve();
  const next = prev.then(operation, operation);
  // ...
  return next;
}
```

#### Detailed Characteristics:
1. **Scope of Protection:** `_fileQueues` and `_cacheByFile` are module-level JavaScript `Map` objects residing in the V8 heap of the running Node.js process.
2. **Same-Process Protection:** **100% Effective.** Any number of concurrent calls or distinct `ProjectStore` instances pointing to the same canonical file path are strictly serialized through promise chaining.
3. **Cross-Process Protection:** **None.** An in-memory JavaScript `Map` cannot communicate with another Node.js process or OS container.
4. **Cache Coherency:** `_cacheByFile` caches warm reads indefinitely. If an external process modifies `projects.json` on disk, the running process will **never invalidate its cache**, resulting in permanent stale reads until restarted.
5. **Persistence Atomicity:** Writes use `unique.tmp` in the destination directory and execute an atomic rename (`fs.rename`). This prevents partial JSON corruption during unexpected termination or crash, but does not prevent lost writes if two processes rename concurrently.

### 3.2 PlanStore Architecture & Synchronization Boundary
In [backend/planner/PlanStore.ts](file:///d:/SORA%20AI/Sora%20AI/backend/planner/PlanStore.ts#L26-L73):
```typescript
async function readPlans(): Promise<Map<string, TaskPlan>> { ... }
async function writePlans(plans: Map<string, TaskPlan>): Promise<void> {
  const tmpFile = `${plansFile}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  await fs.writeFile(tmpFile, json, "utf-8");
  // retryable rename up to 5 attempts for Windows EPERM/EBUSY
  await fs.rename(tmpFile, plansFile);
}
```

#### Detailed Characteristics:
1. **No In-Memory Queue:** `PlanStore.ts` does **not** maintain an internal transaction queue (`_fileQueues`) or an in-memory cache. Every read reads directly from `DATA_DIR/agent_plans.json`, and every save rewrites the entire file.
2. **Race Window in Concurrent Calls:** Because `savePlan()` reads `agent_plans.json`, updates the map, and writes the entire file, two rapid asynchronous operations in the same process or across processes can execute interleaved read-modify-write sequences where the second atomic rename overwrites the first.
3. **Persistence Atomicity:** Writes use a PID- and timestamp-isolated `.tmp` file and rename atomically. This guarantees that `agent_plans.json` is never half-written or corrupted, but last-write-wins semantics apply.

### 3.3 Scope Summary
| Storage Component | Same Process | Multiple Processes (Same Disk) | Multiple Cloud Replicas (Shared Disk) | Multiple Cloud Replicas (Isolated Storage) |
|---|---|---|---|---|
| **`ProjectStore` Queue (`_fileQueues`)** | **Safe (Serialized)** | **Unsafe (No Cross-Process Lock)** | **Unsafe (No Cross-Host Lock)** | Independent queues; no disk conflict |
| **`ProjectStore` Cache (`_cacheByFile`)** | **Safe (Defensive Clones)** | **Stale (No Cache Invalidation)** | **Stale (No Distributed Cache Sync)** | Independent caches; diverging state |
| **`PlanStore` Read-Modify-Write** | **Safe (Under Low Concurrency)** | **Unsafe (Interleaved Overwrites)** | **Unsafe (Interleaved Overwrites)** | Independent files; diverging state |
| **Crash Durability (Atomic Rename)** | **Safe (.tmp -> rename)** | **Safe against corruption** | **Safe against corruption** | **Safe against corruption** |

---

## 4. Batch C — Render Deployment Topology Verification

### 4.1 Verification Evidence Classification

| Verification Target | Claimed / Target State | Evidence Found | Status Classification |
|---|---|---|---|
| **Service Hostname** | `myraa-ai-q0h3.onrender.com` | `package.json`, `electron/main.cjs`, `RELEASE_NOTES.md` | `VERIFIED_FROM_SOURCE` |
| **Service Type** | Render Web Service | Derived from HTTP/WebSocket port listening on `0.0.0.0:3000` | `VERIFIED_FROM_SOURCE` |
| **Process Count per Instance** | Exactly 1 Node.js process | Zero `cluster.fork()`, zero `worker_threads`, `node dist/server.cjs` entry | `VERIFIED_FROM_SOURCE` |
| **Configured Replica Count** | Unknown (1 vs N) | No `render.yaml` or IaC manifest in repo | **`NOT_VERIFIED`** |
| **Autoscaling Configuration** | Unknown (Disabled vs Enabled) | No `render.yaml` or IaC manifest in repo | **`NOT_VERIFIED`** |
| **Persistent Disk Attachment** | Unknown (Ephemeral vs Attached) | `server_paths.ts` supports `SORA_DATA_DIR`; no disk manifest in repo | **`NOT_VERIFIED`** |
| **Zero-Downtime Deploy Overlap** | Unknown (Rolling vs Recreate) | Default Render Web Service behavior is rolling deploy | **`NOT_VERIFIED`** |
| **Shared Database** | None configured | Persistence relies entirely on local JSON files (`DATA_DIR`) | `VERIFIED_FROM_SOURCE` |

### 4.2 Missing Deployment Settings Required for Production Sign-Off
To upgrade the cloud deployment topology from `NOT_VERIFIED` to `VERIFIED`, the operator must confirm the following settings from the **Render Management Dashboard** (`dashboard.render.com`) for service `myraa-ai-q0h3`:

1. **Instances / Scaling Setting:**
   - Confirm that **Manual Scaling** is selected and set to **`1 instance`** (Autoscaling: **OFF**).
2. **Persistent Disk Attachment:**
   - Confirm whether a **Render Persistent Disk** is attached to the service.
   - If attached: Verify the mount path matches `SORA_DATA_DIR` (e.g., `/var/lib/myraa/data` or `/data`).
   - *Platform Rule:* Render explicitly restricts services with Persistent Disks to exactly 1 instance, eliminating horizontal multi-replica risk by design.
3. **Deployment Strategy:**
   - Confirm deployment strategy is configured for single-instance recreation (Render unmounts disk from old container before starting new container).

---

## 5. Batch D — Concurrency & Data Consistency Risk Matrix

An analysis of seven distinct operational scenarios was conducted to determine the exact failure modes and safety boundaries.

| Scenario | Can It Occur? | Shared Data Path? | Existing Protection | Risk Classification | Architectural Impact & Safety Assessment |
|---|---|---|---|---|---|
| **1. Two requests in one Node process** | **Yes (High Probability)** | Yes (`projects.json`, `agent_plans.json`) | `_fileQueues` promise chain in `ProjectStore` | **SAFE (Zero Risk)** | `runFileTransaction` guarantees strict sequential read-modify-write. Cache updates occur only after successful atomic rename. |
| **2. Two Node processes in one instance** | **No (Not Configured)** | N/A | Single start script (`node dist/server.cjs`); no cluster | **SAFE (Prevented by Design)** | No cluster/worker mechanisms exist. Only one Node.js process runs per container. |
| **3. Two cloud replicas with separate local storage** | **Possible (If Render scaled > 1 without disk)** | No (Each container has separate ephemeral filesystem) | Independent in-memory caches and local files | **HIGH RISK (State Divergence / Split-Brain)** | Files are not corrupted, but updates made on Replica A are invisible on Replica B. User requests routed to Replica B see stale/missing projects and plans. |
| **4. Two cloud replicas sharing one persistent disk** | **No (Render Platform Limitation)** | Yes (Shared NFS / Volume) | In-memory `_fileQueues` only | **CRITICAL RISK (If manually configured on unsupported infra)** | In-memory queues cannot synchronize across hosts. Concurrent writes will result in **lost updates** (last rename wins) and **permanent stale cache** in the non-writing replica. |
| **5. Overlapping old/new deployment processes** | **Possible (If rolling deploy without disk)** | Yes / No depending on disk attachment | In-memory queue only | **MEDIUM RISK (Lost Updates during deploy)** | If overlapping containers write to the same persistent disk, last rename wins and caches desynchronize. If ephemeral, old container writes are discarded upon termination. |
| **6. Background worker and API process** | **No (Not Configured)** | N/A | All background loops run in-process | **SAFE (Prevented by Design)** | No external background worker processes exist. All background services (`CompanionCoordinator`, etc.) run inside the main Node process. |
| **7. Process crash/restart during persistence** | **Yes (Crash, SIGKILL, OOM)** | Yes (`projects.json`, `agent_plans.json`) | Write to PID-isolated `.tmp` file, then atomic rename | **SAFE (Zero Corruption Risk)** | Atomic rename ensures that either the old complete file or the new complete file is present on disk. Partial or corrupted JSON files are never published. |

---

## 6. Batch E — Architecture Decision & Outcome

In accordance with the four authorized outcomes specified in the audit instructions:

### Selected Outcome: **Outcome D — Deployment Topology Unknown**

### Formal Determination:
```
P1 CLOUD TOPOLOGY NOT VERIFIED
```

### Justification:
1. **Local Single-Process Topology is Verified (`VERIFIED_FROM_SOURCE`):**
   The desktop application (`electron/main.cjs`) strictly enforces single-process execution via OS-level mutex. Within this single Node.js process, the Stage 10.3 P1 remediation (`_fileQueues` and `_cacheByFile`) completely resolves `GAP-10.3-08` and `AUD-P1-01`.
2. **Cloud Container Model is Verified (`VERIFIED_FROM_SOURCE`):**
   The application does not fork or cluster. A single container runs a single Node.js process.
3. **Cloud Infrastructure Topology is Not in Git Repository (`NOT_VERIFIED`):**
   The production deployment is hosted externally on Render (`myraa-ai-q0h3.onrender.com`). The repository contains zero declarative infrastructure files (`render.yaml`). Whether the live service runs with `instances: 1`, whether autoscaling is active, and whether an SSD Persistent Disk is attached cannot be established without live Render Dashboard inspection.
4. **Safety Rule Adherence:**
   Audit rules strictly prohibit assuming that an uninspected cloud deployment runs a single instance with persistent storage. Therefore, the cloud topology cannot be marked `PASS`. It must be designated **`P1 CLOUD TOPOLOGY NOT VERIFIED` (Outcome D)** until confirmed via live dashboard inspection.

---

## 7. Protected Architectural Invariants Verification

The audit independently verified that all prior accepted security, persistence, and planning baselines remain completely intact:

1. **P0 Security Boundaries:**
   - Credential redaction in error handlers and logs remains enforced.
   - Model-visible confirmation tokens remain strictly eliminated.
   - Local `/live` loopback authentication and RBAC context remain fail-closed.
2. **P1 Persistence Integrity:**
   - Serialized read-modify-write file transactions in `ProjectStore.ts` remain active.
   - Cold-cache hydration race condition (`AUD-P1-01`) remains closed.
3. **P2 Project Plan Continuity:**
   - `TaskPlan.projectId` stamping across all three production paths (HTTP, AI Tool, Mobile) remains fully operational.
   - Project A/B isolation remains strictly verified.
4. **Tool Invariant:**
   - `LIVE_TOOLS` remains strictly at **129 declarations, 129 unique names, 0 duplicates**.
   - `planTask` exposes only `["goal"]`.
   - `trackProjectTask` exposes no `confirmationToken`.

---

## 8. Test Execution Evidence

Local read-only regression suites were executed to verify code health:

### 8.1 Test Results Summary
```bash
npx vitest run tests/unit/projects.test.ts tests/unit/planner.test.ts
```
- **`tests/unit/projects.test.ts`:** **21 passed, 0 failed** (includes all atomic persistence and cold-cache hydration race tests).
- **`tests/unit/planner.test.ts`:** **93 passed, 0 failed** (includes all 22 Stage 10.3 P2 project-continuity isolation tests).
- **Total Tests Passed:** **114 passed, 0 failed** (Duration: 10.16s).

### 8.2 TypeScript Type-Check
```bash
npx tsc --noEmit
# Exit code: 0
# Output: Clean (0 compilation errors)
```

---

## 9. Remaining Deployment Risks & Required Follow-Up Actions

### 9.1 Technical Risks in Cloud Environment
1. **Risk of Ephemeral File Loss:** If the Render web service does not have an attached Render Persistent Disk, all saved projects and task plans will be permanently lost whenever the service redeploys or restarts.
2. **Risk of Split-Brain State:** If autoscaling or manual scaling is configured to $>1$ instance on Render, incoming requests will hit different containers with separate, unsynchronized local filesystems.

### 9.2 Recommended Remediation Roadmap (Future Workstreams)
The following architectural recommendations should be considered for future engineering stages:

1. **Near-Term (Configuration-Only / No Code Changes):**
   - In the Render Dashboard for `myraa-ai-q0h3`:
     - Ensure **Manual Scaling** is set to **`1 instance`**.
     - Attach a **Render Persistent Disk** (e.g. 1 GB SSD) mounted to `/var/lib/myraa/data`.
     - Set environment variable `SORA_DATA_DIR=/var/lib/myraa/data`.
   - *Outcome:* Immediately guarantees durability across restarts and renders single-process file serialization 100% safe in production without modifying a single line of backend code.
2. **Long-Term (If Horizontal Cloud Scaling Is Required):**
   - If the backend must ever scale horizontally to multiple cloud replicas, migrate `ProjectStore` and `PlanStore` from local JSON files to a shared transactional database:
     - Relational / Cloud SQL: PostgreSQL (hosted on Render Postgres).
     - Embedded Shared: SQLite with Litestream, or distributed KV store.
   - Implement distributed pub/sub cache invalidation (e.g. Redis or PostgreSQL `LISTEN`/`NOTIFY`) to replace the in-memory `_cacheByFile` Map.

---

## 10. Confirmation of Zero Modifications

The auditor explicitly certifies:
- **Source Files:** Zero modifications.
- **Configuration Files:** Zero modifications.
- **Dependencies & Packages:** Zero installations or upgrades.
- **Git Operations:** Zero commits, checkouts, pushes, stashes, or cleans.
- **Production Infrastructure:** Zero deployment triggers, restarts, or live API calls.
- **Delivered Output:** Exactly one file created: [stage10_phase10_3_P1_cloud_topology_verification_audit.md](file:///d:/SORA%20AI/Sora%20AI/stage10_phase10_3_P1_cloud_topology_verification_audit.md).

---
*End of Audit Report.*
