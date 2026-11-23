# MYRAA NF-02 — Browser Context Closure Diagnosis Report

**Document ID:** `nf02_browser_lifecycle_diagnosis.md`  
**Date:** 2026-10-22  
**Investigation Scope:** Manual Test NF-02 failure: `Page.goto: Target page, context or browser has been closed`  
**Target URL:** `https://the-internet.herokuapp.com/login`  
**Status:** Read-only Investigation Complete — Awaiting Explicit Implementation Scope Approval  

---

## 1. Executive Summary

During manual validation of test **NF-02** ("Form Interaction: Type & Click" on `https://the-internet.herokuapp.com/login`), the automation browser failed during navigation with:

```text
Page.goto: Target page, context or browser has been closed
```

The error repeated on subsequent retries as observed in the assistant conversation:
> *"Lekin dekho, fir se wahi error aa raha hai—'Page.goto: Target page, context or browser has been closed.' Aisa lagta hai ki browser tab apne aap band ho jaa raha hai navigation ke dauran..."*

### Verdict & Core Finding
- **Root Cause Confirmed:** The browser lifecycle manager in `desktop_agent/tools_browser.py` relies on a defective health check (`_ = STATE.page.url`). In Playwright, `page.url` is a synchronous property that accesses a cached string in memory and **never raises an exception**, even if the page, its context, or the Chromium process has been closed (`is_closed() == True` or `is_connected() == False`).
- **Secondary Flaw:** When Chromium's window is closed by a user, tab closure, or crash, `STATE.browser` remains instantiated (`STATE.browser is not None`), so the initializer skips browser launch and attempts to call `goto` or `new_page` on a disconnected browser, trapping the agent in a **perpetual dead-browser state** until the Python process is killed.
- **Severity:** **HIGH** (Completely blocks all desktop browser automation once any tab or window is closed; 100% reproducible; requires restart without a fix).
- **Security & Scope Impact:** No security regression. Resolution requires a minimal, surgical fix to `desktop_agent/tools_browser.py` (a frozen file requiring explicit user authorization).

---

## 2. End-to-End Task Lifecycle & IPC Flow

The execution flow for `desktopBrowserOpen` and browser tools follows this pipeline:

```
[User UI: localhost:3000]
         │ (WebSocket message)
         ▼
[backend/server.ts & Gemini Live Session]
         │ (Gemini model generates tool call: desktopBrowserOpen)
         ▼
[backend/tools/ToolOrchestrator.ts]
         │ (Routes DESKTOP_TOOLS)
         ▼
[backend/tasks/TaskManager.ts -> callDesktopAgent()]
         │ (HTTP POST http://127.0.0.1:8765/execute, 25s timeout)
         ▼
[desktop_agent/main.py -> POST /execute]
         │ (Calls TOOLS["desktopBrowserOpen"] -> _sync_wrap)
         ▼
[desktop_agent/tools_browser.py]
         │ 1. _ensure_browser_async() (Health check & launch)
         │ 2. page = await _page()
         │ 3. await page.goto(url, wait_until="domcontentloaded", timeout=20000)
         ▼
[Playwright headed Chromium via DnsPinningProxy (127.0.0.1:ephemeral)]
```

---

## 3. Root Cause Analysis (Detailed Evidence)

### Defect 1: The Defective `_ = STATE.page.url` Health Check
In `desktop_agent/tools_browser.py` lines 160–168:
```python
async def _ensure_browser_async() -> Any:
    if STATE.page is not None:
        try:
            # Health check: a cheap op; if the page died, recreate.
            _ = STATE.page.url
            return STATE.page
        except Exception:
            STATE.reset_playwright()
```

**The Bug:**
The author assumed that accessing `STATE.page.url` would raise an exception if the page or browser died.
**Empirical Proof (Tested live in Python):**
```python
>>> await page.goto('https://example.com')
>>> await browser.close()
>>> page.url
'https://example.com/'   # <-- Does NOT raise an exception!
>>> page.is_closed()
True                     # <-- Page is closed!
>>> browser.is_connected()
False                    # <-- Browser is disconnected!
```
Because `page.url` returns the cached URL string without throwing, `_ensure_browser_async()` returns `STATE.page` directly. The subsequent `page.goto()` fails immediately with `Target page, context or browser has been closed`.

### Defect 2: Missing Browser Connection Check (`is_connected()`)
In `desktop_agent/tools_browser.py` lines 174–186:
```python
    if STATE.browser is None:
        proxy_port = await get_or_start_egress_proxy()
        STATE.browser = await STATE.playwright.chromium.launch(...)
```
When Chromium is closed (either by the user clicking "X" on the headed window, an OS window event, or a crash):
- `STATE.browser` is **NOT `None`**; it is still a `playwright.async_api.Browser` instance.
- However, `STATE.browser.is_connected()` is `False`.
- Because `STATE.browser is not None`, the code **never relaunches the browser**.
- It then attempts `await STATE.context.new_page()`, which throws:
  `BrowserContext.new_page: Target page, context or browser has been closed`.

### Defect 3: No State Reset on Navigation Failure
In `desktop_agent/tools_browser.py` lines 222–225:
```python
    try:
        await page.goto(url, wait_until="domcontentloaded", timeout=20000)
    except Exception as e:
        raise ToolError(f"Could not open {url}: {e}")
```
When `Target page, context or browser has been closed` occurs, the exception handler raises `ToolError` **without clearing `STATE.page` or resetting Playwright state**.
As a result:
- On every subsequent attempt (such as when the assistant or user retries), `_ensure_browser_async()` encounters the exact same dead `STATE.page`.
- `STATE.page.url` again succeeds silently.
- `page.goto` fails again with the exact same error.
- The system is permanently locked in this failure state.

### Defect 4: Tab Closure Handling Leaves Stale References
In `desktopBrowserOpenTab` and `desktopBrowserCloseTab`:
If a user closes a tab manually in Chromium or if a multi-tab workflow has closed pages, `STATE.context.pages` can contain closed pages, and `STATE.page` retains a reference to a closed page while other tabs remain open. Because `STATE.page.is_closed()` is never evaluated, the agent fails to fall back to an open tab.

---

## 4. Empirical Reproduction Evidence

We reproduced the issue under controlled local conditions using the exact runtime code:

### Test Run 1: Browser Closed (User Closes Window)
Command executed:
```python
open_fn({'url': 'https://example.com'})
await STATE.browser.close()
# Retry navigation
open_fn({'url': 'https://the-internet.herokuapp.com/login'})
```
**Actual Output:**
```text
1. Initial open: https://example.com/
2. Browser closed. STATE.page is not None: True
3. Second open FAILED with ToolError: Could not open https://the-internet.herokuapp.com/login: Page.goto: Target page, context or browser has been closed
4. Third open FAILED again with ToolError: Could not open https://the-internet.herokuapp.com/login: Page.goto: Target page, context or browser has been closed
```
**Conclusion:** 100% reproduction of the user's exact error message and the perpetual failure loop.

### Test Run 2: Tab Closed (User Closes Tab, Browser Remains Open)
Command executed:
```python
open_fn({'url': 'https://example.com'})
await STATE.page.close()
# Retry navigation
open_fn({'url': 'https://the-internet.herokuapp.com/login'})
```
**Actual Output:**
```text
Page closed. STATE.page is not None: True
Second open FAILED with ToolError: Could not open https://the-internet.herokuapp.com/login: Page.goto: Target page, context or browser has been closed
```

### Test Run 3: Multi-Tab Orphan Reference
Command executed:
```python
open_fn({'url': 'https://example.com'})
new_tab_fn({'url': 'https://iana.org'})
await STATE.page.close() # Active tab closed
open_fn({'url': 'https://the-internet.herokuapp.com/login'})
```
**Actual Output:**
```text
Active tab closed. STATE.page.is_closed(): True
Remaining tabs in context: 1
Open FAILED: Could not open https://the-internet.herokuapp.com/login: Page.goto: Target page, context or browser has been closed
```

---

## 5. What Was Ruled Out

| Potential Factor | Investigation Result | Verdict |
|:---|:---|:---:|
| **Firewall / Antivirus** | `the-internet.herokuapp.com` resolves cleanly to AWS IP `99.83.176.110` and connects over HTTPS without OS interference. | **RULED OUT** |
| **DNS-Pinning Egress Proxy** | The proxy resolved and validated `the-internet.herokuapp.com` instantly. Port 443 is permitted. Bidirectional HTTP CONNECT tunnel was verified functioning. | **RULED OUT** |
| **Backend RPC Timeout** | `TaskManager.ts` timeout is 25s; direct `desktop_agent` execution failed immediately (<50ms) on dead page handles. | **RULED OUT** |
| **Herokuapp Server Downtime** | Public endpoint responds with HTTP 200; direct Playwright test loaded the login page and submitted the form successfully when a fresh page was used. | **RULED OUT** |

---

## 6. Proposed Minimal Fix

The fix requires modifying `_ensure_browser_async` in `desktop_agent/tools_browser.py` to:
1. Validate that `STATE.browser` is not only not None, but actively connected (`STATE.browser.is_connected()`). If disconnected, call `STATE.reset_playwright()` to discard dead handles.
2. Ensure `STATE.context` is valid and active.
3. Check `STATE.page is not None and not STATE.page.is_closed()`.
4. If the active page is closed, check for any other unclosed pages in `STATE.context.pages`, or create a fresh page with `await STATE.context.new_page()`.
5. In tool exception handlers, catch `TargetClosedError` (or detect closed pages) and ensure state cleanup occurs so that failures never lock the browser in an unrecoverable loop.

### Verified Architecture for `_ensure_browser_async()`:
```python
async def _ensure_browser_async() -> Any:
    # 1. Re-initialize if browser is missing or disconnected
    if STATE.browser is None or not STATE.browser.is_connected():
        STATE.reset_playwright()

    if STATE.playwright is None:
        from playwright.async_api import async_playwright
        STATE.playwright = await async_playwright().start()

    if STATE.browser is None or not STATE.browser.is_connected():
        proxy_port = await get_or_start_egress_proxy()
        STATE.browser = await STATE.playwright.chromium.launch(
            headless=False,
            args=[
                "--start-maximized",
                "--no-sandbox",
                f"--proxy-server=http://127.0.0.1:{proxy_port}",
                "--proxy-bypass-list=<-loopback>",
                "--disable-quic",
                "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
            ],
        )
        STATE.context = await STATE.browser.new_context(viewport=None)
        await STATE.context.route("**/*", _guard_browser_route)
        STATE.page = await STATE.context.new_page()
        return STATE.page

    # 2. Re-create context if missing
    if STATE.context is None:
        STATE.context = await STATE.browser.new_context(viewport=None)
        await STATE.context.route("**/*", _guard_browser_route)

    # 3. Check if active page is still alive and open
    if STATE.page is not None and not STATE.page.is_closed():
        return STATE.page

    # 4. Fallback: inspect context pages for a living tab or create a new one
    open_pages = [p for p in STATE.context.pages if not p.is_closed()]
    if open_pages:
        STATE.page = open_pages[-1]
    else:
        STATE.page = await STATE.context.new_page()

    return STATE.page
```

### Verification of the Proposed Fix:
We tested this exact implementation against all 3 failure modes:
1. **Scenario 1:** Initial launch → `P1 url: https://example.com/` (PASS)
2. **Scenario 2:** User closes active tab → `p1.is_closed(): True`, auto-creates fresh page `p2`, navigates to `https://the-internet.herokuapp.com/login` (PASS)
3. **Scenario 3:** User closes the entire browser window → `STATE.browser.is_connected(): False`, auto-relaunches Chromium with proxy, navigates to `https://the-internet.herokuapp.com/login` (PASS)

---

## 7. Affected Files & Scope Authorization Request

To implement this fix, the following files would be touched:

| File | Change Type | Status |
|:---|:---:|:---|
| `desktop_agent/tools_browser.py` | Minimal lifecycle fix in `_ensure_browser_async()` | **Frozen File — Requires Scope Approval** |
| `tests/integration/stage9_evaluation_acceptance.test.ts` | Add automated regression tests for browser closure recovery | Authorized test file |

> [!IMPORTANT]
> **No code has been edited.** The working tree is untouched and preserved.
> Implementation will only proceed once explicit authorization is granted for modifying `desktop_agent/tools_browser.py`.
