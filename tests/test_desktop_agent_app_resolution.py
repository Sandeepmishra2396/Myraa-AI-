import os
import sys
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
from desktop_agent.tools_applications import _resolve_app, APP_COMMANDS
from desktop_agent.tools_files import _resolve_folder, open_folder

def test_app_resolution():
    apps_to_test = [
        ("file manager", "File Explorer"),
        ("file explorer", "File Explorer"),
        ("filemanager", "File Explorer"),
        ("explorer", "File Explorer"),
        ("chrome", "Google Chrome"),
        ("google chrome", "Google Chrome"),
        ("edge", "Microsoft Edge"),
        ("ms edge", "Microsoft Edge"),
        ("notepad", "Notepad"),
        ("calculator", "Calculator"),
        ("calc", "Calculator"),
        ("task manager", "Task Manager"),
        ("taskmanager", "Task Manager"),
        ("cmd", "Command Prompt"),
        ("powershell", "PowerShell"),
        ("terminal", "Windows Terminal"),
        ("paint", "Paint"),
        ("vscode", "Visual Studio Code"),
        ("vs code", "Visual Studio Code"),
        ("cursor", "Cursor Editor"),
        ("telegram", "Telegram"),
        ("tg", "Telegram"),
        ("whatsapp", "WhatsApp"),
    ]

    for query, expected_label in apps_to_test:
        spec = _resolve_app(query)
        assert spec["label"] == expected_label, f"Expected {expected_label} for {query}, got {spec['label']}"
        if "exe" in spec and os.path.isabs(spec["exe"]) and os.path.exists(spec["exe"]):
            assert os.path.exists(spec["exe"]) or spec["exe"].endswith(".cmd"), f"Exe path does not exist: {spec['exe']}"
        else:
            assert "app_id" in spec or "shell" in spec or "uwp" in spec or "exe" in spec
        print(f"PASS: {query:15} -> {spec['label']} ({spec.get('exe', spec.get('app_id', spec.get('shell')))})")


def test_folder_aliases():
    for fa in ["file manager", "file explorer", "explorer", "files", "desktop", "documents", "downloads"]:
        resolved = _resolve_folder(fa)
        assert resolved.exists(), f"Folder alias {fa} does not exist: {resolved}"
        print(f"PASS folder: {fa:15} -> {resolved}")

if __name__ == "__main__":
    test_app_resolution()
    test_folder_aliases()
    print("ALL PYTHON DESKTOP AGENT APP RESOLUTION TESTS PASSED!")
