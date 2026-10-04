/**
 * MYRAA Platform — Android Module Barrel Export
 * Phase 15
 */

export type {
  AndroidPairingRequest,
  AndroidPairingResponse,
  AndroidPairingError,
  AndroidAudioUploadFrame,
  AndroidVideoUploadFrame,
  AndroidTextMessage,
  AndroidToolResponse,
  AndroidToolOutput,
  AndroidOutboundMessage,
  AndroidAudioDownloadFrame,
  AndroidStatusMessage,
  AndroidModelTurnMessage,
  AndroidUserTurnMessage,
  AndroidTurnCompleteMessage,
  AndroidInterruptedMessage,
  AndroidToolCallMessage,
  AndroidMemorySyncMessage,
  AndroidCompanionNotificationMessage,
  AndroidEmergencyStopMessage,
  AndroidErrorMessage,
  AndroidInboundMessage,
  AndroidEmergencyStopStateResponse,
  AndroidEmergencyStopRequest,
  AndroidEmergencyStopTriggerResponse,
  AndroidEmergencyStopResetResponse,
  AndroidSessionListResponse,
  AndroidOpenAppArgs,
  AndroidOpenUrlArgs,
  AndroidOpenSettingsArgs,
  AndroidSetAlarmArgs,
  AndroidSetTimerArgs,
  AndroidCreateReminderArgs,
  AndroidCalendarArgs,
  AndroidNotificationsArgs,
  AndroidMediaControlsArgs,
  AndroidClipboardArgs,
  AndroidDeviceStatusArgs,
  AndroidOpenBrowserArgs,
  AndroidSearchWebArgs,
  AndroidFindOnPageArgs,
  AndroidNavigateBackArgs,
  AndroidNavigateForwardArgs,
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
} from "./AndroidContract.ts";

export {
  isAndroidAudioDownloadFrame,
  getAndroidMessageType,
} from "./AndroidContract.ts";

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
} from "./AndroidCapabilityDescriptors.ts";

export {
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
} from "./AndroidCapabilityDescriptors.ts";

