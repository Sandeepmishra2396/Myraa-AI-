# MYRAA Mobile Expansion Architecture Audit (Phase 14)
**Target Platform:** Android Client Integration & Desktop Core Preservation  
**Author:** Antigravity AI Engineering Architecture Team  
**Date:** September 2026  
**Status:** COMPLETE AUDIT (Read-Only Inspection)

---

## Executive Summary

This architecture audit provides an exhaustive, ground-truth inspection of the **MYRAA (Sora AI)** repository prior to the implementation of native mobile (Android) support. 

### Critical Invariants Verified
1. **Existing Desktop MYRAA Invariant:** The existing desktop Electron application, Vite frontend, Node.js server gateway, and Python desktop agent must continue operating completely undisturbed.
2. **Zero Security Duplication Invariant:** The battle-tested Phase 10A–10F security framework (`SecurityPolicyEngine`, `SecurityRiskEngine`, `ToolExecutionFirewall`, `OutputDataFirewall`, `IdentityAuthManager`, `ContentSanitizer`, `DataProtectionService`, `NetworkSecurityManager`, `SecretManager`, `ThreatContainmentManager`, `IntegrityMonitor`) and Phase 13 test suite (536 passing tests) must be reused directly as the authoritative gatekeeper.
3. **126-Tool Registry Invariant:** The 126 Gemini Live tools must remain intact without modification, deletion, or premature refactoring.
4. **Desktop Autonomy Invariant:** Desktop-specific dependencies (PyWin32, PyAutoGUI, Playwright, PyCaw, Electron IPC, Three.js VRM avatar) must remain anchored on the desktop workstation.

---

## 1. Current System Architecture

### 1.1 High-Level Architecture Overview

MYRAA operates as a hybrid desktop-core system consisting of three cooperative tiers:
1. **Electron Shell & Desktop UI:** Electron 43 + React 19 + TypeScript + Three.js / VRM 3D holographic avatar + Web Audio API streaming.
2. **Node.js Gateway Server (Port 3000):** Express 4 + WebSocket (`ws`) + Gemini Live API Client (`@google/genai`) + Phase 10A–10F Security Subsystems + ToolOrchestrator + Autonomous Intelligence Engines (Memory, Planner, Projects, Research, Companion, Multimodal, Study).
3. **Python Desktop Agent (Port 8765):** Local FastHTML / Uvicorn server providing low-level Windows OS automation, screen capture, file manipulation, and Playwright browser control.

```
 +-----------------------------------------------------------------------------------+
 |                             MYRAA WORKSTATION CORE                                |
 |                                                                                   |
 |  +--------------------+        IPC         +-----------------------------------+  |
 |  |  Electron Main     |<==================>|  Desktop UI (React 19 / Three.js) |  |
 |  |  (electron/main)   |                    |  - 3D Avatar (VRM / Three.js)     |  |
 |  |  - Single Instance |                    |  - Web Audio PCM16 (16kHz / 24kHz)|  |
 |  |  - Splash / Tray   |                    |  - Holographic Browser Projector  |  |
 |  |  - Floating Window |                    |  - Floating Companion UI          |  |
 |  +---------+----------+                    +-----------------+-----------------+  |
 |            | launches (ELECTRON_RUN_AS_NODE)                 |                    |
 |            v                                                 |                    |
 |  +-----------------------------------------------------------v-----------------+  |
 |  |                      Node.js Core Server (server.ts :3000)                  |  |
 |  |  +-----------------------------------------------------------------------+  |  |
 |  |  | HttpGateway.ts (Express REST Routes & Auth Middleware)                |  |  |
 |  |  | - /api/memories, /api/projects, /api/knowledge, /api/planner          |  |  |
 |  |  | - /api/companion, /api/remote/*, /api/multimodal, /api/study/*        |  |  |
 |  |  +-----------------------------------------------------------------------+  |  |
 |  |  | WebSocket Engine (/live and /remote-live)                             |  |  |
 |  |  | - Sec-WebSocket-Protocol Bearer Token Auth                            |  |  |
 |  |  | - Transport Security Validator (WSS / HTTPS enforcement)             |  |  |
 |  |  | - Full-Duplex PCM Audio Streaming (16kHz up, 24kHz down)              |  |  |
 |  |  | - Proactive Companion & Emergency Stop Broadcast Wire                 |  |  |
 |  |  +-----------------------------------------------------------------------+  |  |
 |  |  | ConversationManager & GeminiSessionFactory                            |  |  |
 |  |  | - Gemini Live Bi-directional WebSocket Bridge                         |  |  |
 |  |  | - Seamless GoAway Connection Rotation                                 |  |  |
 |  |  | - 126 Tool Declarations Registration                                  |  |  |
 |  |  +-----------------------------------------------------------------------+  |  |
 |  |  | Phase 10A–10F Security Architecture (Deterministic Gatekeeper)         |  |  |
 |  |  | - SecurityPolicyEngine  - SecurityRiskEngine  - ToolExecutionFirewall |  |  |
 |  |  | - OutputDataFirewall    - ContentSanitizer    - DataProtectionService |  |  |
 |  |  | - IdentityAuthManager   - IntegrityMonitor    - ThreatContainment     |  |  |
 |  |  | - NetworkSecurityManager- SecretManager       - SecurityAuditLogger   |  |  |
 |  |  +-----------------------------------------------------------------------+  |  |
 |  |  | ToolOrchestrator.ts (126-Tool Execution Engine)                       |  |  |
 |  |  | - 61 Desktop Agent Tools  - 22 Study Companion Tools                  |  |  |
 |  |  | - 9 Holographic UI Tools  - 6 Agent Planner Tools                     |  |  |
 |  |  | - 6 Research Tools        - 6 Companion Tools                         |  |  |
 |  |  | - 6 Multimodal Tools      - 5 Project Tools                           |  |  |
 |  |  | - 4 Remote Tools          - 1 Memory Tool                             |  |  |
 |  |  +-----------------------------------------------------------------------+  |  |
 |  |  | Autonomous Engines & Storage Services                                 |  |  |
 |  |  | - MemoryManager         - ProjectManager      - KnowledgeManager      |  |  |
 |  |  | - PlannerCoordinator    - CompanionCoordinator- ScreenContextManager  |  |  |
 |  |  | - StudySessionManager   - PairingManager      - RemoteSessionManager  |  |  |
 |  |  | - EmergencyStopCoordinator (Idempotent Killswitch)                    |  |  |
 |  |  +-----------------------------------------------------------------------+  |  |
 |  +-------------------------------------+---------------------------------------+  |
 |                                        | HTTP / JSON (127.0.0.1:8765)              |
 |                                        v                                           |
 |  +-----------------------------------------------------------------------------+  |
 |  |               Python Desktop Agent Subprocess (desktop_agent)               |  |
 |  |  - FastHTML / Uvicorn Server on 127.0.0.1:8765                               |  |
 |  |  - PyWin32 (Window control, brightness, registry auto-start)                |  |
 |  |  - PyAutoGUI & PyCaw (Screen capture, volume, mouse/keyboard)               |  |
 |  |  - Playwright Headless/Headed Chromium Automation                           |  |
 |  +-----------------------------------------------------------------------------+  |
 +-----------------------------------------------------------------------------------+
```

---

## 2. Electron / Desktop Architecture

### 2.1 Process Lifecycle & Packaging
* **File:** `electron/main.cjs`
* **Single Instance Guard:** `app.requestSingleInstanceLock()`. Second instances focus `mainWindow` without starting duplicate backend instances.
* **Backend Spawning:** In production, Electron launches `dist/server.cjs` using `process.execPath` with `ELECTRON_RUN_AS_NODE: '1'`. This eliminates the requirement for a global Node.js runtime on the user machine.
* **Frozen Python Subprocess:** Launches `agent_dist/myraa-agent/myraa-agent.exe` (PyInstaller frozen agent) or falls back to local Python in dev mode.
* **Window Management:**
  1. `splashWindow`: Frameless 420x300 transparent boot screen displayed while waiting for `http://localhost:3000` to answer health polling (timeout 40,000 ms).
  2. `mainWindow`: 1280x800 main application window loading `http://localhost:3000`.
  3. `floatingWindow`: 320x380 frameless, transparent, always-on-top companion widget loading `http://localhost:3000/?mode=floating`.
* **Clean Termination:** `taskkill /pid <serverPid> /T /F` on Windows ensures the entire process tree (Node backend and Python desktop agent) terminates cleanly on app exit.

### 2.2 IPC Architecture
* Exposes safe IPC via `electron/preload.cjs` using `contextBridge.exposeInMainWorld('electronAPI', ...)`.
* Channels: `floating:open`, `floating:close`, `floating:toggle`, `floating:focus-main`, `floating:sync-state`, `floating:request-state`, `floating:toggle-mic`, `floating:set-always-on-top`, `floating:move-window`, `floating:context-menu`.

---

## 3. Gemini Live Integration

### 3.1 Bi-directional Streaming Architecture
* **Factory:** `src/backend/ai/GeminiSessionFactory.ts`
* **Connection Lifecycle:** `src/backend/conversation/ConversationManager.ts`
* **SDK:** `@google/genai` (`GoogleGenAI`, `createLiveSession`)
* **Audio Specs:**
  - **Input (User -> Model):** 16,000 Hz, 16-bit linear mono PCM (`audio/pcm;rate=16000`), packaged as base64 strings in `{ audio: "<base64>" }`.
  - **Output (Model -> User):** 24,000 Hz, 16-bit linear mono PCM (`audio/pcm;rate=24000`), chunked via `serverContent.modelTurn.parts`.
* **Video / Screen Perception:** Base64 JPEG frames (`image/jpeg`) sent via `{ type: "video", video: "<base64>" }` -> `session.sendRealtimeInput({ video: blob })`.
* **Seamless GoAway Session Rotation:**
  - Detects Gemini `goAway` protocol frames.
  - Sets `flags.isRotating = true`.
  - Spins up replacement session preserving `dialogueHistory` and `currentModelResponseRef` without dropping the client WebSocket connection.

---

## 4. Complete 126-Tool Registry & Execution Flow

### 4.1 Tool Partitioning & Registry Map

The repository contains exactly **126 declared tools** in `GeminiSessionFactory.ts`, mapped into 10 deterministic functional subsystems:

| # | Subsystem Category | Count | Handling Layer | Typical Tools |
|---|--------------------|:-----:|----------------|---------------|
| 1 | **Desktop Control Tools** | 61 | Python Subprocess (Port 8765) | `runShellCommand`, `openApplication`, `createFile`, `modifyFile`, `deleteFile`, `volumeUp`, `takeScreenshot`, `desktopBrowserOpen`, `brightnessUp`, `enableAutoStart`, `systemInfo` |
| 2 | **AI Study Companion** | 22 | In-Process TypeScript (`src/backend/study`) | `loadStudyDocument`, `trackStudyPage`, `detectStudyQuestions`, `analyzeStudyDiagram`, `explainStudySection`, `toggleTeachingMode`, `setInteractiveTutorMode`, `configureCourseProfile`, `generatePersonalizedStudyPlan` |
| 3 | **Holographic UI Tools** | 9 | Client WebSocket (`src/App.tsx`) | `browserOpen`, `browserSearch`, `browserClick`, `browserMediaControl`, `browserScroll`, `browserType`, `browserGoBack`, `browserTabAction`, `changeBackground` |
| 4 | **Agent Planner Tools** | 6 | In-Process TypeScript (`src/backend/planner`) | `planTask`, `executeTaskPlan`, `pauseTaskPlan`, `resumeTaskPlan`, `confirmCheckpoint`, `getTaskPlanStatus` |
| 5 | **Research & Knowledge** | 6 | In-Process TypeScript (`src/backend/knowledge`) | `researchWeb`, `fetchOfficialDocs`, `readUrl`, `ingestKnowledge`, `queryKnowledgeBase`, `checkFreshness` |
| 6 | **Proactive Companion** | 6 | In-Process TypeScript (`src/backend/companion`) | `scheduleTask`, `listBackgroundTasks`, `cancelBackgroundTask`, `getCompanionNotifications`, `updateCompanionPreferences`, `triggerProjectCheck` |
| 7 | **Multimodal Intelligence** | 6 | In-Process TypeScript (`src/backend/multimodal`) | `captureScreenContext`, `analyzeVisualCode`, `extractDocumentContent`, `getContextAwareSuggestions`, `toggleContinuousScreenContext`, `getActiveWindowContext` |
| 8 | **Project Intelligence** | 5 | In-Process TypeScript (`src/backend/projects`) | `analyzeProject`, `getProjectArchitecture`, `searchProjectCode`, `getProjectGitStatus`, `trackProjectTask` |
| 9 | **Remote Companion Tools** | 4 | In-Process TypeScript (`src/backend/remote`) | `generateDevicePairCode`, `listRemoteDevices`, `revokeRemoteDevice`, `triggerEmergencyStop` |
| 10| **Memory Management** | 1 | In-Process TypeScript (`server_memory.ts`) | `saveCustomMemory` |
| **TOTAL** | **All Registered Tools** | **126** | **All Handled via ToolOrchestrator** | **100% Deterministic Coverage** |

### 4.2 Tool Execution Flow Diagram

```
 [ Gemini Live Server ]
           │
           │ toolCall { name, args, id }
           ▼
 [ GeminiSessionFactory.ts ]
           │
           ▼
 [ ToolOrchestrator.dispatch() ]
           │
           ├─────────────────────────► [ EmergencyStopCoordinator.isActive()? ]
           │                                 │ YES (and tool != triggerEmergencyStop)
           │                                 └─► RETURN EMERGENCY_STOP_ACTIVE (BLOCKED)
           ▼
 [ SecurityPolicyEngine.evaluateRequest() ]
           │
           ├─► SecurityRiskEngine (7 Deterministic Factors: 0-100 score)
           ├─► Role & Permission Verification (admin / standard / read_only / guest)
           ├─► Argument Boundary Enforcement (isPathWithinWorkspace, isSsrfSafeUrl)
           ├─► Confirmation Token Validation (Single-use HMAC token for HIGH/CRITICAL)
           │
           │ If DENIED or REQUIRE_CONFIRMATION:
           └─► Return Policy Block / Confirmation Token to Gemini Live
           │
           │ If ALLOWED:
           ▼
 [ OutputDataFirewall Wrapping ]
           │ (Guards sendToolResponse with SecretManager dynamic redaction & DLP)
           │
           ▼
 [ Dispatch Target Routing ]
   ├── saveCustomMemory         ──► MemoryManager + Client memory_sync broadcast
   ├── PROJECT_TOOLS (5)        ──► projectManager (In-process)
   ├── RESEARCH_TOOLS (6)       ──► knowledgeManager (In-process)
   ├── PLANNER_TOOLS (6)        ──► plannerCoordinator (In-process)
   ├── COMPANION_TOOLS (6)      ──► companionCoordinator (In-process)
   ├── REMOTE_TOOLS (4)         ──► remoteSessionManager / emergencyStopCoordinator
   ├── MULTIMODAL_TOOLS (6)     ──► screenContextManager / activeWindowTracker
   ├── STUDY_TOOLS (22)         ──► studySessionManager / interactiveTutor
   ├── DESKTOP_TOOLS (61)       ──► TaskManager.callDesktopAgent() (Python :8765)
   └── Holographic Tools (9)    ──► sendToClient({ type: "toolCall" }) -> WebSocket
           │
           ▼
 [ Output Sanitization & Audit ]
           │
           ├─► outputDataFirewall.sanitizeResult(output)
           ├─► securityAuditLogger.logEvent()
           ▼
 [ Gemini Live Session & Client Response ]
```

---

## 5. Security Architecture (Phase 10A–10F & Phase 13)

The MYRAA security subsystem is centralized in `src/backend/security/` and operates as an uncompromisable, deterministic pipeline.

```
 +----------------------------------------------------------------------------------+
 |                          PHASE 10A–10F SECURITY BOUNDARY                         |
 |                                                                                  |
 |  [Untrusted World: Web, Screen, PDF, YouTube, External Tools, User Prompts]      |
 |                                      │                                           |
 |                                      ▼                                           |
 |                      ContentSanitizer.ts (Phase 10B)                             |
 |                      - Instruction override defanging                            |
 |                      - Fences with <<<UNTRUSTED_DOCUMENT_DATA>>>                 |
 |                      - Exfiltration URL removal                                  |
 |                                      │                                           |
 |                                      ▼                                           |
 |                       IdentityAuthManager.ts (Phase 10A)                         |
 |                       - HMAC-SHA256 15m access tokens                            |
 |                       - Refresh token rotation & replay attack detection         |
 |                       - Sliding window brute-force lockout (5 attempts / 15 min) |
 |                                      │                                           |
 |                                      ▼                                           |
 |                      SecurityPolicyEngine.ts (Phase 10A)                         |
 |                      - Security Modes: BALANCED, STRICT, PARANOID, LOCKDOWN      |
 |                      - Single-use confirmation token issuance                    |
 |                      - Fail-closed evaluation pipeline                           |
 |                                      │                                           |
 |                     ┌────────────────┴────────────────┐                          |
 |                     ▼                                 ▼                          |
 |        SecurityRiskEngine.ts (Phase 10E)    NetworkSecurityManager (Phase 10F)   |
 |        - 7 Deterministic Factors (0-100)    - SSRF & DNS rebinding defense       |
 |        - LOW / MEDIUM / HIGH / CRITICAL     - Hop-by-hop redirect validation     |
 |        - Zero AI override vulnerability     - Egress sliding-window rate limit   |
 |                     │                                 │                          |
 |                     └────────────────┬────────────────┘                          |
 |                                      ▼                                           |
 |                      ToolExecutionFirewall.ts (Phase 10A)                        |
 |                      - Enforces confirmation gates                               |
 |                      - Dispatches guarded tool execution                         |
 |                                      │                                           |
 |                                      ▼                                           |
 |                       OutputDataFirewall.ts (Phase 10A)                          |
 |                       - Dynamic DLP scrubbing via SecretManager (Phase 10F)      |
 |                       - Stack trace cleansing & file path masking                |
 |                                      │                                           |
 |                     ┌────────────────┴────────────────┐                          |
 |                     ▼                                 ▼                          |
 |        SecurityAuditLogger.ts (Phase 10A)   SecurityMonitor.ts (Phase 10C)       |
 |        - Tamper-evident SHA-256 chaining    - IDS anomaly event correlation      |
 |        - Frozen immutable audit records     - Brute-force & injection detection  |
 |                     │                                 │                          |
 |                     └────────────────┬────────────────┘                          |
 |                                      ▼                                           |
 |             ThreatContainmentManager (10D) & IntegrityMonitor (10D)              |
 |             - Automated containment: Block -> Revoke -> Disable Tool -> Alert   |
 |             - HMAC-SHA256 baseline verification of critical files                |
 +----------------------------------------------------------------------------------+
```

### 5.1 Subphase Breakdown
* **Phase 10A (Foundation):** `SecurityPolicyEngine`, `ToolExecutionFirewall`, `OutputDataFirewall`, `IdentityAuthManager`, `PermissionManager`, `SecurityAuditLogger`.
* **Phase 10B (Data Protection & Boundaries):** `ContentSanitizer` (fencing external text with `<<<UNTRUSTED_DOCUMENT_DATA>>>`), `DataProtectionService` (AES-256-GCM encryption at rest, HTTPS/WSS enforcement in transit).
* **Phase 10C (Intrusion Detection):** `SecurityEventStream`, `SecurityMonitor` (sliding-window detection of brute-force, replay, traversal, prompt injection), `SecurityAlertManager`.
* **Phase 10D (Containment & Tamper Detection):** `ThreatContainmentManager` (automated session revocation, tool disabling, lockdown), `IntegrityMonitor` (HMAC baseline hashing of critical security files).
* **Phase 10E (Deterministic Risk Engine):** `SecurityRiskEngine` (evaluates tool sensitivity, operation type, identity role, device trust, path arguments, egress destination, threat level; scores 0–100).
* **Phase 10F (Egress & Secret Governance):** `NetworkSecurityManager` (SSRF loopback/cloud metadata protection, DNS rebinding prevention, 10MB stream limits), `SecretManager` (AES-256-GCM vault, memory scrubbing, accidental hardcoded secret scanner).

### 5.2 Phase 13 Security Regression Suite
* **Test Architecture:** 7 comprehensive test files in `src/backend/security/__tests__/` covering 12 adversarial domains:
  1. Authentication bypass & token security
  2. Privilege escalation & RBAC boundary fuzzing
  3. Path traversal & command injection fuzzing
  4. Prompt injection & untrusted content fencing
  5. SSRF, DNS rebinding & evasive payload fuzzing
  6. Unauthorized remote control & session hijacking
  7. Tool permission & confirmation gate bypass
  8. Audit-log & baseline integrity tampering
  9. Zero raw-secret exposure guarantee (DLP)
  10. Emergency stop bypass resistance
  11. Security lockdown fail-closed resistance
  12. Complete 126-tool systematic security boundary matrix
* **Audit Execution Verification:** **536 tests passing** across 17 test suites in 19.36s with zero failures.

---

## 6. Emergency Stop vs. Security Lockdown

The system possesses two distinct, independent killswitch mechanisms that must never be conflated:

| Feature Dimension | **Emergency Stop** (`EmergencyStopCoordinator`) | **Security Lockdown** (`SecurityPolicyEngine` / `ThreatContainmentManager`) |
|-------------------|------------------------------------------------|---------------------------------------------------------------------------|
| **Trigger Origin** | Operator / User (UI button, mobile remote, tool call, REST API) | Automated Security Defense (Integrity failure, replay attack, prompt injection campaign) |
| **Primary Intent** | Operational safety (halt runaway agent plans, freeze physical PC actions) | Security defense (contain active compromise, prevent exfiltration or tamper) |
| **System State Impact** | - Halts active Planner execution<br>- Aborts active Python subprocess tool calls<br>- Pauses companion background monitors<br>- Halts study sessions and timers | - Changes security mode to `LOCKDOWN`<br>- Blocks all non-allowlisted tools fail-closed<br>- Disables affected tools<br>- Revokes compromised sessions |
| **Permitted Operations** | Only `triggerEmergencyStop` allowed; all other tool calls blocked | Only `LOCKDOWN_ALLOWLIST` tools allowed:<br>1. `triggerEmergencyStop`<br>2. `getEmergencyStopStatus`<br>3. `resetEmergencyStop` |
| **Persistence** | Persisted to `remote_emergency_stop.json` across restarts | In-memory active security posture + containment records + audit log |
| **Reset Requirements** | Authorized operator action via UI or `/api/remote/emergency-stop/reset` | Strict requirement: **Admin role** AND (**isLocal** OR **isStepUpAuthenticated**) |

---

## 7. Authentication, Sessions & Remote-Device Architecture

### 7.1 Ephemeral PIN Pairing Protocol
* **Manager:** `src/backend/remote/PairingManager.ts`
* **PIN Specification:** 6-character uppercase alphanumeric string (`[A-Z0-9]{6}`).
* **TTL:** 5 minutes (`PAIRING_CODE_TTL_MS = 300,000`).
* **Rate Limiting:** Maximum 5 failed attempts per IP address -> 10-minute lockout cooldown.
* **Token Issuance:** On successful PIN presentation, issues HMAC-SHA256 signed bearer token: `sora_dev_<base64Url(deviceId.timestamp.nonce)>.<hmac>`.
* **Zero-Leakage Persistence:** Only the SHA-256 hash of the token is written to `remote_devices.json`. The raw bearer token is never written to disk.

### 7.2 Remote WebSocket Authentication (`/live` & `/remote-live`)
* **Transport Validation:** `DataProtectionService.validateTransport()` requires WSS/HTTPS for all non-localhost IP connections.
* **Token Handshake:** Token extracted from `Sec-WebSocket-Protocol: myraa-auth, <token>` or `?token=<token>`.
* **Session Lifecycle:** `RemoteSessionManager` verifies signature, matches token hash in constant time (`crypto.timingSafeEqual`), checks non-revocation status, updates `lastSeenAt`, and assigns session ID.
* **Instant Revocation:** When a device is revoked via API (`DELETE /api/remote/devices/:id`), all associated active WebSocket connections are terminated immediately.

### 7.3 Existing Remote Client (`src/components/remote/RemoteMobileApp.tsx`)
* A full React 19 web remote application already exists in the repository!
* Accessible on mobile browsers via `http://<desktop-ip>:3000/?mode=remote` or `http://<desktop-ip>:3000/remote`.
* Implements PIN pairing, token storage in `localStorage`, full-duplex live audio streaming, transcript log, companion notifications, active window mirroring, and emergency stop controls.

---

## 8. Intelligence Engines & Subsystems

1. **Memory Subsystem (`src/backend/memory/` & `server_memory.ts`):**
   - Persistent store: `memories.json`.
   - Semantic categorization (preferences, personal facts, technical skills, project context).
   - In-memory search, vector deduplication, and conversational memory extraction.
2. **Project Intelligence (`src/backend/projects/`):**
   - Persistent store: `projects.json`.
   - Scans workspaces, detects project types (Node, Python, Rust, Go, Flutter, Android), tracks git branch/status, manages developer task boards.
3. **Research & Knowledge Engine (`src/backend/knowledge/`):**
   - Multi-engine search (`WebSearchEngine`, `DocumentationRetriever`).
   - PDF & text extraction, vector embedding, similarity chunking, and freshness checking.
4. **Agent Planner (`src/backend/planner/`):**
   - Persistent store: `agent_plans.json`.
   - Multi-step DAG goal parsing, step execution, completion verification, and interactive human checkpoints.
5. **Proactive Companion (`src/backend/companion/`):**
   - Persistent stores: `companion_tasks.json`, `companion_notifications.json`, `companion_preferences.json`.
   - Schedulers and event monitors for background git commits, build issues, and proactive suggestions.
6. **Multimodal Perception (`src/backend/multimodal/`):**
   - Active window tracking, continuous screen perception, OCR, visual code inspection.
7. **AI Study Companion (`src/backend/study/`):**
   - Persistent store: `academic_profile.json`.
   - Course profile management, textbook PDF ingestion, question detection, Socratic interactive tutoring, diagram explanation, exam review scheduling.

---

## 9. Network & API Architecture

* **Host Binding:** Node.js Express server listens on `0.0.0.0:3000` (accessible across the local area network).
* **REST Endpoints:** Over 40 structured JSON endpoints under `/api/*` in `HttpGateway.ts`.
* **Authentication Middleware:**
  - `requireLocalhost`: Restricts critical actions (e.g. device role elevation, raw secret retrieval) strictly to `127.0.0.1` / `::1`.
  - `requireLocalhostOrPairedDevice`: Validates bearer tokens for remote clients while allowing seamless local access.
* **WebSocket Endpoints:**
  - `/live`: Standard live connection for local desktop UI.
  - `/remote-live`: Dedicated connection for remote companions (enforcing token validation and device role restrictions).
* **Python Desktop Agent:** Strictly bound to loopback `127.0.0.1:8765`, never directly exposed to external network interfaces.

---

## 10. Platform Dependency & Component Sharing Map

```
 +-----------------------------------------------------------------------------------------+
 |                                COMPONENT SHARING MATRIX                                 |
 +------------------------------------+----------------------------------------------------+
 | DESKTOP-ONLY (MUST NOT BE MOVED)   | SHARED BACKEND (DESKTOP CORE HOSTS FOR ANDROID)    |
 +------------------------------------+----------------------------------------------------+
 | • electron/main.cjs & preload.cjs  | • server.ts & HttpGateway.ts REST endpoints        |
 | • Python desktop_agent/ (PyWin32,  | • /remote-live WebSocket streaming engine          |
 |   PyAutoGUI, PyCaw, Playwright)    | • Phase 10A–10F Security Subsystems (All 17 files) |
 | • Three.js / VRM Avatar Renderer   | • Phase 13 Comprehensive Security Test Suite       |
 | • Holographic Browser Projector    | • ToolOrchestrator & 126-Tool Execution Engine     |
 | • Floating Companion Window        | • PairingManager, RemoteSessionManager, Store      |
 | • Windows registry auto-start tools| • Memory, Planner, Knowledge, Study, Companion     |
 +------------------------------------+----------------------------------------------------+
 | ANDROID ADAPTER REQUIREMENTS       | PROPOSED ANDROID CLIENT COMPONENTS                 |
 +------------------------------------+----------------------------------------------------+
 | • Audio: Android AudioRecord /     | • Native Android App (Kotlin / Jetpack Compose)    |
 |   AudioTrack (PCM16 16k/24k)       | • mDNS / NSD Desktop Auto-Discovery Service        |
 | • Network: OkHttp3 WebSocket       | • Android Keystore Encrypted Session Storage       |
 | • Background: Android Foreground   | • Foreground Audio Service (Notification + WakeLock|
 |   Service with ongoing notif       | • Emergency Stop Floating Action Widget            |
 | • Storage: EncryptedSharedPreferences|• Live Audio Visualizer & Interactive Study Viewer |
 +------------------------------------+----------------------------------------------------+
```

---

## 11. Exact Extension Points for Android Integration

The existing repository was intentionally designed with Phase 7 remote companion capabilities, providing clean, non-invasive extension points:

### Extension Point 1: Device Pairing Handshake
* **Endpoint:** `POST /api/remote/pair`
* **Request:** `{ "code": "6CHAR_PIN", "deviceName": "Pixel 8 Pro", "deviceType": "android" }`
* **Response:** `{ "device": { "id": "...", "role": "standard" }, "token": "sora_dev_..." }`
* **Impact on Desktop:** Handled in `PairingManager.ts`; zero modification required.

### Extension Point 2: Streaming WebSocket Connection
* **Endpoint:** `ws://<desktop-ip>:3000/remote-live?token=<token>` or `wss://...`
* **Subprotocol:** `Sec-WebSocket-Protocol: myraa-auth, <token>`
* **Frames Sent by Android:**
  - Audio: `{ "audio": "<base64_pcm16_16khz>" }`
  - Video / Camera: `{ "type": "video", "video": "<base64_jpeg>" }`
  - Text: `{ "type": "text", "text": "Hello Myraa" }`
  - Tool Response: `{ "type": "toolResponse", "id": "...", "name": "...", "output": { ... } }`
* **Frames Received by Android:**
  - Audio: `{ "audio": "<base64_pcm16_24khz>" }`
  - Transcript: `{ "type": "modelTurn", "text": "..." }`, `{ "type": "userTurn", "text": "..." }`
  - Notifications: `{ "type": "companion_notification", "notification": { ... } }`
  - Emergency Stop Alert: `{ "type": "emergency_stop", "state": { "active": true, ... } }`
* **Impact on Desktop:** Handled in `server.ts` & `ConversationManager.ts`; zero modification required.

### Extension Point 3: Remote Emergency Stop Killswitch
* **Trigger Endpoint:** `POST /api/remote/emergency-stop`
* **Status Endpoint:** `GET /api/remote/emergency-stop`
* **Reset Endpoint:** `POST /api/remote/emergency-stop/reset`
* **Impact on Desktop:** Handled in `EmergencyStopCoordinator.ts`; zero modification required.

### Extension Point 4: REST Data APIs
* Android can directly query existing endpoints for study documents, tasks, notifications, and memories using `Authorization: Bearer <deviceToken>`.
* Middleware `requireLocalhostOrPairedDevice` in `HttpGateway.ts` automatically authorizes paired Android devices!

### Extension Point 5: Mobile-Specific Tool Registry (Future Phase)
* When Android-native tools (e.g. `mobileFlashlight`, `mobileSendSms`, `mobileVibrate`) are added in future phases, they will be registered in a dedicated `MOBILE_TOOLS` Set in `ToolOrchestrator.ts` and forwarded via `{ type: "mobileToolCall" }` over the client WebSocket, keeping the 61 desktop tools untouched.

---

## 12. Technical Risks & Mitigations for Android Support

| # | Technical Risk | Impact | Concrete Mitigation |
|---|----------------|:------:|---------------------|
| 1 | **Desktop Functionality Breakage** | Critical | Treat all desktop files (`electron/*`, `src/App.tsx`, `desktop_agent/*`) as immutable. Android code resides in an isolated directory. |
| 2 | **Security Duplication / Drift** | High | Do NOT create a parallel auth or policy engine. The Android app acts purely as a client to the Phase 10 security core. |
| 3 | **Cleartext HTTP Restrictions in Android** | High | Modern Android blocks `http://` by default. Configure `network_security_config.xml` with local LAN domain/IP bypasses for development, and provide self-signed/local CA TLS support. |
| 4 | **Android OS Background Killing** | High | Android will terminate WebSockets when backgrounded. Implement an Android `ForegroundService` with `FOREGROUND_SERVICE_MICROPHONE` and a persistent notification while connected. |
| 5 | **Audio Buffer Overrun / Underrun** | Medium | Gemini Live requires strict 16kHz mono PCM16 input and 24kHz output. Android must use precise ring buffering and sample-rate conversion rather than sending raw device audio rates. |
| 6 | **LAN IP Discovery Friction** | Low | Users should not need to manually look up desktop local IP addresses. Implement mDNS / Bonjour (ZeroConf) announcement on desktop via Node and Android Network Service Discovery (NSD). |

---

## 13. Recommended Project Structure

To guarantee zero impact on the existing codebase, a clean monorepo separation is recommended:

```
d:\SORA AI\Sora AI\
├── android/                         <-- [NEW ISOLATED ROOT FOR ANDROID]
│   ├── app/
│   │   ├── src/
│   │   │   ├── main/
│   │   │   │   ├── AndroidManifest.xml
│   │   │   │   ├── java/com/myraa/companion/
│   │   │   │   │   ├── audio/           # AudioRecord / AudioTrack PCM engines
│   │   │   │   │   ├── network/         # OkHttp3 WebSocket client & mDNS discovery
│   │   │   │   │   ├── service/         # Foreground Live Streaming Service
│   │   │   │   │   ├── storage/         # Keystore-backed session storage
│   │   │   │   │   └── ui/              # Jetpack Compose UI (Pairing, Live, Study)
│   │   │   │   └── res/
│   │   ├── build.gradle.kts
│   │   └── proguard-rules.pro
│   ├── build.gradle.kts
│   ├── settings.gradle.kts
│   └── gradle/
│
├── electron/                        <-- [UNTOUCHED DESKTOP ENGINE]
├── desktop_agent/                   <-- [UNTOUCHED PYTHON ENGINE]
├── src/                             <-- [UNTOUCHED NODE/REACT CORE]
│   ├── backend/
│   │   ├── ai/                      # Gemini Live Session Factory (126 Tools)
│   │   ├── security/                # Phase 10A-10F Security Core
│   │   ├── tools/                   # ToolOrchestrator
│   │   └── remote/                  # Pairing & Session Management
│   └── components/                  # Desktop React UI
├── package.json                     <-- [UNTOUCHED]
└── server.ts                        <-- [UNTOUCHED]
```

---

## 14. Files & Modules That Must NOT Be Modified Initially

The following files represent the operational spine of MYRAA Desktop and MUST NOT be touched during initial Android setup:
1. `electron/main.cjs` & `electron/preload.cjs` (Desktop application shell)
2. `desktop_agent/*` (All Python tools and OS controllers)
3. `src/backend/ai/GeminiSessionFactory.ts` (126-tool declarations & Gemini Live bridge)
4. `src/backend/tools/ToolOrchestrator.ts` (Tool routing engine)
5. `src/backend/security/*` (All 17 Phase 10A–10F security modules)
6. `src/backend/security/__tests__/*` (All Phase 13 security test suites)
7. `src/backend/remote/EmergencyStopCoordinator.ts` (Emergency killswitch)
8. `src/App.tsx` & `src/components/AvatarRenderer.tsx` (Desktop UI & Three.js 3D avatar)

---

## 15. Recommended Phased Implementation Order

* **Phase 14 — Architecture Audit (Current):** Read-only codebase audit, 126-tool verification, security boundary mapping, and creation of `mobile_architecture_audit.md`.
* **Phase 15 — Desktop Discovery & Pairing Integration:**
  - Add optional mDNS announcement (`myraa-core.local`) in `server.ts` or standalone helper.
  - Create `android/` project scaffolding with Kotlin & Jetpack Compose.
  - Implement PIN pairing UI and secure token storage using Android Keystore / `EncryptedSharedPreferences`.
* **Phase 16 — Android Live Audio & Streaming Engine:**
  - Implement 16kHz PCM16 `AudioRecord` capture pipeline.
  - Implement 24kHz PCM16 `AudioTrack` playback pipeline with jitter ring buffer.
  - Implement OkHttp3 WebSocket client connecting to `/remote-live`.
  - Package inside an Android `ForegroundService` with notification controls.
* **Phase 17 — Android UI & Companion Capabilities:**
  - Build Jetpack Compose interface: Pairing screen, Live Character Orb / Visualizer, Transcript feed.
  - Implement prominent Emergency Stop widget.
  - Implement Companion Notification inbox and Active Desktop Window mirroring.
* **Phase 18 — Mobile Multimodal & Study Companion:**
  - Camera frame streaming (JPEG over `/remote-live`).
  - Study Companion mobile interface (textbook reader, Socratic quiz view).
* **Phase 19 — End-to-End Verification & Mobile Regression Suite:**
  - Verify zero impact on desktop test suite (all 536 tests continue passing).
  - Verify mobile connection handling under network dropouts, airplane mode, and emergency stop conditions.

---

## 16. Architecture Readiness Verdict

### **VERDICT: READY FOR ANDROID EXPANSION (WITH PREREQUISITES)**

The MYRAA codebase is exceptionally well-architected for mobile expansion. The presence of Phase 7 (`PairingManager`, `RemoteSessionManager`, `EmergencyStopCoordinator`), the existing `/remote-live` WebSocket endpoint, the complete Phase 10A–10F security framework, and the working prototype in `RemoteMobileApp.tsx` prove that remote companion capabilities are already native to the design.

### What Must Be Prepared First Before Writing Android Code:
1. **Isolated Directory Commitment:** The Android project must be created in a new top-level `android/` directory so zero desktop packaging or npm scripts are impacted.
2. **Local Network / TLS Strategy:** Ensure Android's `network_security_config.xml` is configured to permit local network WebSocket traffic to the desktop IP.
3. **Audio Pipeline Groundwork:** Strictly adhere to the 16kHz input / 24kHz output PCM16 specification expected by `GeminiSessionFactory.ts`.
4. **Preserve Invariant Gates:** Verify before and after each phase that `npm test` continues to pass all 536 tests.
