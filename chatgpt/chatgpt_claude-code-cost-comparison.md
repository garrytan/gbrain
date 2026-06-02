---
title: "Claude Code Cost Comparison"
type: essay
created: 2026-05-12
updated: 2026-05-13
source: chatgpt-export
conversation_id: 6a03a567-3bc0-83e8-b780-0cb7b86d4b36
message_count: 36
tags: [chatgpt, import, code, long-form]
---
# Claude Code Cost Comparison

> Conversation ID: 6a03a567-3bc0-83e8-b780-0cb7b86d4b36
> Created: 2026-05-12T22:10:47Z
> Updated: 2026-05-13T18:07:23Z
> Messages: 36

---

## User

could i have claude code use ruflo for swarm and write plans with opus 4.7 but specifically instruct each sub agent to use deepseek v4 pro for actually implmeneitng the code. how would this compare and what cost vs using claude subscription for these tasks. is it good enough to do? it would make our claude code 200/mo susbcription go way farther right?

---

## Assistant

Mr. White, I’ll verify the current Claude Code, Anthropic, DeepSeek, and “ruflo/swarm” details first, then compare architecture, cost mechanics, and viability.

---

## Assistant

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

---

## User

I wanna move towards a model where plans are automatically made by either 4.7 or 5.5 with the FedEx subscription.

---

## User

Would it be the same cost if I were to run Hermes agent and have it just spin up an Hermes sub-profile? Okay, so I guess the question is the longer 


...should i use hermes agent or open claw as the orchestrator and tell it to spin up sib agents using the claude code oatuh opus model inside hermes ahent to plan and then the deep seek models for implementation

or it istill better to run the hermes agent as the orchestrator have it open issues in linear and have those issues addressed seperately by a claude code worker? 

it would be nice to hand off everythign to hermes agent but i wanna ensure its still as efferctive

---

## User

Codex* 
But the key thing is that I should be in the loop for planning and review not dev work. So you should run the gstack flows etc and ask questions of me then the plan gets better and better until I say it’s good at which point we fire it off. This could be done via linear issues that need a plan and I sit down and do “planning sessions” where I run through gstack on conductor or via telegram chat with you and we harden the plan. Then upon approval you move it to todo so an agent can pick it up and implement then those agents can be using ruflo and model routing through free models or deepseek or codex or clause based on complexity and cost. If we route more implementation to deepseek flash or pro when it’s available we extend our subscriptions but we don’t wanna lose out on quality. So spec how this could work in an idea work. I’m in the loop on plans and PRs that require taste but I wanna look at one screen and see screenshots to approve if it’s design related. The less I have to touch an IDE the better but shipping velocity and revenue matters most

---

## Assistant

I’ll verify what Hermes/OpenClaw actually route versus wrap, then compare single-session orchestration against Linear-driven Claude Code workers for cost, reliability, and effectiveness.

---

## Assistant

I’ll turn this into an operating spec covering intake, planning approval, routed implementation, PR/design review, and cost controls. I’ll ground it in current Codex, Claude, Linear, and routing capabilities.

---

## Assistant

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

---

## User

where and in what form should claude code actually run? and how to have it pick up issues?

---

## Assistant

I’ll map the runtime, worker launch pattern, Linear pickup loop, and usage-safe routing so the setup is concrete rather than conceptual.

---

## Assistant

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

---

## Assistant

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

---

## User

this sounds great. one thing though is hermes agent support oauthed claude max plans natively. would it be easier to just have it run an hermes sub agent using that to do planning and then use hermes coder with deepseek for implementaton and hermes can just set it all up as crons?

---

## Assistant

I’ll verify Hermes’ OAuth, cron, and coder behavior, then compare the Hermes-native setup against runner/Linear on cost, reliability, and control.

---

## Assistant

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

---

## User

ok well extra usage is pointless ebcause you might as well use deep seek at that point. so remove all options related to that. what about codex? can it use codex 200/mo subscription without being on extra usage? and what is kanban is this hermes native? does it have a gui? why did no one meniton this before we started building shit like that?

---

## Assistant

I’ll remove Claude extra-usage paths and focus on Hermes Kanban, DeepSeek implementation, and whether Codex subscription access can fund coding work without API overage.

---

## Assistant

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

---

## User

give me a prompt to have hermes implement this all

---

## Assistant

Mr. White, here is a paste-ready master prompt for Hermes to implement the full setup with explicit routing, cost guardrails, Kanban durability, and Linear/GitHub integration.

---

## Assistant

Use this as the master prompt:

```text
You are Hermes running as the Jovie AI engineering orchestrator.

Mission:
Set up a durable multi-agent coding system using Hermes Kanban as the native task queue, Codex OAuth for planning/review, DeepSeek for implementation, Linear for issue intake/status, and GitHub for PRs/CI.

Important cost constraints:
1. Do not use Anthropic, Claude Max extra usage, Claude API, or Claude Code for this system.
2. Do not configure ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, ANTHROPIC_BASE_URL, or any Claude provider.
3. Use Codex only through ChatGPT/Codex OAuth subscription auth, not OPENAI_API_KEY or OpenAI API billing.
4. Use DeepSeek API only for implementation-heavy coding work.
5. Do not enable paid auto-top-up, extra credits, or usage-based OpenAI API billing.
6. Before making any provider change, verify the auth path and summarize whether it uses subscription allowance or API billing.

High-level architecture to implement:

Hermes Kanban:
- Durable task queue
- Shared board across profiles
- SQLite-backed task state
- Native Hermes dashboard if available
- Worktree-based coding tasks where possible

Profiles:
1. jovie-orchestrator
   - Provider: Codex via ChatGPT/Codex OAuth
   - Purpose: intake, issue decomposition, planning, routing, Linear/GitHub coordination
   - Should not directly implement code except tiny config/glue work

2. jovie-implementer
   - Provider: DeepSeek
   - Model: best available DeepSeek coding model, preferably deepseek-v4-pro or equivalent
   - Purpose: implementation, tests, lint/type fixes, migrations, scaffolding
   - Should work from explicit specs/plans only

3. jovie-reviewer
   - Provider: Codex via ChatGPT/Codex OAuth
   - Purpose: review diffs, verify test coverage, catch architecture/security/scope issues, approve/block PRs

Queue flow:
Linear issue assigned/labeled for AI
→ Hermes intake detects it
→ jovie-orchestrator creates/updates a Kanban task
→ orchestrator writes plan + acceptance criteria
→ implementer codes in isolated workspace/worktree
→ implementer runs tests/lint/typecheck
→ reviewer reviews diff
→ implementer fixes reviewer findings
→ PR opened/updated in GitHub
→ Linear issue updated with status, PR link, test results, and remaining risks

Do not use raw synchronous subagents as the main durable execution system.
Use raw subagents only for short helper tasks like file inspection, approach comparison, or quick review.
Use Hermes Kanban/profiles for real coding tickets.

First steps:
1. Inspect the installed Hermes version and available commands.
2. Run help/list commands as needed. Do not hallucinate CLI flags.
3. Inspect whether these are available:
   - Hermes Kanban
   - Kanban dashboard plugin
   - Hermes profiles
   - Hermes cron/scheduler
   - Linear integration or skill
   - GitHub integration or skill
   - Codex OAuth provider
   - DeepSeek provider
4. If an expected feature is missing, choose the lightest workaround and document it.

Provider setup:
1. Configure Codex provider using ChatGPT/Codex OAuth only.
2. Verify it does not use OPENAI_API_KEY or usage-based API billing.
3. Configure DeepSeek provider using DEEPSEEK_API_KEY.
4. Confirm the implementer profile routes to DeepSeek.
5. Confirm orchestrator and reviewer route to Codex OAuth.
6. Add explicit guardrails so implementation tasks never accidentally use Codex unless manually overridden.
7. Add explicit guardrails so planning/review tasks never accidentally use DeepSeek for final judgment unless manually overridden.

Create or update these Hermes profiles:

Profile: jovie-orchestrator
Role:
- Owns Linear intake
- Converts Linear issues into Kanban tasks
- Writes concise implementation plans
- Creates acceptance criteria
- Assigns tasks to implementer/reviewer
- Tracks status
- Updates Linear and GitHub
- Avoids direct code implementation

Profile: jovie-implementer
Role:
- Implements only scoped Kanban tasks
- Reads the plan before coding
- Works in isolated worktree/workspace
- Does not change unrelated files
- Adds/updates tests
- Runs relevant tests before completion
- Reports changed files, tests run, failures, uncertainty
- Blocks the task instead of guessing when requirements are unclear

Profile: jovie-reviewer
Role:
- Reviews diffs against main
- Checks correctness, architecture, security, test coverage, performance, and scope creep
- Blocks with exact actionable fixes when issues exist
- Approves only when implementation satisfies the plan and tests pass
- Updates Kanban/Linear with review summary

Kanban setup:
1. Enable Hermes Kanban.
2. Enable the Kanban dashboard plugin if available.
3. Start or configure the Hermes gateway/dashboard if required.
4. Create a board/tenant/project named “jovie”.
5. Create lanes/statuses for:
   - Intake
   - Planning
   - Ready for Implementation
   - Implementing
   - Ready for Review
   - Fixes Required
   - Ready for PR
   - Done
   - Blocked
6. Configure worker lanes so:
   - Planning tasks go to jovie-orchestrator
   - Implementation tasks go to jovie-implementer
   - Review tasks go to jovie-reviewer
7. Use isolated git worktrees/workspaces for coding tasks where possible.
8. Ensure every task records:
   - Linear issue ID
   - Git branch
   - Workspace path
   - Assigned profile
   - Current model/provider
   - Test commands run
   - PR URL
   - Final status

Linear integration:
Implement the simplest reliable Linear intake method available.

Preferred:
- Use Linear webhooks/agent integration if Hermes supports it cleanly.

Fallback:
- Use Hermes cron to poll Linear every 5–10 minutes.

Behavior:
1. Find Linear issues assigned to the AI agent or labeled with an agreed AI label, for example:
   - ai
   - ai-ready
   - hermes
   - jovie-agent
2. For each new Linear issue, create exactly one root Kanban task.
3. Use idempotency keys so repeated polling does not duplicate tasks.
4. Store the mapping:
   - Linear issue ID
   - Linear issue identifier
   - Kanban task ID
   - Git branch
   - PR URL
5. Update Linear comments/status when:
   - Planning starts
   - Plan is ready
   - Implementation starts
   - Tests pass/fail
   - Review blocks/approves
   - PR is opened
   - Work is done or blocked

GitHub integration:
1. Detect the repo and default branch.
2. For each implementation task:
   - Fetch latest main
   - Create branch like ai/<linear-issue-key>-<slug>
   - Use isolated worktree/workspace
   - Commit changes with clear message
   - Push branch
   - Open PR
3. PR title format:
   [<LINEAR_KEY>] <issue title>
4. PR body must include:
   - Linear issue link
   - Plan summary
   - Files changed
   - Tests run
   - Reviewer findings
   - Remaining risks
5. Do not merge automatically unless explicitly configured later.
6. Leave PR ready for human review unless the issue is explicitly marked safe-for-auto-merge and all checks pass.

Cron/scheduler:
Set up these scheduled jobs if Hermes cron is available:

1. Linear intake poller
   - Every 10 minutes
   - Finds AI-ready Linear issues
   - Creates/updates Kanban tasks
   - Idempotent

2. Stale task checker
   - Every 30 minutes
   - Finds stuck/blocked/running tasks
   - Comments status
   - Retries only when safe

3. Nightly PR/CI review
   - Every night around 2am local time
   - Checks AI-created PRs
   - Summarizes failed CI
   - Creates follow-up Kanban tasks if needed

4. Morning summary
   - Weekdays around 9am local time
   - Summarizes:
     - Completed AI work
     - Open PRs
     - Blocked tasks
     - Failed tests
     - Required human decisions

Implementation guardrails:
1. No destructive shell commands without explicit safety checks.
2. No deleting branches, dropping databases, resetting main, force-pushing, or modifying production secrets.
3. Never commit secrets.
4. Scan diffs for secrets before PR.
5. Do not modify unrelated files.
6. Do not expand scope beyond the Linear issue and approved plan.
7. Block the task when product ambiguity affects implementation.
8. Prefer small PRs.
9. Every coding task must run relevant tests or explain exactly why tests were not run.
10. Reviewer must verify the diff, not merely read the implementer summary.

Repository conventions:
1. Detect package manager automatically.
2. Detect test/lint/typecheck commands from package.json, Makefile, pyproject, or repo docs.
3. Save detected commands in a local AI runner config file.
4. Use those commands consistently.
5. If commands are missing, create a suggested config and ask for approval before enforcing it.

Files/docs to create:
Create documentation in the repo or Hermes config area, whichever is more appropriate:

1. docs/ai-engineering-system.md
   Include:
   - Architecture
   - Provider routing
   - Cost guardrails
   - Profile roles
   - Kanban flow
   - Linear labels/assignment rules
   - GitHub PR workflow
   - Cron jobs
   - Troubleshooting

2. docs/ai-agent-runbook.md
   Include:
   - How to start Hermes gateway/dashboard
   - How to inspect Kanban board
   - How to manually enqueue a Linear issue
   - How to stop/pause workers
   - How to rotate DeepSeek key
   - How to verify Codex OAuth
   - How to audit model/provider usage
   - How to disable automation

3. A local config file if needed, for example:
   .jovie/ai-agent-config.yaml
   Include:
   - Provider names
   - Profile names
   - Linear label filters
   - Branch naming
   - Test commands
   - Dashboard URL
   - Poll intervals

Validation:
After setup, run a dry-run test.

Dry-run test:
1. Create or identify a harmless test Linear issue or local mock issue.
2. Create a Kanban task from it.
3. Have orchestrator write a plan.
4. Have implementer make either:
   - no code changes, or
   - a tiny harmless docs-only change
5. Have reviewer review it.
6. Confirm all status updates work.
7. Confirm provider routing:
   - Orchestrator = Codex OAuth
   - Implementer = DeepSeek
   - Reviewer = Codex OAuth
8. Confirm no Anthropic/Claude provider is configured or used.
9. Confirm no OpenAI API key billing path is used.
10. Report exact commands used and exact files changed.

Deliverables:
At the end, provide:
1. What you configured
2. Exact profiles created
3. Exact provider routing
4. Exact cron jobs created
5. Dashboard URL or how to open it
6. Linear intake rule
7. GitHub PR workflow
8. Dry-run result
9. Any missing Hermes features or workarounds
10. Any remaining manual steps

Work style:
- Be autonomous.
- Inspect before assuming.
- Prefer native Hermes features over custom infrastructure.
- Prefer simple durable systems over fragile clever ones.
- Keep implementation small and reversible.
- Document everything.
- Do not ask me for clarification unless blocked by a missing credential or destructive decision.
- When blocked, state the exact missing credential, permission, command, or decision needed.
```

For the first run, add this short prefix above it:

```text
Start in audit/setup mode. Do not enable recurring cron jobs or make code changes until you have verified provider routing and shown me the planned configuration. After the plan is approved, implement it.
```

After the setup looks right, run it again without that prefix to let Hermes implement.

---

## User

should each agent handle landing the pr they created or should one agent land all open prs? which is going to use less tokens

---

## Assistant

Mr. White, a **single dedicated merge/review agent** will usually use fewer tokens overall and produce more consistent outcomes.

Best architecture:

```text
Implementer agents:
- code
- test
- open/update PR
- stop

Single reviewer/merge agent:
- reviews all open PRs
- decides approve/block
- requests fixes
- merges when clean
```

## Why this uses fewer tokens

If every implementer also lands its own PR:

```text
Implementer:
- reads issue
- plans
- codes
- tests
- rereads diff
- reviews itself
- inspects CI
- merges
```

That duplicates expensive reasoning context per worker.

With a centralized reviewer:

```text
Implementer:
- issue context only
- local diff only
- task-scoped tests only

Reviewer:
- loads PR diff only
- standardized merge checklist
- standardized CI inspection
```

The expensive “should this merge?” reasoning becomes amortized across all PRs.

## Biggest token saver

The real token win is:

```text
Workers never load the full repo.
Reviewer never loads the full issue history.
```

Each role gets minimal context.

## Recommended split

### Implementer agent (DeepSeek)

Cheap.

Responsibilities:

```text
- implement scoped task
- run targeted tests
- open/update PR
- summarize changes
- stop
```

Never let it:

```text
- decide merge readiness globally
- inspect unrelated PRs
- resolve merge queue conflicts
- do architectural judgment
```

DeepSeek is cheap enough that extra implementation retries are fine.

## Reviewer/Merge agent (Codex)

Expensive/high-quality.

Responsibilities:

```text
- review diffs
- inspect CI
- check architecture/security/scope
- request fixes
- merge approved PRs
```

This agent can run periodically:

```text
every 15 min:
  inspect all open AI PRs
```

That is vastly cheaper than having every implementer repeatedly poll CI and self-review.

## Even cheaper architecture

Cheapest serious setup:

```text
DeepSeek implementers
→ GitHub PR

GitHub Actions
→ run lint/test/typecheck

Codex reviewer
→ ONLY wakes up if CI passes
```

Now Codex never wastes tokens reviewing obviously broken PRs.

Flow:

```text
1. DeepSeek implements
2. Push PR
3. CI runs
4. If CI fails:
      DeepSeek fixes
5. If CI passes:
      Codex reviewer wakes up
6. Codex approves/block
7. Merge agent merges
```

That is probably your optimal cost/performance architecture.

## One merge agent vs one reviewer + one merger

Use:

```text
reviewer == merger
```

No reason to split unless scale becomes enormous.

Separate merge-only agents are useful when:

```text
- multiple repos
- merge queues
- branch protection complexity
- batching
- release trains
```

You are not there yet.

## Kanban structure

Recommended lanes:

```text
Intake
Planning
Implementing
CI Failed
Ready for Review
Fixes Required
Ready to Merge
Merged
Blocked
```

The reviewer/merge agent owns:

```text
Ready for Review
Ready to Merge
Merged
Fixes Required
```

Implementers own:

```text
Implementing
CI Failed
```

## Token optimization rules

### HUGE savings

Do these:

```text
1. Reviewer only reads diff, not full files.
2. Implementers only get scoped issue context.
3. Use GitHub Actions for tests, not LLM reasoning.
4. Use shallow PR summaries.
5. Use worktrees to isolate context.
6. Reuse concise system prompts.
7. Disable repo-wide semantic search unless needed.
```

### Avoid

Avoid these:

```text
- “analyze the whole repo”
- “understand the entire architecture”
- loading massive markdown docs repeatedly
- multi-agent debate loops
- recursive self-review
```

That burns tokens insanely fast.

## Best practical setup for Jovie

```text
Hermes Orchestrator (Codex)
- decomposes work
- routes tasks

DeepSeek Implementers
- code
- fix CI
- open PRs

GitHub Actions
- tests
- lint
- typecheck

Codex Reviewer/Merger
- reviews passing PRs only
- merges approved PRs
```

That gives you:

```text
High quality judgment
+
Cheap implementation
+
Minimal duplicated reasoning
+
Durable queue
+
Low token burn
```

That is likely the best ROI architecture for where Jovie is right now.

---

## User

give me the implementation prompt

---

## Assistant

```text
You are Hermes operating as Jovie’s autonomous AI engineering system.

Mission:
Implement a durable multi-agent coding pipeline optimized for:
- minimum token cost
- maximum throughput
- high merge quality
- low duplicated reasoning
- strong isolation between tasks
- durable execution using Hermes Kanban

Core architecture (MANDATORY)

DO NOT use:
- Anthropic
- Claude API
- Claude Max extra usage
- Claude Code
- OpenAI API billing
- OPENAI_API_KEY billing paths
- any paid auto-topup or extra credit system

USE ONLY:
1. Hermes Kanban as the durable task queue
2. Codex OAuth via ChatGPT Pro subscription for:
   - orchestration
   - planning
   - review
   - merge decisions
3. DeepSeek API for:
   - implementation
   - CI fixes
   - repetitive coding
   - tests
   - scaffolding
4. GitHub Actions for:
   - lint
   - typecheck
   - tests
5. Linear as external issue source
6. GitHub PRs as execution artifacts

Critical architecture constraints

Implementers NEVER:
- merge PRs
- globally review architecture
- inspect unrelated PRs
- repeatedly poll CI
- load the full repo unnecessarily

Reviewer/Merge agent ONLY:
- reviews PRs with passing CI
- loads minimal diff context
- merges approved PRs
- blocks unsafe PRs
- requests exact fixes

Use GitHub Actions as the first validation layer so expensive reviewer tokens are only spent on passing PRs.

High-level flow

Linear Issue
→ Hermes intake
→ Kanban task
→ Orchestrator writes plan
→ DeepSeek implementer codes
→ GitHub Actions run
→ if CI fails:
     implementer fixes
→ if CI passes:
     reviewer/merge agent wakes up
→ reviewer approves or blocks
→ merge agent merges approved PR
→ Linear updated

Durable execution rules

Do NOT use synchronous subagents as the primary execution mechanism.

Use:
- Hermes Kanban
- Hermes profiles
- worktrees/workspaces
- durable task records
- scheduled polling/review

Subagents may ONLY be used for:
- quick inspection
- summarization
- short research tasks

Profiles to create

1. jovie-orchestrator
Provider:
- Codex OAuth via ChatGPT Pro subscription

Purpose:
- Linear intake
- issue decomposition
- planning
- acceptance criteria
- routing tasks
- Kanban management
- PR coordination
- status updates

Must NOT:
- implement large code changes
- merge PRs directly

2. jovie-implementer
Provider:
- DeepSeek

Purpose:
- implementation
- CI fixes
- tests
- lint/typecheck fixes
- migrations
- scaffolding

Rules:
- use scoped issue context only
- do not read unrelated files
- do not modify unrelated files
- always run relevant tests
- stop when blocked
- report uncertainty explicitly

3. jovie-reviewer
Provider:
- Codex OAuth via ChatGPT Pro subscription

Purpose:
- review diffs
- inspect passing CI
- verify architecture/security/scope
- approve/block PRs
- merge approved PRs

Rules:
- only wake up for passing CI
- load minimal diff context
- avoid loading full repo
- request exact actionable fixes
- merge only when safe

Provider setup requirements

Verify all provider routing before implementation.

Codex:
- MUST use ChatGPT/Codex OAuth
- MUST NOT use OPENAI_API_KEY
- MUST NOT use API billing
- MUST use subscription allowance only

DeepSeek:
- MUST use DEEPSEEK_API_KEY
- MUST route implementer tasks to DeepSeek only

Verify:
- orchestrator → Codex OAuth
- reviewer → Codex OAuth
- implementer → DeepSeek

Add explicit safeguards preventing:
- DeepSeek from handling final merge/review decisions
- Codex from being used for implementation-heavy coding unless manually overridden

Kanban requirements

Enable Hermes Kanban.

Enable Kanban dashboard plugin if available.

Create a board/tenant/project:
- jovie

Statuses/lanes:
1. Intake
2. Planning
3. Ready for Implementation
4. Implementing
5. CI Failed
6. Ready for Review
7. Fixes Required
8. Ready to Merge
9. Merged
10. Blocked

Worker ownership:
- orchestrator owns Intake + Planning
- implementers own Implementing + CI Failed
- reviewer owns Ready for Review + Ready to Merge + Merged + Fixes Required

Task metadata requirements:
Every task must store:
- Linear issue ID
- Linear identifier
- branch name
- workspace/worktree path
- assigned profile
- provider/model
- test commands run
- PR URL
- CI status
- final status

Workspace/worktree rules

Use isolated git worktrees/workspaces for implementation tasks whenever possible.

Branch naming:
ai/<linear-key>-<slug>

Never:
- work directly on main
- force push main
- delete branches automatically
- run destructive git commands without confirmation

GitHub Actions integration

Detect existing CI.

If missing, create lightweight CI for:
- install
- lint
- typecheck
- tests

Keep CI fast and minimal.

Reviewer MUST NOT wake up unless CI passes.

If CI fails:
- route task back to implementer automatically

Reviewer should inspect:
- diff
- CI results
- changed files
- PR description

Reviewer should NOT:
- reread entire repo
- reload massive docs unnecessarily

Linear integration

Implement the simplest reliable intake method.

Preferred:
- Linear webhooks/agent integration

Fallback:
- Hermes cron polling every 10 minutes

AI issue intake rules:
Process issues:
- assigned to AI agent
OR
- labeled:
    ai
    ai-ready
    hermes
    jovie-agent

Use idempotency protection so issues do not duplicate.

Store mapping:
- Linear issue ID
- Kanban task ID
- Git branch
- PR URL

Update Linear automatically when:
- planning starts
- plan completed
- implementation starts
- CI fails/passes
- review blocks/approves
- PR opens
- PR merges
- task blocked

GitHub PR workflow

Implementers:
- create/update PRs
- stop after CI passes

Reviewer:
- reviews passing PRs
- merges approved PRs

PR title:
[<LINEAR_KEY>] <issue title>

PR body template:
- issue link
- implementation summary
- files changed
- tests run
- CI status
- reviewer findings
- remaining risks

Do not auto-merge unless:
- explicitly configured safe
- CI passes
- reviewer approves

Cron/scheduler jobs

Implement:

1. Linear intake poller
Every 10 min:
- discover AI-ready issues
- enqueue/update Kanban tasks
- idempotent

2. CI recovery watcher
Every 15 min:
- inspect failed AI PRs
- route back to implementer if fixable

3. Reviewer queue watcher
Every 15 min:
- discover PRs with passing CI
- enqueue reviewer tasks

4. Nightly maintenance
Nightly:
- summarize blocked tasks
- summarize stale PRs
- summarize failed CI
- summarize open reviewer queue

5. Morning summary
Weekdays:
- completed work
- blocked work
- open PRs
- merge status
- required human decisions

Cost optimization rules

MANDATORY:
1. Implementers get minimal scoped context only.
2. Reviewer loads diffs only.
3. Avoid repo-wide scans unless required.
4. Prefer GitHub Actions over LLM reasoning for validation.
5. Avoid recursive review loops.
6. Avoid multi-agent debates.
7. Avoid rereading large markdown docs repeatedly.
8. Prefer concise prompts and summaries.
9. Prefer small PRs.
10. Avoid loading the entire repo into context.

Implementation quality rules

1. No secrets in commits.
2. Scan diffs for secrets.
3. No unrelated file modifications.
4. No scope creep.
5. Block instead of guessing.
6. Tests required unless impossible.
7. Reviewer verifies actual diff.
8. Document assumptions explicitly.
9. Prefer reversible changes.
10. Prefer native Hermes features over custom infrastructure.

Docs to create

1. docs/ai-engineering-system.md
Include:
- architecture
- provider routing
- Kanban flow
- merge flow
- Linear integration
- GitHub workflow
- CI workflow
- cost optimization strategy
- profile responsibilities

2. docs/ai-agent-runbook.md
Include:
- starting Hermes
- dashboard usage
- Kanban usage
- Linear intake
- provider verification
- disabling automation
- troubleshooting
- inspecting stuck tasks
- rotating DeepSeek keys
- verifying Codex OAuth

3. Local config file
Example:
.jovie/ai-agent-config.yaml

Include:
- providers
- profiles
- branch naming
- poll intervals
- CI commands
- labels
- dashboard URL
- workflow settings

Validation requirements

After implementation:
Run a dry-run test using a harmless issue.

Dry-run must verify:
1. Linear intake works
2. Kanban task created
3. Orchestrator writes plan
4. Implementer creates tiny harmless change
5. GitHub Actions run
6. Reviewer wakes up only after CI passes
7. Reviewer reviews diff
8. Reviewer merges or blocks correctly
9. Linear updates work
10. Correct provider routing verified

Explicitly confirm:
- No Anthropic configured
- No Claude configured
- No API billing path used for Codex
- Implementer uses DeepSeek only
- Reviewer uses Codex only

Final deliverables

At completion provide:
1. Exact providers configured
2. Exact profiles created
3. Exact Kanban setup
4. Exact cron jobs
5. Dashboard URL/how to open
6. Linear intake rules
7. GitHub workflow
8. CI workflow
9. Dry-run results
10. Remaining manual steps
11. Missing Hermes features/workarounds
12. Estimated operational token/cost savings from centralized review architecture

Execution mode

Operate autonomously.
Inspect before assuming.
Prefer native Hermes functionality.
Keep systems simple and durable.
Document all changes.
Do not ask for clarification unless blocked by:
- missing credentials
- missing permissions
- destructive decision
- unavailable Hermes feature

If blocked:
state the exact command, credential, permission, or decision needed.
```

---

## User

make sure it use ruflo where possible and worktrees with our setup script from the repo and also make sure its using gbrain properly at the satart and end of tasks etc

---

## Assistant

```text id="0szshg"
You are Hermes operating as Jovie’s autonomous AI engineering system.

Mission:
Implement a durable multi-agent coding pipeline optimized for:
- minimum token cost
- maximum throughput
- high merge quality
- low duplicated reasoning
- strong task isolation
- durable execution using Hermes Kanban
- maximum reuse of existing Jovie tooling/infrastructure

Core architecture (MANDATORY)

DO NOT use:
- Anthropic
- Claude API
- Claude Max extra usage
- Claude Code
- OpenAI API billing
- OPENAI_API_KEY billing paths
- any paid auto-topup or extra credit system

USE ONLY:
1. Hermes Kanban as the durable task queue
2. Codex OAuth via ChatGPT Pro subscription for:
   - orchestration
   - planning
   - review
   - merge decisions
3. DeepSeek API for:
   - implementation
   - CI fixes
   - repetitive coding
   - tests
   - scaffolding
4. GitHub Actions for:
   - lint
   - typecheck
   - tests
5. Linear as external issue source
6. GitHub PRs as execution artifacts
7. Ruflo wherever it provides leverage or existing functionality
8. Existing Jovie setup/bootstrap scripts
9. GBrain for memory/context continuity and task lifecycle memory

Critical architecture constraints

Implementers NEVER:
- merge PRs
- globally review architecture
- inspect unrelated PRs
- repeatedly poll CI
- load the full repo unnecessarily

Reviewer/Merge agent ONLY:
- reviews PRs with passing CI
- loads minimal diff context
- merges approved PRs
- blocks unsafe PRs
- requests exact fixes

Use GitHub Actions as the first validation layer so expensive reviewer tokens are only spent on passing PRs.

High-level flow

Linear Issue
→ Hermes intake
→ Kanban task
→ Orchestrator writes plan
→ DeepSeek implementer codes
→ GitHub Actions run
→ if CI fails:
     implementer fixes
→ if CI passes:
     reviewer/merge agent wakes up
→ reviewer approves or blocks
→ merge agent merges approved PR
→ Linear updated

Durable execution rules

Do NOT use synchronous subagents as the primary execution mechanism.

Use:
- Hermes Kanban
- Hermes profiles
- git worktrees
- durable task records
- scheduled polling/review
- Ruflo orchestration/hooks where beneficial

Subagents may ONLY be used for:
- quick inspection
- summarization
- short research tasks

RUFLO INTEGRATION REQUIREMENTS

Inspect the repo and current environment for:
- Ruflo installation
- existing Ruflo configs
- hooks
- orchestration flows
- slash commands
- routing
- existing automations

Reuse Ruflo wherever possible instead of rebuilding equivalent orchestration manually.

Preferred Ruflo responsibilities:
- orchestration glue
- routing
- hooks
- workflow coordination
- automation helpers
- task/event pipelines
- model/provider abstraction
- memory integration if already wired

Do NOT duplicate existing Ruflo functionality if already available.

If Ruflo already supports:
- swarms
- queues
- hooks
- workflows
- orchestration
- task dispatch
then integrate Hermes Kanban with Ruflo instead of replacing Ruflo entirely.

Document exactly:
- what Ruflo handles
- what Hermes handles
- what overlap exists
- what was intentionally NOT duplicated

WORKTREE REQUIREMENTS

MANDATORY:
Every implementation task must run in an isolated git worktree/workspace.

Do NOT:
- code directly on main
- reuse dirty workspaces
- allow multiple implementers in same workspace

Inspect the repo for:
- existing worktree setup scripts
- repo bootstrap scripts
- environment setup scripts
- dev shell setup
- package manager setup
- existing automation

Reuse the existing Jovie setup/bootstrap script wherever possible.

The implementation workflow should be:

1. Fetch latest main
2. Create isolated worktree:
   ai/<linear-key>-<slug>
3. Run the existing repo setup/bootstrap script automatically
4. Validate dependencies/environment
5. Run implementation
6. Run tests
7. Commit
8. Push
9. Open/update PR

Workspace metadata must include:
- branch
- worktree path
- setup status
- dependency install status
- test status
- assigned task
- provider/model used

GBRAIN REQUIREMENTS

Inspect current GBrain integration/setup.

Reuse existing GBrain integration if available.

MANDATORY TASK LIFECYCLE MEMORY FLOW

At task START:
1. Pull relevant context from GBrain:
   - issue history
   - related PRs
   - architecture notes
   - previous agent learnings
   - coding conventions
   - known pitfalls
   - related repo memory

2. Save:
   - task start event
   - assigned profile
   - provider/model
   - worktree path
   - branch
   - implementation plan

At task END:
1. Push structured memory back into GBrain:
   - outcome
   - files changed
   - bugs discovered
   - architectural learnings
   - reviewer findings
   - CI failures
   - fixes applied
   - unresolved risks
   - implementation notes
   - useful commands
   - repo discoveries

2. Store:
   - PR URL
   - merge/block result
   - test outcomes
   - final status

3. Ensure future agents can retrieve:
   - prior implementation pitfalls
   - recurring CI failures
   - architecture decisions
   - repo conventions

IMPORTANT:
Do NOT spam GBrain with low-value noise.

Prefer:
- concise structured memory
- durable learnings
- implementation patterns
- debugging insights
- architectural decisions

Avoid:
- giant raw logs
- repetitive summaries
- low-signal chatter

Profiles to create

1. jovie-orchestrator
Provider:
- Codex OAuth via ChatGPT Pro subscription

Purpose:
- Linear intake
- issue decomposition
- planning
- acceptance criteria
- routing tasks
- Kanban management
- PR coordination
- status updates
- GBrain orchestration memory
- Ruflo workflow coordination

Must NOT:
- implement large code changes
- merge PRs directly

2. jovie-implementer
Provider:
- DeepSeek

Purpose:
- implementation
- CI fixes
- tests
- lint/typecheck fixes
- migrations
- scaffolding

Rules:
- use scoped issue context only
- do not read unrelated files
- do not modify unrelated files
- always run relevant tests
- stop when blocked
- report uncertainty explicitly
- always operate in isolated worktree
- pull/push task memory from GBrain

3. jovie-reviewer
Provider:
- Codex OAuth via ChatGPT Pro subscription

Purpose:
- review diffs
- inspect passing CI
- verify architecture/security/scope
- approve/block PRs
- merge approved PRs
- write reviewer learnings to GBrain

Rules:
- only wake up for passing CI
- load minimal diff context
- avoid loading full repo
- request exact actionable fixes
- merge only when safe

Provider setup requirements

Verify all provider routing before implementation.

Codex:
- MUST use ChatGPT/Codex OAuth
- MUST NOT use OPENAI_API_KEY
- MUST NOT use API billing
- MUST use subscription allowance only

DeepSeek:
- MUST use DEEPSEEK_API_KEY
- MUST route implementer tasks to DeepSeek only

Verify:
- orchestrator → Codex OAuth
- reviewer → Codex OAuth
- implementer → DeepSeek

Add explicit safeguards preventing:
- DeepSeek from handling final merge/review decisions
- Codex from being used for implementation-heavy coding unless manually overridden

Kanban requirements

Enable Hermes Kanban.

Enable Kanban dashboard plugin if available.

Create a board/tenant/project:
- jovie

Statuses/lanes:
1. Intake
2. Planning
3. Ready for Implementation
4. Implementing
5. CI Failed
6. Ready for Review
7. Fixes Required
8. Ready to Merge
9. Merged
10. Blocked

Worker ownership:
- orchestrator owns Intake + Planning
- implementers own Implementing + CI Failed
- reviewer owns Ready for Review + Ready to Merge + Merged + Fixes Required

Task metadata requirements:
Every task must store:
- Linear issue ID
- Linear identifier
- branch name
- workspace/worktree path
- assigned profile
- provider/model
- setup/bootstrap status
- test commands run
- PR URL
- CI status
- final status

Workspace/worktree rules

Use isolated git worktrees/workspaces for implementation tasks whenever possible.

Branch naming:
ai/<linear-key>-<slug>

Never:
- work directly on main
- force push main
- delete branches automatically
- run destructive git commands without confirmation

GitHub Actions integration

Detect existing CI.

If missing, create lightweight CI for:
- install
- lint
- typecheck
- tests

Keep CI fast and minimal.

Reviewer MUST NOT wake up unless CI passes.

If CI fails:
- route task back to implementer automatically

Reviewer should inspect:
- diff
- CI results
- changed files
- PR description

Reviewer should NOT:
- reread entire repo
- reload massive docs unnecessarily

Linear integration

Implement the simplest reliable intake method.

Preferred:
- Linear webhooks/agent integration

Fallback:
- Hermes cron polling every 10 minutes

AI issue intake rules:
Process issues:
- assigned to AI agent
OR
- labeled:
    ai
    ai-ready
    hermes
    jovie-agent

Use idempotency protection so issues do not duplicate.

Store mapping:
- Linear issue ID
- Kanban task ID
- Git branch
- PR URL

Update Linear automatically when:
- planning starts
- plan completed
- implementation starts
- CI fails/passes
- review blocks/approves
- PR opens
- PR merges
- task blocked

GitHub PR workflow

Implementers:
- create/update PRs
- stop after CI passes

Reviewer:
- reviews passing PRs
- merges approved PRs

PR title:
[<LINEAR_KEY>] <issue title>

PR body template:
- issue link
- implementation summary
- files changed
- tests run
- CI status
- reviewer findings
- remaining risks

Do not auto-merge unless:
- explicitly configured safe
- CI passes
- reviewer approves

Cron/scheduler jobs

Implement:

1. Linear intake poller
Every 10 min:
- discover AI-ready issues
- enqueue/update Kanban tasks
- idempotent

2. CI recovery watcher
Every 15 min:
- inspect failed AI PRs
- route back to implementer if fixable

3. Reviewer queue watcher
Every 15 min:
- discover PRs with passing CI
- enqueue reviewer tasks

4. Nightly maintenance
Nightly:
- summarize blocked tasks
- summarize stale PRs
- summarize failed CI
- summarize open reviewer queue

5. Morning summary
Weekdays:
- completed work
- blocked work
- open PRs
- merge status
- required human decisions

Cost optimization rules

MANDATORY:
1. Implementers get minimal scoped context only.
2. Reviewer loads diffs only.
3. Avoid repo-wide scans unless required.
4. Prefer GitHub Actions over LLM reasoning for validation.
5. Avoid recursive review loops.
6. Avoid multi-agent debates.
7. Avoid rereading large markdown docs repeatedly.
8. Prefer concise prompts and summaries.
9. Prefer small PRs.
10. Avoid loading the entire repo into context.

Implementation quality rules

1. No secrets in commits.
2. Scan diffs for secrets.
3. No unrelated file modifications.
4. No scope creep.
5. Block instead of guessing.
6. Tests required unless impossible.
7. Reviewer verifies actual diff.
8. Document assumptions explicitly.
9. Prefer reversible changes.
10. Prefer native Hermes/Ruflo functionality over custom infrastructure.

Docs to create

1. docs/ai-engineering-system.md
Include:
- architecture
- provider routing
- Kanban flow
- Ruflo integration
- GBrain lifecycle
- worktree lifecycle
- merge flow
- Linear integration
- GitHub workflow
- CI workflow
- cost optimization strategy
- profile responsibilities

2. docs/ai-agent-runbook.md
Include:
- starting Hermes
- dashboard usage
- Kanban usage
- Ruflo usage
- GBrain inspection
- worktree inspection
- Linear intake
- provider verification
- disabling automation
- troubleshooting
- inspecting stuck tasks
- rotating DeepSeek keys
- verifying Codex OAuth

3. Local config file
Example:
.jovie/ai-agent-config.yaml

Include:
- providers
- profiles
- branch naming
- poll intervals
- CI commands
- labels
- dashboard URL
- workflow settings
- worktree setup commands
- GBrain integration settings

Validation requirements

After implementation:
Run a dry-run test using a harmless issue.

Dry-run must verify:
1. Linear intake works
2. Kanban task created
3. Orchestrator writes plan
4. Implementer creates tiny harmless change
5. Worktree setup script runs correctly
6. GBrain task-start memory recorded
7. GitHub Actions run
8. Reviewer wakes up only after CI passes
9. Reviewer reviews diff
10. Reviewer merges or blocks correctly
11. GBrain task-end memory recorded
12. Correct provider routing verified

Explicitly confirm:
- No Anthropic configured
- No Claude configured
- No API billing path used for Codex
- Implementer uses DeepSeek only
- Reviewer uses Codex only

Final deliverables

At completion provide:
1. Exact providers configured
2. Exact profiles created
3. Exact Kanban setup
4. Exact Ruflo integrations
5. Exact GBrain lifecycle integration
6. Exact worktree lifecycle
7. Exact cron jobs
8. Dashboard URL/how to open
9. Linear intake rules
10. GitHub workflow
11. CI workflow
12. Dry-run results
13. Remaining manual steps
14. Missing Hermes/Ruflo features/workarounds
15. Estimated operational token/cost savings from centralized review architecture

Execution mode

Operate autonomously.
Inspect before assuming.
Prefer native Hermes + Ruflo functionality.
Keep systems simple and durable.
Document all changes.
Do not ask for clarification unless blocked by:
- missing credentials
- missing permissions
- destructive decision
- unavailable Hermes/Ruflo feature

If blocked:
state the exact command, credential, permission, or decision needed.
```

---

## User

{'asset_pointer': 'sediment://file_00000000e31871fd98ebfd6e41496c80', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 1330, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 13200243, 'width': 2048}
it seems like claude code does use your subscription.....

---

## Assistant

Yes, Mr. White — your screenshot confirms Hermes is successfully reading your Claude Code subscription credentials from `~/.claude/.credentials.json`, and Anthropic officially states Claude Code works with unified Pro/Max subscriptions. citeturn0search3turn0search15

But the important nuance is:

```text
Claude Code CLI itself:
  Uses your Pro/Max subscription allowance.

Hermes calling Anthropic directly through OAuth:
  Often routes into "extra usage" behavior.
```

That distinction is exactly what all the Hermes GitHub issues are about. Multiple users with healthy Max subscriptions are getting:

```text
"You're out of extra usage"
```

inside Hermes specifically, even while normal Claude Code works fine. citeturn0search2turn0search5turn0search7

So your screenshot proves:

```text
Hermes CAN see and reuse your Claude credentials.
```

It does NOT prove:

```text
Hermes orchestration traffic reliably stays inside included Max allowance.
```

In fact, the current evidence strongly suggests the opposite for many Hermes-native Anthropic flows. citeturn0search2turn0search5turn0search10

The critical distinction is:

| Path | Included subscription? | Stable? |
|---|---|---|
| Running `claude` CLI directly | Yes | Yes |
| Hermes using Claude Code CLI as external tool | Usually yes | Mostly |
| Hermes native Anthropic provider OAuth | Unclear / often extra usage | Buggy currently |

That is why your architecture should become:

```text
Hermes = orchestrator + Kanban + memory + workflows
Codex OAuth = orchestration/review intelligence
DeepSeek = implementation
Claude Code = OPTIONAL specialized worker only
```

NOT:

```text
Hermes native anthropic provider for everything
```

unless you are okay with extra-usage weirdness.

Your screenshot actually reinforces the strategy we landed on:

```text
Avoid Anthropic-native Hermes routing entirely.
```

because the ecosystem around it is currently unstable.

The best setup for you now is probably:

```text
Hermes Kanban
+ Codex OAuth (subscription)
+ DeepSeek implementers
+ GitHub Actions CI
+ optional Claude Code worker skill for specific hard problems only
```

and only invoke Claude Code selectively for:

```text
- architectural deadlocks
- hard debugging
- refactors
- security-sensitive review
- difficult merge conflicts
```

because Claude Code CLI itself is officially included in Max. citeturn0search15turn0search11

The good news is your screenshot also confirms:

```text
OpenAI Codex (ChatGPT) OAuth is connected.
```

That is the important one for your orchestration layer.

---

## User

harden the plan

---

## Assistant

Mr. White, I would **not approve the pasted plan as-is**. It is close, but it needs three hardening changes:

1. **Stop or rewrite the existing Claude Code dispatcher first.** Your audit says `dispatch-kanban.sh` currently runs every 10 minutes and sends Kanban tasks to Claude Code CLI. That conflicts with the “no Claude/Anthropic” goal unless you explicitly want Claude Code as a fallback. fileciteturn0file0

2. **Do not use the free NVIDIA/OpenRouter model as the merge authority.** OpenRouter free models are rate-limited, availability is not guaranteed, and model-provider terms/data practices can vary by provider. Use free models only for queue triage or cheap summaries. The actual reviewer/merge judge should be **Codex OAuth**. citeturn705980view3turn705980view4

3. **Make implementation routing explicit.** If no DeepSeek key exists, use **Codex OAuth** as a temporary implementer fallback. Once DeepSeek is configured, route implementation to DeepSeek. Never silently route implementation through a random free OpenRouter model.

Codex OAuth is the right paid-subscription path here because OpenAI says Codex is included with ChatGPT Plus/Pro/Business/Enterprise/Edu plans, while API-key Codex usage is billed separately through the OpenAI Platform. Also disable credits/auto-top-up so Codex stops at included usage rather than buying more after limits. citeturn705980view1turn705980view0turn705980view2

## Hardened architecture

```text
Hermes Kanban = durable queue / source of truth

Linear = issue intake / human-visible task record

Ruflo = hooks/workflow glue only where already present and verified

GBrain = durable task memory at start/end

Git worktrees = isolated implementation workspace

GitHub Actions = first validation gate

Codex OAuth = orchestrator + reviewer/merge judge

DeepSeek = implementation once direct key is configured

Codex OAuth fallback = implementation only while DeepSeek is missing

Free OpenRouter/NVIDIA = queue triage only, never merge authority
```

Hermes Kanban is the correct backbone because it is a native durable board shared across profiles; every task is stored in `~/.hermes/kanban.db`, handoffs are durable, and engineering pipelines with worktrees/review/PR are explicitly listed as a target pattern. citeturn810522view6

Hermes profiles are also the right separation boundary for roles because each profile has its own config, `.env`, memory, sessions, cron jobs, and state database. Profiles do **not** sandbox filesystem access, so worktree isolation and explicit `terminal.cwd` still matter. citeturn705980view7

## Hardened role routing

| Role | Primary model path | Fallback | Merge authority? |
|---|---|---|---|
| Orchestrator | Codex OAuth | none | no |
| Implementer | DeepSeek direct API | Codex OAuth | no |
| CI fixer | DeepSeek direct API | Codex OAuth | no |
| Reviewer | Codex OAuth | pause | yes |
| Merger | Codex OAuth | pause | yes |
| Triage/summarizer | Free OpenRouter/NVIDIA | skip | no |

The main correction is reviewer quality. A cheap/free reviewer is false economy because it controls the riskiest action: landing code.

## Hardened implementation prompt

Paste this to Hermes as the next instruction:

```text
HARDEN THE EXISTING AI ENGINEERING PLAN BEFORE IMPLEMENTATION.

Current audit summary:
- Hermes v0.13.0 is installed.
- Kanban board jovie-product already exists.
- Existing dispatch-kanban.sh runs every 10 minutes and currently dispatches Kanban work to Claude Code CLI.
- Codex OAuth is authenticated.
- DeepSeek direct API key is not set in ~/.hermes/.env.
- Linear API key is set.
- GitHub is authenticated.
- Ruflo and GBrain still need inspection.
- Goal remains: durable Hermes Kanban pipeline with Linear intake, worktrees, setup script, CI gating, GBrain memory, Ruflo where useful, and no unintended paid API billing.

MANDATORY HARDENING CHANGES

1. Disable or rewrite the existing Claude Code dispatcher first.

Before creating new workers, inspect:
- dispatch-kanban.sh
- existing cron entries
- Hermes cron jobs
- system cron jobs
- launch agents
- any scripts that call claude, Claude Code, Anthropic, or dispatch to Claude

If dispatch-kanban.sh currently calls Claude Code:
- do not leave it active
- either disable it or rewrite it to dispatch to Hermes profiles
- document the exact change
- verify there is only one active dispatcher after setup

Do not delete credentials.
Do not disconnect Claude manually.
Just ensure this automation does not route through Claude/Anthropic unless explicitly approved later.

2. Provider authority rules.

Allowed:
- Codex OAuth via ChatGPT subscription for orchestrator/reviewer/merge decisions
- DeepSeek direct API for implementation once DEEPSEEK_API_KEY is configured
- Codex OAuth as temporary implementation fallback while DeepSeek is missing
- Free OpenRouter/NVIDIA only for triage/summaries

Forbidden:
- Anthropic provider
- Claude provider
- Claude Code dispatch
- Claude Max extra usage
- OpenAI API key billing
- OPENAI_API_KEY billing path
- Codex credits/auto-top-up
- free OpenRouter/NVIDIA as final reviewer or merger

3. Reviewer/merger hardening.

Replace the prior reviewer plan.

Do NOT use free NVIDIA/OpenRouter as reviewer/merge authority.

Use:
- jovie-reviewer = Codex OAuth
- jovie-merger = same profile or same Codex OAuth path

Free NVIDIA/OpenRouter may only:
- summarize PR queues
- classify obvious CI failures
- detect stale tasks
- produce low-risk status digests

It must never:
- approve code
- merge code
- decide architecture
- override tests
- handle security-sensitive review

4. Implementer routing hardening.

If DEEPSEEK_API_KEY is present:
- jovie-implementer uses DeepSeek direct API
- implementation-heavy tasks route to DeepSeek

If DEEPSEEK_API_KEY is missing:
- jovie-implementer temporarily uses Codex OAuth
- mark this as fallback mode
- create a visible warning in docs and dashboard/status:
  “DeepSeek not configured; implementer using Codex OAuth fallback.”

Do NOT silently use OpenRouter free models for implementation.

If OpenRouter DeepSeek is considered:
- require explicit budget cap
- require model allowlist
- require confirmation that source code may be sent to that provider route
- never use it automatically because the OpenRouter balance is limited

5. Codex billing guardrails.

Before running Codex tasks, verify:
- Codex auth is OAuth / ChatGPT sign-in
- OPENAI_API_KEY is unset or ignored for this automation
- no OpenAI API billing path is active
- auto-top-up / extra credits are disabled or at least documented as disabled
- if Codex limit is hit, tasks pause instead of buying credits or switching to API billing

Create a provider sanity check script:
scripts/ai/assert-provider-policy.sh

It should fail fast if:
- OPENAI_API_KEY is present in the automation environment
- ANTHROPIC_API_KEY is present
- ANTHROPIC_AUTH_TOKEN is present
- ANTHROPIC_BASE_URL is present
- active Hermes model/provider for orchestrator/reviewer is not Codex OAuth
- active implementer provider is neither DeepSeek nor approved Codex fallback
- reviewer provider is free OpenRouter/NVIDIA

Do not guess Hermes CLI flags. Inspect help output before implementing checks.

6. Kanban remains source of truth.

Use the existing board:
- jovie-product

Do not create a duplicate board unless the existing board is unusable.

Create or enforce statuses:
- Intake
- Planning
- Ready for Implementation
- Implementing
- CI Failed
- Ready for Review
- Fixes Required
- Ready to Merge
- Merged
- Blocked

Task metadata must include:
- Linear issue ID
- Linear identifier
- Kanban task ID
- branch name
- worktree path
- setup/bootstrap status
- assigned profile
- provider/model actually used
- Ruflo hook status
- GBrain start memory ID
- GBrain end memory ID
- test commands run
- CI status
- PR URL
- final status
- blocker reason if blocked

7. Cron hardening.

Use no-agent/script cron for polling and routing where possible.

Cron jobs should enqueue or update Kanban tasks only.
Cron jobs should not perform expensive LLM reasoning unless explicitly necessary.

Every cron job must:
- be idempotent
- log start/end
- produce a heartbeat
- report errors
- avoid silent success with empty output
- use lockfiles to prevent overlapping runs
- have a max runtime
- have retry limits
- never recursively create new cron jobs

Required jobs:
- Linear intake poller every 10m
- CI recovery watcher every 15m
- reviewer queue watcher every 15m
- stale worktree cleanup/report job
- nightly maintenance summary
- weekday morning summary

8. Linear intake hardening.

Preferred:
- Linear Agent Session webhooks

Fallback:
- polling every 10m

If using webhooks:
- respond quickly
- enqueue work instead of doing long processing in the webhook handler
- store Linear session/issue/task mapping

If using polling:
- process issues with labels:
  ai
  ai-ready
  hermes
  jovie-agent
- or issues assigned to the AI agent
- use idempotency keys
- never duplicate Kanban tasks for the same Linear issue

9. GitHub/CI hardening.

GitHub Actions is the first validation gate.

Reviewer wakes only when:
- PR exists
- branch is up to date or mergeable
- required checks pass on latest commit
- no obvious secret scan failure
- PR belongs to ai/* branch
- PR has Linear mapping
- PR has implementation summary

If CI fails:
- route back to implementer
- do not wake reviewer
- summarize failure concisely
- cap retry loops

Required branch protections:
- required status checks
- require latest commit SHA checks
- require PR review if available
- no direct push to main by agents
- no force-push to main

If branch protection cannot be configured automatically:
- document exact manual steps
- block auto-merge until configured

10. Worktree hardening.

Every implementation task must use an isolated git worktree.

Workflow:
1. git fetch origin
2. create branch ai/<linear-key>-<slug>
3. create isolated worktree
4. run provider sanity check
5. run existing repo setup/bootstrap script
6. validate dependencies
7. pull GBrain task-start context
8. implement
9. run tests/lint/typecheck
10. commit
11. push
12. open/update PR
13. wait for CI
14. route to reviewer only after CI passes

Inspect repo for setup scripts:
- setup.sh
- scripts/setup*
- scripts/bootstrap*
- bin/setup
- Makefile
- package manager scripts
- devcontainer
- mise/asdf/nix/direnv config

Use the repo’s existing setup script. Do not invent a new bootstrap unless no existing one is found.

If setup fails:
- block the task
- record failure
- do not proceed to implementation

11. Ruflo hardening.

Inspect Ruflo before using it.

Run:
- which ruflo
- npx ruflo --help
- inspect repo configs/hooks
- inspect existing Ruflo state/configs

Use Ruflo only for:
- verified hooks
- workflow glue
- orchestration helpers
- memory or event pipeline integration if already wired
- validation hooks around task start/end

Do NOT:
- make Ruflo the durable task source of truth
- duplicate Hermes Kanban queueing
- enable broad swarms blindly
- install a large MCP/tool surface without a dry run
- route through Claude Code because Ruflo is Claude-centric

Hermes Kanban remains the queue.
Ruflo is glue/hooks only unless explicitly proven otherwise.

Document:
- Ruflo version
- Ruflo commands used
- hooks enabled
- hooks skipped
- why skipped

12. GBrain hardening.

At task start:
- query GBrain for relevant context
- fetch related issue/PR/convention/pitfall notes
- store task-start record

At task end:
- store structured task-end record
- store only durable learnings, not raw logs

GBrain start record schema:
{
  "type": "ai_task_start",
  "linear_key": "...",
  "kanban_task_id": "...",
  "branch": "...",
  "worktree": "...",
  "profile": "...",
  "provider": "...",
  "plan_summary": "...",
  "relevant_memory_refs": [...]
}

GBrain end record schema:
{
  "type": "ai_task_end",
  "linear_key": "...",
  "kanban_task_id": "...",
  "branch": "...",
  "pr_url": "...",
  "outcome": "merged|blocked|ci_failed|review_failed|abandoned",
  "files_changed": [...],
  "tests_run": [...],
  "ci_result": "...",
  "reviewer_findings": "...",
  "bugs_discovered": [...],
  "repo_conventions_learned": [...],
  "future_pitfalls": [...],
  "unresolved_risks": [...]
}

Do not spam GBrain.
Do not write giant logs.
Do not store ephemeral status chatter.
Use agent memory for operational preferences/config.
Use GBrain for durable world/project knowledge and learnings.

13. Secret and safety hardening.

Before commit:
- run git diff
- check for secrets
- check for unrelated file changes
- check for destructive changes
- check package lockfile changes
- verify branch is ai/*
- verify not on main
- verify worktree path is correct

Never:
- delete databases
- run destructive migrations
- force-push main
- modify production secrets
- change billing settings
- enable paid auto-top-up
- merge without CI
- merge from a dirty worktree
- merge if provider sanity check failed

14. Retry limits.

Implementation retries:
- max 2 automatic CI-fix attempts per PR
- after 2 failed attempts, move to Blocked or Fixes Required

Review retries:
- max 2 review/fix loops
- after 2 loops, request human decision

Cron retries:
- exponential backoff
- no overlapping runs
- alert on repeated failures

15. Observability.

Create:
- docs/ai-engineering-system.md
- docs/ai-agent-runbook.md
- .jovie/ai-agent-config.yaml
- scripts/ai/assert-provider-policy.sh
- scripts/ai/create-worktree-for-task.sh
- scripts/ai/run-worktree-setup.sh
- scripts/ai/gbrain-task-start.sh
- scripts/ai/gbrain-task-end.sh
- scripts/ai/check-pr-ready-for-review.sh
- scripts/ai/check-pr-ready-to-merge.sh

Docs must include:
- provider routing
- billing guardrails
- active cron jobs
- disabled old dispatchers
- Kanban board URL/dashboard
- Linear intake labels
- GBrain lifecycle
- Ruflo usage
- worktree lifecycle
- setup script used
- CI/merge rules
- emergency stop procedure

16. Emergency stop.

Implement a kill switch:
- .jovie/AI_AUTOMATION_DISABLED

If present:
- intake poller stops creating tasks
- dispatcher stops assigning tasks
- implementer stops starting work
- reviewer stops merging
- existing running jobs finish current safe step then stop

17. Dry-run validation.

Run dry-run only after provider policy and old dispatcher are fixed.

Dry-run should:
1. create or use harmless Linear issue
2. create Kanban task
3. pull GBrain start context
4. create isolated worktree
5. run repo setup script
6. make tiny docs-only change
7. commit/push/open PR
8. run CI
9. wait for passing CI
10. route to Codex reviewer
11. reviewer either blocks or approves
12. do not merge unless branch protection and all merge gates are verified
13. write GBrain end memory
14. update Linear
15. produce final report

Final report must include:
- old dispatcher status
- exact active cron jobs
- exact profiles
- exact provider routing
- Codex OAuth verification
- DeepSeek status
- OpenRouter free-model usage restrictions
- Ruflo status
- GBrain status
- worktree setup script found/used
- dry-run PR URL
- CI result
- merge gate result
- remaining manual steps

Proceed in audit/setup mode first.
Do not enable recurring automation until the old Claude Code dispatcher is disabled or rewritten and provider routing is verified.
```

## The biggest changes versus the uploaded plan

Your uploaded plan had:

```text
Implementer = Codex
Reviewer = free NVIDIA/OpenRouter
Existing dispatch = Claude Code CLI
```

The hardened version should be:

```text
Existing Claude Code dispatcher = disabled or rewritten first
Implementer = DeepSeek once configured, Codex OAuth fallback until then
Reviewer/Merger = Codex OAuth
Free NVIDIA/OpenRouter = triage only
```

That gives you the low-token architecture without letting the cheapest or most fragile model make merge decisions.

---

## Assistant

Mr. White, this plan is now close enough to approve **with a few mandatory edits**. The latest hardening plan correctly pauses the old Claude Code dispatcher, routes reviewer/merger to Codex OAuth, limits free OpenRouter/NVIDIA to triage, keeps `jovie-product`, and treats Ruflo as optional because it is present but not initialized. fileciteturn0file0 The earlier audit version still had the bad reviewer routing to free NVIDIA; treat that as superseded. fileciteturn0file1

Codex OAuth is the right planner/reviewer path because OpenAI says Codex is included with ChatGPT Plus/Pro/Business/Enterprise/Edu plans. The caveat is that after included usage is exhausted, Codex can draw from a credit balance, and eligible Plus/Pro users can enable auto top-up, so the plan needs an explicit “pause at subscription limit” policy and a manual check that auto top-up is off. citeturn142273view0turn142273view1

Hermes Kanban is the right queue. Hermes describes it as a durable board shared across profiles, backed by `~/.hermes/kanban.db`, with workers as full OS processes; it explicitly supports engineering pipelines like “decompose → implement in parallel worktrees → review → iterate → PR.” citeturn142273view2

## Required edits before approval

1. **Do not create `.jovie/AI_AUTOMATION_DISABLED` by default.**  
   Create `.jovie/AI_AUTOMATION_DISABLED.example` and document that creating the real file disables automation. If Hermes creates the real file during setup, the system starts in disabled mode.

2. **Do not edit Kanban JSON/SQLite directly.**  
   The plan says task metadata is stored in “board JSON fields.” Change that to: use official Hermes Kanban CLI/tool APIs wherever supported; store overflow metadata in `.jovie/kanban-task-metadata/<task-id>.json`.

3. **Free OpenRouter stays non-authoritative.**  
   OpenRouter free models have request limits and variable availability/latency; free variants are capped by requests per minute/day, and the free router may choose models dynamically. Use it only for summaries, stale-task detection, and queue triage. citeturn142273view3turn907288view0

4. **Auto-merge stays blocked until GitHub branch protection is verified.**  
   GitHub required status checks force checks to be successful, skipped, or neutral before merging, and branch rules can require approving reviews and passing checks. The dry run should report “merge ready,” then stop unless protections are confirmed. citeturn142273view4turn142273view5

5. **DeepSeek direct should be configured before serious implementation.**  
   Codex fallback is fine for the dry run. For real implementation throughput, add `DEEPSEEK_API_KEY` and make implementer use DeepSeek. Codex fallback burns your Codex subscription capacity.

6. **GBrain needs redaction/dedupe limits.**  
   Add: redact secrets before writes, max payload size, no raw logs, deterministic memory key per task, and update existing task memory rather than creating duplicates.

7. **Provider check cannot rely only on env vars.**  
   `assert-provider-policy.sh` should check both environment and Hermes profile config. It should fail if reviewer is OpenRouter/free, if implementer is OpenRouter/free, or if `OPENAI_API_KEY`/Anthropic vars are visible to automation.

## Send Hermes this approval

```text
Approved, with the following mandatory edits before implementation.

1. Treat the newer HARDENING PLAN as authoritative. The older audit plan is superseded, especially the part that routed reviewer/merger to free NVIDIA/OpenRouter.

2. Reviewer and merger must use Codex OAuth only.
   Free OpenRouter/NVIDIA may be used only for:
   - queue summaries
   - stale task detection
   - obvious CI failure classification
   - low-risk status digests

   Free OpenRouter/NVIDIA must never:
   - approve code
   - merge code
   - make architecture decisions
   - override CI
   - review security-sensitive changes

3. Do not create .jovie/AI_AUTOMATION_DISABLED as an active file during setup.
   Instead create:
   - .jovie/AI_AUTOMATION_DISABLED.example

   Document:
   - creating .jovie/AI_AUTOMATION_DISABLED disables automation
   - deleting it re-enables automation after provider checks pass

4. Do not edit Hermes Kanban SQLite or board JSON directly.
   Use official Hermes Kanban CLI/tool APIs wherever possible.
   If task metadata cannot fit in native Kanban fields, store overflow metadata in:
   - .jovie/kanban-task-metadata/<kanban-task-id>.json

5. Keep existing Kanban board:
   - jovie-product

6. Disable or rewrite the existing Claude Code dispatcher before enabling new recurring automation.
   Verification must include:
   - Hermes cron list
   - system crontab
   - launch agents if applicable
   - grep for claude, anthropic, ANTHROPIC, Claude Code, and dispatch-kanban

   There must be exactly one active dispatcher after setup.

7. Codex OAuth guardrail:
   - Codex must use ChatGPT/Codex OAuth only.
   - OPENAI_API_KEY must not be visible to automation.
   - Do not use OpenAI API billing.
   - Do not use Codex credits or auto top-up.
   - If Codex hits subscription limit, pause tasks instead of buying credits or switching to API billing.

   Add a manual verification step in the runbook:
   - check Codex Settings > Usage
   - verify auto top-up is off
   - verify no unwanted credit spending policy is active

8. Implementer routing:
   - If DEEPSEEK_API_KEY is present, jovie-implementer uses DeepSeek direct API.
   - If DEEPSEEK_API_KEY is missing, jovie-implementer may use Codex OAuth fallback only for dry-run and low-volume setup work.
   - Show a visible warning whenever Codex fallback is active:
     “DeepSeek not configured; implementer using Codex OAuth fallback.”

   Do not use OpenRouter free models for implementation.

9. Strengthen scripts/ai/assert-provider-policy.sh.
   It must fail if:
   - OPENAI_API_KEY is visible
   - ANTHROPIC_API_KEY is visible
   - ANTHROPIC_AUTH_TOKEN is visible
   - ANTHROPIC_BASE_URL is visible
   - reviewer provider is OpenRouter/free
   - merger provider is OpenRouter/free
   - implementer provider is OpenRouter/free
   - orchestrator/reviewer are not Codex OAuth
   - implementer is neither DeepSeek direct nor explicitly approved Codex fallback
   - .jovie/AI_AUTOMATION_DISABLED exists

10. GBrain hardening:
   Add redaction and dedupe.
   At task start/end:
   - redact secrets
   - cap payload size
   - avoid raw logs
   - use deterministic key: linear_key + kanban_task_id + phase
   - update existing memory if present
   - store only durable learnings and task metadata

11. GitHub merge hardening:
   Auto-merge must stay disabled until branch protection is verified.
   Required gates:
   - PR branch matches ai/*
   - latest commit has passing required checks
   - branch is mergeable
   - no secret scan failure
   - PR has Linear mapping
   - PR has Kanban task mapping
   - reviewer approval exists
   - branch protection/ruleset is verified

   During dry-run, report merge readiness but do not merge unless all protections are verified.

12. Worktree hardening:
   Every implementation task must:
   - create an isolated worktree
   - run the repo’s existing setup/bootstrap script
   - verify clean worktree before/after
   - avoid main
   - avoid dirty workspace reuse
   - record setup/test status in metadata

13. Ruflo:
   Since Ruflo is installed but not initialized in this repo, do not introduce it as a new durable queue.
   Use Ruflo only if inspection finds existing useful hooks/configs.
   Hermes Kanban remains source of truth.

14. Proceed in this order:
   1. Rewrite/disable old Claude Code dispatcher.
   2. Create provider policy script.
   3. Create/update profiles.
   4. Verify Codex OAuth and DeepSeek status.
   5. Configure Kanban lanes on jovie-product.
   6. Add metadata storage.
   7. Add GBrain start/end hooks.
   8. Add worktree scripts using repo setup script.
   9. Add no-agent cron jobs with lockfiles.
   10. Run dry-run docs-only PR.
   11. Report results and stop before auto-merge unless branch protection is verified.

Proceed without asking further questions unless blocked by a missing credential, missing permission, or destructive action.
```

Bottom line: approve the current hardening plan **after these edits**. The main principles are correct: Hermes Kanban as queue, Codex OAuth for judgment, DeepSeek for implementation when configured, GitHub Actions as the validation gate, and no free model in the merge path.

---

## User

shouldnt we jjust intialize riuflo

---

## Assistant

Yes, Mr. White — **initialize Ruflo**, but do it in **controlled mode** and keep Hermes Kanban as the durable queue.

Your audit already says Ruflo is installed but not initialized in the repo, and the current plan says Hermes would skip it unless useful. That is too conservative. We should initialize it, inspect what it adds, then wire only the useful parts. fileciteturn2file0

## Correct decision

```text
Initialize Ruflo
Do not make Ruflo the source of truth
Do not let Ruflo auto-wire Claude Code
Do not let Ruflo run autonomous background loops until inspected
Use Ruflo for hooks/workflows/memory/glue
Use Hermes Kanban for durable queue/dispatcher/task state
```

Why: Ruflo is specifically built for agent orchestration, swarms, memory, hooks, workflows, testing, security audit, docs, cost tracking, and background workers. Its README says the full init path installs a large surface: agents, commands, skills, MCP server, hooks, and daemon. That means it is useful, but also too broad to blindly activate in production. citeturn359016view0

Hermes Kanban should still remain the backbone because it is already a durable SQLite-backed queue across Hermes profiles, with task state, handoffs, comments, idempotency keys, dispatcher support, dashboard/CLI access, and engineering workflows like “decompose → implement in parallel worktrees → review → iterate → PR.” citeturn823243view1

## The hardened stance

Ruflo becomes:

```text
Ruflo = orchestration enhancement layer
Hermes Kanban = durable task queue
GBrain = durable project memory
GitHub Actions = validation gate
Codex OAuth = planner/reviewer
DeepSeek = implementer
```

Ruflo should help with:

```text
- task hooks
- workflow templates
- test generation
- security scanning
- docs generation
- cost tracking
- memory/RAG support
- diff/risk analysis
- agent coordination helpers
```

Ruflo should not own:

```text
- Kanban state
- Linear issue mapping
- final merge authority
- Claude Code dispatch
- recurring autonomous loops
- billing/provider routing
```

## Important risk

The Ruflo README distinguishes a light Claude Code plugin path from a full CLI install. The full Ruflo path includes hooks and an MCP server; the plugin-only path gives slash commands and agent definitions without registering the Ruflo MCP server. citeturn359016view1

So the setup should **inspect before activating**. The danger is accidentally installing hooks that route through Claude Code or create duplicate worker loops.

## Revised instruction to Hermes

Use this:

```text
Update the hardening plan: initialize Ruflo in controlled audit mode.

Ruflo is installed but not initialized in this repo. Initialize it, but do not let it replace Hermes Kanban or create uncontrolled Claude Code/background automation.

MANDATORY ORDER:

1. Pause active AI automation first.
   - Pause old Claude Code dispatcher.
   - Pause Kanban auto-dispatch cron.
   - Ensure no recurring worker loop is active while Ruflo initializes.

2. Snapshot current state.
   Record:
   - git status
   - existing .claude files
   - existing .ruflo / .claude-flow / Ruflo files if any
   - Hermes cron list
   - system crontab
   - current dispatch-kanban.sh
   - current Hermes profiles
   - current Kanban board state

3. Inspect Ruflo CLI before running init.
   Run:
   - which ruflo
   - ruflo --version
   - ruflo --help
   - ruflo init --help
   - npx ruflo@latest init --help if needed

   Do not guess flags.

4. Initialize Ruflo in the least destructive full mode that exposes hooks/workflows/memory.
   Prefer local repo initialization.
   Avoid enabling autonomous background loops during init if prompted.
   Avoid registering Claude Code MCP unless explicitly required and approved.
   Avoid any Anthropic/Claude provider setup.

5. After init, inspect all changed files.
   Report:
   - files created
   - files modified
   - hooks installed
   - MCP servers registered
   - daemons/background workers configured
   - provider/model settings
   - any Claude Code integration
   - any billing/API-key paths
   - any recurring loops

6. Disable or remove any Ruflo feature that:
   - dispatches to Claude Code
   - uses Anthropic
   - uses OPENAI_API_KEY billing
   - starts autonomous loops without Hermes Kanban control
   - duplicates Hermes Kanban as the source of truth
   - bypasses provider-policy checks

7. Keep Hermes Kanban as source of truth.
   Ruflo may only be used for:
   - hooks
   - workflow helpers
   - test generation
   - security audit
   - docs generation
   - diff/risk scoring
   - memory/RAG glue
   - task lifecycle hooks

8. Wire Ruflo into the task lifecycle.

   At task start:
   - run provider policy check
   - run GBrain start context
   - optionally run Ruflo memory/context retrieval
   - optionally run Ruflo planning/workflow helper
   - record Ruflo hook status in Kanban metadata

   Before commit:
   - optionally run Ruflo security/test/diff-risk hooks
   - keep GitHub Actions as the hard validation gate

   At task end:
   - run GBrain end memory write
   - optionally run Ruflo docs/memory update
   - record durable learnings only

9. Do not let Ruflo control merges.
   Merge authority remains:
   - Codex OAuth reviewer/merger
   - GitHub branch protection
   - passing CI
   - merge-gate script

10. Update docs:
   - docs/ai-engineering-system.md
   - docs/ai-agent-runbook.md
   - .jovie/ai-agent-config.yaml

   Include:
   - Ruflo initialization result
   - Ruflo enabled hooks
   - Ruflo disabled hooks
   - why Hermes Kanban remains source of truth
   - how to disable Ruflo integration
   - how to audit Ruflo provider routing

11. Only after Ruflo init is audited and safe:
   - rewrite dispatcher
   - enable Hermes profile workers
   - enable no-agent cron jobs
   - run dry-run docs-only PR

Proceed with Ruflo initialization in audit mode first. Stop after reporting changed files, hooks, daemons, MCP settings, provider settings, and any automation it attempted to install.
```

## Bottom line

Yes — initialize Ruflo now.

The corrected architecture is:

```text
Hermes Kanban owns work
Ruflo enhances workflow
GBrain owns durable memory
Codex judges
DeepSeek implements
GitHub Actions gates
Linear tracks
```

That is better than leaving Ruflo unused, and safer than letting Ruflo become another uncontrolled dispatcher.

---

## Assistant

Mr. White, proceed, but **do not approve the plan exactly as written**. The Ruflo init succeeded and looks safe enough to use, but the plan needs a final delta patch before Hermes implements.

Your audit shows Ruflo was initialized with `ruflo init --full --force`, added `.claude-flow/`, `.mcp.json`, hooks, agents, skills, and daemon config, and did **not** start autonomous background loops. The daemon has `autoStart: false`, which is good. The main concern is that Ruflo overwrote `.claude/`, installed Claude-oriented defaults, and set model preferences to Claude identifiers. fileciteturn2file0 Ruflo’s own README frames init as a Claude Code integration where hooks can automatically route tasks and coordinate agents, so we should treat those hooks as useful but potentially dangerous until provider policy is enforced. citeturn731224search0

## Decision

Use this architecture:

```text
Hermes Kanban = source of truth
Ruflo = hooks / workflow helper / optional MCP helper
GBrain = durable project memory
Codex OAuth = orchestrator + reviewer + merge judge
DeepSeek direct = implementer once key is configured
Codex OAuth fallback = temporary implementer only
OpenRouter free = triage/status summaries only
Claude/Ruflo Claude defaults = disabled or made inert
```

Hermes Kanban should stay the backbone because Hermes documents it as a durable board shared across profiles, backed by `~/.hermes/kanban.db`, with each worker running as a full OS process. citeturn731224search1

## Final corrections before implementation

The hardening plan still has a few contradictions:

1. **Section 11 is stale.** It still says Ruflo is not initialized. Replace it with the new audit result: Ruflo is initialized, but used only as hooks/MCP/workflow glue. fileciteturn2file1

2. **Do not create `.jovie/AI_AUTOMATION_DISABLED` as the active file.** The plan says to create the real kill-switch file. That would start the system disabled. Create `.jovie/AI_AUTOMATION_DISABLED.example` instead. fileciteturn2file1

3. **Do not store metadata by editing Kanban board JSON directly.** Use Hermes Kanban APIs/CLI where possible. Store overflow metadata in `.jovie/kanban-task-metadata/<task-id>.json`.

4. **Fix Ruflo Claude defaults.** The audit shows Ruflo model preferences point to Claude. Leave them inert or override them so Ruflo cannot route to Claude/Anthropic. fileciteturn2file0

5. **Keep free OpenRouter away from review/merge.** The older plan routed reviewer to free NVIDIA, which is unsafe and superseded. fileciteturn2file2 OpenRouter free models have request/day limits and availability constraints, so they are unsuitable as merge authority. citeturn731224search6

6. **Codex must stay OAuth-only.** Codex is included with ChatGPT plans, but API-key usage is billed through OpenAI Platform pricing, so the provider check must fail if `OPENAI_API_KEY` is visible to automation. citeturn731224search3turn731224search7

## Send Hermes this final approval prompt

```text
Approved to proceed, but first apply this final hardening delta.

Use the latest Ruflo audit as authoritative:
- Ruflo has now been initialized with ruflo init --full --force.
- .claude-flow/ exists.
- .mcp.json exists.
- Ruflo hooks, agents, skills, and MCP config exist.
- Ruflo daemon autoStart is false.
- Ruflo did not create cron jobs or autonomous loops.
- Existing .claude/ was overwritten, with .claude.backup preserved.
- Ruflo model preferences currently point to Claude identifiers.

Update the plan before implementation:

1. Replace the stale Ruflo section.
   Ruflo is initialized now.
   Do not say Ruflo is absent or uninitialized.
   Hermes Kanban remains the source of truth.
   Ruflo may only be used for:
   - hooks
   - MCP helper functionality
   - workflow glue
   - task lifecycle checks
   - memory/context helper flows
   - security/test/diff-risk helpers

   Ruflo must not own:
   - durable queue state
   - Linear issue mapping
   - merge authority
   - provider routing
   - recurring worker loops

2. Neutralize unsafe Ruflo Claude defaults.
   Inspect:
   - .claude/settings.json
   - .mcp.json
   - .claude-flow/
   - .claude/agents/
   - .claude/hooks/
   - .claude/helpers/

   Ensure no active automation routes through:
   - Claude
   - Claude Code
   - Anthropic
   - ANTHROPIC_API_KEY
   - ANTHROPIC_AUTH_TOKEN
   - ANTHROPIC_BASE_URL

   If Ruflo model preferences point to Claude, either:
   - leave them inert and document they are unused by Hermes automation, or
   - override them to non-Claude placeholders compatible with our provider policy.

   Do not delete credentials.
   Do not disconnect providers.
   Just ensure the automation cannot dispatch through Claude/Anthropic.

3. Keep Ruflo daemon disabled.
   Do not run:
   - ruflo daemon start
   - claude-flow daemon start
   - any Ruflo background worker loop

   unless explicitly approved later.

   Document:
   - daemon autoStart=false
   - no active Ruflo daemon
   - how to verify daemon status
   - how to disable Ruflo MCP/hooks if needed

4. Fix the emergency stop file behavior.
   Do NOT create .jovie/AI_AUTOMATION_DISABLED as an active file during setup.

   Create:
   - .jovie/AI_AUTOMATION_DISABLED.example

   Document:
   - creating .jovie/AI_AUTOMATION_DISABLED disables automation
   - deleting it re-enables automation only after provider policy checks pass

5. Do not edit Hermes Kanban SQLite or board JSON directly.
   Use official Hermes Kanban CLI/tool APIs wherever possible.

   If metadata cannot fit in native Kanban fields, store overflow metadata in:
   - .jovie/kanban-task-metadata/<kanban-task-id>.json

6. Keep existing Kanban board:
   - jovie-product

   Do not create a duplicate board unless jovie-product is unusable.

7. Rewrite or disable the old Claude Code dispatcher before enabling new recurring automation.
   The existing dispatch-kanban.sh still points to Claude Code CLI.
   This must be fixed first.

   Verification must include:
   - Hermes cron list
   - system crontab
   - launch agents if applicable
   - grep for claude, anthropic, ANTHROPIC, Claude Code, dispatch-kanban

   There must be exactly one active dispatcher after setup.
   The active dispatcher must call Hermes profiles, not Claude Code.

8. Provider routing rules:
   - jovie-orchestrator = Codex OAuth only
   - jovie-reviewer = Codex OAuth only
   - jovie-merger = Codex OAuth only
   - jovie-implementer = DeepSeek direct if DEEPSEEK_API_KEY is present
   - jovie-implementer = Codex OAuth fallback only if DeepSeek is missing

   Free OpenRouter/NVIDIA may only be used for:
   - status summaries
   - stale task detection
   - obvious CI failure classification
   - queue digests

   Free OpenRouter/NVIDIA must never:
   - review code
   - approve code
   - merge code
   - decide architecture
   - override CI
   - handle security-sensitive decisions

9. Strengthen scripts/ai/assert-provider-policy.sh.
   It must fail if:
   - OPENAI_API_KEY is visible to automation
   - ANTHROPIC_API_KEY is visible
   - ANTHROPIC_AUTH_TOKEN is visible
   - ANTHROPIC_BASE_URL is visible
   - reviewer provider is OpenRouter/free
   - merger provider is OpenRouter/free
   - implementer provider is OpenRouter/free
   - orchestrator/reviewer/merger are not Codex OAuth
   - implementer is neither DeepSeek direct nor explicitly approved Codex OAuth fallback
   - Ruflo daemon is running
   - old Claude Code dispatcher is active
   - .jovie/AI_AUTOMATION_DISABLED exists

10. Codex billing guardrail:
   Codex must use ChatGPT/Codex OAuth only.
   Do not use OpenAI API billing.
   Do not use OPENAI_API_KEY.
   Do not enable auto top-up or extra credits.
   If Codex hits subscription limits, pause tasks instead of switching to API billing.

11. GBrain lifecycle:
   At task start:
   - retrieve relevant memory
   - redact secrets
   - write concise ai_task_start memory
   - record memory ID in task metadata

   At task end:
   - redact secrets
   - write concise ai_task_end memory
   - update existing deterministic memory if present
   - avoid raw logs
   - avoid duplicate memory spam

12. Worktrees:
   Every implementation task must:
   - create isolated git worktree
   - use branch ai/<linear-key>-<slug>
   - run repo setup/bootstrap script
   - verify clean worktree before and after
   - avoid main
   - avoid dirty workspace reuse
   - record setup/test status in metadata

13. GitHub/merge gate:
   Auto-merge remains disabled until branch protection is verified.

   Required gates:
   - branch is ai/*
   - latest commit has passing required checks
   - branch is mergeable
   - no secret scan failure
   - PR has Linear mapping
   - PR has Kanban task mapping
   - reviewer approval exists
   - merge gate script passes
   - branch protection/ruleset verified

   During dry-run, report merge readiness but do not merge unless all protections are verified.

14. Proceed in this order:
   1. Neutralize/verify Ruflo Claude defaults and daemon status.
   2. Rewrite/disable old Claude Code dispatcher.
   3. Create provider policy script.
   4. Create/update Hermes profiles.
   5. Verify Codex OAuth and DeepSeek status.
   6. Configure Kanban lanes on jovie-product.
   7. Add overflow metadata storage.
   8. Add GBrain start/end hooks.
   9. Add worktree scripts using repo setup script.
   10. Add no-agent cron jobs with lockfiles.
   11. Run dry-run docs-only PR.
   12. Report results and stop before auto-merge unless branch protection is verified.

Proceed without asking further questions unless blocked by a missing credential, missing permission, unavailable command, or destructive action.
```

Bottom line: **approve implementation after this delta**. Ruflo is now initialized and useful, but it must remain a helper layer. Hermes Kanban owns work, Codex judges, DeepSeek implements, GitHub Actions gates, and Ruflo hooks support the lifecycle.
