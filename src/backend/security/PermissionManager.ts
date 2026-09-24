/**
 * MYRAA — PermissionManager
 *
 * Centralises all security concerns:
 *   • requireLocalhost  — middleware that blocks non-loopback callers
 *   • sanitizeError     — strips API keys from log/error strings
 *   • isRestrictedHost  — classifies IPs/hostnames as private/restricted
 *   • isSsrfSafeUrl     — async SSRF check (DNS-resolves the target host)
 *   • safeSsrfFetch     — fetch wrapper that validates every redirect hop
 *
 * Nothing in this file reads from disk or spawns processes; it is purely
 * stateless so it can be imported early and re-used from multiple modules.
 */

// ---------------------------------------------------------------------------
// Security: Localhost-only guard for sensitive endpoints.
// ---------------------------------------------------------------------------
export function requireLocalhost(req: any, res: any, next: () => void): void {
  const forwardedIp = req.headers?.["x-forwarded-for"];
  const ip = forwardedIp
    ? String(forwardedIp).split(",")[0].trim()
    : req.ip || req.socket?.remoteAddress || req.connection?.remoteAddress || "";
  const isLocal =
    ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1" || ip === "localhost";
  if (!isLocal) {
    res
      .status(403)
      .json({
        error: "Forbidden: This endpoint is only accessible from localhost.",
      });
    return;
  }
  next();
}

// ---------------------------------------------------------------------------
// Security: Sanitizer to prevent any API key leakage into logs / error responses.
// ---------------------------------------------------------------------------
export function sanitizeError(msg: unknown): string {
  return String(msg || "")
    .replace(/AIza[0-9A-Za-z\-_]{35}/g, "AIzaSy...[REDACTED]")
    .replace(/AQ\.[0-9A-Za-z\-_]{30,}/g, "AQ...[REDACTED]");
}

// ---------------------------------------------------------------------------
// Security: Comprehensive SSRF Defence (Centralized via NetworkSecurityManager)
// ---------------------------------------------------------------------------
import { networkSecurityManager } from "./NetworkSecurityManager.ts";

export function isRestrictedHost(host: string): boolean {
  return networkSecurityManager.isRestrictedHost(host);
}

export async function isSsrfSafeUrl(
  urlStr: string,
): Promise<{ safe: boolean; reason?: string }> {
  return networkSecurityManager.isSsrfSafeUrl(urlStr);
}

/**
 * Safe fetch that validates each hop against SSRF before following redirects.
 * Delegates to centralized NetworkSecurityManager.
 */
export async function safeSsrfFetch(
  url: string,
  options: RequestInit = {},
  maxRedirects = 3,
): Promise<Response> {
  const guarded = await networkSecurityManager.fetchGuarded(url, {
    ...options,
    maxRedirects,
  });
  const buf = await guarded.arrayBuffer();
  return new Response(buf, {
    status: guarded.status,
    statusText: guarded.statusText,
    headers: guarded.headers,
  });
}

// ---------------------------------------------------------------------------
// Security: Workspace Traversal & File Boundary Guards
// Prevents directory traversal (../), path escapes, and symlink hijacking.
// ---------------------------------------------------------------------------
import path from "path";
import fs from "fs";

/**
 * Checks whether targetPath is strictly inside or equal to workspaceRoot.
 * Handles Windows case-insensitivity and resolves real paths if present.
 */
export function isPathWithinWorkspace(
  targetPath: string,
  workspaceRoot: string,
): boolean {
  try {
    const resolvedRoot = path.resolve(workspaceRoot);
    const resolvedTarget = path.resolve(resolvedRoot, targetPath);

    // Normalize for OS comparison
    const normRoot = process.platform === "win32" ? resolvedRoot.toLowerCase() : resolvedRoot;
    const normTarget = process.platform === "win32" ? resolvedTarget.toLowerCase() : resolvedTarget;

    const rel = path.relative(normRoot, normTarget);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      return false;
    }

    // If target exists on disk, also check its realpath to prevent symlink escaping
    if (fs.existsSync(resolvedTarget)) {
      const realRoot = fs.realpathSync(resolvedRoot);
      const realTarget = fs.realpathSync(resolvedTarget);
      const normRealRoot = process.platform === "win32" ? realRoot.toLowerCase() : realRoot;
      const normRealTarget = process.platform === "win32" ? realTarget.toLowerCase() : realTarget;
      const realRel = path.relative(normRealRoot, normRealTarget);
      if (realRel.startsWith("..") || path.isAbsolute(realRel)) {
        return false;
      }
    }

    return true;
  } catch {
    return false;
  }
}

/**
 * Asserts that targetPath is within workspaceRoot, throwing an error if not.
 * Returns the sanitized, resolved absolute path.
 */
export function assertWithinWorkspace(
  targetPath: string,
  workspaceRoot: string,
): string {
  const resolvedRoot = path.resolve(workspaceRoot);
  const resolvedTarget = path.resolve(resolvedRoot, targetPath);

  if (!isPathWithinWorkspace(targetPath, workspaceRoot)) {
    throw new Error(
      `Access denied: Path '${sanitizeError(targetPath)}' is outside active workspace boundary.`,
    );
  }

  return resolvedTarget;
}
