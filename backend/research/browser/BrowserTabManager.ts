/**
 * MYRAA — Advanced Browser Intelligence Subsystem
 * BrowserTabManager.ts
 *
 * Manages active browser tabs, active-tab context, per-tab history stacks,
 * and lifecycle transitions for Stage 3: Browser Control.
 *
 * Invariants:
 *   - Bounded tab collection (max 10 tabs) to prevent resource exhaustion.
 *   - Clean state fallback when active tab is closed.
 *   - Synchronized history navigation stack (back / forward).
 */

import crypto from "crypto";
import type { BrowserTabContext, TabStatus } from "./BrowserIntelligenceTypes.ts";

export const MAX_OPEN_TABS = 10;

export class BrowserTabManager {
  private _tabs: Map<string, BrowserTabContext> = new Map();
  private _activeTabId: string | null = null;
  private _sequenceCounter = 0;

  constructor() {
    this.reset();
  }

  /**
   * Resets tab manager to a single clean default tab.
   */
  public reset(): void {
    this._sequenceCounter = 0;
    this._tabs.clear();
    const defaultTab = this._createTabRecord("about:blank", "New Tab");
    this._tabs.set(defaultTab.tabId, defaultTab);
    this._activeTabId = defaultTab.tabId;
  }

  /**
   * Create and open a new tab. If MAX_OPEN_TABS is reached, oldest inactive tab is pruned.
   */
  public createTab(url = "about:blank", title = "New Tab"): BrowserTabContext {
    if (this._tabs.size >= MAX_OPEN_TABS) {
      this._pruneOldestInactiveTab();
    }

    const tab = this._createTabRecord(url, title);
    this._tabs.set(tab.tabId, tab);
    this._activeTabId = tab.tabId;
    return tab;
  }

  /**
   * Switch the active tab to a specific tabId.
   */
  public switchTab(tabId: string): BrowserTabContext | null {
    const tab = this._tabs.get(tabId);
    if (!tab || tab.status === "CLOSED") return null;

    tab.lastActiveAt = Date.now();
    tab.lastActiveSequence = ++this._sequenceCounter;
    this._activeTabId = tabId;
    return tab;
  }

  /**
   * Close a tab. If the active tab was closed, selects the most recently active remaining tab.
   */
  public closeTab(tabId: string): { closed: boolean; newActiveTab?: BrowserTabContext } {
    const tab = this._tabs.get(tabId);
    if (!tab) return { closed: false };

    tab.status = "CLOSED";
    this._tabs.delete(tabId);

    // If closed tab was active, choose new active tab
    if (this._activeTabId === tabId) {
      const remaining = this.getAllTabs();
      if (remaining.length > 0) {
        // Pick most recently active
        remaining.sort((a, b) => {
          const seqDiff = (b.lastActiveSequence ?? 0) - (a.lastActiveSequence ?? 0);
          if (seqDiff !== 0) return seqDiff;
          return b.lastActiveAt - a.lastActiveAt;
        });
        this._activeTabId = remaining[0].tabId;
        return { closed: true, newActiveTab: remaining[0] };
      } else {
        // Create new blank tab so browser is never empty
        const newTab = this.createTab("about:blank", "New Tab");
        return { closed: true, newActiveTab: newTab };
      }
    }

    return { closed: true, newActiveTab: this.getActiveTab() };
  }

  /**
   * Get the current active tab.
   */
  public getActiveTab(): BrowserTabContext | undefined {
    if (!this._activeTabId) return undefined;
    return this._tabs.get(this._activeTabId);
  }

  /**
   * Get all currently open tabs.
   */
  public getAllTabs(): BrowserTabContext[] {
    return Array.from(this._tabs.values()).filter((t) => t.status !== "CLOSED");
  }

  /**
   * Retrieve a tab by its ID.
   */
  public getTab(tabId: string): BrowserTabContext | undefined {
    return this._tabs.get(tabId);
  }

  /**
   * Update metadata or status of a tab.
   */
  public updateTab(tabId: string, updates: Partial<BrowserTabContext>): BrowserTabContext | null {
    const tab = this._tabs.get(tabId);
    if (!tab) return null;

    Object.assign(tab, updates);
    tab.lastActiveAt = Date.now();
    return tab;
  }

  /**
   * Record navigation to a new URL inside a tab, updating its history stack.
   */
  public navigateTab(tabId: string, newUrl: string, title?: string): BrowserTabContext | null {
    const tab = this._tabs.get(tabId);
    if (!tab) return null;

    // Truncate forward history if navigating from a past index
    const historySlice = tab.history.slice(0, tab.historyIndex + 1);
    historySlice.push(newUrl);

    tab.url = newUrl;
    if (title) tab.title = title;
    tab.history = historySlice;
    tab.historyIndex = historySlice.length - 1;
    tab.status = "LOADED";
    tab.lastActiveAt = Date.now();
    tab.lastActiveSequence = ++this._sequenceCounter;
    return tab;
  }

  /**
   * Navigate back in the tab's history.
   */
  public goBack(tabId?: string): { success: boolean; url?: string } {
    const targetId = tabId || this._activeTabId;
    if (!targetId) return { success: false };

    const tab = this._tabs.get(targetId);
    if (!tab || tab.historyIndex <= 0) return { success: false };

    tab.historyIndex--;
    tab.url = tab.history[tab.historyIndex];
    tab.lastActiveAt = Date.now();
    tab.lastActiveSequence = ++this._sequenceCounter;
    return { success: true, url: tab.url };
  }

  /**
   * Navigate forward in the tab's history.
   */
  public goForward(tabId?: string): { success: boolean; url?: string } {
    const targetId = tabId || this._activeTabId;
    if (!targetId) return { success: false };

    const tab = this._tabs.get(targetId);
    if (!tab || tab.historyIndex >= tab.history.length - 1) return { success: false };

    tab.historyIndex++;
    tab.url = tab.history[tab.historyIndex];
    tab.lastActiveAt = Date.now();
    tab.lastActiveSequence = ++this._sequenceCounter;
    return { success: true, url: tab.url };
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private _createTabRecord(url: string, title: string): BrowserTabContext {
    const now = Date.now();
    return {
      tabId: `tab_${crypto.randomBytes(3).toString("hex")}`,
      url,
      title,
      status: "IDLE",
      history: [url],
      historyIndex: 0,
      createdAt: now,
      lastActiveAt: now,
      lastActiveSequence: ++this._sequenceCounter,
    };
  }

  private _pruneOldestInactiveTab(): void {
    const candidates = Array.from(this._tabs.values())
      .filter((t) => t.tabId !== this._activeTabId);

    if (candidates.length === 0) return;

    candidates.sort((a, b) => {
      const seqDiff = (a.lastActiveSequence ?? 0) - (b.lastActiveSequence ?? 0);
      if (seqDiff !== 0) return seqDiff;
      return a.lastActiveAt - b.lastActiveAt;
    });
    const oldest = candidates[0];
    this.closeTab(oldest.tabId);
  }
}

export const browserTabManager = new BrowserTabManager();
