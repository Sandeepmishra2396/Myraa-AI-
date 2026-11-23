# Test Mocks Directory

This directory hosts mock service implementations, WebSocket client stubs, and platform adapter stubs for isolated testing.

## Mock Guidelines
1. **Gemini Live Mocking**: WebSocket live session stubs should emulate Gemini 3.1 Flash Live protocol messages (`setupComplete`, `serverContent`, `toolCall`, `turnComplete`).
2. **Desktop Agent Mocking**: Python FastAPI RPC mock responses should conform to `desktop_agent` schemas for app resolution, window control, and system metrics.
3. **Android Client Mocking**: Stubs emulating the Android companion client WebSocket payload format.
