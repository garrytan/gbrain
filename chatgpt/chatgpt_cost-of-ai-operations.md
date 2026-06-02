---
title: "Cost of AI Operations"
type: essay
created: 2026-05-10
updated: 2026-05-10
source: chatgpt-export
conversation_id: 6a00b5e4-2860-83e8-a9e4-daeb6b3e880d
message_count: 12
tags: [chatgpt, import, long-form]
---
# Cost of AI Operations

> Conversation ID: 6a00b5e4-2860-83e8-a9e4-daeb6b3e880d
> Created: 2026-05-10T16:44:20Z
> Updated: 2026-05-10T17:18:01Z
> Messages: 12

---

## User

What would be the cost to run, like, Hermes Agent or OpenCLaw, just, like, out of the box with a reliable model? Like, assuming I'm using it, you know, let's call it like 8 hours a day, plus have it running like syncron jobs and stuff, you know, overnight. It's basically acting as my chief of staff, and it's like, kind of watching issues in linear, and it's pulling or it's pulling, doing investor research and then populating our Airtable with more investors. And it's doing like, you know, I don't know, just like generally orchestrating operations, reading my emails and summarizing them every morning, and then asking me, you know, what I want to say to each one, all that kind of stuff. Like just a general, you know, CEO's like chief of staff for me based on kind of where the company is right now. What would be the cost? Mainly, because what I'm trying to figure out is like, yes, we're working on Agent OS and all that, but cash is tight and I'm just trying to figure out because like right now, it seems the biggest bottleneck towards actually moving this forward is that the...

---

## Assistant

Mr. White, I’ll model this as a monthly operating budget: model inference, framework/runtime, tool/API overhead, infra, and long-context automation. I’ll give low/base/high ranges using current reliable-model pricing.

---

## User

The free models we’re using are so unreliable that it’s hard to use cuz all I get is timeouts

---

## Assistant

The timeout problem points to a paid primary model, a cheaper triage/fallback model, and hard spend caps as the realistic architecture.

---

## Assistant

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

**Web search / research:** budget another **$20–$150/mo** depending on how much investor research it does. OpenAI and Anthropic both list web search at **$10 per 1,000 calls/searches**. citeturn980453view0 citeturn377955view0 Gemini includes **5,000 Google Search/Maps grounding prompts per month shared across Gemini 3**, then charges **$14 per 1,000 search queries**. citeturn376869view0

**Hosting:** **$5–$25/mo** is enough for a small VPS. More if you want separate workers, persistent browser environments, logs, monitoring, or sandboxed execution.

**Managed runtime / containers:** usually small. Anthropic lists managed agents at **$0.08/session-hour** and code execution beyond free daily hours at **$0.05/hour/container**. citeturn377955view0 OpenAI lists containers separately, with pricing by container/session. citeturn980453view0

**Batch jobs:** overnight investor enrichment should use batch/cheap models. OpenAI, Anthropic, and Gemini all expose batch-style discounts around **50%** for eligible async work. citeturn980453view0 citeturn377955view0 citeturn376869view0

## Practical monthly budget

For your situation and cash constraints, I’d think in these tiers:

| Setup | Monthly budget | Reliability | Recommendation |
|---|---:|---|---|
| Cheapest usable | **$75–$150** | Medium | Mostly Gemini Flash-Lite / GPT-5.4 mini; occasional stronger model |
| Sensible founder setup | **$150–$350** | Good | Cheap model for monitoring/summaries; Sonnet/GPT-5.4/Gemini Pro only for hard tasks |
| One strong model default | **$400–$900** | Good | Simpler config, more expensive |
| Frontier default | **$800–$2,500+** | Best reasoning, worst cash burn | Avoid as default unless the agent is directly making/saving serious money |

My strong recommendation: **do not run one frontier model for all agent loops.** Route by task.

A good cash-tight config:

| Workflow | Model tier |
|---|---|
| Email digest, Linear polling, Airtable CRUD, status summaries | Gemini 3.1 Flash-Lite / GPT-5.4 mini / Haiku |
| Investor research extraction | Gemini Flash-Lite or GPT-5.4 mini first pass |
| Investor prioritization, nuanced reasoning, outbound draft quality | Claude Sonnet 4.6 / GPT-5.4 / Gemini 3.1 Pro |
| Complex company ops, strategy, delicate email drafts | Sonnet 4.6 or GPT-5.4 |
| Rare high-stakes synthesis | GPT-5.5 or Opus 4.7 |

## Why the free models are timing out

Free tiers are usually constrained by rate limits, queues, and lower priority. For an always-on chief-of-staff agent, that becomes painful because the agent does many small calls: planning, tool selection, retrieval, summarization, validation, retries, and follow-up actions. Paid tiers give higher limits and production access; Google explicitly distinguishes free from paid by higher rate limits and access to advanced production features, and OpenAI distinguishes priority processing from flex processing where flex may be slower or intermittently unavailable. citeturn376869view0 citeturn980453view0

## What I’d actually do

Start with a **$250/mo hard cap**:

| Category | Cap |
|---|---:|
| Cheap/background model | $75 |
| Strong model | $125 |
| Web/search | $30 |
| VPS/logging/misc | $20 |

Then enforce:

- **No autonomous email sending. Draft + ask you.**
- **No frontier model for polling.**
- **No full inbox ingestion unless needed. Start with snippets/metadata, then read full threads selectively.**
- **Investor enrichment in batches overnight.**
- **Webhooks over polling wherever possible.**
- **Hard per-workflow budgets.**
- **Compact long sessions aggressively.**
- **Use prompt caching.** OpenClaw documents cache/heartbeat strategies and cost tracking commands like `/status`, `/usage full`, and `/usage cost`. citeturn353418view0

Bottom line: **budget $150–$350/mo to make it actually usable.** Below that, you’ll keep fighting reliability. Above **$500/mo**, you should demand measurable ROI: investor leads enriched, emails cleared, meetings prepared, Linear work unblocked, and founder hours saved.

---

## User

Well, can you check with actually using DeepSeek based on the current v4 models? And openeouter pricing

And then what did this to me move to no Agent cron scripts? 

---

## Assistant

I’ll check current DeepSeek/OpenRouter pricing and separate the always-on agent estimate from a simpler cron-script setup, since that changes both cost and reliability.

---

## Assistant

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

For cash tightness, I’d do this first.

The cron version should be dramatically cheaper because it avoids agent loop waste: repeated planning calls, redundant context loading, runaway retries, and unnecessary tool calls.

A good no-agent structure:

| Script | Schedule | Model |
|---|---:|---|
| `email_digest.py` | 7:00am daily | V4 Flash |
| `linear_watch.py` | every 30–60 min | V4 Flash |
| `investor_enrich.py` | overnight | V4 Flash first pass, V4 Pro only for scoring |
| `daily_brief.py` | 8:00am daily | V4 Pro or Flash |
| `reply_drafter.py` | on demand | V4 Pro for important emails |
| `ops_router.py` | on demand | V4 Flash |

For cron-only, I’d assume **40M–80M input tokens and 4M–8M output tokens/month** unless you do a lot of investor browsing.

That costs:

| Cron model setup | Model cost/mo |
|---|---:|
| V4 Flash only | **~$7–$14/mo** |
| 80% Flash / 20% Pro | **~$10–$20/mo** |
| Add web research | **+$10–$80/mo** |
| VPS/logging/misc | **+$5–$25/mo** |

So the practical cron-only budget is probably **$25–$125/mo**, with most of the variance coming from investor research/search volume.

## What I’d run

Use **DeepSeek V4 Flash as the default**.

Use **DeepSeek V4 Pro only for:**

| Task | Use Pro? |
|---|---:|
| Summarizing emails | No |
| Tagging emails | No |
| Linear issue summaries | No |
| Airtable cleanup | No |
| Investor data extraction | Usually no |
| Investor scoring / thesis fit | Yes |
| Important email drafts | Yes |
| Weekly CEO brief | Yes |
| Ambiguous multi-step ops decisions | Yes |

That gives you the economics of:

**Model cost:** probably **$20–$50/mo**  
**Search cost:** probably **$20–$80/mo**  
**Infra:** probably **$10–$25/mo**  
**Total:** **~$50–$150/mo**

## Reliability

OpenRouter should help with the timeout problem. Its paid plan says paid users with at least $10 in credits have **no limits on paid models**, while free-tier usage is rate-limited and popular free models can be provider-limited during peak times. citeturn936010view3

OpenRouter also supports fallback routing and says fallback attempts are billed only for the successful model run. citeturn936010view3

## Important privacy note

For **investor research and public data enrichment**, DeepSeek V4 is economically compelling.

For **your emails**, be more careful. DeepSeek’s privacy policy says it collects user input such as prompts, uploaded files, chat history, and related content, and says personal data may be directly collected, processed, and stored in the People’s Republic of China. citeturn672492search0

OpenRouter says it logs basic request metadata but does not log prompts/completions by default, and it can route based on provider privacy policies; however, it is still a proxy that sends requests to model providers. citeturn208244view0

My practical recommendation:

**Use DeepSeek V4 Flash/Pro for investor research, Linear, Airtable, and low-sensitivity ops. Use a stricter privacy provider/model for raw personal email bodies unless you are comfortable with the data path.**

Bottom line: with DeepSeek V4 via OpenRouter, this becomes a **$50–$150/mo project**, not a **$500–$1,500/mo project**, especially if you start with deterministic cron scripts instead of a full autonomous agent runtime.

---

## User

So then my next ask is for you to map out of all of the cron's that we've discussed previously and all of the ones that I currently have in our repo that are linked internal. Think about all the things that we're currently doing, all the things we could be doing, and what are the highest priority things that'll move the company forward. So off the top of my head, it's probably one, making sure that anytime a linear issue is open, it's able to automatically be worked on by the best model, have an issue planned with the best model, have the code executed with the best model, have those models use GBrain and Rooflow so that they're operating optimally, have them use Gstack so that the quality is there, and then have them automatically ship and land without any human intervention. And then the other things would be go-to-market, automations, and fundraising automations.

---

## Assistant

I’ll first inventory the current cron and automation entry points, then rank engineering, GTM, and fundraising workflows by impact, implementation risk, and company leverage.

---

## Assistant

I found the main Jovie/Ops repos and existing docs: cron registry, cron API routes, AI automation, Agent OS, and a May automation audit. A likely mismatch is `vercel.json` scheduling 9 paths while `purge-pixel-ips` appears only in the registry.

---

## Assistant

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
| **Synthetic Monitoring / Nightly Tests** | Production and regression monitoring | Exists |
| **PR Comment Hardening Retro** | Weekly Codex automation that learns from CodeRabbit/Greptile/Sentry/human comments | Exists |

The `linear-ai-orchestrator.yml` already dedupes existing PRs, caps work at **5 open agent PRs**, waits for CodeRabbit planning, uses Claude Code with `JOVIE_AGENT_PROFILE=coder`, commits/pushes the branch, and syncs Linear to In Progress/In Review. fileciteturn45file0

The automation docs also already say routine Linear AI dispatch should default to **economy**, reserve **premium** for explicit planner escalation, defer new work at five open agent PRs, and keep agents focused on targeted diffs/files instead of broad repo context. fileciteturn35file0

### Existing AgentOS architecture

AgentOS already has the right control-plane decision: **Linear is source of truth, GitHub Actions + GStack are the review/ship/deploy gates, Vercel Workflow/WDK is the durable coordinator, Hermes/Ruflo are execution adapters, and OpenRouter free/economy models are for read-only cognition.** fileciteturn36file0

The `AgentRunArtifact` schema already defines the exact action and gate vocabulary: model routes include `deterministic`, `openrouter-free`, `ai-sdk-gateway`, `claude-code`, and `codex-cli`; actions include read/classify/rank/summarize/draft/dispatch/write/open PR/merge/deploy; gates include `gstack.qa.exhaustive`, `gstack.review`, `gstack.ship`, GitHub CI, scope judge, CodeRabbit, Greptile, branch protection, land-and-deploy, and Sentry canary. fileciteturn44file0

### Existing GBrain, Ruflo, and GStack posture

The repo distinguishes the memory layers correctly:

| Layer | Best use |
|---|---|
| **GBrain** | Durable founder/company/strategy/cross-repo memory |
| **Ruflo** | Swarm-session coordination, claims, progress, shared memory |
| **GStack** | QA, review, ship, deploy discipline |

The repo uses **Ruflo**, not “Rooflow,” in the files I found. GStack docs say gbrain should be consulted for durable founder/strategic context, fundraising, pricing, competitive positioning, repeated decisions, and cross-repo recall; Ruflo agentdb is for swarm-session memory. fileciteturn41file0

For large parallel work, the Ruflo swarm pattern already defines claims, progress, shared memory, worktrees, HOT ZONE ownership, `/qa --exhaustive`, `/ship`, and auto-merge. fileciteturn42file0

### Existing fundraising/ops workspace

`JovieInc/Ops` is already the internal ops / FounderOS workspace. It has canon, content, fundraising, product, social, knowledge, and ideas directories. It also says the Hermes coder profile should use the sibling code workspace while ops files such as `company_state.md`, `daily_briefings/`, and `agent_tasks/` live in Ops. fileciteturn25file0 fileciteturn26file0

Fundraising is active: **Pre-seed target $500K, $25K committed, SAFE, in progress.** The fundraising folder has strategy, accelerators, investors, materials, and intake. fileciteturn27file0

The fundraising intake contract is already solid: one JSON per item, Linear as active queue, durable archive in Ops, and routing labels `agent:fundraise`, `agent:coder`, and `needs-tim`. fileciteturn28file0

## 2. Highest-priority company-moving automation map

### P0 — Engineering throughput: make every safe Linear issue ship itself

This is the top priority.

**Goal:** Any safe Linear issue can move from Todo → planned → implemented → PR → verified → merged → deployed with no founder bottleneck.

The no-human path should cover **safe implementation work**:

| Step | System | Model/tool |
|---|---|---|
| Issue intake | Linear | Deterministic + cheap model classification |
| Issue brief | AgentOS brief generator | DeepSeek V4 Flash/Pro or similar |
| Planning | CodeRabbit / planner model / GStack planning | Premium only when ambiguous |
| Execution | Claude Code / Codex / Hermes worker | Strong code model |
| Context | GBrain + targeted repo reads | GBrain only when durable context matters |
| Multi-agent chunks | Ruflo | Claims, progress, shared swarm memory |
| QA | GStack | `/qa --exhaustive` |
| Review | GStack + CodeRabbit + Greptile | Required gate evidence |
| Ship | GStack | `/ship` |
| Land/deploy | GitHub Actions + branch protection + Sentry canary | Auto-merge only when gates pass |

**Immediate work to finish:**

| Priority | Work item | Why it matters |
|---:|---|---|
| 1 | **Broaden Linear AI Dispatcher scope** | Audit says dispatcher was hardcoded to “Design V1 Rollout / Flag Hardening.” It should route across the real top-priority queue. fileciteturn34file0 |
| 2 | **Implement/finish AgentBrief generator** | Each run needs repo specs, gates, allowed/forbidden actions, model route, cost estimate, and human-gate status. The sync model already defines this. fileciteturn43file0 |
| 3 | **Enforce gate evidence before auto-land** | Missing `gstack.qa.exhaustive`, `gstack.review`, `gstack.ship`, CI, scope judge, bot review, branch protection, or Sentry canary should block landing. fileciteturn36file0 |
| 4 | **Add daily AgentOps health report** | Audit identified this as a top gap: dispatched, merged, failed, needs-human, cost, time-to-merge. fileciteturn34file0 |
| 5 | **Sync GBrain after material merges** | Keep durable strategy/code context searchable without making every agent reread the repo. The sync skill exists. fileciteturn40file0 |

**Auto-land rules I’d use:**

Auto-land allowed when all are true:

- Linear issue is agent-owned.
- No `human-review-required`.
- No auth, billing, security, migrations, production data mutation, or outbound-send changes.
- AgentBrief forbids protected actions.
- GStack QA/review/ship pass.
- CI, branch protection, CodeRabbit/Greptile, scope judge pass.
- Sentry canary is clean.
- Cost estimate is under the per-run cap.
- Open agent PR count is below the current cap.

Human gate required for:

- Auth, billing, security, permissions, privacy, user data, production data, database migrations, dependency upgrades with security implications, outbound sends, investor/customer emails, legal/company formation, or anything that changes brand/canon facts.

### P1 — Fundraising automation: increase cash probability

Given the active pre-seed and cash constraints, this is next.

**Goal:** Every day, the system should increase the number of high-fit investors with a clear next action.

The Ops repo already has the fundraising structure and intake schema. Use that as the source of truth, with Linear as the active queue. fileciteturn27file0 fileciteturn28file0

Highest-value fundraising crons/scripts:

| Automation | Cadence | Output |
|---|---:|---|
| `investor_research_batch` | Nightly | 25–100 investors enriched and scored |
| `intro_path_finder` | Nightly | Likely intro paths from known people/companies/emails |
| `fundraising_email_digest` | 7am daily | Investor emails, follow-ups due, reply drafts |
| `fundraising_followup_queue` | Daily | “Due today” follow-ups with suggested copy |
| `materials_drift_check` | Weekly | Flags stale deck/app/site metrics versus canon |
| `accelerator_application_refresher` | Weekly / on demand | Drafts answers using the application KB |

The `JovieApplication` repo is already an accelerator/investor application knowledge base with question management, answer editing, smart tagging, and 142 questions across accelerators. Use it as the source for accelerator drafts and investor application answers. fileciteturn14file0

### P1 — GTM automation: produce artist leads and demos

Jovie’s canon says the GTM motion is founder-led distribution through electronic music, product virality via “Powered by Jovie,” direct outreach to musicians already using fragmented tools, and content marketing based on founder expertise. fileciteturn30file0

Highest-value GTM automations:

| Automation | Cadence | Output |
|---|---:|---|
| `artist_lead_discovery` | Nightly or capped inside `/frequent` | Artists/DJs with active releases and weak link-in-bio setup |
| `fragmented_tool_detector` | Nightly | Artists using Linktree, Feature.fm, Linkfire, Toneden, etc. |
| `spotify_artist_enrichment` | Nightly | Artist profile, genre, release cadence, social links |
| `personalized_demo_generator` | On lead approval | Demo Jovie profile / smart-link pitch angle |
| `outbound_draft_queue` | Daily | Drafts only; human approves sends |
| `signup_activation_recovery` | Daily | Users who signed up but did not connect Spotify/publish |
| `gtm_daily_brief` | 8am daily | Leads found, demos ready, replies, signups, revenue movement |

The existing `leadDiscovery` and `outreach` sub-jobs inside `/api/cron/frequent` are the place to attach this, with strict caps. The audit specifically called lead discovery the highest recurring cost risk because SerpAPI can run every 15-minute tick when enabled. fileciteturn33file0 fileciteturn34file0

### P2 — Founder chief-of-staff scripts

These are the cron-only scripts from the earlier discussion. Keep them outside the product app unless they need app data.

| Script | Cadence | Priority |
|---|---:|---|
| `daily_brief.py` | 7–8am daily | High |
| `email_digest.py` | 7am daily | High |
| `reply_drafter.py` | On demand / morning | High |
| `linear_watch.py` | Every 30–60 min | Superseded by AgentOS dispatcher |
| `investor_enrich.py` | Overnight | High |
| `ops_router.py` | On demand | Medium |

The daily brief should combine: Linear queue health, open agent PRs, failed automations, fundraising follow-ups, investor emails, GTM leads, product incidents, runway/cost notes, and “needs Tim” decisions.

## 3. New cron / automation backlog

This is the order I’d implement.

| Rank | Automation | Type | Why |
|---:|---|---|---|
| 1 | `agentos_dispatcher_v2` | GitHub Action / Workflow | Generalize Linear issue dispatch beyond the current narrow project |
| 2 | `agentos_brief_generator` | Workflow step | Gives every agent the right model route, repo specs, gates, and forbidden actions |
| 3 | `agentos_gate_enforcer` | Workflow step | Blocks auto-land unless required evidence exists |
| 4 | `agentops_health_report` | Daily + weekly | Shows whether automation is actually increasing throughput |
| 5 | `gbrain_sync_on_merge` | On merge / nightly | Keeps durable repo/company memory fresh |
| 6 | `fundraising_email_digest` | Daily | Directly protects cash and follow-up discipline |
| 7 | `investor_research_batch` | Nightly | Expands the funding pipeline |
| 8 | `intro_path_finder` | Nightly | Converts investor research into reachable asks |
| 9 | `gtm_lead_discovery_capped` | Nightly or gated `/frequent` | Finds high-intent artists |
| 10 | `personalized_demo_generator` | On approved lead | Makes outreach concrete |
| 11 | `outbound_draft_queue` | Daily | Drafts copy without auto-sending |
| 12 | `materials_drift_check` | Weekly | Keeps deck/applications/canon consistent |
| 13 | `automation_cost_report` | Daily/weekly | Prevents model/search spend surprises |

## 4. Model routing

Use cheap models for cognition, strong models for code.

| Work | Model route |
|---|---|
| Cron health checks, status sync, label routing | Deterministic |
| Linear triage, issue classification, brief prefill | DeepSeek V4 Flash / cheap OpenRouter model |
| Investor enrichment first pass | DeepSeek V4 Flash |
| Investor scoring, nuanced fit, outbound draft | DeepSeek V4 Pro / stronger model |
| Email summaries | DeepSeek V4 Flash for low-sensitivity; stricter provider for sensitive email |
| Code planning | Strong planner only when ambiguous |
| Code execution | Claude Code / Codex / Hermes worker |
| CI/Sentry autofix | Claude Code / Codex |
| Architecture, product taste, high-risk planning | Premium planner / Opus-class model |
| Auth/billing/security/migrations | Strong model + human gate |

The AgentOS architecture already says OpenRouter economy/free models are for classify/rank/summarize/draft internal artifacts and should not own code mutation, security, billing, auth, or outbound sends. fileciteturn36file0

## 5. The actual top company-moving sequence

Do this in order:

1. **Finish AgentOS safe auto-land.**  
   This turns Linear into an execution engine.

2. **Add AgentOps daily health report.**  
   Measure dispatches, merges, failures, time-to-merge, cost, and stuck reasons.

3. **Generalize Linear AI Dispatcher.**  
   Move from narrow project scope to priority/label-based company queue.

4. **Add AgentBrief generator and gate enforcement.**  
   This makes the system safe enough to run without you.

5. **Add GBrain sync on merge and decision-page writes.**  
   Future agents stop rediscovering context.

6. **Launch fundraising digest + investor enrichment.**  
   Cash is tight; this has immediate company impact.

7. **Launch capped GTM lead discovery + personalized demos.**  
   Focus on artists already showing buying intent.

8. **Add materials drift checker.**  
   Keep canon, deck, site, and applications consistent.

9. **Add cost report and model broker.**  
   Route cheap work to DeepSeek/OpenRouter, code work to premium models, cap all recurring jobs.

## 6. My recommended operating principle

Use **Linear as the command queue**, **AgentOS as the coordinator**, **GBrain as long-term memory**, **Ruflo as swarm memory**, **GStack as the quality gate**, and **GitHub Actions as the authority to merge/deploy**.

For the next build sprint, I’d prioritize one outcome:

**Every safe Linear issue auto-ships or produces a clear `needs-tim` reason with cost, failed gate, and next action.**

That one loop moves product, stability, GTM infrastructure, and fundraising automation faster than any standalone cron.


## See Also
- [[chatgpt/chatgpt_branch-cost-of-ai-operations-part1]]
- [[chatgpt/chatgpt_branch-cost-of-ai-operations-part2]]
- [[chatgpt/chatgpt_branch-cost-of-ai-operations-part3]]
- [[chatgpt/chatgpt_ai-operations-optimization]]
- [[chatgpt/chatgpt_gtm-operations-and-tools-part1]]
