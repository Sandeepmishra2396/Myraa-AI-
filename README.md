# MYRAA — Advanced AI Personal Assistant

[![Phase 11: Complete](https://img.shields.io/badge/Phase%2011-Complete-brightgreen.svg)](#phase-completion-status)
[![Phase 12: Not Started](https://img.shields.io/badge/Phase%2012-Not%20Started-lightgrey.svg)](#future-roadmap)
[![Security Pipeline](https://img.shields.io/badge/Security-6--Stage%20Fail--Closed-blue.svg)](#architecture-overview)
[![Live Tools](https://img.shields.io/badge/LIVE__TOOLS-129%20Preserved-orange.svg)](#architecture-overview)
[![License: Proprietary](https://img.shields.io/badge/License-Proprietary-red.svg)](#license)

> **MYRAA** is a production-grade, multimodal, proactive personal AI assistant operating seamlessly across Windows Desktop and an Android Companion application. Built on Google Gemini Live technology with a guarded 129-tool execution engine, autonomous task orchestration, long-term memory governance, and a fail-closed multi-tier security pipeline.

---

## Table of Contents

- [Project Introduction](#project-introduction)
  - [Vision and Purpose](#vision-and-purpose)
  - [Core Design Philosophy](#core-design-philosophy)
- [Current Features](#current-features)
- [Architecture Overview](#architecture-overview)
  - [High-Level System Architecture](#high-level-system-architecture)
  - [The 6-Stage Security Pipeline](#the-6-stage-security-pipeline)
  - [Emergency Stop and Security Lockdown](#emergency-stop-and-security-lockdown)
- [Project Structure](#project-structure)
- [Getting Started](#getting-started)
  - [Prerequisites](#prerequisites)
  - [Environment Setup](#environment-setup)
  - [Running the Application](#running-the-application)
  - [Build and Packaging](#build-and-packaging)
- [Testing and Quality Assurance](#testing-and-quality-assurance)
  - [Reported Phase 11 Test Results](#reported-phase-11-test-results)
- [Phase Completion Status](#phase-completion-status)
  - [Phase 11: Reliability, Integration & Release Readiness](#phase-11-reliability-integration--release-readiness-complete)
  - [Phase 12: Advanced Agentic Intelligence](#phase-12-advanced-agentic-intelligence-not-started)
- [Known Limitations](#known-limitations)
- [Security and Privacy](#security-and-privacy)
- [Future Roadmap](#future-roadmap)
- [Documentation Index](#documentation-index)

---

## Project Introduction

### Vision and Purpose

MYRAA is engineered to be an intuitive, always-available AI partner that bridges the gap between passive conversational agents and autonomous execution systems. By uniting high-speed duplex conversational audio with deep operating system automation, structured task planning, and governed long-term memory, MYRAA assists operators in research, project management, system administration, and personal productivity while maintaining strict cryptographic boundaries and operator control.

### Core Design Philosophy

1. **Multimodal Native Execution**: Conversational voice, computer vision, visual widgets, and structured text operate as first-class, concurrently streaming modalities rather than disconnected sequential features.
2. **Defense-in-Depth & Fail-Closed Security**: Every tool invocation and state mutation must clear strict authorization, policy, risk, firewall, and DLP layers. If any stage encounters an anomaly, execution halts fail-closed.
3. **Transparent & Verifiable Autonomy**: Autonomous actions undergo explicit goal decomposition, pre-execution human confirmation for high-consequence operations, postcondition verification, and tamper-evident audit logging.
4. **Governed Long-Term Memory**: The AI cannot unilaterally mutate its own core memory. All persistent memory insertions and modifications require authorized proposals and operator confirmation.
5. **Cross-Device Continuity**: Unified state synchronization across desktop workstations and mobile companion endpoints enables fluid handoff and ambient assistance.

---

## Current Features

Every feature listed below has been implemented and verified in the repository:

- **Gemini-Powered AI Chat**: Conversational interface powered by Google Gemini models (`gemini-2.5-flash`, `gemini-3.1-flash-live-preview`) supporting structured reasoning, dynamic context grounding, prompt-injection defenses, and rich markdown rendering (`backend/ai/GeminiSessionFactory.ts`, `backend/server.ts`).
- **Real-Time Live Voice Conversations**: Low-latency, full-duplex conversational audio streaming via WebSockets. Employs raw PCM audio (16 kHz upload / 24 kHz download), custom Web Audio worklets, real-time speech prosody management, audio interruption detection, and conversational greeting guards (`backend/conversation/ConversationManager.ts`, `backend/voice/SpeechProsodyEngine.ts`, `frontend/lib/audio.ts`).
- **Long-Term Memory & Adaptive Context Retrieval**: Dual-tier cognitive memory architecture featuring an in-memory short-term cache and SQLite-backed persistent memory. Governed by the `GoverningMemoryGate`, ensuring all persistent writes require human approval and cryptographic signing (`backend/memory/MemoryStore.ts`, `backend/companion/AdaptiveContextRetriever.ts`, `backend/companion/GoverningMemoryGate.ts`).
- **Task Orchestrator & Multi-Step Planning**: Autonomous planning engine capable of decomposing complex operator instructions into structured DAG plans. Features step dependency validation, checkpointing, timeout handling, recovery loops, and formal postcondition verification (`backend/planner/TaskOrchestrator.ts`, `backend/planner/TaskPlanner.ts`, `backend/planner/StepExecutor.ts`, `backend/planner/CompletionVerifier.ts`).
- **Reminders & Automation Engine**: Persistent scheduled reminder system with cron parsing, timezone normalization, cross-process claim/delivery tracking, and delivery deduplication (`backend/reminders/ReminderService.ts`, `backend/reminders/ReminderScheduler.ts`, `backend/reminders/ReminderStore.ts`).
- **Desktop Agent (Python FastAPI)**: Native local operating system automation daemon running on `127.0.0.1:8765`. Provides 62 system tools across application management, file system manipulation, window control, and hardware telemetry, guarded by an internal SSRF firewall and workspace path sandboxing (`desktop_agent/tools_applications.py`, `tools_browser.py`, `tools_files.py`, `tools_pc.py`, `tools_windows.py`).
- **Android Companion Application**: Native Kotlin & Jetpack Compose Android companion supporting cryptographic pairing, duplex audio streaming, mobile capability discovery, and local push notification dispatch (`android/app/src/main/java/com/myraa/companion/`).
- **Explainability & Task Completion Verification**: Verification engine that inspects step artifacts, output tokens, and process exit codes to objectively verify task success rather than relying on self-reported AI claims (`backend/explainability/ExplainabilityService.ts`, `backend/planner/CompletionVerifier.ts`).
- **Authentication & Role-Based Access Control (RBAC)**: Cryptographic Bearer token session authentication (`identityAuthManager`), granular role enforcement (`admin`, `operator`, `user`), device identity binding, and step-up authentication for high-risk operations (`backend/security/IdentityAuthManager.ts`).
- **Security Monitoring & Containment**: Real-time heuristic anomaly detection, automated brute-force burst containment, rate limiting, DLP data-leakage prevention via regex/entropy filters, and structured audit trails (`backend/security/SecurityMonitor.ts`, `backend/security/SecurityAlertManager.ts`, `backend/security/OutputDataFirewall.ts`).
- **Runtime Observability, Diagnostics & Health Monitoring**: Continuous system health tracking, bounded memory consumption metrics, event emission rates, process boot ID verification, and unified diagnostic endpoints (`backend/diagnostics/RuntimeObservability.ts`).

---

## Architecture Overview

### High-Level System Architecture

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

### The 6-Stage Security Pipeline

Every action initiated by the AI or operator traverses six non-bypassable security barriers before execution:

1. **SecurityPolicyEngine**: Enforces system execution mode (`NORMAL`, `STRICT`, `LOCKDOWN`). Evaluates whether the requested action is permitted under active policies and checks if specific tools have been administratively disabled.
2. **SecurityRiskEngine**: Analyzes command payloads, target paths, and network destinations to score risk (`LOW`, `MEDIUM`, `HIGH`, `CRITICAL`).
3. **ToolExecutionFirewall**: Evaluates tool parameters against path traversal boundaries, schema validations, shell injection signatures, and unauthorized system access attempts.
4. **Confirmation Gate**: High-risk actions (file deletions, system configurations, arbitrary process spawning) require a short-lived cryptographic confirmation token explicitly authorized by the operator.
5. **OutputDataFirewall**: Sanitizes tool execution outputs and reasoning text, redacting API keys, private credentials, session tokens, and personal data (DLP) before reaching the AI or UI.
6. **SecurityAuditLogger**: Records an immutable, structured event log entry containing actor identity, session metadata, command parameters, risk assessment, and policy decision.

### Emergency Stop and Security Lockdown

MYRAA implements an authoritative, fail-closed containment hierarchy:

```
┌─────────────────────────────────────────────────────────────────────────┐
│                      EMERGENCY CONTAINMENT MODES                        │
├───────────────────────────────────┬─────────────────────────────────────┤
│          EMERGENCY STOP           │          SECURITY LOCKDOWN          │
├───────────────────────────────────┼─────────────────────────────────────┤
│ • Highest evaluation precedence   │ • Triggered by threat containment   │
│ • Absolute fail-closed killswitch │ • Restricts execution fail-closed   │
│ • Rejects ALL tools immediately   │ • Enforces LOCKDOWN_ALLOWLIST       │
│ • Cancels background planners     │ • Blocks ordinary tool execution    │
│ • AI-callable via:                │ • Deliberately NOT in LIVE_TOOLS    │
│   `triggerEmergencyStop` (1/129)  │   to prevent AI-initiated evasion   │
│ • Recovery: Direct admin reset via│ • Recovery: Step-up admin auth via  │
│   `POST /api/remote/emergency-stop│   `POST /api/remote/security/       │
│   /reset`                         │    lockdown/recover`                │
└───────────────────────────────────┴─────────────────────────────────────┘
```

- **Emergency Stop Absolute Priority**: Evaluated first in all dispatch pipelines. While Emergency Stop is engaged, no other tool or plan step can execute.
- **Authoritative `LOCKDOWN_ALLOWLIST`**: Defined in `backend/security/SecurityPolicyEngine.ts:73-77`:
  1. `triggerEmergencyStop`
  2. `getEmergencyStopStatus`
  3. `resetEmergencyStop`
- **Tool Catalog Separation**: `triggerEmergencyStop` is available in `LIVE_TOOLS` so operators can use voice or AI chat to halt the system. In contrast, `getEmergencyStopStatus` and `resetEmergencyStop` are **strictly excluded from `LIVE_TOOLS`**; untrusted AI models cannot clear an emergency stop or bypass security lockdown.
- **Dual-State Recovery Order**: If both Emergency Stop and Security Lockdown are engaged simultaneously, Emergency Stop must be reset first via local admin API, followed by Lockdown recovery requiring step-up operator credentials.

---

## Project Structure

The repository follows a clean, canonical structure established in the repository reorganization:

```text
MYRAA/
├── backend/                  # Node.js TypeScript server core
│   ├── ai/                   # Gemini Live session factory & 129 LIVE_TOOLS declarations
│   ├── brain/                # Cognitive memory store and contextual working state
│   ├── companion/            # Mobile companion coordination, persona, and memory gates
│   ├── conversation/         # Conversation manager, live duplex audio, and turn state
│   ├── device/               # Production UX controller and desktop window state
│   ├── diagnostics/          # Runtime observability, telemetry, and health metrics
│   ├── explainability/       # Step verification, reasoning traces, and evidence reader
│   ├── gateway/              # Express HTTP gateway & route definitions
│   ├── intelligence/         # User preference resolver and profile logic
│   ├── memory/               # Persistent SQLite memory store and proposal adapters
│   ├── orchestrator/         # Intent resolver and device-aware intelligence
│   ├── planner/              # Task orchestrator, DAG planner, step executor, completion verifier
│   ├── projects/             # Multi-session project management and decision store
│   ├── reminders/            # Scheduled reminders, cron engine, and delivery manager
│   ├── research/             # Autonomous web research, epistemic verifier, source fetcher
│   ├── security/             # The 6-stage security pipeline, RBAC, DLP, and audit logging
│   ├── tasks/                # Background task execution tracking
│   ├── tools/                # Tool orchestrator dispatching 129 live tool implementations
│   ├── voice/                # Language manager, speech prosody, and audio synthesis
│   └── workflow/             # Mobile workflow and cross-device handoff manager
├── frontend/                 # React 19 + Vite desktop and web interface
│   ├── components/           # UI components (AvatarRenderer, BrowserAgent, MemoryDashboard, etc.)
│   ├── lib/                  # Web Audio worklets, wake word detector, and settings store
│   └── App.tsx               # Main application orchestration view
├── desktop_agent/            # Python FastAPI local OS automation agent (Port 8765)
│   ├── tools_applications.py # App launch, process listing, window focus
│   ├── tools_browser.py      # Local browser tab inspection and control
│   ├── tools_files.py        # Sandboxed file read, write, and directory listing
│   ├── tools_pc.py           # System info, battery, volume, display brightness
│   ├── tools_windows.py      # Windows management, keystrokes, and mouse actions
│   └── egress_proxy.py       # Local network egress filter and SSRF guard
├── android/                  # Native Android Companion project
│   └── app/                  # Kotlin source, Jetpack Compose UI, WebSockets, audio engines
├── electron/                 # Electron desktop wrapper and Windows packaging
│   ├── main.cjs              # Electron main process lifecycle
│   ├── preload.cjs           # Secure context bridge
│   └── scripts/              # Windows packaging and Authenticode verification scripts
├── platform/                 # Platform capability descriptors and hardware abstractions
├── config/                   # Centralized configuration directory
│   ├── env/                  # Configuration templates (.env.example, .env.production.example)
│   ├── build/                # Build configurations and packaging specifications
│   └── testing/              # Testing guidelines and environment profiles
├── docs/                     # Technical documentation, architecture, and reports
│   ├── architecture/         # System design specifications
│   ├── audits/               # Security and compliance audits
│   ├── guides/               # Operator manuals and developer documentation
│   ├── releases/             # Release notes and changelogs
│   └── reports/              # Phase execution, regression, and acceptance reports
├── tests/                    # Automated testing suite
│   ├── unit/                 # Unit tests (memory, planner, security, voice, etc.)
│   ├── integration/          # Integration suites (RBAC, firewalls, desktop agent, reminders)
│   ├── e2e/                  # End-to-end full system lifecycle suites
│   ├── fixtures/             # Cryptographic fixtures and mock data
│   ├── helpers/              # Test harness setup and teardown utilities
│   └── mocks/                # Upstream service and hardware mocks
├── assets/                   # Branding icons, 3D avatar assets, audio test fixtures
├── public/                   # Static web assets, 3D VRM models, and audio worklets
└── release/                  # Production build outputs, installers, and checksums
```

---

## Getting Started

### Prerequisites

- **Node.js**: v20.x or v22.x LTS (v22.x recommended)
- **Python**: 3.11+ (Required for the Python Desktop Agent daemon)
- **Google Gemini API Key**: Valid API key from [Google AI Studio](https://aistudio.google.com/)
- **Operating System**: Windows 10/11 (for native desktop agent features; cross-platform backend runs on Linux/macOS)

### Environment Setup

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
   *(Or activate a dedicated Python virtual environment before installing).*

4. **Configure environment variables**:
   Copy the development environment template from `config/env/`:
   ```bash
   cp config/env/.env.example .env
   ```
   Edit `.env` to provide your Gemini API key and adjust settings:
   ```ini
   NODE_ENV=development
   PORT=3000
   HOST=0.0.0.0
   GEMINI_API_KEY=your_actual_gemini_api_key_here
   GEMINI_LIVE_MODEL=gemini-3.1-flash-live-preview
   GEMINI_TEXT_MODEL=gemini-2.5-flash
   ```

### Running the Application

- **Start Backend and Web Interface**:
  ```bash
  npm run dev
  ```
  Starts the Node.js backend and Vite development server on `http://localhost:3000`.

- **Start Python Desktop Agent (In a separate terminal)**:
  ```bash
  python run_agent.py
  ```
  Launches the local FastAPI agent on `http://127.0.0.1:8765`.

- **One-Click Windows Launch**:
  Execute `start-myraa.bat` in the repository root to launch both servers simultaneously in separate consoles.

### Build and Packaging

- **TypeScript Typecheck**:
  ```bash
  npm run lint
  ```
- **Execute Automated Tests**:
  ```bash
  npm test
  ```
- **Production Web and Backend Bundle**:
  ```bash
  npm run build
  ```
- **Package Windows Desktop Application**:
  ```bash
  npm run dist
  ```
- **Verify Windows Release Package Integrity**:
  ```bash
  node electron/scripts/verifyWindowsRelease.cjs
  ```

---

## Testing and Quality Assurance

### Reported Phase 11 Test Results

The following test metrics represent the verified engineering baseline documented upon completion of Phase 11 (`docs/reports/phase11_7_final_regression_release_readiness_report.md` and `docs/reports/phase11_7_1_regression_closure_report.md`):

| Category | Reported Result | Status | Notes |
|:---|:---:|:---:|:---|
| **Unit Tests** | **763 / 763** | **PASS** | 22 test files covering memory, planner, security, projects, and voice |
| **Integration Tests** | **1,954 / 1,954** | **PASS** | 69 test files verified sequentially (`--fileParallelism=false`) |
| **End-to-End (E2E) Tests** | **107 / 107** | **PASS** | 8 test files verified with cryptographic session tokens and memory governance |
| **Python Tests** | **4 / 4** | **PASS** | Native Python Desktop Agent suites via `pytest` |
| **Total Runnable Tests** | **2,828 / 2,828** | **PASS** | **100% pass rate across all automated suites** |
| **TypeScript Compilation** | **0 Errors** | **PASS** | Clean compilation via `tsc --noEmit` |
| **Production Build** | **Success** | **PASS** | Vite frontend bundle + esbuild backend `dist/server.cjs` (6.1 MB) |
| **Security Regression** | **190 / 190** | **PASS** | 9 dedicated core security suites covering fail-closed invariants |
| **Latest Security Audit** | **174 / 174** | **PASS** | Precedence, allowlist reconciliation, and memory ownership audit |

> [!NOTE]
> The figures above reflect the documented Phase 11 engineering audit results. To preserve repository integrity and avoid modifying production state, test suites were not re-executed during this documentation task.

---

## Phase Completion Status

### Phase 11: Reliability, Integration & Release Readiness: COMPLETE

Phase 11 established full system stabilization, test isolation, and release packaging verification. All subphases are complete and formally closed:

- **11.1 Legacy Test Modernization**: Modernized historical test harnesses, synchronized mock contracts, and eliminated obsolete fixtures.
  - **11.1.1 Test Integrity**: Reconciled test assertions with production security rules and confirmed strict mock parity.
- **11.2 Reminder Runtime Reliability**: Validated cron scheduler accuracy, cross-process claim/delivery audits, and deduplication logic.
  - **11.2.1 Cross-Process Claim/Delivery Audit**: Proved safe reminder claim boundaries and race-free delivery locks.
- **11.3 Task Recovery and Execution Verification**: Hardened planner state transitions, crash recovery mechanisms, and checkpoint validation.
  - **11.3.1 Postcondition and Dependency Safety**: Verified deterministic DAG step evaluation and automated failure remediation.
  - **11.3.2 Authorization Provenance Audit**: Ensured high-risk plan steps enforce cryptographic operator confirmation tokens.
- **11.4 Live Voice and Browser E2E Acceptance**: Validated low-latency duplex streaming, Web Audio worklets, and Gemini Live audio turn-taking.
  - **11.4.1 Live Voice and Browser Acceptance Follow-up**: Confirmed browser audio context resilience and reconnection recovery.
- **11.5 Android and Desktop Acceptance**: Verified Android companion networking, pairing protocols, and Python Desktop Agent tools.
- **11.6 Runtime Observability**: Implemented system diagnostics, bounded telemetry buffers, error rate monitors, and boot ID tracking.
- **11.7 Final Regression and Release Readiness**: Final evidence-based acceptance audit across the full platform.
  - **11.7.1 Regression Closure**: Resolved test isolation state leakage and updated E2E authentication fixtures to achieve 100% test pass rate.
  - **11.7.2 Security Recovery Allowlist Audit**: Reconciled the authoritative `LOCKDOWN_ALLOWLIST` and confirmed negative security controls.
  - **11.7.3 Emergency Stop, Security Lockdown and Recovery Precedence Audit**: Proved deadlock-free recovery precedence and verified tool catalog separation.

---

### Phase 12: Advanced Agentic Intelligence: NOT STARTED

> [!IMPORTANT]
> **Phase 12 has NOT been started.** The project is currently positioned at the transition boundary following the successful closure of Phase 11.
>
> The next scheduled milestone is **Phase 12.0 — Architecture Assessment & Feature Roadmap**, which is currently planned and awaiting formal execution and operator approval.

---

## Known Limitations

In the interest of full transparency and engineering rigor, the following known limitations are documented:

1. **Android Source Rebuild Tooling**: Fresh command-line compilation of the Android companion APK from source is currently blocked in the automated host environment due to the absence of the Gradle wrapper script (`android/gradlew.bat`) and system Gradle in the environment `PATH`. Pre-compiled APKs are present and validated in `android/app/build/outputs/apk/`.
2. **Physical Mobile Hardware Verification**: While Android notification intents, channel descriptors, and audio network protocols have been verified programmatically, physical notification rendering and hardware microphone/speaker behavior on physical mobile hardware remain unverified due to zero physical devices attached via ADB during automated audits.
3. **Windows Release Code Signing**: The packaged Windows desktop build (`release/`) is verified structurally as a functional development build (`electron/scripts/verifyWindowsRelease.cjs` passes). However, production Authenticode code signing with an Extended Validation (EV) certificate is required prior to public commercial deployment.
4. **Single-Process Reminder Scope**: Reminder delivery guarantees and deduplication claim locks currently target a single active Node.js server instance. Multi-instance cluster scaling with distributed database locks is scheduled for future infrastructure milestones.
5. **Local Python Daemon Dependency**: Advanced Windows operating system automation (window positioning, native keystrokes, direct application launch) relies on the local Python FastAPI service running on port 8765. If the Python process is terminated, desktop automation tools fail-closed gracefully.

---

## Security and Privacy

MYRAA is built with an enterprise security posture prioritizing operator sovereignty:

- **Strict Invariant Maintenance**: Exactly **129 unique `LIVE_TOOLS` function declarations** are maintained. No tool can be added or modified without passing full security pipeline reviews.
- **Zero Unapproved Memory Mutations**: All persistent long-term memory operations route through `GoverningMemoryGate`. The AI assistant cannot overwrite, delete, or fabricate permanent memory records without operator review.
- **Data Loss Prevention (DLP)**: The `OutputDataFirewall` scans and sanitizes all agent responses and tool outputs, stripping API keys, bearer tokens, passwords, and private identifiers before they can be displayed or stored.
- **Local Network Boundary (SSRF Protection)**: The desktop agent egress proxy blocks requests targeting private IP spaces, cloud metadata endpoints (`169.254.169.254`), and unauthorized local ports.
- **Secrets Management**: No API keys, credentials, or production environment variables are stored in source code. All configuration is loaded dynamically via environment variables with template documentation in `config/env/`.

---

## Future Roadmap

The upcoming **Phase 12 (Advanced Agentic Intelligence)** will focus on expanding cognitive autonomy while preserving established security invariants:

```text
Phase 12: Advanced Agentic Intelligence
├── 12.1 Advanced AI Chat & Multimodal Reasoning
│   ├── Hierarchical multi-model reasoning pipelines
│   └── Dynamic conversational personality adaptation
├── 12.2 Intelligent Long-Term Memory & Context
│   ├── Semantic vector embeddings for episodic memory
│   └── Automated memory consolidation and relevance decay
├── 12.3 Multi-Step Task Intelligence
│   ├── Speculative task decomposition and dynamic re-planning
│   └── Cross-agent goal delegation and verification
├── 12.4 Proactive Personal Assistant Experience
│   ├── Context-aware habit learning and predictive scheduling
│   └── Ambient daily briefings and smart reminder synthesis
├── 12.5 Desktop and Android Continuity
│   ├── Seamless session handoff across desktop and mobile
│   └── Shared clipboard, screen context, and bi-directional audio
└── 12.6 Adaptive Learning & Task Reliability
    ├── Implicit preference learning from operator feedback
    └── Automated formal verification of task output artifacts
```

---

## Documentation Index

For comprehensive technical specifications, audit logs, and development guidelines, consult the following project documentation:

- **Project Reorganization**: [`docs/project_reorganization_report.md`](docs/project_reorganization_report.md)
- **Phase 11.7 Release Readiness Report**: [`docs/reports/phase11_7_final_regression_release_readiness_report.md`](docs/reports/phase11_7_final_regression_release_readiness_report.md)
- **Phase 11.7.1 Regression Closure Report**: [`docs/reports/phase11_7_1_regression_closure_report.md`](docs/reports/phase11_7_1_regression_closure_report.md)
- **Phase 11.7.2 Security Recovery Allowlist Audit**: [`docs/reports/phase11_7_2_security_acceptance_consistency_report.md`](docs/reports/phase11_7_2_security_acceptance_consistency_report.md)
- **Phase 11.7.3 Recovery Precedence Audit**: [`docs/reports/phase11_7_3_recovery_precedence_audit_report.md`](docs/reports/phase11_7_3_recovery_precedence_audit_report.md)
- **Testing Architecture & Guide**: [`tests/README.md`](tests/README.md)
- **Environment Configuration Guide**: [`config/env/README.md`](config/env/README.md)
- **Windows Production Code Signing**: [`docs/guides/WINDOWS_PRODUCTION_SIGNING.md`](docs/guides/WINDOWS_PRODUCTION_SIGNING.md)

---

## License

Copyright © 2026 MYRAA AI. All rights reserved.
Proprietary and Confidential. Unauthorized copying, distribution, or modification is strictly prohibited.
