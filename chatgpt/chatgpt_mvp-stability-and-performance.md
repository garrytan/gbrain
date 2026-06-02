---
title: "MVP Stability and Performance"
type: note
created: 2026-01-22
updated: 2026-01-22
source: chatgpt-export
conversation_id: 6972b1cb-19c0-832b-9728-778f40f3dd55
message_count: 2
tags: [chatgpt, import, long-form]
---
# MVP Stability and Performance

> Conversation ID: 6972b1cb-19c0-832b-9728-778f40f3dd55
> Created: 2026-01-22T23:25:26Z
> Updated: 2026-01-22T23:26:19Z
> Messages: 2

---

## User

So, as I'm analyzing our code base right now, and I'm trying to get us, like, we're trying to launch the MVP, and basically the thing works. It just has, like, intermittent reliability and stability issues and, like, performance things where, like, sometimes we get, like, a server, internal server error, sometimes we get, you know, just very slow page loads and stuff and, like, intermittent problems and stuff. And so we're kind of like, that's where we're at, is kind of like knocking out all of those stability and inconsistency issues and stuff, and locking down performance so that this thing, like, flies right now. And so I just did a comprehensive audit. I had Opus 4.5 analyze the code base. And the key findings, and this was specifically targeting these kinds of findings, but the key findings that it had for me were the number one priority issue is middleware DB calls block every authentication request on the proxy.ts file, get user state queries, the neon database on every request causing 200 to 1000 millisecond TTFB with cold starts. Number two was edge runtime routes with DB access may fail on edge nodes. The feature creators, one of the routes, the WebSocket connection issues can cause silent failures. Number three was onboarding transactions can exceed versatile timeout. The onboardingactions.ts, serialize transactions and avatar fetch retries can take more than 30 seconds. Number four was use effect and use links manager with unstable dependency can trigger render loops if parent doesn't memoize callback. Number five was... Unbounded query in the link wrapping service, no limit clause, memory exhaustion risk with large data sets. We also had fetch outside tanstack query component, fetch for critical persistence in use-link persistence, real-time cache enables 30-second polling by default, N plus 1 pattern and billing reconciliation cron, select without column selection, photo cleanup cron deletes records one by one, missing error boundaries for critical routes, user creation retries can block requests, use suggestions sync effect may run excessively, in-memory API route cache without bounds, network calls that should be tanstack query and aren't. You know, so anyway, so basically just like looking at those, you know, the summary here is middleware performance. DB calls in every request need caching. Number two, edge node runtime mismatch. Some DB routes incorrectly use edge runtime. Three is transaction scope onboarding action does too much in one request. And four is N plus one patterns cron jobs need batching and optimization. Now, after we started building the core of the app, we added in tanstack query, tanstack pacer, tanstack virtual, and tanstack table. We also added in NUX, N-U-K-S. And we're on Next 16. I'm not sure if we're on 16.1 yet. And we're using Clerk for authentication, and we use Drizzle and DrizzleKit on Neon Serverless. So the main thing that I'm curious about is a lot of like mismatches, and I don't totally understand all the intricacies of how this works. But, you know, some of the legacy stuff hasn't been moved over to Tanstack or consolidated properly. As we, like, now that we're ready to launch the MVP, you know, as we were building the thing, we didn't exactly know what we were gonna do, so we were incrementally building our schema and stuff. Now that, and all of our APIs and stuff, now that we understand it, we kind of have like a comprehensive thing of it. We probably would have built it a little bit more efficiently, right? So now that we kind of are ready to go, I kind of wanna lock it down to like a super efficient thing. And I wanna really nail down the mismatch between edge and node and SSR and all that stuff, so that everything that's public is loading incredibly quickly, you know, proper suspense and stuff and loading states, and like, you know, make sure that we can like, you know, and I just want to generally like nail, how all of that goes together and stuff and work on it and then once I’m done working on it I wanna I want to extract that is like a rule set in guardrails

---

## Assistant

Mr. White — you’re on the right problems. Here’s how I’d “lock it down” into a fast, predictable MVP, and then turn it into a repeatable rule set.

## 1) Stop doing DB work in middleware (biggest reliability + latency win)
**Why it hurts:** Next.js middleware runs on *every matched request* and is supposed to stay lightweight. If you hit Neon from middleware, you pay cold-start/connection latency and block the whole request path (your 200–1000ms TTFB spikes make total sense). Neon also autosuspends after inactivity, which can create cold-start behavior. citeturn0search2

**Target architecture**
- **Middleware = “optimistic checks only”**: read cookies/headers, validate Clerk session/JWT *without DB*, rewrite/redirect, set headers.
- **Authorization requiring DB = in Node route handlers / server actions** (or behind an internal API), *not* middleware.

**Concrete changes**
- In `proxy.ts` (or equivalent middleware):
  - Replace `getUserState()` DB query with:
    - Clerk session claims / JWT verification result, and
    - A short-lived, signed “user state” cookie (or header) **derived elsewhere**.
- Create a `/api/auth/bootstrap` (Node runtime) that:
  - does the DB lookup once per session (or once per X minutes),
  - returns minimal “user state” (role, orgId, flags),
  - sets an HttpOnly cookie with TTL (e.g., 5–15 minutes) + version stamp.
- In React, prefetch bootstrap once (TanStack Query) and keep it warm client-side.

**Guardrail**: “Middleware must be pure compute; zero DB/network calls.”

---

## 2) Fix Edge vs Node mismatches (eliminates “works sometimes” failures)
You’re seeing the classic problem: some routes are running on Edge nodes but using Node-only DB drivers / connection patterns.

**Rule of thumb**
- If the code touches **Neon/Drizzle**, **WebSockets**, **crypto/node APIs**, **file system**, or **large transactions** → **Node runtime**.
- Edge is for **tiny request transforms** and **simple fetches** to edge-compatible services.

**Action**
- Do an explicit runtime sweep:
  - Add `export const runtime = "nodejs"` to every route handler / server action that hits DB or uses WS.
  - Ensure **no DB client initialization** happens in files imported by Edge routes.
- If you’re on Next 16.x, Node.js middleware support is stable, which gives you more room to keep middleware logic Node-based—but you still don’t want DB calls there. citeturn0search7turn0search0

**Guardrail**: “Any DB access requires runtime=nodejs; Edge routes may not import DB modules.”

---

## 3) Split onboarding into bounded work (kills 30s timeouts)
Your onboarding is doing multiple slow steps (serialized transactions + avatar fetch retries). That’s how you exceed typical serverless time limits.

**Pattern**
- Make onboarding **idempotent** and **multi-step**:
  1) `POST /api/onboarding/start` (fast): create row, return onboardingId
  2) `POST /api/onboarding/step` (fast): apply one DB change
  3) Avatar/media fetch → **async job** (queue) or at least a separate endpoint with its own timeout + retries.
- Use **outbox table** or “pending_jobs” table if you don’t have a queue yet.
- Add strict per-step budgets (e.g., 300–800ms) and fail fast with resumable state.

**Guardrail**: “No request does unbounded external retries; onboarding must be resumable.”

---

## 4) Eliminate unbounded queries + N+1s (prevents memory blowups + slow crons)
These are “time bombs.”

**Immediate fixes**
- **Every list query must have**: `LIMIT`, deterministic `ORDER BY`, and cursor pagination if it can grow.
- **Select only needed columns** (especially in Drizzle).
- **Cron batching**:
  - Replace “delete one by one” with bulk deletes or batched `WHERE id IN (...) LIMIT ...`.
  - Billing reconciliation: prefetch related entities in bulk, join, or do 2-pass queries with `IN` sets.

**Guardrail**: “No query without limit (unless by primary key). No N+1 in cron paths.”

---

## 5) React/TanStack cleanup to stop render loops + random refetching
You called out unstable deps and fetches outside TanStack Query.

**Rules**
- Any server state fetch in client components → **TanStack Query only**.
- Anything used in `useEffect` deps that’s passed from parent must be **memoized** (`useCallback`, `useMemo`) or moved inside the effect.
- Disable accidental polling:
  - If “real-time cache” defaults to 30s polling, explicitly set `refetchInterval: false` unless the view truly needs it.

**Guardrail**: “No raw fetch in client components for server state; TanStack Query owns it.”

---

## 6) WebSockets: make failures loud + recoverable
Silent failures usually come from missing:
- connection lifecycle logging/metrics
- heartbeats (ping/pong)
- reconnect with backoff + jitter
- server-side timeouts / max payload / auth refresh

**Guardrail**: “WS must have heartbeat + reconnect + visible error surface (toast/log/telemetry).”

---

# The “Guardrails” rule set (copy/paste friendly)
1) **Middleware**: no DB/network I/O; only cookie/header/session parsing + redirects.  
2) **Runtime**: DB/WS/Drizzle ⇒ `runtime="nodejs"`; Edge routes may not import DB modules.  
3) **DB access**: pooled/optimized; no per-request “bootstrap” queries—cache user state with TTL.  
4) **Queries**: every list query has `LIMIT` + stable `ORDER BY`; select only needed columns.  
5) **Transactions**: bounded (< ~1s); onboarding is resumable steps; no long external retries in-request.  
6) **Client data fetching**: TanStack Query only; no raw fetch for server state; polling must be explicit.  
7) **Crons**: batch operations; forbid N+1; use set-based SQL.  
8) **Reliability**: error boundaries on critical routes; retries are capped + exponential backoff; failures are observable.  
9) **WebSockets**: heartbeat + reconnect + auth refresh + telemetry.  
10) **Imports**: shared modules must be runtime-safe (Edge-safe modules cannot import Node/DB code).

---

If you want, paste the **current middleware/proxy.ts auth flow** (just the relevant parts) and one example of an **Edge route that hits DB**, and I’ll rewrite them into the Node/bootstrap + cached user-state pattern without changing behavior.
