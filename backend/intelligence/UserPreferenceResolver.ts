/**
 * MYRAA — UserPreferenceResolver
 *
 * Resolves user defaults and preferences (editor, workspace, browser, volume, language)
 * while strictly enforcing the golden rule:
 * "Never let old memory override a clear current instruction."
 */

import type { UserPreferenceProfile } from "./IntelligenceTypes.ts";

const DEFAULT_WORKSPACE = process.env.SORA_WORKSPACE_DIR || process.cwd();

export type PreferenceProvenanceSource = "default" | "persona" | "cognitive" | "operator" | "api";

export interface PreferenceProvenanceEntry {
  source: PreferenceProvenanceSource;
  actorId: string;
  updatedAt: string;
}

export interface PreferenceUpdateAuthContext {
  source: PreferenceProvenanceSource;
  actorId: string;
  role?: string;
  isLocal?: boolean;
  isStepUpAuthenticated?: boolean;
}

const ALLOWED_PREFERENCE_KEYS = new Set<keyof UserPreferenceProfile>([
  "preferredEditor",
  "preferredWorkspace",
  "preferredBrowser",
  "preferredLanguage",
  "preferredVolume",
  "autoConfirmLowRisk",
  "activeProjectName",
]);

export class UserPreferenceResolver {
  private _preferences: Map<string, UserPreferenceProfile> = new Map();
  private _provenance: Map<string, Partial<Record<keyof UserPreferenceProfile, PreferenceProvenanceEntry>>> = new Map();

  /**
   * Returns default user preference profile.
   */
  private _getDefaultProfile(): UserPreferenceProfile {
    return {
      preferredEditor: "vscode",
      preferredWorkspace: DEFAULT_WORKSPACE,
      preferredBrowser: "chrome",
      preferredLanguage: "hinglish",
      preferredVolume: 80,
      autoConfirmLowRisk: true,
      activeProjectName: "Myraa AI",
    };
  }

  private _recordProvenance(
    userId: string,
    keys: Array<keyof UserPreferenceProfile>,
    source: PreferenceProvenanceSource,
    actorId: string,
  ): void {
    const existing = this._provenance.get(userId) || {};
    const now = new Date().toISOString();
    for (const key of keys) {
      existing[key] = { source, actorId, updatedAt: now };
    }
    this._provenance.set(userId, existing);
  }

  /**
   * Returns provenance metadata for each preference field of a user/session (FINDING-AUD-10).
   */
  public getPreferenceProvenance(
    userId = "default",
  ): Partial<Record<keyof UserPreferenceProfile, PreferenceProvenanceEntry>> {
    const map = this._provenance.get(userId);
    if (!map) return {};
    const copy: Partial<Record<keyof UserPreferenceProfile, PreferenceProvenanceEntry>> = {};
    for (const [k, v] of Object.entries(map)) {
      if (v) copy[k as keyof UserPreferenceProfile] = { ...v };
    }
    return copy;
  }

  /**
   * Get preferences for a user / session.
   */
  public getPreferences(userId = "default"): UserPreferenceProfile {
    const existing = this._preferences.get(userId);
    if (existing) {
      return { ...existing };
    }
    const def = this._getDefaultProfile();
    this._preferences.set(userId, def);
    this._recordProvenance(userId, Array.from(ALLOWED_PREFERENCE_KEYS), "default", "system");
    return { ...def };
  }

  /**
   * Governed preference update with explicit provenance & protected-setting enforcement (FINDING-AUD-10).
   * - Rejects unknown keys or prototype-pollution keys.
   * - Blocks `autoConfirmLowRisk` changes unless caller is an authenticated local admin with step-up auth.
   * - Blocks `preferredWorkspace` changes unless caller is an authenticated local admin operator
   *   and the workspace path is non-empty without traversal/null-byte anomalies.
   */
  public updatePreferencesWithProvenance(
    userId: string,
    updates: Partial<UserPreferenceProfile>,
    auth: PreferenceUpdateAuthContext,
  ): UserPreferenceProfile {
    if (!updates || typeof updates !== "object" || Array.isArray(updates)) {
      throw new Error("INVALID_PREFERENCES: Preferences payload must be a plain object.");
    }

    const dangerousKeys = ["__proto__", "constructor", "prototype"];
    for (const dk of dangerousKeys) {
      if (Object.prototype.hasOwnProperty.call(updates, dk)) {
        throw new Error(`INVALID_PREFERENCES: Forbidden key '${dk}' detected.`);
      }
    }

    const keys = Object.keys(updates) as Array<keyof UserPreferenceProfile>;
    for (const key of keys) {
      if (!ALLOWED_PREFERENCE_KEYS.has(key)) {
        throw new Error(`INVALID_PREFERENCES: Unknown preference key '${String(key)}'.`);
      }
    }

    if ("autoConfirmLowRisk" in updates) {
      const canModifyAutoConfirm =
        auth.source === "operator" &&
        auth.role === "admin" &&
        Boolean(auth.isLocal) &&
        Boolean(auth.isStepUpAuthenticated);
      if (!canModifyAutoConfirm) {
        throw new Error(
          "PROTECTED_PREFERENCE: Modifying 'autoConfirmLowRisk' requires local step-up authenticated admin operator authorization.",
        );
      }
      if (typeof updates.autoConfirmLowRisk !== "boolean") {
        throw new Error("INVALID_PREFERENCES: 'autoConfirmLowRisk' must be a boolean.");
      }
    }

    if ("preferredWorkspace" in updates) {
      const canModifyWorkspace =
        auth.source === "operator" &&
        auth.role === "admin" &&
        Boolean(auth.isLocal);
      if (!canModifyWorkspace) {
        throw new Error(
          "PROTECTED_PREFERENCE: Modifying 'preferredWorkspace' requires authorized local admin operator preference update.",
        );
      }
      const ws = updates.preferredWorkspace;
      if (typeof ws !== "string" || ws.trim().length === 0 || ws.length > 512 || ws.includes("\0") || ws.includes("..")) {
        throw new Error("INVALID_PREFERENCES: 'preferredWorkspace' must be a valid non-traversal path string.");
      }
    }

    if ("preferredVolume" in updates) {
      const vol = updates.preferredVolume;
      if (typeof vol !== "number" || !Number.isFinite(vol) || vol < 0 || vol > 100) {
        throw new Error("INVALID_PREFERENCES: 'preferredVolume' must be a number between 0 and 100.");
      }
    }

    for (const strKey of ["preferredEditor", "preferredBrowser", "preferredLanguage", "activeProjectName"] as const) {
      if (strKey in updates) {
        const val = updates[strKey];
        if (typeof val !== "string" || val.trim().length === 0 || val.length > 128) {
          throw new Error(`INVALID_PREFERENCES: '${strKey}' must be a non-empty string (max 128 chars).`);
        }
      }
    }

    const current = this.getPreferences(userId);
    const updated: UserPreferenceProfile = {
      ...current,
      ...updates,
    };
    this._preferences.set(userId, updated);
    this._recordProvenance(userId, keys, auth.source, auth.actorId);
    return { ...updated };
  }

  /**
   * Update preferences for a user / session (internal/in-process callers).
   */
  public updatePreferences(
    userIdOrUpdates: string | Partial<UserPreferenceProfile> = "default",
    updates?: Partial<UserPreferenceProfile>,
    provenanceSource: PreferenceProvenanceSource = "operator",
    actorId = "system",
  ): UserPreferenceProfile {
    const userId = typeof userIdOrUpdates === "string" ? userIdOrUpdates : "default";
    const delta = typeof userIdOrUpdates === "object" ? userIdOrUpdates : updates || {};
    const current = this.getPreferences(userId);
    const safeDelta: Partial<UserPreferenceProfile> = {};
    const changedKeys: Array<keyof UserPreferenceProfile> = [];
    for (const k of Object.keys(delta) as Array<keyof UserPreferenceProfile>) {
      if (ALLOWED_PREFERENCE_KEYS.has(k)) {
        (safeDelta as any)[k] = (delta as any)[k];
        changedKeys.push(k);
      }
    }
    const updated: UserPreferenceProfile = {
      ...current,
      ...safeDelta,
    };
    this._preferences.set(userId, updated);
    if (changedKeys.length > 0) {
      this._recordProvenance(userId, changedKeys, provenanceSource, actorId);
    }
    return { ...updated };
  }

  /**
   * Reset preferences to defaults.
   */
  public resetPreferences(userId?: string): void {
    if (userId) {
      this._preferences.delete(userId);
      this._provenance.delete(userId);
    } else {
      this._preferences.clear();
      this._provenance.clear();
    }
  }

  /**
   * Load and sync preferences from CompanionPersonaStore (Stage 10 Phase 1).
   */
  public async loadFromPersonaStore(
    store?: import("../companion/CompanionPersonaStore.ts").CompanionPersonaStore,
    userId = "default",
  ): Promise<UserPreferenceProfile> {
    try {
      const personaStore =
        store ||
        (await import("../companion/CompanionPersonaStore.ts")).companionPersonaStore;
      const persona = await personaStore.getPersona();
      if (persona?.preferredLanguage) {
        return this.updatePreferences(
          userId,
          { preferredLanguage: persona.preferredLanguage },
          "persona",
          "companion_persona_store",
        );
      }
    } catch (err) {
      console.warn("[UserPreferenceResolver] Failed to load from persona store:", err);
    }
    return this.getPreferences(userId);
  }

  /**
   * Synchronize learned cognitive preferences into the profile.
   */
  public syncCognitivePreferences(
    memories: Array<{ key: string; value: any; status: string }>,
    userId = "default"
  ): void {
    for (const mem of memories) {
      if (mem.status !== "active") continue;
      if (mem.key === "workflow.preferred_editor" && typeof mem.value === "string") {
        this.updatePreferences(userId, { preferredEditor: mem.value }, "cognitive", "cognitive_brain");
      } else if (mem.key === "comm.language" && typeof mem.value === "string") {
        this.updatePreferences(userId, { preferredLanguage: mem.value }, "cognitive", "cognitive_brain");
      }
    }
  }

  /**
   * Resolves whether the user's explicit utterance overrides a stored preference.
   * If user explicitly says "Cursor kholo" or "open in notepad", preference "vscode" MUST NOT override it.
   */
  public resolveEffectiveTarget(
    utterance: string,
    preferenceKey: keyof UserPreferenceProfile,
    userId = "default"
  ): { target: string; isExplicitOverride: boolean; source: "explicit" | "preference" } {
    const lower = (utterance || "").toLowerCase();
    const prefs = this.getPreferences(userId);

    if (preferenceKey === "preferredEditor") {
      if (/\b(cursor|notepad|sublime|atom|webstorm|intellij|vim|neovim|emacs)\b/i.test(lower)) {
        const match = lower.match(/\b(cursor|notepad|sublime|atom|webstorm|intellij|vim|neovim|emacs)\b/i);
        return {
          target: match ? match[1].toLowerCase() : "vscode",
          isExplicitOverride: true,
          source: "explicit",
        };
      }
      if (/\b(vs code|vscode|code editor)\b/i.test(lower)) {
        return {
          target: "vscode",
          isExplicitOverride: true,
          source: "explicit",
        };
      }
      return {
        target: prefs.preferredEditor,
        isExplicitOverride: false,
        source: "preference",
      };
    }

    if (preferenceKey === "preferredBrowser") {
      if (/\b(edge|firefox|brave|safari|opera)\b/i.test(lower)) {
        const match = lower.match(/\b(edge|firefox|brave|safari|opera)\b/i);
        return {
          target: match ? match[1].toLowerCase() : "chrome",
          isExplicitOverride: true,
          source: "explicit",
        };
      }
      return {
        target: prefs.preferredBrowser,
        isExplicitOverride: false,
        source: "preference",
      };
    }

    return {
      target: String(prefs[preferenceKey] ?? ""),
      isExplicitOverride: false,
      source: "preference",
    };
  }
}

export const userPreferenceResolver = new UserPreferenceResolver();
