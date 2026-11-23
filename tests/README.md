# MYRAA — Test Suite Architecture, Catalog & Execution Guide

This document describes the structure, testing frameworks, execution procedures, governance rules, and baseline status of the test suite in the **MYRAA** desktop and multi-device AI assistant repository.

---

## 1. Directory Structure

The central `tests/` directory organizes automated tests across unit, integration, end-to-end, and language-specific domains:

```
tests/
├── e2e/                                  # End-to-End full system test suites (7 files)
│   ├── cross_platform_e2e_phase29.test.ts
│   ├── phase10_final_production_verification.test.ts
│   ├── phase11_live_production_e2e.test.ts
│   ├── phase12_release_packaging_e2e.test.ts
│   ├── phase13a_android_standalone_ux.test.ts
│   ├── phase13a_win6_local_desktop_app.test.ts
│   └── production_hardening_phase30.test.ts
│
├── integration/                          # Multi-component and subsystem integration tests (65 files)
│   ├── admin_recovery_and_multidevice.test.ts
│   ├── app_launch_and_speech_completeness.test.ts
│   ├── audit_trail_and_risk_engine.test.ts
│   ├── automatic_containment_and_tamper_detection.test.ts
│   ├── cloud_web_companion.test.ts
│   ├── code_modification_permission_verification.test.ts
│   ├── comprehensive_security_suite.test.ts
│   ├── conversational_greeting_guard.test.ts
│   ├── cross_device_handoff.test.ts
│   ├── desktop_rpc_and_cors_security.test.ts
│   ├── desktop_security_gate.test.ts
│   ├── intent_capability_orchestrator.test.ts
│   ├── mobile_emergency_security.test.ts
│   ├── mobile_proactive.test.ts
│   ├── mobile_workflow.test.ts
│   ├── multi_device_architecture.test.ts
│   ├── multimodal.test.ts
│   ├── network_security_and_secrets.test.ts
│   ├── phase13a_win7_local_api_key_runtime.test.ts
│   ├── phase13a_win_authenticode_trust.test.ts
│   ├── phase14_natural_voice_prosody.test.ts
│   ├── phase15_multilingual_voice_engine.test.ts
│   ├── phase16_advanced_natural_conversation_multilingual.test.ts
│   ├── phase16_voice_clarity_refinement.test.ts
│   ├── phase17_intelligence_engine.test.ts
│   ├── phase18_adaptive_personal_brain.test.ts
│   ├── phase19_advanced_context_fusion.test.ts
│   ├── phase20_natural_conversation_engine.test.ts
│   ├── phase21_predictive_proactive_engine.test.ts
│   ├── phase22_multi_agent_brain.test.ts
│   ├── phase23_autonomous_coding_engineer.test.ts
│   ├── phase24_personal_knowledge_graph.test.ts
│   ├── phase25_self_correction.test.ts
│   ├── phase26_security_intelligence_separation.test.ts
│   ├── phase4_full_orchestrator.test.ts
│   ├── phase5_device_aware_intelligence.test.ts
│   ├── phase6_optional_remote_bridge.test.ts
│   ├── phase7_shared_account_memory.test.ts
│   ├── phase8_advanced_browser_research.test.ts
│   ├── phase8_cross_device_workflows.test.ts
│   ├── phase9_production_ux.test.ts
│   ├── prompt_injection_and_data_protection.test.ts
│   ├── remote.test.ts
│   ├── remote_app_interaction.test.ts
│   ├── remote_browser_assistant.test.ts
│   ├── remote_capability_engine.test.ts
│   ├── remote_live_websocket.test.ts
│   ├── remote_mobile_context.test.ts
│   ├── remote_mobile_screen.test.ts
│   ├── remote_security_communication.test.ts
│   ├── remote_voice_assistant.test.ts
│   ├── remote_websocket_resilience.test.ts
│   ├── security_foundation.test.ts
│   ├── security_monitoring_and_alerts.test.ts
│   ├── stage1_browser_intelligence_coordinator.test.ts
│   ├── stage2_intelligent_search_epistemic.test.ts
│   ├── stage3_browser_control.test.ts
│   ├── stage4_document_comparison.test.ts
│   ├── stage5_adaptive_knowledge_ingestion.test.ts
│   ├── stage6_skill_proposal_system.test.ts
│   ├── stage7_self_improvement_evaluator.test.ts
│   ├── stage8_security_boundary_audit.test.ts
│   ├── stage9_evaluation_acceptance.test.ts
│   ├── token_refresh_pairing.test.ts
│   └── voice_language_and_ordinal_song.test.ts
│
├── unit/                                 # Isolated module and component tests (19 files)
│   ├── adaptive_context_retriever.test.ts
│   ├── ai_study_companion.test.ts
│   ├── companion.test.ts
│   ├── companion_core_phase1.test.ts
│   ├── explainability/
│   │   └── explainability.test.ts        # Stage 10.7 explainability subsystem unit tests
│   ├── gemini_live_auth_regression.test.ts
│   ├── interactive_tutor.test.ts
│   ├── knowledge.test.ts
│   ├── memory.test.ts
│   ├── phase10_audio_continuity.test.ts
│   ├── phase10_project_continuity.test.ts
│   ├── planner.test.ts
│   ├── platform.test.ts
│   ├── projects.test.ts
│   ├── reminders/
│   │   └── reminders.test.ts             # Stage 10.6 reminders governance unit tests
│   ├── shared_memory.test.ts
│   ├── stage10_1_10_2_security_remediation.test.ts
│   ├── study.test.ts
│   └── task_orchestrator.test.ts
│
├── python/                               # Python desktop agent tool tests (1 file)
│   └── test_desktop_agent_app_resolution.py
│
├── fixtures/                             # Static and synthetic test fixtures
│   └── README.md
│
├── helpers/                              # Shared test utilities and assertion helpers
│   └── README.md
│
├── mocks/                                # Mock service implementations and protocol stubs
│   └── README.md
│
└── test_desktop_agent_app_resolution.py  # Root duplicate candidate (see Section 8)
```

Additionally, Android companion tests reside in their native Gradle directory:
- `android/app/src/test/java/com/myraa/companion/ReleaseArtifactVerificationTest.kt`
- `android/app/src/test/java/com/myraa/companion/StandaloneMobileLaunchUxTest.kt`
- `android/app/src/test/java/com/myraa/companion/StandaloneVoicePipelineTest.kt`

---

## 2. Test Categories & Scope

| Category | Count | Focus & Description |
|---|---|---|
| **Unit Tests** | 19 files | Validates individual modules: Memory, Planner, Adaptive Context, Study Companion, Projects, Stage 10.6 Reminders, Stage 10.7 Explainability, Security Remediation. |
| **Integration Tests** | 65 files | Validates multi-component interaction: Tool Execution Firewall, Security Risk Engine, Pairing & Tokens, Desktop RPC, Browser Intelligence (Stages 1-9), Voice Prosody, Self-Correction. |
| **End-to-End Tests** | 7 files | Validates end-to-end user workflows: Cross-Platform (Phase 29), Production Hardening (Phase 30), Packaging (Phase 12), Windows App (Phase 13a), Live Production (Phase 11). |
| **Python Tests** | 2 files | Validates `desktop_agent` application resolution, folder alias resolution, and shell invocation commands. |
| **Android Tests** | 3 files | Validates Android companion UX launch, voice pipeline integration, and release artifact verification. |
| **Total Test Files** | **96 files** | Complete repository test suite. |

---

## 3. Testing Frameworks

1. **Vitest (`^5.0.1`)**:
   - Primary test runner for TypeScript (`*.test.ts`).
   - Configured in `vite.config.ts` (`test.fileParallelism: false`, `testTimeout: 15000`).
   - Dispatches tests sequentially across Node.js / happy-dom environments.

2. **Pytest (`8.3.4`)**:
   - Test runner for Python desktop agent verification.
   - Run with `pytest <test_path>`.

3. **Android JUnit / Kotlin Test**:
   - Unit tests executed by Gradle via `./gradlew testDebugUnitTest`.

---

## 4. Test Execution Commands

### TypeScript / Vitest Suites

```bash
# Run all unit tests
npx vitest run tests/unit --fileParallelism=false

# Run focused unit tests
npx vitest run tests/unit/memory.test.ts

# Run integration tests
npx vitest run tests/integration --fileParallelism=false

# Run focused integration tests (e.g. security suite)
npx vitest run tests/integration/comprehensive_security_suite.test.ts

# Run E2E tests
npx vitest run tests/e2e --fileParallelism=false

# Full TypeScript compilation check
npm run lint    # runs `tsc --noEmit`

# Production application build check
npm run build   # runs `vite build && esbuild backend/server.ts ...`
```

### Python Desktop Agent Tests

```bash
# Run Python desktop agent tests from tests/python/
pytest tests/python/test_desktop_agent_app_resolution.py -v

# Run directly with Python interpreter
python tests/python/test_desktop_agent_app_resolution.py
```

> **Note on `pytest tests`**: Avoid running bare `pytest tests` because `tests/test_desktop_agent_app_resolution.py` and `tests/python/test_desktop_agent_app_resolution.py` share the same module name, causing Pytest collection collisions. Run targeting `tests/python/test_desktop_agent_app_resolution.py`.

### Android Companion Tests

```bash
# Navigate to android directory and run unit tests
cd android
./gradlew testDebugUnitTest
```

---

## 5. Shared Fixtures, Helpers, and Test Workspaces

- **`test-artifacts/`**: Contains runtime output artifacts from E2E and visual tests, including emulator screenshots (`test-artifacts/screenshots/`), UI dumps (`test-artifacts/ui-dumps/`), and isolated file-system sandbox test workspaces (`test-artifacts/test-workspace/`). This directory is excluded from Vite HMR watching and build bundles.
- **Stage 7 Evaluation Fixtures (`backend/research/browser/EvaluationFixtureRegistry.ts`)**: Versioned, immutable evaluation fixtures (v1.0.0) utilized by the Self-Improvement candidate evaluator. As production code, this file is preserved in the backend module.
- **Test Audio Assets (`assets/myraa_multilingual_test.wav`)**: Real PCM audio fixture used by `tests/integration/phase15_multilingual_voice_engine.test.ts` and referenced in project stores. Retained in `assets/`.

---

## 6. Tests Maintained Outside `tests/` and Why

The 3 Android test files:
- `android/app/src/test/java/com/myraa/companion/ReleaseArtifactVerificationTest.kt`
- `android/app/src/test/java/com/myraa/companion/StandaloneMobileLaunchUxTest.kt`
- `android/app/src/test/java/com/myraa/companion/StandaloneVoicePipelineTest.kt`

**Reason for non-relocation (`NOT_SAFE_TO_MOVE`):**
The Android Gradle build system strictly binds test compilation to standard source sets (`src/test/java`). Moving these files into `tests/` would disconnect them from Gradle dependency resolution, Android SDK stubs, and CI test pipelines (`./gradlew test`).

---

## 7. External Service & Environment Requirements

Certain tests require live credentials or network connectivity and fail in an offline/mock environment:
1. **Live Production Endpoints**: `tests/e2e/phase11_live_production_e2e.test.ts` validates live Render cloud deployment (`https://myraa-ai-q0h3.onrender.com`).
2. **Windows Authenticode Signing**: `tests/integration/phase13a_win_authenticode_trust.test.ts` checks Azure Key Vault / signtool certificate configuration.
3. **HTTP Security Gate Authentication**: Tests in `phase10_final_production_verification.test.ts` and `production_hardening_phase30.test.ts` verify that endpoints without valid session tokens receive HTTP 401.

---

## 8. Known Baseline Status & Duplicate Candidates

### Duplicate Candidates Requiring Manual Review
1. `tests/test_desktop_agent_app_resolution.py`
2. `tests/python/test_desktop_agent_app_resolution.py`
- Both files test the same `desktop_agent` application and folder resolution logic.
- `tests/python/test_desktop_agent_app_resolution.py` is properly organized within `tests/python/` with path adjustments (`../..`).
- In accordance with safety rules forbidding file deletion, both files are retained. A future cleanup may safely archive the root-level copy once confirmed.

### Pre-existing Baseline Failures
- `tests/unit/ai_study_companion.test.ts`: Line 590 expects `output.configured === true` from `configureCourseProfile`.
- `tests/integration/phase4_full_orchestrator.test.ts`: Line 1273 asserts 130 tools, whereas the active system invariant is exactly 129 tools (`LIVE_TOOLS`).
- `tests/integration/phase5_device_aware_intelligence.test.ts`: Line 410 resolves target device for "YouTube kholo" as `BROWSER` instead of `PHONE`.

---

## 9. Security & Governance Invariants

All test suites and maintenance procedures must uphold the fundamental MYRAA safety architecture:
1. **LIVE_TOOLS Invariant**: Exactly **129 unique tool declarations** must be maintained across all modules.
2. **Security Chain Integrity**:
   `SecurityPolicyEngine → SecurityRiskEngine/RiskEngine → ToolExecutionFirewall → Confirmation → OutputDataFirewall → AuditLogger`
3. **Zero Test Bypasses**: Never fabricate cryptographic tokens, mock security checks into auto-accepting, or bypass the Tool Execution Firewall to make a test pass.
