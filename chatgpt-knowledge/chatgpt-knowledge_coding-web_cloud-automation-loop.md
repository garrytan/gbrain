---
title: "Cloud automation loop"
type: essay
created: 2026-01-21
updated: 2026-01-21
source: chatgpt-export
topic: coding-web
message_count: 8
tags: [chatgpt, knowledge, coding-web]
---
# Cloud automation loop

> **Source:** ChatGPT conversation
> **Date:** 2026-01-21T21:20:46Z
> **Messages:** 8
> **Topic:** coding-web

## Question

Yo, dog, I have a cloud code slash command that automatically pulls in the latest issues from the Sonar API, and then prioritizes and triages them, and then it picks a group of the top offenders, the like ones that are the highest priority, that can be dealt with in one single PR and addresses them, and then runs a few other slash commands to verify and simplify the code, and then it opens up a PR. How can I get it so that, and it does a really good job of doing this, and then all of those issues are handled, and they're all like high enough complexity issues and things that can be automatically handled. How can I get this to just like trigger in the cloud to run continuously so that when one agent finishes, it triggers another one to go through the same exact thing and just keeps going until we're at zero?

## Answer

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
   Multiple dependent PRs on top of 

*(Answer truncated — 4420 chars total)*

## Question

The way I currently run it is I have a slash command in Cloud Code, and I'm using Cloud Code on the app so I can use it on my phone or the desktop and it runs in the cloud, and I just run it manually and then let it go in the background, and then I come back to it once I see that the PR has merged and I run it again. I can run Cloud Code instance on my computer and have it keep firing these off, but it's a little less dependent and I have to always be by my machine. I'm kind of looking for a way to have this continuously run anytime I'm away from my machine so that work is still getting done while I'm off the clock.

## Answer

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

#

*(Answer truncated — 3893 chars total)*

## Question

GitHub 

## Answer

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
             add label 'autofix', include s

*(Answer truncated — 5061 chars total)*

## Question

Sonarcloud

## Answer

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
        run: 

*(Answer truncated — 4220 chars total)*
