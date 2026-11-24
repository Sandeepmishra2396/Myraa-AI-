# Sora AI / MYRAA — Dependency & Supply Chain Security Review

**Date:** 2026-11-24  
**Project:** Sora AI / MYRAA Desktop  
**Target Path:** `D:\SORA AI\Sora AI`  

---

## 1. Ecosystem Overview

The Sora AI project manages dependencies across two separate ecosystems:
1. **Node.js / NPM Ecosystem:** Managed via `package.json` and `package-lock.json` for the Electron desktop shell, React frontend, and Node backend.
2. **Python Ecosystem:** Managed via `desktop_agent/requirements.txt` for the local desktop automation daemon.

---

## 2. Node.js / NPM Dependency Review

### Direct Production Dependencies (`package.json`)

| Package | Declared Version | Category | Security Assessment & Status |
| :--- | :---: | :---: | :--- |
| `@google/genai` | `^2.4.0` | AI SDK | Official Google Gen AI SDK. Actively maintained; TLS v1.3 encrypted endpoints. |
| `@pixiv/three-vrm` | `^3.5.5` | 3D Rendering | Handles 3D avatar rendering. No known high/critical CVEs. |
| `@tailwindcss/vite` | `^4.1.14` | Styling | Build-time Tailwind CSS integration. |
| `@types/three` | `^0.186.0` | Types | TypeScript type definitions. |
| `@vitejs/plugin-react` | `^5.0.4` | Build Plugin | Official Vite React plugin. |
| `dotenv` | `^17.2.3` | Configuration | Environment configuration loader. |
| `express` | `^4.21.2` | Web Framework | **Note:** Express 4.x has known history regarding prototype pollution in older query parsers; `^4.21.2` addresses earlier body-parser vulnerabilities. Keep updated to Express 5 when stable. |
| `lucide-react` | `^0.546.0` | UI Icons | Icon bundle; zero runtime vulnerability footprint. |
| `motion` | `^12.23.24` | Animation | Framer Motion modern package. Safe. |
| `react` / `react-dom`| `^19.0.1` | UI Engine | Modern React 19 stable release. Safe. |
| `three` | `^0.186.0` | 3D Graphics | WebGL / 3D engine. |
| `vite` | `^6.2.3` | Dev/Build Server| Vite 6 modern release. Fast dev server and asset pipeline. |
| `ws` | `^8.21.0` | WebSocket | High-performance WebSocket library. `ws` >= 8.17.1 mitigates ReDoS issues in Sec-WebSocket-Extensions header parsing (CVE-2024-37890). `8.21.0` is current and patched. |

### Development Dependencies (`devDependencies`)

| Package | Declared Version | Notes |
| :--- | :---: | :--- |
| `electron` | `^43.1.0` | Chromium / Node.js desktop framework. Includes modern sandboxing capabilities. Ensure `contextIsolation: true` and `nodeIntegration: false` remain strictly enforced. |
| `electron-builder` | `^26.15.3` | Windows NSIS / portable installer packaging tool. |
| `esbuild` | `^0.25.0` | Fast bundler for backend server. |
| `tailwindcss` | `^4.1.14` | Utility-first CSS framework. |
| `tsx` | `^4.21.0` | TypeScript execution engine for development. |
| `typescript` | `~5.8.2` | TypeScript compiler. |
| `vitest` | `^5.0.1` | Test framework. |

---

## 3. Python Dependency Review (`desktop_agent/requirements.txt`)

| Package | Pinned Version | Role / Privilege | Security Assessment |
| :--- | :---: | :--- | :--- |
| `fastapi` | `0.115.6` | HTTP API Engine | Current release; Pydantic-backed request validation. |
| `uvicorn[standard]` | `0.34.0` | ASGI Server | Async HTTP server engine. |
| `pyautogui` | `0.9.54` | OS Automation | Native mouse/keyboard synthesis. High privilege; requires input sanitization. |
| `playwright` | `1.49.1` | Headless Browser | Automates browser sessions. Ensure browser contexts do not leak user cookies. |
| `psutil` | `6.1.1` | System Monitoring | Process inspection and management. |
| `pywin32` | `308` | Windows Win32 API | Native Windows API bindings. High system privilege. |
| `pyperclip` | `1.9.0` | Clipboard Access | Accesses clipboard data. Potential risk of sensitive credential scraping if unauthenticated. |
| `pytesseract` | `0.3.13` | OCR Engine | Python wrapper for Tesseract. |
| `Pillow` | `11.0.0` | Image Processing | Modern Pillow release. Legacy image decompression vulnerabilities are resolved in 11.x. |
| `pycaw` | `20230407` | Audio Control | Windows Core Audio API wrapper. |
| `pygetwindow` | `0.0.9` | Window Management | Enumerates and controls application windows. |
| `Send2Trash` | `1.8.3` | File Management | Safely sends files to the Windows Recycle Bin rather than permanently deleting them. |
| `python-multipart` | `0.0.20` | Form Parsing | Resolves earlier DoS vulnerabilities (CVE-2024-24762). |
| `nvidia-ml-py3` | `7.352.0` | GPU Stats | Optional GPU diagnostic metrics. |

---

## 4. Supply Chain & Packaging Findings

1. **PyInstaller Binary Integrity:**
   The production build produces `myraa-agent.exe` via PyInstaller (spec file: `desktop_agent.spec`).
   - *Risk:* PyInstaller binaries unpack into a temporary directory at runtime (`%TEMP%\_MEIxxxxxx`). If permissions on `%TEMP%` allow other local users to modify DLLs during extraction, binary preloading / DLL hijacking can occur.
   - *Recommendation:* Ensure the runtime unpack directory is created with restricted user ACLs or build as a single directory bundle inside `%LOCALAPPDATA%`.
2. **Missing Dependency Pinning in Node:**
   `package.json` uses caret (`^`) version ranges for critical libraries (e.g. `express`, `ws`, `electron`).
   - *Risk:* Automated CI builds could inadvertently pull minor or patch releases that alter behavior.
   - *Recommendation:* Maintain `package-lock.json` committed to version control and run `npm ci` in automated builds.
3. **Execution Policy Bypass in Packaging Scripts:**
   Several build and maintenance scripts in `electron/scripts/` utilize PowerShell with `-ExecutionPolicy Bypass`.
   - *Recommendation:* Ensure release scripts are digitally signed with an Authenticode code-signing certificate (as configured in `electron/scripts/signWindowsExecutable.cjs`).
