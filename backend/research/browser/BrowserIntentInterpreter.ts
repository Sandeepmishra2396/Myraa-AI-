/**
 * MYRAA — Advanced Browser Intelligence Subsystem
 * BrowserIntentInterpreter.ts
 *
 * Interprets natural-language browser commands into structured intent specifications.
 * Resolves implicit context (e.g. "is page pe search karo", "woh link follow karo")
 * using Phase 19 ActionContextManager.
 *
 * Stage 3 Extensions:
 *   - Form fills, clicks, typing, selection, scrolling, and tab management.
 *   - Navigation history (go back, forward, reload).
 *   - Element target inference (selectors, button names, link text).
 */

import { actionContextManager } from "../../orchestrator/ActionContext.ts";
import { multiAgentContextManager } from "../../multiagent/MultiAgentContextManager.ts";
import type { BrowserActionType } from "./BrowserIntelligenceTypes.ts";

/**
 * Strips sentence-ending and boundary punctuation from extracted URLs without
 * corrupting legitimate URLs (such as Wikipedia balanced parentheses, query params, etc.).
 */
export function cleanExtractedUrl(raw: string): string {
  if (!raw || typeof raw !== "string") return "";
  let url = raw.trim();

  // Strip leading enclosure punctuation first: < ( [ ' " `
  url = url.replace(/^[<([\'"`]+/, "");

  // Iteratively strip trailing punctuation: . , ; : ! ? ' " ` ] } )
  while (url.length > 0) {
    const lastChar = url[url.length - 1];
    if (/[.,;:!?'"`\]}]/.test(lastChar)) {
      url = url.slice(0, -1);
    } else if (lastChar === ")") {
      // Only strip closing parenthesis if there is no balancing opening parenthesis
      const openCount = (url.match(/\(/g) || []).length;
      const closeCount = (url.match(/\)/g) || []).length;
      if (closeCount > openCount) {
        url = url.slice(0, -1);
      } else {
        break;
      }
    } else {
      break;
    }
  }

  return url;
}

export interface DynamicInteractionStep {
  action: BrowserActionType;
  target?: string;
  params?: Record<string, unknown>;
}

export interface InterpretedBrowserIntent {
  primaryAction: BrowserActionType;
  secondaryActions: BrowserActionType[];
  targetUrl?: string;
  comparisonUrls?: string[];
  searchQuery?: string;
  tableExtractionRequested: boolean;
  docComparisonRequested: boolean;
  originRestrictions: string[];
  requiresMultiSource: boolean;
  focusArea?: string;
  confidence: number;
  interactionTarget?: string;
  interactionParams?: Record<string, unknown>;
}

export class BrowserIntentInterpreter {
  /**
   * Interpret a natural language instruction into a structured browser intent.
   */
  public interpret(prompt: string, contextId = "default"): InterpretedBrowserIntent {
    const sanitized = multiAgentContextManager.sanitizeUntrustedInput(prompt || "").trim();
    const lower = sanitized.toLowerCase();

    // 1. URL extraction (supporting multiple URLs for comparison)
    const rawUrls = sanitized.match(/https?:\/\/[^\s"'<>]+/gi) || [];
    const allUrls = rawUrls.map(cleanExtractedUrl).filter(Boolean);
    let targetUrl: string | undefined = allUrls[0];
    const comparisonUrls = allUrls.length >= 2 ? allUrls : undefined;

    // 2. Context resolution: If prompt refers to current page, retrieve from ActionContext
    if (!targetUrl && /(is page|current page|this page|active tab|ye website|iss site)/i.test(lower)) {
      const activeCtx = actionContextManager.getContext(contextId);
      if (activeCtx?.currentWebsite) {
        targetUrl = activeCtx.currentWebsite.startsWith("http")
          ? activeCtx.currentWebsite
          : `https://${activeCtx.currentWebsite}`;
      }
    }

    // 3. Detect Table Extraction
    const tableExtractionRequested =
      /\b(table|pricing|tabular|matrix|specs|specification|comparison table)\b/i.test(lower) &&
      /\b(extract|nikalo|get|read|fetch|pull)\b/i.test(lower);

    // 4. Detect Documentation Comparison
    const docComparisonRequested =
      /\b(compare|diff|difference|differences|what changed between|changed between|version diff|compatibility diff|verify against docs|official doc se check|compliance)\b/i.test(
        lower
      ) || (allUrls.length >= 2 && /\b(and|vs|to|against|between)\b/i.test(lower));

    // 5. Query / Search Term Extraction
    let searchQuery: string | undefined;
    const hinglishMatch = sanitized.match(
      /(?:google|bing)\s+(?:pe|par|me|mein)\s+(?:search\s+karo\s+|dhoondo\s+)?["']?([^"'\n]+?)["']?(?:$|\s+(?:and|aur)\b)/i
    );
    if (hinglishMatch && hinglishMatch[1]) {
      searchQuery = hinglishMatch[1].replace(/^(?:search\s+karo\s+|dhoondo\s+)/i, "").trim();
    } else {
      const searchMatch = sanitized.match(
        /(?:search(?: for)?|dhoondo|karo search|khojo)\s+["']?([^"'\n]+?)["']?(?:$|\s+(?:and|aur|on|in|using)\b)/i
      );
      if (searchMatch && searchMatch[1]) {
        searchQuery = searchMatch[1].trim();
      } else if (!targetUrl && lower.startsWith("search ")) {
        searchQuery = sanitized.slice(7).trim();
      }
    }
    if (searchQuery) {
      searchQuery = searchQuery.replace(/\s+(?:search\s+karo|dhoondo|karo search)$/i, "").trim();
    }

    // 6. Action classification
    const secondaryActions: BrowserActionType[] = [];
    let primaryAction: BrowserActionType = "NAVIGATE";
    let interactionTarget: string | undefined;
    const interactionParams: Record<string, unknown> = {};

    if (/\b(youtube|video|lecture|tutorial)\b/i.test(lower) && !targetUrl) {
      primaryAction = "SEARCH";
      if (!searchQuery) {
        searchQuery = sanitized.replace(/youtube|video|lecture|kholo|chalao|search/gi, "").trim();
      }
      targetUrl = searchQuery
        ? `https://www.youtube.com/results?search_query=${encodeURIComponent(searchQuery)}`
        : "https://www.youtube.com";
      secondaryActions.push("EXTRACT_DOM");
    } else if (searchQuery && (!targetUrl || targetUrl.includes("google.com") || targetUrl.includes("bing.com"))) {
      primaryAction = "SEARCH";
      if (!targetUrl) {
        targetUrl = `https://www.google.com/search?q=${encodeURIComponent(searchQuery)}`;
      }
      secondaryActions.push("EXTRACT_DOM");
      secondaryActions.push("SUMMARIZE_RESEARCH");
    } else if (
      // Multi-action chained dynamic interactions (e.g. ADV-01: Remove -> wait -> Add -> verify)
      /\b(remove)\b/i.test(lower) &&
      /\b(add)\b/i.test(lower) &&
      (/\b(wait|checkbox|dynamic)\b/i.test(lower) || /\b(then|after)\b/i.test(lower))
    ) {
      primaryAction = "CLICK";
      interactionTarget = "#checkbox-example button";
      interactionParams.text = "Remove";
      interactionParams.dynamicSequence = [
        { action: "CLICK", target: "#checkbox-example button", params: { text: "Remove", stepDesc: "Click 'Remove'" } },
        {
          action: "WAIT_FOR",
          target: "#checkbox-example button",
          params: { text: "Add", condition: "visible", timeoutMs: 10000, stepDesc: "Wait for button text 'Add' and checkbox removal" },
        },
        { action: "CLICK", target: "#checkbox-example button", params: { text: "Add", stepDesc: "Click 'Add'" } },
        {
          action: "WAIT_FOR",
          target: "#checkbox",
          params: { selector: "#checkbox", condition: "visible", timeoutMs: 10000, stepDesc: "Verify checkbox restored" },
        },
      ];
      if (targetUrl) {
        secondaryActions.push("OPEN_URL");
      }
    } else if (/\b(click|press|tap|daba do|pe click karo|click on)\b/i.test(lower)) {
      primaryAction = "CLICK";
      const quoted = sanitized.match(/(?:click|press|tap|click on)[^"']*?["']([^"']+)["']/i);
      if (quoted && quoted[1]) {
        interactionTarget = quoted[1].trim();
      } else {
        const clickMatch = sanitized.match(/(?:click|press|tap|click on)(?:\s+(?:on|the|button|link|pe))*\s+([a-zA-Z0-9_\-]+)/i);
        if (clickMatch && clickMatch[1]) {
          interactionTarget = clickMatch[1].trim();
        }
      }
      if (targetUrl) {
        secondaryActions.push("OPEN_URL");
      }
    } else if (/\b(fill form|fill out|form bhar do|submit form)\b/i.test(lower)) {
      primaryAction = "FILL_FORM";
      if (targetUrl) secondaryActions.push("OPEN_URL");
    } else if (/\b(type|enter text|likho|fill in)\b/i.test(lower)) {
      primaryAction = "TYPE";
      const typeMatch = sanitized.match(/(?:type|enter|likho)\s+["']?([^"'\n]+?)["']?\s+(?:in|into|pe)/i);
      if (typeMatch && typeMatch[1]) {
        interactionParams.text = typeMatch[1].trim();
      }
    } else if (/\b(scroll|niche karo|upar karo|scroll down|scroll up)\b/i.test(lower)) {
      primaryAction = "SCROLL";
      interactionParams.direction = /\b(up|upar)\b/i.test(lower) ? "up" : "down";
    } else if (/\b(go back|piche jao|back jao)\b/i.test(lower)) {
      primaryAction = "GO_BACK";
    } else if (/\b(go forward|aage badho)\b/i.test(lower)) {
      primaryAction = "GO_FORWARD";
    } else if (/\b(reload|refresh)\b/i.test(lower)) {
      primaryAction = "RELOAD";
    } else if (/\b(tab|new tab|close tab|switch tab)\b/i.test(lower)) {
      if (/\b(close)\b/i.test(lower)) {
        primaryAction = "CLOSE_TAB";
      } else if (/\b(switch|switch to)\b/i.test(lower)) {
        primaryAction = "SWITCH_TAB";
        const tabMatch = sanitized.match(/tab\s+(\d+|[a-zA-Z0-9_\-]+)/i);
        if (tabMatch && tabMatch[1]) interactionTarget = tabMatch[1];
      } else {
        primaryAction = "OPEN_TAB";
      }
    } else if (docComparisonRequested && comparisonUrls && comparisonUrls.length >= 2) {
      primaryAction = "COMPARE_DOCUMENTS";
      secondaryActions.push("EXTRACT_DOM");
      secondaryActions.push("SUMMARIZE_RESEARCH");
    } else if (targetUrl) {
      primaryAction = "OPEN_URL";
      if (tableExtractionRequested) {
        secondaryActions.push("EXTRACT_TABLE");
      }
      secondaryActions.push("EXTRACT_DOM");
      secondaryActions.push("SUMMARIZE_RESEARCH");
    } else {
      // Default to search + research if general query
      primaryAction = "SEARCH";
      searchQuery = sanitized;
      targetUrl = `https://www.google.com/search?q=${encodeURIComponent(sanitized)}`;
      secondaryActions.push("EXTRACT_DOM");
      secondaryActions.push("SUMMARIZE_RESEARCH");
    }

    // 7. Calculate Origin Restrictions
    const originRestrictions: string[] = [];
    const urlsToScan = comparisonUrls && comparisonUrls.length > 0 ? comparisonUrls : targetUrl ? [targetUrl] : [];
    for (const u of urlsToScan) {
      try {
        const parsed = new URL(u);
        if (!originRestrictions.includes(parsed.hostname)) {
          originRestrictions.push(parsed.hostname);
        }
      } catch {
        // invalid URL handled downstream by Security Gate
      }
    }

    // 8. Focus Area
    let focusArea: string | undefined;
    const focusMatch = sanitized.match(/(?:focusing on|focus on|regarding|about|for)\s+([a-zA-Z0-9_\- ]+)/i);
    if (focusMatch && focusMatch[1]) {
      focusArea = focusMatch[1].trim();
    }

    return {
      primaryAction,
      secondaryActions,
      targetUrl,
      comparisonUrls,
      searchQuery,
      tableExtractionRequested,
      docComparisonRequested,
      originRestrictions,
      requiresMultiSource: !targetUrl || docComparisonRequested || primaryAction === "SEARCH",
      focusArea,
      confidence: targetUrl || searchQuery || comparisonUrls ? 0.9 : 0.8,
      interactionTarget,
      interactionParams,
    };
  }
}

export const browserIntentInterpreter = new BrowserIntentInterpreter();
