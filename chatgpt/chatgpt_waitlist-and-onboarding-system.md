---
title: "Waitlist and Onboarding System"
type: guide
created: 2026-01-05
updated: 2026-01-05
source: chatgpt-export
conversation_id: 695bf0fa-52d0-832d-a534-daff0e23fc20
message_count: 4
tags: [chatgpt, import, code, long-form]
---
# Waitlist and Onboarding System

> Conversation ID: 695bf0fa-52d0-832d-a534-daff0e23fc20
> Created: 2026-01-05T17:13:22Z
> Updated: 2026-01-05T18:39:12Z
> Messages: 4

---

## User

If I have Next.js 16 and Clark for our author writer, and we want a waitlist system and an onboarding system, and users on the waitlist have to create an account first, so they have to get a Clark ID, so everyone has a Clark ID, and then we need to route to see if the users on the waitlist have been accepted off the waitlist. And then we also have to see if they've onboarded or not, so we know if they should go to the dashboard or go to the onboarding process. And the onboarding is multi-step, and we should save progress for onboarding. What's the best way to implement this? That is the most performative, and would cause the least complications with auth.

---

## Assistant

Mr. White — the cleanest “least auth headaches + very fast” pattern is:

- **Clerk = identity + session**
- **Your DB = source of truth for waitlist + onboarding state**
- **One “decision” endpoint right after login** that routes users to **/waitlist**, **/onboarding**, or **/app** based on DB state (not metadata that can lag)

This avoids the common gotcha where **Clerk user metadata/session claims can take seconds to reflect in middleware** after updates. citeturn0search6

---

## 1) Data model (DB is authoritative)

Create an `app_user` table keyed by `clerk_user_id`:

**app_user**
- `clerk_user_id` (pk/unique)
- `waitlist_status` enum: `pending | accepted | rejected`
- `accepted_at`
- `onboarding_status` enum: `not_started | in_progress | complete`
- `onboarding_step` int (or string key)
- `onboarding_data` jsonb (partial form data)
- `updated_at`

Why: onboarding is multi-step and needs partial saves; stuffing that into Clerk metadata is possible but size-limited and not what metadata is best at. citeturn0search3

---

## 2) Routing strategy (single source of truth + minimal middleware logic)

### A. After sign-in / sign-up → always go to a “post-auth router”
Configure Clerk to redirect to something like:

- `/post-auth` after sign-in
- `/post-auth` after sign-up

Clerk itself recommends this “onboarding gate” pattern. citeturn0search0

**`/post-auth`** (server route / server component):
1. `auth()` → get `clerkUserId`
2. `upsert app_user` (create row if first time)
3. Read `waitlist_status` + `onboarding_status`
4. Redirect:
   - `pending` → `/waitlist`
   - `accepted` + onboarding incomplete → `/onboarding/step-<n>`
   - `accepted` + onboarding complete → `/app`

This is the key: you make the decision **server-side, once**, off the DB.

### B. Middleware: protect pages, don’t “decide” anything expensive
Use middleware only to:
- Require auth for `/waitlist`, `/onboarding/*`, `/app/*`
- Optionally, route *unknown* users to `/post-auth` (cheap)

Avoid querying your DB inside middleware on every request (edge middleware + DB can be a latency trap).

---

## 3) Waitlist implementation (account required first)

Your flow requirement (“must create account to join waitlist”) becomes:

1. Public landing page → CTA “Join waitlist”
2. If not signed in → Clerk sign-up
3. Clerk redirects to `/post-auth`
4. `/post-auth` upserts user row with `waitlist_status='pending'` if new
5. Redirect to `/waitlist`

Clerk has an example waitlist built with user metadata, but in practice **DB-backed state scales cleaner** (auditing, analytics, bulk ops, joins, etc.). citeturn0search2

**Admin acceptance**
- Update DB: `waitlist_status='accepted'`, `accepted_at=now()`
- (Optional) also set a tiny Clerk `publicMetadata.waitlist='accepted'` for convenience, but **don’t rely on it for immediate gating** because token propagation can lag. citeturn0search6turn0search3

---

## 4) Onboarding (multi-step + saved progress)

### A. Route layout
- `/onboarding/step-1`
- `/onboarding/step-2`
- etc.

Each step:
- Loads saved state from DB (`onboarding_data`, `onboarding_step`)
- Renders form with defaults

### B. Saving progress (performant + robust)
Use **server actions** (or API routes) that do **partial updates**:
- On “Next”
- And optionally on debounced field changes for critical inputs

Update:
- `onboarding_status='in_progress'`
- `onboarding_step=<next>`
- Merge patch into `onboarding_data` jsonb (don’t overwrite everything)

When final step completes:
- `onboarding_status='complete'`
- Redirect to `/app`

### C. Guardrails
- Server-side validate each step before advancing
- If user hits `/onboarding/step-4` but DB says step-2, redirect them back (prevents weird state)

---

## 5) “Fast path” optimization without auth weirdness

If you want ultra-fast gating *after* `/post-auth`:
- Put only **two tiny booleans** in Clerk `publicMetadata` (or a single string status), *if you like*.
- But treat DB as canonical; metadata is just a hint/cache. Clerk metadata has size limits and token-size considerations. citeturn0search3
- If metadata is stale (it happens), `/post-auth` corrects it.

This hybrid gives you:
- **No DB hits in middleware**
- **Correctness** via `/post-auth`
- Minimal auth complications

---

## 6) Recommended rule set (simple + predictable)

- Any authenticated user visiting `/app/*`:
  - If they somehow bypassed, your **app layout server component** can do a quick DB check once and redirect to `/post-auth` (belt + suspenders).
- Any authenticated user visiting `/waitlist`:
  - If DB says accepted → `/post-auth` (which lands them in onboarding/dashboard)
- Any authenticated user visiting `/onboarding/*`:
  - If DB says onboarding complete → `/app`

---

If you tell me what DB you’re on (Postgres/Supabase/PlanetScale/etc.), I’ll sketch the exact schema + a concrete `/post-auth` + onboarding save pattern for that stack.

---

## User

Next neon database with drizzle is there any reason that itching at all just live in the clerk or the proxy.TS file

---

## Assistant

Mr. White — **yes, there *are* real reasons not to put this all in Clerk or only in `proxy.ts`**, even with Neon + Drizzle. Short answer:

**Identity in Clerk, product state in Neon (Drizzle).**  
Trying to collapse waitlist + onboarding fully into Clerk will cost you later in performance, correctness, and flexibility.

Below is the straight, no-fluff breakdown.

---

## Why NOT keep everything in Clerk metadata?

Clerk metadata **looks** tempting, but it’s the wrong tool for this job.

### 1) Token propagation lag (this is the killer)
When you update:
- `publicMetadata`
- `privateMetadata`
- session claims

Those updates **do not instantly propagate** to:
- Middleware
- Server Components
- Edge routes

Result:
- Users get routed incorrectly
- “Accepted but still seeing waitlist”
- “Finished onboarding but bounced back”

This is a known Clerk behavior and the #1 source of auth-routing bugs.

---

### 2) Metadata is not a database
Metadata limitations:
- Size limits (especially session claims)
- No partial updates (you overwrite blobs)
- No transactions
- No analytics / joins / admin tooling
- Painful for multi-step onboarding

Multi-step onboarding with saved progress is **exactly** what JSONB in Postgres is for.

---

### 3) Admin + ops pain
The moment you want:
- Bulk accept users
- Query funnel dropoff
- Segment onboarding steps
- Add features like “reset onboarding”

You’ll wish this was in SQL instead of Clerk metadata.

---

## Why NOT only use `proxy.ts` / middleware?

Middleware should be:
- **Fast**
- **Stateless**
- **Cheap**

Problems if you do logic there:
- Neon is not edge-local → latency
- DB queries on *every request*
- Hard to debug redirect loops
- You end up re-implementing a router in middleware

Best practice:
> Middleware = auth presence only  
> Server routes/components = decisions

---

## The correct split (with Neon + Drizzle)

### Clerk (only):
- Authentication
- Sessions
- User ID (`clerkUserId`)
- Optional: *tiny* convenience flags

### Neon + Drizzle (authoritative):
- `waitlist_status`
- `onboarding_status`
- `onboarding_step`
- `onboarding_data`
- Timestamps

This gives you:
- Strong consistency
- No auth race conditions
- Simple mental model

---

## Where logic actually belongs

### 1️⃣ `/post-auth` (server-only, not middleware)
This is your **single decision point**.

Flow:
```
auth() → clerkUserId
↓
SELECT app_user
↓
Redirect:
- pending → /waitlist
- accepted + incomplete → /onboarding/step-x
- accepted + complete → /app
```

One DB hit. One redirect. Done.

---

### 2️⃣ Middleware (`proxy.ts`)
Use it ONLY for:
- “Is the user signed in?”
- Blocking unauthenticated access

❌ No DB reads  
❌ No waitlist logic  
❌ No onboarding logic  

---

### 3️⃣ Onboarding saves
- Server actions
- Partial JSONB updates
- Update step + data atomically

This is where Drizzle + Neon shine.

---

## When is Clerk metadata acceptable?

**Only** for:
- UI hints (e.g. show badge)
- Non-critical flags
- Caching a status you *don’t rely on*

Never for:
- Routing decisions
- Multi-step progress
- Anything correctness-critical

---

## Final verdict (hard truth)

If you put waitlist + onboarding fully in Clerk:
- It will work at first
- It will break under real usage
- You will debug phantom auth bugs at 2am

**Neon + Drizzle is the right place.**  
Clerk should stay boring and reliable.

If you want, I can:
- Design the exact Drizzle schema
- Show the `/post-auth` server component
- Show the minimal middleware config
- Or show how to *optionally* mirror status into Clerk safely

Just say which.


## See Also
- [[chatgpt/chatgpt_waitlist-onboarding-chat]]
- [[chatgpt/chatgpt_soft-auth-waitlist-strategy]]
- [[chatgpt/chatgpt_superhuman-waitlist-process]]
- [[chatgpt/chatgpt_ai-driven-onboarding-design]]
- [[chatgpt/chatgpt_auth-system-with-toast-pin]]
