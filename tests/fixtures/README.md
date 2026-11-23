# Test Fixtures Directory

This directory hosts static, reusable test fixtures for automated testing across MYRAA subsystems.

## Fixture Guidelines
1. **Immutability**: Test fixtures should remain deterministic and read-only during test execution. Tests requiring write capabilities must create a scratch copy in `os.tmpdir()` or isolated workspace.
2. **Audio Fixtures**: Real PCM/WAV fixtures utilized by voice prosody and multilingual tests are canonical in `assets/` (e.g., `assets/myraa_multilingual_test.wav`, `assets/myraa_expressive_speech.wav`).
3. **Evaluation Fixtures**: Production evaluation datasets reside in `backend/research/browser/EvaluationFixtureRegistry.ts` (v1.0.0). Synthetic benchmark fixtures may be staged here.
4. **Security Grounding**: Never store real credentials, private keys, or actual auth tokens in test fixtures.
