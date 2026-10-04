/**
 * MYRAA — DeploymentMonitor (Phase 6)
 *
 * Proactively monitors local or approved deployment targets:
 *   - Tracks HTTP status code, latency, and uptime
 *   - Detects status transitions: healthy <-> degraded <-> down
 *   - Strict SSRF protection: only explicitly approved URLs allowed
 *   - Validates redirects against approved origins & SSRF restrictions
 *   - Fires notifications and voice alerts on downtime / recovery
 */

import type { DeploymentMonitorReport } from "./CompanionTypes.ts";
import { companionStore } from "./CompanionStore.ts";
import { isSsrfSafeUrl } from "../security/PermissionManager.ts";
import { eventBus } from "./EventBus.ts";
import { notificationManager } from "./NotificationManager.ts";

export class DeploymentMonitor {
  private _lastReports = new Map<string, DeploymentMonitorReport>();

  /**
   * Validate whether a target URL is permitted for monitoring.
   * Safety invariant:
   *   1. Must match an approved URL in user preferences.
   *   2. If external (non-local), must pass isSsrfSafeUrl.
   *   3. Private / intranet IPs outside approved localhost are blocked.
   */
  async validateTargetUrl(targetUrl: string): Promise<{ allowed: boolean; reason?: string }> {
    try {
      const parsed = new URL(targetUrl);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return { allowed: false, reason: "Invalid protocol. Only http: and https: are allowed." };
      }

      const prefs = await companionStore.getPreferences();
      const approved = prefs.approvedDeploymentUrls || [];

      // Check if target matches approved origins or exact paths
      const isApproved = approved.some((appUrl) => {
        try {
          const appParsed = new URL(appUrl);
          return (
            appParsed.origin.toLowerCase() === parsed.origin.toLowerCase() &&
            (appParsed.pathname === "/" || parsed.pathname.startsWith(appParsed.pathname))
          );
        } catch {
          return false;
        }
      });

      if (!isApproved) {
        return {
          allowed: false,
          reason: `Target URL '${targetUrl}' is not in the approved deployment targets list.`,
        };
      }

      // If targeting a non-local host, verify SSRF safety
      const host = parsed.hostname.toLowerCase();
      const isLocal = host === "localhost" || host === "127.0.0.1" || host === "::1";
      if (!isLocal) {
        const ssrfCheck = await isSsrfSafeUrl(targetUrl);
        if (!ssrfCheck.safe) {
          return { allowed: false, reason: `SSRF validation failed: ${ssrfCheck.reason}` };
        }
      }

      return { allowed: true };
    } catch (err: any) {
      return { allowed: false, reason: `Invalid URL format: ${err.message}` };
    }
  }

  /** Probe the deployment target and report health. */
  async check(targetUrl: string): Promise<DeploymentMonitorReport> {
    const timestamp = new Date().toISOString();

    const validation = await this.validateTargetUrl(targetUrl);
    if (!validation.allowed) {
      const blockedReport: DeploymentMonitorReport = {
        timestamp,
        targetUrl,
        healthy: false,
        status: "unreachable",
        changedSinceLastCheck: true,
        errorMessage: validation.reason,
      };
      this._lastReports.set(targetUrl, blockedReport);
      return blockedReport;
    }

    const start = Date.now();
    let statusCode: number | undefined;
    let healthy = false;
    let status: "healthy" | "degraded" | "down" | "unreachable" = "unreachable";
    let errorMessage: string | undefined;

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);

      const res = await fetch(targetUrl, {
        signal: controller.signal,
        redirect: "manual",
      });
      clearTimeout(timeout);

      statusCode = res.status;
      const latencyMs = Date.now() - start;

      // Validate redirect destination if any
      if ([301, 302, 307, 308].includes(res.status)) {
        const loc = res.headers.get("location");
        if (loc) {
          const redirectUrl = new URL(loc, targetUrl).href;
          const redirectValid = await this.validateTargetUrl(redirectUrl);
          if (!redirectValid.allowed) {
            throw new Error(`Unapproved redirect destination: ${redirectValid.reason}`);
          }
        }
      }

      if (statusCode >= 200 && statusCode < 400) {
        healthy = true;
        status = latencyMs > 3000 ? "degraded" : "healthy";
      } else if (statusCode >= 400 && statusCode < 500) {
        status = "degraded";
      } else {
        status = "down";
      }
    } catch (err: any) {
      status = "down";
      errorMessage = err?.message || String(err);
    }

    const latencyMs = Date.now() - start;
    const lastReport = this._lastReports.get(targetUrl);
    const changed = !lastReport || lastReport.status !== status;

    const report: DeploymentMonitorReport = {
      timestamp,
      targetUrl,
      statusCode,
      latencyMs,
      healthy,
      status,
      changedSinceLastCheck: changed,
      errorMessage,
    };

    if (changed && lastReport) {
      eventBus.emit("monitor:deployment_changed", report);

      // Notify on outage or recovery
      if (status === "down" && lastReport.status !== "down") {
        await notificationManager.notify({
          title: "Deployment Target Down",
          message: `Target '${targetUrl}' is down (${errorMessage || `HTTP ${statusCode}`}).`,
          level: "error",
          source: "deployment_monitor",
          voiceText: `Alert! Deployment target ${new URL(targetUrl).hostname} down ho gaya hai.`,
        });
      } else if (status === "healthy" && lastReport.status === "down") {
        await notificationManager.notify({
          title: "Deployment Target Recovered",
          message: `Target '${targetUrl}' has recovered (HTTP ${statusCode}, ${latencyMs}ms).`,
          level: "success",
          source: "deployment_monitor",
          voiceText: `Sandeep, deployment target ${new URL(targetUrl).hostname} recover ho gaya hai aur healthy hai!`,
        });
      }
    }

    this._lastReports.set(targetUrl, report);
    return report;
  }

  getLastReport(targetUrl: string): DeploymentMonitorReport | undefined {
    return this._lastReports.get(targetUrl);
  }
}

/** Global singleton deployment monitor. */
export const deploymentMonitor = new DeploymentMonitor();
