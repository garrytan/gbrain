---
title: "Cold Starts Neon Vercel"
type: note
created: 2026-01-28
updated: 2026-01-28
source: chatgpt-export
conversation_id: 697a6728-a5b8-8325-94a5-e90d154db7fa
message_count: 2
tags: [chatgpt, import]
---
# Cold Starts Neon Vercel

> Conversation ID: 697a6728-a5b8-8325-94a5-e90d154db7fa
> Created: 2026-01-28T19:44:41Z
> Updated: 2026-01-28T23:56:07Z
> Messages: 2

---

## User

cold starts neon and vercel

---

## Assistant

Mr. White — here’s the clean, factual breakdown.

## Cold starts with **Neon** + **Vercel**

### What’s happening
- **entity["company","Vercel","cloud platform"]** Serverless Functions **cold start** when there’s no warm instance. That’s typically **50–300 ms** (Node), sometimes more with heavy bundles.
- **entity["company","Neon","serverless postgres"]** *sleeps* databases after inactivity. First query triggers a **database wake-up**: often **300 ms–2+ seconds**.

When combined:
> **Vercel cold start + Neon cold start = compounded latency**  
This is why first request after idle feels “slow,” then everything is fast.

### Why it’s worse with serverless
- Each cold function may open a **new DB connection**.
- Traditional Postgres connection models don’t match ephemeral compute.
- TLS + auth + wake-up all happen on the critical path.

### How to reduce or eliminate it (ranked by impact)
1. **Neon pooled connection (PgBouncer / serverless driver)**  
   - Use Neon's serverless driver or pooled endpoint.  
   - Prevents connection storms.  
   - *Mandatory* for Vercel.

2. **Keep Neon warm**
   - Neon paid plans allow longer idle times.
   - External cron ping (every 5–10 min) works, but is a band-aid.

3. **Vercel Edge Functions (when possible)**
   - No Node cold start.
   - Still hits Neon over the network, but removes half the problem.
   - Works best for read-heavy paths.

4. **Reduce function weight**
   - Smaller bundles = faster cold start.
   - Avoid ORMs with heavy init (or lazy-load them).

5. **Cache aggressively**
   - Vercel Data Cache / KV / ISR.
   - If request never hits Neon, cold start is irrelevant.

### What *not* to expect
- You **cannot fully eliminate** cold starts with:
  - Free tiers
  - Pure serverless + sleeping DB
- Physics + cost models apply.

### Rule of thumb
- **User-facing, latency-sensitive app** → consider:
  - Always-on Postgres (RDS, Supabase Pro, etc.), or
  - Edge + heavy caching
- **Internal tools / dashboards** → Neon + Vercel is fine.

If you want, tell me:
- read vs write ratio
- ORM (Prisma? Drizzle? raw SQL?)
- traffic pattern (spiky vs steady)

I’ll give you a concrete architecture recommendation in one shot.
