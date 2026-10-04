/**
 * MYRAA — EmergencyStopCoordinator (Phase 7)
 *
 * Fail-safe, idempotent emergency killswitch:
 *   - Halts all executing planner plans immediately
 *   - Aborts in-flight desktop tool calls & child processes
 *   - Pauses all background companion monitors
 *   - Persistent across restarts (remote_emergency_stop.json)
 *   - Blocks any newly submitted plans, tasks, or tools while active
 *   - Broadcasts immediate emergency alerts to all connected clients
 *   - Can only be reset via explicit authorized action
 */

import type { EmergencyStopState } from "./RemoteTypes.ts";
import { remoteStore } from "./RemoteStore.ts";

export type EmergencyBroadcastFn = (payload: unknown) => void;

export class EmergencyStopCoordinator {
  private _state: EmergencyStopState = { active: false };
  private _initialized = false;
  private _broadcastFns = new Set<EmergencyBroadcastFn>();
  private _triggerHooks = new Set<() => void | Promise<void>>();

  async init(): Promise<void> {
    if (this._initialized) return;
    this._initialized = true;
    try {
      this._state = await remoteStore.getEmergencyStopState();
      if (this._state.active) {
        console.warn("[EmergencyStop] WARNING: Server started with EMERGENCY STOP ACTIVE. All work blocked until reset.");
      }
    } catch {
      this._state = { active: false };
    }
  }

  registerBroadcast(fn: EmergencyBroadcastFn): () => void {
    this._broadcastFns.add(fn);
    return () => this._broadcastFns.delete(fn);
  }

  registerTriggerHook(cb: () => void | Promise<void>): () => void {
    this._triggerHooks.add(cb);
    return () => this._triggerHooks.delete(cb);
  }

  private _broadcast(payload: unknown): void {
    for (const fn of this._broadcastFns) {
      try { fn(payload); } catch { /* ignore dropped frames */ }
    }
  }

  isActive(): boolean {
    return this._state.active;
  }

  getState(): EmergencyStopState {
    return { ...this._state };
  }

  /**
   * Trigger the emergency stop killswitch.
   * Idempotent: can be called repeatedly without adverse side effects.
   */
  async trigger(opts: {
    source: "remote_device" | "desktop_ui" | "tool" | "rest_api";
    deviceId?: string;
    deviceName?: string;
    ipAddress?: string;
    reason?: string;
  }): Promise<EmergencyStopState> {
    const now = new Date().toISOString();
    const reason = opts.reason || "Emergency stop triggered by operator.";

    this._state = {
      active: true,
      triggeredAt: this._state.active && this._state.triggeredAt ? this._state.triggeredAt : now,
      triggeredBy: {
        source: opts.source,
        deviceId: opts.deviceId,
        deviceName: opts.deviceName,
        ipAddress: opts.ipAddress,
      },
      reason,
      resetAt: undefined,
      resetBy: undefined,
    };

    console.error(`[EmergencyStop] !!! EMERGENCY STOP TRIGGERED by ${opts.source} (${opts.deviceName || opts.deviceId || opts.ipAddress || "local"}): ${reason} !!!`);

    // 1. Persist state to disk
    await remoteStore.saveEmergencyStopState(this._state);

    // 2. Halt Planner plans (Phase 5)
    try {
      const { plannerCoordinator } = await import("../planner/PlannerCoordinator.ts");
      await plannerCoordinator.emergencyStop();
    } catch (err) {
      console.error("[EmergencyStop] Error halting planner plans:", err);
    }

    // 3. Pause Companion background tasks (Phase 6)
    try {
      const { companionCoordinator } = await import("../companion/CompanionCoordinator.ts");
      await companionCoordinator.emergencyStop();
    } catch (err) {
      console.error("[EmergencyStop] Error pausing companion tasks:", err);
    }

    // 4. Abort desktop agent executions (Phase 2/3/5)
    try {
      const { abortAllDesktopExecutions } = await import("../tasks/TaskManager.ts");
      abortAllDesktopExecutions?.();
    } catch (err) {
      console.error("[EmergencyStop] Error aborting desktop executions:", err);
    }

    // 5. Post high-priority system audit notification
    try {
      const { notificationManager } = await import("../companion/NotificationManager.ts");
      await notificationManager.notify({
        title: "EMERGENCY STOP ACTIVATED",
        message: `Emergency halt triggered by ${opts.deviceName || opts.source}. All running tasks and scripts terminated.`,
        level: "error",
        source: "system",
        dedupKey: `emergency_stop_${now.slice(0, 16)}`,
      });
    } catch (err) {
      console.error("[EmergencyStop] Error posting audit notification:", err);
    }

    // 6. Halt screen perception loop and registered trigger hooks (Phase 8)
    for (const hook of this._triggerHooks) {
      try {
        await hook();
      } catch (err) {
        console.error("[EmergencyStop] Error in trigger hook:", err);
      }
    }

    // 7. Halt AI Study Companion session (Phase 9)
    try {
      const { studySessionManager } = await import("../study/StudySessionManager.ts");
      studySessionManager.emergencyStop();
    } catch (err) {
      console.error("[EmergencyStop] Error halting study session:", err);
    }
    try {
      const { screenContextManager } = await import("../multimodal/ScreenContextManager.ts");
      screenContextManager.emergencyStop();
    } catch (err) {
      console.error("[EmergencyStop] Error halting screen perception:", err);
    }

    // 8. Security audit logging (Phase 10A + Phase 28)
    try {
      const { securityAuditLogger } = await import("../security/SecurityAuditLogger.ts");
      securityAuditLogger.logEvent({
        eventType: "EMERGENCY_STOP_TRIGGERED",
        actor: {
          identityId: opts.deviceId || opts.source,
          role: "admin",
          ipAddress: opts.ipAddress || "127.0.0.1",
          deviceId: opts.deviceId,
        },
        decision: "ALLOW",
        reason: `Emergency stop triggered by ${opts.source}: ${reason}`,
        riskLevel: "CRITICAL",
      });
    } catch (err) {
      console.error("[EmergencyStop] Error posting security audit event:", err);
    }

    // 9. Broadcast to all active clients (desktop & mobile)
    this._broadcast({
      type: "emergency_stop",
      active: true,
      timestamp: now,
      triggeredBy: this._state.triggeredBy,
      reason,
    });

    try {
      const { remoteSessionManager } = await import("./RemoteSessionManager.ts");
      remoteSessionManager.broadcastToAllSessions({
        type: "emergency_stop",
        active: true,
        timestamp: now,
        triggeredBy: this._state.triggeredBy,
        reason,
      });
    } catch {
      /* best-effort */
    }

    return { ...this._state };
  }

  /**
   * Reset the emergency stop state.
   * Can only be triggered by an authorized operator.
   */
  async reset(resetBy = "localhost"): Promise<EmergencyStopState> {
    const now = new Date().toISOString();
    this._state = {
      active: false,
      resetAt: now,
      resetBy,
    };

    console.log(`[EmergencyStop] Emergency stop reset by ${resetBy}. System normal operations resumed.`);
    await remoteStore.saveEmergencyStopState(this._state);

    // Reset study session and companion emergency stop state (Phase 9)
    try {
      const { studySessionManager } = await import("../study/StudySessionManager.ts");
      studySessionManager.resetEmergencyStop();
    } catch (err) {
      console.error("[EmergencyStop] Error resetting study session emergency stop:", err);
    }

    // Broadcast reset event to clients
    this._broadcast({
      type: "emergency_stop",
      active: false,
      timestamp: now,
      resetBy,
    });

    try {
      const { remoteSessionManager } = await import("./RemoteSessionManager.ts");
      remoteSessionManager.broadcastToAllSessions({
        type: "emergency_stop",
        active: false,
        timestamp: now,
        resetBy,
      });
    } catch {
      /* best-effort */
    }

    return { ...this._state };
  }
}

export const emergencyStopCoordinator = new EmergencyStopCoordinator();
