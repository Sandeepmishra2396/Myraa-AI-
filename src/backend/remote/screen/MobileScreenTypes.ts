/**
 * MYRAA — Mobile Screen Understanding Types
 * Phase 23
 *
 * Core type definitions for permission-gated mobile screen understanding:
 *   - Screen shield reasons and states (fail-closed)
 *   - Volatile in-memory screen snapshots (zero disk persistence)
 *   - Multi-tier OCR tokenization and DLP secret redactions
 *   - Semantic visual UI elements (buttons, inputs, headers, dialogs)
 *   - Full screen analysis result contracts
 */

import type {
  AndroidMobileScreenArgs,
  MobileScreenAnalysisResult,
  MobileScreenMode,
} from "../../../platform/android/index.ts";

export type {
  AndroidMobileScreenArgs,
  MobileScreenAnalysisResult,
  MobileScreenMode,
};

export const SCREEN_SHIELD_REASONS = {
  USER_NOT_APPROVED: "USER_NOT_APPROVED",
  SENSITIVE_APP: "SENSITIVE_APP",
  BANKING_APP: "BANKING_APP",
  PASSWORD_MANAGER: "PASSWORD_MANAGER",
  AUTH_OTP: "AUTH_OTP",
  UNCERTAIN_CONTEXT: "UNCERTAIN_CONTEXT",
  EMERGENCY_STOP: "EMERGENCY_STOP",
  LOCKDOWN: "LOCKDOWN",
  CAPTURE_FAILED: "CAPTURE_FAILED",
} as const;

export type ScreenShieldReasonType =
  (typeof SCREEN_SHIELD_REASONS)[keyof typeof SCREEN_SHIELD_REASONS];

export interface ScreenPrivacyShieldDecision {
  isShielded: boolean;
  reason?: ScreenShieldReasonType;
  details?: string;
}

export interface StructuredOcrLine {
  text: string;
  isRedacted: boolean;
  hasPromptInjection?: boolean;
}

export interface StructuredScreenOcr {
  rawText: string;
  sanitizedText: string;
  fencedText: string;
  lines: StructuredOcrLine[];
  redactedSecretsCount: number;
}

export interface VisualUIElement {
  type: "header" | "button" | "input" | "dialog" | "list_item" | "text";
  label: string;
  isSensitive?: boolean;
}

export interface MobileScreenCaptureOptions {
  approved: boolean;
  captureMode?: MobileScreenMode;
  rawScreenBase64?: string;
  screenSummary?: string;
  query?: string;
  foregroundApp?: {
    packageName?: string;
    appName?: string;
    isSensitive?: boolean;
    isAvailable?: boolean;
  };
  activityName?: string;
  isUncertain?: boolean;
}
