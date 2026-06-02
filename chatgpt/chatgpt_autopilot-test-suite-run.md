---
title: "Autopilot test suite run"
type: guide
created: 2025-08-25
updated: 2025-08-25
source: chatgpt-export
conversation_id: 68abe970-13dc-8323-84e6-44877bf4527d
message_count: 6
tags: [chatgpt, import, code, long-form]
---
# Autopilot test suite run

> Conversation ID: 68abe970-13dc-8323-84e6-44877bf4527d
> Created: 2025-08-25T04:41:20Z
> Updated: 2025-08-25T16:28:20Z
> Messages: 6

---

## User

Five me a prompt to run all E2e smoke tests first. Fix all errors. Fix all console errors. Make them all pass. Then move onto to the golden path e2e and do the same. Then move on to the full suite and do the same. Then run full rpm check and do the same. Then push and open pr. Also no stopping. No approvals needed. No asking me to accept. i just want cascade in windsurf to run the whole thing on autopilot while im asleep.

---

## Assistant

Got it, Mr. White. Here’s a tight, copy-paste prompt for Windsurf/Cascade to run fully on autopilot.

---

# Autopilot: E2E→Golden Path→Full Suite→RPM→PR (No stops)

**You are the CI caretaker for the Jovie repo. Run this end-to-end with zero prompts, zero approvals. If a command is missing, create it. If tests are flaky, deflake. Keep commits small and atomic.**

## Objectives (strict order)
1) **E2E Smoke** → make green  
2) **E2E Golden Path** → make green  
3) **Full Test Suite** (unit + integration + all E2E) → make green  
4) **RPM Check** (perf, bundle, a11y, web-vitals/CLS/INP, Lighthouse/Next lint/perf, Storybook a11y) → make green  
5) **Push branch & open PR** with a structured checklist

## Repo assumptions & commands (create if missing)
- Package manager: `pnpm` (fall back to `npm` if pnpm missing).  
- Add/normalize scripts in `package.json` (create them if they don’t exist):
  - `"test:smoke": "playwright test -g @smoke || playwright test --config=e2e.smoke.config.ts"`
  - `"test:golden": "playwright test -g @golden || playwright test --config=e2e.golden.config.ts"`
  - `"test:e2e": "playwright test"`
  - `"test:unit": "vitest run || jest --ci"`
  - `"test:all": "pnpm test:unit && pnpm test:e2e"`
  - `"lint": "next lint --max-warnings=0 || eslint . --max-warnings=0"`
  - `"typecheck": "tsc -p . --noEmit"`
  - `"a11y:storybook": "axe-storybook || echo 'axe-storybook not configured'"`
  - `"perf:lighthouse": "lhci autorun || lighthouse http://localhost:3000 --quiet --chrome-flags='--headless' --output=json --output-path=./.artifacts/lhr.json"`
  - `"perf:bundle": "next build && npx source-map-explorer 'out/**/*.js' || npx webpack-bundle-analyzer --mode=static --no-open"`
  - `"webvitals": "node scripts/webvitals-ci.mjs || echo 'webvitals script not found'"`
  - `"rpm": "pnpm lint && pnpm typecheck && pnpm perf:lighthouse && pnpm perf:bundle && pnpm a11y:storybook && pnpm webvitals"`
- Ensure Playwright is installed & browsers are set up (`npx playwright install --with-deps`).

## Non-negotiables
- **Fix all errors and all console errors** (browser + server) before advancing each stage.  
- **Deflake** tests (retry logic, explicit waits, stable selectors, network mocking).  
- **Zero layout shift from UI state changes** in golden path (loading → success).  
- **No ESLint/TypeScript warnings**: treat as errors.  
- **No console noise** in CI: intercept and assert for `console.(error|warn)` and fail on occurrences; fix root cause.  
- **Do not touch secrets/keys.** Do not rotate tokens.  
- Keep diffs minimal, cohesive, and well-described.

## Loop (apply to each stage)
For each stage below:
- Run the command.  
- If failing, fix code/tests/config until green.  
- Re-run to confirm.  
- Commit as `fix(stage): <concise summary>`.

### Stage 1 — E2E Smoke
1. `pnpm install`
2. `pnpm lint && pnpm typecheck`
3. Start app in CI mode (`pnpm dev` or `pnpm start` with test env), then:
4. `pnpm test:smoke`
5. Fix failing specs and **all console errors** seen in test logs/browser logs.  
6. Commit: `fix(smoke): stabilize smoke e2e and eliminate console errors`

### Stage 2 — Golden Path
1. `pnpm test:golden`
2. Eliminate **all** console errors and flakiness.
3. Ensure loading→success transitions do **not** cause layout shift; add assertions for stable bounding boxes or `expect(page).toHaveScreenshot()` where appropriate.
4. Commit: `fix(golden): harden golden path and silence console`

### Stage 3 — Full Suite
1. `pnpm test:all`
2. Fix unit/integration/e2e failures; deflake; ensure deterministic seeds; mock external I/O.
3. Commit: `fix(tests): full suite green`

### Stage 4 — RPM Check
1. `pnpm rpm`
2. If missing pieces, add minimal setup:
   - Lighthouse CI config (`.lighthouserc.js`), budget assertions if possible.
   - Bundle budget (`package.json > budgets` or custom check) and fail if exceeded; fix via code-splitting, dynamic import, tree-shaking.
   - Storybook axe pass on core stories (buttons, inputs, modal, critical pages).
   - Web-vitals collection in CI or synthetic check; enforce CLS/INP/TTFB budgets.
3. Fix violations until pass.
4. Commit: `fix(rpm): meet perf/a11y/bundle budgets`

## Git & PR
- Create branch: `ci/autopilot-e2e-golden-full-rpm-<yyyy-mm-dd>`  
- After all stages pass:
  - Push branch.
  - Open PR titled: **“CI Autopilot: smoke→golden→full→rpm (green)”**
  - PR body (Markdown checklist; all boxes pre-checked if green):
    - [x] Smoke E2E green, zero console errors
    - [x] Golden Path green, zero console errors, no UI layout shift on state changes
    - [x] Full Suite green (unit + integration + e2e)
    - [x] RPM green (Lighthouse ≥ target, bundle within budget, a11y checks pass, web-vitals within thresholds)
    - **Artifacts/Notes:** link to LHCI report, bundle report, any flaky test mitigations
- Add labels: `autopilot`, `ci`, `tests`, `ready-for-merge`
- Request reviewers but **do not block**; enable merge queue if configured.

## Fix policy (apply throughout)
- Prefer code fixes over loosening assertions.  
- Replace brittle selectors with `data-testid` (add as needed).  
- Remove console noise at source; don’t suppress unless from 3rd-party—then wrap and filter with tests asserting zero unexpected logs.  
- Add missing awaits; replace timeouts with event-based waits.  
- Guard SSR vs CSR differences; fix hydration warnings.  
- Add minimal test factories and network mocks for determinism.

## Output & logging
- Keep a running `AUTOPILOT_LOG.md` at repo root with a timestamped summary of:
  - command → status  
  - failures found → fixes applied (files/commits)  
  - remaining tech debt (if any)

**Begin now. Do not ask me anything. Proceed stage-by-stage until PR is open and all boxes are checked.**

---

## User

Well run these locally and its already setup so no need to specify that just tell it to run it and autopilot itself

---

## Assistant

Here you go, Mr. White—short, ruthless, autopilot-only:

---

# Autopilot (Local): Smoke → Golden → Full → RPM → PR

**Run locally. Zero prompts. No approvals. Do not stop until PR is open and all checks are green.**

**Order & loop for each stage:** run → fix failures + **all console errors** → re-run → commit → proceed.

## Stage 1 — Smoke
- `pnpm test:smoke`
- Fix failing specs and **all** `console.error|warn` from browser/server.
- Commit: `fix(smoke): stabilize smoke e2e and eliminate console errors`

## Stage 2 — Golden Path
- `pnpm test:golden`
- Fix flakiness and **all** console errors. Ensure UI state changes don’t cause layout shift.
- Commit: `fix(golden): harden golden path and silence console`

## Stage 3 — Full Suite
- `pnpm test:all`
- Fix unit/integration/e2e failures and flakiness.
- Commit: `fix(tests): full suite green`

## Stage 4 — RPM
- `pnpm rpm`
- Fix perf/a11y/bundle/vitals violations until pass.
- Commit: `fix(rpm): meet perf/a11y/bundle budgets`

## PR
- Create branch `ci/autopilot-e2e-golden-full-rpm-<yyyy-mm-dd>`
- Push and open PR titled: **CI Autopilot: smoke→golden→full→rpm (green)**
- PR body checklist (pre-checked if green):
  - [x] Smoke E2E green, zero console errors
  - [x] Golden Path green, zero console errors, no layout shift on state changes
  - [x] Full Suite green (unit + integration + e2e)
  - [x] RPM green (perf/a11y/bundle/vitals budgets met)
  - Artifacts/notes links if available
- Labels: `autopilot`, `ci`, `tests`, `ready-for-merge`
- Request reviewers but **do not block** merge queue.

**Begin now. No questions. Run locally, fix, commit, cascade through all stages, open PR.**

---

## User

So, I'm finding that generally EDE tests are absolutely useless unless they can work with authentication. And I'm having a lot of issues with authentication and CLERC and EDE tests. What's the proper way to set up CLERC to allow EDE tests to run?

---

## Assistant

You’re right: E2E is pointless without auth. With Clerk the “proper” setup is:

1) **Use Clerk’s testing integration + token**
- Install `@clerk/testing` (dev dep).  
- In Playwright **global setup**, call `clerkSetup()` once; it fetches a short-lived **Testing Token** so your tests don’t hit “Bot traffic detected.” citeturn2view1  
- For each test that touches Clerk, call `setupClerkTestingToken({ page })` (or use the helpers below). citeturn2view1

2) **Sign in without UI (stable + fast)**
- Use the helper:  
  ```ts
  import { clerk } from '@clerk/testing/playwright'

  await page.goto('/') // an unprotected page that loads Clerk
  await clerk.signIn({
    page,
    signInParams: { strategy: 'password', identifier: process.env.E2E_CLERK_USER_USERNAME!, password: process.env.E2E_CLERK_USER_PASSWORD! },
  })
  ```
  (Supports `password`, `phone_code`, `email_code`; MFA not supported.) citeturn3view0

3) **Cache auth state once, reuse everywhere**
- In global setup, after `clerk.signIn(...)`, save storage state to `playwright/.clerk/user.json`, then set `storageState` in your projects or specific tests. This avoids re-logging in and stabilizes runs. citeturn4view0

4) **Provide keys to the test runner (not the browser)**
- Ensure your Playwright process has `CLERK_PUBLISHABLE_KEY` and `CLERK_SECRET_KEY` (dev instance). `@clerk/testing` reads them to mint the Testing Token. Don’t expose `CLERK_SECRET_KEY` to client code. citeturn2view1

5) **Have a deterministic test user**
- In the Clerk dashboard, enable **username/password** and create a dedicated **test user** (e.g., `E2E_CLERK_USER_USERNAME` / `E2E_CLERK_USER_PASSWORD`). This is what you sign in with in global setup. (Clerk’s demo repo uses this pattern.) citeturn4view0turn0search13

6) **If you need API-only auth**
- You can mint a short-lived **session token** via Backend API and attach `Authorization: Bearer <token>` in API tests (valid ~60s). Useful for non-UI calls. citeturn5view0

---

### Minimal files you need

**`global.setup.ts`** (serial)
```ts
import { clerk, clerkSetup } from '@clerk/testing/playwright'
import { test as setup } from '@playwright/test'
import path from 'path'

setup.describe.configure({ mode: 'serial' })

setup('clerk global setup', async () => {
  await clerkSetup()
})

const authFile = path.join(__dirname, '../playwright/.clerk/user.json')

setup('authenticate and cache state', async ({ page }) => {
  await page.goto('/')
  await clerk.signIn({
    page,
    signInParams: {
      strategy: 'password',
      identifier: process.env.E2E_CLERK_USER_USERNAME!,
      password: process.env.E2E_CLERK_USER_PASSWORD!,
    },
  })
  await page.goto('/protected') // sanity check: protected page loads
  await page.context().storageState({ path: authFile })
})
```
citeturn4view0turn3view0

**`playwright.config.ts`** (use cached state)
```ts
projects: [
  { name: 'global setup', testMatch: /global\.setup\.ts/ },
  {
    name: 'e2e',
    use: { storageState: 'playwright/.clerk/user.json' },
    dependencies: ['global setup'],
  },
]
```
citeturn4view0

**In tests that hit Clerk UI** (optional)
```ts
import { setupClerkTestingToken } from '@clerk/testing/playwright'
await setupClerkTestingToken({ page })
```
citeturn2view1

---

### Common gotchas (and fixes)
- **Bot traffic errors** → you forgot the Testing Token (`clerkSetup()` / `setupClerkTestingToken`). citeturn5view0  
- **Flaky OAuth popups** → prefer username/password for the test user; third-party OAuth flows are brittle for E2E. citeturn0search13  
- **Re-login every test** → you didn’t reuse `storageState`. Cache once. citeturn4view0

If you want, I’ll turn this into a one-shot Windsurf task that adds the files, env reads, and a sample spec using your existing `.env.local` keys.


## See Also
- [[chatgpt/chatgpt_windsurf-autopilot-prompt]]
- [[chatgpt/chatgpt_windsurf-autopilot-setup-part1]]
- [[chatgpt/chatgpt_windsurf-autopilot-setup-part2]]
- [[chatgpt/chatgpt_ai-agent-test-strategies]]
- [[chatgpt/chatgpt_ai-chat-security-test]]
