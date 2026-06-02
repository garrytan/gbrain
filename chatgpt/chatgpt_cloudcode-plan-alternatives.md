---
title: "CloudCode Plan Alternatives"
type: essay
created: 2026-04-30
updated: 2026-04-30
source: chatgpt-export
conversation_id: 69f2ab12-66a4-83e8-ba85-a6757f944699
message_count: 13
tags: [chatgpt, import, code, long-form]
---
# CloudCode Plan Alternatives

> Conversation ID: 69f2ab12-66a4-83e8-ba85-a6757f944699
> Created: 2026-04-30T01:06:27Z
> Updated: 2026-04-30T02:21:05Z
> Messages: 13

---

## User

So, I just burned through my $200 CloudCode plan and my $200 Codex plan and one of my $20 accounts on Codex, and I've got to keep shipping tonight. What is the best option for me to do deep seek through like Open, or through an open router, or one of those, or do I use something else? Or do I just sign up for another $200 CloudCode plan or Codex plan? What do we think? What do we think is the move so I can keep shipping? I have a bunch of tasks that are like predefined with well-scoped issues that I basically just wanna like drop the plan files into a workspace, hit enter, let it run, go to the next workspace, and keep doing this. And I've got, you know, a bunch of these I gotta fire out tonight. What's my best option like cost-wise with like the new deep seek prices and stuff off of OpenRouter? Is that a viable option comparable to like GPT 5.4 or 5.5 or Opus 4.6 or 4.7? Yeah, help me out here.

---

## Assistant

Mr. White, I’ll verify current pricing and limits, then give you a practical tonight-only recommendation based on cost, throughput, and coding-agent quality.

---

## Assistant

DeepSeek via API routing is looking like the cost move for tonight; the remaining question is harness reliability and when to escalate retries or reviews to GPT/Claude.

---

## Assistant

Mr. White, the move tonight is **DeepSeek V4 Pro / V4 Flash on usage-based billing**, preferably through **OpenCode or Claude Code pointed at DeepSeek**, and keep GPT-5.5 / Opus for rescue passes.

Do **not** buy another $200 plan as the first move unless you specifically need native Codex/Claude cloud workflow. You already proved tonight’s workload can burn fixed-plan quotas. API/token billing gives you predictable marginal cost and no “wait for reset” problem.

## My recommendation

Use this stack:

**Primary worker:** DeepSeek V4 Pro  
**Cheap first-pass worker:** DeepSeek V4 Flash  
**Harness:** OpenCode, or Claude Code using DeepSeek’s Anthropic-compatible endpoint  
**Fallback / final reviewer:** GPT-5.5, GPT-5.4, or Opus 4.7 only for failed/hairy tasks

Current OpenRouter pricing is the main reason: **DeepSeek V4 Pro is listed at $0.435/M input and $0.87/M output**, with a 1M-token context window, and is explicitly aimed at coding, reasoning, and long-horizon agent workflows. **V4 Flash is $0.14/M input and $0.28/M output**, also with 1M context and positioned for fast, high-throughput coding-agent work. citeturn902479view0turn276902view1

DeepSeek’s own docs also say V4 Pro is currently discounted 75%, and input cache-hit pricing was cut to one-tenth of launch price as of April 26, 2026. citeturn315328view1

## Cost reality

For a fairly big agent run, say **300k input + 50k output**:

| Model | Approx cost/run |
|---|---:|
| DeepSeek V4 Flash | **$0.056** |
| DeepSeek V4 Pro on OpenRouter | **$0.174** |
| GPT-5.4 mini | **$0.45** |
| GPT-5.4 | **$1.50** |
| Claude Opus 4.7 | **$2.75** |
| GPT-5.5 | **$3.00** |

For a smaller **100k input + 20k output** run:

| Model | Approx cost/run |
|---|---:|
| DeepSeek V4 Flash | **$0.0196** |
| DeepSeek V4 Pro | **$0.0609** |
| GPT-5.4 mini | **$0.165** |
| GPT-5.5 | **$1.10** |

So $200 of DeepSeek V4 Pro credits can buy roughly **1,100+ large agent runs** at the 300k/50k shape, before retries/tool-loop waste. The same $200 at GPT-5.5 pricing buys roughly **66** of those runs.

OpenAI’s current API pricing is **GPT-5.5 at $5/M input and $30/M output**, **GPT-5.4 at $2.50/M input and $15/M output**, and **GPT-5.4 mini at $0.75/M input and $4.50/M output**. citeturn276902view2 Claude Opus 4.7 is **$5/M input and $25/M output**. citeturn315328view3

## Quality: is DeepSeek comparable?

For your described workload — **predefined, well-scoped issues where you drop a plan file into a workspace and let the agent execute** — **DeepSeek V4 Pro is viable**.

It is probably **below GPT-5.5 and Opus 4.7 for gnarly terminal-heavy autonomy**, but close enough on repo-level issue resolution that the cost delta dominates. One comparison reported **GPT-5.5 at 58.6% vs DeepSeek V4 Pro at 55.4% on SWE-bench Pro**, while GPT-5.5 had a much larger lead on **Terminal-Bench 2.0: 82.7% vs 67.9%**. Claude Opus 4.7 led SWE-bench Pro at **64.3%** in that same comparison. citeturn276902view4

That means:

**Use V4 Flash** for small, obvious tasks, scaffolding, search, cleanup, doc edits, simple PRs.

**Use V4 Pro** for normal feature work, multi-file edits, refactors, and test-fix loops.

**Use GPT-5.5 / Opus 4.7** when the task is failing repeatedly, involves tricky architecture, requires deep terminal/tool use, or is the final review before merge.

## Best setup tonight

### Option A — fastest if you want OpenRouter

Use **OpenCode + OpenRouter + DeepSeek V4 Pro/Flash**.

OpenCode supports OpenRouter directly: create an OpenRouter key, run `/connect`, select OpenRouter, then use `/models` to select the model. citeturn588791view0 OpenCode is also built for terminal/IDE agent work, supports multi-session operation, and can connect many providers. citeturn595272view1

Model names to try:

```text
deepseek/deepseek-v4-pro
deepseek/deepseek-v4-flash
```

### Option B — best if you like Claude Code muscle memory

DeepSeek officially documents using **Claude Code pointed at DeepSeek’s Anthropic-compatible endpoint**. The important env pattern is:

```bash
export ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic
export ANTHROPIC_AUTH_TOKEN=<your DeepSeek API key>
export ANTHROPIC_MODEL=deepseek-v4-pro[1m]
export ANTHROPIC_DEFAULT_OPUS_MODEL=deepseek-v4-pro[1m]
export ANTHROPIC_DEFAULT_SONNET_MODEL=deepseek-v4-pro[1m]
export ANTHROPIC_DEFAULT_HAIKU_MODEL=deepseek-v4-flash
export CLAUDE_CODE_SUBAGENT_MODEL=deepseek-v4-flash
export CLAUDE_CODE_EFFORT_LEVEL=max
```

Then run:

```bash
cd /path/to/project
claude
```

DeepSeek’s docs list that exact Claude Code integration flow. citeturn898538view0

This is probably the cleanest path if you were calling it “CloudCode” and meant **Claude Code**.

## Should you buy another Codex or Claude plan?

**Codex $200:** worth it only if you need the native Codex UX/cloud task flow. OpenAI’s current Codex docs say Pro $200 gives **20x Plus** usage on an ongoing basis and temporarily **25x Plus 5-hour Codex limits through May 31, 2026**. citeturn284742view0 But it is still quota/window-based, and you already hit the ceiling. OpenAI also says users who hit limits can buy credits or run extra local tasks with an API key at standard API rates. citeturn284742view0

**Claude Max $200:** same logic. Anthropic’s Max 20x plan is $200/month and gives 20x more usage than Pro, but it still has session and weekly limits, and Anthropic says it may apply other caps at its discretion. citeturn284742view2

So for tonight: **buying another subscription is the emergency fallback, not the efficient move**.

## The actual playbook

1. Put **$50–$100** into OpenRouter or direct DeepSeek.
2. Run **OpenCode or Claude Code → DeepSeek V4 Pro**.
3. Use **V4 Flash** for easy tasks and subagents.
4. Use **V4 Pro high/max effort** for the main implementation.
5. Save **GPT-5.5 / Opus 4.7** for failures, architecture questions, final diff review.
6. Run each task in a clean branch/worktree with tests before merge.

My call: **OpenRouter/OpenCode if you want one key and fallback flexibility; direct DeepSeek + Claude Code if you want the closest continuation of your Claude Code workflow.** Cost-wise, DeepSeek V4 Pro/Flash is the obvious move tonight.

---

## User

How does Kimi 4.6 compare? Because it's free in Windsurf right now.

---

## Assistant

I’ll verify what “Kimi 4.6” means inside Windsurf, then judge it for your actual plan-file shipping workflow against DeepSeek and premium rescue models.

---

## Assistant

Mr. White, I’m assuming you mean **Kimi K2.6** in Windsurf. For tonight: **yes, use it aggressively while it’s free.** It is probably the best immediate move for your use case.

Windsurf’s official account says **Kimi K2.6 is available free for two weeks for Pro, Teams, and Max users**. Windsurf docs also say model availability/pricing should be checked in the in-editor selector because that is the up-to-date source. citeturn377542search5turn162578view1

## The practical call

Use this routing:

1. **Kimi K2.6 in Windsurf** for the first attempt on every well-scoped task.
2. **DeepSeek V4 Flash** for cheap/easy external runs if you need more parallel throughput.
3. **DeepSeek V4 Pro** for paid fallback when Windsurf/Kimi stalls.
4. **GPT-5.5 / Opus 4.7** only for rescue, final review, or ugly failures.

If Kimi is truly free in your Windsurf account tonight, it beats every API option on cost.

## How Kimi K2.6 compares

Kimi K2.6 is legitimately strong for what you described: long-horizon coding, multi-file edits, frontend/full-stack generation, and autonomous agent loops. Moonshot describes it as a multimodal agentic model built for long-horizon coding, coding-driven design, autonomous execution, and swarm orchestration, with **1T total parameters, 32B active parameters, and 256K context**. citeturn511146view0

On Moonshot’s published benchmark table, Kimi K2.6 scores:

| Benchmark | Kimi K2.6 | GPT-5.4 xhigh | Claude Opus 4.6 max |
|---|---:|---:|---:|
| SWE-Bench Pro | **58.6** | 57.7 | 53.4 |
| Terminal-Bench 2.0 | **66.7** | 65.4 | 65.4 |
| SWE-Bench Verified | 80.2 | n/a | **80.8** |
| LiveCodeBench v6 | **89.6** | n/a | 88.8 |

Those are Moonshot-reported / Moonshot-collated numbers, so treat them as useful directional signal rather than gospel. Still, they are strong enough that Kimi K2.6 deserves to be in your first-pass shipping stack tonight. citeturn511146view1

## Cost comparison if it stops being free

This is where DeepSeek still wins.

Kimi’s official API lists **K2.6 at $0.95/M input and $4.00/M output**. OpenRouter currently lists Kimi K2.6 around **$0.7448/M input and $4.655/M output**. citeturn161303view6turn990251search3

DeepSeek V4 Pro on OpenRouter is listed at **$0.435/M input and $0.87/M output** with a **1,048,576-token context**, and V4 Flash is **$0.14/M input and $0.28/M output** with the same 1M-token context. citeturn105822search0turn105822search2

For a big agent run of **300K input + 50K output**:

| Option | Approx cost/run |
|---|---:|
| Kimi K2.6 in Windsurf promo | **$0** |
| DeepSeek V4 Flash | **$0.056** |
| DeepSeek V4 Pro | **$0.174** |
| Kimi K2.6 via OpenRouter | **$0.456** |
| Kimi K2.6 direct API | **$0.485** |
| Claude Opus 4.7 | **$2.75** |
| GPT-5.5 | **$3.00** |

OpenAI lists GPT-5.5 at **$5/M input and $30/M output**, while Anthropic lists Opus 4.7 at **$5/M input and $25/M output**. citeturn629196search0turn629196search2

## Kimi vs DeepSeek for your exact workflow

**Kimi K2.6 in Windsurf is the move when:**

You want to drop a plan into a workspace, let Cascade run, inspect the diff, and move to the next issue. It should be excellent for scoped tickets, UI work, glue code, refactors, docs, and multi-file implementation.

**DeepSeek V4 Pro is the move when:**

You need lower paid cost, longer context, or want to run multiple external agents outside Windsurf. DeepSeek’s 1M context is a meaningful edge over Kimi’s 256K when you are handing the model big plan files plus a lot of repo context.

**GPT-5.5 / Opus 4.7 are the move when:**

The cheap/open models get stuck, make repeated bad assumptions, break architecture boundaries, or fail tests after two passes.

## My final recommendation for tonight

Use **Kimi K2.6 in Windsurf as the first-pass workhorse**. It is free right now, benchmark-credible, and aligned with exactly the “well-scoped plan file → agent run → next workspace” workflow.

Keep **DeepSeek V4 Pro/Flash via OpenRouter or direct API** ready as your overflow lane. Once the Windsurf free window ends, DeepSeek becomes the better cost default. Kimi is more expensive than DeepSeek on paid API, especially output-heavy agent loops.

Your tonight routing should be:

```text
Easy/scoped issue → Kimi K2.6 in Windsurf
Simple repetitive issue → DeepSeek V4 Flash
Normal paid overflow → DeepSeek V4 Pro
Stuck / high-risk / final review → GPT-5.5 or Opus 4.7
```

The move: **hammer free Kimi in Windsurf first, spend DeepSeek credits second, preserve frontier-model quota for rescue.**

---

## User

It seems like we're starting to get to a point where we're at the bottom of the actuate, right where we're about to skyrocket and keep power, and basically where more and more of my sessions, like one of my sessions, just ran out of credits after it was at 261 minutes running. The sessions are getting better and better and better, and the agent's quality is going to the point that I confidently trust that the agent can fully execute on the plan, submit a PR, and then another agent can land that PR fully autonomously.

I'm usually running through a series of conversations in ChatGPT using deep research to ask it about new features or defensive features or hardening and stuff like that, to have it pull as much as it can. For example, if a new feature requires a calendar, I'll be like, "Deep research, find me everything you can on calendar UX." Here's ones that I like, and just tell me what the best of the best are and think of all the common things that go wrong, et cetera, et cetera. I let it run for like half an hour. I come back, I take that plan, I throw it into ChatGPT 5.5 pro with extended thinking. I ask it to basically take that and propose a plan and give me a prompt based off it. Take that, and I take that and throw it into a terminal and run the G-stack workflow with office hours. Talk through the feature, run that through the whole auto plan or the individual plans in G-stack, and then I take the final plan and I copy paste it back into ChatGPT 5.4 with extended thinking. I say, "Harden this plan, find all the flaws and then improve upon them," and then I take that final plan, and then I usually throw it into an agent and have it just run, okay.

I've done various things with using linear to orchestrate agents and stuff and all this shit. I've got wind surf and all these things. I just spun up windsurf with Kimmy 2.6, and I've got like 10 agents running in parallel on windsurf right now working on Talis for me. That's fucking great, right, because it's free. More and more, it seems like orchestrating things and stuff is becoming the norm, and so it feels like my day should really become, when it comes to coding, be spent coming in and extensively planning and then extensively Q&A and essentially talking to users in fundraising and marketing and stuff, and not actually coding for the most part.

How do we keep it so that these things keep running in the background? Are there things that we should be looking at that are basically? I've seen more and more cloud agents and automations and stuff like. What should I be looking into, and what should we be thinking about in terms of, like, should I just run 20 parallel agents on my machine all day long? Have them just continually pick up linear issues and run them, and then I just work exclusively by building plan files and then dumping the plan files into linear. I could literally work with an aramis agent or something and have it, like, extensively interview me to figure out what it is I want to accomplish, and then have it just go build plans and then put them into linear. Have another agent harden those plans and stuff like that, you know what I mean? Have another agent that we tag as needing research, and another agent that does deep research on it and shit.

I'm usually trying to think about all these things. I'm like, if there are better ways we should be doing this, and then also I'm looking at this open code and all these new things that are coming out. Deep sync is so cheap now and stuff, and I'm like, should we just be having a billion agents in with an aramis agent, or like I can effectively run an entire coding department now? It's like, you know what I mean? I'm just trying to think of what should be going on. I don't know. I just I'm getting a little FOMO that I'm not running enough operational efficiency right now. 

---

## Assistant

Mr. White, this is an operating-model problem now: throughput comes from issue quality, isolated execution, model routing, budget caps, and merge gates. I’ll map the current agent landscape into a concrete founder-run coding department workflow.

---

## Assistant

Mr. White, you are directionally right. The next leverage point is **agent operations**, not more manual coding. Your coding day should increasingly become:

```text
user insight / founder judgment
→ research brief
→ hardened implementation plan
→ Linear issue
→ agent execution
→ PR
→ CI + reviewer agents
→ merge / rollback
```

The move is to build a small **agent factory** around Linear + GitHub, with your local Windsurf/Kimi swarm as one execution lane.

## My call

For tonight:

**Keep running the free Windsurf Kimi swarm**, but isolate every task in a worktree/branch. Windsurf explicitly supports simultaneous Cascades, and its docs warn that two Cascades editing the same files can race; they recommend worktrees when edits may overlap. citeturn941116view0

For the next few days:

**Turn Linear into your production queue.** Linear now has an Agents surface for “artificial teammates,” supports delegating issues end-to-end, and has integrations for Codex, Cursor, GitHub Copilot, Factory, Sentry, Devin, and others. Linear also says agents are not billable Linear seats, though each agent provider has its own pricing. citeturn616390view3turn616390view4turn812906search6

For the longer-term system:

**Run a hybrid swarm: local agents for burst work, cloud agents for continuous background work, and reviewer agents for PR gates.**

## Do not optimize for “20 agents” first

Optimize for **agent-ready tickets**. Twenty bad tickets create twenty half-broken branches. Five excellent tickets can produce five mergeable PRs.

The new bottlenecks are:

```text
1. spec clarity
2. dependency ordering
3. branch isolation
4. test coverage
5. review/merge throughput
6. rollback safety
```

Agent count matters after those are in place.

## The architecture I would build

### 1. Linear becomes the issue queue

Every coding task should enter Linear with a consistent schema:

```md
# Goal
What should change?

# Non-goals
What should the agent avoid?

# Context
Relevant product/user/research background.

# Constraints
Design system, architecture, data model, security, perf, privacy.

# Expected files / areas
Likely files, components, APIs, tests.

# Acceptance criteria
Concrete pass/fail requirements.

# Test plan
Exact commands to run.

# Edge cases
Common failures, weird states, regressions.

# Rollback plan
How to safely revert or disable.

# PR instructions
Branch name, PR title format, screenshots, notes required.
```

Then use labels like:

```text
agent-ready
needs-research
needs-plan-hardening
needs-design-review
needs-security-review
safe-automerge
human-review-required
blocked-by:<issue>
```

GitHub’s own Copilot cloud-agent docs say an assigned issue should be treated like a prompt, and recommend starting with simpler tasks such as bugs, UI changes, test coverage, docs, accessibility, and tech debt before broad/domain-heavy work. citeturn616390view8

### 2. Add specialized planning agents before implementation agents

Your current workflow is already good:

```text
Deep Research
→ frontier model planning
→ G-stack / office-hours planning
→ hardening pass
→ implementation agent
```

Turn that into roles:

| Role | Job | Model/tool |
|---|---|---|
| Researcher | Pull UX patterns, failure modes, competitor references | ChatGPT Deep Research / Gemini / Perplexity-style research |
| Spec writer | Convert research into an implementation-ready issue | GPT-5.5 / Claude / Codex |
| Plan hardener | Find missing cases, test gaps, architectural risks | GPT-5.4 / GPT-5.5 / Opus |
| Implementer | Build branch and PR | Kimi/Windsurf, Cursor, Codex, OpenCode+DeepSeek, Jules |
| Reviewer | Critique diff, tests, security, regressions | Codex review, Claude Code Action, GPT-5.5 |
| Merger | Land only low-risk PRs after gates pass | GitHub merge queue / bot |

The valuable part is the **handoff artifact**, not the chat transcript. Every planning stage should emit a cleaner Linear issue or `PLAN.md`.

### 3. Use multiple execution lanes

I would run these lanes in parallel:

| Lane | Use for | Notes |
|---|---|---|
| **Windsurf + Kimi K2.6** | First-pass implementation while free | Best immediate marginal cost: $0 |
| **OpenCode + DeepSeek V4 Pro/Flash** | Cheap overflow agent work | OpenCode supports GitHub issue/PR workflows via `/opencode` or `/oc`, and can run inside GitHub Actions. citeturn616390view0 |
| **Cursor Background Agent + Linear** | Linear-native ticket-to-PR | Cursor’s Linear integration lets you assign `@Cursor`, pull issue context, run background agents, and open PRs. citeturn965831view1 |
| **GitHub Copilot Cloud Agent** | GitHub-native background work | It runs in an ephemeral GitHub Actions-powered environment, can research, plan, edit, test, branch, and open one PR per task. citeturn616390view7 |
| **Codex Cloud / Codex Action** | Review, repeatable CI jobs, cloud tasks | Codex cloud supports `@codex` from issues/PRs, and the Codex GitHub Action can run prompts, apply patches, or post reviews from workflows. citeturn616390view5turn616390view6 |
| **Jules** | Async cloud implementation / scheduled sweeps | Jules integrates with GitHub, works autonomously, and has an API/SDK for running cloud sessions and creating PRs. citeturn965831view4turn965831view6turn965831view7 |
| **Factory / Codegen / Devin** | Managed “AI dev team” trials | Factory, Codegen, and Devin all have Linear-native ticket-to-PR workflows. citeturn965831view2turn965831view3turn965831view8 |

DeepSeek remains the paid overflow value king. OpenRouter lists DeepSeek V4 Pro with a 1,048,576-token context window at **$0.435/M input and $0.87/M output**, aimed at long-horizon agent workflows; DeepSeek’s own docs say V4 Pro is under a 75% discount and cache-hit pricing was cut heavily. citeturn838288search8turn838288search3

## Local swarm vs cloud swarm

### Local swarm is good for tonight

Use your machine as a burst pool:

```text
10 Windsurf/Kimi workspaces
+ 2–4 OpenCode/DeepSeek terminals
+ 1 frontier review window
```

Rules:

```text
one issue = one worktree = one branch = one PR
no two agents share a worktree
no two agents touch the same high-risk subsystem at once
every agent gets an exact PLAN.md
every agent must run tests before PR
```

### Cloud swarm is better for all-day operation

Your laptop is a weak orchestrator. It sleeps, crashes, hits IDE limits, loses state, and encourages ad hoc supervision.

Cloud agents give you:

```text
ephemeral workspaces
background execution
GitHub/Linear status updates
PR creation
CI integration
audit trail
less local babysitting
```

GitHub Copilot cloud agent specifically runs in a GitHub Actions-powered ephemeral environment and exposes metrics such as PRs created, PRs merged, and median time to merge. citeturn616390view7

## The merge policy

Let agents create PRs freely. Let agents review PRs aggressively. Let agents auto-merge only the lowest-risk classes.

Use three risk classes:

| Class | Examples | Merge rule |
|---|---|---|
| **A — safe** | docs, copy, tests, lint, small UI polish, telemetry labels | Auto-merge after CI + reviewer agent |
| **B — controlled** | isolated feature behind flag, non-critical refactor, simple API addition | Auto-merge only after CI + reviewer agent + no risky files |
| **C — founder/human gate** | auth, billing, data deletion, permissions, migrations, prod infra, privacy, security | Human approval required |

This lets you get real autonomy without handing production safety to a single agent pass.

## The PR review stack

Every agent PR should trigger:

```text
1. typecheck
2. unit tests
3. integration/e2e tests where relevant
4. lint
5. visual/screenshot check for UI
6. security/static scan for sensitive areas
7. AI reviewer pass
8. issue acceptance-criteria checklist
```

Codex Action is useful here because it can run as a GitHub Action, use a prompt or prompt file, and post review output back to the PR. Its docs also emphasize sandbox and permission controls, including a default `drop-sudo` strategy and explicit warnings around unsafe runner privileges. citeturn321203view0

## What I would set up this week

### Day 1: Standardize the plan artifact

Create:

```text
/plans/templates/agent-plan.md
.github/copilot-instructions.md
AGENTS.md
```

Windsurf supports `AGENTS.md` for context-aware instructions, and OpenCode supports specialized primary agents/subagents with configurable prompts, models, and tool access. citeturn939287search7turn616390view1

Your `AGENTS.md` should include:

```md
- Never broaden scope beyond the issue.
- Do not change auth, billing, or data deletion flows unless the issue explicitly allows it.
- Prefer small, reviewable diffs.
- Run the exact test command listed in the issue.
- Add or update tests for changed behavior.
- If acceptance criteria are ambiguous, stop and ask.
- Summarize changed files, tests run, and unresolved risks in the PR.
```

### Day 2: Wire Linear to agent lanes

Install or trial:

```text
Cursor Linear agent
GitHub Copilot cloud agent
Codex / GitHub Agent HQ if available in your plan
Factory or Codegen trial
Devin only for expensive/high-autonomy comparisons
```

Linear’s agent integrations page is already designed around this exact motion: “turn issues into pull requests” across Cursor, Copilot, Factory, Sentry, Devin, and Codex. citeturn812906search6

### Day 3: Add GitHub Action reviewer agents

Start with:

```text
Codex PR reviewer
optional Claude reviewer
optional OpenCode reviewer
security-specific reviewer for sensitive diffs
```

OpenCode can run from GitHub issues and PRs through GitHub Actions, while Codex Action is explicitly designed for repeatable CI/CD jobs, code review, release prep, and migration workflows. citeturn616390view0turn616390view6

### Day 4: Build the dispatcher

This can be simple:

```text
Linear issue labeled agent-ready
→ dispatcher picks provider
→ creates branch/worktree/cloud task
→ posts “started” comment
→ agent opens PR
→ reviewer workflows run
→ Linear status updates
```

Provider routing:

```text
docs/tests/simple UI        → Kimi / DeepSeek Flash
normal feature              → Kimi / Cursor / DeepSeek Pro
complex backend             → Codex / Claude / DeepSeek Pro
gnarly architecture         → GPT-5.5 / Opus / human pass
production bug from Sentry  → Sentry agent / Codex / Cursor
```

## The daily operating model

Your day should look like this:

```text
Morning:
- Review dashboard: open agent PRs, failures, blocked issues.
- Merge safe PRs.
- Pick 5–15 issues to make agent-ready.

Midday:
- User calls, fundraising, marketing, product thinking.
- Research/spec agents run in background.

Afternoon:
- Harden plans.
- Assign issues to agents.
- Review only exceptions and high-risk diffs.

Night:
- Let low-risk backlog agents run.
- Scheduled agents handle tests, docs, cleanup, tech debt.
```

The big unlock is moving from “I prompt agents” to “I maintain a queue of executable specs.”

## The metrics to track

Create a weekly scoreboard:

```text
agent PRs opened
agent PRs merged
merge rate by agent/tool/model
average time to PR
average time to merge
human interventions per PR
CI pass rate on first attempt
revert rate
bugs introduced
cost per merged PR
```

This tells you which agents deserve more of the queue. Without this, you’ll overtrust whatever felt magical last night.

## My recommended stack

### Immediate stack

```text
Planning: ChatGPT Deep Research + GPT-5.5 / GPT-5.4 hardening
Queue: Linear
Local execution: Windsurf + free Kimi K2.6
Cheap overflow: OpenCode + DeepSeek V4 Pro/Flash via OpenRouter/direct
Review: Codex/GPT-5.5/Claude reviewer
Source control: GitHub PRs + CI + branch protections
```

### Serious “AI coding department” stack

```text
Linear = command center
GitHub = execution/review/merge system
Windsurf/Kimi = local burst workers
Cursor/Copilot/Codex/Jules = cloud workers
OpenCode+DeepSeek = cheap programmable worker pool
Factory/Codegen/Devin = managed autonomous-worker experiments
Sentry = production bug intake
Reviewer agents = quality gate
```

## The FOMO answer

The FOMO is valid around **operational system design**. The FOMO is less valid around simply having more agents running.

Your advantage comes from:

```text
better specs
faster issue decomposition
more isolated execution
more automated review
more disciplined merge rules
more feedback from users
```

Run 20 agents when you have 20 clean, independent, agent-ready issues. When you have 5 excellent issues, run 5 agents and spend the saved attention creating the next 15 excellent issues.

My move: **use free Kimi hard tonight, build Linear as the agent queue this week, wire GitHub Actions reviewer/CI gates, and graduate from local swarm to cloud swarm as soon as the queue format is stable.**

---

## User

Okay, good, good talk. The plan for tonight then is just going to be to max out this kidney as much as I can. I'm firing off a million agents on it. It's actually running far more efficiently than anything I've run simultaneously on this machine. The only thing is that they occasionally seem to just crash and stop, and then I've got to manually restart them, which is annoying, so I'm wondering if there's any way around that.

The first thing is that I'd love to have these agents just fucking keep going. Is there a way in Windsurf to cron them or whatever so that they pick up every 5 min or something and, if they stop, they resume automatically? Using the /loop command and ClockCode.

The other one would be: can you write me a prompt that I can throw one of these that recursively goes through and finds it, just QA the whole thing? It runs the QA command with the exhaustive flag from g-stack on the public profiles and doesn't stop until it's done. At the end, it runs /review and /ship and splits in the PRs if it needs to split into multiple PRs and then /ships and lands all the PRs. 

---

## Assistant

Mr. White, I’ll separate this into keeping Windsurf/Cascade agents alive automatically and a paste-ready QA-to-ship prompt. I’ll verify the current automation surface before recommending anything brittle.

---

## Assistant

Mr. White, tonight’s move is:

```text
Windsurf/Kimi = maxed-out execution swarm
Claude Code /loop = watchdog-style long-running maintenance agent
GitHub/CI = the actual merge gate
```

## 1. Keeping the agents alive

### Windsurf-native answer

Windsurf has **Auto-Continue**, and you should turn it on. Cascade has a 20-tool-call cap per prompt; when it hits that limit, Auto-Continue can automatically continue the trajectory, consuming another prompt credit. citeturn107063view0

Windsurf also has **Turbo** auto-execution for terminal commands, plus allow/deny lists. For tonight, set Cascade command execution to **Turbo** or **Allowlist Only** with the commands you expect it to run. citeturn514321view0

Windsurf does **not** appear to have a native “cron this stopped Cascade every 5 minutes and click continue/restart if dead” feature. Its reusable **Workflows are manual-only**, and Windsurf explicitly says Cascade will never invoke a workflow automatically. citeturn909626view0

So the Windsurf-native setup is:

```text
Auto-Continue: ON
Command execution: Turbo or Allowlist Only
Worktree mode: ON for every agent
Agent Command Center: use it to monitor stuck/blocked sessions
```

Windsurf’s Agent Command Center is specifically meant to manage local and cloud agents in one Kanban-style view, including local Cascade sessions and cloud Devin sessions. citeturn995109view0

### Important worktree limit

If you are using Windsurf worktrees, each workspace can have **up to 20 worktrees**, and Windsurf cleans up older worktrees as new ones are created. citeturn909626view1

So do this:

```text
10–16 parallel Windsurf/Kimi agents = good
20+ in one workspace = risk of cleanup / mess
More than 20 = split across separate cloned repos / workspaces
```

## 2. The better watchdog pattern: Claude Code `/loop`

Claude Code now has the thing you actually want: `/loop [interval] [prompt]`. It runs a prompt repeatedly while the session stays open; `/loop 5m check if the deploy finished` is literally the example in the docs. citeturn688810view1

Claude Code also has `/schedule`, aliased as `/routines`, for scheduled routines, and `/resume` / `/continue` for resuming sessions. citeturn688810view2

Use this inside a Claude Code terminal:

```text
/loop 5m Run the public-profiles QA loop from .claude/loop.md. Continue until exhaustive QA passes, PRs are reviewed, CI is green, and low-risk PRs are shipped.
```

Or make it cleaner:

```bash
mkdir -p .claude
touch .claude/loop.md
```

Then put the QA prompt below into:

```text
.claude/loop.md
```

and run:

```text
/loop 5m
```

Claude Code also supports CLI resume:

```bash
claude -c
claude -c -p "Check for type errors"
claude -r "session-name" "Finish this PR"
```

Those are documented CLI modes for continuing or resuming sessions. citeturn662976view0

## 3. The prompt to paste into Windsurf/Kimi

Use this as the “QA everything, keep going, review, ship” prompt.

```md
You are the autonomous QA + fix + PR shipping agent for this workspace.

Your mission is to recursively QA the entire public profiles surface, fix every issue you can safely fix, run the exhaustive g-stack QA command, review the final diff, split into multiple PRs if needed, and ship only when the acceptance gates are satisfied.

## Scope

Primary scope:
- Public profiles
- Public profile rendering
- Public profile routing
- Public profile data loading
- Public profile privacy / visibility behavior
- Public profile empty states
- Public profile owner vs viewer behavior
- Public profile mobile/responsive behavior
- Public profile SEO / metadata behavior, if applicable
- Any tests, fixtures, mocks, or docs required to validate the above

Out of scope unless required to fix a public-profiles failure:
- Auth architecture
- Billing
- Data deletion
- Production infrastructure
- Database migrations
- Broad unrelated refactors
- Design-system rewrites
- Anything that changes permissions or privacy behavior without explicit test coverage

## Operating rules

Do not stop after the first failure. Continue until the exhaustive QA command passes or you hit a true external blocker.

Do not guess the g-stack command. First locate the canonical command by searching:
- package.json scripts
- Makefile
- justfile
- g-stack docs
- scripts/
- README / developer docs
- existing plan files
- existing slash commands or workflows

Find and run the canonical g-stack QA command for public profiles using the exhaustive flag. If there are multiple plausible commands, choose the safest/most comprehensive one and record the exact command used.

Expected command shape may be something like:

```bash
g-stack qa public-profiles --exhaustive
```

but do not assume that exact command if the repo defines something different.

## Required loop

Repeat this loop until green:

1. Inspect current branch and working tree:
   - `git status`
   - `git branch --show-current`
   - `git diff --stat`
   - identify whether this branch already has agent changes

2. Discover the public profiles surface:
   - find relevant routes/pages/components/loaders/actions/API endpoints
   - find tests and QA scripts
   - find fixtures/mocks
   - find known TODOs or failing tests
   - find docs or plan files relevant to public profiles

3. Run the exhaustive public profiles QA command.

4. Capture every failure:
   - command
   - error output
   - affected file/test
   - suspected root cause
   - proposed fix

5. Fix failures in the smallest coherent batches.
   - Prefer surgical changes.
   - Preserve existing architecture.
   - Do not broaden scope.
   - Add or update tests for changed behavior.
   - Avoid snapshot churn unless the UI intentionally changed.

6. Re-run the relevant narrow test after each fix.

7. Re-run the exhaustive public profiles QA command.

8. Continue until the exhaustive command passes.

## QA requirements

Before declaring done, run all of the following if available in this repo:

- exhaustive g-stack QA for public profiles
- typecheck
- lint
- unit tests touching public profiles
- integration/e2e tests touching public profiles
- build
- any visual/screenshot checks relevant to public profiles
- any accessibility checks relevant to public profiles

If a command is unavailable, note that clearly in the final summary. Do not invent commands.

## Review phase

After QA is green:

1. Run `/review` if available.
2. If `/review` is not available as an executable workflow/command, perform an equivalent manual review:
   - inspect `git diff`
   - inspect changed files
   - check for unrelated changes
   - check for privacy/security regressions
   - check for flaky tests
   - check for overbroad refactors
   - check that public profile viewer/owner states are correct
   - check that empty/error/loading states are handled
   - check that mobile/responsive behavior is covered where applicable

3. Fix every legitimate issue found by review.
4. Re-run exhaustive QA after review fixes.

## PR splitting rules

Create one PR if the diff is cohesive.

Split into multiple PRs if:
- the diff mixes unrelated fixes
- test infrastructure changes are separable
- UI fixes and backend/data fixes are separable
- the PR would be too large to review cleanly
- some changes are safe to ship immediately and others need review

Suggested split pattern:

1. public-profiles-qa-tests
2. public-profiles-functional-fixes
3. public-profiles-ui-polish
4. public-profiles-hardening

Only split if it reduces risk or improves reviewability.

## Shipping rules

After final QA is green:

1. Create clean commits with clear messages.
2. Create PR(s) with:
   - concise title
   - summary
   - tests run
   - exact exhaustive QA command used
   - screenshots or notes if UI changed
   - risk assessment
   - rollback note

3. Run `/ship` if available.

4. If `/ship` is not available, use the repo’s standard shipping process:
   - push branch
   - create PR with `gh pr create`
   - wait for CI
   - if CI fails, fix and re-run
   - if CI passes and the PR is low-risk, merge using the repository’s normal merge strategy
   - do not bypass branch protection
   - do not force-push over other people’s work
   - do not merge if CI is failing
   - do not merge if review reveals auth, billing, privacy, data deletion, migration, or prod infra risk

5. If multiple PRs are created, land them in dependency order.

## Blocking condition

Only stop before completion if:
- required credentials are unavailable
- a command requires human approval outside the available tools
- CI/provider outage blocks progress
- the fix requires product judgment
- the change touches high-risk auth/billing/privacy/data-deletion/migration/prod-infra code
- the repository has no discoverable public profiles QA command and no safe equivalent can be inferred

If blocked, provide:
- exact blocker
- what was tried
- current branch
- changed files
- failing command/output
- next recommended human action

## Final output

At the end, provide:

- Branch name(s)
- PR URL(s)
- Whether PRs were shipped/merged
- Exact QA commands run
- Final QA result
- Files changed
- Summary of fixes
- Any residual risks
- Anything that needs human review
```

## 4. Claude Code `/loop` version

Put this in:

```text
.claude/loop.md
```

```md
Run the autonomous public-profiles QA loop.

First check whether there is already an open branch or PR for this session. If yes, continue from there. If no, create a branch named `agent/public-profiles-qa`.

Find the canonical g-stack public-profiles QA command with the exhaustive flag by inspecting repo scripts, docs, Makefile, justfile, package.json, g-stack config, and existing workflows. Do not invent the command.

Run exhaustive QA. For every failure, fix it surgically, run the narrow relevant test, then re-run exhaustive QA. Continue until exhaustive QA passes or a true external blocker is reached.

After exhaustive QA passes:
- run `/review` if available
- otherwise perform a full manual diff review
- fix legitimate review findings
- re-run exhaustive QA

Then prepare PR(s). Split into multiple PRs only if the changes are separable and splitting reduces risk. Each PR must include summary, tests run, exact QA command, risk assessment, and rollback note.

Run `/ship` if available. Otherwise push branch, create PR(s), wait for CI, fix failures, and merge only if CI is green and repo protection rules allow it.

Never bypass CI. Never force merge. Never touch auth, billing, data deletion, migrations, production infrastructure, or privacy-sensitive behavior unless the QA failure directly requires it and the fix is covered by tests.

At the end of each loop iteration, report:
- current branch
- current PR URL if any
- last QA command
- pass/fail status
- files changed
- next action
```

Then run:

```text
/loop 5m
```

## 5. Minimal Windsurf workflow file

Save this as:

```text
.windsurf/workflows/qa-public-profiles-ship.md
```

```md
# QA Public Profiles and Ship

## Description

Run exhaustive public profiles QA, fix all failures, review the diff, split PRs if needed, and ship once green.

## Steps

1. Inspect git status, current branch, existing PRs, and current diff.

2. Find the canonical g-stack public profiles QA command with the exhaustive flag. Search package scripts, Makefile, justfile, docs, scripts, and g-stack configuration. Do not invent the command.

3. Run the exhaustive public profiles QA command.

4. For every failure:
   - identify root cause
   - fix surgically
   - add/update tests
   - run narrow test
   - re-run exhaustive QA

5. Continue until exhaustive QA passes or there is a true external blocker.

6. Run review:
   - invoke `/review` if available
   - otherwise manually review the full diff for regressions, unrelated changes, privacy risk, auth/billing/data risk, flaky tests, and overbroad refactors

7. Fix review findings and re-run exhaustive QA.

8. Split PRs only if the diff contains separable changes.

9. Ship:
   - invoke `/ship` if available
   - otherwise push branch, create PR, wait for CI, fix failures, and merge only if CI is green and branch protections allow it

10. Final summary:
   - branch
   - PR URL
   - tests run
   - exact exhaustive QA command
   - files changed
   - risks
   - shipped/merged status
```

Windsurf workflows are invoked manually with slash commands and are stored in `.windsurf/workflows/*.md`. citeturn909626view0

## 6. My recommended tonight setup

Use this operating pattern:

```text
Windsurf/Kimi:
- first-pass feature agents
- one worktree per issue
- Auto-Continue ON
- Turbo/Allowlist command execution
- max ~16–20 agents per workspace

Claude Code:
- one watchdog QA loop
- /loop 5m using .claude/loop.md
- owns exhaustive QA + review + shipping

GitHub:
- CI is the merge gate
- branch protection stays on
```

The real answer: **Windsurf can keep going better with Auto-Continue, but Claude Code is the better cron/loop/watchdog tool.** For tonight, let Kimi crank through implementation and give Claude Code the boring “every 5 minutes, check, QA, fix, ship” supervisor role.


## See Also
- [[chatgpt/chatgpt_affordable-sunglasses-alternatives]]
- [[chatgpt/chatgpt_alternatives-to-genius-shots]]
- [[chatgpt/chatgpt_better-alternatives-to-fastlane]]
- [[chatgpt/chatgpt_better-key-organizer-alternatives]]
- [[chatgpt/chatgpt_birthday-cake-alternatives]]
