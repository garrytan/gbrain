---
title: "Production Instability Audit"
type: note
created: 2026-01-22
updated: 2026-01-22
source: chatgpt-export
conversation_id: 69729d63-a7a0-8325-b674-aabe85a147bf
message_count: 2
tags: [chatgpt, import, long-form]
---
# Production Instability Audit

> Conversation ID: 69729d63-a7a0-8325-b674-aabe85a147bf
> Created: 2026-01-22T21:57:56Z
> Updated: 2026-01-22T21:59:03Z
> Messages: 2

---

## User

Hey, I'm looking for like issues that would cause production instability, like, you know, leaks where something keeps re-rendering a billion times until it crashes or memory leaks or blocking API calls that prevent rendering or like situations where you get like SSR static edge issues and stuff, node issues and stuff like that, where like a request comes in and then like because the DB is slow or something, it just like crashes instead of, you know, loading like loaders or skeleton loaders or whatever. All kinds of like things that would prevent a very quick page load on server, even if that page load is an error or a loader or something. I wanna, I wanna identify those issues and so I want a prompt to go through. It will be context-aware, so you don't have to explain the codebase or anything like that and stuff. And it'll have our agent ID file in it, but I just want it to go through and look at our next JS codebase and ensure and find like the worst offenders and list them out. I don't want it to do any coding or anything, just list all of the issues and stuff. And we use TanStack Query and TanStack Virtual and TanStack Pacer and TanStack Table, and we use Nooks, and we use, we're deployed on Vercel and we use Drizzle ORM with DrizzleKit and Neon Database. And I want to make sure that we're like properly using all of that and like find instances, for example, where we're like doing rate limiting outside of Pacer, we're doing like things outside of Querier or something that should be consolidated into Query or we have like duplicate logic or like multiple versions of a hook or something that should be consolidated into like Query and stuff like that.

---

## Assistant

Mr. White — here’s a **single prompt** you can paste into your codebase-review agent. It’s designed to find **production instability + slow-first-byte / slow-first-render offenders** in a **Next.js + Vercel + Neon + Drizzle + TanStack (Query/Virtual/Pacer/Table) + Nooks** stack, **without making code changes**—just an ordered list of issues with evidence and impact.

---

## Copy/paste prompt for your agent

You are a **production stability + performance auditor** for a **Next.js** codebase deployed on **Vercel**, using **Neon (Postgres)** with **Drizzle ORM/DrizzleKit**, and client state/data with **TanStack Query**, lists with **TanStack Virtual**, rate limiting/backpressure with **TanStack Pacer**, tables with **TanStack Table**, and state hooks with **Nooks**.

**Goal:** Identify **the worst offenders** that can cause **production instability** (crashes, runaway renders, memory leaks, event-loop blocking, request timeouts, SSR/edge incompatibilities) and/or prevent a **very fast initial server response** (even if the response is an error or a loader).  
**Do NOT change code. Do NOT propose refactors as code.** Only report findings.

### Operating constraints
- Be **context-aware**: infer intended behavior from code patterns; don’t ask me to explain architecture.
- Prefer findings that are **high-confidence** and **actionable**.
- Always cite **exact file paths and line ranges** (or nearest stable anchors) and include **the suspicious snippet** (small excerpts only).
- Rank findings by **severity** and **blast radius**: *P0 (crash/data corruption), P1 (timeouts/major perf regression), P2 (chronic slowness/bugs), P3 (cleanup).*
- Include **why it’s bad in production**, **what symptom it causes**, **how to reproduce/confirm**, and **what “correct” usage should look like conceptually** (no code).

---

# Audit checklist (run these passes)

## Pass 1 — Server response time / “fast TTFB even if error”
Find cases where the server can’t quickly return *something* (loader/error boundary/redirect) because work blocks the request:
1. **Blocking work in route handlers / server components**
   - Long DB queries, N+1 queries, unbounded pagination, large joins without limits.
   - Synchronous CPU-heavy work (JSON parse of huge payloads, crypto/hash loops, image processing, CSV parsing).
   - `await` chains that could be parallelized but aren’t (waterfalls).
2. **Missing timeouts / abort signals**
   - Fetches or DB calls without timeouts / cancellation.
   - External API calls inside SSR without safeguards.
3. **Slow DB behavior not degraded gracefully**
   - DB calls in critical render path without fallback, retry storms, or queueing.
   - No “return early” on auth/validation; DB hit happens before cheap checks.

**Output for each:** where it happens, worst-case latency, and how it could cause a hard crash/timeouts on Vercel.

---

## Pass 2 — Infinite re-render / runaway effects / memory leaks (React)
Identify patterns that cause “re-render a billion times” or memory growth:
1. **Effects with unstable dependencies**
   - `useEffect` / `useLayoutEffect` depending on objects/functions created each render.
   - Set state in effect that triggers itself.
2. **State derived incorrectly**
   - Derived state recomputed and re-set each render.
   - `useMemo`/`useCallback` misuse hiding dependency bugs.
3. **Subscriptions not cleaned up**
   - `addEventListener`, websockets, intervals, observers without cleanup.
   - TanStack Query subscriptions or custom listeners leaking.
4. **Rendering massive lists without virtualization**
   - Large arrays rendered without TanStack Virtual or with misconfigured keys causing remount storms.

**Output for each:** likely symptom (CPU spike, memory climb), where to confirm (React Profiler, heap snapshot), and the exact culprit pattern.

---

## Pass 3 — TanStack Query correctness + consolidation
We use TanStack Query as the canonical async/cache layer. Find:
1. **Network calls outside Query**
   - `fetch/axios` in components/hooks that should be in `queryFn` / mutations.
   - Duplicated fetching logic across multiple hooks.
2. **Unstable query keys**
   - Keys built from non-serializable objects, functions, Dates without normalization.
   - Keys missing important params causing cache poisoning or over-sharing.
3. **Retry/refetch storms**
   - Aggressive `retry`, `refetchOnWindowFocus`, `refetchInterval` on expensive queries.
   - Queries enabled without guards → fire on every render.
4. **Server/SSR hydration issues**
   - QueryClient recreated per render/request incorrectly.
   - Missing dehydrate/hydrate where intended, causing double fetches.
5. **Cache bloat**
   - Infinite queries unbounded; `gcTime`/`staleTime` mis-set; huge data retained.

**Output:** list of non-Query fetch points, duplicated hooks, and the most dangerous Query config issues.

---

## Pass 4 — TanStack Pacer: rate limiting / backpressure consistency
We use Pacer as the standard place for pacing/backpressure/rate limiting. Find:
1. **Rate limiting implemented ad-hoc**
   - Custom debounce/throttle/rate limit logic in random utilities/hooks where Pacer should be used.
2. **Queue/backpressure missing**
   - High-frequency events (search typing, scrolling fetch, websocket messages) that call APIs without pacing.
3. **Conflicting pacers**
   - Multiple pacers for same domain action; inconsistent policies.

**Output:** each ad-hoc limiter + why it should be consolidated conceptually.

---

## Pass 5 — Next.js SSR / Edge / Node runtime mismatches (Vercel)
Find issues that crash only in prod due to runtime differences:
1. **Edge runtime incompatibilities**
   - Node APIs used in Edge routes/components (fs, net, tls, crypto Node variants, process access).
   - Drizzle/Neon usage in Edge when it requires Node runtime (flag mismatches).
2. **Dynamic vs static rendering traps**
   - `fetch` caching semantics causing stale or incorrect SSR.
   - Accidental static optimization with dynamic data, or forced dynamic where not needed.
3. **Middleware pitfalls**
   - Heavy middleware, DB calls in middleware, blocking auth in middleware.
4. **Server actions / route handlers**
   - Large payload parsing, missing validation, unhandled exceptions that crash the request.

**Output:** runtime boundary violations + likely Vercel failure mode (500, edge runtime error, timeout).

---

## Pass 6 — Drizzle ORM + Neon DB safety/perf
Find the most risky DB patterns:
1. **Connection management**
   - Creating new clients per request incorrectly; global reuse mistakes.
   - Using non-serverless-safe pooling patterns on Vercel.
2. **N+1 queries**
   - Loops performing queries per item, especially in server components.
3. **Missing indexes / unbounded queries**
   - `where` on non-indexed columns (infer from schema usage), `select *`, no limits.
4. **Transactions**
   - Transaction spanning network calls; long transactions.
5. **Migrations / DrizzleKit mismatch**
   - Multiple schema sources, drift, or migration ordering issues (where visible).

**Output:** suspected N+1 locations, worst unbounded queries, and connection hazards.

---

## Pass 7 — Error handling, loaders, and “return something fast”
We want fast initial render even if “error/loading”.
Find:
1. **Missing Suspense boundaries / loading UI**
   - Critical routes/components doing async work without fallbacks.
2. **Errors that bubble to crash**
   - Uncaught promise rejections, `throw` without boundary, server errors without `notFound()`/`redirect()`/error boundary.
3. **Global blocking**
   - Auth gating or feature flag fetch blocking whole app without fallback.

**Output:** routes/components that should return early with loader/error and currently block.

---

# Deliverable format (strict)
Return a report with:

### 1) Executive summary
- Top 5 P0/P1 offenders (one line each).

### 2) Findings (ranked)
For each finding include:
- **Severity:** P0/P1/P2/P3  
- **Category:** (Render loop / Memory leak / SSR/Edge / Query / Pacer / DB / Loader / Other)  
- **Location:** file path + line range  
- **Evidence:** short snippet + what pattern it matches  
- **Production symptom:** (timeout, crash, memory climb, thundering herd, cache poisoning, etc.)  
- **Why it happens:** brief technical cause  
- **How to confirm:** concrete steps (logs to check, profiler, reproduce path)  
- **Conceptual fix direction:** 1–3 bullets, no code

### 3) Consolidation opportunities
- Duplicate hooks/logic that should be unified under **TanStack Query** and **Pacer** (list locations + what overlaps).

### 4) “Fast response guarantee” gaps
- Routes where the app cannot quickly return loader/error/redirect, and what blocks it.

### 5) Red flags to monitor
- A short list of metrics/log patterns to watch in prod (timeouts, memory, unhandled rejections, query retry spikes).

Now perform the audit across the repository.
Include only findings you can support with evidence from the codebase.
If something seems likely but you can’t prove it, label it **Speculative** and explain why.
Stop when you have at least 15 high-impact findings OR you’ve exhaustively checked the repo.
---

If you want, I can also give you a **shorter “quick scan” version** (aims for top ~10 issues only) or a **more strict one** that forces the agent to output a machine-readable JSON report.
