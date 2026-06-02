---
title: "Claude file updates"
type: essay
created: 2025-08-26
updated: 2025-08-26
source: chatgpt-export
conversation_id: 68ae21eb-4874-832f-af5c-a08f107e3e3f
message_count: 17
tags: [chatgpt, import, code, long-form]
---
# Claude file updates

> Conversation ID: 68ae21eb-4874-832f-af5c-a08f107e3e3f
> Created: 2025-08-26T21:06:52Z
> Updated: 2025-08-26T21:30:45Z
> Messages: 17

---

## User

We need to update our claude file to ensure no client supabase just server. We also are going to move to drizzle. So we should be prepared for everything in our stack and claude file to be done in a way that is compatible with drizzle and eventually neon. Suggest changes to our claude file, if i approve, you'll make them.

---

## Assistant

Got it, Mr. White. Here’s a tight proposal to bring **CLAUDE.md** in line with “server-only Supabase,” **Drizzle-first**, and “Neon-ready,” plus remove the Clerk-billing bits in favor of **direct Stripe**.

# Proposed edits to `CLAUDE.md`

## 1) Global stance (add at top)
- **No client Supabase.** Do not import `@supabase/supabase-js` in client components.  
- **All data access = server-only** via Route Handlers, Server Actions, or server components.  
- **ORM = Drizzle** with a driver abstraction that can swap to **Neon** later.  
- **Billing = Stripe directly** (Checkout + Billing Portal). Remove Clerk Billing section.

## 2) Replace current “Clerk-Supabase Integration” with “Auth & Access (Clerk → Server only)”
**Keep Clerk for auth/session**, but:
- Use `@clerk/nextjs/server` in server files only.
- Pass the **user id** (and any needed claims) into DB calls on the server.  
- No `useSession()` examples with Supabase; delete client examples.

**Server example (replace 1.3/5.2):**
```ts
// app/api/user/route.ts
import { auth } from '@clerk/nextjs/server';
import { db } from '@/db'; // Drizzle instance
import { users } from '@/db/schema';

export async function GET() {
  const { userId } = await auth();
  if (!userId) return new Response('Unauthorized', { status: 401 });

  const row = await db.select().from(users).where(users.clerkId.eq(userId)).limit(1);
  return Response.json(row[0] ?? null);
}
```

## 3) New section: **Database Layer (Drizzle-first, Neon-ready)**
**Goal:** One `db` factory that picks a driver by env without changing call sites.

- **Drivers we support:**
  - **Node Postgres (Pool)** → works with Supabase Postgres now.
  - **Neon HTTP** → drop-in for serverless/edge later.
- **Never use service role for per-user queries.**  
- **Per-request identity**: set a session variable for RLS-like checks.

**Structure:**
```
/db
  /schema/*          // drizzle schema
  client.ts          // exported 'db'
  drivers/
    node-postgres.ts // current default (Supabase db)
    neon-http.ts     // future
  session.ts         // helpers to set user context
```

**`client.ts` (sketch):**
```ts
import { drizzle } from 'drizzle-orm/node-postgres'; // or drizzle-orm/neon-http
import { getPool } from './drivers/node-postgres';   // swap to neon later

export const db = drizzle(getPool()); // typed, shared across server
```

**Session variable pattern (RLS-like):**
```ts
// db/session.ts
import { sql } from 'drizzle-orm';
import { db } from './client';

export async function withUser<T>(userId: string, fn: () => Promise<T>) {
  await db.execute(sql`SET LOCAL app.user_id = ${userId}`);
  return fn();
}
```

Use in handlers:
```ts
import { withUser } from '@/db/session';
import { auth } from '@clerk/nextjs/server';
import { db } from '@/db';
import { posts } from '@/db/schema';

export async function GET() {
  const { userId } = await auth();
  if (!userId) return new Response('Unauthorized', { status: 401 });

  const data = await withUser(userId, () =>
    db.select().from(posts).where(/* policy uses current_setting('app.user_id') */)
  );
  return Response.json(data);
}
```

## 4) New section: **Postgres Security & Policies (Drizzle with RLS-like constraints)**
Since direct drivers bypass Supabase’s JWT context:
- **Create a Postgres GUC** `app.user_id`.
- **Policies reference `current_setting('app.user_id', true)`**.

**Example policy:**
```sql
-- one-time setup
CREATE OR REPLACE FUNCTION app.current_user_id()
RETURNS text LANGUAGE sql STABLE AS $$
  SELECT current_setting('app.user_id', true)
$$;

ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;

CREATE POLICY users_isolation ON public.users
FOR ALL TO PUBLIC
USING (id::text = app.current_user_id())
WITH CHECK (id::text = app.current_user_id());
```

> Rule: Every request calling `db` must set the session var via `withUser(userId, fn)`.

## 5) Storage, Realtime, RPC (server-only)
- If you keep Supabase **Storage/Realtime/Functions**, expose **server endpoints** that proxy these features.  
- **No direct client Supabase usage.**  
- If Realtime is needed client-side, broker it through a **server-validated channel token** or consider a Neon-compatible alternative later.

## 6) Replace **“Clerk Billing with Stripe Integration”** → **“Stripe Billing (Direct)”**
Remove Section 2 entirely. Add:

**Stripe setup:**
- Checkout Sessions for purchase
- Customer Portal for self-serve manage/cancel
- Webhooks → upsert `subscriptions` table via Drizzle
- **Do not** use Clerk Billing components.

**Env (update 7):**
```bash
# Stripe
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_live_...
```

**Server route examples:**
```ts
// app/api/checkout/route.ts
import Stripe from 'stripe';
import { auth } from '@clerk/nextjs/server';

export async function POST() {
  const { userId } = await auth();
  if (!userId) return new Response('Unauthorized', { status: 401 });

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    line_items: [{ price: process.env.STRIPE_PRICE_ID!, quantity: 1 }],
    success_url: `${process.env.NEXT_PUBLIC_BASE_URL}/success`,
    cancel_url: `${process.env.NEXT_PUBLIC_BASE_URL}/pricing`,
    client_reference_id: userId,
  });
  return Response.json({ url: session.url });
}
```

```ts
// app/api/stripe/webhook/route.ts
import Stripe from 'stripe';
import { db } from '@/db';
import { subscriptions } from '@/db/schema';

export async function POST(req: Request) {
  const raw = await req.text();
  const sig = req.headers.get('stripe-signature')!;
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
  const event = stripe.webhooks.constructEvent(raw, sig, process.env.STRIPE_WEBHOOK_SECRET!);

  // handle events: customer.subscription.created/updated/deleted
  // upsert into subscriptions via Drizzle
  return new Response('ok');
}
```

## 7) New **Driver Matrix** (Neon prep)
Add a table:

| Env | Driver | Package | Notes |
|---|---|---|---|
| Node (Supabase db) | `pg` Pool | `pg`, `drizzle-orm/node-postgres` | default now |
| Serverless (Neon) | Neon HTTP | `@neondatabase/serverless`, `drizzle-orm/neon-http` | swap via env |
| Edge (optional) | Neon HTTP | same as above | if we move some routes to Edge |

**Switch by env:**
```ts
// drivers/node-postgres.ts
import { Pool } from 'pg';
let pool: Pool;
export function getPool() {
  if (!pool) pool = new Pool({ connectionString: process.env.DATABASE_URL });
  return pool;
}
```

```ts
// drivers/neon-http.ts
import { neon } from '@neondatabase/serverless';
export function getClient() {
  return neon(process.env.DATABASE_URL!);
}
```

## 8) Update “AI MODEL VERIFICATION STEPS”
- **Confirm no `@supabase/supabase-js` imports in client.**
- **Confirm all DB calls go through Drizzle on the server.**
- **Confirm session var is set (`SET LOCAL app.user_id`) before tenant-scoped queries.**
- **Confirm no Clerk Billing components; Stripe webhook + Checkout present.**
- **Confirm driver abstraction exists and compiles under both node-pg and neon-http.**

## 9) Env Vars (revise Section 7)
```bash
# Clerk (auth)
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=...
CLERK_SECRET_KEY=...

# Database (Supabase Postgres now; Neon later)
DATABASE_URL=postgres://...

# Stripe (direct)
STRIPE_SECRET_KEY=...
STRIPE_WEBHOOK_SECRET=...
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=...
NEXT_PUBLIC_BASE_URL=https://jovie.app
```

## 10) Remove deprecated content
- Delete all client Supabase examples (Sections 1.2, 5.1).  
- Delete “Clerk Billing with Stripe Integration” (entire Section 2 + 2.1–2.6, 3.1 “For Clerk Billing”, 3.2 “For Clerk Billing”, 5.4 “Pricing Page Example”, 5.5 “Homepage Pricing Link Example”).  
- Delete mentions of `<PricingTable />`, `has({ plan })`, `<Protect plan=...>`.

---

If you approve, I’ll apply the edits as a clean, surgical patch to **CLAUDE.md**.

---

## User

approved

---

## Assistant

All set — I’ve updated **CLAUDE.md** to:  

- Enforce **server-only Drizzle** (no client Supabase).  
- Add **Neon-ready driver abstraction** and RLS via session variables.  
- Remove all **Clerk Billing** sections and replace with **direct Stripe integration** (Checkout, Portal, Webhooks).  
- Clean environment variables to just Clerk, `DATABASE_URL`, and Stripe.  
- Updated verification steps so AI must confirm server-only, Drizzle-compatible, Stripe-only patterns.  

Would you like me to also add a **migration checklist** section (step-by-step for moving from Supabase-js to Drizzle/Neon) so future contributors know exactly how to transition?

---

## User

Should we use graphql?

---

## Assistant

Short answer: **not now.**

Mr. White, for Jovie’s current shape (Next.js + server-only Drizzle over Postgres, Stripe, Clerk), GraphQL adds cost without clear benefit.

**Why skip GraphQL today**
- **One frontend, simple data shapes.** Server Actions/Route Handlers + Drizzle give typed, fast queries with less overhead.
- **Auth/RLS is simpler.** We’re already using a Postgres GUC (`app.user_id`). Adding a GraphQL gateway means re-plumbing identity and caching rules.
- **Performance & DX.** GraphQL buys you client query flexibility, but you pay in schema/resolver layer, N+1 protection, caching, and codegen upkeep.

**When GraphQL *does* make sense later**
- You offer a **public/partner API** (third-party devs, integrations).
- You support **multiple heterogeneous clients** (web, mobile, partner dashboards) that need **flexible querying**.
- You need **schema federation** across services or want **typed contracts** for external consumers.

**What to do instead (now)**
- Keep everything **server-only** with **Route Handlers/Server Actions**.
- Use **Drizzle relations** + SQL views/materialized views to shape payloads (avoid N+1).
- Generate types with `drizzle-kit`; use `drizzle-zod` for input validation.
- If you want RPC ergonomics on the client, consider a light **tRPC** layer (still server-only)—but only if it materially speeds you up.

**If/when we add GraphQL**
- Put it **behind the server** (no client SDK).
- Map **resolvers → Drizzle** (no ORM duplication).
- Enforce auth by setting `app.user_id` per request before resolver execution.
- Start small with **GraphQL Yoga** (or Helix) + codegen; add Dataloader for N+1, only if needed.
- Expose **public types** and docs; keep internal routes unchanged.

**Go/No-Go checklist (today = No-Go)**
- Public API soon? **No** → skip
- Multiple independent client apps? **No** → skip
- Complex cross-entity query flexibility needed client-side? **No** → skip

If you want, I’ll append a one-liner to **CLAUDE.md** under “Database Layer”:

> **Default:** No GraphQL. Add only for public/partner API use cases; resolvers must be server-only, backed by Drizzle, and enforce `app.user_id` before DB access.

Say the word and I’ll commit that note.

---

## User

Should we use upstash?

---

## Assistant

Short answer: **use Upstash narrowly**.

**Where Upstash makes sense for Jovie (now)**
- **Rate limiting** (API abuse, link-click endpoints): Upstash Redis + `@upstash/ratelimit` (Edge-safe).
- **Ephemeral caching** (public link pages, OG/meta fetches, short-TTL): avoid pounding Postgres.
- **Reliable webhooks fan-out / retries**: **QStash** to queue Stripe/Clerk webhooks → worker route with retries & DLQ.
- **Lightweight queues** (email/sync jobs) without standing up a worker.

**Where *not* to use it**
- **Durable state, business logic, analytics** → keep in Postgres via Drizzle.
- **User sessions** (Clerk handles that).
- Anything that needs SQL joins/transactions.

**Why this fits our stack**
- Edge-compatible if we move some routes to Edge/Neon later.
- Keeps Postgres hot path clean; cheaper than “counters in SQL”.
- Minimal code: single Redis + optional QStash; no client SDKs.

**Cost/ops sanity**
- Pay-as-you-go; cheap for low-volume ratelimits/caches.
- Add metrics/alerts; set aggressive TTLs to avoid creep.

---

### Proposed CLAUDE.md additions (tell me “approved” to patch)

**Section: Caching & Rate Limiting (Upstash, optional)**
- All usage is **server-only**.
- Use **Upstash Redis** for:
  - Request **rate limiting** (e.g., `@upstash/ratelimit` sliding window).
  - **Short-TTL caches** for public, non-sensitive responses.
- Never cache PII; TTLs ≤ 15 min unless noted.

**Section: Webhooks & Background Jobs (QStash, optional)**
- Stripe/Clerk webhooks → enqueue in **QStash** → process via server route.
- Enable retries + DLQ; handlers are **idempotent** and write via Drizzle.
- No client access to QStash.

**Verification steps**
- ✅ No client Upstash usage.
- ✅ Ratelimits enforced on public endpoints.
- ✅ Webhook handlers idempotent; Postgres writes transactional.
- ✅ Caches bypassed for authenticated/private data.

Want me to add these sections now?

---

## User

So when we move to neon how does up stash fit in or does it not?

---

## Assistant

Mr. White — **yes, Upstash still fits with Neon**. It’s complementary, not a replacement.

## Where Upstash helps in a Neon world
- **Edge rate limiting**: Put `@upstash/ratelimit` in front of public routes (clicks, OG fetchers, API) so Neon isn’t hammered.
- **Ephemeral caching**: Cache read-heavy, public responses (link pages, metadata, DSP lists) in **Upstash Redis** with short TTLs (30s–15m). This offsets Neon queries and hides cold starts.
- **Webhook fan-out & jobs**: Use **QStash** to enqueue Stripe/Clerk webhooks → process in a server route/worker; retries + DLQ; idempotent Drizzle writes.
- **Edge friendliness**: If/when you run some handlers on Vercel **Edge** with **Neon HTTP** driver, Upstash is already Edge-compatible (no TCP).

## When not to use it
- **Durable state/business logic** → Postgres (Neon) via Drizzle.
- **Anything requiring joins/transactions** → Postgres.
- **Private/PII payloads** → don’t cache; or cache keyed to user with ultra-short TTL and encryption (usually not worth it).

## Neon-specific notes
- **Connection limits**: Neon HTTP is connectionless, but caching + rate limits still reduce compute and egress.
- **Latency/region**: Keep **Upstash in the same region** as Neon/Vercel (you’re on us-east-1).  
- **Invalidation**: Use **tagged keys** (e.g., `link:{id}:v{version}`) and bump version on write; or `DEL` on specific keys post-mutation.

## Minimal patterns
- **Rate limit**: Sliding window per IP or per user: `rl.limit("route:{ip}")`.
- **Cache**: `GET cacheKey` → on miss: query Neon via Drizzle → `SETEX cacheKey, ttl, json`.
- **Webhooks (QStash)**: Stripe → your `/api/stripe/webhook` → enqueue job → worker route processes → Drizzle upsert → ack.

## Recommendation
- Adopt Upstash **now** for: (1) rate limits on public endpoints, (2) short-TTL caches for public reads, (3) QStash for webhooks/jobs.  
- Keep **all** Upstash usage **server-only** and PII-free.

---

Side note: your posted `.env.development.local` contains **live-looking secrets** (Stripe, Cloudinary, Neon, Spotify, Clerk e2e creds). **Rotate them immediately** and remove Clerk Billing envs—we’ve already purged Clerk Billing from `CLAUDE.md`.

---

## Assistant

Mr. White — **Upstash still fits when we move to Neon.** It complements Neon; it doesn’t replace it.

### Where it slots in (Neon + Next.js)
- **Rate limiting (Edge-safe):** Upstash Redis + `@upstash/ratelimit` in Route Handlers/Edge. Keeps bots from hammering public link pages, API, and webhooks.
- **Ephemeral cache:** Short-TTL cache for public, unauthenticated responses (OG scrapes, DSP link bundles) to cut read load on Neon. Use cache-aside; TTL ≤ 5–15 min; no PII.
- **Background delivery & retries:** **QStash** to queue inbound webhooks (Stripe, etc.) → worker route with retries/DLQ. Handlers are idempotent and write via Drizzle to Neon.
- **Counters/locks:** Lightweight Redis counters (clicks, ephemeral feature flags, one-time tokens). Durable analytics still live in Postgres.

### Why it’s a good pair with Neon
- **Edge-friendly stack:** Neon HTTP driver + Upstash (global Redis HTTP) both work in Edge runtime if we push some routes there.
- **Latency:** Pick Upstash region close to Neon (you’re on **us-east-1**). Keep Redis+QStash in the same geography to avoid cross-region tail latency.
- **Cost:** Cheaper than doing counters/rate limits in SQL; keeps Neon for durable state/joins.

### When **not** to use it
- Not for durable domain data, auth sessions, or anything needing transactions. Those stay in **Neon + Drizzle**.

---

### CLAUDE.md additions (succinct)
Add under **“Caching & Rate Limiting (Upstash)”**:
- Use Upstash Redis **server-only** for: (1) rate limits, (2) short-TTL public caches, (3) ephemeral counters/locks.
- **Do not cache PII.** Default TTL ≤ 900s. Invalidate on write where correctness matters.
- Place Upstash in same region as **Neon**; Edge routes may use Neon HTTP + Upstash.

Add under **“Webhooks & Jobs (QStash)”**:
- Inbound webhooks → **enqueue QStash** → worker route. Enable retries + DLQ.
- **Idempotency:** Redis key `idemp:{provider_event_id}` (TTL 24–48h) around Neon writes.

Add to **Verification**:
- ✅ No client Upstash usage.
- ✅ Public endpoints have rate limits.
- ✅ Webhook handlers idempotent; writes via Drizzle; background via QStash.
- ✅ Upstash region aligns with Neon region.

If you want, I’ll patch those lines into **CLAUDE.md**.

---

Quick security note: that `.env.development.local` you shared exposes live-looking secrets (Stripe, Cloudinary, Neon). Rotate them now and remove from any repo history.

---

## User

Up stash via marketplace or seperate

---

## Assistant

For Jovie: **separate** is cleaner.  

### Why not marketplace  
- **Lock-in / portability**: A Vercel Marketplace install ties billing + access to that Vercel project. If you ever run jobs outside Vercel (e.g. a standalone worker, Fly, Docker, self-hosted), you’d have to re-wire or duplicate.  
- **Env clutter**: Marketplace auto-injects env vars with VERCEL_-style names; harder to standardize across staging/prod/CI.  
- **Cost tracking**: Your Neon + Stripe + Clerk + Cloudinary are already managed outside Vercel. Keeping Upstash separate keeps your infra consistent and easy to swap.  

### Why separate is better  
- **Same account across all deployments** (local dev, CI, Vercel, anywhere).  
- **Direct control of regions** (important to pick same region as Neon, us-east-1).  
- **Full Upstash dashboard features** (metrics, QStash retries, analytics).  
- **Future flexibility** if you spin up jobs off Vercel.  

### Migration path  
1. Sign up at [upstash.com](https://upstash.com).  
2. Create a **Redis** (for rate limits/caching) and optionally a **QStash** queue.  
3. Put `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`, `QSTASH_URL`, `QSTASH_TOKEN` in your `.env`.  
4. Import with official SDKs:  
   ```ts
   import { Redis } from '@upstash/redis'
   export const redis = new Redis({
     url: process.env.UPSTASH_REDIS_REST_URL!,
     token: process.env.UPSTASH_REDIS_REST_TOKEN!,
   })
   ```  

---

✅ **Recommendation**: provision **separately**, not through Vercel Marketplace. It’s more consistent with how you’re already handling Neon, Stripe, Clerk.  

Want me to patch your `.env.development.local` to include the canonical `UPSTASH_...` keys so it’s ready?

---

## User

Ensure claude respects these rules and combine them into our claude.md file

🚦 Jovie PR & Integration Rules

1. Intent
	•	Always run a fast, deterministic smoke test before opening a PR.
	•	Always open the PR (pass or fail) with structured output so it can enter Merge Queue when ready.
	•	Follow YC best practices (ship small, fast, tighten loops), design like Linear (clarity, minimalism), and hold bar for Apple-level UX & copywriting (concise, humane, benefit-oriented).

⸻

2. Triggers

Open PR when:
	•	linear.issue_labeled(codegen|ready)
	•	local.command("prepare-pr")
	•	vcs.branch_created("feat/*","fix/*","chore/*")

⸻

3. Environment
	•	NODE_VERSION=20
	•	PACKAGE_MANAGER=pnpm

⸻

4. Smoke Steps
	1.	Checkout → new branch if needed
	2.	Install deps: pnpm i --frozen-lockfile
	3.	Lint: pnpm lint --max-warnings=0
	4.	Types: pnpm typecheck (tsc --noEmit)
	5.	Unit (smoke): pnpm test:unit --run -t "smoke|happy|render"
	6.	Build: pnpm build -n || vite build --emptyOutDir false
	7.	UI snapshot (optional): pnpm story:build || true
	8.	Summarize → PR body

⸻

5. Policy
	•	Don’t reformat files beyond the change set.
	•	Don’t touch infra/pipeline files (.github/workflows/**, infra/**) unless issue requires.
	•	Keep diffs small, focused slices (≤300 LOC touched).
	•	No naked TODOs; clear names only.
	•	Copywriting: short, specific, no filler.

⸻

6. Failure Behavior
	•	Still open PR.
	•	Labels: needs-human, smoke-failed. Remove automerge.
	•	Title prepended with ❌. Include logs summary in body.
	•	Never queue auto-merge until smoke passes.

⸻

7. Success Behavior
	•	Labels: ready-for-review, automerge-candidate.
	•	Title prefix: feat:, fix:, chore:, docs:, refactor:, perf:, test:.
	•	Auto-enable squash auto-merge if all checks are green.

⸻

8. PR Template

Always open PRs with:

Title

{{ status_emoji }} {{ type_prefix }}{{ concise_title }}

Body

## Summary
- **Why**: {{ problem_statement }}
- **What**: {{ solution_slice }}
- **Risk**: {{ risk_note }}
- **UX**: Apple-level polish; copy trimmed for clarity.

## Smoke Result
- Lint: {{ lint_status }}
- Types: {{ types_status }}
- Unit: {{ unit_status }}
- Build: {{ build_status }}
- Storybook: {{ story_status }}

## Checklists (YC + Linear-inspired)
- [ ] Small, reviewable diff (≤300 LOC)
- [ ] Clear acceptance criteria met
- [ ] Tests updated/added
- [ ] UX text concise & on-brand
- [ ] No layout shifts/spinner overlap
- [ ] Public profile <100ms p95

## Notes for Reviewers
- Logs: {{ short_logs }}
- Follow-ups: {{ followups }}

	•	Default labels: ["triage"]
	•	Reviewers: @owner-or-codeowners

⸻

9. Post-Open Flow
	•	❌ → Post comment with actionable next steps + failing stage/log link.
	•	✅ → Link PR to issue and move Linear ticket to In Review.

⸻

10. Branching & Protection
	•	Never push directly to preview or main.
	•	Work only on feature branches from preview:
	•	Naming: feat/<slug>, fix/<slug>, chore/<slug> (3–6 word kebab-case).
	•	All changes flow via PR → preview.
	•	Auto-merge to preview allowed after green CI.
	•	Promotion preview → main is manual PR + release tag.

⸻

11. Feature Development Flow
	1.	Branch from preview, name properly.
	2.	Scope: one user-visible outcome; split otherwise.
	3.	Implementation
	•	Behind feature flag (feature_<slug>, default OFF).
	•	Add PostHog events (page_element_action).
	•	Unit + E2E smoke test main path.
	4.	PR to preview:
	•	Title [feat|fix|chore]: <slug>
	•	Body includes goal, KPI, flag name, events, rollback plan.
	5.	Checks: lint, types, unit, E2E, preview deploy, Chromatic if UI.
	6.	Post-Deploy: deploy w/ flag OFF → enable internal only → verify metrics/errors → progressive rollout.
	7.	Done: code in preview, feature flagged, metrics firing.
	8.	Merge to main: via manual PR + release tag.

⸻

12. Clerk-Supabase Integration
	•	Use native integration, NOT JWT templates.
	•	Client: useSession() → session.getToken() via accessToken().
	•	Server: auth() → getToken().
	•	RLS policies: auth.jwt()->>'sub' = user_id.
	•	Enable RLS on all user tables.
	•	Test multi-user isolation.

⸻

13. Stripe Billing
	•	Use direct Stripe integration (not Clerk billing).
	•	Handle subscriptions, invoices, and plan logic directly with Stripe API.
	•	Keep billing logic modular and isolated from auth.
	•	All subscription state checks (active, canceled, trialing) must be enforced server-side.
	•	Pricing page: custom-built (not <PricingTable />).
	•	Webhooks: mandatory for subscription lifecycle events.
	•	Never bypass subscription checks client-side.

⸻

14. Deprecated Patterns (🚫 Never Use)
	•	JWT templates (getToken({ template: 'supabase' })).
	•	createClerkClient() client-side.
	•	Hardcoded user IDs in RLS.
	•	Direct pushes to preview or main.
	•	Manual subscription checks on client (must be server-verified).
We will use upstash as recommended by you. 

---

## Assistant

I merged your detailed **PR & Integration Rules** into `CLAUDE.md` as the leading section and removed the old, redundant Windsurf/critical rules. Now the file starts with the unified rules, then flows into technical guardrails (Auth, Drizzle, Stripe, etc.), without duplication.  

Want me to also add an **Upstash Usage** section (rate limiting, ephemeral caching, QStash for webhooks) so CLAUDE enforces those patterns too?

---

## User

Add some rules about keeping unit tests fast. You can add the up stash usage as well. But keep yc principles in mind

---

## Assistant

I added new sections for **Unit Test Performance Rules** (fast feedback, <200ms per test, mocking external services) and **Upstash Usage** (rate limiting, caching, QStash, server-only, YC-speed focus). Testing Guidelines and later sections were renumbered.
