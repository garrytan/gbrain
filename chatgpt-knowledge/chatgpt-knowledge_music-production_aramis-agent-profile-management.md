---
title: "Aramis Agent Profile Management"
type: essay
created: 2026-04-19
updated: 2026-04-19
source: chatgpt-export
topic: music-production
message_count: 22
tags: [chatgpt, knowledge, music-production]
---
**Topic:** [[chatgpt-knowledge/_topics/music-production]]

# Aramis Agent Profile Management

> **Source:** ChatGPT conversation
> **Date:** 2026-04-19T21:14:08Z
> **Messages:** 22
> **Topic:** music-production

## Question

Hey, okay, so I'm using you right now to help me plan. You know everything about Jovi, I believe you do. If you don't, then you've got the context of the repo, Jovi Inc slash Jovi and Jovi Inc slash ops. Basically what I'm doing right now is we're using AirMe's agent. So I've got an AirMe's agent running on my MacBook Pro laptop, and that one is running in conductor. I basically have one workspace that's running that AirMe's agent, and it's basically set to be like the coder agent, so it's orchestrating our code. And so I have it basically, the idea is that it would go through and trigger each one of the individual... The idea is that it would basically trigger all of the different... It should be spinning up AirMe's agents using the way that... That it lets you do that, where it's like, it can spin up agents in isolated work trees, and then those agents, like, don't carry the full context, they just have the context of the task, and then it's delegating tasks to each one of those agen

## Answer

Mr. White, the move is **one persistent Founder/Chief-of-Staff agent, several persistent department agents, and many disposable coding/research workers**. Do **not** build an infinitely nested “CEO agent → manager agents → manager agents → worker agents” system. It will burn tokens, lose context, and create unclear ownership. Use a simple command structure with human approval gates.

## Direct answers

### Can Hermes/“Aramis” create profiles and clone itself?

Yes, assuming the tool is **Hermes Agent**. Hermes profiles are separate agent instances with their own config, API keys, memory, sessions, skills, cron jobs, and gateway state. A new profile also gets its own command alias, for example `coder chat`, `coder setup`, `coder gateway start`. Hermes supports `profile create`, `--clone`, `--clone-all`, and `--clone-from`. citeturn554293view0turn554293view4

So an operator agent with terminal access can run something like:

```bash
hermes profile create fundraise --clone
fundraise setup
fundraise config set terminal.cwd /absolute/path/to/JovieInc/ops
```

Use `--clone` for new role agents. It copies config, `.env`, and `SOUL.md`, while giving the new profile fresh sessions and memory. Use `--clone-all` only for backups or forking an agent that truly needs the full old memory/session state. citeturn554293view0turn554293view5

### Should you open a new terminal or let the agent create/run the new profile?

For a **persistent department agent**, create a new profile and run it as its own process/gateway/service. Hermes profiles can run their own gateways as separate processes, and each profile can be installed as its own service. citeturn554293view2turn554293view3

For a **one-off task**, use delegation/subagents. Hermes `delegate_task` can spawn child agents with isolated context and terminal sessions, with up to 3 concurrent subagents. Those children start with no parent conversation history, so the parent must pass a complete task brief. citeturn554293view6turn554293view7

### Can it run multiple agents simultaneously?

Yes. Use three layers:

1. **Persistent profiles** for enduring roles: Chief of Staff, Coder, Fundraise, Content, Finance.
2. **Git worktrees** for parallel code changes. Hermes’ docs specifically recommend worktrees when running multiple agents on the same repo because each agent gets its own branch and working directory. citeturn280545view4turn554293view8
3. **Codex/Claude subagents or agent teams** for highly parallel exploration, review, debugging, and multi-part implementation. Codex supports subagents in the app/CLI and can spawn specialized agents in parallel, but token use rises because each child does its own model/tool work. citeturn754069view3 Claude Code agent teams can coordinate multiple Claude Code instances, but Anthropic labels the feature experimental and warns about coordination overhead and token cost. citeturn754069view0turn754069view1

## Recommended Jovie operating system

Use this 

*(Answer truncated — 23823 chars total)*

## Question

ok now for the coding agent we probably want that running on the laptop? the laptop is almost always on. should we jsut run on the mac? 
and also for local model, whats the cost differrnce if we use like openrouter and rotate through models there ?

and whats the advatage or cost diff if we put this on a vps or run it in aws or something

## Answer

I’ll compare three deployment options for Jovie’s coding agent: the always-on Mac, hosted API routing through OpenRouter, and VPS or AWS, focusing on cost, reliability, and fit.

## Answer

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

Ass

*(Answer truncated — 11503 chars total)*

## Question

ok so this is all a lot for me to be seting up with limited runway.

can we focus on coding/founder os and put this only on the mbp for now with open ai subscription and gpt 5.4 mini on the codex subscription for primary stuff. then iteratively add more. 

and if my laptop is always on and doing the coding can founder os just live here too?


also does it make sense ot put anything direclty on cron/autoamtion from the codex app or claude desktop app?

or let hermes do it all?

## Answer

Mr. White, simplify this to a minimum-viable stack first: one MacBook Pro, one coding conductor, one FounderOS loop, and no cloud or local-model complexity yet. I’ll also sanity-check Codex and Claude automation limits so the setup stays practical.

## Answer

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

Do **not** use Codex automations as the main FounderOS. Codex should stay

*(Answer truncated — 7569 chars total)*

## Question

And for all those repo docs when it's working on updating all the company state and all that stuff, what's the best way to handle actually shipping that? For the ops repo should we be opening PRs? Should it just be merging directly into the branch? Should that be on a cron job? Should that be attached to every operation? Should there be a blanket rule for shipping?

And then on the code side we always use GStack and the /ship command from GStack and the /review command from GStack. For feature building it goes through the whole GStack pipeline. What's the split on what those should be used for, like repo stuff, ops stuff versus code stuff? 

## Answer

Mr. White, I’d treat ops docs differently from product code: ops state should move fast with an audit trail, while product code should keep the full GStack review/ship gate. I’ll check GStack’s current command semantics before giving the split.

## Answer

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
- Later: enforce with CODEOWNERS/Git

*(Answer truncated — 10568 chars total)*

## Question

Yeah so founder is always going to spit out tasks to coder. Is that the idea? I have most of the general setup described here already in place. For achieving the stabilization phase what would be the exact workflow?
- Founder dictates it to Coder or Founder?
- Do they talk directly or do we save it to a markdown file and commit?
Then separately how do we get Coder to pick it up? Having it constantly watch a folder or are they able to take a webhook or something? How do we get them to actually trigger it or do we just manually paste it over?

## Answer

Mr. White, the cleanest v1 is a file-based handoff with explicit status, then add webhooks or watchers only after the loop works manually for a few days. I’ll narrow this to the stabilization operating loop: who decides, where the task lives, how Coder picks it up, and what to automate now versus trigger manually.

## Question

And then what's the physical interface look like for this? Should there always be a separate terminal open for each one of the agents or just the founder exists and then we allow it to spin up the others with their profiles? 

## Answer

FounderOS should create a durable task contract, and Coder should execute approved task contracts. For v1, keep both as persistent agents in separate visible terminals, and avoid freeform agent chatter or hidden nested agents as the source of truth.

## Answer

Mr. White, yes: **FounderOS should continuously produce coding task contracts for Coder**, but the source of truth should be **markdown files in the ops repo**, not invisible agent-to-agent chat.

The clean pattern is:

```text
FounderOS decides what matters
→ writes a task contract in ops repo
→ Tim approves the task
→ Coder picks up the approved task
→ Coder creates worktree
→ Coder uses Codex + GStack
→ /review
→ /ship
→ PR opened
→ task file updated with PR/result
```

## Core answer

Use this for now:

```text
FounderOS does not freeform “tell Coder what to do.”
FounderOS writes task markdown.
Coder executes approved task markdown.
```

Agent-to-agent direct communication can exist later, but it should **never be the only record**. You want a durable trail of what was requested, why, what got shipped, and what happened.

## Exact stabilization workflow

### 1. FounderOS runs triage

Every morning, FounderOS reads:

```text
- company_state.md
- Sentry issues
- GitHub issues / PRs
- analytics / onboarding funnel if available
- previous daily briefings
- current open task files
```

It outputs:

```text
ops/daily_briefings/2026-04-21.md
ops/tasks/coder/proposed/STAB-001-fix-onboarding-oauth.md
ops/tasks/coder/proposed/STAB-002-add-activation-event-logging.md
ops/tasks/coder/proposed/STAB-003-investigate-signup-dropoff.md
```

FounderOS should create **small stabilization tasks**, not giant “fix onboarding” tasks.

Good task:

```text
Fix OAuth callback blank screen for new users.
```

Bad task:

```text
Stabilize onboarding.
```

### 2. Tim approves the next tasks

You say to FounderOS:

```text
Approve STAB-001 and STAB-003. Dispatch STAB-001 to Coder first.
```

FounderOS moves files:

```text
ops/tasks/coder/proposed/STAB-001-fix-onboarding-oauth.md
```

to:

```text
ops/tasks/coder/approved/STAB-001-fix-onboarding-oauth.md
```

and commits:

```bash
git add ops/tasks/coder
git commit -m "chore(ops): approve STAB-001 onboarding oauth fix"
```

### 3. Coder picks up the approved task

For v1, trigger Coder manually:

```bash
coder chat -q "Execute the approved task at /Users/tim/JovieInc/ops/tasks/coder/approved/STAB-001-fix-onboarding-oauth.md. Follow the task contract exactly. Use the Jovie code repo at /Users/tim/JovieInc/jovi. Create a worktree, implement with Codex/GStack, run /review before /ship, and update the task file with status and PR link."
```

Hermes profiles become their own command aliases, and the docs show commands such as `coder chat`, `coder gateway start`, and explicit profile targeting with `hermes chat -p coder -q "hello"`. citeturn330214view1

### 4. Coder creates worktree and implements

Coder does:

```bash
cd /Users/tim/JovieInc/jovi
git worktree add ../jovi-STAB-001 fix/STAB-001-onboarding-oauth
cd ../jovi-STAB-001
```

Then uses Codex/GStack:

```text
- reproduce issue
- identify cause
- implement minimal fix
- add regression test if possible
- run relevant tests
- run /review
- fix review findings
- run /ship

*(Answer truncated — 11687 chars total)*

## Question

The other thing is, should we have a general principle for cron stacking or does it not cost us anything? If we're running crons every 5 min or something, are we taking additional tokens if there's nothing to run on that? If we are, would it be beneficial to have a cron stacking policy where we basically sync ones that are not necessarily dependent on each other so that there's one long-running cron that just happens every time and then checks a number of things? Or is there a better way to do it or have it webhook off of something?

Also we have 3 min on CI so we can always put things on CI for now 


And then the other thing I guess is that we run Linear anyway. Should we just use Linear for the general issue tracking or is it just easier to do it off of MarkDoc files in the repo? I don't really give a shit since there's no external party but if it saves us some automation and lets us type in webhooks or something in a meaningful way, we could. If it's simpler to just keep it the way

## Answer

Mr. White, I’d reduce this to one operating policy: use sparse batched polling, reserve event-driven triggers for urgent work, and decide whether Linear meaningfully simplifies the automation compared with repo task files.

## Answer

Mr. White, use this principle:

```text
Cron is for scheduled summaries.
Webhooks are for events.
CI is for deterministic checks.
Linear is for live task state.
Markdown is for durable task context.
```

## Cron stacking policy

Yes, crons can cost tokens. The scheduler itself ticking does not matter, but **every due cron that starts an agent run can spend tokens**, even if the result is “nothing changed.” Hermes cron runs due jobs in fresh agent sessions, injects skills if configured, runs the prompt to completion, and then delivers the result. The gateway checks due jobs every 60 seconds. citeturn231820view2

So avoid this:

```text
Every 5 min: check Sentry with LLM
Every 5 min: check GitHub with LLM
Every 5 min: check Linear with LLM
Every 5 min: check Gmail with LLM
Every 5 min: check CI with LLM
```

Use this:

```text
Every 5 min: cheap script-only sentinel, no LLM unless threshold changed
Every 30–60 min: one batched FounderOS ops sweep
Every morning: full Founder Briefing
Event-driven: Linear/GitHub/Sentry webhooks for urgent changes
```

Hermes docs also recommend `[SILENT]` for monitoring jobs to reduce notification noise, but that still implies the agent ran; it helps UX, not necessarily token spend. citeturn231820view4

## Recommended v1 cron schedule

### 1. Daily full briefing

Run once daily.

```text
8:00am — FounderOS full company briefing
```

This can use real LLM reasoning because it is the high-value synthesis.

### 2. Periodic ops sweep

Run every 30 or 60 minutes, not every 5.

```text
Every 60 min — FounderOS ops sweep
```

It checks:

```text
- open agent-ready Linear issues
- new failed CI status
- new P0/P1 Sentry signals
- stale PRs
- blocked stabilization tasks
- YC/fundraise deadline drift
```

Output only when something needs action.

### 3. Five-minute sentinel

Use a **non-LLM script** every 5 minutes.

This should query machine-readable state and exit unless something crosses a threshold:

```text
- CI failed on main
- production deploy failed
- new P0 Sentry issue
- Linear issue moved to agent-ready
- PR review requested
- onboarding error count spiked
```

Then the script calls Hermes/Coder only if needed.

Pseudo-flow:

```bash
*/5 * * * * /Users/tim/JovieInc/ops/scripts/sentinel.sh
```

The sentinel script should do:

```text
1. Query APIs cheaply.
2. Compare against last seen state.
3. If no change, exit 0.
4. If meaningful change, call founder-os or coder.
```

That gives you five-minute responsiveness without five-minute LLM spend.

## Webhooks are better than frequent polling

For events, use webhooks once setup is easy. Hermes webhooks can receive POSTs from services like GitHub, GitLab, Jira, and Stripe, validate HMAC signatures, transform payloads into prompts, and trigger agent runs automatically. citeturn231820view3 Linear also has webhooks for created/updated data, including issues and comments, and its API is GraphQL with mutation support and scoped API keys. citeturn231820view1

Best 

*(Answer truncated — 8119 chars total)*

## Question

Because these are sharing repo context and honcho memory, can we run the fundraising agent on the PC and have it just pick up tasks for now? Is that a good or bad way to do it? 
The ready for agent status: would it not be better to leave the stock statuses and use the assignee for that? That would eat seats I guess. I would just try and normalize. Agent running should just use the normal in progress and if it gets moved to to do, then that just means that to do there doesn't need to be a separate ready for Tim, ready for agent because we're operating in the same space 



## Answer

I’d keep this simple: use your existing Linear workflow and normal statuses, then decide separately whether fundraise should live on the PC or just pick up tasks there for now.

## Answer

Mr. White, yes: **run the fundraising agent on the PC for now** if the PC already has repo access, Hancho memory, Airtable/Gmail access, and can run the agent reliably. That is a good split because fundraising work is mostly I/O, research, CRM cleanup, drafting, and follow-up tracking. It does not need the coding laptop’s worktrees or GStack loop.

The rule should be:

```text
MBP = FounderOS + Coder + code execution
PC = Fundraise agent + batch enrichment + Airtable/Gmail/Linear pickup
Linear = active queue
Ops repo markdown = durable task contract / archive
Hancho = shared memory, not the queue
```

## Fundraising agent on PC: good or bad?

**Good**, with one caveat: do not rely on Hancho memory as the task queue.

Use Hancho for shared context:

```text
- who Tim is
- Jovie positioning
- prior investor summaries
- learned preferences
- company state
```

Use Linear or markdown for task state:

```text
- what is assigned
- what is approved
- what is in progress
- what is done
- what needs Tim approval
```

Memory is useful for continuity. It is a bad primary source of truth because it is harder to audit, diff, approve, and trigger from.

## How fundraise should pick up tasks

Use Linear as the live queue.

Example issue:

```text
Title:
Build warm angel list from Gmail history

Status:
Todo

Labels:
agent:fundraise
fundraise
warm-intros
needs-draft-only

Priority:
High

Description:
Find investors and angel operators Tim has already communicated with. Add candidates to Airtable. Draft follow-up emails. Do not send.
```

The PC fundraise agent can poll Linear every 30–60 minutes or be triggered manually:

```bash
fundraise chat -q "Pick up the highest-priority Linear issue labeled agent:fundraise in Todo. Move it to In Progress, execute it, update Airtable, draft but do not send emails, and comment results back on the Linear issue."
```

Later, use a webhook:

```text
Linear issue updated
→ label includes agent:fundraise
→ status is Todo
→ trigger PC fundraise agent
```

Linear’s API is GraphQL, supports mutations, and webhooks fire when data is created or updated, including issues and comments. Linear also says webhook payloads include the changed object and previous values, which is exactly what you want for “issue moved to Todo” triggers. citeturn438458view2

## On Linear statuses: your instinct is right

Yes. **Use the stock statuses. Do not create “Ready for Tim,” “Ready for Agent,” and “Agent Running” unless you feel real pain.**

Linear’s default workflow is:

```text
Backlog → Todo → In Progress → Done → Canceled
```

Linear’s docs say workflows are team-specific and come with that default status order. citeturn438458view1

Use that. Normalize around it.

## Recommended Linear convention

```text
Backlog
Captured, not yet committed.

Todo
Approved work. Ready for a human or agent.

In Progress
Someone or some agent is actively working.

Done
Completed and verified enough.

Canceled
Won’t do / duplicate / no longer relevant.
```

Th

*(Answer truncated — 8479 chars total)*
