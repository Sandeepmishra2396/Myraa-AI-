# Environment Configuration Directory (`config/env/`)

This directory houses environment configuration templates, production presets, and credential schemas for **MYRAA**.

---

## 1. Directory Inventory

| File | Purpose |
|---|---|
| `.env.example` | Minimal local development template for Gemini Live API and port configuration. |
| `.env.production.example` | Production environment template for cloud/desktop deployments, SSL, signing, and remote relay. |
| `secrets.example.json` | JSON credential schema template for desktop data storage (`data/secrets.json`). |
| `README.md` | This architectural guide. |

---

## 2. Active Environment File Location Architecture

### Why Active `.env` Remains at Project Root
- **Node.js `dotenv.config()`**: In `backend/server.ts`, `dotenv.config()` defaults to `path.resolve(process.cwd(), '.env')`. When developers run `npm run dev` or `npm start`, the working directory is the repository root.
- **Vite Bundler Resolution**: Vite natively reads environment variables prefixed with `VITE_` from the project root directory where `vite.config.ts` resides (`root` / `envDir`).
- **Electron Main Process**: In packaged desktop execution, `electron/main.cjs` injects canonical desktop runtime flags into `process.env`.
- **Zero-Regression Principle**: Leaving the active `.env` at the root guarantees that all scripts, tooling, and development servers operate without breaking path changes or loader modifications.

---

## 3. Getting Started

To configure a new environment:
1. Copy `config/env/.env.example` to `.env` in the repository root:
   ```bash
   cp config/env/.env.example .env
   ```
2. Open `.env` and configure your credentials (e.g. `GEMINI_API_KEY`).
3. Never commit `.env` or credential files to version control. Root `.env*` files are strictly ignored by `.gitignore`.

---

## 4. Environment Variables Reference

| Variable | Default | Description |
|---|---|---|
| `GEMINI_API_KEY` | *(User supplied)* | Google Gemini Live API key for multimodal full-duplex session. |
| `PORT` | `3000` | Port for local MYRAA HTTP/WebSocket backend server. |
| `MYRAA_AGENT_PORT` | `8765` | Port for local Python FastAPI desktop agent (`run_agent.py`). |
| `MYRAA_BACKEND_URL` | `https://myraa-ai-q0h3.onrender.com` | Production cloud backend fallback URL. |
| `MYRAA_REQUIRE_WINDOWS_SIGNING` | `false` | When `true`, enforces strict Authenticode signing on release packaging. |
