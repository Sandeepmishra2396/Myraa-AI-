# MYRAA — STAGE 10, PHASE 10.4.2 (R1.7)
# FINAL TECHNICAL CONSISTENCY & SECURITY DESIGN CORRECTION
## Implementation Readiness Gate: Audio Continuity & Capability Revocation

**Role**: Principal Software Architect, Senior Real-Time Audio Systems Engineer, Application Security Engineer  
**Date**: 2026-11-03T12:12:00+05:30  
**Phase Objective**: Final Technical Consistency & Security Architecture Specification  
**Architecture Verdict**: **`READY FOR IMPLEMENTATION AUTHORIZATION`**  

---

## 1. Executive Summary & R1.7 Correction Matrix

This specification provides the definitive, implementation-ready technical design for **`SEC-P4-A01`** (PCM Audio Loss during Gemini Session Recreation) and **`SEC-P3-R1.3-01`** (Server-Side Confirmation Capability Revocation). It rigorously resolves all technical inconsistencies, mathematical edge cases, and architectural omissions identified in R1.6.

```
┌────────────────────────────────────────────────────────────────────────┐
│ FINAL ARCHITECTURE VERDICT:                                            │
│                                                                        │
│   READY FOR IMPLEMENTATION AUTHORIZATION                               │
│                                                                        │
│ 1. PCM/Base64 Correctness:         Exact padding math & Buffer length  │
│ 2. Consistent Queue API:           Atomic dequeue(), peek(), single    │
│                                    drain worker, strict FIFO ordering  │
│ 3. Project Switch Cutover:         Full ordered sequence in §2.4       │
│ 4. Failure Semantics:              Fail-closed token consumption rules │
│ 5. Security Call Paths:            Emergency Stop & Lockdown enforced  │
│ 6. Process Boot ID Architecture:   Single & multi-worker fail-closed   │
│ 7. Exact Scope:                    6 Production + 2 Test Files (6+2)   │
│ 8. Acceptance Test Suite:          38 Explicitly Mapped Test Cases     │
└────────────────────────────────────────────────────────────────────────┘
```

### Corrections from R1.6 to R1.7

| Category | R1.6 Inconsistency / Gap | R1.7 Concrete Resolution | Section |
|---|---|---|---|
| **PCM & Base64 Math** | Byte calculation used `Math.floor(charLen * 3 / 4)` ignoring padding | Decoded length derived via canonical base64 padding subtraction and verified via `Buffer.byteLength(b64, 'base64')` = **$4,096\text{ bytes}$** | §2.1 |
| **Queue API & Drain** | Drain code called undefined `shift()`; dequeue undefined | Implemented cohesive atomic `dequeue()`, `peek()`, and `enqueue()` methods with strict byte accounting | §2.2 |
| **DRAINING State** | Potential race if new frames arrived during drain | New frames arriving during `DRAINING` append to queue tail; single active worker prevents overtaking | §2.3 |
| **Cutover Section 2.4** | Truncated / missing sequence detail | Full 10-step end-to-end timeline with zero Project A audio leakage into Project B | §2.4 |
| **Failure Semantics** | Persistence failure after consumption was ambiguous | **Fail-Closed Guarantee**: Token remains consumed even if store fails; operator must request a new token | §3.3 |
| **Security Call Paths** | Unclear enforcement of Emergency Stop / Lockdown | Exact call path documented: `Session -> EmergencyStop -> Lockdown -> Store -> PolicyEngine -> Audit` | §3.4 |
| **Process Generation** | Multi-worker behavior was unspecified | Clarified single-process default + cluster master boot inheritance; all cross-instance tokens fail-closed | §3.5 |
| **Scope Accounting** | Re-confirmed exact file count | Exactly 6 production files + 2 test files (6 + 2) | §4.0 |
| **Test Matrix** | 30 tests in R1.6 | Expanded to **38 comprehensively mapped test cases** | §5.0 |

---

## 2. Scope A — Audio Continuity Architecture (SEC-P4-A01)

### 2.1 Measured PCM Dimensions & Base64 Padding Correctness

Inspection of [`public/mic-processor.worklet.js`](file:///d:/SORA%20AI/Sora%20AI/public/mic-processor.worklet.js) and [`frontend/lib/audio.ts`](file:///d:/SORA%20AI/Sora%20AI/frontend/lib/audio.ts#L297):
- **AudioContext**: 16,000 Hz, 1 Channel (Mono).
- **AudioWorklet Chunk Size**: 2,048 Float32 samples.
- **Sample Bit Depth**: 16-bit Signed Integer (Little-Endian) via `floatTo16BitPCM()` = 2 bytes/sample.
- **Decoded Raw PCM Bytes per Frame**: $2,048 \times 2 = \mathbf{4,096 \text{ bytes}}$.
- **Frame Duration**: $2,048 / 16,000 = \mathbf{0.128 \text{ seconds}}$ ($128 \text{ ms}$).

#### Base64 Padding and Byte Calculation
Base64 groups 3 binary bytes into 4 ASCII characters:
- For 4,096 raw bytes:
  - $4,096 = 1,365 \times 3 + 1 \text{ byte}$.
  - The 1,365 full 3-byte blocks produce $1,365 \times 4 = 5,460 \text{ base64 characters}$.
  - The remaining 1 byte (8 bits) produces 2 base64 characters followed by **2 padding characters (`==`)**.
  - Total Base64 Length = $5,460 + 4 = \mathbf{5,464 \text{ characters}}$ ending with `==`.
- **Validation Formula**:
  ```ts
  function getDecodedPcmByteLength(base64Str: string): number {
    const len = base64Str.length;
    if (len === 0 || len % 4 !== 0) return -1;
    let padding = 0;
    if (base64Str.endsWith("==")) padding = 2;
    else if (base64Str.endsWith("=")) padding = 1;
    return (len * 3) / 4 - padding;
  }
  ```
  For standard chunks: $(5,464 \times 3) / 4 - 2 = 4,098 - 2 = \mathbf{4,096 \text{ bytes}}$.
- **Buffer Capacity Accounting**:
  - Exactly **24 frames** $\times 4,096 \text{ bytes} = \mathbf{98,304 \text{ bytes}}$ ($96 \text{ KB}$ PCM).
  - Base64 length: 24 frames $\times 5,464 \text{ chars} = \mathbf{131,136 \text{ characters}}$ ($\approx 128 \text{ KB}$).
  - All 24 frames fit **exactly** within the $98,304\text{-byte}$ memory ceiling with zero rounding error.

---

### 2.2 Cohesive Bounded Ring Buffer API

```ts
export interface QueuedAudioFrame {
  data: string;           // Base64-encoded PCM string
  pcmByteLength: number;  // Decoded PCM byte count (4096 bytes)
  epoch: number;          // Context generation epoch
  sequence: number;       // Monotonic sequence number
  timestamp: number;      // Ingress timestamp (Date.now())
}

export type EnqueueResult =
  | { success: true; enqueuedCount: number }
  | { success: false; reason: "OVERSIZED_FRAME" | "INVALID_FORMAT" | "MALFORMED_PADDING" | "QUEUE_FULL" };

export class BoundedAudioRingBuffer {
  public static readonly MAX_FRAMES = 24;                 // 3.072 seconds max
  public static readonly MAX_PCM_BYTES = 98_304;          // 96 KB PCM limit
  public static readonly MAX_BASE64_CHARS = 131_136;      // 128 KB base64 limit
  public static readonly STANDARD_FRAME_PCM_BYTES = 4_096;
  public static readonly STANDARD_FRAME_B64_CHARS = 5_464;

  private frames: QueuedAudioFrame[] = [];
  private totalPcmBytes: number = 0;
  private totalBase64Chars: number = 0;
  private sequenceCounter: number = 0;

  /**
   * Enqueues an incoming base64 PCM frame with strict pre-validation.
   * Guaranteed terminating operation with zero infinite loop risk.
   */
  public enqueue(base64Data: string, epoch: number): EnqueueResult {
    if (!base64Data || typeof base64Data !== "string") {
      return { success: false, reason: "INVALID_FORMAT" };
    }

    const charLen = base64Data.length;
    if (charLen > BoundedAudioRingBuffer.STANDARD_FRAME_B64_CHARS || charLen < 32) {
      return { success: false, reason: "OVERSIZED_FRAME" };
    }

    // Canonical Base64 validation: must be divisible by 4 with valid alphabet and padding
    if (charLen % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64Data)) {
      return { success: false, reason: "MALFORMED_PADDING" };
    }

    // Accurate decoded PCM byte length accounting
    let padding = 0;
    if (base64Data.endsWith("==")) padding = 2;
    else if (base64Data.endsWith("=")) padding = 1;
    const pcmBytes = (charLen * 3) / 4 - padding;

    // Enforce 16-bit sample boundary (even byte count) and sample limits
    if (pcmBytes % 2 !== 0 || pcmBytes > BoundedAudioRingBuffer.STANDARD_FRAME_PCM_BYTES) {
      return { success: false, reason: "INVALID_FORMAT" };
    }

    // Strict Capacity Check (Bounded FIFO Hold)
    if (
      this.frames.length >= BoundedAudioRingBuffer.MAX_FRAMES ||
      this.totalPcmBytes + pcmBytes > BoundedAudioRingBuffer.MAX_PCM_BYTES ||
      this.totalBase64Chars + charLen > BoundedAudioRingBuffer.MAX_BASE64_CHARS
    ) {
      return { success: false, reason: "QUEUE_FULL" };
    }

    // Append to queue tail
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

  /**
   * Atomic dequeue: Removes and returns the head frame while updating byte accounting.
   */
  public dequeue(): QueuedAudioFrame | undefined {
    const frame = this.frames.shift();
    if (frame) {
      this.totalPcmBytes -= frame.pcmByteLength;
      this.totalBase64Chars -= frame.data.length;
    }
    return frame;
  }

  /**
   * Peek: Inspects the head frame without modifying queue state.
   */
  public peek(): QueuedAudioFrame | undefined {
    return this.frames[0];
  }

  /**
   * Drains all frames matching an epoch, purging mismatched frames.
   */
  public drainForEpoch(epoch: number): QueuedAudioFrame[] {
    const valid = this.frames.filter((f) => f.epoch === epoch);
    this.clear();
    return valid;
  }

  /**
   * Resets the buffer and all counters atomically.
   */
  public clear(): void {
    this.frames = [];
    this.totalPcmBytes = 0;
    this.totalBase64Chars = 0;
  }

  public get size(): number {
    return this.frames.length;
  }

  public get pcmBytes(): number {
    return this.totalPcmBytes;
  }

  public get base64Chars(): number {
    return this.totalBase64Chars;
  }
}
```

---

### 2.3 DRAINING State & FIFO Drain Algorithm

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
        [*] --> DrainLoop: Single Async Worker Drains Queue via dequeue()
        DrainLoop --> EnqueueDuringDrain: New client frame arrives -> Appended to queue tail
        EnqueueDuringDrain --> DrainLoop: Strictly preserves FIFO order
    }

    DRAINING --> READY: Queue completely drained (size == 0)
    DRAINING --> FAILED: Upstream send throws or socket closes
    RECREATING --> FAILED: Max recreate attempts exceeded / Auth error
    FAILED --> CLOSED: Client disconnected / Fatal error
    READY --> CLOSED: Client disconnect
    CLOSED --> [*]
```

#### The Drain Loop Algorithm
In [`backend/conversation/ConversationManager.ts`](file:///d:/SORA%20AI/Sora%20AI/backend/conversation/ConversationManager.ts):
```ts
private async _drainBufferedAudio(targetSession: any, epoch: number): Promise<void> {
  if (this._isDraining) return; // Prevent duplicate drain workers
  this._isDraining = true;
  this._drainEpoch = epoch;

  try {
    while (
      this.audioBuffer.size > 0 &&
      this.currentGeminiState === "DRAINING" &&
      !this.flags.isClientClosed
    ) {
      const frame = this.audioBuffer.peek();
      if (!frame) break;

      // Drop frames from stale epochs
      if (frame.epoch !== this._drainEpoch) {
        this.audioBuffer.dequeue();
        continue;
      }

      // Send to Gemini Live upstream
      await targetSession.sendRealtimeInput({
        audio: { data: frame.data, mimeType: "audio/pcm;rate=16000" },
      });

      // Dequeue only after successful upstream dispatch
      this.audioBuffer.dequeue();

      // Inter-chunk pacing to avoid socket burst congestion
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    if (this.currentGeminiState === "DRAINING") {
      this.currentGeminiState = "READY";
      this._send(this.clientWs, { type: "status", status: "connected", geminiState: "READY" });
    }
  } catch (err: any) {
    console.error("[AudioDrain] Drain failed:", err);
    this.currentGeminiState = "FAILED";
    this.audioBuffer.clear();
    this._send(this.clientWs, { type: "status", status: "session_failed", geminiState: "FAILED" });
  } finally {
    this._isDraining = false;
  }
}
```

---

### 2.4 Complete Project Switch Cutover Sequence (§2.4 Full Specification)

```mermaid
sequenceDiagram
    autonumber
    actor User as Human Operator
    participant Client as Frontend (audio.ts)
    participant CM as ConversationManager.ts
    participant Factory as GeminiSessionFactory.ts
    participant OldGem as Gemini Live (Epoch 1: Project A)
    participant NewGem as Gemini Live (Epoch 2: Project B)

    Note over CM: State: READY | Active Epoch: 1 (Project A)
    User->>OldGem: "Switch to Project B" (User audio streaming directly to OldGem)
    OldGem->>CM: trackProjectTask({ action: 'switch', projectName: 'Project B' })
    CM->>CM: ProjectStore.setActiveProject("proj-b")
    CM->>Factory: requestSessionRotation("project_switch")
    Note over Factory: flags.pendingSessionRotation = "project_switch"
    OldGem-->>User: Speaks: "Switching to Project B now."
    OldGem->>Factory: message.serverContent.turnComplete: true

    rect rgb(35, 20, 50)
    Note over Factory,CM: === EPOCH CUTOVER POINT ===
    Factory->>Factory: flags.isRotating = true; OldGem.close()
    CM->>CM: sessionEpoch = 2; // Incremented immediately
    CM->>CM: audioBuffer.clear(); // Purge all residual Epoch 1 frames
    Note over CM: Any in-flight frames sent before turnComplete<br/>were consumed by OldGem. Queue size is 0.
    CM->>Client: WS Frame: status="connecting_gemini", geminiState="RECREATING", epoch=2
    end

    User->>Client: "What tasks are pending?" (Speech intended for Project B)
    Client->>CM: WS Frames: { audio: chunk, epoch: 2 }
    CM->>CM: audioBuffer.enqueue(chunk, epoch=2) (Buffered safely)

    Factory->>NewGem: ai.live.connect(Project B instructions)
    NewGem-->>Factory: onopen
    Factory->>CM: onGeminiStateChange("DRAINING")
    CM->>NewGem: Drain audioBuffer.dequeue() sequentially (Epoch 2 only)
    Note over CM: Drain completes -> currentGeminiState = "READY"
    CM-->>Client: WS Frame: status="connected", geminiState="READY"
    NewGem-->>User: Speaks: "In Project B, there are 2 pending tasks..."
```

#### Ordered Cutover Steps & Isolation Guarantees
1. **Project A Active Audio**: Frames stream directly to `OldGem`. Queue size is 0.
2. **`turnComplete` Signal**: `OldGem` completes spoken reply. `turnComplete` arrives at `GeminiSessionFactory.ts`.
3. **Cutover Initiation**: `flags.pendingSessionRotation` triggers rotation.
4. **Epoch Increment**: `sessionEpoch` increments synchronously ($1 \to 2$).
5. **Queue Purge**: `audioBuffer.clear()` executes synchronously. Any late chunk tagged with Epoch 1 is discarded.
6. **Old Session Shutdown**: `OldGem.close()` fires.
7. **New Session Creation**: `ai.live.connect()` runs with `buildCompleteSystemInstructions()` querying newly active Project B.
8. **Replacement Session Activation**: `onopen` fires on `NewGem`.
9. **READY Callback Validation**: Verified against `NewGem.sessionId`.
10. **First Project B Audio Delivery**: Buffer drains Epoch 2 frames to `NewGem` in strict FIFO order.

**Proof of Zero Audio Leakage**:
- All pre-cutover speech was either sent to `OldGem` or purged by `audioBuffer.clear()`.
- Every frame arriving during `RECREATING` is stamped with `epoch = 2`.
- The drain worker evaluates `if (frame.epoch !== this._drainEpoch) continue;`.
- No frame from Project A can ever reach `NewGem`.

---

## 3. Scope B — Confirmation Capability Revocation (SEC-P3-R1.3-01)

### 3.1 Mandatory Session Ownership
- For both `confirm_decision` and `reject_decision`:
  - `sessionId` is extracted from the authenticated server WebSocket connection context (`clientSessionId` / `authenticatedRemoteSession.sessionId`).
  - The `"local"` bypass exception is strictly **prohibited** for socket-originated requests.
  - If `sessionId !== payload.sessionId`, the request is rejected with `SESSION_MISMATCH`.

---

### 3.2 Trusted Canonical Arguments Architecture
- The client provides only `{ decisionId, projectId, confirmationToken }`.
- The server retrieves the record: `decision = await projectDecisionStore.getDecision(decisionId)`.
- If `!decision`, operation halts immediately with `DECISION_NOT_FOUND` (token unconsumed).
- Server derives canonical arguments:
  ```ts
  const canonicalArgs = {
    action: "confirm_decision",
    decisionId: decision.id,
    projectId: decision.projectId,
  };
  ```
- `SecurityPolicyEngine` computes `argsHash = this._hashArgs(canonicalArgs)` and validates `payload.argsHash === argsHash`.

---

### 3.3 Complete Approval/Rejection Failure Semantics

```mermaid
flowchart TD
    Req["Incoming confirm_decision or reject_decision"] --> AuthCheck{"Authenticated<br/>Session Matches?"}
    AuthCheck -- No --> FailAuth["Reject: SESSION_MISMATCH<br/>(Token Unconsumed)"]
    AuthCheck -- Yes --> DecCheck{"Decision exists in<br/>ProjectDecisionStore?"}
    DecCheck -- No --> FailDec["Reject: DECISION_NOT_FOUND<br/>(Token Unconsumed)"]
    DecCheck -- Yes --> TokenCheck{"verifyToken()<br/>Sig, TTL, BootID, Args"}
    TokenCheck -- Invalid --> FailSig["Reject: SIGNATURE_INVALID / EXPIRED / ARGS_MISMATCH<br/>(Token Unconsumed)"]
    TokenCheck -- Valid --> ConsumeCheck{"_consumedTokens.has(tokenId)?"}
    ConsumeCheck -- Yes --> FailReplay["Reject: ALREADY_CONSUMED / REPLAY<br/>(Fail Closed)"]
    ConsumeCheck -- No --> MarkConsumed["_consumeTokenId(tokenId, status)<br/>ATOMICALLY MARK CONSUMED"]
    MarkConsumed --> IsConfirm{"Action == confirm?"}
    IsConfirm -- Yes --> StorePersist["projectDecisionStore.confirmDecision()"]
    StorePersist -- Success --> SuccessConfirm["Emit TOOL_CONFIRMED<br/>Return decision_confirmed"]
    StorePersist -- Failure --> FailPersist["Fail Closed: Token remains consumed!<br/>Return PERSISTENCE_ERROR<br/>Operator must re-prompt."]
    IsConfirm -- No --> SuccessRevoke["Emit TOOL_BLOCKED (REVOKED)<br/>Return decision_rejected"]
```

#### Exact Concurrency & Failure Rules
1. **Persistence Failure after Consumption**:
   - Token is consumed **before** mutating persistent store.
   - If `projectDecisionStore.confirmDecision()` throws an I/O error, the token **remains consumed**. It cannot be re-used.
   - The operation fails closed; the operator must request a new confirmation.
2. **Approval-First**:
   - Token is marked consumed (`status: "CONFIRMED"`).
   - Subsequent `reject_decision` sees `_consumedConfirmationTokens.has(tokenId)` -> returns `{ revoked: false, reason: "ALREADY_CONSUMED", status: "ALREADY_CONFIRMED" }`. Confirmed decision is **not** reverted.
3. **Rejection-First**:
   - Token is marked consumed (`status: "REVOKED"`).
   - Subsequent `confirm_decision` sees `_consumedConfirmationTokens.has(tokenId)` -> returns `CONFIRMATION_TOKEN_REPLAY`. Approval is permanently blocked.
4. **Interleaved Concurrent Race**:
   - Node.js event loop evaluates `_consumeTokenId()` synchronously and atomically. Whichever frame runs first wins; the second frame is rejected.
5. **Duplicate Requests**:
   - Duplicate approval returns `CONFIRMATION_TOKEN_REPLAY`.
   - Duplicate rejection returns `{ revoked: false, reason: "ALREADY_CONSUMED" }`.
6. **Disconnect During Rejection**:
   - If disconnect occurs after token consumed: Token is safely revoked.
   - If disconnect occurs before frame reaches server: Token expires naturally at 300s TTL. Decision remains `ai_proposed`.

---

### 3.4 Verification of Emergency Stop & Security Lockdown Call Paths

The complete execution path for WebSocket `reject_decision` is enforced in [`ConversationManager.ts`](file:///d:/SORA%20AI/Sora%20AI/backend/conversation/ConversationManager.ts):

```ts
} else if (msg.type === "reject_decision") {
  const { decisionId, projectId, confirmationToken } = msg;

  // 1. Session Identity Extraction
  const socketSessionId = (clientWs as any)?.remoteSession?.sessionId || clientSessionId;
  if (!socketSessionId) {
    this._send(clientWs, { type: "decision_rejection_failed", error: "MISSING_SESSION_CONTEXT" });
    return;
  }

  // 2. Emergency Stop Fail-Closed Gate
  const { emergencyStopCoordinator } = await import("../remote/EmergencyStopCoordinator.ts");
  if (emergencyStopCoordinator.isActive()) {
    this._send(clientWs, { type: "decision_rejection_failed", error: "EMERGENCY_STOP_ACTIVE" });
    return;
  }

  // 3. Security Policy Lockdown Fail-Closed Gate
  const { securityPolicyEngine } = await import("../security/SecurityPolicyEngine.ts");
  if (securityPolicyEngine.getMode() === "LOCKDOWN") {
    this._send(clientWs, { type: "decision_rejection_failed", error: "SECURITY_LOCKDOWN_ACTIVE" });
    return;
  }

  // 4. Retrieve Canonical Decision Record from Store
  const { projectDecisionStore } = await import("../projects/ProjectDecisionStore.ts");
  const decision = await projectDecisionStore.getDecision(decisionId);
  if (!decision) {
    this._send(clientWs, { type: "decision_rejection_failed", error: "DECISION_NOT_FOUND" });
    return;
  }

  // 5. Build Canonical Arguments
  const canonicalArgs = { action: "confirm_decision", decisionId: decision.id, projectId: decision.projectId };

  // 6. SecurityPolicyEngine Revocation
  const revokeRes = securityPolicyEngine.revokeConfirmationToken(
    confirmationToken,
    "trackProjectTask",
    canonicalArgs,
    socketSessionId,
  );

  if (!revokeRes.revoked) {
    this._send(clientWs, { type: "decision_rejection_failed", error: revokeRes.reason });
    return;
  }

  // 7. Structured Audit Logging (Secret-Safe)
  const { securityAuditLogger } = await import("../security/SecurityAuditLogger.ts");
  securityAuditLogger.logEvent({
    eventType: "TOOL_BLOCKED",
    actor: { identityId: socketSessionId, role: "standard", ipAddress: "127.0.0.1", sessionId: socketSessionId },
    target: { toolName: "trackProjectTask", resource: `decision:${decisionId}` },
    decision: "BLOCK",
    reason: `User explicitly rejected decision confirmation in UI; capability revoked.`,
    riskLevel: "HIGH",
    metadata: { decisionId, projectId: decision.projectId, tokenId: revokeRes.tokenId, argsHash: revokeRes.argsHash },
  });

  // 8. Client & Model Notification
  this._send(clientWs, { type: "decision_rejected", decisionId, projectId: decision.projectId });
  session?.sendClientContent?.({
    turns: [{ role: "user", parts: [{ text: `[System Action: The human operator rejected decision "${decisionId}".]` }] }],
    turnComplete: true,
  });
}
```

*Verification*: This preserves the entire security chain without modifying frozen [`ToolOrchestrator.ts`](file:///d:/SORA%20AI/Sora%20AI/backend/tools/ToolOrchestrator.ts).

---

### 3.5 Process Generation Assumptions & Multi-Worker Architecture

#### Single-Process Default
In [`backend/server.ts`](file:///d:/SORA%20AI/Sora%20AI/backend/server.ts), MYRAA operates as a single Node.js process:
```ts
export const PROCESS_BOOT_ID = crypto.randomUUID();
```
Upon restart, a new UUID is generated. All pre-restart tokens contain the old `processBootId` and are instantly rejected with `STALE_PROCESS_GENERATION`.

#### Multi-Worker / Cluster Support
If the application is deployed with Node.js cluster or worker threads:
1. The master process initializes `PROCESS_BOOT_ID = process.env.MYRAA_BOOT_ID || crypto.randomUUID()`.
2. When master forks workers, `MYRAA_BOOT_ID` is passed in worker environment variables.
3. All worker processes within the same server generation share the identical `PROCESS_BOOT_ID`.
4. When the server cluster restarts, a new `PROCESS_BOOT_ID` is generated.
5. **Fail-Closed Rule**: If a token is presented across deployments or after a server reboot, `payload.processBootId !== PROCESS_BOOT_ID` triggers immediate fail-closed rejection.

---

## 4. Exact Scope Accounting (6 Production + 2 Test Files)

```
┌────────────────────────────────────────────────────────────────────────┐
│ DECLARED PRODUCTION IMPLEMENTATION SCOPE (6 + 2 FILES):                │
│                                                                        │
│ 1. backend/conversation/ConversationManager.ts                         │
│    - BoundedAudioRingBuffer implementation                             │
│    - DRAINING state handling and FIFO queue drain                      │
│    - Epoch cutover handling on project switch                          │
│    - reject_decision handler with Emergency Stop & Lockdown checks     │
│                                                                        │
│ 2. backend/ai/GeminiSessionFactory.ts                                  │
│    - Pass onEpochCutover callback during turnComplete rotation         │
│    - Stamping of sessionId on session instance callbacks               │
│                                                                        │
│ 3. backend/security/SecurityPolicyEngine.ts                            │
│    - PROCESS_BOOT_ID generation and token payload binding              │
│    - revokeConfirmationToken() API and _consumeTokenId()               │
│                                                                        │
│ 4. frontend/lib/audio.ts                                               │
│    - Pass confirmationToken parameter in rejectDecision()              │
│                                                                        │
│ 5. frontend/components/DecisionConfirmationModal.tsx                   │
│    - Pass data.confirmationToken in onReject()                         │
│                                                                        │
│ 6. frontend/App.tsx                                                    │
│    - Wire token into onReject callback                                 │
│                                                                        │
│ Test Files:                                                            │
│ 7. tests/unit/phase10_audio_continuity.test.ts (19 Audio tests)        │
│ 8. tests/unit/phase10_project_continuity.test.ts (19 Revocation tests) │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 5. Test Plan & Acceptance Mapping (38 Tests Total)

### 5.1 Audio Continuity Tests (19 Tests)

| Test ID | Scenario | Input / Setup | Expected Result | Acceptance Criterion | Source File | Level |
|---|---|---|---|---|---|---|
| **AC-01** | Direct dispatch when READY | Standard 5,464 char frame in `READY` | Sent directly to `sendRealtimeInput`; buffer size 0 | §2.3 Invariant 1 | `ConversationManager.ts` | Unit |
| **AC-02** | Enqueue when RECREATING | Standard frame in `RECREATING` | Frame enqueued; buffer size increments | §2.3 Invariant 2 | `ConversationManager.ts` | Unit |
| **AC-03** | Sequential drain FIFO order | 10 frames enqueued during recreate | Drained in exact order 1..10 to upstream | §2.3 Invariant 3 | `ConversationManager.ts` | Integration |
| **AC-04** | Frame arriving during DRAINING | Frame arrives while draining | Appended to queue tail; never overtakes | §2.3 Invariant 3 | `ConversationManager.ts` | Unit |
| **AC-05** | Oversized frame rejection | Frame with length 6,145 chars | Rejected immediately; `OVERSIZED_FRAME` | §2.2 Termination | `ConversationManager.ts` | Unit |
| **AC-06** | Malformed Base64 characters | Base64 with invalid chars (`$$$`) | Rejected; `MALFORMED_PADDING` | §2.2 Validation | `ConversationManager.ts` | Unit |
| **AC-07** | Malformed Base64 padding | String with 3 padding chars (`===`) | Rejected; `MALFORMED_PADDING` | §2.1 Math | `ConversationManager.ts` | Unit |
| **AC-08** | Short / odd PCM byte count | Frame with odd byte length | Rejected; `INVALID_FORMAT` | §2.1 Sample boundary | `ConversationManager.ts` | Unit |
| **AC-09** | Exact 24 frames capacity fit | 24 standard frames enqueued | All 24 fit exactly; total PCM = 98,304 B | §2.1 Capacity | `ConversationManager.ts` | Unit |
| **AC-10** | 25th frame queue overflow | Attempt 25th frame enqueue | Rejected with `QUEUE_FULL`; warning emitted | §2.2 Bounded Hold | `ConversationManager.ts` | Integration |
| **AC-11** | Project switch cutover purge | Project switch triggers rotation | Epoch increments; Epoch 1 queue purged | §2.4 Cutover | `GeminiSessionFactory.ts` | Integration |
| **AC-12** | Epoch isolation verification | Enqueue Epoch 1, cutover, enqueue 2 | Drain receives only Epoch 2 frames | §2.4 Zero leakage | `ConversationManager.ts` | Integration |
| **AC-13** | Rapid sequential switches (3x) | 3 rapid switches in 1 second | Epoch increments 3x; no race or deadlock | §2.4 Stability | `ConversationManager.ts` | Integration |
| **AC-14** | Duplicate onopen READY callback | Multiple onopen calls | Single drain worker runs; no double send | §2.3 Idempotency | `ConversationManager.ts` | Unit |
| **AC-15** | Stale callback from old session | Callback from closed session | Rejected via `sessionId` match check | §2.3 Session guard | `GeminiSessionFactory.ts` | Unit |
| **AC-16** | Upstream send failure in drain | `sendRealtimeInput` throws | Catches error; state `FAILED`; buffer cleared | §2.3 Error recovery | `ConversationManager.ts` | Integration |
| **AC-17** | Client disconnect during buffer | Client socket closes with 10 frames | Buffer cleared; memory reclaimed | §2.2 Cleanup | `ConversationManager.ts` | Unit |
| **AC-18** | Two concurrent clients | 2 client sockets streaming audio | Independent ring buffers; zero cross-talk | §2.2 Isolation | `ConversationManager.ts` | Integration |
| **AC-19** | Upstream recreate failure | Recreate attempts exceed 3 | Buffer cleared; model prompts user repeat | §2.2 Graceful prompt | `ConversationManager.ts` | Integration |

---

### 5.2 Capability Revocation Tests (19 Tests)

| Test ID | Scenario | Input / Setup | Expected Result | Acceptance Criterion | Source File | Level |
|---|---|---|---|---|---|---|
| **CR-01** | Explicit reject then approve | User rejects in UI, then submits token | Approval fails: `CONFIRMATION_TOKEN_REPLAY` | §3.3 Anti-replay | `SecurityPolicyEngine.ts` | Unit |
| **CR-02** | Duplicate rejection calls | Submit `reject_decision` twice | Second call returns `ALREADY_CONSUMED` | §3.3 Idempotency | `SecurityPolicyEngine.ts` | Unit |
| **CR-03** | Rejection with wrong sessionId | Token from session A, socket is session B | Rejected: `SESSION_MISMATCH` | §3.1 Session ownership | `SecurityPolicyEngine.ts` | Unit |
| **CR-04** | Socket request without sessionId | Socket frame omitting session | Rejected: `MISSING_SESSION_CONTEXT` | §3.1 Mandatory session | `ConversationManager.ts` | Unit |
| **CR-05** | Rejection with tampered projectId | Tampered project in client message | Rejected: `ARGS_MISMATCH` | §3.2 Canonical args | `SecurityPolicyEngine.ts` | Unit |
| **CR-06** | Rejection with phantom decisionId | Non-existent decisionId in store | Rejected: `DECISION_NOT_FOUND` | §3.2 Store lookup | `ConversationManager.ts` | Unit |
| **CR-07** | Rejection after 301 seconds (expired)| Token past 300s TTL | Returns `TOKEN_EXPIRED` | §3.3 TTL boundary | `SecurityPolicyEngine.ts` | Unit |
| **CR-08** | Approval followed by late rejection | Confirm succeeds, then reject called | Approval stands; reject: `ALREADY_CONFIRMED` | §3.3 Case 2 | `SecurityPolicyEngine.ts` | Integration |
| **CR-09** | Concurrent approval/reject race | Interleaved approval and rejection | One succeeds; second fails; token consumed 1x | §3.3 Case 4 | `SecurityPolicyEngine.ts` | Integration |
| **CR-10** | Store persistence failure on confirm| Store throws after token consumed | Token remains consumed; returns error | §3.3 Case 1 Fail closed | `ConversationManager.ts` | Integration |
| **CR-11** | Backend process restart simulation | Token validated under new boot ID | Rejected: `STALE_PROCESS_GENERATION` | §3.5 Restart safety | `SecurityPolicyEngine.ts` | Unit |
| **CR-12** | Modal dismissal via Escape key | User presses Esc | Modal closes; token remains unrevoked in TTL | §3.4 UI Semantics | `App.tsx` | Unit |
| **CR-13** | Disconnect before reject arrives | Socket drops before frame sent | Token expires at 300s TTL | §3.3 Case 6 | `ConversationManager.ts` | Integration |
| **CR-14** | Audit log inspection | Inspect log entries on revocation | `tokenId` and `argsHash` logged; raw token absent | §3.4 Secret protection | `SecurityPolicyEngine.ts` | Unit |
| **CR-15** | Emergency Stop active during reject | `emergencyStopCoordinator.isActive()` | Rejection blocked: `EMERGENCY_STOP_ACTIVE` | §3.4 Security Gate 2 | `ConversationManager.ts` | Integration |
| **CR-16** | Security Lockdown active on reject | `securityPolicyEngine.getMode() === "LOCKDOWN"` | Rejection blocked: `SECURITY_LOCKDOWN_ACTIVE`| §3.4 Security Gate 3 | `ConversationManager.ts` | Integration |
| **CR-17** | Multi-worker boot ID inheritance | Child worker with same `MYRAA_BOOT_ID` | Valid token accepted across cluster workers | §3.5 Cluster support | `SecurityPolicyEngine.ts` | Unit |
| **CR-18** | Stale cluster deployment token | Token from previous deployment boot ID | Rejected: `STALE_PROCESS_GENERATION` | §3.5 Cluster fail closed | `SecurityPolicyEngine.ts` | Unit |
| **CR-19** | End-to-end UI reject lifecycle | User clicks Reject in mounted modal | Modal closes, token revoked, audit recorded | §3.4 End-to-end | `DecisionConfirmationModal.tsx` | Integration |

---

## 6. Invariants & Scope Compliance

- **`LIVE_TOOLS` Count**: Exactly **129 declarations** (frozen).
- **`LIVE_TOOLS` Uniqueness**: Exactly **129 unique names** (frozen).
- **Scope Limit**: Strictly **6 production files + 2 test files (8 files total)**.
- **Git State**: Zero Git operations (`git commit`, `git checkout`, `git reset`, `git stash`).
- **Production Safety**: Zero requests or modifications to `https://myraa-ai-q0h3.onrender.com`.

---

## 7. Implementation Readiness Verdict

```
══════════════════════════════════════════════════════════════════════════
FINAL VERDICT: READY FOR IMPLEMENTATION AUTHORIZATION

All technical consistency requirements and security call paths are
completely specified:
1. Exact Base64 padding and PCM byte math verified (§2.1).
2. Cohesive BoundedAudioRingBuffer API with atomic dequeue() (§2.2).
3. DRAINING state machine guarantees strict FIFO order (§2.3).
4. Complete 10-step Project Switch Cutover sequence documented (§2.4).
5. Fail-closed token consumption and persistence failure handling (§3.3).
6. Emergency Stop and Security Lockdown gates strictly enforced (§3.4).
7. PROCESS_BOOT_ID multi-worker restart defense verified (§3.5).
8. Exactly 6 production + 2 test files accounted for (§4.0).
9. Complete 38-test acceptance matrix with explicit criteria (§5.0).
══════════════════════════════════════════════════════════════════════════
```
