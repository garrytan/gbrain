---
title: "Cold Start Crashes Next.js"
type: essay
created: 2026-01-23
updated: 2026-01-23
source: chatgpt-export
conversation_id: 6973e795-c5e4-832b-b141-fe499d31b4c2
message_count: 20
tags: [chatgpt, import, code, long-form]
---
# Cold Start Crashes Next.js

> Conversation ID: 6973e795-c5e4-832b-b141-fe499d31b4c2
> Created: 2026-01-23T21:26:46Z
> Updated: 2026-01-23T22:05:37Z
> Messages: 20

---

## User

were getting cold start crashes on next.js on vercel. should we upgrade our neon db off the free plan? were prelaunch trying to launch our mvp this week

---

## Assistant

Mr. White — Cold start crashes with Next.js on Vercel are often tied to database connection limits or latency, especially with serverless function environments. Before committing to a Neon paid plan, here’s a concise troubleshooting path and decision guidance:

---

## 1) Why the Cold Start Crashes Happen
**Next.js serverless + Neon Free Tier issues:**
- Cold starts spin up new function instances.
- Each instance opens new DB connections.
- Neon free tier has **low connection limits** and possibly idle timeout constraints.
- When connections spike or idle, you can hit errors like:
  - “Too many connections”
  - Timeouts
  - Crashes on first request after inactivity

This is extremely common in prelaunch MVP setups on Vercel with serverless functions + free DB offerings.

---

## 2) First: Validate the Root Cause
Before upgrading, verify:

### Check Logs
- **Vercel function logs** for:
  - connection errors
  - timeouts
  - “cannot connect”
- **Neon logs** for:
  - rejected connections
  - authentication errors
  - idle timeout resets

If root cause is connection saturation, that strongly supports upgrading.

---

## 3) Interim Mitigations (Pre-launch, no immediate cost)
Try these:

### A) Use a Connection Pooler
In serverless, use something like **PgBouncer** style pooling so you don’t open a new connection on each cold start.

With Neon you can:
- Enable/Use **Neon’s connection pooling** (if available on free tier)
- Or self-host a pooler in a lightweight container

This often fixes cold starts without upgrading.

### B) Reduce Cold Starts
- Set `vercel.json` or function config to **minimize inactivity scaling down** (keep warm)
- Increase memory/timeouts slightly to avoid function terminations

These can reduce frequency of cold spawns.

---

## 4) When Upgrading Makes Sense
Upgrade if the crash pattern is:
- **Database connection rejections** (Neon free plan maxed out)
- **Unreliable connections on traffic burst**
- You want:
  - **Persistent connections**
  - Higher concurrency
  - Lower idle disconnections

Paid Neon tiers generally offer:
- Higher connection limits
- Better performance SLAs
- More predictable behavior
This aligns well with:
- MVP launch with spikes
- Serverless backends

So **yes**, if logs show connection limits being hit, upgrading to a paid Neon plan is a practical move before launch.

---

## 5) Alternative Options Worth Considering
If Neon upgrade is too slow or you want alternatives:
- Switch to a **managed PostgreSQL** with better serverless handling (Neon paid, Supabase Pro, Render, etc.)
- Use **edge runtime + D1 / Upstash** for very low-latency small workloads

But sticking with Neon paid tier is usually simplest if you’re already committed to it.

---

## 6) Practical Next Steps (Today)
1) **Check logs quickly** for connection errors.
2) If confirmed:
   - Upgrade Neon plan
   - Enable pooling
3) **Deploy a warm-up route or schedule** to minimize cold starts.
4) Monitor for spikes during prelaunch traffic simulations.

---

## Summary
- Cold start crashes on Vercel + Next.js **are normal** when the DB can’t handle connections.
- **Upgrading Neon off free tier usually helps** because it increases connection capacity and reliability.
- For a prelaunch MVP this week, upgrading + using pooling is a low-risk move.

If you want, share specific logs/errors and I can diagnose the exact failure pattern.

---

## User

is there a tanstack version of pgbouncer?

---

## Assistant

No. There isn’t a “TanStack version of PgBouncer.”

**Why:**  
- **PgBouncer** is a **PostgreSQL connection pooler** that runs as a separate service between your app and the database.  
- **TanStack** (e.g., **TanStack Query**, **TanStack Table**) is a set of client-side/React/JS utilities — **not a database proxy or connection pooler**.

So there’s **no TanStack tool that acts like PgBouncer** at the database level.

---

## What You *Can* Use Instead

### ✅ For Node / Serverless (Next.js) Connection Pooling
Since serverless functions spin up often and create many DB connections:

- Use **PgBouncer** itself (recommended)
- Use **Neon’s built-in pooling** if your plan supports it
- Use **Supabase pooling** if you switch providers
- Use **Neon dedicated branches** or connection proxies from the provider

These handle pooling at the DB side, which is what you want.

### ❌ What TanStack Tools Do
- **TanStack Query** — client state and caching for frontend data fetching  
- **TanStack Table** — table UI library  
- They do *not* manage or pool PostgreSQL connections

---

## Practical for Next.js on Vercel

For serverless you typically need:

```
Client -> PgBouncer (pooler) -> PostgreSQL/Neon
```

You can self-host a PgBouncer instance, or use a provider feature that gives you pooling.

---

If you share your current stack/config (Neon plan, how you connect), I can suggest exact pooling setup steps.

---

## User

does drizzle handle this

---

## Assistant

No. **Drizzle does not handle connection pooling or cold starts.**

**Facts:**
- **Drizzle ORM** is a **query builder / ORM**, not a connection manager.
- It uses whatever database driver you give it (`pg`, `@neondatabase/serverless`, etc.).
- **Pooling, connection reuse, and concurrency limits are entirely outside Drizzle’s scope.**

So if you’re seeing cold-start crashes, **Drizzle is not the fix**.

---

## What Actually Fixes This (Serverless + Next.js)
You need **one of these**, regardless of ORM:

1. **Database-side pooling**
   - Neon pooled endpoint (recommended)
   - PgBouncer (self-hosted or managed)

2. **Serverless-safe driver**
   - Neon serverless driver (WebSockets, fewer connections)
   - NOT vanilla `pg` without pooling

3. **Correct instantiation pattern**
   - Global singleton for the client
   - No new connections per request

---

## Correct Mental Model
- **Drizzle** → SQL generation + typing  
- **Pooling** → database / driver / proxy responsibility  

ORM choice ≠ cold start stability.

---

## Bottom Line for an MVP Launch This Week
- Keep Drizzle if you like it.
- **Upgrade Neon or enable pooling**.
- Use Neon’s pooled/serverless endpoint.
- Verify you’re not opening a new client per request.

If you want, paste:
- your Neon connection string (redacted)
- which driver you’re using
- where the client is initialized

I’ll tell you in 30 seconds whether your setup is safe or guaranteed to crash.

---

## User

doesnt neon have pooling

---

## Assistant

Yes. **Neon *does* have pooling** — but this is the part that trips people up.

Here’s the precise, no-hand-waving answer.

---

## Neon Pooling: The Reality

### ✅ **Neon provides a pooled connection endpoint**
- It’s essentially **PgBouncer-as-a-service**
- Designed **specifically for serverless (Vercel, Lambda, etc.)**
- You must **explicitly use the pooled connection string**

**Regular Neon connection ≠ pooled connection**

---

## Why People Still Crash on Cold Starts

Most teams:
- Are on Neon free
- Use the **direct connection string**
- Use `pg` or Drizzle
- Deploy to Vercel serverless

Result:
- Each cold start opens new connections
- You hit connection limits
- App crashes on first request

Pooling exists — **but you’re probably not using it**

---

## What You Should Be Using (Critical)

### 1️⃣ Neon *Pooled* Connection String
In Neon dashboard:
- You’ll see **two URLs**
  - **Direct**
  - **Pooled** ← this one

The pooled URL usually looks like:
```
postgresql://user:pass@ep-xxx.pooler.neon.tech/db
```

If you’re not using `.pooler.neon.tech`, you are **not pooled**.

---

### 2️⃣ Correct Driver Choice (Serverless)
Best options:
- `@neondatabase/serverless` ✅ (WebSocket-based, very cold-start friendly)
- Or `pg` **only if** using pooled endpoint

Worst option:
- `pg` + direct Neon endpoint ❌

---

### 3️⃣ Drizzle Compatibility (Yes, but…)

Drizzle works **fine** with Neon pooling **if**:
- You pass it the pooled connection
- You don’t re-create the client per request

Drizzle itself does **nothing** for pooling.

---

## MVP Launch Recommendation (This Week)

**Do this now:**
1. Switch to Neon **pooled connection string**
2. Use `@neondatabase/serverless`
3. Ensure a global singleton DB client
4. Redeploy

**Then decide** if you even need to upgrade plans.  
Many MVPs stabilize immediately just from this.

---

## One-Line Verdict
- **Neon has pooling**
- **You must opt into it**
- **Drizzle does not manage it**
- **Cold start crashes = wrong endpoint or driver**

If you want, paste:
- which Neon URL you’re using (mask creds)
- your DB client init code

I’ll sanity-check it fast.

---

## User

were using the pooled connection string

---

## Assistant

Got it. If you’re **already on Neon’s pooled endpoint** and still seeing cold-start crashes, then the problem is **not “missing pooling.”** At that point it’s almost always one of the following, in descending likelihood.

---

## 1) You’re Still Opening Too Many Clients (Most Common)
Pooling **does not help** if you create a new client on every request / function invocation.

**Failure mode**
- Vercel cold start → new function instance
- Your code runs `new Client()` / `drizzle()` at module or request scope
- Pooler still gets hammered with auth + setup
- First request times out or crashes

**Fix**
- Ensure **one global singleton** per function instance
- Never initialize inside handlers

If this isn’t true, pooling won’t save you.

---

## 2) Wrong Driver for Serverless
If you’re using **`pg`**, even with pooling, cold starts can still be flaky.

**Best-in-class for Neon + Vercel**
- `@neondatabase/serverless` ✅  
  - WebSocket-based
  - Designed for high churn
  - Much faster cold starts

**`pg` is tolerable**, but:
- More TLS handshakes
- Slower on cold starts
- More likely to hit timeouts under burst

This alone has fixed crashes for many teams.

---

## 3) Transaction Pooling Edge Cases
Neon pooling behaves like PgBouncer **transaction pooling**.

That means:
- No session-level state
- No `SET LOCAL` assumptions
- Long transactions = bad
- Prepared statements can break things

If you have:
- Long-running queries
- Implicit transactions
- Migrations running at runtime ❌

You can still crash on cold starts.

---

## 4) Vercel Timeouts / Memory Too Low
Cold start + DB handshake + ORM init can exceed defaults.

**Fix**
- Increase function memory
- Increase max duration slightly
- Especially on first request after deploy

This matters more than people think.

---

## 5) Neon Free Tier Limits (Yes, Still Relevant)
Even pooled:
- Free tier has **low total throughput**
- Bursty traffic + cold starts = transient failures

**Upgrading helps here**, but only *after* the above is correct.

---

## MVP-Week Recommendation (Blunt)
Since you’re launching **this week**:

1. Switch to **`@neondatabase/serverless`** if not already
2. Verify **singleton DB client**
3. Increase function memory/timeouts
4. If crashes persist → **upgrade Neon** (predictability > cost)

Upgrading before fixing #1 or #2 is wasted money.

---

## Quick Triage Question (Answer One)
Which driver are you using?
- `pg`
- `@neondatabase/serverless`

That answer usually identifies the bug immediately.

---

## User

@neondatabase/serverless

---

## Assistant

Good — that narrows it a lot. If you’re on **`@neondatabase/serverless` + Neon pooled endpoint** and still crashing on cold start, then this is almost certainly **one of three concrete issues**. No fluff.

---

## 1) Client Is Not Truly Singleton (Even Though It Looks Like It Is)
This is the #1 gotcha with App Router + Vercel.

**Common failure pattern**
- DB client is created in a file that gets re-evaluated per route / per bundle
- Or wrapped in a function that runs on cold start per request
- Or duplicated between edge + node runtimes

**Hard rule**
- One client **per Lambda instance**
- Must live in a module that is imported once

**Gold-standard pattern**
```ts
// db.ts
import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';

const sql = neon(process.env.DATABASE_URL!);

export const db = drizzle(sql);
```

🚫 Never create this inside:
- route handlers
- server actions
- API functions

---

## 2) You’re Running in the Edge Runtime (Silent Killer)
`@neondatabase/serverless` works in **Node**, but **Edge + cold start + DB = pain**.

**If ANY of these are true:**
- `export const runtime = 'edge'`
- middleware touching the DB
- server actions defaulting to edge

You will see:
- random cold start crashes
- first request failures
- non-reproducible locally

**Fix**
Force Node:
```ts
export const runtime = 'nodejs';
```

For:
- API routes
- server actions
- anything that touches the DB

---

## 3) First Query Is Too Slow (Handshake + ORM + TLS)
Cold start budget on Vercel is tight.

**What happens**
- Function boots
- WebSocket handshake to Neon
- Drizzle initializes
- First query executes
→ Timeout before response

**Fixes**
- Increase function memory (this speeds CPU)
- Increase maxDuration
- Avoid heavy logic on first DB call

This alone fixes “crashes only on first hit.”

---

## When Upgrading Neon Helps (and When It Doesn’t)
**Upgrade helps ONLY if:**
- You’re bursting connections
- You’re hitting throughput caps
- You want lower variance

**Upgrade does NOT fix:**
- Edge runtime DB access
- Bad client lifecycle
- Per-request initialization

---

## MVP Launch Checklist (Do This Today)
1. Confirm **Node runtime everywhere DB is used**
2. Confirm **exactly one DB client per function**
3. Bump memory + timeout
4. If still flaky → upgrade Neon for safety margin

---

### One last yes/no that matters
Are you touching the DB from **middleware, server actions, or edge routes**?

That answer determines whether this is a 5-minute fix or a day of whack-a-mole.

---

## User

so this seems to be the root of all our headaches over and over.

we have marketing pages, app pages auth flows and then dashboard for user and admin
we want ssr or iss or ssg or whatever for fast page loads on public routes.
we want minimal rendering between pages etc.
we have client vs server and node vs edge
and we have react hooks etc
all of these decisions cause mismatches and stuff and with ai agents working on teh code it often is inconsistent.

Whats the high level rule/philosphy that helps us determine when to use what where

---

## Assistant

Mr. White — you’re not wrong. This *is* the root problem, and it’s not a tooling bug, it’s a **missing architecture contract**. Teams without one end up with exactly what you’re describing: random edge usage, SSR drift, hydration mismatches, and DB crashes that look “mystical”.

Here’s the **high-level philosophy** that actually works in production, especially with AI agents touching the code.

---

# The One Rule That Fixes 80% of This

> **The database defines the runtime. The runtime defines the rendering. Rendering never defines the database.**

If a page ever touches:
- auth state
- database
- secrets
- writes
- non-cacheable user data  

👉 it is **Node runtime + server-only data access**. Full stop.

Everything else is an optimization.

---

# A Clean Mental Model (Use This Everywhere)

## 1️⃣ Divide Your App Into 3 Zones (Hard Boundaries)

### **Zone A — Public / Marketing**
**Examples**
- Landing pages
- Pricing
- Blog
- Docs

**Rules**
- ❌ No DB
- ❌ No auth
- ❌ No secrets
- ❌ No server actions

**Tech**
- SSG or ISR
- Edge runtime allowed
- Client components OK
- Fetch from CMS / static APIs only

👉 These pages should still work if your DB is on fire.

---

### **Zone B — Auth & App Shell**
**Examples**
- `/login`
- `/signup`
- `/onboarding`
- layout that loads user identity

**Rules**
- ✅ Auth
- ⚠️ Minimal DB reads
- ❌ No heavy queries
- ❌ No edge

**Tech**
- SSR
- **Node runtime**
- Server Components for auth/session
- Client Components for forms

👉 This is the “bridge” zone. Keep it thin.

---

### **Zone C — Dashboard / Admin**
**Examples**
- User dashboard
- Admin panels
- Anything behind auth

**Rules**
- ✅ DB reads/writes
- ✅ Secrets
- ❌ Edge runtime
- ❌ SSG / ISR
- ❌ Middleware DB access

**Tech**
- SSR or streaming RSC
- **Node runtime only**
- Server Components fetch data
- Client Components = interaction only

👉 Correctness > speed here. Always.

---

# 2️⃣ Rendering Strategy Rules (Simple, Enforceable)

| Use case | Use this |
|-------|--------|
| Public, static content | **SSG / ISR** |
| Needs auth | **SSR (Node)** |
| Needs DB | **Server Component (Node)** |
| User interaction | **Client Component** |
| Writes / mutations | **Server Actions (Node)** |

If someone asks “Edge or Node?”  
**If it touches DB → Node. No debate.**

---

# 3️⃣ React Component Rules (Critical With AI Agents)

### **Server Components**
Use when:
- Fetching data
- Reading auth
- Reading cookies/headers

Rules:
- No hooks
- No browser APIs
- No event handlers

### **Client Components**
Use when:
- Forms
- Buttons
- Modals
- Charts
- UX logic

Rules:
- No DB access
- No secrets
- Only call server actions

---

# 4️⃣ Auth Rule (This Prevents 50% of Mismatches)

> **Auth is resolved once, at the layout level, on the server.**

- Never re-fetch auth on the client
- Never duplicate auth logic
- Pass user/session down as props

This kills hydration issues immediately.

---

# 5️⃣ Middleware Rule (Non-Negotiable)

> **Middleware is for routing, not data.**

Allowed:
- redirects
- rewrites
- header inspection

Forbidden:
- DB access
- auth verification that hits DB
- Neon calls (this causes your crashes)

---

# 6️⃣ Performance Philosophy (This Is the Trap)

**Fast ≠ Edge**  
**Fast = predictable**

- Static pages are fast because they don’t fail
- Dashboards feel fast when they don’t crash
- Users don’t care about 50ms if login breaks once

Edge is a **last-mile optimization**, not a default.

---

# 7️⃣ The AI-Agent Safety Rule (Very Important)

Add this comment to your repo root or README:

> “Any code that touches auth, DB, or secrets must run in Node runtime and live in Server Components or Server Actions only.”

This single sentence prevents agents from “optimizing” you into outages.

---

# TL;DR Philosophy

- **Data decides runtime**
- **Runtime decides rendering**
- **Rendering never decides data**
- **Edge is opt-in, never default**
- **Public ≠ App**
- **Correctness before cleverness**

If you want, next I can:
- Help you design a **folder structure that enforces this**
- Write a **runtime checklist** your agents must follow
- Review one of your routes and label exactly what zone it belongs to

This is a solved problem — it just needs discipline, not more tools.

---

## User

Findings
Singleton/Handler Enforcement
No checks exist. Found 3 violations:

create-tip-intent/route.ts:110 - new Stripe() inside handler
capture-tip/route.ts:26 - new Stripe() inside handler
clerk/webhook/route.ts:48 - new Webhook() inside function
The correct singleton pattern exists at lib/stripe/client.ts but these files don't use it.

Neon Serverless Usage
Inconsistent. Main app uses @neondatabase/serverless correctly, but:

drizzle/config.ts has dual-driver logic (neon + postgres fallback)
scripts/run-sql.ts uses postgres package directly
scripts/drizzle-seed.ts imports both

---

## Assistant

Mr. White — this is actually **good news**. Your findings explain the instability *exactly*, and they’re **surgical fixes**, not a rewrite.

Below is a **clean verdict + ruleset** you can lock in so this never regresses (especially with AI agents).

---

# Executive Verdict

You do **not** have a Neon or Vercel problem.

You have:
1. **Broken singleton enforcement**
2. **Environment leakage between runtime and tooling**
3. **Implicit “it probably doesn’t matter” assumptions**

All three are fatal in serverless.

---

# 1️⃣ Singleton / Handler Violations (Critical)

## What’s happening
These lines are **guaranteed cold-start pain**:

- `new Stripe()` inside handlers
- `new Webhook()` inside handlers

Each cold start:
- re-initializes crypto
- re-opens sockets
- re-does TLS
- increases execution time
- increases failure probability

**Pooling does not help this.**

---

## The Rule (Non-Negotiable)

> **No `new Client()` inside request scope. Ever.**

Applies to:
- Stripe
- Neon
- Clerk
- Webhooks
- Anything with sockets or crypto

---

## Fix (Do This Once)

Create **exactly one** client per service:

```ts
// lib/stripe/client.ts
import Stripe from 'stripe';

export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2023-10-16',
});
```

Then **ban** `new Stripe()` everywhere else.

Same for webhooks.

---

## Enforcement (Important)
Add an ESLint rule or grep-based CI check:

```
new Stripe(
new Webhook(
```

Fail the build if found.

This alone will eliminate a huge % of cold-start crashes.

---

# 2️⃣ Neon Serverless Usage — Mixed Drivers (Very Bad)

This is the other root cause.

You currently have **three DB execution modes**:
- Neon serverless (correct)
- `postgres` driver (wrong in prod)
- dual logic that chooses at runtime (dangerous)

This creates:
- inconsistent connection behavior
- local assumptions leaking into prod
- agent confusion

---

## The Rule

> **There is exactly ONE database driver in production.**

Tooling may differ. Runtime may not.

---

## Correct Split

### ✅ Production / Runtime
- **ONLY** `@neondatabase/serverless`
- **ONLY** pooled connection string
- **ONLY** Node runtime

### ✅ Tooling / Scripts
- Can use `postgres` or direct connections
- Must live **outside app runtime**
- Never imported by app code

---

## Concrete Fixes

### `drizzle/config.ts`
🚫 **Remove dual-driver logic**

This file should be **tooling-only**.  
It should never be imported by runtime code.

If runtime needs Drizzle config:
- create a separate file
- or inline it

---

### `scripts/run-sql.ts` / `drizzle-seed.ts`
These are fine **if and only if**:
- They are never imported by app routes
- They run locally or in CI only
- They do not share config with runtime

If they share config → split immediately.

---

# 3️⃣ Hidden Runtime Boundary Violation (The Real Enemy)

Right now your repo allows this:

> “Code that *can* run in prod accidentally *does* run in prod.”

That’s the architectural failure.

---

## The One Fix That Prevents This Forever

### Enforce folder-level intent

```
/lib
  /db          ← runtime-safe only
  /stripe      ← runtime-safe only

/scripts       ← NEVER imported by app
/drizzle       ← tooling only
```

Then add:
- path-based ESLint restrictions
- or simple README rule for agents

---

# 4️⃣ Launch-Week Priority Order (Do This in Order)

1. **Fix all singleton violations** (Stripe, webhooks)
2. **Remove dual-driver logic**
3. **Guarantee one DB path in prod**
4. Redeploy
5. Then consider upgrading Neon (optional, safety margin)

If you upgrade Neon **before** steps 1–3, you’ll still see crashes.

---

# TL;DR (Put This in Your Repo)

> - No clients instantiated in handlers  
> - One DB driver in production  
> - Tooling ≠ runtime  
> - Node runtime for anything with DB or secrets  
> - Edge is opt-in, not default  

You’ve already done the hard part: **you found the violations**.  
Now you just need to lock the door so they don’t come back.

If you want, next I can:
- Write the **exact ESLint rules**
- Propose a **repo structure that enforces this**
- Help you turn this into a **“launch hardening checklist”**

You’re very close.

---

## User

Does neon serverless mean we dont use drizzle at all?

---

## Assistant

No. **Neon serverless does *not* replace Drizzle.**  
They solve **different layers** of the stack.

Short, precise answer first — then the mental model.

---

## The Correct Layering

**You want BOTH:**

```
Next.js (Server Components / Actions)
        ↓
Drizzle ORM (types + SQL)
        ↓
@neondatabase/serverless (transport + connections)
        ↓
Neon Postgres (with pooling)
```

- **Neon serverless** = *how* bytes move to Postgres (WebSockets, pooling-safe)
- **Drizzle** = *what* SQL you generate and how it’s typed

They are complementary, not substitutes.

---

## What “Neon Serverless” Actually Means

`@neondatabase/serverless` provides:
- A **serverless-safe Postgres client**
- WebSocket transport (fast cold starts)
- Works with Neon’s pooled endpoint
- No connection lifecycle management needed in your app

It does **not**:
- Define schemas
- Generate SQL
- Handle migrations
- Provide typing
- Replace an ORM

So if you removed Drizzle, you’d be writing raw SQL everywhere.

---

## The Correct Way to Use Drizzle with Neon Serverless

This is the **only** pattern you should allow in runtime code:

```ts
// lib/db/index.ts
import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';

const sql = neon(process.env.DATABASE_URL!);

export const db = drizzle(sql);
```

Rules:
- This file is imported by server components / actions only
- Never re-created per request
- Never swapped at runtime

---

## What You Should NOT Do (And Probably Are Somewhere)

🚫 “Driver abstraction” like:

```ts
if (process.env.NODE_ENV === 'production') {
  useNeon();
} else {
  usePostgres();
}
```

This causes:
- Different behavior between local and prod
- Cold start bugs that don’t repro
- Agent confusion
- Exactly the issues you’re seeing

**One driver per environment. No branching.**

---

## Tooling Is the Only Exception

It is fine to use different drivers for:
- migrations
- seeds
- local scripts

But:
- those files must live outside app runtime
- must never be imported by route code
- must not share config with runtime DB

---

## Final Rule to Lock In

> **Drizzle is your ORM. Neon serverless is your wire protocol. You need both.**

If someone suggests “dropping Drizzle because Neon is serverless,” that’s a category error.

---

If you want, next I can:
- Give you a **one-file DB contract** agents are not allowed to touch
- Help you standardize **local vs prod DB without branching logic**
- Review your Drizzle config and mark what must move

You’re asking exactly the right questions at exactly the right time.

---

## User

can you give me a prompt for claude to update our agents.md file and biome to enforce these patterns across our work.

---

## Assistant

Absolutely. Below is a **copy-pasteable prompt** you can give to Claude. It’s written to be decisive, repo-aware, and enforcement-focused (not advisory). This will produce concrete changes to **agents.md** and **Biome config** that lock in the patterns we discussed.

---

### Prompt for Claude

:::writing{id="58241" variant="standard"}
You are a senior staff engineer performing **architecture hardening** on a Next.js (App Router) codebase deployed on Vercel using Neon + Drizzle.

Your task is to **update two things** in this repo:
1. `agents.md` — to give AI agents strict, enforceable rules
2. `biome.json` (or biome config) — to mechanically enforce those rules

This is not a discussion or proposal. Make **decisive changes**.

---

## Context (Authoritative)
This repo has suffered repeated production issues due to:
- Client / server confusion
- Edge vs Node misuse
- Per-request client instantiation
- Mixed database drivers
- AI agents introducing “optimizations” that break serverless guarantees

The correct architecture is now **locked** and must be enforced.

---

## HARD RULES (Must Encode)

### Runtime & Data
- **Any code that touches DB, auth, secrets, webhooks, or payments MUST:**
  - Run in **Node runtime**
  - Use **Server Components or Server Actions only**
- **Edge runtime is opt-in and forbidden** for:
  - DB access
  - Auth verification
  - Webhooks
  - Stripe / Clerk / Neon usage

### Database
- Production runtime uses **ONE driver only**:
  - `@neondatabase/serverless` + pooled Neon URL
- **Drizzle ORM is mandatory** for runtime DB access
- No dual-driver logic
- No environment-based driver switching
- Tooling (migrations, seeds, scripts) may use other drivers but:
  - Must live outside app runtime
  - Must never be imported by route code

### Singleton Enforcement
- **No `new Client()` / `new Stripe()` / `new Webhook()` inside handlers**
- All external clients must be:
  - Initialized once
  - Exported from `lib/*`
  - Reused everywhere
- Any per-request instantiation is a build failure

### React / Next.js
- Server Components:
  - Data fetching
  - Auth resolution
- Client Components:
  - Interaction only
  - No DB, auth, or secrets
- Middleware:
  - Routing only
  - **No DB or auth calls**

---

## agents.md Requirements
Update `agents.md` to:
- Clearly define **Zones**:
  - Public (SSG/ISR, no DB)
  - Auth/App Shell (SSR, Node)
  - Dashboard/Admin (SSR/RSC, Node)
- State **non-negotiable rules**
- Explicitly forbid:
  - Edge DB access
  - Runtime driver branching
  - Handler-level client instantiation
- Include a short **“If you violate this, prod will break”** warning
- Be concise, direct, and authoritative

---

## Biome Requirements
Update Biome config to enforce:
- ❌ `new Stripe(` outside `lib/stripe/*`
- ❌ `new Webhook(` outside `lib/*`
- ❌ Imports of `postgres` or `pg` inside `app/`
- ❌ Imports from `scripts/` or `drizzle/` inside runtime code
- ❌ DB client creation inside route handlers

Use:
- `no-restricted-imports`
- `no-restricted-syntax`
- Path-based restrictions

Prefer **false positives over false negatives**.

---

## Output Format
1. Show the **updated `agents.md`** (full file)
2. Show the **Biome config changes** (only relevant sections)
3. Do NOT explain concepts unless necessary
4. Assume this will be merged as-is

You are enforcing a production contract. Act accordingly.
:::

---

If you want, next I can:
- Tighten this further for **Claude vs GPT-style agents**
- Review Claude’s output and mark what’s still too weak
- Adapt this for ESLint as a second line of defense

This is the right move before launch.
