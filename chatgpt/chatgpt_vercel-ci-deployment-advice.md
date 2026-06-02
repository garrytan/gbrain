---
title: "Vercel CI deployment advice"
type: essay
created: 2025-08-04
updated: 2025-08-04
source: chatgpt-export
conversation_id: 6891195c-9cf0-8322-943a-f1a879f00d60
message_count: 14
tags: [chatgpt, import, code, long-form]
---
# Vercel CI deployment advice

> Conversation ID: 6891195c-9cf0-8322-943a-f1a879f00d60
> Created: 2025-08-04T20:34:38Z
> Updated: 2025-08-04T20:56:42Z
> Messages: 14

---

## User

Take a look at the CI workflow. You know, we're deploying to Versal, and so I'm curious, like, do we, you know, Versal does its thing with, like, automatically deploying... It automatically deploys for every build and stuff, but, you know, we have our preview and our production environments and stuff that we would then deploy, but we want to make sure they pass the checks on GitHub actions. Just explain to me currently how Versal deploy is being handled by this, and if that's going to create duplicate deployments or not for any given stage of the CI, and then your recommendation if there's a better way to handle it.

---

## Assistant

**Current behavior**

| Branch | Who triggers the build | What the workflow does | Duplicate risk? |
|--------|-----------------------|------------------------|-----------------|
| **develop** | GitHub Actions | `vercel pull → vercel build → vercel deploy --prebuilt`【20†L42-L51】 | Yes—if Vercel Git-Hub integration is still on |
| **preview** | GitHub Actions | Same three-step CLI flow【5†L39-L48】 | Same duplicate risk |
| **main (prod)** | GitHub Actions | Same flow with `--prod` flag【1†L40-L49】 | Same duplicate risk |

Because the workflows deploy via the Vercel CLI **and** the Vercel Git-Hub app will auto-deploy every push by default, you end up with two deployments per commit:

1. An instant upload using the locally built artifacts (`--prebuilt`)—cheap but still a deployment record.  
2. A second full remote build kicked off by the Git-Hub app—slower, uses extra build minutes, and clutters the dashboard.

---

**Recommendations (pick one path and stick to it)**

| Option | Keep CLI, disable Vercel’s auto-deploy *(recommended)* | Drop CLI, rely on Vercel app |
|--------|--------------------------------------------------------|-----------------------------|
| How | In Vercel → **Settings ▸ Git**, turn off **Automatic Project Deploys** (or unlink the repo). | Delete the `vercel pull/build/deploy` steps from all three workflows and keep the rest of the CI. |
| Pros | • Tests/lint pass **before** anything is deployed.<br>• `--prebuilt` re-uses the local build → no remote build minutes.<br>• Single deployment per commit. | • Even simpler workflows.<br>• Vercel handles infra; you only gate merges on CI success. |
| Cons | You must manage the Vercel token + env vars in Actions (already done). | You need an Action (or branch rule) that waits for the Vercel check before auto-promoting preview → main. |

---

**Extra polish if you keep the CLI**

1. Run Playwright/Lighthouse **before** `vercel deploy`. You can spin up the local `.vercel/output` with `vercel dev --listen 3000` or `next start` so tests fail fast without polluting Vercel.  
2. Add `--scope` flags only if you split orgs later; not needed now.

Bottom line: **turn off the Git-Hub integration for this repo and leave the CLI in charge**. One build, one deployment, no wasted minutes, clean history.

---

## User

Okay, so I'm going to turn it off. So I'm going to go to Versal. I'm going to go to my Projects. I'm going to go to my Settings. I'm going to go to Git, and I'm just going to turn... When a commit is pushed to the Git repository that is connected with your project, the SSH will determine if a new build has to be issued. If the SHH was deployed before, no build will be issued and customizes its behavior with a command that exits with 1 or code 0, run my node script, only if there are changes in the folder, only build pre-production, only build production, yada yada yada. Is that the right setting, or is there a different setting in here? There's a Connect Git Repository section. Versal automatically posts comments and events to keep you up to date. I have a disconnect button, but I don't know if the disconnect... Should I just disconnect GitHub entirely, or what's the way to do this?

---

## Assistant

**Skip the “Ignored Build Step” box — that’s not what you want**

The text you’re looking at (“When a commit is pushed … decide with exit 0/1”) is the **Ignored Build Step** feature. It only *cancels the build after it has already started*, and the cancelled build still counts as a deployment slot and clutters the dashboard. citeturn4view0L36-L41

---

### The clean way: keep the GitHub link, but tell Vercel never to auto-deploy

Add a small `vercel.json` in the repo root:

```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "git": {
    "deploymentEnabled": false        // turn off for **all** branches
  }
}
```

*Or* use the object form to disable only certain branches:

```json
"git": {
  "deploymentEnabled": {
    "develop": false,
    "preview": false,
    "main": false
  }
}
```

`deploymentEnabled: false` stops Vercel’s GitHub app from spinning up any deployment, but the repo stays connected so you still get commit status checks, PR comments, and “Deploy” buttons if you ever want to trigger a manual build. citeturn7view0L32-L36

---

### Where to click if you prefer the UI

1. **Project ▸ Settings ▸ Git**  
2. At the very top you’ll see two toggles:  
   * **Automatic Production Deployments**  
   * **Automatic Preview Deployments**  
   Turn them **off**. (If you don’t see the toggles you’re on an older layout; in that case, add the `vercel.json` file instead.)

That leaves the integration active but quiet.

---

### Don’t hit “Disconnect”

Clicking **Disconnect** severs the whole integration — you’ll lose PR comments and commit-status checks, which breaks the “wait-for-Vercel” protection many teams use. It’s over-kill for what you need.

---

### What happens after this change?

* **GitHub Actions** runs your linters/tests → builds with `vercel build` → `vercel deploy --prebuilt`.  
* Vercel says “cool, artifact already built” and just uploads it — **one deployment per commit, zero duplicates**.  
* No remote build minutes are burned, dashboard stays tidy.

That’s it — add the `vercel.json` (or flick the two toggles) and you’re done.

---

## User

Okay, so I've done that. Now the other thing we're having is we're having a Versal issue with the CI is not actually deploying to Versal. It's getting like a error, I think, because there's no like token or whatever. Tell me what I have to do to set up the token or login or auth or whatever for Versal on the CI.

---

## Assistant

**Why the job fails**

All three workflows expect these three secrets to exist:

```yml
env:
  VERCEL_TOKEN:      ${{ secrets.VERCEL_TOKEN }}
  VERCEL_ORG_ID:     ${{ secrets.VERCEL_ORG_ID }}
  VERCEL_PROJECT_ID: ${{ secrets.VERCEL_PROJECT_ID }}fileciteturn2file0L18-L23
```

If any one of them is missing, `vercel pull / build / deploy` will exit with 1 and the step (and therefore the job) dies.

---

### One-time setup (takes two minutes)

| Secret | Where to get it | Notes |
|--------|-----------------|-------|
| **VERCEL_TOKEN** | Vercel → **Account ▸ Settings ▸ Tokens ▸ “Create”** | Generate a **Personal** token (scoped to your account or team). Copy the **entire** string-of-letters. |
| **VERCEL_ORG_ID** | Vercel → Project ▸ **Settings ▸ General ▸ Team** | Looks like `team_abc123…`. If you’re on a personal account this still appears under “Team”. |
| **VERCEL_PROJECT_ID** | Same page, under **Project ID** | Looks like `prj_def456…`. |

1. In GitHub → **Repo ▸ Settings ▸ Secrets → Actions**  
   create three new secrets with the exact names above and paste the values.
2. Re-run the failed job – it should now authenticate, pull envs, build and deploy.

---

### Gotchas & tips

* **Least-privilege**: the token only needs “Deployments → Create & Read”.  
  (That’s the default when you create a Personal token.)
* **Org vs. project secrets**: if you have several repos that deploy the same Vercel project, put the secrets at the **organization-level** in GitHub instead of per-repo.
* **.vercel/project.json fallback**: You could delete `VERCEL_ORG_ID` / `VERCEL_PROJECT_ID` and commit the `.vercel/project.json` generated by `vercel link`, but keeping them as secrets avoids accidentally leaking IDs in the repo.

That’s it—add the three secrets once and CI will start shipping builds to Vercel without manual intervention.

---

## User

Okay, great. Now, compare our CI to the CI of, like, big Y Combinator companies and stuff. Um, is there anything that we're doing wrong or that we're doing that could be better? Or, you know, what's, uh, what, you know? And also in, like, general practice of, like, walk me through, like, ideally a new developer comes in and pulls our repo. How should they work?

---

## Assistant

**Mr. White, quick verdict**

Your pipeline is already miles ahead of most seed-stage teams: it gates deploys on unit tests + type-checks, spins up Playwright smoke tests, enforces Lighthouse budgets, runs CodeQL, and auto-promotes branches.  That’s the core playbook you’ll see at mature YC companies.

---

### What you’re already hitting YC-grade on

* **Fast local CI build** – `setup-node` with native NPM cache and Node 20.17 on every job【4†L30-L34】.  
* **Quality gates before deploy** – type-check, ESLint, unit tests, build step【8†L37-L40】.  
* **Preview infrastructure** – each commit to `develop`/`preview` is built locally, uploaded with `vercel deploy --prebuilt`, then smoke-tested by Playwright【3†L4-L8】【3†L10-L13】.  
* **Perf & security budgets** – Lighthouse, bundle-size, OWASP-ZAP, audit-ci run automatically on preview CI【11†L10-L18】【11†L21-L33】.  
* **Promotion automation** – once checks pass, a bot PR pushes `develop→preview` or `preview→main` and even enables auto-merge【4†L47-L57】【4†L72-L78】.  
* **Supply-chain upkeep** – Dependabot auto-merges patch/minor upgrades after CodeQL passes【4†L26-L36】【4†L38-L47】.

That’s already more surface-area coverage than many Series-A shops.

---

### Gaps top YC teams usually plug

| Theme | Why it matters | Quick win |
|-------|----------------|-----------|
| **Cancel stale runs** | A single PR push can start 2-3 parallel builds; wastes minutes. | Add `concurrency: group: ${{ github.workflow }}-${{ github.ref }} cancel-in-progress: true` to each job. |
| **Re-usable workflows** | Avoid copy-paste between `develop`, `preview`, `production`. | Extract common “build-and-deploy” job into `.github/workflows/_deploy.yml` and `uses:` it. |
| **Coverage gating** | YC favourites (Convex, Rippling) treat < 80 % coverage as a failed build. | Pipe `npm run test:ci -- --coverage` to Codecov and require the status check. |
| **Package-layer cache** | You rely only on `setup-node` cache; big repos add an L2 pnpm/npm cache keyed on lock-file. | `actions/cache` with `key: node-${{ hashFiles('**/package-lock.json') }}`. |
| **Build artifact reuse** | Production deploy re-runs `npm run build` after the CI build【0†L37-L39】—burns time. | Persist `.vercel/output` with `actions/upload-artifact` in the CI job and download it in the deploy job. |
| **Secrets via OIDC** | Tokens in GitHub secrets are fine but need rotation. | Switch to Vercel’s GitHub OIDC integration so CI jobs mint short-lived tokens (no copy/paste). |
| **Commit lint / Danger** | Keeps PRs tidy and changelogs automatic. | Add `commitlint` + a Danger JS step. |

---

### Ideal flow for a new dev onboarding tomorrow

1. **Clone & bootstrap**  
   ```bash
   git clone git@github.com:itstimwhite/Jovie.git
   nvm use 20        # matches CI
   npm ci
   vercel env pull .env.local        # pulls dev secrets
   ```
2. **Local run** – `npm run dev` (Next.js uses env pulled above).  
3. **Branch discipline** – `git switch -c feat/login-modal`.  
4. **Pre-commit hooks** – husky runs lint & tests locally; commit only green.  
5. **Push & PR** – open PR to `develop`; CI runs full suite.  
6. **Preview link** – Vercel URL auto-comments; play with it, share with design.  
7. **Merge rules** – when CI + CodeQL + coverage pass, GitHub auto-merges to `develop`; bot later promotes.  
8. **Rollbacks** – if Main is broken, click “Re-deploy previous” in Vercel; no code needed.

Stick with that and you’ll keep velocity high while avoiding the typical YC fire-drills.

---

*TL;DR – you’re 80 % of the way to elite.  Add concurrency cancellation, coverage gating, a shared workflow template, and consider OIDC for secrets.  Your future teammates will thank you.*

---

## User

Tell me about OIDC, tell me about the commit link danger, and then also tell me about how you would do the pre-commit hooks locally with Husky. Thank you for watching.

---

## Assistant

### 1 — OIDC in CI/CD (why & how)

* **What it is.** GitHub Actions can mint a short-lived OpenID Connect (OIDC) JWT for every job. Your cloud provider (AWS, GCP, Azure, Vault, etc.) trusts that JWT and swaps it for a time-boxed access token, so you no longer paste long-lived secrets into `secrets.*`. citeturn2view0L23-L28  
* **Why YC-scale teams like it.**  
  * No credential rotation headaches.  
  * Least-privilege claims (you can scope by repo, env, branch).  
  * Leaked token becomes useless after the job dies.  
* **Reality check for Vercel.** Vercel’s own OIDC support is aimed at *its* functions calling *your* back-end services, not at GitHub → Vercel deploys; you still need a `VERCEL_TOKEN` today. There’s an open feature request for token-less Vercel deploys via GitHub OIDC, but it isn’t shipped yet. citeturn9search1  
* **Where to start.** Use OIDC where it’s mature (e.g., your AWS S3, KMS, or Supabase keys). Keep the Vercel token until they flip the switch.

---

### 2 — Commit lint + Danger JS (PR hygiene)

| Tool | What it catches | Where it runs |
|------|-----------------|---------------|
| **commitlint** | Enforces Conventional Commits (`feat:`, `fix:`, etc.) so auto-changelogs & semantic-versioning work. | `git commit` (`commit-msg` hook) **and** a CI check. |
| **Danger JS** | Opinionated PR bot: filesize bloat, missing tests, no changelog, “TODO” in code, etc. | A GitHub Actions step that comments on the PR. |

**Danger in one job**

```yml
- name: Danger
  uses: danger/danger-js@9.1.6
  env:
    GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
``` citeturn7view0L47-L52

Write your rules in `dangerfile.ts`, e.g. fail if PR changes > 500 LOC or if a component lacks a story.

---

### 3 — Local pre-commit workflow with Husky

```bash
# deps
npm i -D husky lint-staged @commitlint/{cli,config-conventional}

# bootstrap hooks
npx husky init        # adds .husky/
npm pkg set scripts.lint="next lint"        # or eslint --fix
npm pkg set lint-staged."*.{js,ts,tsx}"="npm run lint --"

# commit-message lint
echo 'npx --no-install commitlint --edit "$1"' > .husky/commit-msg
```
citeturn8view0L2-L5

* **How it plays out for a new dev**

  1. `git clone … && npm ci`  
  2. Husky auto-installs hooks (via the post-install script it added).  
  3. On `git commit`, lint-staged runs ESLint/Prettier on staged files; commitlint rejects bad messages instantly.  
  4. Push → CI → Danger bot reviews PR.

That gives you the same guardrails you see at Stripe, Retool, and other YC favorites—clean history, green builds, no nit-pick reviews.

---

## User

OK, what about like in our various stages? Are we correctly running tests at the appropriate branches or should we be running more tests earlier or less test earlier on and more test later on etc. kind of like what's the thinking here should things have to pass tests and linking before they even get into the develop branch thus making those less relevant on the develop branch or should they not and we just add them on the developer they kind of walk me through how that should look and how in-depth the test should be on each step and the lighthouse checks and security scanning and everything else

---

## Assistant

**Mr. White—where the checks run now**

| Stage | What’s running today | Lines |
|-------|----------------------|-------|
| **PR → _develop_** | `typecheck`, ESLint, Jest, build, smoke Playwright, Lighthouse budgets, `audit-ci` citeturn5file3L37-L40turn5file3L54-L60turn5file3L67-L68 |
| **_develop_ auto-promote → preview** | _same build_ is pushed to Vercel; no extra tests (just the promotion logic) |
| **_preview_** | full desktop+mobile Playwright suite, visual-regression, multipage Lighthouse, bundle-size, ZAP DAST, dep audit citeturn5file7L51-L55turn5file7L56-L58turn5file7L60-L67turn5file7L71-L79turn5file7L81-L82 |
| **_main_ (prod)** | local build → deploy; no tests after build ﻿citeturn5file1L37-L45 |
| **CodeQL** | runs on every branch + weekly cron ﻿citeturn5file12L14-L18 |

---

### Industry pattern (and what I’d tweak)

| Gate | Goal | What to run |
|------|------|------------|
| **Pre-merge (_feature → develop_ PR)** | Fail *fast*; keep the develop branch green. | ▸ `typecheck`, ESLint, Jest/<1 min unit suite<br>▸ **no** build, **no** deploy |
| **_develop_** | Integrate features; smoke-test the app. | ▸ `npm run build`<br>▸ smoke Playwright (1-2 happy paths)<br>▸ short Lighthouse budgets<br>▸ dep audit (high+) |
| **_preview_** | Full dress rehearsal. | ▸ full Playwright matrix<br>▸ visual regression<br>▸ multipage Lighthouse + bundle size<br>▸ ZAP baseline DAST |
| **_main_ deploy** | Keep prod stable. | ▸ _Reuse preview artefact_; deploy<br>▸ after-deploy ping /health and 1 smoke test |

**Why**  
* Faster feedback → happier devs. Making a typo shouldn’t wait for a build + Vercel upload to fail.  
* Expensive checks (E2E, DAST) only run once per commit, not three times.  
* Keeping *develop* always green means auto-promotion stays trustworthy.

---

### Concrete changes

1. **Add `web-pr-verify.yml`** (if not already) that runs lint + unit tests only on `pull_request` targeting `develop`.  
2. **Drop lint/unit from `develop-ci.yml`; leave build + smoke + light Lighthouse.**  
3. **Cache Playwright & node_modules** so the preview job stays under 10 min.  
4. **Upload the `.vercel/output` artefact from preview and re-use it in `production-deploy.yml`;** drop the second `npm run build`.  
5. **Optionally enforce “Require status checks to pass”** on the `develop` branch so nothing merges dirty.

Follow that pyramid and you’re hitting the same cadence Stripe, Retool, and YC’s darlings use: quick failures, heavy tests once, production calm.

---

## User

Okay, so I like your set of recommendations. I also want to implement CommitLint in Danger.js, and then we'll ignore the OIDC for now since Vercel doesn't support it. Can you go ahead and write a concise AI prompt for Cloud Code to go and implement these changes? Also include updating required status checks to pass on the develop branch

---

## Assistant

**Cloud Code prompt (copy-paste)**

```
# Objective
Refactor the Jovie CI pipeline, add CommitLint + Danger, and tighten branch-protection rules.

# Steps
1. ▸ Add dev-deps  
   npm i -D @commitlint/{cli,config-conventional} husky lint-staged \
           danger @types/danger

2. ▸ Commit-lint & Husky  
   - echo '{ "extends": ["@commitlint/config-conventional"] }' > .commitlintrc.json  
   - npx husky init                       # creates .husky/ + postinstall
   - echo 'npx --no-install commitlint --edit "$1"' > .husky/commit-msg  
   - npm pkg set lint-staged."*.{js,ts,tsx}"="npm run lint --"  
   - echo 'lint-staged' >> .husky/pre-commit

3. ▸ Danger bot  
   - create dangerfile.ts with:  
     * fail if PR > 500 LOC  
     * warn if `/pages/**` touched but no *.spec.ts added  
   - npm pkg set scripts.danger="danger ci --fail-on-errors --verbose"

4. ▸ Workflows  
   **.github/workflows/pr-verify.yml** (new)  
   - trigger: pull_request→develop  
   - jobs: typecheck, eslint, jest (--maxWorkers=2), commitlint, danger  
   - concurrency: group=${{ github.workflow }}-${{ github.ref }}, cancel-in-progress=true

   **Refactor develop-ci.yml**  
   - drop lint/unit/commitlint (already in PR)  
   - keep build, smoke Playwright (1–2 happy paths), light Lighthouse, audit-ci  
   - upload .vercel/output as artifact  

   **preview-ci.yml**  
   - download artifact or rebuild  
   - full Playwright matrix, multipage Lighthouse, bundle-size, ZAP DAST  
   - vercel deploy --prebuilt (preview)  
   - auto-promote PR to main on success  

   **production-deploy.yml**  
   - download artifact  
   - vercel deploy --prebuilt --prod  
   - curl /api/health and one smoke test after deploy  

   **Shared bits**  
   - extract duplicate steps into .github/workflows/_reusable-build.yml (uses:)  
   - add `concurrency` stanza to every job.  

5. ▸ Branch protection (via gh-CLI)  
   gh api \
     -XPATCH repos/:owner/:repo/branches/develop/protection \
     -f required_status_checks.strict=true \
     -F required_status_checks.contexts='["pr-verify","develop-ci","CodeQL"]'

6. ▸ Commit & push  
   - separate commits: “chore: add commitlint + husky”, “ci: add pr-verify & refactor pipelines”, “chore: danger rules”  

# Done criteria
* PRs must pass **pr-verify** before merging.  
* develop pushes run slim CI + deploy preview.  
* preview pushes run full e2e + perf + security; artefact reused in prod deploy.  
* Only one deployment per commit; no dupes.  
* develop branch now requires pr-verify, develop-ci, CodeQL checks.

```

*(The prompt is deliberately concise and ordered so Cloud Code can execute it step-by-step without further clarification.)*
