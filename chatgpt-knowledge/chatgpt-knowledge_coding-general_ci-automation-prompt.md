---
title: "CI automation prompt"
type: essay
created: 2025-08-05
updated: 2025-08-05
source: chatgpt-export
topic: coding-general
message_count: 30
tags: [chatgpt, knowledge, coding-general]
---
# CI automation prompt

> **Source:** ChatGPT conversation
> **Date:** 2025-08-05T19:00:52Z
> **Messages:** 30
> **Topic:** coding-general

## Question

We need to get the jovie project to pass through our whole ci and go live on production. I need a prompt to make our AI iterate through all errors and fix and keep checking ci til it passes everything opens a pr for preview, auto merges, passes all checks, and opens a pr for production. i need it to only stop when i have a green lit pr open for production.

## Answer

**Copy-paste Prompt for your AI agent**

```
You are “Jovie-CI Autopilot,” an autonomous coding agent with push access to https://github.com/itstimwhite/Jovie.

MISSION
  ▸ Deliver a fully green CI pipeline all the way to production.
  ▸ Finish only when a PR from branch main → production is OPEN **and** every required check is passing (green).

CONSTRAINTS
  • Use existing GitHub Actions, Vercel, Supabase migrations, Danger.js, CommitLint, Lighthouse, and security scans.
  • Keep branch flow: feature ➜ develop ➜ preview ➜ main.
  • Required status checks must be green on every gating branch (update branch-protections as needed).
  • Fast-fail: if CI fails, analyse the logs, patch the code/config, commit, and push; repeat until green.
  • Preserve current app behaviour; refactors OK but no regressions (run unit/integration/e2e tests + manual smoke via Vercel Preview URL).
  • All code changes must be in conventional-commit format.
  • PR titles:  
      develop→preview  →  “chore: promote develop → preview”  
      preview→main     →  “chore: promote preview → main (production)”
  • Auto-merge permitted only when **all** checks succeed.

LOOP
  1. Checkout branch **develop**; run `npm ci && npm run lint && npm test && vercel build`.
  2. On failure → fix, commit, push, and restart step 1.
  3. When develop is green → open / update PR develop → preview; label `automerge`.
  4. Wait for PR checks; if red → repair on develop, push, let CI re-run; go to step 1.
  5. When PR is green → allow automerge; branch **preview** is now current.
  6. Run full CI on preview (same scripts plus Lighthouse & security scans).  
     • On failure → patch on preview, push, repeat step 6.
  7. When preview is green → open PR preview → **main** (production); do **NOT** automerge—just ensure all checks are green.
  8. Terminate only when that PR is open and every required check is ✅.

OUTPUT
  • After each CI cycle, post a brief comment summarising fixes and remaining blockers.
  • On completion, post: “🎉 Production ready — PR #<num> is green.”

BEGIN.
```

Run this prompt in your preferred agent (e.g., Cloud Code, ChatGPT-based CLI, or your internal DevOps bot) and let it iterate until the production PR is green-lit.

## Question

Adopt this based on how our actual ci works. Main IS our production branch

## Answer

**Mr. White, here’s a drop-in prompt wired to your actual GitHub Actions flow (develop → preview → main). Copy-paste into whatever agent you’re using.**

```
You are “Jovie-CI Autopilot” with push access to github.com/itstimwhite/Jovie.

OBJECTIVE
  • Ship a fully green CI pipeline through **develop ➜ preview ➜ main (production)**.
  • Stop ONLY when a PR preview → main is open, every required check is ✅, and the PR auto-merges (or is ready to merge if branch protection blocks it).

PIPELINE MAP
  • develop push ⇢ runs `Develop CI/CD Pipeline` (build, lint, tests, Vercel preview, Lighthouse, audit-ci).【2:16†file-8ciWUDM2ZmCKntWqbq18cs†L1-L12】【2:12†file-8ciWUDM2ZmCKntWqbq18cs†L40-L50】
  • On success, workflow auto-opens PR **develop → preview** and enables auto-merge.【2:8†file-8ciWUDM2ZmCKntWqbq18cs†L22-L30】
  • preview push ⇢ runs `Preview CI/CD Pipeline` (build, E2E across 3 browsers, Lighthouse multi-page, bundle size, ZAP DAST).【2:14†file-4CPesaCHx1NpqyS3uYgzKS†L1-L14】
  • On success, workflow auto-opens PR **preview → main** with auto-merge enabled.【2:1†file-4CPesaCHx1NpqyS3uYgzKS†L100-L108】
  • main push ⇢ triggers `Production Deploy` (Vercel prod, health-check, smoke tests).【2:0†file-V7dXY36m3t58e9b48eBqgD†L3-L7】【2:0†file-V7dXY36m3t58e9b48eBqgD†L57-L64】

CONSTRAINTS
  • Maintain commit style (`conventional-commits`) so `commitlint` passes.  
  • Fix anything that breaks `pr-verify`, CodeQL, audit-ci, Playwright, Lighthouse, or ZAP.  
  • Never disable or skip checks; make code/config right instead.  
  • Preserve app behaviour; add tests if needed to lock fixes.  
  • Use `npm ci`, Node 20.17, and Vercel CLI just like the workflows.  
  • Keep looping until **GitHub shows a green PR preview → main OR main already updated and `Production Deploy` is green**.

LOOP
  1. Checkout **develop**, run `npm ci && npm run typecheck && npm run lint && npm test:ci && npm run build`.
  2. If any step fails, patch, `conventional-commit`, push to develop, goto 1.
  3. Wait for GitHub Action *Develop CI/CD Pipeline* to finish; on red, goto 1.
  4. After it turns green, monitor PR **develop → preview**; if it fails CI, fix on develop, goto 1.
  5. When **preview** updates, wait for *Preview CI/CD Pipeline*; on red, hot-fix on preview (or cherry-pick to develop), push, goto 4.
  6. When PR **preview → main** opens, watch checks (E2E, Lighthouse, bundle, ZAP, CodeQL).  
     • On red, patch on preview, push, goto 5.
  7. Exit only when that PR is green-lit and either:
       – auto-merged into main, **or**  
       – waiting on manual review with all checks passing.

COMMUNICATION
  • After each push, comment on the relevant PR with:
      – Summary of root cause & fix.  
      – Next blocker, if any.  
  • On completion, comment: “🎉 All green – production ready.”

BEGIN.
```

This mirrors the exact branch triggers and promotion steps already defined in your YAML, so the agent will align with your real CI instead of a generic flow.

## Question

Improve this prompt:
look at our code and map out what our basic MVP looks like and what is currently working vs broken. lay out exactly what tasks need to be completed in order for us to have a funactional and stable mvp to submit to ycombinator. break evey task into a very small and specific job.

## Answer

**Sharpened “MVP-Audit” Prompt**

```
You are “Jovie-MVP Auditor,” a senior full-stack engineer with deep Vue 3 / Nuxt 3, Tailwind, and Vercel experience and full read access to github.com/itstimwhite/Jovie.

MISSION
  1. **Map the current MVP** – list every feature, API route, page, component, script, and workflow that exists in the repo.
  2. **Status check** – for each item, mark it as:
       ✅ working (passes tests + manual smoke)  
       ⚠️ partially working (edge cases, missing tests)  
       ❌ broken / unfinished.
  3. **Backlog** – generate a strictly ordered to-do list that will bring the project to a stable, YC-ready MVP.
       • Break work into **atomic, dev-day sized tasks** (2–4 h each).  
       • Each task must include: short title, file(s) touched, acceptance criteria, and blocking dependencies.

CONSTRAINTS
  • Do **NOT** rewrite code; you’re only auditing and planning.  
  • Use local commands exactly as CI does: `npm ci && npm run typecheck && npm run lint && npm test && npm run dev`.  
  • Treat `main` as production, `preview` as staging, `develop` as integration.  
  • Ignore future “nice-to-have” features; focus solely on what’s essential for an MVP smart-link platform (link creation, redirect logic, basic analytics, responsive UI, and signup flow).

OUTPUT (Markdown)
```
# MVP Feature Map
| Area | Item | Path | Status | Notes |

# Critical Issues (❌ / ⚠️)
1. **Title** – one-sentence description  
   *Root cause:* …  
   *Evidence:* log excerpt / test failure

# Backlog – YC MVP
| # | Task Title | Files / Folders | Depends On | Acceptance Criteria |

*Stop.* Return the completed document and nothing else.

## Question

Our stack is next.js 15, tailwind 4, vercel, supabase with clerk intergration, 

## Answer

**Refined “MVP-Audit” Prompt (tuned to your stack)**  

```
You are “Jovie-MVP Auditor,” a senior engineer fluent in
  • Next.js 15 / React 19
  • Tailwind CSS v4
  • Supabase (Postgres + Edge Functions)
  • Clerk auth
  • Vercel CI/CD

SCOPE
  1. **Feature Map** – enumerate every route, API handler, component, Supabase table/function, and CI workflow in the repo.
  2. **Health Check** – mark each item:
       ✅ working ⚠️ partial ❌ broken / missing
  3. **Backlog** – produce an *ordered* list of dev-day–sized tasks (≈2-4 h each) that will turn the codebase into a stable, YC-ready MVP.

WORKING RULES
  • Use the exact commands our CI runs:

        npm ci
        npx prisma format            # if Prisma is present
        npm run lint
        npm run test:ci              # Vitest / Playwright
        npm run build                # next build
        npx supabase db reset --schema public --seed
        npx supabase functions serve
        vercel --prod --prebuilt

  • Treat branches as:
        develop  → integration
        preview  → staging
        main     → production
  • Ignore future “nice-to-haves”; stick to MVP essentials:
        — smart-link creation & redirect
        — sign-up / login (Clerk)
        — Supabase row-level security & API auth
        — basic analytics (click count, referrer)
        — responsive UI
        — CI green on develop / preview / main

OUTPUT (Markdown)

# MVP Feature Map
| Area | Item | Path | Status | Notes |

# Critical Issues (⚠️ / ❌)
1. **Title** – one-sentence summary  
   *Root cause:* …  
   *Evidence:* stack trace / failing test snippet

# Backlog – YC-Ready MVP
| # | Task (≤ 50 chars) | Files / Folders | Depends On | Acceptance Criteria |

*Stop when the above document is complete. Produce nothing else.*
```

## Question

Give me a prompt for create a cookie banner. It should be world class ux. It should only appear where legally required to appear.

## Answer

**Copy-paste Prompt — “Build-Once, Comply-Everywhere Cookie Banner”**

```
You are “Cookie-Guardian,” a senior Next.js 15 engineer.  
Goal: ship a world-class, legally-compliant cookie banner for the Jovie app.

STACK
  • Next.js 15, React 19  (app router, server components)
  • Tailwind CSS v4 for styling
  • Vercel Edge Middleware
  • Supabase + Clerk (auth)

LEGAL SCOPE
  • Show banner ONLY for visitors whose IP is in jurisdictions that *require* opt-in/opt-out consent:
        – EU / EEA / UK  (GDPR + ePrivacy)
        – California      (CPRA / “Do Not Sell or Share”)
        – Colorado / Virginia / Connecticut / Utah (state privacy acts)
        – Quebec (Law 25)
  • Hide banner everywhere else.

UX REQUIREMENTS
  1. **First paint < 100 ms add’l cost** – no layout shift.
  2. **Tiny footprint** – banner height ≤ 80 px on mobile, non-blocking; fades after consent.
  3. **Choices**:  [Accept All]  [Reject Non-Essential]  [Customize]  
     • “Customize” opens modal with granular toggles (Essential, Analytics, Marketing).  
     • Default = only Essential enabled.
  4. **Accessibility** – WCAG 2.2 AA: focus trap, Escape key, ARIA labels, dark-mode.
  5. **Locales** – auto-translate using browser `navigator.language` (en, fr, de, es at minimum).
  6. **Persist consent** – signed, HTTP-only cookie `jv_cc=<json>` (365 d TTL). Respect DNT header.

TECH SPECS
  • Edge Middleware `middleware.ts` detects country via `request.geo.country`.  
    – If country in `REQUIRES_CONSENT`, inject `x-show-cookie-banner: 1` header; else skip.  
  • Banner rendered client-side **only** when header present.  
  • Use React Context + `useEffect` to block loading of non-essential scripts (Google Analytics, TikTok, etc.) until consent.
  • Provide `window.JVConsent` helper with `onChange(callback)` for other scripts.
  • Unit tests with Jest + React Testing Library; e2e with Playwright covering EU vs US paths.
  • Lint, type-safe (TS strict), 100 % Lighthouse Best-Practices.

DELIVERABLES
  1. `/components/CookieBanner.tsx` + `/components/CookieModal.tsx`
  2. `/lib/cookies/consent.ts`
  3. `middleware.ts`
  4. Docs: `docs/cookie-consent.md` – setup, APIs, legal references.
  5. GitHub Action step adding `COUNTRY=` matrix to Playwright tests.

Complete when:
  • Banner shows in GDPR/CPRA regions, hidden elsewhere.
  • All automated tests and CI checks are green.
  • Lighthouse score ≥ 95 on mobile and desktop.
```

## Question

If i use branching in supabase with the GitHub integration, do i need to add the supabase variables to my GitHub environment secrets?

## Answer

Yes.  
Supabase’s GitHub-integration Action still calls the CLI under your repo’s CI, so it needs the same secrets it would need if you ran the CLI locally. Add them once (repo or environment level) and every branch-specific run will reuse them:

| Secret | Why it’s needed |
| --- | --- |
| `SUPABASE_ACCESS_TOKEN` | Authenticates the Action to your Supabase org. |
| `SUPABASE_PROJECT_REF` | Tells the CLI which project to branch. |
| `SUPABASE_DB_PASSWORD` (optional, only if you run `db push` or tests) | Lets the CLI connect to the branch’s database. |

You don’t have to duplicate the secrets for every Git branch—one copy at the repo (or a “Production” / “Preview” environment) is enough, and the Branching workflow will create/tear down the database branches automatically.

## Question

how many supabase branches should i have and how should I set them up vs our repo?

## Answer

**Mr. White, keep it simple: mirror the three long-lived Git branches you actually deploy, and spin up throwaway database branches only when tests need one.**

| Git branch | Supabase branch | Purpose | Lifetime |
|------------|----------------|---------|----------|
| `main`     | `prod` (default project) | Real customers / prod data | Permanent |
| `preview`  | `staging`      | Final acceptance before prod | Permanent |
| `develop`  | `dev`          | Daily integration, teammates share | Permanent |
| any feature / PR | `tmp-<sha>` | Isolated migrations / seed data for CI | Ephemeral (auto-delete after CI) |

### Why this layout works
1. **One-to-one mental model** – no guessing which DB maps to which site.  
2. **Cost-controlled** – only three always-on branches; tmp DBs exist for ~15 min during CI, then the CLI deletes them.  
3. **Safe migrations** – every branch runs `supabase db push` against its own database so bad SQL never reaches prod.  
4. **Realistic testing** – `preview` hits the same Postgres version/extensions as prod, so surprises surface before release.

### Set-up checklist
1. **Create branches once**  
   ```bash
   supabase branch create dev
   supabase branch create staging
   # prod is the default project DB
   ```
2. **Add secrets _once_ at repo level**  
   `SUPABASE_ACCESS_TOKEN`, `SUPABASE_PROJECT_REF`, `SUPABASE_DB_PASSWORD`.
3. **CI mapping**  
   ```yaml
   env:
     BRANCH_NAME: ${{ github.ref_name }}
   steps:
     - name: Pick Supabase branch
       run: |
         if [[ "$BRANCH_NAME" == "main" ]];   then SB_BRANCH=prod;
         elif [[ "$BRANCH_NAME" == "preview" ]]; then SB_BRANCH=staging;
         elif [[ "$BRANCH_NAME" == "develop" ]]; then SB_BRANCH=dev;
         else SB_BRANCH="tmp-${BRANCH_NAME:0:7}";
              supabase branch create "$SB_BRANCH";
         fi
         echo "SB_BRANCH=$SB_BRANCH" >> $GITHUB_ENV
     - run: supabase db push --branch $SB_BRANCH
     # … run tests …
     - name: Clean up tmp branch
       if: startsWith(env.SB_BRANCH, 'tmp-')
       run: supabase branch delete "$SB_BRANCH" --yes
   ```
4. **Local dev**  
   ```bash
   supabase branch switch dev
   npm run dev
   ```
5. **Promotion flow**  
   *Merge develop → preview* → run migration on `staging`.  
   *Merge preview → main* → run migration on `prod`.

That’s it: three permanent Supabase branches to match your deploy targets, plus disposable ones for every feature PR.

## Question

https://github.com/orgs/supabase/discussions/29260



## Answer

**Mr. White — key take-aways from Supabase discussion #29260**

| What’s changing | Why it matters to you |
| --- | --- |
| **Anon / service JWT keys are being replaced by simple string keys** (`sb_pub_…` + `sb_secret_…`). They’re rotated, revocable, and no longer double as JWTs. citeturn4search0 | Your app and CI will need **two env vars** instead of one (`SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY`). |
| **Timeline:** early preview → June 2025, full launch → July 2025, monthly nags start → Nov 2025. citeturn4search1 | You can migrate now in dev/staging, switch prod before the November reminders. |
| **JWT signing moves to RS256** from Oct 1 2025 for new projects (opt-in for existing). citeturn8search2 | If you mint custom tokens you’ll need the new public key endpoint; otherwise `@supabase/supabase-js` handles it. |

---

### How this affects your branch / secret layout

You **don’t** need extra Supabase database branches; just update the secrets on the three you already run:

| Git branch | Supabase DB | Old secret | New secrets |
| --- | --- | --- | --- |
| `main` (prod) | `prod` | `SUPABASE_SERVICE_ROLE_KEY` | `SUPABASE_PUBLISHABLE_KEY_PROD`  <br>`SUPABASE_SECRET_KEY_PROD` |
| `preview` | `staging` | same | `SUPABASE_PUBLISHABLE_KEY_STG`  <br>`SUPABASE_SECRET_KEY_STG` |
| `develop` | `dev` | same | `SUPABASE_PUBLISHABLE_KEY_DEV`  <br>`SUPABASE_SECRET_KEY_DEV` |

**CI / GitHub Actions**
```yaml
env:
  SUPABASE_ACCESS_TOKEN: ${{ secrets.SUPABASE_ACCESS_TOKEN }}
  SUPABASE_PROJECT_REF:  ${{ secrets.SUPABASE_PROJECT_REF }}
  SUPABASE_SECRET_KEY:   ${{ secrets[ format('SUPABASE_SECRET_KEY_{0}', env.ENV) ] }}
  SUPABASE_PUB_KEY:      ${{ secrets[ format('SUPABASE_PUBLISHABLE_KEY_{0}', env.ENV) ] }}
```
The CLI still needs `SUPABASE_ACCESS_TOKEN` + `SUPABASE_PROJECT_REF`; the new keys just replace the old `SERVICE_ROLE_KEY`/`ANON_KEY`.

---

### Migration game-plan (keep it lean)

1. **Generate new keys** for the project in the dashboard (Settings → API Keys).  
2. **Add them** to GitHub repo/Env secrets and Vercel environment variables as above.  
3. **Upgrade** to `@supabase/supabase-js >= 2.45.0` (first version that reads the new header automatically).  
4. **Patch config** (`createClient(url, pubKey, { auth: { persistSession: … } })`).  
5. **Smoke-test** in `develop` ➔ promote to `preview` ➔ cut over `main`.  
6. **Delete legacy keys** once prod is green.  
7. **Set a rotation reminder** (Supabase will start nagging in Nov 2025).

Stick to the three permanent DB branches (`dev`, `staging`, `prod`) plus the throwaway test branches your CI already creates; nothing in #29260 changes that strategy.

## Question

Give me the env file for this

## Answer

**Minimal env templates (copy-paste & fill the values)**

---

### `.env.development`  (local `develop` branch → Supabase **dev** branch)
```bash
# ─── Supabase ────────────────────────────────────────────────
NEXT_PUBLIC_SUPABASE_URL=https://<project-ref>.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_pub_dev_********************************
SUPABASE_SECRET_KEY=sb_secret_dev_********************************
SUPABASE_PROJECT_REF=<project-ref>
SUPABASE_ACCESS_TOKEN=<personal-access-token>      # CLI / CI only
SUPABASE_DB_PASSWORD=<dev-db-password>             # needed if you run tests

# ─── Clerk ──────────────────────────────────────────────────
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_********************************
CLERK_SECRET_KEY=sk_test_********************************

# ─── App ────────────────────────────────────────────────────
NEXT_PUBLIC_APP_ENV=development
```

### `.env.preview`  (`preview` branch → Supabase **staging** branch)
```bash
NEXT_PUBLIC_SUPABASE_URL=https://<project-ref>.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_pub_stg_********************************
SUPABASE_SECRET_KEY=sb_secret_stg_********************************
SUPABASE_PROJECT_REF=<project-ref>
SUPABASE_ACCESS_TOKEN=<personal-access-token>
SUPABASE_DB_PASSWORD=<staging-db-password>

NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_live_********************************
CLERK_SECRET_KEY=sk_live_********************************

NEXT_PUBLIC_APP_ENV=staging
```

### `.env.production`  (`main` branch → Supabase **prod** branch)
```bash
NEXT_PUBLIC_SUPABASE_URL=https://<project-ref>.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_pub_prod_********************************
SUPABASE_SECRET_KEY=sb_secret_prod_********************************
SUPABASE_PROJECT_REF=<project-ref>
SUPABASE_ACCESS_TOKEN=<personal-access-token>
SUPABASE_DB_PASSWORD=<prod-db-password>

NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_live_********************************
CLERK_SECRET_KEY=sk_live_********************************

NEXT_PUBLIC_APP_ENV=production
```

**Usage notes**

1. **CI / GitHub Actions** – load the matching file via environment secrets or `dotenv-linter`; the keys map 1-to-1 with the ones you set in GitHub/Vercel.
2. **Next.js 15** automatically exposes vars prefixed with `NEXT_PUBLIC_` to the client; everything else stays server-only.
3. Rotate the `sb_secret_*` keys periodically (Supabase dashboard → **API Keys**).

## Question

our we setting this once at the repo level or env level

## Answer

**Do both.**

| Secret | Where to store | Why |
| --- | --- | --- |
| **One-copy repo-level**<br>`SUPABASE_ACCESS_TOKEN`<br>`SUPABASE_PROJECT_REF` | **Repository → Secrets → Actions** | Identical for every deploy; CI just needs one copy. |
| **Per-env (dev / staging / prod)**<br>`SUPABASE_PUBLISHABLE_KEY_*`<br>`SUPABASE_SECRET_KEY_*`<br>`SUPABASE_DB_PASSWORD_*`<br>`CLERK_*` | **Repository → Environments**<br>create `development`, `staging`, `production` | Keys differ by database / auth tenant; GitHub Environments let you scope them to the matching branch and add manual approvals if you want. |

**How CI picks them up**

```yaml
jobs:
  build:
    environment: ${{ github.ref_name == 'main' && 'production' ||
                     github.ref_name == 'preview' && 'staging'  ||
                     'development' }}
    env:
      SUPABASE_PROJECT_REF: ${{ secrets.SUPABASE_PROJECT_REF }}
      SUPABASE_ACCESS_TOKEN: ${{ secrets.SUPABASE_ACCESS_TOKEN }}
      SUPABASE_SECRET_KEY:   ${{ secrets.SUPABASE_SECRET_KEY }}
      SUPABASE_PUB_KEY:      ${{ secrets.SUPABASE_PUBLISHABLE_KEY }}
      SUPABASE_DB_PASSWORD:  ${{ secrets.SUPABASE_DB_PASSWORD }}
      CLERK_SECRET_KEY:      ${{ secrets.CLERK_SECRET_KEY }}
```

*Bottom line:*  
- Store the **shared tokens** once at repo level.  
- Store **anything that changes per environment** inside GitHub Environments and let the workflow select the right environment based on the branch.

## Question

What will be shared for supabase?

## Answer

Only the **two project-wide tokens** that never change from branch to branch:

| Secret | Purpose | Scope |
| --- | --- | --- |
| `SUPABASE_ACCESS_TOKEN` | Personal PAT that lets the CLI / GitHub Action talk to the Supabase Management API (create branches, run migrations, delete branches). | **Repo-level** (one copy is enough). |
| `SUPABASE_PROJECT_REF` | The permanent  `xxxxx`  project ID that precedes every branch URL (`https://<branch>.<project-ref>.supabase.co`). | **Repo-level**. |

Everything else—publishable key, secret key, database password, branch-specific API URL—*belongs in the matching GitHub **Environment*** (`development`, `staging`, `production`, or the ephemeral CI branch), because each Supabase branch gets its **own** set of credentials and connection strings.  citeturn0search1

## Question

Give me a prompt to refactor our header. utilize atomic design best practices. Be sure to follow our claude.md guidelines and not break anything. Be sure to organize and clean up files and code. Be sure to respect clerk and next common problems related to server and client code to avoid breaking things.

## Answer

**Copy-paste Prompt — “Header Refactor (Atomic Design + Next 15 + Clerk)”**

```
You are “Jovie-UI Refactor Bot,” a senior Front-End engineer.

GOAL  
Refactor the site header into an **Atomic-Design** component set while staying 100 % backward-compatible and compliant with `/docs/claude.md`.

STACK  
• Next.js 15 (app router, React 19)  
• Tailwind CSS v4 (using @apply + utility classes)  
• Clerk auth (SSR + client helpers)  
• Typescript strict, ESLint/Prettier enforced

DELIVERABLES  
1. **Atoms**  
   └ `/components/atoms/Logo.tsx` – stateless SVG logo  
   └ `/components/atoms/NavLink.tsx` – `<Link>` with active-state logic  
   └ `/components/atoms/UserAvatar.tsx` – wraps `UserButton` (Clerk)  
2. **Molecules**  
   └ `/components/molecules/NavMenu.tsx` – flex row of `NavLink`  
3. **Organisms**  
   └ `/components/organisms/SiteHeader.tsx` – responsive header bar  
4. **Stories / Tests**  
   • Storybook stories for each component (if Storybook installed)  
   • Jest + RTL tests (render, active link, auth flow)  
5. **Layout wire-up**  
   • Replace legacy header import in `/app/(site)/layout.tsx` with `SiteHeader`.

CONSTRAINTS  
• **Do not** change any public route, prop, or class name used by existing pages.  
• Props must remain tree-shakable & typed (`export type NavLinkProps …`).  
• Keep Clerk logic client-only; mark `UserAvatar` with `"use client"`.  
• No server component may directly import Clerk’s client SDK.  
• Headless UI / @radix may be used, but keep bundle size flat.  
• Follow claude.md code-style & commit message rules (conventional-commits).  
• Run: `npm ci && npm run lint && npm test && npm run build` – all green.  
• Update/clean file names, delete unused styles, fix any ESLint warns.  
• Touch only header-related files unless a build fails.

WORKFLOW  
1. Grep repo for old header usage; map props & CSS.  
2. Scaffold atoms → molecules → organism (Atomic sequence).  
3. Migrate Tailwind classes; move any global CSS into `@layer components`.  
4. Write unit tests; adjust failing snapshots.  
5. Swap header in layout; run full CI; repair any Clerk SSR warnings.  
6. Commit as `refactor(header): migrate to atomic design`.

Stop when: **Site builds + e2e smoke passes, header visually identical, codebase cleaner, and PR is ready to merge.**
```

## Question

Do an internet search for the latest docs and clerk and next to make sure our prompt reflects them. Also were using the latest supabase and clerk integration with it set as a 3rd party auth provider.

## Answer

**Updated AI prompt — aligned with the _latest_ Clerk × Next-.js 15 + Supabase 3-party-auth docs**

```
You are “Jovie-UI Refactor Bot,” a senior front-end engineer.

OBJECTIVE  
Refactor the site header into **Atomic-Design** layers while keeping 100 % compatibility and following `/docs/claude.md`.

TECH STACK  
• Next.js 15 (App Router, React 19)  
• Tailwind 4  
• Clerk SDK @latest (v4) – App Router helpers `auth()` / `currentUser()` on the server, hooks on the client【turn4search4】【turn4search0】  
• Supabase JS v3 with Clerk 3-party auth (`accessToken: async () => session?.getToken()`)【turn5view0】  
• Vercel CI

DELIVERABLE TREE  
```
src/
 └─ components/
     ├─ atoms/
     │   ├── Logo.tsx              # stateless SVG
     │   ├── NavLink.tsx           # typed `<Link>`
     │   └── UserAvatar.client.tsx # `"use client"` – wraps <UserButton />
     ├─ molecules/
     │   └── NavMenu.tsx           # flex row of NavLink
     └─ organisms/
         └── SiteHeader.tsx        # responsive bar
 tests/
   └── header.spec.tsx            # RTL + Jest
 stories/ (optional)
 docs/
   └── header-refactor.md
```

RULES & GOTCHAS  
1. **Server vs Client**  
   • Server files may call `currentUser()` or `auth()`; never import `useUser()` there.  
   • All Clerk hooks/components (`SignedIn`, `UserButton`, etc.) live only in `.client.tsx` files.  
2. **Supabase client**  
   ```ts
   const { session } = useSession();           // client
   const supabase = createClient(
     env.NEXT_PUBLIC_SUPABASE_URL,
     env.NEXT_PUBLIC_SUPABASE_PUB_KEY,
     { accessToken: async () => session?.getToken() ?? null } // Clerk 3-party auth
   );
   ```  
3. **Atomic design flow**: build Atoms → Molecules → Organism.  
4. Keep existing props / CSS class names so no page breaks.  
5. Tailwind: move legacy CSS into `@layer components` if still needed.  
6. Pass **eslint**, **prettier**, **type-check**, **unit tests**, **next build**, **vercel build**.  
7. Commit style: `refactor(header): migrate to atomic design`.  
8. Only touch header-related files unless CI fails elsewhere.  
9. Follow claude.md naming, import order, comment style.

WORK PLAN  
1. Grep repo for `<header>` and old navbar components; map props.  
2. Scaffold Logo/NavLink/UserAvatar (Atoms).  
3. Assemble NavMenu (Molecule) and SiteHeader (Organism).  
4. Replace import in `/app/(site)/layout.tsx`.  
5. Add tests: logged-in vs logged-out, mobile breakpoint.  
6. Run full CI; fix any Clerk SSR warnings or Supabase token issues.  
7. Ship PR ready to merge.

Stop when **all CI checks are green** and the header looks identical across develop, preview, and main.
```

---

**Key references**

* Clerk server helpers `auth()` & `currentUser()` for App Router – eliminates manual cookie parsing citeturn4search4turn4search0  
* Supabase’s new first-class Clerk 3-party integration – use Clerk session token with `accessToken` option citeturn5view0

## Question

Give me a prompt for our header when sticky, to adapt to the underling content when on a landing page like the homepage. So it goes dark mode when the content is dark and light when the content is light, as you scroll. Have it be dark by default. When on a other pages liek legal pages and such it should just follow the theme setting for either light or dark.

## Answer

**Copy-paste Prompt — “Smart Sticky Header (Adaptive Theme)”**

```
You are “Jovie-Header Adapt-Bot,” a senior front-end engineer.

TASK
Build a **sticky SiteHeader** that:
1. Defaults to **dark theme**.
2. On landing-type pages (`/`, `/pricing`, any route with `metadata.isLanding = true`)
   automatically flips between dark and light as the underlying section’s
   theme changes while scrolling.
3. On all other pages (docs, legal, dashboard, etc.) it obeys the global
   user-selected theme (light / dark) and never auto-switches.

STACK & RULES
• Next.js 15 (App Router)  • Tailwind 4  
• Clerk v4 (auth)          • Supabase JS v3 (3-party auth)  
• Atomic design directory structure (atoms → molecules → organisms)  
• Follow `/docs/claude.md` style & commit guidelines.  
• No server component may import Clerk’s client SDK.  
• Header must remain fully SSR-friendly (no CLS).

DELIVERABLES
```
src/components/organisms/SiteHeader.client.tsx  // `"use client"`
src/hooks/useSectionTheme.ts                    // IntersectionObserver hook
src/context/ThemeContext.tsx                    // provides { theme, setTheme }
src/lib/pageMetadata.ts                         // export const metadata = { isLanding: … }
tests/header-theme.spec.tsx
```

DESIGN SPEC
• Section markup on landing pages includes  
  `<section data-theme="light">` or `data-theme="dark">`.  
  `useSectionTheme()` watches the nearest visible section and returns its
  theme; debounced to 50 ms.  
• `SiteHeader` consumes that hook **only if** `metadata.isLanding` is true;
  otherwise it reads the global theme from `ThemeContext`.  
• Visual change = toggle `class="bg-neutral-900 text-white"` vs
  `bg-white text-neutral-900 shadow-md`. Smooth -200 ms transition.
• Accessibility: maintain 4.5:1 contrast in both modes.
• Persist user theme choice in `localStorage.theme`; auto-reapply on mount.
• Unit tests: landing scroll-swap, non-landing respect user theme.

ACCEPTANCE CRITERIA
1. Scroll on home page swaps header theme precisely when a new
   `data-theme` section tops the viewport.
2. Docs page keeps chosen theme regardless of content.
3. No CLS; Lighthouse Accessibility ≥ 95.  
4. `npm run lint`, `npm test`, `npm run build` all pass.
5. Commit: `feat(header): adaptive sticky header` with changelog entry.

BEGIN.
```

## Question

Break down all the feats of smartlink.it and linkfire and lay out a plan for us to include this in our jov.ie/davidguetta/listen pages, but also update them to have the most magic user experiences and take full advantage of modern tech stacks and capabilities 

## Answer

### 1 / What the incumbents offer  

**Linkfire**  
* Pre-release (pre-save), release, bio, podcast, ticket & reward link types.  
* Auto-scan DSP catalogues, pull artwork/metadata, create QR codes.  
* Deep-links by device + geo, branded domains, A/B link split-tests, affiliate IDs.  
* Pixel injection (Meta, GA, TikTok), full-funnel analytics & Apple Music Insights. citeturn7view0  

**Smartlink.it-style toolset** (via Feature.fm & other smart-link docs)  
* One link that **auto-converts** from pre-save → live on release day.  
* Multi-follow actions, song preview embeds, store-order control.  
* Retargeting pixels, custom social cards, Amazon/Apple affiliate codes. citeturn10view0  

---

### 2 / Gap analysis for `jov.ie/davidguetta/listen`  

| Capability | Present today | Needed to match / beat market |
|------------|---------------|--------------------------------|
| Static landing page | ✔ | **Dynamic** link types (pre-save, ticket, bio) |
| Manual DSP links | ⚠️ copy-paste | **Auto-scan** Spotify/Apple APIs + cron refresh |
| Basic click tally | ⚠️ | **Device + geo analytics**, FB/TikTok/GA pixels |
| No A/B testing | ✘ | Slug-level split routing + Supabase metrics |
| No QR / affiliate | ✘ | QR generator, optional affiliate params |
| Flat theme | ✔ dark | Theme that adapts artwork dominant colours |

---

### 3 / Execution plan (tiny, chainable tasks)

> **Phase 0 – plumbing**

1. **DB: smart-links** — table `links (id, slug, type, artist_id, release_date …)`  
2. **DB: destinations** — `destinations (link_id, service, url, region)`  
3. **DB: clicks** — edge-logged; row ≈ 300 B.  
4. Edge Function `POST /ingest-click` → Supabase.

> **Phase 1 – data automation**

5. **Spotify scan lambda** — fetch `isrc` → platform URLs; store rows.  
6. **Apple Music scan** — same pattern.  
7. **Nightly GitHub workflow** runs both; flags “ready” when all primary DSPs populated.

> **Phase 2 – core UX**

8. **Atom → Organism header** (already scheduled).  
9. **SmartLink page** (`/listen/[slug]/page.tsx`) SSR-first, falls back to CSR.  
10. `useDominantColor` hook → switch Tailwind theme classes runtime.  
11. **Hero artwork component** with blurred fallback for LCP ≤ 2 s.  
12. **CTA grid** auto-orders DSP buttons by user agent (iOS ≻ Android ≻ Web).  
13. **QR modal** (client-only).  
14. **Pre-save logic** — if `type=pre_save && now<release_date` show OAuth buttons, else swap to live DSP list.

> **Phase 3 – analytics & pixels**

15. Cookie-less click log → Supabase Edge; forward hashed IP/device.  
16. Pixel dispatcher — when user accepts cookies, inject FB/TikTok/GA tags with `link_id` param.  
17. Admin UI toggle for remarketing pixels per link.

> **Phase 4 – magic extras**

18. **A/B router** — if link has `variant_b` and `rand<0.5` serve alt page; store split result.  
19. **AI share image** (`/api/og/:slug`) generates OG image via Vercel OG.  
20. **Affiliate helper** — ∆ Amazon/Apple IDs per campaign.  
21. **Short slug engine** — (`/

*(Answer truncated — 4337 chars total)*
