
Mr. White, yes: **run the coding conductor on the MacBook Pro**.

Use the Mac as the **interactive coding machine** because it has the repo, GStack, worktrees, browser/dev tooling, and is almost always on. Use the desktop or a cheap VPS for **always-on monitoring/briefings**, because laptops sleep, disconnect, move networks, and get rebooted.

## Recommended split

```text
MacBook Pro M5 32GB
- Coder conductor
- Jovie repo + worktrees
- GStack
- Codex / Claude Code / Hermes coding workers
- Local tests, Playwright, Docker, browser debugging
- PR creation

Desktop PC
- Local model server
- FounderOS / fundraise / finance / content agents
- Overnight batch work
- Gmail/Airtable/Mercury/Typefully/Sentry monitoring
- Cheap local summarization/extraction

Cheap VPS
- Agent gateway / cron / webhook receiver
- Daily briefings
- “Wake up the laptop/desktop agent” orchestration
- Read-only health checks
```

The laptop should be the **coding workstation**, not the only always-on company brain. Put the always-on control plane on the desktop or a VPS.

## Use the Mac, but harden it

Do this:

```bash
# Keep Mac awake while plugged in
sudo pmset -c sleep 0 displaysleep 30 disksleep 0 powernap 1 womp 1

# Optional per-session keepalive
caffeinate -dimsu
```

Run the coding conductor in `tmux`, `zellij`, or `launchd`, and keep every implementation in a separate worktree:

```bash
cd ~/JovieInc/jovi

git worktree add ../jovi-fix-onboarding-oauth fix/onboarding-oauth
git worktree add ../jovi-fix-activation-event fix/activation-event
git worktree add ../jovi-sentry-p0-001 fix/sentry-p0-001
```

Rule:

```text
One bug / issue = one worktree = one branch = one PR.
```

## Local model vs OpenRouter

OpenRouter is useful, but mostly as a **model router and budget layer**. Their pricing page says input/output tokens are billed per model at posted rates, they say they do not mark up provider pricing, and pay-as-you-go has no minimum or lock-in. BYOK lets you bring provider keys; OpenRouter says BYOK normally costs 5% of the same model/provider cost, but the first 1M BYOK requests/month are free. citeturn369071view0turn369071view1turn369071view2

So the cost difference is:

```text
Direct provider API:
- Best if you know exactly which models you want.
- Cleaner billing directly with OpenAI/Anthropic/Google/etc.
- Fewer routing abstractions.

OpenRouter credits:
- Same posted provider pricing according to OpenRouter.
- Easier model switching.
- One key, one dashboard, per-key caps, routing/fallback.
- Good for agents.

OpenRouter BYOK:
- Provider bills you directly.
- OpenRouter routes requests.
- First 1M BYOK requests/month free, then 5% fee.
```

For Jovie, I would use OpenRouter for **non-core agents**, not as the main coding path. Keep coding on Codex/Claude Code subscriptions and direct tools where possible. Use OpenRouter for model fallback, cheap drafting, extraction, summarization, investor enrichment, and second-opinion review.

## Token cost examples

Assume one medium agent task uses:

```text
1M input tokens + 200K output tokens
```

Approximate API cost:

| Model class | Cost for 1M in + 200K out | Best use |
|---|---:|---|
| GPT-5.4 | ~$5.50 | hard planning, critical code review |
| GPT-5.4 mini | ~$1.65 | coding subagents, decent reasoning |
| Claude Sonnet 4.6 | ~$6.00 | complex coding, refactors, product reasoning |
| Claude Haiku 4.5 | ~$2.00 | summaries, triage, drafting |
| Gemini 2.5 Flash | ~$0.80 | cheap research, extraction, analysis |
| Gemini 2.5 Flash-Lite | ~$0.18 | bulk classification/summarization |
| DeepSeek V3.2 | ~$0.36 | cheap reasoning/coding-ish background work |

OpenAI lists GPT-5.4 at $2.50/M input and $15/M output, GPT-5.4 mini at $0.75/M input and $4.50/M output, and GPT-5.4 nano at $0.20/M input and $1.25/M output. citeturn485197view0 Anthropic lists Claude Sonnet 4.6 at $3/M input and $15/M output, Haiku 4.5 at $1/M input and $5/M output, and Opus 4.7 at $5/M input and $25/M output. citeturn485197view1 Google lists Gemini 2.5 Flash at $0.30/M input and $2.50/M output, and Gemini 2.5 Flash-Lite at $0.10/M input and $0.40/M output. citeturn485197view2 DeepSeek lists V3.2 cache-miss input at $0.28/M and output at $0.42/M. citeturn471972view0

The takeaway:

```text
Routing matters more than hosting.
```

If every agent uses Sonnet/GPT for every step, agents get expensive fast. If cheap agents do extraction/triage and frontier agents only do hard decisions/code, OpenRouter/API spend can stay low.

## Monthly API scenarios

Assume this monthly usage:

```text
10M input + 2M output tokens
```

Approximate monthly cost:

| Model | Monthly cost |
|---|---:|
| Gemini 2.5 Flash-Lite | ~$1.80 |
| DeepSeek V3.2 | ~$3.64 |
| Gemini 2.5 Flash | ~$8.00 |
| GPT-5.4 mini | ~$16.50 |
| GPT-5.4 | ~$55.00 |
| Claude Sonnet 4.6 | ~$60.00 |

At:

```text
100M input + 20M output tokens
```

Approximate monthly cost:

| Model | Monthly cost |
|---|---:|
| Gemini 2.5 Flash-Lite | ~$18 |
| DeepSeek V3.2 | ~$36 |
| Gemini 2.5 Flash | ~$80 |
| GPT-5.4 mini | ~$165 |
| GPT-5.4 | ~$550 |
| Claude Sonnet 4.6 | ~$600 |

So OpenRouter + cheap models can be dramatically cheaper than cloud GPUs for background work. Frontier agent loops can become more expensive than a rented GPU if you let them run constantly.

## Local model on your hardware

Your desktop’s RTX 2080 Ti class card commonly has **11GB GDDR6**, which limits how much of a modern coding model can fit fully on GPU. citeturn945331search4 Your M5 MacBook Pro supports up to 32GB unified memory and Apple lists 153GB/s memory bandwidth for the base M5 MacBook Pro. citeturn945331search5

Meaning:

```text
MacBook Pro M5 32GB:
- Better for local 7B–32B quantized models.
- Good enough for summaries, extraction, simple coding review.
- Fine for a local fallback model.
- Not a replacement for frontier coding agents.

Desktop 2080 Ti + 64GB RAM:
- Good for smaller GPU-offloaded local models.
- Bigger models will spill into system RAM/CPU and slow down.
- Better as always-on local inference box than as primary coding machine.
```

I would run a local model server on the **desktop first**, because it can stay on without disrupting your coding machine. Use the Mac local model only when you are actively developing.

## VPS / AWS / GPU cloud cost difference

There are three very different things people call “putting it on a VPS.”

### 1. Cheap CPU VPS

This is good for orchestration, cron, webhooks, briefings, and dashboards. It is bad for LLM inference.

DigitalOcean droplets start around $4/month, Hetzner’s small CPX tiers are in the single/low-double-digit monthly range after its 2026 price changes, and Linode/Akamai has historically offered a $5/month Nanode-type entry instance. citeturn811059search0turn811059search1turn811059search14

Use this for:

```text
- FounderOS gateway
- Cron jobs
- Health checks
- Sentry/GitHub/Airtable polling
- Slack/Telegram/email delivery
- Small SQLite/Postgres state DB
```

Do **not** use it for local LLM inference.

### 2. GPU cloud like RunPod

RunPod is much cheaper than AWS for raw GPU rental. Current listed on-demand prices include RTX A5000 at $0.16/hr, RTX 3090 at $0.22/hr, RTX 4090 at $0.34/hr, A40 at $0.35/hr, L4 at $0.44/hr, L40S at $0.79/hr, and H100 PCIe at $1.39/hr. citeturn369071view3

Approximate 24/7 monthly cost:

| GPU | Hourly | 24/7 monthly |
|---|---:|---:|
| RTX A5000 | $0.16/hr | ~$115/mo |
| RTX 3090 | $0.22/hr | ~$158/mo |
| RTX 4090 | $0.34/hr | ~$245/mo |
| A40 | $0.35/hr | ~$252/mo |
| L4 | $0.44/hr | ~$317/mo |
| L40S | $0.79/hr | ~$569/mo |
| H100 PCIe | $1.39/hr | ~$1,001/mo |

GPU cloud makes sense when:

```text
- You need higher VRAM than your own machines.
- You have batch jobs that can saturate the GPU.
- You want to run open-weight models privately.
- You can shut the GPU off when idle.
```

It is wasteful if it sits idle waiting for occasional agent calls.

### 3. AWS GPU instances

AWS is more reliable/integrated, but usually much more expensive for this use case. AWS says EC2 On-Demand lets you pay by hour/second with no long-term commitment. citeturn369071view4 Current third-party AWS price trackers show g4dn.xlarge around $0.526/hr, g6.xlarge around $0.805/hr, and g5.xlarge around $1.006/hr in us-east-1; 24/7 that is roughly $384/mo, $588/mo, and $734/mo respectively. citeturn581987search11turn581987search6turn581987search5 AWS G6 uses NVIDIA L4 GPUs with 24GB per GPU, while G5 uses NVIDIA A10G GPUs with 24GB per GPU. citeturn581987search10turn369071view5

For Jovie right now, AWS GPU is a bad default. It adds cloud ops burden and burns runway.

## Break-even intuition

A 24/7 RunPod RTX 4090 is roughly **$245/month**. For the same $245, using API routing at the “1M input + 200K output” task shape buys approximately:

```text
Claude Sonnet 4.6: ~41 medium tasks
GPT-5.4 mini: ~148 medium tasks
DeepSeek V3.2: ~673 medium tasks
Gemini 2.5 Flash-Lite: ~1,361 medium tasks
```

So hosted GPU only wins when you are doing **large, continuous, high-utilization inference** on open models. For your current stage, API routing wins.

## My recommended model strategy

Use four tiers:

```text
Tier 0 — Local
Use for: summaries, extraction, dedupe, Airtable cleanup, log clustering.
Where: desktop local model server.

Tier 1 — Cheap API
Use for: Gmail triage, investor enrichment, content first drafts, issue classification.
Models: Gemini Flash-Lite, Gemini Flash, DeepSeek, GPT nano/mini.

Tier 2 — Strong API
Use for: product reasoning, bug diagnosis, PR review, YC/fundraise writing.
Models: GPT-5.4 mini, Claude Sonnet, GPT-5.4.

Tier 3 — Subscription coding tools
Use for: real code changes, agentic repo work, tests, refactors.
Tools: Codex / Claude Code / GStack on the Mac.
```

Do not rotate models randomly for coding. Use routing by task type.

Bad:

```text
“Pick any cheap model and code.”
```

Good:

```text
- Planner: Claude Sonnet or GPT-5.4 mini
- Implementer: Codex/Claude Code
- Reviewer: different strong model
- Log classifier: local/Gemini Flash-Lite
- Investor enrichment: DeepSeek/Gemini Flash
- Content first draft: cheap model
- Final public/investor copy: strong model
```

## Concrete Jovie setup

### MacBook Pro

```text
Role: coding workstation
Agent: coder conductor
Model access: Codex + Claude Code + OpenRouter fallback
Runs: GStack, worktrees, tests, browser, PRs
```

### Desktop PC

```text
Role: always-on local ops box
Agents: founder-os, fundraise, finance, content
Model access: local model + OpenRouter cheap models
Runs: cron jobs, Airtable/Gmail/Mercury/Sentry checks
```

### VPS

```text
Role: uptime/control plane
Cost target: $5–20/mo
Runs: gateway, cron, alerts, webhook receiver, company_state store
Does not run: GPU inference
```

### Cloud GPU

```text
Role: optional burst compute
Use only when: local models become a real bottleneck
Provider preference: RunPod before AWS
Default state: off
```

## Decision

For now:

```text
1. Run coding conductor on the MacBook Pro.
2. Run local model server on the desktop.
3. Use OpenRouter for cheap non-coding agents and fallback.
4. Add a $5–20/mo VPS only for always-on gateway/cron reliability.
5. Avoid AWS GPU.
6. Avoid 24/7 GPU cloud unless you can prove sustained utilization.
```

Your bottleneck is activation/onboarding, so spend compute budget where it removes that bottleneck: **frontier coding on the laptop, cheap routing for background ops, local model for bulk grunt work.**


ok so this is all a lot for me to be seting up with limited runway.

can we focus on coding/founder os and put this only on the mbp for now with open ai subscription and gpt 5.4 mini on the codex subscription for primary stuff. then iteratively add more. 

and if my laptop is always on and doing the coding can founder os just live here too?

also does it make sense ot put anything direclty on cron/autoamtion from the codex app or claude desktop app?

or let hermes do it all?


Mr. White, simplify this to a minimum-viable stack first: one MacBook Pro, one coding conductor, one FounderOS loop, and no cloud or local-model complexity yet. I’ll also sanity-check Codex and Claude automation limits so the setup stays practical.


Mr. White, yes. **Put coding + FounderOS on the MacBook Pro for now.** Keep it simple until this produces daily value.

## Recommended v1 setup

```text
MacBook Pro only
│
├── Hermes founder-os
│   ├── daily Founder Briefing
│   ├── bottleneck detection
│   ├── Sentry/GitHub/Airtable/Gmail/YC task review
│   └── creates tasks, drafts, issue summaries
│
├── Hermes coder
│   ├── turns FounderOS/product tasks into coding tickets
│   ├── creates worktrees
│   ├── launches Codex / GStack
│   └── opens PRs
│
└── Codex app / Codex CLI
    ├── primary implementation agent
    ├── GPT-5.4 mini default
    ├── stronger model only when blocked
    └── repo-specific automation only
```

Do **not** add VPS, AWS, desktop local model, Claude routines, or OpenRouter routing yet unless the MacBook setup starts creating obvious bottlenecks.

## Can FounderOS live on the laptop too?

Yes. That is the right move for v1.

The tradeoff is uptime. If the Mac sleeps, reboots, loses internet, or Codex/Hermes is closed, scheduled work may miss. For now that is acceptable because your immediate need is **operational leverage**, not enterprise reliability.

Use this split:

```text
Hermes founder-os = company brain / briefing / routing
Hermes coder = coding manager
Codex = implementation worker
Tim = approval authority
```

## Should Hermes do all automation?

For v1: **Hermes should own the main schedule.**

Reason: you want one place that knows the company operating cadence. Hermes profiles have separate config, API keys, memory, sessions, skills, cron jobs, and state, so `founder-os` and `coder` can stay cleanly separated on the same machine. citeturn471569view3 Hermes also has built-in cron that can schedule recurring tasks, attach skills, deliver results, and save outputs locally. citeturn471569view0turn471569view2

Use Hermes for:

```text
- Daily Founder Briefing
- Morning bottleneck report
- Sentry/GitHub/analytics scan
- YC/fundraise deadline reminders
- Deciding what coding tasks should exist
- Writing task briefs for Codex
```

Important: Hermes cron jobs run in fresh sessions, so their prompts need to be self-contained. Do not schedule vague jobs like “check progress.” Schedule explicit jobs with the files, systems, and output format named. citeturn415989view5

## Should anything go directly into Codex automations?

Yes, but only **repo-native coding hygiene**.

Codex app automations can run recurring background tasks, report findings to its inbox, use skills, and run in a local project or a separate worktree. For project-scoped automations, the Codex app needs to be running and the selected project must be available on disk. citeturn471569view4turn415989view1

Use Codex automations for:

```text
- Nightly repo health scan
- Daily failing test / CI summary
- Dependency/security review
- “Scan onboarding code for obvious regressions”
- “Review open PRs and summarize risk”
```

Do **not** use Codex automations as the main FounderOS. Codex should stay close to the codebase. FounderOS should stay close to the company.

## Should anything go into Claude Desktop / Claude Code automation?

For now: **no**.

Claude Code has scheduled tasks and routines, but that adds another automation surface. Claude scheduled tasks inside a session are useful for polling and short-lived work, but they are session-scoped and recurring tasks expire after 7 days. citeturn415989view3 Claude routines are more durable and can run on Anthropic-managed infrastructure with schedules, API triggers, and GitHub triggers, but they are in research preview and add another system to monitor. citeturn415989view4

Given limited runway, skip Claude automation until you have a specific reason.

## Minimal automation stack

Use only these three at first:

### 1. Hermes FounderOS morning briefing

```bash
founder-os cron create "0 8 * * *" \
"Generate the Jovie Founder Briefing.

Read:
- /Users/tim/JovieInc/ops/company_state.md
- GitHub issues and PRs if available
- Sentry issues if available
- Airtable fundraise/status tables if available
- Gmail/customer/investor signals if available
- YC/speedrun task docs if available

Output:
1. Single current company bottleneck
2. Why it is the bottleneck
3. Top 3 actions for today
4. Product stability risks
5. Fundraise/accelerator risks
6. Decisions needed from Tim
7. Suggested coding tasks for coder profile

Rules:
- Do not send emails.
- Do not merge/deploy.
- Do not launch campaigns.
- Keep it concise and action-oriented." \
--name "Jovie Founder Morning Briefing"
```

### 2. Hermes P0 watch

```bash
founder-os cron create "0 */3 * * *" \
"Check only for P0/P1 issues that require Tim today.

Look for:
- production outage
- Sentry spike
- broken onboarding
- failed deploy
- urgent customer/investor reply
- YC/speedrun blocker
- runway/cash issue

If nothing requires action, output: No action required.
If action is required, output the exact next step and owner." \
--name "Jovie P0 Watch"
```

### 3. Codex repo health automation

In Codex app, create one project automation:

```text
Every weekday at 9am, inspect the Jovie repo in a separate worktree.

Goal:
Identify codebase risks that threaten onboarding activation or production stability.

Check:
- failing tests
- recent changes touching onboarding/auth/billing
- obvious TypeScript/runtime errors
- stale PRs
- security or dependency warnings if available

Output:
- Top risks
- Suggested fixes
- Whether a PR/task should be created
- Do not modify files unless explicitly asked
```

Keep this read-only at first.

## Do not automate implementation yet

Avoid this v1 automation:

```text
Every night, fix bugs and open PRs automatically.
```

That sounds useful but creates review burden and weird diffs. Start with:

```text
Every morning, tell me what deserves attention.
```

Then manually approve:

```text
founder-os → creates task brief
coder → creates worktree
Codex → implements
coder → reviews/opens PR
Tim → merges
```

## Immediate setup

Create just two Hermes profiles:

```bash
hermes profile create founder-os --clone
hermes profile create coder --clone

founder-os config set terminal.cwd /Users/tim/JovieInc/ops
coder config set terminal.cwd /Users/tim/JovieInc/jovi
```

Create these files:

```text
/Users/tim/JovieInc/ops/company_state.md
/Users/tim/JovieInc/ops/daily_briefings/
/Users/tim/JovieInc/ops/agent_tasks/
/Users/tim/JovieInc/jovi/AGENTS.md
```

Put this in `company_state.md`:

```markdown
# Jovie Company State

## North Star
Revenue / MRR.

## Current Bottleneck
Onboarding activation stability.

## Strategy
No new features until users are paying or explicitly saying why they are not paying.

## Current Priorities
1. Stabilize onboarding.
2. Get users to activation.
3. Submit YC by May 4, 2026.
4. Build warm bridge investor pipeline.
5. Turn on GTM only after activation works.

## Approval Rules
- No merge to main without Tim approval.
- No production deploy without Tim approval.
- No investor/customer email send without Tim approval.
- No Instantly campaign launch without Tim approval.
- Drafting, summarizing, issue creation, and PR creation are allowed.
```

## Final recommendation

Run this on the MBP:

```text
Hermes = orchestration and FounderOS
Codex = code execution
Codex automations = repo-only scans
Claude automation = skip for now
VPS/cloud/local model = skip for now
```

This gives you the highest leverage with the lowest setup cost. Once the morning briefing and coding loop are useful for 7 straight days, then add fundraise automation or VPS uptime.


And for all those repo docs when it's working on updating all the company state and all that stuff, what's the best way to handle actually shipping that? For the ops repo should we be opening PRs? Should it just be merging directly into the branch? Should that be on a cron job? Should that be attached to every operation? Should there be a blanket rule for shipping?

And then on the code side we always use GStack and the /ship command from GStack and the /review command from GStack. For feature building it goes through the whole GStack pipeline. What's the split on what those should be used for, like repo stuff, ops stuff versus code stuff? 


Mr. White, I’d treat ops docs differently from product code: ops state should move fast with an audit trail, while product code should keep the full GStack review/ship gate. I’ll check GStack’s current command semantics before giving the split.


Mr. White, use **two shipping lanes**:

```text
Code repo = PR-only through GStack.
Ops repo = direct commits for generated logs; PRs for canonical decisions.
```

## Blanket rule

```text
If it changes product behavior, agent behavior, strategy, permissions, customer/investor messaging, or anything canonical → PR.

If it is generated, append-only, timestamped, and informational → commit directly.

If it touches production code → GStack pipeline.

If it is a daily briefing/status/log → no PR.
```

## Ops repo policy

The ops repo should have two classes of files.

### 1. Canonical files — PR required

These are “source of truth” files:

```text
ops/company_state.md
ops/bottleneck_scorecard.yaml
ops/agents/founder-os.md
ops/agents/coder.md
ops/agent_rules.md
ops/fundraise_strategy.md
ops/gtm_strategy.md
ops/content_voice.md
ops/yc_application.md
ops/runbooks/*.md
```

Require PRs for these because changing them changes how the company or agents operate.

Examples:

```text
- Change current bottleneck from onboarding to fundraising → PR
- Change approval rules → PR
- Change FounderOS prompt → PR
- Change coding-agent permissions → PR
- Change fundraise strategy → PR
- Change YC answer drafts → PR
```

### 2. Generated files — direct commit allowed

These are logs/artifacts:

```text
ops/daily_briefings/2026-04-21.md
ops/p0_watch/2026-04-21-1200.md
ops/agent_runs/2026-04-21.jsonl
ops/inbox/suggested_tasks/2026-04-21-onboarding.md
ops/proposals/2026-04-21-state-update.md
```

These should be committed directly because a PR for every briefing creates noise.

Examples:

```text
- Daily Founder Briefing → direct commit
- P0 watch output → direct commit
- Suggested coding tasks → direct commit
- Investor follow-up summary → direct commit
- Proposed company_state update → direct commit to proposals/
```

The agent can write a proposal, but canonical state changes still need approval.

## Recommended branch setup for ops

Keep it simple:

```text
main
  - canonical ops docs
  - generated briefings/logs
  - protected enough to prevent accidental destructive changes
```

For now, direct commit generated artifacts to `main`. You are a small team and speed matters.

Once this gets noisy, split it:

```text
main
  - canonical docs only

agent-state
  - generated briefings, logs, snapshots
```

Do **not** start with the two-branch version unless the repo gets noisy.

## GitHub branch protection

For the code repo, protect `main` hard. GitHub branch protection can require pull requests, approvals, and required status checks before merging. GitHub’s docs also describe requiring status checks to pass before merge. citeturn252581search0turn252581search3

For the ops repo, use lighter protection:

```text
Code repo main:
- Require PR
- Require status checks
- Require review if practical
- No direct pushes by agents

Ops repo main:
- Direct commits allowed only for generated paths
- PR required by convention for canonical files
- Later: enforce with CODEOWNERS/GitHub rules if needed
```

## Path-based rule for FounderOS

Put this in the FounderOS instructions:

```text
Shipping rules for ops repo:

Direct commit allowed:
- ops/daily_briefings/**
- ops/p0_watch/**
- ops/agent_runs/**
- ops/inbox/**
- ops/proposals/**
- ops/snapshots/**

PR required:
- ops/company_state.md
- ops/bottleneck_scorecard.yaml
- ops/agents/**
- ops/runbooks/**
- ops/strategy/**
- ops/yc/**
- ops/fundraise/**
- ops/gtm/**
- any file that changes agent permissions, approval rules, company priorities, or external messaging

Never commit:
- secrets
- API keys
- bank exports with sensitive data
- raw Gmail exports
- raw investor private notes unless intentionally sanitized
```

## How FounderOS should update company state

FounderOS should **not directly rewrite `company_state.md` every morning**.

Use this flow:

```text
1. FounderOS writes daily briefing.
2. FounderOS detects whether company_state.md is stale.
3. If stale, it writes a proposed patch to ops/proposals/.
4. If Tim approves, FounderOS opens a PR changing company_state.md.
```

Example:

```text
ops/proposals/2026-04-21-company-state-update.md
```

Content:

```markdown
# Proposed Company State Update — 2026-04-21

## Proposed change
Current bottleneck should remain: onboarding activation stability.

## Reason
- New signups are still bouncing before activation.
- No MRR yet.
- GTM engine exists but should not be scaled until activation works.

## Suggested patch
```diff
- Current Bottleneck: TBD
+ Current Bottleneck: Onboarding activation stability
```

## Requires approval?
Yes — this changes canonical state.
```

Then the agent asks or waits for an approval command:

```text
Approve the company_state update and open a PR.
```

## Commit cadence

Use this:

```text
Daily briefing cron:
- write file
- commit immediately

P0 watch cron:
- commit only if there is an alert or state change

Every coding operation:
- write task brief to ops/inbox/suggested_tasks/
- commit direct
- code change happens in code repo through GStack

Canonical ops update:
- branch
- commit
- PR
- Tim approval
- merge
```

Avoid one commit per tiny internal thought. Commit useful artifacts only.

Good commit messages:

```bash
chore(ops): add founder briefing for 2026-04-21
chore(ops): log p0 watch alert for onboarding errors
chore(ops): propose company state update
docs(ops): update founder-os approval rules
docs(ops): update current bottleneck
```

## GStack split

### Use GStack for code repo work

Use GStack for anything in `JovieInc/jovi` that affects the product:

```text
- app code
- onboarding
- auth
- billing
- database/schema/migrations
- APIs
- CI/CD
- tests
- production bug fixes
- Sentry fixes
- dependency changes
- runtime config
- frontend UX changes
```

GStack’s own docs describe `/ship` as the final-mile workflow for a ready branch: sync with main, run tests, verify branch state, update changelog/versioning if expected, push, and create or update the PR. citeturn462738view6 The skill file also describes `/ship` as detecting/merging the base branch, running tests, reviewing the diff, bumping version/changelog, committing, pushing, and creating the PR. citeturn462738view0

So for code:

```text
Plan → build in worktree → /review → fix findings → /ship → PR → Tim approves merge/deploy
```

### Use `/review` for meaningful diffs

Use `/review` before `/ship` when there is real code. GStack’s review skill dispatches testing and maintainability specialists for diffs of 50+ lines and conditionally dispatches security, performance, data migration, API contract, and other specialists depending on scope. citeturn462738view3turn462738view4

Use `/review` for:

```text
- onboarding/auth/billing changes
- backend/API changes
- migrations
- security-sensitive code
- large frontend changes
- anything over ~50 lines
- any fix that came from a Sentry production issue
```

Skip full `/review` only for trivial changes:

```text
- typo
- comment
- one-line copy change
- generated briefing
- internal ops log
```

### Use `/ship` only when branch is ready

`/ship` should not be the planning tool. GStack docs explicitly frame `/ship` as “final mile” for a ready branch, after you know what you built and want disciplined release execution. citeturn462738view6

Use `/ship` when:

```text
- implementation is done
- tests have been added/updated
- local smoke test is sane
- branch should become a PR
```

Do not use `/ship` for:

```text
- deciding what to build
- daily FounderOS reports
- generated ops logs
- exploratory planning
- fundraise notes
- raw content drafts
```

## Should GStack touch the ops repo?

Usually no.

Use GStack in the ops repo only when the ops change behaves like a real project change:

```text
Use GStack for ops repo:
- agent prompt refactor
- new FounderOS workflow
- new automation script
- new Airtable/Gmail/Sentry integration script
- cron runner code
- repo-level CI or scripts
- changes that could break automation

Do not use GStack for ops repo:
- daily briefing
- p0 watch log
- proposed task file
- founder note
- investor summary
- meeting notes
```

For ops docs, a simple branch + PR is enough:

```bash
cd ~/JovieInc/ops
git checkout -b ops/update-company-state-2026-04-21
# edit canonical docs
git add company_state.md
git commit -m "docs(ops): update current company bottleneck"
gh pr create --title "Update current company bottleneck" --body "Updates company_state.md based on current onboarding activation status."
```

## The actual operating loop

Use this exact split:

```text
FounderOS cron
→ writes daily briefing directly to ops repo
→ writes proposed tasks directly to ops repo
→ if canonical state needs changing, writes proposal
→ Tim approves or rejects

Coder agent
→ reads approved/suggested coding task
→ creates worktree in code repo
→ uses Codex/GStack to implement
→ runs /review
→ runs /ship
→ opens PR
→ Tim approves merge/deploy
```

## Recommended default policy

Paste this into `ops/agent_rules.md`:

```markdown
# Jovie Agent Shipping Policy

## Repos

### jovi code repo
All product/runtime code changes require the GStack pipeline.

Required flow:
1. Create branch/worktree.
2. Implement.
3. Run relevant tests.
4. Run /review for meaningful diffs.
5. Run /ship to create/update PR.
6. Tim approves merge/deploy.

No agent may directly push to main.

### ops repo
The ops repo has two classes of files.

Generated artifacts may be committed directly:
- daily_briefings/**
- p0_watch/**
- agent_runs/**
- inbox/**
- proposals/**
- snapshots/**

Canonical files require PR:
- company_state.md
- bottleneck_scorecard.yaml
- agents/**
- strategy/**
- runbooks/**
- yc/**
- fundraise/**
- gtm/**
- any approval/permission rule

## Approval Rules
Agents may:
- write briefings
- write proposals
- create branches
- create PRs
- create suggested coding tasks

Agents may not, without Tim approval:
- merge product code
- deploy production
- send external emails
- launch campaigns
- change canonical company strategy
- change agent permissions
- commit secrets
```

## My recommendation

Start with this:

```text
Ops repo:
- Direct commits for daily generated artifacts.
- PRs for canonical docs.
- No GStack for daily ops logs.
- Optional GStack only for ops automation code.

Code repo:
- Always GStack.
- /review for meaningful code changes.
- /ship for final PR creation.
- No direct main commits.
```

This keeps FounderOS lightweight and useful while preserving discipline where it matters: product code, agent permissions, strategy, and production behavior.


Yeah so founder is always going to spit out tasks to coder. Is that the idea? I have most of the general setup described here already in place. For achieving the stabilization phase what would be the exact workflow?
- Founder dictates it to Coder or Founder?
- Do they talk directly or do we save it to a markdown file and commit?
Then separately how do we get Coder to pick it up? Having it constantly watch a folder or are they able to take a webhook or something? How do we get them to actually trigger it or do we just manually paste it over?


Mr. White, the cleanest v1 is a file-based handoff with explicit status, then add webhooks or watchers only after the loop works manually for a few days. I’ll narrow this to the stabilization operating loop: who decides, where the task lives, how Coder picks it up, and what to automate now versus trigger manually.


And then what's the physical interface look like for this? Should there always be a separate terminal open for each one of the agents or just the founder exists and then we allow it to spin up the others with their profiles? 


FounderOS should create a durable task contract, and Coder should execute approved task contracts. For v1, keep both as persistent agents in separate visible terminals, and avoid freeform agent chatter or hidden nested agents as the source of truth.


## See Also
- [[chatgpt/chatgpt_aramis-agent-profile-management-part1]]
- [[chatgpt/chatgpt_aramis-agent-profile-management-part3]]
- [[chatgpt/chatgpt_ai-agent-automation-part2]]
- [[chatgpt/chatgpt_ai-engineering-agent-prompt-part2]]
- [[chatgpt/chatgpt_automate-visual-profile-follow-part2]]
