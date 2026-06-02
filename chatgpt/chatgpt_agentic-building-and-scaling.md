---
title: "Agentic Building and Scaling"
type: essay
created: 2026-05-08
updated: 2026-05-08
source: chatgpt-export
conversation_id: 69fe6380-2290-83e8-ac55-765539b045b7
message_count: 13
tags: [chatgpt, import, code, long-form]
---
# Agentic Building and Scaling

> Conversation ID: 69fe6380-2290-83e8-ac55-765539b045b7
> Created: 2026-05-08T22:28:17Z
> Updated: 2026-05-08T23:21:25Z
> Messages: 13

---

## User

can we use kilocode and code supernova inside of our stack for our agentic building, how would that compare to, which is supposedly free? Would we be able to just use that for free throughput and basically have our agentic building system, with the hub and everything, basically just do a cost management thing? For anything that's worth it, it sends it through our codex subscription or a Claude Code subscription. When it needs to build without that, it sends it through kilocode and code supernova because it's free. Anything that's passable through that we could just do that, and then we have basically infinite scaling. 

---

## Assistant

I’ll verify what Kilo Code and Code Supernova currently offer, including pricing, limits, and terms, then map the practical routing architecture and risks.

---

## Assistant

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

---

## User

Now, I just saw Kilo Code and I discovered it, and I thought it was interesting. I thought that CodeSupernova was free because I saw a blog post, but I just checked and you're right: that is from September of 2025. Is the new one any good? Are any of the ones any good?

I don't know if we buy anything using Kilo Code. We already have Air Me's agent, and I don't know if this is better or not. For coding, we have Claude Code for our subscription to Codec CLI. When we don't use Claude Code or Codec CLI, I think that there's now free Claude Code too and the ways to use Claude Code with open router and stuff. I don't even know unless it's specifically better. If it's better, I'm down to use it. I want to use the best product. Specifically, what I was interested in is a free model because I'm looking for free models that we can use to get more throughput when our subscriptions are down. It's generally my interest right now. That's what I was thinking of. 

---

## Assistant

I’ll separate this into whether Kilo Code is better than your current coding tools and whether its free-model lane is useful for overflow throughput.

---

## Assistant

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

---

## User

I also would wonder, when it comes to free stuff, if there is a world in which, because it's free, you basically have tasks that are potentially too complicated for a free model. We throw the free model at them. The plan is made by a frontier model. The frontier model judges the work, then throws out the work because it would cost us anything to make rewrites, then throws it to the agent again, and then aging home, you know. It just kind of does that, and it could even then do that with two or three models and then just pick the best one or something like that kind of shit. Is that worth doing, and then putting a self-improving cycle on it, where it kind of, as it's writing this plan, gets just better at plan writing? And then, as we're starting to think about this stuff, I start to wonder about our orchestration system and what we build versus what we use. We could effectively build our own Kilo code, or we could just use Kilo code. You know what I mean? We could build what I just described, like a model shotgun thing, or we could find one. We could just use open router's own free flag, where they just route us through whatever free model they think they have. Where do we draw those lines? Should we be picking the model, or should we be letting something else pick the model? You know what I mean? 

---

## Assistant

Mr. White, I’ll frame this as an orchestration decision: when free-model retries are worth it, who should choose models, and what to build versus borrow.

---

## Assistant

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

---

## User

Can you start building a plan of what this should look like in practicality, based on all the context of the current repo and what's in linear and everything we've mentioned? Make a suggestion for the killer system for me to keep orchestrating and building as much of it as possible autonomously, while still using g-stack and vbrain and all that stuff, and focusing on our things. Make it focused on the KPI of getting the company to fall alive and revenue, so all of this should work with that guidance and my taste. Everything that this system does should be about extracting cases from my brain and then making decisions on my behalf. So that doesn't have to be asking me, right? Eventually, I can run every department from this HUD with teams of AI agents, and they just get better every day, and every day they ask me less questions to achieve the same thing. Kind of like humans would. 

---

## Assistant

Mr. White, I’ll ground this in the actual repo/Linear context where available, then turn it into an implementable operating-system plan: architecture, routing rules, agent teams, KPI loops, and a phased build path.

---

## Assistant

The current structure points to extending AgentOS: Vercel Workflow coordinates, GStack/GitHub Actions gate, AgentRunArtifact audits, and HUD/vBrain learn your decisions.

---

## Assistant

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

The current WDK proof emits a harmless `AgentRunArtifact` behind safe constraints, with no model call, no Linear mutation, no deploy/merge authority, and explicit forbidden actions. fileciteturn19file0

So the next move is **not “invent AgentOS.”** It is **turn AgentOS from audit artifact into daily command center.**

---

# 2. The killer version

The killer system is not a dashboard. It is a decision and execution queue.

Current Linear issue JOV-1965 already names the right direction: replace tile-style HUD status with a normalized `OpsAction[]` Attention Queue, backed by events, approval gates, severity, owner, recommended action, linked PR/deploy/issue, and transitionable status. fileciteturn10file0

That should become the main product.

## Main surface

`/app/admin/ops`

This is your command HUD. It should show:

1. **Today’s company objective**
   Example: “Make signup → first artist profile → checkout trustworthy enough to onboard 10 artists this week.”

2. **Revenue impact queue**
   Every task ranked by likely effect on activation, revenue, user trust, or founder leverage.

3. **Agent runs**
   All active/completed/blocked agent work with model route, cost, approval status, GStack gates, PR link, and failure reason.

4. **Attention Queue**
   The actual operating feed:
   - broken auth
   - checkout issue
   - stale PR
   - Sentry spike
   - new customer request
   - UI regression
   - blocked agent
   - expensive automation
   - GTM opportunity
   - investor/fundraising follow-up
   - design candidate awaiting taste judgment

5. **Decision Inbox**
   Only questions where your judgment is genuinely needed.

6. **Brain extraction panel**
   The system asks a compressed question, captures your answer, turns it into a durable rule, and applies it to future decisions.

---

# 3. Required missing module: Founder Brain / Decision Extraction

The AgentOS initiative has execution projects, but it needs one more project:

## Founder Brain / Decision Extraction

Purpose:

> Convert your taste, strategy, preferences, rejections, priorities, and company logic into durable machine-usable policy.

This is the thing that makes agents ask fewer questions over time.

### It should store five memory types

| Memory type | Example | Where it lives |
|---|---|---|
| **Company strategy** | “Revenue before polish unless polish blocks trust.” | `agentos/memory/company-strategy.md` |
| **Taste rules** | “No decorative hover lift; use restrained UI; subtraction principle.” | `.claude/rules/ui.md`, `agentos/memory/design-taste.md` |
| **Decision rules** | “Auth, billing, migrations, outbound sends require human approval.” | `agentos/memory/decision-policy.md` |
| **Rejected directions** | “Do not build another static dashboard when an action queue is needed.” | `agentos/memory/rejected-directions.md` |
| **Delegation preferences** | “Default to small PRs; park guarded-path work; free models can draft but not decide.” | `agentos/memory/delegation-policy.md` |

Your repo already supports this direction. The Linear↔AgentOS sync model says Linear owns priority/status/ownership, while `agentos/` owns execution detail, taste rules, agent instructions, decisions, run artifacts, and memory. fileciteturn17file0

### The operating loop

Every time you answer a question, approve/reject a design, override an agent, merge/block a PR, or change priority, AgentOS should produce a learning artifact:

```ts
FounderDecisionMemory {
  source: "hud" | "linear" | "pr-review" | "chat" | "design-review";
  decision: string;
  reason: string;
  appliesTo: string[];
  ruleCandidate: string;
  confidence: number;
  needsHumanApproval: boolean;
}
```

Then:

1. store it as a proposed memory;
2. cluster it with similar decisions;
3. ask you only when the rule would change future behavior;
4. promote approved rules into `agentos/memory/*` or `.claude/rules/*`;
5. use those rules in future AgentBriefs.

This is how the agents get closer to “humans who learn your taste.”

---

# 4. The core object model

You need four canonical objects.

## A. `AgentBrief`

Input to an agent.

Your sync model already defines this shape: issue context, dependencies, repo specs, taste rules, GStack skills, allowed actions, forbidden actions, human approval requirement, success criteria, verification gates, and provenance. fileciteturn17file0

This should become the only way agents start work.

## B. `AgentRunArtifact`

Output from an agent.

Already exists in code. Keep extending this rather than inventing parallel logs. fileciteturn18file0

## C. `OpsAction`

Company-facing actionable unit.

Proposed in JOV-1965:

```ts
OpsAction {
  id;
  severity;
  source;
  title;
  summary;
  status;
  owner;
  recommendedAction;
  requiresApproval;
  linkedPr;
  linkedDeploy;
  linkedIssue;
  createdAt;
  updatedAt;
}
```

This should be Postgres-backed, not local-file-backed, because it becomes the company operating queue. fileciteturn10file0

## D. `FounderDecisionMemory`

The missing learning object.

This is how AgentOS learns your taste and judgment.

---

# 5. Agent teams

Start with teams that map to company outcomes, not tool names.

## 1. Chief of Staff / Hermes

Role: route, prioritize, summarize, enforce policy.

It should not do heavy implementation. Your `AGENTS.md` already says the Chief/default profile prioritizes, dispatches, verifies, and updates HUD/Linear, while coding profiles implement. fileciteturn31file0

Responsibilities:

- daily plan
- issue ranking
- decision inbox
- memory extraction
- delegation
- checking stale/blocked work
- cost routing
- producing “what changed today”

## 2. Code Orchestrator

Role: plan/decompose/review coding work.

Responsibilities:

- convert Linear issue → AgentBrief
- split large work into small PRs
- select model route
- assign executor
- enforce allowed paths
- require GStack gates
- detect when free/cheap attempt should escalate

## 3. Coder Agents

Role: implement bounded tasks only.

Executor options:

- Claude Code
- Codex CLI
- Kilo Code
- OpenRouter model route
- Air Me’s agent
- deterministic scripts

Rules:

- small PRs
- max file/diff budget unless explicitly approved
- no auth/billing/security/migrations without human gate
- no direct deploy/merge
- evidence required

## 4. QA / Reliability Agents

Role: find bugs, create detectors, keep product alive.

You already have JOV-1848: exhaustive QA campaign across revenue/trust paths with child issues, isolated coder sessions, small PRs, `/qa`, `/review`, `/ship`, `/land-and-deploy`, and guarded paths parked as `needs-human`. fileciteturn7file0

This should become a permanent department.

## 5. Revenue / Growth Agent

Role: work backward from paid active artists.

Responsibilities:

- watch signup/onboarding/checkout/profile metrics
- propose activation fixes
- inspect leads/waitlist/admin data
- generate GTM actions
- rank product work by revenue likelihood
- draft outbound, but require approval before sending

## 6. Design / Taste Agent

Role: generate and score design candidates.

Linear already has Design Lab and Creative Agent System under AgentOS for daily proposals, taste memory, and proposal routing. fileciteturn33file0

Rules:

- produce variants
- score against design taste memory
- ask yes/no/notes
- learn from rejections
- approved proposal becomes an implementation brief

## 7. CFO / Cost Router

Role: optimize spend, runway, model routing.

Responsibilities:

- monitor agent/model/API costs
- substitute free/cheap models where safe
- detect runaway loops
- produce weekly cost-per-accepted-action
- decide when to use Claude/Codex vs Kilo/OpenRouter

## 8. Founder Brain Agent

Role: make your judgment reusable.

Responsibilities:

- compress your messy input into rules
- detect contradictions
- ask for approval only when policy changes
- write memory diffs
- update future agent briefs

---

# 6. Model routing policy

This should become a first-class system.

Your automation audit already identifies OpenRouter free substitution candidates and says full code implementation, red-main fixes, Sentry autofix, and agent-pipeline repair should stay on stronger models, while scope-judge and some summarization/classification tasks are better free-model candidates. fileciteturn21file0

## Routing table

| Work type | Default route | Notes |
|---|---|---|
| Deterministic sync, metrics, health checks | `deterministic` | No LLM. |
| Rank/summarize/classify | `openrouter-free` / Kilo free | Safe for low-risk internal cognition. |
| Draft plans/specs | cheap/frontier depending on complexity | Frontier for ambiguous product direction. |
| Small UI/code fixes | Kilo/OpenRouter/cheap model attempt allowed | Validate with tests before review. |
| Production code | Claude Code / Codex CLI | Especially multi-file or customer-facing. |
| Auth/billing/security/migrations | Claude/Codex + human gate | No free-model authority. |
| Final review/merge/deploy readiness | GStack + GitHub Actions + premium review | Gates decide. |

## Free-model swarm rule

Use free models as disposable workers:

```text
frontier planner
→ 2 free/cheap executor attempts
→ deterministic tests/lint/build
→ premium judge only for top candidate
→ escalate to Claude/Codex if failed twice
```

Do not let free models:

- touch secrets
- see customer-sensitive data
- decide shipping
- change auth/billing/security
- mutate Linear
- send outbound
- merge/deploy
- bypass GStack

The ADR already says OpenRouter free routes are read-only economy cognition only. fileciteturn16file0

I would extend `AGENT_RUN_MODEL_ROUTES` to include:

```ts
'kilo-free'
'kilo-auto-free'
'openrouter-free'
'openrouter-cheap'
'airme-agent'
'claude-code'
'codex-cli'
'deterministic'
```

Right now the schema has `deterministic`, `openrouter-free`, `ai-sdk-gateway`, `claude-code`, and `codex-cli`. fileciteturn18file0

---

# 7. Autonomy levels

Every action should have an autonomy level.

| Level | Agent can do | Examples |
|---|---|---|
| **L0 Read** | observe/summarize only | metrics, Linear, PRs, logs |
| **L1 Draft** | create plans/proposals | specs, issue briefs, design variants |
| **L2 Prepare** | make local artifacts/PR drafts | code patch, screenshot diff, draft PR |
| **L3 Ship low-risk** | auto-merge/deploy after gates | docs, tests, tiny UI, deterministic sync |
| **L4 Human-gated** | needs approval before action | auth, billing, data, outbound, security |
| **L5 Forbidden** | never autonomous | secrets, destructive prod data, financial transfers |

Map this onto existing artifact fields:

- `allowedActions`
- `forbiddenActions`
- `humanApprovalRequired`
- `humanGate`
- `verificationGates`

Those fields already exist. fileciteturn18file0

---

# 8. The daily operating loop

Every day AgentOS should run the company like this:

## Morning: company state

Hermes produces:

```text
Today’s goal:
- Increase revenue-bearing active artists.

Top 5 actions:
1. Fix broken staging auth / signup.
2. Land profile trust bugs affecting public artist profiles.
3. Resolve payment-adjacent tip validation PR with human gate.
4. Dispatch free-model QA sweep for profile mobile bugs.
5. Create GTM list of 20 artist leads only after product trust gates pass.

Blocked:
- Auth/billing/payment/security tasks requiring Tim.
- PRs with unresolved bot findings.
- Agent runs missing GStack evidence.

Questions for Tim:
- Only 1-3 decisions that affect policy/taste/revenue.
```

## During day: autonomous execution

- Pull from Linear.
- Generate AgentBrief.
- Route to executor.
- Run validators.
- Emit AgentRunArtifact.
- Convert meaningful signals into OpsActions.
- Update HUD.

## Evening: learning loop

- What shipped?
- What moved revenue/trust?
- What failed?
- What did Tim decide?
- What rule should we add?
- Which agents/models performed best?
- Which prompts should change?
- Which questions should never be asked again?

---

# 9. What to build versus use

## Build inside Jovie

Build the parts that encode your company:

1. **AgentOS control plane**
2. **Founder Brain memory**
3. **OpsAction queue**
4. **AgentBrief generator**
5. **AgentRunArtifact ledger**
6. **Cost/model router**
7. **Approval gates**
8. **GStack evidence enforcement**
9. **Revenue KPI scoring**
10. **Taste/rejection memory**
11. **Daily/weekly operating reports**

These are durable assets.

## Use existing tools as adapters

Use:

- **Claude Code** for premium coding.
- **Codex CLI** for premium coding/review.
- **Kilo Code** for optional coding-agent/free-model overflow.
- **OpenRouter** for free/cheap model access and discovery.
- **Air Me’s agent** if it outperforms on your evals.
- **Ruflo/Hermes** as execution adapters.
- **Vercel Workflow** for durable orchestration.
- **GitHub Actions** for CI/gates/deploy.
- **Linear** for roadmap truth.
- **Statsig/PostHog/Sentry/GitHub/Vercel** as signal sources.

Do not build a generic Kilo replacement. Build the orchestration and judgment layer above every executor.

---

# 10. Revenue-first prioritization formula

Every issue/action should get a score:

```text
impact_score =
  revenue_impact * 5
+ activation_impact * 4
+ trust_impact * 4
+ user_visible_quality * 2
+ founder_leverage * 2
- risk * 4
- cost * 1
- complexity * 1
```

Then assign a route:

```text
if risk includes auth/billing/security/migration/outbound:
  human-gated premium route

else if objective validation exists and impact is low/medium:
  free/cheap swarm first

else if high impact or ambiguous:
  frontier plan + premium executor

else:
  deterministic/no_agent route
```

This makes AgentOS make decisions on your behalf without guessing.

---

# 11. Immediate build plan

## Phase 1 — Make the HUD an action queue

Implement/split JOV-1965.

Deliver:

- `ops_events` table
- `/api/hud/actions`
- `OpsAction[]`
- Attention Queue in `/app/admin/ops`
- detail drawer
- severity × business impact sort
- linked issue/PR/deploy/run
- basic transitions: `queued`, `investigating`, `fixing`, `verifying`, `blocked`, `shipped`, `dismissed`

This is the real command center.

## Phase 2 — Extend `AgentRunArtifact` for model routing

Add fields:

```ts
modelProvider
modelName
routeReason
attemptNumber
parentRunId
candidateGroupId
validationScore
businessImpactScore
autonomyLevel
```

Keep the existing schema shape, just extend it.

## Phase 3 — Build the Model Router

Add:

```ts
ModelRoutePolicy {
  route;
  allowedKinds;
  forbiddenActions;
  maxCostUsd;
  maxAttempts;
  requiresHumanGate;
  providerFallbacks;
}
```

Routes:

- `deterministic`
- `openrouter-free`
- `kilo-free`
- `openrouter-cheap`
- `claude-code`
- `codex-cli`
- `airme-agent`

## Phase 4 — Free-model overflow broker

Start with only safe tasks:

- summarize Linear issues
- classify bug type
- rank backlog
- draft tests
- draft UI copy
- generate candidate plans
- simple low-risk implementation attempts in isolated worktrees

Record:

- model used
- prompt
- pass/fail
- tests
- human accepted/rejected
- cleanup required

## Phase 5 — Founder Brain memory

Create:

```text
agentos/memory/company-strategy.md
agentos/memory/decision-policy.md
agentos/memory/design-taste.md
agentos/memory/rejected-directions.md
agentos/memory/delegation-policy.md
agentos/memory/model-routing.md
```

Add `/api/admin/agent-os/memory/proposals`.

HUD interaction:

```text
Agent: “You rejected this because it felt too dashboard-y and not action-oriented. Promote rule?”
Tim: yes/no/notes
```

Approved rule goes to memory.

## Phase 6 — AgentBrief generator

Implement the already-specified brief model from `SYNC_MODEL.md`.

Every coding or ops run starts from a generated brief.

## Phase 7 — Department agents

Add departments one by one:

1. Reliability
2. Product/Activation
3. Coding
4. Design/Taste
5. Growth/Revenue
6. CFO/Cost
7. Founder Brain
8. Fundraising/Investor

Each department produces `OpsAction`s, not random summaries.

---

# 12. What this looks like in the HUD

Top nav:

```text
Ops
Revenue
Product
Agents
PRs
Approvals
Brain
Costs
Design Lab
QA
```

Main view:

```text
Company Objective
Revenue-bearing active artists ↑

Attention Queue
[Urgent] Staging auth broken — blocks signup trust
[Urgent] Profile hero/artwork bugs — blocks public profile trust
[High] Tip validation PR needs human gate
[High] AgentOS HUD artifact panel in progress
[Medium] Free model scope-judge substitution candidate
[Medium] Design proposal queue awaiting taste approval
```

Agent panel:

```text
Run: JOV-1990 release countdown bug
Route: kilo-free attempt 1 → failed typecheck
Route: openrouter-free attempt 2 → passed unit, failed visual
Route: claude-code final → PR ready
Gates: typecheck passed, focused test passed, GStack review pending
Decision: hold until /ship
```

Brain panel:

```text
New rule candidates:
1. “Profile trust bugs outrank generic UI polish when public artist pages are affected.”
2. “Payment-adjacent changes can be implemented by agents but require human landing.”
3. “Free models may attempt mobile layout fixes when screenshot/Playwright validation exists.”
```

Cost panel:

```text
Saved premium attempts: 14
Accepted free-model drafts: 6
Rejected free-model drafts: 19
Premium escalations avoided: 4
Cost per accepted PR: $X
Best free model this week: [model]
Worst route: [model]
```

---

# 13. Specific current priorities from Linear/repo

Based on what I saw, I would prioritize:

## P0: Product trust / revenue path

Current active issues include staging auth, payment-adjacent tip validation, profile trust bugs, and waitlist/auth gate review. The exhaustive QA epic explicitly prioritizes billing/checkout/webhooks/entitlements, auth/signup/onboarding, public profiles/claim/profile modes, creator app shell, smart links/DSP redirects/audience capture/notifications/tips, and admin/ingest/investor portal. fileciteturn7file0

These are revenue and trust paths. They outrank generic AgentOS polish.

## P1: AgentOS actionability

Ship the private HUD AgentRunArtifact panel, because JOV-1941 is already in progress and explicitly renders status, model route badge, approval state, and verification gates. fileciteturn8file0

Then ship OpsAction/Attention Queue.

## P2: Free/cheap model broker

Add OpenRouter/Kilo free only for low-risk, validated work. The automation audit already identifies scope-judge and some summarization as the cleanest free-model candidates, while full implementation and autofix loops should stay premium. fileciteturn21file0

## P3: Founder Brain memory

This is the unlock for “ask me fewer questions.”

## P4: Design Lab / Creative Agent System

Useful, but only after public profile trust and onboarding are reliable enough that better design converts.

---

# 14. The key policy

AgentOS should always choose one of these outcomes:

```text
Do now autonomously.
Draft and ask for approval.
Escalate to premium model.
Escalate to Tim.
Park as not revenue-relevant.
Convert into detector/test.
Convert into memory rule.
```

That is how it becomes a manager rather than a chatbot.

---

# 15. My concrete recommendation

Build the system in this order:

1. **Finish AgentRunArtifact HUD panel.**
2. **Ship OpsAction Attention Queue.**
3. **Add model route/cost/attempt tracking to artifacts.**
4. **Add free-model broker as a safe executor lane.**
5. **Add Founder Brain memory proposal flow.**
6. **Turn every agent result into either shipped work, blocked work, an OpsAction, or a memory update.**
7. **Score every task against revenue-bearing active artists.**

The architecture is already pointed correctly. The main change is making it less “agent infrastructure” and more “company command system.” The system should wake up every day, decide what matters, assign agents, verify work, learn from your judgments, and only interrupt you for approvals that change revenue, trust, taste, or irreversible risk.
