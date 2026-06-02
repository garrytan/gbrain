
Mr. White, this is the right direction: **you stay in the loop for product taste, planning, and PR approval; agents do the dev work.** The system should optimize for fewer IDE touches, tighter plans, cheaper implementation, and visible review artifacts.

## Proposed operating model

Call it a **Plan → Dispatch → Review factory**.

```text
Idea / Linear issue
  ↓
Planning session with you
  ↓
Hardened plan artifact
  ↓
Your approval
  ↓
Move to Todo / Dispatch
  ↓
Agent implementation
  ↓
Automated QA + screenshots + PR
  ↓
Your review only when taste/revenue/risk matters
  ↓
Merge / deploy / learnings captured
```

The core rule: **agents may implement only from an approved plan.** They can ask clarifying questions during planning. Once approved, they execute inside guardrails.

## Why this fits the current tool landscape

Codex is already structured for cloud coding tasks, parallel work, GitHub integration, PR creation, and CLI-driven task dispatch. OpenAI’s docs say Codex Cloud can work on tasks in the background and in parallel, connect to GitHub, edit/run code, show diffs, and open PRs. Codex CLI also supports cloud task execution and `codex cloud exec`, which makes it scriptable from a planner/dispatcher. citeturn529553view5turn529553view2

Claude Code and Conductor are a strong local orchestration layer. Conductor supports Claude Code and Codex agents in isolated workspaces, separate branches, app processes, and review paths, with diff review and PR/merge handling. citeturn730447view6turn730447view7turn730447view9

GStack is basically the workflow scaffold you are describing: `/office-hours`, `/plan-ceo-review`, `/plan-design-review`, `/plan-eng-review`, `/qa`, `/review`, `/ship`, and `/autoplan`. Its own docs describe the lifecycle as `office-hours → plan → implement → review → QA → ship → retro`, with `/autoplan` running CEO → Design → Eng review and escalating taste decisions to a final approval gate. citeturn681911view0turn681911view1

## Linear workflow

Create these Linear statuses:

```text
Inbox
Needs Plan
Planning Session
Plan Review
Approved Plan
Todo
In Progress
Agent QA
Needs Founder Review
Ready to Merge
Shipped
```

Linear supports team-specific issue workflows and custom statuses, and its GraphQL API/webhooks can query, mutate, and respond to issue/comment/status changes. citeturn127132view1turn127132view0turn127132view3

### Status behavior

| Status | Who acts | What happens |
|---|---|---|
| **Inbox** | Anyone | Raw idea, bug, user request, founder thought. |
| **Needs Plan** | Planner agent | Agent drafts first plan and asks the first high-leverage questions. |
| **Planning Session** | You + planner | You harden scope, taste, user value, revenue value, risk. |
| **Plan Review** | Claude/GPT planner | Runs CEO/design/eng review. Finds missing decisions. |
| **Approved Plan** | You | You say “approved” or mark the issue approved. |
| **Todo** | Dispatcher | Issue becomes eligible for implementation. |
| **In Progress** | Worker agent | Agent implements in isolated branch/workspace. |
| **Agent QA** | QA/reviewer agents | Tests, screenshots, browser flows, review. |
| **Needs Founder Review** | You | Only appears for taste, revenue, UX, risky architecture, or unclear tradeoffs. |
| **Ready to Merge** | Release agent | CI green, screenshots attached, PR summary ready. |
| **Shipped** | Release agent | Merged/deployed, production verified, learnings saved. |

## The planning artifact

Every approved issue should end with a structured plan, not a chat transcript.

```md
# Plan

**Related:** [[coding_ai]]

**Related:** [[coding_ai_ml]]

## Outcome
What user/business result this creates.

## Non-goals
What the agent must not build.

## User flow
Step-by-step user-visible behavior.

## Screens / design expectations
Required states: empty, loading, success, error, mobile, desktop.

## Technical approach
Files likely touched, architecture, data flow, dependencies.

## Edge cases
Failure modes, retries, permissions, rate limits, abuse cases.

## Test plan
Unit tests, integration tests, browser checks, visual screenshots.

## Acceptance criteria
Concrete pass/fail checklist.

## Approval
Founder-approved: yes/no
Approved by: Tim
Approved at:
Implementation model tier:
Review required: founder/design/security/none
```

GStack’s `/plan-eng-review` is especially useful here because it forces architecture, boundaries, data flow, failure modes, edge cases, trust boundaries, and test coverage. It also writes a test-plan artifact that `/qa` can pick up later. citeturn681911view2

## Planning sessions

You should have two modes.

### 1. Batch Linear planning sessions

You sit down with a queue of `Needs Plan` issues. I or another planner agent runs each issue through:

```text
/office-hours
/plan-ceo-review
/plan-design-review if UI/taste-facing
/plan-eng-review
```

Then you approve, cut scope, or send it back.

This is best for weekly or daily founder planning.

### 2. Telegram planning chat

You send rough ideas from Telegram:

```text
“Users should be able to compare two outreach campaigns.”
```

The planner creates or updates a Linear issue, asks clarifying questions, and hardens the plan over chat. Once you say:

```text
approve
```

the issue moves to `Approved Plan`, then `Todo`.

The important part: Telegram should be a **planning and approval surface**, not an implementation surface. It should ask you questions, show plan diffs, and show PR screenshots. It should not dump code unless requested.

## Model routing

Use expensive models for decisions. Use cheap models for execution.

| Task type | Planner | Implementer | Reviewer |
|---|---|---|---|
| Raw idea → plan | GPT-5.5 or Opus 4.7 | None | You |
| Product/taste-heavy plan | Opus 4.7 + GPT-5.5 second opinion | None | You |
| Bounded CRUD/backend task | GPT-5.5/Opus plan | DeepSeek V4 Flash or Pro | Claude/Codex review |
| Normal frontend implementation | GPT-5.5/Opus plan | DeepSeek V4 Pro | Screenshot review + Claude/GPT |
| Design-sensitive UI | Opus/GPT-5.5 + design review | DeepSeek Pro or Codex | You with screenshot board |
| Auth/billing/payments/data migration | Opus/GPT-5.5 | Codex or Claude, not cheap-only | Human + senior model |
| Unclear bug/root cause | Opus/GPT-5.5 investigation | Model chosen after root cause | Independent review |
| Refactor with wide blast radius | Opus/GPT-5.5 | Claude/Codex | Multi-agent review |
| Tests, lint fixes, docs | Cheap/free/DeepSeek Flash | Cheap/free/DeepSeek Flash | Automated checks |

DeepSeek is currently viable for this routing because its docs list DeepSeek V4 Flash and Pro, Anthropic-compatible and OpenAI-compatible API formats, 1M context, JSON output, tool calls, and Claude Code integration via environment variables. citeturn795117view2turn795117view1turn795117view0

Current DeepSeek pricing makes it a strong implementation layer: V4 Flash is listed at $0.14/M cache-miss input and $0.28/M output; V4 Pro is currently listed at $0.435/M cache-miss input and $0.87/M output during a 75% discount through May 31, 2026. citeturn795117view1

Opus 4.7 is a good high-end planning/review model. Anthropic lists Opus 4.7 at $5/M input and $25/M output, and Claude Code docs recommend `xhigh` effort for best coding/agentic results on Opus 4.7. citeturn659135search1turn730447view3

## Subscription strategy

Use the subscriptions as **scarce judgment capacity**, not as unlimited implementation labor.

### Codex subscription

Codex Pro currently starts at $100/month, with higher usage tiers, and OpenAI’s Codex pricing page lists GPT-5.5, GPT-5.4, GPT-5.3-Codex, and GPT-5.4-mini as available within Codex usage. The docs also say usage varies based on codebase size, task complexity, and execution location. citeturn529553view0turn529553view1

Codex usage has moved toward token-based credit accounting across most plans. The rate card lists GPT-5.5 at 125 credits/M input, 12.5 credits/M cached input, and 750 credits/M output; GPT-5.3-Codex is listed at 43.75 credits/M input, 4.375 cached, and 350 output. citeturn958487view0

Practical implication: use Codex for high-value cloud tasks, PRs, code review, and when its GitHub/cloud environment is useful. Use DeepSeek for repetitive implementation when quality risk is manageable.

### Claude subscription

Claude Code agent teams and parallel work can burn tokens quickly. Anthropic says agent teams use significantly more tokens because each teammate has its own context window, and their cost docs say teams can use roughly 7x more tokens than standard sessions when teammates run in plan mode. citeturn730447view1turn730447view2

Practical implication: keep Claude/Opus for planning, architecture, review, debugging, and design judgment. Avoid spending Claude capacity on low-value file edits, boilerplate, and test churn when DeepSeek or Codex can handle it.

## PR review surface: one screen

For design-related work, the PR should automatically include:

```text
1. Linear issue link
2. Approved plan link
3. Acceptance criteria checklist
4. Vercel/preview URL
5. Screenshot grid
   - desktop before/after
   - mobile before/after
   - empty state
   - loading state
   - error state
   - key conversion flow
6. QA report
7. CI/test status
8. Agent notes
9. “Founder decision needed” section
```

Vercel automatically creates preview deployments for PRs on connected Git repositories, and GitHub Actions/Playwright can run browser tests and upload reports/artifacts. citeturn885384search1turn885384search15turn127132view4turn885384search7

GStack’s `/design-review` and `/qa` are directly aligned with this. `/design-review` audits the live site, fixes visual issues, and takes before/after screenshots; `/qa` reads the diff, identifies affected routes, tests browser flows, and saves a report with screenshots. citeturn681911view3turn681911view4

Your review screen should look like:

```text
JOV-123: Improve campaign comparison UX

Plan: approved
Preview: open
CI: green
QA: passed
Design score: 8.5/10
Revenue impact: high
Risk: medium

Screenshots:
[Desktop before] [Desktop after]
[Mobile before]  [Mobile after]
[Empty state]    [Error state]

Founder decision:
A) Use compact comparison table
B) Use card-based comparison
Recommendation: A

Approve / Request changes / Reject
```

## Dispatcher logic

The dispatcher reads `Approved Plan` issues and chooses model/tooling.

Example routing policy:

```yaml
routing:
  default:
    implementer: deepseek-v4-pro
    reviewer: codex-review
    max_cost_usd: 3

  trivial:
    labels: [typo, docs, test-fix, lint]
    implementer: deepseek-v4-flash
    reviewer: automated-checks
    max_cost_usd: 0.50

  frontend_design:
    labels: [frontend, design, ux]
    implementer: deepseek-v4-pro
    reviewer: opus-4.7-design-review
    founder_review: required
    require_screenshots: true

  high_risk:
    labels: [auth, billing, payments, security, migration, data-loss]
    implementer: codex-or-claude
    reviewer: opus-4.7-and-codex
    founder_review: required
    cheap_models_allowed: false

  unclear_bug:
    labels: [bug, unclear-root-cause]
    planner: opus-4.7
    implementer: selected_after_investigation
    require_root_cause: true

  revenue_critical:
    labels: [pricing, onboarding, activation, checkout, conversion]
    planner: gpt-5.5-or-opus-4.7
    implementer: codex-or-deepseek-pro
    founder_review: required
```

## Agent permissions

Implementation agents should not be trusted equally.

```text
Cheap implementation agents:
- May edit only approved files / directories
- May not change architecture
- May not touch auth, billing, migrations, secrets
- Must run tests
- Must produce a changed-files summary
- Must stop on ambiguity

Senior agents:
- May propose architecture changes
- May investigate cross-cutting bugs
- May request plan amendments
- May open PRs after checks pass

Founder:
- Approves plans
- Approves taste decisions
- Approves high-risk PRs
- Approves scope expansion
```

Claude Code subagents support tool restrictions, MCP scoping, permission modes, plan mode, and auto-accepted edits, so you can make cheap agents narrower and safer. citeturn730447view0

## Quality gates

An issue cannot move to `Ready to Merge` unless:

```text
- Linear issue has approved plan
- Branch links to Linear issue
- PR body includes acceptance criteria
- Tests pass
- Lint/typecheck pass
- QA report exists for user-facing work
- Screenshot board exists for design work
- Reviewer agent produces PASS or specific blocking findings
- Founder approval exists for taste/revenue/high-risk work
```

For frontend work, add:

```text
- Preview URL exists
- Playwright smoke flow passes
- Screenshots are attached
- Mobile breakpoint checked
- Empty/loading/error states checked
```

Playwright’s CI docs show GitHub Actions workflows for installing dependencies, running tests, and uploading the Playwright HTML report as an artifact. They also recommend stable CI settings such as sequential workers for reproducibility. citeturn127132view4turn127132view5

## Cost-control loop

Track per issue:

```text
planning_model
implementation_model
review_model
tokens/credits used
wall-clock time
human minutes required
number of agent retries
number of review comments
CI failures
bugs after merge
revenue/user impact
```

Then tune routing monthly.

The optimization target is:

```text
maximum shipping velocity per founder-review minute
```

Not lowest model cost.

A cheap model that creates review churn is expensive. A premium model that saves one founder hour or prevents a bad UX ship is cheap.

## Concrete first version

Build the MVP of this workflow in this order:

### Week 1: Linear plan factory

Create the Linear statuses, labels, and plan template.

Labels:

```text
needs-plan
needs-founder
approved-plan
frontend
design
revenue
high-risk
cheap-ok
deepseek-ok
codex-ok
claude-required
screenshot-required
```

Start with manual dispatch from Linear/Conductor.

### Week 2: Planning sessions

Use GStack for planning:

```text
/office-hours
/autoplan
/plan-eng-review
```

For design work:

```text
/design-consultation
/plan-design-review
```

Output gets pasted into the Linear issue as the canonical plan.

### Week 3: Agent dispatch

When you approve, issue moves to `Todo`.

Dispatcher chooses:

```text
DeepSeek Flash → trivial
DeepSeek Pro → normal bounded implementation
Codex Cloud → cloud PR tasks / repo-heavy implementation
Claude Opus/Sonnet → ambiguous, high-risk, architecture-heavy
```

### Week 4: One-screen review

For every PR, require:

```text
Plan summary
Acceptance criteria
Preview link
Screenshot grid
QA result
Review verdict
Founder decision needed
```

Telegram should send only the compact review card.

## What this buys you

This should make the Claude/Codex subscriptions go much farther because you stop spending premium usage on low-leverage implementation loops. DeepSeek handles bulk execution. Claude/GPT-5.5 handle taste, architecture, and review. Codex handles cloud agent tasks, GitHub/PR flow, and strong code review.

The model is sound:

```text
You = product taste, approval, revenue judgment
Opus/GPT-5.5 = planning and hard calls
GStack = planning/review process
Linear = source of truth
Conductor = local parallel workspaces
Codex Cloud = cloud PR-capable implementation/review
DeepSeek = cheap implementation labor
Playwright/Vercel/screenshots = visual review layer
```

The key operating discipline: **nothing gets built until the plan is approved, and nothing design-related gets merged until you can approve it from screenshots and a preview URL.**


this sounds great. one thing though is hermes agent support oauthed claude max plans natively. would it be easier to just have it run an hermes sub agent using that to do planning and then use hermes coder with deepseek for implementaton and hermes can just set it all up as crons?


I’ll verify Hermes’ OAuth, cron, and coder behavior, then compare the Hermes-native setup against runner/Linear on cost, reliability, and control.


Mr. White, yes — **it would be easier operationally** to keep everything inside Hermes, but I would use **Hermes Kanban/profiles**, not raw subagents or cron alone, for serious coding work.

The best “all-Hermes” version is:

```text
Hermes orchestrator profile
  → Claude Max OAuth / Opus or Sonnet for planning

Hermes implementer profile
  → DeepSeek V4 Pro for coding

Hermes reviewer profile
  → Claude Max OAuth / Opus or Sonnet for review

Hermes Kanban
  → durable task queue, worktrees, handoffs, retries

Cron
  → scheduled polling / recurring triggers / nightly review jobs
```

## Important cost caveat

Hermes’ native Anthropic OAuth is convenient, but its docs say it uses **Claude Max extra usage credits**, not the base Max allowance included with Claude Code. Hermes says that when you authenticate via `hermes model → Anthropic OAuth`, it routes as Claude Code against your Anthropic account, requires Claude Max plus purchased extra usage credits, and does **not** consume the base Max plan allowance. citeturn819371view0

So:

| Path | Operational ease | Cost behavior |
|---|---:|---|
| Hermes native Anthropic OAuth | Easiest | Uses Claude Max extra/overage credits |
| Hermes → Claude Code CLI | More setup | Better if you want to use base Claude Code Max allowance |
| Hermes DeepSeek profile | Easy | DeepSeek API cost |
| Hermes subagents inheriting parent model | Easy | Can accidentally burn Claude on implementation |
| Hermes Kanban with role-specific profiles | Best balance | Explicit routing per role |

If your goal is **maximum simplicity**, use Hermes native Claude OAuth for planning/review and DeepSeek for implementation.

If your goal is **stretch the $200 Claude Code Max base subscription as far as possible**, keep Claude planning/review as actual **Claude Code CLI calls** launched by Hermes, because Hermes native Anthropic OAuth appears to draw from extra credits rather than the base Claude Code allowance.

## I would use Hermes Kanban over cron for implementation

Cron is good for scheduling. It can create one-shot or recurring jobs, attach skills, run fresh sessions, deliver results, and even run no-agent scripts with zero LLM use. Hermes can also create cron jobs from natural language. citeturn203334view0

But cron jobs run in **fresh agent sessions** with no memory of your current chat, so the prompt has to be fully self-contained. citeturn203334view2

For coding, Hermes Kanban is a better primitive. Hermes describes Kanban as a durable task board shared across profiles, where each task is stored in SQLite, each handoff is durable, and each worker is a full OS process with its own identity. It specifically lists engineering pipelines as a supported pattern: “decompose → implement in parallel worktrees → review → iterate → PR.” citeturn203017view0

Use cron to **feed the queue**, not to be the queue.

Example:

```text
Cron every 10 min:
  Check Linear for issues assigned to @jovie-agent
  Create/update Hermes Kanban tasks

Kanban dispatcher:
  Spawns planner / implementer / reviewer profiles
  Runs work in isolated worktrees
  Records comments, status, retries, evidence
```

## Why not just Hermes subagents?

Hermes `delegate_task` is useful for short subtasks, but it is synchronous and not durable. If the parent turn is interrupted, the children are cancelled and in-progress work is discarded. Hermes docs recommend `cronjob` or `terminal(background=True, notify_on_complete=True)` for durable long-running work. citeturn143095view1

That makes raw subagents a weaker fit for coding tickets, because implementation often takes minutes, fails tests, needs retries, and should leave a durable audit trail.

Use subagents for:

```text
- “Inspect these files and summarize the likely bug”
- “Compare two implementation approaches”
- “Review this diff for risky changes”
- “Generate a test plan”
```

Use Kanban/profiles for:

```text
- “Implement this Linear issue”
- “Fix failing CI”
- “Refactor these modules”
- “Open a PR”
- “Run reviewer after implementer finishes”
```

## Recommended Hermes setup

Create three Hermes profiles:

```bash
hermes profile create jovie-orchestrator
hermes profile create jovie-implementer
hermes profile create jovie-reviewer
```

### `jovie-orchestrator`

Use Claude via Hermes OAuth or Claude Code CLI handoff.

```yaml
model:
  provider: anthropic
  default: claude-opus-4-7

toolsets:
  enabled:
    - kanban
    - linear
    - github
    - terminal

skills:
  - kanban-orchestrator
```

This profile should decompose work and create tasks. It should avoid editing code directly.

### `jovie-implementer`

Use DeepSeek.

```yaml
model:
  provider: deepseek
  default: deepseek-v4-pro

toolsets:
  enabled:
    - terminal
    - filesystem
    - git
    - github
    - kanban

skills:
  - kanban-worker
```

DeepSeek’s own Hermes integration docs say to choose DeepSeek as the provider, set the base URL to `https://api.deepseek.com`, and select `deepseek-v4-pro`. citeturn203334view6

### `jovie-reviewer`

Use Claude.

```yaml
model:
  provider: anthropic
  default: claude-opus-4-7

toolsets:
  enabled:
    - terminal
    - git
    - github
    - kanban

skills:
  - kanban-worker
  - github-code-review
  - security-pr-audit
```

## How the work should flow

```text
1. Hermes cron polls Linear every 5–10 minutes.
2. New Linear issue assigned to agent → Hermes creates Kanban task.
3. Orchestrator profile expands it into:
   - implementation task
   - test task
   - review task
4. Implementer profile runs DeepSeek in a git worktree.
5. Reviewer profile runs Claude on the diff.
6. Implementer fixes review findings.
7. Hermes opens PR or comments ready-for-review.
8. Linear is updated with PR link, test results, and remaining risks.
```

Hermes Kanban workers can use worktree workspaces for coding tasks, and the dispatcher runs inside the gateway by default, picking up ready tasks every 60 seconds. citeturn203017view0

## The profile-based setup is better than “one Hermes subagent with model overrides”

Hermes supports subagent provider/model overrides via `delegation.provider` and `delegation.model`; subagents otherwise inherit the parent’s provider/model. citeturn143095view0

That is useful, but it is too blunt for your case. You want different roles:

```text
Planner: Claude
Implementer: DeepSeek
Reviewer: Claude
```

A global delegation override like this:

```yaml
delegation:
  provider: deepseek
  model: deepseek-v4-pro
```

makes subagents cheap, but now the subagents are all DeepSeek unless you add more routing complexity.

Profiles are cleaner:

```text
jovie-orchestrator = Claude
jovie-implementer  = DeepSeek
jovie-reviewer     = Claude
```

Then Hermes Kanban assigns tasks to the correct profile.

## Use cron this way

Good cron jobs:

```text
Every 10 minutes:
  Check Linear for issues assigned to Jovie Agent.
  For each new issue, create or update a Hermes Kanban task.
  Use idempotency keys to avoid duplicates.

Every night at 2am:
  Review open AI-created PRs.
  Check failed CI.
  Summarize blocked tasks.

Every weekday at 9am:
  Summarize yesterday’s completed AI work and today’s blocked tasks.
```

Less ideal cron job:

```text
Every 10 minutes:
  Directly implement all Linear issues.
```

That will work sometimes, but it is brittle because each cron run is a fresh session and long coding tasks need state, retries, handoffs, and review.

## My recommendation

Use the all-Hermes setup, but make it:

```text
Hermes Gateway
+ Hermes Kanban
+ Hermes profiles
+ Linear polling/webhook cron
+ DeepSeek implementer profile
+ Claude planner/reviewer profile
```

Use native Hermes Claude OAuth if simplicity matters more than squeezing every drop out of the base Max subscription.

Use Hermes → Claude Code CLI for planner/reviewer if preserving the base **Claude Code Max $200/mo** allowance is the priority.

The cleanest version:

```text
Hermes orchestrator:
  owns queue, schedules work, updates Linear

Claude:
  plans and reviews

DeepSeek:
  implements

Kanban:
  durable handoffs

Cron:
  recurring triggers only
```

That gives you the “hand everything to Hermes” workflow without letting a fragile synchronous subagent chain become the production engineering system.


ok well extra usage is pointless ebcause you might as well use deep seek at that point. so remove all options related to that. what about codex? can it use codex 200/mo subscription without being on extra usage? and what is kanban is this hermes native? does it have a gui? why did no one meniton this before we started building shit like that?


I’ll remove Claude extra-usage paths and focus on Hermes Kanban, DeepSeek implementation, and whether Codex subscription access can fund coding work without API overage.


Mr. White, remove the Anthropic extra-usage route completely. It is economically pointless for your use case.

The cleaner stack becomes:

```text
Hermes Orchestrator / Kanban
→ Codex via ChatGPT Pro $200 OAuth for high-quality planning/review
→ DeepSeek via API for cheap implementation
→ Linear/GitHub for external visibility
```

## Codex $200/mo question

Yes. **Codex can use your ChatGPT Pro $200 subscription allowance**, provided it is authenticated through **ChatGPT sign-in / Codex OAuth**, not an OpenAI API key.

OpenAI’s Codex auth docs say Codex has two OpenAI auth paths:

```text
Sign in with ChatGPT = subscription access
API key = usage-based access
```

Codex cloud requires ChatGPT sign-in, while CLI and IDE support both. API-key usage is billed through the OpenAI Platform at standard API rates. citeturn688717view1

OpenAI’s Codex pricing page says Codex is included in ChatGPT plans, including Pro, and Pro has 5x or 20x higher rate limits than Plus. The $200 Pro tier is the 20x tier. citeturn566455view0

So the rule is simple:

```text
Use Codex OAuth / ChatGPT login:
  Uses included Codex allowance from ChatGPT Pro.

Use OPENAI_API_KEY:
  Uses API billing.

Use credits / auto top-up:
  Pays extra after included limits.

Disable credits / auto top-up:
  Stops when limits are hit.
```

OpenAI says your plan’s included usage is consumed first, and after you hit plan limits, Codex draws from your credit balance if you have one. citeturn124291view0

## Hermes + Codex specifically

Hermes appears to support **OpenAI Codex as a native provider** via device-code OAuth. Hermes stores Codex credentials under `~/.hermes/auth.json` and can import existing Codex CLI credentials from `~/.codex/auth.json`; no Codex CLI installation is required for Hermes’ own Codex provider path. citeturn923507view0

Hermes’ quickstart lists:

```text
OpenAI Codex
→ ChatGPT OAuth
→ uses Codex models
→ setup via hermes model
```

citeturn923507view2

That means you can likely run:

```text
Hermes planner profile:
  provider = openai-codex
  auth = ChatGPT / Codex OAuth
  cost = ChatGPT Pro included Codex allowance
```

Then:

```text
Hermes implementer profile:
  provider = deepseek
  auth = DeepSeek API key
  cost = DeepSeek API
```

That is much better than Claude extra credits.

## What Kanban is

Hermes Kanban is **native Hermes infrastructure**. It is not Trello. It is a built-in durable multi-agent task board.

Hermes describes it as:

```text
A durable task board shared across Hermes profiles.
Every task is a row in ~/.hermes/kanban.db.
Every handoff is durable.
Every worker is a full OS process with its own identity.
```

citeturn698526view0

It is basically Hermes’ internal work queue for multi-agent execution.

Instead of this fragile pattern:

```text
Parent agent
→ subagent
→ subagent
→ subagent
→ if parent dies, work disappears
```

Kanban gives you:

```text
Task row
→ assigned to profile
→ dispatcher spawns worker
→ worker comments / completes / blocks
→ reviewer can unblock / retry
→ history stays in SQLite
```

Hermes explicitly says Kanban is for workflows like:

```text
decompose → implement in parallel worktrees → review → iterate → PR
```

citeturn698526view0

## Does it have a GUI?

Yes. Hermes has a **Kanban dashboard plugin**.

The built-in plugins page lists:

```text
kanban/dashboard
→ dashboard tab
→ Kanban board UI for the multi-agent dispatcher
→ tasks, comments, fan-out, board switching
```

citeturn698526view3

It is opt-in. Hermes bundled plugins are not auto-enabled; you enable them explicitly. citeturn698526view3

Likely setup:

```bash
hermes plugins enable kanban/dashboard
hermes gateway start
```

Then you use the Hermes dashboard/gateway UI to watch tasks move through lanes.

Hermes’ Kanban tutorial references dashboard screenshots and says the board can show running/done/ready tasks grouped by profile lanes. citeturn698526view2

## Why this should have come up earlier

Fair pushback. Kanban should have been introduced earlier once the discussion moved from “one Claude Code worker picking up Linear issues” to “Hermes orchestrates multiple coding agents.”

The earlier architecture was more general:

```text
Linear issue
→ external runner
→ Claude Code worker
→ PR
```

That makes sense when Claude Code is the main execution engine.

For an all-Hermes setup, Hermes Kanban is the native queue. It replaces a lot of the custom runner/queue machinery.

## Important limitation

Hermes Kanban’s default worker lane is a **Hermes profile**. The dispatcher spawns:

```bash
hermes -p <profile> chat -q <prompt>
```

inside the task workspace. citeturn698526view1

Hermes docs say wiring external CLI tools like Codex CLI, Claude Code CLI, OpenCode CLI, or local coding runners as Kanban worker lanes is **not yet a paved path**. It is possible through a plugin, but the wrapper has to map exit codes, workspaces, auth, and Kanban completion/block calls. citeturn698526view1

So the cleanest version is:

```text
Use Hermes profiles as Kanban workers.
Do not make Codex CLI or Claude Code CLI the primary worker lane unless you build glue.
```

## Revised best architecture

Use this:

```text
Hermes Kanban
  owns the durable queue

Hermes orchestrator profile
  provider: openai-codex
  auth: ChatGPT Pro OAuth
  job: decompose, plan, route tasks

Hermes reviewer profile
  provider: openai-codex
  auth: ChatGPT Pro OAuth
  job: review diffs, approve/block

Hermes implementer profile
  provider: deepseek
  auth: DeepSeek API
  job: code implementation, tests, lint fixes

Linear
  external task source / company-visible issue tracker

GitHub
  PRs, CI, review artifacts
```

In plain terms:

```text
Codex Pro subscription = planning/review/orchestration quality
DeepSeek = cheap coding labor
Hermes Kanban = native durable multi-agent queue
Linear = team-facing record
GitHub = code and CI
```

## Concrete setup shape

### 1. Configure Codex OAuth in Hermes

```bash
hermes model
# choose OpenAI Codex / ChatGPT OAuth
```

or, based on Hermes docs:

```bash
hermes auth add openai-codex
```

Hermes can also import existing Codex CLI credentials from `~/.codex/auth.json` if present. citeturn923507view0

### 2. Configure DeepSeek in Hermes

```bash
hermes model
# choose DeepSeek Direct
# add DEEPSEEK_API_KEY
```

Hermes’ quickstart lists DeepSeek Direct as a first-class provider using `DEEPSEEK_API_KEY`. citeturn923507view2

### 3. Create profiles

```bash
hermes profile create jovie-orchestrator
hermes profile create jovie-implementer
hermes profile create jovie-reviewer
```

Conceptual configs:

```yaml
# jovie-orchestrator
model:
  provider: openai-codex
  default: gpt-5.5

toolsets:
  enabled:
    - kanban
    - linear
    - github

role:
  purpose: decompose Linear/GitHub work into scoped Kanban tasks
```

```yaml
# jovie-implementer
model:
  provider: deepseek
  default: deepseek-v4-pro

toolsets:
  enabled:
    - terminal
    - file
    - git
    - github
    - kanban

role:
  purpose: implement scoped tasks, run tests, block for review
```

```yaml
# jovie-reviewer
model:
  provider: openai-codex
  default: gpt-5.5

toolsets:
  enabled:
    - terminal
    - git
    - github
    - kanban

role:
  purpose: review diffs and approve/block implementation tasks
```

### 4. Enable Kanban dashboard

```bash
hermes plugins enable kanban/dashboard
hermes gateway start
```

### 5. Use Kanban as the actual work queue

Create a task:

```bash
hermes kanban create "Implement Linear issue JOV-482" \
  --assignee jovie-orchestrator \
  --workspace worktree \
  --tenant jovie \
  --priority high
```

The orchestrator should create child tasks like:

```text
Spec: JOV-482
  assignee: jovie-orchestrator

Implement: JOV-482
  assignee: jovie-implementer
  depends on: Spec

Review: JOV-482
  assignee: jovie-reviewer
  depends on: Implement
```

Hermes workers use `kanban_show`, `kanban_complete`, `kanban_block`, `kanban_comment`, and related tools when spawned by the dispatcher. citeturn698526view5

## Where Codex fits versus DeepSeek

I would use Codex for:

```text
- planning
- architecture
- issue decomposition
- final review
- “is this good enough?” judgment
- debugging subtle failures
```

I would use DeepSeek for:

```text
- implementation
- repetitive edits
- tests
- lint/type fixes
- migrations
- scaffolding
- straightforward feature work
```

That keeps the $200 Codex subscription focused on high-leverage reasoning, while DeepSeek handles the token-heavy loops.

## Final recommendation

Yes, use Hermes Kanban.

Revised answer:

```text
Do not use Claude extra usage.
Do not build a custom queue unless Hermes Kanban lacks something critical.
Do not make raw subagents the main coding system.

Use:
Hermes Kanban + Hermes profiles + Codex OAuth + DeepSeek API.
```

The only custom work you likely need is:

```text
Linear → Hermes Kanban task creation
GitHub PR creation / update conventions
Profile prompts
CI/test gating
```

That is much less infrastructure than building your own runner from scratch.


give me a prompt to have hermes implement this all


Mr. White, here is a paste-ready master prompt for Hermes to implement the full setup with explicit routing, cost guardrails, Kanban durability, and Linear/GitHub integration.


**Topic:** [[chatgpt-clusters/coding_ai]]


## See Also
- [[chatgpt/chatgpt_claude-code-cost-comparison-part1]]
- [[chatgpt/chatgpt_claude-code-cost-comparison-part3]]
- [[chatgpt/chatgpt_claude-code-cost-comparison-part4]]
- [[chatgpt/chatgpt_claude-code-cost-comparison-part5]]
- [[chatgpt/chatgpt_apple-shortcuts-claude-code]]
