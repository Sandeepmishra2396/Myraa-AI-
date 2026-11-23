# Testing Configuration Directory (`config/testing/`)

This directory documents test runner settings, timeout policies, isolation rules, and multi-framework testing configurations for **MYRAA**.

---

## 1. Test Framework Configurations

| Framework | Test Scope | Runner Configuration File | Invocation Command |
|---|---|---|---|
| **Vitest** | TypeScript unit, integration, E2E | `vite.config.ts` (`test: { fileParallelism: false, testTimeout: 15000 }`) | `npm test` or `npx vitest run --fileParallelism=false` |
| **Pytest** | Python desktop agent app resolution | `tests/python/test_desktop_agent_app_resolution.py` | `pytest tests/python/` or `python tests/python/test_desktop_agent_app_resolution.py` |
| **Gradle Test** | Android Companion Kotlin unit tests | `android/app/build.gradle.kts` | `./gradlew testDebugUnitTest` |

---

## 2. Testing Constraints & Best Practices

1. **Sequential Execution (`fileParallelism: false`)**:
   Due to shared singleton resources (such as `emergencyStopCoordinator`, `securityRiskEngine`, and `Port 3000/8765` listeners), Vitest must run sequentially to prevent race conditions.
2. **Deterministic Isolation**:
   Tests writing to disk must utilize isolated worker directories or mock data stores.
3. **Tool Invariant**:
   All test suites must assert exactly **129 unique `LIVE_TOOLS`** function declarations.
