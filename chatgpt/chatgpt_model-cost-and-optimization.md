---
title: "Model Cost and Optimization"
type: guide
created: 2026-05-09
updated: 2026-05-09
source: chatgpt-export
conversation_id: 69ffc00e-2bd4-83e8-a541-c4b585f184eb
message_count: 4
tags: [chatgpt, import, code, long-form]
---
# Model Cost and Optimization

> Conversation ID: 69ffc00e-2bd4-83e8-a541-c4b585f184eb
> Created: 2026-05-09T23:15:27Z
> Updated: 2026-05-09T23:20:21Z
> Messages: 4

---

## User

So for our Hermes agent, the main one that's orchestrating everything, the chief of staff, it is costing us nothing when we use NVIDIA models, but they're kind of unreliable. DeepSeek V4 Flash is supposedly relatively cheap, but with our usage, one day of it was like, still burned like 20 bucks in our test. That's not really sustainable at the current moment. Eventually, $20 a day is obviously cheaper than hiring a $70,000 a year assistant. But, you know, for a company that has $300 in the bank, it's expensive. Any prediction of like if I was talking to this thing 24-7 and it was just kind of always on, what the burn would be daily on DeepSeek V4 Flash? And then like, if there's any recommendations for how to save, like, is that kind of normal? Because everyone's talking about DeepSeek, the new DeepSeek V4 being incredibly cheap. And I'm wondering, like, I haven't tried Hermes agent with, you know, Frontier models and stuff, so I don't really know what it costs. We have subscriptions that we use for our cloud and OpenAI, but I'm trying to think of like, you know, if I can get this thing going on token-based payments on OpenRA or something, because, you know, we want to reserve our subscriptions for our coding. And I'm just curious of like, is there, like, what can we do with this? Is there like, do you know what I'm trying to say? Like, is there the ability for us to go, I don't know, I just wanna know, like, what model I could use and what it would cost.

---

## Assistant

Mr. White, I’ll sanity-check pricing against your $20/day test, estimate realistic always-on Hermes burn, and map cheaper routing options that preserve reliability.

---

## Assistant

DeepSeek V4 Flash looks genuinely cheap per token, so the $20 day likely came from tens or hundreds of millions of tokens via context bloat, retries, or tool loops.

---

## Assistant

Mr. White, yes. The key point: **DeepSeek V4 Flash is genuinely cheap. A $20/day DeepSeek bill means Hermes is probably doing a lot of hidden work**, not that DeepSeek is expensive.

DeepSeek V4 Flash is listed at **$0.14 / 1M input tokens**, **$0.28 / 1M output tokens**, with a **1M context window**. Direct DeepSeek also shows **cache-hit input at $0.0028 / 1M**, which is absurdly cheap when your prompt prefix is stable. citeturn628725view0turn628725view1

## What your $20 DeepSeek day probably means

At DeepSeek V4 Flash prices:

| Usage shape | Daily tokens | DeepSeek V4 Flash daily cost |
|---|---:|---:|
| Human-heavy chat: 480 calls/day, 10k input + 1k output | 4.8M in / 0.48M out | **$0.81/day** |
| Always-on light: 1 call/min, 4k input + 1k output | 5.76M in / 1.44M out | **$1.21/day** |
| Agent loop: 5 calls/min, 8k input + 2k output | 57.6M in / 14.4M out | **$12.10/day** |
| Heavy loop: 10 calls/min, 8k input + 2k output | 115.2M in / 28.8M out | **$24.19/day** |
| Long-context loop: 5 calls/min, 30k input + 3k output | 216M in / 21.6M out | **$36.29/day** |

So your $20 test roughly corresponds to **one medium agent call every 7 seconds all day**, or fewer calls with bloated context. That is normal for an uncontrolled agent loop. It is high for “Tim chatting with it,” even 24/7.

## Same workload on other models

Using the “10 calls/min, 8k input + 2k output” workload above:

| Model | Approx daily cost |
|---|---:|
| **DeepSeek V4 Flash** | **$24/day** |
| **Gemini 2.5 Flash-Lite** | **$23/day** |
| **GPT-5.4 nano** | **$59/day** |
| **Gemini 3.1 Flash-Lite** | **$72/day** |
| **GPT-5.4 mini** | **$216/day** |
| **Claude Haiku 4.5** | **$259/day** |
| **Claude Sonnet 4.6** | **$778/day** |
| **Claude Opus 4.7** | **$1,296/day** |
| **GPT-5.5** | **$1,440/day** |

OpenAI currently lists GPT-5.4 nano at **$0.20 / $1.25**, GPT-5.4 mini at **$0.75 / $4.50**, and GPT-5.5 at **$5 / $30** per 1M input/output tokens. citeturn628725view3 Anthropic lists Claude Haiku 4.5 at **$1 / $5**, Sonnet 4.6 at **$3 / $15**, and Opus 4.7 at **$5 / $25**. citeturn804246search0 Google lists Gemini 2.5 Flash-Lite at **$0.10 / $0.40**, Gemini 3.1 Flash-Lite at **$0.25 / $1.50**, and Gemini 3.1 Pro Preview at **$2 / $12**. citeturn386352view0turn975345view0

My read: **DeepSeek is cheap. Hermes is token-hungry.** A frontier model as the always-on chief-of-staff brain would be financially insane right now.

## Model recommendation

For a company with $300 in the bank, I’d run Hermes like this:

| Role | Model choice | Why |
|---|---|---|
| Default orchestrator / chief of staff | **DeepSeek V4 Flash direct API** | Best price/performance, huge context, cheap output, strong for agents. |
| Cheap classifier / summarizer / memory compressor | **Gemini 2.5 Flash-Lite** or **GPT-5.4 nano** | Very cheap for routing, summarizing, tagging, “should I act?” checks. |
| Fallback if DeepSeek flakes | **Gemini 3.1 Flash-Lite** or **GPT-5.4 nano** | More reliable backup without jumping to frontier prices. |
| Escalation model | **GPT-5.4 mini** or **Claude Haiku 4.5** | Use only when Hermes is about to make a real decision. |
| Frontier reviewer | **GPT-5.5 / Claude Opus 4.7** | Manual or rare automated escalation only. Never default. |

Assuming “OpenRA” means **OpenRouter**: OpenRouter is useful for routing, fallbacks, separate keys, caps, and model switching. It says it does not mark up provider pricing, pay-as-you-go has no minimum, and fallback routing bills only the successful run. citeturn628725view2 I’d use **direct DeepSeek** for the primary path if prompt caching is giving you better economics, and **OpenRouter** for fallback/model experimentation.

## How to get the bill down

The biggest lever is **agent architecture**, not model shopping.

1. **Add per-node token accounting.** Log `agent_name`, `model`, `prompt_tokens`, `completion_tokens`, `cached_tokens`, `tool_calls`, `retry_count`, `latency`, and `cost_usd` for every call. You need to know whether the burn is coming from planner loops, memory injection, tool results, retries, or verbose outputs.

2. **Cap Hermes’ loop.** Set something like:
   - max 3–5 model calls per user request
   - max 8k–15k prompt tokens for routine orchestration
   - max 500–1,000 output tokens
   - hard stop when no new tool result appears
   - no autonomous polling unless an external event fires

3. **Use DeepSeek prompt caching deliberately.** Keep the system prompt, tool schema, operating rules, and stable Hermes identity at the very front. Put dynamic user/task/context data at the end. DeepSeek caching is automatic according to OpenRouter docs, and OpenRouter exposes cached token usage in the response usage fields. citeturn704387view0

4. **Stop sending the whole company context every turn.** Hermes should get:
   - current task
   - compact user profile
   - compact company state
   - 3–10 relevant memory snippets
   - recent conversation summary  
   
   It should not get full Slack/email/calendar/tool logs unless needed.

5. **Use a cheap “should I think?” gate.** Most orchestration steps do not need reasoning mode. DeepSeek V4 Flash supports both thinking and non-thinking modes; use non-thinking for routine routing and thinking only for ambiguous, high-impact decisions. citeturn628725view0

6. **Set daily budget enforcement.** With a $100/month target, your daily budget is about **$3.33/day**. At DeepSeek prices, that supports roughly:
   - **~2,000 medium calls/day** at 8k input + 2k output
   - **~660 long-context calls/day** at 30k input + 3k output  
   
   Once Hermes crosses the daily limit, route to free NVIDIA/free OpenRouter models for low-stakes tasks and block autonomous loops.

7. **Use free NVIDIA models only as draft workers.** Let them summarize, classify, or propose. Do not let them be the final action-taking brain if reliability is poor.

8. **Watch tool costs.** Some APIs charge separately for tools like web search, file search, hosted shell/code interpreter, etc.; OpenAI’s pricing page lists web search at **$10 / 1k calls** plus model tokens, and file search/tool calls separately. citeturn628725view3 If Hermes is browsing, shelling, or searching constantly, token price may be only part of the burn.

## What I’d do immediately

Set Hermes to:

```yaml
daily_budget_usd: 3.00
primary_model: deepseek-v4-flash
routine_mode: non-thinking
max_agent_steps_per_request: 4
max_prompt_tokens_routine: 12000
max_output_tokens_routine: 700
memory_policy: retrieve_top_k_only
tool_result_policy: summarize_before_reinjecting
fallback_1: gemini-2.5-flash-lite
fallback_2: gpt-5.4-nano
escalation_model: gpt-5.4-mini
frontier_model: manual_only
```

Verdict: **DeepSeek V4 Flash is probably the right primary model for Hermes right now.** The $20/day burn says Hermes needs token discipline, loop caps, caching, and routing. A frontier model would likely turn that same usage into hundreds or over a thousand dollars per day.


## See Also
- [[chatgpt/chatgpt_aesthetic-muscle-focus-64-model]]
- [[chatgpt/chatgpt_ai-3d-model-creation]]
- [[chatgpt/chatgpt_ai-model-comparison-for-nextjs]]
- [[chatgpt/chatgpt_arlo-camera-charging-model]]
- [[chatgpt/chatgpt_best-model-for-design-systems]]
