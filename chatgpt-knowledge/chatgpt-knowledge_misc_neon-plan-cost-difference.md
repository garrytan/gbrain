---
title: "Neon Plan Cost Difference"
type: guide
created: 2026-02-18
updated: 2026-02-18
source: chatgpt-export
topic: misc
message_count: 8
tags: [chatgpt, knowledge, misc]
---
# Neon Plan Cost Difference

> **Source:** ChatGPT conversation
> **Date:** 2026-02-18T20:45:25Z
> **Messages:** 8
> **Topic:** misc

## Question

what will the difference in my db costs if i switch our neon basic plan to never go cold

## Answer

Mr. White, here’s the practical cost impact of setting your **entity["company","Neon","serverless postgres company"]** Basic database to **“never go cold”** (i.e., disable autosuspend):

## What changes
On the **Basic plan**, you’re billed primarily for:
- **Compute time (vCPU-hours)**
- **Storage (GB/month)**
- **Data transfer**

When the DB **goes cold**, you’re *not billed for compute*.  
When you set it to **never go cold**, compute runs **24/7**, so you pay for it continuously.

---

## Cost Difference (Ballpark)

Let’s assume:
- 1 compute unit (typical small Basic instance)
- ~730 hours/month

If compute is roughly **$0.10 per compute hour** (example rate):

```
730 hours × $0.10 ≈ $73/month
```

So:

| Scenario | Monthly Compute Cost |
|-----------|----------------------|
| Goes cold when idle | Often $0–$20 (depends on usage) |
| Never goes cold | ~$70–$80+ baseline |

If you scale above 1 compute unit, multiply accordingly.

---

## Real-World Impact

If your DB:
- Is lightly used (internal tools, dev DB, low traffic SaaS) → **Costs may 3–10×**
- Is already active most of the day → Difference may be minor
- Is production with steady traffic → You’re likely already near full-hour billing

---

## When “Never Go Cold” Makes Sense
- You can’t tolerate 1–2s cold start latency
- You have frequent but bursty traffic
- You run background jobs every few minutes

## When It’s Wasteful
- Dev/staging environments
- Early-stage low-traffic SaaS
- Intermittent API usage

---

### Quick Formula for Your Case

If your DB currently averages **X hours active per day**:

```
Extra monthly cost ≈ (24 − X) × 30 × compute_hour_rate
```

If you tell me:
- Your current monthly Neon bill
- Average active hours per day
- Compute size (if known)

I can give you a tighter estimate.

## Question

our current neon bill is 0. we just have a ton of issues form slow neon start. im assuming that we should resolve these code side?

## Answer

Mr. White — if your **entity["company","Neon","serverless postgres company"]** bill is **$0**, that means your database is spending almost all its time suspended.

Your slow start issue is almost certainly **cold start latency**, not a deeper DB performance problem.

---

## What’s Actually Happening

When Neon goes cold:
- Compute shuts down
- First query triggers spin-up
- Cold start delay: ~1–3 seconds (sometimes more)

After that, it’s fast.

---

# Should You Fix It in Code?

**Usually yes — unless this is production and user-facing.**

Here’s the decision framework:

## Fix in Code If:
- You’re early-stage
- Traffic is low
- You’re cost sensitive
- You can tolerate a background warm-up
- It’s dev/staging

### Code-Side Fixes That Actually Work

1. **Warm ping every 4–5 minutes**
   - Simple cron hitting `SELECT 1`
   - Keeps DB alive
   - Costs near $0 if usage is light

2. **Connection pooling**
   - Use pgBouncer (Neon supports pooled connections)
   - Avoid opening fresh connections on every request

3. **Don’t connect during cold lambda boot**
   - Lazy-connect on first query
   - Avoid blocking startup

4. **Cache aggressively**
   - Reduce DB hits on initial page loads

---

# When You Should Just Pay

If:
- This is production
- Users notice latency
- You care about perceived performance
- You’re raising / pitching
- You have API timeouts

Then $70–$80/month is cheap insurance.

Cold start UX kills trust more than most founders realize.

---

# Real Founder Advice

If you’re still at $0:
- You likely don’t have enough traffic to justify 24/7 compute.
- But you *do* need predictable response times.

The clean compromise:
**Run a tiny always-on compute during business hours only.**
Or warm it via scheduled ping.

---

If you tell me:
- Is this production?
- What stack (Next.js? Supabase client? Direct pg?)
- Serverless or dedicated backend?

I’ll give you the exact optimal setup.

## Question

if its vercel plus neon. how does it compare cost wise for doing a ping on a cron job vs paying for neon to never go cold

## Answer

Mr. White — with **entity["company","Vercel","cloud platform"]** + **entity["company","Neon","serverless postgres company"]**, the difference is significant.

You’re basically choosing between:

1. **Pay Neon to run 24/7**
2. **Use a cron ping to keep it warm**

---

# Option 1 — “Never Go Cold”

If you disable autosuspend:

- Compute runs ~730 hrs/month
- Even at a small size, you’re likely looking at **~$60–$90/month baseline**
- Cost is predictable
- No cold starts ever

This is effectively converting Neon from serverless → traditional always-on DB pricing.

---

# Option 2 — Cron Ping (Keep Warm)

You schedule a ping every 4–5 minutes:

```
SELECT 1;
```

### What this does:
- Prevents autosuspend
- Keeps DB active
- But only bills for compute while active

### Cost impact:

If you ping every 5 minutes:
- DB basically never suspends
- You’ll still be billed for compute hours
- Meaning: cost approaches same as “never go cold”

**Important nuance:**
If the ping frequency is less than autosuspend window, Neon never shuts off → you pay almost full-time compute anyway.

So cost difference becomes small.

---

# The Real Cost Comparison

| Approach | Expected Monthly Cost | Notes |
|-----------|----------------------|-------|
| Leave cold (no ping) | $0 | Cold start latency |
| Cron ping every 5 min | ~$50–$80 | Essentially same as always-on |
| Never go cold toggle | ~$60–$90 | Predictable |
| Ping every 15–30 min | Low ($5–$25) | Some cold starts remain |

---

# The Hidden Vercel Factor

With **Vercel serverless functions**:
- Cold DB + cold function = compounded latency
- First request can feel very slow (3–5s+)

If your API routes are serverless and connect fresh each time, cold start pain is amplified.

---

# Founder-Level Recommendation

If:
- This is production
- You care about UX
- You’re building something real

→ Just pay the ~$70.

If:
- Early validation stage
- Very low traffic
- Internal tool

→ Leave cold and accept 1–2s delay.

---

If you want, tell me:
- Is this App Router or Pages Router?
- Are you using pooled connections?
- Rough daily requests?

I’ll tell you the optimal cost/perf move.

## Question

its a startup. were early. weve only raised 25k. this is the production site but effectively 0 traffic right now. we are using pooled connections app route next.js

## Answer

Mr. White — given:

- Early startup  
- $25k raised  
- Production but ~0 traffic  
- **entity["company","Vercel","cloud platform"]** + **entity["company","Neon","serverless postgres company"]**  
- App Router + pooled connections  

You should **not** pay for always-on compute right now.

You’d be spending ~$70/month to eliminate a problem almost no users are experiencing yet.

That’s ~3–4% of your total raise per year on idle database time.

---

# What’s Actually Happening

Even with pooled connections:

Cold stack looks like this:

1. Neon cold start (1–3s)
2. Vercel function cold start (sometimes 200ms–1s)
3. First query initialization

So first request can feel like 2–4s.

After that, everything is fast.

With 0 traffic, Neon suspends constantly → you see it every time you test.

That makes it feel worse than it actually is.

---

# The Correct Move at Your Stage

## Do Nothing Structural  
Leave autosuspend enabled.

## Add a Low-Frequency Warm Ping

Use a Vercel cron every **10–15 minutes**:

- Keeps DB warm during testing
- Doesn’t fully eliminate autosuspend
- Keeps compute cost very low
- Likely <$10–20/month

This gives you:
- Mostly smooth experience while working
- Minimal burn

---

# Important Optimization

Make sure you are:

- Using Neon’s pooled connection string
- Not opening a new client per request unnecessarily
- Reusing the client in a singleton pattern

If you’re doing `new Pool()` inside each route handler, fix that.

---

# When You Should Flip to Always-On

Only when:
- Real users are hitting it consistently
- You start caring about conversion drop from 2s delay
- Or background jobs run constantly

Until then, cold starts are a “nice problem to have.”

---

# Founder Reality

At your stage:

Cash runway > micro-latency polish.

You don’t optimize for scale before you have users.

---

If you want, I can give you:
- The exact singleton pattern for Next.js App Router
- The cleanest low-cost cron warming setup for Vercel
