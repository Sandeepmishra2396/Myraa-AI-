# MYRAA NF-03 — Tab Switching Failure Diagnosis Report

**Document ID:** `nf03_tab_switch_diagnosis.md`  
**Date:** 2026-10-22  
**Investigation Scope:** Manual Test NF-03 failure: `No matching tab code found.`  
**Workflow Under Test:** Multi-Tab Management:  
> *"Open https://example.com in Tab 1, open https://iana.org in new tab, switch back to Tab 1, close Tab 2"*  
**Status:** Read-only Investigation Complete — Awaiting Approval Before Code Modification  

---

## 1. Executive Summary

| Dimension | Finding |
|:---|:---|
| **Reported Failure** | When navigating between tabs (`example.com` in Tab 1, `iana.org` in Tab 2), switching back to Tab 1 fails with: `No matching tab code found.` |
| **Exact Source of Error** | [`frontend/components/BrowserAgent.tsx`](file:///d:/SORA%20AI/Sora%20AI/frontend/components/BrowserAgent.tsx#L595) line 595: `callback({ error: "No matching tab code found." });` |
| **Primary Root Cause** | **Opaque Hash ID vs Natural Identifier Mismatch:** Tabs are internally assigned randomly generated 7-character hash IDs (e.g., `id: "4f8a9b2"` via `Math.random().toString(36).substring(2, 9)`). This hash ID is **never returned** in any tool response or enumeration. The caller (Gemini) follows the tool description instructions (`"switch index values"`) and passes `tabId: "1"`, `"0"`, `"Tab 1"`, or `"example.com"`. `BrowserAgent.tsx` performs only strict literal equality `tabs.some(t => t.id === tabId)`, which fails 100% of the time. |
| **Secondary Root Cause** | **Stale React Closure:** `useEffect` in `BrowserAgent.tsx` listens to `[actionTrigger, activeTabId]` but omits `tabs`. Even though `tabsRef` exists, the handler queries the stale captured `tabs` state. |
| **Tertiary Root Cause** | **Silent Failure on `close`:** `handleCloseTab` also only looks up `t.id === targetId`. Passing `tabId: "2"` to close Tab 2 finds no match (`idx = -1`) and fails silently while falsely returning `"Done. Closed the browser tab."` |
| **Architectural Gap in Desktop Agent** | While holographic `BrowserAgent.tsx` has `browserTabAction`, the desktop automation backend [`desktop_agent/tools_browser.py`](file:///d:/SORA%20AI/Sora%20AI/desktop_agent/tools_browser.py) has `desktopBrowserOpenTab` and `desktopBrowserCloseTab` but **no tab switching tool** (`desktopBrowserSwitchTab`) or tab enumeration tool. |
| **Severity** | **HIGH** (Blocks all multi-tab automated workflows in holographic UI and prevents index/label-based tab switching). |
| **Safety Invariant** | Exactly **129 unique declarations** in `LIVE_TOOLS` must be preserved. No code edited during diagnosis. |

---

## 2. End-to-End Orchestration & IPC Flow

```
[User Voice / Chat Input]
  "Open https://example.com in Tab 1, open https://iana.org in new tab, switch back to Tab 1, close Tab 2"
         │
         ▼
[Gemini Live Session (backend/ai/GeminiSessionFactory.ts)]
  Gemini inspects function declaration:
    browserTabAction(action: "new" | "close" | "switch", tabId: string, url: string)
    Description: "Performs standard browser-tab actions: open new tab, close a tab, or switch index values."
         │
         ├── Step 1: browserOpen(url: "https://example.com")
         │     └─ UI opens Tab 1 (id="x7k9p2a", title="Example Domain")
         │        Response returned: { result: "Opening Example Domain for you now..." } [NO TAB ID EXPOSED]
         │
         ├── Step 2: browserTabAction(action: "new", url: "https://iana.org")
         │     └─ UI opens Tab 2 (id="3m4c1z8", title="IANA")
         │        Response returned: { result: "Opening a new browser tab now." } [NO TAB ID EXPOSED]
         │
         └── Step 3: browserTabAction(action: "switch", tabId: "1")
               │
               ▼
[ToolOrchestrator.ts -> sendToClient(type: "toolCall", name: "browserTabAction", args: { action: "switch", tabId: "1" })]
               │
               ▼
[frontend/App.tsx -> setBrowserTrigger]
               │
               ▼
[frontend/components/BrowserAgent.tsx -> actionTrigger useEffect]
  Evaluates:
    tabs.some(t => t.id === "1")
    t.id is "x7k9p2a" -> false
    t.id is "3m4c1z8" -> false
               │
               ▼
  Line 595 triggers:
    callback({ error: "No matching tab code found." });
```

---

## 3. Root Cause Breakdown (Evidence & Analysis)

### 3.1 Defect 1: Random Alphanumeric Hash ID vs Human/Model Identifiers
In `frontend/components/BrowserAgent.tsx`:
- Line 243: `const tabId = Math.random().toString(36).substring(2, 9);`
- Line 992: `id: Math.random().toString(36).substring(2, 9);`
Every tab receives an internal random hash (e.g. `"9b4f2c1"`).

In `frontend/components/BrowserAgent.tsx` lines 590–597:
```tsx
} else if (tabAction === "switch") {
  if (tabId && tabs.some(t => t.id === tabId)) {
    setActiveTabId(tabId);
    callback({ result: "Let's see. Switched to that tab." });
  } else {
    callback({ error: "No matching tab code found." });
  }
}
```
**Why it fails:**
1. The tool description in `backend/ai/GeminiSessionFactory.ts` line 245 states:  
   `"Performs standard browser-tab actions: open new tab, close a tab, or switch index values."`
2. The model passes `tabId: "1"` (1-based index) or `"Tab 1"` (label) or `"example.com"` (domain).
3. `tabs.some(t => t.id === tabId)` performs an exact match against the random hash ID.
4. Neither indices (`"1"`, `1`, `"0"`), nor labels (`"Tab 1"`), nor titles (`"Example Domain"`), nor URLs (`"example.com"`) match the internal hash.
5. The switch operation unconditionally rejects the input with `"No matching tab code found."`.

### 3.2 Defect 2: Stale React State Closure
In `frontend/components/BrowserAgent.tsx` line 885:
```tsx
  }, [actionTrigger, activeTabId]);
```
- The effect depends on `actionTrigger` and `activeTabId`, but **omits `tabs`**.
- Notice lines 262–263:
  ```tsx
  const tabsRef = useRef<Tab[]>(tabs);
  tabsRef.current = tabs;
  ```
  The author recognized that `tabs` needed ref tracking, but line 591 reads `tabs.some(...)` from the component scope closure instead of `tabsRef.current`.
- When Tab 1 and Tab 2 are created in sequence, the closure may evaluate against a stale single-element `tabs` array.

### 3.3 Defect 3: Silent Failure on Tab Closure by Index/Label
In `frontend/components/BrowserAgent.tsx` lines 586–589 and lines 1004–1017:
```tsx
} else if (tabAction === "close") {
  const targetId = tabId || activeTabId;
  handleCloseTab(targetId);
  callback({ result: "Done. Closed the browser tab." });
}
```
In `handleCloseTab`:
```tsx
const handleCloseTab = (idToClose: string) => {
  if (tabs.length <= 1) {
    onClose();
    return;
  }
  const idx = tabs.findIndex(t => t.id === idToClose);
  const updated = tabs.filter(t => t.id !== idToClose);
  setTabs(updated);
```
When the user asks to "close Tab 2":
- Model sends `tabId: "2"`.
- `tabs.findIndex(t => t.id === "2")` returns `-1`.
- `updated` is identical to `tabs`. No tab is removed.
- The UI reports success (`"Done. Closed the browser tab."`), leaving an orphan tab.

### 3.4 Defect 4: Zero Metadata / Tab Enumeration in Responses
When any tab action completes:
- `new`: returns only `"Opening a new browser tab now."`
- `browserOpen`: returns only `"Opening ${cleanTitle} for you now..."`
There is no enumeration of existing tabs, their indices (`[1]`, `[2]`), active tab index, or URLs returned in the callback. The model has no ground truth to confirm which tab ID or index was assigned.

---

## 4. Empirical Reproduction Evidence

We reproduced the matching failure logic using the exact state schema:

```javascript
const tabs = [
  { id: "x7k9p2a", title: "Example Domain", url: "https://example.com" },
  { id: "3m4c1z8", title: "IANA", url: "https://iana.org" },
];

function simulateSwitch(tabId) {
  if (tabId && tabs.some(t => t.id === tabId)) {
    return { ok: true, active: tabId };
  } else {
    return { error: "No matching tab code found." };
  }
}
```

### Test Runs & Outcomes:
| Input `tabId` | Input Type | Current Result | Expected Result |
|:---|:---|:---:|:---:|
| `"1"` | 1-based index string | **`{ error: "No matching tab code found." }`** | Switch to Tab 1 (`example.com`) |
| `1` | 1-based numeric index | **`{ error: "No matching tab code found." }`** | Switch to Tab 1 (`example.com`) |
| `"Tab 1"` | Natural label string | **`{ error: "No matching tab code found." }`** | Switch to Tab 1 (`example.com`) |
| `"tab 1"` | Lowercase label | **`{ error: "No matching tab code found." }`** | Switch to Tab 1 (`example.com`) |
| `"example.com"` | Domain substring | **`{ error: "No matching tab code found." }`** | Switch to Tab 1 (`example.com`) |
| `"0"` | 0-based index string | **`{ error: "No matching tab code found." }`** | Switch to Tab 1 (`example.com`) |
| `"2"` | 1-based index string | **`{ error: "No matching tab code found." }`** | Switch to Tab 2 (`iana.org`) |
| `"Tab 2"` | Natural label string | **`{ error: "No matching tab code found." }`** | Switch to Tab 2 (`iana.org`) |
| `"iana.org"` | Domain substring | **`{ error: "No matching tab code found." }`** | Switch to Tab 2 (`iana.org`) |

**Outcome:** 100% reproduction of the exact error across all natural human and LLM calling conventions.

---

## 5. Proposed Minimal Fix Plan

### 5.1 Implement Universal Tab Resolver Function in `BrowserAgent.tsx`
Create a helper `resolveTargetTab(identifier: any, tabsList: Tab[]): Tab | undefined`:
```typescript
function resolveTargetTab(identifier: any, tabsList: Tab[]): Tab | undefined {
  if (!identifier || !tabsList.length) return undefined;
  const raw = String(identifier).trim().toLowerCase();

  // 1. Direct ID match
  const directMatch = tabsList.find(t => t.id.toLowerCase() === raw);
  if (directMatch) return directMatch;

  // 2. Tab label parsing (e.g., "tab 1", "tab-1", "tab #1", "tab1")
  const labelMatch = raw.match(/^tab\s*[-#:]?\s*(\d+)$/i);
  if (labelMatch) {
    const idx = parseInt(labelMatch[1], 10) - 1; // 1-based
    if (idx >= 0 && idx < tabsList.length) return tabsList[idx];
  }

  // 3. Numeric index: check 1-based first, then 0-based
  const num = parseInt(raw, 10);
  if (!isNaN(num)) {
    // 1-based index (e.g. "1" for first tab, "2" for second tab)
    if (num >= 1 && num <= tabsList.length) {
      return tabsList[num - 1];
    }
    // 0-based index (e.g. "0" for first tab)
    if (num >= 0 && num < tabsList.length) {
      return tabsList[num];
    }
  }

  // 4. Positional words
  if (raw === "first" || raw === "first tab") return tabsList[0];
  if (raw === "second" || raw === "second tab" && tabsList.length >= 2) return tabsList[1];
  if (raw === "last" || raw === "last tab") return tabsList[tabsList.length - 1];

  // 5. URL / Domain substring match
  const urlMatch = tabsList.find(t => t.url.toLowerCase().includes(raw));
  if (urlMatch) return urlMatch;

  // 6. Title substring match
  const titleMatch = tabsList.find(t => t.title.toLowerCase().includes(raw));
  if (titleMatch) return titleMatch;

  return undefined;
}
```

### 5.2 Update `browserTabAction` Handler in `BrowserAgent.tsx`
1. Use `tabsRef.current` instead of the closed-over `tabs` array to prevent stale closure bugs.
2. For `switch`:
   ```typescript
   const targetTab = resolveTargetTab(tabId, currentTabs);
   if (targetTab) {
     setActiveTabId(targetTab.id);
     activeTabIdRef.current = targetTab.id;
     setInputValue(targetTab.url === "about:blank" ? "" : targetTab.url);
     const tabIdx = currentTabs.findIndex(t => t.id === targetTab.id) + 1;
     callback({
       result: `Switched to Tab ${tabIdx}: "${targetTab.title}" (${targetTab.url}).`,
       activeTabId: targetTab.id,
       activeTabIndex: tabIdx,
       totalTabs: currentTabs.length
     });
   } else {
     callback({ error: `No matching tab code found for '${tabId}'.` });
   }
   ```
3. For `close`:
   ```typescript
   const targetTab = tabId ? resolveTargetTab(tabId, currentTabs) : currentTabs.find(t => t.id === activeTabId);
   if (targetTab) {
     handleCloseTab(targetTab.id);
     callback({
       result: `Closed Tab: "${targetTab.title}".`,
       closedTabId: targetTab.id,
       remainingTabs: currentTabs.length - 1
     });
   } else {
     handleCloseTab(activeTabId);
     callback({ result: "Closed active browser tab." });
   }
   ```
4. For `new`:
   Return tab enumeration metadata so the caller knows the assigned tab number:
   ```typescript
   handleNewTab(startUrl || "about:blank");
   const newCount = currentTabs.length + 1;
   callback({
     result: `Opened new Tab ${newCount} at ${startUrl || "about:blank"}.`,
     tabIndex: newCount,
     totalTabs: newCount
   });
   ```

---

## 6. Affected Files & Scope Approval Requirement

| File | Nature of Change | Scope Status |
|:---|:---|:---:|
| `frontend/components/BrowserAgent.tsx` | Tab resolution helper, `tabsRef` usage, structured tab metadata in callback | **Frontend Component — Non-frozen file** |
| `tests/integration/stage9_evaluation_acceptance.test.ts` | Automated regression test for tab creation, switching by index/label/URL, and closing | **Authorized Test Suite** |

> [!IMPORTANT]
> **No frozen files need to be modified for this fix.**  
> `desktop_agent/tools_browser.py` remains untouched.
> No code changes have been made yet. Awaiting explicit user approval before implementation.

---

## 7. Regression Test Plan

1. **Test NF-03.1:** Tab creation and enumeration: create Tab 1 (`example.com`) and Tab 2 (`iana.org`), verify 2 tabs present.
2. **Test NF-03.2:** Switch by numeric index: switch to `"1"` -> active tab is `example.com`.
3. **Test NF-03.3:** Switch by label: switch to `"Tab 2"` -> active tab is `iana.org`.
4. **Test NF-03.4:** Switch by URL/domain: switch to `"example.com"` -> active tab is `example.com`.
5. **Test NF-03.5:** Close by index: close `"2"` -> Tab 2 is removed, Tab 1 remains active without orphans.
6. **Tool Invariant:** Confirm `LIVE_TOOLS` contains exactly 129 unique declarations.
7. **Full Gate:** Run `npm run build` and `npx tsc --noEmit`.
