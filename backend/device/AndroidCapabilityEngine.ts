/**
 * MYRAA — AndroidCapabilityEngine
 *
 * Phone-first capability engine for MYRAA Mobile (Android).
 *
 * This engine handles all capabilities that are native to a phone:
 *   - App launcher (open/close apps)
 *   - Browser / Web search / YouTube
 *   - Alarms, Timers, Reminders
 *   - Calendar, Notes, Clipboard
 *   - Media playback
 *   - Notifications
 *   - Device status (battery, WiFi, etc.)
 *
 * WORKS COMPLETELY WITHOUT DESKTOP CONNECTED.
 *
 * This engine does NOT depend on:
 *   - RemoteSessionManager
 *   - Desktop companion
 *   - Any desktop-local capability
 *
 * It runs entirely on phone-local context.
 * Security policy evaluation happens in CapabilityRegistry BEFORE reaching here.
 */

import type {
  ProductCapabilityEngine,
  DeviceExecutionContext,
  DeviceCapabilityResult,
  CapabilityScope,
} from "./DeviceTypes.ts";

// ---------------------------------------------------------------------------
// Android App Alias Table
// (Subset of CapabilityRegistry.APPLICATION_ALIASES, phone-relevant only)
// ---------------------------------------------------------------------------

const ANDROID_APP_PACKAGE_MAP: Readonly<Record<string, string>> = {
  // Google Apps
  "youtube":      "com.google.android.youtube",
  "yt":           "com.google.android.youtube",
  "gmail":        "com.google.android.gm",
  "maps":         "com.google.android.apps.maps",
  "google maps":  "com.google.android.apps.maps",
  "chrome":       "com.android.chrome",
  "browser":      "com.android.chrome",
  "calendar":     "com.google.android.calendar",
  "photos":       "com.google.android.apps.photos",
  "drive":        "com.google.android.apps.docs",
  "meet":         "com.google.android.apps.meetings",
  "keep":         "com.google.android.keep",
  "notes":        "com.google.android.keep",
  // Social / Messaging
  "whatsapp":     "com.whatsapp",
  "telegram":     "org.telegram.messenger",
  "instagram":    "com.instagram.android",
  "facebook":     "com.facebook.katana",
  "twitter":      "com.twitter.android",
  "x":            "com.twitter.android",
  // Productivity
  "spotify":      "com.spotify.music",
  "netflix":      "com.netflix.mediaclient",
  "amazon":       "com.amazon.mShop.android.shopping",
  // System
  "settings":     "com.android.settings",
  "camera":       "com.android.camera2",
  "gallery":      "com.google.android.apps.photos",
  "phone":        "com.android.dialer",
  "contacts":     "com.google.android.contacts",
  "messages":     "com.google.android.apps.messaging",
  "calculator":   "com.google.android.calculator",
  "clock":        "com.google.android.deskclock",
  "alarm":        "com.google.android.deskclock",
  "files":        "com.google.android.documentsui",
};

// ---------------------------------------------------------------------------
// Capabilities supported by Android engine
// ---------------------------------------------------------------------------

const ANDROID_SUPPORTED_CAPABILITIES: ReadonlySet<string> = new Set([
  "mobile.openApp",
  "mobile.closeApp",
  "mobile.alarm",
  "mobile.timer",
  "mobile.reminder",
  "mobile.calendar",
  "mobile.notes",
  "mobile.notifications",
  "mobile.deviceStatus",
  "mobile.camera",
  "mobile.photos",
  "mobile.contacts",
  "mobile.sms",
  "mobile.call",
  "mobile.clipboard",
  // Shared-cloud capabilities also run here when on mobile
  "youtube.search",
  "youtube.play",
  "youtube.pause",
  "youtube.resume",
  "youtube.stop",
  "youtube.next",
  "youtube.previous",
  "youtube.volume",
  "browser.openUrl",
  "browser.search",
  "web.research",
  "ai.chat",
  "ai.summarize",
  "memory.read",
  "memory.write",
]);

// Capability scope map for this engine
const ANDROID_SCOPE_MAP: Readonly<Record<string, CapabilityScope>> = {
  "mobile.openApp":      "mobile-local",
  "mobile.closeApp":     "mobile-local",
  "mobile.alarm":        "mobile-local",
  "mobile.timer":        "mobile-local",
  "mobile.reminder":     "mobile-local",
  "mobile.calendar":     "mobile-local",
  "mobile.notes":        "mobile-local",
  "mobile.notifications":"mobile-local",
  "mobile.deviceStatus": "mobile-local",
  "mobile.camera":       "mobile-local",
  "mobile.photos":       "mobile-local",
  "mobile.contacts":     "mobile-local",
  "mobile.sms":          "mobile-local",
  "mobile.call":         "mobile-local",
  "mobile.clipboard":    "mobile-local",
  "youtube.search":      "shared-cloud",
  "youtube.play":        "shared-cloud",
  "youtube.pause":       "shared-cloud",
  "youtube.resume":      "shared-cloud",
  "youtube.stop":        "shared-cloud",
  "youtube.next":        "shared-cloud",
  "youtube.previous":    "shared-cloud",
  "youtube.volume":      "shared-cloud",
  "browser.openUrl":     "shared-cloud",
  "browser.search":      "shared-cloud",
  "web.research":        "shared-cloud",
  "ai.chat":             "shared-cloud",
  "ai.summarize":        "shared-cloud",
  "memory.read":         "shared-cloud",
  "memory.write":        "shared-cloud",
};

// ---------------------------------------------------------------------------
// AndroidCapabilityEngine
// ---------------------------------------------------------------------------

export class AndroidCapabilityEngine implements ProductCapabilityEngine {
  readonly productType = "MYRAA_MOBILE" as const;

  /**
   * Returns true if this engine can execute the given capability.
   * On the server side, this is a declaration of capability support.
   * On the Android app, this would check installed apps, granted permissions, etc.
   */
  canExecute(capability: string): boolean {
    return ANDROID_SUPPORTED_CAPABILITIES.has(capability);
  }

  getScopeFor(capability: string): CapabilityScope | undefined {
    return ANDROID_SCOPE_MAP[capability];
  }

  async execute(
    capability: string,
    args: Record<string, unknown>,
    _context: DeviceExecutionContext,
  ): Promise<DeviceCapabilityResult> {
    if (!this.canExecute(capability)) {
      return {
        success: false,
        message: `Capability '${capability}' is not supported on MYRAA Mobile.`,
        errorCode: "CAPABILITY_NOT_SUPPORTED",
        bridgeRequired: true,
        bridgeTargetProduct: "MYRAA_DESKTOP",
      };
    }

    // Route to the appropriate handler
    switch (capability) {
      case "mobile.openApp":
        return this._openApp(args);
      case "mobile.alarm":
        return this._setAlarm(args);
      case "mobile.timer":
        return this._setTimer(args);
      case "mobile.reminder":
        return this._setReminder(args);
      case "mobile.calendar":
        return this._calendarAction(args);
      case "mobile.notes":
        return this._notesAction(args);
      case "mobile.deviceStatus":
        return this._getDeviceStatus();
      case "youtube.search":
        return this._youtubeSearch(args);
      case "youtube.play":
        return this._youtubePlay(args);
      case "browser.openUrl":
        return this._browserOpenUrl(args);
      case "browser.search":
        return this._browserSearch(args);
      default:
        return {
          success: true,
          message: `Capability '${capability}' acknowledged by Android engine.`,
          payload: { capability, args, delegated: true },
        };
    }
  }

  // ── Handlers ────────────────────────────────────────────────────────────

  private _openApp(args: Record<string, unknown>): DeviceCapabilityResult {
    const appName = String(args.appName || args.app || "").toLowerCase().trim();
    const packageId = ANDROID_APP_PACKAGE_MAP[appName];

    if (!appName) {
      return {
        success: false,
        message: "App name required. Please specify which app to open.",
        errorCode: "MISSING_ARG_APP_NAME",
      };
    }

    return {
      success: true,
      message: packageId
        ? `Opening ${appName} on your phone.`
        : `Attempting to open '${appName}' on your phone.`,
      payload: {
        action: "OPEN_APP",
        appName,
        packageId: packageId || null,
        // Android app will handle the actual Intent.startActivity()
        intentAction: "android.intent.action.MAIN",
      },
    };
  }

  private _setAlarm(args: Record<string, unknown>): DeviceCapabilityResult {
    const time = String(args.time || args.at || "");
    const label = String(args.label || args.title || "Alarm");

    if (!time) {
      return {
        success: false,
        message: "Please specify the alarm time (e.g. '7:30 AM' or '7 baje').",
        errorCode: "MISSING_ARG_TIME",
      };
    }

    return {
      success: true,
      message: `Alarm set for ${time}: "${label}"`,
      payload: {
        action: "SET_ALARM",
        time,
        label,
        intentAction: "android.intent.action.SET_ALARM",
      },
    };
  }

  private _setTimer(args: Record<string, unknown>): DeviceCapabilityResult {
    const duration = args.duration || args.minutes || args.seconds;
    const label = String(args.label || args.title || "Timer");

    if (!duration) {
      return {
        success: false,
        message: "Please specify the timer duration (e.g. '5 minutes' or '30 seconds').",
        errorCode: "MISSING_ARG_DURATION",
      };
    }

    return {
      success: true,
      message: `Timer set: ${duration} — "${label}"`,
      payload: {
        action: "SET_TIMER",
        duration,
        label,
        intentAction: "android.intent.action.SET_TIMER",
      },
    };
  }

  private _setReminder(args: Record<string, unknown>): DeviceCapabilityResult {
    const text = String(args.text || args.reminder || args.message || "");
    const time = String(args.time || args.at || "");

    if (!text) {
      return {
        success: false,
        message: "Please specify what to remind you about.",
        errorCode: "MISSING_ARG_TEXT",
      };
    }

    return {
      success: true,
      message: time
        ? `Reminder set for ${time}: "${text}"`
        : `Reminder added: "${text}"`,
      payload: {
        action: "SET_REMINDER",
        text,
        time: time || null,
      },
    };
  }

  private _calendarAction(args: Record<string, unknown>): DeviceCapabilityResult {
    const action = String(args.action || "view").toLowerCase();
    return {
      success: true,
      message: action === "view" ? "Opening calendar." : `Calendar: ${action} event.`,
      payload: { action: "CALENDAR_" + action.toUpperCase(), ...args },
    };
  }

  private _notesAction(args: Record<string, unknown>): DeviceCapabilityResult {
    const action = String(args.action || "create").toLowerCase();
    const text = String(args.text || args.content || "");
    return {
      success: true,
      message: action === "create"
        ? text ? `Note saved: "${text.slice(0, 60)}..."` : "Opening notes."
        : `Notes: ${action}`,
      payload: { action: "NOTES_" + action.toUpperCase(), text },
    };
  }

  private _getDeviceStatus(): DeviceCapabilityResult {
    return {
      success: true,
      message: "Fetching device status from your phone.",
      payload: { action: "GET_DEVICE_STATUS" },
    };
  }

  private _youtubeSearch(args: Record<string, unknown>): DeviceCapabilityResult {
    const query = String(args.query || args.q || "");
    if (!query) {
      return {
        success: false,
        message: "Please specify what to search on YouTube.",
        errorCode: "MISSING_ARG_QUERY",
      };
    }
    return {
      success: true,
      message: `Searching YouTube for "${query}"`,
      payload: { action: "YOUTUBE_SEARCH", query },
    };
  }

  private _youtubePlay(args: Record<string, unknown>): DeviceCapabilityResult {
    const videoId = String(args.videoId || args.id || "");
    const action = String(args.action || "play");
    return {
      success: true,
      message: videoId ? `YouTube: ${action} video ${videoId}` : `YouTube: ${action}`,
      payload: { action: "YOUTUBE_PLAY", videoId: videoId || null, playAction: action },
    };
  }

  private _browserOpenUrl(args: Record<string, unknown>): DeviceCapabilityResult {
    const url = String(args.url || args.link || "");
    if (!url) {
      return {
        success: false,
        message: "Please specify the URL to open.",
        errorCode: "MISSING_ARG_URL",
      };
    }
    return {
      success: true,
      message: `Opening ${url} in browser.`,
      payload: { action: "BROWSER_OPEN_URL", url },
    };
  }

  private _browserSearch(args: Record<string, unknown>): DeviceCapabilityResult {
    const query = String(args.query || args.q || "");
    if (!query) {
      return {
        success: false,
        message: "Please specify what to search.",
        errorCode: "MISSING_ARG_QUERY",
      };
    }
    return {
      success: true,
      message: `Searching for "${query}"`,
      payload: { action: "BROWSER_SEARCH", query },
    };
  }

  resetForTesting(): void {
    // No mutable state to reset in this engine
  }
}

export const androidCapabilityEngine = new AndroidCapabilityEngine();
