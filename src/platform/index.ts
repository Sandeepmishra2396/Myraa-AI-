/**
 * MYRAA Platform — Top-level Barrel Export
 * Phase 15
 */

// Platform capability interfaces
export type {
  ICaptureAudio,
  IPlaybackAudio,
  IAppLaunch,
  IBrowserAction,
  IAlarm,
  INotification,
  IDeviceStatus,
  IScreenContext,
  IRemoteSession,
  CapturedAudioFrame,
  PlaybackAudioFrame,
  AudioCaptureOptions,
  AudioPlaybackOptions,
  AppDescriptor,
  AppLaunchResult,
  ScrollDirection,
  BrowserNavigateResult,
  BrowserSearchResult,
  BrowserClickResult,
  BrowserScrollResult,
  AlarmRepeat,
  AlarmSpec,
  AlarmRecord,
  AlarmResult,
  NotificationPriority,
  NotificationCategory,
  NotificationAction,
  NotificationSpec,
  BatteryState,
  BatteryStatus,
  NetworkType,
  NetworkStatus,
  StorageInfo,
  DeviceInfo,
  WindowCategory,
  ActiveWindowContext,
  ScreenFrame,
  RemoteSessionState,
  RemoteSessionConfig,
  RemoteToolCallRequest,
  RemoteToolResponse,
  TranscriptEvent,
  CompanionNotificationEvent,
} from "./capabilities/index.ts";

// Desktop capability adapter
export {
  DesktopCapabilityAdapter,
  DesktopCapabilityDelegationError,
} from "./adapters/DesktopCapabilityAdapter.ts";

export type { MyraAudioSessionLike } from "./adapters/DesktopCapabilityAdapter.ts";

// Android wire contract
export type {
  AndroidPairingRequest,
  AndroidPairingResponse,
  AndroidPairingError,
  AndroidOutboundMessage,
  AndroidInboundMessage,
  AndroidAudioUploadFrame,
  AndroidAudioDownloadFrame,
  AndroidToolCallMessage,
  AndroidToolResponse,
  AndroidEmergencyStopMessage,
  AndroidEmergencyStopStateResponse,
  AndroidEmergencyStopRequest,
  AndroidEmergencyStopTriggerResponse,
  AndroidEmergencyStopResetResponse,
  // Phase 21
  AndroidInteractAppArgs,
  AndroidAppInteractionResult,
  // Phase 22
  AndroidMobileContextArgs,
  AndroidMobileContextResult,
  CurrentAppContext,
  ActivityContext,
  NotificationContextItem,
  DeviceStateContext,
  NetworkStateContext,
  BatteryContext,
  ScreenContextData,
  ConversationContextData,
  TaskContextData,
  MobileContextSnapshot,
  // Phase 23
  AndroidMobileScreenArgs,
  MobileScreenAnalysisResult,
  // Phase 24
  AndroidSharedMemoryArgs,
  AndroidSharedMemoryResult,
  // Phase 25
  AndroidHandoffArgs,
  AndroidHandoffResult,
  // Phase 26
  AndroidMobileProactiveArgs,
  AndroidMobileProactiveResult,
  // Phase 27
  AndroidWorkflowExecuteRequest,
  AndroidWorkflowResponse,
  AndroidWorkflowStep,
  AndroidWorkflowConfirmRequest,
  // Phase 28
  AndroidSuspiciousEvent,
  AndroidSecurityStatusResponse,
  AndroidSecurityControlRequest,
  AndroidSecurityControlResult,
  AndroidLostDeviceRequest,
} from "./android/index.ts";

export {
  isAndroidAudioDownloadFrame,
  getAndroidMessageType,
  ANDROID_TOOL_DESCRIPTORS,
  ANDROID_AVAILABLE_TOOLS,
  ANDROID_PARTIAL_TOOLS,
  ANDROID_UNAVAILABLE_TOOLS,
  ANDROID_CLIENT_TOOLS,
  ANDROID_CAPABILITIES,
  BROWSER_CAPABILITIES,
  getAndroidToolDescriptor,
  isToolAvailableOnAndroid,
  // Phase 21
  SUPPORTED_APPS,
  SUPPORTED_APP_IDS,
  resolveAppId,
  getAllowedAppActions,
  // Phase 22
  MOBILE_CONTEXT_CATEGORIES,
  // Phase 23
  MOBILE_SCREEN_MODES,
  // Phase 26
  MOBILE_NOTIFICATION_CATEGORIES,
} from "./android/index.ts";

export type {
  AndroidToolAvailability,
  AndroidToolDescriptor,
  AndroidCapabilityName,
  BrowserCapabilityName,
  // Phase 21
  SupportedAppId,
  // Phase 22
  MobileContextCategory,
  // Phase 23
  MobileScreenMode,
  // Phase 26
  MobileProactiveCategory,
} from "./android/index.ts";

