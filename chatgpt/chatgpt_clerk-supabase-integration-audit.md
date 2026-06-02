---
conversation_id: 68a38b5f-59ac-832d-966f-8492ab754503
created: 2025-08-18
links:
- '[[chatgpt-clusters/coding_devops]]'
message_count: 4
source: chatgpt-export
tags:
- chatgpt
- import
- code
- long-form
title: Clerk Supabase integration audit
type: essay
updated: 2025-08-18
---

# Clerk Supabase integration audit

> Conversation ID: 68a38b5f-59ac-832d-966f-8492ab754503
> Created: 2025-08-18T20:22:04Z
> Updated: 2025-08-18T20:28:03Z
> Messages: 4

---

## User

https://clerk.com/docs/integrations/databases/supabase 


This is the documentation on SuperBase and Cleric integration. We have the setup and we're running it right now. We're having various issues. And what I would like to do is instruct Cloud Code to just look through our entire setup of SuperBase and Cleric. We've had some instances with fake JumpJWT instances and stuff like that. We want to go through and make sure that they're removed and they're all using real ones. We want to make sure that everything is set up correctly with the integration. We want to make sure that all our RLS policies are working correctly. We want to make sure that artist profiles are public and will display publicly, both on local and on a server. We want to make sure that users can sign up. And when they sign up with Cleric, it will create an account in SuperBase for that user. We want to make sure that that user then has the ability to read their own data, to load the dashboard. And basically, we want to iterate through all of this and ensure that we've fixed all of this stuff and that all of the health, the health slash API slash health slash DB route shows that we're good. And we want to basically just make sure that artist profiles are loading when a user signs up, a new account is created with an attached artist profile. As soon as after they're prompted for their username and they pick a username, then it's attached to a user profile or to an artist profile. And then when they and then they're sent to the database and they're authenticated to get that data. Give me an add prompt to let Cloud Code go through and do all this. I'd also say that we should squash any data migrations because we're not live yet. So we can simplify our migrations if that makes sense. And and then we can do a reset DB.

---

## Assistant

Mr. White — here’s a single, drop-in prompt for Claude Code to **audit and fix your Clerk ↔ Supabase integration** (Next.js 15, SSR-safe), scrub any legacy JWT-template usage, lock RLS, ensure public artist profiles, auto-create profiles on signup, and finish with a clean migrations squash + DB reset.

> Copy everything between the lines and paste into Claude Code.

```
You are a senior full-stack engineer. Task: audit and repair our Clerk ↔ Supabase integration for a Next.js 15 app (App Router). Goals:

A) Remove legacy/JWT-template paths; use **native Supabase third-party provider** with Clerk session tokens.
B) Enforce correct RLS everywhere.
C) Artist profiles are public (read-only) when is_public = true (both local & server).
D) Signup flow: Clerk signup → username step → create user row and attached artist_profile → redirect to dashboard.
E) Users can read only their own private data; dashboards load SSR without leaking tokens.
F) /api/health/db returns OK and verifies DB + RLS sanity.
G) Squash migrations (we are pre-launch), then reset DB.

CONSTRAINTS
- Next.js 15, App Router; SSR supported where noted.
- Use @clerk/nextjs and @supabase/supabase-js current APIs.
- For client calls, inject Clerk session via `accessToken()`; for server calls use `auth().getToken()`.
- No JWT templates; do not depend on Supabase JWT secret in Clerk. (Ref: Clerk native Supabase integration & JWT template deprecation.)
- Minimal surface area; prefer server actions/route handlers. Webhooks used only for background sync, not required for the critical path.

DELIVERABLES
Make atomic commits per numbered step with brief commit messages. Add a top-level `docs/integration-checklist.md` summarizing what you changed and how to verify.

STEPS

1) DETECT & PURGE LEGACY JWT TEMPLATE USAGE
- Grep the repo for: `jwt`, `clerk-jwt`, `CLERK_JWT_TEMPLATE`, `supabaseJwt`, `supabase_jwt_secret`, `createMiddlewareSupabaseClient`, `auth.uid()` used with Clerk.
- Remove any code/ENV that references Clerk JWT templates or Supabase JWT secret in Clerk. Replace with native provider flow.
- Ensure `.env` has:
  - `NEXT_PUBLIC_SUPABASE_URL=...`
  - `NEXT_PUBLIC_SUPABASE_KEY=...` (anon)
  - `CLERK_PUBLISHABLE_KEY=...`
  - `CLERK_SECRET_KEY=...`
- Confirm Supabase auth provider “Clerk” is used & the Clerk Domain is set (leave instruction notes in the checklist).

2) UNIFIED SUPABASE CLIENT HELPERS
- Create `lib/supabase/client.ts` (client-side):
  ```ts
  'use client';
  import { createClient } from '@supabase/supabase-js';
  import { useSession } from '@clerk/nextjs';

  export function useClerkSupabase() {
    const { session } = useSession();
    const client = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_KEY!,
      { accessToken: async () => (await session?.getToken()) ?? null }
    );
    return client;
  }
  ```
- Create `lib/supabase/server.ts` (server-side):
  ```ts
  import { auth } from '@clerk/nextjs/server';
  import { createClient } from '@supabase/supabase-js';

  export function createServerSupabase() {
    return createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_KEY!,
      { accessToken: async () => (await auth()).getToken() }
    );
  }
  ```
- Replace ad-hoc clients across app with these helpers.

3) DATABASE SCHEMA & RLS (SQL MIGRATION)
- Create migration `xxxx_clerk_rls.sql` that:
  ```sql
  -- USERS TABLE (app domain)
  create table if not exists app_users (
    id text primary key,              -- Clerk user id (sub)
    email text,
    created_at timestamptz default now()
  );
  alter table app_users enable row level security;

  -- ARTIST PROFILES
  create table if not exists artist_profiles (
    id uuid primary key default gen_random_uuid(),
    user_id text not null references app_users(id) on delete cascade,
    username text unique not null,
    display_name text,
    bio text,
    avatar_url text,
    is_public boolean not null default true,
    created_at timestamptz default now()
  );
  alter table artist_profiles enable row level security;

  -- RLS: app_users (owner-only read/write)
  create policy "users_owner_select"
    on app_users for select to authenticated
    using (id = auth.jwt()->>'sub');

  create policy "users_owner_upsert"
    on app_users for insert to authenticated
    with check (id = auth.jwt()->>'sub');

  create policy "users_owner_update"
    on app_users for update to authenticated
    using (id = auth.jwt()->>'sub')
    with check (id = auth.jwt()->>'sub');

  -- RLS: artist_profiles
  -- Public read when is_public = true
  create policy "artist_public_read"
    on artist_profiles for select to anon
    using (is_public = true);

  create policy "artist_auth_read_public_or_self"
    on artist_profiles for select to authenticated
    using (is_public = true OR user_id = auth.jwt()->>'sub');

  -- Only owners can insert/update/delete their profile
  create policy "artist_insert_owner"
    on artist_profiles for insert to authenticated
    with check (user_id = auth.jwt()->>'sub');

  create policy "artist_update_owner"
    on artist_profiles for update to authenticated
    using (user_id = auth.jwt()->>'sub')
    with check (user_id = auth.jwt()->>'sub');

  create policy "artist_delete_owner"
    on artist_profiles for delete to authenticated
    using (user_id = auth.jwt()->>'sub');

  -- Helpful index
  create index if not exists artist_profiles_username_idx on artist_profiles(lower(username));
  ```

  Notes:
  - Use `auth.jwt()->>'sub'` (string Clerk IDs) — don’t use `auth.uid()` (UUID) with Clerk.
  - Enable Realtime later if needed; ensure channels respect RLS.

4) SIGNUP → USER & ARTIST PROFILE CREATION
- On post-signup username step (server action or route handler under `/app/(auth)/onboarding`):
  ```ts
  'use server';
  import { auth, currentUser } from '@clerk/nextjs/server';
  import { createServerSupabase } from '@/lib/supabase/server';

  export async function completeOnboarding({ username, displayName }: { username: string; displayName?: string }) {
    const { userId } = await auth();
    if (!userId) throw new Error('Not authenticated');

    const supabase = createServerSupabase();

    // Upsert app_users
    const user = await currentUser();
    await supabase.from('app_users').upsert({
      id: userId,
      email: user?.emailAddresses?.[0]?.emailAddress ?? null
    });

    // Insert artist profile if not exists
    const { data: existing } = await supabase
      .from('artist_profiles')
      .select('id').eq('user_id', userId).limit(1).maybeSingle();

    if (!existing) {
      const { error } = await supabase.from('artist_profiles').insert({
        user_id: userId,
        username,
        display_name: displayName ?? username
      });
      if (error) throw error;
    }
  }
  ```
- After success, route to `/dashboard` where SSR fetch uses `createServerSupabase()` and verifies rows resolve under RLS.

(Optionally, add a Clerk `user.created` webhook to upsert `app_users` in the background using a Supabase **service role** key and `verifyWebhook` with Svix; not required on the critical path. If you add it, put the handler at `/api/webhooks/clerk` and store the signing secret in env; verify using Clerk’s `verifyWebhook()`.)

5) PUBLIC ARTIST PAGES
- Public route `app/[username]/page.tsx`:
  - Fetch by username via a **server** Supabase anon client (`NEXT_PUBLIC_*` creds without token) OR reuse `createServerSupabase()` with no session.
  - Query only `artist_profiles` columns needed for public display.
  - Expect it to work both locally and deployed thanks to `artist_public_read` policy.

6) HEALTH CHECK
- Implement `app/api/health/db/route.ts`:
  ```ts
  import { NextResponse } from 'next/server';
  import { createClient } from '@supabase/supabase-js';

  export const dynamic = 'force-dynamic';

  export async function GET() {
    try {
      const supabase = createClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.NEXT_PUBLIC_SUPABASE_KEY!
      );
      // Lightweight query hitting a public path (no token)
      const { error } = await supabase.from('artist_profiles').select('id').limit(1);
      if (error) throw error;
      return NextResponse.json({ ok: true });
    } catch (e: any) {
      return NextResponse.json({ ok: false, error: e.message }, { status: 500 });
    }
  }
  ```
- Add a second internal check (protected dev-only route) that uses `createServerSupabase()` with session to validate `auth.jwt()->>'sub'` path by selecting the current user’s profile.

7) MIGRATIONS SQUASH & DB RESET (PRE-LAUNCH ONLY)
- Create a fresh “baseline” migration containing the final schema & RLS above; delete older app migrations.
- Run `supabase db reset` (or your migration runner’s reset) locally and on staging.
- Re-seed minimal dev data:
  - 2 public artist profiles detached from any user (is_public=true)
  - 1 test Clerk user with attached profile.
- Verify:
  - Anonymous GET of `/[username]` returns profile data.
  - Signed-in user can read/update only their own profile.
  - Cross-account reads/updates are denied.

8) TESTS / ACCEPTANCE
- Add Playwright tests:
  - Anonymous visit to a public artist page → 200 & expected fields.
  - Anonymous visit to non-public profile → 404/blocked render.
  - After signup + onboarding, dashboard shows the user’s profile (SSR page fetch via `createServerSupabase()`).
- Add a quick SQL check script under `scripts/verify-rls.sql`:
  - `select current_setting('request.jwt.claims', true)` present.
  - Prove `auth.jwt()->>'sub'` gates `artist_profiles`.

9) CLEANUP & LINT
- Remove dead ENV keys & references to JWT templates.
- Add comments in code pointing to `auth.jwt()->>'sub'` usage rationale.

REFERENCES (leave as inline comments in modified files)
- Clerk ↔ Supabase integration & RLS examples; JWT template deprecation (Aug 2025 update).
- Use `auth.jwt()->>'sub'` with Clerk IDs (string), not `auth.uid()` (UUID).
- Clerk webhooks & `verifyWebhook()` if you enable background sync.

OUTPUTS
- Working code, migrations, seeds, tests, and `docs/integration-checklist.md` listing manual dashboard settings (Clerk Domain in Supabase provider) and how to verify /api/health/db.
```

Key refs if you need to glance while coding: Clerk’s Supabase guide (incl. **JWT template deprecation** and `auth.jwt()->>'sub'` patterns) and webhooks docs. citeturn1view0turn1view1  
If you add webhooks, verify with `verifyWebhook()` (and mind recent advisory fixes) and/or ngrok for local testing. citeturn2search1turn2search4turn2search7  
For RLS details and custom claims logic, use Supabase docs. citeturn2search8turn2search19

If you want me to tailor the SQL and onboarding code to your exact table/column names, paste a snippet of your current schema and I’ll inline it.

---

## User

Okay now give me the stripe intergration prompt

---

## Assistant

Mr. White — here’s a single, drop-in **Claude Code prompt** to implement **Stripe Billing** end-to-end (Next.js 15, App Router) with **Supabase** sync, **PostHog** plan flags, SSR-safe routes, webhooks, a clean pricing→checkout→portal flow, and a migration squash/reset.

> Copy everything between the lines and paste into Claude Code.

```
You are a senior full-stack engineer. Task: replace Clerk Billing with **Stripe Billing** in a Next.js 15 (App Router) app, wired into Supabase + PostHog. Keep SSR safe. Use **Stripe Checkout** for new subs and **Stripe Customer Portal** for management. No client-secret exposure. Make atomic commits per step with brief messages and a `docs/billing-checklist.md`.

GOALS
1) Plans: Free, Pro Monthly, Pro Annual (renameable). Stripe is source of truth for pricing; Supabase mirrors status.
2) Pricing page: SSR product display → “Subscribe” buttons → server-created Checkout Session.
3) On completion, store `stripe_customer_id`, subscription `status`, `plan_key`, `current_period_end` in Supabase.
4) PostHog: identify users and set `plan` property + flip feature flags by plan.
5) Webhooks: handle `checkout.session.completed`, `customer.subscription.created|updated|deleted`, `invoice.payment_failed`.
6) Customer Portal: server route creates a Portal session.
7) Health: `/api/health/billing` verifies env + Stripe connectivity.
8) Pre-launch: squash migrations + `db reset` after schema change.

CONSTRAINTS
- Next.js 15 App Router; TypeScript.
- Use `stripe` Node SDK on server only.
- Use `@clerk/nextjs` for auth; Supabase for app DB; PostHog for analytics/flags.
- No client-side calls to Stripe; no long-lived secrets in the browser.
- Keep SSR for public pages; dashboards can be dynamic.

ENV (add to `.env.local`)
- STRIPE_SECRET_KEY=...
- STRIPE_WEBHOOK_SECRET=...    # from Dashboard → Developers → Webhooks
- STRIPE_PRICE_PRO_MONTHLY=... # price_xxx ids
- STRIPE_PRICE_PRO_ANNUAL=...
- STRIPE_CUSTOMER_PORTAL_RETURN_URL=https://<domain>/dashboard
- NEXT_PUBLIC_POSTHOG_KEY=...
- NEXT_PUBLIC_POSTHOG_HOST=https://us.i.posthog.com  # or your instance
- NEXT_PUBLIC_SUPABASE_URL=...
- NEXT_PUBLIC_SUPABASE_KEY=...
- CLERK_PUBLISHABLE_KEY=...
- CLERK_SECRET_KEY=...

STEP 1 — Stripe objects (one-time setup)
- Ensure the following exist in Stripe Dashboard (or create via API):
  - Product: “Pro”
  - Prices: Monthly recurring and Annual recurring
- Record their `price_` ids into env above.

STEP 2 — Supabase schema & RLS (migration)
Create a single migration `xxxx_billing.sql`:
```sql
-- Users table must already exist: app_users(id text primary key, ...)

create table if not exists user_billing (
  user_id text primary key references app_users(id) on delete cascade,
  stripe_customer_id text unique,
  plan_key text not null default 'free',            -- 'free' | 'pro_monthly' | 'pro_annual'
  status text not null default 'inactive',          -- 'active'|'trialing'|'past_due'|'canceled'|'incomplete'...
  current_period_end timestamptz,
  updated_at timestamptz not null default now()
);

alter table user_billing enable row level security;

-- RLS: owners can read their own billing row
create policy "billing_select_self"
  on user_billing for select to authenticated
  using (user_id = auth.jwt()->>'sub');

-- Owners cannot write; only service role (webhook) updates.
create policy "billing_no_client_write"
  on user_billing for all to authenticated
  using (false) with check (false);
```

STEP 3 — Stripe server util
Create `lib/stripe.ts`:
```ts
import Stripe from 'stripe';
export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2024-06-20' });
```

STEP 4 — Supabase server helper (reuse existing if present)
```ts
// lib/supabase/server.ts (ensure present)
import { auth } from '@clerk/nextjs/server';
import { createClient } from '@supabase/supabase-js';
export function createServerSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_KEY!,
    { accessToken: async () => (await auth()).getToken() }
  );
}
```

STEP 5 — Create/ensure billing row on login
Add a small server action called from your auth/layout (no blocking UI):
```ts
// app/(app)/_actions/ensureBilling.ts
'use server';
import { auth } from '@clerk/nextjs/server';
import { createServerSupabase } from '@/lib/supabase/server';

export async function ensureBillingRow() {
  const { userId } = await auth();
  if (!userId) return;
  const supabase = createServerSupabase();
  const { data } = await supabase.from('user_billing').select('user_id').eq('user_id', userId).maybeSingle();
  if (!data) {
    await supabase.from('user_billing').insert({ user_id: userId, plan_key: 'free', status: 'inactive' });
  }
}
```

STEP 6 — Pricing (SSR) and Checkout route
- Build an SSR pricing page that reads env to show plans; buttons POST to `/api/stripe/checkout`.

`app/api/stripe/checkout/route.ts`:
```ts
import { NextResponse } from 'next/server';
import { stripe } from '@/lib/stripe';
import { auth, currentUser } from '@clerk/nextjs/server';
import { createServerSupabase } from '@/lib/supabase/server';

export async function POST(req: Request) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { priceId, successPath='/dashboard', cancelPath='/pricing' } = await req.json();
  if (!priceId) return NextResponse.json({ error: 'Missing priceId' }, { status: 400 });

  const supabase = createServerSupabase();
  const { data: billing } = await supabase.from('user_billing')
    .select('stripe_customer_id').eq('user_id', userId).maybeSingle();

  // Ensure a Stripe customer
  let customerId = billing?.stripe_customer_id;
  if (!customerId) {
    const user = await currentUser();
    const customer = await stripe.customers.create({
      metadata: { user_id: userId },
      email: user?.emailAddresses?.[0]?.emailAddress,
      name: user?.fullName ?? undefined,
    });
    customerId = customer.id;
    await supabase.from('user_billing').upsert({ user_id: userId, stripe_customer_id: customerId });
  }

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer: customerId,
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${new URL(successPath, req.url).origin}${successPath}?checkout=success`,
    cancel_url: `${new URL(cancelPath, req.url).origin}${cancelPath}?checkout=cancel`,
    allow_promotion_codes: true,
  });

  return NextResponse.json({ url: session.url }, { status: 200 });
}
```

STEP 7 — Customer Portal route
`app/api/stripe/portal/route.ts`:
```ts
import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { stripe } from '@/lib/stripe';
import { createServerSupabase } from '@/lib/supabase/server';

export async function POST(req: Request) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const supabase = createServerSupabase();
  const { data: billing, error } = await supabase.from('user_billing')
    .select('stripe_customer_id').eq('user_id', userId).maybeSingle();
  if (error || !billing?.stripe_customer_id) return NextResponse.json({ error: 'No customer' }, { status: 400 });

  const session = await stripe.billingPortal.sessions.create({
    customer: billing.stripe_customer_id,
    return_url: process.env.STRIPE_CUSTOMER_PORTAL_RETURN_URL!,
  });
  return NextResponse.json({ url: session.url });
}
```

STEP 8 — Webhook (service-role update to Supabase)
- Create `app/api/stripe/webhook/route.ts`. Use raw body; do **not** read via `req.json()`.
- In `next.config.js` set `api: { bodyParser: false }` for this route using App Router convention with `config = { api: { bodyParser: false }}` export.

`app/api/stripe/webhook/route.ts`:
```ts
import { headers } from 'next/headers';
import { NextResponse } from 'next/server';
import { stripe } from '@/lib/stripe';
import { createClient } from '@supabase/supabase-js';

export const config = { api: { bodyParser: false } };

async function getRawBody(req: Request) {
  const buf = await req.arrayBuffer();
  return Buffer.from(buf);
}

export async function POST(req: Request) {
  const sig = (await headers()).get('stripe-signature');
  const body = await getRawBody(req);
  let event;

  try {
    event = stripe.webhooks.constructEvent(body, sig!, process.env.STRIPE_WEBHOOK_SECRET!);
  } catch (err: any) {
    return NextResponse.json({ error: `Webhook Error: ${err.message}` }, { status: 400 });
  }

  // Use Supabase service role for privileged writes (store it as SUPABASE_SERVICE_ROLE_KEY)
  const supabaseAdmin = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  const handleSubChange = async (sub: any) => {
    const customerId = sub.customer as string;
    const planKey =
      sub.items?.data?.[0]?.price?.id === process.env.STRIPE_PRICE_PRO_ANNUAL ? 'pro_annual' :
      sub.items?.data?.[0]?.price?.id === process.env.STRIPE_PRICE_PRO_MONTHLY ? 'pro_monthly' :
      'unknown';

    const status = sub.status as string;
    const currentPeriodEnd = new Date(sub.current_period_end * 1000).toISOString();

    // Find user by customer id
    const { data: row } = await supabaseAdmin.from('user_billing')
      .select('user_id').eq('stripe_customer_id', customerId).maybeSingle();
    if (!row?.user_id) return;

    await supabaseAdmin.from('user_billing').upsert({
      user_id: row.user_id,
      stripe_customer_id: customerId,
      plan_key: status === 'active' || status === 'trialing' ? planKey : 'free',
      status,
      current_period_end: currentPeriodEnd
    });
  };

  switch (event.type) {
    case 'checkout.session.completed': {
      // Nothing to do here; subscription events will follow.
      break;
    }
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      await handleSubChange((event as any).data.object);
      break;
    }
    case 'invoice.payment_failed': {
      // optional: mark status/past_due
      await handleSubChange((event as any).data.object.subscription);
      break;
    }
    default:
      break;
  }

  return NextResponse.json({ received: true });
}
```

STEP 9 — PostHog identify + flags
- On authenticated layouts/pages, after `ensureBillingRow()`, fetch `user_billing.plan_key` server-side and pass to client.
- Client boot (only once per session):
```ts
// app/providers/PostHogProvider.tsx
'use client';
import posthog from 'posthog-js';
import { useEffect } from 'react';
import { useUser } from '@clerk/nextjs';

export default function PHProvider({ plan }: { plan?: string }) {
  const { user } = useUser();
  useEffect(() => {
    if (!process.env.NEXT_PUBLIC_POSTHOG_KEY) return;
    posthog.init(process.env.NEXT_PUBLIC_POSTHOG_KEY!, { api_host: process.env.NEXT_PUBLIC_POSTHOG_HOST });
    if (user?.id) {
      posthog.identify(user.id, { email: user.primaryEmailAddress?.emailAddress, plan });
    }
  }, [user?.id, plan]);
  return null;
}
```
- Gate features via PostHog’s feature flags (“pro_features”) + `plan` property. Keep simple boolean checks in code to avoid hard dependency on PostHog for critical paths.

STEP 10 — UI hooks
- Pricing page “Upgrade” buttons:
```ts
async function startCheckout(priceId: string) {
  const r = await fetch('/api/stripe/checkout', { method: 'POST', body: JSON.stringify({ priceId }) });
  const { url } = await r.json();
  window.location.href = url;
}
```
- “Manage billing” in Settings:
```ts
async function openPortal() {
  const r = await fetch('/api/stripe/portal', { method: 'POST' });
  const { url } = await r.json();
  window.location.href = url;
}
```

STEP 11 — Health check
`app/api/health/billing/route.ts`:
```ts
import { NextResponse } from 'next/server';
import { stripe } from '@/lib/stripe';

export async function GET() {
  try {
    // Ping Stripe with a lightweight call
    await stripe.products.list({ limit: 1 });
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e.message }, { status: 500 });
  }
}
```

STEP 12 — Tests
- Playwright: pricing page renders; clicking “Upgrade” hits `/api/stripe/checkout` (mocked) and returns URL.
- Webhook unit tests: validate signature construction with a fixture payload; ensure Supabase updates.

STEP 13 — Migrations squash + reset (pre-launch)
- Squash app migrations (including `xxxx_billing.sql`) into one baseline.
- Run local: `supabase db reset && supabase db seed` (add 1 free user row, 1 pro row).
- Verify flows:
  - Anonymous pricing loads (SSR).
  - Auth user → Checkout → webhook → plan becomes `pro_*` and dashboard shows Pro.
  - Customer Portal opens and returns.

DELIVERABLES
- Working pricing → checkout → webhook sync → portal loop.
- `docs/billing-checklist.md` with:
  - Exact env names and where to find values.
  - Stripe Dashboard objects created and price ids recorded.
  - Webhook endpoint path and signing secret.
  - How to test in Stripe test mode (test cards).
  - RLS rationale (service-role only writes billing).

NOTES
- Keep all Stripe calls server-side.
- Prefer idempotent upserts keyed by `user_id`.
- Treat Stripe as authoritative for billing state; mirror into Supabase for fast checks and flags.
```

If you want me to prefill the `price_` IDs and wire this into your existing routes/components, paste your current file paths and I’ll tailor the prompt to your tree.


**Topic:** [[chatgpt-clusters/coding_devops]]
