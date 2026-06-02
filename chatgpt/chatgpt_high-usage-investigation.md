---
title: "High Usage Investigation"
type: guide
created: 2026-05-11
updated: 2026-05-11
source: chatgpt-export
conversation_id: 6a012a40-c31c-83e8-81d2-5262337e882b
message_count: 13
tags: [chatgpt, import, code, long-form]
---
# High Usage Investigation

**Related:** [[personal_finance]]

> Conversation ID: 6a012a40-c31c-83e8-81d2-5262337e882b
> Created: 2026-05-11T01:00:49Z
> Updated: 2026-05-11T02:32:24Z
> Messages: 13

---

## User

figure out why my usage is so high. im buringing a lot a day on deepseek which should be cheap in hermes agent.

---

## Assistant

Mr. White, I’ll use the visible OpenRouter logs as evidence and compare them against current DeepSeek/OpenRouter pricing. The clear initial pattern is repeated ~160k–190k token prompts, often several times per minute.

---

## Assistant

Mr. White — based on the visible OpenRouter rows, your burn is coming from **repeated huge input context + expensive provider routing**, not from DeepSeek output.

### What the visible logs show

In the visible slice, Hermes made **20 requests in ~7 minutes**:

| Metric | Visible rows |
|---|---:|
| Total input tokens | **3,573,824** |
| Total output tokens | **8,168** |
| Avg input/request | **178,691 tokens** |
| Total visible cost | **$2.2056** |
| Output share of tokens | **0.23%** |

So the core issue is: **Hermes is resending ~160k–190k input tokens per call**, often for tiny outputs of 80–1,000 tokens.

### The two biggest cost multipliers

**1. You are mostly using DeepSeek V4 Pro, not Flash.**  
OpenRouter lists DeepSeek V4 Pro at **$0.435/M input** and **$0.87/M output**, while DeepSeek V4 Flash is **$0.14/M input** and **$0.28/M output**. Both have a 1,048,576-token context window, which lets Hermes accumulate very large prompts. citeturn219769view0turn219769view1

At the visible token volume, if everything had run on **V4 Flash**, the slice would have cost about **$0.50** instead of **$2.21**.

**2. Parasail and one Together row are cost outliers.**  
Five rows over $0.10 account for **$1.60**, or **72.5% of the visible spend**, despite only **~24% of the input tokens**. Four of those are **Parasail** rows. OpenRouter’s effective pricing page shows V4 Pro provider prices vary materially, with entries like Together and Parasail showing higher effective per-million pricing than the base headline rate. citeturn387337search0

### Why Hermes is creating 180k-token calls

Hermes docs explicitly list high token usage causes as **long conversations, verbose system prompts, and many tool calls accumulating context**, with `/compress` and `/usage` as the immediate remedies. citeturn397029view1

There is also a 1M-context trap: Hermes’ default compression threshold is relative to the model’s context window. The example config says default compression triggers at **50%** of context; on a 1M-token model, that can mean waiting until ~500k tokens, and the default post-compression tail can still preserve ~100k tokens. citeturn397029view4

### Immediate fixes

Run this inside the Hermes session first:

```text
/usage
/compress
```

Then change Hermes config to bias cost:

```yaml
model:
  provider: openrouter
  default: deepseek/deepseek-v4-flash:floor
  api_mode: chat_completions

provider_routing:
  sort: "price"
  ignore:
    - "Parasail"
  require_parameters: true

compression:
  enabled: true
  threshold: 0.12
  target_ratio: 0.10
  protect_last_n: 8
```

OpenRouter documents `sort: "price"` / `:floor` as cost-prioritizing provider routing, and Hermes passes provider routing preferences through to OpenRouter from `~/.hermes/config.yaml`. citeturn501541view0turn501541view1turn501541view2

Also check auxiliary models. Hermes says auxiliary tasks can fall back to the main model, and tasks like title generation, compression, approval, session search, and web extraction should be assigned cheap/fast models rather than your main expensive model. citeturn397029view2

### My read

Your biggest problem is **context accumulation**. Your second problem is **provider routing landing on costly V4 Pro providers**. Your third problem is **using Pro for high-frequency agent/tool loops when Flash would probably be enough**.

Expected impact from the config above: likely **70–90% lower spend** during similar Hermes runs, assuming the agent behavior stays roughly the same.

---

## User

───────────────────────────────────────────────────────────────────────────────────────────────────────
  📊 Session Token Usage
  ────────────────────────────────────────
  Model:                     deepseek/deepseek-v4-flash
  Input tokens:               2,052,255
  Cache read tokens:          5,695,488
  Cache write tokens:                 0
  Output tokens:                 29,043
  Prompt tokens (total):      7,747,743
  Completion tokens:             29,043
  Total tokens:               7,776,786
  API calls:                         51
  Session duration:              5h 23m
  Cost status:               estimated
  Cost source:              provider_models_api
  Total cost:              ~$    0.3114
  ────────────────────────────────────────
  Current context:  173,293 / 1,048,576 (17%)
  Messages:         217
  Compressions:     0

⚙️  /usage
/compress

  📈 Account limits
  Provider: openrouter
  API key quota: 85% remaining (15% used) • $34.02 of $40.00 remaining • resets daily
  Credits balance: $9.66
  API key usage: $60.28 total • $5.98 today • $5.98 this week • $60.28 this month

---

## Assistant

Mr. White, the new `/usage` output changes the diagnosis: this Flash session is token-heavy yet estimated at ~$0.31. Today’s $5.98 is likely from other OpenRouter rows, sessions, routing, or estimator mismatch.

---

## User

we use gbrain. can that help this?

---

## Assistant

I’m checking GBrain specifically, since it can either reduce context burn or add overhead depending on how Hermes loads memory and tools.

---

## User

check this page

---

## Assistant

I’ll reconcile the Hermes session’s cheap Flash estimate with the higher OpenRouter daily spend, separating current-session token economics from account-level charges.

---

## Assistant

Mr. White — yes. Use GBrain to move durable context out of the Hermes session and retrieve only the few relevant records per task.

Checked the OpenRouter page: it shows **seven recent $10 credit purchases** from May 6–May 10. Your Hermes `/usage` says **$60.28 total API key usage** and **$9.66 balance**, which roughly reconciles with **$70 purchased - $60.28 used = $9.72 remaining**. So the OpenRouter burn is real; the **$0.3114 Hermes session estimate is only one session**, not the whole account/day.

### Diagnosis

Your current session is cheap:

```text
Current session: ~$0.3114
Today on key:    $5.98
Delta:           ~$5.67
```

DeepSeek V4 Flash itself is priced cheaply on OpenRouter at **$0.14/M input** and **$0.28/M output**, with the model page listing a 1,048,576-token context window. The cache-read price shown by OpenRouter is tiny, which explains why your 5.7M cache-read tokens are not the main cost driver. citeturn142564view0turn976209search0

The high daily spend is likely from one or more of these:

1. **Other Hermes sessions** using V4 Pro or expensive providers.
2. **Old long-running sessions** still sending huge context.
3. **GBrain/Hermes cron or enrichment jobs** hitting OpenRouter.
4. **Provider routing** landing on costly routes.
5. **No compression yet**: your session has **173,293 context tokens**, **217 messages**, and **0 compressions**.

Hermes has built-in compression/caching, and its context engine decides when compaction fires; the documented/default behavior often waits until a large percentage of the context window is used. On a 1M-token model, a 50% threshold means compression may wait until roughly **500k tokens**, so your current **173k** context can keep growing without compression. citeturn386413view1turn386413view5

### How GBrain helps

GBrain is useful here if you use it as **retrieval memory**, not as more prompt stuffing. Its docs describe a clear split: world knowledge goes in GBrain, operational preferences go in agent memory, and only immediate task state stays in session context. citeturn386413view3

Use this pattern:

```text
1. Summarize the current Hermes session into GBrain.
2. Start a fresh Hermes session.
3. For each task, query GBrain for only the relevant people/company/project/files.
4. Inject only the top 1–3 retrieved items, ideally summarized to <2k tokens.
5. Keep the live Hermes context small.
```

GBrain’s own README describes it as the production brain for OpenClaw/Hermes-style deployments, with hybrid search and a self-wiring knowledge graph. That is exactly the kind of layer that can replace “carry the whole 173k-token conversation forever.” citeturn386413view0

### Important GBrain caveat

GBrain can also increase spend if Hermes loads too much of it. GBrain’s docs reference large deployments with **40+ skills** and **20+ cron jobs**; if your setup has automated jobs, enrichers, or collectors running through Hermes/OpenRouter, those can silently create daily burn. citeturn386413view4

### What I’d change

Add or confirm this in Hermes:

```yaml
model:
  provider: openrouter
  default: deepseek/deepseek-v4-flash:floor

compression:
  enabled: true
  threshold: 0.12
  target_ratio: 0.10
  protect_last_n: 8
  summary_model: deepseek/deepseek-v4-flash
  summary_provider: openrouter
```

Then add an operating rule for Hermes/GBrain:

```text
Before continuing a long task, write durable facts and project state to GBrain.
For future turns, use gbrain search/get instead of relying on old session history.
Retrieve at most 3 GBrain pages unless explicitly asked.
Summarize retrieved pages before sending them to the model.
Do not load the whole brain, whole skillpack, or full meeting transcripts into context.
```

### Next thing to check

On OpenRouter, go to **Logs → Past 1 Day**, then filter:

```text
App: Hermes Agent
Model: DeepSeek V4 Pro
Provider: Parasail OR Together
```

Then separately filter:

```text
Model: DeepSeek V4 Flash
```

If the expensive rows are V4 Pro or Parasail/Together, GBrain is only part of the fix. The immediate fix is routing/model locking. If the expensive rows are V4 Flash with huge input, GBrain + lower compression threshold is the fix.

---

## User

done

---

## Assistant

I can see the filtered OpenRouter log now: this slice is DeepSeek V4 Flash, and the spend is coming from repeated large-context Hermes requests rather than outputs.

---

## Assistant

Mr. White — this page confirms the issue.

### What the visible DeepSeek V4 Flash logs show

Visible rows only:

| Metric | Value |
|---|---:|
| Visible requests | **20** |
| Total input | **1,785,932 tokens** |
| Total output | **17,885 tokens** |
| Avg input/request | **89,297 tokens** |
| Avg output/request | **894 tokens** |
| Visible cost | **$0.2183** |
| App | **Hermes Agent** |
| Main finish reason | **tool_calls** |
| Main provider | **Parasail** |

The model is cheap. The problem is that Hermes is repeatedly sending **70k–173k input tokens per call**, mostly during tool-call loops.

### Key finding

This is the cost pattern:

```text
May 10 4:50–4:57 PM:
~19 Flash calls
mostly 70k–96k input tokens each
mostly tool_calls
~$0.194 visible spend in ~7 minutes
```

That means the agent is probably doing tool loops while carrying a big session context every call.

Your earlier Hermes `/usage` said:

```text
Current context: 173,293 / 1,048,576
Messages: 217
Compressions: 0
```

This page matches that exactly: the latest visible request has **173,293 input tokens** and cost **$0.0243**.

### What this proves

The burn is **not** because DeepSeek V4 Flash is expensive.

The burn is from:

1. **Hermes carrying huge context into every tool call**
2. **No compression yet**
3. **Long sessions with 200+ messages**
4. **Tool-call loops multiplying the same context cost**
5. Possibly **other sessions/log pages**, because the visible rows explain only **$0.218**, while your API key showed **$5.98 today**

### Does GBrain help?

Yes, if you use it to **replace persistent session context**.

GBrain should hold:

```text
project facts
people/company memory
research summaries
decisions
task history
long docs
```

Hermes session should hold only:

```text
current task
last few messages
top 1–3 relevant GBrain retrievals
active tool results
```

Do **not** let Hermes dump large GBrain pages, whole skillpacks, full transcripts, or entire project histories into every call. That would recreate the same problem.

### Immediate fix

Run this in Hermes:

```text
/compress
```

Then update config so compression happens much earlier:

```yaml
compression:
  enabled: true
  threshold: 0.08
  target_ratio: 0.08
  protect_last_n: 6
  summary_model: deepseek/deepseek-v4-flash
  summary_provider: openrouter
```

For a 1,048,576-token model, a 50% compression threshold waits far too long. Your session is already at **173k tokens** and still has **0 compressions**.

### Add a Hermes/GBrain operating rule

```text
Use GBrain for durable memory.
Before long tool work, retrieve only the most relevant 1–3 GBrain records.
Never load full GBrain collections, full transcripts, full docs, or full skillpacks unless explicitly requested.
After each major task, summarize durable facts back into GBrain, then compress or start a fresh Hermes session.
```

### Next check

Clear the model filter and inspect **all models / all providers** for the same 1-day window.

This Flash page explains the **pattern**, but not the full **$5.98 today**. The missing spend is likely from additional pages of logs, other sessions, another model, or background Hermes/GBrain jobs.


**Topic:** [[chatgpt-clusters/personal_finance]]
