# MYRAA v1.0.0 — Production Release

**MYRAA v1.0.0** is the general-availability production release of the MYRAA Autonomous AI Companion across **Android** and **Windows Desktop**, backed by the live cloud production infrastructure (`https://myraa-ai-q0h3.onrender.com`) and powered by **Gemini Live** (`gemini-3.1-flash-live-preview` / `gemini-2.5-flash-native-audio-preview-12-2025`) with all **126 native & cloud tools**.

---

## Downloads & Distribution Artifacts

| Platform | Artifact | Size | Distribution Target |
| :--- | :--- | :--- | :--- |
| **Android (Direct Install)** | `MYRAA-Android-1.0.0.apk` | 2.13 MB | GitHub Release Download (Android 8.0+ / API 26–35) |
| **Windows (Installer)** | `MYRAA-Setup-1.0.0.exe` | 172.97 MB | GitHub Release Download (NSIS Installer, Windows 10/11 x64) |
| **Windows (Portable)** | `MYRAA-Portable-1.0.0.exe` | 170.47 MB | GitHub Release Download (Zero-Install Portable Executable, x64) |
| **Checksums** | `SHA256SUMS.txt` | < 1 KB | Cryptographic SHA-256 verification sums |
| **Android (Play Store)** | `MYRAA-Android-1.0.0.aab` | 4.28 MB | Retained in `release/` for Google Play Console submission |

---

## SHA-256 Checksums

Verify your downloaded files using `certutil -hashfile <filename> SHA256` (Windows) or `shasum -a 256 <filename>` (macOS/Linux):

```text
9b5439ae25e16d1c046a5f1c3b2f3670faf6fddbbf5d746ee517d1f846a473b0  MYRAA-Android-1.0.0.apk
e7a89768cd9325ef9cdd1b326de55acf2b32a06acd1e0aecdcd817cc5704cbe3  MYRAA-Android-1.0.0.aab
69dd9d0bb0bcf195f379dafd8b19a667ec7c14d7534404f93e547ba7bff1d714  MYRAA-Setup-1.0.0.exe
3f1fa238be5cb5b37376cd9209ccf029907e2db1cb10754dcdcfcd490af1d09f  MYRAA-Portable-1.0.0.exe
```

---

## Key Highlights in v1.0.0

### 1. Android Production Companion (`MYRAA-Android-1.0.0.apk` & `.aab`)
- **Production Release Signing & Optimization**: Signed with the Mishtron Labs production RSA-2048 keystore (`APK Signature Scheme v2`), minified and obfuscated with R8/ProGuard, with all debug flags (`isDebuggable = false`, `isJniDebuggable = false`) and HTTP logging interceptors completely stripped.
- **Strict HTTPS/WSS-Only Transport**: Enforces `cleartextTrafficPermitted="false"` with system CA trust anchors and zero cleartext domain exceptions. All REST calls use `https://myraa-ai-q0h3.onrender.com` and real-time voice/control streams use `wss://myraa-ai-q0h3.onrender.com/remote-live`.
- **Hardware-Backed Credential Storage**: Pairing access tokens (`myraa_at_*`) and refresh tokens (`myraa_rf_*`) are encrypted via Android Keystore (`EncryptedSharedPreferences`).
- **Real-Time Voice & Gemini Live**: Low-latency PCM16 16kHz voice input, 24kHz audio playback, foreground service stability, automatic exponential-backoff reconnect, and one-tap Emergency Stop.

### 2. Windows Desktop Application (`MYRAA-Setup-1.0.0.exe` & `MYRAA-Portable-1.0.0.exe`)
- **Cloud-Connected Production Architecture**: Connects directly to `https://myraa-ai-q0h3.onrender.com` out of the box with zero local development server (`localhost`) dependency.
- **Bundled Native Desktop Agent (`myraa-agent.exe`)**: Automatically spawns the standalone PyInstaller Windows agent on `127.0.0.1:8765` to execute native OS automation, window management, clipboard, file manager, media, and system telemetry tools via Electron IPC.
- **NSIS Installer & Portable Builds**:
  - `MYRAA-Setup-1.0.0.exe`: Customizable installation directory, desktop & Start Menu shortcuts, clean uninstaller (`deleteAppDataOnUninstall: false` preserves user pairing across upgrades), and in-place upgrade support.
  - `MYRAA-Portable-1.0.0.exe`: Single-file portable executable that runs without installation.

### 3. Production Security & Safety Controls
- **10-Character Alphanumeric Device Pairing**: One-time pairing codes with 5-minute TTL, brute-force lockout protection, and granular per-device revocation.
- **Global Emergency Stop**: Instant halt of all active Gemini Live sessions, background tasks, and WebSocket connections from either Android or Windows.

---

## Installation Instructions

### Windows
1. **Standard Installation**: Download and run `MYRAA-Setup-1.0.0.exe`, select your preferred install directory, and launch **MYRAA** from the Desktop or Start Menu shortcut.
2. **Portable Execution**: Download `MYRAA-Portable-1.0.0.exe` and double-click to launch directly without installation.

### Android
1. Download `MYRAA-Android-1.0.0.apk` to your Android device (Android 8.0 Oreo / API 26 or newer).
2. Open the APK to install, launch **MYRAA**, grant microphone and notification permissions when prompted, and enter your pairing code from the MYRAA Control Hub.
