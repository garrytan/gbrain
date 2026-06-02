---
title: "CI profile page test"
type: guide
created: 2025-11-29
updated: 2025-11-29
source: chatgpt-export
conversation_id: 692a848a-84a4-8325-8490-28ec2c26c555
message_count: 2
tags: [chatgpt, import, code]
---
# CI profile page test

> Conversation ID: 692a848a-84a4-8325-8490-28ec2c26c555
> Created: 2025-11-29T05:29:04Z
> Updated: 2025-11-29T05:29:34Z
> Messages: 2

---

## User

Can we set an evaluation or test for profile pages to be sub 100ms and then put that in our ci so it fails when pages become slow?

---

## Assistant

Yes, absolutely—you can enforce “profile page <100ms” in CI and have builds fail when it regresses.

Below is a practical way to do it, plus a couple of variants depending on what you actually care about (TTFB vs full page load).

---

## 1. Decide *what* “<100ms” means

You need a concrete metric:

- **Backend / API latency**  
  - e.g. `TTFB` or response time for `GET /profiles/:id` from your server.
- **Full page load metric** (harder to keep under 100ms in a real browser)
  - e.g. `First Contentful Paint (FCP)`
  - or `Time to Interactive (TTI)`

For “sub 100ms” it’s usually more realistic to target **backend response time / TTFB** from your infra, not full browser render.

I’ll show both:

---

## 2. Simple: Raw HTTP latency check in CI (<100ms TTFB)

This is CI-friendly and stack-agnostic.

### Step 1 – Write a small perf test script

Example in Node (can be called from CI):

```js
// perf-check.js
import https from "https"; // or 'http' depending on your endpoint
import { performance } from "perf_hooks";

const URL = process.env.PROFILE_URL || "https://your-site.com/profile/123";
const BUDGET_MS = parseInt(process.env.BUDGET_MS || "100", 10);
const RUNS = parseInt(process.env.RUNS || "5", 10);

function requestOnce() {
  return new Promise((resolve, reject) => {
    const start = performance.now();
    const req = https.get(URL, (res) => {
      res.on("data", () => {}); // consume
      res.on("end", () => {
        const ms = performance.now() - start;
        resolve(ms);
      });
    });
    req.on("error", reject);
  });
}

(async () => {
  const times = [];
  for (let i = 0; i < RUNS; i++) {
    const t = await requestOnce();
    times.push(t);
  }

  const avg = times.reduce((a, b) => a + b, 0) / times.length;
  const max = Math.max(...times);

  console.log(`Profile URL: ${URL}`);
  console.log(`Runs: ${RUNS}`);
  console.log(`Times: ${times.map(t => t.toFixed(1)).join(", ")} ms`);
  console.log(`Average: ${avg.toFixed(1)} ms`);
  console.log(`Max: ${max.toFixed(1)} ms`);
  console.log(`Budget: ${BUDGET_MS} ms`);

  if (avg > BUDGET_MS) {
    console.error(`❌ Performance budget FAILED (avg ${avg.toFixed(1)} > ${BUDGET_MS})`);
    process.exit(1);
  } else {
    console.log(`✅ Performance budget PASSED`);
  }
})();
```

### Step 2 – Wire it into CI

Example GitHub Actions job:

```yaml
name: Performance budget

on:
  pull_request:
  push:
    branches: [ main ]

jobs:
  profile_perf:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: 22

      - name: Install deps
        run: npm ci

      - name: Run profile perf check
        env:
          PROFILE_URL: "https://staging.your-site.com/profile/123"
          BUDGET_MS: "100"
        run: node perf-check.js
```

If the script exits with code `1`, the CI job fails → PR blocked until perf is back under budget.

You can parameterize this per environment (staging, prod) and per profile type.

---

## 3. If you want **real browser/page metrics** (Lighthouse / Playwright)

If you care about *render metrics* (FCP, LCP, etc.), use headless browser tools.

### Option A – Lighthouse CI with performance budgets

1. Install Lighthouse CI:

```bash
npm install --save-dev @lhci/cli
```

2. Add `lighthouserc.js`:

```js
// lighthouserc.js
module.exports = {
  ci: {
    collect: {
      url: ["https://staging.your-site.com/profile/123"],
      numberOfRuns: 3,
      settings: {
        preset: "desktop",
      },
    },
    assert: {
      assertions: {
        "first-contentful-paint": ["error", { "maxNumericValue": 100_000 }], // 100ms in microseconds
        // example of overall perf score threshold:
        "categories:performance": ["error", { "minScore": 0.95 }],
      },
    },
  },
};
```

3. CI step:

```yaml
- name: Run Lighthouse CI
  run: npx lhci autorun --config=lighthouserc.js
```

If `FCP > 100ms` or perf score <0.95, the command exits non-zero and the build fails.

---

### Option B – Playwright-based timing budget

Use Playwright to measure a specific navigation metric:

```bash
npm install --save-dev @playwright/test
```

`profile-perf.spec.ts`:

```ts
import { test, expect } from "@playwright/test";

const BUDGET_MS = 100;

test("profile page loads within budget", async ({ page }) => {
  const start = Date.now();
  await page.goto("https://staging.your-site.com/profile/123", {
    waitUntil: "networkidle", // or "domcontentloaded"
  });
  const elapsed = Date.now() - start;

  console.log(`Profile load time: ${elapsed} ms`);
  expect(elapsed).toBeLessThan(BUDGET_MS);
});
```

In CI:

```yaml
- name: Run Playwright tests
  run: npx playwright test profile-perf.spec.ts
```

Failed assertion => failed CI.

---

## 4. Multiple profile types / regression coverage

You can:

- Test a **representative set**:
  - cheap profile, heavy profile, staff/admin profile
- Run on:
  - every PR (fast HTTP-only test)
  - nightly/cron (heavier Lighthouse/Playwright)

Config idea:

- `fast-budget` job (almost always on PR):
  - Node script hitting APIs/pages; budget = 100ms
- `deep-budget` job (scheduled / on main):
  - Lighthouse/Playwright; budgets on FCP/LCP/TTI

---

## 5. What I’d do in practice

If you just want “CI fails when profile gets slow” with minimal fuss:

1. **Measure backend latency** with a small Node/Go/Python script (like section 2).
2. Run it in CI against your **staging** URL on every PR.
3. Add a stricter/prod-like check with Lighthouse or Playwright as a nightly job.

If you tell me:
- your stack (Next.js, Rails, Django, etc.)
- your CI provider (GitHub Actions, GitLab, CircleCI, etc.)

…I can give you a copy-pasteable config tailored exactly to what you’re running.
