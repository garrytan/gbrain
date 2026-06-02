---
title: "Cloudflare Credits for AI"
type: note
created: 2026-05-17
updated: 2026-05-17
source: chatgpt-export
conversation_id: 6a0a126f-7c00-83e8-89ed-a0d71df0fbd9
message_count: 3
tags: [chatgpt, import, long-form]
---
# Cloudflare Credits for AI

> Conversation ID: 6a0a126f-7c00-83e8-89ed-a0d71df0fbd9
> Created: 2026-05-17T19:09:37Z
> Updated: 2026-05-17T19:31:35Z
> Messages: 3

---

## User

cloudflare might be giving us 100k in credits through stripe perks. what can we do with that? can we use it for AI models?

---

## Assistant

Mr. White, I’ll verify the current Cloudflare/Stripe credit terms and map eligible products to practical uses, especially Workers AI, AI Gateway, and model inference coverage.

---

## Assistant

Mr. White, yes — **you can use Cloudflare credits for AI**, but the useful answer is:

**Assume only up to ~$50k is usable for Workers AI model inference, and only ~$250 is usable for AI Gateway, unless Cloudflare confirms otherwise for your account.** The rest is best used for edge compute, storage, security, delivery, and data infrastructure.

Cloudflare’s Startup Program page says the $100k tier covers usage-based services for one year, including Workers, Durable Objects, Workflows, KV, D1, Queues, Vectorize, R2, Pages, Images/Stream, Cache Reserve, Argo, Workers AI, and AI Gateway. It also states specific caps: **R2 up to $10k, Workers AI up to $50k, AI Gateway up to $250**. Credits expire after **one year or full consumption**, whichever comes first. citeturn846858view0

## What you can do with it

### 1. Run Cloudflare-hosted AI models

Use **Workers AI** for inference directly on Cloudflare. Cloudflare currently lists dozens of models, including hosted text-generation, embeddings, image, audio, and classification models; their model page shows 78 Workers AI models, including Kimi, GLM, OpenAI gpt-oss, Llama, and others. citeturn465081view1

Practical uses:

| Use case | Cloudflare products |
|---|---|
| Chat / agents | Workers + Workers AI |
| RAG / semantic search | Workers AI embeddings + Vectorize + R2 |
| Moderation / guardrails | Workers AI + AI Gateway guardrails |
| Audio transcription | Workers AI Whisper / Deepgram models |
| Image generation / processing | Workers AI image models + Images / R2 |
| Customer-support bot | Workers AI + D1 / KV / Vectorize |
| Low-latency AI endpoint | Workers + Workers AI close to users |

Workers AI pricing is token/model-specific, billed through “Neurons,” with the paid rate listed as **$0.011 per 1,000 Neurons**; Cloudflare also publishes per-token equivalent pricing for each model. citeturn253133view0

Roughly, the **$50k Workers AI cap** could buy approximately:

| Model/task | Current Cloudflare price | Rough $50k capacity |
|---|---:|---:|
| `@cf/openai/gpt-oss-120b` | $0.350/M input, $0.750/M output | ~45.5B input + ~45.5B output tokens, assuming equal input/output |
| `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | $0.293/M input, $2.253/M output | ~19.6B input + ~19.6B output tokens, assuming equal input/output |
| `@cf/moonshotai/kimi-k2.6` | $0.950/M input, $4.000/M output | ~10.1B input + ~10.1B output tokens, assuming equal input/output |
| `@cf/baai/bge-m3` embeddings | $0.012/M input tokens | ~4.17T embedding tokens |
| `@cf/openai/whisper` | $0.0005/audio minute | ~100M audio minutes |

Those examples come from Cloudflare’s Workers AI pricing table. citeturn253133view2turn253133view3turn253133view4

### 2. Use AI Gateway, mainly for control and observability

**AI Gateway** is useful even if the credit cap is small. It gives you logging, analytics, caching, rate limiting, retries, fallback routing, and cost visibility across AI providers. Cloudflare says AI Gateway is available on all plans and its core features include dashboard analytics, caching, and rate limiting. citeturn465081view2

Use it to:

| Use case | Why it matters |
|---|---|
| Track per-user/per-workflow AI costs | See which features are burning tokens |
| Cache repeated prompts | Reduce OpenAI/Anthropic/Workers AI spend |
| Rate-limit abuse | Prevent runaway AI costs |
| Add fallback routing | Try another model/provider if one fails |
| Log prompts/responses | Debug quality and latency |
| Add DLP / guardrails | Reduce sensitive-data leakage risk |

For third-party models, Cloudflare’s docs say AI Gateway Unified Billing can connect to providers like **OpenAI, Anthropic, and Google AI Studio**, and those calls deduct credits from the Cloudflare account. They also clarify that `@cf/` Workers AI models are billed through Workers AI pricing, while third-party models use Unified Billing. citeturn431070view0

The key caveat: the Startup Program page caps **AI Gateway at $250**, so I would treat OpenAI/Anthropic/Gemini-via-Gateway as **not a path to spend the full $100k** until Cloudflare confirms that Stripe-perk promotional credits apply to third-party Unified Billing. The safer assumption is:

**Workers AI = yes, up to $50k.  
Third-party OpenAI/Anthropic through AI Gateway = maybe, but probably limited by the $250 AI Gateway cap unless your Cloudflare rep says otherwise.**

### 3. Move infra to Cloudflare and use credits aggressively

Best high-ROI places to spend the rest:

| Area | Products | Good use |
|---|---|---|
| Edge APIs | Workers | Replace small backend services, auth middleware, webhooks, API proxies |
| Stateful coordination | Durable Objects | Sessions, rate limits, multiplayer/presence, queues, per-user state |
| Async jobs | Queues + Workflows | AI job pipelines, retries, background tasks |
| Static/frontend hosting | Pages | Web app deploys |
| Object storage | R2, capped at $10k | Assets, generated images/video, exports, logs |
| Vector search | Vectorize | RAG, recommendations, semantic lookup |
| Serverless SQL | D1 | Lightweight app metadata, config, user/project records |
| Key-value config/cache | KV | Feature flags, auth/session cache, global config |
| Media | Images and Stream | Image transforms, video hosting/streaming |
| Performance | Cache Reserve, Argo Smart Routing | Faster global delivery and lower origin load |
| Security | WAF, DDoS, bot protection, SSL, Page Shield | Harden the app without burning normal cloud budget |

Cloudflare says the credits cover usage-based services, and separate core security/networking benefits are included at no cost in the program, including three enterprise domains, unlimited Business/Pro plans, DDoS/bot protection, WAF rules, SSL, CDN/DNS, limited load balancing, and rate limiting. citeturn846858view0

### 4. What it probably does **not** cover

Cloudflare’s FAQ says the program excludes **Registrar services**, Enterprise feature add-ons unless requested, Magic Transit, Enterprise Spectrum, Dedicated IPs, and China Network. citeturn846858view0

So: use it for **infrastructure and AI inference**, not domain purchases, dedicated IPs, or specialized enterprise network products.

## Recommended plan

Use it like this:

| Bucket | Suggested allocation | Why |
|---|---:|---|
| Workers AI | Up to $50k | Max out AI inference experiments, RAG, transcription, agents |
| R2 | Up to $10k | Generated media, assets, logs, exports |
| Workers / Durable Objects / Queues / Workflows | $15k–$25k | Edge backend, AI pipelines, orchestration |
| Vectorize / D1 / KV | $5k–$15k | RAG, app data, caching |
| Images / Stream / Cache / Argo | Variable | Media delivery and performance |
| AI Gateway | Up to $250 | Observability, caching, rate limits, guardrails |

For Jovie, I’d use this to build a **Cloudflare AI edge layer**: Workers as the API, Workers AI for cheaper inference/transcription/embeddings where quality is acceptable, AI Gateway for OpenAI/Anthropic observability, Vectorize for memory/search, R2 for generated assets, and Queues/Workflows for long-running AI jobs.

The one question to ask Cloudflare or Stripe before committing architecture: **“Do Stripe Atlas Startup Program credits apply to AI Gateway Unified Billing for third-party models like OpenAI/Anthropic, or only to Workers AI under the $50k cap?”**
