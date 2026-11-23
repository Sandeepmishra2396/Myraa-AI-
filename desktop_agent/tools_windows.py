"""
Window management: minimize / maximize / close the active window or switch apps.

Uses win32gui for the foreground window and pygetwindow for title-based lookups,
with graceful degradation if a backend isn't present.
"""

from __future__ import annotations

import platform
import subprocess
import time
from typing import Any, Dict, Optional

from .registry import ToolError, register

SW_MINIMIZE = 6
SW_MAXIMIZE = 3
SW_RESTORE = 9
SW_HIDE = 0


def _get_foreground_window():
    if platform.system() != "Windows":
        return None
    try:
        import win32gui

        hwnd = win32gui.GetForegroundWindow()
        if not hwnd:
            return None
        return hwnd
    except Exception:
        return None


def _window_title(hwnd) -> str:
    try:
        import win32gui

        return win32gui.GetWindowText(hwnd)
    except Exception:
        return ""


def _show_window(hwnd, cmd) -> None:
    try:
        import win32gui

        win32gui.ShowWindow(hwnd, cmd)
    except Exception as e:  # noqa: BLE001
        raise ToolError(f"Could not change window state: {e}")


def _close_window_hwnd(hwnd) -> None:
    try:
        import win32con
        import win32gui

        win32gui.PostMessage(hwnd, win32con.WM_CLOSE, 0, 0)
    except Exception as e:  # noqa: BLE001
        raise ToolError(f"Could not close window: {e}")


def _find_window_by_title(query: str):
    """Return the hwnd of the first window whose title contains query."""
    if platform.system() != "Windows":
        return None
    try:
        import win32gui

        matches = []

        def cb(hwnd, _):
            if win32gui.IsWindowVisible(hwnd):
                title = win32gui.GetWindowText(hwnd)
                if title and query.lower() in title.lower():
                    matches.append(hwnd)
            return True

        win32gui.EnumWindows(cb, None)
        return matches[0] if matches else None
    except Exception:
        return None


def force_bring_to_foreground(target: Any) -> bool:
    """Forces a window to the top foreground on Windows desktop, bypassing Windows focus lock."""
    if platform.system() != "Windows":
        return False
    try:
        import ctypes
        import win32gui
        import win32con

        hwnd = target if isinstance(target, int) else None
        if not hwnd and isinstance(target, str):
            hwnd = _find_window_by_title(target)
            if not hwnd:
                def cb(h, matches):
                    if win32gui.IsWindowVisible(h):
                        t = win32gui.GetWindowText(h)
                        if t and (target.lower() in t.lower() or t.lower() in target.lower()):
                            matches.append(h)
                    return True
                found: list[int] = []
                win32gui.EnumWindows(cb, found)
                if found:
                    hwnd = found[0]

        if not hwnd:
            return False

        user32 = ctypes.windll.user32
        kernel32 = ctypes.windll.kernel32

        # 1. Un-minimize if minimized
        win32gui.ShowWindow(hwnd, win32con.SW_RESTORE)

        # 2. Attach thread input to bypass foreground lockout
        fore_hwnd = user32.GetForegroundWindow()
        cur_thread = kernel32.GetCurrentThreadId()
        fore_thread = user32.GetWindowThreadProcessId(fore_hwnd, None) if fore_hwnd else 0

        if fore_thread and fore_thread != cur_thread:
            user32.AttachThreadInput(cur_thread, fore_thread, True)

        try:
            win32gui.SetForegroundWindow(hwnd)
            user32.BringWindowToTop(hwnd)
            user32.SwitchToThisWindow(hwnd, True)
        finally:
            if fore_thread and fore_thread != cur_thread:
                user32.AttachThreadInput(cur_thread, fore_thread, False)

        return True
    except Exception:
        try:
            if isinstance(target, str):
                cmd = f"(New-Object -ComObject WScript.Shell).AppActivate('{target}')"
                subprocess.run(["powershell", "-NoProfile", "-Command", cmd], capture_output=True, timeout=3)
                return True
        except Exception:
            pass
        return False


def _focus(hwnd) -> None:
    if not force_bring_to_foreground(hwnd):
        _show_window(hwnd, SW_RESTORE)
        time.sleep(0.1)
        try:
            import win32gui
            win32gui.SetForegroundWindow(hwnd)
        except Exception as e:
            raise ToolError(f"Could not focus window: {e}")


def _resolve_target(args: Dict[str, Any]):
    """Pick the hwnd to operate on: explicit title, or the foreground window."""
    title: Optional[str] = args.get("title") or args.get("application")
    if title:
        hwnd = _find_window_by_title(str(title))
        if not hwnd:
            raise ToolError(f"No visible window with title containing '{title}'.")
        return hwnd, str(title)
    hwnd = _get_foreground_window()
    if not hwnd:
        raise ToolError("No active window found.")
    return hwnd, _window_title(hwnd)


@register("minimizeWindow")
def minimize_window(args: Dict[str, Any]) -> Dict[str, Any]:
    hwnd, title = _resolve_target(args)
    _show_window(hwnd, SW_MINIMIZE)
    return {"result": f"Minimized window: {title or 'active window'}."}


@register("maximizeWindow")
def maximize_window(args: Dict[str, Any]) -> Dict[str, Any]:
    hwnd, title = _resolve_target(args)
    _show_window(hwnd, SW_MAXIMIZE)
    return {"result": f"Maximized window: {title or 'active window'}."}


@register("closeWindow")
def close_window(args: Dict[str, Any]) -> Dict[str, Any]:
    hwnd, title = _resolve_target(args)
    _close_window_hwnd(hwnd)
    return {"result": f"Closed window: {title or 'active window'}."}


@register("switchApplication")
def switch_application(args: Dict[str, Any]) -> Dict[str, Any]:
    """Focus a window by title, or cycle windows (Alt+Tab) if no title given."""
    title = args.get("title") or args.get("application")
    if title:
        hwnd = _find_window_by_title(str(title))
        if not hwnd:
            raise ToolError(f"No visible window matching '{title}'.")
        _show_window(hwnd, SW_RESTORE)
        _focus(hwnd)
        return {"result": f"Switched to: {str(title)}."}

    # No specific title -> Alt+Tab cycle.
    try:
        import pyautogui

        pyautogui.hotkey("alt", "tab")
        return {"result": "Cycled to the next window."}
    except Exception:
        # Fallback: cycle by enumerating windows and focusing the next one.
        if platform.system() == "Windows":
            try:
                import win32gui

                order = []

                def cb(hwnd, _):
                    if win32gui.IsWindowVisible(hwnd) and win32gui.GetWindowText(hwnd):
                        order.append(hwnd)
                    return True

                win32gui.EnumWindows(cb, None)
                fg = win32gui.GetForegroundWindow()
                if order:
                    idx = order.index(fg) if fg in order else -1
                    nxt = order[(idx + 1) % len(order)]
                    _focus(nxt)
                    return {"result": f"Switched to: {win32gui.GetWindowText(nxt)}."}
            except Exception:
                pass
        raise ToolError("Could not switch applications.")


__all__ = [
    "minimize_window",
    "maximize_window",
    "close_window",
    "switch_application",
]
