---
title: "Auto-promote blockers check"
type: essay
created: 2025-08-08
updated: 2025-08-08
source: chatgpt-export
topic: music-production
message_count: 18
tags: [chatgpt, knowledge, music-production]
---
# Auto-promote blockers check

> **Source:** ChatGPT conversation
> **Date:** 2025-08-08T00:09:50Z
> **Messages:** 18
> **Topic:** music-production

## Question

Check this ci and see if there's any reason that things would fail auto promote. Like circularly logic or steps running before other checks have finished. Also check branch protections to make sure nothing will be blocked.

## Answer

Mr. White — short version: **yes, you’ve got multiple hard blockers** that will stop auto-promote, plus a couple logic bugs.

# What will block auto-promote

- **Branch protections require checks you don’t run.** You require `security-audit`, `e2e:smoke`, `e2e:full`, and `a11y:ci`, but those jobs are commented out / not defined anywhere. That alone blocks merges. fileciteturn0file5 fileciteturn0file3 fileciteturn0file2 fileciteturn0file4  
- **CodeQL context name mismatch.** You require `codeql` (lowercase) in branch protection, but the workflow emits matrixed checks like “CodeQL / Analyze (javascript-typescript)”. That won’t match. fileciteturn0file5 fileciteturn0file0  
- **“Required workflows” are mis-scoped.** You require `develop-ci.yml` and `preview-ci.yml` on PRs, but those only run on **push** to their branches, not on PR events—so PRs can never satisfy them. fileciteturn0file5 fileciteturn0file2 fileciteturn0file3  
- **Required deployments set to both `production` and `preview` for all branches.** A PR into `preview` can’t satisfy a `production` deployment requirement; this will deadlock merges. fileciteturn0file5  
- **Security & code-quality rules add more non-existent checks** (e.g., `prettier`, `eslint`, `lighthouse`, `performance`, `test-coverage`, `unit-tests`, `integration-tests`, `e2e-tests`). Unless you emit all of these, merges will be blocked. fileciteturn0file6 fileciteturn0file7

# Logic/circular issues

- **PR verification uses a bad context var.** You reference `${{ github.head_sha }}` (not a thing on `pull_request`). Should be `${{ github.event.pull_request.head.sha }}`; otherwise the verify job can fail spuriously and block. fileciteturn0file4  
- **Dependabot wait pattern doesn’t match your checks.** You wait on `(CodeQL|pr-verify)`, but your workflow is named “PR Verification” with jobs `verify-pr-source|build|test|lint|typecheck`. This won’t ever match → no auto-merge. fileciteturn0file1 fileciteturn0file4  
- **Preview → main “existing PR” path is wrong.** In `preview-ci.yml` you don’t reset the PR branch to `preview` like you do for develop→preview. You just `git checkout -b auto-promote/main` (from whatever HEAD is), then push, which can drift or fail. Mirror the develop flow (`fetch`, `checkout -B … origin/main`, `reset --hard preview`). fileciteturn0file3 fileciteturn0file2  
- **Promote jobs don’t wait for deploy.** Both promotion jobs only `needs: [build]`. That’s fine (branch protection will gate), but if you expect PRs to open *after* deploys, add an explicit wait or make `promote` depend on `deploy`. fileciteturn0file2 fileciteturn0file3

# Minimal fixes (to unblock)

1) **Trim branch protection to checks you actually emit (per branch):**  
- For `preview` and `main` PRs keep: `build`, `test`, `lint`, `typecheck`, and the PR-verify job(s). Remove `security-audit`, `e2e:*`, `a11y:ci` (until implemented). Fix CodeQL to the exact check names your repo em

*(Answer truncated — 4091 chars total)*

## Question

Reaudit the updated files

## Answer

Mr. White — re-audit done. Short verdict: **much cleaner**, but you still have **3 hard blockers** for hands-off auto-promote, plus a couple soft frictions.

# What’s fixed
- PR source/ancestor checks now use the correct PR SHA. ✔️ fileciteturn1file4  
- Preview→main promotion now resets from `origin/main` and hard-resets to `origin/preview`. ✔️ fileciteturn1file3

# Hard blockers (will stop auto-promote)
1) **Develop PRs can’t pass required checks.**  
   Your branch rules target **develop, preview, main**, but the PR checks (`build/test/lint/typecheck/verify-pr-source`) only run for PRs **into preview & main**, not develop. Any PR to develop (including Dependabot) can’t satisfy required contexts or the required workflow `web-pr-verify.yml`. ❌ fileciteturn1file5 fileciteturn1file4

2) **CodeQL context mismatch.**  
   Rules require a context named **`analyze`**, but the workflow exposes matrixed checks like **“Analyze (javascript-typescript)”** (capital A, plus variant suffixes). Same mismatch in your Dependabot `check-regexp` (looks for `analyze`, lowercase). This won’t match and will block merges/auto-merge waits. ❌ fileciteturn1file5 fileciteturn1file0 fileciteturn1file8 fileciteturn1file1 fileciteturn1file9

3) **Required review + last-push approval = no bot auto-merge.**  
   Branch rules require **1 review** and **`require_last_push_approval: true`**. Your promotion PRs are pushed by `github-actions[bot]`, which can’t approve. Auto-merge will sit forever without a human click. ❌ fileciteturn1file5

# Soft frictions (won’t always block, but will bite)
- **Dependabot waits for checks that never run on develop PRs.** Your regex waits for `(analyze|verify-pr-source|build|test|lint|typecheck)`; none of those exist on develop PRs right now → timeout, no auto-merge. fileciteturn1file1 fileciteturn1file4  
- **Ruleset YAMLs add many non-existent required checks** (`format`, `prettier`, `eslint`, `lighthouse`, `performance`, `unit-tests`, `e2e-tests`, `a11y:ci`, etc.). If these rules are actually applied in GitHub, merges will be blocked until you emit those contexts. (If they’re just docs, ignore.) fileciteturn1file6 fileciteturn1file7  
- **Preview deploy uses a GitHub Environment “Preview.”** If that env has required reviewers, deployments will pause awaiting approval. (If not configured, you’re fine.) fileciteturn1file3

# Minimal changes to unblock
1) **Scope PR checks or branch rules correctly (pick one):**  
   - EITHER: add `develop` to `web-pr-verify.yml` trigger so develop PRs run `build/test/lint/typecheck`. fileciteturn1file4  
   - OR: remove `develop` from `branch-protection.yml` targets (leave preview/main protected), and rely on push CI for develop. fileciteturn1file5

2) **Fix CodeQL contexts everywhere:**  
   - In `branch-protection.yml`, replace `analyze` with the actual emitted contexts, e.g. **`Analyze (javascript-typescript)`** and **`Analyze (actions)`** *or* require the cod

*(Answer truncated — 4063 chars total)*

## Question

Can this be simplified? Should it be?

## Answer

Mr. White — **yes, simplify.** You’ll get fewer moving parts, faster runs, and easier branch-protection wiring.

# What to collapse (and why)
- **Make one CI workflow** for all branches.  
  Today you run the same install/typecheck/lint/test/build steps in *three* places: `develop-ci`, `preview-ci`, and `web-pr-verify`. That’s pure duplication. fileciteturn2file2 fileciteturn2file3 fileciteturn2file4  
  **Plan:** create `.github/workflows/ci.yml` with:
  - `on: [pull_request (develop|preview|main), push (develop|preview)]`
  - one job `ci` that does install → typecheck → lint → test → build (single workspace, one cache).  
  Then delete the build/test/lint/typecheck jobs from `web-pr-verify.yml` (keep only the policy checks). fileciteturn2file4

- **Unify promotion logic.**  
  The `promote` jobs in `develop-ci` and `preview-ci` are near-clones (only from/to differ). fileciteturn2file2 fileciteturn2file3  
  **Plan:** extract that block into a reusable workflow (or composite action) `promote.yml` with inputs `{from, to, head}` and call it from the single CI workflow with:
  - on push to `develop` → promote `develop→preview`
  - on push to `preview` → promote `preview→main`
  Also set `needs: [deploy]` if you want PRs to open only after a successful deploy. fileciteturn2file3

- **Keep CodeQL as-is, just wire protections to the real names.**  
  The job emits **`Analyze (actions)`** and **`Analyze (javascript-typescript)`**; don’t require a fake “codeql/analyze” context. fileciteturn2file0

- **Trim Dependabot to the new contexts.**  
  Your regex already matches the CodeQL names + CI checks. After you collapse to one job, make it `check-regexp: (Analyze \(.+\)|ci)` and you’re done. fileciteturn2file1

# Target end-state (files)
- `ci.yml` → PR & push pipeline (does install/typecheck/lint/test/build; deploys on push; calls promotion). (Replaces `develop-ci.yml` + `preview-ci.yml`.)
- `pr-policy.yml` → **only** the branch ancestry/source checks you already wrote. (Slims `web-pr-verify.yml` to just the “gate”.) fileciteturn2file4
- `codeql.yml` → unchanged. fileciteturn2file0
- `dependabot-auto-merge.yml` → minor regex tweak. fileciteturn2file1

# Should you actually do it?
**Yes.** Fewer workflows → fewer required checks to configure, less chance of drift, faster feedback, and cleaner auto-promote. No loss of control: you still gate PRs with your policy job and can keep environment protections on Preview for deploys.

## Question

ok and how can we enhance it even further so that we move quickly. Id rather move fast right now as we're trying to get th initial map out, then we can start adding more checks to get it stable later.

## Answer

Mr. White — if the goal is **ship fast now**, do this:

# Fast-lane setup (now)
1) **One workflow.** Replace `develop-ci.yml` + `preview-ci.yml` + most of `web-pr-verify.yml` with a single `ci.yml`:
   - `on: pull_request` → branches: `develop, preview, main`
   - `on: push` → branches: `develop, preview`
   - Jobs:
     - `pr-policy` (keep your “only allow auto-promote” checks)
     - `ci-fast` (TypeScript + lint + *optional* lightweight build)
     - `deploy` (only on push to `develop`/`preview`)
     - `promote` (call after deploy or just after build if you want max speed)

2) **Minimal branch protection (temporary).**
   - Required checks on PRs: `pr-policy`, `typecheck`, `lint`. That’s it.
   - **Remove** required deploys, reviews, and CodeQL from PR gating for now.
   - Allow the bot to merge: disable “last push approval” and set required reviews to 0 on the **auto-promote PR pattern**.

3) **Draft/label gating = speed on demand.**
   - Run only `pr-policy` for drafts.
   - When the PR is “Ready for review”, run `ci-fast`.
   - Add a `full-ci` label that triggers tests/build (kept off by default).

   ```yaml
   jobs:
     ci-fast:
       if: ${{ github.event_name != 'pull_request' || github.event.pull_request.draft == false }}
     ci-full:
       if: ${{ github.event_name == 'pull_request' && contains(join(github.event.pull_request.labels.*.name), 'full-ci') }}
   ```

4) **Cancel in progress + skip duplicates.**
   - Keep your `concurrency: cancel-in-progress: true`.
   - Add `fkirc/skip-duplicate-actions@v5` to bail early on identical commits.

5) **Aggressive caching.**
   ```yaml
   - uses: actions/setup-node@v4
     with: { node-version: 20.17, cache: 'npm', cache-dependency-path: '**/package-lock.json' }

   - name: Cache Next build artifacts
     uses: actions/cache@v4
     with:
       path: |
         **/.next/cache
       key: ${{ runner.os }}-next-${{ hashFiles('**/package-lock.json') }}
       restore-keys: ${{ runner.os }}-next-
   ```
   - Build with `TS_NODE_PROJECT` unset + `tsc --noEmit --skipLibCheck` for speed.

6) **Only run when it matters.**
   - Add `paths-ignore` for docs/chore changes to PR & push triggers:
   ```yaml
   on:
     pull_request:
       branches: [develop, preview, main]
       paths-ignore: ['**/*.md', 'docs/**', '.vscode/**', '.github/**']
     push:
       branches: [develop, preview]
       paths-ignore: ['**/*.md', 'docs/**']
   ```

7) **Dependabot: auto-merge quickly.**
   - Wait for `(pr-policy|typecheck|lint)` only; let patch/minor auto-merge immediately when green.

8) **Deploy & promote flow tuned for speed.**
   - On `develop` push: run `build → deploy (Vercel preview) → promote(develop→preview)`.
   - On `preview` push: `build → deploy (Preview env) → promote(preview→main)`.
   - If you want *maximum* velocity, make `promote` `needs: [build]` (don’t wait for deploy). If you want slightly safer, `needs: [deploy]`.

9) **Move CodeQL off the happy path.**
   - Keep CodeQL, but run on a nigh

*(Answer truncated — 3696 chars total)*

## Question

yes

## Answer

Got it, Mr. White. Here’s the **one-file fast lane** + **minimal protections** you can paste in now.

# .github/workflows/ci.yml
```yaml
name: CI

on:
  pull_request:
    branches: [develop, preview, main]
    paths-ignore:
      - '**/*.md'
      - 'docs/**'
      - '.vscode/**'
  push:
    branches: [develop, preview]
    paths-ignore:
      - '**/*.md'
      - 'docs/**'

concurrency:
  group: ci-${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true

jobs:
  pr-policy:
    if: ${{ github.event_name == 'pull_request' }}
    runs-on: ubuntu-latest
    steps:
      - uses: actions/github-script@v7
        with:
          script: |
            const base = context.payload.pull_request.base.ref;
            const head = context.payload.pull_request.head.ref;
            if (base === 'preview' && head !== 'develop') {
              core.setFailed(`Only allow develop -> preview. Got ${head} -> ${base}`);
            } else if (base === 'main' && head !== 'preview') {
              core.setFailed(`Only allow preview -> main. Got ${head} -> ${base}`);
            } else {
              core.info('PR policy OK');
            }

  ci-fast:
    # Draft PRs skip; ready PRs + pushes run fast checks
    if: ${{ github.event_name != 'pull_request' || github.event.pull_request.draft == false }}
    runs-on: ubuntu-latest
    steps:
      - uses: fkirc/skip-duplicate-actions@v5
        with:
          cancel_others: 'true'
      - uses: actions/checkout@v4
        with: { fetch-depth: 2 }
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
          cache-dependency-path: '**/package-lock.json'
      - name: Install
        run: npm ci
      - name: Typecheck
        run: npm run typecheck --if-present
      - name: Lint
        run: npm run lint --if-present

  ci-full:
    name: Full CI (label or push)
    needs: [ci-fast]
    if: ${{ github.event_name == 'push' || (github.event_name == 'pull_request' && contains(github.event.pull_request.labels.*.name, 'full-ci')) }}
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 2 }
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
          cache-dependency-path: '**/package-lock.json'
      - run: npm ci
      - run: npm test --if-present
      - run: npm run build --if-present

  deploy:
    needs: [ci-fast] # change to [ci-full] if you want build/tests first
    if: ${{ github.event_name == 'push' && (github.ref == 'refs/heads/develop' || github.ref == 'refs/heads/preview') }}
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - name: Install Vercel CLI
        run: npm i -g vercel@latest
      - name: Pull env (preview)
        run: vercel pull --yes --environment=preview --token ${{ secrets.VERCEL_TOKEN }}
        env:
          VERCEL_ORG_ID: ${{ secrets.VERCEL_O

*(Answer truncated — 6510 chars total)*

## Question

yes

## Answer

Roger, Mr. White. Here’s the **tiny tweak** so Dependabot only waits on your fast checks and merges instantly when green.

# Patch (minimal)
Change the wait regex from `(CodeQL|pr-verify)` → `(?i)(pr-policy|ci-fast)`.

```diff
-          check-regexp: >
-            (CodeQL|pr-verify)
+          check-regexp: >
+            (?i)(pr-policy|ci-fast)
```

# Drop-in file (paste over `.github/workflows/dependabot-auto-merge.yml`)
```yaml
name: Dependabot Auto-Merge

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
      github.event.pull_request.base.ref == 'develop'
    runs-on: ubuntu-latest
    steps:
      - name: Fetch metadata
        id: meta
        uses: dependabot/fetch-metadata@v2
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}

      - name: Allow only patch/minor & security updates
        id: ensure
        run: |
          ut="${{ steps.meta.outputs.update-type }}"
          sec="${{ steps.meta.outputs.dependency-type }}"
          if [[ "$sec" == "direct:security" ]]; then echo "allowed=true" >> $GITHUB_OUTPUT; exit 0; fi
          if [[ "$ut" =~ ^version-update:semver-(patch|minor)$ ]]; then echo "allowed=true" >> $GITHUB_OUTPUT; exit 0; fi
          echo "allowed=false" >> $GITHUB_OUTPUT

      - name: Wait for fast checks
        if: ${{ fromJSON(steps.ensure.outputs.allowed) }}
        uses: lewagon/wait-on-check-action@v1.3.3
        with:
          repo-token: ${{ secrets.GITHUB_TOKEN }}
          wait-interval: 10
          # Only the fast-lane checks
          check-regexp: >
            (?i)(pr-policy|ci-fast)
          allowed-conclusions: success
          timeout-minutes: 45

      - name: Enable auto-merge (squash)
        if: ${{ fromJSON(steps.ensure.outputs.allowed) }}
        uses: peter-evans/enable-pull-request-automerge@v3
        with:
          token: ${{ secrets.GITHUB_TOKEN }}
          pull-request-number: ${{ github.event.pull_request.number }}
          merge-method: squash
```

# Notes
- This **only** waits for `pr-policy` and `ci-fast`. No CodeQL, no tests. Fast.
- Merges **patch/minor + security** on `develop` automatically; majors stay manual.
- Make sure repo setting **“Allow auto-merge”** is enabled.

## Question

Hows this

## Answer

Looks tight, Mr. White. Two tweaks so it’s **truly** hands-off:

1) **Give the promote job write perms.**  
`create-pull-request` and `enable-pull-request-automerge` need `contents: write` + `pull-requests: write`. Add at workflow top (or just on `promote`). fileciteturn3file0
```yaml
permissions:
  contents: write
  pull-requests: write
```

2) **Create the PR from the real branches.**  
Right now `promote` uses `peter-evans/create-pull-request` **without** a checkout and sets both `head` and `branch`. That action is meant to open PRs from **local changes**; with no changes, it can no-op. Use the GitHub CLI to open a PR **from existing branches** instead (rock solid):

```yaml
promote:
  needs: [deploy]
  if: ${{ github.event_name == 'push' && (github.ref == 'refs/heads/develop' || github.ref == 'refs/heads/preview') }}
  runs-on: ubuntu-latest
  permissions:
    contents: write
    pull-requests: write
  steps:
    - uses: actions/checkout@v4
      with: { fetch-depth: 2 }

    - name: Promote develop → preview
      if: ${{ github.ref == 'refs/heads/develop' }}
      run: |
        gh pr create --base preview --head develop \
          --title "Auto-promote: develop → preview" \
          --body "Automated promotion PR"
        num=$(gh pr view --json number -q .number --head develop --base preview)
        gh pr merge "$num" --squash --auto
      env:
        GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}

    - name: Promote preview → main
      if: ${{ github.ref == 'refs/heads/preview' }}
      run: |
        gh pr create --base main --head preview \
          --title "Auto-promote: preview → main" \
          --body "Automated promotion PR"
        num=$(gh pr view --json number -q .number --head preview --base main)
        gh pr merge "$num" --squash --auto
      env:
        GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

Everything else looks good:
- Fast checks only on PRs (`ci-fast`), heavier checks opt-in via label or push. fileciteturn3file0  
- CodeQL runs on PRs/push + weekly—kept off the happy path. fileciteturn3file1  
- Dependabot waits only on `pr-policy|ci-fast` and merges patch/minor/security to `develop`. ✔️ fileciteturn3file2

Want me to drop in the exact diff to your `ci.yml` with the perms + GH CLI promote?

## Question

Give me a concise prompt for cursor ai to fix these issues. Also check branch rules

## Answer

Mr. White — here’s a **tight Cursor prompt** to fix it fast and keep auto-promote hands-off.

---

**Cursor prompt:**

> **Goal (speed-first):** One fast CI, hands-off auto-promote, minimal branch rules. No heavy checks on PRs.
>
> **Edit 1 — `.github/workflows/ci.yml`:**
> - Add at top:
>   ```yaml
>   permissions:
>     contents: write
>     pull-requests: write
>   ```
> - Replace the `promote` steps to use GitHub CLI (PRs **from real branches**; idempotent):
>   ```yaml
>   promote:
>     needs: [deploy]
>     if: ${{ github.event_name == 'push' && (github.ref == 'refs/heads/develop' || github.ref == 'refs/heads/preview') }}
>     runs-on: ubuntu-latest
>     permissions:
>       contents: write
>       pull-requests: write
>     steps:
>       - uses: actions/checkout@v4
>         with: { fetch-depth: 2 }
>       - name: Promote develop → preview
>         if: ${{ github.ref == 'refs/heads/develop' }}
>         env: { GH_TOKEN: ${{ secrets.GITHUB_TOKEN }} }
>         run: |
>           gh pr view --head develop --base preview >/dev/null 2>&1 || \
>             gh pr create --base preview --head develop --title "Auto-promote: develop → preview" --body "Automated promotion PR"
>           num=$(gh pr view --json number -q .number --head develop --base preview)
>           gh pr merge "$num" --squash --auto
>       - name: Promote preview → main
>         if: ${{ github.ref == 'refs/heads/preview' }}
>         env: { GH_TOKEN: ${{ secrets.GITHUB_TOKEN }} }
>         run: |
>           gh pr view --head preview --base main >/dev/null 2>&1 || \
>             gh pr create --base main --head preview --title "Auto-promote: preview → main" --body "Automated promotion PR"
>           num=$(gh pr view --json number -q .number --head preview --base main)
>           gh pr merge "$num" --squash --auto
>   ```
> - Keep `pr-policy` and `ci-fast` as the only PR checks; deploy/promote only on push to `develop` or `preview`.
>
> **Edit 2 — `.github/workflows/dependabot-auto-merge.yml`:**
> - Narrow the wait to the fast checks:
>   ```diff
>   - check-regexp: >
>   -   (analyze|verify-pr-source|build|test|lint|typecheck)
>   + check-regexp: >
>   +   (?i)(pr-policy|ci-fast)
>   ```
> - Leave base branch filter as `develop`.
>
> **Edit 3 — `branch-protection.yml` (replace with minimal “Fast-Track”):**
> ```yaml
> name: 'Fast-Track (temporary)'
> enforcement: 'active'
> target:
>   ref_name:
>     include: ['refs/heads/preview','refs/heads/main']
>     exclude: []
> rules:
>   - type: 'pull_request'
>     parameters:
>       dismiss_stale_reviews_on_push: false
>       require_code_owner_review: false
>       required_approving_review_count: 0
>       require_last_push_approval: false
>   - type: 'required_status_checks'
>     parameters:
>       strict_required_status_checks_policy: true
>       required_status_checks:
>         - context: 'pr-policy'
>         - context: 'ci-fast'
> bypass_actors: []
> ```
>
> **Edit 4 — “example only” for heavy rules:**
> - M

*(Answer truncated — 3953 chars total)*

## Question

Write me a prompt to check the ci now and see if it does what we want

## Answer

Here’s a **copy-paste Cursor prompt** to audit and fix the CI for speed-first auto-promote.

---

**Cursor Prompt — “CI sanity check + quick fixes”**

Goal: Speed-first pipeline. PRs only run **pr-policy** + **ci-fast**. Push to **develop/preview** deploys and **auto-promotes via GH CLI**. Dependabot merges patch/minor/security to **develop** after fast checks. Branch rules require only those two checks on **preview/main**. No circular waits, no missing perms.

**Scope:** Review & patch these files:
- `.github/workflows/ci.yml`
- `.github/workflows/dependabot-auto-merge.yml`
- `branch-protection.yml` (ruleset config)
- (Informational) `codeql.yml`, `security-rules.yml`, `code-quality.yml`

### What to verify (and fix if wrong)

1) **Triggers**
   - `pull_request` → branches: `develop, preview, main` (fast checks only)
   - `push` → branches: `develop, preview` (deploy + promote)
   - `paths-ignore` excludes docs/markdown for both
   - `concurrency` with `cancel-in-progress: true`

2) **Jobs present / wiring**
   - `pr-policy` runs on PRs; enforces only `develop→preview` and `preview→main`
   - `ci-fast` runs on all non-draft PRs and on pushes; does `typecheck` + `lint`
   - `ci-full` (optional) runs on push or PRs labeled `full-ci`
   - `deploy` runs **only on push** (develop/preview)
   - `promote` runs **only on push** (develop/preview), `needs: [deploy]` (OK to change to `[ci-fast]` if we want max speed)
   - **Permissions** set so promote can open/merge PRs:
     ```yaml
     permissions:
       contents: write
       pull-requests: write
     ```
   - **Promote uses GH CLI** to create PRs **from real branches** and auto-merge:
     - develop→preview
     - preview→main
     - Idempotent: if PR exists, re-use it; then `--auto --squash`
     - Uses `GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}`

3) **Secrets**
   - Vercel deploy uses `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`
   - No missing envs

4) **Dependabot**
   - Base branch filter: only `develop`
   - Merge policy: allow **security** or **semver patch/minor**
   - Waits for **fast checks only**:
     ```
     check-regexp: (?i)(pr-policy|ci-fast)
     allowed-conclusions: success
     ```

5) **Branch rules (branch-protection.yml)**
   - Active ruleset targets **preview** and **main** only
   - Required status checks: exactly `pr-policy`, `ci-fast`
   - `required_approving_review_count: 0`
   - `require_last_push_approval: false`
   - **No required deployments** and no required external workflows
   - **Bypass actors**: none (or ensure bot doesn’t need one)

6) **No circular waits**
   - Promotion PRs do **not** require deployments, CodeQL, e2e, a11y, etc.
   - CodeQL runs on schedule / push, **not** required in ruleset

7) **Housekeeping**
   - If `security-rules.yml` or `code-quality.yml` list checks we don’t emit, ensure they’re **examples only** (not enforced)
   - Confirm label logic for `ci-full` (optional) works

### Output format
1) **Report** with PASS/FAIL for each item ab

*(Answer truncated — 3335 chars total)*
