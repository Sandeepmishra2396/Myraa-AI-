/**
 * MYRAA Platform — DeviceStatusCapability Interface
 * Phase 15
 *
 * Defines the typed contract for querying platform hardware and system status.
 *
 * Desktop implementation: Delegates to Python agent system tools
 *   (systemInfo, gpuInfo, temperatureInfo — existing DESKTOP_TOOLS).
 *   These are routed via ToolOrchestrator → TaskManager.callDesktopAgent().
 *
 * Android implementation (Phase 17): Native Android APIs
 *   - Battery: BatteryManager / registerReceiver(Intent.ACTION_BATTERY_CHANGED)
 *   - Network: ConnectivityManager / WifiManager
 *   - Storage: Environment.getExternalStoragePublicDirectory / StatFs
 *   - Device: Build.MODEL, Build.MANUFACTURER, Build.VERSION.RELEASE
 *
 * NOTE: Desktop system information is queried via the Python agent tools.
 * The AndroidCapabilityAdapter (Phase 17) queries Android APIs directly
 * and does NOT proxy requests to the desktop Python agent.
 */

// ---------------------------------------------------------------------------
// Device Status Types
// ---------------------------------------------------------------------------

export type BatteryState = "charging" | "discharging" | "full" | "not_charging" | "unknown";

export interface BatteryStatus {
  /** Charge level as a percentage (0–100). -1 if unavailable. */
  level: number;
  /** Current charging state. */
  state: BatteryState;
  /** Estimated remaining time in minutes, if available. */
  remainingMinutes?: number;
  /** Whether the device is plugged in (charging from any source). */
  isPluggedIn: boolean;
}

export type NetworkType = "wifi" | "cellular" | "ethernet" | "vpn" | "none" | "unknown";

export interface NetworkStatus {
  /** Type of active network connection. */
  type: NetworkType;
  /** Whether a network connection is available. */
  isConnected: boolean;
  /**
   * Wi-Fi signal strength in dBm (negative; closer to 0 is stronger).
   * Defined only when `type` is "wifi".
   */
  wifiSignalDbm?: number;
  /** SSID of connected Wi-Fi network. May be null on Android 10+ without fine location. */
  wifiSsid?: string;
  /** Local IP address on the current network interface. */
  localIpAddress?: string;
}

export interface StorageInfo {
  /** Total internal storage in bytes. */
  totalBytes: number;
  /** Available (free) internal storage in bytes. */
  availableBytes: number;
  /** Used storage in bytes. */
  usedBytes: number;
}

export interface DeviceInfo {
  /**
   * Platform identifier.
   *   Desktop: "windows" | "macos" | "linux"
   *   Android: "android"
   */
  platform: "windows" | "macos" | "linux" | "android" | "unknown";

  /** Human-readable device model name (e.g., "Pixel 8 Pro", "DESKTOP-ABC123"). */
  modelName: string;

  /** Manufacturer or system vendor (e.g., "Google", "Dell"). */
  manufacturer?: string;

  /** Operating system version string. */
  osVersion: string;

  /** Application version (e.g., "0.15.0"). */
  appVersion: string;
}

// ---------------------------------------------------------------------------
// IDeviceStatus Contract
// ---------------------------------------------------------------------------

/**
 * IDeviceStatus — Platform-independent hardware/system status contract.
 *
 * Desktop (via DesktopCapabilityAdapter):
 *   Maps to existing `systemInfo`, `gpuInfo`, `temperatureInfo` tools.
 *
 * Android (Phase 17):
 *   BatteryManager, ConnectivityManager, WifiManager, StatFs, Build.
 */
export interface IDeviceStatus {
  /**
   * Query current battery status.
   */
  getBatteryStatus(): Promise<BatteryStatus>;

  /**
   * Query current network connection status.
   * Returns the LAN IP address needed for MYRAA Core connection auto-discovery.
   */
  getNetworkStatus(): Promise<NetworkStatus>;

  /**
   * Query internal storage information.
   */
  getStorageInfo(): Promise<StorageInfo>;

  /**
   * Query device hardware and OS information.
   */
  getDeviceInfo(): Promise<DeviceInfo>;
}
