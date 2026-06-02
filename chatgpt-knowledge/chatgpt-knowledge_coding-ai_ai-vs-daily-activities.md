---
title: "AI vs Daily Activities"
type: guide
created: 2026-05-01
updated: 2026-05-01
source: chatgpt-export
topic: coding-ai
message_count: 7
tags: [chatgpt, knowledge, coding-ai]
---
**Topic:** [[chatgpt-knowledge/_topics/coding-ai]]

# AI vs Daily Activities

> **Source:** ChatGPT conversation
> **Date:** 2026-05-01T00:17:58Z
> **Messages:** 7
> **Topic:** coding-ai

## Question

For all the haters that are bullshitting and claiming how bad everything is for the environment while posting about it on how bad AI is for the environment while posting on social media and watching Netflix and using Spotify and overnighting Shein orders and Amazon orders and doing all this shit, can you give me like a comparison breakdown chart of roughly, like, you know, what using a Snapchat AI filter burns in environmental cost or what using, like, you know, asking a question in ChatGPT or generating an image with, like, image 2 or something? Can you just, like, break down a couple of practical examples of daily AI use versus, like, everything else and then put it in a table in comparison that I can use when people tell me how bad AI is for the environment and I tell them to go eat shit?

## Answer

I’ll build this as a practical rebuttal table using published estimates, with ranges and clear caveats where per-use AI numbers are proxies.

## Answer

A useful pattern is emerging: ordinary text prompts are tiny per use, image generation is higher, and streaming, shipping, driving, food, and fast fashion dominate quickly.

## Answer

Mr. White, here’s the practical comparison. I’m using **one average ChatGPT text prompt = ~0.34 Wh** as the baseline. At the 2024 U.S. grid average of **~384 gCO₂/kWh**, that is roughly **0.13 gCO₂** per prompt, though actual provider emissions vary a lot by data center and energy accounting. OpenAI’s Sam Altman gave the **0.34 Wh** and **~0.32 mL water** figure; Google reports a median Gemini text prompt at **0.24 Wh, 0.03 gCO₂e, and 0.26 mL water**. citeturn284447search0turn893049search0turn355966search0

| Activity | Rough environmental cost | Equivalent to about… | Notes |
|---|---:|---:|---|
| **1 ChatGPT text question** | ~0.34 Wh; ~0.13 gCO₂ on avg U.S. grid; ~0.32 mL water | **1 prompt** | Best public OpenAI-linked number, but no full audited methodology. citeturn284447search0 |
| **1 Gemini-style AI text prompt** | 0.24 Wh; 0.03 gCO₂e; 0.26 mL water | ~0.2–1 prompt | Google’s own production measurement; cleaner-energy accounting lowers CO₂. citeturn893049search0 |
| **10 ChatGPT questions** | ~3.4 Wh; ~1.3 gCO₂ | **10 prompts** | Still tiny at personal scale. |
| **1 AI image generation** | ~2.9 Wh average in a 2024 model study; ~1 gCO₂ on U.S.-ish grid | **~9 text prompts** | Image generation is much heavier than text. One study found **2.907 kWh per 1,000 image generations**; newer image models vary dramatically, up to ~46x across tested models. citeturn345139view1turn121090view0 |
| **Snapchat AI/AR filter, 1 minute** | No public audited per-filter number; proxy: Snapchat story/feed use measured at **~0.65 gCO₂e/min** | **~5 prompts/min** | If it runs mostly on-device, it is phone/data usage. If it calls cloud genAI, use the AI-image row. Greenspector measured Snapchat feed/story use, not a specific AI lens. citeturn652385view0 |
| **Spotify audio, 1 hour** | ~1 gCO₂e/hour estimate | **~8 prompts** | Audio streaming is relatively light compared with video. Greenly’s Spotify estimate is ~1.04 gCO₂e/hour. citeturn546677search1 |
| **Snapchat/TikTok/social scrolling, 10 minutes** | Snapchat: ~6.5 gCO₂e; TikTok: ~9.6 gCO₂e using 2023 Greenspector figures | **~50–75 prompts** | Social feeds add up because people do them for hours. citeturn652385view0 |
| **Social media, ~2 hours/day** | Roughly ~75–145 gCO₂e/day depending app mix | **~575–1,100 prompts** | Greenspector estimated 1h55/day social use can become **20–40 kgCO₂e/year** depending platform. citeturn652385view0 |
| **Netflix / video streaming, 1 hour** | ~36–55 gCO₂e/hour | **~275–420 prompts** | IEA estimated ~36 gCO₂/hour; Carbon Trust estimated ~55 gCO₂e/hour for European video streaming. citeturn792948search0turn792948search7 |
| **Driving 1 mile in an average gas car** | ~400 gCO₂ | **~3,000 prompts** | EPA’s typical passenger vehicle estimate. citeturn766372search0 |
| **One standard 1 kg e-commerce parcel delivered home** | ~1,075 gCO₂e | **~8,000 prompts** | Oliver Wyman estimated this for common postal delivery in Europe; exact U.S. deliv

*(Answer truncated — 4798 chars total)*

## Question

How are we counting “ai” vs just serverless infrastructure etc

## Answer

I’ll separate the accounting problem into layers: model compute, supporting cloud overhead, user-device/network overhead, and company-wide infrastructure allocation. That distinction drives most disagreement in AI footprint claims.

## Answer

Mr. White, **“AI” is a workload, not an infrastructure category**. Serverless, GPUs, databases, CDNs, storage, networking, and cooling are all infrastructure. The clean way to count it is by **what portion of the infrastructure exists or runs because of the AI feature**.

### The useful accounting split

| Layer | Count as “AI”? | Why |
|---|---:|---|
| User’s phone/laptop screen time | Usually **no**, or count separately | Same device cost exists for social media, Netflix, browsing, etc. |
| Network transfer / CDN / API gateway | **Partly** | Every app request uses this. Count the incremental traffic caused by the AI feature. |
| Serverless/backend orchestration | **Partly** | Lambda/API/db/auth/logging is normal cloud overhead. Count it if the AI request triggers it, but separate it from model compute. |
| Model inference compute | **Yes** | This is the core AI cost: GPU/TPU/accelerator time, CPU/RAM, batching, decoding, safety passes, tool calls. |
| Idle/reserved accelerator capacity | **Yes, for allocated footprint** | Production AI systems keep spare capacity for latency, traffic spikes, failover, and reliability. Google explicitly includes idle machines in its comprehensive AI prompt methodology. citeturn392052view0 |
| Data-center overhead | **Yes, allocated proportionally** | Cooling, power distribution, networking, storage, UPS, etc. are part of delivering the workload. IEA breaks data-center electricity into servers, storage, networking, cooling, UPS, and other infrastructure. citeturn281461view3 |
| Training the model | **Depends** | For “what did this one prompt cost?” usually amortized or excluded. For “what is AI as an industry costing?” include training, R&D, hardware buildout, and deployment. |
| Embodied hardware carbon | **Depends** | For serious corporate/LCA accounting, include servers, GPUs, data centers, supply chain. For per-prompt casual comparisons, it is often omitted or amortized. |
| Electricity carbon intensity | **Always disclose method** | Location-based uses the grid where the data center runs; market-based reflects contracts/RECs/clean-energy procurement. GHG Protocol Scope 2 guidance standardizes electricity-emissions accounting and energy-contract disclosures. citeturn392052view1 |

### The clean formula

For a single AI feature request:

```text
Full AI request footprint =
  user device energy
+ network/CDN transfer
+ frontend/backend/serverless orchestration
+ model inference compute
+ safety/filtering/tool-call compute
+ storage/RAG/vector DB/database usage
+ allocated idle capacity
+ allocated data-center overhead
+ allocated water/cooling
+ optionally amortized training + hardware embodied carbon
```

For the **AI-specific premium**, subtract the non-AI baseline:

```text
AI premium =
  footprint of app request with AI
- footprint of same app request without AI
```

That distinction matters. A Snapchat filter, ChatGPT prompt, or AI search result still uses normal cloud plumbing. The AI part is the

*(Answer truncated — 6109 chars total)*
