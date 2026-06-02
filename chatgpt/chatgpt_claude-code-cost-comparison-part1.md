---
conversation_id: 6a03a567-3bc0-83e8-b780-0cb7b86d4b36
created: 2026-05-12
links:
- '[[chatgpt-clusters/coding_ai_ml]]'
message_count: 36
source: chatgpt-export
tags:
- chatgpt
- import
- code
- long-form
title: Claude Code Cost Comparison
type: essay
updated: 2026-05-13
---

# Claude Code Cost Comparison

**Related:** [[coding_ai]]

> Conversation ID: 6a03a567-3bc0-83e8-b780-0cb7b86d4b36
> Created: 2026-05-12T22:10:47Z
> Updated: 2026-05-13T18:07:23Z
> Messages: 36


could i have claude code use ruflo for swarm and write plans with opus 4.7 but specifically instruct each sub agent to use deepseek v4 pro for actually implmeneitng the code. how would this compare and what cost vs using claude subscription for these tasks. is it good enough to do? it would make our claude code 200/mo susbcription go way farther right?


Mr. White, I’ll verify the current Claude Code, Anthropic, DeepSeek, and “ruflo/swarm” details first, then compare architecture, cost mechanics, and viability.


Mr. White, yes — the architecture is feasible, and it could make your **Claude Code Max $200/mo** subscription go materially farther. The key distinction: **prompting subagents to “use DeepSeek” is insufficient**. You need actual **model routing** so implementation calls go to DeepSeek’s API instead of consuming Claude Max usage.

## Practical answer

Use **Claude/Opus 4.7 as the lead planner/reviewer**, then route **implementation subagents** to **DeepSeek V4 Pro**.

Best workflow:

1. **Claude Opus 4.7** writes the plan, architecture, acceptance criteria, and test strategy.
2. **Ruflo / Claude Code subagents** implement bounded tasks using **DeepSeek V4 Pro**.
3. Claude reviews the diffs, catches integration mistakes, and approves/adjusts.
4. Tests, typecheck, lint, and ideally worktree isolation gate all merges.

Claude Code already supports subagents with model selection, including a `model` field and `CLAUDE_CODE_SUBAGENT_MODEL`; that env var has top priority over per-agent settings. Claude Code also has `opusplan`, which uses Opus in plan mode and Sonnet for execution, but you would need routing/configuration to make execution or subagents use DeepSeek instead. citeturn646922view0turn698994view1

## Cost comparison

Claude Max 20x is **$200/month**, with Claude Code included, but usage is shared across Claude web/app and Claude Code; if you hit limits, extra usage is billed separately at standard API rates. citeturn116569view2turn400569view0turn400569view1

Current API prices:

| Model | Input / 1M tokens | Output / 1M tokens |
|---|---:|---:|
| Claude Opus 4.7 | $5.00 | $25.00 |
| Claude Sonnet 4.6 | $3.00 | $15.00 |
| DeepSeek V4 Pro, current discounted price | $0.435 | $0.87 |
| DeepSeek V4 Pro, post-discount listed price | $1.74 | $3.48 |

Anthropic lists Opus 4.7 at $5/M input and $25/M output; DeepSeek lists V4 Pro at $0.435/M cache-miss input and $0.87/M output during its 75% discount, with the discount currently extended until **May 31, 2026**. citeturn116569view1turn932973view0

Example for an implementation-heavy run: **10M input + 1M output tokens**

| Path | Approx cost |
|---|---:|
| Opus 4.7 API | $75.00 |
| Sonnet 4.6 API | $45.00 |
| DeepSeek V4 Pro discounted | $5.22 |
| DeepSeek V4 Pro after discount | $20.88 |

So, while the discount lasts, DeepSeek V4 Pro is about **11.5x cheaper on input** and **28.7x cheaper on output** than Opus 4.7. Even after the discount, it is still much cheaper than Opus for bulk implementation.

## Would it make the Claude subscription go farther?

Yes, especially if your Claude Code limits are being burned by **parallel subagents, repo scanning, repetitive edits, test fixes, and implementation loops**.

Agent teams and swarms multiply token use because each teammate/subagent has its own context; Anthropic’s docs explicitly warn that agent teams use significantly more tokens and that usage scales with active teammates. citeturn892774view0

So the winning pattern is:

**Claude Max subscription = high-value thinking**  
**DeepSeek API = cheap implementation labor**

That turns your Claude subscription into the scarce “architect/reviewer” layer instead of spending it on every file read, grep, patch, retry, and test-fix loop.

## Implementation options

### Option A: Cleanest and safest

Run planning/review in normal Claude Code using your Max subscription, then run DeepSeek-backed worker sessions separately.

DeepSeek’s official docs show Claude Code can be pointed at its Anthropic-compatible endpoint:

```bash
export ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic
export ANTHROPIC_AUTH_TOKEN=<your DeepSeek API key>
export ANTHROPIC_MODEL=deepseek-v4-pro[1m]
export CLAUDE_CODE_SUBAGENT_MODEL=deepseek-v4-pro[1m]
claude
```

DeepSeek V4 Pro supports 1M context, tool calls, JSON output, and an Anthropic-format base URL, which is why this is technically plausible for Claude Code-style implementation work. citeturn932973view5turn932973view0

### Option B: Integrated Ruflo / swarm setup

Use Ruflo or an LLM gateway/router so the lead and subagents can route to different providers. Ruflo’s repo describes a pipeline with Router → Swarm → Agents → Memory → LLM Providers, and says its hooks can coordinate agents after `npx ruflo init`. citeturn116569view6

The routing target should look conceptually like:

```bash
# Through your own gateway/router
export ANTHROPIC_BASE_URL=https://your-llm-gateway.example
export ANTHROPIC_AUTH_TOKEN=<gateway token>

# Lead model
export ANTHROPIC_MODEL=claude-opus-4-7

# Worker model
export CLAUDE_CODE_SUBAGENT_MODEL=deepseek-v4-pro[1m]
```

Your gateway must route:

```text
claude-opus-4-7      -> Anthropic / Claude
deepseek-v4-pro[1m]  -> DeepSeek
```

Anthropic’s Claude Code docs support LLM gateways for centralized auth, usage tracking, cost controls, audit logging, and model routing, and Claude Code sends agent ID headers that can help attribute subagent costs. citeturn547280view0

## Is DeepSeek V4 Pro good enough?

For many implementation tasks: **yes**.

Use it for:

| Good DeepSeek subagent work | Keep Claude/Opus involved for |
|---|---|
| CRUD features | Architecture decisions |
| Component scaffolding | Ambiguous product logic |
| Test writing | Security-sensitive changes |
| Type fixes | Large cross-cutting refactors |
| Migration scripts | Final PR review |
| Isolated backend/frontend tickets | Debugging subtle behavior |

I would use DeepSeek workers only against **approved plans**. Give each worker a narrow task, expected files, constraints, tests to run, and “do not expand scope” instructions. Then have Claude review the diff.

A good subagent definition would look like:

```yaml
---
name: deepseek-implementer
description: Implements approved, bounded coding tasks from an explicit plan. Use only after the plan is accepted.
tools: Read, Glob, Grep, Bash, Edit, Write
model: deepseek-v4-pro[1m]
permissionMode: acceptEdits
isolation: worktree
---

You implement only the assigned task.
Follow the plan exactly.
Do not change architecture.
Do not modify unrelated files.
Add or update tests.
Run the relevant test command before reporting done.
Return: files changed, tests run, failures, and any uncertainty.
```

Claude Code supports subagent frontmatter fields for model, tools, permission mode, max turns, effort, and worktree isolation, so this maps cleanly onto Claude Code’s subagent system. citeturn646922view0

## Main caveats

The biggest caveat is **data exposure**. DeepSeek’s privacy policy says it may collect prompts/inputs, uploaded files, outputs, and other service data, and it describes use of personal data to improve and train technology, with an opt-out right. It also says collected personal data may be stored and processed in China. For proprietary code, customer data, secrets, or regulated data, use a vendor/privacy posture you are comfortable with, strip secrets, or use a zero-retention/private deployment path. citeturn111941view1

The second caveat is reliability. DeepSeek can be cheap enough to brute-force implementation, but Claude/Opus is still the better orchestrator for judgment, edge cases, and catching subtle mistakes.

## Bottom line

Yes, this is a strong setup.

For Jovie-style startup velocity, I’d use:

```text
Claude Opus 4.7 = planner, architect, reviewer, merge judge
DeepSeek V4 Pro = implementation workers
Ruflo / Claude Code teams = orchestration
Worktrees + tests + Claude review = safety gates
```

It should make the $200/mo Claude Max subscription go much farther **if your current bottleneck is Claude Code usage limits from implementation and swarm fanout**. It adds DeepSeek API spend, but at current prices that spend is likely small relative to the Claude capacity you preserve.


I wanna move towards a model where plans are automatically made by either 4.7 or 5.5 with the FedEx subscription.


Would it be the same cost if I were to run Hermes agent and have it just spin up an Hermes sub-profile? Okay, so I guess the question is the longer 

...should i use hermes agent or open claw as the orchestrator and tell it to spin up sib agents using the claude code oatuh opus model inside hermes ahent to plan and then the deep seek models for implementation

or it istill better to run the hermes agent as the orchestrator have it open issues in linear and have those issues addressed seperately by a claude code worker? 

it would be nice to hand off everythign to hermes agent but i wanna ensure its still as efferctive


Codex* 
But the key thing is that I should be in the loop for planning and review not dev work. So you should run the gstack flows etc and ask questions of me then the plan gets better and better until I say it’s good at which point we fire it off. This could be done via linear issues that need a plan and I sit down and do “planning sessions” where I run through gstack on conductor or via telegram chat with you and we harden the plan. Then upon approval you move it to todo so an agent can pick it up and implement then those agents can be using ruflo and model routing through free models or deepseek or codex or clause based on complexity and cost. If we route more implementation to deepseek flash or pro when it’s available we extend our subscriptions but we don’t wanna lose out on quality. So spec how this could work in an idea work. I’m in the loop on plans and PRs that require taste but I wanna look at one screen and see screenshots to approve if it’s design related. The less I have to touch an IDE the better but shipping velocity and revenue matters most


I’ll verify what Hermes/OpenClaw actually route versus wrap, then compare single-session orchestration against Linear-driven Claude Code workers for cost, reliability, and effectiveness.


I’ll turn this into an operating spec covering intake, planning approval, routed implementation, PR/design review, and cost controls. I’ll ground it in current Codex, Claude, Linear, and routing capabilities.


Mr. White, I would use **Hermes as the orchestrator**, **Linear as the durable task ledger**, and **Claude Code / DeepSeek workers as the execution layer**.

I would **not** make OpenClaw the main coding orchestrator. OpenClaw is more of a personal assistant surface for inbox/calendar/messaging workflows, while Hermes has more direct support for subagent delegation, Kanban-style multi-agent work, Linear skills, provider routing, and Claude Code handoff. OpenClaw’s own docs also frame Anthropic subscription reuse as policy-sensitive and say API keys are the clearer production path. citeturn344686view5turn858914view4turn546636view1turn502919view3

## The cost answer

A Hermes sub-profile is **not automatically cheaper**. Cost depends on the **model provider and auth path**, not whether the worker is called a sub-profile, subagent, profile, or Claude Code worker.

| Setup | Cost behavior |
|---|---|
| Hermes subagent using DeepSeek | DeepSeek API cost |
| Hermes subagent using Anthropic API key | Anthropic API cost |
| Hermes native Anthropic OAuth | Hermes docs say this uses Claude Max **extra/overage credits**, not the base Max allowance |
| Hermes shelling out to `claude -p` / Claude Code CLI | Uses Claude Code auth path; with Pro/Max, activity counts against shared Claude + Claude Code usage |
| OpenClaw using Claude Max proxy/community route | Technically possible, but OpenClaw docs say to verify Anthropic terms and treat API keys as clearer for production |

Hermes’ own docs say Anthropic OAuth in Hermes requires **Claude Max plus purchased extra usage credits** and “only draws from the Max plan’s extra/overage credits, not the base Max allowance.” That means using Hermes’ native Anthropic OAuth path is **not the same cost profile** as simply using your $200 Claude Code Max subscription. citeturn502919view2

Direct Claude Code with your Pro/Max subscription is different: Anthropic says Claude Code and Claude app activity share the same Pro/Max usage limits, and that API credits are billed separately at standard API rates only if you choose that route. Anthropic also warns that setting `ANTHROPIC_API_KEY` makes Claude Code use API billing instead of the subscription. citeturn729609view0

## Best architecture

Use this:

```text
Hermes = front door / orchestrator / scheduler / issue creator
Linear = durable task queue and audit trail
Claude Code Opus/Sonnet = planner, reviewer, merge judge
DeepSeek V4 Pro workers = implementation
Git worktrees = isolation
Tests + Claude review = safety gate
```

For engineering work, I would prefer:

```text
Hermes receives request
→ Hermes decomposes into Linear issues
→ Claude Code planner writes plan + acceptance criteria
→ DeepSeek worker implements in isolated worktree
→ Claude Code reviews diff
→ Worker fixes issues
→ PR opened / merged only after checks
```

This is more reliable than “Hermes, go do everything” because Hermes subagents start with **fresh context** and only know what the parent passes in the `goal` and `context` fields. Linear issues force the plan, constraints, files, tests, and acceptance criteria to be explicit. citeturn546636view1

## When to let Hermes directly spin subagents

Use Hermes native subagents for bounded, low-risk tasks:

```text
“Inspect these 3 files and summarize the bug.”
“Update copy across these components.”
“Run tests and identify the failing module.”
“Research three implementation approaches.”
```

Hermes’ `delegate_task` supports parallel subagents, model overrides, restricted toolsets, and separate contexts. Its docs also say the default is up to 3 concurrent subagents and that subagents can be routed to cheaper/faster models through config. citeturn546636view1

Example Hermes config:

```yaml
delegation:
  max_concurrent_children: 3
  max_iterations: 50
  model: "deepseek-v4-pro[1m]"
  provider: "deepseek"
```

Use Hermes Kanban or Linear for serious work. Hermes Kanban is explicitly built for “decompose → implement in parallel worktrees → review → iterate → PR,” and it is more durable than `delegate_task`; `delegate_task` is synchronous and dies with the parent turn. citeturn502919view0turn546636view1

## Linear vs Hermes Kanban

For your company workflow, I would use **Linear** as the source of truth.

| Queue | Use when |
|---|---|
| Hermes `delegate_task` | Quick synchronous subwork inside one agent turn |
| Hermes Kanban | Local multi-agent pipeline on one host |
| Linear | Real engineering backlog, humans involved, PR traceability, durable team workflow |

Hermes Kanban is local SQLite and single-host; Linear is better for company work because issues are team-visible, assignable, commentable, and integration-friendly. Linear’s docs say issues can be created via GraphQL API, and Linear agents can be assigned or mentioned on issues. citeturn502919view0turn727528search1turn727528search3

## Model routing setup

Do **not** merely tell subagents “use DeepSeek.” They need to actually run through DeepSeek’s endpoint or a gateway that routes model IDs.

DeepSeek’s docs show Claude Code can be pointed to DeepSeek’s Anthropic-compatible endpoint:

```bash
export ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic
export ANTHROPIC_AUTH_TOKEN=<your DeepSeek API key>
export ANTHROPIC_MODEL=deepseek-v4-pro[1m]
export ANTHROPIC_DEFAULT_OPUS_MODEL=deepseek-v4-pro[1m]
export ANTHROPIC_DEFAULT_SONNET_MODEL=deepseek-v4-pro[1m]
export CLAUDE_CODE_SUBAGENT_MODEL=deepseek-v4-flash
export CLAUDE_CODE_EFFORT_LEVEL=max
```

DeepSeek lists Claude Code, OpenCode, and OpenClaw integrations, with DeepSeek V4 Pro supporting 1M context, JSON output, tool calls, and Anthropic-format routing. citeturn344686view2turn713764view0

I would create separate wrappers so you never accidentally burn the wrong account:

```bash
# ~/.local/bin/cc-claude
#!/usr/bin/env bash
unset ANTHROPIC_BASE_URL
unset ANTHROPIC_AUTH_TOKEN
unset ANTHROPIC_API_KEY
exec claude "$@"
```

```bash
# ~/.local/bin/cc-deepseek
#!/usr/bin/env bash
export ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic
export ANTHROPIC_AUTH_TOKEN="$DEEPSEEK_API_KEY"
export ANTHROPIC_MODEL='deepseek-v4-pro[1m]'
export ANTHROPIC_DEFAULT_OPUS_MODEL='deepseek-v4-pro[1m]'
export ANTHROPIC_DEFAULT_SONNET_MODEL='deepseek-v4-pro[1m]'
export CLAUDE_CODE_SUBAGENT_MODEL='deepseek-v4-pro[1m]'
exec claude "$@"
```

Then Hermes can call the correct binary depending on role:

```text
Planner/reviewer: cc-claude -p "Write implementation plan..."
Implementer:      cc-deepseek -p "Implement this Linear issue..."
```

## Cost delta

DeepSeek is drastically cheaper for implementation loops. Current official pricing lists DeepSeek V4 Pro at **$0.435 / 1M cache-miss input tokens** and **$0.87 / 1M output tokens** during the 75% discount, versus Anthropic Opus 4.7 at **$5 / 1M input** and **$25 / 1M output**. DeepSeek says the discount is extended until **May 31, 2026**. citeturn713764view0turn483353view0

Example: **10M input + 1M output**

| Model path | Approx cost |
|---|---:|
| Claude Opus 4.7 API | $75.00 |
| Claude Sonnet 4.6 API | $45.00 |
| DeepSeek V4 Pro discounted | $5.22 |
| DeepSeek V4 Pro post-discount listed price | $20.88 |

Your $200 Claude Max subscription goes farther only if you **reserve Claude usage for planning/review** and send implementation loops to DeepSeek. It does **not** go farther if Hermes itself burns Claude Opus for orchestration, especially through a path that requires extra usage credits.

## Recommended operating rule

Use this split:

```text
Hermes:
- accepts requests
- creates Linear issues
- decomposes tasks
- schedules workers
- tracks progress

Claude Code / Claude:
- architecture
- plan approval
- final review
- subtle debugging
- security-sensitive changes

DeepSeek:
- code implementation
- repetitive edits
- tests
- migrations
- scaffolding
- type/lint fixes
```

For Jovie, the strongest setup is:

```text
Hermes orchestrator
+ Linear issues
+ DeepSeek implementation workers
+ Claude Code planner/reviewer
+ isolated worktrees
+ required tests before PR
```

That gets most of the “hand everything to Hermes” convenience while preserving Claude-quality judgment at the points where mistakes are expensive.


where and in what form should claude code actually run? and how to have it pick up issues?


I’ll map the runtime, worker launch pattern, Linear pickup loop, and usage-safe routing so the setup is concrete rather than conceptual.


Mr. White, run Claude Code as a **headless CLI worker on a self-hosted runner**, with Linear acting as the trigger and task ledger.

The clean form is:

```text
Hermes
→ creates / refines Linear issues
→ Linear delegates issue to your agent
→ webhook hits your runner
→ runner spawns Claude Code as CLI process
→ Claude Code plans / implements / reviews in isolated git worktree
→ runner opens PR and updates Linear
```

## Where Claude Code should run

Use a dedicated **runner machine** you control:

```text
jovie-agent-runner
- Linux VM, Mac mini, or dev server
- repo clones stored locally
- Claude Code installed globally
- GitHub CLI installed
- Linear webhook server
- job queue / SQLite / Redis
- one git worktree per issue
```

For your specific goal, I would avoid making the official GitHub Action the main execution path. Claude’s GitHub Action is convenient, but its docs describe API-token/provider usage and API-token costs; it runs on GitHub-hosted runners and consumes GitHub Actions minutes plus model API tokens. Anthropic’s own docs list `ANTHROPIC_API_KEY` for direct usage and separate API costs for the action. citeturn229634view1turn936389view0

For preserving your **Claude Max subscription**, the better path is a **self-hosted Claude Code CLI process** authenticated through Claude subscription OAuth. Anthropic says Claude Code with Pro/Max uses one unified subscription, and Claude Code activity shares the same usage limits as Claude web/app. citeturn791064view2

## In what form Claude Code should run

Run it as a **non-interactive CLI process** using `claude -p`.

Anthropic documents `claude -p` / `--print` as the programmatic mode for scripts, CI, and automation. It supports structured output, `--max-turns`, `--allowedTools`, `--permission-mode`, `--output-format json`, and related flags. citeturn739509view0turn229634view0

Use three wrappers:

```text
cc-claude-plan      -> Claude subscription / Opus / plan-only
cc-deepseek-impl    -> DeepSeek API / implementation
cc-claude-review    -> Claude subscription / Opus or Sonnet / final review
```

### `cc-claude-plan`

```bash
#!/usr/bin/env bash
set -euo pipefail

unset ANTHROPIC_API_KEY
unset ANTHROPIC_AUTH_TOKEN
unset ANTHROPIC_BASE_URL
unset ANTHROPIC_MODEL

export CLAUDE_CODE_OAUTH_TOKEN="$CLAUDE_CODE_OAUTH_TOKEN"

exec claude -p "$@" \
  --model claude-opus-4-7 \
  --permission-mode plan \
  --output-format json \
  --max-turns 8
```

Generate the token with:

```bash
claude setup-token
```

Anthropic says `claude setup-token` creates a one-year OAuth token for CI/scripts, set via `CLAUDE_CODE_OAUTH_TOKEN`, and requires a Pro, Max, Team, or Enterprise plan. Important caveat: `--bare` does **not** read `CLAUDE_CODE_OAUTH_TOKEN`, so avoid `--bare` for subscription-funded Claude runs. citeturn791064view0

### `cc-deepseek-impl`

```bash
#!/usr/bin/env bash
set -euo pipefail

unset ANTHROPIC_API_KEY
unset CLAUDE_CODE_OAUTH_TOKEN

export ANTHROPIC_BASE_URL="https://api.deepseek.com/anthropic"
export ANTHROPIC_AUTH_TOKEN="$DEEPSEEK_API_KEY"
export ANTHROPIC_MODEL="deepseek-v4-pro[1m]"
export ANTHROPIC_DEFAULT_OPUS_MODEL="deepseek-v4-pro[1m]"
export ANTHROPIC_DEFAULT_SONNET_MODEL="deepseek-v4-pro[1m]"
export ANTHROPIC_DEFAULT_HAIKU_MODEL="deepseek-v4-flash"
export CLAUDE_CODE_SUBAGENT_MODEL="deepseek-v4-flash"
export CLAUDE_CODE_EFFORT_LEVEL="max"

exec claude -p "$@" \
  --permission-mode acceptEdits \
  --output-format stream-json \
  --max-turns 30 \
  --allowedTools "Read,Edit,Write,Glob,Grep,Bash(git *),Bash(pnpm *),Bash(npm *),Bash(yarn *),Bash(bun *),Bash(pytest *),Bash(make *)"
```

DeepSeek’s official Claude Code integration uses the Anthropic-compatible base URL, `ANTHROPIC_AUTH_TOKEN`, `deepseek-v4-pro[1m]`, and `CLAUDE_CODE_SUBAGENT_MODEL` for subagents. citeturn156222view0

### `cc-claude-review`

```bash
#!/usr/bin/env bash
set -euo pipefail

unset ANTHROPIC_API_KEY
unset ANTHROPIC_AUTH_TOKEN
unset ANTHROPIC_BASE_URL
unset ANTHROPIC_MODEL

export CLAUDE_CODE_OAUTH_TOKEN="$CLAUDE_CODE_OAUTH_TOKEN"

exec claude -p "$@" \
  --model claude-opus-4-7 \
  --output-format json \
  --max-turns 10 \
  --allowedTools "Read,Glob,Grep,Bash(git diff *),Bash(git status *),Bash(pnpm test *),Bash(npm test *)"
```

Critical environment rule: `ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_API_KEY` take precedence over `CLAUDE_CODE_OAUTH_TOKEN`. If those leak into the Claude planner/reviewer wrapper, you can accidentally use API billing instead of the subscription. Anthropic explicitly documents that precedence and warns that `ANTHROPIC_API_KEY` can override subscription auth. citeturn791064view0turn791064view2

## How it should pick up Linear issues

Use Linear’s **Agent SDK / Agent Session webhooks**.

Linear agents are app users. They can be assigned/delegated issues, mentioned in comments, create comments, and participate in workflows. Assigning an issue to an agent triggers delegation, while the human assignee remains responsible. citeturn418962view4

The pickup mechanism:

```text
1. Create “Jovie Agent” as a Linear OAuth app.
2. Request app:assignable and app:mentionable scopes.
3. Enable Agent Session events webhooks.
4. Assign a Linear issue to Jovie Agent.
5. Linear sends AgentSessionEvent.created webhook.
6. Your runner enqueues a job.
7. Worker spawns Claude Code in a worktree.
8. Worker posts progress, plan, PR link, and final status back to Linear.
```

Linear’s developer docs say Agent Sessions are created automatically when an agent is mentioned or delegated an issue. The `created` webhook includes `promptContext`, which contains issue details, comments, guidance, labels, project info, and related context. citeturn771934view0turn119198view0

Your webhook handler should respond fast and enqueue the real work. Linear says webhook receivers must respond within 5 seconds, and for `created` events the agent should emit an activity or set an external URL within 10 seconds to avoid being marked unresponsive. citeturn119198view0

## Worker flow per issue

```text
Linear issue delegated
→ receive AgentSessionEvent.created
→ create job record
→ post “Queued / starting plan” activity
→ create git worktree
→ run Claude planner
→ post plan to Linear
→ optionally wait for human approval
→ run DeepSeek implementer
→ run tests
→ run Claude reviewer
→ fix review findings
→ push branch
→ open PR
→ attach PR URL to Linear session
→ post final response
```

Use one git worktree per issue. Claude Code supports `--worktree`, creating isolated worktrees under `.claude/worktrees/<name>/` on separate branches, so parallel workers do not overwrite each other’s edits. citeturn418962view1turn229634view0

Example issue branch:

```bash
claude --worktree LIN-482
```

For automated jobs, your runner can also create the worktree itself:

```bash
git fetch origin
git worktree add ".worktrees/LIN-482" -b "ai/LIN-482" origin/main
cd ".worktrees/LIN-482"
```

Then call the wrappers from inside that directory.

## Minimal webhook runner shape

```ts
// linear-webhook.ts
import express from "express";
import { enqueueLinearJob } from "./queue";

const app = express();
app.use(express.json());

app.post("/linear/webhook", async (req, res) => {
  const event = req.body;

  // Verify Linear webhook signature here.

  if (
    event.type === "AgentSessionEvent" &&
    event.action === "created"
  ) {
    await enqueueLinearJob({
      sessionId: event.agentSession.id,
      issueId: event.agentSession.issue?.id,
      issueIdentifier: event.agentSession.issue?.identifier,
      promptContext: event.agentSession.promptContext,
    });

    // Respond quickly. Worker posts detailed activity later.
    res.status(200).json({ ok: true });
    return;
  }

  if (
    event.type === "AgentSessionEvent" &&
    event.action === "prompted"
  ) {
    await enqueueLinearJob({
      sessionId: event.agentSession.id,
      prompt: event.agentActivity.body,
      resume: true,
    });

    res.status(200).json({ ok: true });
    return;
  }

  res.status(200).json({ ignored: true });
});

app.listen(3456);
```

Then a worker process pulls jobs:

```ts
// worker.ts
import { execa } from "execa";

async function runIssueJob(job) {
  const branch = `ai/${job.issueIdentifier}`;
  const dir = `.worktrees/${job.issueIdentifier}`;

  await execa("git", ["fetch", "origin"], { stdio: "inherit" });
  await execa("git", ["worktree", "add", dir, "-b", branch, "origin/main"], {
    stdio: "inherit",
  });

  const planPrompt = `
You are the planning agent.
Use the Linear issue context below.
Write a concise implementation plan, acceptance criteria, risk areas, and tests.
Do not edit files.

${job.promptContext}
`;

  const plan = await execa("cc-claude-plan", [planPrompt], {
    cwd: dir,
    env: { CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN },
  });

  // Post plan to Linear here. Optionally wait for approval.

  const implPrompt = `
Implement the approved plan below.
Stay within scope.
Do not change unrelated files.
Add or update tests.
Run the relevant test command.
Return changed files, tests run, failures, and uncertainty.

PLAN:
${plan.stdout}
`;

  await execa("cc-deepseek-impl", [implPrompt], {
    cwd: dir,
    env: { DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY },
    stdio: "inherit",
  });

  const reviewPrompt = `
Review this work before PR.
Check correctness, architecture, security, test coverage, and scope creep.
Use git diff against origin/main.
If issues are found, list exact required fixes.

Issue context:
${job.promptContext}
`;

  const review = await execa("cc-claude-review", [reviewPrompt], {
    cwd: dir,
    env: { CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN },
  });

  // If clean: push branch and gh pr create.
}
```

## Linear update behavior

Post these back to Linear:

```text
thought: “Planning implementation”
action: “Created worktree ai/LIN-482”
response: “Plan ready”
elicitation: “Approve plan before implementation?”
action: “Running tests”
response: “PR opened: <url>”
error: “Tests failed: <summary>”
```

Linear supports semantic Agent Activities such as `thought`, `action`, `response`, `elicitation`, and `error`. It also supports session plans as a checklist, plus `externalUrls` for linking to dashboards or PRs. citeturn119198view0

## Practical recommendation

Use this structure:

```text
Hermes:
- intake
- product clarification
- Linear issue creation
- issue decomposition
- status summarization

Linear:
- source of truth
- issue queue
- approval trail
- agent activity log

Claude Code runner:
- actual code execution
- one process per job
- one worktree per job

Claude Opus:
- plan
- review
- hard debugging

DeepSeek:
- implementation
- tests
- repetitive fixes
```

This gives you the “hand everything to Hermes” feel while keeping the code execution reliable, inspectable, and replayable. The important implementation detail is that Claude Code should be launched by a **runner process**, not treated as a vague sub-profile instruction. The runner controls auth, model routing, worktrees, Linear updates, test gates, and PR creation.


**Topic:** [[chatgpt-clusters/coding_ai]]


## See Also
- [[chatgpt/chatgpt_claude-code-cost-comparison-part2]]
- [[chatgpt/chatgpt_claude-code-cost-comparison-part3]]
- [[chatgpt/chatgpt_claude-code-cost-comparison-part4]]
- [[chatgpt/chatgpt_claude-code-cost-comparison-part5]]
- [[chatgpt/chatgpt_apple-shortcuts-claude-code]]
