/**
 * MYRAA — CompanionTypes (Phase 6)
 *
 * Full type system for the Proactive Companion engine:
 *   - Background tasks & schedules
 *   - Proactive monitors (project, git, deployment)
 *   - Notification items & voice announcements
 *   - Companion preferences & quiet hours
 *   - Safety invariants (read-only default, minimum intervals, bounded queues)
 */

// ---------------------------------------------------------------------------
// Background Tasks & Scheduler
// ---------------------------------------------------------------------------

export type TaskType =
  | "build_monitor"
  | "git_monitor"
  | "deployment_monitor"
  | "event_waiter"
  | "custom_poll";

export type TaskStatus =
  | "scheduled"
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";

export interface TaskSchedule {
  /** Execution cadence: 'interval' (recurring) or 'delayed' (one-shot). */
  type: "interval" | "delayed";
  /** Interval or delay in milliseconds. Minimum floor is 5,000ms (5s). */
  intervalMs: number;
  /** Maximum iterations before automatic completion (undefined = unlimited for recurring). */
  maxIterations?: number;
  /** Maximum overall task lifetime in milliseconds before timeout. */
  timeoutMs?: number;
}

export interface BackgroundTask {
  id: string;
  name: string;
  type: TaskType;
  schedule: TaskSchedule;
  status: TaskStatus;
  /** Parameters passed to the monitoring target. */
  params: Record<string, unknown>;
  /** Strict invariant: background tasks are read-only by default. */
  isReadOnly: boolean;
  iterationCount: number;
  lastRunAt?: string;
  nextRunAt?: string;
  lastResult?: unknown;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

// ---------------------------------------------------------------------------
// Proactive Monitors
// ---------------------------------------------------------------------------

export interface BuildStatusReport {
  timestamp: string;
  buildStatus: "success" | "failure" | "unknown";
  lintStatus: "success" | "failure" | "unknown";
  testStatus?: "passed" | "failed" | "unknown";
  distArtifactsFound: boolean;
  errorMessage?: string;
  changedSinceLastCheck: boolean;
}

export interface GitMonitorReport {
  timestamp: string;
  branch: string;
  commitHash: string;
  clean: boolean;
  uncommittedFilesCount: number;
  modifiedFiles: string[];
  changedSinceLastCheck: boolean;
  summary: string;
}

export interface DeploymentMonitorReport {
  timestamp: string;
  targetUrl: string;
  statusCode?: number;
  latencyMs?: number;
  healthy: boolean;
  status: "healthy" | "degraded" | "down" | "unreachable";
  changedSinceLastCheck: boolean;
  errorMessage?: string;
}

// ---------------------------------------------------------------------------
// Notifications & Voice
// ---------------------------------------------------------------------------

export type NotificationLevel = "info" | "success" | "warning" | "error";

export interface NotificationItem {
  id: string;
  title: string;
  message: string;
  level: NotificationLevel;
  source: TaskType | "companion" | "system" | "planner";
  timestamp: string;
  read: boolean;
  dismissed: boolean;
  /** Deduplication signature to prevent alert flooding. */
  dedupKey: string;
  /** Spoken phrase for voice notification (sanitized of sensitive secrets). */
  voiceText?: string;
  metadata?: Record<string, unknown>;
}

export interface VoiceAnnouncement {
  id: string;
  notificationId: string;
  text: string;
  level: NotificationLevel;
  queuedAt: string;
  playedAt?: string;
  /** If quiet hours suppressed speech, this is marked true (visual notification preserved). */
  suppressedByQuietHours: boolean;
}

// ---------------------------------------------------------------------------
// User-Defined Companion Preferences
// ---------------------------------------------------------------------------

export interface QuietHoursConfig {
  enabled: boolean;
  /** Format "HH:mm" in 24h, e.g. "22:00" */
  start: string;
  /** Format "HH:mm" in 24h, e.g. "08:00" */
  end: string;
}

export interface PollIntervalPreferences {
  /** Minimum floor: 5000ms */
  gitPollIntervalMs: number;
  buildPollIntervalMs: number;
  deploymentPollIntervalMs: number;
}

export interface CompanionPreferences {
  /** Master companion toggle. */
  enabled: boolean;
  /** Voice notifications toggle. */
  voiceNotificationsEnabled: boolean;
  /** UI sound alert toggle. */
  soundEnabled: boolean;
  /** Minimum level required for spoken announcements. */
  minVoiceLevel: NotificationLevel;
  /** Quiet hours configuration (suppresses voice/audio only, never visual). */
  quietHours: QuietHoursConfig;
  /** Polling interval preferences. */
  pollIntervals: PollIntervalPreferences;
  /** Whitelisted URLs for deployment monitoring (strict SSRF-safe). */
  approvedDeploymentUrls: string[];
  /** Maximum notifications retained in queue. */
  maxNotificationQueueSize: number;
  updatedAt: string;
}

export const DEFAULT_COMPANION_PREFERENCES: CompanionPreferences = {
  enabled: true,
  voiceNotificationsEnabled: true,
  soundEnabled: true,
  minVoiceLevel: "info",
  quietHours: {
    enabled: false,
    start: "22:00",
    end: "08:00",
  },
  pollIntervals: {
    gitPollIntervalMs: 15_000,       // 15 seconds
    buildPollIntervalMs: 30_000,     // 30 seconds
    deploymentPollIntervalMs: 20_000 // 20 seconds
  },
  approvedDeploymentUrls: [
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "http://localhost:3000/api/agent-health",
  ],
  maxNotificationQueueSize: 200,
  updatedAt: new Date().toISOString(),
};

/** Minimum allowed polling interval across the platform to prevent CPU spin. */
export const MIN_POLL_INTERVAL_MS = 5_000;
