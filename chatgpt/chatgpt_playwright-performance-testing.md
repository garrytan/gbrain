---
title: "Playwright performance testing"
type: guide
created: 2026-02-02
updated: 2026-02-02
source: chatgpt-export
conversation_id: 69800f3b-f6a8-832e-91d5-26fc9108bfb6
message_count: 4
tags: [chatgpt, import, code]
---
# Playwright performance testing

> Conversation ID: 69800f3b-f6a8-832e-91d5-26fc9108bfb6
> Created: 2026-02-02T02:43:08Z
> Updated: 2026-02-02T05:26:45Z
> Messages: 4

---

## User

playwright perfomnce

---

## Assistant

**Playwright performance basics**

- **What Playwright is:** an open-source browser automation and end-to-end testing framework by Microsoft. It controls Chromium/Firefox/WebKit for scripted browser flows. citeturn0search44

- **Performance testing with Playwright:** Playwright itself isn’t a traditional load/stress tester, but *can be used to measure web performance metrics and user-perceived speed* by running real browser interactions and capturing timing data. citeturn0search0turn0search13

---

### 📊 What you can measure via Playwright

Playwright can extract frontend performance metrics using browser APIs and DevTools:  
- **Performance timing:** e.g., `Time to First Byte (TTFB)`, `First Contentful Paint (FCP)`, `DOM interactive`, etc., via the Performance API. citeturn0search2  
- **Web Vitals & layout metrics:** like Cumulative Layout Shift (CLS) with Layout Instability API. citeturn0search3  
- **Navigation/load durations:** measure navigation start → load/end times programmatically. citeturn0search6  
- **Traces:** extract Chrome DevTools trace files for deep performance analysis. citeturn0search15

You can also use plugins like **playwright-performance-metrics** to gather Core Web Vitals and network/resource timings directly inside tests. citeturn0search7

---

### 🛠️ How it’s typically done

**1. Script a user journey** using Playwright (e.g., page.goto, clicks).  
**2. Capture performance data** via the browser’s Performance API or DevTools Protocol inside the script.  
**3. Assert against thresholds** (fail build if metrics exceed your performance budget). citeturn0search13

Example pattern in Node/Playwright:

```js
await page.goto(url);
// run performance.metrics() or use page.evaluate(() => performance.timing)
```

You then analyze or export those metrics for reporting.

---

### ⚡ When Playwright *is* useful for performance

✔ Measures *real user experience* (actual browser render + scripts).  
✔ Integrates performance checks into CI/CD alongside functional tests.  
✔ Good for *page load responsiveness* and frontend timing insights. citeturn0search13

---

### ⚠️ Limitations & when not to use it

❌ Not a classic load/stress testing tool — browsers are heavy and cannot simulate thousands of users cheaply. citeturn0search19  
❌ Doesn’t generate backend or API throughput stats — for pure server benchmarking tools like JMeter, Gatling, k6, etc., are more appropriate. citeturn0search19  
❌ Browser resource usage and performance can vary with local conditions; stable environments are needed for meaningful results. citeturn0search13

---

### 🧠 Best practices

- Control environment (headless, fixed viewport, network). citeturn0search13  
- Run multiple iterations and average metrics to reduce noise. citeturn0search13  
- Set clear performance budgets and thresholds. citeturn0search13  
- Integrate into CI/CD to catch regressions early. citeturn0search13

---

If you want, I can show you a **starter Playwright performance test script** for a website with real metric extraction.

---

## User

i mean general e2e testing with playwright. whats my options for getting it to run better

---

## Assistant

Understood, Mr. White. Concise, factual, no fluff.

## Improving **Playwright E2E test performance**

### 1. **Parallelization (biggest win)**
- Set `workers` to CPU cores (or slightly less) in CI.
- Split slow suites into multiple projects.
- Avoid global `--serial` unless absolutely required.

```ts
// playwright.config.ts
export default {
  workers: process.env.CI ? 4 : undefined,
};
```

**Rule:** tests must be **isolated** to scale.

---

### 2. **Use browser reuse aggressively**
- Prefer **`browser.newContext()` per test**, not `chromium.launch()` per test.
- Launch browser once per worker (default behavior—don’t override it).
- Avoid `test.use({ launchOptions })` inside tests.

---

### 3. **Reduce navigation + login cost**
- Use **storageState** to skip login flows.
- Seed auth tokens / cookies directly if possible.

```ts
test.use({ storageState: 'auth.json' });
```

This alone often cuts runtime **30–60%**.

---

### 4. **Headless + Chromium only**
- Use **Chromium** unless cross-browser coverage is required.
- Always run **headless** in CI.

```ts
use: {
  browserName: 'chromium',
  headless: true,
}
```

Firefox/WebKit are slower. Measure before enabling.

---

### 5. **Disable unnecessary browser work**
Block what you don’t need:
- Images
- Fonts
- Analytics
- Video

```ts
await page.route('**/*', route => {
  const type = route.request().resourceType();
  if (['image', 'font', 'media'].includes(type)) route.abort();
  else route.continue();
});
```

Huge win on JS-heavy apps.

---

### 6. **Fix waits (most common slowdown)**
Bad:
```ts
await page.waitForTimeout(5000);
```

Good:
```ts
await page.getByRole('button', { name: 'Save' }).click();
await expect(page.getByText('Saved')).toBeVisible();
```

- Never wait for time
- Never wait for network idle on SPAs
- Wait for **user-visible state**

---

### 7. **Avoid test coupling**
- No shared state across tests.
- No dependency on execution order.
- No “mega flows” that test everything in one file.

Smaller tests → better parallelization → faster suite.

---

### 8. **Use test sharding in CI**
For large suites:

```bash
npx playwright test --shard=1/4
```

Run shards in parallel CI jobs. Linear scaling.

---

### 9. **Trace only on failure**
Traces are expensive.

```ts
use: {
  trace: 'on-first-retry',
  video: 'retain-on-failure',
}
```

Never `trace: 'on'` in CI.

---

### 10. **Profile the suite**
Run:

```bash
npx playwright test --reporter=html
```

Sort by slowest tests.  
You will usually find:
- login flows
- network-idle waits
- excessive page reloads

Fix those first.

---

## Reality check
- **Playwright is already fast**.
- 80% of slowness comes from **test design**, not the tool.
- Proper isolation + storageState + parallelism beats any micro-optimizations.

If you want, tell me:
- CI provider
- suite size (# tests)
- current runtime

I can give you **exact config values** to cut it further.


## See Also
- [[chatgpt/chatgpt_clerk-playwright-testing]]
- [[chatgpt/chatgpt_playwright-e2e-testing-automation]]
- [[chatgpt/chatgpt_aerial-performance-prep]]
- [[chatgpt/chatgpt_anitta-performance-style]]
- [[chatgpt/chatgpt_app-performance-hardening-skill]]
