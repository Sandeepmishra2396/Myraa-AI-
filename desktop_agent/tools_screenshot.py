"""
Screenshot & screen-reading: capture, save, OCR, and read on-screen text.

  takeScreenshot    -> capture full screen, return metadata (+ small base64)
  saveScreenshot    -> capture & write to a file under the Screenshots folder
  analyzeScreenshot-> capture, run OCR (pytesseract), return extracted text
  readScreen        -> OCR the active window region + name the active window

OCR requires the Tesseract OCR engine + the pytesseract wrapper. If either is
missing, the OCR tools return a graceful 'unavailable' message instead of
crashing; non-OCR capture still works.
"""

from __future__ import annotations

import base64
import io
import os
import shutil
import time
from pathlib import Path
from typing import Any, Dict, Optional

from .registry import ToolError, register

SCREENSHOTS_DIR = Path(os.path.expanduser("~")) / "Pictures" / "SoraScreenshots"


def _capture() -> "Any":
    """Capture the full virtual screen as a PIL Image."""
    try:
        from PIL import ImageGrab

        return ImageGrab.grab(all_screens=True)
    except Exception:
        try:
            from PIL import ImageGrab

            return ImageGrab.grab(all_screens=False)
        except Exception:
            try:
                import pyautogui

                return pyautogui.screenshot()
            except Exception as e:  # noqa: BLE001
                raise ToolError(f"Screen capture failed: {e}")


def _capture_region(bbox):
    try:
        from PIL import ImageGrab

        return ImageGrab.grab(bbox=bbox, all_screens=False)
    except Exception:
        try:
            import pyautogui

            # bbox is (left, top, right, bottom)
            region = (bbox[0], bbox[1], bbox[2] - bbox[0], bbox[3] - bbox[1])
            return pyautogui.screenshot(region=region)
        except Exception as e:  # noqa: BLE001
            raise ToolError(f"Region capture failed: {e}")


def _active_window_bbox():
    """Return (left, top, right, bottom) of the foreground window, or None."""
    try:
        import win32gui

        hwnd = win32gui.GetForegroundWindow()
        if not hwnd:
            return None
        rect = win32gui.GetWindowRect(hwnd)  # (l, t, r, b)
        return rect
    except Exception:
        return None


def _active_window_title() -> str:
    try:
        import win32gui

        hwnd = win32gui.GetForegroundWindow()
        return win32gui.GetWindowText(hwnd) if hwnd else ""
    except Exception:
        return ""


def _image_to_b64(img, fmt="PNG", quality=70) -> str:
    buf = io.BytesIO()
    if fmt.upper() == "JPEG":
        img.convert("RGB").save(buf, format="JPEG", quality=quality)
    else:
        img.save(buf, format=fmt)
    return base64.b64encode(buf.getvalue()).decode("ascii")


def _image_size_kb(img) -> int:
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return len(buf.getvalue()) // 1024


def _run_ocr(img) -> str:
    try:
        import pytesseract
    except ImportError:
        raise ToolError(
            "OCR unavailable: the 'pytesseract' package is not installed."
        )
    # Ensure the Tesseract binary is discoverable.
    exe = os.environ.get("TESSERACT_PATH") or _find_tesseract_exe()
    if exe:
        pytesseract.pytesseract.tesseract_cmd = exe
        tessdata_dir = os.path.join(os.path.dirname(exe), "tessdata")
        if os.path.isdir(tessdata_dir) and not os.environ.get("TESSDATA_PREFIX"):
            os.environ["TESSDATA_PREFIX"] = tessdata_dir
    else:
        raise ToolError(
            "OCR failed: Tesseract OCR engine was not found on this system. "
            "Please ensure Tesseract is installed or specify TESSERACT_PATH."
        )
    try:
        return pytesseract.image_to_string(img)
    except Exception as e:  # noqa: BLE001
        raise ToolError(
            "OCR failed (is the Tesseract engine installed?). Detail: " + str(e)
        )


def _find_tesseract_exe() -> Optional[str]:
    # 1. System PATH lookup
    which_path = shutil.which("tesseract") or shutil.which("tesseract.exe")
    if which_path and os.path.isfile(which_path):
        return which_path

    # 2. Common Windows user and system directories
    candidates = []

    # Per-user AppData installation (e.g. C:\Users\<User>\AppData\Local\Programs\Tesseract-OCR\tesseract.exe)
    local_app_data = os.environ.get("LOCALAPPDATA")
    if local_app_data:
        candidates.append(os.path.join(local_app_data, "Programs", "Tesseract-OCR", "tesseract.exe"))

    try:
        candidates.append(str(Path.home() / "AppData" / "Local" / "Programs" / "Tesseract-OCR" / "tesseract.exe"))
    except Exception:
        pass

    # Program Files (64-bit and 32-bit)
    prog_files = os.environ.get("PROGRAMFILES", r"C:\Program Files")
    candidates.append(os.path.join(prog_files, "Tesseract-OCR", "tesseract.exe"))

    prog_files_x86 = os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)")
    candidates.append(os.path.join(prog_files_x86, "Tesseract-OCR", "tesseract.exe"))

    # Explicit drive letter fallbacks
    candidates.extend([
        r"C:\Program Files\Tesseract-OCR\tesseract.exe",
        r"C:\Program Files (x86)\Tesseract-OCR\tesseract.exe",
        r"C:\Tesseract-OCR\tesseract.exe",
        r"D:\Tesseract-OCR\tesseract.exe",
    ])

    for c in candidates:
        if c and os.path.isfile(c):
            return c
    return None


def _trim_ocr(text: str, max_chars: int = 1500) -> str:
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    out = "\n".join(lines)
    if len(out) > max_chars:
        out = out[:max_chars] + "…"
    return out


@register("takeScreenshot")
def take_screenshot(args: Dict[str, Any]) -> Dict[str, Any]:
    img = _capture()
    include_image = bool(args.get("include_image", False))
    result: Dict[str, Any] = {
        "result": f"Captured screen ({img.width}x{img.height}).",
        "width": img.width,
        "height": img.height,
    }
    if include_image:
        # Downscale + JPEG to keep payload small for the WS bridge.
        max_dim = int(args.get("max_dim", 1280))
        if max(img.size) > max_dim:
            ratio = max_dim / max(img.size)
            img_small = img.resize(
                (max(1, int(img.width * ratio)), max(1, int(img.height * ratio)))
            )
        else:
            img_small = img
        result["image_base64"] = _image_to_b64(img_small, fmt="JPEG", quality=60)
        result["image_mime"] = "image/jpeg"
    return result


@register("saveScreenshot")
def save_screenshot(args: Dict[str, Any]) -> Dict[str, Any]:
    img = _capture()
    SCREENSHOTS_DIR.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    name = args.get("name")
    fname = f"{name}-{stamp}.png" if name else f"screenshot-{stamp}.png"
    out_path = SCREENSHOTS_DIR / fname
    img.save(out_path, format="PNG")
    return {"result": f"Saved screenshot to {out_path}.", "path": str(out_path)}


@register("analyzeScreenshot")
def analyze_screenshot(args: Dict[str, Any]) -> Dict[str, Any]:
    img = _capture()
    try:
        text = _run_ocr(img)
    except ToolError as e:
        return {"result": f"Screenshot captured, but OCR unavailable: {e.message}"}
    return {
        "result": "Screenshot analyzed via OCR.",
        "text": _trim_ocr(text, int(args.get("max_chars", 1500))),
    }


@register("readScreen")
def read_screen(args: Dict[str, Any]) -> Dict[str, Any]:
    """OCR the active window and report its title + visible text."""
    title = _active_window_title()
    bbox = _active_window_bbox()
    if bbox:
        try:
            img = _capture_region(bbox)
        except ToolError:
            img = _capture()
    else:
        img = _capture()
    try:
        text = _run_ocr(img)
        visible = _trim_ocr(text, int(args.get("max_chars", 1500))) or "(no readable text)"
    except ToolError as e:
        return {
            "result": f"Active window: {title or 'unknown'}. OCR unavailable: {e.message}",
            "active_window": title,
        }
    return {
        "result": f"Active window '{title or 'unknown'}' contains readable text.",
        "active_window": title,
        "text": visible,
    }


__all__ = [
    "take_screenshot",
    "save_screenshot",
    "analyze_screenshot",
    "read_screen",
]
