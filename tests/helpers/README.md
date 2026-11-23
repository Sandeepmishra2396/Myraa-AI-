# Test Helpers Directory

This directory hosts shared utility functions, test harness helpers, environment mocking helpers, and assertion helpers for Vitest test suites.

## Helper Guidelines
1. **Purity**: Test helpers should not mutate global state without resetting it in `afterEach` or `afterAll`.
2. **Type Safety**: Helpers should be authored in TypeScript (`.ts`) and export strict type signatures.
3. **Emergency Stop & Security Gates**: Any helper that alters `emergencyStopCoordinator` or security lockdown state must guarantee automatic restoration to avoid cascading test failures.
