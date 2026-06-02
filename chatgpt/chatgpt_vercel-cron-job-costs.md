---
conversation_id: 69924ba7-449c-8329-8e17-3c95695f161e
created: 2026-02-15
links:
- '[[chatgpt-clusters/coding_devops]]'
message_count: 10
source: chatgpt-export
tags:
- chatgpt
- import
- long-form
title: Vercel Cron Job Costs
type: note
updated: 2026-02-15
---

# Vercel Cron Job Costs

**Related:** [[coding_devops]]

> Conversation ID: 69924ba7-449c-8329-8e17-3c95695f161e
> Created: 2026-02-15T22:42:05Z
> Updated: 2026-02-15T22:48:48Z
> Messages: 10

---

## User

Hey, for our MVP, I'm scheduling cron jobs right now. 370, so like if a cron job runs every five minutes versus like once a day, it's like the cost difference for an MVP on Versal.

---

## Assistant

Mr. White — on **Vercel** (I’m assuming that’s what you meant by “Versal”), the key thing is:

- **Cron Jobs themselves are included**, but **each cron run is just a Vercel Function invocation**, so the **Function usage + pricing** is what changes with frequency. citeturn1view0
- Also: on **Hobby**, Vercel cron jobs can **only run once per day**—anything more frequent fails deployment. citeturn1view0

### Cost difference: every 5 minutes vs once per day
It scales almost perfectly linearly with the number of executions.

- Every 5 minutes = **288 runs/day**
- Once per day = **1 run/day**
- So **~288× more invocations/compute** (and **~8,640 runs/month** vs **~30 runs/month**)

### What that means in dollars (rule of thumb)
Vercel Functions pricing is driven by:
1) **Active CPU time**
2) **Provisioned memory duration**
3) **Invocation count** citeturn1view1

Invocation charges are usually tiny at MVP scale (e.g., 8,640/month is far under the **1M included** on the pricing page). citeturn1view1  
So the real driver is: **how long the function runs and how much memory you allocate**.

### Quick example (to sanity-check your MVP)
Using the “starting at” rates shown on Vercel’s pricing page (CPU $/hr, memory $/GB-hr, invocations $/1M): citeturn1view1

If your cron function is “light” (say ~**1s active CPU**, ~**0.5GB**, ~**2s lifetime**):
- **Every 5 minutes**: on the order of **tens of cents/month**
- **Once/day**: basically **near-zero**

If it’s heavier (say **10s CPU**, **1GB**, **10s lifetime**):
- **Every 5 minutes**: a **few dollars/month**
- **Once/day**: still close to zero

### MVP takeaway
- If you truly need **every 5 minutes**, you’re effectively committing to **Pro** (because Hobby is once/day max). citeturn1view0
- The **multiplier is 288×**; plug in your function’s CPU seconds + memory seconds and you’ve got the real answer.

If you tell me **(a)** memory setting (e.g., 512MB/1GB) and **(b)** typical runtime (CPU seconds + roughly how long it’s “alive”), I can compute a tight monthly estimate from the published rates.

---

## User

So with like 10,000 monthly active users, what would the cost be?

---

## Assistant

Mr. White — **10,000 MAU doesn’t determine Vercel cost by itself.** Cost is driven by **how many function invocations happen** (including cron runs + API traffic) and **how much CPU time + memory time each invocation uses**. Vercel’s “Fluid compute” for Functions is billed on **Active CPU time + Provisioned Memory + Invocations**, with some included each month. citeturn0search0turn0search2

Also, if you need cron **more than once/day**, that generally pushes you off **Hobby** (Hobby cron is once/day max). citeturn0search1  
And **Pro seats are $20/month per member**. citeturn0search3

## What it costs for 10,000 MAU: the only two realistic patterns

### 1) One global cron job (same job regardless of users)
Example: “recompute metrics,” “send digest emails,” etc.

Every 5 minutes = **8,640 runs/month**.

That’s **way under the 1M invocations/month included** on the pricing page, so invocations usually aren’t the issue at MVP scale. citeturn0search0  
The question becomes: **how heavy is each run?**

Using Vercel’s published rates (typical US regions: **$0.128 per CPU-hr** and **$0.0106 per GB-hr memory**, with **4 CPU-hrs + 360 GB-hrs included**): citeturn0search0turn0search2

- **Light cron** (≈1s CPU, 0.5GB for 2s): you’re likely **still inside included usage** → compute cost ≈ **$0**, you mostly pay **the Pro seat(s)** if you need >daily cron.  
- **Moderate cron** (≈10s CPU, 1GB for 10s): CPU ≈ 24 CPU-hrs/month → **~20 CPU-hrs over included** → about **$2.56/month** in CPU overage (plus seats). Memory would still be far under 360 GB-hrs included. citeturn0search0turn0search2  
- **Heavy cron** is when you start feeling it (long runtimes, big memory, lots of data scanning).

So for a **single global cron**, 10k MAU often doesn’t change your bill much.

### 2) Per-user scheduled work (cost scales with MAU)
If you effectively do “a job per user” (or per user segment) — e.g., you enqueue work for each user, or hit an endpoint per user — then MAU matters.

Rule of thumb:
- If you do **1 function call per user per day**:  
  10,000/day → **~300,000/month** (still under 1M included invocations). citeturn0search0
- If you do **1 per user every 5 minutes** (don’t do this):  
  10,000 × 8,640/month = **86.4 million invocations/month** → invocations + compute will dominate fast. citeturn0search0

## The minimum you should budget (typical MVP reality)
- If you need cron more than daily: **at least Pro seat(s)** → **$20/user/month**. citeturn0search3turn0search1  
- Compute overage is often **$0–single digits/month** unless your cron runs are heavy or you’re doing per-user work.

## If you give me 2 numbers, I’ll calculate it precisely
1) For your cron function: **average runtime in seconds** (roughly CPU-active time)  
2) **memory size** you’re using (GB; common is 2GB by default on Pro) citeturn0search16

…and tell me whether it’s **one global job** or **per-user**, and I’ll spit back a monthly estimate using Vercel’s published rates. citeturn0search2turn0search0

---

## User

I have cron jobs to basically clean up data retention, forward pixels for analytics, process campaigns for users, scheduling release notifications, and then actually sending the emails, generating insights based on your data. And those have various times and stuff. That's where we're at right now, and that would be per user. So estimate costs on 10,000 API active users for that, if all of those jobs were, say, every five minutes.

---

## Assistant

Mr. White — if you literally run **each of those per-user jobs every 5 minutes**, Vercel cost will explode mainly from **invocations + compute** (and you’ll be on **Pro** because Hobby cron is once/day max). citeturn0search1turn0search5turn1view0

### Step 1: How many executions is that?
- Every 5 minutes = **8,640 runs/user/month**
- You listed **~6 jobs** (cleanup, pixel forwarding, campaign processing, release notifications, send emails, insights)

So monthly invocations ≈  
**10,000 users × 6 jobs × 8,640 = 518,400,000 invocations/month**

### Step 2: Invocation-only cost (ignoring CPU + memory)
Vercel Functions invocations: **first 1M included**, then **$0.60 per 1M**. citeturn1view0

- Billable invocations ≈ 518.4M − 1M = **517.4M**
- Invocation charges ≈ **517.4 × $0.60 = ~$310/month**

That’s before CPU + memory.

### Step 3: Compute cost (this is where it gets ugly)
Functions are billed by **Active CPU time ($/CPU-hour)** and **Provisioned Memory ($/GB-hour)**, region-dependent (e.g., $0.128/CPU-hr and $0.0106/GB-hr in many US regions). citeturn1view0  
Default function memory is **2 GB** unless you change it. citeturn0search3

Below are **ballpark totals** assuming **2 GB** per invocation and different “per-invocation” runtimes:

- **Tiny work** (20ms active CPU, 200ms instance lifetime): **~$1,285/mo**
- **Light** (50ms CPU, 500ms lifetime): **~$2,754/mo**
- **Medium** (100ms CPU, 1s lifetime): **~$5,202/mo**
- **Heavy** (500ms CPU, 5s lifetime): **~$24,786/mo**

Those totals include the **~$310/mo** invocation charges; the rest is CPU+memory.

### Base plan cost
If you need cron more than daily, you’re effectively on **Pro**, which is **$20/month per member seat** (plus usage). citeturn0search1turn0search5

---

## Practical takeaway
“**Per user every 5 minutes**” is almost always the wrong architecture on Vercel. The cost driver is that you’ve created **~518M function calls/month**.

What usually works for an MVP:
- **One (or a few) global cron(s)** every minute/5 minutes
- Each run **batches** work: “find due jobs in DB → process N due items → reschedule”
- Put heavy/long tasks behind a queue/workflow system (Vercel also has **Workflow** as a product line, or use an external queue) citeturn0search2turn0search4turn1view0

If you want, I can re-estimate using your real numbers by making conservative assumptions per job type (pixels vs email sends vs insights) — but even with extremely optimistic runtimes, **the invocation count alone tells you this design will be expensive.**

---

## User

I'm already on a pro account. We're spending $20 a month on it. I need this to be efficient. Also, do I buy anything if I use Tanstack Acer? And I need to keep, like, these costs under, like, $100 a month.

---

## Assistant

Mr. White — good news: being on **Pro** means you get **$20/month in usage credit** automatically. citeturn0search4  
Bad news: **per-user, every-5-min** background jobs will *blow past* your $100/month target even if each run is “tiny”.

## 1) Why your current “every 5 minutes per user” won’t fit under $100
Using your list (~6 job types) and 10,000 active API users:

- Every 5 minutes = **8,640 runs/user/month**
- Invocations/month ≈ **10,000 × 6 × 8,640 = 518,400,000**

Even if you ignore CPU+memory and only count invocations:
- Vercel bills invocations as part of Functions/Fluid compute usage (rates vary by plan/region, but invocations are explicitly metered). citeturn0search0  
At hundreds of millions of invocations, you’ll rack up meaningful charges **before** CPU/memory is counted.

And CPU + memory absolutely will count: Vercel bills **Active CPU time + Provisioned Memory duration** per invocation. citeturn0search0

So: **you won’t keep this under $100/month** with “6 per-user crons every 5 minutes.”

## 2) The efficient pattern that *does* hit <$100: “few global crons + due-work batching”
Instead of “per user cron”, do this:

### A. One global “scheduler” cron every 1–5 minutes
Each run:
1) Query a DB table of due jobs (indexed by `run_at`)
2) Pull the next **N** due items (e.g., 200–2,000)
3) Process them (or enqueue them)
4) Update their next `run_at`

This turns **518M invocations/month** into something like:
- 5-min scheduler: **8,640 invocations/month total** (not per user)

### B. Separate the *heavy* work from Vercel Functions
Use any of:
- a queue + worker (cheap VPS, managed queue, etc.)
- a DB-backed job table + a single worker service

Vercel Functions stay as:
- scheduler + dispatch
- lightweight, quick handlers

### C. Re-schedule each job type to realistic frequencies
A sane MVP setup usually looks like:

- **Data retention cleanup:** 1×/day (or hourly if needed), batched by records
- **Forward pixels:** don’t cron this per user—forward in the request path, or batch per source every 1–5 minutes globally
- **Campaign processing:** event-driven when users act; plus a global “due campaigns” scan every 1–5 minutes
- **Release notifications:** global scan for “notifications due now” every minute
- **Send emails:** enqueue to an email provider; process queue continuously (not per-user cron)
- **Insights:** 1×/day per user, but executed via batching (e.g., compute 500 users per run)

This is exactly how you keep invocations and compute bounded.

## 3) About “Tanstack Acer” — do you need to buy anything?
I can’t find “TanStack Acer,” but I *do* see **TanStack Pacer**, a timing/scheduling utility library. citeturn0search2turn0search11  
TanStack libraries like Query are typically **MIT licensed** (free to use; no purchase). citeturn0search12

So if you meant **TanStack Pacer**: you generally **don’t buy anything**—it’s just an npm package. citeturn0search11turn0search20

## 4) A concrete <$100/month target you can aim for on Vercel Pro
To stay comfortably under $100/month **total** (meaning ~$80 beyond your $20 credit):
- Keep total Function invocations more like **single-digit millions/month**, not hundreds of millions.
- Keep each invocation **short** (tens of ms CPU; minimal “instance alive” time), because Active CPU + memory duration is billed. citeturn0search0

With the “global scheduler + batching” approach, your Vercel side is usually:
- scheduler invocations: **~8,640/month**
- worker invocations: **only proportional to batches**, not users × time

That’s the difference between **<$100** and **$1k+**.

If you want, paste your current cron list (names + cadence + rough runtime), and I’ll map it into a **single global scheduler + job table** design with recommended batch sizes and frequencies that keeps you under budget.

---

## User

Now, my question specifically was, can Stacker Pacer, and if Pacer buys me anything in terms of allowing me to, like, does that manage the job scheduling and stuff in a more efficient way so that the crons aren't just arbitrarily running all the time?

---

## Assistant

Mr. White — **TanStack Pacer won’t solve this problem directly**, because it’s **not a server cron / job scheduler**. It’s a library of **timing/execution-control utilities** (debounce, throttle, rate limit, queue, batch) aimed *mostly at client-side usage today*. citeturn0search0turn0search2turn0search9turn0search15

### What Pacer *can* buy you
Pacer is useful when you already have “things happening” and you want to **reduce chatter** by:
- **batching** many small events into one (e.g., analytics events) citeturn0search15turn0search10
- **rate-limiting / throttling** repeated calls
- **queueing** work so it executes in a controlled stream instead of a burst citeturn0search9

So yes: it can make parts of your system more efficient by lowering *how often* you hit your backend / third parties and by **coalescing** work.

### What Pacer *does not* buy you
It does **not** replace:
- Vercel Cron (or any cron)
- a durable job queue
- “run this per user every 5 minutes” scheduling logic
- persistence/retries/at-least-once semantics

Also, the project itself notes it’s **currently mostly client-side** (with server-side being a possible future direction). citeturn0search0

### The fix for “crons arbitrarily running all the time”
The efficient pattern is **not** “better cron code”; it’s **better scheduling architecture**:

**One global cron** every 1–5 minutes:
- Query your DB for “jobs due now” (`run_at <= now`) with a tight index
- Process *only those due jobs* in batches
- Update `run_at` for the next time

That eliminates “wake up and do nothing” per-user runs.

### Where Pacer fits in that architecture (if you still want it)
- **Client → server analytics/pixels:** use Pacer batching to send fewer requests (eg batch 100 events or 2 seconds) citeturn0search15turn0search10
- **Inside a single worker process** (not serverless): you *could* use queue/batch utilities to smooth bursts, but it’s optional and not the core win. citeturn0search9turn0search15

### Bottom line
- If your goal is **“don’t run jobs unless they’re due”** and keep costs **< $100/mo**, Pacer isn’t the lever.
- The lever is: **global scheduler + due-job table + batching**, and only use cron to *kick* the scheduler.

If you tell me what DB you’re on (Postgres? Redis? etc.), I’ll outline a minimal schema (`jobs` table), the exact query pattern, and the batching strategy for your six job types.


**Topic:** [[chatgpt-clusters/coding_devops]]


## See Also
- [[chatgpt/chatgpt_cloudflare-reduces-cloud-costs]]
- [[chatgpt/chatgpt_ded-body-removal-costs]]
- [[chatgpt/chatgpt_ev-ownership-costs-comparison]]
- [[chatgpt/chatgpt_expensive-chipotle-meal-costs]]
- [[chatgpt/chatgpt_julia-garner-costs-coaching]]
