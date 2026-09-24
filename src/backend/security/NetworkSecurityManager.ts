/**
 * MYRAA — NetworkSecurityManager (Phase 10F)
 *
 * Centralized Outbound Network Security Layer:
 *   • Single source of truth for SSRF protection and network egress validation.
 *   • Defense-in-depth IP validation: IPv4/IPv6 loopback, RFC 1918 private, link-local,
 *     cloud metadata endpoints, CGNAT, ULA IPv6, intranet domains, and obfuscated/hex/octal IPs.
 *   • DNS rebinding prevention via multi-address A/AAAA async resolution validation.
 *   • Hop-by-hop redirect validation (max 5 hops; fails closed on any restricted target).
 *   • Strict connect/read timeouts (default 10s via AbortController).
 *   • Response-size limits (chunked streaming byte counting; aborts if limit exceeded, default 10MB).
 *   • Per-domain sliding-window rate limiting (default 30 req/min).
 *   • Webhook HMAC signature validation (timing-safe comparison with timestamp tolerance).
 *   • Audit integration: Logs SSRF_BLOCKED, RATE_LIMIT_EXCEEDED, WEBHOOK_VERIFIED/FAILED.
 */

import dns from "dns";
import net from "net";
import crypto from "crypto";
import {
  NetworkSecurityConfig,
  GuardedFetchOptions,
  GuardedResponse,
  WebhookValidationOptions,
  WebhookValidationResult,
  SecurityContext,
} from "./SecurityTypes.ts";
import { securityAuditLogger } from "./SecurityAuditLogger.ts";

const BLOCKED_PORTS = new Set([
  21,    // FTP
  22,    // SSH
  23,    // Telnet
  25,    // SMTP
  53,    // DNS
  69,    // TFTP
  135,   // MS RPC
  137,   // NetBIOS
  138,   // NetBIOS
  139,   // NetBIOS
  445,   // SMB
  1433,  // MS SQL
  1521,  // Oracle DB
  3306,  // MySQL
  5432,  // PostgreSQL
  6379,  // Redis
  11211, // Memcached
  27017, // MongoDB
  28017, // MongoDB Web
]);

export class NetworkSecurityManager {
  private _config: NetworkSecurityConfig;
  private _domainRequestWindows = new Map<string, number[]>();

  constructor(config: NetworkSecurityConfig = {}) {
    this._config = {
      maxRedirects: 5,
      timeoutMs: 10_000,
      maxResponseBytes: 10 * 1024 * 1024, // 10MB
      rateLimitPerDomainPerMin: 30,
      dnsRebindingProtection: true,
      ...config,
    };
  }

  // ---------------------------------------------------------------------------
  // Configuration
  // ---------------------------------------------------------------------------

  updateConfig(newConfig: Partial<NetworkSecurityConfig>): void {
    this._config = { ...this._config, ...newConfig };
  }

  getConfig(): Readonly<NetworkSecurityConfig> {
    return { ...this._config };
  }

  // ---------------------------------------------------------------------------
  // Host & IP Validation (SSRF Defense)
  // ---------------------------------------------------------------------------

  /**
   * Evaluates if a given host string or IP address is restricted/private.
   * Handles IPv4, IPv6, loopback, link-local, private networks, cloud metadata,
   * intranet names, and obfuscated (hex/octal/dword) representations.
   */
  isRestrictedHost(host: string): boolean {
    if (!host || typeof host !== "string") return true;

    let h = host.toLowerCase().replace(/^\[|\]$/g, "").trim();

    // Remove port if present (e.g. "localhost:8080" -> "localhost")
    if (h.includes(":") && !h.includes("::")) {
      const parts = h.split(":");
      if (parts.length === 2 && /^\d+$/.test(parts[1])) {
        h = parts[0];
      }
    }

    // 1. Dword / Integer IPv4 (e.g. 2130706433 -> 127.0.0.1)
    if (/^\d+$/.test(h)) {
      const num = parseInt(h, 10);
      if (!isNaN(num) && num >= 0 && num <= 0xffffffff) {
        const decoded = [
          (num >>> 24) & 255,
          (num >>> 16) & 255,
          (num >>> 8) & 255,
          num & 255,
        ].join(".");
        return this.isRestrictedHost(decoded);
      }
      return true; // invalid numeric host
    }

    // 2. Hexadecimal IPv4 (e.g. 0x7f000001 -> 127.0.0.1)
    if (/^0x[0-9a-f]+$/i.test(h)) {
      const num = parseInt(h, 16);
      if (!isNaN(num) && num >= 0 && num <= 0xffffffff) {
        const decoded = [
          (num >>> 24) & 255,
          (num >>> 16) & 255,
          (num >>> 8) & 255,
          num & 255,
        ].join(".");
        return this.isRestrictedHost(decoded);
      }
      return true;
    }

    // 3. Obfuscated octal or hex dotted quad (e.g. 0177.0.0.1 or 0x7f.0.0.1)
    if (h.includes(".")) {
      const segments = h.split(".");
      if (segments.length === 4) {
        let isObfuscated = false;
        const decodedParts: number[] = [];
        for (const seg of segments) {
          if (/^0x[0-9a-f]+$/i.test(seg)) {
            isObfuscated = true;
            decodedParts.push(parseInt(seg, 16));
          } else if (/^0\d+$/.test(seg)) {
            isObfuscated = true;
            decodedParts.push(parseInt(seg, 8));
          } else if (/^\d+$/.test(seg)) {
            decodedParts.push(parseInt(seg, 10));
          } else {
            break;
          }
        }
        if (isObfuscated && decodedParts.length === 4 && decodedParts.every((p) => p >= 0 && p <= 255)) {
          return this.isRestrictedHost(decodedParts.join("."));
        }
      }
    }

    // 4. Loopback (IPv4 127.0.0.0/8, IPv6 ::1, 0.0.0.0, ::)
    if (
      h === "localhost" ||
      h === "0.0.0.0" ||
      h === "::" ||
      h === "::1" ||
      h.startsWith("127.") ||
      h.startsWith("::ffff:127.")
    ) {
      return true;
    }

    // 5. RFC 1918 Private IPv4
    if (
      h.startsWith("10.") ||
      h.startsWith("192.168.") ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(h)
    ) {
      return true;
    }

    // 6. Link-Local & Cloud Metadata (IPv4 169.254.0.0/16, IPv6 fe80::/10)
    if (
      h.startsWith("169.254.") ||
      /^fe[89ab][0-9a-f]:/i.test(h) ||
      h === "169.254.169.254" ||
      h === "169.254.169.253" ||
      h === "metadata.google.internal" ||
      h === "metadata.aws" ||
      h === "instance-data"
    ) {
      return true;
    }

    // 7. Carrier-Grade NAT (100.64.0.0/10)
    if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(h)) {
      return true;
    }

    // 8. Unique Local IPv6 (fc00::/7)
    if (/^f[cd][0-9a-f]{2}:/i.test(h)) {
      return true;
    }

    // 9. Intranet & Local domain suffixes
    if (
      h.endsWith(".local") ||
      h.endsWith(".internal") ||
      h.endsWith(".lan") ||
      h.endsWith(".corp") ||
      h.endsWith(".home") ||
      h.endsWith(".onion") ||
      h.endsWith(".test") ||
      h.endsWith(".example") ||
      h.endsWith(".invalid") ||
      (!h.includes(".") && !h.includes(":"))
    ) {
      return true;
    }

    return false;
  }

  /**
   * Thoroughly validates a target URL for SSRF, restricted ports, domain blocklists,
   * and DNS rebinding (resolving all A and AAAA addresses).
   */
  async isSsrfSafeUrl(
    urlStr: string,
    options: { skipDnsResolution?: boolean } = {},
  ): Promise<{ safe: boolean; reason?: string }> {
    try {
      const parsed = new URL(urlStr);

      // Protocol check: Only HTTP and HTTPS
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return {
          safe: false,
          reason: `Invalid protocol '${parsed.protocol}'. Only http: and https: are allowed.`,
        };
      }

      // Port check
      if (parsed.port) {
        const portNum = parseInt(parsed.port, 10);
        if (BLOCKED_PORTS.has(portNum)) {
          return {
            safe: false,
            reason: `Target port ${portNum} is restricted for security.`,
          };
        }
      }

      const cleanHost = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "").trim();

      // Host restriction check
      if (this.isRestrictedHost(cleanHost)) {
        return {
          safe: false,
          reason: `Target host '${cleanHost}' is restricted (private/loopback/metadata address blocked).`,
        };
      }

      // Domain allowlist check (if configured)
      if (this._config.allowedDomains && this._config.allowedDomains.length > 0) {
        const isAllowed = this._config.allowedDomains.some(
          (d) => cleanHost === d.toLowerCase() || cleanHost.endsWith(`.${d.toLowerCase()}`),
        );
        if (!isAllowed) {
          return {
            safe: false,
            reason: `Target domain '${cleanHost}' is not in the allowed domain list.`,
          };
        }
      }

      // Domain blocklist check (if configured)
      if (this._config.blockedDomains && this._config.blockedDomains.length > 0) {
        const isBlocked = this._config.blockedDomains.some(
          (d) => cleanHost === d.toLowerCase() || cleanHost.endsWith(`.${d.toLowerCase()}`),
        );
        if (isBlocked) {
          return {
            safe: false,
            reason: `Target domain '${cleanHost}' is in the blocked domain list.`,
          };
        }
      }

      // DNS Rebinding Protection: Resolve domain and inspect all A / AAAA addresses
      const shouldCheckDns =
        !options.skipDnsResolution &&
        this._config.dnsRebindingProtection !== false &&
        net.isIP(cleanHost) === 0;

      if (shouldCheckDns) {
        try {
          const lookup = await dns.promises.lookup(cleanHost, { all: true });
          if (!lookup || lookup.length === 0) {
            return {
              safe: false,
              reason: `Target host '${cleanHost}' could not be resolved to any IP address.`,
            };
          }
          for (const item of lookup) {
            if (this.isRestrictedHost(item.address)) {
              return {
                safe: false,
                reason: `DNS Rebinding detected: Target host '${cleanHost}' resolves to restricted IP (${item.address}).`,
              };
            }
          }
        } catch (dnsErr: any) {
          // If DNS fails to resolve completely, reject fail-closed if strictly resolving
          // but allow fetch error to surface naturally if it's an offline/mock environment
          if (dnsErr.code === "ENOTFOUND") {
            return {
              safe: false,
              reason: `DNS resolution failed for host '${cleanHost}' (ENOTFOUND).`,
            };
          }
        }
      }

      return { safe: true };
    } catch (err: any) {
      return { safe: false, reason: `Malformed or invalid URL: ${err.message}` };
    }
  }

  // ---------------------------------------------------------------------------
  // Per-Domain Rate Limiter
  // ---------------------------------------------------------------------------

  checkRateLimit(domain: string): { allowed: boolean; retryAfterSeconds?: number } {
    const limit = this._config.rateLimitPerDomainPerMin || 30;
    const now = Date.now();
    const windowMs = 60_000;

    let history = this._domainRequestWindows.get(domain) || [];
    // Purge timestamps older than 1 minute
    history = history.filter((t) => now - t < windowMs);
    this._domainRequestWindows.set(domain, history);

    if (history.length >= limit) {
      const oldestInWindow = history[0];
      const retryAfterSeconds = Math.max(1, Math.ceil((oldestInWindow + windowMs - now) / 1000));
      return { allowed: false, retryAfterSeconds };
    }

    return { allowed: true };
  }

  recordRequest(domain: string): void {
    const now = Date.now();
    const history = this._domainRequestWindows.get(domain) || [];
    history.push(now);
    this._domainRequestWindows.set(domain, history);
  }

  resetRateLimits(): void {
    this._domainRequestWindows.clear();
  }

  // ---------------------------------------------------------------------------
  // Guarded Outbound Fetch
  // ---------------------------------------------------------------------------

  /**
   * High-level safe fetch engine:
   *   • Validates URL and checks SSRF
   *   • Applies domain rate limiting
   *   • Connect/read timeouts via AbortController
   *   • Hop-by-hop redirect validation (maxRedirects)
   *   • Response-size limit protection (streaming accumulator with byte count)
   *   • Returns a GuardedResponse
   */
  async fetchGuarded(url: string, options: GuardedFetchOptions = {}): Promise<GuardedResponse> {
    const maxRedirects = options.maxRedirects ?? this._config.maxRedirects ?? 5;
    const timeoutMs = options.timeoutMs ?? this._config.timeoutMs ?? 10_000;
    const maxResponseBytes =
      options.maxResponseBytes ?? this._config.maxResponseBytes ?? 10 * 1024 * 1024;
    const skipDns = options.skipDnsRebinding ?? false;

    let currentUrl = url;
    const redirectHops: string[] = [];

    for (let hop = 0; hop <= maxRedirects; hop++) {
      // 1. Validate hop URL against SSRF
      const check = await this.isSsrfSafeUrl(currentUrl, { skipDnsResolution: skipDns });
      if (!check.safe) {
        securityAuditLogger.logEvent({
          eventType: "SSRF_BLOCKED",
          actor: {
            identityId: options.callerSubsystem || "network_security",
            role: options.context?.role || "standard",
            ipAddress: options.context?.ipAddress || "127.0.0.1",
            sessionId: options.context?.sessionId,
          },
          target: { resource: currentUrl },
          decision: "BLOCK",
          reason: `SSRF blocked on hop ${hop}: ${check.reason}`,
          riskLevel: "HIGH",
          metadata: { initialUrl: url, hop, reason: check.reason },
        });
        throw new Error(`SSRF blocked: ${check.reason}`);
      }

      // 2. Rate limit check for hostname
      const parsedHost = new URL(currentUrl).hostname.toLowerCase();
      const rateLimitCheck = this.checkRateLimit(parsedHost);
      if (!rateLimitCheck.allowed) {
        securityAuditLogger.logEvent({
          eventType: "RATE_LIMIT_EXCEEDED",
          actor: {
            identityId: options.callerSubsystem || "network_security",
            role: options.context?.role || "standard",
            ipAddress: options.context?.ipAddress || "127.0.0.1",
            sessionId: options.context?.sessionId,
          },
          target: { resource: parsedHost },
          decision: "BLOCK",
          reason: `Rate limit exceeded for host '${parsedHost}'. Retry after ${rateLimitCheck.retryAfterSeconds}s`,
          riskLevel: "MEDIUM",
          metadata: { host: parsedHost, retryAfterSeconds: rateLimitCheck.retryAfterSeconds },
        });
        throw new Error(
          `Rate limit exceeded for host '${parsedHost}'. Retry after ${rateLimitCheck.retryAfterSeconds}s`,
        );
      }
      this.recordRequest(parsedHost);

      // 3. Setup AbortController for timeout
      const abortController = new AbortController();
      const timer = setTimeout(() => {
        abortController.abort(new Error(`Request timeout after ${timeoutMs}ms`));
      }, timeoutMs);

      try {
        const {
          timeoutMs: _t,
          maxRedirects: _r,
          maxResponseBytes: _m,
          skipDnsRebinding: _s,
          callerSubsystem: _c,
          context: _ctx,
          ...fetchOpts
        } = options;

        const response = await fetch(currentUrl, {
          ...fetchOpts,
          redirect: "manual",
          signal: abortController.signal,
        });

        // Check if redirect
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          clearTimeout(timer);
          const location = response.headers.get("location");
          if (!location) {
            throw new Error(`Redirect response from '${currentUrl}' lacked a Location header.`);
          }
          const nextUrl = new URL(location, currentUrl).href;
          redirectHops.push(currentUrl);
          currentUrl = nextUrl;
          continue;
        }

        // 4. Enforce response size limits via Content-Length header check
        const contentLength = response.headers.get("content-length");
        if (contentLength && parseInt(contentLength, 10) > maxResponseBytes) {
          clearTimeout(timer);
          throw new Error(
            `Response size (${contentLength} bytes) exceeds maximum permitted limit (${maxResponseBytes} bytes).`,
          );
        }

        // 5. Read body stream with byte counting
        const chunks: Uint8Array[] = [];
        let totalBytes = 0;

        if (response.body) {
          const reader = response.body.getReader();
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              if (value) {
                totalBytes += value.byteLength;
                if (totalBytes > maxResponseBytes) {
                  await reader.cancel();
                  throw new Error(
                    `Response stream exceeded maximum permitted limit of ${maxResponseBytes} bytes.`,
                  );
                }
                chunks.push(value);
              }
            }
          } finally {
            clearTimeout(timer);
          }
        } else {
          clearTimeout(timer);
        }

        const bodyBuffer = Buffer.concat(
          chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength)),
        );

        const guardedResponse: GuardedResponse = {
          url: currentUrl,
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
          redirectHops,
          ok: response.ok,
          text: async () => bodyBuffer.toString("utf-8"),
          json: async <T = unknown>() => JSON.parse(bodyBuffer.toString("utf-8")) as T,
          arrayBuffer: async () =>
            bodyBuffer.buffer.slice(
              bodyBuffer.byteOffset,
              bodyBuffer.byteOffset + bodyBuffer.byteLength,
            ),
        };

        return guardedResponse;
      } catch (err: any) {
        clearTimeout(timer);
        throw err;
      }
    }

    throw new Error(`Too many redirects: exceeded maximum of ${maxRedirects} hops.`);
  }

  // ---------------------------------------------------------------------------
  // Webhook Signature & HMAC Validation
  // ---------------------------------------------------------------------------

  /**
   * Deterministically validates webhook signatures using constant-time comparison
   * and optional timestamp replay tolerance.
   */
  validateWebhookSignature(options: WebhookValidationOptions): WebhookValidationResult {
    const {
      payload,
      signatureHeader,
      secret,
      algorithm = "sha256",
      toleranceSeconds = 300, // 5 minutes
      timestampHeader,
    } = options;

    if (!payload || !signatureHeader || !secret) {
      return { valid: false, reason: "Missing payload, signature, or secret" };
    }

    // 1. Timestamp validation (replay prevention)
    let parsedTimestamp: number | undefined;
    if (timestampHeader) {
      const tsNum = parseInt(timestampHeader, 10);
      if (isNaN(tsNum)) {
        return { valid: false, reason: "Malformed timestamp header" };
      }
      parsedTimestamp = tsNum;
      const nowSec = Math.floor(Date.now() / 1000);
      if (Math.abs(nowSec - tsNum) > toleranceSeconds) {
        securityAuditLogger.logEvent({
          eventType: "WEBHOOK_FAILED",
          actor: { identityId: "webhook_ingress", role: "guest", ipAddress: "127.0.0.1" },
          decision: "BLOCK",
          reason: `Webhook timestamp expired or outside tolerance window (${toleranceSeconds}s)`,
          riskLevel: "HIGH",
        });
        return { valid: false, reason: "Timestamp expired or outside tolerance window", timestamp: tsNum };
      }
    }

    // 2. Extract signature hex (supports "sha256=hex", "sha1=hex", or raw hex)
    let cleanProvidedSig = signatureHeader.trim();
    if (cleanProvidedSig.includes("=")) {
      const parts = cleanProvidedSig.split("=");
      cleanProvidedSig = parts[parts.length - 1].trim();
    }

    // 3. Compute expected HMAC
    const hmac = crypto.createHmac(algorithm, secret);
    const payloadBuffer = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, "utf-8");
    hmac.update(payloadBuffer);
    const expectedSig = hmac.digest("hex");

    // 4. Constant-time comparison
    const expectedBuf = Buffer.from(expectedSig, "utf-8");
    const providedBuf = Buffer.from(cleanProvidedSig, "utf-8");

    if (expectedBuf.length !== providedBuf.length) {
      securityAuditLogger.logEvent({
        eventType: "WEBHOOK_FAILED",
        actor: { identityId: "webhook_ingress", role: "guest", ipAddress: "127.0.0.1" },
        decision: "BLOCK",
        reason: "Webhook signature length mismatch",
        riskLevel: "HIGH",
      });
      return { valid: false, reason: "Signature length mismatch" };
    }

    const matches = crypto.timingSafeEqual(expectedBuf, providedBuf);
    if (!matches) {
      securityAuditLogger.logEvent({
        eventType: "WEBHOOK_FAILED",
        actor: { identityId: "webhook_ingress", role: "guest", ipAddress: "127.0.0.1" },
        decision: "BLOCK",
        reason: "Webhook HMAC signature mismatch",
        riskLevel: "HIGH",
      });
      return { valid: false, reason: "Invalid HMAC signature" };
    }

    securityAuditLogger.logEvent({
      eventType: "WEBHOOK_VERIFIED",
      actor: { identityId: "webhook_ingress", role: "guest", ipAddress: "127.0.0.1" },
      decision: "ALLOW",
      reason: "Webhook signature verified successfully",
      riskLevel: "LOW",
    });

    return { valid: true, timestamp: parsedTimestamp };
  }
}

export const networkSecurityManager = new NetworkSecurityManager();
