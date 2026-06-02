---
title: "E2E testing in CI"
type: note
created: 2025-09-02
updated: 2025-09-02
source: chatgpt-export
conversation_id: 68b73cb6-bdf0-832d-bb5e-9d454dfd2201
message_count: 6
tags: [chatgpt, import]
---
# E2E testing in CI

> Conversation ID: 68b73cb6-bdf0-832d-bb5e-9d454dfd2201
> Created: 2025-09-02T18:51:35Z
> Updated: 2025-09-02T18:54:01Z
> Messages: 6

---

## User

what should i do with e2e test in ci?

---

## Assistant

Mr. White — short and surgical:

# E2E in CI: what to run where

**On every PR (fast):**
- Run **Playwright smoke** only (`@smoke` tags, ~10–15 tests, chromium only).
- Point at a **local build** (`next build && next start`) with **test env**:
  - Neon: ephemeral branch DB seeded with **minimal fixtures**.
  - Upstash: test DB / namespace.
  - Auth: test user shortcut (bypass email flow), no captchas.
  - External services mocked unless critical (Stripe mocked, PostHog no-op).
- Flake controls: retries=2, workers=auto, `trace:on-first-retry`, **upload traces/videos on fail**.
- **Hard cap:** ≤5 min. If it exceeds, fail.

**On merge to `preview` (thorough but parallel):**
- Hit the **Vercel Preview URL**.
- Run **full critical path** (`@critical`, `@regression`) across chromium+webkit, sharded.
- Stripe: **test mode** against a **Stripe test account** with webhook to preview.
- Cloudinary (or Vercel Images): **test bucket** only.
- Keep under **15 min** via parallelization.

**Pre-prod gate on `production` (release gate):**
- Smoke again against **production build URL** (pre-deploy or canary).
- Optionally a **nightly full suite** against staging (not blocking deploys).

# Test taxonomy (use tags)
- `@smoke` (PR required), `@critical` (preview required), `@slow` (nightly), `@admin` (role-gated).
- Skip visual diffs on PR; run them only on preview/nightly.

# Data & isolation
- Each run creates a **unique tenant**/org + test user; teardown at end.
- Seed with **idempotent script**; never reuse prod data.
- Feature flags: enable **test helpers** (disable analytics, bypass delays).

# Flake & observability
- Retries=2, `expect.soft` where UX-benign.
- Artifacts: **HTML report + traces + screenshots** on failure; keep 7 days.
- Quarantine list: auto-tag a test as `@quarantined` after N flaky fails (exclude from blocking).

# Performance guardrails
- Fail if **any single test >60s** or **TTFB >2s** on key pages.
- Track suite time trend; alert on +25% regression.

# Suggested workflows (names you can set as required)
1. **`e2e-smoke-pr`** – required on PRs
2. **`e2e-preview-suite`** – required on `preview`
3. **`e2e-prod-smoke`** – required on `production`
4. **`e2e-nightly-full`** – scheduled, non-blocking

# Playwright config essentials
- Projects: `chromium` (PR), `chromium`, `webkit` (preview/nightly).
- `use: { baseURL, trace, video:'retain-on-failure', screenshot:'only-on-failure' }`
- Shard on CI: `--shard=${{ matrix.shard }}/${{ matrix.total }}`.
- Tag selection: `--grep "@smoke"` / `--grep "@critical"` / `--grep-invert "@quarantined|@slow"`.

# External services policy
- **Stripe:** test keys + dedicated test account + preview/staging webhook.
- **PostHog:** point to test project or stub network.
- **Cloudinary/Vercel Images:** test bucket; auto-purge after run.

If you want, I’ll drop in a tight GitHub Actions + Playwright config snippet next.

---

## User

So feature branches
Preview (staging)
production

Is our main flow. Are you saying run e2e when feature-> is open?

---

## Assistant

Exactly — the flow is:  

- **Feature branches (PRs):** yes, run **fast smoke E2E** (only `@smoke` tagged). Purpose: catch obvious breakage (login, nav, dashboard load) before merging.  
- **Preview (staging):** run the **broader suite** (`@critical` + browsers). This ensures new features work correctly once merged into staging/preview.  
- **Production:** run a **smoke sanity** (basic sign-in + homepage + one core flow) as a gate or immediately post-deploy.  

So:  
- **Feature → PR open = quick smoke.**  
- **Merge into preview = full regression / critical path.**  
- **Production = quick smoke again.**

Would you like me to draft a **GitHub Actions matrix setup** showing exactly how these three job types (feature, preview, prod) get separated?

---

## User

This is YC best practice?

---

## Assistant

Yes — this matches YC’s “ship fast, don’t block yourself, but catch regressions early” playbook:  

- **Feature branches:** only run *smoke E2E* — fast feedback (<5 min). Don’t let slow, flaky, or full suites block iteration. PR checks should be quick and always green unless something is truly broken.  
- **Preview (staging):** once merged, *then* run the heavier E2E suite on the preview environment. This is where you validate integrations (Stripe test mode, PostHog, Cloudinary buckets). If something breaks here, you catch it *before prod* but *after velocity*.  
- **Production:** run a *sanity smoke* as a release gate. It’s the safety net — confirm deploy didn’t break login, dashboard, or checkout.  

YC guidance is:  
- Keep CI fast on PRs (lint, type-check, unit, smoke E2E).  
- Push heavier checks to staging/previews.  
- Never let long-running/flaky E2Es slow down daily shipping.  
- Optimize for iteration speed → reliability comes from staging + prod smoke, not PR bottlenecks.  

So yes — smoke on PR, full suite on preview, sanity on prod — that’s the YC-style best practice.  

Do you want me to sketch the exact **GitHub Actions job breakdown** (names, triggers, and required checks) so you can wire it directly into your branch protections?


## See Also
- [[chatgpt/chatgpt_ai-app-testing-process-part1]]
- [[chatgpt/chatgpt_ai-app-testing-process-part2]]
- [[chatgpt/chatgpt_ai-app-testing-process-part3]]
- [[chatgpt/chatgpt_ai-app-testing-process-part4]]
- [[chatgpt/chatgpt_ai-chaos-testing-tools]]
