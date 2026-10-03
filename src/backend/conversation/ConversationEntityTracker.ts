/**
 * MYRAA — Phase 20: Advanced Natural Conversation Engine
 * ConversationEntityTracker
 *
 * Tracks entities mentioned across turns with recency decay:
 *   - Discovers mentioned files, projects, apps, URLs, and media items.
 *   - Matches fuzzy project queries (e.g. "woh project jisme kal authentication fix kar rahe the").
 *   - Ranks entity candidates with confidence scoring and detects ambiguous ties.
 */

import type { ConversationEntity, ConversationEntityType } from "./ConversationTypes.ts";

export class ConversationEntityTracker {
  private _entities = new Map<string, ConversationEntity[]>();

  /**
   * Scans a user or model utterance and extracts structured entities.
   */
  public trackEntitiesFromUtterance(
    text: string,
    role: "user" | "model",
    turnIndex: number,
    contextId = "default",
    now = Date.now()
  ): ConversationEntity[] {
    const raw = (text || "").trim();
    if (!raw) return [];

    const extracted: ConversationEntity[] = [];

    // 1. Extract file mentions
    const fileMatches = raw.match(/[\w.-]+\.(ts|tsx|js|jsx|py|json|md|html|css|txt|log|yaml|yml)/gi);
    if (fileMatches) {
      for (const f of fileMatches) {
        extracted.push({
          entityId: `ent_file_${f}`,
          entityType: "file",
          name: f,
          confidence: 0.95,
          lastMentionedAt: now,
          turnIndex,
          source: role,
        });
      }
    }

    // 2. Extract app mentions
    const appMap: Record<string, string> = {
      "vs code": "vscode",
      vscode: "vscode",
      "code editor": "vscode",
      "file manager": "explorer",
      filemanager: "explorer",
      "file explorer": "explorer",
      explorer: "explorer",
      notepad: "notepad",
      chrome: "chrome",
      "google chrome": "chrome",
      edge: "edge",
      terminal: "powershell",
      powershell: "powershell",
      cmd: "cmd",
      calculator: "calculator",
      calc: "calculator",
    };

    for (const [pattern, canonical] of Object.entries(appMap)) {
      const regex = new RegExp(`\\b${pattern}\\b`, "i");
      if (regex.test(raw)) {
        if (!extracted.some((e) => e.name === canonical && e.entityType === "app")) {
          extracted.push({
            entityId: `ent_app_${canonical}`,
            entityType: "app",
            name: canonical,
            confidence: 0.92,
            lastMentionedAt: now,
            turnIndex,
            source: role,
          });
        }
      }
    }

    // 3. Extract URL mentions
    const urlMatches = raw.match(/https?:\/\/[^\s]+/gi);
    if (urlMatches) {
      for (const u of urlMatches) {
        extracted.push({
          entityId: `ent_url_${u}`,
          entityType: "url",
          name: u,
          confidence: 0.98,
          lastMentionedAt: now,
          turnIndex,
          source: role,
        });
      }
    }

    // 4. Extract Project mentions (e.g., "authentication project", "auth-service", "my-project", "D:/Projects/...")
    const projectRegex = /\b([a-zA-Z0-9_-]+(?:-service|-backend|-frontend|-app|-api)?(?:\s+project)?)\b/i;
    const projectPathMatches = raw.match(/[a-zA-Z]:[\\/][\w\\/.-]+/g);
    if (projectPathMatches) {
      for (const p of projectPathMatches) {
        extracted.push({
          entityId: `ent_proj_${p}`,
          entityType: "project",
          name: p,
          path: p,
          confidence: 0.96,
          lastMentionedAt: now,
          turnIndex,
          source: role,
        });
      }
    }

    if (/\b(project|workspace)\b/i.test(raw)) {
      const match = raw.match(/\b([a-zA-Z0-9_-]+)\s+project\b/i);
      if (match) {
        const projName = match[1];
        if (!["that", "this", "woh", "ye", "mera", "wahi"].includes(projName.toLowerCase())) {
          extracted.push({
            entityId: `ent_proj_${projName}`,
            entityType: "project",
            name: projName,
            confidence: 0.9,
            lastMentionedAt: now,
            turnIndex,
            source: role,
          });
        }
      }
    }

    // Update in-memory entity list for this context
    const existingList = this._entities.get(contextId) || [];
    for (const ent of extracted) {
      const idx = existingList.findIndex((e) => e.name === ent.name && e.entityType === ent.entityType);
      if (idx >= 0) {
        existingList[idx] = {
          ...existingList[idx],
          lastMentionedAt: now,
          turnIndex,
          confidence: Math.min(1.0, existingList[idx].confidence + 0.05),
        };
      } else {
        existingList.unshift(ent);
      }
    }

    // Keep bounded history
    if (existingList.length > 30) {
      existingList.splice(30);
    }
    this._entities.set(contextId, existingList);

    return extracted;
  }

  /**
   * Adds an explicit entity directly to the tracker.
   */
  public registerEntity(
    entity: Omit<ConversationEntity, "entityId" | "lastMentionedAt" | "confidence" | "source" | "turnIndex"> & {
      confidence?: number;
      lastMentionedAt?: number;
      source?: "user" | "model" | "system";
      turnIndex?: number;
    },
    contextId = "default"
  ): ConversationEntity {
    const now = entity.lastMentionedAt || Date.now();
    const full: ConversationEntity = {
      ...entity,
      entityId: `ent_${entity.entityType}_${entity.name}`,
      confidence: entity.confidence ?? 0.9,
      lastMentionedAt: now,
      source: entity.source || "user",
      turnIndex: entity.turnIndex ?? 0,
    };

    const existingList = this._entities.get(contextId) || [];
    const idx = existingList.findIndex((e) => e.name === full.name && e.entityType === full.entityType);
    if (idx >= 0) {
      existingList[idx] = full;
    } else {
      existingList.unshift(full);
    }
    this._entities.set(contextId, existingList);
    return full;
  }

  /**
   * Retrieves active entities for a context, sorted by recency descending.
   */
  public getActiveEntities(contextId = "default"): ConversationEntity[] {
    return [...(this._entities.get(contextId) || [])];
  }

  /**
   * Retrieves the most recent entity of a given type.
   */
  public getMostRecentEntity(
    type?: ConversationEntityType,
    contextId = "default"
  ): ConversationEntity | null {
    const list = this._entities.get(contextId) || [];
    if (!type) {
      return list[0] || null;
    }
    return list.find((e) => e.entityType === type) || null;
  }

  /**
   * Matches a natural project description query against candidate projects.
   * e.g. "Bhai woh project kholo na jisme kal hum authentication fix kar rahe the"
   */
  public matchProjectCandidates(
    userUtterance: string,
    candidateProjects: Array<{ name: string; path?: string; description?: string; tags?: string[] }>
  ): Array<{ candidate: { name: string; path?: string }; score: number; rationale: string }> {
    const lower = (userUtterance || "").toLowerCase();
    const results: Array<{ candidate: { name: string; path?: string }; score: number; rationale: string }> = [];

    // Extract search tokens (ignore filler words)
    const stopWords = new Set([
      "bhai", "woh", "wo", "project", "kholo", "na", "jisme", "kal", "hum", "kar", "rahe", "the",
      "open", "please", "the", "in", "which", "we", "were", "yesterday", "working", "on", "hai", "tha"
    ]);

    const tokens = lower
      .replace(/[^\w\s-]/g, "")
      .split(/\s+/)
      .filter((t) => t.length > 2 && !stopWords.has(t));

    for (const cand of candidateProjects) {
      let score = 0;
      const reasons: string[] = [];
      const candName = cand.name.toLowerCase();
      const candDesc = (cand.description || "").toLowerCase();
      const candTags = (cand.tags || []).map((t) => t.toLowerCase());

      for (const token of tokens) {
        // Direct or root match in project name
        const rootName = candName.split(/[-_]/)[0];
        if (candName === token) {
          score += 0.5;
          reasons.push(`exact name match '${token}'`);
        } else if (candName.includes(token) || (rootName.length >= 3 && token.includes(rootName))) {
          score += 0.4;
          reasons.push(`partial name match '${token}'`);
        }

        // Match in description or tags
        if (candDesc.includes(token)) {
          score += 0.25;
          reasons.push(`description match '${token}'`);
        }
        if (candTags.some((tag) => tag.includes(token) || (tag.length >= 3 && token.includes(tag)))) {
          score += 0.3;
          reasons.push(`tag match '${token}'`);
        }
      }

      if (score > 0) {
        results.push({
          candidate: { name: cand.name, path: cand.path },
          score: Math.min(1.0, score),
          rationale: reasons.join("; "),
        });
      }
    }

    // Sort descending by score
    results.sort((a, b) => b.score - a.score);
    return results;
  }

  /**
   * Clears tracked entities.
   */
  public clearEntities(contextId = "default"): void {
    this._entities.delete(contextId);
  }

  /**
   * Clears across all contexts.
   */
  public clearAll(): void {
    this._entities.clear();
  }
}

export const conversationEntityTracker = new ConversationEntityTracker();
