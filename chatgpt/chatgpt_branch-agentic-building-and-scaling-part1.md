---
title: "Branch · Agentic Building and Scaling"
type: essay
created: 2026-05-08
updated: 2026-05-08
source: chatgpt-export
conversation_id: 69fe72bb-4a68-83e8-ab4d-2bb9641399d9
message_count: 14
tags: [chatgpt, import, code, long-form]
---
# Branch · Agentic Building and Scaling

> Conversation ID: 69fe72bb-4a68-83e8-ab4d-2bb9641399d9
> Created: 2026-05-08T23:33:18Z
> Updated: 2026-05-08T23:54:40Z
> Messages: 14


can we use kilocode and code supernova inside of our stack for our agentic building, how would that compare to, which is supposedly free? Would we be able to just use that for free throughput and basically have our agentic building system, with the hub and everything, basically just do a cost management thing? For anything that's worth it, it sends it through our codex subscription or a Claude Code subscription. When it needs to build without that, it sends it through kilocode and code supernova because it's free. Anything that's passable through that we could just do that, and then we have basically infinite scaling. 


I’ll verify what Kilo Code and Code Supernova currently offer, including pricing, limits, and terms, then map the practical routing architecture and risks.


Mr. White, yes, **Kilo can be part of the stack**, but **Code Supernova specifically is no longer the free throughput answer**. Kilo’s own blog says Code Supernova was removed from Kilo Code on **October 27, 2025**. The current option is Kilo’s free-model routing, especially `kilo-auto/free`, plus any individually labeled free models. citeturn797037view0turn629613view3

The practical answer: **use Kilo as a cheap/free execution lane, not as an infinite scaling lane.**

### What works

Kilo is useful for your hub because it has both a coding agent and a gateway. Kilo Gateway is an OpenAI-compatible API that can route across many models, supports BYOK, usage tracking, org controls, provider restrictions, and per-user daily spending limits. That fits your “hub routes jobs based on cost/value” idea well. citeturn686369view0

Kilo CLI is also usable in an agentic build stack. It supports terminal-based agentic coding, `kilo run`, `kilo serve`, `kilo models`, `kilo stats`, custom agents, MCP, and model selection. That gives you both API-style routing and command-line automation options. citeturn187479view0turn187479view2

### The catch

Kilo Code itself is free/open-source, but model inference is usually billed separately unless you choose free models. Kilo’s pricing page says the agent is free, while AI usage is billed separately; its docs say free-model availability changes over time, some free models are upstream-rate-limited, and `Auto Free` can route prompts to providers that log prompts/outputs and may use them to improve services. Kilo specifically warns against sending personal or confidential data through `Auto Free`. citeturn797037view1turn629613view3

Also, anonymous Kilo Gateway access to free models is limited to **200 requests per hour per IP**, so it is explicitly not unlimited anonymous throughput. citeturn686369view1

### Recommended architecture

Use a **model router** with four lanes:

| Lane | Use for | Provider |
|---|---|---|
| **Free / disposable** | scaffolding, tests, docs, throwaway components, isolated frontend chunks | Kilo free models / `kilo-auto/free` |
| **Cheap paid** | routine implementation after a clear plan | Kilo Gateway cheap models / BYOK |
| **Premium build** | high-value feature work, complex diffs, production PRs | Codex / Claude Code |
| **Premium review** | security, auth, payments, infra, deploy-critical code | Codex / Claude / another strong reviewer |

The best pattern is **planner → cheap/free builder → premium reviewer**. Kilo itself recommended a similar hybrid approach after Supernova shut down: use a cheap stronger model for planning and a fast/free model for implementation, especially for larger changes. citeturn629613view0

### How this compares to Codex and Claude Code

Codex and Claude Code are better treated as **premium execution/review lanes**. Codex is included with ChatGPT Plus, Pro, Business, and Enterprise/Edu plans, with Pro tiers offering much higher usage allowances; OpenAI also has Codex-only seats for Business/Enterprise with no rate limits and token-based pay-as-you-go billing. citeturn366551view1turn366551view2turn366551view3

Claude Code is included with Claude Pro and Max, and Anthropic says Pro/Max users can use Claude Code through the same subscription. Anthropic’s pricing lists Pro at $20/month monthly and Max from $100/month, with 5x or 20x more usage than Pro; Anthropic also doubled Claude Code’s five-hour rate limits for Pro, Max, Team, and seat-based Enterprise plans on May 6, 2026. citeturn366551view4turn552762view0turn366551view5

### My recommendation

Build the hub exactly as you described, with one adjustment:

**Do not base the business model on “free = infinite.” Base it on “free/cheap first, premium only when value or risk justifies it.”**

The routing policy should escalate to Codex/Claude when any of these are true:

1. touches auth, billing, permissions, data privacy, infra, production deploys, or database migrations;
2. free/cheap model fails tests twice;
3. diff exceeds a size threshold;
4. task requires architecture, ambiguous product judgment, or cross-file reasoning;
5. output confidence is low or reviewer flags issues;
6. code will ship to customers without a human rewrite.

For Jovie, I’d use Kilo free models only for **non-sensitive disposable build tasks** and keep all repo-sensitive, customer-sensitive, or production-grade work on paid/BYOK lanes. That gives you large cost savings without betting the company on unstable free inference.


Now, I just saw Kilo Code and I discovered it, and I thought it was interesting. I thought that CodeSupernova was free because I saw a blog post, but I just checked and you're right: that is from September of 2025. Is the new one any good? Are any of the ones any good?

I don't know if we buy anything using Kilo Code. We already have Air Me's agent, and I don't know if this is better or not. For coding, we have Claude Code for our subscription to Codec CLI. When we don't use Claude Code or Codec CLI, I think that there's now free Claude Code too and the ways to use Claude Code with open router and stuff. I don't even know unless it's specifically better. If it's better, I'm down to use it. I want to use the best product. Specifically, what I was interested in is a free model because I'm looking for free models that we can use to get more throughput when our subscriptions are down. It's generally my interest right now. That's what I was thinking of. 


I’ll separate this into whether Kilo Code is better than your current coding tools and whether its free-model lane is useful for overflow throughput.


Mr. White, I’d add Kilo as an **overflow/free-model lane**, not as the main coding system.

Your primary build lane should stay **Claude Code + Codex CLI** for valuable production work. Kilo becomes useful when the task is low-risk, sanitized, testable, and you mainly want extra attempts without burning premium subscription capacity.

## Are the new free models any good?

Yes, some are worth testing. The best current Kilo free candidates look like:

| Model / route | My take |
|---|---|
| `kilo-auto/free` | Best default. Lets Kilo choose the current free model pool. |
| Step 3.5 Flash | Most interesting free Kilo candidate right now. Kilo ranks it highly for code/debug/plan modes and explicitly says it is free in Kilo. |
| Ling-2.6-1T | Strong Kilo leaderboard presence, especially plan/review/debug. |
| Laguna M.1 | Coding-agent-specific free candidate. |
| Hy3 Preview | Worth testing for cheap/free agentic workflows. |
| Nemotron 3 Super / Trinity Large Thinking | Listed in Kilo’s free model docs; useful as overflow experiments. |
| OpenRouter free route | Useful as a generic fallback, with meaningful limits. |

Kilo’s own leaderboard currently ranks Step 3.5 Flash #1 for Code mode, Ling-2.6-1T #2, and shows several free models among top mode rankings; Kilo also labels Step 3.5 Flash as “free to use in Kilo.” Treat that as a promising signal from Kilo’s ecosystem rather than independent proof. citeturn621817view3turn621817view0

The more conservative independent view is: free/open-weight models have become useful, but closed frontier models still generally outperform on harder SWE-bench Verified tasks, especially 15–60 minute coding tasks. Vals notes that SWE-bench Verified measures real GitHub issue patching in isolated Docker containers, and that closed-source models still show a clear performance edge overall. citeturn826258view4

## The main catch

Kilo’s free tier is real, but it is not unlimited. Kilo says `kilo-auto/free` dynamically selects from curated free models, and Kilo’s own architecture docs say Free quality is lower than Frontier or Balanced and uses one free model per session rather than mode-specific routing. citeturn295024view3

Kilo free models are also rate-limited. Kilo’s Gateway docs say free model requests are capped at **200 requests per hour per IP**, and Kilo warns that free endpoints such as NVIDIA’s may log prompts/outputs and should not receive personal or confidential data. citeturn295024view1turn295024view2

## OpenRouter free models

OpenRouter is useful as a second overflow path, especially for API-style routing. It has `:free` model variants and a Free Models Router. The router chooses from available free models, but selection can be random unless you target a specific `:free` model, and OpenRouter warns that availability, latency, and limits vary. citeturn313309view1turn313309view2

OpenRouter’s free limits are clear: `:free` models allow up to **20 requests/minute**, with **50 free-model requests/day** if the account has bought less than 10 credits, and **1000/day** after buying at least 10 credits. That makes it an overflow lane, not infinite throughput. citeturn313309view0

## “Free Claude Code” via OpenRouter

This is mostly a YouTube/tutorial meme, not a reliable production strategy. Anthropic’s docs say Claude Code requires a **Pro, Max, Team, Enterprise, or Console account**; the free Claude.ai plan does not include Claude Code access. citeturn976846view0

OpenRouter can sit between Claude Code and Anthropic, but OpenRouter’s own docs say Claude Code compatibility is only guaranteed with Anthropic’s first-party provider, and Claude Code is optimized for Anthropic models and may not work correctly with other providers. citeturn313309view3

## Should you buy anything from Kilo?

I would not buy Kilo Pass yet.

Use Kilo Code free first. Kilo Code itself is free/open-source, while AI inference is billed separately unless you use free models or BYOK. citeturn236277view3

The reason to use Kilo is **model flexibility**, not raw model superiority. Kilo Gateway gives you BYOK, model allowlists, provider restrictions, per-user spending limits, usage tracking, and 500+ model access. That fits your hub/cost-management architecture well. citeturn295024view0turn295024view1

## Recommended setup for Jovie

Use this routing policy:

| Lane | Use for | Tool/model |
|---|---|---|
| **Free disposable** | tests, docs, small components, simple refactors, scaffold code, isolated utilities | Kilo `kilo-auto/free`, selected Kilo free models, OpenRouter `:free` |
| **Cheap paid** | routine implementation where failure is acceptable | Kilo Balanced, Qwen/GLM/MiniMax/Kimi/DeepSeek-type models |
| **Premium build** | production features, ambiguous product work, multi-file changes | Claude Code / Codex CLI |
| **Premium review** | auth, billing, permissions, DB migrations, infra, security, customer-facing deploys | Claude Code / Codex CLI, preferably second-model review |

The rule should be: **free models can draft; premium models decide and review.**

## My concrete recommendation

Install Kilo Code and wire it into the hub as an optional executor. Do not route proprietary customer data, secrets, auth flows, payment code, production migrations, or sensitive repo context through `kilo-auto/free`.

Run a bakeoff with 20–30 Jovie tasks:

1. 10 low-risk tasks: tests, docs, UI copy, simple components.
2. 10 medium tasks: bug fixes, refactors, integration helpers.
3. 5 hard tasks: multi-file feature or production bug.

Compare Air Me’s agent, Kilo `kilo-auto/free`, one manually selected Kilo free model like Step 3.5 Flash, OpenRouter free, Claude Code, and Codex CLI. Track pass rate, number of attempts, test success, human cleanup time, and whether the diff is shippable.

My expected outcome: **Kilo free models will be useful for 20–40% of low-risk throughput, occasionally surprisingly good, and unreliable for the work you actually care about.** That still makes them valuable because they reduce premium burn and give your hub a real free overflow lane.


I also would wonder, when it comes to free stuff, if there is a world in which, because it's free, you basically have tasks that are potentially too complicated for a free model. We throw the free model at them. The plan is made by a frontier model. The frontier model judges the work, then throws out the work because it would cost us anything to make rewrites, then throws it to the agent again, and then aging home, you know. It just kind of does that, and it could even then do that with two or three models and then just pick the best one or something like that kind of shit. Is that worth doing, and then putting a self-improving cycle on it, where it kind of, as it's writing this plan, gets just better at plan writing? And then, as we're starting to think about this stuff, I start to wonder about our orchestration system and what we build versus what we use. We could effectively build our own Kilo code, or we could just use Kilo code. You know what I mean? We could build what I just described, like a model shotgun thing, or we could find one. We could just use open router's own free flag, where they just route us through whatever free model they think they have. Where do we draw those lines? Should we be picking the model, or should we be letting something else pick the model? You know what I mean? 


Mr. White, I’ll frame this as an orchestration decision: when free-model retries are worth it, who should choose models, and what to build versus borrow.


Mr. White, yes: the **frontier-planner + free-worker swarm + frontier-judge** pattern is worth building.

The key is to make it **bounded, measured, and disposable**. Free models should get many chances only when failure is cheap and validation is mostly automated.

## My recommendation

Build your own **orchestration layer**, and use Kilo/OpenRouter/Claude/Codex as pluggable executors.

Do **not** build your own Kilo Code from scratch right now. Kilo already gives you a CLI coding agent, model switching, gateway access, custom modes, MCP, permissions, usage tracking, BYOK, and hundreds of models. Kilo’s CLI docs explicitly position it as a terminal coding agent that can switch among many LLMs and run Architect/Ask/Debug/Orchestrator/custom modes. Its Gateway also gives OpenAI-compatible access, usage tracking, BYOK, model allowlists, provider restrictions, and per-user spending limits. citeturn183822view5turn112383view0

Build the part that is specific to **Jovie’s economics and workflow**:

```text
Task enters hub
→ classify risk + complexity
→ frontier model writes plan only when needed
→ free/cheap executors attempt patch
→ local validators run first
→ frontier judge reviews only promising outputs
→ best patch selected
→ premium Claude/Codex escalation when free lane fails
→ task ledger updates routing/prompt rules
```

That is your durable advantage. Kilo and OpenRouter are interchangeable pipes.

## Is the free-model retry loop worth doing?

Yes, for the right tasks.

It is worth doing when the task has an objective validation loop: TypeScript checks, unit tests, lint, snapshot tests, build success, small UI acceptance criteria, schema checks, import fixes, docs generation, simple refactors, test creation, isolated components, or repeated CodeRabbit-style cleanup.

It is less useful for architecture, auth, billing, permissions, database migrations, security, product judgment, production deploy logic, or large cross-repo changes. Those should go straight to Claude Code/Codex or use free models only to draft ideas.

The economic rule:

```text
Use free swarm when:
premium_plan_cost + premium_judge_cost + orchestration_cost
<
premium_build_cost or premium_subscription_burn you are trying to avoid
```

The mistake would be letting a frontier model judge every bad free output. Run deterministic validators first. Only ask the frontier judge to inspect candidates that pass basic checks or are close enough to salvage.

## The best loop

Use this:

```text
1. Frontier planner creates a concrete implementation plan.
2. Split the plan into small patches.
3. Send each patch to 2–3 free/cheap executors.
4. Run tests/lint/typecheck/build locally.
5. Rank outputs by objective score.
6. Frontier judge reviews the top 1–2 only.
7. If all fail twice, escalate to Claude Code/Codex.
```

Avoid this:

```text
free model writes bad code
→ frontier model reviews every bad output
→ free model rewrites again forever
```

That burns your scarce frontier capacity on cleanup.

## Should you use multiple free models?

Yes, but cap it.

Use **2–3 attempts**, not 10. The best setup is:

| Slot | Model source | Purpose |
|---|---|---|
| A | Kilo `kilo-auto/free` | Stable-ish free coding attempt |
| B | Explicit known free model | Your current best performer from evals |
| C | OpenRouter `openrouter/free` | Exploration/random discovery |

Kilo Auto Free is useful because it routes a session to one of its curated free models and keeps that session on the same model. Kilo says free quality is lower than Balanced/Frontier and does not vary by mode, so it should be treated as an overflow executor. citeturn183822view4

OpenRouter’s `openrouter/free` is useful for exploration because it automatically selects from available free models after filtering for required capabilities like vision, tool calling, or structured output. The downside is that selection is random and you cannot control which model is picked unless you choose a specific `:free` model. The response includes the actual model used, so you can log winners and losers. citeturn255394view1

## Should you pick the model or let the router pick?

Use both, in different phases.

| Situation | Better choice |
|---|---|
| Exploring free models | Let Kilo/OpenRouter pick |
| Low-risk overflow | Let Kilo Auto Free pick |
| Measured production-ish automation | Pick explicit models from your leaderboard |
| Sensitive repo context | Pick trusted paid/BYOK models |
| Tool-calling reliability matters | Pick explicit tested models |
| Debugging failures | Pick explicit models |
| Max throughput while subscriptions are down | Use a fallback chain |

The operating principle:

**Auto-route to discover. Explicit-route to scale.**

Start with `kilo-auto/free` and `openrouter/free`, log every result, then promote winning models into your own allowlist. Once a model proves useful on Jovie tasks, call it directly instead of relying on random routing.

## Free is real, but capped

OpenRouter’s free models are capped: `:free` models allow up to **20 requests per minute**, with **50 free-model requests/day** before buying at least 10 credits, and **1000/day** after that. It also says making extra accounts or API keys does not bypass global capacity limits. citeturn255394view0

Kilo’s free docs also warn that free models may be rate-limited by upstream providers, and that Auto Free may route to providers that log prompts/outputs and use them to improve services. Kilo explicitly says not to submit personal or confidential data through Auto Free. citeturn183822view0

So the free lane should handle sanitized, low-risk, disposable work.

## Kilo vs OpenRouter for this

Use **Kilo** when you want a coding-agent surface: local code changes, CLI workflows, modes, permissions, MCP, and model switching.

Use **OpenRouter** when you want model API routing, free-model discovery, fallback chains, paid/cheap model access, and direct integration into your own hub.

Use **Claude Code/Codex CLI** when the work needs to ship.

Kilo also has a built-in “Virtual Quota Fallback” provider that can prioritize free providers, track token/request limits per minute/hour/day, and automatically switch to the next provider when a quota or error is hit. That is very close to the fallback behavior you described. citeturn112383view3

## Do not let free agents touch everything

Kilo’s security docs say the CLI does not sandbox the agent and recommends Docker or a VM for true isolation. That matters if you are running free-model agents against a real repo with shell access. citeturn112383view2

For your setup, every free/cheap executor should run in an ephemeral workspace:

```text
fresh git worktree or container
no secrets
no production env vars
no customer data
limited filesystem
limited network
patch output only
tests run locally
human/premium merge gate
```

## The self-improving cycle is worth building

Do it as an eval loop, not as a vague recursive “AI improves itself” loop.

Track:

```text
task type
risk level
planner model
executor model
prompt template
files touched
tests passed/failed
lint/typecheck result
diff size
judge score
human accepted/rejected
time to result
premium tokens spent
free attempts used
```

Then update your planner prompts based on evidence.

Example:

```text
If free models fail React component edits because plans are too abstract,
planner learns to output:
- exact file paths
- exact component names
- acceptance tests
- forbidden files
- expected diff shape
- rollback instruction
```

Use a held-out set of old Jovie tasks before changing the planner. A self-improving planner without evals will overfit to the judge and produce prettier plans that do not improve shipped code.

## Where I would draw the line

Build:

```text
Jovie Agent Hub
- task classifier
- risk router
- model/provider registry
- free attempt budget
- sandbox/worktree runner
- test/lint/build validator
- candidate scorer
- premium judge
- escalation rules
- prompt/eval ledger
```

Use existing products for:

```text
- actual code editing agent: Claude Code, Codex CLI, Kilo
- free model discovery: Kilo Auto Free, OpenRouter Free
- gateway/fallback: Kilo Gateway, OpenRouter
- premium reasoning/review: Claude/Codex/frontier models
```

## My concrete call

Use Kilo. Do not bet the stack on Kilo.

Add it as one executor inside your hub:

```text
executor:kilo-free
executor:openrouter-free
executor:openrouter-explicit-free-model
executor:claude-code
executor:codex-cli
executor:airme-agent
```

Then route like this:

```text
Low-risk + testable:
  2 free attempts → local validation → premium judge only if promising

Medium-risk:
  frontier plan → 2 free/cheap attempts → premium judge → premium rewrite if needed

High-risk:
  Claude/Codex directly → second premium review

Subscription exhausted:
  Kilo/OpenRouter free fallback → only sanitized low-risk tasks
```

The free swarm can probably absorb meaningful nuisance work. It should not become the authority. The authority should be your hub’s tests, metrics, risk rules, and premium review lane.


Can you start building a plan of what this should look like in practicality, based on all the context of the current repo and what's in linear and everything we've mentioned? Make a suggestion for the killer system for me to keep orchestrating and building as much of it as possible autonomously, while still using g-stack and vbrain and all that stuff, and focusing on our things. Make it focused on the KPI of getting the company to fall alive and revenue, so all of this should work with that guidance and my taste. Everything that this system does should be about extracting cases from my brain and then making decisions on my behalf. So that doesn't have to be asking me, right? Eventually, I can run every department from this HUD with teams of AI agents, and they just get better every day, and every day they ask me less questions to achieve the same thing. Kind of like humans would. 


Mr. White, I’ll ground this in the actual repo/Linear context where available, then turn it into an implementable operating-system plan: architecture, routing rules, agent teams, KPI loops, and a phased build path.


The current structure points to extending AgentOS: Vercel Workflow coordinates, GStack/GitHub Actions gate, AgentRunArtifact audits, and HUD/vBrain learn your decisions.


## See Also
- [[chatgpt/chatgpt_branch-agentic-building-and-scaling-part2]]
- [[chatgpt/chatgpt_agentic-building-and-scaling]]
- [[chatgpt/chatgpt_branch-branch-branch-sms-subscription-ideas-part1]]
- [[chatgpt/chatgpt_branch-branch-sms-subscription-ideas-part1]]
- [[chatgpt/chatgpt_branch-cost-of-ai-operations-part1]]
