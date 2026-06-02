---
title: "Integration setup guide"
type: guide
created: 2025-08-28
updated: 2025-08-28
source: chatgpt-export
conversation_id: 68af9c72-d840-8324-84d3-70cf88d562a0
message_count: 4
tags: [chatgpt, import, code]
---
# Integration setup guide

> Conversation ID: 68af9c72-d840-8324-84d3-70cf88d562a0
> Created: 2025-08-28T00:01:55Z
> Updated: 2025-08-28T00:07:46Z
> Messages: 4

---

## User

For jovie, drizzle, neon, ssr, next..js tailwind 4, clerk auth, and upstash fro redis... all playing niceley ttogether. For performance and speed on public profiles. Deploying to vercel edge with posthog analytics and feature flags. Stripe for billing, no clerk billing.

Tell em what packages i should use for each and what the correct intergation notes i need are to make sure everything plays nice. Give me a concise set of things to look out for 

---

## Assistant

Got it, Mr. White. Here’s the tight integration map for **Next.js (SSR/Edge) + Drizzle + Neon + Clerk + Upstash Redis + Tailwind v4 + PostHog + Stripe** on Vercel.

# What to install (by area)

**Next.js / SSR & Edge**
- `next` `react` `react-dom`
- (Optional routing helpers) `next-safe-action` or your own RPC pattern

**DB (Neon + Drizzle)**
- `drizzle-orm`
- `drizzle-kit` (migrations)
- `@neondatabase/serverless` (use the **neon-http** client for Edge)

**Auth (Clerk)**
- `@clerk/nextjs`

**Redis (Upstash)**
- `@upstash/redis`
- `@upstash/ratelimit` (if you want clean per-IP/slug limits)

**CSS (Tailwind v4)**
- `tailwindcss` (v4)
- (Optional) `clsx`, `tailwind-merge`

**Analytics & Flags (PostHog)**
- `posthog-js` (client)
- `posthog-node` (server/Route Handlers)

**Billing (Stripe)**
- `stripe` (server/webhooks only)
- (Client) `@stripe/stripe-js` for Checkout/Elements

---

# Integration notes (the “make it play nice” bits)

**Edge vs Node split (Vercel)**
- Edge runtime routes: `export const runtime = 'edge'`
- Node runtime routes (Stripe webhooks, Node-only libs): `export const runtime = 'nodejs'`
- Don’t import `stripe` or Node-only libs in Edge code paths.

**Neon + Drizzle (Edge-safe)**
- Use Neon’s HTTP client:  
  ```ts
  import { neon } from '@neondatabase/serverless';
  import { drizzle } from 'drizzle-orm/neon-http';
  const sql = neon(process.env.DATABASE_URL!); // use pooled HTTP URL
  export const db = drizzle(sql);
  ```
- Run **drizzle-kit** migrations in CI (Node runtime) or a one-off job; don’t run migrations from Edge.
- Use **short-lived, per-request** db clients on Edge (no global pooling required with HTTP).

**Clerk (SSR + middleware)**
- Add `middleware.ts` with `clerkMiddleware()`; protect only what you must.
- On server components/route handlers use:
  ```ts
  import { auth, currentUser } from '@clerk/nextjs/server';
  ```
- On client use `<ClerkProvider>`, `useAuth()`.
- Ensure `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`, and **Frontend URL(s)** match exactly (prod/preview). Mismatches cause “invalid host”.

**Upstash Redis (Edge)**
- Works on Edge (HTTP-based). Pattern:
  ```ts
  import { Redis } from '@upstash/redis';
  export const redis = Redis.fromEnv();
  ```
- Use for:
  - **Public profile cache** (e.g., `profile:${slug}` JSON)
  - **Rate limit** public endpoints with `@upstash/ratelimit`
- Invalidate with tags or a simple `DEL` on writes, and pair with Next’s `revalidateTag()` where SSR fits.

**PostHog (analytics + flags)**
- Client: initialize `posthog-js` in a small provider, respect `doNotTrack` and only load in browser.
- Server/Route handlers: `posthog-node` for secure event capture and **flag evaluation for SSR** if you need server-side flag splits.
- Pass **distinct_id** from Clerk user id when authenticated; anonymous id for public views.

**Stripe (no Clerk billing)**
- Create Checkout Sessions on **Node runtime** route (`/api/stripe/checkout`).
- Webhooks: dedicated Node function at `/api/stripe/webhook` with `stripe.webhooks.constructEvent`.
- Store Stripe customer id on your user table keyed by Clerk user id.

**Tailwind v4**
- Zero-config `tailwind.css` with the new build; remove legacy plugins that aren’t v4-ready.
- Audit any class-merging libraries for v4 compatibility.

---

# Public profile perf (concrete recipe)

- Render **at the Edge** (fast TTFB).
- First look in **Upstash Redis** for `profile:${slug}`; if miss, fetch from Neon (Edge-safe via neon-http), hydrate minimal JSON, set a short TTL (e.g., 60–180s) + a **stale-while-revalidate** pattern.
- Keep the component **streaming** (RSC + suspense), compress images, pre-size avatars, and ship only needed client JS (islands).
- Track view with PostHog **client** (deferred) and **server** (low volume, optional) for reliable counts without blocking.

---

# ENV checklist (names that won’t bite you)

- **Neon**: `DATABASE_URL` (Neon HTTP URL)
- **Clerk**: `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`, `CLERK_WEBHOOK_SECRET` (if used), **Frontend URL(s)**
- **Upstash**: `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`
- **Stripe**: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`
- **PostHog**: `NEXT_PUBLIC_POSTHOG_KEY`, `POSTHOG_API_KEY` (server), `POSTHOG_HOST` (if EU/self-hosted)

---

# Things to watch out for (landmines)

1. **Edge/Node leakage**: Importing `stripe`, `posthog-node`, or any Node crypto in Edge routes = boom.
2. **Clerk host mismatch**: Frontend URL must match **exact domain (incl. preview)** or you’ll get “Invalid host / JWT signature” errors.
3. **Neon client**: Use `neon-http` with Drizzle on Edge; don’t use Node pooling clients there.
4. **Migrations**: Run `drizzle-kit` from CI/Node only; never in Edge paths.
5. **Caching correctness**: Invalidate Redis on writes (profile edits, plan changes). Consider a version key.
6. **PostHog flags**: If you SSR by flag, resolve flags **server-side** for deterministic HTML; otherwise flicker.
7. **Stripe webhooks**: Must be Node runtime; raw body parsing required. Don’t run behind Edge/middleware that consumes the body.
8. **Tailwind v4 plugin drift**: Some community plugins aren’t ready; prune or replace.
9. **Preview envs**: Provide **separate** PostHog projects/Stripe modes/Clerk instances or strict domain allowlists to avoid mixing data.
10. **Secret sprawl**: Keep all secrets in Vercel envs (prod/preview/dev) and never import them into client bundles.

If you want, I can drop starter snippets for each piece (Edge db client, Redis cache wrapper, Clerk SSR guard, Stripe handlers, PostHog provider) in your repo next.

---

## User

Update our claude file to align with this

---

## Assistant

Done, Mr. White. Your **CLAUDE.md** now matches the stack: Next.js (Edge/SSR) + Neon + Drizzle + Clerk + Upstash + Tailwind v4 + PostHog + Stripe (no Clerk billing). 

Key fixes:
- Purged Supabase client/JWT template references; added **neon-http + drizzle** Edge pattern.
- Added **Edge vs Node** runtime rules and landmines.
- Inserted **packages list**, **public profile caching recipe**, **PostHog flags SSR**, and **Stripe (Node-only) handlers**.
- Corrected feature flag naming to `feature_<slug>`.
- Consolidated env vars per system.

Want me to drop minimal starter files (`db/index.ts`, `lib/redis.ts`, PostHog provider, Stripe routes) next?
