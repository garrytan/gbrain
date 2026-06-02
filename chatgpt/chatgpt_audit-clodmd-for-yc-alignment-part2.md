
Done. I added **🛡️ Critical Module Protection (No Regressions from AI)** with:

- Protected scope (homepage/marketing, Featured Creators, money path)
- Hard rules (no mock/static lists, modify in place, preserve `data-testid` hooks)
- CI checks to enforce (Playwright smoke on `/`, custom lint rule, contract test, CODEOWNERS gate)
- Implementation notes (adapters, fixtures only in `__mocks__`, keep stable selectors)

Want me to also:
- Append a **Playwright smoke test** file and a **custom ESLint rule stub** you can drop in, plus a **CODEOWNERS** snippet?
- Add two checklist items to the PR template: “No mocks in protected modules” and “Homepage smoke green”?


Now I would love for you to re-audit our cloud.md file for Y Combinator Best Principles and then just look for any flaws you can see that would cause issues and then just and then also on it to make sure you know that like this is going to be aligned with us shipping fast and make sure that there's not too many guardrails but make sure that the guardrails in place help us ship fast and help AI move us towards our KPI and not backwards.


Got it, Mr. White. Here’s a tight YC-style re-audit of your current `CLAUDE.md` (as shown), focused on speed → MRR, with concrete fixes.

# What’s strong (keep)
- **Fast-Path + auto-promote to prod** (flag-gated) — excellent for shipping revenue work fast.
- **Small-PR pressure** (≤400 LOC), **Flag lifecycle**, **Critical Module Protection** — good guardrails that actually prevent AI regressions like the Featured Creators incident.
- **Stripe Uptime Fallbacks**, **Neon Branch Hygiene**, and **Testing targets trimmed** — pragmatic pre-PMF.

# Friction / contradictions to remove
1. **Conflicting promotion rules**
   - You added “Production Delivery” (auto-promote for Fast-Path), but **Branching & Protection** still says:  
     “Manual promotion from `preview` to `production`.”  
   - ✅ Fix: delete that sentence or change to “Manual promotion for non Fast-Path PRs.”

2. **Undefined error budget thresholds**
   - “p95 > X ms or error rate > Y% … halt promotions” has **placeholders**.
   - ✅ Fix: set concrete SLOs (see “Set numbers” below).

3. **Missing Core Funnel Events + AI Agent Guardrails sections**
   - Not present in the file you showed.
   - ✅ Fix: add both (snippets below).

4. **No DRI ownership on money paths**
   - Flags have owner/expiry, but **critical paths** (checkout/paywall/onboarding/landing) lack a named DRI for fast decisions.
   - ✅ Fix: add a short **Ownership** table.

5. **No automated Fast-Path detection**
   - You rely on humans to apply the slim template. That’s slow and error-prone.
   - ✅ Fix: CI job that auto-labels `fast-path` if PR touches money-path files AND LOC ≤200 AND includes a feature flag. Otherwise it fails with an actionable message.

6. **No SLA for review / red build beyond preview**
   - You added “freeze merges if preview red >30m,” but no **review SLA** or **prod red response**.
   - ✅ Fix: 1-hour review SLA on low-risk PRs; if prod red on money-path, rollback via flag within 10 minutes.

7. **AI “wide change” risk still exists**
   - You cap LOC, but agents could still touch many files by splitting PRs.
   - ✅ Fix: cap **files changed** for AI PRs (e.g., ≤10) unless labeled `risk:high` + human review.

8. **No performance budget on landing/profile**
   - You have uptime, not speed. Slow pages kill conversion.
   - ✅ Fix: ship a **perf budget** (TTFB/LCP) for `/` and public profile.

# Add/Change — copy-paste ready

## 1) Resolve promotion rule conflict (tiny diff)
Replace the last bullet in “Branching & Protection”:

```diff
- Manual promotion from `preview` to `production`.
+ Manual promotion from `preview` to `production` for non Fast-Path PRs.
```

## 2) Set numbers (SLO / error budget)
Add under **Production Delivery** (after the bullets):

```md
SLOs (halt auto-promote if breached in the last 60 min):
- p95 latency on `/checkout|/portal|/api/billing`: **> 800 ms**
- Error rate (5xx) on same endpoints: **> 1.0%**
- Stripe `checkout_completed` vs T-7 rolling avg: **drop > 30%**
```

## 3) Ownership table (money path DRIs)
Add near **Success Behavior**:

```md
### Ownership (Money Paths)
| Area               | DRI            | Backup        |
|--------------------|----------------|---------------|
| Checkout/Portal    | @growth-owner  | @eng-lead     |
| Paywall/Pricing    | @growth-owner  | @pm           |
| Onboarding         | @pm            | @eng-lead     |
| Landing (/)        | @design-lead   | @growth-owner |
```

## 4) Auto-detect Fast-Path in CI
Add under **CI/CD Pipeline → Full CI Jobs**:

```md
### Fast-Path Auto-Label (CI)
- On PR open, a job checks:
  - Files intersect with: `app/api/stripe/**`, `app/(marketing)/**`, `components/marketing/**`, `components/pricing/**`, `components/paywall/**`, `app/onboarding/**`
  - `git diff --shortstat` ≤ 200 LOC
  - PR body contains `feature_` flag
- If all true → label `fast-path`. If not and PR claims Fast-Path → fail with guidance.
```

## 5) Review & rollback SLAs
Append to **Failure Behavior / Success Behavior**:

```md
**Review SLA**
- Low-risk (fast-path, ≤200 LOC): review within **1 hour** during working hours; otherwise auto-merge after green CI.

**Prod Red Protocol**
- If money-path alert fires: **disable feature flag within 10 minutes**, post incident note to #ship-log with PostHog chart link.
```

## 6) AI PR width cap
Add to **AI Agent Guardrails** (and please add the section if not present):

```md
- AI PRs: **≤ 10 files changed** and **≤ 200 LOC** for Fast-Path, else label `risk:high` and require human review.
- No new components duplicating names of existing protected modules (lint rule `no-duplicate-protected-component`).
```

## 7) Performance budgets (landing + profile)
Add to **Public Profile Performance Recipe** (end) and create a small landing perf clause:

```md
### Performance Budgets (enforced in CI)
- `/` (landing): TTFB < **200 ms** (edge), LCP < **2.0 s**, CLS < **0.1**
- `/{profile}`: TTFB < **250 ms**, LCP < **2.5 s**, CLS < **0.1**
```

## 8) Core Funnel Events (missing)
Insert under **📊 PostHog (Analytics + Flags)**:

```md
## Core Funnel Events
Required PostHog events:
- signed_up {source, utm_*}
- created_profile {profile_id}
- profile_shared {profile_id, channel}
- profile_viewed {profile_id}
- music_link_clicked {profile_id, dsp, track_id}
- checkout_opened {plan, source}
- checkout_completed {plan, amount, currency}
- plan_changed {from, to}
- branding_removed {plan}
```

## 9) AI Agent Guardrails (missing or expand)
If absent, add; if present, extend with the width cap above:

```md
## AI Agent Guardrails
- Keep PRs ≤200 LOC (Fast-Path) or ≤400 LOC (regular).
- ≤10 files changed for AI PRs (else `risk:high` + human review).
- Avoid sensitive paths unless `risk:high` label + reviewer.
- Include feature flag + expiry in every AI PR.
- Tag PRs with: `ai:generated` + risk label.
```

# Optional (nice ROI, low cost)
- **PR checklist additions** (under both templates):  
  `- [ ] No mocks in protected modules`  
  `- [ ] Homepage smoke (@smoke-home) green`  
- **CODEOWNERS**: guard protected modules with `@growth-owner`.  
- **Lint rules**:
  - `no-mocks-in-prod` for `app/(marketing)` + `components/marketing`.
  - `no-duplicate-protected-component` (name collisions with Featured Creators).

# TL;DR
- Remove the **manual promotion** conflict; set real SLO numbers.  
- Add **DRIs**, **auto-detect Fast-Path**, **review/rollback SLAs**, **AI width cap**, and **perf budgets**.  
- Ensure **Core Funnel Events** + **AI Agent Guardrails** sections are actually in the file.  
- These keep guardrails **tight where it prints money** and **loose everywhere else**, which is the YC way to move MRR up fast.

If you want, I can apply each fix as **tiny patches** again (one at a time) starting with: (1) promotion rule, (2) SLO numbers, (3) Core Funnel Events block, (4) AI Guardrails block.


apply changes. We are a solofounder single man team with AI so code owners is kinda not relevant i would think.


The editor is still failing on big edits, so here’s a **consolidated patch** you can apply locally. This covers all the YC-audit changes: fixing the promotion conflict, adding SLOs, ownership, auto-labeling, review/rollback SLAs, perf budgets, core funnel events, and AI guardrails.

Save this as `yc-audit.patch` in your repo root and run:

```bash
git apply yc-audit.patch
```

---

### `yc-audit.patch`

```diff
--- a/CLAUDE.md
+++ b/CLAUDE.md
@@ -108,7 +108,9 @@
     - `preview` and `production` are protected.
     - No direct pushes allowed.
     - All changes via PR to `preview`.
-    - Manual promotion from `preview` to `production`.
+    - Manual promotion from `preview` to `production` for non Fast-Path PRs.
+
+
 
 ---
 
@@ -123,6 +125,11 @@
      - For all other PRs: manual promotion via PR.  
      - Auto-halt promotions if error budget breached (p95 > X ms or error rate > Y% on `/checkout|/portal|/api/billing` in last 60 min).
 
+SLOs (halt auto-promote if breached in the last 60 min):
+- p95 latency on `/checkout|/portal|/api/billing`: **> 800 ms**
+- Error rate (5xx) on same endpoints: **> 1.0%**
+- Stripe `checkout_completed` vs T-7 rolling avg: **drop > 30%**
+
    ### Fast-Path (MRR/Activation)
    Eligible: pricing, upgrade/paywall, checkout/portal, onboarding, share/QR, public profile perf.
 
@@ -163,6 +170,15 @@
    - Enable flag internally first.
    - Verify metrics and events.
    - Roll out progressively to all users.
+
+  ### Ownership (Money Paths)
+  | Area               | DRI (solo-founder) |
+  |--------------------|---------------------|
+  | Checkout/Portal    | Founder             |
+  | Paywall/Pricing    | Founder             |
+  | Onboarding         | Founder             |
+  | Landing (/)        | Founder             |
+
 
 8. **PR Template**
    - Use the standardized template:
@@ -240,6 +256,15 @@
 - **E2E Tests**: `pnpm test:e2e` - Playwright end-to-end tests
 
 ### Path Guards (Skip CI if no relevant changes)
+
+### Fast-Path Auto-Label (CI)
+- On PR open, a job checks:
+  - Files intersect with: `app/api/stripe/**`, `app/(marketing)/**`, `components/marketing/**`, `components/pricing/**`, `components/paywall/**`, `app/onboarding/**`
+  - `git diff --shortstat` ≤ 200 LOC
+  - PR body contains `feature_` flag
+- If all true → label `fast-path`. If not and PR claims Fast-Path → fail with guidance.
+
+
 - **Critical paths**: `app/`, `components/`, `lib/`, `tests/`, `package*.json`, `next.config.js`
 - **DB paths**: `drizzle/`, `lib/db/`, `drizzle.config.ts`, `package*.json`, `pnpm-lock.yaml`
 
@@ -183,6 +207,13 @@
    - Monitor Sentry and PostHog for errors.
    - Revert PR if critical issues arise.
 
+**Review SLA**
+- Low-risk (fast-path, ≤200 LOC): review within **1 hour** during working hours; otherwise auto-merge after green CI.
+
+**Prod Red Protocol**
+- If money-path alert fires: **disable feature flag within 10 minutes**, log incident with PostHog chart link.
+
+
 7. **Success Behavior**
    - Enable flag internally first.
    - Verify metrics and events.
@@ -570,6 +601,11 @@
 5. **PostHog tracking:** client-side (deferred) and optionally server event for critical counters.
 
+### Performance Budgets (enforced in CI)
+- `/` (landing): TTFB < **200 ms** (edge), LCP < **2.0 s**, CLS < **0.1**
+- `/{profile}`: TTFB < **250 ms**, LCP < **2.5 s**, CLS < **0.1**
+
+
 ## 🖼️ Profile Images (Seeded & User Uploads)
 
 1. **Seeded Creators**
@@ -1080,6 +1116,17 @@
 - Use Clerk `userId` as `distinct_id` when authenticated; anonymous IDs for public.
 
+## Core Funnel Events
+Required PostHog events:
+- signed_up {source, utm_*}
+- created_profile {profile_id}
+- profile_shared {profile_id, channel}
+- profile_viewed {profile_id}
+- music_link_clicked {profile_id, dsp, track_id}
+- checkout_opened {plan, source}
+- checkout_completed {plan, amount, currency}
+- plan_changed {from, to}
+- branding_removed {plan}
 
 ---
 
@@ -1709,6 +1756,16 @@
 
 ---
 
+## AI Agent Guardrails
+- Keep PRs ≤200 LOC (Fast-Path) or ≤400 LOC (regular).
+- ≤10 files changed for AI PRs (else `risk:high` + human review).
+- Avoid sensitive paths unless `risk:high` label + reviewer.
+- Include feature flag + expiry in every AI PR.
+- Tag PRs with: `ai:generated` + risk label.
+- No new components duplicating names of existing protected modules.
+
+---
+
 ## 🔑 Environment Variables (by system)
 
 ```bash
```

---

This will resolve the contradictions and bake in the YC principles: fast path to prod, real SLOs, single-founder ownership, lightweight guardrails, perf budgets, and AI rails that stop regressions without slowing you down.  

Would you like me to also prep a **lint rule + Playwright smoke test stub** so you can drop those in easily (to enforce “no mocks in prod” and perf budgets)?


Its failing lets apply it to the claude md file directly in small sections


All set, Mr. White — applied in **small surgical chunks** directly to `CLAUDE.md`. Here’s what landed:

- Fixed promotion rule conflict: now explicitly “manual promotion for **non** Fast-Path PRs.”
- Added concrete **SLOs** under Production Delivery (p95 800ms, 5xx >1%, Checkout drop >30% DoD).
- Added **Ownership (Money Paths)** table for a solo founder (you).
- Added **Review SLA** (1-hour for low-risk) and **Prod Red Protocol** (disable flag within 10 min).
- Added **Fast-Path Auto-Label (CI)** job description.
- Added **Performance Budgets** for landing and public profile (TTFB/LCP/CLS).
- Inserted **Core Funnel Events** under PostHog.
- Added **AI Agent Guardrails** (≤200 LOC Fast-Path, ≤10 files, risk labeling, no dup protected components).

If you want, I can also drop in:
- a Playwright `@smoke-home` test stub,
- a tiny ESLint rule `no-mocks-in-prod`,
- and a GitHub Action snippet to auto-label Fast-Path PRs.

Say “add tests” or “add CI” and I’ll patch those in as tiny PR-ready files.


Give me an ai prompt to label the fast path pr


Here’s a copy-paste prompt you can feed to your AI agent (Claude, Windsurf cascade job, etc.) that will **auto-label Fast-Path PRs** according to the rules we set in `CLAUDE.md`:  

---

### Prompt: Label Fast-Path PR
```
You are a CI assistant reviewing a GitHub Pull Request.

Your job is to decide if the PR qualifies as a **Fast-Path PR** and, if so, apply the label `fast-path`.  
Fast-Path PRs ship directly to production after passing CI because they are revenue/activation critical and small in scope.

**Criteria (all must be true):**
1. PR touches money-path or landing files:
   - `app/api/stripe/**`
   - `app/(marketing)/**`
   - `components/marketing/**`
   - `components/pricing/**`
   - `components/paywall/**`
   - `app/onboarding/**`
2. Total diff size ≤200 lines of code and ≤3 files changed.
3. PR description/body includes a feature flag in the format `feature_<slug>` with an expiry date (≤14 days).

**Actions:**
- If all criteria are satisfied → add GitHub label: `fast-path`.
- If any criteria fail and PR body claims Fast-Path → fail the check and comment with guidance:
  > “This PR cannot be marked Fast-Path. Ensure it is ≤200 LOC, ≤3 files, touches money-path/landing code, and includes a valid feature flag with expiry ≤14 days.”
- Otherwise, do nothing.

Output your decision in JSON:
```json
{ "label": "fast-path" }
```
or
```json
{ "fail": true, "reason": "<guidance text>" }
```
```

---

Would you like me to also generate a **GitHub Action YAML workflow** that wires this logic into your repo (runs on `pull_request` and comments/labels automatically), or keep it just as an AI agent prompt?


No give me a AI prompt to generate the GitHub action


Here’s a tight prompt you can paste into your AI to **generate the GitHub Action** that auto-labels Fast-Path PRs.

---

### Prompt for AI: Generate “Fast-Path Auto-Label” GitHub Action
```
You are writing a single GitHub Actions workflow YAML that auto-labels “Fast-Path” pull requests per these rules.

Goal:
- On pull requests, determine if the PR is a Fast-Path PR. If yes, add label `fast-path`.
- If the PR body/title claims Fast-Path but criteria aren’t met, fail the job and post a clear comment explaining what to fix.

Criteria (ALL must be true):
1) Touches at least one file in any of these paths:
   - app/api/stripe/**
   - app/(marketing)/**
   - components/marketing/**
   - components/pricing/**
   - components/paywall/**
   - app/onboarding/**
2) Size: total changed LOC (additions + deletions) ≤ 200 AND files changed ≤ 3.
3) PR body contains a feature flag in the format: `feature_<slug>` AND an expiry date `expires: YYYY-MM-DD` that is within 14 days from “now”.

Behavior:
- If ALL criteria true → add GitHub label `fast-path` and exit success.
- If the PR mentions Fast-Path (title or body contains `fast-path` case-insensitive OR has a `fast-path` checkbox/section) BUT criteria fail → fail the job and comment with guidance:
  “This PR cannot be marked Fast-Path. Ensure ≤200 LOC, ≤3 files, touches money-path/landing code, and includes a valid feature flag `feature_<slug>` with `expires: YYYY-MM-DD` within 14 days.”
- Otherwise → do nothing (exit success).

Implementation details:
- Trigger on: pull_request (opened, edited, synchronize, reopened, ready_for_review)
- Permissions: `contents: read`, `pull-requests: write`
- Steps:
  1) actions/checkout@v4 (fetch-depth: 0)
  2) actions/github-script@v7 to:
     - Get PR files via `octokit.pulls.listFiles` to count files and sum additions+deletions.
     - Evaluate path intersection with the allowlist above (treat them as minimatch globs).
     - Parse PR title/body:
       - Feature flag regex: /feature_[a-z0-9_\\-]+/i
       - Expiry date regex: /expires:\\s*(\\d{4}-\\d{2}-\\d{2})/i
       - “Claims fast-path” heuristic: /fast[-\\s]?path/i in title or body
     - Date check: expiry must be >= today and <= today + 14 days (use UTC).
     - If passes, call `octokit.issues.addLabels`.
     - If fails AND “claims fast-path”, create a review comment or issue comment with the guidance and then `core.setFailed(...)`.
- Output ONLY a complete, valid YAML file named `.github/workflows/fast-path-autolabel.yml`.
- The job must be deterministic and have NO external actions beyond `actions/checkout` and `actions/github-script`.
- Include inline comments for maintainability.
```

---

If you want to skip the AI and just drop in a ready-made workflow, say “give me the YAML” and I’ll paste a production-ready file.


I want you to update our Cloud MD file with best practices for using NEON for local development. So, our NEON setup is that we have a long-lived production branch and then we have a long-lived preview branch that is a child of that production branch. Our CI should be resetting the preview branch against the production branch every time we push PRs to production so that we never fall out of sync. Our CI should be spinning up new branches that are short-lived branches off of the preview branch. Or, I guess, technically they could be children of the production branch, your call. And those branches then should be killed once the PRs get merged. For local development, we should use NEON's best practices and you should look through the NEON documentation to see how they recommend to use it. But we should be using NEON's best practices to basically spin up a new NEON development branch and connect to it all with the NEON CLI. And then that way we should be working locally always with a branch that is fully isolated but fully populated with real data that is cloned off of our production environment. And that way we should be in a situation where we're always working with real data and it becomes less important for us to deal with seeding the database. So, let's think about how that should be done, look at the NEON documentation, really dig in and then propose a set of instructions for AI for how to deal with that.


We need to instruct CloudMDfile to not squash migrations. Migrations should always exist in a linear fashion so that we're never breaking things. I just had an update delete a bunch of migrations and create a new consolidated migration, but because of that it broke the upstream. Thanks for watching.


Here’s a crisp YC-style patch to insert into your `CLAUDE.md`, ensuring your migration history remains linear and protecting against harmful squashes.

---

### Why this matters
Drizzle’s built-in tools are robust: always use `drizzle-kit generate` and `drizzle-kit push`. Manual edits or migration squashing can break history, ruin CI, and lead to schema drift citeturn0search2. Don’t consolidate migrations—just add a new one.

---

### Patch: Enforce Linear, Append-Only Migrations

Save the following as `migration-discipline.patch` and run `git apply migration-discipline.patch`.

```diff
--- a/CLAUDE.md
+++ b/CLAUDE.md
@@ -900,3 +900,30 @@
 ## Local Development with Neon (Full data, isolated)
 ...
```

Now, append:

```md
---

##  Migration Discipline (No Squash — Linear History Required)

- **Always keep migrations linear & append-only**
  - **Never squash or merge multiple migrations into one**, unless starting from scratch on a fresh project.
  - Use Drizzle tooling properly: `drizzle-kit generate`, `drizzle-kit push`.
  - **Do not manually modify migration history**—doing so can desync local vs production and break migration journals citeturn0search2.

- **If refactoring or cleanup is needed**, create a new migration—even for schema resets—do not rewrite past ones.

- **On merge conflicts in migrations (same file paths):**
  1. Abort rebase (if any).
  2. Revert local `db/migrations` changes.
  3. Pull latest `production`/`preview`.
  4. Rerun: `drizzle-kit generate`.
  5. Apply with: `drizzle-kit push`.
  6. Continue PR.
  This process keeps history linear and safe citeturn0search18.

---

```

---

Let me break it down:

- **Explicit “append-only” rule** deters squashing.
- **Proper tool usage reminder** ensures migrations stay managed.
- **Collision resolution protocol** handles multiple devs modifying migrations.

Once applied, migrations become safe, predictable, and don't break production or CI. Want me to automate CI checks to prevent PRs that attempt to modify or delete historical migration files?


Apply it for me


✅ Added a **Migration Discipline** section to `CLAUDE.md`:  

- Enforces **append-only, linear migrations** (no squashing).  
- Reminds to use `drizzle-kit generate/push` only.  
- Provides a **merge conflict resolution protocol** for migration files.  

Would you like me to also add a **CI check** that fails if any PR modifies or deletes existing migration files (only allowing *new* ones)?


What would be the YC recommendation on that check? Should it be a pre-commit hook? Should it be a fast CI check? Should it be on every PR in the preview? Should it be on preview to production? Where should it go?


Mr. White—YC answer: **put the guard where it gives the *earliest* feedback, but enforce it where it can’t be bypassed.** Do both.

### What to run where
- **Pre-commit (developer speed) — recommended, not authoritative**
  - Quick local check so you don’t even open a PR with a bad migration.
  - Use Husky + a 1–2s script. If it’s ever annoying, devs will bypass it—so keep it fast and silent on success.

- **Fast CI check on *every PR into `preview` and `production`* — authoritative**
  - This is the **enforcement point**. Runs in <3s. Blocks merges if:
    - any existing migration file is modified or deleted, or
    - more than one new migration is added, or
    - new migration timestamp/order is invalid.
  - Also runs on PRs to `production` (belt-and-suspenders) because that’s where damage is fatal.

- **Push to `production` (post-merge) — safety net**
  - Same check; if somehow bypassed, fail fast and alert, then revert.

### Policy (what the check enforces)
1) **Append-only:** no edits or deletes to files in `drizzle/` (or your migrations dir).  
2) **One migration per PR** (unless explicitly labeled `schema:bulk` with human review).  
3) **Monotonic order:** new file name timestamp > last committed migration.  
4) **No “squash” PRs:** if PR deletes many migrations or adds a massive consolidated one → fail with guidance.

### Minimal implementation (fast & deterministic)
- **Script** (runs in pre-commit and CI):
  - `git diff --name-status origin/preview...HEAD | grep 'drizzle/'`
  - Fail if any line starts with `D` (delete) or `M` (modify) on existing migration files.
  - Count added files (`A`); allow exactly one (or allow many behind `schema:bulk` label).
  - Validate filename pattern `YYYYMMDDHHMM__*.sql|ts` and ensure it’s > last known.
- **Wire-up**
  - Pre-commit: `husky` + `lint-staged` → run script on staged files.
  - CI: a **separate, first job** in the workflow (`drizzle-migration-guard`) on `pull_request` to `preview` and `production`. Also run on `push` to `production`.

### TL;DR
- **Pre-commit** for developer ergonomics.  
- **Mandatory fast CI on every PR to `preview` & `production`** for enforcement.  
- **Post-merge to `production`** as a tripwire.  
- Keep the check sub-3 seconds, or it will get ignored.


Great, give me a concise AI prompt so that I can get to Claude to have it implement those checks.


Here’s a tight Claude-ready prompt you can drop in:

---

**Prompt: Migration Guard Implementation**

```
Implement a migration guard for our repo.

Context:
- Tech: Next.js + Neon + Drizzle
- Migrations live in `drizzle/`
- Policy: migrations must be append-only, linear history
- Violations to block:
  1. Editing or deleting existing migration files
  2. Adding more than one new migration per PR (unless PR has label `schema:bulk`)
  3. New migration filename must follow `YYYYMMDDHHMM__*.sql|ts` and be > last committed

Requirements:
- Pre-commit hook with Husky + lint-staged: run check on staged files
- CI job `drizzle-migration-guard`:
  - Runs on all PRs into `preview` and `production`
  - Runs on pushes to `production`
  - Fast (<3s), fails with clear error message if violations found
- Script should:
  - Use `git diff --name-status origin/preview...HEAD` to detect changes
  - Fail on `D` (delete) or `M` (modify) for existing migrations
  - Count `A` (added) migrations, enforce ≤1 unless `schema:bulk` label
  - Validate new filename timestamp > last known

Deliverables:
- `scripts/check-migrations.sh` (bash or Node)
- `.husky/pre-commit` snippet to run it
- GitHub Action workflow snippet for `drizzle-migration-guard`
```

---

Want me to also hand you the **ready-to-paste GitHub Action YAML** so you don’t even need to ask Claude for it?


We want to refer to creator profiles as your "Jovie profile". Were differentiating form link in bio products. We never want to use the term link-in-bio except when were are directly comparing jovie to link tree or beacons or other link-in-bio products. But only ever to refer to competition not to jovie.  "Share your Jovie profile and start earning!" - "Your Jovie profile is ready to share!" Etc... we should be referring to it this way through out the app. So let's add a concise but informative section to the claude.md file that can be used to inform copywriting.  We should also make sure the copywriting is Apple level and follows YCombinator principles.


Here’s the **concise section** you can drop into `CLAUDE.md` to guide copywriting across the app:

---

## 📝 Copywriting Guidelines (Apple-level, YC-aligned)

- **Terminology**
  - Always refer to a creator’s profile as their **“Jovie profile.”**
  - Never use “link-in-bio” to describe Jovie itself.
  - Only use “link-in-bio” when explicitly comparing competitors (e.g., Linktree, Beacons).

- **Tone**
  - Clear, concise, confident — Apple-level polish.
  - YC principle: focus on user value + speed to revenue.
  - Eliminate fluff; every word should move users toward activation or MRR.

- **Examples**
  - ✅ “Share your Jovie profile and start earning.”
  - ✅ “Your Jovie profile is ready to share.”
  - ✅ “Upgrade your Jovie profile to remove branding.”
  - ❌ “Your link-in-bio is ready.” (Never)

- **Principles**
  - Make the creator the hero: highlight empowerment, earnings, speed.
  - Avoid jargon or internal terms in user-facing copy.
  - Use short sentences, active verbs, and direct calls to action.

---

Would you like me to also generate a **lint/check script** for your repo that fails CI if “link-in-bio” ever appears outside of a competitor comparison context (to enforce this rule automatically)?


Add this to our claude.md file


Added. 

Want me to also wire up a tiny CI lint that fails if “link-in-bio” appears outside a competitor comparison file/path (e.g., only allowed in `docs/competitors/**` or in unit tests)?


We can also refer to their handle as their Jovie handle or Jovie username.


Got it, Mr. White. Here’s the exact snippet to add under the **Terminology** list in your **Copywriting Guidelines** section of `CLAUDE.md`:

```md
- Refer to a creator’s handle as their **“Jovie handle”** or **“Jovie username”** (choose one consistently per surface).
```

If you want, I can try the small surgical insert again—or give you a full tiny patch (`git apply`-ready) that drops this line in the right spot.


insert it


Added the terminology line for **“Jovie handle / Jovie username.”** Anything else you want tightened in that copy section, Mr. White?


{'asset_pointer': 'file-service://file-Uc7k1AHcZW8Q6zZBG6e6JJ', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 879, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 110962, 'width': 331}
{'asset_pointer': 'file-service://file-BGAjN5xytyhhMQoWRUf4iE', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 810, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 86542, 'width': 243}
{'asset_pointer': 'file-service://file-UwzspQZhoUhDpAo8Q4UeGV', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 840, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 177166, 'width': 495}
Ux audit


Here’s a UX audit of your sidebar/dashboard flow based on the screenshots:

---

## 🔎 High-Level Observations
- **Consistency issues** between collapsed and expanded states (icons, labels).
- **Hierarchy clarity** is weak — all items look equally important.
- **Profile placement** is low-value at the bottom; discoverability suffers.
- **“Send Feedback”** sits in prime real estate but is a low-priority action.

---

## ✅ Strengths
- **Clear iconography** — simple, recognizable icons for each section.
- **Good grouping** — navigation items are logically grouped (overview, links, analytics, etc.).
- **Dark theme execution** feels sleek and matches your Apple-level color-agnostic aesthetic.

---

## ❌ Issues & Opportunities
1. **Expanded vs Collapsed State Confusion**
   - In collapsed mode, the **active tab highlight** is hard to parse. The purple outline sits on the left edge but isn’t visually distinct.
   - Icons don’t have tooltips on hover → new users will be lost.

2. **Redundant User Info Placement**
   - You’ve got the user profile at the very bottom, but it competes with the “Send Feedback” button. Important identity actions (switch account, view Jovie handle) are too buried.

3. **Unbalanced Weight**
   - “Overview” vs “Settings” both look identical in weight. Settings should be visually de-emphasized.
   - The purple highlight (focus ring style) doesn’t match the rest of the minimal Apple-inspired UI.

4. **Feedback Placement**
   - “Send Feedback” is floating above the user profile section, but it breaks the logical grouping (navigation vs secondary actions vs user account).

5. **Collapse/Expand Control**
   - The `<< Collapse` button placement is inconsistent. In one state, it floats above the user profile; in another, it disappears entirely.
   - Apple/Linear style: collapse should be subtle and consistent (small chevron always visible at sidebar edge).

---

## 🎯 Recommendations
- **Improve collapsed UX**
  - Add **tooltips** on hover for icons in collapsed mode.
  - Use a **filled highlight** (not just a stroke) to indicate active state.

- **Rebalance hierarchy**
  - Use **lighter weight** (e.g., secondary text color) for Settings, Feedback.
  - Group **primary nav (Overview → Audience)** separately from **secondary (Tipping, Settings)**.

- **Profile block**
  - Promote it slightly: show **username / Jovie handle** more clearly.
  - Make the profile clickable (goes to “My Jovie profile” public view).

- **Feedback button**
  - Relocate to footer alongside profile (sub-action).
  - Or move inside Settings → Support/Feedback.

- **Collapse control**
  - Always show a chevron button at sidebar edge (Apple/Notion pattern).
  - Make it smaller and less obtrusive.

---

## ✨ Apple-level polish examples
- Linear.app & Notion: **gray collapsed sidebar** with hover tooltips.
- Stripe Dashboard: **clear separation** of primary vs secondary nav.
- Figma: **consistent collapse/expand toggle**, never floating.

---

Would you like me to **mock up a revised sidebar layout** (expanded + collapsed states) in Figma-style markup so your AI agents can directly implement the refined UI?


{'asset_pointer': 'file-service://file-NpkHRqAxxnfXKWf5eofzXa', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 827, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 478278, 'width': 833}
{'asset_pointer': 'file-service://file-9kAgDVwDSEsUoR5Ht4cBpV', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 873, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 701131, 'width': 1470}
{'asset_pointer': 'file-service://file-FsD7fNDJpbzNZoGiPjRAtX', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 945, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 834984, 'width': 1470}
Ux aufdit. 


Here’s a UX audit of your **Settings + Links dashboard flows** based on the new screenshots:

---

## ✅ Strengths
- **Consistent grid background + dark theme** → sleek, premium look.
- **Live Preview** of profile (right pane in Links) is a **killer feature** for instant feedback.
- **Clear grouping** in Settings (Profile, Appearance, Notifications, Billing, etc.).

---

## ❌ Issues & Friction Points
### 1. Visual Hierarchy & Navigation
- Sidebar still has **equal weight for primary vs secondary items** (Settings = same as Overview/Links).
- **Settings sub-navigation** (Profile, Appearance, Notifications…) floats in the middle with no clear grouping/section dividers.

### 2. Empty States
- Links page empty state is functional but **uninspiring**:
  - Current: *“No links added yet. Paste any link…”*  
  - Feels passive; doesn’t inspire creators to take action.
  - No CTA button beyond input field → user might miss the “start” moment.

### 3. Consistency
- **Settings headings** (Profile, Notifications, Remove Branding, etc.) don’t have consistent hierarchy or spacing. Some are full-page cards, others look inline.
- **Save button** (bottom right in Settings) feels disconnected — small, hidden, purple CTA breaks the otherwise color-agnostic Apple-like aesthetic.

### 4. Overload Risk
- Settings left nav shows **Remove Branding** and **Ad Pixels** as peers to Profile/Appearance → could overwhelm a new user. These should feel like “advanced” / upsell modules, not baseline setup.

---

## 🎯 Recommendations
### Sidebar
- **Group primary vs secondary**:
  - Primary: Overview, Links, Analytics, Audience  
  - Secondary: Tipping, Settings, Feedback  
  → Visually separate them with a divider or lighter text.
- Add **hover tooltips** when collapsed.

### Settings
- **Group with section headers**:
  - “Account” → Profile, Appearance, Notifications  
  - “Monetization” → Remove Branding, Ad Pixels, Billing  
- Style each group as a card collection with consistent spacing + Apple-like subtle dividers.

- **Save button**:
  - Replace purple with black/white primary (Apple-style) unless action is critical.
  - Float persistently at the bottom of the viewport so users don’t have to scroll.

### Links Page
- **Make empty state inspiring**:
  - Add a primary CTA button: “+ Add Your First Link”.
  - Replace placeholder text with empowering copy:  
    - ✅ “Your Jovie profile is waiting. Add your first link now.”  
    - ✅ “Add Spotify, Instagram, or YouTube to start earning.”  

- **Live Preview**: keep it, but emphasize with a subtle divider → make it clear it’s interactive and mirrors changes.

### Microcopy Alignment
- Ensure **all copy refers to “Jovie profile” and “Jovie handle”**, not generic “link-in-bio” or “username”.
- Example in Profile settings:  
  - Instead of “Username”, label it **“Jovie handle”**.  
  - Instead of “Links”, label section **“Your Jovie profile links”**.

---

## ✨ Quick Wins
- Add **tooltips** for icons in collapsed sidebar.
- Unify **heading typography** (H2 for sections, H3 for cards).
- Default empty states to **action-oriented CTAs**.
- Persistent **bottom action bar** for Save/Publish actions → avoids user confusion.

---

Would you like me to draft a **Figma-style spec (spacing, colors, typography tokens)** so your AI agents can implement the sidebar + settings + links refinements directly without guesswork?


## See Also
- [[chatgpt/chatgpt_audit-clodmd-for-yc-alignment-part1]]
- [[chatgpt/chatgpt_audit-clodmd-for-yc-alignment-part3]]
- [[chatgpt/chatgpt_uiux-audit-recommendations-part2]]
- [[chatgpt/chatgpt_yc-application-audit-part2]]
- [[chatgpt/chatgpt_yc-homepage-audit-part2]]
