---
title: "Cloud automation loop"
type: guide
created: 2026-01-21
updated: 2026-01-21
source: chatgpt-export
conversation_id: 6971432c-6328-8333-895d-b12065dc0aa0
message_count: 8
tags: [chatgpt, import, code, long-form]
---
# Cloud automation loop

> Conversation ID: 6971432c-6328-8333-895d-b12065dc0aa0
> Created: 2026-01-21T21:20:46Z
> Updated: 2026-01-21T21:29:12Z
> Messages: 8

---

## User

Yo, dog, I have a cloud code slash command that automatically pulls in the latest issues from the Sonar API, and then prioritizes and triages them, and then it picks a group of the top offenders, the like ones that are the highest priority, that can be dealt with in one single PR and addresses them, and then runs a few other slash commands to verify and simplify the code, and then it opens up a PR. How can I get it so that, and it does a really good job of doing this, and then all of those issues are handled, and they're all like high enough complexity issues and things that can be automatically handled. How can I get this to just like trigger in the cloud to run continuously so that when one agent finishes, it triggers another one to go through the same exact thing and just keeps going until we're at zero?

---

## Assistant

Mr. White — the key constraint is: you can’t truly “keep going until zero” **unless each iteration sees the repo in the new post-merge state**. So you need an **orchestrator loop** that (a) runs your “triage→fix→verify→PR” worker, then (b) **waits for merge**, then (c) kicks off the next run.

Here are the clean patterns that work in practice.

## Pattern A (best): Queue + worker + merge webhook (event-driven loop)
**Components**
1. **Worker** (your existing slash-command logic, refactored into a callable job):
   - Input: repo, base branch, rules (max issues, max PR size), run_id
   - Output: PR URL + “remaining issues count” (or a boolean `done`)
2. **Queue** (SQS / PubSub / Rabbit / Redis queue)
3. **State store** (DB row per repo): running lock, last PR, counters, kill switch
4. **Git provider webhook**: on PR merged → enqueue the next job

**Flow**
- `/autofix start` enqueues `{repo, base=main}` and sets a **distributed lock** like `repo_autofix_running=true`.
- Worker runs:
  - pulls Sonar issues → selects batch → fixes → runs verification commands → opens PR
  - marks state as `waiting_for_merge` and stores PR id
- Webhook fires when PR is **merged**:
  - enqueue next message `{repo, base=main}`
- Worker consumes next message and repeats until Sonar returns “0 actionable” → clears lock.

**Why it works**
- Fully continuous, no polling.
- Exactly one active run per repo (lock).
- Naturally throttles on “merge speed”.

**Hard requirements**
- **Idempotency**: every job must be safe to re-run without duplicating PRs (use `run_id` + “already opened PR?” check).
- **Locking**: prevent two workers from opening PRs simultaneously for the same repo.
- **Stop conditions**: “0 issues” OR “max PRs/day” OR “budget exceeded” OR manual kill switch.

---

## Pattern B: Durable orchestrator loop (Step Functions / Temporal / Workflows)
If you want the “loop” expressed explicitly:

**State machine**
1. `ScanAndSelectIssues`
2. `ApplyFixesAndOpenPR`
3. `WaitForMerge` (event-based if supported, otherwise poll PR status)
4. `RecheckSonar`
5. If remaining > 0 → back to step 1 else `Done`

**When to choose**
- You want auditability, retries, timeouts, and a visible run history.
- You want “one button” to start/stop a long-running automation.

---

## Pattern C: Simple cron (works, but less elegant)
Run a scheduled job every N minutes (GitHub Actions cron / Cloud Scheduler) that:
- checks “is there an open autofix PR?” → if yes, exit
- else runs your worker once

This is fine if you don’t want webhooks/queues, but it’s inherently **polling** and slower to react.

---

## One important design choice: PR strategy
You have three viable approaches:

1. **Sequential PRs (recommended)**  
   One PR per batch; loop waits for merge → next batch. Lowest risk, clean history.

2. **Single rolling PR**  
   Keep one “autofix” PR open and just push commits until Sonar hits zero. Fast, but PR can get huge and CI noisy.

3. **Stacked PRs**  
   Multiple dependent PRs on top of each other. Powerful but adds complexity (rebase/merge conflict handling).

If your goal is “until zero with minimal drama,” do **Sequential PRs + auto-merge** (once checks pass).

---

## Practical safeguards you’ll want (non-negotiable)
- **Max scope per PR** (files changed, lines changed, cyclomatic complexity delta)
- **Rate limiting/backoff** for Sonar + GitHub/GitLab API (avoid getting blocked)
- **Conflict handling**: if PR can’t merge cleanly, stop and alert
- **Noise controls**: don’t open PRs if the “fix set” is below a threshold or duplicates prior attempts
- **Kill switch**: `repo_autofix_enabled=false` in DB/env

---

## Minimal implementation blueprint (what to build)
1. Refactor slash command into `run_autofix_once(repo, base_branch) -> {pr, remaining}`
2. Add a repo-level lock in DB/Redis:
   - acquire at start of job, release only when done (or on terminal failure)
3. Create a queue-triggered worker (serverless or container)
4. Add webhook handler:
   - on `pull_request merged` (and label matches `autofix`) → enqueue next run
5. Define “done” as:
   - `remaining_actionable == 0` **or** “only issues we don’t auto-fix” remain

---

If you tell me what platform you’re on (AWS/GCP/Azure, and GitHub vs GitLab) and where the slash command lives (Slack? Discord? internal), I can give you the exact wiring (services + IAM permissions + webhook events + retry strategy) in a concrete recipe.

---

## User

The way I currently run it is I have a slash command in Cloud Code, and I'm using Cloud Code on the app so I can use it on my phone or the desktop and it runs in the cloud, and I just run it manually and then let it go in the background, and then I come back to it once I see that the PR has merged and I run it again. I can run Cloud Code instance on my computer and have it keep firing these off, but it's a little less dependent and I have to always be by my machine. I'm kind of looking for a way to have this continuously run anytime I'm away from my machine so that work is still getting done while I'm off the clock.

---

## Assistant

Mr. White — easiest way to get “keeps going while I’m away” is to move the **orchestration** into CI (GitHub Actions / GitLab CI) and run Claude Code **headless** via the Agent SDK CLI (`claude -p`). That gives you a server-side loop triggered by merges, not your laptop. citeturn4view0

### Why this is the right lever
- Your current “Cloud Code session + slash command” is great interactively, but **the continuous trigger** you want is a *webhook/CI problem*, not an in-app session problem.
- In headless mode you run Claude non-interactively with `claude -p` and auto-approve tools with `--allowedTools`. citeturn4view0
- Note: **user-invoked slash commands/skills aren’t available in `-p` mode**, so you’ll want to port your workflow into a prompt (or a small script that Claude follows). citeturn4view0

---

## The “merge-driven conveyor belt” pattern (recommended)
**Trigger:** every time an autofix PR merges to `main`, run again.

### GitHub Actions sketch
This workflow:
1) exits if there’s already an open autofix PR  
2) checks Sonar for remaining issues (you can do this in a bash step or inside the Claude prompt)  
3) runs `claude -p` to do your full loop and open the next PR  
4) the merge of that PR triggers the workflow again until zero

```yaml
name: sonar-autofix-loop

on:
  push:
    branches: [ main ]   # runs after merges
  workflow_dispatch: {}

concurrency:
  group: sonar-autofix-loop
  cancel-in-progress: false

permissions:
  contents: write
  pull-requests: write

jobs:
  autofix:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Skip if an autofix PR is already open
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: |
          open_count=$(gh pr list --state open --label "autofix" --json number --jq 'length')
          if [ "$open_count" -gt 0 ]; then
            echo "Autofix PR already open; exiting."
            exit 0
          fi

      # Optional: quick “are we done?” check (Sonar API) before spending tokens

      - name: Run Claude to create next autofix PR
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          SONAR_TOKEN: ${{ secrets.SONAR_TOKEN }}
        run: |
          claude -p "
          You are an automated refactor agent.
          Goal: reduce Sonar issues to zero via small, mergeable PRs.
          Steps:
          1) Fetch latest Sonar issues via API using SONAR_TOKEN.
          2) Select a batch that can be fixed in one PR (limit scope).
          3) Create a branch, apply fixes, run tests/lint/format.
          4) Commit with a clear message.
          5) Open a PR via gh, apply label 'autofix', include summary + risks.
          Stop if there are zero actionable issues.
          " --allowedTools "Bash,Read,Edit" --output-format text
```

This uses the documented non-interactive mode (`claude -p`) and tool auto-approval (`--allowedTools`). citeturn4view0

---

## If you really want to keep your existing slash command
Because `-p` mode can’t directly run your user-invoked skills/slash commands citeturn4view0, the practical options are:

1) **Copy the logic into the prompt** (fastest).
2) **Put the logic into a repo script** (`./scripts/sonar_autofix.sh`) and have Claude run that script + handle the PR-writing parts.
3) **Write a tiny “orchestrator” script** (Python/TS) that calls Sonar + uses `claude -p` only for the “make code changes” part.

---

## Two must-have guards (or it’ll go sideways)
- **One PR at a time**: exit if an autofix PR is open (shown above).
- **Hard stop limits**: max files/LOC touched, max PRs/day, stop on merge conflicts or flaky tests.

---

If you tell me whether you’re on **GitHub or GitLab**, I’ll tailor the exact pipeline (triggers + permissions + “auto-merge when green” wiring) so it truly runs unattended.

---

## User

GitHub 

---

## Assistant

Mr. White — perfect. On GitHub, the clean “runs while you’re away” setup is:

1) **A GitHub Action that runs after every merge to `main` (push event)**  
2) It **opens at most one** “autofix” PR at a time  
3) When that PR gets merged, the same workflow fires again → repeat until Sonar says “nothing actionable”

Below is a working template you can drop into `.github/workflows/sonar-autofix.yml`.

---

## 1) GitHub Actions workflow (merge-driven loop)

```yaml
name: Sonar Autofix Loop

on:
  push:
    branches: [ main ]          # runs after merges to main
  workflow_dispatch: {}         # lets you kick it off manually
  schedule:
    - cron: "17 * * * *"        # optional: hourly safety net

concurrency:
  group: sonar-autofix-loop     # ensures only one run at a time
  cancel-in-progress: false

permissions:
  contents: write
  pull-requests: write

jobs:
  autofix:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Install GitHub CLI
        run: sudo apt-get update && sudo apt-get install -y gh

      - name: Exit if an autofix PR is already open
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: |
          open_count=$(gh pr list --state open --label "autofix" --json number --jq 'length')
          if [ "$open_count" -gt 0 ]; then
            echo "Autofix PR already open; exiting."
            exit 0
          fi

      # OPTIONAL: exit early if Sonar has zero actionable issues
      # - name: Check Sonar actionable issues
      #   env:
      #     SONAR_TOKEN: ${{ secrets.SONAR_TOKEN }}
      #   run: |
      #     ./scripts/sonar_actionable_count.sh | tee /tmp/count.txt
      #     if [ "$(cat /tmp/count.txt)" = "0" ]; then exit 0; fi

      - name: Run Claude Code headless to create next PR
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          SONAR_TOKEN: ${{ secrets.SONAR_TOKEN }}
        run: |
          # If claude isn't preinstalled in your repo toolchain, install it here.
          # Example if you're using npm:
          # npm ci
          # npx -y @anthropic-ai/claude-code@latest --version

          claude -p "
          You are an automated refactor agent for this repository.

          Objective: reduce Sonar issues to zero via small, mergeable PRs.

          Constraints:
          - One PR per run, keep changes tight (avoid giant refactors).
          - Only fix issues that are safe to auto-fix.
          - If tests fail or changes are risky, stop and summarize.

          Required steps:
          1) Pull the latest Sonar issues via the Sonar API (use SONAR_TOKEN).
          2) Prioritize + select a batch that can be fixed in one PR.
          3) Create a new branch, apply fixes, run format/lint/tests.
          4) Commit with a clear message.
          5) Open a PR to main using GitHub CLI (gh pr create),
             add label 'autofix', include summary + what Sonar issues it addresses.
          6) If there are zero actionable issues, do nothing and exit cleanly.
          " --allowedTools "Bash,Read,Edit"
```

### Secrets you must add (Repo → Settings → Secrets and variables → Actions)
- `ANTHROPIC_API_KEY`
- `SONAR_TOKEN` (or whatever you use to call Sonar)
- `GITHUB_TOKEN` is already provided automatically by Actions

---

## 2) Make it truly unattended: enable Auto-merge for the PRs
You have two common options:

### Option A (simple): enable “Auto-merge” in the repo settings + branch protections
- Require status checks to pass
- Require PR reviews (optional)
- Then have your agent set the PR to auto-merge (can be done with `gh pr merge --auto --squash`)

Add this line to the end of your agent instructions (or run it in a step after PR creation):
```bash
gh pr merge --auto --squash --delete-branch
```

### Option B (safer): require a label or CODEOWNERS approval
If you’re worried about fully hands-off merges, require:
- a reviewer approval, or
- a special label (applied by a bot or you), before merge

---

## 3) One thing to refactor from your current setup
Your “Cloud Code slash command” is interactive. For CI you want the same logic as either:
- a repo script (`./scripts/autofix_once.sh` / `autofix_once.ts`) that the workflow runs, **or**
- a prompt-driven run where Claude performs the API calls + edits + PR creation itself.

The script approach tends to be more reliable: scripts do the plumbing (Sonar query, PR creation), Claude does the code edits.

---

## 4) Guardrails I strongly recommend
- **Hard cap per PR**: max files changed, max LOC, max time
- **Stop if it can’t keep changes small** (prevents “mega PR”)
- **Stop on flaky tests** (don’t loop endlessly)
- **One PR open at a time** (already handled)

---

If you tell me **where Sonar lives** (SonarCloud vs self-hosted SonarQube) and what language stack you’re fixing (TS/Go/Python/etc.), I’ll give you a tight `sonar_actionable_count.sh` (or equivalent) and a “PR creation” script so the loop is rock-solid.

---

## User

Sonarcloud

---

## Assistant

Mr. White — with SonarCloud + GitHub, the simplest “runs while you’re away” loop is **merge-driven GitHub Actions**:

- Every merge to `main` triggers a workflow.
- Workflow **exits** if there’s already an open “autofix” PR.
- Otherwise it runs **one** “fix batch → open PR”.
- When that PR merges, the workflow triggers again → repeats until SonarCloud reports **0 actionable issues**.

### 1) SonarCloud “are we done?” check (script)
Create `scripts/sonar_actionable_count.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

: "${SONAR_TOKEN:?missing SONAR_TOKEN}"
: "${SONAR_PROJECT_KEY:?missing SONAR_PROJECT_KEY}"

# SonarCloud Web API is available at sonarcloud.io/api/*  citeturn0search2
# Token auth: basic auth username=token, blank password  citeturn0search5

count=$(
  curl -sS -u "${SONAR_TOKEN}:" \
    "https://sonarcloud.io/api/issues/search?componentKeys=${SONAR_PROJECT_KEY}&resolved=false&types=BUG,VULNERABILITY,CODE_SMELL&severities=BLOCKER,CRITICAL,MAJOR&ps=1" \
  | jq -r '.total'
)

echo "${count}"
```

Notes:
- `ps=1` makes it fast; `total` still tells you how many match.
- Tune `types`/`severities` to match what your automation safely fixes.

### 2) GitHub Actions workflow (one PR at a time, loops on merge)
Create `.github/workflows/sonar-autofix.yml`:

```yaml
name: Sonar Autofix Loop

on:
  push:
    branches: [ main ]      # runs after merges to main
  workflow_dispatch: {}
  schedule:
    - cron: "23 * * * *"    # optional safety net

concurrency:
  group: sonar-autofix-loop
  cancel-in-progress: false

permissions:
  contents: write
  pull-requests: write

jobs:
  autofix:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }

      - name: Exit if an autofix PR is already open
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: |
          open_count=$(gh pr list --state open --label "autofix" --json number --jq 'length')
          if [ "$open_count" -gt 0 ]; then
            echo "Autofix PR already open; exiting."
            exit 0
          fi

      - name: Exit if SonarCloud has no actionable issues
        env:
          SONAR_TOKEN: ${{ secrets.SONAR_TOKEN }}
          SONAR_PROJECT_KEY: ${{ secrets.SONAR_PROJECT_KEY }}
        run: |
          chmod +x scripts/sonar_actionable_count.sh
          n=$(scripts/sonar_actionable_count.sh)
          echo "Actionable issues: $n"
          if [ "$n" = "0" ]; then exit 0; fi

      - name: Run your “one batch” autofix (must open exactly one PR)
        env:
          SONAR_TOKEN: ${{ secrets.SONAR_TOKEN }}
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: |
          # Replace this with whatever runs your existing Cloud Code logic non-interactively,
          # or refactor the slash-command logic into a script.
          ./scripts/autofix_once.sh

      - name: Enable auto-merge (optional)
        if: ${{ always() }}
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: |
          # If your script already enabled auto-merge, you can remove this.
          # gh pr merge supports --auto  citeturn0search10
          # Repo must have auto-merge enabled; it merges once requirements pass. citeturn0search3
          pr=$(gh pr list --state open --label "autofix" --json number --jq '.[0].number // empty')
          if [ -n "$pr" ]; then
            gh pr merge "$pr" --auto --squash --delete-branch
          fi
```

### 3) Secrets to add (Repo → Settings → Secrets and variables → Actions)
- `SONAR_TOKEN`
- `SONAR_PROJECT_KEY` (your SonarCloud project key)
- `GITHUB_TOKEN` is automatic.

### 4) The only refactor you likely need
Your current slash command is interactive. For Actions, make **one** entrypoint that does exactly one iteration:

`./scripts/autofix_once.sh` should:
1) query SonarCloud → pick a batch  
2) create branch → apply fixes → run checks  
3) `gh pr create … --label autofix`  
4) optionally enable auto-merge

That’s it. GitHub handles the “keep going” loop via merges.

If you paste what your slash command currently runs (high level steps/commands), I’ll translate it into a robust `autofix_once.sh` skeleton that’s idempotent and won’t open duplicate PRs.


## See Also
- [[chatgpt/chatgpt_add-column-index-to-loop]]
- [[chatgpt/chatgpt_claude-ralpha-loop]]
- [[chatgpt/chatgpt_coderabbit-auto-loop]]
- [[chatgpt/chatgpt_codex-loop-optimization]]
- [[chatgpt/chatgpt_fix-ring-doorbell-boot-loop]]
