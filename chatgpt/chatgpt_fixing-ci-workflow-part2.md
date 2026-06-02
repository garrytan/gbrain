
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


In Claude Coderview, I'd be down to add it for Copilot as well. But shouldn't that be non-blocking for preview and blocking for production? Thanks for watching!


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

Result: speedy `preview` merges with helpful (but non-blocking) AI signal, and a single **AI Review Gate** that blocks `production` only when there’s a clear, tagged blocker.


Great, so then what would be our updated branch requirements, our updated branch rule set for preview and for production?


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


Should we rename any of our workflows?


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
