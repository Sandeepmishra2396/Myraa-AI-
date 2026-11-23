"""
Browser automation via Playwright.

Runs a single persistent headed Chromium instance owned by this agent
(independent of the in-app holographic BrowserAgent and the separate
local-agent.js Playwright server on :3001).

Capabilities: open/navigate, new/close tabs, search, click, type, fill forms,
back/forward, scroll. Lazy-initialized; robust to closed pages.
"""

from __future__ import annotations

import asyncio
import threading
from typing import Any, Dict, Optional
from urllib.parse import quote_plus

from .egress_proxy import get_or_start_egress_proxy, stop_egress_proxy
from .registry import STATE, ToolError, register

# A dedicated event loop + thread runs all Playwright coroutines, because
# Playwright's sync API can deadlock under FastAPI's threadpool. We use the
# async API marshalled through a single loop.
_LOOP: Optional[asyncio.AbstractEventLoop] = None
_LOOP_THREAD: Optional[threading.Thread] = None
_LOOP_LOCK = threading.Lock()


def _get_loop() -> "asyncio.AbstractEventLoop":
    global _LOOP, _LOOP_THREAD
    with _LOOP_LOCK:
        if _LOOP is None or _LOOP.is_closed():
            _LOOP = asyncio.new_event_loop()
            _LOOP_THREAD = threading.Thread(target=_run_loop, daemon=True)
            _LOOP_THREAD.start()
        return _LOOP


def _run_loop() -> None:
    loop = _LOOP
    assert loop is not None
    asyncio.set_event_loop(loop)
    try:
        loop.run_forever()
    finally:
        try:
            loop.close()
        except Exception:
            pass


def _run(coro):
    """Submit a coroutine to the dedicated Playwright loop and block on it."""
    loop = _get_loop()
    future = asyncio.run_coroutine_threadsafe(coro, loop)
    return future.result(timeout=60)


# --- Async Playwright lifecycle ---------------------------------------------


import ipaddress
import socket
import urllib.parse


def is_restricted_destination(url_or_host: str) -> tuple[bool, str]:
    """
    Evaluates whether a destination target resolves to loopback, private RFC1918,
    link-local, cloud-metadata, or other restricted IP ranges.
    Fails closed if the destination cannot be verified or DNS resolution fails.
    """
    if not url_or_host:
        return True, "Empty target URL or host"

    try:
        parsed = urllib.parse.urlsplit(url_or_host)
        scheme = (parsed.scheme or "").lower()
        if scheme in ("data", "about", "blob", "javascript"):
            return False, f"Browser internal scheme: {scheme}"
        host = parsed.hostname or url_or_host
    except Exception as e:
        return True, f"Malformed URL: {e}"

    if not host:
        return True, "Missing host in URL"

    host_lower = host.strip().lower()

    # Immediate rejection for common loopback and metadata names
    if host_lower in ("localhost", "127.0.0.1", "::1", "0.0.0.0"):
        return True, f"Restricted loopback host: {host_lower}"
    if host_lower.endswith(".localhost") or host_lower.endswith(".local"):
        return True, f"Restricted local domain: {host_lower}"

    # Check if host is already an IP address literal
    try:
        ip = ipaddress.ip_address(host_lower)
        if (
            ip.is_loopback
            or ip.is_private
            or ip.is_link_local
            or ip.is_reserved
            or ip.is_multicast
            or ip.is_unspecified
        ):
            return True, f"Restricted IP range: {ip}"
        # Cloud metadata IP literal check
        if str(ip) == "169.254.169.254":
            return True, "Restricted cloud metadata IP"
        return False, f"Safe public IP literal: {ip}"
    except ValueError:
        pass

    # Resolve hostname via getaddrinfo to check all A/AAAA addresses at connection time
    try:
        addrinfo = socket.getaddrinfo(host_lower, None, socket.AF_UNSPEC, socket.SOCK_STREAM)
        if not addrinfo:
            return True, f"DNS resolution returned no addresses for host '{host_lower}'"

        for family, socktype, proto, canonname, sockaddr in addrinfo:
            ip_str = sockaddr[0]
            ip = ipaddress.ip_address(ip_str)
            if (
                ip.is_loopback
                or ip.is_private
                or ip.is_link_local
                or ip.is_reserved
                or ip.is_multicast
                or ip.is_unspecified
            ):
                return True, f"DNS resolves to restricted IP: {ip}"
            if str(ip) == "169.254.169.254":
                return True, "DNS resolves to cloud metadata IP: 169.254.169.254"
        return False, "Safe public host"
    except Exception as err:
        return True, f"Connection-time DNS resolution failed for '{host_lower}': {err}"


async def _guard_browser_route(route: Any) -> None:
    """Intercept all Playwright browser requests and enforce network egress restrictions."""
    try:
        req = route.request
        target_url = req.url
        restricted, reason = is_restricted_destination(target_url)
        if restricted:
            # Abort request immediately at browser connection time
            await route.abort("accessdenied")
        else:
            await route.continue_()
    except Exception:
        # Fail closed on any route handler error
        try:
            await route.abort("failed")
        except Exception:
            pass


async def _ensure_browser_async() -> Any:
    # 1. Recover if browser is missing or disconnected
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

    # 4. Fallback: inspect context pages for a living tab or create a fresh one
    open_pages = [p for p in (STATE.context.pages if STATE.context else []) if not p.is_closed()]
    if open_pages:
        STATE.page = open_pages[-1]
    else:
        STATE.page = await STATE.context.new_page()

    return STATE.page


async def _page() -> Any:
    return await _ensure_browser_async()


def _normalize_url(raw: str) -> str:
    url = raw.strip()
    if not url:
        raise ToolError("Empty URL.")
    if (
        url.startswith("about:")
        or url.startswith("data:")
        or url.startswith("javascript:")
        or "://" in url
    ):
        return url
    return "https://" + url


# --- Handlers ---------------------------------------------------------------


@register("desktopBrowserOpen")
async def browser_open(args: Dict[str, Any]) -> Dict[str, Any]:
    url = _normalize_url(args.get("url") or "https://www.google.com")
    page = await _page()
    try:
        await page.goto(url, wait_until="domcontentloaded", timeout=20000)
    except Exception as e:  # noqa: BLE001
        err_msg = str(e)
        if "closed" in err_msg.lower():
            # State cleanup: discard dead page/browser references
            if STATE.page is not None and STATE.page.is_closed():
                STATE.page = None
            if STATE.browser is not None and not STATE.browser.is_connected():
                STATE.reset_playwright()
            # Bounded one-time recovery attempt
            try:
                page = await _page()
                await page.goto(url, wait_until="domcontentloaded", timeout=20000)
            except Exception as retry_err:
                raise ToolError(f"Could not open {url} after target recovery attempt: {retry_err}")
        else:
            raise ToolError(f"Could not open {url}: {e}")
    return {"result": f"Opened {url} in the automation browser.", "url": page.url}


@register("desktopBrowserNavigate")
async def browser_navigate(args: Dict[str, Any]) -> Dict[str, Any]:
    # Alias of desktopBrowserOpen, retained for clarity.
    return await browser_open(args)


@register("desktopBrowserOpenTab")
async def browser_open_tab(args: Dict[str, Any]) -> Dict[str, Any]:
    url = _normalize_url(args.get("url") or "about:blank")
    await _ensure_browser_async()
    ctx = STATE.context
    try:
        page = await ctx.new_page()
    except Exception:
        # Context might have closed; re-acquire
        await _ensure_browser_async()
        page = await STATE.context.new_page()
    STATE.page = page  # make it active
    if url != "about:blank":
        try:
            await page.goto(url, wait_until="domcontentloaded", timeout=20000)
        except Exception as e:  # noqa: BLE001
            err_msg = str(e)
            if "closed" in err_msg.lower():
                if STATE.page is not None and STATE.page.is_closed():
                    STATE.page = None
                if STATE.browser is not None and not STATE.browser.is_connected():
                    STATE.reset_playwright()
                try:
                    page = await _page()
                    await page.goto(url, wait_until="domcontentloaded", timeout=20000)
                except Exception as retry_err:
                    raise ToolError(f"Opened tab but navigation failed after recovery: {retry_err}")
            else:
                raise ToolError(f"Opened tab but navigation failed: {e}")
    return {"result": f"New tab opened at {url}.", "url": url}


@register("desktopBrowserCloseTab")
async def browser_close_tab(args: Dict[str, Any]) -> Dict[str, Any]:
    try:
        page = await _page()
        if not page.is_closed():
            await page.close()
    except Exception:
        pass
    pages = [p for p in (STATE.context.pages if STATE.context else []) if not p.is_closed()]
    STATE.page = pages[-1] if pages else None
    if STATE.page is None:
        return {"result": "Closed the last tab; browser now empty."}
    return {"result": f"Closed tab. Active tab now: {STATE.page.url}"}


@register("desktopBrowserSearch")
async def browser_search(args: Dict[str, Any]) -> Dict[str, Any]:
    query = args.get("query") or args.get("q")
    engine = (args.get("engine") or "google").strip().lower()
    if not query:
        raise ToolError("Parameter 'query' is required.")
    q = quote_plus(str(query))
    url = {
        "google": f"https://www.google.com/search?q={q}",
        "youtube": f"https://www.youtube.com/results?search_query={q}",
        "github": f"https://github.com/search?q={q}",
        "duckduckgo": f"https://duckduckgo.com/?q={q}",
        "bing": f"https://www.bing.com/search?q={q}",
    }.get(engine)
    if not url:
        raise ToolError(f"Unsupported engine '{engine}'.")
    page = await _page()
    try:
        await page.goto(url, wait_until="domcontentloaded", timeout=20000)
    except Exception as e:  # noqa: BLE001
        err_msg = str(e)
        if "closed" in err_msg.lower():
            if STATE.page is not None and STATE.page.is_closed():
                STATE.page = None
            if STATE.browser is not None and not STATE.browser.is_connected():
                STATE.reset_playwright()
            try:
                page = await _page()
                await page.goto(url, wait_until="domcontentloaded", timeout=20000)
            except Exception as retry_err:
                raise ToolError(f"Search navigation failed after recovery: {retry_err}")
        else:
            raise ToolError(f"Search navigation failed: {e}")
    return {"result": f"Searched {engine} for '{query}'.", "url": page.url}


@register("desktopBrowserClick")
async def browser_click(args: Dict[str, Any]) -> Dict[str, Any]:
    selector = args.get("selector")
    text = args.get("text")
    page = await _page()
    try:
        if selector:
            await page.click(selector, timeout=5000)
        elif text:
            await page.get_by_text(str(text), exact=False).first.click(timeout=5000)
        else:
            raise ToolError("Provide 'selector' or 'text' to click.")
    except Exception as e:  # noqa: BLE001
        raise ToolError(f"Click failed: {e}")
    return {"result": f"Clicked {selector or text}."}


@register("desktopBrowserType")
async def browser_type(args: Dict[str, Any]) -> Dict[str, Any]:
    text = args.get("text")
    selector = args.get("selector")
    clear_first = bool(args.get("clear", True))
    if not text:
        raise ToolError("Parameter 'text' is required.")
    page = await _page()
    try:
        if selector:
            await page.fill(selector, str(text), timeout=5000)
        else:
            if clear_first:
                await page.keyboard.press("Control+A")
                await page.keyboard.press("Delete")
            await page.keyboard.type(str(text))
    except Exception as e:  # noqa: BLE001
        raise ToolError(f"Type failed: {e}")
    return {"result": f"Typed {len(str(text))} characters."}


@register("desktopBrowserFillForm")
async def browser_fill_form(args: Dict[str, Any]) -> Dict[str, Any]:
    """Fill multiple fields. fields = { selector: value, ... }"""
    fields = args.get("fields")
    submit = args.get("submit")  # optional selector to click after filling
    if not isinstance(fields, dict) or not fields:
        raise ToolError("Parameter 'fields' (object of selector->value) is required.")
    page = await _page()
    filled = 0
    try:
        for sel, val in fields.items():
            await page.fill(str(sel), str(val), timeout=5000)
            filled += 1
        if submit:
            await page.click(str(submit), timeout=5000)
    except Exception as e:  # noqa: BLE001
        raise ToolError(f"Form fill failed after {filled} field(s): {e}")
    extra = " and submitted." if submit else "."
    return {"result": f"Filled {filled} field(s){extra}"}


@register("desktopBrowserGoBack")
async def browser_go_back(args: Dict[str, Any]) -> Dict[str, Any]:
    page = await _page()
    try:
        await page.go_back(timeout=15000)
    except Exception as e:  # noqa: BLE001
        raise ToolError(f"Back failed: {e}")
    return {"result": f"Went back. Now on {page.url}."}


@register("desktopBrowserGoForward")
async def browser_go_forward(args: Dict[str, Any]) -> Dict[str, Any]:
    page = await _page()
    try:
        await page.go_forward(timeout=15000)
    except Exception as e:  # noqa: BLE001
        raise ToolError(f"Forward failed: {e}")
    return {"result": f"Went forward. Now on {page.url}."}


@register("desktopBrowserScroll")
async def browser_scroll(args: Dict[str, Any]) -> Dict[str, Any]:
    direction = (args.get("direction") or "down").lower()
    amount = int(args.get("amount", 500))
    delta = amount if direction != "up" else -amount
    page = await _page()
    try:
        await page.mouse.wheel(0, delta)
    except Exception as e:  # noqa: BLE001
        raise ToolError(f"Scroll failed: {e}")
    return {"result": f"Scrolled {direction} {amount}px."}


# Wrap the async handlers so FastAPI's sync threadpool path can call them.
# Each @register'd async function above is replaced by a sync wrapper below.
def _sync_wrap(async_fn):
    def wrapper(args: Dict[str, Any]) -> Dict[str, Any]:
        return _run(async_fn(args))

    wrapper.__name__ = async_fn.__name__
    wrapper.__doc__ = async_fn.__doc__
    return wrapper


# Re-register the async handlers as synchronous wrappers so the registry
# dispatcher (which is sync) can call them uniformly.
from .registry import TOOLS  # noqa: E402

for _name in [
    "desktopBrowserOpen",
    "desktopBrowserNavigate",
    "desktopBrowserOpenTab",
    "desktopBrowserCloseTab",
    "desktopBrowserSearch",
    "desktopBrowserClick",
    "desktopBrowserType",
    "desktopBrowserFillForm",
    "desktopBrowserGoBack",
    "desktopBrowserGoForward",
    "desktopBrowserScroll",
]:
    _orig = TOOLS[_name]
    if asyncio.iscoroutinefunction(_orig):
        TOOLS[_name] = _sync_wrap(_orig)


def shutdown_browser() -> None:
    """Cleanly stop the Playwright browser (called on app shutdown)."""
    if STATE.browser is None:
        return

    async def _stop():
        try:
            if STATE.browser:
                await STATE.browser.close()
        except Exception:
            pass
        try:
            if STATE.playwright:
                await STATE.playwright.stop()
        except Exception:
            pass
        STATE.reset_playwright()

    try:
        _run(_stop())
    except Exception:
        STATE.reset_playwright()


__all__ = [
    "browser_open",
    "browser_navigate",
    "browser_open_tab",
    "browser_close_tab",
    "browser_search",
    "browser_click",
    "browser_type",
    "browser_fill_form",
    "browser_go_back",
    "browser_go_forward",
    "browser_scroll",
    "shutdown_browser",
]
