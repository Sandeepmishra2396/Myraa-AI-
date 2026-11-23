# MYRAA — Advanced Multimodal AI Personal Assistant

[![Node.js](https://img.shields.io/badge/Node.js-v20%20%7C%20v22-green.svg)](https://nodejs.org/)
[![React](https://img.shields.io/badge/React-19-blue.svg)](https://react.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.8-blue.svg)](https://www.typescriptlang.org/)
[![Python](https://img.shields.io/badge/Python-3.11+-yellow.svg)](https://www.python.org/)
[![Electron](https://img.shields.io/badge/Electron-Desktop-47848F.svg)](https://www.electronjs.org/)
[![Gemini Live](https://img.shields.io/badge/AI-Google%20Gemini%20Live-8E75C2.svg)](https://ai.google.dev/)
[![License](https://img.shields.io/badge/License-Proprietary-red.svg)](#license)

> **MYRAA** is a production-grade, multimodal, proactive personal AI assistant operating seamlessly across Windows Desktop and an Android Companion application. Powered by Google Gemini Live with low-latency full-duplex conversational audio, interactive 3D VRM avatar visualization, native local operating system automation, autonomous multi-step task planning, and governed long-term memory.

---

## 🌟 Key Highlights

- 🎙️ **Full-Duplex Live Voice**: Real-time bidirectional voice streaming with natural turn-taking, speech prosody management, audio interruption detection, and raw PCM streaming over WebSockets.
- 🧑‍🎨 **Interactive 3D Holographic Avatar**: Real-time lip-sync, facial expressions, and dynamic visualizer powered by React 19, Three.js, and VRM 3D models.
- 🖥️ **Native Windows Desktop Agent**: High-performance Python FastAPI service (`127.0.0.1:8765`) enabling deep OS automation — launch apps, manage windows, browse files, and control PC hardware settings.
- 📱 **Android Companion App**: Native Kotlin & Jetpack Compose mobile companion offering secure device pairing, remote notifications, and mobile voice interaction.
- 🧠 **Governed Long-Term Memory**: Dual-tier memory architecture (short-term cognitive working memory + SQLite persistent store) with cryptographic human confirmation for all write operations.
- 📋 **Autonomous Task Orchestration**: Intelligent planner that decomposes complex instructions into dependency-ordered DAG task graphs with execution verification and automated failure recovery.
- 🛡️ **Defense-in-Depth Security Pipeline**: Multi-tier fail-closed security pipeline enforcing role-based access control (RBAC), tool execution firewalls, SSRF egress filters, and outbound data loss prevention (DLP).

---

## 🏗️ System Architecture

```text
┌────────────────────────────────────────────────────────────────────────┐
│                          OPERATOR INTERFACES                           │
│   Windows Desktop (Electron + React 19)   │   Android Companion (Compose)│
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ WebSocket (Duplex Audio / Events)
                                    │ HTTP/REST (Bearer Token Sessions)
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                        CORE BACKEND (Node.js)                          │
│                                                                        │
│  ┌───────────────────────┐  ┌───────────────────────────────────────┐  │
│  │ Conversation & Voice  │  │        Task Orchestrator & DAG        │  │
│  │ Gemini Live (129 Tools│  │    PlannerCoordinator & Verifier     │  │
│  └───────────┬───────────┘  └───────────────────┬───────────────────┘  │
│              │                                  │                      │
│              ▼                                  ▼                      │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │                     THE 6-STAGE SECURITY PIPELINE                │  │
│  │                                                                  │  │
│  │   [1] SecurityPolicyEngine    ──▶ Checks system mode & lockout  │  │
│  │   [2] SecurityRiskEngine      ──▶ Computes tool risk level      │  │
│  │   [3] ToolExecutionFirewall   ──▶ Validates payload & perimeter │  │
│  │   [4] Confirmation Gate       ──▶ Enforces cryptographic tokens │  │
│  │   [5] OutputDataFirewall      ──▶ Filters sensitive secrets/DLP │  │
│  │   [6] SecurityAuditLogger     ──▶ Tamper-evident append logging │  │
│  └───────────────────────────────────┬──────────────────────────────┘  │
│                                      │                                 │
│             ┌────────────────────────┴───────────────────────┐         │
│             ▼                                                ▼         │
│  ┌───────────────────────┐                      ┌───────────────────┐  │
│  │ GoverningMemoryGate   │                      │DesktopSecurityGate│  │
│  │ (Proposal / Approval) │                      │(SSRF / Path Guard)│  │
│  └──────────┬────────────┘                      └─────────┬─────────┘  │
└─────────────┼─────────────────────────────────────────────┼────────────┘
              │                                             │ HTTP (Local)
              ▼                                             ▼
┌───────────────────────────┐                 ┌──────────────────────────┐
│  SQLite Memory & Storage  │                 │  Python Desktop Agent    │
│  (Cognitive & Long-Term)  │                 │  (FastAPI on Port 8765)  │
└───────────────────────────┘                 └──────────────────────────┘
```

---

## 🚀 Getting Started

### Prerequisites

- **Node.js**: `v20.x` or `v22.x` LTS recommended
- **Python**: `3.11+` (required for Desktop OS Automation Agent)
- **Google Gemini API Key**: Obtain a key from [Google AI Studio](https://aistudio.google.com/)
- **Operating System**: Windows 10/11 (for desktop automation tools; core backend runs cross-platform on Linux/macOS)

### Installation

1. **Clone the repository**:
   ```bash
   git clone https://github.com/Sandeepmishra2396/Myraa-AI-.git
   cd Myraa-AI-
   ```

2. **Install Node.js dependencies**:
   ```bash
   npm install
   ```

3. **Install Python Desktop Agent dependencies**:
   ```bash
   pip install -r desktop_agent/requirements.txt
   ```

4. **Environment Setup**:
   Copy the example environment configuration:
   ```bash
   cp config/env/.env.example .env
   ```
   Edit `.env` to configure your API keys:
   ```ini
   NODE_ENV=development
   PORT=3000
   HOST=0.0.0.0
   GEMINI_API_KEY=your_actual_gemini_api_key_here
   GEMINI_LIVE_MODEL=gemini-3.1-flash-live-preview
   GEMINI_TEXT_MODEL=gemini-2.5-flash
   ```

---

## 🏃 Running MYRAA

### Option 1: One-Click Windows Launch (Recommended)
Double-click `start-myraa.bat` in the repository root to launch both the backend server and the desktop agent in separate terminals.

### Option 2: Manual Terminal Launch
1. **Start Core Backend & Web UI**:
   ```bash
   npm run dev
   ```
   Opens the assistant interface at `http://localhost:3000`.

2. **Start Python Desktop Agent (In a separate terminal)**:
   ```bash
   python run_agent.py
   ```
   Launches the local automation daemon on `http://127.0.0.1:8765`.

---

## 💻 Native Desktop Automation

The local Python Desktop Agent exposes native system automation capabilities, strictly monitored by `DesktopSecurityGate`:

- **Application Lifecycle**: Launch installed software, list running processes, bring windows to focus, and cleanly close applications.
- **Window Management**: Maximize, minimize, restore, resize, and reposition windows across multiple monitors.
- **Filesystem Operations**: Sandboxed file browsing, directory listing, reading, and structured writing within operator-approved paths.
- **Hardware & Telemetry**: Monitor battery status, memory utilization, CPU load, adjust system volume, and control display brightness.
- **Network Egress Guard**: Local SSRF firewall blocking requests to private ranges or cloud metadata endpoints.

---

## 📱 Android Companion

The Android companion application provides mobile continuity:
- **Location**: Source code is available in [`android/`](android/).
- **Tech Stack**: Kotlin, Jetpack Compose, Coroutines, OkHttp WebSockets.
- **Features**: Device pairing via secure QR / token exchange, background push alerts, and direct voice streaming.
- **Binaries**: Prebuilt APKs are located in `android/app/build/outputs/apk/`.

---

## 🛡️ Security & Privacy Guardrails

MYRAA is built with strict privacy and security guarantees:

- **Fail-Closed Security Pipeline**: Every tool execution passes through 6 sequential verification barriers.
- **Emergency Stop Killswitch**: Instantly aborts all active planner tasks, browser runs, and background agents fail-closed.
- **Human-in-the-Loop Memory Governance**: Long-term memories cannot be updated, inserted, or deleted without explicit operator authorization.
- **Data Loss Prevention (DLP)**: Outbound LLM text and tool responses are actively filtered to prevent leakage of credentials, bearer tokens, or personal identifiers.
- **Zero Hardcoded Secrets**: All secrets and credentials are loaded dynamically from environment variables and strictly excluded from version control.

---

## 📁 Project Structure

```text
MYRAA/
├── backend/            # Express + WebSocket core backend, Gemini Live AI session, security pipeline
│   ├── ai/             # Gemini session factory & 129 tool declarations
│   ├── companion/      # Mobile companion coordination & memory gate
│   ├── conversation/   # Duplex audio conversation manager
│   ├── diagnostics/    # Observability, metrics, and health checks
│   ├── explainability/ # Execution verification & decision traces
│   ├── memory/         # SQLite memory store & proposal adapters
│   ├── planner/        # Multi-step DAG task orchestrator & verifier
│   ├── reminders/      # Scheduled reminder & cron delivery engine
│   ├── research/       # Autonomous web research & epistemic verification
│   └── security/       # 6-stage security pipeline, RBAC, DLP, and audit logging
├── frontend/           # React 19 + Vite desktop and web interface
│   ├── components/     # UI components (AvatarRenderer, Visualizer, Workspaces)
│   └── lib/            # Web Audio worklets, settings store, wake word detector
├── desktop_agent/      # Python FastAPI local OS automation agent (Port 8765)
├── android/            # Native Android Companion app (Kotlin, Jetpack Compose)
├── electron/           # Electron desktop wrapper & packaging scripts
├── platform/           # Hardware capability abstraction layer
├── config/             # Configuration templates (env, build, testing)
├── docs/               # Technical specifications, architecture designs, and guides
├── tests/              # Automated unit, integration, and end-to-end test suites
├── assets/             # Branding icons, 3D avatar assets, audio fixtures
└── public/             # Static web assets and audio worklet processors
```

---

## 🛠️ Build & Scripts

| Command | Description |
| :--- | :--- |
| `npm run dev` | Starts the backend server and Vite frontend in development mode |
| `npm run build` | Builds production frontend assets and bundles the backend server |
| `npm test` | Runs the automated test suite |
| `npm run lint` | Runs TypeScript static type checking (`tsc --noEmit`) |
| `npm run dist` | Packages the Electron Windows desktop application installer |

---

## 📄 License

Proprietary and Confidential.  
Copyright © 2026 MYRAA AI. All rights reserved.  
Unauthorized copying, modification, or distribution is strictly prohibited.
