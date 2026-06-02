---
title: "Cost Analysis Inquiry"
type: essay
created: 2026-05-27
updated: 2026-05-27
source: chatgpt-export
topic: design-ux
message_count: 16
tags: [chatgpt, knowledge, design-ux]
---
**Topic:** [[chatgpt-knowledge/_topics/design-ux]]

# Cost Analysis Inquiry

> **Source:** ChatGPT conversation
> **Date:** 2026-05-27T19:19:30Z
> **Messages:** 16
> **Topic:** design-ux

## Question

analyze costs here. why is it so expensive? your own estimates have previous said it should be less than a dollar a day

## Answer

I’ll ground this in the visible OpenRouter rows, separating shown spend from any hidden daily total, then isolate drivers like large contexts, repeated calls, provider variance, and app/API source.

## Answer

The visible sample is about $0.235 across 20 requests, driven by roughly 2.58M input tokens and only about 9.6k output tokens. Repeated 160k–176k-token prompts are the core issue.

## Answer

Mr. White, the visible logs point to one cause: **Hermes Agent is repeatedly sending huge prompts during tool-call loops.**

## What the visible rows show

| Metric from visible rows | Value |
|---|---:|
| Visible requests | 20 |
| Input tokens | **2,575,969** |
| Output tokens | **9,624** |
| Visible cost | **$0.235156** |
| Output share of tokens | **0.37%** |
| Large 167k–176k input-token calls | **14** |
| Cost of those 14 large calls | **$0.22415** |
| Share of visible spend from those 14 calls | **95.3%** |

The issue is **input-token repetition**, not generated output.

## Why it got expensive

DeepSeek V4 Flash is listed on OpenRouter at **$0.10 per 1M input tokens** and **$0.20 per 1M output tokens**, with a 1M context window. A single ~170k-token prompt costs roughly **$0.017** before provider/routing/caching variation. citeturn963630view0

Your log shows many requests around this size:

- 176,103 input tokens
- 175,542 input tokens
- 175,166 input tokens
- 174,792 input tokens
- 174,122 input tokens
- 173,156 input tokens
- etc.

Most of those rows finish with **`tool_calls`**, meaning they are intermediate agent steps. Each step appears to resend a massive context, then the model calls another tool, then the next request resends the expanded context again. OpenRouter calculates cost from provider-reported token usage and deducts credits per request. citeturn477885search4

## Why the earlier “less than $1/day” estimate broke

That estimate would hold only under assumptions like:

- much smaller prompts,
- fewer agent/tool rounds,
- reliable prompt caching,
- limited browser/page/tool context,
- fewer repeated full-history calls.

The visible logs invalidate those assumptions.

At the observed large-call size, **~58 uncached 170k-token requests/day is already about $1/day** on input alone. The visible page shows **14 large requests in about six minutes**. Four or five similar bursts in a day crosses $1.

Also, the table has a **Load more** button, so the visible $0.235 is only the rendered slice, not necessarily the full 1-day spend.

## Why some same-sized rows cost different amounts

Rows around ~170k input tokens cost anywhere from about **$0.004–$0.024**. Likely causes:

1. **Different providers**: the visible requests route across GMICloud, SiliconFlow, Alibaba Cloud, DeepInfra. OpenRouter routes across providers and provider prices can differ. citeturn477885search0

2. **Cache hits vs. cache misses**: OpenRouter says DeepSeek prompt caching is automatic; cache reads are charged at **0.1×** the original input price, while cache writes are charged at normal input pricing. citeturn963630view2

3. **Provider/routing changes may reduce cache consistency**: if large prompts route differently or the prompt prefix changes between tool rounds, you should expect fewer effective cache reads. The logs shown here do not include `cached_tokens`/`cache_discount`, so this is the first thing to inspect in the raw usage details.

## Mai

*(Answer truncated — 4704 chars total)*

## Question

Should we let Open Rider autoroute, or should we handle that with a direct model call? 

## Answer

I’ll treat “Open Rider” as OpenRouter and compare autorouting, pinned provider routing, and direct provider calls against Hermes’ repeated large-prompt tool loops.

## Question

is it viable to use openrouter with hermes agent and have it use only free models but stil be reliable?

## Answer

I’ll evaluate this as a Hermes deployment choice, focusing on OpenRouter routing, free-model constraints, reliability, latency, tool-calling quality, rate limits, and cost fallback strategy.

## Answer

Mr. White, for **Hermes Agent**, I would **use a direct, explicit model call** and avoid `openrouter/auto` for the main loop.

## Recommendation

Use:

```txt
model: deepseek/deepseek-v4-flash
```

with constrained provider routing, for example:

```json
{
  "model": "deepseek/deepseek-v4-flash:floor",
  "provider": {
    "require_parameters": true,
    "max_price": {
      "prompt": 0.12,
      "completion": 0.25
    }
  }
}
```

Then fix the real cost driver: **stop resending 170k-token prompts on every tool step**.

## Why

There are two different “routing” layers:

| Option | What it does | My take |
|---|---|---|
| `openrouter/auto` | Chooses the model for you | Avoid for Hermes Agent production |
| Provider routing for a chosen model | Chooses provider endpoint for the same model | Fine, but constrain it |

OpenRouter’s Auto Router analyzes the prompt and selects from a curated model pool. The selected model is returned in the response, and you pay the selected model’s normal price. It has no extra router fee, but it can choose more expensive models depending on its quality/cost tradeoff settings. citeturn827802view0

For your case, model selection should be deterministic. Hermes Agent has a known workload: tool use, long context, cheap reasoning, repeated calls. Auto model selection adds variance in:

- cost,
- latency,
- tool-call behavior,
- context-window assumptions,
- cache behavior,
- debugging.

## Use OpenRouter, but do not let it freely choose models

The visible logs already showed **DeepSeek V4 Flash**. That model is cheap: OpenRouter lists it at about **$0.10/M input tokens** and **$0.20/M output tokens**, with a 1M-token context window. citeturn282074search0

The cost spike came from **huge repeated inputs**, not from choosing the wrong frontier model.

OpenRouter provider routing can still be useful. By default, OpenRouter routes across providers for a chosen model and prioritizes price while accounting for uptime. You can override routing with `provider` settings such as `sort`, `order`, `only`, `ignore`, `allow_fallbacks`, `require_parameters`, and `max_price`. citeturn827802view1

## Best setup

### 1. Main agent loop

Use direct model ID:

```txt
deepseek/deepseek-v4-flash
```

or price-prioritized shortcut:

```txt
deepseek/deepseek-v4-flash:floor
```

OpenRouter documents `:floor` as equivalent to sorting providers by price. citeturn990199view0

### 2. Add price guardrails

Use `max_price` so routing fails instead of silently using an endpoint above your threshold. OpenRouter supports max prompt/completion prices per million tokens. citeturn990199view1

### 3. Keep fallbacks on initially

I would leave fallbacks on unless uptime is irrelevant. Turning off fallbacks gives tighter cost control, but it makes failures more likely. OpenRouter supports disabling fallbacks via `allow_fallbacks: false`. citeturn990199view2

### 4. Do not manually pin provider order yet

OpenRouter uses sticky routing to improv

*(Answer truncated — 4041 chars total)*

## Answer

Mr. White, **free-only OpenRouter for Hermes Agent is viable for dev/test, but I would not treat it as reliable production infrastructure.**

## Recommendation

Use a **hybrid route**:

```txt
Primary: paid explicit cheap model
Fallback/overflow: another paid cheap model
Optional: free models only for non-critical subtasks
```

Do **not** make Hermes Agent depend on only free models if reliability matters.

## Why free-only is fragile

OpenRouter’s free models have explicit limits and availability caveats:

| Constraint | Practical effect |
|---|---|
| **20 requests/minute** on `:free` models | Multi-step agents can hit this quickly. |
| **50 free requests/day** if you have purchased under $10 credits | Too low for any real agent usage. |
| **1000 free requests/day** after at least $10 credits purchased | Better, but still finite. |
| Different availability/rate limits than paid models | Can produce intermittent 429s or provider failures. |
| `openrouter/free` selects from available free models | Behavior can vary across calls. |

OpenRouter’s own docs say free models are suited for experimentation, learning, and low-volume use, while production workloads with higher reliability requirements should use paid models. citeturn923636search0turn923636search5

The current free-model rate limits are **20 RPM**, **50/day** without $10+ purchased credits, and **1000/day** after $10+ purchased credits. citeturn923636search1turn923636search3turn923636search7

## Specific to Hermes Agent

Hermes Agent is tool-call heavy. Your logs showed many intermediate requests ending in `tool_calls`, often with very large input contexts. That pattern is bad for free-only routing because:

1. **Each tool step consumes another request.**  
   A single user task may burn 5–30 free requests.

2. **Rate limits become task limits.**  
   At 1000 free requests/day, 10 calls/task means ~100 tasks/day before hard failure.

3. **Model variance hurts agents.**  
   `openrouter/free` selects from available free models and filters by needed features, but the chosen model can vary. citeturn923636search2 That is fine for casual chat. It is risky for deterministic tool use.

4. **Long context may fail or degrade.**  
   Your current architecture sometimes sends ~170k-token prompts. Many free models will have smaller practical limits, weaker tool-use reliability, or slower throughput.

## Best architecture

### Production path

Use a paid explicit model with strict cost controls:

```txt
deepseek/deepseek-v4-flash
```

or price-prioritized provider routing:

```txt
deepseek/deepseek-v4-flash:floor
```

Then enforce:

```json
{
  "provider": {
    "require_parameters": true,
    "max_price": {
      "prompt": 0.12,
      "completion": 0.25
    }
  }
}
```

The main cost fix remains **context compression**, not free routing.

### Free-model path

Use free models only for:

- draft summaries,
- cheap classification,
- simple extraction,
- non-user-facing background attempts,
- f

*(Answer truncated — 3599 chars total)*

## Question

Would it be cheaper for us to just host our always-on agent that's on the MacBook Air? We're getting free embeddings because we're using Olama and all that. Would hosting it on Railway or something like that make sense and be cheap enough, or should we just keep it on the MacBook Air? 

## Answer

Mr. White, I’ll separate the costs for keeping the MacBook Air, moving only the orchestration layer to Railway, and moving embeddings/local inference too.

## Answer

Mr. White, **keep the always-on agent on the MacBook Air for now** if the goal is lowest cost.

Use Railway only for a **thin production wrapper**: webhook endpoint, queue, dashboard, logs, deployment, maybe a small controller. Do **not** move Ollama/embeddings to Railway unless uptime matters more than cost.

## Core point

Moving the agent from the MacBook Air to Railway **does not reduce the OpenRouter LLM bill**. OpenRouter bills input/output tokens per model, so the expensive part remains the repeated large prompts/tool loops unless you change that architecture. citeturn646008search0

Ollama is “free” because it runs on your hardware. Ollama’s own pricing page describes the free tier as running open models on your hardware. citeturn732587view5 If you run Ollama on Railway, the software is still free, but the CPU/RAM is metered.

## Cost comparison

Railway’s current resource pricing is:

```txt
RAM:     $10 / GB / month
CPU:     $20 / vCPU / month
Storage: $0.15 / GB / month
Egress:  $0.05 / GB
```

Hobby includes $5/month of usage; Pro includes $20/month. citeturn732587view0turn732587view1

For local power, Los Angeles electricity is roughly **$0.23/kWh** as of May 2026. citeturn732587view4

### Back-of-envelope

| Setup | Rough monthly cost | Takeaway |
|---|---:|---|
| **MacBook Air local agent, light load** | ~$1–$5 electricity | Cheapest by far |
| **MacBook Air heavier sustained load** | ~$5–$10 electricity | Still cheap |
| **Railway thin controller only** | ~$5–$15 | Reasonable if you need webhooks/logs/deploys |
| **Railway agent + browser worker** | ~$15–$30+ | Fine for uptime, more than local |
| **Railway Ollama embeddings kept hot** | ~$25–$50+ | Usually worse than local |
| **Railway local LLM via Ollama** | ~$50–$100+ and likely slow on CPU | Bad default |

Power math:

```txt
monthly local cost ≈ watts × 24 × 30 ÷ 1000 × $0.23
```

Examples:

```txt
10W always-on ≈ $1.66/month
30W always-on ≈ $4.97/month
60W always-on ≈ $9.94/month
```

Railway math:

```txt
monthly Railway cost ≈
  ($20 × average vCPU used)
+ ($10 × GB RAM used)
+ storage
+ egress
```

So a constantly warm 4 GB Ollama/embedding service is already about:

```txt
4 GB RAM × $10 = $40/month
```

before meaningful CPU, storage, or egress.

## Recommendation for Jovie / Hermes

Use this architecture:

```txt
MacBook Air:
- Ollama embeddings
- local vector/index work
- local agent worker
- cheap long-running background tasks

Railway:
- small API/webhook endpoint
- queue
- job status
- logs
- auth boundary
- restartable controller

OpenRouter:
- explicit paid cheap model for hard reasoning/tool steps
- strict context limits
- max tool-round caps
- prompt caching where possible
```

This gives you the best cost/reliability mix.

## When Railway makes sense

Use Railway if you need:

- public HTTPS endpoint,
- webhook receiver,
- deployment from GitHub,
- stable logs,
- uptime independent of the laptop,
- team access,
- fewer “my laptop slept / Wi-Fi dr

*(Answer truncated — 4574 chars total)*

## Question

give me a hermes prompt for those fixes

## Answer

Mr. White, here’s a paste-ready Hermes system/developer prompt targeting repeated huge context resends, with behavioral cost controls; enforce API-side limits separately in code.

## Answer

Mr. White, use this as the **Hermes Agent system/developer prompt**.

```text
You are Hermes Agent, an always-on local agent running primarily on the user’s MacBook Air.

Your priorities, in order:

1. Complete the user’s task correctly.
2. Minimize paid LLM calls and token usage.
3. Avoid runaway tool-call loops.
4. Keep raw context out of paid model prompts unless strictly necessary.
5. Prefer local computation, local embeddings, and deterministic code whenever possible.

CORE COST RULES

Paid LLM calls are expensive when large context is resent repeatedly. Before every paid LLM call:

- Target prompt size: under 20,000 tokens.
- Hard prompt cap: 40,000 tokens.
- If estimated context exceeds 40,000 tokens, compress, summarize, filter, or retrieve top-K chunks before calling the paid model.
- Never send raw browser DOM, full logs, full tables, full file contents, or long tool outputs directly into a paid LLM call.
- Store raw data outside the prompt. Send only compact summaries, relevant excerpts, aggregates, IDs, and pointers.
- Use local embeddings / Ollama retrieval before paid LLM reasoning.
- Use deterministic code for math, aggregation, parsing, sorting, filtering, and deduplication.
- Do not use a paid LLM for tasks that can be solved with local code or local retrieval.

MODEL ROUTING POLICY

Use explicit models. Do not use openrouter/auto for the main agent loop.

Default paid model:

deepseek/deepseek-v4-flash

Preferred cost-constrained variant:

deepseek/deepseek-v4-flash:floor

Use provider price guards in API configuration when available. Require tool/function support when the task needs tools.

Free models may be used only for non-critical opportunistic subtasks such as rough classification, draft summarization, or cheap extraction.

Free-model policy:

- Maximum one free-model attempt per subtask.
- Do not retry free-model failures repeatedly.
- On 429, timeout, malformed tool call, unavailable model, or low-confidence output, either use local methods or fall back to the explicit paid cheap model.
- Never make the whole agent dependent on free-model availability.

LOOP LIMITS

For one user task:

- Maximum tool calls: 6 by default.
- Maximum paid LLM calls: 4 by default.
- Maximum repeated calls to the same tool with similar inputs: 2.
- Maximum retries after failure: 2 total.
- Stop immediately if a tool loop is repeating without new information.

Before exceeding any limit, produce the best available answer using current evidence and clearly state what remains unresolved.

TASK STATE POLICY

Maintain a compact task state. Keep it under 1,200 tokens.

Use this structure internally before each reasoning step:

Task State:
- Goal:
- User constraints:
- Known facts:
- Relevant retrieved context:
- Tool results summary:
- Open questions:
- Next action:
- Cost/risk notes:

Do not carry forward raw data. Carry forward summaries and references.

CONTEXT HANDLING

When given a webpage, document, table, log, transcript, email thread, or t

*(Answer truncated — 7542 chars total)*
