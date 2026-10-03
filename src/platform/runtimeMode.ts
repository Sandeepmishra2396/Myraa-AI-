/**
 * MYRAA — Centralized Platform Runtime Mode & Configuration
 * Phase 13A-WIN.6
 *
 * Canonical runtime modes:
 *   - DESKTOP_LOCAL: Windows desktop application (Electron shell + local Node backend on 127.0.0.1 + local Python desktop agent on 127.0.0.1:8765)
 *   - CLOUD_WEB: Hosted cloud web deployment (e.g. https://myraa-ai-q0h3.onrender.com)
 *   - ANDROID_STANDALONE: Android mobile application (Jetpack Compose APK/AAB)
 *   - REMOTE_DESKTOP: Remote companion / bridged client controlling a desktop instance
 *
 * Eliminates scattered boolean checks and provides a single canonical source of truth.
 */

export type RuntimeMode =
  | "DESKTOP_LOCAL"
  | "CLOUD_WEB"
  | "ANDROID_STANDALONE"
  | "REMOTE_DESKTOP";

export interface RuntimeSystemStatus {
  runtimeMode: RuntimeMode;
  isDesktop: boolean;
  backend: "LOCAL" | "CLOUD" | "OFFLINE";
  backendUrl: string;
  localBackendPort: number | null;
  desktopAgent: "ONLINE" | "OFFLINE" | "STARTING" | "ERROR";
  desktopAgentUrl: string;
  desktopAgentToolCount?: number;
  desktopAgentVersion?: string;
  gemini: "READY" | "CONNECTING" | "OFFLINE" | "CONFIG_REQUIRED";
  cloudServices: "CONNECTED" | "OFFLINE" | "CONNECTING";
  cloudUrl: string;
  security: "ACTIVE" | "LOCKDOWN" | "EMERGENCY_STOP";
  isOfflineMode: boolean;
}

export const CLOUD_PRODUCTION_URL = "https://myraa-ai-q0h3.onrender.com";
export const DEFAULT_LOCAL_AGENT_URL = "http://127.0.0.1:8765";

/**
 * Detects the active canonical runtime mode from the execution environment.
 */
export function getRuntimeMode(): RuntimeMode {
  if (typeof window === "undefined") {
    // Server-side / Node.js context
    if (
      process.env.MYRAA_LOCAL_DESKTOP === "true" ||
      process.env.SORA_LAUNCHED_BY === "electron"
    ) {
      return "DESKTOP_LOCAL";
    }
    return "CLOUD_WEB";
  }

  // 1. Electron Desktop Shell
  if ((window as any).electronAPI?.isDesktop || (window as any).myraa?.isDesktop) {
    return "DESKTOP_LOCAL";
  }

  // 2. Android Standalone App (WebView bridge or native Android container)
  if (
    (window as any).AndroidBridge ||
    (window as any).myraaAndroid ||
    (typeof navigator !== "undefined" &&
      /MYRAA-Android|Android/i.test(navigator.userAgent) &&
      !(window as any).electronAPI?.isDesktop &&
      !(window as any).myraa?.isDesktop)
  ) {
    // If specifically running inside the standalone Android app wrapper
    if ((window as any).AndroidBridge || (window as any).myraaAndroid || /MYRAA-Android/i.test(navigator.userAgent)) {
      return "ANDROID_STANDALONE";
    }
  }

  // 3. Remote Desktop Session
  if (typeof localStorage !== "undefined") {
    try {
      const sess = localStorage.getItem("sora_remote_session");
      if (sess) {
        const parsed = JSON.parse(sess);
        if (parsed?.token || parsed?.accessToken) {
          // If accessing via cloud web with an active remote paired device session
          const hostname = window.location.hostname;
          if (hostname !== "localhost" && hostname !== "127.0.0.1" && hostname !== "::1") {
            return "REMOTE_DESKTOP";
          }
        }
      }
    } catch {
      /* ignore */
    }
  }

  // 4. Default: Cloud Web deployment
  return "CLOUD_WEB";
}

export function isDesktopLocal(): boolean {
  return getRuntimeMode() === "DESKTOP_LOCAL";
}

export function isCloudWeb(): boolean {
  return getRuntimeMode() === "CLOUD_WEB";
}

export function isAndroidStandalone(): boolean {
  return getRuntimeMode() === "ANDROID_STANDALONE";
}

export function isRemoteDesktop(): boolean {
  return getRuntimeMode() === "REMOTE_DESKTOP";
}

/**
 * Gets the canonical backend base URL for HTTP/API calls.
 * In DESKTOP_LOCAL mode, dynamically discovers the local backend URL passed by Electron.
 */
export function getBackendBaseUrl(): string {
  if (typeof window !== "undefined") {
    const desktopLocalUrl =
      (window as any).electronAPI?.localBackendUrl ||
      (window as any).myraa?.localBackendUrl;
    if (desktopLocalUrl && isDesktopLocal()) {
      return String(desktopLocalUrl).replace(/\/+$/, "");
    }
    return window.location.origin.replace(/\/+$/, "");
  }

  if (process.env.MYRAA_LOCAL_BACKEND_URL) {
    return process.env.MYRAA_LOCAL_BACKEND_URL.replace(/\/+$/, "");
  }

  const port = process.env.PORT || "3000";
  const host = process.env.HOST || "127.0.0.1";
  return `http://${host}:${port}`;
}

/**
 * Gets the canonical desktop agent URL for loopback native OS automation.
 */
export function getDesktopAgentUrl(): string {
  if (typeof window !== "undefined") {
    const agentUrl =
      (window as any).electronAPI?.desktopAgentUrl ||
      (window as any).myraa?.desktopAgentUrl;
    if (agentUrl) return agentUrl;
  }
  return DEFAULT_LOCAL_AGENT_URL;
}

/**
 * Gets the production cloud backend URL.
 */
export function getCloudBackendUrl(): string {
  if (typeof window !== "undefined") {
    const cloudUrl =
      (window as any).electronAPI?.cloudBackendUrl ||
      (window as any).myraa?.cloudBackendUrl;
    if (cloudUrl) return cloudUrl;
  }
  return CLOUD_PRODUCTION_URL;
}
