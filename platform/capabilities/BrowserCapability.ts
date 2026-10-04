/**
 * MYRAA Platform — BrowserCapability Interface
 * Phase 15
 *
 * Defines the typed contract for platform-native browser control actions.
 *
 * Desktop implementation: Delegates to the existing Holographic Browser (9 UI tools)
 *   or the Playwright Desktop Browser (11 desktopBrowser* tools in the Python agent).
 *   These are already wired via ToolOrchestrator → sendToClient({ type: "toolCall" }).
 *
 * Android implementation (Phase 17): android.content.Intent.ACTION_VIEW for URL
 *   navigation; Custom Tabs for in-app browsing; WebView for embedded content.
 *
 * NOTE: The existing 9 holographic browser tools (browserOpen, browserSearch, etc.)
 * run on the MYRAA Desktop Core and send JSON toolCall messages to the React UI.
 * The Android adapter does NOT intercept or replicate those desktop tool routes.
 * It exposes Android-native browser actions only.
 */

// ---------------------------------------------------------------------------
// Browser Action Types
// ---------------------------------------------------------------------------

export type ScrollDirection = "up" | "down" | "left" | "right";

export interface BrowserNavigateResult {
  success: boolean;
  url?: string;
  title?: string;
  reason?: string;
}

export interface BrowserSearchResult {
  success: boolean;
  query: string;
  resultUrl?: string;
  reason?: string;
}

export interface BrowserClickResult {
  success: boolean;
  selector: string;
  reason?: string;
}

export interface BrowserScrollResult {
  success: boolean;
  direction: ScrollDirection;
  pixelsMoved?: number;
  reason?: string;
}

// ---------------------------------------------------------------------------
// IBrowserAction Contract
// ---------------------------------------------------------------------------

/**
 * IBrowserAction — Platform-independent browser interaction contract.
 *
 * Desktop implementations:
 *   • Holographic UI tools (9):   forwards via sendToClient({ type: "toolCall" })
 *     (browserOpen, browserSearch, browserClick, browserScroll, browserType, etc.)
 *   • Desktop Playwright tools (11): via Python agent
 *     (desktopBrowserOpen, desktopBrowserNavigate, desktopBrowserSearch, etc.)
 *
 * Android implementation (Phase 17):
 *   • Intent.ACTION_VIEW for external URL navigation.
 *   • Chrome Custom Tabs for in-app viewing.
 *   • WebView.loadUrl() for embedded content.
 */
export interface IBrowserAction {
  /**
   * Navigate the active browser to the specified URL.
   * @param url The target URL (must be a valid http/https URL).
   */
  navigate(url: string): Promise<BrowserNavigateResult>;

  /**
   * Execute a search query using the platform default search mechanism.
   * @param query The search string.
   * @param engine Optional search engine hint ("google" | "youtube" | "bing").
   */
  search(query: string, engine?: string): Promise<BrowserSearchResult>;

  /**
   * Click a UI element identified by its selector.
   * Selector semantics are platform-dependent.
   * @param selector Platform-specific element identifier.
   * @param description Optional human-readable description for logging.
   */
  click(selector: string, description?: string): Promise<BrowserClickResult>;

  /**
   * Scroll the active browser view.
   * @param direction Scroll direction.
   * @param pixels Distance in display pixels (default: 300).
   */
  scroll(direction: ScrollDirection, pixels?: number): Promise<BrowserScrollResult>;

  /**
   * Type text into the currently focused input element.
   * @param text The text to type.
   */
  type(text: string): Promise<{ success: boolean; reason?: string }>;

  /**
   * Navigate back in the browser history.
   */
  goBack(): Promise<{ success: boolean; reason?: string }>;
}
