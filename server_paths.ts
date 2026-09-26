/**
 * MYRAA — path & secret resolution.
 *
 * Separates read-only *code/asset* locations (shipped with the app) from the
 * writable *data* location (per-user, survives reinstalls). In development both
 * collapse to the project root, so existing behaviour is unchanged. When the
 * packaged Electron app launches the backend it sets SORA_DATA_DIR to a
 * writable folder under %APPDATA%\MYRAA, because the install directory
 * (Program Files) is read-only.
 *
 * The Gemini API key is NOT shipped with the app. Each user supplies their own
 * on first run; it is stored here in the per-user data dir (never returned to
 * the frontend).
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";

/** Writable per-user data directory. Falls back to cwd in development. */
export const DATA_DIR: string = process.env.SORA_DATA_DIR || process.cwd();

try {
  fs.mkdirSync(DATA_DIR, { recursive: true });
} catch {
  /* already exists / best-effort */
}

/** Absolute path to a file inside the writable data directory. */
export function dataFile(name: string): string {
  return path.join(DATA_DIR, name);
}

let _cachedServerSecret: string | null = null;

/**
 * Resolves a persistent server-side HMAC signing secret.
 * Used for signing and verifying device tokens and session tokens across server restarts.
 * Priority:
 *   1. SORA_REMOTE_SECRET in environment
 *   2. MYRAA_SECURITY_SECRET in environment
 *   3. Deterministic secret derived from RENDER_SERVICE_ID (stable across deployments on Render)
 *   4. Persisted key in DATA_DIR/remote_secret.key
 *   5. Cryptographically secure 256-bit random key persisted to DATA_DIR/remote_secret.key
 */
export function getPersistentServerSecret(): string {
  if (process.env.SORA_REMOTE_SECRET?.trim()) {
    return process.env.SORA_REMOTE_SECRET.trim();
  }
  if (process.env.MYRAA_SECURITY_SECRET?.trim()) {
    return process.env.MYRAA_SECURITY_SECRET.trim();
  }
  if (process.env.RENDER_SERVICE_ID?.trim()) {
    return crypto.createHash("sha256").update(`myraa-render-secret:${process.env.RENDER_SERVICE_ID.trim()}`).digest("hex");
  }
  const renderHost = process.env.RENDER_EXTERNAL_HOSTNAME?.trim() || process.env.RENDER_EXTERNAL_URL?.trim();
  if (renderHost) {
    return crypto.createHash("sha256").update(`myraa-render-host-secret:${renderHost}`).digest("hex");
  }
  if (_cachedServerSecret) {
    return _cachedServerSecret;
  }

  const keyFile = dataFile("remote_secret.key");
  try {
    if (fs.existsSync(keyFile)) {
      const stored = fs.readFileSync(keyFile, "utf-8").trim();
      if (stored.length >= 32) {
        _cachedServerSecret = stored;
        return stored;
      }
    }
  } catch {
    /* fallback */
  }

  const generated = crypto.randomBytes(32).toString("hex");
  try {
    fs.writeFileSync(keyFile, generated, "utf-8");
  } catch {
    /* best-effort write */
  }
  _cachedServerSecret = generated;
  return generated;
}

// ---------------------------------------------------------------------------
// Gemini API key store (secrets.json in the data dir).
// ---------------------------------------------------------------------------
export const SECRETS_FILE = dataFile("secrets.json");

interface Secrets {
  geminiApiKey?: string;
}

function getAppDataSecretsFile(): string | null {
  const appData = process.env.APPDATA;
  if (!appData) return null;
  return path.join(appData, "MYRAA", "secrets.json");
}

function readSecretsFromFile(filePath: string): Secrets {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, "utf-8")) as Secrets;
    }
  } catch {
    /* corrupt — treat as empty */
  }
  return {};
}

function readSecrets(): Secrets {
  const local = readSecretsFromFile(SECRETS_FILE);
  if (local.geminiApiKey && isValidGeminiApiKey(local.geminiApiKey)) {
    return local;
  }
  const appDataFile = getAppDataSecretsFile();
  if (appDataFile && appDataFile !== SECRETS_FILE) {
    const appData = readSecretsFromFile(appDataFile);
    if (appData.geminiApiKey && isValidGeminiApiKey(appData.geminiApiKey)) {
      return appData;
    }
  }
  return local;
}

/**
 * Strips whitespace and optional surrounding quotes (e.g. "..." or '...') from a key string.
 */
export function cleanKey(raw: string | undefined | null): string {
  if (!raw) return "";
  let k = raw.trim();
  if ((k.startsWith('"') && k.endsWith('"')) || (k.startsWith("'") && k.endsWith("'"))) {
    k = k.slice(1, -1).trim();
  }
  return k;
}

/**
 * Detects unconfigured template placeholder strings from .env example files.
 */
export function isPlaceholderKey(key: string | undefined | null): boolean {
  if (!key) return false;
  const k = key.trim().toLowerCase();
  return (
    k.includes("your_production") ||
    k.includes("your_local") ||
    k.includes("your_gemini") ||
    k.includes("my_gemini_api_key") ||
    k.includes("your_api_key") ||
    k.includes("key_here") ||
    k.includes("<your_") ||
    k.includes("changeme") ||
    k.includes("placeholder")
  );
}

export type CredentialClass =
  | "API_KEY"
  | "AI_STUDIO_AUTH_KEY"
  | "OAUTH_ACCESS_TOKEN"
  | "EPHEMERAL_TOKEN"
  | "PLACEHOLDER"
  | "INVALID"
  | "NONE";

/**
 * Classifies a candidate Gemini credential into a safe metadata category without exposing the secret.
 */
export function classifyCredential(key: string | undefined | null): CredentialClass {
  const cleaned = cleanKey(key);
  if (!cleaned) return "NONE";
  if (isPlaceholderKey(cleaned)) return "PLACEHOLDER";
  if (cleaned.startsWith("ya29.")) return "OAUTH_ACCESS_TOKEN";
  if (cleaned.length < 15) return "INVALID";
  if (cleaned.startsWith("AIza")) return "API_KEY";
  if (cleaned.startsWith("AQ.")) return "AI_STUDIO_AUTH_KEY";
  if (cleaned.startsWith("auth_tokens/")) return "EPHEMERAL_TOKEN";
  return "API_KEY";
}

/**
 * Validates whether a candidate string is a plausible Google Gemini API key or AI Studio auth key.
 * Accepts standard API keys ('AIza...'), Google AI Studio authorization keys ('AQ....'), and ephemeral tokens ('auth_tokens/...').
 * Rejects empty, whitespace, excessively short inputs, template placeholders, or raw OAuth 2.0 access tokens ('ya29....').
 */
export function isValidGeminiApiKey(key: string | undefined | null): boolean {
  if (!key) return false;
  const cleaned = cleanKey(key);
  if (cleaned.length < 15) return false;
  if (isPlaceholderKey(cleaned)) return false;
  if (cleaned.startsWith("ya29.")) return false;
  return true;
}

export interface KeyMetadata {
  key?: string;
  source: "secrets.json" | "appdata_secrets.json" | "GEMINI_API_KEY" | "GOOGLE_API_KEY" | "GOOGLE_GENAI_API_KEY" | "none";
  credentialClass: CredentialClass;
  isValid: boolean;
  prefix: string;
  masked: string;
  length: number;
  isPlaceholder?: boolean;
}

export function inspectKey(key: string | undefined | null): {
  credentialClass: CredentialClass;
  isValid: boolean;
  prefix: string;
  masked: string;
  length: number;
  isPlaceholder: boolean;
} {
  const k = cleanKey(key);
  if (!k) {
    return {
      credentialClass: "NONE",
      isValid: false,
      prefix: "empty",
      masked: "none",
      length: 0,
      isPlaceholder: false,
    };
  }
  const isPlaceholder = isPlaceholderKey(k);
  const credentialClass = classifyCredential(k);
  const isValid = isValidGeminiApiKey(k);
  const prefix = isPlaceholder
    ? "placeholder"
    : k.startsWith("AIza")
    ? "AIza"
    : k.startsWith("AQ.")
    ? "AQ."
    : k.startsWith("ya29.")
    ? "ya29."
    : k.startsWith("auth_tokens/")
    ? "auth_tokens/"
    : "other";
  const masked = isPlaceholder
    ? "placeholder"
    : `${prefix}...[REDACTED]`;
  return { credentialClass, isValid, prefix, masked, length: k.length, isPlaceholder };
}

function getFileMtimeMs(filePath: string): number {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Resolves the active Gemini API key along with safe diagnostics.
 * Priority:
 *   1. User-entered key in data directory (secrets.json) / %APPDATA%\MYRAA\secrets.json (newest valid file wins when both exist)
 *   2. GEMINI_API_KEY in environment (.env)
 *   3. GOOGLE_API_KEY in environment (.env)
 *   4. GOOGLE_GENAI_API_KEY in environment (.env)
 */
export function resolveApiKeyWithMetadata(): KeyMetadata {
  // In cloud production (not packaged Electron desktop), server environment variables take
  // absolute precedence to ensure secrets are loaded strictly from the server environment.
  if (process.env.NODE_ENV === "production" && process.env.SORA_LAUNCHED_BY !== "electron") {
    const envGemini = cleanKey(process.env.GEMINI_API_KEY);
    const envGeminiInfo = inspectKey(envGemini);
    if (envGeminiInfo.isValid) {
      return { key: envGemini, source: "GEMINI_API_KEY", ...envGeminiInfo };
    }

    const envGoogle = cleanKey(process.env.GOOGLE_API_KEY);
    const envGoogleInfo = inspectKey(envGoogle);
    if (envGoogleInfo.isValid) {
      return { key: envGoogle, source: "GOOGLE_API_KEY", ...envGoogleInfo };
    }

    const envGenAi = cleanKey(process.env.GOOGLE_GENAI_API_KEY);
    const envGenAiInfo = inspectKey(envGenAi);
    if (envGenAiInfo.isValid) {
      return { key: envGenAi, source: "GOOGLE_GENAI_API_KEY", ...envGenAiInfo };
    }

    if (envGemini) return { key: undefined, source: "GEMINI_API_KEY", ...envGeminiInfo };
    if (envGoogle) return { key: undefined, source: "GOOGLE_API_KEY", ...envGoogleInfo };
    if (envGenAi) return { key: undefined, source: "GOOGLE_GENAI_API_KEY", ...envGenAiInfo };
    return {
      key: undefined,
      source: "none",
      credentialClass: "NONE",
      isValid: false,
      prefix: "none",
      masked: "none",
      length: 0,
      isPlaceholder: false,
    };
  }

  // 1 & 2. Data dir secrets.json and Roaming AppData secrets.json
  const stored = cleanKey(readSecretsFromFile(SECRETS_FILE).geminiApiKey);
  const storedInfo = inspectKey(stored);
  const appDataFile = getAppDataSecretsFile();
  const hasDistinctAppData = Boolean(appDataFile && appDataFile !== SECRETS_FILE);
  const appDataKey = hasDistinctAppData ? cleanKey(readSecretsFromFile(appDataFile!).geminiApiKey) : "";
  const appDataInfo = inspectKey(appDataKey);

  if (storedInfo.isValid && appDataInfo.isValid) {
    const storedMtime = getFileMtimeMs(SECRETS_FILE);
    const appDataMtime = getFileMtimeMs(appDataFile!);
    if (appDataMtime > storedMtime) {
      return { key: appDataKey, source: "appdata_secrets.json", ...appDataInfo };
    }
    return { key: stored, source: "secrets.json", ...storedInfo };
  }
  if (storedInfo.isValid) {
    return { key: stored, source: "secrets.json", ...storedInfo };
  }
  if (appDataInfo.isValid) {
    return { key: appDataKey, source: "appdata_secrets.json", ...appDataInfo };
  }

  // 3. GEMINI_API_KEY in environment
  const envGemini = cleanKey(process.env.GEMINI_API_KEY);
  const envGeminiInfo = inspectKey(envGemini);
  if (envGeminiInfo.isValid) {
    return { key: envGemini, source: "GEMINI_API_KEY", ...envGeminiInfo };
  }

  // 4. GOOGLE_API_KEY in environment
  const envGoogle = cleanKey(process.env.GOOGLE_API_KEY);
  const envGoogleInfo = inspectKey(envGoogle);
  if (envGoogleInfo.isValid) {
    return { key: envGoogle, source: "GOOGLE_API_KEY", ...envGoogleInfo };
  }

  // 5. GOOGLE_GENAI_API_KEY in environment
  const envGenAi = cleanKey(process.env.GOOGLE_GENAI_API_KEY);
  const envGenAiInfo = inspectKey(envGenAi);
  if (envGenAiInfo.isValid) {
    return { key: envGenAi, source: "GOOGLE_GENAI_API_KEY", ...envGenAiInfo };
  }

  // If no valid candidate, report metadata of rejected token if present
  if (stored) return { key: undefined, source: "secrets.json", ...storedInfo };
  if (appDataKey) return { key: undefined, source: "appdata_secrets.json", ...appDataInfo };
  if (envGemini) return { key: undefined, source: "GEMINI_API_KEY", ...envGeminiInfo };
  if (envGoogle) return { key: undefined, source: "GOOGLE_API_KEY", ...envGoogleInfo };

  return {
    key: undefined,
    source: "none",
    credentialClass: "NONE",
    isValid: false,
    prefix: "none",
    masked: "none",
    length: 0,
    isPlaceholder: false,
  };
}

/**
 * Safe logger for key resolution at boot / connection. Never prints full keys or secret characters.
 */
export function logKeyResolution(): void {
  const meta = resolveApiKeyWithMetadata();
  if (meta.isValid && meta.key) {
    console.log(
      `[Auth Resolution] source=${meta.source} credentialClass=${meta.credentialClass} prefix=${meta.prefix} length=${meta.length}`,
    );
  } else {
    console.warn(
      `[Auth Resolution] No valid API key found. source=${meta.source} credentialClass=${meta.credentialClass} prefix=${meta.prefix} length=${meta.length}`,
    );
  }
}

/**
 * Resolve the active Gemini API key.
 * Returns the resolved valid API key or authorization key.
 */
export function getGeminiApiKey(): string | undefined {
  return resolveApiKeyWithMetadata().key;
}

/** Whether any usable key is configured (without revealing it). */
export function hasGeminiApiKey(): boolean {
  return Boolean(getGeminiApiKey());
}

/** Persist a user-supplied key to the per-user secrets file (and sync AppData). */
export function setGeminiApiKey(key: string): void {
  const cleaned = cleanKey(key);
  if (!cleaned) throw new Error("API key must not be empty.");
  if (cleaned.startsWith("ya29.")) {
    throw new Error(
      "Gemini API credential is invalid or expired. Please configure a valid Gemini credential in Settings.",
    );
  }
  if (cleaned.length < 15) throw new Error("API key is too short. Please provide a valid Gemini API key or authorization key.");
  if (isPlaceholderKey(cleaned)) throw new Error("API key appears to be a template placeholder. Please provide a valid Gemini API key.");
  const current = readSecrets();
  current.geminiApiKey = cleaned;
  fs.writeFileSync(SECRETS_FILE, JSON.stringify(current, null, 2), "utf-8");

  // Keep Roaming AppData synchronized
  const appDataFile = getAppDataSecretsFile();
  if (appDataFile && appDataFile !== SECRETS_FILE) {
    try {
      fs.mkdirSync(path.dirname(appDataFile), { recursive: true });
      fs.writeFileSync(appDataFile, JSON.stringify(current, null, 2), "utf-8");
    } catch {}
  }
}

/** Remove the stored key (used by "reset"/sign-out flows). */
export function clearGeminiApiKey(): void {
  const current = readSecrets();
  delete current.geminiApiKey;
  try {
    fs.writeFileSync(SECRETS_FILE, JSON.stringify(current, null, 2), "utf-8");
  } catch {}

  const appDataFile = getAppDataSecretsFile();
  if (appDataFile && appDataFile !== SECRETS_FILE) {
    try {
      fs.writeFileSync(appDataFile, JSON.stringify(current, null, 2), "utf-8");
    } catch {}
  }
}
