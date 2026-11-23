/**
 * MYRAA — Advanced Browser Intelligence Subsystem
 * BrowserElementTargeter.ts
 *
 * Discovers and targets DOM and accessibility-tree elements for Stage 3: Browser Control.
 * Supports CSS selectors, XPath, text matching, ARIA roles, and accessibility attributes.
 *
 * Invariants:
 *   - Resilient against stale elements, dynamic IDs, and DOM mutations via fallback heuristics.
 *   - Recovers from navigation changes and missing primary selectors.
 *   - Distinguishes clickable/interactive elements from static text.
 */

import type {
  ElementTargetSpec,
  ElementTargetingStrategy,
  TargetedElementResult,
} from "./BrowserIntelligenceTypes.ts";

export class BrowserElementTargeter {
  /**
   * Resolves an element target against an HTML string or page representation.
   */
  public resolveElement(
    html: string,
    target: string | ElementTargetSpec
  ): TargetedElementResult {
    if (!html || typeof html !== "string") {
      return { found: false, error: "EMPTY_DOM: Provided HTML content is empty." };
    }

    const spec = typeof target === "string" ? this._inferTargetSpec(target) : target;

    // 1. Attempt Primary Strategy
    const primaryResult = this._attemptStrategy(html, spec.strategy, spec.value, spec);
    if (primaryResult.found) {
      return primaryResult;
    }

    // 2. Attempt Explicit Fallback Strategies
    if (spec.fallbackStrategies && spec.fallbackStrategies.length > 0) {
      for (const fallback of spec.fallbackStrategies) {
        const fallbackRes = this._attemptStrategy(html, fallback.strategy, fallback.value, spec);
        if (fallbackRes.found) {
          return {
            ...fallbackRes,
            staleRecovered: true,
          };
        }
      }
    }

    // 3. Attempt Resilient Automatic Fallbacks (Stale Element Recovery)
    const autoFallback = this._attemptAutomaticFallback(html, spec);
    if (autoFallback.found) {
      return {
        ...autoFallback,
        staleRecovered: true,
      };
    }
    if (autoFallback.error && autoFallback.error.startsWith("AMBIGUOUS_MATCH")) {
      return autoFallback;
    }

    return {
      found: false,
      error: `ELEMENT_NOT_FOUND: Could not locate element with ${spec.strategy}='${spec.value}'. Stale element recovery exhausted.`,
    };
  }

  // ---------------------------------------------------------------------------
  // Strategy Execution
  // ---------------------------------------------------------------------------

  private _attemptStrategy(
    html: string,
    strategy: ElementTargetingStrategy,
    value: string,
    spec: ElementTargetSpec
  ): TargetedElementResult {
    switch (strategy) {
      case "CSS_SELECTOR":
        return this._matchCssSelector(html, value);

      case "TEXT_MATCH":
        return this._matchText(html, value);

      case "ARIA_ROLE":
        return this._matchAriaRole(html, value, spec.requiredText);

      case "ACCESSIBILITY_ID":
        return this._matchAccessibilityId(html, value);

      case "XPATH":
        return this._matchXPath(html, value);

      default:
        return { found: false, error: `UNSUPPORTED_STRATEGY: ${strategy}` };
    }
  }

  private _matchCssSelector(html: string, selector: string): TargetedElementResult {
    const trimmedSel = selector.trim();

    // 0. Scoped / Descendant selector (e.g. "#checkbox-example button", "form#checkbox-example input")
    if (trimmedSel.includes(" ")) {
      const parts = trimmedSel.split(/\s+/);
      const parentSelector = parts[0];
      const childSelector = parts.slice(1).join(" ");
      const parentRes = this._matchCssSelector(html, parentSelector);
      if (parentRes.found) {
        const parentHtml = (parentRes as any).matchedHtml || html;
        const childRes = this._matchCssSelector(parentHtml, childSelector);
        if (childRes.found) {
          return {
            ...childRes,
            selector: trimmedSel,
          };
        }
      }
    }

    // 1. Match by ID with optional tag (e.g. #my-id or form#my-id)
    const idMatch = selector.match(/^(?:([a-zA-Z0-9]+))?#([a-zA-Z0-9_\-]+)$/);
    if (idMatch) {
      const tag = idMatch[1] || "[a-zA-Z0-9]+";
      const id = idMatch[2];
      const regex = new RegExp(`<(${tag})[^>]*\\bid=["']${id}["'][^>]*>(?:([\\s\\S]*?)<\\/\\1>)?`, "i");
      const match = html.match(regex);
      if (match) {
        return this._buildElementResult("CSS_SELECTOR", selector, match[1], match[0], match[2] || "");
      }
    }

    // 2. Match by Class with optional tag (.my-class or button.my-class)
    const classMatch = selector.match(/^(?:([a-zA-Z0-9]+))?\.([a-zA-Z0-9_\-]+)$/);
    if (classMatch) {
      const tag = classMatch[1] || "[a-zA-Z0-9]+";
      const className = classMatch[2];
      const regex = new RegExp(`<(${tag})[^>]*\\bclass=["'][^"']*\\b${className}\\b[^"']*["'][^>]*>(?:([\\s\\S]*?)<\\/\\1>)?`, "i");
      const match = html.match(regex);
      if (match) {
        return this._buildElementResult("CSS_SELECTOR", selector, match[1], match[0], match[2] || "");
      }
    }

    // 3. Match tag + attribute e.g. input[name="search"], button[type="submit"], input[type="checkbox"]
    const tagAttrMatch = selector.match(/^([a-zA-Z0-9]+)\[([a-zA-Z0-9_\-]+)(?:=(?:["']?)([^"'\]]+)(?:["']?))?\]$/);
    if (tagAttrMatch) {
      const [, tag, attr, attrVal] = tagAttrMatch;
      const regex = attrVal
        ? new RegExp(`<${tag}[^>]*\\b${attr}=["']${attrVal}["'][^>]*>(?:([\\s\\S]*?)<\\/${tag}>)?`, "i")
        : new RegExp(`<${tag}[^>]*\\b${attr}\\b[^>]*>(?:([\\s\\S]*?)<\\/${tag}>)?`, "i");
      const match = html.match(regex);
      if (match) {
        return this._buildElementResult("CSS_SELECTOR", selector, tag, match[0], match[1] || "");
      }
    }

    // 4. Match plain tag name (button, input, a, form)
    if (/^[a-zA-Z0-9]+$/.test(selector)) {
      const regex = new RegExp(`<${selector}[^>]*>(?:([\\s\\S]*?)<\\/${selector}>)?`, "i");
      const match = html.match(regex);
      if (match) {
        return this._buildElementResult("CSS_SELECTOR", selector, selector, match[0], match[1] || "");
      }
    }

    return { found: false };
  }

  private _matchText(html: string, text: string): TargetedElementResult {
    const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    
    // 1. Try matching innermost element (containing no inner tags)
    const leafRegex = new RegExp(
      `<([a-zA-Z0-9]+)([^>]*)>([^<]*?${escaped}[^<]*?)<\\/\\1>`,
      "gi"
    );
    const leafMatch = leafRegex.exec(html);
    if (leafMatch) {
      return this._buildElementResult("TEXT_MATCH", text, leafMatch[1], leafMatch[0], leafMatch[3]);
    }

    // 2. Fall back to shortest enclosing element whose visible text actually includes the searched text
    const broadRegex = new RegExp(
      `<([a-zA-Z0-9]+)([^>]*)>([\\s\\S]*?)<\\/\\1>`,
      "gi"
    );
    let bestMatch: RegExpExecArray | null = null;
    let shortest = Infinity;
    let match: RegExpExecArray | null;

    while ((match = broadRegex.exec(html)) !== null) {
      const innerContent = match[3];
      const visibleText = innerContent.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
      const textRegex = new RegExp(escaped, "i");
      if (textRegex.test(visibleText) && innerContent.length < shortest) {
        shortest = innerContent.length;
        bestMatch = match;
      }
    }

    if (bestMatch) {
      return this._buildElementResult("TEXT_MATCH", text, bestMatch[1], bestMatch[0], bestMatch[3]);
    }

    // Also match input with value="text" or placeholder="text"
    const inputRegex = new RegExp(
      `<input[^>]*\\b(?:value|placeholder)=["'][^"']*${escaped}[^"']*["'][^>]*>`,
      "i"
    );
    const inputMatch = html.match(inputRegex);
    if (inputMatch) {
      return this._buildElementResult("TEXT_MATCH", text, "input", inputMatch[0], "");
    }

    return { found: false };
  }

  private _matchAriaRole(html: string, role: string, requiredText?: string): TargetedElementResult {
    const roleRegex = new RegExp(`<([a-zA-Z0-9]+)[^>]*\\brole=["']${role}["'][^>]*>([\\s\\S]*?)<\\/\\1>`, "gi");
    let match: RegExpExecArray | null;

    while ((match = roleRegex.exec(html)) !== null) {
      const innerText = match[2].replace(/<[^>]+>/g, "").trim();
      if (!requiredText || innerText.toLowerCase().includes(requiredText.toLowerCase())) {
        return this._buildElementResult("ARIA_ROLE", role, match[1], match[0], match[2]);
      }
    }

    // Native semantic tags matching the role
    const nativeRoleMap: Record<string, string> = {
      button: "button",
      link: "a",
      textbox: "input",
      checkbox: "input",
      heading: "h1",
    };

    const nativeTag = nativeRoleMap[role.toLowerCase()];
    if (nativeTag) {
      return this._matchCssSelector(html, nativeTag);
    }

    return { found: false };
  }

  private _matchAccessibilityId(html: string, accId: string): TargetedElementResult {
    const escaped = accId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(
      `<([a-zA-Z0-9]+)[^>]*\\b(?:data-testid|aria-label|aria-labelledby|id)=["']${escaped}["'][^>]*>(?:([\\s\\S]*?)<\\/\\1>)?`,
      "i"
    );
    const match = html.match(regex);
    if (match) {
      return this._buildElementResult("ACCESSIBILITY_ID", accId, match[1], match[0], match[2] || "");
    }
    return { found: false };
  }

  private _matchXPath(html: string, xpath: string): TargetedElementResult {
    // Basic text-based XPath conversion: //button[contains(text(), 'Submit')] or //*[@id='search']
    const textXPath = xpath.match(/\/\/(?:[a-zA-Z0-9*]+)\[contains\((?:text\(\)|.),\s*['"]([^'"]+)['"]\)/i);
    if (textXPath) {
      return this._matchText(html, textXPath[1]);
    }

    const idXPath = xpath.match(/\/\/(?:[a-zA-Z0-9*]+)\[@id=['"]([^'"]+)['"]\]/i);
    if (idXPath) {
      return this._matchCssSelector(html, `#${idXPath[1]}`);
    }

    return { found: false };
  }

  // ---------------------------------------------------------------------------
  // Stale Element Recovery Heuristics
  // ---------------------------------------------------------------------------

  private _attemptAutomaticFallback(html: string, spec: ElementTargetSpec): TargetedElementResult {
    // Heuristic 1: Semantic interactive button / action fallback
    // e.g. spec.value is "#add-button" or "#remove-button" or "button#add"
    const rawVal = spec.value.replace(/^[.#]/, "").trim();
    const tokens = rawVal.split(/[-_\s]+/).map(t => t.toLowerCase()).filter(Boolean);
    const genericWords = new Set(["button", "btn", "action", "input", "elem", "element", "link"]);
    const actionWords = tokens.filter(t => !genericWords.has(t));

    if (actionWords.length > 0) {
      // Find all interactive candidate elements (button, input[type=button/submit], role=button, etc.)
      const candidates: TargetedElementResult[] = [];
      const buttonRegex = /<button[^>]*>([\s\S]*?)<\/button>/gi;
      let bMatch: RegExpExecArray | null;
      while ((bMatch = buttonRegex.exec(html)) !== null) {
        const fullTag = bMatch[0];
        const innerText = bMatch[1].replace(/<[^>]+>/g, " ").trim();
        const attrs = this._extractAttributes(fullTag);
        const candidateText = (innerText || attrs["aria-label"] || attrs.value || "").toLowerCase();

        const matchesAction = actionWords.some(w => {
          const wordRegex = new RegExp(`\\b${w}\\b`, "i");
          return wordRegex.test(candidateText);
        });

        if (matchesAction) {
          candidates.push(this._buildElementResult("TEXT_MATCH", spec.value, "button", fullTag, bMatch[1]));
        }
      }

      // Also check inputs with submit/button types
      const inputRegex = /<input[^>]*\btype=["'](?:button|submit)["'][^>]*>/gi;
      let iMatch: RegExpExecArray | null;
      while ((iMatch = inputRegex.exec(html)) !== null) {
        const fullTag = iMatch[0];
        const attrs = this._extractAttributes(fullTag);
        const candidateText = (attrs.value || attrs["aria-label"] || "").toLowerCase();
        const matchesAction = actionWords.some(w => new RegExp(`\\b${w}\\b`, "i").test(candidateText));
        if (matchesAction) {
          candidates.push(this._buildElementResult("TEXT_MATCH", spec.value, "input", fullTag, ""));
        }
      }

      if (candidates.length === 1) {
        return candidates[0];
      }
      if (candidates.length > 1) {
        return {
          found: false,
          error: `AMBIGUOUS_MATCH: Multiple interactive elements (${candidates.length}) matched semantic fallback for '${spec.value}'. Safe element targeting rejects ambiguous matches.`,
        };
      }
    }

    // Heuristic 2: If CSS selector contained a class or id, extract candidate text and search for it
    if (spec.strategy === "CSS_SELECTOR") {
      const textCandidate = spec.value.replace(/^[.#]/, "").replace(/[-_]/g, " ");
      if (textCandidate.length > 3) {
        const textRes = this._matchText(html, textCandidate);
        if (textRes.found) return textRes;
      }
    }

    // Heuristic 3: If requiredText is present, use TEXT_MATCH
    if (spec.requiredText) {
      const textRes = this._matchText(html, spec.requiredText);
      if (textRes.found) return textRes;
    }

    // Heuristic 4: Check for accessibility labels / data-testid
    const cleanId = spec.value.replace(/[^a-zA-Z0-9]/g, "");
    if (cleanId.length > 2) {
      const accRes = this._matchAccessibilityId(html, cleanId);
      if (accRes.found) return accRes;
    }

    return { found: false };
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private _inferTargetSpec(target: string): ElementTargetSpec {
    const trimmed = target.trim();

    if (trimmed.startsWith("//") || trimmed.startsWith("/html")) {
      return { strategy: "XPATH", value: trimmed };
    }
    if (
      trimmed.startsWith("#") ||
      trimmed.startsWith(".") ||
      trimmed.includes("[") ||
      trimmed.includes(">") ||
      trimmed.includes(" ")
    ) {
      return { strategy: "CSS_SELECTOR", value: trimmed };
    }
    if (trimmed.startsWith("role=")) {
      return { strategy: "ARIA_ROLE", value: trimmed.replace(/^role=/, "") };
    }
    if (trimmed.startsWith("data-testid=") || trimmed.startsWith("aria-label=")) {
      return { strategy: "ACCESSIBILITY_ID", value: trimmed.replace(/^[^=]+=/, "") };
    }

    // By default, treat human strings as TEXT_MATCH with CSS_SELECTOR fallback
    return {
      strategy: "TEXT_MATCH",
      value: trimmed,
      fallbackStrategies: [
        { strategy: "CSS_SELECTOR", value: trimmed },
        { strategy: "ACCESSIBILITY_ID", value: trimmed },
      ],
    };
  }

  private _buildElementResult(
    strategyUsed: ElementTargetingStrategy,
    selector: string,
    tagName: string,
    fullTagHtml: string,
    innerContent: string
  ): TargetedElementResult {
    const attributes = this._extractAttributes(fullTagHtml);
    const visibleText = innerContent.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

    const tagLower = tagName.toLowerCase();
    const isInteractive =
      ["button", "a", "input", "select", "textarea"].includes(tagLower) ||
      attributes.role === "button" ||
      Boolean(attributes.onclick) ||
      Boolean(attributes.href);

    const isHidden =
      attributes.hidden !== undefined ||
      (attributes.style && /display\s*:\s*none|visibility\s*:\s*hidden/i.test(attributes.style));

    const result: TargetedElementResult & { matchedHtml?: string } = {
      found: true,
      strategyUsed,
      selector,
      tagName: tagLower,
      text: visibleText || attributes.placeholder || attributes.value || attributes["aria-label"] || "",
      attributes,
      isClickable: isInteractive && !isHidden,
      isVisible: !isHidden,
    };
    result.matchedHtml = fullTagHtml;
    return result;
  }

  private _extractAttributes(tagHtml: string): Record<string, string> {
    const attrs: Record<string, string> = {};
    const attrRegex = /([a-zA-Z0-9_\-]+)(?:=(?:["'])([^"']*?)(?:["']))?/g;

    const openingTag = tagHtml.match(/<[a-zA-Z0-9]+([^>]*)>/);
    if (!openingTag) return attrs;

    let match: RegExpExecArray | null;
    while ((match = attrRegex.exec(openingTag[1])) !== null) {
      const key = match[1].toLowerCase();
      const val = match[2] !== undefined ? match[2] : "true";
      attrs[key] = val;
    }

    return attrs;
  }
}

export const browserElementTargeter = new BrowserElementTargeter();
