# MYRAA Android Companion

This directory contains the isolated Android (Kotlin / Jetpack Compose) client for the
MYRAA AI Companion system.

## Architecture Relationship

The Android app is a **remote client** of the MYRAA Desktop Core — it does NOT replicate
any server-side intelligence. All AI reasoning, security enforcement, tool orchestration,
and Gemini Live bridging remain on the desktop workstation.

```
  Android App (this directory)
       │
       │  Wi-Fi / LAN
       │  WS(S) /remote-live
       │  Bearer Token (sora_dev_...)
       ▼
  MYRAA Desktop Core (server.ts :3000)
  ├── Phase 10A–10F Security (authoritative gatekeeper)
  ├── 126-Tool Orchestrator
  ├── Gemini Live Session Factory
  └── Python Desktop Agent (:8765)
```

## Prerequisites (Desktop Side)

1. MYRAA Desktop must be running (port 3000 accessible on LAN).
2. Generate a pairing PIN from the desktop UI or API:
   ```
   POST http://<desktop-ip>:3000/api/remote/pair-code
   Authorization: (localhost only)
   ```
3. Use the 6-character PIN in the Android pairing screen.

## Audio Specification

| Direction      | Format                          |
|----------------|---------------------------------|
| Upload (mic)   | 16,000 Hz · 16-bit · mono · PCM |
| Download (TTS) | 24,000 Hz · 16-bit · mono · PCM |

Both streams are base64-encoded in WebSocket JSON frames.

## Security Model

- Device tokens are HMAC-SHA256 signed by the MYRAA desktop server.
- Tokens are stored in Android Keystore-backed EncryptedSharedPreferences.
- Only SHA-256 token hashes are ever persisted on the desktop side.
- Transport requires WSS / HTTPS in production (see `network_security_config.xml`).
- All tool executions are gated by the desktop Phase 10A–10F SecurityPolicyEngine.
- Emergency Stop can be triggered from the Android app at any time.

## Project Structure

```
android/
├── app/
│   ├── src/
│   │   └── main/
│   │       ├── AndroidManifest.xml
│   │       ├── java/com/myraa/companion/
│   │       │   ├── audio/       # AudioRecord (16kHz) + AudioTrack (24kHz)
│   │       │   ├── network/     # OkHttp3 WebSocket + mDNS/NSD discovery
│   │       │   ├── pairing/     # PIN pairing flow
│   │       │   ├── service/     # ForegroundService for live audio
│   │       │   ├── storage/     # EncryptedSharedPreferences session store
│   │       │   └── ui/          # Jetpack Compose screens
│   │       └── res/
│   │           └── xml/
│   │               └── network_security_config.xml
│   └── build.gradle.kts
├── build.gradle.kts
├── settings.gradle.kts
└── gradle/
    └── libs.versions.toml
```

## Platform Capability Contract

The TypeScript platform interfaces that define the Android ↔ MYRAA Core contract
live in the desktop monorepo at:

```
src/platform/
├── capabilities/       # Typed interface contracts
├── adapters/           # DesktopCapabilityAdapter (reference implementation)
└── android/            # AndroidContract wire protocol types
```

These are documentation and type contracts only — they do not affect the running
desktop or Android systems directly.

## Build Instructions (Placeholder)

```bash
# From this directory
./gradlew assembleDebug

# Install to connected device
./gradlew installDebug
```

> **Note:** Kotlin source files under `java/com/myraa/companion/` are scaffolded
> in a future phase. This phase establishes the project structure, Gradle config,
> and Android manifest only.

## Phase Roadmap

| Phase | Scope |
|-------|-------|
| 14    | Architecture Audit (complete) |
| 15    | Platform abstraction + Android scaffold (this phase) |
| 16    | Android PCM audio engine + OkHttp3 WebSocket client |
| 17    | Jetpack Compose UI: Pairing · Live · Emergency Stop |
| 18    | Camera streaming + Study Companion mobile view |
| 19    | End-to-end verification + mobile regression suite |
