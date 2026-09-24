/**
 * NotificationContextProvider
 * Phase 22 — Mobile Context Intelligence
 *
 * Provides minimal sanitized notification metadata.
 * Restricts collection strictly to non-sensitive structural summaries.
 */

import type { IContextProvider, NotificationContextItem } from "../MobileContextTypes.ts";
import { MobileContextSanitizer } from "../MobileContextSanitizer.ts";

export class NotificationContextProvider implements IContextProvider<NotificationContextItem[]> {
  readonly category = "notifications" as const;

  getContext(options?: { rawPayload?: unknown }): NotificationContextItem[] {
    const rawList = Array.isArray(options?.rawPayload) ? options?.rawPayload : [];

    return rawList.map((item: any, idx: number) => {
      const isSensitive = item.category === "sensitive" ||
        MobileContextSanitizer.isSensitivePackage(item.packageName || "");

      if (isSensitive) {
        return {
          id: item.id || `notif_${idx}`,
          packageName: item.packageName || "unknown",
          appName: item.appName || "App",
          category: "sensitive",
          title: "[SHIELDED]",
          sanitizedSnippet: "[CONTENT_SHIELDED_FOR_PRIVACY]",
          postTimeMs: item.postTimeMs || Date.now(),
          priority: item.priority || "normal",
        };
      }

      return {
        id: item.id || `notif_${idx}`,
        packageName: item.packageName || "unknown",
        appName: item.appName || "App",
        category: item.category || "general",
        title: (item.title || "").slice(0, 80),
        sanitizedSnippet: (item.sanitizedSnippet || item.snippet || "").slice(0, 140),
        postTimeMs: item.postTimeMs || Date.now(),
        priority: item.priority || "normal",
      };
    });
  }
}
