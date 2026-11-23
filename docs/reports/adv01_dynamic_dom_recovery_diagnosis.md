# MYRAA ADV-01 — Dynamic DOM Recovery Diagnosis Report

**Date:** 2026-10-24  
**Author:** Antigravity Pairing Assistant  
**Status:** DIAGNOSIS COMPLETE — AWAITING EXPLICIT USER APPROVAL  
**Investigation Mode:** Strictly Read-Only (Zero Production Code or Test Modifications)

---

## 1. Executive Summary

During manual evaluation of test **ADV-01** on `https://the-internet.herokuapp.com/dynamic_controls`, two critical failures occurred:
1. **Unintended Search Engine Redirection:** The browser unexpectedly navigated to DuckDuckGo search results (`https://html.duckduckgo.com/html/?q=...`) instead of remaining on the target page.
2. **Element Not Found Failure:** MYRAA reported that selector `#add-button` was not found (`ELEMENT_NOT_FOUND: Could not locate element with CSS_SELECTOR='#add-button'. Stale element recovery exhausted.`).

Our rigorous read-only investigation uncovered **four intertwined root causes**:
- **Root Cause 1 (URL Parsing & Trailing Punctuation):** The URL extraction regex in `BrowserIntentInterpreter.ts` (`/https?:\/\/[^\s"'<>]+/gi`) captured sentence-ending punctuation (e.g. `dynamic_controls.`), producing a 404 response from Herokuapp.
- **Root Cause 2 (DuckDuckGo Fallback in UI/Agent):** In `BrowserAgent.tsx`, input that fails domain validation (`isDomain` check) or triggers search fallback is automatically converted to `https://html.duckduckgo.com/html/?q=${encodeURIComponent(finalUrl)}`.
- **Root Cause 3 (Hallucinated Selector `#add-button` vs Actual DOM):** The target page `https://the-internet.herokuapp.com/dynamic_controls` has **no `#add-button` element**. The button has no `id`; its stable selector is `#checkbox-example button` (or button text `"Remove"` / `"Add"`). The LLM or test prompt hallucinated `#add-button`.
- **Root Cause 4 (Static In-Memory DOM vs Dynamic Playwright DOM):** `BrowserActionExecutor` evaluates DOM targets against static HTML fetched via HTTP `sourceFetcher.fetch(url)` or pre-cached string snapshots, and `_handleWaitFor` polls this static string in a loop without re-fetching live DOM changes from Chromium via Playwright. Because `dynamic_controls` employs an asynchronous 3-second delay (`swapCheckbox()` via `setTimeout`), static DOM checks never observe the checkbox disappearing or reappearing.

---

## 2. Target Page Real DOM Inspection

We inspected the actual DOM of `https://the-internet.herokuapp.com/dynamic_controls` live:

### 2.1 Initial State (Before Click)
```html
<form id="checkbox-example">
  <div id="checkbox">
    <input type="checkbox" label="blah"> A checkbox
  </div>
  <button autocomplete="off" type="button" onclick="swapCheckbox()">Remove</button>
</form>
```
*Note:* The button has **no id** attribute. Its text is `"Remove"`.

### 2.2 Transition State (Immediately After Clicking "Remove")
```javascript
function swapCheckbox(){
  var btn = $("#checkbox-example button");
  var check = $("#checkbox");
  var message = $("#message");
  btn.attr("disabled", true);
  if (btn.text() == "Remove") {
    $("#loading").show(); // <div id="loading" style="display: block;">Wait for it... <img src="/img/ajax-loader.gif"></div>
    setTimeout(function() {
      check.remove();
      btn.text("Add");
      btn.attr("disabled", false);
      $("#loading").hide();
      $("#checkbox-example").append("<p id='message'>It's gone!</p>");
    }, 3000);
  }
}
```

### 2.3 Mutated State (3 Seconds After Click)
- `#checkbox` is removed completely from the DOM.
- The button text changes from `"Remove"` to `"Add"`.
- Button is re-enabled (`disabled` attribute removed).
- An element `<p id="message">It's gone!</p>` is appended.

### 2.4 Second Click State (Clicking "Add")
- 3-second timeout runs.
- Button text changes back from `"Add"` to `"Remove"`.
- `<div id="checkbox"><input type="checkbox" id="checkbox"> A checkbox</div>` is re-inserted into `#checkbox-example`.
- An element `<p id="message">It's back!</p>` is displayed.

---

## 3. Detailed Root Cause Analysis

### 3.1 Why Did the Browser End Up on DuckDuckGo?
1. In `frontend/components/BrowserAgent.tsx` (`handleNavigate`):
   ```typescript
   const isDomain = /^([a-zA-Z0-9-]+\.)+[a-zA-Z]{2,}(\/.*)?$/.test(finalUrl);
   if (!isDomain) {
     finalUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(finalUrl)}`;
   }
   ```
   When a user prompt or goal contains natural language, instructions, or an invalid/trailing-punctuated URL, `isDomain` evaluates to `false`, silently hijacking the navigation to DuckDuckGo.
2. In `backend/research/browser/BrowserIntentInterpreter.ts`:
   ```typescript
   const urlMatch = text.match(/https?:\/\/[^\s"'<>]+/gi);
   ```
   If the instruction is `"Navigate to https://the-internet.herokuapp.com/dynamic_controls. Click 'Remove'..."`, the regex extracts `"https://the-internet.herokuapp.com/dynamic_controls."` with the trailing period.
   Live test confirms:
   - `https://the-internet.herokuapp.com/dynamic_controls` -> **HTTP 200**
   - `https://the-internet.herokuapp.com/dynamic_controls.` -> **HTTP 404 Not Found**
   When the 404 page loads or when the agent attempts fallback search, the browser gets diverted to DuckDuckGo.

### 3.2 Why Did MYRAA Look for `#add-button`?
1. Neither the original DOM nor the mutated DOM contains `#add-button`. The button is simply:
   `<button autocomplete="off" type="button" onclick="swapCheckbox()">Remove</button>` / `Add`
2. `BrowserElementTargeter.ts` contains `_matchCssSelector(target, root)`. When `#add-button` is requested as a CSS selector, it searches `<button id="add-button">` and inevitably returns `ELEMENT_NOT_FOUND`.
3. In `BrowserIntentInterpreter.ts`, the multi-action prompt:
   `"Click 'Remove', wait for checkbox to disappear, then click 'Add'"`
   was flattened into a single action (`primaryAction: "CLICK"`, target `"Remove"`), dropping the wait condition and the second click entirely, or generating an ungrounded selector `#add-button` for the second step.

### 3.3 Why Did Dynamic Wait and Stale Element Recovery Fail?
1. In `BrowserActionExecutor.ts` (`_handleWaitFor`, lines 508–540):
   ```typescript
   let domHtml = '';
   if (step.url) {
     const doc = await this.sourceFetcher.fetch(step.url);
     domHtml = doc.content;
   }
   // ...
   while (Date.now() - startTime < timeoutMs) {
     const root = parse(domHtml);
     // ... checks root against target ...
     await new Promise(r => setTimeout(r, pollIntervalMs));
   }
   ```
   `domHtml` is fetched **once** via static HTTP `sourceFetcher.fetch()`! It is never re-evaluated against the running browser page in Playwright. Any in-page JavaScript mutations (such as Herokuapp's 3-second `setTimeout`) are completely invisible to this loop.
2. In `BrowserActionExecutor.ts` (`_handleClick`, line 364):
   ```typescript
   const isSuccess = res.ok || Boolean(targetedElem?.found || target);
   ```
   `isSuccess` erroneously evaluates to `true` if `target` is truthy, masking underlying desktop tool failures and corrupting execution state telemetry!

---

## 4. Affected Files & Minimal Fix Proposal

To achieve robust ADV-01 execution without regressing security or lifecycle stability:

### 4.1 Affected Files
1. `backend/research/browser/BrowserIntentInterpreter.ts`:
   - Sanitize extracted URLs by stripping trailing punctuation (`.,;:!?)]}`).
   - Support multi-step action plans for dynamic interactions (Navigate -> Click -> Wait -> Click).
2. `backend/research/browser/BrowserActionExecutor.ts`:
   - In `_handleWaitFor`: Instead of querying a static cached string, query live DOM state from Playwright via the desktop browser tool (`browser_extract_dom` or evaluating presence in active page).
   - In `_handleClick`: Fix `isSuccess` logic so it strictly reflects tool execution success (`res.ok && targetedElem?.found`).
3. `backend/research/browser/BrowserElementTargeter.ts`:
   - Enhance semantic element targeting: When a selector like `#add-button` fails, fall back to matching button/input elements by text content (e.g. `button:text-is("Add")` or text `"Add"` inside `#checkbox-example`) and attribute matching.
4. `frontend/components/BrowserAgent.tsx`:
   - Guard `handleNavigate` so valid URL patterns are not mistakenly redirected to DuckDuckGo, and ensure search fallback occurs only when explicitly intended.
5. `tests/integration/stage9_evaluation_acceptance.test.ts`:
   - Add targeted integration regression tests for:
     - URL trailing punctuation sanitization.
     - Dynamic button resolution by text (`"Remove"` -> `"Add"`) without requiring hardcoded synthetic IDs.
     - Dynamic wait polling against live DOM mutations.

---

## 5. Regression Tests, Scope Constraints & Rollback Plan

### 5.1 Invariants & Scope Constraints
- **Zero modification to frozen `desktop_agent/tools_browser.py`** without explicit user permission.
- **Strict preservation of 129 `LIVE_TOOLS` invariant.**
- **Preserve all SEC-04 origin enforcement, SSRF protections, and audit logging.**
- **Preserve NF-02 browser lifecycle recovery and NF-03 tab switching logic.**

### 5.2 Rollback Plan
All modifications will be tracked strictly in git. If any test or regression occurs, changes can be rolled back cleanly via:
`git checkout HEAD -- <modified_files>`

---

## 6. Next Step
We stop here in Phase 2 as required. We await your explicit review and approval before making any code or test modifications.
