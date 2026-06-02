---
title: "Telegram approvals in Beeper"
type: essay
created: 2026-05-27
updated: 2026-05-27
source: chatgpt-export
conversation_id: 6a1689e0-05a8-83e8-94c5-436ffa0c6bad
message_count: 18
tags: [chatgpt, import, code, long-form]
---
# Telegram approvals in Beeper

> Conversation ID: 6a1689e0-05a8-83e8-94c5-436ffa0c6bad
> Created: 2026-05-27T06:06:40Z
> Updated: 2026-05-27T06:35:31Z
> Messages: 18

---

## User

Yeah, can I get Telegram tool approvals in beeper?

---

## Assistant

I’ll check the current state of Beeper/Telegram support and answer specifically around whether approval prompts/actions can be handled inside Beeper versus only in the native Telegram app.

---

## Assistant

Mr. White, **probably yes for seeing the Telegram approval messages**, but **maybe no for tapping approval buttons reliably inside Beeper**.

### Practical answer

- **Plain text Telegram approvals:** Yes. If OpenClaw / Hermes / whatever sends approval messages to Telegram, Beeper should receive them because Beeper supports Telegram bridging. citeturn772282view0
- **Inline approval buttons:** Unclear / fragile. The OpenClaw Telegram Approval Buttons plugin uses Telegram **inline keyboard buttons** via the Telegram Bot API. citeturn772282view2 Beeper bridges Telegram through Matrix, and bridged apps often fail on Telegram-native UI affordances like bot inline keyboards, callbacks, topics, and other richer Telegram-specific features. Beeper’s own docs list several Telegram limitations, including no topic support and channel/large-room limits. citeturn772282view0
- **Native Telegram app:** Safest path for one-tap approvals.
- **Beeper:** Good for receiving the notification and possibly replying with `/approve <id> allow-once` if the fallback text is present.

### Best setup

Use Telegram native as the approval target, keep Beeper as the unified inbox.

For agent approvals, configure the tool to send a fallback command like:

```txt
/approve <id> allow-once
/approve <id> always
/deny <id>
```

Then Beeper can still work even if the inline buttons do not render or callbacks do not fire.

### My recommendation

For your always-on agent machine:

1. **Send approvals to Telegram.**
2. **Keep Telegram installed for button approvals.**
3. **Let Beeper mirror the messages.**
4. **Require text fallback commands** so Beeper remains useful.

I would not rely on Beeper as the only approval surface for destructive or expensive agent actions.

---

## User

Should everything go through chief of staff agent or should we have a fundraising agent and a GYM agent and a product agent etc

---

## Assistant

Mr. White, use a **Chief of Staff agent as the router/orchestrator**, with **specialist agents underneath it**.

Do **not** make one mega-agent responsible for everything. It will become slow, vague, and expensive.

## Recommended structure

```txt
You
↓
Chief of Staff Agent
↓
Specialist Agents
- Product Agent
- Engineering Agent
- Fundraising Agent
- GTM / Sales Agent
- Content Agent
- Finance / Runway Agent
- Personal Ops Agent
- Gym / Health Agent
```

## What should go through Chief of Staff

Use Chief of Staff for:

- Daily planning
- Task triage
- Priority ranking
- Routing work to the right agent
- Checking whether work serves Jovie KPIs
- Summarizing agent outputs
- Catching conflicts between agents
- Deciding what gets escalated to you

The Chief of Staff should own the question:

> “What matters most right now, and who should do it?”

## What should go to specialist agents

Specialists should own **domain execution**.

### Product Agent

Owns:

- Roadmap
- Feature specs
- User flows
- UX cleanup
- PRD drafts
- Product-market fit questions
- Jovie app behavior

### Engineering Agent

Owns:

- Code implementation
- PR review
- Bug fixing
- Performance
- Tests
- CI
- Sentry issues

### Fundraising Agent

Owns:

- Investor list
- Warm intro tracking
- Pitch iteration
- Application recycling
- Investor updates
- Data room checklist

### GTM Agent

Owns:

- Scraper logic
- Outreach lists
- Campaign copy
- ICP scoring
- Conversion tracking
- Competitive positioning

### Gym / Health Agent

Owns:

- Weekly training plan
- Cut/bulk logic
- Meal prep planning
- Recovery
- Body comp tracking

This agent should **not** interrupt Jovie work unless you ask or there is a calendar/schedule conflict.

## The key rule

Chief of Staff should **delegate**, not execute everything.

Bad:

```txt
Chief of Staff writes code, edits deck, plans workout, researches investors, checks GitHub, rewrites copy.
```

Good:

```txt
Chief of Staff sees runway is short → asks Fundraising Agent for investor targets → asks Product Agent for demo narrative → asks Engineering Agent for demo blockers → gives you one ranked action plan.
```

## Suggested agent hierarchy

| Layer | Role | Example |
|---|---|---|
| You | CEO / final taste / final decision | “Ship this, kill that, make it sexier.” |
| Chief of Staff | Router, prioritizer, synthesizer | “Today’s top constraint is fundraising/demo readiness.” |
| Specialist Agents | Domain workers | Product, fundraising, GTM, gym, finance |
| Tool Agents | Narrow executors | GitHub bot, browser bot, calendar bot, scraper bot |

## Decision logic

Every task should be classified by Chief of Staff:

```txt
1. Is this urgent?
2. Is this tied to Jovie survival, growth, or product quality?
3. Which agent owns it?
4. What is the expected output?
5. Does Tim need to approve it?
6. What is the cheapest model/tool that can do it?
```

## My recommendation for your setup

Start with **5 agents**, not 20:

1. **Chief of Staff**
   - Owns prioritization, daily plan, routing, summaries.

2. **Product Agent**
   - Owns Jovie UX, specs, positioning, product strategy.

3. **Engineering Agent**
   - Owns implementation, QA, perf, PRs.

4. **Fundraising Agent**
   - Owns investor pipeline, updates, applications, deck iteration.

5. **Personal Ops Agent**
   - Owns gym, meals, calendar, errands, apartment, car, life logistics.

Then later split Personal Ops into:

```txt
Gym Agent
Finance Agent
Household Agent
Calendar Agent
```

Only split when the workload justifies it.

## Operating principle

Use this architecture:

```txt
Centralized prioritization.
Decentralized execution.
Centralized reporting.
```

That gives you focus without turning the Chief of Staff into a bloated chatbot.

---

## User

Should the agents be always on Hermes agents or crons or agent profiles or how do we set this up. Do I use conductor or something and leave 5 agents always running or do I just run one agent in a terminal and ask it to spin up sub agents?

---

## Assistant

Mr. White, do **not** leave 5 full Hermes agents always running.

Use this:

```txt
1 always-on Chief of Staff process
+ scheduled crons for recurring checks
+ specialist agent profiles invoked on demand
+ Conductor only for multi-step engineering/product work
```

## Best architecture

```txt
Always-on layer
└── Chief of Staff Hermes agent

Scheduled layer
├── fundraising scan cron
├── changelog/news cron
├── GitHub/PR/Sentry cron
├── daily planning cron
└── weekly gym/planning cron

On-demand layer
├── Product profile
├── Engineering profile
├── Fundraising profile
├── GTM profile
├── Personal Ops profile
└── Gym profile

Heavy execution layer
└── Conductor / worktrees / subagents for real implementation
```

## What should always run

### 1. One Hermes Chief of Staff

This is the only thing I would keep constantly available.

It should:

- receive Telegram approvals
- read daily state
- triage tasks
- decide what matters
- call specialist profiles
- summarize outputs
- ask you for approval only when needed

It should **not** do all the work itself.

## What should be crons

Use crons for anything predictable.

Examples:

```txt
Every morning:
- summarize calendar
- inspect active tasks
- identify top 3 priorities
- check runway/fundraising status
- check critical Jovie blockers

Every 6 hours:
- check GitHub issues/PRs/Sentry
- check developer tool changelogs
- check investor replies
- check high-priority inbox threads

Weekly:
- gym/body comp review
- budget review
- GTM pipeline review
- fundraising pipeline review
```

Crons should produce **brief reports**, not launch huge autonomous work unless a condition is met.

## What should be agent profiles

Use profiles for reusable personalities/capabilities:

```txt
hermes --profile chief-of-staff
hermes --profile product
hermes --profile engineering
hermes --profile fundraising
hermes --profile gtm
hermes --profile personal-ops
hermes --profile gym
```

Each profile should have:

- its own system prompt
- its own tool permissions
- its own memory scope
- its own output format
- clear escalation rules

Profiles are cheap to maintain because they are **configuration**, not always-running workers.

## What should use Conductor

Use Conductor when you need **parallel execution or isolated worktrees**.

Good Conductor jobs:

- “Audit app shell and open PRs for layout fixes”
- “Run 3 design passes on the onboarding flow”
- “Implement profile import, test it, and open PR”
- “Compare 5 GTM landing page variants”
- “Run /qa --exhaustive and fix regressions”

Do **not** use Conductor for:

- daily planning
- reminders
- gym programming
- simple research
- investor list cleanup
- inbox summaries

Conductor is for **real work**, not passive monitoring.

## Do you run one terminal or multiple?

Use **one main terminal/session** for the Chief of Staff.

Then let it spawn specific jobs:

```txt
Chief of Staff receives task
↓
Classifies task
↓
Chooses:
- answer directly
- run specialist profile
- schedule cron
- create Conductor job
- ask Tim for approval
```

You do **not** need five terminals sitting open as five fake employees.

## Correct mental model

### Bad setup

```txt
5 always-on agents:
- all checking things
- all burning tokens
- all creating noise
- unclear ownership
- duplicate work
- messy memory
```

### Good setup

```txt
1 always-on router
+ cron triggers
+ specialist profiles
+ Conductor for execution
```

## Suggested MVP setup

Start with this exact stack:

### Always-on

```txt
Hermes Chief of Staff
```

Runs on the always-on MacBook Air.

### Profiles

```txt
chief-of-staff
product
engineering
fundraising
gtm
personal-ops
gym
```

### Crons

```txt
daily-plan: 8:30 AM
jovie-health-check: every 6 hours
fundraising-check: every day at 10 AM
github-pr-check: every 3 hours
gym-week-review: Sunday night
```

### Conductor

Only triggered by Chief of Staff for larger tasks.

## Permission model

Give the Chief of Staff broad **read** access and narrow **write** access.

```txt
Chief of Staff:
- can read calendar, tasks, GitHub, docs, inbox summaries
- can draft tasks
- can propose actions
- needs approval for sending, deleting, spending, deploying, messaging investors

Specialist agents:
- only get the tools they need
- only get scoped context
- report back to Chief of Staff
```

## Default routing rules

```txt
Task involves code → Engineering profile or Conductor
Task involves UX/product/copy → Product profile
Task involves investors/applications/deck → Fundraising profile
Task involves scraping/outreach/ICP → GTM profile
Task involves schedule/life/admin → Personal Ops
Task involves training/nutrition/body comp → Gym profile
Task spans multiple domains → Chief of Staff orchestrates
```

## My direct recommendation

Set it up as:

```txt
One persistent Hermes Chief of Staff on the MacBook Air.
Crons wake it up with specific prompts.
Specialist profiles are invoked only when needed.
Conductor is reserved for multi-agent/product/engineering execution.
```

That gives you the most leverage with the least token burn, noise, and operational mess.

---

## User

Yeah, if we were using a max 20x plan on Claude or Codex, and we were maxing it out, and then we switched all of that usage to Composer 2.5, but purely token-based, what would the cost look like?

---

## Assistant

I’ll ground this in current public pricing, then translate “maxing out a fixed plan” into token-volume scenarios because Claude/Codex plan limits do not map cleanly to published token counts.

---

## Assistant

Mr. White, the useful answer:

> **Composer 2.5 Standard is cheap enough that $200/month buys a lot. Composer 2.5 Fast gets expensive fast.**

Cursor prices Composer 2.5 at **$0.50/M input tokens + $2.50/M output tokens**. The **Fast** variant is **$3/M input + $15/M output**, and Cursor says Fast is the default option. citeturn729292search3

Claude Max 20x is **$200/month**. citeturn729292search1 OpenAI’s Pro 20x tier is also effectively the $200 heavy Codex tier, with 20x Plus usage on an ongoing basis and temporarily higher 5-hour limits through May 31, 2026. citeturn548335search0

## Composer 2.5 cost formula

### Standard

```txt
monthly cost = input_millions × $0.50 + output_millions × $2.50
```

### Fast

```txt
monthly cost = input_millions × $3.00 + output_millions × $15.00
```

Fast is exactly **6x Standard**.

## What $200/month buys on Composer 2.5

| Usage shape | Composer 2.5 Standard at $200 | Composer 2.5 Fast at $200 |
|---|---:|---:|
| All input tokens | 400M input | 66.7M input |
| All output tokens | 80M output | 13.3M output |
| 4:1 input/output mix | ~222M total tokens | ~37M total tokens |
| 10:1 input/output mix | ~293M total tokens | ~49M total tokens |
| 20:1 input/output mix | ~336M total tokens | ~56M total tokens |

For coding agents, a **10:1 to 20:1 input/output ratio** is realistic if they repeatedly read repo context, logs, diffs, docs, and test output.

## Scenario table

| Monthly usage | Standard cost | Fast cost |
|---|---:|---:|
| 50M input / 10M output | **$50** | **$300** |
| 100M input / 20M output | **$100** | **$600** |
| 200M input / 40M output | **$200** | **$1,200** |
| 500M input / 100M output | **$500** | **$3,000** |
| 1B input / 200M output | **$1,000** | **$6,000** |

## Translation

If you are maxing a **$200 Claude/Codex plan**, switching the same behavior to Composer 2.5 would roughly look like:

| Behavior | Likely Composer cost |
|---|---:|
| Light daily agent use | $25–$100/mo Standard |
| Heavy daily coding use | $100–$300/mo Standard |
| Full “leave agents grinding” usage | $300–$1,000+/mo Standard |
| Same thing on Fast | $600–$6,000+/mo |

## Recommendation

Use **Composer 2.5 Standard** for:

- background agents
- repo scanning
- planning
- issue triage
- routine fixes
- cheap overnight work
- Chief of Staff / Hermes sub-agent calls

Use **Composer 2.5 Fast** only for:

- interactive coding where latency matters
- urgent debugging
- tasks where waiting costs you more than tokens

### Practical default

```txt
Default: Composer 2.5 Standard
Escalate: Composer 2.5 Fast only when latency matters
Frontier fallback: Claude/Codex for hard reasoning, architecture, or high-risk PRs
```

The danger is leaving Fast as default. At your usage pattern, **Fast can turn a $200/month subscription replacement into a $1,000–$3,000/month bill**.

---

## User

Should there be a coding agent on the mbp pro always on? Or the air spins it up on demand?

---

## Assistant

Mr. White, **the Air should spin up coding agents on demand**. Do **not** keep a coding agent always running on the MBP Pro by default.

## Best setup

```txt
MacBook Air = always-on controller
MBP Pro = high-power execution node
```

### MacBook Air

Run:

```txt
Hermes Chief of Staff
crons
light monitoring
approval routing
task queue
status reports
```

The Air decides when code work is needed.

### MBP Pro

Run coding agents only when there is a real job:

```txt
Conductor
Claude Code
Codex
repo worktrees
test loops
Playwright
Lighthouse
builds
```

The MBP Pro should be treated like a **worker machine**, not a constantly-chatting employee.

## Why

An always-on coding agent creates problems:

| Problem | Why it matters |
|---|---|
| Token burn | Coding agents reread repo context constantly |
| Noise | They invent work unless tightly scoped |
| Merge risk | More agents touching code increases conflicts |
| Context drift | Long-running sessions get stale |
| Laptop heat/battery | MBP stays loaded for no reason |
| Focus loss | More outputs for you to supervise |

## Correct flow

```txt
1. Air Chief of Staff detects coding need
2. Creates a scoped coding task
3. Opens/assigns a worktree on MBP Pro
4. Starts Conductor / Claude Code / Codex
5. Agent runs tests and opens PR
6. Chief of Staff summarizes result
7. You approve merge/deploy
```

## When to leave MBP coding agent running

Only for bounded execution windows:

```txt
- overnight QA sprint
- active PR cleanup
- full app audit
- migration
- performance loop
- design implementation pass
```

Set it with a clear task and stop condition:

```txt
Run until:
- PR opened
- tests pass
- blocker found
- 2-hour budget hit
- approval required
```

## Recommended default

```txt
Air:
  always-on Chief of Staff

MBP Pro:
  on-demand coding worker

Conductor:
  used for multi-worktree execution

Claude/Codex:
  used for hard code/review

Cheap models:
  used for planning, triage, grep, summarization
```

## Simple rule

If the task requires touching the repo, running tests, or opening a PR:

```txt
Air routes it → MBP executes it
```

If the task is monitoring, planning, summarizing, or prioritizing:

```txt
Air handles it
```

That keeps the system cheap, clean, and less chaotic.

---

## User

But how do we orchestrate auto picking up issues on the pro?

---

## Assistant

Mr. White, use the Air as the **scheduler/router** and the MBP Pro as a **pull-based worker**.

The Pro should **poll a queue**, claim eligible coding jobs, run them in isolated worktrees, then report back.

## Recommended orchestration

```txt
MacBook Air
- Chief of Staff
- crons
- creates/labels coding issues
- maintains task queue
- sends approvals

MBP Pro
- worker daemon
- polls queue every few minutes
- claims approved coding jobs
- creates worktree
- runs Conductor / Claude Code / Codex
- opens PR
- reports result
```

## The key: use GitHub Issues as the queue

Do this instead of inventing a whole task system first.

### Labels

```txt
agent:ready
agent:blocked
agent:in-progress
agent:needs-review
agent:done

area:engineering
area:product
area:design
area:qa
area:perf

risk:low
risk:medium
risk:high

runner:mbp-pro
runner:air
```

### The MBP Pro only picks up issues matching:

```txt
is:issue
is:open
label:agent:ready
label:runner:mbp-pro
-label:agent:blocked
-label:agent:in-progress
```

## Flow

```txt
1. Air/Chief of Staff creates or labels an issue:
   agent:ready + runner:mbp-pro

2. MBP Pro cron sees it.

3. MBP Pro claims it:
   removes agent:ready
   adds agent:in-progress
   comments: "Claimed by mbp-pro."

4. MBP Pro creates worktree:
   ../jovie-worktrees/issue-123-short-name

5. Runs agent with the issue body as prompt.

6. Agent commits changes, runs tests, opens PR.

7. MBP Pro updates issue:
   removes agent:in-progress
   adds agent:needs-review
   comments with PR link, test result, summary.

8. Chief of Staff summarizes to you in Telegram.
```

## Safety gate

Only auto-pick up **low-risk issues**.

Auto-run:

```txt
risk:low
area:qa
area:perf
area:design
area:copy
```

Require approval:

```txt
risk:medium
risk:high
database migrations
auth
billing
payments
deploys
deleting data
investor/customer emails
```

## Minimal script shape

Run this on the MBP Pro every 5 minutes via `launchd` or cron:

```bash
#!/usr/bin/env bash
set -euo pipefail

REPO="timwhite/jovie"
BASE="$HOME/dev/jovie"
WORKTREES="$HOME/dev/jovie-worktrees"

issue_json=$(gh issue list \
  --repo "$REPO" \
  --state open \
  --label "agent:ready" \
  --label "runner:mbp-pro" \
  --json number,title,labels,url \
  --limit 1)

issue_number=$(echo "$issue_json" | jq -r '.[0].number // empty')

if [ -z "$issue_number" ]; then
  exit 0
fi

title=$(echo "$issue_json" | jq -r '.[0].title')
slug=$(echo "$title" | tr '[:upper:]' '[:lower:]' | tr -cs 'a-z0-9' '-' | sed 's/^-//;s/-$//' | cut -c1-40)

gh issue edit "$issue_number" \
  --repo "$REPO" \
  --remove-label "agent:ready" \
  --add-label "agent:in-progress"

gh issue comment "$issue_number" \
  --repo "$REPO" \
  --body "Claimed by MBP Pro worker."

cd "$BASE"
git fetch origin main
branch="agent/issue-${issue_number}-${slug}"
worktree="$WORKTREES/issue-${issue_number}-${slug}"

git worktree add -b "$branch" "$worktree" origin/main

cd "$worktree"

gh issue view "$issue_number" \
  --repo "$REPO" \
  --json title,body,comments \
  > /tmp/issue-${issue_number}.json

# Replace this with your actual runner:
# conductor run --issue /tmp/issue-${issue_number}.json
# claude-code --dangerously-skip-permissions < prompt.md
# codex exec < prompt.md
hermes --profile engineering --input /tmp/issue-${issue_number}.json

git status
```

## Better version: task file per issue

Have the Air/Chief of Staff generate a structured issue body:

```md
## Objective
Fix the task page spacing regression.

## Scope
Only modify task page layout and related components.

## Constraints
- Do not touch auth.
- Do not change database schema.
- Do not redesign sidebar.
- Preserve Shell V1 design system.

## Acceptance Criteria
- Task page gaps match screenshot reference.
- No layout shift on navigation.
- Tests pass.
- Screenshot before/after included.

## Risk
Low

## Runner
MBP Pro

## Suggested Agent
engineering
```

This makes auto-pickup much safer.

## Use Conductor when

The issue has:

```txt
multiple files
visual QA
test loop
parallel design/code attempts
needs isolated worktree
```

For small changes, a single Hermes/Claude/Codex engineering profile is enough.

## Final recommendation

Set up:

```txt
Air:
  creates/prioritizes/labels issues

GitHub Issues:
  queue and source of truth

MBP Pro:
  launchd worker polls GitHub
  claims one issue at a time
  runs coding agent in worktree
  opens PR
  reports back

Chief of Staff:
  reviews result and asks you for approval
```

This gives you automatic pickup without five chaotic agents sitting around burning tokens.

---

## User

Give me a prompt for air to set up

---

## Assistant

Mr. White, paste this into the **Air Chief of Staff / Hermes setup agent**.

```txt
You are setting up this MacBook Air as the always-on controller for Tim White’s agent system.

Goal:
Create a lightweight orchestration setup where this MacBook Air runs the Chief of Staff agent, scheduled checks, and GitHub issue routing. The Air should not do heavy coding work. Heavy coding work should be assigned to the MBP Pro through GitHub Issues using labels.

Operating model:
- MacBook Air = always-on scheduler, router, reporter
- MBP Pro = on-demand coding worker
- GitHub Issues = shared task queue
- Specialist profiles = invoked only when needed
- Conductor / Claude Code / Codex = used only for scoped engineering jobs

Primary objective:
Set up a working MVP where the Air can:
1. Run a persistent Chief of Staff Hermes profile.
2. Run scheduled cron/launchd jobs.
3. Create and label GitHub Issues for coding work.
4. Assign eligible issues to the MBP Pro using labels.
5. Avoid doing heavy repo/test/build work locally.
6. Send concise status reports to Tim.
7. Require approval before dangerous actions.

Repository:
Use the Jovie repo as the main repo. If the repo path or GitHub owner/name is unknown, detect it from the local git remote or ask once.

Required GitHub labels:
Create these labels if missing:

Status:
- agent:ready
- agent:blocked
- agent:in-progress
- agent:needs-review
- agent:done

Area:
- area:engineering
- area:product
- area:design
- area:qa
- area:perf
- area:gtm
- area:fundraising
- area:personal

Risk:
- risk:low
- risk:medium
- risk:high

Runner:
- runner:mbp-pro
- runner:air

Agent:
- agent-profile:engineering
- agent-profile:product
- agent-profile:fundraising
- agent-profile:gtm
- agent-profile:personal-ops
- agent-profile:gym

Issue routing rules:
- Code, tests, app UI, PRs, builds, Playwright, Lighthouse, and repo work go to runner:mbp-pro.
- Planning, summaries, investor tracking, personal ops, and daily briefings stay on runner:air.
- Only risk:low issues can be auto-assigned to runner:mbp-pro without explicit Tim approval.
- risk:medium and risk:high issues require approval before being marked agent:ready.
- Anything involving auth, billing, payments, database migrations, production deploys, deleting data, sending external messages, or investor/customer emails must require approval.

Chief of Staff responsibilities:
- Prioritize work based on Jovie survival, fundraising, product quality, and revenue.
- Convert vague requests into structured GitHub Issues.
- Add correct labels.
- Route coding work to MBP Pro.
- Summarize results.
- Ask Tim for approval only when needed.
- Avoid noisy updates.

Specialist profile model:
Do not keep multiple specialist agents always running.
Set up these profiles as callable profiles/configs:
- chief-of-staff
- engineering
- product
- fundraising
- gtm
- personal-ops
- gym

The Chief of Staff profile is the only always-on agent.
Specialist profiles are invoked on demand.

Scheduled jobs to create on the Air:
1. daily-plan
   - Time: 8:30 AM local
   - Action: Summarize calendar/tasks/issues and produce top 3 priorities.
   - Output: concise report to Tim.

2. jovie-health-check
   - Frequency: every 6 hours
   - Action: Check GitHub Issues/PRs, repo health signals, blocked agent jobs, and urgent product/engineering problems.
   - Output: only report if something materially changed or needs Tim.

3. fundraising-check
   - Time: 10:00 AM local
   - Action: Check fundraising tasks, investor follow-ups, applications, and stale threads.
   - Output: concise list of next actions.

4. github-routing-check
   - Frequency: every 15 minutes
   - Action: Look for untriaged GitHub Issues or tasks, classify them, and label them.
   - Output: usually silent unless approval is needed.

5. weekly-gym-review
   - Time: Sunday 7:00 PM local
   - Action: Review training/nutrition plan and upcoming week constraints.
   - Output: concise plan.

Implementation requirements:
- Prefer launchd on macOS over cron if possible.
- Store scripts in a clean folder, for example:
  ~/agent-os/scripts
  ~/agent-os/logs
  ~/agent-os/state
  ~/agent-os/prompts
- Make scripts idempotent.
- Log all runs.
- Do not expose secrets in logs.
- Use environment variables for tokens/config.
- Include dry-run mode for destructive or noisy actions.
- Do not auto-send emails, texts, investor messages, or customer messages.
- Do not auto-deploy.
- Do not delete files, branches, issues, or data without approval.

Create a GitHub issue template for agent-runnable work:

## Objective
Clear one-sentence objective.

## Context
Relevant background.

## Scope
What the agent is allowed to touch.

## Constraints
What the agent must not touch.

## Acceptance Criteria
- Specific measurable outcome
- Tests or checks required
- Screenshot required if visual

## Risk
Low / Medium / High

## Runner
Air / MBP Pro

## Suggested Agent Profile
engineering / product / fundraising / gtm / personal-ops / gym

## Approval Required
Yes / No

## Notes
Extra context.

Create a router script that:
1. Finds open issues without agent labels.
2. Classifies them by area/risk/runner/profile.
3. Adds labels.
4. For low-risk coding issues, adds:
   - agent:ready
   - runner:mbp-pro
   - risk:low
   - agent-profile:engineering
5. For risky issues, adds:
   - agent:blocked
   - risk:medium or risk:high
   - comment explaining approval needed.

Create a status command:
agent-status

It should print:
- Active agent jobs
- Issues ready for MBP Pro
- Issues blocked for approval
- PRs needing review
- Last successful daily plan
- Last failed cron/launchd job

Create a queue command:
agent-queue

It should print:
- Ready issues by priority
- Runner assignment
- Risk level
- Suggested profile
- URL

Create an approval command:
agent-approve ISSUE_NUMBER

It should:
- remove agent:blocked
- add agent:ready
- keep runner/profile/risk labels
- comment that Tim approved the issue

Create a block command:
agent-block ISSUE_NUMBER "reason"

It should:
- remove agent:ready
- add agent:blocked
- comment with the reason

Deliverables:
1. Install/setup script.
2. launchd plist files.
3. GitHub label setup script.
4. Router script.
5. Status command.
6. Queue command.
7. Approval/block commands.
8. Chief of Staff profile prompt.
9. Specialist profile prompts.
10. README explaining how to run, stop, debug, and extend the system.

Chief of Staff profile prompt:
You are Tim White’s Chief of Staff agent. Your job is to prioritize, route, and summarize work. You are not a general chatbot and you are not the primary coding worker. Keep Tim focused on Jovie survival, fundraising, product quality, and revenue. Use GitHub Issues as the source of truth for work. Route heavy coding work to the MBP Pro by labeling issues runner:mbp-pro and agent:ready. Ask for approval before risky actions. Keep updates concise. Never create noise for low-value changes. Your default output should be a short status report, a ranked task list, or a clear approval request.

Engineering profile prompt:
You are the Engineering agent for Jovie. You execute scoped GitHub Issues. Work only within the stated scope. Prefer small PRs. Preserve the design system. Run relevant tests. For visual changes, include before/after screenshots when possible. Do not touch auth, billing, database schema, production deploys, secrets, or destructive actions unless explicitly approved. Report back with summary, files changed, tests run, risks, and PR URL.

Product profile prompt:
You are the Product agent for Jovie. You turn messy product intent into clear specs, UX flows, issue bodies, acceptance criteria, and prioritization. Optimize for speed, clarity, conversion, and Jovie’s current survival/fundraising needs. Keep copy concise. Avoid bloated feature specs. Route implementation to Engineering.

Fundraising profile prompt:
You are the Fundraising agent for Jovie. You manage investor pipeline, pitch clarity, application recycling, investor updates, and warm intro tasks. Keep outputs concise and concrete. Do not send messages externally without Tim’s approval. Produce drafts and next-action lists.

GTM profile prompt:
You are the GTM agent for Jovie. You manage ICP research, artist scraping strategy, outreach drafts, landing page positioning, and conversion loops. Prioritize cheap validation and revenue. Do not spam, scrape abusively, or send external messages without approval.

Personal Ops profile prompt:
You are Tim White’s Personal Ops agent. You help with scheduling, errands, household tasks, moving, car, budgeting logistics, and life admin. Keep outputs practical and concise. Do not interrupt Jovie work unless there is a real scheduling, health, money, or logistics conflict.

Gym profile prompt:
You are Tim White’s Gym agent. You help with training, nutrition, body composition, recovery, and gym scheduling. Respect Tim’s known training preferences: side delts, biceps, chest, triceps, abs, back, forearms, traps, glutes, legs, in that priority order. Avoid overhead pressing. Prefer stretched-position biceps work, pull-ups/pulldowns for back, and side-delt-focused lateral raise variations. Keep plans concise and practical.

After setup:
- Run label creation.
- Install launchd jobs.
- Run one dry-run of each script.
- Print the resulting file tree.
- Print exact commands Tim can use:
  agent-status
  agent-queue
  agent-approve ISSUE_NUMBER
  agent-block ISSUE_NUMBER "reason"
- Do not claim success unless commands actually run.
```

Add this as the **first implementation instruction** if you want it to build cautiously:

```txt
Start by creating the file structure, scripts, and dry-run mode only. Do not install launchd jobs or modify GitHub labels until I approve the dry-run output.
```

---

## User

All agents should use ruflo and gbrain and coder profiles. We should have plans written by composer 2.5 or better if it’s needed. And execution by deepseek? Write a plan that’s optimal for us.

Also should we use a coding planner profile and a coder profile? Etc? 

---

## Assistant

Mr. White, yes: use **separate planner and coder profiles**.

The optimal setup is:

```txt
Chief of Staff
→ Planner profile
→ Coder profile
→ Reviewer / QA profile
→ Chief of Staff summary
```

Do **not** let the same agent plan, code, approve its own work, and summarize success. That creates sloppy PRs.

# Optimal Jovie agent architecture

## Core rule

```txt
Composer 2.5 or better writes plans.
DeepSeek executes low/medium-risk code.
Claude/Codex handles hard architecture, review, auth, DB, billing, and rescue work.
Ruflo runs workflow/state.
GBrain provides shared memory/context.
Coder profiles define behavior and tool scope.
```

## Recommended stack

| Layer | Tool/model | Job |
|---|---|---|
| Orchestration | **Ruflo** | workflow state, queues, retries, handoffs |
| Company memory | **GBrain** | durable company/project memory |
| Router | **Hermes Chief of Staff** | triage, priority, approvals |
| Planning | **Composer 2.5 Standard** | specs, issue plans, task decomposition |
| Premium planning | **Claude/Codex/GPT-5.5** | hard architecture, risky work |
| Execution | **DeepSeek V4 Flash / cheap coder** | scoped implementation |
| Review | **Composer 2.5 / Claude/Codex** | PR review, risk check |
| Heavy coding | **MBP Pro + Conductor** | worktrees, tests, PRs |
| Always-on control | **MacBook Air** | crons, routing, approvals |

# Agent profiles to use

## 1. Chief of Staff profile

**Always on. Runs on Air.**

Owns:

- daily priority
- issue routing
- approval gating
- agent selection
- summary back to you
- deciding whether work is worth doing

It should not code.

## 2. Coding Planner profile

**Yes, this should be separate.**

Owns:

- reading issue/context
- writing implementation plan
- defining files likely touched
- acceptance criteria
- test plan
- risk assessment
- model recommendation

Use **Composer 2.5 Standard by default**.

Escalate planner to Claude/Codex/GPT-5.5 when:

- auth
- billing
- DB schema
- architecture
- performance-sensitive flows
- security
- deploy/release changes
- ambiguous product behavior
- more than ~5 files touched

## 3. Coder profile

Owns:

- executing the plan
- modifying files
- keeping scope tight
- running tests
- committing changes
- opening PR

Use **DeepSeek** for:

- layout fixes
- copy changes
- component cleanup
- simple bugs
- test additions
- refactors with clear plan
- docs
- issue hygiene

Use Claude/Codex for:

- failing DeepSeek attempts
- complex TypeScript bugs
- architectural work
- debugging weird runtime/test failures
- migrations
- auth/billing/secrets
- high-risk PRs

## 4. Reviewer profile

Owns:

- compare PR against plan
- check scope creep
- inspect diff
- check tests
- flag risks
- request changes

Use Composer 2.5 for normal review. Use Claude/Codex for risky PRs.

## 5. QA profile

Owns:

- Playwright
- screenshots
- Lighthouse
- visual regressions
- acceptance checklist

Can use cheap model for summarizing output. Use stronger model when diagnosing failures.

# Recommended workflow

```txt
1. Chief of Staff sees task/issue.
2. Chief of Staff classifies:
   - area
   - risk
   - runner
   - required profile
   - approval required or not

3. Coding Planner writes plan.
4. Reviewer checks plan if risk medium/high.
5. MBP Pro worker claims issue.
6. Coder executes plan in worktree.
7. QA runs tests/screenshots.
8. Reviewer checks diff.
9. Chief of Staff summarizes to Tim.
10. Tim approves merge/deploy if needed.
```

# Model routing

## Default routing table

| Task type | Planner | Executor | Reviewer |
|---|---|---|---|
| Copy/UI polish | Composer 2.5 | DeepSeek | Composer 2.5 |
| Simple bug | Composer 2.5 | DeepSeek | Composer 2.5 |
| Tests | Composer 2.5 | DeepSeek | Composer 2.5 |
| Performance cleanup | Composer 2.5 or Claude | DeepSeek first | Claude/Codex |
| App shell refactor | Claude/Codex | DeepSeek or Codex | Claude/Codex |
| Auth | Claude/Codex | Claude/Codex | Claude/Codex |
| DB/schema | Claude/Codex | Claude/Codex | Claude/Codex |
| Billing/payments | Claude/Codex | Claude/Codex | Claude/Codex |
| Deploy/release | Claude/Codex | Human-approved | Claude/Codex |
| Fundraising copy | Composer 2.5 | Composer 2.5 | GPT-5.5/Claude optional |
| GTM scraping | Composer 2.5 | DeepSeek | Composer 2.5 |
| Gym/personal ops | cheap model | cheap model | none |

# Where Ruflo fits

Use **Ruflo as the workflow brain**, not as the model brain.

Ruflo should track:

```txt
issue_id
workflow_id
status
current_step
assigned_runner
assigned_profile
planner_model
executor_model
reviewer_model
risk_level
approval_required
last_error
retry_count
pr_url
```

Example states:

```txt
created
triaged
needs-plan
planned
approved-for-execution
claimed-by-runner
executing
needs-qa
needs-review
needs-human-approval
done
blocked
failed
```

This prevents the system from becoming “random agents yelling in terminals.”

# Where GBrain fits

Use **GBrain as context and memory**, not the live task queue.

GBrain should store:

```txt
Jovie product principles
design system rules
known architecture
repo conventions
agent operating rules
past decisions
pitch/fundraising language
model-routing policy
common failure modes
accepted PR patterns
Tim preferences
```

Do **not** use GBrain as the source of truth for active tasks. Active tasks belong in:

```txt
GitHub Issues + Ruflo state
```

# The ideal coding pipeline

## Step 1: Plan

Planner produces:

```md
## Objective
## Relevant Context
## Files Likely Touched
## Implementation Plan
## Acceptance Criteria
## Tests / Checks
## Risk Assessment
## Stop Conditions
```

## Step 2: Execute

Coder receives only:

```txt
- issue body
- planner output
- scoped repo context
- relevant GBrain notes
- explicit forbidden areas
```

Coder should not be allowed to freestyle product direction.

## Step 3: Review

Reviewer checks:

```txt
Did it follow the plan?
Did it touch forbidden files?
Did tests pass?
Did it create UX drift?
Did it create security/billing/auth risk?
Is PR small enough?
Should Tim review?
```

# Should the coder write the plan?

Default: **no**.

Use this split:

```txt
Planner = decides what should happen.
Coder = makes it happen.
Reviewer = checks whether it happened correctly.
```

Exception: tiny tasks.

For tiny tasks, allow planner+coder combined:

```txt
- typo
- one-line copy
- simple CSS spacing
- dependency-free docs update
```

Even then, require a reviewer before merge if code changed.

# Recommended machine setup

## MacBook Air

Runs:

```txt
Hermes Chief of Staff
Ruflo scheduler
GBrain access
GitHub issue router
cron/launchd jobs
Telegram approvals
status reports
```

Does not run heavy repo builds.

## MBP Pro

Runs:

```txt
MBP worker daemon
Conductor
worktrees
DeepSeek execution
Claude/Codex escalation
Playwright
tests
Lighthouse
PR creation
```

The Pro should poll Ruflo/GitHub for:

```txt
agent:ready
runner:mbp-pro
risk:low
```

# Approval policy

## Auto-execute

```txt
risk:low
copy
CSS
visual polish
tests
docs
small components
non-production scripts
```

## Needs approval before execution

```txt
risk:medium
large refactors
touches many files
changes user-facing behavior
new dependencies
analytics/tracking
pricing/onboarding logic
```

## Needs approval before merge/deploy

```txt
auth
billing
database
payments
secrets
production deploys
external messages
deleting data
investor/customer communication
```

# My recommended default loop

```txt
Air Chief of Staff
  ↓
Ruflo workflow created
  ↓
GBrain context pulled
  ↓
Composer 2.5 planner writes plan
  ↓
Risk gate
  ↓
MBP Pro worker claims job
  ↓
DeepSeek coder executes
  ↓
Tests/QA
  ↓
Composer 2.5 reviewer checks
  ↓
Claude/Codex only if risky or failed
  ↓
Chief of Staff summarizes
```

# Minimal MVP version

Start with only these profiles:

```txt
chief-of-staff
coding-planner
coder
reviewer
qa
fundraising
product
```

Do **not** start with 20 agents.

# Final recommendation

Use:

```txt
Ruflo = workflow state
GBrain = durable memory
Chief of Staff = router
Coding Planner = Composer 2.5 or better
Coder = DeepSeek by default
Reviewer = Composer 2.5 by default
Claude/Codex = escalation for hard/risky work
MBP Pro = execution worker
MacBook Air = always-on controller
```

Yes, create both:

```txt
coding-planner profile
coder profile
```

That split is one of the highest-leverage changes. It keeps cheap execution from making expensive strategic mistakes.


## See Also
- [[chatgpt/chatgpt_telegram-id-retrieval]]
- [[chatgpt/chatgpt_beeper-imessages-setup]]
- [[chatgpt/chatgpt_beeper-issue-instagram-login]]
- [[chatgpt/chatgpt_01-vs-091-proof]]
- [[chatgpt/chatgpt_1-of-body-weight-part1]]
