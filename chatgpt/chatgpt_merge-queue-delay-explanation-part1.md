---
title: "Merge queue delay explanation"
type: essay
created: 2025-08-30
updated: 2025-08-30
source: chatgpt-export
conversation_id: 68b33088-af70-8332-9e46-228754d29bfe
message_count: 73
tags: [chatgpt, import, code, long-form]
---
# Merge queue delay explanation

> Conversation ID: 68b33088-af70-8332-9e46-228754d29bfe
> Created: 2025-08-30T17:11:03Z
> Updated: 2025-08-30T20:34:57Z
> Messages: 73


{'asset_pointer': 'file-service://file-NQGGTm3EWr4DF5jrLJq22z', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 658, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 388384, 'width': 1218}
We've taken a look at our merge queue right now. Why is it that the next merge is going to be in 11 minutes? All the other ones after that are, like, sequentially happening very quickly, but why does it seem like... Why is there, like, this giant delay before the first merge?


Mr. White—there’s no “gap.” GitHub Merge Queue runs your required checks on a synthetic **merge-group** branch for the first PR. That run is what the “Estimated merge in 11m” reflects. Every item after it shows **11m + a bit** because they can’t start until the first merge-group finishes (your queue is effectively 1-at-a-time).

Why it’s ~11m for the first:

- Your required checks (CI, deploy, external statuses like Vercel/Neon) take ~11m on the merge-group.
- Queue respects runner capacity & workflow `concurrency`; if runners are busy, the clock includes waiting time.
- “Require branch to be up to date” forces a fresh merge-group run even if the PR’s own CI was green.

How to shorten it:

- Trim required checks (make slow ones informational), or split long jobs and require only the gate.
- Speed CI (cache deps/builds, parallelize tests, avoid full deploys as required).
- Add more runners / allow more parallel jobs; avoid `concurrency` bottlenecks.
- If stable, enable **batching** in the rule so multiple PRs share one merge-group run.


Okay, let's do an audit of our CI, how it currently is, and let's just look at, like, fight combinator best practices. We want to be shipping multiple times a day. And it's just me and a bunch of AI bots, basically, AI agents. And so the goal is to ship basically like this. We want everything, when we open up new branches, Neon branches get created in sync with our GitHub branches, which should be in that workflow. Then when we merge something, it passes all its checks, you know, the quick checks or whatever, including the drizzle check that we've added. It gets added to the merge queue. When it goes through the merge queue, the branch gets deleted. The Neon branch also gets deleted. It gets deployed to the preview server, which is mirrored to preview.gov.ie, goes through that whole process, and we should have a working then preview.gov.ie with its Neon branch and database and everything. And then we go to, then our server gets, you know, passed through whatever other checks need to happen, and then PR gets opened for our production branch. And provided that there's not any issues, I think it should be safe for us to just have it auto-merge into production. At least now in the early days, you know, we always have the ability to roll back the first one and Neon and stuff. So I think it's safe for us to just automate the workflow all the way up, provided everything is hitting those checks. And I'd love to even turn on auto-merge by automatically and not have to deal with it ourselves. I think Cloud Code does do a code review. It's non-blocking right now. I don't know if there's a way for us to make that a required check or not and have it trigger an AI to automatically fix any of those things, or if that's even a good idea. I don't know. I want some thoughts on that. But, or if it, I don't know. So yeah, let's figure out what we should be doing differently.


Got it, Mr. White. Here’s a tight audit + concrete fixes to hit “ship many times/day” with bots in the loop.

# What you have (quick read)

- **Auto-merge to `preview`** via a smart workflow that waits for checks, updates behind branches, and enables PR auto-merge. Good foundation. fileciteturn0file0  
- **Main CI** runs Typecheck, Lint, Drizzle Check, Build, Unit, E2E; also listens to **`merge_group`** (merge queue). Deploys `preview` and then opens a **manual** preview→production PR. fileciteturn0file1  
- **Claude review** that can set a blocking label; currently **not a required check**. fileciteturn0file2  
- **Ad-hoc Claude bot** for on-demand help. fileciteturn0file3  
- **CodeQL** (non-blocking). fileciteturn0file4  
- **Per-PR Vercel preview** workflow (comments the URL). fileciteturn0file5  
- **Plan→issues** sync for Copilot. fileciteturn0file6  
- **Ruleset** currently requires `pr-policy` and a check named **`ci-fast`** (but there is **no job named `ci-fast`** yet—mismatch). fileciteturn0file9  
- README documents the intended merge-queue support. fileciteturn0file7  
- Separate **synthetic monitoring** (good). fileciteturn0file8  

# Why merges wait ~11m
Your CI **runs full Build/Unit/E2E on `merge_group`**, so the first item in queue must complete a heavy merge-group run before merge. That time becomes the ETA. fileciteturn0file1

# Do this (minimal changes, big speed)

1) **Create a real “fast gate” and make it the *only* merge-queue requirement**  
- Add a compact job **`ci-fast`** that depends only on **Typecheck + Lint + Drizzle Check**.  
- In CI, **remove** Build/Unit/E2E from `merge_group` triggers; run them on **push to `preview`** instead (post-merge). This keeps merge queue fast and defers heavy tests to the branch that just merged. fileciteturn0file1  
- Your ruleset already requires `ci-fast`; once the job exists, merge-queue will honor it. fileciteturn0file9

2) **Keep full CI after merge to `preview` (as you already do) and deploy**  
You already deploy `preview` and canary-check it on push to `preview`. Keep that. fileciteturn0file1

3) **Make preview→production promotion fully automatic (early stage)**  
- In the **`promote`** job, instead of opening a manual PR, create or update the PR **and enable auto-merge** when all production checks pass. (Mirror the technique you use in Smart Auto-Merge.) fileciteturn0file1turn0file0  
- Keep a **feature flag** to flip this back to manual quickly.

4) **Neon branch lifecycle (missing today)**  
- Add two tiny workflows:  
  a) **On PR open** → create Neon branch matching `feature/*`.  
  b) **On PR close/branch delete** → delete Neon branch.  
Right now CI only *uses* `NEON_DATABASE_URL`; it does not create/clean branches. fileciteturn0file1

5) **Make Claude review advisory or required—your call**  
- If you want it **blocking**, add **`Claude Code Review / claude-review`** to the ruleset required checks; the workflow already sets a `claude:needs-fixes` label and fails when blocking. fileciteturn0file2  
- If you want speed, keep it **non-blocking** but let the auto-merge workflow **skip** when `claude:needs-fixes` label is present (it already does). fileciteturn0file0

6) **Tighten the auto-merge guardrails**  
- Your auto-merge waits on checks matching a regex; ensure it matches **exact job names** (“Typecheck”, “Lint”, “Drizzle Check”, …). It currently uses patterns like `unit.tests` which *do* match “Unit Tests”, but be explicit to avoid surprises. fileciteturn0file0

7) **Speed wins (Fight-Combinator-style best practice)**  
- **Cache everything**: you already cache pnpm; add **Playwright browser cache** to the fast lane when present (you do it in E2E; keep). fileciteturn0file1  
- **Parallelize**: keep Typecheck/Lint in parallel; Drizzle after them (already set). fileciteturn0file1  
- **Fail fast**: keep draft PRs skipping heavy checks (already). fileciteturn0file1  
- **One small required gate in queue, heavy tests post-merge** (key change above).

# Concrete edits (summary)

- **Add `ci-fast` aggregator job** and drop heavy jobs on `merge_group`. Example shape inside `ci.yml`:  
  - `ci-fast`: needs `[ci-typecheck, ci-lint, ci-drizzle-check]`, runs on all events, outputs a success.  
  - Remove `merge_group` from `ci-build`, `ci-unit-tests`, `ci-e2e-tests`; keep them on `push` to `preview`. fileciteturn0file1  
- **Ruleset**: keep `required_status_checks: pr-policy, ci-fast` (now both exist). fileciteturn0file9  
- **Auto-merge**: leave as is, but tighten the `wait-on-check` list to exact names. fileciteturn0file0  
- **Promotion**: in `promote` step, call the same GraphQL **enablePullRequestAutoMerge** you already use, targeting the preview→production PR. fileciteturn0file1turn0file0  
- **Neon**: add two tiny workflow files to create/delete branches (gap today). fileciteturn0file1

# Optional niceties

- Make **`consolidated-vercel-preview`** comment also include QR + `preview.jov.ie` alias if applicable. fileciteturn0file5  
- Keep **CodeQL** non-blocking (good for velocity). fileciteturn0file4  
- Keep **Synthetic golden path** as scheduled, not required (don’t slow merges). fileciteturn0file8

If you want, I can draft the exact YAML diffs for: (a) `ci-fast` job + trigger tweaks, (b) auto-promotion with auto-merge, and (c) Neon branch create/delete workflows.


NEON recommends the following, or at least provides the following example. Action. I'm including it here. Give me a recommendation on that.


NEON recommends the following, or at least provides the following example. Action. I'm including it here. Give me a recommendation on that.

name: Create/Delete Branch for Pull Request

on:
  pull_request:
    types:
      - opened
      - reopened
      - synchronize
      - closed

concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}

jobs:
  setup:
    name: Setup
    outputs:
      branch: ${{ steps.branch_name.outputs.current_branch }}
    runs-on: ubuntu-latest
    steps:
      - name: Get branch name
        id: branch_name
        uses: tj-actions/branch-names@v8

  create_neon_branch:
    name: Create Neon Branch
    outputs:
      db_url: ${{ steps.create_neon_branch_encode.outputs.db_url }}
      db_url_with_pooler: ${{ steps.create_neon_branch_encode.outputs.db_url_with_pooler }}
    needs: setup
    if: |
      github.event_name == 'pull_request' && (
      github.event.action == 'synchronize'
      || github.event.action == 'opened'
      || github.event.action == 'reopened')
    runs-on: ubuntu-latest
    steps:
      - name: Create Neon Branch
        id: create_neon_branch
        uses: neondatabase/create-branch-action@v5
        with:
          project_id: ${{ vars.NEON_PROJECT_ID }}
          branch_name: preview/pr-${{ github.event.number }}-${{ needs.setup.outputs.branch }}
          api_key: ${{ secrets.NEON_API_KEY }}

  # The step above creates a new Neon branch.
  # You may want to do something with the new branch, such as run migrations, run tests
  # on it, or send the connection details to a hosting platform environment.
  # The branch DATABASE_URL is available to you via:
  # "${{ steps.create_neon_branch.outputs.db_url_with_pooler }}".
  # It's important you don't log the DATABASE_URL as output as it contains a username and
  # password for your database.
  #
  # For example, you can uncomment the lines below to run a database migration command:
  #      - name: Run Migrations
  #        run: npm run db:migrate
  #        env:
  #          DATABASE_URL: "${{ steps.create_neon_branch.outputs.db_url_with_pooler }}"
  #
  # You can also add a Schema Diff action to compare the database schema on the new
  # branch with the base branch. This action automatically writes the schema differences
  # as a comment on your GitHub pull request, making it easy to review changes.

  # Following the step above, which runs database migrations, you may want to check
  # for schema changes in your database. We recommend using the following action to
  # post a comment to your pull request with the schema diff. For this action to work,
  # you also need to give permissions to the workflow job to be able to post comments
  # and read your repository contents. Add the following permissions to the workflow job:
  #
  # permissions:
  #   contents: read
  #   pull-requests: write
  #
  # You can also check out https://github.com/neondatabase/schema-diff-action for more
  # information on how to use the schema diff action.
  # You can uncomment the lines below to enable the schema diff action.
  #      - name: Post Schema Diff Comment to PR
  #        uses: neondatabase/schema-diff-action@v1
  #        with:
  #          project_id: \${{ vars.NEON_PROJECT_ID }}
  #          compare_branch: preview/pr-\${{ github.event.number }}-\${{ needs.setup.outputs.branch }}
  #          api_key: \${{ secrets.NEON_API_KEY }}

  delete_neon_branch:
    name: Delete Neon Branch
    needs: setup
    if: github.event_name == 'pull_request' && github.event.action == 'closed'
    runs-on: ubuntu-latest
    steps:
      - name: Delete Neon Branch
        uses: neondatabase/delete-branch-action@v3
        with:
          project_id: ${{ vars.NEON_PROJECT_ID }}
          branch: preview/pr-${{ github.event.number }}-${{ needs.setup.outputs.branch }}
          api_key: ${{ secrets.NEON_API_KEY }}


Mr. White — that Neon example is solid, but I’d harden/tune it for your workflow:

# Keep
- Create on **opened/reopened/synchronize**, delete on **closed**.
- Use Neon’s official actions (`create-branch-action`, `delete-branch-action`).
- Don’t log the DB URL.

# Change / add (recommended)

1) **Name branches by PR number only**  
PR numbers are stable even if the Git branch is renamed.  
`branch_name: preview/pr-${{ github.event.number }}`  
(You don’t need `-${{ needs.setup.outputs.branch }}`; it can cause mismatches on rename.)

2) **Use PR head ref directly** (more robust than deriving)  
Where you truly need the Git name, prefer:  
`${{ github.event.pull_request.head.ref }}`

3) **Tighten concurrency to one per PR**  
Avoid cross-PR contention:  
```yaml
concurrency:
  group: ${{ github.workflow }}-pr-${{ github.event.number }}
  cancel-in-progress: true
```

4) **Protect secrets from forks**  
If you’ll take external PRs in the future, guard creates/deletes so Neon creds never run on forks:  
```yaml
if: github.event.pull_request.head.repo.fork == false
```

5) **Create on PR (drafts allowed), but skip heavy work for drafts**  
Let DB branches exist early, but run migrations/tests only when `draft == false`.  
```yaml
if: >
  !github.event.pull_request.draft &&
  (github.event.action == 'opened' || github.event.action == 'reopened' || github.event.action == 'synchronize')
```

6) **Run migrations right after create (Drizzle)**  
Use **non-pooler URL** for schema changes; use **pooler** at runtime.  
```yaml
- name: Run Drizzle migrations
  run: pnpm drizzle-kit push
  env:
    DATABASE_URL: ${{ steps.create_neon_branch.outputs.db_url }}
```

7) **Export the DB URL for your preview deploy**  
Pass it to your Vercel preview (or set a branch-scoped env var via API) so each PR’s preview points at its Neon branch. Example (minimal) env-file handoff for a later deploy job:  
```yaml
- name: Write env for downstream job
  run: |
    echo "DATABASE_URL=${{ steps.create_neon_branch.outputs.db_url_with_pooler }}" >> $GITHUB_OUTPUT
  id: neon_env
```
Then `needs.create_neon_branch.outputs.db_url_with_pooler` in your Vercel deploy job.

8) **Comment schema diff on the PR (optional but useful)**  
Grant perms and use Neon’s schema-diff action so reviewers see DDL changes inline.  
```yaml
permissions:
  contents: read
  pull-requests: write
# ...
- uses: neondatabase/schema-diff-action@v1
  with:
    project_id: ${{ vars.NEON_PROJECT_ID }}
    compare_branch: preview/pr-${{ github.event.number }}
    api_key: ${{ secrets.NEON_API_KEY }}
```

9) **Also delete on Git branch deletion** (safety net)  
Sometimes maintainers delete branches without closing PRs (or after squash-merge). Add a tiny second workflow:  
```yaml
on:
  delete:
    branches: ['**']
jobs:
  delete_neon_on_git_delete:
    if: github.event.ref_type == 'branch'
    runs-on: ubuntu-latest
    steps:
      - uses: neondatabase/delete-branch-action@v3
        with:
          project_id: ${{ vars.NEON_PROJECT_ID }}
          branch: preview/pr-$(echo "${{ github.event.ref }}" | sed 's|.*/||')
          api_key: ${{ secrets.NEON_API_KEY }}
```
(If you stick to `preview/pr-<PR#>` naming, you can’t reconstruct from Git ref reliably; this is just an extra net. The main path remains PR-closed.)

10) **Make the job idempotent**  
Neon’s actions already are, but keep the `synchronize` trigger—re-running create is harmless and ensures the branch exists if a prior run failed.

---

# Drop-in version (concise)

```yaml
name: PR Neon Branch

on:
  pull_request:
    types: [opened, reopened, synchronize, closed]

concurrency:
  group: ${{ github.workflow }}-pr-${{ github.event.number }}
  cancel-in-progress: true

jobs:
  create_neon_branch:
    name: Create Neon Branch
    if: >
      github.event.action != 'closed' &&
      github.event.pull_request.head.repo.fork == false
    runs-on: ubuntu-latest
    outputs:
      db_url: ${{ steps.create.outputs.db_url }}
      db_url_with_pooler: ${{ steps.create.outputs.db_url_with_pooler }}
    steps:
      - name: Create Neon Branch
        id: create
        uses: neondatabase/create-branch-action@v5
        with:
          project_id: ${{ vars.NEON_PROJECT_ID }}
          branch_name: preview/pr-${{ github.event.number }}
          api_key: ${{ secrets.NEON_API_KEY }}

      - name: Run Drizzle migrations (skip for drafts)
        if: ${{ !github.event.pull_request.draft }}
        run: pnpm drizzle-kit push
        env:
          DATABASE_URL: ${{ steps.create.outputs.db_url }}

      # Optionally post schema diff comment (add permissions block above)
      # - uses: neondatabase/schema-diff-action@v1
      #   with:
      #     project_id: ${{ vars.NEON_PROJECT_ID }}
      #     compare_branch: preview/pr-${{ github.event.number }}
      #     api_key: ${{ secrets.NEON_API_KEY }}

  delete_neon_branch:
    name: Delete Neon Branch
    if: >
      github.event.action == 'closed' &&
      github.event.pull_request.head.repo.fork == false
    runs-on: ubuntu-latest
    steps:
      - name: Delete Neon Branch
        uses: neondatabase/delete-branch-action@v3
        with:
          project_id: ${{ vars.NEON_PROJECT_ID }}
          branch: preview/pr-${{ github.event.number }}
          api_key: ${{ secrets.NEON_API_KEY }}
```

---

# How this fits your pipeline
- Each PR gets its **own Neon branch** + **Drizzle pushed**; your Vercel preview uses the emitted `db_url_with_pooler`.
- When the PR merges (or closes), the Neon branch is **deleted**.
- With the rest of our CI tweak (make `ci-fast` the only merge-queue requirement), merges start in ~1–2 minutes, and the heavy tests/deploys run on `preview` post-merge.
- Promotion to production can be auto-merged once `preview` checks pass.

Want me to wire this into your existing `ci.yml` + Vercel preview job (env plumbed end-to-end) and add the `ci-fast` gate?


Okay, and then finally, they also provide a reset action for resetting a branch back to its parent. What's the recommended setup for us for parent branches and resetting branches? Basically, should feature branches constantly be reset off of the preview branch or the production branch? Should the preview branch be reset off the production branch? Should the production branch be a parent? Should the preview branch be a parent? How exactly should all of that go down for our setup specifically?

Example provided by neon:
reset_neon_branch:
  name: Reset Neon Branch
  needs: setup
  if: |
    contains(github.event.pull_request.labels.*.name, 'Reset Neon Branch') &&
    github.event_name == 'pull_request' &&
    (github.event.action == 'synchronize' ||
     github.event.action == 'opened' ||
     github.event.action == 'reopened' ||
     github.event.action == 'labeled')
  runs-on: ubuntu-latest
  steps:
    - name: Reset Neon Branch
      uses: neondatabase/reset-branch-action@v1
      with:
        project_id: ${{ vars.NEON_PROJECT_ID }}
        parent: true
        branch: preview/pr-${{ github.event.number }}-${{ needs.setup.outputs.branch }}
        api_key: ${{ secrets.NEON_API_KEY }}


Here’s the clean model for your setup, Mr. White:

---

## Parent/child structure
- **Production branch = parent of everything.**
  - This is the only “long-lived, canonical” database.  
  - It should almost never be reset—it evolves naturally through migrations.
- **Preview branch = auto-promotion staging branch.**
  - Its Neon branch should be **reset off of Production** after every promotion so it never drifts.
  - Think of it as a rolling mirror of Production + latest green code, not its own forked lineage.
- **Feature PR branches = children of Preview.**
  - Each PR Neon branch should be created from the current **Preview Neon branch**, not directly from Production.
  - That way your devs/agents test against the exact schema/state that’s about to go live, not stale Production.

---

## Where to use resets
- **Feature branches:**  
  Don’t auto-reset on every push; just recreate on `opened`/`synchronize`. If schema migrations diverge, you can label the PR (“Reset Neon Branch”) and the reset action will snap it back to its parent (Preview). That’s the right use case for the example you pasted.
- **Preview branch:**  
  After each successful promotion of Preview → Production, run a **reset of Preview’s Neon branch to Production**. This keeps the staging DB identical to live, so the next round of PRs starts clean.
- **Production branch:**  
  No resets. It’s the root. You evolve it with migrations only.

---

## Practical flow for you
1. **PR opens →** Neon branch created from Preview branch.  
2. **CI runs migrations** on that Neon branch.  
3. **If migrations blow up or schema drift accumulates →** maintainer applies “Reset Neon Branch” label → workflow resets that Neon branch to Preview and reruns migrations.  
4. **PR merges →** Neon PR branch deleted.  
5. **Preview deploy runs** against Preview Neon.  
6. **Auto-promotion to Production →** after merge, run a reset of the Preview Neon branch to Production, so staging = live.

---

## Why not reset everything off Production?
- You’d lose the staging step.  
- PRs would test against “yesterday’s live schema,” not what’s queued in Preview. That creates more drift/conflicts.  
- Resetting Preview to Production only after promotion guarantees consistency and keeps the pipeline linear.

---

👉 Recommendation for you:  
- **Production = root parent.**  
- **Preview = child of Production, reset to Production after every promotion.**  
- **Feature PR branches = children of Preview, reset to Preview if needed (label trigger).**

Would you like me to draft the two extra reset jobs for you:  
1. **Preview reset to Production (post-promotion job).**  
2. **PR reset to Preview (label-trigger job)?**


Yeah, so then tell me exactly how I should set that up, and then if I need to do anything within the NEON dashboard itself to specify long-lived branches or specify parents and all that.


Mr. White—here’s the exact setup I recommend and what (little) you need to do in Neon.

# In Neon (one-time)

1) **Create two long-lived branches**
- **`production`** (root/default). This is the live DB.
- **`preview`** with **parent = `production`**.  
In the Neon dashboard: Branches → **New branch** → choose **Parent: production** → name it `preview`.

2) **Settings (recommended)**
- **Autosuspend:** `production` ≥ 10–30 min; `preview` ~10 min; PR branches 5 min (default is fine).
- **Compute:** give `preview` a small fixed size; PR branches use autoscale.
- **Roles:** one migration role (full DDL) and one app role (runtime). Use the **non-pooler URL** for migrations, **pooler URL** for the app.

You do **not** need to pre-declare parents for PR branches in the dashboard—GitHub Actions will create PR branches with the correct parent.

---

# In GitHub Actions

## 1) PR branches (create/reset/delete) — parent = `preview`
Create a dedicated workflow (e.g., `.github/workflows/pr-neon.yml`):

```yaml
name: PR Neon Branches
on:
  pull_request:
    types: [opened, reopened, synchronize, labeled, closed]

concurrency:
  group: ${{ github.workflow }}-pr-${{ github.event.number }}
  cancel-in-progress: true

jobs:
  create_neon_branch:
    if: github.event.action != 'closed' && github.event.pull_request.head.repo.fork == false
    runs-on: ubuntu-latest
    outputs:
      db_url: ${{ steps.create.outputs.db_url }}
      db_url_with_pooler: ${{ steps.create.outputs.db_url_with_pooler }}
    steps:
      - name: Create Neon Branch from PREVIEW
        id: create
        uses: neondatabase/create-branch-action@v5
        with:
          project_id: ${{ vars.NEON_PROJECT_ID }}
          branch_name: preview/pr-${{ github.event.number }}
          # IMPORTANT: parent must be PREVIEW (not production)
          parent: preview
          api_key: ${{ secrets.NEON_API_KEY }}

      - name: Run Drizzle migrations (skip drafts)
        if: ${{ !github.event.pull_request.draft }}
        run: pnpm drizzle-kit push
        env:
          # Use NON-pooler URL for schema changes
          DATABASE_URL: ${{ steps.create.outputs.db_url }}

  reset_neon_branch_to_parent:
    name: Reset PR DB to PREVIEW parent
    if: >
      github.event_name == 'pull_request' &&
      (github.event.action == 'labeled' || github.event.action == 'synchronize' || github.event.action == 'opened' || github.event.action == 'reopened') &&
      contains(github.event.pull_request.labels.*.name, 'Reset Neon Branch') &&
      github.event.pull_request.head.repo.fork == false
    runs-on: ubuntu-latest
    steps:
      - uses: neondatabase/reset-branch-action@v1
        with:
          project_id: ${{ vars.NEON_PROJECT_ID }}
          # parent: true means "reset this branch to its parent" (which is PREVIEW)
          parent: true
          branch: preview/pr-${{ github.event.number }}
          api_key: ${{ secrets.NEON_API_KEY }}

  delete_neon_branch:
    if: github.event.action == 'closed' && github.event.pull_request.head.repo.fork == false
    runs-on: ubuntu-latest
    steps:
      - uses: neondatabase/delete-branch-action@v3
        with:
          project_id: ${{ vars.NEON_PROJECT_ID }}
          branch: preview/pr-${{ github.event.number }}
          api_key: ${{ secrets.NEON_API_KEY }}
```

> Wiring tip: pass `db_url_with_pooler` from `create_neon_branch` into your Vercel preview deploy job as that PR’s `DATABASE_URL`.

---

## 2) Keep `preview` in sync with `production` (post-promotion reset)
After you auto-promote `preview` → `production`, immediately reset the **`preview` Neon branch to its parent (`production`)** so staging never drifts. Add a job to your promotion workflow (or a tiny standalone workflow that you dispatch after promotion succeeds):

```yaml
name: Reset PREVIEW DB after Promotion

on:
  workflow_dispatch:
  push:
    branches: [production]  # or call this from your promotion job at the very end

jobs:
  reset_preview_to_production:
    runs-on: ubuntu-latest
    steps:
      - name: Reset preview branch to its parent (production)
        uses: neondatabase/reset-branch-action@v1
        with:
          project_id: ${{ vars.NEON_PROJECT_ID }}
          parent: true      # reset to the parent of 'preview'
          branch: preview
          api_key: ${{ secrets.NEON_API_KEY }}
```

If you don’t want to rely on `parent: true`, you can explicitly set `parent: production` instead of `parent: true`.

---

## 3) Secrets & vars you need
- **Repository → Settings → Secrets and variables**
  - Secret: `NEON_API_KEY`
  - Variable: `NEON_PROJECT_ID`
- Optional: `VERCEL_TOKEN`, etc., for your preview deploy to consume the PR-specific `DATABASE_URL`.

---

## TL;DR policy
- **Production**: root parent (never reset; migrate only).
- **Preview**: child of Production; **reset to Production after each promotion**.
- **PR DBs**: children of Preview; **reset to parent on demand** (label) and **delete on close**.

This gives you: fast, isolated PR databases that match what’s about to ship; a Preview DB that’s always a clean mirror of Production right after each release; and zero manual steps in Neon.


Questions/tweaks for you
Limit to PRs into preview?
Currently runs for any PR. Do you want to scope to if: github.base_ref == 'preview' for create/reset/delete jobs?
Label name confirmation
Using label: “Reset Neon Branch”. Want a different label, e.g., “db:reset” or “neon:reset”? I can update the condition and document it.
Optional PR feedback
Want me to post a PR comment when a reset occurs (and/or when the PR DB is created) for visibility?
Extra safety net
Add a nightly cleanup to delete stale Neon branches not linked to open PRs? I can add a cron with list + delete.


Mr. White — here’s what I recommend, with drop-in snippets.

# 1) Scope to PRs targeting `preview`
Yes. Only create/reset/delete PR DBs when the PR’s **base** is `preview`.

```yaml
# Inside .github/workflows/pr-neon.yml
jobs:
  create_neon_branch:
    if: >
      github.event.action != 'closed' &&
      github.event.pull_request.base.ref == 'preview' &&
      github.event.pull_request.head.repo.fork == false
    # ...

  reset_neon_branch_to_parent:
    if: >
      (github.event.action == 'labeled' || github.event.action == 'synchronize' ||
       github.event.action == 'opened'  || github.event.action == 'reopened') &&
      github.event.pull_request.base.ref == 'preview' &&
      contains(github.event.pull_request.labels.*.name, 'neon:reset') &&
      github.event.pull_request.head.repo.fork == false
    # ...

  delete_neon_branch:
    if: >
      github.event.action == 'closed' &&
      github.event.pull_request.base.ref == 'preview' &&
      github.event.pull_request.head.repo.fork == false
    # ...
```

# 2) Label name
Use a short, grep-able label: **`neon:reset`**. (I updated the condition above.)

# 3) Optional PR feedback (recommended)
Post a comment when we **create** or **reset** so it’s obvious what happened.

```yaml
# After Create Neon Branch step
- name: Comment PR (DB created)
  if: always()
  uses: actions/github-script@v7
  with:
    script: |
      const url = process.env.DB_URL_W_POOLER
      const masked = url ? url.replace(/:\/\/[^@]+@/, '://***:***@') : '(hidden)'
      github.rest.issues.createComment({
        owner: context.repo.owner,
        repo: context.repo.repo,
        issue_number: context.issue.number,
        body: `✅ Neon PR database created: \`preview/pr-${context.issue.number}\`\nDATABASE_URL (pooler): ${masked}`
      })
  env:
    DB_URL_W_POOLER: ${{ steps.create.outputs.db_url_with_pooler }}

# After Reset step
- name: Comment PR (DB reset)
  if: always()
  uses: actions/github-script@v7
  with:
    script: |
      github.rest.issues.createComment({
        owner: context.repo.owner,
        repo: context.repo.repo,
        issue_number: context.issue.number,
        body: `♻️ Neon PR database **reset to parent** (preview): \`preview/pr-${context.issue.number}\``
      })
```

# 4) Nightly cleanup (extra safety net)
Deletes **stale** Neon PR branches (e.g., if someone force-deleted a Git branch or a PR closed without the workflow running). This only removes branches named `preview/pr-<number>` that no longer correspond to an **open** PR into `preview`.

Create `.github/workflows/neon-cleanup.yml`:

```yaml
name: Neon Cleanup
on:
  schedule: [{ cron: "13 7 * * *" }]   # daily 07:13 UTC
  workflow_dispatch:

jobs:
  cleanup_orphan_pr_dbs:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: read
    steps:
      - name: Fetch open PR numbers targeting preview
      id: prs
      uses: actions/github-script@v7
      with:
        script: |
          const prs = await github.paginate(github.rest.pulls.list, {
            owner: context.repo.owner,
            repo: context.repo.repo,
            state: 'open',
            base: 'preview',
            per_page: 100
          })
          const nums = prs.map(pr => pr.number)
          core.setOutput('open_prs', JSON.stringify(nums))

      - name: List Neon branches (JSON)
      id: neon_list
      run: |
        curl -sS -H "Authorization: Bearer $NEON_API_KEY" \
          "https://console.neon.tech/api/v2/projects/${NEON_PROJECT_ID}/branches" > branches.json
        jq -r '.branches[].name' branches.json > neon_branches.txt
      env:
        NEON_API_KEY: ${{ secrets.NEON_API_KEY }}
        NEON_PROJECT_ID: ${{ vars.NEON_PROJECT_ID }}

      - name: Compute orphan PR branches
      id: compute
      run: |
        OPEN="$(echo '${{ steps.prs.outputs.open_prs }}' | jq -r '.[]' | sed 's/^/preview\\/pr-/')"
        awk 'NR==FNR{a[$0]=1;next} /^preview\/pr-[0-9]+$/ && !($0 in a){print $0}' \
          <(printf "%s\n" $OPEN) neon_branches.txt > to_delete.txt
        echo "To delete:"
        cat to_delete.txt || true

      - name: Delete orphan branches
      if: success()
      run: |
        while read -r BR; do
          [ -z "$BR" ] && continue
          echo "Deleting $BR"
          gh workflow run placeholder 1>/dev/null 2>&1 || true # no-op to ensure gh is present
          echo "::group::delete $BR"
          echo "project=$NEON_PROJECT_ID branch=$BR"
          curl -sS -X DELETE -H "Authorization: Bearer $NEON_API_KEY" \
            "https://console.neon.tech/api/v2/projects/${NEON_PROJECT_ID}/branches/$BR" \
            | jq . || true
          echo "::endgroup::"
        done < to_delete.txt
      env:
        NEON_API_KEY: ${{ secrets.NEON_API_KEY }}
        NEON_PROJECT_ID: ${{ vars.NEON_PROJECT_ID }}
```

Notes:
- Uses Neon’s public API to list/delete branches.
- Only deletes names shaped `preview/pr-<number>`.
- Cross-checks against **open PRs targeting `preview`**.

# 5) Tiny improvement to create step (explicit parent + scoping)
(If you haven’t already):

```yaml
- name: Create Neon Branch from PREVIEW
  id: create
  uses: neondatabase/create-branch-action@v5
  with:
    project_id: ${{ vars.NEON_PROJECT_ID }}
    branch_name: preview/pr-${{ github.event.number }}
    parent: preview
    api_key: ${{ secrets.NEON_API_KEY }}
```

# Dashboard tweaks (Neon)
- Mark **`production`** and **`preview`** as your two **long-lived branches** (names only; no special flag required).
- Ensure **`preview`’s parent is `production`** (one-time when you create it).
- No further dashboard config is required; the workflows determine parents for PR branches.

If you want, I can fold these changes into your existing `pr-neon.yml` and add the `neon-cleanup.yml` file exactly as above.


What about turning on enable auto-merge or merge to queue and ready, instead of us having to manually hit that button on every PR?


Short answer: yes—make it automatic.

# What to turn on in GitHub
1) In repo settings → **Merge button**: enable **Allow auto-merge**.  
2) In branch protection for `preview` (and/or `main`): enable **Require merge queue** and keep your required checks minimal (our `ci-fast`). When auto-merge is enabled on a PR, GitHub will enqueue it automatically once requirements are met.

# Two good ways to automate it (pick one)

## A) “Set auto-merge” (simplest; works great with merge queue)
When your CI passes, call **`enablePullRequestAutoMerge`**. If merge queue is required, the PR will auto-enqueue when ready.

```yaml
# .github/workflows/auto-enable-automerge.yml
name: Auto-enable auto-merge
on:
  workflow_run:
    workflows: ["CI"]       # your main CI name
    types: [completed]
permissions:
  contents: read
  pull-requests: write

jobs:
  enable:
    if: >
      github.event.workflow_run.conclusion == 'success' &&
      github.event.workflow_run.pull_requests[0].base.ref == 'preview'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/github-script@v7
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          script: |
            const pr = context.payload.workflow_run.pull_requests[0]
            const { data } = await github.graphql(`
              mutation($prId: ID!) {
                enablePullRequestAutoMerge(input:{
                  pullRequestId: $prId
                  mergeMethod: SQUASH
                }) { pullRequest { number autoMergeRequest { enabledAt } } }
              }`, { prId: pr.node_id })
            core.info(`Auto-merge enabled for PR #${pr.number}`)
```
Facts: “Allow auto-merge” must be on; the GraphQL mutation is the supported path. With merge queue required, enabling auto-merge causes the PR to join the queue when checks pass. citeturn0search14turn0search1turn0search2

## B) “Enqueue directly” (explicitly push to the queue)
If you prefer to shove it into the queue immediately after checks pass, call **`enqueuePullRequest`**.

```yaml
# .github/workflows/auto-enqueue.yml
name: Auto-enqueue to merge queue
on:
  workflow_run:
    workflows: ["CI"]
    types: [completed]
permissions:
  contents: read
  pull-requests: write

jobs:
  enqueue:
    if: >
      github.event.workflow_run.conclusion == 'success' &&
      github.event.workflow_run.pull_requests[0].base.ref == 'preview'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/github-script@v7
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          script: |
            const pr = context.payload.workflow_run.pull_requests[0]
            await github.graphql(`
              mutation($prId: ID!) {
                enqueuePullRequest(input:{ pullRequestId: $prId }) { clientMutationId }
              }`, { prId: pr.node_id })
```
GitHub added GraphQL for merge queue (enqueue/dequeue, list). citeturn0search4

# Which should you use?
- **Option A (auto-merge)** is cleaner and matches the normal UX; with “Require merge queue” on, it still goes through the queue—just without you clicking the button.  
- **Option B (enqueue)** gives you explicit control if you ever want to separate “queued” from “auto-merge when ready.”

# Notes / gotchas
- The workflow needs **`pull-requests: write`** permission for GraphQL mutations. citeturn0search5  
- Scope it to PRs targeting `preview`: check `base.ref == 'preview'`.  
- If you want a manual override, only trigger when a label like `merge:auto` is present.  
- With batching on the queue, enabling auto-merge still participates in batches per your queue config. citeturn0search2turn0search12

If you want, I can wire Option A into your existing auto-merge workflow and remove the need to click anything ever again.


## See Also
- [[chatgpt/chatgpt_merge-queue-delay-explanation-part2]]
- [[chatgpt/chatgpt_merge-queue-delay-explanation-part3]]
- [[chatgpt/chatgpt_merge-queue-delay-explanation-part4]]
- [[chatgpt/chatgpt_merge-queue-explanation]]
- [[chatgpt/chatgpt_merge-queue-throughput-explanation]]
