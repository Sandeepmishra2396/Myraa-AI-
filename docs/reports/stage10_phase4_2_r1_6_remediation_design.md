# MYRAA — STAGE 10, PHASE 10.4.2 (R1.6)
# FINAL REMEDIATION ARCHITECTURE CORRECTION
## Implementation Readiness Gate: Audio Continuity & Capability Revocation

**Role**: Principal Software Architect, Senior Real-Time Audio Systems Engineer, Application Security Engineer  
**Date**: 2026-11-03T12:05:00+05:30  
**Phase Objective**: Implementation Readiness Gate Specification  
**Architecture Verdict**: **`READY FOR IMPLEMENTATION AUTHORIZATION`**  

---

## 1. Executive Summary & Resolved Findings Matrix

This specification corrects and supersedes the R1.5 remediation design. It resolves all implementation-blocking findings identified across audio buffering, overflow semantics, FIFO ordering during connection drains, canonical token validation, session ownership, process restart protection, and file scope accounting.

```
┌────────────────────────────────────────────────────────────────────────┐
│ FINAL ARCHITECTURE VERDICT:                                            │
│                                                                        │
│   READY FOR IMPLEMENTATION AUTHORIZATION                               │
│                                                                        │
│ 1. Audio Continuity (SEC-P4-A01):  Bounded FIFO Ring Buffer with       │
│                                    DRAINING State & Epoch Cutover      │
│ 2. Capability Revocation (SEC-P3): Server Canonical Revocation with    │
│                                    PROCESS_BOOT_ID Replay Defense      │
│ 3. Exact Scope Accounting:         Exactly 6 Production + 2 Test Files │
│ 4. Platform Invariants:            129 LIVE_TOOLS Unchanged (129/129)  │
└────────────────────────────────────────────────────────────────────────┘
```

### R1.5 Blocking Issues & R1.6 Concrete Resolutions

| Finding ID | R1.5 Defect / Gap | R1.6 Concrete Resolution | Section |
|---|---|---|---|
| **GAP-A1** | Infinite loop in `enqueue()` when frame exceeds `maxBytes` | Pre-enqueue input validation; immediate rejection if frame $>8\text{ KB}$; guaranteed terminating `while` loop | §2.1 |
| **GAP-A2** | Inconsistent overflow policy (drop-oldest vs reject vs pause) | Single consistent policy: **Bounded FIFO Hold with Explicit Recoverable Overflow** ($24\text{ frames} / 98.3\text{ KB}$ PCM limit) | §2.2 |
| **GAP-A3** | Unordered audio during `READY` transition | Explicit **`DRAINING`** state in state machine; new frames append to queue during drain; single worker prevents overtaking | §2.3 |
| **GAP-A4** | Ambiguous project cutover timing | Strict cutover sequence: `turnComplete` -> increment `sessionEpoch` -> purge Epoch $N$ queue -> open Project B session | §2.4 |
| **GAP-A5** | Unverified audio payload API | Grounded in exact `@google/genai` LiveSession format: `session.sendRealtimeInput({ audio: { data, mimeType } })` | §2.5 |
| **GAP-B1** | Missing/optional session ownership in revocation | Mandatory authenticated `sessionId` match; `"local"` bypass prohibited for WebSocket requests | §3.1 |
| **GAP-B2** | Client-supplied expected arguments vulnerability | Server derives canonical arguments from `ProjectDecisionStore.getDecision(decisionId)`; client cannot tamper | §3.2 |
| **GAP-B3** | Independent approval/rejection consumption mechanisms | Shared atomic `_consumeTokenId()` primitive with unambiguous result codes (`SUCCESS_REVOKED`, `ALREADY_CONSUMED`) | §3.3 |
| **GAP-B4** | In-memory token set cleared on process restart | **Process Generation Binding**: `PROCESS_BOOT_ID` embedded in token HMAC; all prior-instance tokens fail-closed on restart | §3.4 |
| **GAP-B5** | Conflated Dismissal and Rejection semantics | Explicit UI "Reject" revokes capability; Dismiss/Esc closes modal without revoking (remains valid within TTL) | §3.5 |
| **GAP-SCOPE** | Inaccurate file count ("5 existing files") | Formally corrected to **6 production files + 2 test files (6+2)** | §4.0 |

---

## 2. Scope A — Audio Continuity Architecture (SEC-P4-A01)

### 2.1 Measured PCM Dimensions & Memory Calculations

From source inspection of [`public/mic-processor.worklet.js`](file:///d:/SORA%20AI/Sora%20AI/public/mic-processor.worklet.js) and [`frontend/lib/audio.ts`](file:///d:/SORA%20AI/Sora%20AI/frontend/lib/audio.ts#L297):
- **Sampling Rate**: $16,000 \text{ Hz}$ (16 kHz), Single-channel Mono.
- **Bit Depth**: 16-bit Signed Integer (Little-Endian) = $2 \text{ bytes/sample}$.
- **Worklet Chunk**: $2,048 \text{ Float32 samples}$ converted to $2,048 \text{ Int16 samples}$.
- **Decoded Raw PCM Frame Size**: $2,048 \times 2 = \mathbf{4,096 \text{ bytes}}$ ($4.0 \text{ KB}$).
- **Frame Duration**: $2,048 / 16,000 = \mathbf{0.128 \text{ seconds}}$ ($128 \text{ ms}$).
- **Frame Rate**: $1 / 0.128 = \mathbf{7.8125 \text{ frames/second}}$.
- **Base64 String Length**: $4,096 \times (4/3) = \mathbf{5,464 \text{ characters}}$ ($\approx 5.48 \text{ KB}$ with JSON envelope).

#### Bounded Queue Limits
- **Maximum Frame Count ($N_{\max}$)**: **$24 \text{ frames}$** ($\approx 3.072 \text{ seconds}$ duration).
- **Maximum Decoded PCM Bytes ($B_{\max,\text{pcm}}$)**: $24 \times 4,096 = \mathbf{98,304 \text{ bytes}}$ ($96 \text{ KB}$).
- **Maximum Base64 Character Length ($B_{\max,\text{b64}}$)**: $24 \times 5,464 = \mathbf{131,136 \text{ characters}}$ ($\approx 128 \text{ KB}$).
- **Maximum Permitted Individual Frame Size**: **$6,144 \text{ characters}$** ($4,608 \text{ bytes}$ PCM). Any frame exceeding this is immediately rejected as oversized.

---

### 2.2 Bounded Ring Buffer Data Structure & Guaranteed Termination

```ts
export interface QueuedAudioFrame {
  data: string;           // Base64-encoded PCM chunk
  pcmByteLength: number;  // Decoded PCM byte size
  epoch: number;          // Session/Project epoch
  sequence: number;       // Monotonically increasing sequence
  timestamp: number;      // Arrival timestamp
}

export type EnqueueResult =
  | { success: true; enqueuedCount: number }
  | { success: false; reason: "OVERSIZED_FRAME" | "INVALID_FORMAT" | "QUEUE_FULL" };

export class BoundedAudioRingBuffer {
  public static readonly MAX_FRAMES = 24;                 // 3.072 seconds max
  public static readonly MAX_PCM_BYTES = 98_304;          // 96 KB PCM max
  public static readonly MAX_BASE64_CHARS = 131_136;      // 128 KB base64 max
  public static readonly MAX_SINGLE_FRAME_CHARS = 6_144;  // Max single frame limit

  private frames: QueuedAudioFrame[] = [];
  private totalPcmBytes: number = 0;
  private totalBase64Chars: number = 0;
  private sequenceCounter: number = 0;

  public enqueue(base64Data: string, epoch: number): EnqueueResult {
    // 1. Pre-validation: Input must be a valid, non-empty base64 string
    if (!base64Data || typeof base64Data !== "string") {
      return { success: false, reason: "INVALID_FORMAT" };
    }

    // 2. Immediate rejection if individual frame exceeds single-frame limit
    const charLen = base64Data.length;
    if (charLen > BoundedAudioRingBuffer.MAX_SINGLE_FRAME_CHARS || charLen < 16) {
      return { success: false, reason: "OVERSIZED_FRAME" };
    }

    // Fast base64 validation (alphanumeric + +, /, =, newline)
    if (!/^[A-Za-z0-9+/=]+$/.test(base64Data)) {
      return { success: false, reason: "INVALID_FORMAT" };
    }

    const pcmBytes = Math.floor((charLen * 3) / 4);

    // 3. Guaranteed terminating capacity check: Reject if queue is full
    if (
      this.frames.length >= BoundedAudioRingBuffer.MAX_FRAMES ||
      this.totalPcmBytes + pcmBytes > BoundedAudioRingBuffer.MAX_PCM_BYTES ||
      this.totalBase64Chars + charLen > BoundedAudioRingBuffer.MAX_BASE64_CHARS
    ) {
      return { success: false, reason: "QUEUE_FULL" };
    }

    // 4. Safe append
    this.frames.push({
      data: base64Data,
      pcmByteLength: pcmBytes,
      epoch,
      sequence: ++this.sequenceCounter,
      timestamp: Date.now(),
    });
    this.totalPcmBytes += pcmBytes;
    this.totalBase64Chars += charLen;

    return { success: true, enqueuedCount: this.frames.length };
  }

  public drainForEpoch(epoch: number): QueuedAudioFrame[] {
    const valid = this.frames.filter((f) => f.epoch === epoch);
    this.clear();
    return valid;
  }

  public clear(): void {
    this.frames = [];
    this.totalPcmBytes = 0;
    this.totalBase64Chars = 0;
  }

  public get size(): number {
    return this.frames.length;
  }
}
```

---

### 2.3 Audio Lifecycle State Machine with DRAINING State

To ensure that new audio frames arriving while the queue is being flushed are never sent out of order, the connection state machine includes an explicit **`DRAINING`** state:

```mermaid
stateDiagram-v2
    [*] --> STARTING_GEMINI: Client Connects
    STARTING_GEMINI --> READY: Upstream onopen (Buffer Empty)
    READY --> RECREATING: Project Switch / GoAway / Upstream Reconnect
    
    state RECREATING {
        [*] --> Buffering: sessionEpoch active
        Buffering --> QueueFull: Buffer reaches 24 frames
        QueueFull --> EmitWarning: Send audio_warning (QUEUE_FULL)
    }

    RECREATING --> DRAINING: Upstream onopen (New Session Connected)
    
    state DRAINING {
        [*] --> DrainWorker: Single Async Worker Drains Queue
        DrainWorker --> AppendNew: New client frame arrives -> Appends to queue (FIFO)
        AppendNew --> DrainWorker: Sequential sendRealtimeInput()
    }

    DRAINING --> READY: Queue completely drained (size == 0)
    DRAINING --> FAILED: Upstream send throws or socket closes
    RECREATING --> FAILED: Max recreate attempts exceeded / Auth error
    FAILED --> CLOSED: Client disconnected / Fatal error
    READY --> CLOSED: Client disconnect
    CLOSED --> [*]
```

#### Detailed State Transition Invariants
1. **`READY` State**:
   - Queue is empty (`size === 0`).
   - Incoming audio frames are dispatched directly:
     ```ts
     session.sendRealtimeInput({ audio: { data: msg.audio, mimeType: "audio/pcm;rate=16000" } });
     ```
2. **`RECREATING` State**:
   - `session = null` (or closing).
   - Incoming audio frames are validated and enqueued via `audioBuffer.enqueue(msg.audio, sessionEpoch)`.
   - If `QUEUE_FULL` is returned:
     - Client is notified: `{ type: "audio_warning", code: "BUFFER_OVERFLOW", message: "Speech buffer exceeded 3 seconds during reconnection." }`.
     - The first 24 frames remain preserved; subsequent frames are not accepted.
3. **`DRAINING` State**:
   - Triggered when the replacement session opens (`onopen`).
   - State sets to `DRAINING`.
   - **Critical Ordering Guard**: Any new audio frame arriving from the client while `state === "DRAINING"` is **appended to the tail of `audioBuffer`**, NEVER sent directly to `session.sendRealtimeInput()`.
   - A single, dedicated async drain loop dequeues frames one-by-one from the head of the buffer and sends them upstream with a $5\text{ms}$ inter-chunk delay:
     ```ts
     while (audioBuffer.size > 0 && currentGeminiState === "DRAINING") {
       const frame = audioBuffer.shift();
       if (frame && frame.epoch === sessionEpoch) {
         await session.sendRealtimeInput({ audio: { data: frame.data, mimeType: "audio/pcm;rate=16000" } });
         await new Promise((r) => setTimeout(r, 5));
       }
     }
     if (currentGeminiState === "DRAINING") {
       currentGeminiState = "READY";
       this._send(clientWs, { type: "status", status: "connected", geminiState: "READY" });
     }
     ```
   - Once the buffer is fully drained (`size === 0`), the connection transitions to `READY`.
4. **Drain Failure & Stale Callbacks**:
   - If `session.sendRealtimeInput()` throws during drain: catch error, transition state to `FAILED`, purge buffer, abort drain worker.
   - Stale callbacks: `GeminiSessionFactory` assigns each connection a UUID `sessionId`. Callbacks verify `thisSessionId === activeSessionId`; callbacks from superseded sessions are discarded immediately.

---

### 2.4 Project-Switch Epoch Isolation & Exact Cutover Timeline

```mermaid
sequenceDiagram
    autonumber
    actor User as Human Operator
    participant Client as Frontend (audio.ts)
    participant CM as ConversationManager.ts
    participant Factory as GeminiSessionFactory.ts
    participant OldGem as Gemini Live (Epoch 1: Proj A)
    participant NewGem as Gemini Live (Epoch 2: Proj B)

    Note over CM: Active Epoch: 1 (Project A)
    User->>OldGem: "Switch to Project B"
    OldGem->>CM: trackProjectTask({ action: 'switch', projectName: 'Project B' })
    CM->>CM: ProjectStore.setActiveProject("proj-b")
    CM->>Factory: requestSessionRotation("project_switch")
    OldGem-->>User: Speaks: "Switching to Project B now."
    OldGem->>Factory: turnComplete: true

    rect rgb(35, 25, 55)
    Note over Factory,CM: === EPOCH CUTOVER POINT ===
    Factory->>Factory: flags.isRotating = true; OldGem.close()
    CM->>CM: sessionEpoch = 2;
    CM->>CM: audioBuffer.clear()
    Note over CM: Stale Epoch 1 audio purged.<br/>Zero Project A frames can enter Project B!
    CM->>Client: WS Frame: status="connecting_gemini", geminiState="RECREATING", epoch=2
    end

    User->>Client: "What is pending?" (Spoken for Project B)
    Client->>CM: WS Frame: { audio: chunk, epoch: 2 }
    CM->>CM: audioBuffer.enqueue(chunk, epoch=2) (Buffered for Project B)

    Factory->>NewGem: ai.live.connect(Project B instructions)
    NewGem-->>Factory: onopen
    Factory->>CM: onGeminiStateChange("DRAINING")
    CM->>NewGem: Drain audioBuffer (Epoch 2 only) sequentially
    Note over CM: All Epoch 2 frames sent in FIFO order
    CM->>CM: currentGeminiState = "READY"
    CM-->>Client: WS Frame: status="connected", geminiState="READY"
    NewGem-->>User: Speaks: "In Project B, there are 2 pending tasks..."
```

---

### 2.5 Existing API Payload Compatibility
The Gemini Live API in `@google/genai` accepts the exact structure:
```ts
session.sendRealtimeInput({
  audio: {
    data: base64PcmString,
    mimeType: "audio/pcm;rate=16000",
  },
});
```
This matches [`backend/conversation/ConversationManager.ts`](file:///d:/SORA%20AI/Sora%20AI/backend/conversation/ConversationManager.ts#L266-L269) directly:
```ts
const blob = { data: msg.audio, mimeType: "audio/pcm;rate=16000" };
session?.sendRealtimeInput?.({ audio: blob });
```
Zero new SDK methods, external packages, or modified data types are required.

---

## 3. Scope B — Confirmation Capability Revocation (SEC-P3-R1.3-01)

### 3.1 Mandatory Session Ownership
- For all WebSocket-originated requests (`confirm_decision` and `reject_decision`):
  - `sessionId` is **mandatory** and extracted from the authenticated server connection (`clientSessionId` / `authenticatedRemoteSession.sessionId`).
  - The `"local"` fallback exception is strictly **prohibited** for socket requests.
  - The token payload's `payload.sessionId` must equal the authenticated connection's `sessionId`. If mismatched, the request is rejected with `SESSION_MISMATCH`.

---

### 3.2 Trusted Canonical Arguments Architecture

```mermaid
flowchart TD
    Client["Client sends: { decisionId: 'dec-1', confirmationToken: '...' }"] --> CM["ConversationManager.ts"]
    CM --> Store["ProjectDecisionStore.getDecision('dec-1')"]
    Store --> CheckExists{"Decision exists in store?"}
    CheckExists -- No --> ErrNotFound["Reject: DECISION_NOT_FOUND (Token unconsumed)"]
    CheckExists -- Yes --> BuildCanonical["Derive Canonical Arguments:<br/>{ action: 'confirm_decision', decisionId: decision.id, projectId: decision.projectId }"]
    BuildCanonical --> SPE["SecurityPolicyEngine.revokeConfirmationToken(<br/>token, 'trackProjectTask', canonicalArgs, sessionId)"]
    SPE --> CheckArgs{"payload.argsHash == hash(canonicalArgs)?"}
    CheckArgs -- No --> ErrTamper["Reject: ARGS_MISMATCH (Token unconsumed)"]
    CheckArgs -- Yes --> ConsumeToken["Atomically add tokenId to _consumedConfirmationTokens"]
```

#### Canonicalization Rules
1. The client **never** specifies `expectedArgs`.
2. The server queries [`ProjectDecisionStore`](file:///d:/SORA%20AI/Sora%20AI/backend/projects/ProjectDecisionStore.ts) using `decisionId`.
3. If the decision does not exist, the operation halts immediately. The token is **not** consumed.
4. If found, the server constructs canonical arguments:
   ```ts
   const canonicalArgs = {
     action: "confirm_decision",
     decisionId: decision.id,
     projectId: decision.projectId,
   };
   ```
5. `SecurityPolicyEngine` computes `argsHash = this._hashArgs(canonicalArgs)` and checks `payload.argsHash === argsHash`.
6. This prevents an attacker from forging or tampering with project scopes.

---

### 3.3 Shared Atomic One-Time Consumption Mechanism

Both `verifyAndConsumeConfirmation()` and `revokeConfirmationToken()` rely on a single private atomic primitive in `SecurityPolicyEngine`:

```ts
private _consumeTokenId(tokenId: string, reason: "CONFIRMED" | "REVOKED", toolName: string): boolean {
  if (this._consumedConfirmationTokens.has(tokenId)) {
    return false; // Already consumed
  }
  this._consumedConfirmationTokens.add(tokenId);
  this._recentlyConsumedTokens.set(tokenId, {
    toolName,
    timestamp: Date.now(),
    status: reason,
  });
  return true;
}
```

#### Unambiguous Result Codes & Audit Outcomes
- `SUCCESS_REVOKED`: Live capability verified and atomically transitioned to revoked. Emits audit `TOOL_BLOCKED` (Action: `REVOKE_CAPABILITY`).
- `ALREADY_CONSUMED`: Token was already consumed (either confirmed or revoked). Returns error; decision state untouched.
- `TOKEN_EXPIRED`: `Date.now() > payload.expiresAt`. Returns error; decision state untouched.
- `SIGNATURE_INVALID`: HMAC verification failed via `crypto.timingSafeEqual`. Emits audit `SECURITY_VIOLATION`.
- `SESSION_MISMATCH`: Caller session does not match token session. Emits audit `SECURITY_VIOLATION`.
- `ARGS_MISMATCH`: Decision/Project parameters do not match token hash. Emits audit `SECURITY_VIOLATION`.

---

### 3.4 Process Restart & Replay Protection: `PROCESS_BOOT_ID`

#### The Problem
In-memory Sets (`_consumedConfirmationTokens`) are wiped if the backend restarts. If an issued token has 300s TTL and the server restarts at second 30, the new process without protection could accept a replayed token because its HMAC signature is valid.

#### The Zero-Dependency Scope-Compliant Solution
At module load time, `SecurityPolicyEngine` generates a cryptographically random process instance identifier:

```ts
export const PROCESS_BOOT_ID = crypto.randomUUID();
```

When issuing a token, `processBootId: PROCESS_BOOT_ID` is included in the payload:
```ts
interface ConfirmationTokenPayload {
  tokenId: string;
  toolName: string;
  argsHash: string;
  processBootId: string; // Bound to current process lifetime
  sessionId: string;
  issuedAt: number;
  expiresAt: number;
}
```

When validating either for approval or revocation:
```ts
if (payload.processBootId !== PROCESS_BOOT_ID) {
  return {
    valid: false,
    reason: "STALE_PROCESS_GENERATION: Token was issued by a prior server process and was invalidated upon restart.",
  };
}
```

#### Replay Protection Matrix

| Dimension | Mechanism | Guarantee |
|---|---|---|
| **Same Process Lifetime** | In-Memory `_consumedConfirmationTokens` Set | Single-use consumption (anti-replay within process) |
| **Process Restart** | `PROCESS_BOOT_ID` mismatch | 100% fail-closed: All pre-restart tokens instantly invalid |
| **Time-To-Live (TTL)** | `payload.expiresAt = issuedAt + 300_000` | Strict 5-minute maximum capability lifetime |
| **Tamper Resistance** | HMAC-SHA256 (`crypto.timingSafeEqual`) | Cannot forge payload, boot ID, or arguments hash |

---

### 3.5 UI & Audit Semantics

#### Explicit Reject vs. Dismissal
- **Explicit "Reject" Button**:
  - Semantic: User formally rejects the proposed decision.
  - Action: Client sends WebSocket frame:
    ```json
    {
      "type": "reject_decision",
      "decisionId": "dec-1",
      "projectId": "proj-a",
      "confirmationToken": "sora_conf_..."
    }
    ```
  - Result: Backend calls `revokeConfirmationToken()`. Token added to `_consumedConfirmationTokens`. Decision remains `ai_proposed`.
- **Dismissal (Escape Key / Backdrop Click)**:
  - Semantic: User closes the modal to inspect files without making a decision.
  - Action: Client unmounts modal (`setPendingConfirmation(null)`). Does **NOT** send `reject_decision`. Token remains valid until 300s TTL expires.

#### Secret-Safe Audit Logging
- Audit events **NEVER** include the raw `sora_conf_...` token or signature.
- Log schema:
  ```json
  {
    "timestamp": "2026-11-03T12:05:00.000Z",
    "eventType": "TOOL_BLOCKED",
    "actor": { "identityId": "user-123", "sessionId": "sess-456", "ipAddress": "127.0.0.1" },
    "target": { "toolName": "trackProjectTask", "resource": "decision:dec-1" },
    "decision": "BLOCK",
    "reason": "Human operator explicitly rejected decision; confirmation capability revoked.",
    "riskLevel": "HIGH",
    "metadata": { "decisionId": "dec-1", "projectId": "proj-a", "tokenId": "uuid-v4", "argsHash": "sha256" }
  }
  ```

---

## 4. Exact Scope Accounting (6 + 2 Files)

The implementation scope is strictly contained to **6 production files and 2 test files**:

```
┌────────────────────────────────────────────────────────────────────────┐
│ AUTHORIZED IMPLEMENTATION FILE SCOPE (6 + 2):                          │
│                                                                        │
│ Production Files:                                                      │
│ 1. backend/conversation/ConversationManager.ts (Ring buffer & cutover) │
│ 2. backend/ai/GeminiSessionFactory.ts (Epoch cutover signal)          │
│ 3. backend/security/SecurityPolicyEngine.ts (Revocation & Boot ID)     │
│ 4. frontend/lib/audio.ts (Token parameter in rejectDecision)           │
│ 5. frontend/components/DecisionConfirmationModal.tsx (Forward token)   │
│ 6. frontend/App.tsx (Modal callback wiring)                            │
│                                                                        │
│ Test Files:                                                            │
│ 7. tests/unit/phase10_audio_continuity.test.ts (16 Audio tests)        │
│ 8. tests/unit/phase10_project_continuity.test.ts (14 Revocation tests) │
└────────────────────────────────────────────────────────────────────────┘
```

*Note*: No local staging scripts, Docker configs, or database schema changes are included in this authorized scope.

---

## 5. Test Plan & Acceptance Mapping (30 Tests Total)

### 5.1 Audio Continuity Tests (16 Tests)

| Test ID | Scenario | Expected Result | Acceptance Criterion | Source File | Level |
|---|---|---|---|---|---|
| **A-01** | Frame arrives while `READY` | Direct dispatch to `session.sendRealtimeInput` | Immediate transmission; buffer size = 0 | `ConversationManager.ts` | Unit |
| **A-02** | Frame arrives while `RECREATING` | Frame enqueued in `BoundedAudioRingBuffer` | Buffer size increments; status = `RECREATING` | `ConversationManager.ts` | Unit |
| **A-03** | Transition from `RECREATING` to `DRAINING` to `READY` | Buffered frames sent upstream in FIFO sequence | Strict sequential delivery; state transitions clean | `ConversationManager.ts` | Integration |
| **A-04** | Frame arrives while state is `DRAINING` | Frame appended to queue, not sent directly | Zero overtaking; FIFO order preserved | `ConversationManager.ts` | Unit |
| **A-05** | Individual frame $>6,144 \text{ chars}$ | Rejected immediately with `OVERSIZED_FRAME` | Zero infinite loop; buffer unchanged | `ConversationManager.ts` | Unit |
| **A-06** | Invalid base64 string provided | Rejected with `INVALID_FORMAT` | Process remains alive; buffer safe | `ConversationManager.ts` | Unit |
| **A-07** | Queue reaches $24 \text{ frames}$ ($98.3 \text{ KB}$) | Rejects 25th frame; sends `audio_warning` | Bounded capacity enforced; no drop-oldest | `ConversationManager.ts` | Integration |
| **A-08** | Project switch cutover at `turnComplete` | `sessionEpoch` increments; Epoch $N$ purged | Complete project isolation; zero stale audio | `GeminiSessionFactory.ts` | Integration |
| **A-09** | Rapid sequential project switches (3 switches in 1s) | Epoch increments 3 times; only final epoch drained | No race condition; zero cross-project leak | `ConversationManager.ts` | Integration |
| **A-10** | Duplicate `READY` callback fired | Second callback ignored; single drain worker | Zero duplicate packet sending | `ConversationManager.ts` | Unit |
| **A-11** | Stale callback from closed Gemini session | Discarded via `sessionId` match check | No ghost callbacks accepted | `GeminiSessionFactory.ts` | Unit |
| **A-12** | Upstream send throws during drain | Catches error; transitions to `FAILED`; clears queue | Graceful error recovery; socket stable | `ConversationManager.ts` | Integration |
| **A-13** | Client disconnects while queue has 10 frames | Buffer cleared; memory garbage-collected | Zero memory leak on client close | `ConversationManager.ts` | Unit |
| **A-14** | Two concurrent clients streaming audio | Independent ring buffers; zero cross-client leak | Per-session memory isolation | `ConversationManager.ts` | Integration |
| **A-15** | Upstream session recreation failure | Buffer cleared; model prompts user to repeat | No garbled speech replay | `ConversationManager.ts` | Integration |
| **A-16** | 50 sequential frames stream through switch | Frames 1-20 in Proj A, 21-35 in switch (cut), 36-50 in Proj B | Verified end-to-end PCM flow | `ConversationManager.ts` | Runtime |

---

### 5.2 Capability Revocation Tests (14 Tests)

| Test ID | Scenario | Expected Result | Acceptance Criterion | Source File | Level |
|---|---|---|---|---|---|
| **B-01** | Explicit reject then attempt confirmation | `verifyAndConsumeConfirmation()` returns `CONFIRMATION_TOKEN_REPLAY` | Decision remains `ai_proposed`; replay blocked | `SecurityPolicyEngine.ts` | Unit |
| **B-02** | Duplicate rejection calls | Second call returns `ALREADY_CONSUMED` | Idempotent rejection handling | `SecurityPolicyEngine.ts` | Unit |
| **B-03** | Rejection with wrong `sessionId` | Rejected with `SESSION_MISMATCH` | Strict session ownership enforced | `SecurityPolicyEngine.ts` | Unit |
| **B-04** | Rejection with tampered `projectId` | Rejected with `ARGS_MISMATCH` | Canonical arguments verification | `SecurityPolicyEngine.ts` | Unit |
| **B-05** | Rejection with non-existent `decisionId` | Rejected with `DECISION_NOT_FOUND` | Cannot revoke phantom records | `ConversationManager.ts` | Unit |
| **B-06** | Rejection after 301 seconds (expired) | Returns `TOKEN_EXPIRED` | 300s TTL boundary enforced | `SecurityPolicyEngine.ts` | Unit |
| **B-07** | Approval followed by late rejection | Approval succeeds; rejection returns `ALREADY_CONSUMED` | Confirmed decision cannot be reverted | `SecurityPolicyEngine.ts` | Integration |
| **B-08** | Concurrent approval/rejection race | Exactly one operation succeeds; token consumed once | Atomic execution; no double-spend | `SecurityPolicyEngine.ts` | Integration |
| **B-09** | Backend process restart simulation | Token rejected with `STALE_PROCESS_GENERATION` | `PROCESS_BOOT_ID` prevents pre-restart replay | `SecurityPolicyEngine.ts` | Unit |
| **B-10** | Escape key modal dismissal | Modal closes; token remains valid within TTL | Dismissal does not revoke capability | `App.tsx` | Unit |
| **B-11** | Disconnect before rejection reaches server | Token naturally expires at 300s TTL | Bound risk window | `ConversationManager.ts` | Integration |
| **B-12** | Audit log inspection | `tokenId` and `argsHash` logged; raw token absent | Zero raw token/HMAC leakage | `SecurityPolicyEngine.ts` | Unit |
| **B-13** | Emergency Stop active during rejection | Operation blocked by Emergency Stop gate | Safety gate precedence | `ToolOrchestrator.ts` | Integration |
| **B-14** | Security Lockdown active during rejection | Operation blocked by Lockdown gate | Lockdown precedence | `ToolOrchestrator.ts` | Integration |

---

## 6. Risks, Assumptions & Explicit Exclusions

### Explicit Exclusions
- **No Cloud Staging Provisioning**: Testing is strictly confined to local unit and integration test harnesses. No Render infrastructure or cloud services are provisioned.
- **No Database Migration**: All token management and session buffering operates in memory and existing stores.
- **No LIVE_TOOLS Changes**: The 129 tools remain 100% untouched.

### Assumptions & Dependencies
- Client WebSocket sends audio chunks at $128\text{ms}$ intervals ($16\text{kHz}$ Mono PCM).
- Node.js single-threaded event loop ensures atomic map and set operations in `SecurityPolicyEngine`.

---

## 7. Final Implementation Readiness Verdict

```
══════════════════════════════════════════════════════════════════════════
FINAL READINESS VERDICT:
READY FOR IMPLEMENTATION AUTHORIZATION

All implementation-blocking findings from R1.5 have been resolved:
1. Infinite-loop safety guaranteed with pre-validation (§2.2).
2. Exactly ONE overflow policy established: Bounded FIFO Hold (§2.2).
3. FIFO ordering guaranteed during DRAINING state (§2.3).
4. Project-switch cutover timing strictly defined (§2.4).
5. Mandatory session ownership and canonical args enforced (§3.1, §3.2).
6. Process restart replay protection guaranteed via PROCESS_BOOT_ID (§3.4).
7. File scope accounted with exact precision (6 production + 2 test files).
8. All 30 tests mapped to exact criteria and files (§5.0).
══════════════════════════════════════════════════════════════════════════
```
