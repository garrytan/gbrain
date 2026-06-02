---
title: "Neon paid plan cost"
type: note
created: 2025-12-22
updated: 2025-12-22
source: chatgpt-export
conversation_id: 69497782-4678-832d-9816-01b5ec507229
message_count: 4
tags: [chatgpt, import]
---
# Neon paid plan cost

> Conversation ID: 69497782-4678-832d-9816-01b5ec507229
> Created: 2025-12-22T16:53:59Z
> Updated: 2025-12-22T16:55:45Z
> Messages: 4

---

## User

how much will we pay for neon if we switch from free to paid plan. startup mvp few users. 

---

## Assistant

Mr. White,

Short answer: **likely $5–$20/month at MVP scale**, often closer to the low end.

Here’s how **entity["company","Neon","serverless postgres company"]** pricing typically plays out for a small startup moving off the free tier.

---

## What changes when you go paid
Neon charges **usage-based**, not a flat server fee.

You pay for:
1. **Compute (CPU + RAM time)** – billed per second while the DB is active  
2. **Storage** – ~$0.10/GB/month  
3. **Data transfer** – minimal at MVP scale

No always-on server cost. Idle DBs can **scale to zero**.

---

## Typical MVP cost profile (few users)

Assumptions:
- 1 primary Postgres DB
- Light traffic (internal tools, early users)
- DB active a few hours/day
- <10 GB total data

**Monthly estimate**
- Compute: **$3–$10**
- Storage (5–10 GB): **$0.50–$1**
- Misc overhead: **$1–$3**

👉 **Total: ~$5–$15/month**

Even with spiky usage or CI branches, staying under **$20/month** is common.

---

## What pushes cost higher
- DB constantly active 24/7
- Heavy background jobs or analytics queries
- Large branching usage without cleanup
- >50–100 concurrent connections without pooling

---

## Important note on the Startup Program
If you qualify, the **Startup Program gives up to $100K in credits**, which effectively means:
- **$0 cost for months (often years)** at MVP scale
- No downside to applying

---

## Bottom line
For a startup MVP with few users:
- **Paid Neon ≈ coffee money**
- **Cheaper than RDS, Supabase Pro, or managed EC2 Postgres**
- Very hard to accidentally run up a big bill unless abused

If you want, tell me:
- Always-on vs bursty traffic  
- Approx users / requests per day  
- CI branching usage  

I can sanity-check a tighter estimate.

---

## User

always on with lots of long running ingest jobs. branch clean up in ci but might have 20-30 branches for a few hours will ci is running through them

---

## Assistant

Mr. White,

Given **always-on** usage plus **long-running ingest jobs**, your cost will be meaningfully higher than a sleepy MVP—but still reasonable.

Below is a **realistic paid-plan estimate** for **entity["company","Neon","serverless postgres company"]** under the conditions you described.

---

## Your workload profile (interpreted)
- **DB always on (24/7)**
- **Sustained CPU usage** from ingest jobs (not just bursty queries)
- **20–30 CI branches**, alive for **a few hours**, then cleaned up
- Branches mostly idle except migrations/tests
- Likely using connection pooling (important)

---

## Cost breakdown (monthly)

### 1. Primary database (always on)
Assume:
- 1–2 vCPU equivalent
- Moderate memory
- Running continuously

**Compute**
- ~$0.0006–$0.001 per second (typical Neon paid compute)
- Monthly: **$30–$60**

This is the biggest driver. Long-running ingest keeps the DB hot.

---

### 2. CI branches (20–30, short-lived)

Key point: **branches are cheap** unless they’re actively queried.

Assume:
- 25 branches
- Active ~2–4 hours each
- Mostly schema + light test traffic

**Compute**
- ~$0.05–$0.15 per branch per CI run
- Monthly (daily CI): **$10–$25**

**Storage**
- Copy-on-write keeps this tiny
- Usually **<$2/month**

---

### 3. Storage (primary DB)
Assume:
- 20–50 GB total

**Storage**
- ~$0.10/GB
- **$2–$5/month**

---

### 4. Data transfer & misc
Negligible unless exporting large datasets.

**<$5/month**

---

## Expected total
**Without credits:**
- **Low end:** ~$45/month  
- **Typical:** **$60–$90/month**  
- **Upper bound:** ~$120 if ingest is heavy + inefficient queries

---

## How to keep this from creeping upward
Facts, not fluff:

1. **Throttle ingest concurrency**
   - Fewer parallel writers > faster total throughput on Postgres
2. **Use unlogged tables or COPY where possible**
3. **Aggressively cap branch lifetimes**
   - Auto-delete on CI completion + nightly sweep
4. **PgBouncer is non-optional**
   - Prevents idle connection waste
5. **Offload analytics**
   - Don’t mix OLTP + heavy reporting on the same Neon compute

---

## Startup Program impact
If you qualify:
- **$100K in credits**
- Your described workload would effectively cost **$0 for a long time**
- No downside; apply immediately

---

## Bottom line
For your workload:
- Expect **$60–$100/month** paid
- Predictable, no surprise bills if branches are cleaned
- Still **cheaper than RDS + CI replicas** at the same scale

If you want, tell me:
- Approx ingest rows/sec
- Whether jobs run continuously or in batches
- Postgres version + extensions

I can sanity-check whether you’re CPU-bound or I/O-bound and tighten the estimate further.


## See Also
- [[chatgpt/chatgpt_neon-paid-plan-cost-2]]
- [[chatgpt/chatgpt_neon-plan-cost-difference]]
- [[chatgpt/chatgpt_paid-plan-creation-guide]]
- [[chatgpt/chatgpt_clerk-auth-vs-neon-auth]]
- [[chatgpt/chatgpt_cold-starts-neon-vercel]]
