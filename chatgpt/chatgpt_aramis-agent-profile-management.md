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

---

## User

Hey, okay, so I'm using you right now to help me plan. You know everything about Jovi, I believe you do. If you don't, then you've got the context of the repo, Jovi Inc slash Jovi and Jovi Inc slash ops. Basically what I'm doing right now is we're using AirMe's agent. So I've got an AirMe's agent running on my MacBook Pro laptop, and that one is running in conductor. I basically have one workspace that's running that AirMe's agent, and it's basically set to be like the coder agent, so it's orchestrating our code. And so I have it basically, the idea is that it would go through and trigger each one of the individual... The idea is that it would basically trigger all of the different... It should be spinning up AirMe's agents using the way that... That it lets you do that, where it's like, it can spin up agents in isolated work trees, and then those agents, like, don't carry the full context, they just have the context of the task, and then it's delegating tasks to each one of those agents. And then it should be using cloud code or codex CLI to do the actual coding so that it leans on frontier models and all of that jazz. But currently... But yeah, so that's what it's doing. And then on my desktop PC, I have an Aramis agent that is my operator agent that is managing our fundraise right now, and I'm having it deal with like tackling issues and stuff in the fundraise now. My question for you is, I know that there's like profiles for agents and stuff, and I guess my first question is, can Aramis manage those profiles? So can Aramis automatically clone itself and create a new profile for an agent, and then, like, create that task, for example? Could I be like, to my operator agent, can I be like, hey, create a fundraising agent that just manages our fundraise and then run that? Or do I wanna open up a new terminal and run that agent separately in the new terminal? And then, as far as the like, um, the, um, rest of that goes, like, um, um, can I, um, if I run that Aramis agent, um, can I have the agent do like multiple, um, multiple, uh, you know, can it run multiple, um, things, like simultaneously? Can it run multiple of those agents simultaneously, you know what I mean? So like, I basically would wanna spin up a bunch of agents simultaneously and have them all be like... You know, working on the same, in parallel on the same thing. You know, that's what I'm trying to figure out. I just want to figure out like what's the best path forward for me to orchestrate agents, because right now, I basically need a couple things. I want, I want, I want something, so I need the products constantly moving forward. And right now, that's focused entirely on stabilization, hardening everything. We're not adding any new features until we have users either paying or telling us why they're not paying. I'm not adding any new features until then. But I'm focused on stabilizing the product as much as possible and improving the onboarding and activation. So we're working backwards from metrics, right? And I basically want, I basically want one agent that I can like talk to and decide what to build that has context that I'll cover and stuff. And by the way, we're sharing memory over Hancho with all these agents. And so I basically want to like talk and discuss with these agents, like what makes sense to spend my time and money on, and for the company. And then I want one coding and orchestrating a bunch of coding agents and work trees and stuff. And we use GStack and it already knows to use GStack for coding. And then. I want one managing the fundraise, and the fundraise is gonna be like, I have an Airtable, and I need that Airtable filled with contacts, pulling contacts from my Gmail, from my LinkedIn, Twitter, all that shit, finding investors that I've already communicated with, and then from past companies and stuff, and then putting them all together, and then finding new investors and generating that. And then we'll start using like Instantly.ai or something to email all these investors, right? Then I have like a content department, so I need someone who's gonna be like using the Canon docs that we have in our repo for context on how to write like me, and then just starting to compose tweets and threads and LinkedIn posts and stuff. And we can throw all that into Typefully, which can handle all the scheduling and stuff, and it already has an MCP integration, so we don't need to like post on those and stuff. And so basically, for all the things that I'm trying to achieve now, I wanna figure out what's the best way to orchestrate all these, how exactly I should be managing this, if I should be using like one AirBz agent on top of the AirBz agents on top of the AirBz agents to do this, or like how I should think about this. Like, should there be a CEO agent basically that orchestrates all these other agents, you know? And I like have them talk to each other and stuff, or like, what's the move? And then we don't wanna like burn through cash and stuff. So I am trying to get a local hosted model that we can use for some of this stuff. And I wanna know how to think about switching between the model and stuff. We have a Cloud Code Next and a Codex subscription, both $200 a month, and then we have a couple other lighter subscriptions that are $20 a month. And then we have like obviously the local model we can use, but I've got a 64 gigabyte RAM PC with a 2080 Ti, and then I got a MacBook Pro with M5 2026 model with 32 gigabytes of RAM. It's just a regular M5, not a M5 Pro or Max. And then I have a 16 gigabyte MacBook Air, that's a 2022 model with an M2 chip. Help me figure out how to plan and orchestrate the company, basically. And for KPI, it's going to be revenue, MRR, and we're trying to get into YC. We've probably, we've extended our runway a little bit. We could probably make it to July 1st without any additional cash and then have a burn of about $5,000 a month after that. And so we need to either get some angel checks in, even one 25K check dramatically extends our runway, or get into an accelerator. Now, we're trying to get into an accelerator either way. The question is just whether or not we need bridge money to make it to get into an accelerator. We will apply to accelerators. May 4th is the deadline for YC, and the speedrun applications just came out tomorrow or today, I think. But so in the next two weeks, we are applying to all the accelerators, but we don't have any users yet. We have products. We've had a bunch of inbound users come in and bounce. And so now we're just trying to stabilize the onboarding and everything like that so that the users stick around. And then we can turn on our go-to-market engine, which already is built that scrapes and pre-qualifies leads and then emails them via Instantly.ai. So help me think about how to put this all together now with actionable insights. And what I would really love is one agent that kind of is perpetually taking all of this context in. Like I'd want it to have our bank account info and I want it to have like our Airtable access, which already has Airtable API and our Mercury API and like all and our GitHub and everything. Take the context of everything we're shipping and like I literally want it to send me a message every day, like with a founder briefing or something. or even multiple times a day to be like, to highlight what are the most important actionable items. So I wanna know, like, you know, hey, there's a sentry issue came up that's p0, that needs to be dealt with today. You should be assigning a... an agent a coding agent to handle that or tells me like hey you guys are spending you know excessively or you know don’t have enough revenue coming in etc. etc. all those kinds of things and I basically want you know to know that like we’re on track with the company or we’re not on track with the company or like we need to like we need to start getting users or we need more users or we have customer support or like you know keeping an eye on everything that’s happening in the company and being like OK you know here’s where you’re bottom next are like I almost want a framework where like every day it sends me like your current bottom neck is is X right like any given point we should have one bottleneck that if we address it the company moves forward right so I think currently that bottleneck is probably the stability of the on boarding if we fix that now users can start going and then it’ll be the stability of the go to market engine. We need to turn that on and improve its conversion and stop some more users come through right and then it’ll be like OK now we need to scale that and then it’ll probably be OK. Something is breaking now the bottom neck is your Sencherey issues now the bottleneck is cash. We need to go Reyes. You know like I don’t give them point. I wanna know what’s our current bottleneck and what actionable items can we tackle today that I’ll move the company forward

---

## Assistant

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

---

## User

ok now for the coding agent we probably want that running on the laptop? the laptop is almost always on. should we jsut run on the mac? 
and also for local model, whats the cost differrnce if we use like openrouter and rotate through models there ?

and whats the advatage or cost diff if we put this on a vps or run it in aws or something

---

## Assistant

I’ll compare three deployment options for Jovie’s coding agent: the always-on Mac, hosted API routing through OpenRouter, and VPS or AWS, focusing on cost, reliability, and fit.

---

## Assistant

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

---

## User

ok so this is all a lot for me to be seting up with limited runway.

can we focus on coding/founder os and put this only on the mbp for now with open ai subscription and gpt 5.4 mini on the codex subscription for primary stuff. then iteratively add more. 

and if my laptop is always on and doing the coding can founder os just live here too?


also does it make sense ot put anything direclty on cron/autoamtion from the codex app or claude desktop app?

or let hermes do it all?

---

## Assistant

Mr. White, simplify this to a minimum-viable stack first: one MacBook Pro, one coding conductor, one FounderOS loop, and no cloud or local-model complexity yet. I’ll also sanity-check Codex and Claude automation limits so the setup stays practical.

---

## Assistant

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

---

## User

And for all those repo docs when it's working on updating all the company state and all that stuff, what's the best way to handle actually shipping that? For the ops repo should we be opening PRs? Should it just be merging directly into the branch? Should that be on a cron job? Should that be attached to every operation? Should there be a blanket rule for shipping?

And then on the code side we always use GStack and the /ship command from GStack and the /review command from GStack. For feature building it goes through the whole GStack pipeline. What's the split on what those should be used for, like repo stuff, ops stuff versus code stuff? 

---

## Assistant

Mr. White, I’d treat ops docs differently from product code: ops state should move fast with an audit trail, while product code should keep the full GStack review/ship gate. I’ll check GStack’s current command semantics before giving the split.

---

## Assistant

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

---

## User

Yeah so founder is always going to spit out tasks to coder. Is that the idea? I have most of the general setup described here already in place. For achieving the stabilization phase what would be the exact workflow?
- Founder dictates it to Coder or Founder?
- Do they talk directly or do we save it to a markdown file and commit?
Then separately how do we get Coder to pick it up? Having it constantly watch a folder or are they able to take a webhook or something? How do we get them to actually trigger it or do we just manually paste it over?

---

## Assistant

Mr. White, the cleanest v1 is a file-based handoff with explicit status, then add webhooks or watchers only after the loop works manually for a few days. I’ll narrow this to the stabilization operating loop: who decides, where the task lives, how Coder picks it up, and what to automate now versus trigger manually.

---

## User

And then what's the physical interface look like for this? Should there always be a separate terminal open for each one of the agents or just the founder exists and then we allow it to spin up the others with their profiles? 

---

## Assistant

FounderOS should create a durable task contract, and Coder should execute approved task contracts. For v1, keep both as persistent agents in separate visible terminals, and avoid freeform agent chatter or hidden nested agents as the source of truth.

---

## Assistant

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
- open PR
```

### 5. Coder updates the task file

Coder edits:

```text
ops/tasks/coder/in_progress/STAB-001-fix-onboarding-oauth.md
```

or moves it to:

```text
ops/tasks/coder/pr_opened/STAB-001-fix-onboarding-oauth.md
```

with:

```markdown
## Status
PR opened.

## PR
https://github.com/JovieInc/jovi/pull/123

## Summary
Fixed OAuth callback blank screen by handling missing onboarding session state and redirecting user back to step 3.

## Tests
- pnpm test onboarding
- pnpm typecheck
- manual OAuth smoke test

## Remaining risks
OAuth provider-specific edge cases still need monitoring.
```

Then it commits the ops task update:

```bash
git add ops/tasks/coder
git commit -m "chore(ops): update STAB-001 with PR"
```

## Task contract template

Use this file format:

```markdown
# STAB-001 — Fix onboarding OAuth callback blank screen

## Status
approved

## Owner
coder

## Priority
P0

## Bottleneck
Onboarding activation stability

## Source
- Sentry:
- Analytics:
- User report:
- FounderOS briefing:

## Problem
New users sometimes hit a blank screen after OAuth callback during onboarding.

## Expected behavior
After OAuth callback, the user should return to onboarding with the connected account marked complete and continue to the next step.

## Actual behavior
The user sees a blank screen and does not reach activation.

## Scope
Fix the specific OAuth callback/onboarding session failure path.

## Out of scope
- Redesigning onboarding
- Adding new onboarding features
- Changing pricing
- Rewriting auth

## Repo
/Users/tim/JovieInc/jovi

## Worktree
/Users/tim/JovieInc/jovi-STAB-001

## Branch
fix/STAB-001-onboarding-oauth

## Required workflow
1. Create worktree.
2. Reproduce or explain why reproduction is unavailable.
3. Implement minimal fix.
4. Add or update regression test if practical.
5. Run relevant tests.
6. Run GStack /review.
7. Address critical review findings.
8. Run GStack /ship.
9. Open PR.
10. Update this task file with PR link and result.

## Acceptance criteria
- New user OAuth callback does not blank-screen.
- User returns to onboarding in the correct state.
- Relevant tests pass.
- PR is opened with clear summary.

## Approval gates
- Do not merge.
- Do not deploy.
- Do not alter unrelated onboarding flows.
```

This is the contract between FounderOS and Coder.

## How to get Coder to pick it up

Use phases.

### Phase 1 — manual dispatch

This is what I recommend immediately.

```text
FounderOS writes task file.
Tim approves.
Tim or FounderOS runs one command to Coder.
Coder executes.
```

The physical action is just:

```bash
coder chat -q "Execute task file: /path/to/STAB-001.md"
```

This is the lowest-risk setup. It keeps you in control and avoids building automation before the workflow is proven.

### Phase 2 — semi-automatic dispatch

Once Phase 1 works for a few days, let FounderOS dispatch Coder by running the command itself:

```bash
coder chat -q "Execute the newest approved task in /Users/tim/JovieInc/ops/tasks/coder/approved. Take only one task. Move it to in_progress before starting. Follow the task contract exactly."
```

FounderOS can do that after you say:

```text
Approve and dispatch STAB-001.
```

### Phase 3 — watched folder

Later, add a tiny watcher:

```text
ops/tasks/coder/approved/
```

When a file appears, a script triggers:

```bash
coder chat -q "Execute task file: $TASK_FILE"
```

I would not start here. Folder-watch automation can double-trigger, race, or pick up half-written files unless you add locking.

### Phase 4 — webhook

Hermes supports webhooks: the gateway can receive POSTs from systems like GitHub, GitLab, Jira, and Stripe, validate HMAC signatures, transform payloads into prompts, and trigger Hermes runs. citeturn330214view0 Hermes also supports dynamic webhook subscriptions through `hermes webhook subscribe`, and incoming POSTs can trigger an agent run and deliver the result to a configured destination. citeturn330214view4

Use this later for:

```text
GitHub issue labeled agent-ready
→ webhook triggers coder
→ coder executes task
```

For now, webhooks are extra setup. Use manual or semi-automatic dispatch.

## Should FounderOS and Coder talk directly?

Use this rule:

```text
They can talk directly for convenience.
The task file is the source of truth.
```

Good:

```text
FounderOS creates STAB-001.md.
FounderOS tells Coder: execute STAB-001.md.
Coder updates STAB-001.md with progress and PR.
```

Bad:

```text
FounderOS tells Coder in chat.
Coder does something.
No file records what happened.
```

The markdown file gives you:

```text
- audit trail
- replayability
- less hallucinated scope
- easy handoff between agents
- easy review by you
- future automation compatibility
```

## Physical interface

For now, run **two persistent Hermes profiles**, but you do not need two giant interactive sessions open all the time.

Recommended setup:

```text
tmux session: jovie
│
├── window 1: founder-os
│   └── interactive chat with you
│
├── window 2: coder
│   └── idle / available for active coding task
│
├── window 3: code
│   └── current worktree, tests, Codex/GStack
│
└── window 4: logs
    └── gateway, cron, git status, agent logs
```

Command:

```bash
tmux new -s jovie
```

Windows:

```bash
tmux rename-window founder
tmux new-window -n coder
tmux new-window -n code
tmux new-window -n logs
```

### FounderOS terminal

Keep this one open because it is your command center:

```bash
cd /Users/tim/JovieInc/ops
founder-os chat
```

### Coder terminal

You can leave it idle or only open it when needed:

```bash
cd /Users/tim/JovieInc/jovi
coder chat
```

### Background gateway option

Hermes gateways can run as separate processes per profile, and each profile can be installed as its own service. citeturn330214view1 The messaging gateway is a single background process that connects configured platforms, handles sessions, and runs cron jobs. citeturn330214view2

So the cleaner v1.5 setup is:

```bash
founder-os gateway install
founder-os gateway start

coder gateway install
coder gateway start
```

Then you use chat/CLI when needed, while cron/webhooks can run in the background.

## Should FounderOS spin up Coder each time?

No. Keep Coder as a persistent profile.

```text
FounderOS = persistent command center
Coder = persistent engineering manager
Codex/GStack workers = disposable per task/worktree
```

FounderOS should not create a fresh Coder profile for every task. That loses continuity and creates clutter.

The right pattern:

```text
Persistent:
- founder-os
- coder

Disposable:
- worktrees
- branches
- Codex sessions
- task-specific subagents
```

## Stabilization task states

Use this folder structure:

```text
ops/tasks/coder/
├── proposed/
├── approved/
├── in_progress/
├── blocked/
├── pr_opened/
├── done/
└── cancelled/
```

Task lifecycle:

```text
proposed
→ approved
→ in_progress
→ pr_opened
→ done
```

FounderOS owns:

```text
proposed
approved
blocked
done summaries
```

Coder owns:

```text
in_progress
pr_opened
implementation notes
PR links
test results
```

Tim owns:

```text
approval
priority
merge/deploy decision
```

## Exact daily stabilization loop

### Morning

FounderOS:

```text
1. Read company state.
2. Read Sentry/GitHub/analytics.
3. Identify current bottleneck.
4. Write daily briefing.
5. Create 1–3 proposed coding tasks.
6. Recommend exactly one task to dispatch first.
```

### You

You say:

```text
Approve and dispatch STAB-001.
```

### FounderOS

FounderOS:

```text
1. Moves STAB-001 to approved.
2. Commits the approval.
3. Runs coder dispatch command, or gives you the command to run.
```

### Coder

Coder:

```text
1. Moves task to in_progress.
2. Creates worktree.
3. Uses Codex/GStack.
4. Runs /review.
5. Runs /ship.
6. Opens PR.
7. Updates task file with PR link.
```

### You

You review PR:

```text
- merge if good
- ask Coder to revise if not
- deploy only if appropriate
```

### FounderOS

FounderOS next briefing:

```text
- sees STAB-001 PR opened/merged
- checks whether onboarding bottleneck improved
- recommends next task
```

## My recommendation for your current stage

Start with this exact operating mode:

```text
1. FounderOS writes task files.
2. Tim approves one task at a time.
3. FounderOS dispatches Coder by CLI command.
4. Coder runs GStack/Codex in a worktree.
5. Coder opens PR.
6. FounderOS tracks status from markdown + GitHub.
```

Do **not** start with folder watchers or webhooks. Add them after the manual dispatch loop works reliably.

The first automation worth adding is:

```text
Approve and dispatch STAB-001
```

where FounderOS handles the file move, commit, and `coder chat -q ...` command.

---

## User

The other thing is, should we have a general principle for cron stacking or does it not cost us anything? If we're running crons every 5 min or something, are we taking additional tokens if there's nothing to run on that? If we are, would it be beneficial to have a cron stacking policy where we basically sync ones that are not necessarily dependent on each other so that there's one long-running cron that just happens every time and then checks a number of things? Or is there a better way to do it or have it webhook off of something?

Also we have 3 min on CI so we can always put things on CI for now 


And then the other thing I guess is that we run Linear anyway. Should we just use Linear for the general issue tracking or is it just easier to do it off of MarkDoc files in the repo? I don't really give a shit since there's no external party but if it saves us some automation and lets us type in webhooks or something in a meaningful way, we could. If it's simpler to just keep it the way it is, it's fine 

---

## Assistant

Mr. White, I’d reduce this to one operating policy: use sparse batched polling, reserve event-driven triggers for urgent work, and decide whether Linear meaningfully simplifies the automation compared with repo task files.

---

## Assistant

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

Best event triggers:

```text
Linear issue moved to “Ready for Agent”
→ trigger Coder

GitHub PR opened/updated
→ trigger review/summarization

CI failed on main
→ trigger FounderOS P0 alert

Sentry P0 issue created
→ trigger FounderOS triage
```

Do not start with all of these. Start with **Linear → Coder** or **GitHub PR → FounderOS summary**.

## How to use CI

Since your CI is ~3 minutes, use it aggressively for deterministic checks.

Put this in CI:

```text
- typecheck
- lint
- unit tests
- onboarding smoke test if fast
- build
- maybe Playwright smoke path if it fits
```

Do not use CI as the main LLM runner yet. Use CI to produce facts. FounderOS/Coder can read those facts.

Good pattern:

```text
CI runs fast checks
→ status is visible on PR
→ Linear/GitHub status updates
→ FounderOS summarizes only failed/changed state
```

Bad pattern:

```text
Every CI run invokes an LLM to think about the repo.
```

Use the LLM after CI failure or before PR shipping, not on every push by default.

## Linear vs markdown

Use **Linear for the active issue queue**. Use **markdown for the task contract and audit trail**.

Since you already run Linear, use it. Linear’s GitHub integration can link PRs to issues via branch names, PR titles, or magic words, and it can automate issue status based on PR and commit activity. citeturn620163view0 That saves automation work you would otherwise rebuild with markdown folders.

Recommended split:

```text
Linear = live task tracker
Markdown = durable task spec
GitHub PR = code change
Ops repo = company memory / task archive
```

## Exact Linear workflow

### Statuses

Create or use these Linear statuses:

```text
Triage
Ready for Tim
Ready for Agent
Agent Running
PR Open
Blocked
Done
Cancelled
```

### Labels

Use labels:

```text
stabilization
onboarding
sentry
p0
p1
agent-ready
needs-founder-approval
```

### FounderOS creates issues

FounderOS should create Linear issues for stabilization work.

Example Linear issue:

```text
Title:
[STAB] Fix onboarding OAuth callback blank screen

Status:
Ready for Tim

Labels:
stabilization, onboarding, p0

Description:
Problem, expected behavior, actual behavior, scope, out-of-scope, acceptance criteria, required GStack workflow.

Task contract:
ops/tasks/coder/linear/JOV-123-fix-onboarding-oauth.md
```

### Tim approves

You move it to:

```text
Ready for Agent
```

or tell FounderOS:

```text
Approve JOV-123 for Coder.
```

### Coder picks it up

Two options.

For v1, manual:

```bash
coder chat -q "Execute Linear issue JOV-123. Read the task contract at /Users/tim/JovieInc/ops/tasks/coder/linear/JOV-123-fix-onboarding-oauth.md. Use GStack /review and /ship. Do not merge or deploy."
```

For v1.5, webhook:

```text
Linear issue status changed to Ready for Agent
→ Hermes webhook
→ Coder runs task
```

Linear webhooks fire on data created/updated, and Hermes webhooks can turn incoming events into agent prompts. citeturn231820view1turn231820view3

### Coder branches using Linear ID

Branch:

```bash
fix/JOV-123-onboarding-oauth
```

PR title or description:

```text
Fixes JOV-123
```

Linear recognizes issue IDs in branch names, PR titles, and magic words like `Fixes ENG-123`; closing magic words can move the issue through workflow states when branches/PRs/merges happen. citeturn620163view0

### Coder updates both places

Coder updates:

```text
Linear issue comment:
- worktree
- branch
- PR link
- tests run
- risks

Markdown task file:
- final implementation notes
- PR link
- result
```

## Should markdown still exist?

Yes, but markdown becomes **the contract**, not the queue.

Use this path:

```text
ops/tasks/coder/linear/JOV-123-fix-onboarding-oauth.md
```

The markdown file should be created once, committed, and linked in the Linear issue. It gives agents a stable, repo-visible spec.

Linear can change status. Markdown should preserve context.

## Recommended automation layering

### Now

```text
Manual approval + manual dispatch
Linear issue + markdown contract
Coder runs GStack
```

### Next

```text
Linear Ready for Agent → webhook → Coder dispatch
```

### Later

```text
GitHub PR updates → Linear status automation
CI failure → FounderOS alert
Sentry P0 → FounderOS alert
```

## Practical policy

Use this as the rule:

```text
No LLM cron more frequent than every 30 minutes unless it is reacting to a real event.

Every 5-minute job must be script-only or webhook-driven.

Batch low-urgency checks into one FounderOS sweep.

Use Linear for task state.

Use markdown for task contracts.

Use CI for facts.

Use GStack for code shipping.
```

## Minimal setup I’d run today

```text
1. Linear is the queue.
2. FounderOS creates Linear issues + task markdown.
3. Tim approves by moving issue to Ready for Agent.
4. Coder is manually dispatched from that issue.
5. Coder creates branch with Linear ID.
6. Coder runs /review and /ship.
7. PR uses “Fixes JOV-123.”
8. Linear/GitHub integration tracks status.
9. FounderOS daily briefing reads Linear + GitHub + markdown.
```

This keeps the system simple while giving you the automation hooks you’ll want later.

---

## User

Because these are sharing repo context and honcho memory, can we run the fundraising agent on the PC and have it just pick up tasks for now? Is that a good or bad way to do it? 
The ready for agent status: would it not be better to leave the stock statuses and use the assignee for that? That would eat seats I guess. I would just try and normalize. Agent running should just use the normal in progress and if it gets moved to to do, then that just means that to do there doesn't need to be a separate ready for Tim, ready for agent because we're operating in the same space 



---

## Assistant

I’d keep this simple: use your existing Linear workflow and normal statuses, then decide separately whether fundraise should live on the PC or just pick up tasks there for now.

---

## Assistant

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

Then use **labels** to determine who or what should pick it up:

```text
agent:coder
agent:fundraise
agent:founderos
agent:content

area:onboarding
area:fundraise
area:stability
area:yc
area:gtm

type:bug
type:task
type:research
type:draft
type:ops

source:sentry
source:gmail
source:founderos
source:user
```

So instead of:

```text
Status: Ready for Agent
```

use:

```text
Status: Todo
Label: agent:coder
```

Instead of:

```text
Status: Agent Running
```

use:

```text
Status: In Progress
Label: agent:coder
```

Instead of:

```text
Status: Ready for Tim
```

use:

```text
Status: Todo
Label: needs-tim
```

This keeps the workflow normal.

## Assignee policy

Do **not** create fake Linear users for each agent right now.

Linear’s current pricing page lists Free as unlimited members with 2 teams and 250 issues, Basic as $10/user/month billed yearly, and Business as $16/user/month billed yearly. Business adds private teams, guests, and Linear Agent automations beta. citeturn438458view0

Even if the free tier allows unlimited members, agent users create operational clutter. Separate users also become billing/permissions/admin overhead once you move plans.

Use assignee for the **human accountable owner**:

```text
Assignee: Tim
Labels: agent:coder / agent:fundraise
Status: Todo / In Progress
```

The agent can comment as the API token owner or via whatever integration identity you set up later.

Practical rule:

```text
Assignee = human accountable owner.
Label = execution lane.
Status = lifecycle state.
```

## How each agent decides what to pick up

### Coder on MBP

Query:

```text
status = Todo
label = agent:coder
priority = highest first
```

Then:

```text
move to In Progress
create branch/worktree
use GStack /review and /ship
comment PR link
leave merge/deploy to Tim
```

### Fundraise on PC

Query:

```text
status = Todo
label = agent:fundraise
priority = highest first
```

Then:

```text
move to In Progress
update Airtable
draft Gmail responses / investor emails
comment summary in Linear
move to Done if fully complete
move back to Todo with needs-tim label if approval is needed
```

### FounderOS on MBP

Query:

```text
everything high-priority
stale In Progress
new Sentry/user/fundraise signals
blocked issues
```

Then:

```text
create/clarify issues
add labels
write/refresh markdown contracts for important tasks
produce briefing
```

## Do we still need markdown task files?

Yes, but only for nontrivial tasks.

Use this split:

```text
Linear issue = active work item
Markdown file = detailed contract/context for agent execution
Linear comments = status updates
GitHub PR = code artifact
Airtable = fundraise CRM artifact
```

For a trivial fundraise task, Linear alone is enough.

For a real coding task, create markdown:

```text
ops/tasks/linear/JOV-123-fix-onboarding-oauth.md
```

For a real fundraising task, create markdown only when useful:

```text
ops/tasks/linear/JOV-211-build-warm-angel-list.md
```

Markdown is useful when the task needs:

```text
- exact acceptance criteria
- source links
- approval gates
- do-not-contact rules
- investor positioning
- code scope boundaries
- audit trail
```

## Fundraising agent workflow on PC

Run a separate profile on the PC:

```bash
fundraise chat
```

Give it this rule:

```text
You may pick up Linear issues with label agent:fundraise and status Todo.
Before starting, move the issue to In Progress.
You may update Airtable.
You may draft emails.
You may not send emails.
You may not launch campaigns.
You must comment a summary on the Linear issue.
If Tim approval is needed, add label needs-tim and move the issue to Todo.
```

Good statuses:

```text
Todo + agent:fundraise
→ In Progress + agent:fundraise
→ Done
```

For approval:

```text
In Progress + agent:fundraise
→ Todo + needs-tim
```

No custom status needed.

## Triggering fundraise from PC

Start manual/semi-manual:

```bash
fundraise chat -q "Pick up the highest-priority Todo Linear issue labeled agent:fundraise. Work one issue only. Draft but do not send external emails."
```

Then add a low-frequency cron:

```text
Every 60 minutes:
Check for Todo issues labeled agent:fundraise.
If none, exit.
If one exists, work the highest-priority one.
```

Do not run the fundraise agent every 5 minutes with an LLM. Fundraise tasks are rarely urgent to the minute.

Later:

```text
Linear webhook issue updated
→ if status Todo and label agent:fundraise
→ PC fundraise agent starts
```

## Final normalized operating model

Use this:

```text
Statuses:
Backlog
Todo
In Progress
Done
Canceled

Assignee:
Tim or actual human owner

Labels:
agent:coder
agent:fundraise
agent:founderos
needs-tim
stabilization
fundraise
onboarding
yc
p0
p1
```

And this routing:

```text
Todo + agent:coder
→ MBP coder picks it up

Todo + agent:fundraise
→ PC fundraise picks it up

Todo + needs-tim
→ Tim decision required

In Progress
→ actively being worked by either human or agent

Done
→ complete
```

## My recommendation

Run fundraise on the PC now, but keep the control system simple:

```text
1. Linear is the active queue.
2. Stock statuses only.
3. Labels route work to agents.
4. Assignee stays human.
5. Markdown exists only for meaningful task contracts.
6. Hancho memory shares context, but does not replace Linear.
7. Fundraise agent drafts and updates Airtable, but never sends or launches campaigns without approval.
```

That gives you parallelism without creating a fake org chart inside Linear.
