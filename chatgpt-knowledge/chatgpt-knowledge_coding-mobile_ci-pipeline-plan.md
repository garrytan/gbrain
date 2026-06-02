---
title: "CI pipeline plan"
type: guide
created: 2025-08-03
updated: 2025-08-03
source: chatgpt-export
topic: coding-mobile
message_count: 9
tags: [chatgpt, knowledge, coding-mobile]
---
# CI pipeline plan

> **Source:** ChatGPT conversation
> **Date:** 2025-08-03T04:39:54Z
> **Messages:** 9
> **Topic:** coding-mobile

## Question

You should be familiar with our preferred CI pipeline from LogYourBody. Now I want to build the CI pipeline for the Jovi app. It's going to be the same concept, but because it is... there's no iOS app, it'll theoretically be a little simpler. What I'm going to do now is include all of our current workflow files for the LogYourBody app, so that you can see. And what I would like you to do is come up with a plan for us to take the best of this and build it into a new set of workflows for the Jovi app. Now because we have no iOS, it means we just need web, Next.js. We want a development branch that is rapid iteration. We want to have all of our features spun out of the development branch. We do our work, and then we open a PR. And when we open the PR, it runs a minimal set of checks. If those pass, it merges them into the development branch automatically. So we'll just auto-merge. So anyone opens up a feature, we'll have a set of auto-checks go through. And we can even let that trigger re

## Answer

Mr. White — here’s a tight plan to translate your LYB CI/CD into a **web‑only (Next.js) pipeline for Jovi**, preserving the “rapid → confidence → release” loops and adding the security gates you want.

---

## Branch model
- **feature/* → PR → dev → (auto‑PR) → preview → PR → main**
- Environments: **dev** (Vercel preview per-PR), **preview** (shared staging), **production** (main).
- Separate **Supabase/Clerk** projects and keys for **preview** vs **production**.

---

## Required checks & gates (policy)
Before anything reaches **main/production**, it **must** have passed:
- **Unit/integration/E2E** tests
- **Typecheck + lint + build**
- **CodeQL (js/ts)** SAST
- **Dependency/security scan** (e.g., `npm audit --audit-level=high` or `oss-index/audit-ci`; optionally Snyk/GHAS alerts)
- **DAST smoke** on the preview URL (basic ZAP baseline or Pa11y/Lighthouse security headers check)
This mirrors your existing CodeQL setup (already includes `javascript-typescript`) and runs on `main/dev/preview` and PRs. fileciteturn0file0

---

## Workflows to create (names mirror your current style)

### 1) **web-pr-verify.yml** (PR → `dev`)
**Trigger:** `pull_request` targeting `dev`  
**Jobs (fast):**
- Node setup (v20) + `npm ci` with cache
- `npm run typecheck`, `npm run lint`, `npm run test -- --ci`
- **Build** (`npm run build`) to catch SSR/edge errors early
- **Vercel Preview deploy** (comment back the URL)
- **Light checks** against preview URL:
  - `/api/health` 200
  - Lighthouse CI performance ≥ threshold on `/`
  - Basic a11y (axe) on `/`
- **Security (fast):** `npm audit` (fail on high/critical)  
**Merge:** **manual** (you review the preview link).  
*This replaces iOS PR checks with web checks; similar structure to your current PR split in the Orchestrator.* fileciteturn0file8

### 2) **web-rapid-loop.yml** (`push` → `dev`)
**Trigger:** `push` on `dev`  
**Jobs (parallel where possible):**
- Typecheck, lint, unit tests, build (cache with Turbo/Next cache)
- **Playwright E2E** against the fresh Vercel preview
- **Lighthouse CI** (performance budgets)
- **Pa11y/axe** a11y sweep on key routes
- **CodeQL (js/ts)** (reuse your CodeQL config) fileciteturn0file0
- **Security scan** (dependency audit)  
**Deploy:** Update the **dev** environment preview (already done by Vercel).  
**Promotion:** After rapid loop is green, **open/refresh an auto‑PR from `dev` → `preview`** (like your `promote-preview.yml` flow), then **enable auto‑merge** once preview checks pass. fileciteturn0file9

### 3) **web-confidence-loop.yml** (`push`/nightly on `preview`)
**Trigger:** `push` on `preview` + nightly cron  
**Jobs (heavier):**
- All rapid checks **plus**:
  - **Playwright E2E** full suite (mobile + desktop)
  - **Visual regression** (Playwright trace/snapshots)
  - **API contract** tests vs **Preview Supabase/Clerk**
  - **DAST baseline** (ZAP baseline scan) on preview URL
  - **Bundle/bloat check** (size-limit)
  - **CodeQL** again (matrix js/ts only) fil

*(Answer truncated — 6157 chars total)*

## Question

Yes create them please

## Answer

Got it, Mr. White. Below are **5 GitHub Actions** you can drop into `.github/workflows/` for Jovi (Next.js on Vercel). They implement your **PR → dev → (auto‑PR) preview → PR → main** flow with lint/tests, E2E, Lighthouse, a11y, **CodeQL gate**, and **security checks**. Placeholders use repo **secrets**.

---

### 1) `web-pr-verify.yml` — PR checks (feature → `dev`)
Runs fast checks, deploys a **Vercel Preview**, comments the URL, and gates merge by checks (manual merge by you).

```yaml
name: PR Web Checks

on:
  pull_request:
    branches: [ dev ]
    types: [opened, synchronize, reopened]

permissions:
  contents: read
  pull-requests: write

jobs:
  pr-verify:
    runs-on: ubuntu-latest
    timeout-minutes: 25
    env:
      VERCEL_TOKEN: ${{ secrets.VERCEL_TOKEN }}
      VERCEL_ORG_ID: ${{ secrets.VERCEL_ORG_ID }}
      VERCEL_PROJECT_ID: ${{ secrets.VERCEL_PROJECT_ID }}
      # Dev env (public + server) for preview deploys
      NEXT_PUBLIC_SUPABASE_URL: ${{ secrets.DEV_NEXT_PUBLIC_SUPABASE_URL }}
      SUPABASE_SERVICE_ROLE_KEY: ${{ secrets.DEV_SUPABASE_SERVICE_ROLE_KEY }}
      NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: ${{ secrets.DEV_NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY }}
      CLERK_SECRET_KEY: ${{ secrets.DEV_CLERK_SECRET_KEY }}

    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: 'npm'

      - run: npm ci

      - name: Typecheck
        run: npm run typecheck --if-present

      - name: Lint
        run: npm run lint --if-present

      - name: Unit tests
        run: npm run test --if-present -- --ci

      - name: Build (SSR sanity)
        run: npm run build

      - name: Vercel pull preview env
        run: npx vercel pull --environment=preview --yes --token "$VERCEL_TOKEN"

      - name: Vercel build (prebuilt artifacts)
        run: npx vercel build --token "$VERCEL_TOKEN"

      - name: Vercel deploy (preview)
        id: vercel
        run: |
          URL=$(npx vercel deploy --prebuilt --token "$VERCEL_TOKEN")
          echo "url=$URL" >> $GITHUB_OUTPUT

      - name: Comment preview URL
        uses: marocchino/sticky-pull-request-comment@v2
        with:
          header: vercel-preview
          message: |
            ✅ Preview deployed: ${{ steps.vercel.outputs.url }}

      - name: Health check
        run: |
          curl -sSfL "${{ steps.vercel.outputs.url }}/api/health" -o /dev/null

      - name: Lighthouse CI (homepage)
        uses: treosh/lighthouse-ci-action@v12
        with:
          urls: ${{ steps.vercel.outputs.url }}
          configPath: .lighthouserc.json
          uploadArtifacts: true
          temporaryPublicStorage: true

      - name: Accessibility (axe via playwright)
        run: |
          npx playwright install --with-deps
          npm run a11y:ci --if-present

      - name: Dependency security (high+)
        run: npx audit-ci --moderate --allowlist "npm:*" || npm audit --audit-level=high
```

---

### 2) `web-r

*(Answer truncated — 14288 chars total)*

## Question

Okay, the YAML files have been added and the scripts have been added. Walk me through the next steps I have to do to get this all working correctly, including any branch protection, any secrets I have to set up, etc.

## Answer

Mr. White — here’s the concise, end‑to‑end checklist to make the new CI/CD work.

---

## 0) Sanity check CodeQL (clean up)
Your current CodeQL matrix still includes **swift/python/ruby**. For Jovi (web‑only), change it to **javascript-typescript** only to cut time/cost and avoid macOS runners. Update the matrix to:
```yaml
strategy:
  matrix:
    include:
      - language: javascript-typescript
        build-mode: none
```

---

## 1) Branches & default flow
1) Create branches:
```bash
git checkout -b dev && git push -u origin dev
git checkout -b preview && git push -u origin preview
# main already exists
```
2) Default branch can stay **main** (recommended), with work happening in **feature/* → PR → dev**.

---

## 2) GitHub repository settings

### A) Workflow permissions
- **Settings → Actions → General → Workflow permissions**: set to **Read and write**.
- **Allow GitHub Actions to create and approve pull requests**: **enabled** (for auto‑promotion dev→preview).

### B) Enable auto‑merge
- **Settings → General → Pull Requests → Enable auto‑merge**: **on** (needed by the promotion workflow).

### C) Environments (optional but recommended)
- Create **production** environment:
  - Require 1 reviewer (you).
  - (Optional) 5–10 minute wait timer.
  - This matches the `environment: production` in `web-release-loop.yml`.

---

## 3) Branch protection rules (required checks)

> Names must match the jobs in the YAMLs you added.

**main**
- Require PR before merging and 1 approval.
- **Required status checks:**
  - `Release Loop (Main) / premerge`
  - **Code scanning alerts: CodeQL**

**preview**
- Require PR before merging (the CI opens it).
- **Required status checks:**
  - `Preview Confidence Loop / confidence`
  - **Code scanning alerts: CodeQL**

**dev**
- Require PR before merging (features → dev).
- **Required status checks:**
  - `PR Web Checks / pr-verify`
  - **Code scanning alerts: CodeQL**
- Allow auto‑merge if all checks pass (you still review on PRs to `dev` as you like).

---

## 4) Secrets to add (Repository → Settings → Secrets and variables → Actions → Secrets)

**Vercel**
- `VERCEL_TOKEN`
- `VERCEL_ORG_ID`
- `VERCEL_PROJECT_ID`

**Dev (used for PR previews and dev rapid loop)**
- `DEV_NEXT_PUBLIC_SUPABASE_URL`
- `DEV_SUPABASE_SERVICE_ROLE_KEY`
- `DEV_NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`
- `DEV_CLERK_SECRET_KEY`

**Preview**
- `PREVIEW_NEXT_PUBLIC_SUPABASE_URL`
- `PREVIEW_SUPABASE_SERVICE_ROLE_KEY`
- `PREVIEW_NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`
- `PREVIEW_CLERK_SECRET_KEY`

**Production**
- `PROD_NEXT_PUBLIC_SUPABASE_URL`
- `PROD_SUPABASE_SERVICE_ROLE_KEY`
- `PROD_NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`
- `PROD_CLERK_SECRET_KEY`

> Tip: keep **public** keys in Vercel envs too so local/hosted configs match.

---

## 5) Vercel setup

1) In Vercel, create the **Jovi** project and connect the GitHub repo.
2) **Project Settings → Git**:
   - Production Branch: **main**
3) **Environment Variables** in Vercel:
   - **Preview**: set your **DEV/Previ

*(Answer truncated — 6046 chars total)*

## Question

Should we add a depend.automerge workflow?

## Question

Should we add a depend.automerge workflow?

## Answer

Yes—with guardrails.

You already have `dependabot-auto-merge.yml`. I recommend **keeping it**, but tune it for Jovi’s web checks and limit scope:

**Policy**
- Auto‑merge **Dependabot PRs** that are **npm or GitHub Actions**, **semver patch/minor**, and **pass PR Web Checks + CodeQL**.
- **Never** auto‑merge majors; require human review.
- **Target branch:** `dev` only. (Promotion → `preview` still runs our heavier gates.)
- **Security updates**: allow auto‑merge if checks pass (high priority).

**Dependabot config (`.github/dependabot.yml`)**
```yaml
version: 2
updates:
  - package-ecosystem: npm
    directory: "/"
    schedule: { interval: daily }
    open-pull-requests-limit: 10
    labels: [dependencies, npm]
    versioning-strategy: increase-if-necessary
    commit-message: { prefix: "deps(npm)" }
  - package-ecosystem: github-actions
    directory: "/"
    schedule: { interval: weekly }
    labels: [dependencies, gha]
    commit-message: { prefix: "deps(gha)" }
```

**Auto‑merge workflow (`.github/workflows/dependabot-auto-merge.yml`)**
(Replace your existing file with this or update it similarly.)
```yaml
name: Dependabot Auto‑Merge

on:
  pull_request_target:
    types: [opened, edited, synchronize, labeled, unlabeled, ready_for_review]
  check_suite:
    types: [completed]

permissions:
  contents: write
  pull-requests: write

jobs:
  auto-merge:
    if: >
      github.actor == 'dependabot[bot]' &&
      github.base_ref == 'dev'
    runs-on: ubuntu-latest

    steps:
      - name: Fetch metadata
        id: meta
        uses: dependabot/fetch-metadata@v2
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}

      # Require only patch/minor OR security updates
      - name: Ensure patch/minor or security
        run: |
          ALLOWED=false
          if [[ "${{ steps.meta.outputs.update-type }}" == "version-update:semver-patch" || \
                "${{ steps.meta.outputs.update-type }}" == "version-update:semver-minor" || \
                "${{ steps.meta.outputs.dependency-type }}" == "direct:security" ]]; then
            ALLOWED=true
          fi
          echo "allowed=$ALLOWED" >> $GITHUB_OUTPUT

      - name: Wait for required checks
        uses: lewagon/wait-on-check-action@v1.3.4
        with:
          ref: ${{ github.event.pull_request.head.sha || github.sha }}
          repo-token: ${{ secrets.GITHUB_TOKEN }}
          wait-interval: 10
          check-regexp: >
            (PR Web Checks / pr-verify|Code scanning results / CodeQL)
          allowed-conclusions: success
          timeout-minutes: 45

      - name: Enable auto-merge (squash)
        if: ${{ steps.meta.outputs.update-type != '' && fromJSON(steps.ensure.outputs.allowed) }}
        uses: peter-evans/enable-pull-request-automerge@v3
        with:
          token: ${{ secrets.GITHUB_TOKEN }}
          pull-request-number: ${{ github.event.pull_request.number }}
          merge-method: squash
```

**Branch protection**
- On **`dev`**, keep required 

*(Answer truncated — 3519 chars total)*
