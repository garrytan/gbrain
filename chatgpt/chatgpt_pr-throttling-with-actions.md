---
title: "PR Throttling with Actions"
type: guide
created: 2026-02-25
updated: 2026-02-25
source: chatgpt-export
conversation_id: 699e4f36-bb40-8328-bd71-e2999e992703
message_count: 2
tags: [chatgpt, import, code]
---
# PR Throttling with Actions

> Conversation ID: 699e4f36-bb40-8328-bd71-e2999e992703
> Created: 2026-02-25T01:25:17Z
> Updated: 2026-02-25T01:25:55Z
> Messages: 2

---

## User

Yeah, that's what the CI is set up so that when I have issues, I'll basically do like brain dumps into ChatGPT, like talking into it or into Claude, and then I'll have it, I'll just like tell it all the bugs that I notice on the site, tell it what should be changed, tell it any things, any work done, any features or whatever, and then I'll have it go and open up issues in linear. And it'll sort those issues and my priority and stuff like that. And then I'll go and when we move issues into the to-do category, it automatically triggers a CodeRabbit issue plan. That issue plan gets created and then we have a CI job that gets triggered that then goes and assigns Codex agent in linear to that job. And then when Codex is done, it won't automatically open up PR, so we have a CI job that checks for Codex branches that have been pushed and then opens a PR. The problem is that sometimes that means that like I'll have 50 PRs open or come in all at the same time because I opened up like 50 issues at once. And I'm thinking that like maybe the move is to have some kind of like either throttle this auto PR thing so that it only opens up one PR at a time or five at a time or something like that, or like opens them like sequentially over like 60 seconds or two minute delays or something. Basically so that doesn't just slam all of the actions runners. What would be like the most efficient way to do this?

---

## Assistant

Mr. White — the simplest, highest-leverage fix is to **use GitHub Actions’ built-in queueing via `concurrency`** on the “open PR” workflow, so branch pushes can happen freely but **PR creation runs are serialized (or limited to N at a time)**.

## Option A (best + simplest): queue PR openings with `concurrency`
Every codex branch push triggers the PR-opener workflow, but only **1 run executes at a time**; the rest sit queued automatically (no runner slam).

```yaml
name: Open PR for Codex branches

on:
  push:
    branches:
      - "codex/**"

concurrency:
  group: pr-opener   # single global lane
  cancel-in-progress: false

jobs:
  open-pr:
    runs-on: ubuntu-latest
    steps:
      - name: Create PR if missing
        run: |
          # your script: check if PR exists for $GITHUB_REF_NAME; if not, open it
```

Why this is efficient:
- No extra infrastructure.
- No custom queue.
- Prevents 50 simultaneous jobs from starting and consuming runners.

## Option B: allow “up to 5 at a time” (still easy)
You can shard into 5 lanes by making the concurrency group depend on a stable hash/mod of the branch name. The idea: **same branch always maps to same lane**, and you get **~5 parallel PR-openers max**.

Example approach (pseudo — implement hash in a step, then use `workflow_call`/dispatch), because `concurrency.group` can’t easily run shell hashing inline. Practical pattern:
1) Push workflow computes lane (0–4) and triggers a reusable workflow with an input `lane`.
2) Reusable workflow sets `concurrency.group: pr-opener-${{ inputs.lane }}`.

If you don’t want the extra plumbing, stick to Option A; it’s usually enough.

## Option C: throttle based on “open PR count”
Add a guard so you never exceed, say, **10 open Codex PRs**:
- If over limit: **exit 0** (don’t open new PR).
- Then a scheduled workflow (every 5–10 min) can scan for codex branches without PRs and open the next batch.

This is great if the real pain is *review bandwidth*, not just runner capacity.

## What I’d do in your system
1) **Add Option A** to the PR-opener workflow today (global `concurrency` queue).
2) If you still want faster throughput, move to **Option B (5 lanes)**.
3) If PR volume is the bigger problem, add **Option C** (cap open PRs + scheduled “drain the queue”).

If you tell me where the PR creation happens (GitHub Action using `gh pr create`? a custom script? a GitHub App?), I can sketch the exact guard checks (PR-exists detection + branch naming + lane sharding) in the style you’re already using.
