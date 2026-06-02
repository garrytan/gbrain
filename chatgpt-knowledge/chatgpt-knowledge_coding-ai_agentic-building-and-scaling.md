---
title: "Agentic Building and Scaling"
type: essay
created: 2026-05-08
updated: 2026-05-08
source: chatgpt-export
topic: coding-ai
message_count: 13
tags: [chatgpt, knowledge, coding-ai]
---
# Agentic Building and Scaling

> **Source:** ChatGPT conversation
> **Date:** 2026-05-08T22:28:17Z
> **Messages:** 13
> **Topic:** coding-ai

## Question

can we use kilocode and code supernova inside of our stack for our agentic building, how would that compare to, which is supposedly free? Would we be able to just use that for free throughput and basically have our agentic building system, with the hub and everything, basically just do a cost management thing? For anything that's worth it, it sends it through our codex subscription or a Claude Code subscription. When it needs to build without that, it sends it through kilocode and code supernova because it's free. Anything that's passable through that we could just do that, and then we have basically infinite scaling. 

## Answer

I’ll verify what Kilo Code and Code Supernova currently offer, including pricing, limits, and terms, then map the practical routing architecture and risks.

## Answer

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

Codex and Claude Code are better treated as **premium execution/review lanes**. Codex is included with ChatGPT Plus, Pro, Business, and Enterprise/Edu plans, with Pro tiers offering much higher usage allowances

*(Answer truncated — 4543 chars total)*

## Question

Now, I just saw Kilo Code and I discovered it, and I thought it was interesting. I thought that CodeSupernova was free because I saw a blog post, but I just checked and you're right: that is from September of 2025. Is the new one any good? Are any of the ones any good?

I don't know if we buy anything using Kilo Code. We already have Air Me's agent, and I don't know if this is better or not. For coding, we have Claude Code for our subscription to Codec CLI. When we don't use Claude Code or Codec CLI, I think that there's now free Claude Code too and the ways to use Claude Code with open router and stuff. I don't even know unless it's specifically better. If it's better, I'm down to use it. I want to use the best product. Specifically, what I was interested in is a free model because I'm looking for free models that we can use to get more throughput when our subscriptions are down. It's generally my interest right now. That's what I was thinking of. 

## Answer

I’ll separate this into whether Kilo Code is better than your current coding tools and whether its free-model lane is useful for overflow throughput.

## Answer

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

OpenRouter’s free limits are clear: `:free` models allow up to **20 requests/minute**, with **50 free-model req

*(Answer truncated — 6112 chars total)*

## Question

I also would wonder, when it comes to free stuff, if there is a world in which, because it's free, you basically have tasks that are potentially too complicated for a free model. We throw the free model at them. The plan is made by a frontier model. The frontier model judges the work, then throws out the work because it would cost us anything to make rewrites, then throws it to the agent again, and then aging home, you know. It just kind of does that, and it could even then do that with two or three models and then just pick the best one or something like that kind of shit. Is that worth doing, and then putting a self-improving cycle on it, where it kind of, as it's writing this plan, gets just better at plan writing? And then, as we're starting to think about this stuff, I start to wonder about our orchestration system and what we build versus what we use. We could effectively build our own Kilo code, or we could just use Kilo code. You know what I mean? We could build what I just des

## Answer

Mr. White, I’ll frame this as an orchestration decision: when free-model retries are worth it, who should choose models, and what to build versus borrow.

## Answer

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

That burns your scarce frontier capacity

*(Answer truncated — 9101 chars total)*

## Question

Can you start building a plan of what this should look like in practicality, based on all the context of the current repo and what's in linear and everything we've mentioned? Make a suggestion for the killer system for me to keep orchestrating and building as much of it as possible autonomously, while still using g-stack and vbrain and all that stuff, and focusing on our things. Make it focused on the KPI of getting the company to fall alive and revenue, so all of this should work with that guidance and my taste. Everything that this system does should be about extracting cases from my brain and then making decisions on my behalf. So that doesn't have to be asking me, right? Eventually, I can run every department from this HUD with teams of AI agents, and they just get better every day, and every day they ask me less questions to achieve the same thing. Kind of like humans would. 

## Answer

Mr. White, I’ll ground this in the actual repo/Linear context where available, then turn it into an implementable operating-system plan: architecture, routing rules, agent teams, KPI loops, and a phased build path.

## Answer

The current structure points to extending AgentOS: Vercel Workflow coordinates, GStack/GitHub Actions gate, AgentRunArtifact audits, and HUD/vBrain learn your decisions.

## Answer

Mr. White, the practical answer is:

**Build Jovie AgentOS as the company operating system, but keep the source of truth split exactly as your repo already defines it: Linear owns the roadmap, `agentos/` owns execution memory/specs, Vercel Workflow owns durable orchestration, GStack/GitHub own gates, Hermes/Ruflo/Kilo/OpenRouter/Claude/Codex are executors.**

The current repo/Linear state already points in this direction. The AgentOS initiative is active and defines five subprojects: Roadmap System, Design Lab, Local Agent Runtime, Visual QA / Pixel Diff, and Creative Agent System. It says AgentOS is the private orchestration surface that makes AI agents first-class citizens in product development and operations. fileciteturn33file0

## The system I’d build

Call it:

# Jovie Founder OS / AgentOS

Its job:

> Extract decisions from your brain, turn them into durable taste/strategy/policy, route work to the right agent/model/runtime, ship toward revenue, and ask you fewer questions every week.

The system should optimize for one top KPI:

## Default KPI: revenue-bearing active artists

I would define the company KPI hierarchy like this:

1. **Revenue-bearing active artists**  
   Artists who are paying, trialing seriously, or actively using a Jovie-powered release/fan-growth workflow.

2. **Activation**  
   Signup/request access → profile created/imported → first release/profile/smartlink value moment.

3. **Audience/fan-growth value**  
   Profile views, clicks, fan captures, pre-saves, notification subscribers, tips, DSP redirects.

4. **Reliability/trust**  
   Auth, billing, profile rendering, checkout, onboarding, notifications, smart links, and public profile correctness.

5. **Founder leverage**  
   More shipped useful work per day, fewer Tim questions, fewer manual interventions, lower cost per accepted PR/action.

Everything in AgentOS should be scored against that hierarchy.

---

# 1. Current foundation already exists

You already have the right bones.

The AgentOS ADR says:

- Vercel Workflow/WDK is the first durable coordinator.
- Trigger.dev is fallback.
- Linear remains product work and ownership source of truth.
- GitHub Actions + GStack remain merge/review/ship/deploy gates.
- Hermes/Ruflo are bounded execution adapters.
- OpenRouter free models are for read-only economy cognition.
- Workflow code cannot merge, deploy, mutate Linear, bypass CI, or grant itself protected authority. fileciteturn16file0

That is the correct architecture. Do not replace it with Kilo, Air Me, OpenRouter, or Claude Code. Those are execution lanes.

The repo also already has the canonical `AgentRunArtifact` contract with source, kind, status, `modelRoute`, allowed/forbidden actions, human gate, Linear issue, PR URL, verification gates, cost estimate, and metadata. fileciteturn18file0

The current WDK proof emits a harmless `AgentRunArtifact` behind safe constraints, with no model call, no Linear mutation, no deploy/merge authority, and explici

*(Answer truncated — 22736 chars total)*
