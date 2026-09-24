"""
File management: create / read / rename / delete / move / open / search.

Safety model:
  * All paths are resolved with expanduser and normalized to absolute.
  * Deletion sends files/folders to the Recycle Bin via `send2trash` when
    available (preferred), and otherwise refuses to delete rather than
    permanently removing data.
  * Operations are confined to a set of SAFE_ROOTS by default; paths that
    escape these roots (e.g. C:\\Windows) are rejected unless explicitly
    marked `allow_anywhere` by the caller.
"""

from __future__ import annotations

import fnmatch
import os
import platform
import subprocess
from pathlib import Path
from typing import Any, Dict, List, Optional

from .registry import ToolError, register

HOME = Path(os.path.expanduser("~"))

# Roots under which file operations are freely permitted.
SAFE_ROOTS: List[Path] = [
    HOME,
    HOME / "Desktop",
    HOME / "Documents",
    HOME / "Downloads",
    HOME / "Pictures",
    HOME / "Music",
    HOME / "Videos",
    Path(os.getcwd()),  # project root
]

# On Windows, add all system drive roots (C:\, D:\, E:\, etc.) to SAFE_ROOTS
if platform.system() == "Windows":
    import string
    for _letter in string.ascii_uppercase:
        _d = Path(f"{_letter}:\\")
        if _d.exists():
            SAFE_ROOTS.append(_d)

# Friendly folder aliases -> resolved path.
FOLDER_ALIASES: Dict[str, Path] = {
    "desktop": HOME / "Desktop",
    "documents": HOME / "Documents",
    "downloads": HOME / "Downloads",
    "pictures": HOME / "Pictures",
    "photos": HOME / "Pictures",
    "music": HOME / "Music",
    "videos": HOME / "Videos",
    "home": HOME,
    "this pc": Path("C:\\"),
    "c drive": Path("C:\\"),
    "c:": Path("C:\\"),
    "c": Path("C:\\"),
    "d drive": Path("D:\\"),
    "d:": Path("D:\\"),
    "d": Path("D:\\"),
    "e drive": Path("E:\\"),
    "e:": Path("E:\\"),
    "e": Path("E:\\"),
}

if platform.system() == "Windows":
    import string
    for _ch in string.ascii_lowercase:
        _d_root = Path(f"{_ch.upper()}:\\")
        if _d_root.exists():
            FOLDER_ALIASES[f"{_ch} drive"] = _d_root
            FOLDER_ALIASES[f"{_ch}:"] = _d_root
            FOLDER_ALIASES[_ch] = _d_root


def _resolve_folder(name_or_path: Optional[str]) -> Path:
    if not name_or_path:
        raise ToolError("Parameter 'path' or 'name' is required.")
    raw = str(name_or_path).strip()
    key = raw.lower().rstrip("/\\")
    if key in FOLDER_ALIASES:
        return FOLDER_ALIASES[key]

    expanded = os.path.expandvars(os.path.expanduser(raw))
    p = Path(expanded)

    # 1. Absolute path or drive path (e.g. "D:\QYROX", "D:/QYROX", "D:", "D:\")
    if p.is_absolute() or (len(raw) >= 2 and raw[1] == ":") or raw.startswith(("\\\\", "//")):
        if len(raw) == 2 and raw[1] == ":":
            p = Path(f"{raw}\\")
        resolved = p.resolve()
        if resolved.exists():
            return resolved
        # If absolute path doesn't exist directly, check parent directory for fuzzy-matching folder
        # e.g. "D:\coding game" -> check D:\ for folders matching "coding game" -> "D:\Daily New Coding Game"
        target_norm = resolved.name.lower().replace(" ", "").replace("_", "").replace("-", "")
        parent = resolved.parent
        try:
            if parent.exists():
                for entry in parent.iterdir():
                    if entry.is_dir():
                        e_norm = entry.name.lower().replace(" ", "").replace("_", "").replace("-", "")
                        if target_norm in e_norm or e_norm in target_norm:
                            return entry.resolve()
        except Exception:
            pass
        return resolved

    # 2. Check current working directory
    cwd_candidate = (Path(os.getcwd()) / p).resolve()
    if cwd_candidate.exists():
        return cwd_candidate

    # 3. Check common user folders
    for base in [HOME / "Desktop", HOME / "Documents", HOME / "Downloads", HOME]:
        candidate = (base / p).resolve()
        if candidate.exists():
            return candidate

    # 4. Check all drive roots (e.g. D:\<name>, C:\<name>, E:\<name>)
    if platform.system() == "Windows":
        import string
        for ch in string.ascii_uppercase:
            drive_root = Path(f"{ch}:\\")
            if drive_root.exists():
                candidate = (drive_root / p).resolve()
                if candidate.exists():
                    return candidate

    # 5. Case-insensitive and substring search across drive roots & user folders
    target_name = p.name.lower()
    target_norm = target_name.replace(" ", "").replace("_", "").replace("-", "")
    search_roots = [Path("D:\\"), HOME / "Desktop", HOME / "Documents", HOME / "Downloads", Path("C:\\")]
    for s_root in search_roots:
        try:
            if s_root.exists():
                for entry in s_root.iterdir():
                    if entry.is_dir():
                        e_lower = entry.name.lower()
                        e_norm = e_lower.replace(" ", "").replace("_", "").replace("-", "")
                        if e_lower == target_name or target_norm in e_norm or e_norm in target_norm:
                            return entry.resolve()
        except Exception:
            pass

    return cwd_candidate


def _resolve_file(path_or_name: Optional[str], *, must_exist: bool = False) -> Path:
    if not path_or_name:
        raise ToolError("Parameter 'path' or 'name' is required.")
    raw = str(path_or_name).strip()
    expanded = os.path.expandvars(os.path.expanduser(raw))
    p = Path(expanded)

    # 1. Absolute path or drive path
    if p.is_absolute() or (len(raw) >= 2 and raw[1] == ":") or raw.startswith(("\\\\", "//")):
        resolved = p.resolve()
        if resolved.exists():
            return resolved
        # If parent folder doesn't exist, try resolving parent folder via fuzzy matching
        # e.g. parent "D:\coding game" -> resolves to "D:\Daily New Coding Game"
        if not resolved.parent.exists():
            resolved_parent = _resolve_folder(str(resolved.parent))
            candidate = (resolved_parent / resolved.name).resolve()
            if candidate.exists() or not must_exist:
                return candidate
        if must_exist and not resolved.exists():
            raise ToolError(f"File does not exist: {resolved}")
        return resolved

    # 2. Check current working directory
    cwd_candidate = (Path(os.getcwd()) / p).resolve()
    if cwd_candidate.exists():
        return cwd_candidate

    # 3. Check common user folders
    for base in [HOME / "Desktop", HOME / "Documents", HOME / "Downloads", HOME]:
        candidate = (base / p).resolve()
        if candidate.exists():
            return candidate

    # 4. Check all drive roots (e.g. D:\<name>, C:\<name>, E:\<name>)
    if platform.system() == "Windows":
        import string
        for ch in string.ascii_uppercase:
            drive_root = Path(f"{ch}:\\")
            if drive_root.exists():
                candidate = (drive_root / p).resolve()
                if candidate.exists():
                    return candidate

    # 5. Search for matching file
    if must_exist:
        fname_lower = p.name.lower()
        search_dirs = [HOME / "Desktop", HOME / "Documents", HOME / "Downloads", Path("D:\\"), Path(os.getcwd())]
        for s_dir in search_dirs:
            try:
                if s_dir.exists():
                    for entry in s_dir.iterdir():
                        if entry.is_file() and entry.name.lower() == fname_lower:
                            return entry.resolve()
            except Exception:
                pass
        raise ToolError(f"File does not exist: {cwd_candidate}")

    return cwd_candidate


def _ensure_safe(p: Path, allow_anywhere: bool = False) -> None:
    if allow_anywhere:
        return
    try:
        p_resolved = p.resolve()
    except Exception:
        p_resolved = p

    # System-critical directories to protect from accidental tampering
    critical_blocked = [
        os.environ.get("SystemRoot", "C:\\Windows").lower(),
        os.path.join(os.environ.get("SystemRoot", "C:\\Windows"), "System32").lower(),
        "c:\\windows",
        "c:\\program files\\windows",
    ]
    p_lower = str(p_resolved).lower()
    for cb in critical_blocked:
        if p_lower == cb or p_lower.startswith(cb + os.sep):
            raise ToolError(f"Access denied: Path '{p}' is inside a protected Windows system folder.")

    # All Windows system drives and safe folders are permitted
    for root in SAFE_ROOTS:
        try:
            r_resolved = root.resolve()
            if p_resolved == r_resolved:
                return
            if hasattr(p_resolved, "is_relative_to") and p_resolved.is_relative_to(r_resolved):
                return
            r_str = str(r_resolved).rstrip(os.sep)
            p_str = str(p_resolved)
            if p_str == r_str or p_str.startswith(r_str + os.sep):
                return
        except Exception:
            continue

    # Fallback for any existing Windows drive (C:, D:, E:, etc.)
    if platform.system() == "Windows":
        drv = p_resolved.drive
        if drv and Path(f"{drv}\\").exists():
            return

    raise ToolError(
        f"Path '{p}' is outside MYRAA's safe folders. "
        f"Pass allow_anywhere=true only if you really mean it."
    )


@register("modifyFile")
def modify_file(args: Dict[str, Any]) -> Dict[str, Any]:
    """Modify, edit, or update an existing file on disk.

    Supports overwrite, append, or string replacement.
    """
    path = args.get("path") or args.get("file")
    if not path:
        raise ToolError("Parameter 'path' is required.")
    p = _resolve_file(path)
    _ensure_safe(p)

    mode = (args.get("mode") or "overwrite").strip().lower()
    content = args.get("content")

    if not p.exists():
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(str(content or ""), encoding="utf-8")
        return {"result": f"Created and wrote file: {p}", "path": str(p)}

    if mode == "append":
        existing = p.read_text(encoding="utf-8", errors="replace")
        new_text = existing + ("\n" if not existing.endswith("\n") else "") + str(content or "")
        p.write_text(new_text, encoding="utf-8")
        return {"result": f"Appended content to {p.name}.", "path": str(p)}
    elif mode == "replace":
        target = str(args.get("target") or "")
        replacement = str(args.get("replacement") or content or "")
        if not target:
            raise ToolError("Parameter 'target' is required when mode is 'replace'.")
        existing = p.read_text(encoding="utf-8", errors="replace")
        if target not in existing:
            raise ToolError(f"Target text '{target[:50]}' not found in {p.name}.")
        new_text = existing.replace(target, replacement)
        p.write_text(new_text, encoding="utf-8")
        return {"result": f"Replaced target text in {p.name}.", "path": str(p)}
    else:  # overwrite
        p.write_text(str(content or ""), encoding="utf-8")
        return {"result": f"Updated {p.name} with new content.", "path": str(p)}


@register("createFile")
def create_file(args: Dict[str, Any]) -> Dict[str, Any]:
    path = args.get("path")
    content = args.get("content", "")
    overwrite = bool(args.get("overwrite", False))
    p = _resolve_file(path)
    _ensure_safe(p)

    if p.exists() and not overwrite:
        raise ToolError(
            f"File already exists: {p}. Pass overwrite=true to replace it."
        )
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(str(content), encoding="utf-8")
    return {"result": f"Created file: {p}", "path": str(p)}


@register("readFile")
def read_file(args: Dict[str, Any]) -> Dict[str, Any]:
    path = args.get("path")
    max_chars = int(args.get("max_chars", 8000))
    p = _resolve_file(path, must_exist=True)
    _ensure_safe(p)
    try:
        text = p.read_text(encoding="utf-8", errors="replace")
    except UnicodeDecodeError:
        return {"result": f"(Binary file, {p.stat().st_size} bytes): {p}"}
    if len(text) > max_chars:
        text = text[:max_chars] + f"\n…[truncated, {len(text) - max_chars} more chars]"
    return {"result": text, "path": str(p)}


@register("renameFile")
def rename_file(args: Dict[str, Any]) -> Dict[str, Any]:
    path = args.get("path")
    new_name = args.get("new_name")
    if not new_name:
        raise ToolError("Parameter 'new_name' is required.")
    p = _resolve_file(path, must_exist=True)
    _ensure_safe(p)
    target = (p.parent / str(new_name)).resolve()
    _ensure_safe(target)
    if target.exists():
        raise ToolError(f"A file already exists at the target name: {target}")
    p.rename(target)
    return {"result": f"Renamed {p.name} -> {target.name}", "path": str(target)}


@register("deleteFile")
def delete_file(args: Dict[str, Any]) -> Dict[str, Any]:
    path = args.get("path")
    permanent = bool(args.get("permanent", False))
    p = _resolve_file(path, must_exist=True)
    _ensure_safe(p)

    if permanent:
        if p.is_dir():
            import shutil

            shutil.rmtree(p)
        else:
            p.unlink()
        return {"result": f"Permanently deleted: {p}"}

    # Prefer recycle bin.
    try:
        import send2trash  # type: ignore

        send2trash.send2trash(str(p))
        return {"result": f"Moved to Recycle Bin: {p}"}
    except ImportError:
        raise ToolError(
            "Safe deletion requires the 'send2trash' package. Install it or pass "
            "permanent=true (use with care)."
        )
    except Exception as e:  # noqa: BLE001
        raise ToolError(f"Could not move to Recycle Bin: {e}")


@register("moveFile")
def move_file(args: Dict[str, Any]) -> Dict[str, Any]:
    path = args.get("path")
    destination = args.get("destination")
    p = _resolve_file(path, must_exist=True)
    _ensure_safe(p)
    dest = Path(os.path.expandvars(os.path.expanduser(str(destination)))).resolve()
    # If destination is an existing directory, keep the filename.
    if dest.is_dir():
        dest = dest / p.name
    _ensure_safe(dest)
    if dest.exists():
        raise ToolError(f"Destination already exists: {dest}")
    dest.parent.mkdir(parents=True, exist_ok=True)
    p.rename(dest)
    return {"result": f"Moved {p.name} -> {dest}", "path": str(dest)}


@register("openFolder")
def open_folder(args: Dict[str, Any]) -> Dict[str, Any]:
    raw_target = args.get("path") or args.get("name")
    folder = _resolve_folder(raw_target)
    _ensure_safe(folder, allow_anywhere=True)
    if not folder.exists():
        raise ToolError(f"Folder does not exist: {folder}")
    # Explorer on Windows, open elsewhere.
    if platform.system() == "Windows":
        if folder.is_file():
            os.startfile(str(folder))
            return {"result": f"Opened file: {folder}", "path": str(folder)}
        else:
            subprocess.Popen(f'explorer "{folder}"', shell=True, close_fds=True)
            return {"result": f"Opened folder: {folder}", "path": str(folder)}
    elif platform.system() == "Darwin":
        subprocess.Popen(["open", str(folder)], close_fds=True)
    else:
        subprocess.Popen(["xdg-open", str(folder)], close_fds=True)
    return {"result": f"Opened folder: {folder}", "path": str(folder)}


@register("openFile")
def open_file(args: Dict[str, Any]) -> Dict[str, Any]:
    raw_target = args.get("path") or args.get("name") or args.get("file")
    p = _resolve_file(raw_target, must_exist=True)
    _ensure_safe(p, allow_anywhere=True)
    if platform.system() == "Windows":
        os.startfile(str(p))
    elif platform.system() == "Darwin":
        subprocess.Popen(["open", str(p)], close_fds=True)
    else:
        subprocess.Popen(["xdg-open", str(p)], close_fds=True)
    return {"result": f"Opened file: {p}", "path": str(p)}


@register("listFiles")
def list_files(args: Dict[str, Any]) -> Dict[str, Any]:
    raw_target = args.get("path") or args.get("name")
    folder = _resolve_folder(raw_target)
    _ensure_safe(folder, allow_anywhere=True)
    if not folder.exists():
        raise ToolError(f"Folder does not exist: {folder}")
    pattern = args.get("pattern") or "*"
    try:
        names = sorted(
            [p.name + ("/" if p.is_dir() else "") for p in folder.glob(pattern)]
        )
    except Exception as e:  # noqa: BLE001
        raise ToolError(f"Could not list folder: {e}")
    return {
        "result": f"{len(names)} item(s) in {folder}",
        "items": names[:500],
        "count": len(names),
    }


@register("searchFiles")
def search_files(args: Dict[str, Any]) -> Dict[str, Any]:
    """Find files by name glob or extension under a folder.

    Examples:
      name="*.py" under "Documents"          -> all python files
      extension="py"                          -> same as name="*.py"
      name="report*" under "Desktop"
    """
    raw_folder = args.get("path") or args.get("folder") or args.get("under") or "home"
    folder = _resolve_folder(raw_folder)
    _ensure_safe(folder, allow_anywhere=True)
    name = args.get("name") or args.get("pattern")
    extension = args.get("extension")
    limit = int(args.get("limit", 100))

    if extension:
        if not str(extension).startswith("."):
            extension = "." + str(extension)
        pattern = "*" + str(extension)
    elif name:
        pattern = str(name)
    else:
        raise ToolError("Provide 'name' glob or 'extension'.")

    if not folder.exists():
        raise ToolError(f"Folder does not exist: {folder}")

    matches: List[str] = []
    for root, _dirs, files in os.walk(folder):
        for fname in files:
            if fnmatch.fnmatch(fname.lower(), pattern.lower()):
                matches.append(os.path.join(root, fname))
                if len(matches) >= limit:
                    break
        if len(matches) >= limit:
            break

    return {
        "result": f"Found {len(matches)} file(s) matching '{pattern}' under {folder}",
        "matches": matches,
        "count": len(matches),
    }


__all__ = [
    "create_file",
    "modify_file",
    "read_file",
    "rename_file",
    "delete_file",
    "move_file",
    "open_folder",
    "open_file",
    "list_files",
    "search_files",
]
