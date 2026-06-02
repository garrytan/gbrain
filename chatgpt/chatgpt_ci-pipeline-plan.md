---
title: "CI pipeline plan"
type: essay
created: 2025-08-03
updated: 2025-08-03
source: chatgpt-export
conversation_id: 688ee819-3350-8331-9936-6434918525b7
message_count: 9
tags: [chatgpt, import, code, long-form]
---
# CI pipeline plan

> Conversation ID: 688ee819-3350-8331-9936-6434918525b7
> Created: 2025-08-03T04:39:54Z
> Updated: 2025-08-03T06:18:55Z
> Messages: 9

---

## User

You should be familiar with our preferred CI pipeline from LogYourBody. Now I want to build the CI pipeline for the Jovi app. It's going to be the same concept, but because it is... there's no iOS app, it'll theoretically be a little simpler. What I'm going to do now is include all of our current workflow files for the LogYourBody app, so that you can see. And what I would like you to do is come up with a plan for us to take the best of this and build it into a new set of workflows for the Jovi app. Now because we have no iOS, it means we just need web, Next.js. We want a development branch that is rapid iteration. We want to have all of our features spun out of the development branch. We do our work, and then we open a PR. And when we open the PR, it runs a minimal set of checks. If those pass, it merges them into the development branch automatically. So we'll just auto-merge. So anyone opens up a feature, we'll have a set of auto-checks go through. And we can even let that trigger reversal deploy. Actually, we should let that trigger reversal deploy, so that we can check that link. And then assuming it passes all those checks... I guess no, I guess it shouldn't auto-merge. It opens up a PR, we check that deployment. It runs the deployment through some basic checks, like I guess lint and some tests and stuff. And then it deploys to reversal, and we get our preview link. And then I can check that preview link. And then when we manually merge in the PR request, it merges into the develop branch. When we manually merge in the PR request, it merges into the develop branch. Develop branch triggers a set of more intense checks. Assuming it passes those, it merges to the preview branch. The preview branch then... It opens a PR, and it auto-merges into the preview branch. And then the preview branch is basically... Once we get to the preview branch, we've passed all of the checks then. And we are confident that that is good to go to main. It opens up, it should run even more checks, I guess, and then open up a PR. And then it opens up that PR, and then we manually decide if we want to merge to the main branch. And when it merges to the main branch, that deploys to production. We use a development environment. We use separate super base instances and clerk instances for development and production. And we will... And we will... What else? Yeah, that's basically how I'm seeing it. I want you to look at that. I want you to think about what big Y Combinator companies are doing and stuff. And think if there's anything else we should add. Anything we should take away. Anything we should do differently than what I just said. How we can improve upon this. And then also make sure that... Before anything can go to production, it needs to have passed... All of the tests and everything. And the code QL analysis. And also, it should have passed a security check. So there should be a security workflow that goes on that too. To prevent us from ever merging something that's unsecured to production.

---

## Assistant

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
  - **CodeQL** again (matrix js/ts only) fileciteturn0file0
- **Gate:** If all pass, mark preview “green”.  
*This parallels your iOS Confidence Loop idea but for web.* fileciteturn0file2

### 4) **web-release-loop.yml** (`push` → `main`)
**Trigger:** `pull_request` to `main` (manual approval), then `push` on `main`  
**Pre‑merge required checks:**
- All **Confidence** checks
- **CodeQL** success on the PR
- **Security scan** clean
**Deploy:** On merge to `main`, **deploy to Vercel Production** with GitHub **environment protection** (require reviewer).  
*Your iOS “release loop validates preview green before release”; we mirror that for web.* fileciteturn0file5

### 5) **orchestrator.yml** (optional, keeps one entry point)
Keep a slimmed **CI/CD Orchestrator** that:
- Detects **web changes**
- Routes to **web‑rapid**, **web‑confidence**, **web‑release**, or **PR checks** by branch, like your current monorepo router. fileciteturn0file8

### 6) **codeql-analysis.yml** (reuse)
- Keep as is, but **drop Swift/Python/Ruby** matrix for Jovi; keep **`javascript-typescript`**. Triggers remain on `main/dev/preview` + PR + weekly cron. fileciteturn0file0

### 7) **dependabot-auto-merge.yml** (reuse)
- Keep pattern: allow **Dependabot** to auto‑merge **patch/minor** once **PR Web Checks** or orchestrated checks pass; comment for majors. Update check names to web equivalents. fileciteturn0file1

### 8) **promote-preview.yml** (reuse with web text)
- Same promotion logic `dev → preview`, generated PR body, auto‑merge when checks pass. Update wording to Jovi/web only. fileciteturn0file9

---

## Secrets / config (per environment)
- **Vercel:** `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`
- **Dev/Preview:** `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY` (preview set)
- **Prod:** same keys, **production** values (scoped to `production` environment)
- **GH Advanced Security/CodeQL:** keep existing config. fileciteturn0file0

---

## What we’re *changing* vs. LYB
- Remove all iOS workflows; **web-only loops** remain (we mirrored your Orchestrator/Promotion patterns for simplicity). fileciteturn0file8 fileciteturn0file9
- Hard gate to **block production** unless **CodeQL + security + tests** are green (enforce via **branch protection** required checks).
- Add **DAST baseline** and **a11y/perf budgets** in Confidence/Release loops.
- Keep **Dependabot auto‑merge** for safe updates, tied to passing web checks. fileciteturn0file1

---

## Minimal required “required checks” (set in branch protection)
- `PR Web Checks`
- `CodeQL` (Code Scanning)
- `web-confidence` (or individual jobs: E2E, Lighthouse, DAST)
- (Optional) `ci-summary` if you keep an orchestrator summary like today. fileciteturn0file8

---

## Next steps
1) Confirm you want **orchestrator-style** routing (single entry) vs **standalone** web workflows.  
2) Give me your **Vercel** and **Preview/Prod** env var names, and I’ll draft the YAMLs.  
3) I’ll also port **promote‑preview** and **dependabot** naming to the web check names.

If you want, I can generate the initial four web workflow files now.

---

## User

Yes create them please

---

## Assistant

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

### 2) `web-rapid-loop.yml` — pushes to `dev`
Runs broader checks + **Playwright E2E** against the fresh preview. When green, **opens/refreshes PR** from `dev` → `preview` and enables **auto‑merge**.

```yaml
name: Dev Rapid Loop

on:
  push:
    branches: [ dev ]
  workflow_dispatch: {}

permissions:
  contents: write
  pull-requests: write

jobs:
  rapid:
    runs-on: ubuntu-latest
    timeout-minutes: 40
    env:
      VERCEL_TOKEN: ${{ secrets.VERCEL_TOKEN }}
      VERCEL_ORG_ID: ${{ secrets.VERCEL_ORG_ID }}
      VERCEL_PROJECT_ID: ${{ secrets.VERCEL_PROJECT_ID }}
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

      - run: npm run typecheck --if-present
      - run: npm run lint --if-present
      - run: npm run test --if-present -- --ci
      - run: npm run build

      - name: Vercel pull preview env
        run: npx vercel pull --environment=preview --yes --token "$VERCEL_TOKEN"

      - name: Vercel build
        run: npx vercel build --token "$VERCEL_TOKEN"

      - name: Vercel deploy (preview)
        id: vercel
        run: |
          URL=$(npx vercel deploy --prebuilt --token "$VERCEL_TOKEN")
          echo "url=$URL" >> $GITHUB_OUTPUT

      - name: Playwright E2E (smoke)
        run: |
          npx playwright install --with-deps
          BASE_URL="${{ steps.vercel.outputs.url }}" npm run e2e:smoke --if-present

      - name: Lighthouse budgets
        uses: treosh/lighthouse-ci-action@v12
        with:
          urls: ${{ steps.vercel.outputs.url }}
          configPath: .lighthouserc.json
          uploadArtifacts: true
          temporaryPublicStorage: true

      - name: Dependency security (high+)
        run: npx audit-ci --moderate --allowlist "npm:*" || npm audit --audit-level=high

  promote:
    needs: rapid
    if: ${{ success() }}
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Create/Update PR dev → preview
        uses: peter-evans/create-pull-request@v6
        with:
          title: "Promote dev → preview"
          body: "Automated promotion from dev."
          branch: promote/dev-to-preview
          base: preview
          delete-branch: true
          labels: ci, promotion

      - name: Enable auto-merge (squash)
        uses: peter-evans/enable-pull-request-automerge@v3
        with:
          pull-request-number: ${{ steps.create_pull_request.outputs.pull-request-number }}
          merge-method: squash
```

---

### 3) `web-confidence-loop.yml` — `preview` (heavier)
Full E2E (desktop+mobile), visual diffs, **ZAP baseline DAST**, bundle size. Runs on push to `preview` (i.e., when the auto‑merged PR lands) and nightly.

```yaml
name: Preview Confidence Loop

on:
  push:
    branches: [ preview ]
  schedule:
    - cron: "0 8 * * *"  # daily 08:00 UTC
  workflow_dispatch: {}

permissions:
  contents: read
  security-events: write

jobs:
  confidence:
    runs-on: ubuntu-latest
    timeout-minutes: 60
    env:
      VERCEL_TOKEN: ${{ secrets.VERCEL_TOKEN }}
      VERCEL_ORG_ID: ${{ secrets.VERCEL_ORG_ID }}
      VERCEL_PROJECT_ID: ${{ secrets.VERCEL_PROJECT_ID }}
      NEXT_PUBLIC_SUPABASE_URL: ${{ secrets.PREVIEW_NEXT_PUBLIC_SUPABASE_URL }}
      SUPABASE_SERVICE_ROLE_KEY: ${{ secrets.PREVIEW_SUPABASE_SERVICE_ROLE_KEY }}
      NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: ${{ secrets.PREVIEW_NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY }}
      CLERK_SECRET_KEY: ${{ secrets.PREVIEW_CLERK_SECRET_KEY }}

    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: 'npm'

      - run: npm ci
      - run: npm run build

      - name: Vercel pull preview env
        run: npx vercel pull --environment=preview --yes --token "$VERCEL_TOKEN"

      - name: Vercel build
        run: npx vercel build --token "$VERCEL_TOKEN"

      - name: Vercel deploy (preview)
        id: vercel
        run: |
          URL=$(npx vercel deploy --prebuilt --token "$VERCEL_TOKEN")
          echo "url=$URL" >> $GITHUB_OUTPUT

      - name: Playwright E2E (full, desktop+mobile)
        run: |
          npx playwright install --with-deps
          BASE_URL="${{ steps.vercel.outputs.url }}" npm run e2e:full --if-present

      - name: Visual regression
        run: |
          BASE_URL="${{ steps.vercel.outputs.url }}" npm run vr:ci --if-present

      - name: Lighthouse (budgeted)
        uses: treosh/lighthouse-ci-action@v12
        with:
          urls: |
            ${{ steps.vercel.outputs.url }}
            ${{ steps.vercel.outputs.url }}/auth/sign-in
            ${{ steps.vercel.outputs.url }}/links/demo
          configPath: .lighthouserc.json
          uploadArtifacts: true
          temporaryPublicStorage: true

      - name: Bundle size (size-limit)
        run: npx size-limit || (echo "Bundle size exceeded" && exit 1)

      - name: ZAP Baseline DAST
        uses: zaproxy/action-baseline@v0.10.0
        with:
          target: ${{ steps.vercel.outputs.url }}
          rules_file_name: '.zap/rules.tsv'
          cmd_options: '-a'

      - name: Dependency security (high+)
        run: npx audit-ci --moderate --allowlist "npm:*" || npm audit --audit-level=high
```

---

### 4) `web-release-loop.yml` — PR to `main` and deploy on merge
`main` PR requires **all checks** (tests, Lighthouse/a11y, Playwright, **CodeQL**, security). On merge, deploys **Vercel Production**.

```yaml
name: Release Loop (Main)

on:
  pull_request:
    branches: [ main ]
    types: [opened, synchronize, reopened]
  push:
    branches: [ main ]

permissions:
  contents: read
  deployments: write
  security-events: write

jobs:
  premerge:
    if: github.event_name == 'pull_request'
    runs-on: ubuntu-latest
    timeout-minutes: 60
    env:
      VERCEL_TOKEN: ${{ secrets.VERCEL_TOKEN }}
      VERCEL_ORG_ID: ${{ secrets.VERCEL_ORG_ID }}
      VERCEL_PROJECT_ID: ${{ secrets.VERCEL_PROJECT_ID }}
      NEXT_PUBLIC_SUPABASE_URL: ${{ secrets.PREVIEW_NEXT_PUBLIC_SUPABASE_URL }}
      SUPABASE_SERVICE_ROLE_KEY: ${{ secrets.PREVIEW_SUPABASE_SERVICE_ROLE_KEY }}
      NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: ${{ secrets.PREVIEW_NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY }}
      CLERK_SECRET_KEY: ${{ secrets.PREVIEW_CLERK_SECRET_KEY }}

    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: 'npm' }
      - run: npm ci
      - run: npm run typecheck --if-present
      - run: npm run lint --if-present
      - run: npm run test --if-present -- --ci
      - run: npm run build

      - name: Vercel pull preview env
        run: npx vercel pull --environment=preview --yes --token "$VERCEL_TOKEN"

      - name: Vercel build
        run: npx vercel build --token "$VERCEL_TOKEN"

      - name: Vercel deploy (preview for PR)
        id: vercel
        run: |
          URL=$(npx vercel deploy --prebuilt --token "$VERCEL_TOKEN")
          echo "url=$URL" >> $GITHUB_OUTPUT

      - name: Playwright E2E (full)
        run: |
          npx playwright install --with-deps
          BASE_URL="${{ steps.vercel.outputs.url }}" npm run e2e:full --if-present

      - name: Lighthouse + a11y
        uses: treosh/lighthouse-ci-action@v12
        with:
          urls: ${{ steps.vercel.outputs.url }}
          configPath: .lighthouserc.json
          uploadArtifacts: true
          temporaryPublicStorage: true

      - name: ZAP Baseline DAST
        uses: zaproxy/action-baseline@v0.10.0
        with:
          target: ${{ steps.vercel.outputs.url }}
          cmd_options: '-a'

      - name: Dependency security (high+)
        run: npx audit-ci --moderate --allowlist "npm:*" || npm audit --audit-level=high

  deploy:
    if: github.event_name == 'push'
    runs-on: ubuntu-latest
    timeout-minutes: 30
    environment:
      name: production
      url: ${{ steps.vercel.outputs.prod_url }}
    env:
      VERCEL_TOKEN: ${{ secrets.VERCEL_TOKEN }}
      VERCEL_ORG_ID: ${{ secrets.VERCEL_ORG_ID }}
      VERCEL_PROJECT_ID: ${{ secrets.VERCEL_PROJECT_ID }}
      NEXT_PUBLIC_SUPABASE_URL: ${{ secrets.PROD_NEXT_PUBLIC_SUPABASE_URL }}
      SUPABASE_SERVICE_ROLE_KEY: ${{ secrets.PROD_SUPABASE_SERVICE_ROLE_KEY }}
      NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: ${{ secrets.PROD_NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY }}
      CLERK_SECRET_KEY: ${{ secrets.PROD_CLERK_SECRET_KEY }}

    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: 'npm' }
      - run: npm ci
      - run: npm run build

      - name: Vercel pull prod env
        run: npx vercel pull --environment=production --yes --token "$VERCEL_TOKEN"

      - name: Vercel build (prod)
        run: npx vercel build --prod --token "$VERCEL_TOKEN"

      - name: Vercel deploy (prod)
        id: vercel
        run: |
          URL=$(npx vercel deploy --prebuilt --prod --token "$VERCEL_TOKEN")
          echo "prod_url=$URL" >> $GITHUB_OUTPUT

      - name: Output prod URL
        run: echo "Deployed: ${{ steps.vercel.outputs.prod_url }}"
```

---

### 5) `promote-preview.yml` — manual button (optional)
Handy **“Promote dev → preview”** button if you want it outside the auto‑promotion.

```yaml
name: Promote Dev → Preview (Manual)

on:
  workflow_dispatch: {}

permissions:
  contents: write
  pull-requests: write

jobs:
  promote:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: peter-evans/create-pull-request@v6
        with:
          title: "Promote dev → preview"
          body: "Manual promotion trigger."
          branch: promote/dev-to-preview
          base: preview
          delete-branch: true
          labels: ci, promotion
      - uses: peter-evans/enable-pull-request-automerge@v3
        with:
          pull-request-number: ${{ steps.create_pull_request.outputs.pull-request-number }}
          merge-method: squash
```

---

## Enforce the gates
- Keep your existing **`codeql-analysis.yml`** (JS/TS only). Make **Code Scanning** a **required check** for PRs to `main`.  
- Add branch protection required checks (examples):  
  - `PR Web Checks`  
  - `Dev Rapid Loop / rapid`  
  - `Preview Confidence Loop / confidence`  
  - **Code scanning: CodeQL**  
  - Optionally “ZAP Baseline DAST” and “Lighthouse CI”.

---

## Secrets to set
- `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`
- Dev: `DEV_*` Supabase/Clerk
- Preview: `PREVIEW_*` Supabase/Clerk
- Prod: `PROD_*` Supabase/Clerk

---

## Package scripts (add as needed)
```json
{
  "scripts": {
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "lint": "next lint",
    "build": "next build",
    "test": "vitest run",
    "e2e:smoke": "playwright test -g @smoke",
    "e2e:full": "playwright test",
    "a11y:ci": "playwright test -g @a11y"
  }
}
```

If you want these committed as files now, tell me the repo path and I’ll output them as downloadable artifacts or open a PR.

---

## User

Okay, the YAML files have been added and the scripts have been added. Walk me through the next steps I have to do to get this all working correctly, including any branch protection, any secrets I have to set up, etc.

---

## Assistant

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
   - **Preview**: set your **DEV/Preview** values (public + server).
   - **Production**: set your **PROD** values.
4) If you prefer the Actions‑driven deploys only, leave Vercel’s “automatic deploy on push” ON (it will deploy on the same pushes our actions make). Our workflows also run `vercel build/deploy` explicitly for consistent URLs in comments.

---

## 6) Supabase & Clerk
- Create **separate projects/instances** for **dev/preview** and **prod**.
- Copy the correct URLs/keys into both **GitHub Secrets** and **Vercel envs**.

---

## 7) Repo files you should add (if not present)

- **Health endpoint** used by PR checks:
  - `/pages/api/health.ts` returning 200 JSON `{ ok: true }`.

- **Playwright**:
  - `playwright.config.ts` with `grep` tags `@smoke` and `@a11y`.
  - Tests using `process.env.BASE_URL` (set by the workflow).

- **Lighthouse**:
  - `.lighthouserc.json` with performance budgets (e.g., TTI, LCP).
  
- **ZAP**:
  - `.zap/rules.tsv` (to downgrade noise like missing sitemap/robots while still failing on real issues).

- **Bundle size**:
  - `package.json` `size-limit` config and a minimal `size-limit` setup.

---

## 8) Dependabot (optional but recommended)
- Ensure `.github/dependabot.yml` exists for `npm` and `github-actions`.
- Map auto‑merge conditions to require `PR Web Checks` success.
- Keep your `dependabot-auto-merge.yml` (it will now rely on the new job names).

---

## 9) Try the pipeline (dry run)

1) **Feature flow**
   - Create `feature/xyz`, push, open PR → **dev**.
   - CI posts a **Vercel Preview URL** on the PR.
   - Checks: typecheck, lint, unit, build, quick Lighthouse/a11y, security.
   - You review the preview; if good, **merge** PR → **dev**.

2) **Dev → Preview promotion**
   - `push` to **dev** triggers **Dev Rapid Loop** (E2E smoke, Lighthouse budgets).
   - On success it opens a PR **dev → preview** and **auto‑merges** after preview checks.
   - **Preview Confidence Loop** runs (full E2E, visual, ZAP, size‑limit).

3) **Preview → Main**
   - Open PR **preview → main** (manual).
   - **Release Loop / premerge** runs (full checks incl. ZAP).
   - **CodeQL** must be green.
   - Merge → **main** triggers production deploy; URL is printed by the job and appears in Vercel.

---

## 10) Optional hardening
- Require **signed commits** on `main`.
- Add **required reviewers** for the **production** environment.
- Add **cron** security jobs (e.g., weekly audit, Lighthouse, Playwright smoke against preview).
- Set **alerts** in GitHub Code Scanning and Dependabot.

---

## 11) Common gotchas (quick fixes)
- If PR comments don’t appear: ensure **Workflow permissions = Read and write**.
- If auto‑merge fails: ensure **Enable auto‑merge** is ON and the bot/user has permission.
- If Vercel CLI can’t deploy: verify `VERCEL_TOKEN/ORG_ID/PROJECT_ID`.
- If CodeQL blocks on non‑JS languages: remove them per step **0** above.

---

If you want, I can:
- Submit a PR that trims CodeQL to JS/TS and adds minimal configs for **Lighthouse**, **Playwright**, **ZAP**, and **size‑limit**.
- Add sample `/api/health`.

---

## User

Should we add a depend.automerge workflow?

---

## User

Should we add a depend.automerge workflow?

---

## Assistant

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
- On **`dev`**, keep required checks:
  - `PR Web Checks / pr-verify`
  - **Code scanning: CodeQL**
- Turn **Enable auto‑merge** ON in repo settings.

**Why this setup**
- Keeps your **human review** on majors and all merges to `preview`/`main`.
- Ensures dependency bumps still traverse **our normal dev→preview gates** before prod.
- Uses CodeQL + PR checks as a **security gate** even for Dependabot.

If you prefer *label‑gated* auto‑merge (e.g., only when you add `automerge`), I’ll switch the condition to require that label instead of semver.
