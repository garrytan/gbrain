---
title: "Fixing CI workflow"
type: essay
created: 2025-09-01
updated: 2025-09-01
source: chatgpt-export
topic: coding-general
message_count: 24
tags: [chatgpt, knowledge, coding-general]
---
# Fixing CI workflow

> **Source:** ChatGPT conversation
> **Date:** 2025-09-01T21:23:56Z
> **Messages:** 24
> **Topic:** coding-general

## Question

So working locally with AI, we make some changes, ai opens a feat branch, we then open a pr, fast ci runs, it hits merge queue (after we manually turn on merge when ready) and then we move to preview and start working again. But it takes like 10-20 minutes to run that cycle. In the mean time were off coding more shit pulled off of preview branch. But preview is behind now. By the time preview updates, weve already made another PR. This sometimes causes conflicts but generally makes for me spending more time dealing with ci and prs then actually coding. How to we fix this workflow

## Answer

Mr. White — you’re fighting the wrong bottleneck. Stop waiting on a central **preview branch** for every iteration. Use per-PR previews + a light “green lane” for fast feedback, and reserve the heavy lane for when you actually ship.

# Fix: make the loop <5 min

1) **Per-PR preview is the source of truth for QA**
- Every feature branch opens a PR → Vercel builds a *unique* preview URL for that PR.
- You review/design QA on that PR URL (not on a shared `preview` branch).
- Only batch-merge to `preview` (or skip it entirely) when you want to stage multiple PRs together.

2) **Two CI lanes**
- **Lane A (fast, required on PRs):** lint, typecheck, unit tests, `pnpm build` (no e2e). Target ≤3–5 min.
- **Lane B (slow, gated):** e2e, cross-browser, smoke against staging DB. Run **only** on merges to `preview` and `production`.

Tactics to make Lane A fast:
- Cache aggressively: `pnpm fetch` + `pnpm install --prefer-offline --frozen-lockfile`, `actions/cache` keyed by `pnpm-lock.yaml`.
- Turborepo/tsc build caching; skip jobs via path filters (docs/markdown don’t run tests).
- Parallelize (lint/type/tests/build in separate jobs).
- Fail-fast (matrix `fail-fast: true`).

3) **Auto-merge on green (no manual “Merge when ready”)**
- Enable GitHub **auto-merge** for PRs by default using a label or a bot comment (`/merge`).
- Rule: when Lane A is green and PR has label `automerge`, queue it automatically.
- Dependabot & AI PRs: apply label programmatically on open.

4) **Stop developing off a stale `preview`**
- Always branch from the latest `origin/preview` (or `main` if you drop `preview`).
- Add a pre-push hook: `git fetch origin && git rebase origin/preview || exit 1` so you never push a stale head.
- If you keep `Require branches up to date`, turn **off** for PRs to `preview` so you’re not blocked by churn; keep it **on** for `production`.

5) **Optional: drop `preview` entirely**
- Many teams run **trunk-based**: PR → per-PR preview → merge to `main` → “promote to production” via tag or PR. If you still want a staging gate, keep `preview` but only use it for **bundled** test passes, not every tiny change.

6) **Neon + envs**
- Spin a **DB branch per PR** (Neon integration). Seed from `staging` nightly. Your PR preview URL points to that DB branch. No waiting on `preview` to test data changes.

7) **Artifact reuse to kill double builds**
- CI builds once and uploads the build artifact.
- For staging/prod, use `vercel deploy --prebuilt` (or Vercel “Deploy from CI artifacts”) so Vercel doesn’t rebuild.

8) **Stack your work without blocking**
- Use stacked PRs (Graphite/GitButler or `gh stack`) so you can land small, ordered changes while the previous one runs Lane A. Each PR still has its own preview URL.

9) **Policy tweaks for speed**
- Required checks on `preview`: **Lane A only**.
- Required checks on `production`: **Lane A + Lane B**.
- Merge queue: auto-enqueue when label `automerge` is present; remove the manual click.

---

## Concrete checklist to 

*(Answer truncated — 4080 chars total)*

## Question

Our preview branch is our staging branch. Then it goes to production. There is no other long lived branches. Is this correct? 

## Answer

Short answer: **Yes—that’s a valid setup** (two long-lived branches: `preview` = staging, `production` = prod). It’s common and works well **if** you add the right guardrails:

- **Branching**
  - Always branch feature branches from **`preview`**.
  - Merge feature PRs **into `preview`** on green (fast checks only).
  - Promote to **`production`** via PR from `preview` → `production` (full checks).

- **CI lanes**
  - **PRs → `preview` (fast):** lint, typecheck, unit tests, build (≤5 min). Per-PR preview URLs for QA.
  - **`preview` → `production` (slow):** e2e, smoke, cross-browser, DB migrations, etc.

- **Policies**
  - `preview`: “Require branch up to date” **off**; auto-merge on green via label.
  - `production`: “Require branch up to date” **on**; merge queue enabled.
  - Use **prebuilt artifacts** to avoid double builds; per-PR **Neon DB branches** for data changes.

If churn and conflicts persist, consider going **trunk-based** (only `main` as staging) and deploy to prod via **tags**—but your current **`preview` + `production`** model is correct; it just needs the speed tweaks above.

## Question

How about copilot review and Claude Code review.

## Answer

Mr. White — yes, use both, but make them **fast, non-blocking on `preview`** and **gating signals for `production`**.

# Recommended setup

1) **Install & scope**
- Install **GitHub Copilot for PRs** (org level) → enables “Copilot PR feedback” checks + summaries.
- Install **Claude Code Review** app (Anthropic) on the repo → it posts a review/check.

2) **When they run**
- Trigger on **every PR to `preview`** (fast feedback, non-blocking).
- Trigger on **PR `preview → production`** (treat as gating via policy below).

3) **Noise control (both tools)**
- Only run if: `LOC < 2,000` and `files_changed ≤ 50` (skip huge refactors).
- Path filters: ignore `**/*.lock`, `dist/**`, snapshots, generated code, images.
- Provide both with your `CLAUDE.md` + “house rules” prompt (tests required, TS strict, Tailwind conventions, no inline styles, etc.).

4) **Policy**
- On PRs → `preview`: they **comment**, not gate. You merge on green Lane-A checks.
- On PRs → `production`: require a **synthetic “review-gate” check** that passes only if neither tool reports a **MUST-FIX** finding.

5) **How to gate without blocking on “approval”**
Bots can’t satisfy “Require approving reviews.” Instead, gate on a **status check** you control:

- Both tools post comments; you ask reviewers to prefix blockers with `MUSTFIX:` (Copilot uses “High severity”, Claude can be prompted to mark `MUSTFIX:`).
- A tiny action scans the latest PR comments & tool checkruns; if any `MUSTFIX:` remains unresolved, it **fails** the gate.

# Minimal workflows (copy-paste)

### `.github/workflows/pr.yml` (fast lane on all PRs, plus AI reviews)
```yaml
name: PR Fast Lane
on:
  pull_request:
    branches: [preview, production]
permissions:
  contents: read
  pull-requests: write
  checks: read
jobs:
  fast:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 9 }
      - run: pnpm install --frozen-lockfile
      - run: pnpm run lint
      - run: pnpm run typecheck
      - run: pnpm run test:unit -- --run
      - run: pnpm run build
  ai-reviews:
    runs-on: ubuntu-latest
    if: >-
      github.event.pull_request.changed_files <= 50 &&
      (github.event.pull_request.additions + github.event.pull_request.deletions) < 2000
    steps:
      # Copilot & Claude apps run automatically once installed.
      # This job exists only to standardize timing and surface links if needed.
      - name: Note
        run: echo "Copilot and Claude apps will comment/check on this PR."
```

### `.github/workflows/review-gate.yml` (gate prod merges)
```yaml
name: AI Review Gate
on:
  pull_request:
    branches: [production]
permissions:
  pull-requests: read
  contents: read
  issues: read
  checks: read
jobs:
  gate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      # Wait for AI tool check-runs to finish (names vary; we match by contains)
      - name: Wait for AI checks
        uses: fountainhead/action-wait-

*(Answer truncated — 5083 chars total)*

## Question

Check our Claude Code logs on our local machine and see if there's any issues its hitting that we can prevent for speed

ash(git status)
  ⎿  On branch preview                                     
     Your branch is ahead of 'origin/preview' by 3 commits.
       (use "git push" to publish your local commits)
     … +27 lines (ctrl+r to expand)

⏺ I need to stage the changes first, then push and create a PR.
   Let me run the git commands:

⏺ Bash(git add -A && git log --oneline -5 && git diff --cached
      --stat)
  ⎿ f9f5a72 Merge remote-tracking branch 'origin/preview' into
     preview
    e717889 [chore]: preview reset workflows (#707)
    … +23 lines (ctrl+r to expand)


⏺ Bash(git push origin preview)
  ⎿  Error: stderr | tests/unit/ClaimHandleForm.test.tsx
     DATABASE_URL is not set. Database tests will be skipped.

     stderr | 
     __tests__/components/dashboard/DashboardSplitView.test.tsx
     DATABASE_URL is not set. Database tests will be skipped.

     stderr | tests

## Answer

From the logs you pasted, here’s what’s slowing down Claude Code locally and what you can fix to speed things up:

### 1. Wrong workflow — working on `preview` directly
- You were pushing commits straight to `preview`, then trying to open PRs from it. That forced resets, force-pushes, and retries.  
✅ **Fix:** Always create a feature branch (`chore/...`, `feat/...`) off `preview`, push that, then PR into `preview`. Claude Code (and your CI) will run cleanly without conflicts.

---

### 2. Missing `DATABASE_URL`
- Every test run logs dozens of warnings:
  ```
  DATABASE_URL is not set. Database tests will be skipped.
  ```
- This doesn’t break the run, but it clogs logs and slows feedback.  
✅ **Fix:**  
  - Add a `.env.test` with a stubbed DB URL (`DATABASE_URL="postgres://dummy:dummy@localhost:5432/test"`) so tests don’t warn.  
  - Or in `jest.setup.ts` / Vitest config, stub `process.env.DATABASE_URL` if undefined.

---

### 3. Commit hooks/linting overhead
- Your pre-push runs `typecheck`, `test`, `build`. That means every push re-does the full suite, adding several minutes.  
✅ **Fix:**  
  - Run *fast checks only* (lint + typecheck) on pre-push. Leave tests/build for CI.  
  - Or use [lint-staged](https://github.com/okonet/lint-staged) to only lint/format staged files locally.  
  - This keeps Claude Code from retrying commits because of hook failures.

---

### 4. Commit message format
- Claude Code tripped over `commitlint` rules (`[chore]: …` vs `chore: …`).  
✅ **Fix:** enforce conventional commits with a commit template or a `git cz` tool. That way Claude won’t waste cycles retrying with the correct format.

---

### 5. Auto-fixable lint errors
- Claude ran `pnpm biome check --fix` after failing on import ordering.  
✅ **Fix:** add Biome/ESLint to `pre-commit` via Husky + lint-staged so imports are auto-fixed before Claude even tries to commit.

---

### TL;DR fixes for speed
1. **Branch discipline**: no direct work on `preview`.
2. **Stub `DATABASE_URL`** in test env to kill noisy skips.
3. **Streamline pre-push**: only lint/typecheck; push tests/build to CI.
4. **Commit format tooling**: conventional commits enforced up front.
5. **Auto-fix lint on commit**: Biome/ESLint in pre-commit, not after failed pushes.

That way, Claude won’t loop through retries, your logs stay clean, and PR creation won’t stall.  

Want me to sketch the exact Husky + lint-staged + `.env.test` snippets you should drop in so you don’t hit these again?

## Question

Ok now how should we go about turning on auto merge when Claude Code pushes?

## Answer

Here’s the clean way to do it, Mr. White:

---

## 1. Use a label-based auto-merge policy
- In **repo settings → Branches → preview branch protection**:
  - Enable **Auto-merge**.
  - Allow “squash” (or merge style you prefer).
- In `.github/auto-merge.yml` (or a lightweight GitHub Action), configure that **any PR with the label `automerge` auto-merges when checks pass**.

---

## 2. Tag Claude PRs automatically
Claude Code PRs have a consistent **author (bot)** or **branch prefix** (`claude/...` or `chore/...` with its signature).
- Add a small action that runs on `pull_request_target`:
  ```yaml
  name: Auto-label Claude PRs
  on:
    pull_request_target:
      types: [opened, reopened]
  jobs:
    label:
      runs-on: ubuntu-latest
      steps:
        - uses: actions-ecosystem/action-add-labels@v1
          if: github.actor == 'anthropic-claude-bot' # replace with exact actor name
          with:
            labels: |
              automerge
  ```
- This drops the `automerge` label on every Claude PR.

---

## 3. Merge queue behavior
- Because you’re using `preview` as staging:
  - **`preview` branch:** only requires fast lane checks (lint, typecheck, unit tests).
  - When the label is added, the PR auto-enqueues → merges on green.
- **`production` branch:** still gated (full checks + AI review gate). No auto-merge unless you explicitly want it.

---

## 4. Extra guardrails
- Require “branches up to date” OFF on `preview`. This keeps Claude PRs from stalling behind constant rebases.
- Require “branches up to date” ON for `production` only.
- Optionally whitelist authors for auto-merge: you + Claude + Dependabot.

---

### Result
Claude pushes → PR opens → gets `automerge` label → runs only fast checks → auto-merges into `preview` as soon as green. No clicks, no waiting.

---

Want me to write you the exact **GitHub Action workflow file** for auto-label + auto-merge so you can just drop it into `.github/workflows/` and be done?

## Question

Ok now for CI checks lets ensure we have the right smoke versions and full version for the right branches. Give me the full setup as it should be

## Answer

Got it, Mr. White. Here’s a clean **branch-aware CI setup** that keeps your loop fast but gates production with full rigor.  

---

# ✅ Branch Strategy Recap
- **Feature branches** → PR into `preview`.
- **`preview` branch = staging** (fast CI + smoke deploy).
- **`production` branch = prod** (full CI + gated deploy).

---

# ✅ CI Workflows

### 1. `pr.yml` – Fast lane for all PRs
Runs on **every PR** (feature → preview, preview → production).  
Goal: keep <5 min feedback.

```yaml
name: PR Fast Lane
on:
  pull_request:
    branches: [preview, production]
permissions:
  contents: read
  pull-requests: write
jobs:
  fast-checks:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 9 }
      - run: pnpm install --frozen-lockfile
      - run: pnpm run lint
      - run: pnpm run typecheck
      - run: pnpm run test:unit -- --run
      - run: pnpm run build
```

---

### 2. `preview.yml` – Staging smoke tests
Triggered on **merge to `preview`**.  
Goal: deploy + run **smoke tests only**.

```yaml
name: Preview Smoke
on:
  push:
    branches: [preview]
permissions:
  contents: read
jobs:
  smoke:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 9 }
      - run: pnpm install --frozen-lockfile
      - run: pnpm run build
      - run: pnpm run test:smoke   # minimal sanity tests

  deploy:
    needs: smoke
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npx vercel deploy --prebuilt --token=${{ secrets.VERCEL_TOKEN }} --prod=false
```

---

### 3. `production.yml` – Full checks for prod
Triggered on **PR into `production`**.  
Goal: run everything, then deploy.

```yaml
name: Production Full
on:
  pull_request:
    branches: [production]
permissions:
  contents: read
jobs:
  full-checks:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 9 }
      - run: pnpm install --frozen-lockfile
      - run: pnpm run lint
      - run: pnpm run typecheck
      - run: pnpm run test:unit -- --coverage
      - run: pnpm run test:integration
      - run: pnpm run test:e2e

  deploy:
    needs: full-checks
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npx vercel deploy --prebuilt --token=${{ secrets.VERCEL_TOKEN }} --prod=true
```

---

# ✅ Branch Protection Rules

- **`preview` branch**
  - Required: `PR Fast Lane` (fast-checks).
  - Require up-to-date: **OFF**.
  - Auto-merge: **ON** (with label).

- **`production` branch**
  - Required: `PR Fast Lane`, `Production Full` (full-checks), AI review gate.
  - Require up-to-date: **ON**.
  - Merge queue: **ON**.

---

# ✅ Smoke vs Full Test Scope

- **Smoke tests (`test:smoke`)**  
  - App boots without errors.  
  - Dashboard renders.  
  - Key routes return 200.  
  - Healthcheck passes.

- **Full suite (`test:

*(Answer truncated — 3546 chars total)*

## Question

How should we be handling NEON NCI for tests? How should our tests be, um... Like, do tests need database, and do tests need auth?

## Answer

Mr. White — keep it simple and fast:

# Test policy (what needs DB/auth?)
- **Unit tests (default):** **No DB, no auth.** Pure functions/components. Mock IO boundaries.
- **Integration tests (server logic, DB queries):** **Ephemeral Neon DB, no real auth.** Run against a throwaway branch seeded with fixtures; mock auth context.
- **E2E (Playwright on preview/prod):** **Real stack.** Hits the deployed app, **real auth with test users**, real Neon staging DB (or an e2e branch cloned from staging).

# Neon NCI (ephemeral DB per CI run)
Use Neon’s branch-per-run so tests never fight each other or your staging data.

**In CI (for integration tests):**
```bash
# 1) Create ephemeral branch from staging
neon branches create \
  --project-id "$NEON_PROJECT_ID" \
  --name "ci-${GITHUB_RUN_ID}" \
  --parent "$NEON_PARENT_BRANCH"

# 2) Get connection string
DB_URL=$(neon connection-string \
  --project-id "$NEON_PROJECT_ID" \
  --branch "ci-${GITHUB_RUN_ID}")

# 3) Export for the job
echo "DATABASE_URL=$DB_URL" >> $GITHUB_ENV

# 4) Migrate + seed (Drizzle)
pnpm drizzle-kit migrate
pnpm tsx scripts/seed.ts

# 5) Run integration tests
pnpm test:integration

# 6) Cleanup
neon branches delete \
  --project-id "$NEON_PROJECT_ID" \
  --name "ci-${GITHUB_RUN_ID}" --force
```
Secrets required: `NEON_PROJECT_ID`, `NEON_PARENT_BRANCH`, `NEON_API_KEY` (if needed by CLI).

**Local dev:**
- Put a stub `.env.test`:
  ```
  NODE_ENV=test
  DATABASE_URL=postgres://dummy:dummy@localhost:5432/test
  ```
- Integration tests can optionally honor `USE_NEON=1` to create a local ephemeral Neon branch when you want to reproduce CI behavior.

# Auth handling
- **Unit & Integration:** **mock auth**. Provide helpers so tests never touch real identity.
  - Clerk example:
    ```ts
    vi.mock('@clerk/nextjs', () => ({
      auth: () => ({ userId: 'test_user_1', sessionId: 'sess_1', getToken: async () => 't' }),
      currentUser: async () => ({ id: 'test_user_1', emailAddresses: [{emailAddress:'t@x.dev'}] }),
    }));
    ```
  - NextAuth example:
    ```ts
    vi.mock('next-auth', () => ({
      getServerSession: async () => ({ user: { id: 'test_user_1', email: 't@x.dev' } }),
    }));
    ```
- **E2E:** **real auth with test accounts only.**
  - Create `TEST_USER_EMAIL/PASSWORD` secrets; seed them in `scripts/seed.ts`.
  - Playwright signs in via UI or programmatic session cookie (faster).

# Project structure (keep boundaries clean)
- Introduce a **Repository/Service boundary** so unit tests mock repositories, and integration tests swap in the real DB repository.
- Provide **test utils**:
  - `test/utils/db.ts` → create/drop schema, truncate tables between tests.
  - `test/utils/auth.ts` → common auth mocks.
  - `test/utils/fixtures.ts` → factories (users, orgs, links, etc.).

# Scripts (package.json)
```json
{
  "scripts": {
    "test": "vitest --run",
    "test:unit": "vitest --run -c vitest.config.unit.ts",
    "test:integration": "vitest --run -c vitest.config.int.ts",
    "test

*(Answer truncated — 5108 chars total)*

## Question

Okay, based on everything we've talked about in terms of trying to keep things quick and fast and do a proper development workflow with all the auto-promotion and auto-merge and all that stuff, take a look at our current workflow files and tell me if you see any problems.

## Answer

Mr. White — quick audit and fixes. Net: you’re close, but a few things are adding latency or duplication.

# High-impact issues & fixes

1) ## Two PR preview deployers (duplicate work)
- You deploy PR previews in **`ci.yml`** (`ci-pr-vercel-preview` job) **and** in **`consolidated-vercel-preview.yml`**. That’s double builds/deploys per PR = slower feedback and noisy comments.  
**Fix:** keep exactly one. Easiest: **remove/disable** `consolidated-vercel-preview.yml` and keep the CI-wired PR deploy so it can reuse the Neon job outputs. fileciteturn0file2 fileciteturn0file6

2) ## Auto-merge depends on workflow name “CI”, but your workflow has no `name:`
- `auto-merge.yml` waits for checks that start with `CI / …`. Your main workflow **doesn’t set `name:`**, so you’re relying on GitHub’s filename default. That’s brittle; if GitHub shows it as “ci”, your regex won’t match and auto-merge won’t trigger.  
**Fix:** add `name: CI` at the top of **`ci.yml`**. (Regex in auto-merge is already `^CI / (…)`.) fileciteturn0file0 fileciteturn0file2

3) ## Neon branch creation runs on *every* PR to `preview`
- `neon-db` job runs for push/merge_group **and PRs to preview**; then downstream Drizzle may skip. You still pay the DB branch creation cost on most PRs (even UI-only).  
**Fix:** restrict `neon-db` to: `push` and `merge_group`, and **PRs to production** (plus `full-ci` label). That keeps the fast lane truly fast. Edit the big `if:` on job `neon-db`. fileciteturn0file2

4) ## PR “Up-to-date with preview” check can block humans more than needed
- Job `PR Up-to-date with Preview` **fails** for manual PRs (unless labels `auto-merge`, `codegen`, `dependabot`). Good guard, but if your ruleset also requires “branch up-to-date,” this creates double friction.  
**Fix:** keep this job but ensure the **branch protection for `preview`** has “Require up-to-date” **OFF** so this job’s soft-policy is the only gating. (Your auto-merge job will update branches when behind.) fileciteturn0file2

5) ## Auto-merge scope is good, but confirm label names
- Your auto-merge logic merges: **Dependabot** (patch/minor/security), **codegen** (via `codegen` label), and anything with **`auto-merge`** or **`dependencies`** label; it **never** auto-merges **preview→production**. That matches policy — just ensure your bots add those exact labels. fileciteturn0file0

6) ## Promotion path: you have two
- **`ci.yml`** auto-opens/updates preview→production PR on push to `preview`.  
- **`auto-promote.yml`** is a manual fallback. That’s fine — just be aware you have *two* paths. If you want one source of truth, remove the manual fallback, or rename it to “Manual Promotion (fallback)” to avoid confusion. fileciteturn0file2 fileciteturn0file1

7) ## PR preview deploy depends on Neon/Drizzle even for front-end changes
- In `ci.yml`, job `ci-pr-vercel-preview` **needs** `[ci-drizzle-check, neon-db]`. For UI-only PRs this is unnecessary latency.  
**Fix:** drop `ci-drizzle-

*(Answer truncated — 6305 chars total)*

## Question

So, based on your feedback, I've removed the up-to-date-with-preview branch protection. Per your point number 4, do we even need this in our CI, or is it just slowing us down? I don't know if there's any use for it, since doesn't it do the same thing as the ruleset? We have it turned on in the ruleset for production and off for preview, so do we even need it as its own CI job?

## Answer

Short answer: drop it.  

Mr. White, that **“Up-to-date with preview” CI job** duplicates what branch protection already does and just burns minutes. You’ve set **Require branch up-to-date = OFF on `preview`** and **ON for `production`**—perfect. The CI job adds no extra safety, only latency and occasional race conditions.

### What to do
- **Delete** the CI job that enforces “up-to-date with preview.”
- **Do not** add any equivalent check on `preview`.
- **Rely on rulesets:**
  - `preview`: fast checks only, auto-merge allowed.
  - `production`: Require up-to-date **ON**, merge queue **ON**, full checks.

### If you still want auto-update when behind (prod only)
Use a tiny helper that updates the head branch **only on PRs into `production`** (so humans don’t click “Update branch”):

```yaml
name: Auto-update prod PR when behind
on:
  pull_request_target:
    types: [opened, synchronize, labeled]
jobs:
  update-branch:
    if: github.base_ref == 'production' && !contains(github.event.pull_request.labels.*.name, 'no-auto-update')
    permissions:
      contents: write
      pull-requests: write
    runs-on: ubuntu-latest
    steps:
      - uses: actions/github-script@v7
        with:
          script: |
            await github.rest.pulls.updateBranch({
              owner: context.repo.owner,
              repo: context.repo.repo,
              pull_number: context.payload.pull_request.number
            })
```

(That uses GitHub’s native **Update branch** API; it plays nicely with the merge queue and “Require up-to-date.”)

### Bottom line
- **Keep preview fast** → no “up-to-date” checks, no CI job for it.
- **Gate production** with native protections + merge queue.
- Optional: auto-update prod PRs via the snippet above to avoid clicks.

## Question

In Claude Coderview, I'd be down to add it for Copilot as well. But shouldn't that be non-blocking for preview and blocking for production? Thanks for watching!

## Answer

Yep—exactly: **non-blocking on `preview`, blocking on `production`** for both Claude Code Review *and* Copilot PR feedback.

Here’s the clean setup:

# Branch protection
- **`preview`:** do **not** mark any AI checks as required.
- **`production`:** mark a single gate check (below) as **required**.

# AI review behavior
- Let **Claude Code Review** and **Copilot PR Feedback** run on every PR.
- On `preview`: they just comment/suggest. Merge isn’t blocked.
- On `production`: a tiny gate job waits for both tools, then fails only if a **MUSTFIX** is present.

# Minimal gate workflow (drop in `.github/workflows/ai-review-gate.yml`)
```yaml
name: AI Review Gate
on:
  pull_request:
    branches: [production]

permissions:
  contents: read
  pull-requests: read
  checks: read

jobs:
  gate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      # Wait for Copilot + Claude checks to finish (names vary; match substrings)
      - name: Wait for Copilot
        uses: fountainhead/action-wait-for-check@v1.2.0
        with:
          token: ${{ secrets.GITHUB_TOKEN }}
          checkName: 'Copilot'   # matches "GitHub Copilot: PR Feedback"
          ref: ${{ github.event.pull_request.head.sha }}

      - name: Wait for Claude
        uses: fountainhead/action-wait-for-check@v1.2.0
        with:
          token: ${{ secrets.GITHUB_TOKEN }}
          checkName: 'Claude'    # matches Anthropic’s check name
          ref: ${{ github.event.pull_request.head.sha }}

      # Fail if any MUSTFIX remains in reviews/comments
      - name: Enforce MUSTFIX
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          PR: ${{ github.event.pull_request.number }}
        run: |
          set -euo pipefail
          # Count unresolved MUSTFIX in PR comments/reviews
          mustfix=$(
            { gh pr view "$PR" --comments --json comments | jq -r '.comments[].body';
              gh pr view "$PR" --reviews  --json reviews  | jq -r '.reviews[].body'; } \
            | grep -i '^MUSTFIX:' | wc -l
          )
          if [ "$mustfix" -gt 0 ]; then
            echo "Blocking: MUSTFIX items present."
            exit 1
          fi
          echo "AI Gate passed."
```

# Prompting rules (put in `CLAUDE.md` and a repo docs note for Copilot)
- Ask both tools to prefix any true blockers with `**MUSTFIX:**` (exact token).
- Everything else should be `NICE:` or `NIT:`.  
This keeps the gate deterministic without over-blocking.

# Optional niceties
- **Size/path filters:** In your AI-config docs, state that AI reviewers should skip huge/binary changes and vendor/lockfiles.
- **Auto-label:** If you want a visible signal, add a lightweight bot to add/remove a `ai:mustfix` label when `MUSTFIX:` appears/gets resolved (the gate above already works without labels).
- **Don’t make AI required on `preview`:** leave required checks there to only your fast lane.

Result: speedy `preview` merges with helpful (but non-blocking) AI signal, and a single **AI Rev

*(Answer truncated — 3078 chars total)*

## Question

Great, so then what would be our updated branch requirements, our updated branch rule set for preview and for production?

## Answer

Mr. White — here’s the crisp, final ruleset.

# preview (staging) — fast & unblocked
- **Require pull request:** ON  
  - **Required reviews:** 0  
  - **Dismiss stale reviews:** OFF
- **Require status checks to pass:** ON  
  - **Required checks (exact names):**  
    - `PR Fast Lane / fast-checks`  *(lint, typecheck, unit, build)*  
    - *(Optional)* `Preview Smoke / smoke` *(if you want a post-merge signal)*
- **Require branches up to date:** **OFF**
- **Require merge queue:** **OFF**
- **Allow auto-merge:** **ON** (squash)
- **Allowed merge methods:** Squash only (recommended)
- **Require linear history / Block force pushes / Restrict deletions:** **ON**
- **Restrict pushes:** Disallow direct pushes (bot/user bypasses optional)
- **AI checks (Claude, Copilot):** **Not required** (non-blocking only)

# production — gated & rigorous
- **Require pull request:** ON  
  - **Required reviews:** 1 (human) *(or 0 if you truly want full-auto)*  
  - **Dismiss stale reviews:** ON
- **Require status checks to pass:** ON  
  - **Required checks (exact names):**  
    - `PR Fast Lane / fast-checks`  
    - `Production Full / full-checks` *(integration, migrations, e2e)*  
    - `AI Review Gate / gate` *(waits on Claude+Copilot, enforces MUSTFIX)*  
    - `CodeQL` *(or `CodeQL / Analyze (javascript-typescript)` if split)*  
    - *(Optional)* `Vercel Deploy (prod) / deploy` **if** you gate on prebuilt deploy success
- **Require branches up to date:** **ON**
- **Require merge queue:** **ON**
- **Allow auto-merge:** OFF (usually)  
  *(Use merge queue promotion from `preview` with all gates.)*
- **Allowed merge methods:** Squash only
- **Require linear history / Block force pushes / Restrict deletions:** **ON**
- **Restrict pushes:** Disallow direct pushes (Admins bypass allowed if you want)

# Notes
- Keep AI (Claude, Copilot) **running on all PRs**, but only the **`AI Review Gate`** is marked **required** on `production`.  
- Ensure workflow/job names match exactly what you set in `.github/workflows` so the required checks resolve 1:1.  
- If you kept a `Preview Smoke / smoke` job, don’t make it required on `preview` unless you want post-merge blocking.

## Question

Should we rename any of our workflows?

## Answer

Yes—rename a couple for clarity and to keep the required-check names stable. Here’s the minimal, high-signal set I’d use:

# Keep as-is
- **Workflow:** `CI` (in `ci.yml`) → checks appear as `CI / <job name>`. This is perfect for gating. fileciteturn2file0
- **Workflow:** `CodeQL Security Analysis` → leave it; not part of the fast lane. fileciteturn2file3

# Rename (or remove) for clarity
- **`consolidated-vercel-preview.yml` →** either **delete** (recommended; you already deploy previews inside `CI`) **or** rename to **`PR Preview Deploy (manual)`** to make it obvious it’s an optional/backup path. Your README currently advertises this as the preview path, which conflicts with CI—pick one. fileciteturn2file2 fileciteturn1file16
- **`auto-promote.yml` →** **`Manual Promotion (fallback)`** so it doesn’t look like the primary path (your primary promotion is opened/updated from `CI`). fileciteturn2file4

# Tweak auto-merge’s expectation (because you removed the “Up-to-date with Preview” job)
Your auto-merge workflow builds a regex of required checks. It still includes `PR Up-to-date with Preview` for preview PRs; drop that so we only wait on the fast lane. Change the “Set wait pattern” step to:

```diff
- // Full checks on production PRs
- re = '^CI \\/ (Build|Unit Tests|E2E Tests|Drizzle Check)$';
- ...
- // Fast checks on preview PRs
- re = '^CI \\/ (ci-fast|PR Up-to-date with Preview)$';
+ // Full checks on production PRs
+ re = '^CI \\/ (Build|Unit Tests|E2E Tests|Drizzle Check)$';
+ // Fast checks on preview PRs (no extra up-to-date job)
+ re = '^CI \\/ (ci-fast)$';
```
(This lives in `auto-merge.yml` “Set wait pattern”.) fileciteturn2file1

# Optional polish (names only; no logic changes)
- **`Smart Auto-Merge`** (current) is fine, but if you want ultra-explicit, rename to **`Auto-Merge (preview only)`** since promotion PRs are intentionally not auto-merged. fileciteturn2file1
- In `CI`, your job display names already match what the auto-merge waits for—`Build`, `Unit Tests`, `E2E Tests`, `Drizzle Check`, and `ci-fast`. Keep those exact strings so the regex stays happy. fileciteturn2file0
- If you keep the standalone preview deployer, set its workflow name to **`PR Preview Deploy`** so its check shows as `PR Preview Deploy / Deploy Vercel Preview`, and **do not** mark it required (since preview deploy already happens inside `CI`). fileciteturn2file2

# Why this helps
- Fewer duplicate deployments (one source of truth for PR previews).
- Required checks remain stable and predictable (regex now matches only what you actually run).
- Manual tools are labeled as such, so they don’t interfere with the fast path.

If you want, I can draft the tiny diff PR that: (1) removes the extra preview deployer, (2) renames the fallback promotion workflow, and (3) edits the auto-merge regex block.
