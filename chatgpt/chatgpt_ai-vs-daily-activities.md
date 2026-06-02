---
title: "AI vs Daily Activities"
type: guide
created: 2026-05-01
updated: 2026-05-01
source: chatgpt-export
conversation_id: 69f3f135-e0ec-83e8-9806-3383ce7ea78b
message_count: 7
tags: [chatgpt, import, code, long-form]
---
# AI vs Daily Activities

> Conversation ID: 69f3f135-e0ec-83e8-9806-3383ce7ea78b
> Created: 2026-05-01T00:17:58Z
> Updated: 2026-05-01T00:55:02Z
> Messages: 7

---

## User

For all the haters that are bullshitting and claiming how bad everything is for the environment while posting about it on how bad AI is for the environment while posting on social media and watching Netflix and using Spotify and overnighting Shein orders and Amazon orders and doing all this shit, can you give me like a comparison breakdown chart of roughly, like, you know, what using a Snapchat AI filter burns in environmental cost or what using, like, you know, asking a question in ChatGPT or generating an image with, like, image 2 or something? Can you just, like, break down a couple of practical examples of daily AI use versus, like, everything else and then put it in a table in comparison that I can use when people tell me how bad AI is for the environment and I tell them to go eat shit?

---

## Assistant

I’ll build this as a practical rebuttal table using published estimates, with ranges and clear caveats where per-use AI numbers are proxies.

---

## Assistant

A useful pattern is emerging: ordinary text prompts are tiny per use, image generation is higher, and streaming, shipping, driving, food, and fast fashion dominate quickly.

---

## Assistant

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
| **One standard 1 kg e-commerce parcel delivered home** | ~1,075 gCO₂e | **~8,000 prompts** | Oliver Wyman estimated this for common postal delivery in Europe; exact U.S. delivery varies. citeturn487829view2 |
| **Same-day / rushed shipping** | Can be **10–12% higher** for same demand; same-day can be **3–4x** standard in some models | **Thousands to 30k+ prompts** | Fast shipping hurts consolidation: half-full vans, repeated neighborhood trips, and sometimes air freight. Delaying 1–2 days can cut delivery CO₂ by ~36%; 3–4 days by ~56%. citeturn487829view0turn487829view1 |
| **Fast-fashion jeans, one “wear” in a fast-fashion model** | ~2.5 kgCO₂e | **~19,000 prompts** | A 2024 fast-fashion jeans LCA estimated 2.50 kgCO₂e per wear. citeturn714421search1 |
| **Shein transport footprint, company scale** | 8.52 million metric tons CO₂e from transport in 2024 | Company-scale issue | Shein’s transport emissions rose 13.7% in 2024, driven heavily by air-freighted direct-to-consumer logistics. citeturn714421search0 |
| **¼ lb beef patty, beef only** | ~6.8 kgCO₂e | **~52,000 prompts** | Based on Our World in Data’s ~60 kgCO₂e/kg beef figure. citeturn813210search0 |

**Use this as the comeback:**

> A ChatGPT text question is roughly a fraction of a gram of CO₂. One hour of Netflix is hundreds of AI text prompts. One gas-car mile is thousands. One standard package delivery is thousands more. Same-day shipping, fast-fashion hauls, beef, and endless social/video scrolling are orders of magnitude bigger than casual AI text use.

**The honest caveat:** AI is a real infrastructure issue at scale. IEA says global data centers used about **415 TWh in 2024**, roughly **1.5% of global electricity**, and projects data-center electricity use could roughly double by 2030. It also warns that AI video, reasoning, and agentic workflows can be **hundreds or thousands of times** heavier than simple text prompts. citeturn103188view0turn103188view1

---

## User

How are we counting “ai” vs just serverless infrastructure etc

---

## Assistant

I’ll separate the accounting problem into layers: model compute, supporting cloud overhead, user-device/network overhead, and company-wide infrastructure allocation. That distinction drives most disagreement in AI footprint claims.

---

## Assistant

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

That distinction matters. A Snapchat filter, ChatGPT prompt, or AI search result still uses normal cloud plumbing. The AI part is the **extra accelerator/model-serving path** plus the capacity reserved to serve it reliably.

### What Google’s AI-prompt number is counting

Google’s published Gemini prompt methodology is closer to a **full-stack serving footprint** than a narrow “GPU only” number. It includes dynamic power, achieved utilization, idle machines, CPU/RAM, data-center overhead/PUE, and water consumption. Google says a narrow active-TPU/GPU-only method would estimate **0.10 Wh** for a median Gemini text prompt, while its comprehensive method estimates **0.24 Wh**. citeturn392052view0

That is the exact point: **GPU-only numbers undercount; company-wide data-center buildout numbers over-attribute to one prompt.** The credible middle is allocated production serving cost.

### Where serverless fits

Serverless is counted like any other cloud service: allocate emissions based on usage. AWS says its customer carbon tool covers services like EC2, S3, CloudFront, Lambda, and more; its allocation method maps emissions from clusters to server racks, then to services, then to customer accounts. AWS also says its methodology allocates unused capacity and data-center overhead to customers because that capacity is required to provide the service. citeturn522045view1

So for a real product, you would break it down like this:

| Example request | “AI” portion | “Regular cloud” portion |
|---|---|---|
| ChatGPT text prompt | Model inference, safety, routing, idle model capacity | Web app, auth, logs, billing, networking |
| AI image generation | Diffusion/image model compute, moderation, GPU capacity | Upload/download, storage, account services |
| Snapchat AI filter | Model inference if cloud-based; on-device ML if local | App UI, camera processing, CDN, social graph, uploads |
| AI search answer | LLM inference, retrieval/ranking, citations, safety | Search index, web crawling, API, cache, page serving |
| Normal social media post | Usually none | App servers, feed ranking, CDN, storage, device/network use |

### The best way to argue it

Use three buckets:

| Claim type | What it means | Fair use |
|---|---|---|
| **Marginal per-use cost** | Extra energy from one additional prompt or image | Best for comparing one AI prompt to one Netflix hour, one car mile, one package, etc. |
| **Allocated service cost** | Share of production infrastructure assigned to each request | Best for honest product-level comparisons. |
| **Industry buildout cost** | Data centers, chips, training, power contracts, grid strain | Best for macro arguments about AI growth. |

A fair sentence:

> “For one user action, I’m comparing allocated per-request serving cost. That includes model compute and real data-center overhead, while separating out generic cloud plumbing. If we want to debate industry-scale AI buildout, that’s a different category than pretending one text prompt is equivalent to a car trip.”

That is the clean distinction. A lot of anti-AI environmental takes quietly jump from **per-prompt criticism** to **global data-center buildout criticism** without saying they changed accounting boundaries.


## See Also
- [[chatgpt/chatgpt_ai-song-uploads-daily]]
- [[chatgpt/chatgpt_cliché-valentines-day-activities]]
- [[chatgpt/chatgpt_daily-calorie-calculation-maintenance-vs-workout]]
- [[chatgpt/chatgpt_daily-macronutrient-intake-estimate]]
- [[chatgpt/chatgpt_daily-meal-summary]]
