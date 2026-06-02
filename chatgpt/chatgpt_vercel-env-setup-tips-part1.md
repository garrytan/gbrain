---
title: "Vercel env setup tips"
type: essay
created: 2025-08-16
updated: 2025-08-17
source: chatgpt-export
conversation_id: 68a0c112-0920-8322-9c66-80141906104a
message_count: 48
tags: [chatgpt, import, code, long-form]
---
# Vercel env setup tips

> Conversation ID: 68a0c112-0920-8322-9c66-80141906104a
> Created: 2025-08-16T17:37:13Z
> Updated: 2025-08-17T05:21:43Z
> Messages: 48


Our jovie app is currently 3 persistentent branches. develop, preview, and main

Each is linked to a persistent domain dev.jov.ie preview.jov.ie, and jov.ie and each has its own supabase branch and GitHub environment. Finally each has a vercel environment. The develop and preview are vercel "preview" environments that are set to fixed domains and fixed GitHub branches for their ends. 

2 questions.
1 when i pull env files from vercel how do i edit the preview and develop branches sense I get a preview env and a development env and they dont necessarily tie to GitHub branches.

2) is this the most logical way to do things? Is there a better way? How do big ycombnaotr startups do it? How does a company like apple?

Less branches? more? Different setup? How can i optimize. Im one dev with some ai agents and i want to move fast but i need to never break production.


Mr. White —

### 1) Editing envs for `develop` vs `preview` on Vercel
Vercel has only 3 **targets**: Development, Preview, Production. To map your two fixed preview branches to different env values, do this:

- **Project → Settings → Environment Variables**
  - Add each var **twice** under **Target = Preview**, but **limit each to a Git branch**:
    - one with **Branch = `develop`** (feeds `dev.jov.ie`)
    - one with **Branch = `preview`** (feeds `preview.jov.ie`)
  - Keep Production vars under **Target = Production** (feeds `jov.ie`).
- Locally, pull envs as needed:
  - `vercel env pull .env.production --environment=production`
  - `vercel env pull .env.preview --environment=preview`
  - `vercel env pull .env.development --environment=development`
- You **don’t push** edited files back. To change values on Vercel, edit in the UI (branch-scoped Preview vars as above) or use `vercel env add` per var.
- In code, prefer **`VERCEL_ENV`** (`development` | `preview` | `production`) + **`VERCEL_GIT_COMMIT_REF`** for branch-specific logic when needed. Supabase keys/URLs should be fully set by the env that Vercel injects—avoid in-app switching if you can.

### 2) Is your setup optimal?
It works, but you can simplify.

**Recommended (solo dev, move fast, never break prod):**
- **Branches:**  
  - `main` → production (protected)  
  - `staging` (or your current `preview`) → pre-prod testing  
  - feature branches → short-lived PRs
  - Drop long-lived `develop` unless it has a clear role. Most YC teams run **trunk-based** with a single staging gate.
- **Deployments:**  
  - Every PR builds a Vercel **Preview** (ephemeral).  
  - Merge to `staging` auto-deploys to **preview.jov.ie**.  
  - Promote/merge to `main` auto-deploys to **jov.ie**.  
  - Keep **`dev.jov.ie`** only if you truly need a stable sandbox; otherwise let PR previews be your “dev”.
- **Env/Secrets:**  
  - Vercel **Production** (prod), **Preview (branch-scoped to `staging`)**, **Preview (branch-scoped to `develop` if kept)**.  
  - Supabase: 1 project per environment (prod/staging/dev) or **Branching** if you rely on its feature—tie each to the matching Git branch.
- **Safety rails (non-negotiable):**
  - Protected `main` (required checks).  
  - CI runs **typecheck, unit tests, lint, build**, plus a **Playwright/Cypress smoke** (hit `/`, `/listen`, `/tip`, and SSR a profile).  
  - **DB migrations**: run against staging first; promote only after green. Use **idempotent** migrations and backup prod before apply.  
  - **Feature flags** for risky UI/UX.  
  - Monitoring: Vercel Analytics + error reporting (Sentry) + uptime ping on the three domains.

**How bigger teams do it (YC “normal”, Apple-like rigor):**
- YC-style: **trunk-based**, heavy PR preview usage, one **staging** gate, automate tests, fast merges.  
- BigCo: often more gates (QA/UAT), release branches, freeze windows, canaries/blue-green. You don’t need that overhead now.

**If you keep all three domains:**
- Keep `dev.jov.ie` tied to `develop` with **branch-scoped Preview vars**.  
- Keep `preview.jov.ie` tied to `staging` (rename your current `preview` branch to `staging` for clarity).  
- `jov.ie` stays Production on `main`.

**TL;DR optimal for you**
- Branches: `main` (prod), `staging` (pre-prod), short-lived feature branches. Consider deleting `develop`.  
- Use Vercel **Preview env vars scoped to branches** to separate `dev.jov.ie` and `preview.jov.ie`.  
- Gate prod with CI + smoke + staged DB migrations + feature flags.  
- Let PR previews replace a permanent dev environment unless you truly need it.


Ok we will kill the dev.jov.ie and go one staging gate to simplify. Give me the full optimal plan now


Mr. White — here’s the streamlined, YC-style plan (one staging gate, zero drama).

# Branch & environment map
- **Branches:** `main` (prod), `staging` (pre-prod), short-lived feature branches.
- **Domains:** `jov.ie` ⇢ `main`, `preview.jov.ie` ⇢ `staging`. Kill `dev.jov.ie`.
- **Vercel targets:**  
  - Production ⇢ `main`  
  - Preview (branch-scoped) ⇢ `staging`  
  - Ephemeral PR previews for every feature branch

# Supabase
- **Projects (cleanest):** `jovie-prod`, `jovie-staging`.  
  - Separate DBs, storage, auth, and service keys.  
- **URL/keys:** set unique `NEXT_PUBLIC_SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` per env.

# Env/Secrets (Vercel)
- **Production:** prod-only vars.
- **Preview:** add **two** groups:  
  - Branch = `staging` (for preview.jov.ie)  
  - (No other branch-scoped entries needed.)
- **Local:** `.env.local` mirrors `staging` for dev; never commit.  
- Pull as needed:  
  - `vercel env pull .env.production --environment=production`  
  - `vercel env pull .env.preview --environment=preview`

# CI/CD (GitHub Actions)
**Required checks on `staging` and `main`:** typecheck, lint, unit, build, e2e smoke.

```yaml
name: CI
on:
  pull_request:
  push:
    branches: [staging, main]
jobs:
  ci:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npm ci
      - run: npm run lint
      - run: npm run typecheck
      - run: npm run build
      - run: npx playwright install --with-deps
      - run: npm run e2e:smoke # hits /, /listen, /tip, one artist slug (SSR)
```

**Deploy rules**
- **Feature PR** → Vercel **Preview** (ephemeral). Merge only if CI green.
- **Merge to `staging`** → auto deploy to **preview.jov.ie**. Run DB migrations here first.
- **Promote to `main`** (via PR from `staging` → `main`) after: green CI + manual smoke + Sentry quiet. Auto-deploy to **jov.ie**.

# Database migrations protocol
1) Author migration on feature branch.  
2) Apply to **staging** automatically on deploy (e.g., `supabase db push` or migration runner).  
3) Sanity checks + seed small QA dataset.  
4) **Prod guard:** backup prod DB, then apply migrations on `main` deploy (gated step). Prefer **idempotent, forward-only** migrations; add quick rollback SQL for hotfixes.

# Testing pyramid (lean)
- **Unit**: components/utils.  
- **Integration**: API routes / Supabase RPCs.  
- **E2E smoke (Playwright)** on PR, `staging`, and `main`:  
  - Load `/` (no 5xx, LCP under budget)  
  - Load `/[artist]` (SSR rendering, OG tags)  
  - `/tip` flow renders buttons & amounts  
  - `/listen` loads services, one click through  
  - Auth happy path (mock Clerk on PR previews if needed)

# Feature flags
- Use a tiny flag provider (e.g., ConfigCat or Supabase table) read at runtime.  
- Default **off** in prod; test **on** in staging. Wrap risky UI/ops.

# Release cadence
- Ship small PRs daily to `staging`.  
- Promote to `main` 1–3×/week after a short checklist: smoke passed, Sentry clean, analytics stable, no DB locks.

# Monitoring & rollback
- **Sentry** for FE/BE errors (separate DSNs per env).  
- **Vercel Analytics** + simple **uptime ping** (health endpoint).  
- **Instant rollback:** Vercel “Redeploy / Rollback to previous build” enabled on both envs. Keep last 5 deploys bookmarked.

# Access & safety
- Protect `main` + `staging` (require PR + checks).  
- Restrict prod Supabase service key to CI only (Vercel prod secret), rotate quarterly.  
- Principle of least privilege for personal tokens.

# Build/SSR performance (quick wins)
- Turn on Vercel **Edge** where safe (middleware, simple APIs).  
- Cache public artist pages with revalidate tags (ISR) and purge on profile edits.  
- Load only the 3rd-party pixels behind consent/flags; defer non-critical scripts.

# Operational runbook (short)
1) **Create feature branch**, commit, open PR → preview spins.  
2) **CI green** → review → merge to `staging`.  
3) **Staging deploy** runs migrations → manual smoke (~2 mins).  
4) If good → PR `staging` → `main` → prod deploy.  
5) Watch Sentry/analytics 15–30 min. If bad → **rollback**; open hotfix branch off `main`, repeat.

# Housekeeping
- Weekly: close stale PR previews, rotate keys if needed, vacuum/analyze staging DB, clear zombie storage.  
- Monthly: audit env vars, dependency updates, lighthouse on top pages.  
- Quarterly: chaos test rollback + restore from prod backup.

# Minimal scripts to add
- `npm run typecheck` (tsc --noEmit)  
- `npm run e2e:smoke` (Playwright headless suite)  
- `npm run db:migrate` / `db:seed` for both envs

# What you change right now
1) Delete `develop` branch + domain; create/confirm **`staging`** branch → map to **preview.jov.ie** in Vercel.  
2) Move branch-scoped Preview env vars to **only** `staging`.  
3) Split Supabase into **prod** and **staging** projects; update URLs/keys in Vercel.  
4) Add the CI workflow above + required checks.  
5) Create 5-test Playwright smoke.  
6) Protect `main`/`staging`; enable Vercel rollbacks.  
7) Add a tiny feature-flag table/provider.

This keeps you shipping fast with AI agents, but makes breaking prod very hard.


We will call the staging branch preview on GitHub to keep things simple as they currently are


Got it. Here’s the tightened plan with **`preview`** as the single gate.

## Topology (final)
- **Branches:** `main` (prod), `preview` (pre-prod), short-lived `feature/*`.
- **Domains:** `jov.ie` ⇢ `main`; `preview.jov.ie` ⇢ `preview`.
- **Vercel:**  
  - **Production target** ⇢ `main`  
  - **Preview target (branch-scoped)** ⇢ `preview`  
  - Ephemeral previews for every PR from `feature/*`

## Env & Secrets (Vercel)
- **Production target:** prod Supabase URL/keys, Sentry DSN, etc.
- **Preview target (branch filter = `preview`):** staging Supabase URL/keys, DSN, etc.
- Pull locally when needed:
```
vercel env pull .env.production --environment=production
vercel env pull .env.preview --environment=preview
```
(You edit values in Vercel UI or `vercel env add`; don’t “push” .env files back.)

## Supabase
- Two projects: `jovie-prod` and `jovie-preview`.
- Vars per env: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`.
- Migrations apply to **preview first**, then prod.

## CI/CD (GitHub Actions)
- **Required checks** on `preview` and `main`: lint, typecheck, build, e2e smoke.
- Minimal workflow:

```yaml
name: CI
on:
  pull_request:
  push:
    branches: [preview, main]
jobs:
  ci:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npm ci
      - run: npm run lint
      - run: npm run typecheck
      - run: npm run build
      - run: npx playwright install --with-deps
      - run: npm run e2e:smoke
```

**Deploy rules**
- PR from `feature/*` → **ephemeral Vercel preview**; merge only if CI green.
- Merge to `preview` → auto-deploys to **preview.jov.ie** and runs **staging DB migrations**.
- Open PR `preview` → `main`; merge after green CI + manual smoke → deploy to **jov.ie** and run **prod migrations** (guarded).

## DB migration protocol (safe & fast)
1) Author migration in feature branch.  
2) On `preview` deploy: run `db:migrate` (staging). Quick sanity data check.  
3) Before `main`: take prod backup → run `db:migrate` (prod). Keep a lightweight rollback SQL ready.

## Tests (lean)
- **Unit/integration** on components/utils/API routes.
- **Playwright smoke** (PR, `preview`, `main`):
  - `/` renders, no 5xx; basic LCP budget.
  - `/[artist]` SSRs with OG tags.
  - `/tip` amounts render; CTA clickable.
  - `/listen` services list loads.
  - Auth happy path (mock Clerk on PR previews).

## Feature flags
- Simple provider (ConfigCat or Supabase table).  
- Default **off** in prod; flip **on** in `preview` to verify risky changes.

## Monitoring & rollback
- **Sentry** (separate projects/DSNs for preview/prod).  
- **Vercel Analytics**; basic uptime ping on both domains.  
- Enable **Vercel rollback**; keep last 5 deploys handy.

## Protections
- Protect `main` and `preview`: PR-only, required checks, code owners if useful.
- Lock prod Supabase service key to prod Vercel only; rotate quarterly.

## Performance hygiene
- ISR for public artist pages; revalidate on profile edits.
- Defer third-party pixels; only load under consent/flags.
- Edge where safe for middleware/light API.

## Daily flow (your cadence)
1) Create `feature/*` → push → PR → ephemeral preview spins.  
2) CI green → merge → **`preview`** → preview.jov.ie + staging migrations.  
3) Quick manual smoke + Sentry glance.  
4) PR **`preview` → `main`** → merge if green → prod deploy + prod migrations.  
5) Watch Sentry/analytics 15–30 min; rollback if needed.

## One-time changes to make now
1) Remove `dev` domain; confirm **`preview.jov.ie` ↔ `preview` branch** in Vercel.  
2) In Vercel → Env Vars: set **Preview (branch filter = `preview`)** values; set **Production** values.  
3) Split/confirm Supabase projects and update Vercel secrets.  
4) Add/enable the CI workflow + required checks.  
5) Add `npm run typecheck`, `npm run e2e:smoke`, and `npm run db:migrate` scripts.  
6) Add feature-flag toggle and wire risky UI to it.  
7) Enable Vercel rollback and set Sentry per env.

This keeps your single gate (`preview`) tight, your prod safe, and your iteration speed high.


We will use branch in supabase. Also what branch should be set as default in GitHub? What branch should people pull to work on?


Mr. White — short and surgical.

### Supabase (using Branching)
- Create **Supabase branches**: `main` (prod) and `preview` (staging).  
- Enable Branching; it maps **Git ↔ Supabase** branches 1:1 and lets you merge DB changes preview→main when ready. Configure per-branch secrets in `config.toml` if you use it. citeturn0search3turn0search10
- CI: on deploy from Git `preview`, run migrations against Supabase **preview**; on `main`, run migrations against **main** (after backup). Supabase Branching 2.0 + docs cover this exact flow. citeturn0search0turn0search7

### Vercel envs (unchanged idea)
- **Production target** → `main` with prod Supabase URL/keys.  
- **Preview target** (branch-scoped) → only **`preview`** with staging Supabase URL/keys. Vercel supports branch-specific Preview vars. citeturn0search1turn0search11

---

## GitHub defaults & where people branch from

**Default branch:** `preview`  
- Rationale: your single gate is `preview`. Making it default ensures all new feature branches start from what’s going to staging, not from a prod snapshot that might lag. (This is common in trunk-ish flows with one staging gate.)

**Normal work:**
- Create from `preview`:  
  `git checkout -b feature/xyz origin/preview` → PR **into `preview`** → deploys to preview.jov.ie + Supabase preview.

**Promote to production:**
- Open PR **`preview` → `main`** → after green checks, merge → prod deploy + Supabase main migrations.

**Hotfix protocol (prod issue):**
1) `git checkout -b hotfix/foo origin/main`  
2) PR **into `main`** → deploy + Supabase main migration.  
3) Immediately back-merge **`main` → `preview`** to keep staging ahead of prod.

**Protections:**
- Protect **both** `main` and `preview` (PR required + checks).  
- Disallow direct pushes to `main`. Allow maintainers to bypass in emergencies only.

---

## Tiny checklist to lock it in
1) In **GitHub → Settings → Branches**, set **Default = `preview`**; protect `preview` and `main`.  
2) In **Supabase**, create branches **preview** and **main**; point Vercel envs to the right project/branch; keep per-branch secrets/config via `config.toml` if you use it. citeturn0search3turn0search10  
3) In **Vercel**, set Preview env vars **scoped to branch = `preview`**; Production for `main`. citeturn0search1

This keeps everyone (and your AI agents) working off the staging truth, makes promotion a one-click PR, and still gives you a clean, safe prod.


Give my ai agent a task to make this shift


Mr. White — here’s a single, copy-pasteable prompt for your AI agent.

# AI AGENT TASK: Collapse to single staging gate (`preview`) and harden prod

## Context
Repo: `itstimwhite/Jovie`  
Infra: Vercel (Next.js), Supabase (Branching), GitHub Actions

## Goal
- Keep **two long-lived branches**: `preview` (staging) and `main` (prod).
- Make **`preview` the default** in GitHub. All work branches fork from `preview`.
- Every PR → ephemeral Vercel preview; merges to `preview` → deploy to `preview.jov.ie` + run **Supabase preview** migrations; promote via PR `preview → main` → deploy `jov.ie` + run **Supabase main** migrations.
- Remove any `develop` references/domains.

---

## Plan (do in order)

### 1) Git & Branch Protections
1. Set **default branch = `preview`**.
2. Protect **`preview`** and **`main`**:
   - Require PR, require status checks (lint, typecheck, build, e2e:smoke).
   - Dismiss stale reviews on new commits, linear history.
   - Block force pushes; allow admins bypass in emergencies.
3. Close/delete stale long-lived branches (`develop`) if present.
4. Create a `CODEOWNERS` (if missing) to require at least 1 reviewer for `main` PRs.

### 2) CI (GitHub Actions)
Add/modify `.github/workflows/ci.yml`:

- Triggers: PRs and pushes on `preview`, `main` and PRs from `feature/*`.
- Jobs: `lint`, `typecheck`, `build`, `playwright smoke`.
- Matrix Node 20.
- Cache npm.
- Export `VERCEL_ENV` and `GIT_BRANCH` from env for scripts.

Add scripts to `package.json` (or ensure they exist):
```json
{
  "scripts": {
    "typecheck": "tsc --noEmit",
    "e2e:smoke": "playwright test tests/smoke",
    "db:migrate": "node scripts/db-migrate.js",
    "db:seed": "node scripts/db-seed.js"
  }
}
```

Create minimal Playwright smoke tests for:
- `/` no 5xx and key elements render
- `/[artist]` SSR renders, OG tags present
- `/tip` amounts & CTA visible
- `/listen` services load
- Auth happy path (mock Clerk on PR previews)

### 3) Supabase Branching
1. Enable **Supabase Branching** and create branches: **`preview`** and **`main`**.
2. Create `scripts/db-migrate.js` that:
   - Detects branch via `process.env.VERCEL_GIT_COMMIT_REF || process.env.GIT_BRANCH`.
   - Runs migrations against **Supabase branch = same name** (`preview` or `main`).
   - Fails fast on `main` unless `ALLOW_PROD_MIGRATIONS=true`.
3. Create `scripts/db-seed.js` that seeds a minimal dataset **only when branch = preview**.
4. Wire CI:
   - On deploys to `preview`: run `npm run db:migrate && npm run db:seed`.
   - On deploys to `main`: `npm run db:migrate` after taking a backup (see next).

Add a simple backup step in CI before main migrations (Supabase CLI/API). If CLI creds unavailable, document a manual backup step and block the migration with a checklist.

### 4) Vercel Envs & Domains
1. Domains:
   - `preview.jov.ie` → project, tied to **branch = `preview`**.
   - `jov.ie` → **`main`**.
   - Remove `dev.jov.ie` mapping.
2. Environment variables:
   - **Production target**: prod values only (Supabase main URL/keys, Sentry prod DSN, etc.).
   - **Preview target**: add **branch filter = `preview`** with staging values (Supabase preview URL/keys, Sentry preview DSN, etc.).
3. Ensure build uses env only (no in-code switching); prefer `VERCEL_ENV` and `VERCEL_GIT_COMMIT_REF` if needed.

### 5) Monitoring & Rollback
1. Sentry:
   - Separate DSNs/projects for preview vs prod; release name = `${GIT_SHA}-${GIT_BRANCH}`.
2. Vercel:
   - Enable rollbacks on both branches; keep last 5 builds.
3. Uptime:
   - Add a simple health endpoint (`/api/health`) and external ping on both domains.

### 6) Hotfix & Back-merge
- Add `docs/release.md` with:
  - **Hotfix**: branch from `main` → PR to `main` → deploy → immediately back-merge `main` into `preview`.
  - **Normal release**: PR `preview` → `main` with checklist (below).

### 7) Release Checklist (PR Template)
Create `.github/pull_request_template.md` for `preview → main`:
- [ ] CI green (lint/type/build/e2e)
- [ ] Sentry preview: no new error spikes
- [ ] DB: prod backup taken
- [ ] `ALLOW_PROD_MIGRATIONS=true` set for this run
- [ ] Post-deploy smoke completed
- [ ] Rollback plan noted

### 8) Clean Up Code & Docs
1. Search/replace repo for `develop`/`dev.jov.ie` references → update to `preview`/`preview.jov.ie`.
2. Update `README.md` with the new flow:
   - Default branch = `preview`
   - Work branches = `feature/*`
   - Promotion via PR `preview → main`
   - Env pull commands:
     - `vercel env pull .env.preview --environment=preview`
     - `vercel env pull .env.production --environment=production`

---

## Acceptance Criteria
- GitHub default branch is **`preview`**; `preview` and `main` are protected with required checks.
- Vercel routes: `preview.jov.ie` (branch `preview`), `jov.ie` (branch `main`); `dev.jov.ie` removed.
- Vercel envs correctly scoped: **Preview (branch = `preview`)** vs **Production**.
- Supabase Branching in use; migrations apply to matching branches; prod requires explicit flag + backup.
- CI runs on PRs and on pushes to `preview`/`main` and blocks merges if failing.
- Playwright smoke passes on PR previews, `preview`, and `main`.
- Docs (`README.md`, `docs/release.md`) reflect the new workflow.
- One `preview → main` release completes using the new checklist.

## Guardrails
- Do **not** store secrets in repo. Use Vercel envs & Supabase secrets.
- Do **not** run prod migrations without explicit backup & `ALLOW_PROD_MIGRATIONS=true`.
- If any step requires console access (Vercel/Supabase) and API/CLI credentials aren’t available, generate a **short operator checklist** and halt with clear instructions.

## Deliverables
- PR(s) implementing CI, scripts, tests, docs.
- Screenshot/log links proving:
  - Default branch switched
  - Branch protections active
  - Vercel env scoping set
  - Supabase branches present
  - A successful `preview` deploy with migrations & seed
  - A successful `preview → main` promotion

— end task —


On vercel i have supabase keys fro production and preview. How do all other feature branches get kes? Do they just use the development ones?


Mr. White — short answer: **yes, make all feature branches use a separate “dev” Supabase, not staging.** Here’s the clean setup.

### Vercel env strategy
- **Production target** → prod keys (only used by `main`).
- **Preview target (default)** → **DEV Supabase keys**. This applies to *all* non-prod deploys by default (PR previews + any branch).
- **Preview target (branch-scoped override = `preview`)** → **STAGING Supabase keys**. This one entry *overrides* the default Preview vars only for the `preview` branch.

Net effect:
- `main` → prod DB  
- `preview` → staging DB  
- any `feature/*` PR → **dev DB**

### Keys to set
- Default Preview (dev):  
  `NEXT_PUBLIC_SUPABASE_URL` (dev)  
  `NEXT_PUBLIC_SUPABASE_ANON_KEY` (dev)  
  **Do NOT** expose a service-role key here.
- Preview override (branch = `preview`, staging):  
  staging URL/anon + (optionally) service-role if your CI needs migrations.
- Production: prod URL/anon + service-role (only if CI migrates prod).

### Safety rails
- Only allow **service-role** on `preview` (staging) and `production` targets—**never** on default Preview (so PRs can’t mutate beyond RLS).
- Gate migrations:
  - PR previews (feature branches) → run against **dev** only.
  - `preview` deploy → run against **staging**.
  - `main` deploy → run against **prod** (with backup + flag).

### Tiny code guard (optional)
```ts
const isProd = process.env.VERCEL_ENV === 'production';
const isStaging = process.env.VERCEL_ENV === 'preview' && process.env.VERCEL_GIT_COMMIT_REF === 'preview';
// Use env-injected keys; don’t switch DBs in code.
// Optionally block dangerous ops when !isProd && !isStaging.
```

### TL;DR
Set **default Preview** vars to **DEV** keys, add a **branch-scoped Preview override** for `preview` with **STAGING** keys. All feature branches automatically use dev; only `preview` hits staging; `main` hits prod. Never break prod.


How does this work with the GitHub branchingi integration on supabase?


Mr. White — here’s how it fits together, no gotchas.

## How Supabase Branching + GitHub works
- Supabase can **watch your GitHub repo** and create a **Supabase preview branch per Git branch/PR**, keeping schema/edge-functions in sync. When you merge to the production branch, Supabase applies the prod migrations. citeturn0search0turn0search10
- There’s also a **hosting-provider integration**: it maps the **hosting branch** (e.g., a Vercel preview for `feature/foo`) to the **matching Supabase preview branch**, so that preview deploy hits the correct schema/config. citeturn0search6

## Two ways to run it (pick one)

### A) “Simple & fast” (what you asked for)
- **Vercel envs**  
  - **Production** → prod Supabase (for `main`)  
  - **Preview (default)** → **dev** Supabase (for *all* feature branches)  
  - **Preview (branch-scoped = `preview`)** → **staging** Supabase  
  Branch-scoped vars override default Preview automatically. citeturn0search2turn0search3
- **Supabase Branching**  
  - Keep **two persistent branches** only: `main` (prod) and `preview` (staging).  
  - **Do not** spin up a Supabase branch per feature branch.  
  - Run migrations on Supabase **preview** when you merge to Git `preview`, and on **main** when you promote to prod.
- Result: **Feature branches** use the shared **dev** DB; `preview` uses staging; `main` uses prod. Clean, few keys, minimal overhead.

### B) “1:1 mapping” (heavier, more isolation)
- Turn on the **Supabase↔GitHub↔Hosting integration** so **every Git branch/PR** gets its own **Supabase preview branch**. citeturn0search1turn0search6  
- Each Vercel preview would then need to **point at that branch’s Supabase URL/anon key**. You can do this via the Supabase hosting integration (auto-matches the preview deployment to the right Supabase branch) or by setting **branch-specific env vars** in Vercel for any branch where you want to override. Note: this adds management overhead. citeturn0search6turn0search2

## Recommendation for you
Stick with **A (Simple & fast)**: one **dev** DB for all feature branches, **staging** for the `preview` gate, **prod** for `main`. It aligns with your “move fast, never break prod” goal and keeps secrets tidy.

### Quick checklist to wire it:
1) **Vercel → Env Vars**  
   - **Preview (default):** set **DEV** Supabase URL/anon.  
   - **Preview (branch = `preview`):** set **STAGING** URL/anon (overrides default).  
   - **Production:** set **PROD** URL/anon (+ service role only where needed). citeturn0search2
2) **Supabase Branching**  
   - Use **`preview`** and **`main`** branches only. Migrations run on those two via CI; feature branches don’t create Supabase branches. citeturn0search1
3) **CI gates**  
   - On push to `preview` → run staging migrations; on merge to `main` → run prod migrations (after backup). citeturn0search13

If someday you want per-PR database isolation (demoing risky schema changes), flip to **B** and let Supabase auto-map Vercel previews to the matching Supabase preview branch. Just know you’ll be managing more keys/branches and watching for schema drift between preview branches. citeturn0search16

TL;DR: Your current plan (dev for features, staging on `preview`, prod on `main`) plays perfectly with Supabase Branching by **only branching Supabase for `preview` and `main`**, and leaving PRs on the **dev** DB.


{'asset_pointer': 'file-service://file-Dd3LPCQ5xr4tjPFEVVsY8w', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 680, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 220605, 'width': 664}
How to setup up the dev one


Mr. White — here’s the clean way to stand up **DEV** with Supabase Branching and keep your “features → dev DB, preview → staging, main → prod” flow.

## Goal
- One **persistent Supabase branch** = `dev` (shared by all feature PRs).
- **No prod/staging keys** on PR previews.
- Staging stays the `preview` branch. Prod is `main`.

## Do this

### 1) Supabase
1) **Create a preview branch**  
   - Name: **`dev`**  
   - **Sync with Git branch:** **`dev`** (create this empty branch in GitHub if you don’t have it).  
   - Leave “merge to production” off. PITR optional.

2) Grab the **`dev` branch** creds (URL/anon, and a service key for CI-only tasks).

### 2) Vercel envs
- **Production target** (used by `main`): prod URL/anon (+ service role if CI migrates prod).
- **Preview target (default)**: **set DEV keys** (URL/anon).  
  → This covers **all feature branches & PR previews** automatically.
- **Preview target (branch filter = `preview`)**: **set STAGING keys** (URL/anon, service role if you migrate here).  
  → Overrides default Preview only on the `preview` branch.

Result:
- `main` → prod DB  
- `preview` → staging DB  
- any `feature/*` → **dev DB**

### 3) Migrations (so features can evolve the DEV schema)
Use Supabase CLI in CI to apply **local migrations from the PR** to the remote **`dev`** branch (so you don’t have to merge into the Git `dev` branch first):

```yaml
# in your PR preview workflow
- name: Install Supabase CLI
  run: npm i -g supabase@latest

- name: Push migrations to DEV branch
  env:
    SUPABASE_ACCESS_TOKEN: ${{ secrets.SUPABASE_ACCESS_TOKEN }}
  run: |
    supabase link --project-ref <YOUR_PROJECT_REF>
    supabase db push --remote-branch dev
```

Notes:
- `supabase db push --remote-branch dev` applies the **migrations in the current PR** to the **Supabase `dev` branch**.  
- Keep **service-role** for DEV in **GitHub Actions secrets only**, not in Vercel default Preview env.

### 4) Staging & Prod migrations
- On **push to `preview`**: run migrations against **Supabase `preview`** branch.  
- On **merge to `main`**: backup → run migrations against **Supabase `main`** (guarded by a flag).

### 5) Defaults people work from
- Default GitHub branch = **`preview`** (your single gate).  
- Dev-only Git branch **`dev`** exists purely to satisfy Supabase’s “Sync with Git branch” requirement; you don’t deploy it.

---

### Sanity checklist
- [ ] Supabase `dev` branch created and mapped to Git `dev`.  
- [ ] Vercel **default Preview** = DEV keys; **branch-scoped Preview (preview)** = STAGING keys; **Production** = PROD keys.  
- [ ] PR CI pushes PR migrations → Supabase **dev**.  
- [ ] `preview` pushes migrate **staging**; `main` merges migrate **prod** (with backup).

This gives every PR a live DB to test against (DEV), while keeping staging/production totally walled.


{'asset_pointer': 'file-service://file-XnNaLQnmY6u1s29iQpDn8n', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 751, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 374847, 'width': 1322}
{'asset_pointer': 'file-service://file-MeJbyFdT9aX3k7GkdmN8hm', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 894, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 619497, 'width': 1450}
{'asset_pointer': 'file-service://file-YJ6vZrARwHN7LBf9SMckdg', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 784, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 445828, 'width': 1393}
supabase is providing me the publishable key for preview and main but the anon for dev. it does not give me an anon key for main or preview


Got it — what you’re seeing is **Supabase’s key migration**.  

### What’s happening
- Supabase is **deprecating `anon` and `service_role` keys**.  
- They are being replaced with:
  - **`publishable` keys** (safe for client/browser use; same role as the old `anon`).  
  - **`secret` keys** (server-only; same role as the old `service_role`).  
- That’s why your **dev branch still shows `anon`** (hasn’t been migrated yet), but **preview and main show `publishable`**.  
- Both are functionally equivalent; they’re just rolling out the naming change across branches/projects (full cutover coming 2025, as noted in the banner in your screenshots).

### What you should do
1. **Treat `publishable` as the new `anon`:**  
   - Set it in your Vercel env as `NEXT_PUBLIC_SUPABASE_ANON_KEY` (or rename to `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` if you want to be explicit).  
   - Use only in frontend/browser code.
2. **Get the `secret` key** (replacement for service role):  
   - In Supabase → Project settings → API → you’ll see a `secret` key.  
   - Use it only in server code / CI migrations, never in Vercel’s client-side Preview/Production envs.
3. **Unify naming in your app:**  
   - Update your Next.js config so your `supabase-js` client pulls:
     ```ts
     const supabase = createClient(
       process.env.NEXT_PUBLIC_SUPABASE_URL!,
       process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY! // or PUBLISHABLE_KEY
     )
     ```
   - Behind the scenes, both `anon` and `publishable` work the same today.
4. **Plan ahead:**  
   - By 2025, Supabase will **only issue `publishable` + `secret`**.  
   - Migrate your code and env vars to use those names now to avoid churn later.

### How this affects your 3-tier setup
- **Feature branches (default Preview):** use the **DEV `publishable/anon` key** only.  
- **Preview branch:** scoped Preview env in Vercel → **STAGING publishable key**.  
- **Main:** Production env in Vercel → **PROD publishable key**.  
- **Secrets (`secret` keys):** only in CI or Vercel server env, never exposed to client.

---

⚡ TL;DR:  
Supabase is renaming keys. Use **publishable = anon**, **secret = service role**. Keep feature PRs on DEV publishable, `preview` on STAGING publishable, `main` on PROD publishable. Use `secret` keys only server-side/CI.  

Do you want me to give you the **exact variable naming convention** I’d recommend for your Vercel envs so you’re future-proof and won’t have to touch this again when Supabase fully flips?


Now clerk only gives us a development and product environments. How should we set those for this new setup?


Mr. White — Clerk only has **Development** and **Production** per *instance*. For our 3-tier app (dev PRs → preview gate → prod), the clean way is to use **multiple Clerk instances**:

## Mapping (recommended)
- **Prod app (jov.ie, branch `main`)** → **Clerk PROD instance (Production keys)**
  - `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` = prod instance **Production** publishable
  - `CLERK_SECRET_KEY` = prod instance **Production** secret
  - Allowed origins/redirects: `https://jov.ie`, `https://www.jov.ie`

- **Staging app (preview.jov.ie, branch `preview`)** → **Clerk STAGING instance (Production keys)**
  - Use **Production** keys here too (non-localhost requires Production)
  - Allowed origins/redirects: `https://preview.jov.ie`

- **Dev PR previews (feature/* on Vercel)** → **Clerk DEV instance (Production keys)**
  - Use **Production** keys so they work on Vercel preview URLs
  - Allowed origins/redirects (wildcards):  
    `https://*.vercel.app` (or the safer pattern for your project previews, e.g. `https://*-jovie.vercel.app`)
  - Optionally restrict sign-ups (invite-only, email domain allowlist) to keep bots out

- **Localhost** → **Clerk DEV instance (Development keys)**
  - `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` = DEV instance **Development** publishable
  - `CLERK_SECRET_KEY` = DEV instance **Development** secret
  - Allowed origins: `http://localhost:3000`

## Vercel env setup
- **Production target (main)** → prod instance Production keys.
- **Preview target (branch filter = `preview`)** → staging instance Production keys.
- **Preview target (default)** → dev instance Production keys (covers all feature/* PRs).

Env var names (consistent across all):
```
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=...
CLERK_SECRET_KEY=...
CLERK_JWT_KEY=...        # if you use it
CLERK_WEBHOOK_SECRET=... # per instance if you use webhooks
```

## Why not use Clerk “Development” on Vercel?
Clerk’s **Development** keys are intended for localhost; they won’t work on Vercel previews. That’s why each non-localhost tier needs **Production** keys from its own instance.

## If you want fewer instances (OK but shared users)
Use **one Production instance** for both `preview.jov.ie` and `jov.ie` (add both origins), and use a second instance for dev PRs. Downside: staging shares the prod user pool. If you do this, lock staging sign-ups to staff emails.

## Small checklist
1) Create/rename Clerk instances: **Jovie Prod**, **Jovie Staging**, **Jovie Dev**.  
2) For each, add Allowed Origins/Redirect URLs (prod, preview, wildcard previews, localhost).  
3) Put keys into Vercel as above (Production/branch-scoped Preview/default Preview).  
4) If you use OAuth, configure providers on **each instance**.  
5) If you use webhooks, set separate endpoints/secrets per instance.

This keeps users and sessions isolated per tier, PRs always work, and prod stays untouchable.


It appears that we can't use clerk across multiple domains without satellite domains which costs more money. Clerk Allowed Origins can't be set for our preview.jov.ie domain. So what do we do


**Topic:** [[chatgpt-clusters/coding_devops]]
