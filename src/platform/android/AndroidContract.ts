/**
 * MYRAA Platform — Android ↔ MYRAA Core Communication Contract
 * Phase 15
 *
 * Formally typed wire protocol for Android client ↔ MYRAA Desktop Core.
 *
 * TRANSPORT LAYER
 * ═══════════════════════════════════════════════════════════════════════════
 * Protocol  : WebSocket (OkHttp3 on Android, `ws` package on server)
 * Endpoint  : ws(s)://<desktop-ip>:3000/remote-live
 * Auth      : Sec-WebSocket-Protocol: myraa-auth, <bearer-token>
 *   OR        Query param: ?token=<bearer-token>
 * Max frame : 256 KB (MAX_REMOTE_MESSAGE_SIZE in RemoteTypes.ts)
 * Max audio : 64 KB per PCM chunk (MAX_AUDIO_FRAME_SIZE in RemoteTypes.ts)
 * Heartbeat : Android sends ping; 60s timeout (REMOTE_SESSION_HEARTBEAT_TIMEOUT_MS)
 *
 * PAIRING FLOW
 * ═══════════════════════════════════════════════════════════════════════════
 * 1. User generates PIN on desktop (POST /api/remote/pair-code, localhost only)
 * 2. Android sends AndroidPairingRequest to POST /api/remote/pair
 * 3. Desktop validates PIN → issues HMAC-SHA256 signed bearer token
 * 4. Android stores token in Keystore-backed EncryptedSharedPreferences
 * 5. Android connects WebSocket with token in Sec-WebSocket-Protocol header
 * 6. All subsequent tool executions go through Phase 10A–10F SecurityPolicyEngine
 *
 * All types here are PURE TYPE DECLARATIONS — no runtime code, no imports with
 * side effects. Safe to import from both TypeScript and Android code via
 * JSON schema generation.
 */

// ---------------------------------------------------------------------------
// Pairing Protocol
// ---------------------------------------------------------------------------

/**
 * Android → Desktop: Request device pairing using a 6-char PIN.
 * Sent to POST /api/remote/pair
 */
export interface AndroidPairingRequest {
  /** The 6-character uppercase alphanumeric PIN generated on the desktop. */
  code: string;

  /** Friendly device name shown in the desktop device management UI. */
  deviceName: string;

  /**
   * Device type for desktop display categorization.
   * MUST be "mobile" or "tablet" for Android devices.
   */
  deviceType: "mobile" | "tablet";

  /**
   * Android device metadata for audit logging.
   * All fields are informational only — no security decisions are made on them.
   */
  deviceMeta: {
    /** Android Build.MODEL (e.g., "Pixel 8 Pro"). */
    model: string;
    /** Android Build.VERSION.RELEASE (e.g., "14"). */
    androidVersion: string;
    /** App version (e.g., "0.15.0"). */
    appVersion: string;
  };
}

/**
 * Desktop → Android: Response to pairing request.
 * Returned from POST /api/remote/pair
 */
export interface AndroidPairingResponse {
  success: true;

  /**
   * HMAC-SHA256 signed bearer token.
   * Format: sora_dev_<base64url(deviceId.ts.nonce)>.<hmac>
   * Store in Android Keystore-backed EncryptedSharedPreferences.
   * NEVER log or expose this token.
   */
  token: string;

  /** Assigned device role. Determines permitted operations. */
  deviceRole: "read_only" | "standard" | "admin";

  /** Server-assigned device UUID. Used for revocation tracking. */
  deviceId: string;

  /** ISO timestamp when the session expires (if applicable). */
  expiresAt?: string;

  /** Short-lived IdentityAuthManager access token (15m TTL). */
  accessToken?: string;

  /** Rotating refresh token with strict replay detection. */
  refreshToken?: string;

  /** Access token validity in seconds. */
  expiresInSeconds?: number;
}

export interface AndroidPairingError {
  success: false;
  error: "INVALID_CODE" | "CODE_EXPIRED" | "CODE_CONSUMED" | "RATE_LIMITED" | "SERVER_ERROR";
  /** Human-readable error message. */
  message: string;
  /** Retry-after seconds (only for RATE_LIMITED). */
  retryAfterSeconds?: number;
}

// ---------------------------------------------------------------------------
// Outbound Message Types (Android → MYRAA Core)
// ---------------------------------------------------------------------------

/**
 * Audio frame: Microphone PCM16 at 16,000 Hz.
 * Sent as bare JSON (no "type" field — matches existing protocol).
 * Max frame size: MAX_AUDIO_FRAME_SIZE (64 KB) per chunk.
 */
export interface AndroidAudioUploadFrame {
  /** Base64-encoded PCM16 LE, 16,000 Hz, mono. */
  audio: string;
}

/**
 * Video/screen frame for multimodal context.
 * Sent when Android camera streaming or screen sharing is active (Phase 18).
 * Max frame size: MAX_REMOTE_MESSAGE_SIZE (256 KB).
 */
export interface AndroidVideoUploadFrame {
  type: "video";
  /** Base64-encoded JPEG image. */
  video: string;
}

/**
 * Text message from the Android user.
 * Injected into the Gemini Live session as a user turn.
 */
export interface AndroidTextMessage {
  type: "text";
  text: string;
}

/**
 * Tool response: Result of executing a client-side tool on Android.
 * Sent after the Android app executes a tool requested by MYRAA Core.
 * Currently applicable tools for Android: listed in AndroidCapabilityDescriptors.ts
 */
export interface AndroidToolResponse {
  type: "toolResponse";
  /** Correlates with the callId in the received AndroidToolCallMessage. */
  id: string;
  /** Tool name (must match the name in the toolCall request). */
  name: string;
  /** Execution result or error description. */
  output: AndroidToolOutput;
}

export interface AndroidToolOutput {
  success: boolean;
  result?: unknown;
  error?: string;
}

/**
 * Union of all frames Android can send to MYRAA Core.
 */
export type AndroidOutboundMessage =
  | AndroidAudioUploadFrame
  | AndroidVideoUploadFrame
  | AndroidTextMessage
  | AndroidToolResponse;

// ---------------------------------------------------------------------------
// Inbound Message Types (MYRAA Core → Android)
// ---------------------------------------------------------------------------

/**
 * TTS audio frame: Gemini Live speech output at 24,000 Hz.
 * Received as bare JSON (no "type" field — matches existing protocol).
 * Android must decode base64 → PCM16 and write to AudioTrack.
 */
export interface AndroidAudioDownloadFrame {
  /** Base64-encoded PCM16 LE, 24,000 Hz, mono. */
  audio: string;
}

/** Session connection status update. */
export interface AndroidStatusMessage {
  type: "status";
  status: "connecting" | "connected" | "disconnected" | "authenticated" | "error";
  message?: string;
}

/** Model (AI) turn transcript text. */
export interface AndroidModelTurnMessage {
  type: "modelTurn";
  text: string;
  /** True when this is the final text for this turn (not a streaming partial). */
  isFinal?: boolean;
}

/** User turn transcript text (echo of user's speech). */
export interface AndroidUserTurnMessage {
  type: "userTurn";
  text: string;
}

/** Signals that the current conversational turn has completed. */
export interface AndroidTurnCompleteMessage {
  type: "turnComplete";
}

/** Signals that the model's output was interrupted (user started speaking). */
export interface AndroidInterruptedMessage {
  type: "interrupted";
}

/**
 * Tool call request: MYRAA Core asks Android to execute a client-side tool.
 * Android MUST call sendToolResponse() with the result.
 * Only tools listed in AndroidCapabilityDescriptors.ANDROID_CLIENT_TOOLS apply.
 */
export interface AndroidToolCallMessage {
  type: "toolCall";
  /** Correlation ID for the tool response. */
  callId?: string;
  /** Tool name from the MYRAA 126-tool registry. */
  name: string;
  /** Tool arguments from Gemini Live function call. */
  args: Record<string, unknown>;
}

/** Memory synchronization update. */
export interface AndroidMemorySyncMessage {
  type: "memory_sync";
  memories: Array<{
    id: string;
    category: string;
    content: string;
    createdAt: string;
  }>;
}

/**
 * Companion notification event.
 * Android should post a system notification using INotification.post().
 */
export interface AndroidCompanionNotificationMessage {
  type: "companion_notification";
  notification: {
    id?: string;
    title?: string;
    message?: string;
    action?: string;
    [key: string]: unknown;
  };
}

/**
 * Emergency Stop state change event.
 * Android MUST immediately:
 *   1. Post a max-priority ongoing notification.
 *   2. Stop all active audio streaming.
 *   3. Update the UI to show Emergency Stop active state.
 */
export interface AndroidEmergencyStopMessage {
  type: "emergency_stop";
  state: {
    active: boolean;
    triggeredAt?: string;
    triggeredBy?: {
      source: "remote_device" | "desktop_ui" | "tool" | "rest_api";
      deviceId?: string;
      deviceName?: string;
    };
    reason?: string;
    resetAt?: string;
  };
}

/** Error message from the server. */
export interface AndroidErrorMessage {
  type: "error";
  error: string;
  code?: string;
}

/**
 * Union of all frames MYRAA Core sends to Android.
 */
export type AndroidInboundMessage =
  | AndroidAudioDownloadFrame
  | AndroidStatusMessage
  | AndroidModelTurnMessage
  | AndroidUserTurnMessage
  | AndroidTurnCompleteMessage
  | AndroidInterruptedMessage
  | AndroidToolCallMessage
  | AndroidMemorySyncMessage
  | AndroidCompanionNotificationMessage
  | AndroidEmergencyStopMessage
  | AndroidErrorMessage;

// ---------------------------------------------------------------------------
// REST API Request/Response Types
// ---------------------------------------------------------------------------

/** GET /api/remote/emergency-stop */
export interface AndroidEmergencyStopStateResponse {
  active: boolean;
  triggeredAt?: string;
  triggeredBy?: {
    source: "remote_device" | "desktop_ui" | "tool" | "rest_api";
    deviceId?: string;
    deviceName?: string;
    ipAddress?: string;
  };
  reason?: string;
  resetAt?: string;
  resetBy?: string;
}

/** POST /api/remote/emergency-stop → request body */
export interface AndroidEmergencyStopRequest {
  reason?: string;
}

/** POST /api/remote/emergency-stop → response */
export interface AndroidEmergencyStopTriggerResponse {
  success: boolean;
  state?: AndroidEmergencyStopStateResponse;
}

/** POST /api/remote/emergency-stop/reset → response */
export interface AndroidEmergencyStopResetResponse {
  success: boolean;
  reason?: string;
}

/** GET /api/remote/sessions → active session list */
export interface AndroidSessionListResponse {
  sessions: Array<{
    sessionId: string;
    deviceId: string;
    deviceName: string;
    role: "read_only" | "standard" | "admin";
    connectedAt: string;
    lastHeartbeatAt: string;
    authenticated: boolean;
  }>;
}

/** POST /api/remote/token/refresh → request body */
export interface AndroidTokenRefreshRequest {
  refreshToken: string;
}

/** POST /api/remote/token/refresh → response */
export interface AndroidTokenRefreshResponse {
  success: true;
  accessToken: string;
  refreshToken: string;
  expiresInSeconds: number;
  tokenType: string;
}

/** POST /api/remote/token/refresh → error */
export interface AndroidTokenRefreshError {
  success: false;
  error: string;
}

/** POST /api/remote/revoke → request body */
export interface AndroidDeviceRevokeRequest {
  deviceId: string;
  reason?: string;
}

/** POST /api/remote/revoke → response */
export interface AndroidDeviceRevokeResponse {
  success: boolean;
  message: string;
}

/** Inbound security violation event from server */
export interface AndroidSecurityViolationEvent {
  type: "security_violation";
  code: string;
  message: string;
  timestamp?: string;
}

// ---------------------------------------------------------------------------
// Phase 19 — Android Native Capability Contracts
// ---------------------------------------------------------------------------

export interface AndroidOpenAppArgs {
  appName?: string;
  packageName?: string;
}

export interface AndroidOpenUrlArgs {
  url: string;
}

export interface AndroidOpenSettingsArgs {
  settingType?: string;
}

export interface AndroidSetAlarmArgs {
  hour: number;
  minutes: number;
  message?: string;
  skipUi?: boolean;
}

export interface AndroidSetTimerArgs {
  lengthSeconds: number;
  message?: string;
  skipUi?: boolean;
}

export interface AndroidCreateReminderArgs {
  title: string;
  notes?: string;
  timeMs?: number;
}

export interface AndroidCalendarArgs {
  action?: "view" | "insert";
  title?: string;
  startTimeMs?: number;
  endTimeMs?: number;
  description?: string;
}

export interface AndroidNotificationsArgs {
  action?: "post" | "cancel";
  title?: string;
  message?: string;
  notificationId?: number;
}

export interface AndroidMediaControlsArgs {
  action:
    | "play"
    | "pause"
    | "play_pause"
    | "next"
    | "previous"
    | "volume_up"
    | "volume_down"
    | "set_volume"
    | "mute";
  volumeLevel?: number;
}

export interface AndroidClipboardArgs {
  action: "get" | "set" | "clear";
  text?: string;
}

export interface AndroidDeviceStatusArgs {
  category?: "all" | "battery" | "network" | "storage" | "device";
}

// ---------------------------------------------------------------------------
// Phase 20 — Android Browser Assistant Contracts
// ---------------------------------------------------------------------------

export interface AndroidOpenBrowserArgs {
  browserName?: string;
  url?: string;
}

export interface AndroidSearchWebArgs {
  query: string;
  engine?: "google" | "duckduckgo" | "bing" | "youtube" | "ecosia";
}

export interface AndroidFindOnPageArgs {
  query: string;
}

export interface AndroidNavigateBackArgs {
  steps?: number;
}

export interface AndroidNavigateForwardArgs {
  steps?: number;
}

// ---------------------------------------------------------------------------
// Phase 21 — Mobile App Interaction Layer Contracts
// ---------------------------------------------------------------------------

/**
 * Arguments for the interactApp capability.
 * Sent from MYRAA Core to Android client via toolCall.
 */
export interface AndroidInteractAppArgs {
  /** Canonical or alias app name (e.g. "gmail", "google maps", "yt"). */
  app: string;
  /** Action to perform (e.g. "launch", "compose", "search", "directions", "watch", "insert_event"). */
  action?: string;
  /** Search query (Maps search, YouTube search). */
  query?: string;
  /** Email recipient for Gmail compose. */
  recipient?: string;
  /** Email subject for Gmail compose. */
  subject?: string;
  /** Email body / message body text. */
  body?: string;
  /** Navigation/directions destination for Google Maps. */
  destination?: string;
  /** Navigation transport mode for Google Maps: "d" (driving), "w" (walking), "b" (biking). */
  mode?: string;
  /** YouTube video ID for watch action. */
  videoId?: string;
  /** Event title for Calendar insert_event. */
  title?: string;
  /** Event description for Calendar insert_event. */
  description?: string;
  /** Event start timestamp (ms since epoch) for Calendar insert_event. */
  startTimeMs?: number;
  /** Event end timestamp (ms since epoch) for Calendar insert_event. */
  endTimeMs?: number;
  /** Phone number for WhatsApp compose_message (E.164 or local with country code). */
  phone?: string;
  /** Message text for WhatsApp compose_message. */
  text?: string;
}

/**
 * Result returned by the Android client after executing an interactApp call.
 * Sent via toolResponse back to MYRAA Core.
 */
export interface AndroidAppInteractionResult {
  success: boolean;
  app: string;
  action: string;
  interactionType: "INTENT" | "DEEP_LINK" | "OFFICIAL_API";
  /** The URI or Intent action used for the interaction. */
  uriOrIntent?: string;
  /** Action-specific result payload. */
  result?: Record<string, unknown>;
  /** Human-readable error message (only when success = false). */
  error?: string;
  /**
   * Structured error code (only when success = false).
   * - "NOT_SUPPORTED": Action is not supported on Android via official mechanisms.
   * - "APP_NOT_INSTALLED": Target app is not installed on this device.
   * - "ARGUMENT_VIOLATION": Required argument missing or invalid.
   * - "SECURITY_VIOLATION": Argument contains credentials or is blocked.
   * - "EXECUTION_ERROR": Intent launch or system-level failure.
   */
  errorCode?: "NOT_SUPPORTED" | "APP_NOT_INSTALLED" | "ARGUMENT_VIOLATION" | "SECURITY_VIOLATION" | "EXECUTION_ERROR";
}

// ---------------------------------------------------------------------------
// Phase 22 — Mobile Context Intelligence Contracts
// ---------------------------------------------------------------------------

export interface AndroidMobileContextArgs {
  /** Optional subset of categories to retrieve. If omitted, all permissioned categories are returned. */
  categories?: string[];
  /** Explicit approval flag for screen context. Must be true for screen data to be gathered. */
  approvedScreenContext?: boolean;
  /** Optional text content from user-approved screen OCR/perception. */
  screenSummary?: string;
  /** Optional user prompt/query driving the context request (e.g. "Ye kya hai?"). */
  query?: string;
}

export interface CurrentAppContext {
  packageName: string;
  appName: string;
  category: string;
  isSensitive: boolean;
  isAvailable: boolean;
}

export interface ActivityContext {
  activityName: string;
  screenTitle: string;
  state: string;
  isAvailable: boolean;
}

export interface NotificationContextItem {
  id: string;
  packageName: string;
  appName: string;
  category: string;
  title: string;
  sanitizedSnippet: string;
  postTimeMs: number;
  priority: string;
}

export interface DeviceStateContext {
  manufacturer: string;
  model: string;
  androidVersion: string;
  sdkInt: number;
  orientation: string;
  isScreenOn: boolean;
  isAvailable: boolean;
}

export interface NetworkStateContext {
  isConnected: boolean;
  type: string;
  isMetered: boolean;
  wifiSsid?: string;
  isAvailable: boolean;
}

export interface BatteryContext {
  level: number;
  isCharging: boolean;
  status: string;
  isAvailable: boolean;
}

export interface ScreenContextData {
  isApproved: boolean;
  summary?: string;
  capturedAtMs: number;
  isAvailable: boolean;
}

export interface ConversationContextData {
  recentTurns?: Array<{ role: string; text: string }>;
  activeIntent?: string;
  lastUserMessage?: string;
}

export interface TaskContextData {
  activeTaskId?: string;
  taskName?: string;
  status?: string;
  currentGoal?: string;
}

export interface MobileContextSnapshot {
  timestamp: number;
  deviceId: string;
  currentApp: CurrentAppContext;
  activity: ActivityContext;
  notifications: NotificationContextItem[];
  deviceState: DeviceStateContext;
  networkState: NetworkStateContext;
  battery: BatteryContext;
  screenContext: ScreenContextData;
  conversation?: ConversationContextData;
  task?: TaskContextData;
  permissionsGranted: string[];
  fusedSummary: string;
  isSanitized: boolean;
}

export interface AndroidMobileContextResult {
  success: boolean;
  snapshot?: MobileContextSnapshot;
  error?: string;
  errorCode?: "PERMISSION_DENIED" | "SECURITY_VIOLATION" | "EMERGENCY_STOP" | "LOCKDOWN" | "NOT_AVAILABLE";
}

// ---------------------------------------------------------------------------
// Phase 23 — Mobile Screen Understanding Contracts
// ---------------------------------------------------------------------------

export interface AndroidMobileScreenArgs {
  /** Explicit approval flag from user. Screen understanding fails closed if false. */
  approved: boolean;
  /** Analysis mode: "ocr" | "visual" | "full". Defaults to "ocr". */
  captureMode?: "ocr" | "visual" | "full";
  /** Volatile in-memory base64 encoded screen image (never persisted to disk). */
  rawScreenBase64?: string;
  /** Extracted or perceived screen summary text. */
  screenSummary?: string;
  /** Active user prompt or deictic question (e.g. "Ye kya hai?"). */
  query?: string;
}

export interface MobileScreenAnalysisResult {
  success: boolean;
  isApproved: boolean;
  isShielded: boolean;
  shieldReason?: string;
  ocrSummary?: string;
  visualSummary?: string;
  fusedContext?: string;
  timestamp?: number;
  error?: string;
  errorCode?: "NOT_PERMITTED" | "SENSITIVE_SCREEN_SHIELDED" | "EMERGENCY_STOP" | "LOCKDOWN" | "EXECUTION_ERROR";
}

// ---------------------------------------------------------------------------
// Phase 24 — Shared MYRAA Memory Contracts
// ---------------------------------------------------------------------------

export interface AndroidSharedMemoryArgs {
  action: "get" | "create" | "update" | "delete" | "search" | "sync";
  id?: string;
  category?: string;
  text?: string;
  key?: string;
  importance?: "low" | "medium" | "high";
  confidence?: "low" | "medium" | "high";
  query?: string;
  clientMutationId?: string;
  clientVersion?: number;
  timestamp?: string;
  mutations?: any[];
}

export interface AndroidSharedMemoryResult {
  success: boolean;
  action: string;
  memory?: any;
  memories?: any[];
  appliedCount?: number;
  conflictsResolved?: number;
  error?: string;
}

// ---------------------------------------------------------------------------
// Phase 25 — Cross-Device Handoff Contracts
// ---------------------------------------------------------------------------

export interface AndroidHandoffArgs {
  action: "create" | "list" | "get" | "accept" | "resume" | "cancel";
  handoffId?: string;
  handoffToken?: string;
  targetDeviceId?: string;
  conversationContext?: Record<string, unknown>;
  taskPlanState?: Record<string, unknown>;
  projectContext?: Record<string, unknown>;
  sharedMemoryRefs?: string[];
  safeUiContext?: Record<string, unknown>;
  confirmResume?: boolean;
}

export interface AndroidHandoffResult {
  success: boolean;
  action: string;
  handoff?: any;
  handoffs?: any[];
  requiresConfirmation?: boolean;
  gatedActions?: any[];
  error?: string;
  errorCode?: string;
}

// ---------------------------------------------------------------------------
// Phase 26 — Mobile Proactive Companion Contracts
// ---------------------------------------------------------------------------

export interface AndroidMobileProactiveArgs {
  action: "subscribe" | "unsubscribe" | "getPreferences" | "updatePreferences" | "drainPending" | "clear" | "post" | "test";
  title?: string;
  message?: string;
  category?: "TASK" | "REMINDER" | "PROJECT" | "LONG_RUNNING_TASK" | "SECURITY" | "CONNECTION";
  priority?: "LOW" | "DEFAULT" | "HIGH" | "URGENT";
  metadata?: Record<string, unknown>;
  actionUrl?: string;
  voiceText?: string;
  preferences?: Record<string, unknown>;
}

export interface AndroidMobileProactiveResult {
  success: boolean;
  action: string;
  delivered?: boolean;
  queued?: boolean;
  preferences?: any;
  notifications?: any[];
  count?: number;
  suppressedReason?: string;
  error?: string;
  errorCode?: string;
}

// ---------------------------------------------------------------------------
// Phase 27 — Mobile Autonomous Workflow Contracts
// ---------------------------------------------------------------------------

export interface AndroidWorkflowExecuteRequest {
  query: string;
  deviceId?: string;
  autoExecute?: boolean;
  preferredLanguage?: "hi" | "en" | "hinglish";
  clientContext?: {
    currentApp?: string;
    screenSummary?: string;
    timeZone?: string;
    currentTimeMs?: number;
  };
}

export interface AndroidWorkflowStep {
  id: string;
  description: string;
  toolName: string;
  phase: string;
  status: string;
  isDestructive: boolean;
  checkpointRequired: boolean;
  result?: unknown;
  error?: string;
}

export interface AndroidWorkflowResponse {
  success: boolean;
  planId: string;
  goal: string;
  category: string;
  status: string;
  steps: AndroidWorkflowStep[];
  voiceResponse: string;
  textResponse: string;
  requiresConfirmation: boolean;
  pendingCheckpoint?: {
    checkpointId: string;
    action: string;
    impactLevel: string;
    expiresAt: string;
    stepId: string;
    toolName: string;
  };
  error?: string;
  errorCode?: string;
}

export interface AndroidWorkflowConfirmRequest {
  checkpointId: string;
  approved: boolean;
  userFeedback?: string;
  preferredLanguage?: "hi" | "en" | "hinglish";
}

// ---------------------------------------------------------------------------
// Phase 28 — Mobile Emergency & Security Contracts
// ---------------------------------------------------------------------------

export interface AndroidSuspiciousEvent {
  eventCategory: string;
  severityLabel: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  approximateTime: string;
  count: number;
  description: string;
}

export interface AndroidSecurityStatusResponse {
  emergencyStopActive: boolean;
  emergencyStopTriggeredAt?: string;
  emergencyStopSource?: string;
  lockdownActive: boolean;
  thisDeviceLostMode: boolean;
  activeSessionCount: number;
  recentSuspiciousEvents: AndroidSuspiciousEvent[];
  snapshotAt: string;
}

export interface AndroidSecurityControlRequest {
  nonce: string;
  timestampMs: number;
  reason?: string;
}

export interface AndroidSecurityControlResult {
  success: boolean;
  errorCode?: string;
  message: string;
  updatedStatus?: Partial<AndroidSecurityStatusResponse>;
}

export interface AndroidLostDeviceRequest extends AndroidSecurityControlRequest {
  deviceId: string;
}


// ---------------------------------------------------------------------------
// Android WebSocket Message Discriminator
// ---------------------------------------------------------------------------

/**
 * Type guard: Determines if an inbound message is an audio frame.
 * Audio frames have no "type" field — they use bare `{ audio: "..." }`.
 */
export function isAndroidAudioDownloadFrame(
  msg: unknown,
): msg is AndroidAudioDownloadFrame {
  return (
    typeof msg === "object" &&
    msg !== null &&
    "audio" in msg &&
    typeof (msg as AndroidAudioDownloadFrame).audio === "string" &&
    !("type" in msg)
  );
}

/**
 * Type guard: Determines the type of a typed inbound message.
 */
export function getAndroidMessageType(
  msg: unknown,
): string | null {
  if (typeof msg === "object" && msg !== null && "type" in msg) {
    return typeof (msg as { type: unknown }).type === "string"
      ? (msg as { type: string }).type
      : null;
  }
  return null;
}
