---
title: "Cost of AI Operations"
type: guide
created: 2026-05-10
updated: 2026-05-10
source: chatgpt-export
topic: research-learning
message_count: 12
tags: [chatgpt, knowledge, research-learning]
---
# Cost of AI Operations

> **Source:** ChatGPT conversation
> **Date:** 2026-05-10T16:44:20Z
> **Messages:** 12
> **Topic:** research-learning

## Question

What would be the cost to run, like, Hermes Agent or OpenCLaw, just, like, out of the box with a reliable model? Like, assuming I'm using it, you know, let's call it like 8 hours a day, plus have it running like syncron jobs and stuff, you know, overnight. It's basically acting as my chief of staff, and it's like, kind of watching issues in linear, and it's pulling or it's pulling, doing investor research and then populating our Airtable with more investors. And it's doing like, you know, I don't know, just like generally orchestrating operations, reading my emails and summarizing them every morning, and then asking me, you know, what I want to say to each one, all that kind of stuff. Like just a general, you know, CEO's like chief of staff for me based on kind of where the company is right now. What would be the cost? Mainly, because what I'm trying to figure out is like, yes, we're working on Agent OS and all that, but cash is tight and I'm just trying to figure out because like righ

## Answer

Mr. White, I’ll model this as a monthly operating budget: model inference, framework/runtime, tool/API overhead, infra, and long-context automation. I’ll give low/base/high ranges using current reliable-model pricing.

## Question

The free models we’re using are so unreliable that it’s hard to use cuz all I get is timeouts

## Answer

The timeout problem points to a paid primary model, a cheaper triage/fallback model, and hard spend caps as the realistic architecture.

## Answer

Mr. White, for your described use case, I’d budget **$150–$350/mo for a lean, reliable model-routed setup**, or **$400–$900/mo if you run one strong model out of the box for everything**. If you force everything through top frontier models like GPT-5.5 or Claude Opus, it can become **$800–$2,500+/mo** once investor research and long-running agent loops get heavy.

The important point: **Hermes/OpenClaw itself is basically cheap. The model/API usage is the bill.** Hermes says it can run on a **$5 VPS** and supports scheduled automations, subagents, Telegram/Slack/etc., plus built-in Airtable, Google Workspace, and Linear skills, which matches your use case closely. citeturn730563view1 citeturn730563view2 OpenClaw similarly says the primary cost is core model responses, tool calls, media processing, memory/search, web search, compaction summaries, and third-party skill APIs. citeturn778415view0

## My estimate for your “AI chief of staff”

Assuming:

- **8 hours/day active use**
- **Morning email digest**
- **Linear monitoring**
- **Investor research + Airtable enrichment**
- **Overnight scheduled jobs**
- **No voice/video/image generation**
- **Approval required before sending emails or making sensitive changes**

A realistic monthly workload is roughly:

| Usage level | Monthly tokens | What it feels like |
|---|---:|---|
| Lean | ~30M input / 3M output | Useful assistant, limited deep research |
| Realistic | ~100–150M input / 10–15M output | Daily operating assistant |
| Heavy | ~300M input / 30M output | Lots of browsing, enrichment, long sessions, subagents |

Using **100M input + 10M output/month** as the practical midpoint:

| Model strategy | Estimated model cost/mo | Notes |
|---|---:|---|
| Gemini 3.1 Flash-Lite for most tasks | ~$40–$80 | Very cheap; use for summaries, polling, enrichment drafts |
| GPT-5.4 mini / Claude Haiku / Grok 4.3 class | ~$120–$180 | Good cheap workhorse tier |
| Gemini 3.1 Pro | ~$320 | Stronger reasoning, decent economics |
| GPT-5.4 | ~$400 | Solid “reliable default” tier |
| Claude Sonnet 4.6 | ~$450 | Good fit for agentic operations/coding-style tool use |
| Claude Opus 4.7 | ~$750 | Expensive for always-on ops |
| GPT-5.5 | ~$800 | Strong, but costly as default for everything |

Those are token-only numbers. OpenAI lists GPT-5.5 at **$5/M input and $30/M output**, GPT-5.4 at **$2.50/M input and $15/M output**, and GPT-5.4 mini at **$0.75/M input and $4.50/M output**. citeturn980453view0 Anthropic lists Claude Sonnet 4.6 at **$3/M input and $15/M output**, Haiku 4.5 at **$1/M input and $5/M output**, and Opus 4.7 at **$5/M input and $25/M output**. citeturn377955view0 Google lists Gemini 3.1 Pro at **$2/M input and $12/M output** for prompts up to 200k tokens, and Gemini 3.1 Flash-Lite at **$0.25/M input and $1.50/M output**. citeturn376869view0 xAI lists Grok 4.3 at **$1.25/M input and $2.50/M output**. citeturn148506search3

## Add-ons that matter

**Web search / research:** budget an

*(Answer truncated — 7016 chars total)*

## Question

Well, can you check with actually using DeepSeek based on the current v4 models? And openeouter pricing

And then what did this to me move to no Agent cron scripts? 

## Answer

I’ll check current DeepSeek/OpenRouter pricing and separate the always-on agent estimate from a simpler cron-script setup, since that changes both cost and reliability.

## Answer

Mr. White, with **DeepSeek V4 on OpenRouter**, the cost is much lower than my earlier frontier-model estimate.

I’m interpreting your last sentence as: **“What would this cost if I moved away from a full agent runtime and just used cron scripts?”**

## Current DeepSeek V4 pricing

OpenRouter currently lists:

| Model | Context | OpenRouter price |
|---|---:|---:|
| **DeepSeek V4 Flash** | ~1.05M tokens | **$0.14/M input, $0.28/M output** |
| **DeepSeek V4 Pro** | ~1.05M tokens | **$0.435/M input, $0.87/M output** |

OpenRouter describes V4 Flash as suitable for fast, cost-efficient agent workflows, and V4 Pro as suited for harder long-horizon agent workflows, multi-step automation, and large synthesis. citeturn936010view1turn936010view0

DeepSeek’s own docs show the same current V4 Flash pricing, and show V4 Pro’s current price as a **75% discount** extended until **May 31, 2026, 15:59 UTC**. After that, the listed non-discount V4 Pro price is **$1.74/M input and $3.48/M output** unless they extend or change the discount. citeturn936010view2

OpenRouter adds a **5.5% credit-purchase fee**, with a **$0.80 minimum**, while saying it does not mark up inference pricing. citeturn208244view0

## Cost for your “chief of staff” setup with DeepSeek V4

Using the same assumptions as before:

| Usage level | Monthly tokens | V4 Flash only | 80% Flash / 20% Pro | V4 Pro only |
|---|---:|---:|---:|---:|
| Lean | 30M input / 3M output | **~$5/mo** | **~$8/mo** | **~$17/mo** |
| Realistic | 125M input / 12.5M output | **~$22/mo** | **~$31/mo** | **~$69/mo** |
| Heavy | 300M input / 30M output | **~$53/mo** | **~$76/mo** | **~$165/mo** |

Those include the rough OpenRouter 5.5% credit fee.

The key watchout: if you rely heavily on **V4 Pro**, the post-discount cost could jump. The realistic **V4 Pro-only** case would go from about **$69/mo** to about **$275/mo** at the listed non-discount price. The realistic **80% Flash / 20% Pro** case would go from about **$31/mo** to about **$73/mo**.

## Web research cost

Investor research can cost more than the model tokens if you use web search heavily.

OpenRouter’s web search server tool lists Exa/Parallel at **$4 per 1,000 results**, with the default 5 results being up to **$0.02 per search**, plus normal model token costs. citeturn598009search1

Rough examples:

| Investor enrichment volume | Search pattern | Search cost |
|---|---:|---:|
| 100 investors/mo | 2 searches × 5 results | **~$4** |
| 500 investors/mo | 3 searches × 5 results | **~$30** |
| 1,000 investors/mo | 3 searches × 5 results | **~$60** |

So your total **DeepSeek + OpenRouter** bill would probably be:

| Setup | Likely monthly cost |
|---|---:|
| Cron-only, low research | **$20–$50/mo** |
| Cron-only, active investor research | **$50–$125/mo** |
| Full agent runtime, restrained loops | **$75–$200/mo** |
| Full agent runtime, lots of browsing/retries/subagents | **$150–$400/mo** |

## Moving to “no agent, just cron scripts”

For cash t

*(Answer truncated — 6260 chars total)*

## Question

So then my next ask is for you to map out of all of the cron's that we've discussed previously and all of the ones that I currently have in our repo that are linked internal. Think about all the things that we're currently doing, all the things we could be doing, and what are the highest priority things that'll move the company forward. So off the top of my head, it's probably one, making sure that anytime a linear issue is open, it's able to automatically be worked on by the best model, have an issue planned with the best model, have the code executed with the best model, have those models use GBrain and Rooflow so that they're operating optimally, have them use Gstack so that the quality is there, and then have them automatically ship and land without any human intervention. And then the other things would be go-to-market, automations, and fundraising automations.

## Answer

I’ll first inventory the current cron and automation entry points, then rank engineering, GTM, and fundraising workflows by impact, implementation risk, and company leverage.

## Answer

I found the main Jovie/Ops repos and existing docs: cron registry, cron API routes, AI automation, Agent OS, and a May automation audit. A likely mismatch is `vercel.json` scheduling 9 paths while `purge-pixel-ips` appears only in the registry.

## Answer

Mr. White, the repo-grounded read is:

**Highest ROI is to finish the Linear → agent plan → code execution → GStack gates → auto-land loop first.** That directly increases engineering throughput. Then attach **fundraising** and **GTM** as bounded cron/batch jobs with clear cost caps.

I could not retrieve a reliable prior-memory list of every older cron discussed, so I’m including the cron-only layer from this thread plus the current repo inventory.

## 1. Current automation inventory

### Existing production app crons

The current registry lists these scheduled production cron paths. It says “9 paths” in prose, but the table lists **10** paths, so I’d treat that as a small registry drift item to clean up. fileciteturn33file0

| Cron | Cadence | Current purpose | Priority |
|---|---:|---|---|
| `/api/cron/frequent` | Every 15 min | DB warm ping, campaigns, pixel retry, release notifications, lead discovery, outreach, Spotify cache, ingestion fallback | **Keep / expand carefully** |
| `/api/cron/daily-maintenance` | Daily | Cleanup, billing reconciliation, SMS intent cleanup, weekly data retention | **Keep** |
| `/api/cron/generate-insights` | Daily | AI insights for eligible profiles | **Keep, monitor cost** |
| `/api/cron/process-ingestion-jobs` | Every minute | Queue drain for ingestion jobs | **Keep** |
| `/api/cron/purge-pixel-ips` | Daily | Privacy cleanup | **Keep** |
| `/api/cron/summarize-interviews` | Every 5 min | AI interview summaries | **Keep if interviews matter** |
| `/api/cron/generate-playlist` | Daily | AI playlist generation for admin review | **Medium** |
| `/api/cron/process-pre-saves` | Daily | Spotify pre-save processing | **High if user-facing** |
| `/api/cron/monitor-metadata-submissions` | Hourly | Metadata drift monitoring | **Medium** |
| `/api/cron/process-metadata-submissions` | Daily | Sends queued metadata submissions | **Medium** |

The most important existing cron is **`/api/cron/frequent`** because it already contains the seeds of GTM automation: `leadDiscovery` and `outreach`, gated by `leadPipelineSettings.enabled`. It also handles campaigns, release notifications, and ingestion fallback. fileciteturn33file0

### Existing agentic engineering workflows

The repo already has most of the engineering automation skeleton:

| Workflow | What it does | Status |
|---|---|---|
| **Linear AI Orchestrator** | Takes Linear dispatch events, waits for a CodeRabbit plan, runs Claude Code, pushes a branch, opens PR, syncs Linear | Core loop exists |
| **Linear AI Dispatcher** | Polls Linear every 15 min for automated Todo issues, dispatches work | Exists, but scope needs broadening |
| **Agent Pipeline** | Fixes agent PRs after CI failure and auto-approves/auto-merges when gates pass | Core gate loop exists |
| **Scope Judge** | Compares PR diff to Linear intent | Exists; OpenRouter/DeepSeek candidate |
| **Main Autofix / Sentry Autofix** | Fixes red main or production errors | Exists |
| **Synthetic Monitoring / Nightl

*(Answer truncated — 16701 chars total)*
