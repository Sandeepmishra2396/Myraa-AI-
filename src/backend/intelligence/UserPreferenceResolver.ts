/**
 * MYRAA — UserPreferenceResolver
 *
 * Resolves user defaults and preferences (editor, workspace, browser, volume, language)
 * while strictly enforcing the golden rule:
 * "Never let old memory override a clear current instruction."
 */

import type { UserPreferenceProfile } from "./IntelligenceTypes.ts";

const DEFAULT_WORKSPACE = process.env.SORA_WORKSPACE_DIR || process.cwd();

export class UserPreferenceResolver {
  private _preferences: Map<string, UserPreferenceProfile> = new Map();

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
    return { ...def };
  }

  /**
   * Update preferences for a user / session.
   */
  public updatePreferences(
    userIdOrUpdates: string | Partial<UserPreferenceProfile> = "default",
    updates?: Partial<UserPreferenceProfile>
  ): UserPreferenceProfile {
    const userId = typeof userIdOrUpdates === "string" ? userIdOrUpdates : "default";
    const delta = typeof userIdOrUpdates === "object" ? userIdOrUpdates : updates || {};
    const current = this.getPreferences(userId);
    const updated: UserPreferenceProfile = {
      ...current,
      ...delta,
    };
    this._preferences.set(userId, updated);
    return { ...updated };
  }

  /**
   * Reset preferences to defaults.
   */
  public resetPreferences(userId?: string): void {
    if (userId) {
      this._preferences.delete(userId);
    } else {
      this._preferences.clear();
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
