/**
 * MYRAA Platform Capabilities — Barrel Export
 * Phase 15
 */

export type {
  // AudioCapability
  CapturedAudioFrame,
  PlaybackAudioFrame,
  AudioCaptureOptions,
  AudioPlaybackOptions,
  ICaptureAudio,
  IPlaybackAudio,
} from "./AudioCapability.ts";

export type {
  // AppLaunchCapability
  AppDescriptor,
  AppLaunchResult,
  IAppLaunch,
} from "./AppLaunchCapability.ts";

export type {
  // BrowserCapability
  ScrollDirection,
  BrowserNavigateResult,
  BrowserSearchResult,
  BrowserClickResult,
  BrowserScrollResult,
  IBrowserAction,
} from "./BrowserCapability.ts";

export type {
  // AlarmCapability
  AlarmRepeat,
  AlarmSpec,
  AlarmRecord,
  AlarmResult,
  IAlarm,
} from "./AlarmCapability.ts";

export type {
  // NotificationCapability
  NotificationPriority,
  NotificationCategory,
  NotificationAction,
  NotificationSpec,
  INotification,
} from "./NotificationCapability.ts";

export type {
  // DeviceStatusCapability
  BatteryState,
  BatteryStatus,
  NetworkType,
  NetworkStatus,
  StorageInfo,
  DeviceInfo,
  IDeviceStatus,
} from "./DeviceStatusCapability.ts";

export type {
  // ScreenCapability
  WindowCategory,
  ActiveWindowContext,
  ScreenFrame,
  IScreenContext,
} from "./ScreenCapability.ts";

export type {
  // RemoteSessionCapability
  RemoteSessionState,
  RemoteSessionConfig,
  RemoteToolCallRequest,
  RemoteToolResponse,
  TranscriptEvent,
  CompanionNotificationEvent,
  IRemoteSession,
} from "./RemoteSessionCapability.ts";
