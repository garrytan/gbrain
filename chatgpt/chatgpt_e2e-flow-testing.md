---
title: "E2E flow testing"
type: guide
created: 2025-08-21
updated: 2025-08-21
source: chatgpt-export
conversation_id: 68a7842c-d6c4-832a-ba7d-397e745815c4
message_count: 4
tags: [chatgpt, import, code, long-form]
---
# E2E flow testing

> Conversation ID: 68a7842c-d6c4-832a-ba7d-397e745815c4
> Created: 2025-08-21T20:42:56Z
> Updated: 2025-08-21T21:39:16Z
> Messages: 4

---

## User

On jovie we have 
Click to sign up
Register with clerk
Redirected back to onboard where there is a username check and claim. 
Then redirect to dashboard to setup profile.
Profile is publicly available.

We need this flow to work flawless and efficiently. When any update breaks this flow we need to catch it fast. 
Im having tons of problems with things breaking this flow. Ive been working for days and haven't gotten to do any work on the dashboard because this keeps breaking.  

How can i make this rock solid and catch it breaking quickly in the future.

---

## Assistant

Mr. White — here’s how to make the signup→onboard→dashboard→public-profile flow rock-solid and catch regressions fast.

# 1) Guard the “golden path” with Playwright E2E (preview + prod)
- Write a single spec that does the **entire flow**: click “Sign up” → Clerk register → username check/claim → lands on dashboard → public profile reachable and renders key selectors.
- Use a **fresh user per run** (timestamped email or Clerk test instance).
- Assert on **critical selectors**, not screenshots:  
  – `data-test=signup-btn`, `data-test=username-input`, `data-test=claim-btn`, `data-test=dashboard-welcome`, `data-test=public-profile-root`.  
- Add a **prod synthetic** that runs every 5–10 min with a throwaway account and alerts Slack on failure.

**playwright.spec.ts (outline)**
```ts
test('signup→claim→dashboard→public profile', async ({ page }) => {
  await page.goto('https://jov.ie');
  await page.getByTestId('signup-btn').click();
  // Clerk widget actions …
  const uname = `tim${Date.now()}`;
  await page.getByTestId('username-input').fill(uname);
  await page.getByTestId('claim-btn').click();
  await page.getByTestId('dashboard-welcome').waitFor();
  const url = `https://jov.ie/${uname}`;
  await page.goto(url);
  await page.getByTestId('public-profile-root').waitFor();
  await expect(page).toHaveTitle(/Jovie/i);
});
```

# 2) Block merges unless E2E passes (CI gate + auto-rollback)
- **GitHub PR:** run E2E against the **Vercel preview URL**. If it fails, **fail the PR**.  
- **Main deploy:** after Vercel builds **staging**, run the same E2E; only then promote to prod.  
- Enable **automatic rollback** (Vercel/monorepo strategy or keep last-good SHA) on failed post-deploy checks.

# 3) Stabilize onboarding with idempotent, transactional backend
- Server action/API wraps onboarding in a **single transaction**:
  - create user row (if not exists)  
  - **unique index** on `username` (CI test that rejects dupes)  
  - create public profile row  
  - commit → redirect  
- Make the endpoint **idempotent** (safe to re-POST if user refreshes).

# 4) RLS + integration tests (catch “auth broke” instantly)
- Add **RLS unit tests** using `supabase-js` in CI:  
  - anonymous cannot read private tables  
  - logged-in user can read self rows  
  - public profile is **readable without auth**.
- Separate **service-role** tests (server only) vs **publishable** key (client). Never require service-role on client paths.

# 5) Contract tests on the API that onboarding depends on
- Zod/Pipeline tests for the endpoints: `POST /claim-username`, `GET /profile/:handle`, `GET /me`.  
- Pact/contract optional; at minimum, validate request/response schemas in CI.

# 6) Health checks + canaries
- Add `/api/health/auth` (Clerk JWT verify), `/api/health/db` (simple SELECT), `/api/health/public-profile?handle=canary`.  
- A **canary user** (pre-provisioned, public) is used by a lightweight **cron Playwright** to hit: homepage → canary profile → 200 + key DOM node. Alert Slack on fail.

# 7) Observability that pinpoints the break
- **Sentry** FE+BE with release tags and source maps.  
- **PostHog** funnel for the four steps with event names matching the DOM test IDs; alert if conversion drops >X% hour-over-hour.  
- **Structured logs** (request id) around onboarding steps.

# 8) Environment hygiene (most silent killers)
- **Ephemeral DB** per PR (or schema shadow DB) → run migrations → seed **minimal fixtures**.  
- Strict **feature flags**: onboarding code paths behind flags to decouple rollout.  
- Lock versions for Clerk/Supabase SDKs; renovate merges after preview E2E passes.

# 9) Fast feedback loop (minutes, not hours)
- CI matrix: **unit (30–60s)** → **API/RLS (~1–2m)** → **E2E on preview (~2–4m)**.  
- On failure: bot **comments the failing step, screenshot, network log**; link to the exact preview URL.

# 10) Two tiny but high-leverage UX checks
- Username check endpoint has a **100–200ms budget**; test and fail CI if slower.  
- Public profile **TTFB + LCP budgets** (e.g., LCP < 2.0s on 4x CPU slow-down); fail PR if exceeded.

---

## Minimal configs to copy in now

**GitHub Action (preview E2E gate)**
```yaml
name: preview-e2e
on: pull_request
jobs:
  e2e:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npm ci
      - name: Wait for Vercel preview
        run: npx vercel-wait
      - name: Get preview URL
        run: echo "PREVIEW_URL=$(npx vercel ls --json | jq -r '.[0].url')" >> $GITHUB_ENV
      - name: Run Playwright
        run: npx playwright install --with-deps && BASE_URL="https://${{ env.PREVIEW_URL }}" npx playwright test
```

**Prod synthetic (cron)**
```yaml
name: prod-synthetic
on:
  schedule: [{ cron: "*/10 * * * *" }]
jobs:
  ping:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm ci
      - run: npx playwright install --with-deps
      - run: BASE_URL="https://jov.ie" npx playwright test e2e/prod-smoke.spec.ts
```

---

## One-shot AI prompt (drop into your code agent)
“Audit and harden the signup→Clerk register→username claim→dashboard→public profile flow. Add Playwright E2E for the full path (selectors via data-test ids), CI gates on Vercel preview, prod synthetic every 10 min with Slack alerts, transactional/idempotent onboarding on the server, unique index on usernames, RLS tests ensuring public read of profiles and authenticated read of self, API schema validation with Zod, budget checks for username API latency and public profile LCP, and auto-rollback on failed post-deploy checks. Keep changes minimal, add clear logs and Sentry breadcrumbs around each step.”

If you want, I’ll generate the exact Playwright spec, test IDs to add, and the RLS tests next.

---

## User

Do we need soft delete

---

## Assistant

Short answer: **Yes—use soft delete (with a hard-delete path for legal/PII).** It prevents breakage, preserves analytics, and lets you recover accounts/handles if something goes sideways.

## When it helps
- **Rollback/restore:** accidental deletions, failed migrations, bad deploys.
- **Username reuse safely:** reclaim old handles after cooldown.
- **Referential integrity:** tips, links, posts, logs don’t orphan.
- **Audit/compliance:** keep non-PII history; still honor GDPR/CCPA by hard-deleting/anonymizing PII.
- **Ops:** “Deactivate” instead of delete when billing or support needs access.

## Model (Postgres/Supabase)
- Add `deleted_at timestamptz null` (and optional `deleted_by uuid`).
- Enforce uniques only for active rows:
  ```sql
  -- usernames reusable when prior row is soft-deleted
  create unique index uniq_active_username
  on profiles(lower(username))
  where deleted_at is null;
  ```
- RLS: **hide deleted rows** by default:
  ```sql
  using (deleted_at is null and user_id = auth.uid())      -- for self reads
  with check (deleted_at is null and user_id = auth.uid()) -- for writes
  ```
  Public profile policy should also include `deleted_at is null`.

## API behavior
- **DELETE /me** → set `deleted_at` + queue PII scrub (or immediate hard-delete on “erase me”).
- **GET /:handle**  
  - if soft-deleted: respond **410 Gone** (SEO-friendly) or 404; never render content.
- **Re-activate**: allow the same user to “undelete” if within grace period; otherwise treat as new.

## Lifecycle & webhooks
- **Clerk webhooks**  
  - `user.deleted` → soft-delete local records; if user requests erasure, **hard-delete/anonymize** PII (emails, names), keep non-PII aggregates.
- **Cooldown for handle reuse** (e.g., 30–90 days) to prevent phishing:
  - enforce via `available_at` column or check against `deleted_at + interval '60 days'`.

## Data hygiene
- Nightly job:
  - Permanently erase rows flagged as **erasure_required = true**.
  - Anonymize PII in related tables (`user_id` → null, text fields → ‘[deleted]’), keep metrics.

## Frontend/UX
- “Deactivate account” (soft) vs “Delete & Erase” (hard) with clear copy.
- On soft delete, auto-logout and show a reactivation email flow.

## Minimal tasks to add now
1. Add `deleted_at` (users, profiles, any child tables commonly “deleted”).
2. Create partial unique indexes for active records.
3. Update RLS to exclude `deleted_at is not null`.
4. Update Clerk webhooks: soft-delete by default; hard-delete on erasure.
5. Adjust E2E: assert 410/404 for deleted profiles; assert username becomes available after grace.
6. Add admin “undelete” and “erase” actions gated by role.

This gives you **safety, reversibility, and compliance** without risking the core signup→claim→dashboard→public flow.
