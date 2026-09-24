/**
 * MYRAA — Mobile Context Intelligence Types
 * Phase 22
 *
 * Defines typed provider interfaces, permission models, DLP rules,
 * and context snapshot containers.
 */

import type {
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
  MobileContextCategory,
} from "../../../platform/android/index.ts";

export type {
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
  MobileContextCategory,
};

export const CONTEXT_UNKNOWN = "UNKNOWN";
export const CONTEXT_NOT_AVAILABLE = "NOT_AVAILABLE";
export const CONTEXT_NOT_PERMITTED = "NOT_PERMITTED";
export const CONTEXT_SENSITIVE_SHIELDED = "SENSITIVE_SHIELDED";

/**
 * Interface that all 9 mobile context providers must implement.
 */
export interface IContextProvider<T> {
  readonly category: MobileContextCategory;
  getContext(options?: {
    approved?: boolean;
    rawPayload?: unknown;
    query?: string;
  }): Promise<T> | T;
}

/**
 * Permission state for each context category.
 */
export interface ContextPermissionGrant {
  category: MobileContextCategory;
  granted: boolean;
  grantedAt?: string;
}

/**
 * Options passed to MobileContextManager when capturing or fusing context.
 */
export interface MobileContextCaptureOptions {
  deviceId?: string;
  categories?: MobileContextCategory[];
  approvedScreenContext?: boolean;
  screenSummary?: string;
  query?: string;
  remoteSnapshot?: Partial<MobileContextSnapshot>;
}
