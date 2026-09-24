/**
 * MYRAA — DataProtectionService (Phase 10B)
 *
 * Data Protection At Rest & In Transit:
 *
 * AT REST:
 *   • Authenticated Encryption (AES-256-GCM) with random 12-byte IV and 16-byte Auth Tag.
 *   • Cryptographic key derivation using PBKDF2 (100,000 iterations + SHA-256).
 *   • Tamper-proof: Any modification of ciphertext or authentication tag fails decryption.
 *   • SecureSecretStore: Encrypted disk storage with atomic write and strict permissions (0o600).
 *   • Never persists raw access/refresh/confirmation tokens on disk unencrypted.
 *
 * IN TRANSIT:
 *   • TransportSecurityValidator: Enforces HTTPS / WSS for all remote / external connections.
 *   • Rejects unencrypted HTTP/WS on remote IP connections.
 *   • Audit logging for insecure transport attempts.
 */

import crypto from "crypto";
import fs from "fs";
import path from "path";
import { dataFile } from "../../../server_paths.ts";
import { securityAuditLogger } from "./SecurityAuditLogger.ts";

const MASTER_KEY_ENV =
  process.env.MYRAA_MASTER_KEY ||
  process.env.MYRAA_SECURITY_SECRET ||
  "myraa_master_fallback_key_32_bytes_long!!";

const SECURE_STORE_FILE = dataFile("secure_secrets.enc");

export interface EncryptedPayload {
  version: "v1";
  salt: string; // hex
  iv: string; // hex
  authTag: string; // hex
  ciphertext: string; // hex
}

export class DataProtectionService {
  private _cachedMasterKey: Buffer | null = null;

  // ---------------------------------------------------------------------------
  // Cryptographic Key Derivation (PBKDF2)
  // ---------------------------------------------------------------------------

  private _deriveKey(salt: Buffer, secret = MASTER_KEY_ENV): Buffer {
    return crypto.pbkdf2Sync(secret, salt, 100_000, 32, "sha256");
  }

  // ---------------------------------------------------------------------------
  // At-Rest Encryption & Decryption (AES-256-GCM)
  // ---------------------------------------------------------------------------

  /**
   * Encrypt plaintext string using AES-256-GCM authenticated encryption.
   */
  encrypt(plaintext: string, secretKey = MASTER_KEY_ENV): string {
    if (typeof plaintext !== "string") {
      throw new Error("DATA_ENCRYPTION_ERROR: Plaintext must be a string.");
    }

    const salt = crypto.randomBytes(16);
    const iv = crypto.randomBytes(12); // 96-bit IV recommended for GCM
    const key = this._deriveKey(salt, secretKey);

    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    let ciphertext = cipher.update(plaintext, "utf-8", "hex");
    ciphertext += cipher.final("hex");

    const authTag = cipher.getAuthTag();

    const payload: EncryptedPayload = {
      version: "v1",
      salt: salt.toString("hex"),
      iv: iv.toString("hex"),
      authTag: authTag.toString("hex"),
      ciphertext,
    };

    return `v1:enc:${payload.salt}:${payload.iv}:${payload.authTag}:${payload.ciphertext}`;
  }

  /**
   * Decrypt and verify ciphertext using AES-256-GCM authenticated encryption.
   * Throws if tampered, corrupted, or key is wrong (AEAD authentication tag verification).
   */
  decrypt(encryptedStr: string, secretKey = MASTER_KEY_ENV): string {
    if (!encryptedStr || typeof encryptedStr !== "string" || !encryptedStr.startsWith("v1:enc:")) {
      throw new Error("DATA_DECRYPTION_ERROR: Invalid encrypted payload format.");
    }

    const parts = encryptedStr.split(":");
    if (parts.length !== 6) {
      throw new Error("DATA_DECRYPTION_ERROR: Malformed encrypted token structure.");
    }

    const [, , saltHex, ivHex, tagHex, ciphertextHex] = parts;

    try {
      const salt = Buffer.from(saltHex, "hex");
      const iv = Buffer.from(ivHex, "hex");
      const authTag = Buffer.from(tagHex, "hex");
      const key = this._deriveKey(salt, secretKey);

      const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAuthTag(authTag);

      let decrypted = decipher.update(ciphertextHex, "hex", "utf-8");
      decrypted += decipher.final("utf-8");

      return decrypted;
    } catch (err: any) {
      securityAuditLogger.logEvent({
        eventType: "DATA_ENCRYPTION_ERROR",
        actor: { identityId: "system", role: "admin", ipAddress: "127.0.0.1" },
        decision: "BLOCK",
        reason: `Decryption authentication tag failure (possible data tampering): ${err?.message}`,
        riskLevel: "CRITICAL",
      });

      throw new Error("DATA_TAMPERED: Authentication tag verification failed. Data corrupted or modified.");
    }
  }

  // ---------------------------------------------------------------------------
  // In-Transit Protection (HTTPS / WSS Enforcement)
  // ---------------------------------------------------------------------------

  /**
   * Validates network transport security.
   * Enforces HTTPS/WSS for all non-loopback connections.
   */
  validateTransport(options: {
    protocol: string; // "http:" | "https:" | "ws:" | "wss:"
    ipAddress: string;
    targetName?: string;
  }): { secure: boolean; error?: string } {
    const isLocal =
      options.ipAddress === "127.0.0.1" ||
      options.ipAddress === "::1" ||
      options.ipAddress === "::ffff:127.0.0.1" ||
      options.ipAddress === "localhost";

    const cleanProto = (options.protocol || "").toLowerCase().trim();
    const isEncrypted = cleanProto === "https:" || cleanProto === "wss:" || cleanProto === "https" || cleanProto === "wss";

    if (!isLocal && !isEncrypted) {
      const reason = `INSECURE_TRANSPORT_REJECTED: Remote connection via '${options.protocol}' rejected. HTTPS/WSS is mandatory for non-localhost endpoints.`;

      securityAuditLogger.logEvent({
        eventType: "INSECURE_TRANSPORT_REJECTED",
        actor: { identityId: "remote_caller", role: "guest", ipAddress: options.ipAddress },
        decision: "BLOCK",
        reason,
        riskLevel: "HIGH",
        metadata: { protocol: options.protocol, target: options.targetName },
      });

      return { secure: false, error: reason };
    }

    return { secure: true };
  }

  /**
   * Enforces that an outgoing URL uses HTTPS unless strictly targeted at localhost.
   */
  enforceSecureUrl(urlStr: string): void {
    try {
      const parsed = new URL(urlStr);
      const isLoopback =
        parsed.hostname === "localhost" ||
        parsed.hostname === "127.0.0.1" ||
        parsed.hostname === "::1";

      if (!isLoopback && parsed.protocol !== "https:") {
        throw new Error(
          `INSECURE_TRANSPORT_REJECTED: Outgoing connection to '${parsed.hostname}' must use HTTPS. Insecure protocol '${parsed.protocol}' is prohibited.`,
        );
      }
    } catch (e: any) {
      if (e.message?.includes("INSECURE_TRANSPORT_REJECTED")) {
        throw e;
      }
      throw new Error(`INVALID_URL: ${e.message}`);
    }
  }
}

export const dataProtectionService = new DataProtectionService();

// ---------------------------------------------------------------------------
// SecureSecretStore (Encrypted at Rest with strict file permissions)
// ---------------------------------------------------------------------------

export class SecureSecretStore {
  private _inMemoryCache = new Map<string, string>();
  private _filePath: string;

  constructor(filePath = SECURE_STORE_FILE) {
    this._filePath = filePath;
    this._load();
  }

  private _load(): void {
    try {
      if (fs.existsSync(this._filePath)) {
        const encrypted = fs.readFileSync(this._filePath, "utf-8").trim();
        if (encrypted) {
          const decrypted = dataProtectionService.decrypt(encrypted);
          const parsed = JSON.parse(decrypted);
          this._inMemoryCache = new Map(Object.entries(parsed));
        }
      }
    } catch (err) {
      console.warn(`[SecureSecretStore] Initialized with empty cache (${(err as any)?.message})`);
      this._inMemoryCache.clear();
    }
  }

  private _save(): void {
    const obj = Object.fromEntries(this._inMemoryCache.entries());
    const plaintext = JSON.stringify(obj);
    const encrypted = dataProtectionService.encrypt(plaintext);

    // Atomic write with strict owner-only permissions (0o600)
    const tmp = `${this._filePath}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
    fs.writeFileSync(tmp, encrypted, { encoding: "utf-8", mode: 0o600 });
    fs.renameSync(tmp, this._filePath);
  }

  setSecret(key: string, secretValue: string): void {
    if (!key || typeof key !== "string") {
      throw new Error("INVALID_KEY: Secret key must be a non-empty string.");
    }
    this._inMemoryCache.set(key, secretValue);
    this._save();
  }

  getSecret(key: string): string | undefined {
    return this._inMemoryCache.get(key);
  }

  hasSecret(key: string): boolean {
    return this._inMemoryCache.has(key);
  }

  deleteSecret(key: string): boolean {
    const existed = this._inMemoryCache.delete(key);
    if (existed) {
      this._save();
    }
    return existed;
  }

  clearForTesting(): void {
    this._inMemoryCache.clear();
    try {
      if (fs.existsSync(this._filePath)) {
        fs.unlinkSync(this._filePath);
      }
    } catch {
      /* ignore */
    }
  }
}

export const secureSecretStore = new SecureSecretStore();
