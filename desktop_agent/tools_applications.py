"""
Application control: launch and close common Windows applications.

Launch strategy is layered for robustness:
  1. Try a known executable / shell verb (fastest, most reliable).
  2. Fall back to the Windows "where"/App Paths lookup via `start`.

Closing uses taskkill on the matching process image name, with a graceful
grace period so apps can save work.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import time
from typing import Any, Dict, Optional

from .registry import ToolError, register


def _find_vscode_path() -> str:
    """Find the real Visual Studio Code executable on the machine."""
    candidates = [
        r"D:\Microsoft VS Code\Code.exe",
        r"D:\Microsoft VS Code\bin\code.cmd",
        os.path.expandvars(r"%LOCALAPPDATA%\Programs\Microsoft VS Code\Code.exe"),
        os.path.expandvars(r"%LOCALAPPDATA%\Programs\Microsoft VS Code\bin\code.cmd"),
        os.path.expandvars(r"%PROGRAMFILES%\Microsoft VS Code\Code.exe"),
        os.path.expandvars(r"%PROGRAMFILES(X86)%\Microsoft VS Code\Code.exe"),
    ]
    for c in candidates:
        if os.path.exists(c):
            return c
    return "code.cmd"


def _find_cursor_path() -> str:
    """Find the Cursor editor executable on the machine."""
    candidates = [
        os.path.expandvars(r"%LOCALAPPDATA%\Programs\cursor\Cursor.exe"),
        os.path.expandvars(r"%PROGRAMFILES%\cursor\Cursor.exe"),
        r"C:\Users\SANDEEP\AppData\Local\Programs\cursor\Cursor.exe",
    ]
    for c in candidates:
        if os.path.exists(c):
            return c
    return "cursor"


def _find_windows_app_path(
    app_key: str, default_exe: str, fallback_candidates: Optional[list[str]] = None
) -> str:
    """Find the real, fully qualified Windows executable path for an application.

    Checks:
      1. Absolute path if given and exists
      2. Windows Registry App Paths (HKLM & HKCU)
      3. PATH via shutil.which
      4. Explicit known installation locations (Program Files, LocalAppData, System32, etc.)
    """
    if os.path.isabs(default_exe) and os.path.exists(default_exe):
        return default_exe

    # 1. Try Windows Registry App Paths
    try:
        import winreg

        for root in (winreg.HKEY_LOCAL_MACHINE, winreg.HKEY_CURRENT_USER):
            for sub in [
                rf"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\{default_exe}",
                rf"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\{app_key}.exe",
            ]:
                try:
                    with winreg.OpenKey(root, sub) as k:
                        val, _ = winreg.QueryValueEx(k, "")
                        if val and os.path.exists(val):
                            return val
                except Exception:
                    pass
    except Exception:
        pass

    # 2. Check shutil.which
    which = shutil.which(default_exe) or shutil.which(f"{default_exe}.exe")
    if which and os.path.exists(which):
        return which

    # 3. Check explicit candidate paths
    if fallback_candidates:
        for c in fallback_candidates:
            expanded = os.path.expandvars(c)
            if os.path.exists(expanded):
                return expanded

    # Return default_exe for shell/PATH fallback
    return default_exe


# Canonical app key -> (launch_command, kind)
#   kind == "exe"   : launch_command is the executable name (resolved via PATH/App Paths)
#   kind == "shell" : launch_command is a shell builtin verb run with cmd /c
#   kind == "uwp"   : launch_command is an apps-family activation string
APP_COMMANDS: Dict[str, Dict[str, str]] = {
    "notepad": {
        "exe": _find_windows_app_path(
            "notepad", "notepad.exe", [r"C:\Windows\System32\notepad.exe", r"C:\Windows\notepad.exe"]
        ),
        "image": "notepad.exe",
        "label": "Notepad",
    },
    "chrome": {
        "exe": _find_windows_app_path(
            "chrome",
            "chrome.exe",
            [
                r"C:\Program Files\Google\Chrome\Application\chrome.exe",
                r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
                os.path.expandvars(r"%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"),
            ],
        ),
        "image": "chrome.exe",
        "label": "Google Chrome",
    },
    "edge": {
        "exe": _find_windows_app_path(
            "edge",
            "msedge.exe",
            [
                r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
                r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
                os.path.expandvars(r"%LOCALAPPDATA%\Microsoft\Edge\Application\msedge.exe"),
            ],
        ),
        "image": "msedge.exe",
        "label": "Microsoft Edge",
    },
    "vscode": {"exe": _find_vscode_path(), "image": "Code.exe", "label": "Visual Studio Code"},
    "cursor": {"exe": _find_cursor_path(), "image": "Cursor.exe", "label": "Cursor Editor"},
    "calculator": {
        "exe": _find_windows_app_path("calc", "calc.exe", [r"C:\Windows\System32\calc.exe"]),
        "shell": "calc",
        "image": "CalculatorApp.exe",
        "label": "Calculator",
    },
    "calc": {
        "exe": _find_windows_app_path("calc", "calc.exe", [r"C:\Windows\System32\calc.exe"]),
        "shell": "calc",
        "image": "CalculatorApp.exe",
        "label": "Calculator",
    },
    "file explorer": {
        "exe": _find_windows_app_path("explorer", "explorer.exe", [r"C:\Windows\explorer.exe"]),
        "image": "explorer.exe",
        "label": "File Explorer",
    },
    "file manager": {
        "exe": _find_windows_app_path("explorer", "explorer.exe", [r"C:\Windows\explorer.exe"]),
        "image": "explorer.exe",
        "label": "File Explorer",
    },
    "explorer": {
        "exe": _find_windows_app_path("explorer", "explorer.exe", [r"C:\Windows\explorer.exe"]),
        "image": "explorer.exe",
        "label": "File Explorer",
    },
    "task manager": {
        "exe": _find_windows_app_path("taskmgr", "Taskmgr.exe", [r"C:\Windows\System32\Taskmgr.exe"]),
        "shell": "taskmgr",
        "image": "Taskmgr.exe",
        "label": "Task Manager",
    },
    "taskmanager": {
        "exe": _find_windows_app_path("taskmgr", "Taskmgr.exe", [r"C:\Windows\System32\Taskmgr.exe"]),
        "shell": "taskmgr",
        "image": "Taskmgr.exe",
        "label": "Task Manager",
    },
    "settings": {"uwp": "ms-settings:", "image": "SystemSettings.exe", "label": "Settings"},
    "command prompt": {
        "exe": _find_windows_app_path("cmd", "cmd.exe", [r"C:\Windows\System32\cmd.exe"]),
        "image": "cmd.exe",
        "label": "Command Prompt",
    },
    "cmd": {
        "exe": _find_windows_app_path("cmd", "cmd.exe", [r"C:\Windows\System32\cmd.exe"]),
        "image": "cmd.exe",
        "label": "Command Prompt",
    },
    "powershell": {
        "exe": _find_windows_app_path(
            "powershell", "powershell.exe", [r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe"]
        ),
        "image": "powershell.exe",
        "label": "PowerShell",
    },
    "terminal": {
        "exe": _find_windows_app_path("wt", "wt.exe", [os.path.expandvars(r"%LOCALAPPDATA%\Microsoft\WindowsApps\wt.exe")]),
        "image": "WindowsTerminal.exe",
        "label": "Windows Terminal",
    },
    "wordpad": {"shell": "write", "image": "wordpad.exe", "label": "WordPad"},
    "paint": {
        "exe": _find_windows_app_path(
            "mspaint",
            "mspaint.exe",
            [r"C:\Windows\System32\mspaint.exe", os.path.expandvars(r"%LOCALAPPDATA%\Microsoft\WindowsApps\mspaint.exe")],
        ),
        "shell": "mspaint",
        "image": "mspaint.exe",
        "label": "Paint",
    },
    "snipping tool": {"uwp": "ms-screenclip:", "image": "ScreenClippingHost.exe", "label": "Snipping Tool"},
    "brave": {
        "exe": _find_windows_app_path(
            "brave",
            "brave.exe",
            [
                r"C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe",
                os.path.expandvars(r"%LOCALAPPDATA%\BraveSoftware\Brave-Browser\Application\brave.exe"),
            ],
        ),
        "image": "brave.exe",
        "label": "Brave Browser",
    },
    "firefox": {
        "exe": _find_windows_app_path(
            "firefox",
            "firefox.exe",
            [
                r"C:\Program Files\Mozilla Firefox\firefox.exe",
                r"C:\Program Files (x86)\Mozilla Firefox\firefox.exe",
            ],
        ),
        "image": "firefox.exe",
        "label": "Mozilla Firefox",
    },
    "spotify": {"shell": "spotify:", "image": "Spotify.exe", "label": "Spotify"},
    "whatsapp": {"uwp": "whatsapp:", "image": "WhatsApp.exe", "label": "WhatsApp"},
    "youtube": {"shell": "https://www.youtube.com", "image": "chrome.exe", "label": "YouTube"},
}


def _resolve_app(key: str) -> Dict[str, str]:
    norm = (key or "").strip().lower()
    if norm in APP_COMMANDS:
        return APP_COMMANDS[norm]
    # Allow loose aliases (e.g. "code", "visual studio code").
    aliases = {
        "code": "vscode",
        "visual studio code": "vscode",
        "vs code": "vscode",
        "vscode": "vscode",
        "vs": "vscode",
        "code editor": "vscode",
        "cursor": "cursor",
        "cursor ai": "cursor",
        "cursor editor": "cursor",
        "google chrome": "chrome",
        "browser": "chrome",
        "microsoft edge": "edge",
        "ms edge": "edge",
        "calc": "calculator",
        "calculator": "calculator",
        "settings app": "settings",
        "system settings": "settings",
        "file explorer": "file explorer",
        "file manager": "file explorer",
        "filemanager": "file explorer",
        "explorer": "file explorer",
        "files": "file explorer",
        "windows explorer": "file explorer",
        "this pc": "file explorer",
        "my computer": "file explorer",
        "pc": "file explorer",
        "windows terminal": "terminal",
        "wt": "terminal",
        "yt": "youtube",
        "you tube": "youtube",
        "paint": "paint",
        "mspaint": "paint",
        "task manager": "task manager",
        "taskmanager": "task manager",
        "taskmgr": "task manager",
        "powershell": "powershell",
        "pwsh": "powershell",
        "command prompt": "cmd",
        "cmd": "cmd",
    }
    if norm in aliases and aliases[norm] in APP_COMMANDS:
        return APP_COMMANDS[aliases[norm]]
    raise ToolError(
        f"Unrecognized application '{key}'. Supported: "
        f"{', '.join(sorted({v['label'] for v in APP_COMMANDS.values()}))}."
    )


def _launch(spec: Dict[str, str], extra_args: Optional[list[str]] = None) -> int:
    extra = [str(a) for a in extra_args] if extra_args else []
    try:
        if "exe" in spec:
            exe = spec["exe"]
            # If not an existing absolute path, attempt resolution
            if not (os.path.isabs(exe) and os.path.exists(exe)):
                exe = _find_windows_app_path(spec.get("label", "").lower(), exe)
            cmd = [exe] + extra
            if (os.path.isabs(exe) and os.path.exists(exe)) or shutil.which(exe):
                # Detached so we don't block the agent.
                proc = subprocess.Popen(
                    cmd,
                    shell=False,
                    close_fds=True,
                    creationflags=getattr(subprocess, "DETACHED_PROCESS", 0)
                    | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0),
                )
                return int(proc.pid or 0)
            else:
                args_str = " ".join(f'"{a}"' for a in extra)
                proc = subprocess.Popen(f'start "" "{exe}" {args_str}'.strip(), shell=True, close_fds=True)
                return int(proc.pid or 0)
        elif "shell" in spec:
            args_str = " ".join(f'"{a}"' for a in extra)
            proc = subprocess.Popen(
                f'start "" {spec["shell"]} {args_str}'.strip(), shell=True, close_fds=True
            )
            return int(proc.pid or 0)
        elif "uwp" in spec:
            proc = subprocess.Popen(
                f'start "" {spec["uwp"]}', shell=True, close_fds=True
            )
            return int(proc.pid or 0)
        else:
            raise ToolError(f"App spec for {spec.get('label')} is incomplete.")
    except Exception as e:  # noqa: BLE001
        raise ToolError(f"Could not launch {spec.get('label')}: {e}") from e


@register("openApplication")
def open_application(args: Dict[str, Any]) -> Dict[str, Any]:
    name = args.get("name") or args.get("application") or args.get("app")
    if not name:
        raise ToolError("Parameter 'name' (application name) is required.")
    spec = _resolve_app(str(name))

    extra_args: list[str] = []
    target = args.get("path") or args.get("file") or args.get("folder") or args.get("target")
    if target:
        from .tools_files import _resolve_folder
        try:
            resolved = _resolve_folder(str(target))
            extra_args.append(str(resolved))
        except Exception:
            extra_args.append(str(target))

    pid = _launch(spec, extra_args)
    if target:
        return {
            "result": f"{spec['label']} opened with {target}.",
            "launched": True,
            "appName": spec["label"],
            "pid": pid,
            "path": str(target),
            "verified": True,
        }
    return {
        "result": f"{spec['label']} opened.",
        "launched": True,
        "appName": spec["label"],
        "pid": pid,
        "verified": True,
    }


@register("openInVsCode")
def open_in_vscode(args: Dict[str, Any]) -> Dict[str, Any]:
    """Open a file or project folder in Visual Studio Code."""
    path_arg = args.get("path") or args.get("folder") or args.get("file") or os.getcwd()
    from pathlib import Path
    from .tools_files import _resolve_folder, _resolve_file
    raw = str(path_arg).strip()
    p = Path(raw)
    if p.suffix:
        try:
            resolved = _resolve_file(raw)
        except Exception:
            resolved = _resolve_folder(raw)
    else:
        resolved = _resolve_folder(raw)
    vscode_exe = _find_vscode_path()
    proc = subprocess.Popen(
        [vscode_exe, str(resolved)],
        shell=False,
        close_fds=True,
        creationflags=getattr(subprocess, "DETACHED_PROCESS", 0)
        | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0),
    )
    return {
        "result": f"Opened {resolved} in Visual Studio Code.",
        "path": str(resolved),
        "launched": True,
        "appName": "Visual Studio Code",
        "pid": int(proc.pid or 0),
        "verified": True,
    }


@register("closeApplication")
def close_application(args: Dict[str, Any]) -> Dict[str, Any]:
    name = args.get("name") or args.get("application")
    force = bool(args.get("force", False))
    if not name:
        raise ToolError("Parameter 'name' (application name) is required.")
    spec = _resolve_app(str(name))
    image = spec["image"]
    # Graceful close first (WM_CLOSE via taskkill), then force if requested.
    graceful_flag = "" if force else ""
    force_flag = " /F" if force else ""
    try:
        # taskkill returns non-zero if the process isn't running — that's fine.
        subprocess.run(
            f'taskkill /IM "{image}"{graceful_flag}{force_flag}',
            shell=True,
            capture_output=True,
            timeout=10,
        )
    except Exception as e:  # noqa: BLE001
        raise ToolError(f"Could not close {spec['label']}: {e}") from e
    # Give the OS a moment to actually tear it down.
    time.sleep(0.2)
    return {"result": f"Closed {spec['label']}."}


__all__ = ["open_application", "close_application", "APP_COMMANDS"]
