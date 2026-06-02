---
title: "Aramis Agent Profile Management"
type: essay
created: 2026-04-19
updated: 2026-04-21
source: chatgpt-export
conversation_id: 69e5459f-76c8-83e8-9e3f-6941c792b2c2
message_count: 22
tags: [chatgpt, import, code, long-form]
---
# Aramis Agent Profile Management

> Conversation ID: 69e5459f-76c8-83e8-9e3f-6941c792b2c2
> Created: 2026-04-19T21:14:08Z
> Updated: 2026-04-21T18:43:59Z
> Messages: 22


Hey, okay, so I'm using you right now to help me plan. You know everything about Jovi, I believe you do. If you don't, then you've got the context of the repo, Jovi Inc slash Jovi and Jovi Inc slash ops. Basically what I'm doing right now is we're using AirMe's agent. So I've got an AirMe's agent running on my MacBook Pro laptop, and that one is running in conductor. I basically have one workspace that's running that AirMe's agent, and it's basically set to be like the coder agent, so it's orchestrating our code. And so I have it basically, the idea is that it would go through and trigger each one of the individual... The idea is that it would basically trigger all of the different... It should be spinning up AirMe's agents using the way that... That it lets you do that, where it's like, it can spin up agents in isolated work trees, and then those agents, like, don't carry the full context, they just have the context of the task, and then it's delegating tasks to each one of those agents. And then it should be using cloud code or codex CLI to do the actual coding so that it leans on frontier models and all of that jazz. But currently... But yeah, so that's what it's doing. And then on my desktop PC, I have an Aramis agent that is my operator agent that is managing our fundraise right now, and I'm having it deal with like tackling issues and stuff in the fundraise now. My question for you is, I know that there's like profiles for agents and stuff, and I guess my first question is, can Aramis manage those profiles? So can Aramis automatically clone itself and create a new profile for an agent, and then, like, create that task, for example? Could I be like, to my operator agent, can I be like, hey, create a fundraising agent that just manages our fundraise and then run that? Or do I wanna open up a new terminal and run that agent separately in the new terminal? And then, as far as the like, um, the, um, rest of that goes, like, um, um, can I, um, if I run that Aramis agent, um, can I have the agent do like multiple, um, multiple, uh, you know, can it run multiple, um, things, like simultaneously? Can it run multiple of those agents simultaneously, you know what I mean? So like, I basically would wanna spin up a bunch of agents simultaneously and have them all be like... You know, working on the same, in parallel on the same thing. You know, that's what I'm trying to figure out. I just want to figure out like what's the best path forward for me to orchestrate agents, because right now, I basically need a couple things. I want, I want, I want something, so I need the products constantly moving forward. And right now, that's focused entirely on stabilization, hardening everything. We're not adding any new features until we have users either paying or telling us why they're not paying. I'm not adding any new features until then. But I'm focused on stabilizing the product as much as possible and improving the onboarding and activation. So we're working backwards from metrics, right? And I basically want, I basically want one agent that I can like talk to and decide what to build that has context that I'll cover and stuff. And by the way, we're sharing memory over Hancho with all these agents. And so I basically want to like talk and discuss with these agents, like what makes sense to spend my time and money on, and for the company. And then I want one coding and orchestrating a bunch of coding agents and work trees and stuff. And we use GStack and it already knows to use GStack for coding. And then. I want one managing the fundraise, and the fundraise is gonna be like, I have an Airtable, and I need that Airtable filled with contacts, pulling contacts from my Gmail, from my LinkedIn, Twitter, all that shit, finding investors that I've already communicated with, and then from past companies and stuff, and then putting them all together, and then finding new investors and generating that. And then we'll start using like Instantly.ai or something to email all these investors, right? Then I have like a content department, so I need someone who's gonna be like using the Canon docs that we have in our repo for context on how to write like me, and then just starting to compose tweets and threads and LinkedIn posts and stuff. And we can throw all that into Typefully, which can handle all the scheduling and stuff, and it already has an MCP integration, so we don't need to like post on those and stuff. And so basically, for all the things that I'm trying to achieve now, I wanna figure out what's the best way to orchestrate all these, how exactly I should be managing this, if I should be using like one AirBz agent on top of the AirBz agents on top of the AirBz agents to do this, or like how I should think about this. Like, should there be a CEO agent basically that orchestrates all these other agents, you know? And I like have them talk to each other and stuff, or like, what's the move? And then we don't wanna like burn through cash and stuff. So I am trying to get a local hosted model that we can use for some of this stuff. And I wanna know how to think about switching between the model and stuff. We have a Cloud Code Next and a Codex subscription, both $200 a month, and then we have a couple other lighter subscriptions that are $20 a month. And then we have like obviously the local model we can use, but I've got a 64 gigabyte RAM PC with a 2080 Ti, and then I got a MacBook Pro with M5 2026 model with 32 gigabytes of RAM. It's just a regular M5, not a M5 Pro or Max. And then I have a 16 gigabyte MacBook Air, that's a 2022 model with an M2 chip. Help me figure out how to plan and orchestrate the company, basically. And for KPI, it's going to be revenue, MRR, and we're trying to get into YC. We've probably, we've extended our runway a little bit. We could probably make it to July 1st without any additional cash and then have a burn of about $5,000 a month after that. And so we need to either get some angel checks in, even one 25K check dramatically extends our runway, or get into an accelerator. Now, we're trying to get into an accelerator either way. The question is just whether or not we need bridge money to make it to get into an accelerator. We will apply to accelerators. May 4th is the deadline for YC, and the speedrun applications just came out tomorrow or today, I think. But so in the next two weeks, we are applying to all the accelerators, but we don't have any users yet. We have products. We've had a bunch of inbound users come in and bounce. And so now we're just trying to stabilize the onboarding and everything like that so that the users stick around. And then we can turn on our go-to-market engine, which already is built that scrapes and pre-qualifies leads and then emails them via Instantly.ai. So help me think about how to put this all together now with actionable insights. And what I would really love is one agent that kind of is perpetually taking all of this context in. Like I'd want it to have our bank account info and I want it to have like our Airtable access, which already has Airtable API and our Mercury API and like all and our GitHub and everything. Take the context of everything we're shipping and like I literally want it to send me a message every day, like with a founder briefing or something. or even multiple times a day to be like, to highlight what are the most important actionable items. So I wanna know, like, you know, hey, there's a sentry issue came up that's p0, that needs to be dealt with today. You should be assigning a... an agent a coding agent to handle that or tells me like hey you guys are spending you know excessively or you know don’t have enough revenue coming in etc. etc. all those kinds of things and I basically want you know to know that like we’re on track with the company or we’re not on track with the company or like we need to like we need to start getting users or we need more users or we have customer support or like you know keeping an eye on everything that’s happening in the company and being like OK you know here’s where you’re bottom next are like I almost want a framework where like every day it sends me like your current bottom neck is is X right like any given point we should have one bottleneck that if we address it the company moves forward right so I think currently that bottleneck is probably the stability of the on boarding if we fix that now users can start going and then it’ll be the stability of the go to market engine. We need to turn that on and improve its conversion and stop some more users come through right and then it’ll be like OK now we need to scale that and then it’ll probably be OK. Something is breaking now the bottom neck is your Sencherey issues now the bottleneck is cash. We need to go Reyes. You know like I don’t give them point. I wanna know what’s our current bottleneck and what actionable items can we tackle today that I’ll move the company forward


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

Use this structure:

```text
Tim / Founder
  |
  |-- FounderOS / Chief-of-Staff Agent
        Owns: company briefing, bottleneck detection, task routing, KPI watch
        Permissions: mostly read-only; can create drafts/tasks; cannot send money/email/deploy
        |
        |-- Product Stabilization Agent
        |     Owns: onboarding funnel, activation, Sentry triage, QA priorities
        |
        |-- Coder Conductor Agent
        |     Owns: code orchestration, worktrees, PRs, tests, reviews
        |     Spawns: disposable Codex/Claude/Hermes workers
        |
        |-- Fundraise Agent
        |     Owns: Airtable investor CRM, warm leads, follow-up drafts, accelerator apps
        |
        |-- GTM / Content Agent
        |     Owns: Typefully drafts, founder voice, content calendar, launch copy
        |
        |-- Finance / Runway Agent
              Owns: Mercury read-only, burn, runway, cash warnings
```

The **FounderOS agent** is your “CEO-like” agent, but make it a **Chief of Staff**, not an autonomous CEO. It should brief you, identify the bottleneck, recommend assignments, and draft actions. It should need approval for external messages, investor emails, Mercury actions, mass outreach, production deploys, and merging to `main`.

## Profiles to create

Create five durable Hermes profiles:

```bash
hermes profile create founder-os --clone
hermes profile create coder --clone
hermes profile create product --clone
hermes profile create fundraise --clone
hermes profile create content --clone
hermes profile create finance --clone
```

Set their working directories explicitly. Hermes profiles do not automatically sandbox the filesystem or change the working directory; the docs say `terminal.cwd` must be set if you want a predictable project folder. citeturn554293view1turn554293view2

Example:

```bash
founder-os config set terminal.cwd /Users/tim/JovieInc/ops
coder config set terminal.cwd /Users/tim/JovieInc/jovi
product config set terminal.cwd /Users/tim/JovieInc/ops
fundraise config set terminal.cwd /Users/tim/JovieInc/ops
content config set terminal.cwd /Users/tim/JovieInc/ops
finance config set terminal.cwd /Users/tim/JovieInc/ops
```

Then give each profile a narrow `SOUL.md` and a narrow `.env`. Do **not** blindly give every agent every key. Profiles have their own `.env`, config, and `SOUL.md`, so use that separation. citeturn554293view2

## Persistent vs disposable agents

### Persistent agents

Use persistent profiles for roles where memory matters:

| Agent | Persistent? | Why |
|---|---:|---|
| `founder-os` | Yes | Needs company-level continuity and briefing history |
| `coder` | Yes | Needs repo conventions, GStack workflow, release discipline |
| `product` | Yes | Needs activation/onboarding history |
| `fundraise` | Yes | Needs investor relationship memory and Airtable context |
| `content` | Yes | Needs your voice/canon docs |
| `finance` | Yes | Needs runway and burn context |

### Disposable agents

Use disposable agents for bounded work:

| Task | Worker type |
|---|---|
| Fix one Sentry issue | Worktree coding worker |
| Compare three possible onboarding flows | 3 parallel research workers |
| Review a PR for regressions | Read-only review worker |
| Enrich 100 investor contacts | Batch/data worker |
| Draft 10 tweets from one canon doc | Content batch worker |

The conductor should pass a complete prompt every time because Hermes subagents begin with fresh context and only know what the parent puts in `goal` and `context`. citeturn554293view6turn554293view7

## Worktree coding system

For coding, the stable pattern is:

```text
coder profile
  |
  |-- issue intake / planning
  |-- creates branch + worktree
  |-- launches Codex CLI / Claude Code / Hermes worker inside worktree
  |-- worker implements
  |-- reviewer agent checks diff
  |-- QA agent runs tests
  |-- coder opens PR
  |-- Tim approves merge/deploy
```

Hermes’ worktree docs show the basic pattern:

```bash
cd /path/to/jovi
git worktree add ../jovi-onboarding-fix-001 fix/onboarding-fix-001
cd ../jovi-onboarding-fix-001
hermes
```

Each worktree gets its own branch and directory, and Hermes uses the worktree as the project root. citeturn554293view8

Codex also has native worktree support in the app, allowing multiple independent tasks in the same Git repo without interfering with one another; Codex automations run in dedicated background worktrees for Git repos. citeturn754069view2turn754069view4

Use this rule:

```text
One issue = one worktree = one branch = one PR.
```

Avoid “five agents all editing the same onboarding files.” Use parallelism for exploration, reproduction, review, tests, and separate files. Use one implementation agent per conflicty area.

## The actual company bottleneck

Your current bottleneck is almost certainly:

```text
Activation/onboarding stability.
```

The reason is simple: you already have product, inbound users have arrived and bounced, GTM is built, and you want revenue/MRR. More leads before onboarding works will mostly generate more bounced users. Fundraising matters because of runway, but investor traction improves materially if you can show that users can onboard, activate, and either pay or clearly explain why they will not.

So the next two weeks should be governed by:

```text
Primary objective: make a new qualified user reach value without founder intervention.
Secondary objective: submit YC + speedrun + bridge investor pipeline.
Tertiary objective: prepare GTM/content so it can turn on once activation is credible.
```

YC’s current on-time deadline is **May 4, 2026 at 8pm PT**, with decisions promised by **June 5** for on-time applications. citeturn851105view0 a16z speedrun SR007 has early applications open now, the formal window opens **April 20, 2026**, and the FAQ lists a **May 17, 2026 at 11:59pm PT** deadline for the upcoming San Francisco cohort. citeturn851105view1turn851105view2

## Your next 14-day plan

### April 19–20: install the operating system

Create the profiles, write their `SOUL.md` files, define permissions, and set up the FounderOS daily briefing.

FounderOS should read:

```text
Sentry
GitHub
PostHog / analytics
Stripe
Mercury
Airtable fundraise CRM
Gmail
Calendar
Instantly
Typefully
Linear/Jira/GitHub Issues
```

It should write only to:

```text
ops/company_state.md
ops/daily_briefings/YYYY-MM-DD.md
Airtable task/fundraise fields
GitHub issues/PR comments, if safe
Draft emails, never send by default
Draft content, never publish by default
```

### April 21–24: onboarding hardening sprint

Have Product + Coder run this loop daily:

```text
1. Pull Sentry issues and onboarding funnel analytics.
2. Identify the top 3 activation blockers.
3. Create one worktree per fix.
4. Reproduce before fixing.
5. Add or update a test.
6. Fix.
7. Run focused tests.
8. Open PR.
9. Review with separate agent.
10. Merge only after human approval or clear policy.
```

Definition of done:

```text
A new user can sign up, complete onboarding, import/create the core object, receive visible value, and understand the next paid action.
```

### April 24–28: user replay sprint

Use the fundraise/content/GTM agents lightly here, but keep product first.

Actions:

```text
Pull the list of bounced inbound users.
Send personal, non-automated follow-ups.
Ask for 10-minute screen-share debugging calls.
Offer concierge setup.
Record every failure point.
Convert failures into issues.
```

Your goal is not volume yet. Your goal is to learn why users bounced and fix the path.

### April 29–May 3: YC application sprint

FounderOS should assemble:

```text
1. One-sentence company description.
2. Demo video script.
3. Product screenshots.
4. Activation metrics, even if small.
5. User quotes or failed-user learnings.
6. Why now.
7. Founder-market fit.
8. What changed since prior attempts, if applicable.
9. Runway and funding ask.
```

Submit before **May 4 at 8pm PT**. citeturn851105view0

### May 5–17: speedrun + bridge

Submit speedrun. Build a tight investor pipeline:

```text
Tier 1: warm angels who already know you
Tier 2: investors from prior companies / social graph
Tier 3: AI/CRM/sales automation angels
Tier 4: cold funds
```

One $25K angel check materially extends runway, so the fundraise agent should prioritize speed and warmth over building a giant cold list.

## FounderOS daily briefing spec

Use Hermes cron for this. Hermes cron supports recurring scheduled jobs, skill-backed jobs, and delivery back to configured platforms. The gateway daemon executes due jobs in isolated sessions and delivers final responses. citeturn477784view0turn477784view4 Hermes also supports messaging through Telegram, Discord, Slack, WhatsApp, Signal, email, and other platforms, and the gateway handles cron jobs. citeturn477784view2

Create a briefing like this:

```bash
founder-os cron create "every day at 8am" \
"Generate the Jovie Founder Briefing. Read company_state.md, Sentry, GitHub, analytics, Stripe, Mercury, Airtable fundraise, Gmail investor/customer replies, Instantly, and Typefully. Identify the single company bottleneck, the 3 highest-leverage actions for today, any P0 alerts, runway changes, and decisions needed from Tim. Keep it concise and action-oriented." \
--name "Jovie Founder Morning Briefing"
```

Add a mid-day monitor:

```bash
founder-os cron create "every 3h" \
"Check for P0 changes only: Sentry regressions, failed production deploys, cash/runway emergencies, urgent investor/customer replies, and blocked YC/speedrun tasks. Report only if action is required." \
--name "Jovie P0 Watch"
```

Daily output should look like:

```text
Jovie Founder Briefing — Apr 20, 2026

Bottleneck:
Onboarding activation stability.

Why:
7 new signups, 0 reached activation event.
Top drop-off is OAuth/connect step.
2 new Sentry issues touch onboarding.

Today’s 3 actions:
1. Assign coder worker to fix OAuth error path.
2. Personally contact 5 bounced users for concierge onboarding.
3. Finish YC demo script v1.

P0/P1:
- P0: none
- P1: onboarding OAuth failure, 11 events, 4 users

Metrics:
- Cash runway: X days
- MRR: $0
- New signups: 7
- Activated users: 0
- Onboarding completion: 0%
- Investor next actions overdue: 3

Decisions needed:
- Approve sending 5 user follow-up emails?
- Approve creating 2 worktrees for onboarding fixes?
```

## Data model for the bottleneck agent

Create `/ops/company_state.md`:

```markdown
# Jovie Company State

## North Star
MRR / revenue.

## Current bottleneck
Activation/onboarding stability.

## Current sprint
Stabilize onboarding and activation. No new features until users pay or explain why they will not.

## Runway
- Default runway date: 2026-07-01
- Burn after then: ~$5,000/mo
- Bridge target: $25K+ angel check

## Current deadlines
- YC Summer 2026: 2026-05-04 8pm PT
- a16z speedrun SR007: 2026-05-17 11:59pm PT

## Product definition of done
A qualified new user reaches core value without founder intervention.

## Agent rules
- No production deploy without approval.
- No merge to main without approval.
- No investor/customer email send without approval.
- Drafts are allowed.
- PRs are allowed.
- Airtable updates are allowed within assigned tables.
- Mercury is read-only.
```

Create `/ops/bottleneck_scorecard.yaml`:

```yaml
bottleneck_order:
  - production_down
  - cash_runway
  - onboarding_activation
  - user_support
  - gtm_lead_volume
  - sales_conversion
  - fundraising_pipeline
  - content_distribution

rules:
  production_down:
    trigger: "active P0 or deploy rollback needed"
    action: "stop all non-critical work"

  cash_runway:
    trigger: "runway < 45 days and no committed financing"
    action: "daily investor asks until bridge secured"

  onboarding_activation:
    trigger: "activation rate below target or users bounce before core value"
    action: "stability + onboarding sprint"

  gtm_lead_volume:
    trigger: "onboarding stable and qualified user volume too low"
    action: "turn on GTM engine in small controlled batches"

  sales_conversion:
    trigger: "qualified users activate but do not pay"
    action: "pricing, offer, onboarding-to-paid experiments"
```

## Model routing and cost control

Use the local model for cheap, repetitive, low-risk work. Use frontier models for high-leverage reasoning, code, investor narrative, and ambiguous debugging.

### Your hardware

Your desktop PC has enough system RAM for many local models, but the 2080 Ti class of cards commonly has **11GB GDDR6**, which is below the 19GB size of the Ollama Q4_K_M `qwen3-coder:30b` package. citeturn718387search3turn232972view3 That means the PC can run useful local models with CPU/GPU split, but it will not feel like a large fully-offloaded GPU inference box.

Your M5 MacBook Pro with 32GB unified memory is a good local-model laptop. Apple’s standard M5 MacBook Pro spec lists 153GB/s memory bandwidth, and Qwen3-Coder 30B-class quantized models are in the range that can fit in 32GB depending on quantization/context. citeturn718387search14turn232972view2

Qwen3-Coder is a strong local coding-agent candidate: the official Qwen repo lists 30B-A3B and 480B-A35B variants, native 256K context, and agentic coding/tool-use focus. citeturn232972view0 LM Studio lists the smaller Qwen3-Coder package as needing at least 15GB RAM, while Unsloth says a dynamic 4-bit Qwen3-Coder-30B-A3B run needs at least about 18GB unified/system memory for 6+ tokens/sec in their setup. citeturn232972view1turn232972view2

### Routing policy

Use this:

```text
Local model:
- email/contact extraction
- Airtable cleanup
- summarizing Gmail threads
- first-pass investor matching
- first-pass content drafts
- daily metric summaries
- log clustering
- issue classification
- simple code search

Codex / Claude Code:
- real code edits
- onboarding hardening
- Sentry bug fixes
- architecture changes
- PR review
- YC application narrative
- investor email final polish
- complex debugging

Human approval:
- sending investor/customer emails
- launching Instantly campaigns
- merging/deploying
- deleting data
- Mercury/money movement
- changing pricing/legal terms
```

## Fundraise agent

Make `fundraise` a persistent Hermes profile. Give it Airtable write access only to fundraise tables. Gmail can be read + draft, not send.

Its job:

```text
1. Pull investors from Gmail history.
2. Pull contacts from LinkedIn/Twitter/manual exports where permitted.
3. Deduplicate into Airtable.
4. Score by relationship strength, thesis fit, check size, and urgency.
5. Draft warm intro asks.
6. Draft direct investor emails.
7. Track next action date.
8. Alert Tim when a high-priority thread goes stale.
```

Airtable columns:

```text
Name
Firm
Email
LinkedIn
Twitter/X
Source
Relationship path
Prior interaction summary
Thesis fit
Check size estimate
Stage
Last touch
Next action
Owner
Draft email
Notes
Do-not-contact
```

For bulk commercial email, keep compliance guardrails in the system prompt. The FTC’s CAN-SPAM guide requires accurate header information, non-deceptive subject lines, a physical address, clear opt-out, and honoring opt-out requests. citeturn976834search0 Use Instantly only after the agent has deduped suppression lists and you have approved the campaign.

## Content agent

The content agent should use your canon docs and repo history, then draft into Typefully. It should not publish automatically.

Daily quota:

```text
- 5 tweet drafts
- 1 thread draft
- 1 LinkedIn post draft
- 3 raw founder notes pulled from actual product/fundraise lessons
```

Content pillars:

```text
1. Building Jovie in public.
2. Founder operating system / agentic company building.
3. CRM/contact enrichment pain.
4. Onboarding and activation lessons.
5. Fundraising/runway reality.
```

Best loop:

```text
Repo commits + Sentry fixes + user calls + fundraise learnings
→ content agent creates drafts
→ Tim approves/edits
→ Typefully schedules
```

## Product/coding agent

The Coder Conductor should receive tasks only after Product/FounderOS defines the outcome.

Good task:

```text
Fix onboarding OAuth failure for new users.

Context:
- Sentry issue: [link]
- Affected flow: signup → connect account → import first contacts
- Expected behavior: user returns to onboarding step 3 with connected status
- Actual behavior: blank screen after OAuth callback
- Relevant files: ...
- Test command: ...
- Definition of done:
  1. Reproduced locally or with failing test
  2. Fix implemented
  3. Regression test added
  4. Existing onboarding tests pass
  5. PR opened with summary
```

Bad task:

```text
Fix onboarding.
```

Use worker roles:

```text
Explorer: read-only, locate cause.
Reproducer: create failing test or reproduction.
Implementer: edit code in worktree.
Reviewer: review diff for bugs/security.
QA: run E2E smoke path.
```

Codex subagents are good for this because they can spawn specialized agents and consolidate results, but you need to explicitly ask for them. citeturn754069view3

## Security and permissions

Use this hard rule:

```text
No single agent gets unrestricted access to GitHub, Gmail, Mercury, Airtable, Instantly, Typefully, Sentry, and production.
```

Recommended permissions:

| Agent | Permissions |
|---|---|
| `founder-os` | Read most systems; write briefings/tasks/drafts |
| `coder` | GitHub branch/PR, Sentry read, CI read, local repo write |
| `product` | Analytics/Sentry read, GitHub issue write |
| `fundraise` | Airtable fundraise write, Gmail read/draft, contacts read |
| `content` | Canon docs read, Typefully draft write |
| `finance` | Mercury read-only, Stripe read-only, briefing write |

Also:

```text
- Separate API keys per profile where possible.
- Keep Mercury read-only.
- Keep Gmail draft-only until you intentionally send.
- Keep Instantly campaign launch manual.
- Never let agents delete production data.
- Never let agents merge/deploy without a clear approval policy.
- Log every external action.
```

## What to do immediately

Run this today:

```bash
# 1. Create profiles
hermes profile create founder-os --clone
hermes profile create coder --clone
hermes profile create product --clone
hermes profile create fundraise --clone
hermes profile create content --clone
hermes profile create finance --clone

# 2. Set working directories
founder-os config set terminal.cwd /Users/tim/JovieInc/ops
coder config set terminal.cwd /Users/tim/JovieInc/jovi
product config set terminal.cwd /Users/tim/JovieInc/ops
fundraise config set terminal.cwd /Users/tim/JovieInc/ops
content config set terminal.cwd /Users/tim/JovieInc/ops
finance config set terminal.cwd /Users/tim/JovieInc/ops

# 3. Check profiles
hermes profile list
```

Then create:

```text
/ops/company_state.md
/ops/bottleneck_scorecard.yaml
/ops/agents/founder-os.md
/ops/agents/coder.md
/ops/agents/product.md
/ops/agents/fundraise.md
/ops/agents/content.md
/ops/agents/finance.md
/ops/daily_briefings/
```

Then tell `founder-os`:

```text
You are Jovie FounderOS, the chief-of-staff agent for Tim White.

Your job is to keep the company moving toward revenue/MRR and accelerator acceptance. Every briefing must identify the single current bottleneck, the reason it is the bottleneck, the top 3 actions for today, P0/P1 alerts, runway status, fundraising next actions, product stability status, and decisions required from Tim.

Current strategy:
- No new features until users are paying or explicitly saying why they will not pay.
- Current bottleneck is likely onboarding activation stability.
- YC deadline: May 4, 2026 at 8pm PT.
- a16z speedrun SR007 deadline: May 17, 2026 at 11:59pm PT.
- Runway target: extend past July 1; one $25K angel check materially helps.

Rules:
- You may draft external messages but not send them.
- You may recommend coding tasks but not merge/deploy.
- You may update company_state.md and daily briefings.
- You must keep recommendations specific, ranked, and actionable.
```

Then set the morning briefing cron.

## My recommended default state

For the next two weeks, run:

```text
MacBook Pro:
- Coder conductor
- Codex/Claude coding work
- Worktree review/testing

Desktop PC:
- FounderOS gateway
- Fundraise profile
- Finance profile
- Local model server
- Cron briefings

MacBook Air:
- Lightweight dashboard / secondary chat / emergency access
```

And keep this priority order:

```text
1. Activation/onboarding stability
2. YC application
3. Warm bridge fundraise
4. Speedrun application
5. Controlled user replay / concierge onboarding
6. Content drafts
7. GTM engine warm-up
8. Cold outbound scale only after activation works
```

Your current operating principle should be:

```text
Every day, identify the one bottleneck.
Every agent either removes that bottleneck or supports the next deadline.
Everything else waits.
```


ok now for the coding agent we probably want that running on the laptop? the laptop is almost always on. should we jsut run on the mac? 
and also for local model, whats the cost differrnce if we use like openrouter and rotate through models there ?

and whats the advatage or cost diff if we put this on a vps or run it in aws or something


I’ll compare three deployment options for Jovie’s coding agent: the always-on Mac, hosted API routing through OpenRouter, and VPS or AWS, focusing on cost, reliability, and fit.
