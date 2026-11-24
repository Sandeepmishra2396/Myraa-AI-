# Sora AI / MYRAA — Actionable Security Remediation Guide

**Date:** 2026-11-24  
**Project:** Sora AI / MYRAA Desktop  
**Target Path:** `D:\SORA AI\Sora AI`  

---

> [!IMPORTANT]
> The following remediation steps provide concrete code modifications to resolve all identified vulnerabilities. As requested by the user, **no source files have been automatically modified**. Review and apply these changes in coordination with your development lifecycle.

---

## 1. Fix for SEC-01 & SEC-04: Mutual Token Authentication for Desktop Agent

### Problem:
`desktop_agent/main.py` is unauthenticated on `127.0.0.1:8765`, allowing any local process or frame to trigger arbitrary tools.

### Solution:
Generate an ephemeral high-entropy authentication token at application startup. Pass this token from Electron to both Node.js and the Python Desktop Agent via the environment variable `MYRAA_AGENT_AUTH_TOKEN`. Validate the token on every request in FastAPI.

### Implementation:

#### Step 1: In `electron/main.cjs`
Generate the shared secret during bootstrap:
```javascript
// Add at top of electron/main.cjs
const crypto = require('crypto');
const AGENT_AUTH_TOKEN = crypto.randomBytes(32).toString('hex');

// In startBundledDesktopAgent():
agentProcess = spawn(agentExe, [], {
  cwd: path.dirname(agentExe),
  env: {
    ...process.env,
    MYRAA_AGENT_AUTH_TOKEN: AGENT_AUTH_TOKEN,
    MYRAA_AGENT_HOST: '127.0.0.1',
    MYRAA_AGENT_PORT: '8765',
    ...
  }
});

// In startLocalBackend(port):
backendProcess = spawn(process.execPath, [serverScript], {
  env: {
    ...process.env,
    MYRAA_AGENT_AUTH_TOKEN: AGENT_AUTH_TOKEN,
    ...
  }
});

// In ipcMain.handle('desktop:execute-tool'):
const res = await fetch('http://127.0.0.1:8765/execute', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${AGENT_AUTH_TOKEN}`,
  },
  body: JSON.stringify({ tool, args: effectiveArgs }),
});
```

#### Step 2: In `desktop_agent/main.py`
Enforce the token via a FastAPI dependency or middleware:
```python
import hmac
from fastapi import Header, HTTPException, status

AGENT_AUTH_TOKEN = os.environ.get("MYRAA_AGENT_AUTH_TOKEN") or os.environ.get("SORA_AGENT_AUTH_TOKEN")

@app.post("/execute", response_model=ExecuteResponse)
def execute(
    req: ExecuteRequest,
    authorization: str | None = Header(default=None)
) -> ExecuteResponse:
    if not AGENT_AUTH_TOKEN:
        log.error("MYRAA_AGENT_AUTH_TOKEN is not configured in agent environment.")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Agent security configuration error: auth token missing."
        )

    expected_header = f"Bearer {AGENT_AUTH_TOKEN}"
    if not authorization or not hmac.compare_digest(authorization.strip(), expected_header):
        log.warning("Unauthorized /execute attempt rejected.")
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or missing desktop agent authorization token."
        )

    tool = req.tool
    args = req.args or {}
    ...
```

---

## 2. Fix for SEC-02 & SEC-07: Restrict or Eliminate `runShellCommand`

### Problem:
`desktop_agent/tools_coding.py` allows arbitrary PowerShell commands with bypass execution policies and a naive keyword blacklist.

### Solution:
1. **Option A (Recommended):** Remove `runShellCommand` entirely if general desktop management does not strictly require raw shell access.
2. **Option B (Safe Parametrization):** Replace raw string commands with structured actions (e.g. `openApp(name)`, `getProcessList()`, `checkDiskSpace()`).
3. **Option C (Human Confirmation Prompt):** If shell commands are retained for developer workflows, require interactive human confirmation in Electron before execution:

```javascript
// In electron/main.cjs inside ipcMain.handle('desktop:execute-tool'):
if (tool === 'runShellCommand') {
  const choice = dialog.showMessageBoxSync(mainWindow, {
    type: 'warning',
    buttons: ['Cancel', 'Run Command'],
    defaultId: 0,
    cancelId: 0,
    title: 'Security Warning: Shell Command Requested',
    message: 'The AI assistant has requested to execute a shell command on your computer.',
    detail: `Command:\n${effectiveArgs.command || effectiveArgs.cmd}\n\nDo you want to allow this command to run?`,
  });
  if (choice !== 1) {
    return { error: 'Command execution cancelled by user.' };
  }
}
```

---

## 3. Fix for SEC-03: Restore Strict Filesystem Sandbox Boundaries

### Problem:
In `desktop_agent/tools_files.py`, adding every Windows drive letter (`C:\`, `D:\`) to `SAFE_ROOTS` disables path isolation.

### Solution:
Remove whole-drive roots from `SAFE_ROOTS`. Restrict operations strictly to user-designated working directories:

```python
# In desktop_agent/tools_files.py

HOME = Path(os.path.expanduser("~"))

# Roots under which file operations are permitted by default
SAFE_ROOTS: List[Path] = [
    HOME / "Desktop",
    HOME / "Documents",
    HOME / "Downloads",
    HOME / "Pictures",
    HOME / "Music",
    HOME / "Videos",
    Path(os.getcwd()),  # Project root
]

# REMOVE or COMMENT OUT the following loop:
# if platform.system() == "Windows":
#     import string
#     for _letter in string.ascii_uppercase:
#         _d = Path(f"{_letter}:\\")
#         if _d.exists():
#             SAFE_ROOTS.append(_d)
```

Also, update `_ensure_safe(p)`:
```python
def _ensure_safe(p: Path, allow_anywhere: bool = False) -> None:
    # Explicit user project folder allowlist can be dynamically registered
    p_resolved = p.resolve()

    # Block all sensitive user config files
    blocked_patterns = [
        str(HOME / ".ssh").lower(),
        str(HOME / ".aws").lower(),
        str(HOME / ".config").lower(),
        str(HOME / ".env").lower(),
    ]
    p_str = str(p_resolved).lower()
    for bp in blocked_patterns:
        if p_str == bp or p_str.startswith(bp + os.sep):
            raise ToolError(f"Access denied: '{p}' is a protected configuration path.")

    # Validate against SAFE_ROOTS
    is_safe = False
    for root in SAFE_ROOTS:
        try:
            r_resolved = root.resolve()
            if p_resolved == r_resolved or p_resolved.is_relative_to(r_resolved):
                is_safe = True
                break
        except Exception:
            continue

    if not is_safe:
        raise ToolError(f"Access denied: Path '{p}' is outside designated safe directories.")
```

---

## 4. Fix for SEC-05 & SEC-06: Web Proxy Origin Isolation

### Problem:
`/api/web-proxy` renders external HTML under `http://127.0.0.1:<PORT>`, enabling Same-Origin / Universal XSS against local backend endpoints.

### Solution:
1. Ensure the frontend loads the web proxy strictly inside an `iframe` with sandboxing:
   ```html
   <iframe
     src="/api/web-proxy?url=..."
     sandbox="allow-scripts allow-forms"
     referrerpolicy="no-referrer"
   ></iframe>
   ```
   *(Crucial: omit `allow-same-origin` so the proxied code has an opaque null origin and cannot access parent storage or APIs).*
2. In `backend/gateway/HttpGateway.ts`, set strict defense headers on `/api/web-proxy`:
   ```typescript
   res.setHeader("Content-Security-Policy", "sandbox allow-scripts allow-forms; default-src * 'unsafe-inline' 'unsafe-eval' data: blob:;");
   res.setHeader("X-Content-Type-Options", "nosniff");
   ```
3. Update `interceptorScript` in `HttpGateway.ts` (lines 3778, 3803) to specify the exact parent origin instead of `'*'`:
   ```javascript
   window.parent.postMessage({ type: 'NAVIGATE', url: resolvedUrl }, window.location.origin);
   ```

---

## 5. Summary of Recommended Priority Actions

| Priority | Action Item | Affected File | Effort |
| :---: | :--- | :--- | :---: |
| **P0** | Add shared secret token verification to `desktop_agent` | `desktop_agent/main.py`, `electron/main.cjs` | 1-2 hours |
| **P0** | Add human confirmation modal to `runShellCommand` | `electron/main.cjs`, `desktop_agent/tools_coding.py` | 1 hour |
| **P1** | Restrict `SAFE_ROOTS` and remove whole-drive allowlisting | `desktop_agent/tools_files.py` | 30 mins |
| **P1** | Add sandboxing CSP headers to `/api/web-proxy` | `backend/gateway/HttpGateway.ts` | 30 mins |
| **P2** | Update postMessage target origin from `'*'` to specific origin | `backend/gateway/HttpGateway.ts` | 15 mins |
