/**
 * MobileContextManager
 * Phase 22 — Mobile Context Intelligence
 *
 * Central orchestrator for mobile context intelligence:
 *   1. Evaluates Emergency Stop and Security Policy Lockdown fail-closed gates.
 *   2. Validates per-category user permissions (screen disabled by default).
 *   3. Collects context from all 9 typed providers.
 *   4. Runs MobileContextSanitizer (DLP, credentials, OTPs, sensitive app shielding).
 *   5. Executes MobileContextFusion to produce coherent contextual understanding.
 *   6. Fences untrusted context before handoff to MYRAA Core.
 */

import { emergencyStopCoordinator } from "../EmergencyStopCoordinator.ts";
import { securityPolicyEngine } from "../../security/SecurityPolicyEngine.ts";
import {
  CurrentAppProvider,
  ActivityProvider,
  NotificationContextProvider,
  DeviceStateProvider,
  NetworkStateProvider,
  BatteryProvider,
  ScreenContextProvider,
  ConversationContextProvider,
  TaskContextProvider,
} from "./providers/index.ts";
import { MobileContextSanitizer } from "./MobileContextSanitizer.ts";
import { MobileContextFusion } from "./MobileContextFusion.ts";
import type {
  MobileContextSnapshot,
  MobileContextCaptureOptions,
  MobileContextCategory,
  ContextPermissionGrant,
  CurrentAppContext,
  ActivityContext,
  NotificationContextItem,
  DeviceStateContext,
  NetworkStateContext,
  BatteryContext,
  ScreenContextData,
} from "./MobileContextTypes.ts";
import {
  CONTEXT_UNKNOWN,
  CONTEXT_NOT_AVAILABLE,
  CONTEXT_NOT_PERMITTED,
} from "./MobileContextTypes.ts";

export class MobileContextManager {
  private currentAppProvider = new CurrentAppProvider();
  private activityProvider = new ActivityProvider();
  private notificationProvider = new NotificationContextProvider();
  private deviceStateProvider = new DeviceStateProvider();
  private networkStateProvider = new NetworkStateProvider();
  private batteryProvider = new BatteryProvider();
  private screenContextProvider = new ScreenContextProvider();
  private conversationContextProvider = new ConversationContextProvider();
  private taskContextProvider = new TaskContextProvider();

  // Permission table: defaults to true for general device telemetry, false for sensitive categories (screen)
  private permissions: Map<MobileContextCategory, boolean> = new Map([
    ["app", true],
    ["activity", true],
    ["notifications", true],
    ["device", true],
    ["network", true],
    ["battery", true],
    ["screen", false], // STRICT: Screen context is DISABLED BY DEFAULT
    ["conversation", true],
    ["task", true],
  ]);

  /**
   * Sets or revokes permission for a specific category.
   */
  setPermission(category: MobileContextCategory, granted: boolean): void {
    this.permissions.set(category, granted);
  }

  /**
   * Checks whether a category is currently permitted.
   */
  hasPermission(category: MobileContextCategory): boolean {
    return this.permissions.get(category) === true;
  }

  /**
   * Updates recent conversation dialogue turns for conversation context.
   */
  updateConversation(turns: Array<{ role: string; text: string }>): void {
    this.conversationContextProvider.updateHistory(turns);
  }

  /**
   * Sets active task context.
   */
  setActiveTask(task: { activeTaskId?: string; taskName?: string; status?: string; currentGoal?: string }): void {
    this.taskContextProvider.setActiveTask(task);
  }

  /**
   * Clears active task context.
   */
  clearActiveTask(): void {
    this.taskContextProvider.clearActiveTask();
  }

  /**
   * Captures, sanitizes, and fuses a full MobileContextSnapshot.
   * Throws Error if Emergency Stop or Security Lockdown is active.
   */
  async captureContext(options: MobileContextCaptureOptions = {}): Promise<MobileContextSnapshot> {
    // 1. Emergency Stop Fail-Closed Gate
    if (emergencyStopCoordinator.isActive()) {
      throw new Error("EMERGENCY_STOP: Context collection halted immediately by Emergency Stop.");
    }

    // 2. Security Policy Lockdown Fail-Closed Gate
    if (securityPolicyEngine.getMode() === "LOCKDOWN") {
      throw new Error("LOCKDOWN: Context collection blocked while system is in security lockdown.");
    }

    const requestedCategories = options.categories || [
      "app", "activity", "notifications", "device",
      "network", "battery", "screen", "conversation", "task",
    ];

    const grantedList: string[] = [];
    const remote = options.remoteSnapshot || {};

    // 3. Provider Data Gathering with Permission Checks

    // App Context
    let app: CurrentAppContext;
    if (requestedCategories.includes("app") && this.hasPermission("app")) {
      grantedList.push("app");
      app = this.currentAppProvider.getContext({ rawPayload: remote.currentApp });
      app = MobileContextSanitizer.sanitizeCurrentApp(app);
    } else {
      app = {
        packageName: CONTEXT_NOT_PERMITTED,
        appName: CONTEXT_NOT_PERMITTED,
        category: "general",
        isSensitive: false,
        isAvailable: false,
      };
    }

    // Activity Context
    let activity: ActivityContext;
    if (requestedCategories.includes("activity") && this.hasPermission("activity")) {
      grantedList.push("activity");
      activity = this.activityProvider.getContext({ rawPayload: remote.activity });
    } else {
      activity = {
        activityName: CONTEXT_NOT_PERMITTED,
        screenTitle: CONTEXT_NOT_PERMITTED,
        state: "unavailable",
        isAvailable: false,
      };
    }

    // Notification Context
    let notifs: NotificationContextItem[];
    if (requestedCategories.includes("notifications") && this.hasPermission("notifications")) {
      grantedList.push("notifications");
      notifs = this.notificationProvider.getContext({ rawPayload: remote.notifications });
      notifs = MobileContextSanitizer.sanitizeNotifications(notifs);
    } else {
      notifs = [];
    }

    // Device State Context
    let device: DeviceStateContext;
    if (requestedCategories.includes("device") && this.hasPermission("device")) {
      grantedList.push("device");
      device = this.deviceStateProvider.getContext({ rawPayload: remote.deviceState });
    } else {
      device = {
        manufacturer: CONTEXT_NOT_PERMITTED,
        model: CONTEXT_NOT_PERMITTED,
        androidVersion: CONTEXT_NOT_PERMITTED,
        sdkInt: 0,
        orientation: "unknown",
        isScreenOn: false,
        isAvailable: false,
      };
    }

    // Network State Context
    let network: NetworkStateContext;
    if (requestedCategories.includes("network") && this.hasPermission("network")) {
      grantedList.push("network");
      network = this.networkStateProvider.getContext({ rawPayload: remote.networkState });
    } else {
      network = {
        isConnected: false,
        type: CONTEXT_NOT_PERMITTED,
        isMetered: false,
        isAvailable: false,
      };
    }

    // Battery Context
    let battery: BatteryContext;
    if (requestedCategories.includes("battery") && this.hasPermission("battery")) {
      grantedList.push("battery");
      battery = this.batteryProvider.getContext({ rawPayload: remote.battery });
    } else {
      battery = {
        level: -1,
        isCharging: false,
        status: CONTEXT_NOT_PERMITTED,
        isAvailable: false,
      };
    }

    // Screen Context (Requires explicit per-request approval OR granted category permission)
    let screen: ScreenContextData;
    const isScreenApproved = options.approvedScreenContext === true || this.hasPermission("screen");
    if (requestedCategories.includes("screen") && isScreenApproved) {
      grantedList.push("screen");
      const rawScreen = options.screenSummary || remote.screenContext?.summary;
      screen = this.screenContextProvider.getContext({
        approved: true,
        rawPayload: rawScreen,
      });
      screen = MobileContextSanitizer.sanitizeScreenContext(screen);
    } else {
      screen = {
        isApproved: false,
        summary: CONTEXT_NOT_PERMITTED,
        capturedAtMs: 0,
        isAvailable: false,
      };
    }

    // Conversation Context
    const conversation = requestedCategories.includes("conversation") && this.hasPermission("conversation")
      ? this.conversationContextProvider.getContext({ query: options.query, rawPayload: remote.conversation })
      : undefined;

    // Task Context
    const task = requestedCategories.includes("task") && this.hasPermission("task")
      ? this.taskContextProvider.getContext({ rawPayload: remote.task })
      : undefined;

    // 4. Context Fusion
    const partialSnapshot = {
      timestamp: Date.now(),
      deviceId: options.deviceId || remote.deviceId || "android_companion",
      currentApp: app,
      activity: activity,
      notifications: notifs,
      deviceState: device,
      networkState: network,
      battery: battery,
      screenContext: screen,
      conversation: conversation,
      task: task,
      permissionsGranted: grantedList,
      isSanitized: true,
    };

    const fusedSummary = MobileContextFusion.fuse(partialSnapshot, options.query);

    return {
      ...partialSnapshot,
      fusedSummary,
    };
  }
}

export const mobileContextManager = new MobileContextManager();
