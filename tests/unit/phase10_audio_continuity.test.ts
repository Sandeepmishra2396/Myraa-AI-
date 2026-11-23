/**
 * MYRAA — Stage 10.4.2: Audio Continuity Test Suite (SEC-P4-A01)
 *
 * Covers all 19 R1.7 Audio Continuity acceptance scenarios (AC-01 through AC-19)
 * plus dedicated in-flight cutover, stale drain worker race, and conditional
 * queue removal tests.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  BoundedAudioRingBuffer,
  ConversationManager,
  validatePcmBase64Frame,
} from "../../backend/conversation/ConversationManager.ts";
import { GeminiSessionFactory, LIVE_TOOLS } from "../../backend/ai/GeminiSessionFactory.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Builds a valid canonical Base64-encoded PCM frame of exact byte size (default 4,096 B = 5,464 chars). */
function makePcmFrame(markerByte = 0x2a, byteLength = 4096): string {
  const buf = Buffer.alloc(byteLength, markerByte);
  // Stamp marker in first 2 bytes for unambiguous FIFO & epoch identity verification
  buf[0] = markerByte & 0xff;
  buf[1] = (markerByte >> 8) & 0xff;
  return buf.toString("base64");
}

function decodeMarker(base64Data: string): number {
  const buf = Buffer.from(base64Data, "base64");
  return buf[0] | (buf[1] << 8);
}

interface MockClientWs {
  readyState: number;
  remoteDevice?: any;
  remoteSession?: any;
  remoteSessionId?: string;
  sent: any[];
  handlers: Record<string, Array<(...args: any[]) => any>>;
  send: (payload: string) => void;
  on: (event: string, cb: (...args: any[]) => any) => void;
  close: () => void;
  emitMessage: (obj: unknown) => Promise<void>;
  emitClose: () => void;
}

function createMockClientWs(opts?: { deviceId?: string; sessionId?: string }): MockClientWs {
  const ws: MockClientWs = {
    readyState: 1,
    remoteDevice: opts?.deviceId ? { id: opts.deviceId, role: "standard", lastIp: "127.0.0.1" } : undefined,
    remoteSession: opts?.sessionId
      ? { sessionId: opts.sessionId, deviceId: opts?.deviceId || "dev-1", role: "standard", ipAddress: "127.0.0.1" }
      : undefined,
    remoteSessionId: opts?.sessionId,
    sent: [],
    handlers: {},
    send(payload: string) {
      try {
        this.sent.push(JSON.parse(payload));
      } catch {
        this.sent.push(payload);
      }
    },
    on(event: string, cb: (...args: any[]) => any) {
      if (!this.handlers[event]) this.handlers[event] = [];
      this.handlers[event].push(cb);
    },
    close() {
      this.readyState = 3;
    },
    async emitMessage(obj: unknown) {
      const raw = Buffer.from(JSON.stringify(obj));
      for (const h of this.handlers["message"] || []) {
        await h(raw);
      }
    },
    emitClose() {
      this.readyState = 3;
      for (const h of this.handlers["close"] || []) {
        h();
      }
    },
  };
  return ws;
}

interface Deferred<T = void> {
  promise: Promise<T>;
  resolve: (val: T | PromiseLike<T>) => void;
  reject: (err?: any) => void;
}

function createDeferred<T = void>(): Deferred<T> {
  let resolve!: (val: T | PromiseLike<T>) => void;
  let reject!: (err?: any) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface FakeLiveSession {
  sessionId: string;
  receivedAudio: string[];
  closed: boolean;
  sendRealtimeInput: ReturnType<typeof vi.fn>;
  sendClientContent: ReturnType<typeof vi.fn>;
  close: () => void;
}

interface RecordedCreateCall {
  sessionId: string;
  flags: any;
  onRotate: () => Promise<void>;
  session: FakeLiveSession;
}

/**
 * Controllable fake GeminiSessionFactory that executes real ConversationManager
 * state machine, queue, drain worker, and callback paths without network calls.
 */
function createControlledFactory(options?: {
  autoOpen?: boolean;
  onSendRealtimeInput?: (session: FakeLiveSession, payload: any, callIdx: number) => void | Promise<void>;
}) {
  const autoOpen = options?.autoOpen ?? true;
  const calls: RecordedCreateCall[] = [];
  let nextCreateGate: Deferred<void> | null = null;
  let sendCallCounter = 0;

  const factory = {
    createSession: vi.fn(async (opts: any) => {
      if (nextCreateGate) {
        const gate = nextCreateGate;
        nextCreateGate = null;
        await gate.promise;
      }
      const sid = opts.sessionId || `fake_sess_${calls.length + 1}`;
      const liveSession: FakeLiveSession = {
        sessionId: sid,
        receivedAudio: [],
        closed: false,
        sendRealtimeInput: vi.fn(async (payload: any) => {
          const idx = ++sendCallCounter;
          if (payload?.audio?.data) {
            liveSession.receivedAudio.push(payload.audio.data);
          }
          if (options?.onSendRealtimeInput) {
            await options.onSendRealtimeInput(liveSession, payload, idx);
          }
        }),
        sendClientContent: vi.fn(),
        close() {
          this.closed = true;
        },
      };

      const record: RecordedCreateCall = {
        sessionId: sid,
        flags: opts.flags,
        onRotate: opts.onRotate,
        session: liveSession,
      };
      calls.push(record);

      if (autoOpen) {
        opts.flags.onSessionOpen?.(sid, liveSession);
      }

      return liveSession;
    }),
  } as unknown as GeminiSessionFactory;

  return {
    factory,
    calls,
    pauseNextCreate(): Deferred<void> {
      const gate = createDeferred<void>();
      nextCreateGate = gate;
      return gate;
    },
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 1500): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("Timed out waiting for condition");
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

// ---------------------------------------------------------------------------
// Test Setup
// ---------------------------------------------------------------------------

const originalGeminiKey = process.env.GEMINI_API_KEY;

beforeEach(() => {
  process.env.GEMINI_API_KEY = "AIzaSyTestKeyForAudioContinuityUnitTests12345";
});

afterEach(() => {
  if (originalGeminiKey !== undefined) {
    process.env.GEMINI_API_KEY = originalGeminiKey;
  } else {
    delete process.env.GEMINI_API_KEY;
  }
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// 1. BoundedAudioRingBuffer & Base64/PCM Math Validation (AC-05..AC-09, RACE-03)
// ---------------------------------------------------------------------------

describe("Stage 10.4.2 SEC-P4-A01: BoundedAudioRingBuffer & PCM/Base64 Validation", () => {
  it("AC-05: rejects oversized audio frame (> 5,464 Base64 chars, e.g. 6,145 chars) with OVERSIZED_FRAME", () => {
    const buf = new BoundedAudioRingBuffer();
    const oversized = "A".repeat(6145);
    const res = buf.enqueue(oversized, 1);
    expect(res.success).toBe(false);
    if (res.success === false) {
      expect(res.reason).toBe("OVERSIZED_FRAME");
    }
    expect(buf.size).toBe(0);
    expect(buf.pcmBytes).toBe(0);
  });

  it("AC-06: rejects malformed Base64 characters ($$$) with MALFORMED_PADDING", () => {
    const buf = new BoundedAudioRingBuffer();
    const badChars = "$$$$".repeat(100);
    const res = buf.enqueue(badChars, 1);
    expect(res.success).toBe(false);
    if (res.success === false) {
      expect(res.reason).toBe("MALFORMED_PADDING");
    }
    expect(buf.size).toBe(0);
  });

  it("AC-07: rejects malformed Base64 padding (===, length % 4 !== 0, and non-canonical trailing bits)", () => {
    const buf = new BoundedAudioRingBuffer();

    const tripleEq = "A".repeat(5461) + "===";
    const r1 = buf.enqueue(tripleEq, 1);
    expect(r1.success).toBe(false);
    if (r1.success === false) expect(r1.reason).toBe("MALFORMED_PADDING");

    const badMod4 = "AAAA" + "A";
    const r2 = buf.enqueue(badMod4, 1);
    expect(r2.success).toBe(false);
    if (r2.success === false) expect(r2.reason).toBe("MALFORMED_PADDING");

    // Non-canonical padding bits: 'AB==' decodes to 1 byte (0x00) whose canonical Base64 is 'AA=='
    const nonCanonical = "AAAA".repeat(10) + "AB==";
    const r3 = buf.enqueue(nonCanonical, 1);
    expect(r3.success).toBe(false);
    if (r3.success === false) expect(r3.reason).toBe("MALFORMED_PADDING");
  });

  it("AC-08: rejects short/odd PCM byte count (violating 16-bit 2-byte sample boundary) with INVALID_FORMAT", () => {
    const buf = new BoundedAudioRingBuffer();
    const odd3Bytes = Buffer.alloc(3, 0x01).toString("base64");
    const r1 = buf.enqueue(odd3Bytes, 1);
    expect(r1.success).toBe(false);
    if (r1.success === false) expect(r1.reason).toBe("INVALID_FORMAT");

    const odd4095Bytes = Buffer.alloc(4095, 0x01).toString("base64");
    const r2 = buf.enqueue(odd4095Bytes, 1);
    expect(r2.success).toBe(false);
    if (r2.success === false) expect(r2.reason).toBe("INVALID_FORMAT");

    const vEmpty = validatePcmBase64Frame("");
    expect(vEmpty.valid).toBe(false);
    if (vEmpty.valid === false) expect(vEmpty.reason).toBe("INVALID_FORMAT");
  });

  it("AC-09: fits exactly 24 standard 4,096-byte (5,464-char) PCM frames = 98,304 PCM bytes & 131,136 Base64 chars", () => {
    const buf = new BoundedAudioRingBuffer();
    const standardFrame = makePcmFrame(1, 4096);
    expect(standardFrame.length).toBe(5464);
    expect(standardFrame.endsWith("==")).toBe(true);
    expect(Buffer.byteLength(standardFrame, "base64")).toBe(4096);

    for (let i = 1; i <= 24; i++) {
      const res = buf.enqueue(makePcmFrame(i, 4096), 1);
      expect(res.success).toBe(true);
      if (res.success === true) {
        expect(res.enqueuedCount).toBe(i);
        expect(res.frame.pcmByteLength).toBe(4096);
      }
    }

    expect(buf.size).toBe(24);
    expect(buf.pcmBytes).toBe(98_304);
    expect(buf.base64Chars).toBe(131_136);

    // 25th frame must fail with QUEUE_FULL without evicting frame 1
    const overflow = buf.enqueue(makePcmFrame(25, 4096), 1);
    expect(overflow.success).toBe(false);
    if (overflow.success === false) {
      expect(overflow.reason).toBe("QUEUE_FULL");
    }
    expect(buf.size).toBe(24);
    expect(decodeMarker(buf.peek()!.data)).toBe(1);
  });

  it("RACE-03: conditional dequeueIfMatch removes head ONLY when epoch and sequence both match", () => {
    const buf = new BoundedAudioRingBuffer();
    const r1 = buf.enqueue(makePcmFrame(10, 4096), 2);
    expect(r1.success).toBe(true);
    const seq1 = r1.success ? r1.frame.sequence : -1;

    // Wrong epoch must NOT remove head
    expect(buf.dequeueIfMatch(1, seq1)).toBeUndefined();
    expect(buf.size).toBe(1);
    expect(buf.pcmBytes).toBe(4096);

    // Wrong sequence must NOT remove head
    expect(buf.dequeueIfMatch(2, seq1 + 99)).toBeUndefined();
    expect(buf.size).toBe(1);

    // Exact match removes head and decrements accounting to 0
    const removed = buf.dequeueIfMatch(2, seq1);
    expect(removed).toBeDefined();
    expect(decodeMarker(removed!.data)).toBe(10);
    expect(buf.size).toBe(0);
    expect(buf.pcmBytes).toBe(0);
    expect(buf.base64Chars).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 2. ConversationManager State Machine & Continuity Flows (AC-01..AC-04, AC-10..AC-19)
// ---------------------------------------------------------------------------

describe("Stage 10.4.2 SEC-P4-A01: ConversationManager Real-Time Audio Continuity", () => {
  it("AC-01: dispatches standard 5,464-char frame directly when READY (zero buffering)", async () => {
    const ctrl = createControlledFactory({ autoOpen: true });
    const cm = new ConversationManager(ctrl.factory, { drainInterChunkDelayMs: 1 });
    const ws = createMockClientWs({ deviceId: "dev-ac01", sessionId: "sess-ac01" });

    await cm.handleConnection(ws);
    expect(ws.sent.some((m) => m.type === "status" && m.geminiState === "READY")).toBe(true);

    const frame = makePcmFrame(7, 4096);
    await ws.emitMessage({ audio: frame });

    expect(ctrl.calls[0].session.receivedAudio).toEqual([frame]);
    expect(ws.sent.some((m) => m.type === "audio_warning")).toBe(false);
  });

  it("AC-02: enqueues standard audio frames in RECREATING state without dispatching to closed session", async () => {
    const ctrl = createControlledFactory({ autoOpen: false });
    const cm = new ConversationManager(ctrl.factory, { drainInterChunkDelayMs: 1 });
    const ws = createMockClientWs({ deviceId: "dev-ac02", sessionId: "sess-ac02" });

    await cm.handleConnection(ws);
    const call1 = ctrl.calls[0];
    call1.flags.onSessionOpen(call1.sessionId, call1.session);

    // Enter RECREATING (simulating transient upstream disconnect)
    call1.flags.onGeminiStateChange("RECREATING", call1.sessionId);

    const frame1 = makePcmFrame(1, 4096);
    const frame2 = makePcmFrame(2, 4096);
    await ws.emitMessage({ audio: frame1 });
    await ws.emitMessage({ audio: frame2 });

    // Buffered safely; neither sent to old session while RECREATING
    expect(call1.session.receivedAudio.length).toBe(0);
    expect(ws.sent.some((m) => m.type === "audio_warning")).toBe(false);
  });

  it("AC-03: drains 10 enqueued frames in strict FIFO order (1..10) on replacement session READY", async () => {
    const ctrl = createControlledFactory({ autoOpen: false });
    const cm = new ConversationManager(ctrl.factory, { drainInterChunkDelayMs: 1 });
    const ws = createMockClientWs({ deviceId: "dev-ac03", sessionId: "sess-ac03" });

    await cm.handleConnection(ws);
    const call1 = ctrl.calls[0];
    call1.flags.onSessionOpen(call1.sessionId, call1.session);
    call1.flags.onGeminiStateChange("RECREATING", call1.sessionId);

    const frames = Array.from({ length: 10 }, (_, i) => makePcmFrame(i + 1, 4096));
    for (const f of frames) {
      await ws.emitMessage({ audio: f });
    }
    expect(call1.session.receivedAudio.length).toBe(0);

    // Rotate to replacement session and open it -> enters DRAINING -> READY
    const newSess = await call1.onRotate();
    const call2 = ctrl.calls[1];
    call2.flags.onSessionOpen(call2.sessionId, newSess);

    await waitFor(() =>
      ws.sent.filter((m) => m.type === "status" && m.geminiState === "READY").length >= 2,
    );

    expect(call2.session.receivedAudio.map(decodeMarker)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it("AC-04: frames arriving during DRAINING append to queue tail and never overtake earlier frames", async () => {
    const gateFrame1 = createDeferred<void>();
    let releaseFirstOnce = false;

    const ctrl = createControlledFactory({
      autoOpen: false,
      onSendRealtimeInput: async (_sess, _payload, callIdx) => {
        if (callIdx === 1 && !releaseFirstOnce) {
          releaseFirstOnce = true;
          await gateFrame1.promise;
        }
      },
    });
    const cm = new ConversationManager(ctrl.factory, { drainInterChunkDelayMs: 1 });
    const ws = createMockClientWs({ deviceId: "dev-ac04", sessionId: "sess-ac04" });

    await cm.handleConnection(ws);
    const call1 = ctrl.calls[0];
    call1.flags.onGeminiStateChange("RECREATING", call1.sessionId);

    // Enqueue initial 3 frames during RECREATING
    await ws.emitMessage({ audio: makePcmFrame(1, 4096) });
    await ws.emitMessage({ audio: makePcmFrame(2, 4096) });
    await ws.emitMessage({ audio: makePcmFrame(3, 4096) });

    // Open session -> starts DRAINING, blocks inside sendRealtimeInput for frame 1
    call1.flags.onSessionOpen(call1.sessionId, call1.session);
    await waitFor(() => call1.session.sendRealtimeInput.mock.calls.length === 1);

    // Frames 4 & 5 arrive while DRAINING is active -> MUST append to tail, never overtake 2 & 3
    await ws.emitMessage({ audio: makePcmFrame(4, 4096) });
    await ws.emitMessage({ audio: makePcmFrame(5, 4096) });

    // Release frame 1 and let drain finish
    gateFrame1.resolve();
    await waitFor(() => ws.sent.some((m) => m.type === "status" && m.geminiState === "READY"));

    expect(call1.session.receivedAudio.map(decodeMarker)).toEqual([1, 2, 3, 4, 5]);
  });

  it("AC-10: 25th frame emits explicit audio_warning (QUEUE_FULL) without dropping older frames", async () => {
    const ctrl = createControlledFactory({ autoOpen: false });
    const cm = new ConversationManager(ctrl.factory, { drainInterChunkDelayMs: 0 });
    const ws = createMockClientWs({ deviceId: "dev-ac10", sessionId: "sess-ac10" });

    await cm.handleConnection(ws);
    const call1 = ctrl.calls[0];
    call1.flags.onGeminiStateChange("RECREATING", call1.sessionId);

    for (let i = 1; i <= 25; i++) {
      await ws.emitMessage({ audio: makePcmFrame(i, 4096) });
    }

    const warnings = ws.sent.filter((m) => m.type === "audio_warning");
    expect(warnings.length).toBe(1);
    expect(warnings[0].reason).toBe("QUEUE_FULL");
    expect(warnings[0].queueSize).toBe(24);
    expect(warnings[0].pcmBytes).toBe(98_304);

    // Drain and verify frames 1..24 are intact (frame 1 was NOT evicted; frame 25 was rejected)
    call1.flags.onSessionOpen(call1.sessionId, call1.session);
    await waitFor(() => ws.sent.some((m) => m.type === "status" && m.geminiState === "READY"));
    expect(call1.session.receivedAudio.map(decodeMarker)).toEqual(
      Array.from({ length: 24 }, (_, i) => i + 1),
    );
  });

  it("AC-11: project switch cutover increments epoch synchronously and purges Epoch 1 queue", async () => {
    const ctrl = createControlledFactory({ autoOpen: false });
    const cm = new ConversationManager(ctrl.factory, { drainInterChunkDelayMs: 1 });
    const ws = createMockClientWs({ deviceId: "dev-ac11", sessionId: "sess-ac11" });

    await cm.handleConnection(ws);
    const call1 = ctrl.calls[0];
    call1.flags.onGeminiStateChange("RECREATING", call1.sessionId);

    // Enqueue Epoch 1 (Project A) frames
    await ws.emitMessage({ audio: makePcmFrame(101, 4096) });
    await ws.emitMessage({ audio: makePcmFrame(102, 4096) });

    // Project switch cutover fires synchronously BEFORE rotation
    call1.flags.onEpochCutover("project_switch:ProjectB");

    const recreatingNotice = ws.sent.find(
      (m) => m.type === "status" && m.geminiState === "RECREATING" && m.epoch === 2,
    );
    expect(recreatingNotice).toBeDefined();

    // Opening replacement session with no Epoch 2 frames must deliver ZERO Epoch 1 frames
    const sess2 = await call1.onRotate();
    const call2 = ctrl.calls[1];
    call2.flags.onSessionOpen(call2.sessionId, sess2);
    await waitFor(() =>
      ws.sent.some((m) => m.type === "status" && m.geminiState === "READY" && m.epoch === 2),
    );
    expect(call2.session.receivedAudio).toEqual([]);
  });

  it("AC-12: epoch isolation delivers ONLY Epoch 2 frames to replacement session (zero Project A leakage)", async () => {
    const ctrl = createControlledFactory({ autoOpen: false });
    const cm = new ConversationManager(ctrl.factory, { drainInterChunkDelayMs: 1 });
    const ws = createMockClientWs({ deviceId: "dev-ac12", sessionId: "sess-ac12" });

    await cm.handleConnection(ws);
    const call1 = ctrl.calls[0];
    call1.flags.onGeminiStateChange("RECREATING", call1.sessionId);

    // Enqueue Epoch 1 (Project A) frames
    await ws.emitMessage({ audio: makePcmFrame(101, 4096) });
    await ws.emitMessage({ audio: makePcmFrame(102, 4096) });

    // Cutover to Epoch 2 (Project B)
    call1.flags.onEpochCutover("project_switch:ProjectB");

    // User speaks for Project B (Epoch 2) while replacement session connects
    await ws.emitMessage({ audio: makePcmFrame(201, 4096) });
    await ws.emitMessage({ audio: makePcmFrame(202, 4096) });

    const sess2 = await call1.onRotate();
    const call2 = ctrl.calls[1];
    call2.flags.onSessionOpen(call2.sessionId, sess2);

    await waitFor(() =>
      ws.sent.some((m) => m.type === "status" && m.geminiState === "READY" && m.epoch === 2),
    );

    // Zero Project A (101, 102) leakage into Project B session!
    expect(call2.session.receivedAudio.map(decodeMarker)).toEqual([201, 202]);
  });

  it("AC-13: 3x rapid sequential project switches increment epoch 3x with no deadlock and only final epoch audio delivered", async () => {
    const ctrl = createControlledFactory({ autoOpen: false });
    const cm = new ConversationManager(ctrl.factory, { drainInterChunkDelayMs: 1 });
    const ws = createMockClientWs({ deviceId: "dev-ac13", sessionId: "sess-ac13" });

    await cm.handleConnection(ws);
    const call1 = ctrl.calls[0];
    call1.flags.onSessionOpen(call1.sessionId, call1.session);

    // Rapid switch 1 (epoch 1 -> 2)
    call1.flags.onEpochCutover("project_switch:ProjB");
    await ws.emitMessage({ audio: makePcmFrame(21, 4096) });

    // Rapid switch 2 (epoch 2 -> 3)
    call1.flags.onEpochCutover("project_switch:ProjC");
    await ws.emitMessage({ audio: makePcmFrame(31, 4096) });

    // Rapid switch 3 (epoch 3 -> 4)
    call1.flags.onEpochCutover("project_switch:ProjD");
    await ws.emitMessage({ audio: makePcmFrame(41, 4096) });
    await ws.emitMessage({ audio: makePcmFrame(42, 4096) });

    const finalSess = await call1.onRotate();
    const call2 = ctrl.calls[1];
    call2.flags.onSessionOpen(call2.sessionId, finalSess);

    await waitFor(() =>
      ws.sent.some((m) => m.type === "status" && m.geminiState === "READY" && m.epoch === 4),
    );

    expect(call2.session.receivedAudio.map(decodeMarker)).toEqual([41, 42]);
  });

  it("AC-14: duplicate onopen callbacks run only a single drain worker with zero double-send", async () => {
    const ctrl = createControlledFactory({ autoOpen: false });
    const cm = new ConversationManager(ctrl.factory, { drainInterChunkDelayMs: 2 });
    const ws = createMockClientWs({ deviceId: "dev-ac14", sessionId: "sess-ac14" });

    await cm.handleConnection(ws);
    const call1 = ctrl.calls[0];
    call1.flags.onGeminiStateChange("RECREATING", call1.sessionId);

    await ws.emitMessage({ audio: makePcmFrame(1, 4096) });
    await ws.emitMessage({ audio: makePcmFrame(2, 4096) });

    // Fire onSessionOpen 3 times for the same session generation
    call1.flags.onSessionOpen(call1.sessionId, call1.session);
    call1.flags.onSessionOpen(call1.sessionId, call1.session);
    call1.flags.onSessionOpen(call1.sessionId, call1.session);

    await waitFor(() => ws.sent.some((m) => m.type === "status" && m.geminiState === "READY"));

    expect(call1.session.receivedAudio.map(decodeMarker)).toEqual([1, 2]);
    const readyMessages = ws.sent.filter((m) => m.type === "status" && m.geminiState === "READY");
    expect(readyMessages.length).toBe(1);
  });

  it("AC-15: stale callbacks from superseded session generation are rejected by sessionId guard", async () => {
    const ctrl = createControlledFactory({ autoOpen: false });
    const cm = new ConversationManager(ctrl.factory, { drainInterChunkDelayMs: 1 });
    const ws = createMockClientWs({ deviceId: "dev-ac15", sessionId: "sess-ac15" });

    await cm.handleConnection(ws);
    const call1 = ctrl.calls[0];
    call1.flags.onSessionOpen(call1.sessionId, call1.session);

    // Rotate to session 2
    call1.flags.onEpochCutover("project_switch:ProjB");
    const sess2 = await call1.onRotate();
    const call2 = ctrl.calls[1];
    call2.flags.onSessionOpen(call2.sessionId, sess2);
    await waitFor(() =>
      ws.sent.some((m) => m.type === "status" && m.geminiState === "READY" && m.epoch === 2),
    );

    // Verify isCurrentSession rejects old sessionId and accepts new sessionId
    expect(call2.flags.isCurrentSession(call1.sessionId)).toBe(false);
    expect(call2.flags.isCurrentSession(call2.sessionId)).toBe(true);

    // Stale old session attempts to change state to FAILED / CLOSED or re-trigger onSessionOpen
    call1.flags.onGeminiStateChange("FAILED", call1.sessionId);
    call1.flags.onGeminiStateChange("CLOSED", call1.sessionId);
    call1.flags.onSessionOpen(call1.sessionId, call1.session);

    // Replacement session 2 remains READY and directly dispatches new audio
    const probeFrame = makePcmFrame(99, 4096);
    await ws.emitMessage({ audio: probeFrame });
    expect(call2.session.receivedAudio).toEqual([probeFrame]);
    expect(call1.session.receivedAudio).toEqual([]);
  });

  it("AC-16: upstream send failure during drain catches error, clears buffer, and emits FAILED status", async () => {
    const ctrl = createControlledFactory({
      autoOpen: false,
      onSendRealtimeInput: async () => {
        throw new Error("Upstream WebSocket broken pipe");
      },
    });
    const cm = new ConversationManager(ctrl.factory, { drainInterChunkDelayMs: 1 });
    const ws = createMockClientWs({ deviceId: "dev-ac16", sessionId: "sess-ac16" });

    await cm.handleConnection(ws);
    const call1 = ctrl.calls[0];
    call1.flags.onGeminiStateChange("RECREATING", call1.sessionId);
    await ws.emitMessage({ audio: makePcmFrame(1, 4096) });
    await ws.emitMessage({ audio: makePcmFrame(2, 4096) });

    call1.flags.onSessionOpen(call1.sessionId, call1.session);

    await waitFor(() =>
      ws.sent.some((m) => m.type === "status" && m.status === "session_failed" && m.geminiState === "FAILED"),
    );

    const failedMsg = ws.sent.find((m) => m.type === "status" && m.geminiState === "FAILED");
    expect(failedMsg).toBeDefined();
    expect(failedMsg.reason).toContain("broken pipe");
  });

  it("AC-17: client disconnect during buffering clears queue and prevents stale drain dispatch", async () => {
    const ctrl = createControlledFactory({ autoOpen: false });
    const cm = new ConversationManager(ctrl.factory, { drainInterChunkDelayMs: 1 });
    const ws = createMockClientWs({ deviceId: "dev-ac17", sessionId: "sess-ac17" });

    await cm.handleConnection(ws);
    const call1 = ctrl.calls[0];
    call1.flags.onGeminiStateChange("RECREATING", call1.sessionId);

    for (let i = 1; i <= 10; i++) {
      await ws.emitMessage({ audio: makePcmFrame(i, 4096) });
    }

    // Client disconnects mid-buffer
    ws.emitClose();
    expect(call1.session.closed).toBe(true);

    // Late onopen after client close must not dispatch any buffered audio
    call1.flags.onSessionOpen(call1.sessionId, call1.session);
    await new Promise((r) => setTimeout(r, 20));
    expect(call1.session.receivedAudio.length).toBe(0);
  });

  it("AC-18: two concurrent clients maintain strictly isolated ring buffers with zero cross-talk", async () => {
    const ctrlA = createControlledFactory({ autoOpen: false });
    const ctrlB = createControlledFactory({ autoOpen: false });
    const cmA = new ConversationManager(ctrlA.factory, { drainInterChunkDelayMs: 1 });
    const cmB = new ConversationManager(ctrlB.factory, { drainInterChunkDelayMs: 1 });

    const wsA = createMockClientWs({ deviceId: "client-A", sessionId: "sess-A" });
    const wsB = createMockClientWs({ deviceId: "client-B", sessionId: "sess-B" });

    await Promise.all([cmA.handleConnection(wsA), cmB.handleConnection(wsB)]);

    ctrlA.calls[0].flags.onGeminiStateChange("RECREATING", ctrlA.calls[0].sessionId);
    ctrlB.calls[0].flags.onGeminiStateChange("RECREATING", ctrlB.calls[0].sessionId);

    // Interleave frames from Client A (markers 10..12) and Client B (markers 20..22)
    await wsA.emitMessage({ audio: makePcmFrame(10, 4096) });
    await wsB.emitMessage({ audio: makePcmFrame(20, 4096) });
    await wsA.emitMessage({ audio: makePcmFrame(11, 4096) });
    await wsB.emitMessage({ audio: makePcmFrame(21, 4096) });
    await wsA.emitMessage({ audio: makePcmFrame(12, 4096) });
    await wsB.emitMessage({ audio: makePcmFrame(22, 4096) });

    // Cutover Client A only — Client B's buffer must be completely unaffected
    ctrlA.calls[0].flags.onEpochCutover("project_switch:OnlyA");
    await wsA.emitMessage({ audio: makePcmFrame(19, 4096) });

    ctrlA.calls[0].flags.onSessionOpen(ctrlA.calls[0].sessionId, ctrlA.calls[0].session);
    ctrlB.calls[0].flags.onSessionOpen(ctrlB.calls[0].sessionId, ctrlB.calls[0].session);

    await waitFor(
      () =>
        wsA.sent.some((m) => m.type === "status" && m.geminiState === "READY") &&
        wsB.sent.some((m) => m.type === "status" && m.geminiState === "READY"),
    );

    expect(ctrlA.calls[0].session.receivedAudio.map(decodeMarker)).toEqual([19]);
    expect(ctrlB.calls[0].session.receivedAudio.map(decodeMarker)).toEqual([20, 21, 22]);
  });

  it("AC-19: upstream recreate exhaustion clears buffer and prompts user to repeat", async () => {
    const ctrl = createControlledFactory({ autoOpen: false });
    const cm = new ConversationManager(ctrl.factory, { drainInterChunkDelayMs: 1 });
    const ws = createMockClientWs({ deviceId: "dev-ac19", sessionId: "sess-ac19" });

    await cm.handleConnection(ws);
    const call1 = ctrl.calls[0];
    call1.flags.onGeminiStateChange("RECREATING", call1.sessionId);

    await ws.emitMessage({ audio: makePcmFrame(1, 4096) });
    await ws.emitMessage({ audio: makePcmFrame(2, 4096) });

    // Simulate recreate exhaustion after 3 failed attempts
    call1.flags.onRecreateExhausted(1011, "Max recreate attempts exceeded. Please repeat your last message.");

    const closedMsg = ws.sent.find(
      (m) => m.type === "status" && m.status === "session_closed" && m.bufferCleared === true,
    );
    expect(closedMsg).toBeDefined();
    expect(closedMsg.promptRepeat).toBe(true);
    expect(closedMsg.geminiState).toBe("CLOSED");
  });
});

// ---------------------------------------------------------------------------
// 3. Critical Concurrency Fix: In-Flight sendRealtimeInput() & Stale Drain Worker Races
// ---------------------------------------------------------------------------

describe("Stage 10.4.2 SEC-P4-A01: In-Flight Drain Worker Cutover Race Protection", () => {
  it("RACE-01: old drain worker awaiting sendRealtimeInput() during cutover NEVER dequeues new-epoch frames or alters replacement session", async () => {
    const oldSessionSendGate = createDeferred<void>();

    const ctrl = createControlledFactory({
      autoOpen: false,
      onSendRealtimeInput: async (sess, _payload) => {
        // Suspend inside old session (session 1) sendRealtimeInput
        if (sess === ctrl.calls[0]?.session) {
          await oldSessionSendGate.promise;
        }
      },
    });
    const cm = new ConversationManager(ctrl.factory, { drainInterChunkDelayMs: 1 });
    const ws = createMockClientWs({ deviceId: "dev-race01", sessionId: "sess-race01" });

    await cm.handleConnection(ws);
    const call1 = ctrl.calls[0];
    call1.flags.onGeminiStateChange("RECREATING", call1.sessionId);

    // Enqueue Epoch 1 frames (Project A)
    await ws.emitMessage({ audio: makePcmFrame(11, 4096) });
    await ws.emitMessage({ audio: makePcmFrame(12, 4096) });

    // Start drain worker W1 on Session 1 (Epoch 1) — suspends mid-await on frame 11
    call1.flags.onSessionOpen(call1.sessionId, call1.session);
    await waitFor(() => call1.session.sendRealtimeInput.mock.calls.length === 1);

    // WHILE W1 IS SUSPENDED IN sendRealtimeInput():
    // 1. Project switch cutover fires (Epoch 1 -> Epoch 2, invalidates W1, clears queue)
    call1.flags.onEpochCutover("project_switch:ProjectB");

    // 2. Enqueue Epoch 2 frames (Project B)
    await ws.emitMessage({ audio: makePcmFrame(21, 4096) });
    await ws.emitMessage({ audio: makePcmFrame(22, 4096) });

    // 3. Now resolve W1's stale in-flight sendRealtimeInput() BEFORE Session 2 even opens!
    oldSessionSendGate.resolve();
    await new Promise((r) => setTimeout(r, 15));

    // W1 must NOT have dequeued Epoch 2 frame 21, must NOT have transitioned to READY,
    // and must NOT have sent frame 12 to oldSession!
    expect(call1.session.receivedAudio.map(decodeMarker)).toEqual([11]);
    expect(
      ws.sent.some((m) => m.type === "status" && m.geminiState === "READY" && m.epoch === 1),
    ).toBe(false);

    // 4. Now rotate and open Session 2 (Epoch 2) -> W2 drains BOTH Epoch 2 frames intact!
    const sess2 = await call1.onRotate();
    const call2 = ctrl.calls[1];
    call2.flags.onSessionOpen(call2.sessionId, sess2);

    await waitFor(() =>
      ws.sent.some((m) => m.type === "status" && m.geminiState === "READY" && m.epoch === 2),
    );

    expect(call2.session.receivedAudio.map(decodeMarker)).toEqual([21, 22]);
  });

  it("RACE-02: stale drain worker whose in-flight sendRealtimeInput() REJECTS after cutover does NOT clobber replacement session state or queue", async () => {
    const oldSessionSendGate = createDeferred<void>();

    const ctrl = createControlledFactory({
      autoOpen: false,
      onSendRealtimeInput: async (sess) => {
        if (sess === ctrl.calls[0]?.session) {
          await oldSessionSendGate.promise;
        }
      },
    });
    const cm = new ConversationManager(ctrl.factory, { drainInterChunkDelayMs: 1 });
    const ws = createMockClientWs({ deviceId: "dev-race02", sessionId: "sess-race02" });

    await cm.handleConnection(ws);
    const call1 = ctrl.calls[0];
    call1.flags.onGeminiStateChange("RECREATING", call1.sessionId);
    await ws.emitMessage({ audio: makePcmFrame(11, 4096) });

    // Start W1 on Session 1 (suspends in sendRealtimeInput)
    call1.flags.onSessionOpen(call1.sessionId, call1.session);
    await waitFor(() => call1.session.sendRealtimeInput.mock.calls.length === 1);

    // Cutover -> Epoch 2 -> enqueue Project B audio -> open Session 2
    call1.flags.onEpochCutover("project_switch:ProjectB");
    await ws.emitMessage({ audio: makePcmFrame(25, 4096) });
    const sess2 = await call1.onRotate();
    const call2 = ctrl.calls[1];

    // Reject the OLD session's in-flight send right as Session 2 opens
    oldSessionSendGate.reject(new Error("Old session closed mid-send"));
    call2.flags.onSessionOpen(call2.sessionId, sess2);

    await waitFor(() =>
      ws.sent.some((m) => m.type === "status" && m.geminiState === "READY" && m.epoch === 2),
    );

    // Replacement session must NOT have received session_failed, and Epoch 2 audio must be intact!
    expect(ws.sent.some((m) => m.type === "status" && m.geminiState === "FAILED")).toBe(false);
    expect(call2.session.receivedAudio.map(decodeMarker)).toEqual([25]);
  });

  it("Invariant: LIVE_TOOLS preserves exact 129 declarations and 129 unique names", () => {
    const decls = LIVE_TOOLS.flatMap((t: any) => t.functionDeclarations || []);
    const names = decls.map((d: any) => d.name);
    const uniqueNames = new Set(names);
    expect(decls.length).toBe(129);
    expect(uniqueNames.size).toBe(129);
  });
});

// ---------------------------------------------------------------------------
// 4. Stage 10.4.2 Closure: Fixed-Size PCM Frame-Boundary Validation
// ---------------------------------------------------------------------------

describe("Stage 10.4.2 Closure: Fixed-Size PCM Frame-Boundary Validation (2,048 samples / 4,096 B)", () => {
  it("accepts ONLY exact 4,096-byte (5,464 canonical Base64 chars ending in '==') PCM frames", () => {
    const validZero = Buffer.alloc(4096, 0x00).toString("base64");
    const validPattern = makePcmFrame(0x5a, 4096);
    expect(validZero.length).toBe(5464);
    expect(validZero.endsWith("==")).toBe(true);

    const r1 = validatePcmBase64Frame(validZero);
    expect(r1).toEqual({ valid: true, pcmByteLength: 4096, charLength: 5464 });

    const r2 = validatePcmBase64Frame(validPattern);
    expect(r2).toEqual({ valid: true, pcmByteLength: 4096, charLength: 5464 });
  });

  it("rejects ALL short frames (both even and odd byte counts < 4,096 B) with INVALID_FORMAT", async () => {
    const shortSizes = [2, 3, 32, 256, 512, 2048, 4094, 4095];
    for (const byteLen of shortSizes) {
      const b64 = Buffer.alloc(byteLen, 0x11).toString("base64");
      const res = validatePcmBase64Frame(b64);
      expect(res.valid).toBe(false);
      if (res.valid === false) {
        expect(res.reason).toBe("INVALID_FORMAT");
      }
    }

    // Verify ConversationManager rejects short even-byte frames with explicit audio_warning and does NOT forward
    const ctrl = createControlledFactory({ autoOpen: true });
    const cm = new ConversationManager(ctrl.factory, { drainInterChunkDelayMs: 1 });
    const ws = createMockClientWs({ deviceId: "dev-short-pcm", sessionId: "sess-short-pcm" });
    await cm.handleConnection(ws);

    const shortEven2048 = Buffer.alloc(2048, 0x22).toString("base64");
    await ws.emitMessage({ audio: shortEven2048 });

    expect(ctrl.calls[0].session.receivedAudio.length).toBe(0);
    expect(
      ws.sent.some((m) => m.type === "audio_warning" && m.reason === "INVALID_FORMAT"),
    ).toBe(true);
  });

  it("rejects ALL oversized frames including 4,097 B / 4,098 B (5,464 chars without '==') and > 5,464 chars with OVERSIZED_FRAME", () => {
    // 4,097 bytes encodes to 5,464 chars ending in '='
    const frame4097 = Buffer.alloc(4097, 0x33).toString("base64");
    expect(frame4097.length).toBe(5464);
    expect(frame4097.endsWith("=")).toBe(true);
    expect(frame4097.endsWith("==")).toBe(false);
    expect(validatePcmBase64Frame(frame4097)).toEqual({ valid: false, reason: "OVERSIZED_FRAME" });

    // 4,098 bytes encodes to 5,464 chars with NO '=' padding
    const frame4098 = Buffer.alloc(4098, 0x33).toString("base64");
    expect(frame4098.length).toBe(5464);
    expect(frame4098.endsWith("=")).toBe(false);
    expect(validatePcmBase64Frame(frame4098)).toEqual({ valid: false, reason: "OVERSIZED_FRAME" });

    // 4,100 bytes encodes to 5,468 chars (> 5,464)
    const frame4100 = Buffer.alloc(4100, 0x33).toString("base64");
    expect(validatePcmBase64Frame(frame4100)).toEqual({ valid: false, reason: "OVERSIZED_FRAME" });
  });

  it("rejects malformed and non-canonical 5,464-char Base64 strings with MALFORMED_PADDING", () => {
    // Non-canonical trailing unused bits on a 5,464-char string ending in '=='
    // Standard 4,096 zero bytes is 'A'.repeat(5462) + '==' -> changing last data char 'A' (000000) to 'B' (000001) sets unused padding bits!
    const nonCanonical5464 = "A".repeat(5461) + "B==";
    expect(nonCanonical5464.length).toBe(5464);
    expect(validatePcmBase64Frame(nonCanonical5464)).toEqual({
      valid: false,
      reason: "MALFORMED_PADDING",
    });

    // Embedded whitespace inside Base64
    const withWhitespace = "A".repeat(5460) + " A==";
    expect(validatePcmBase64Frame(withWhitespace)).toEqual({
      valid: false,
      reason: "MALFORMED_PADDING",
    });
  });
});
