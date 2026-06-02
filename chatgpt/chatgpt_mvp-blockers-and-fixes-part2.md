
Short answer: **yes, add health checks**—but **scope them right** so they’re useful, not flaky.

## What to check (and where)
- **In CI (pre-deploy PR builds):**
  - ✅ `/api/health/app` (no externals): returns 200 + commit SHA. Fast, deterministic.
- **Post-deploy smoke (on preview/staging after Vercel deploy):**
  - ✅ `/api/health/db` (tiny `select 1` with RLS on)  
  - ✅ `/api/health/billing` (Stripe ping or list 1 product w/ cached key)
  - (Optional) `/api/health/flags` (PostHog server API or our cached server flag fetch)

> Don’t run DB/Stripe checks in unit test phase; run them **only** as a short smoke job after the app is live. That avoids local/CI flake.

## Minimal endpoints (Next.js)
```ts
// /app/api/health/app/route.ts
import { NextResponse } from 'next/server';
export function GET() {
  return NextResponse.json({
    ok: true,
    env: process.env.VERCEL_ENV ?? 'local',
    commit: process.env.VERCEL_GIT_COMMIT_SHA ?? 'local'
  });
}
```

```ts
// /app/api/health/db/route.ts (Node runtime)
import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
export const runtime = 'node';
export async function GET() {
  const supa = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  const { error } = await supa.from('_heartbeat').select('id').limit(1); // or rpc('select_1')
  if (error) return NextResponse.json({ ok:false, error: error.message }, { status: 500 });
  return NextResponse.json({ ok:true });
}
```

```ts
// /app/api/health/billing/route.ts
import Stripe from 'stripe';
import { NextResponse } from 'next/server';
export const runtime = 'node';
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
export async function GET() {
  try {
    // Cheap, cacheable metadata call
    await stripe.products.list({ limit: 1 });
    return NextResponse.json({ ok: true });
  } catch (e:any) {
    return NextResponse.json({ ok:false, error: e.message }, { status: 500 });
  }
}
```

## Post-deploy smoke script (runs on preview/staging)
```ts
// scripts/smoke.ts
import assert from 'node:assert';
const base = process.env.APP_URL!;
const endpoints = ['/api/health/app','/api/health/db','/api/health/billing'];

async function check(path:string) {
  const url = base + path;
  const deadline = Date.now() + 60_000; // 60s budget
  let attempt = 0, lastErr:any;
  while (Date.now() < deadline) {
    attempt++;
    try {
      const r = await fetch(url, { cache: 'no-store' });
      const j = await r.json();
      if (r.ok && j.ok) return;
      lastErr = new Error(`${path} -> ${r.status} ${JSON.stringify(j)}`);
    } catch (e) { lastErr = e; }
    await new Promise(r => setTimeout(r, Math.min(5000, 200 * attempt))); // backoff
  }
  throw lastErr ?? new Error(`${path} failed`);
}

(async () => {
  for (const e of endpoints) await check(e);
  console.log('smoke: OK');
})().catch(e => { console.error(e); process.exit(1); });
```

## GitHub Actions (post-deploy only)
```yaml
name: Smoke
on:
  deployment_status:
jobs:
  smoke:
    if: github.event.deployment_status.state == 'success'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npm ci
      - run: node scripts/smoke.ts
        env:
          APP_URL: ${{ github.event.deployment_status.environment_url }}
```

## Acceptance policy (keep it sane)
- **Fail PR** if `/api/health/app` breaks.  
- **Fail deployment** (rollback/alert) if smoke fails on preview/staging.  
- **Production**: same smoke check + external uptime (e.g., Pingdom/UptimeRobot) hitting `/api/health/app` every 1 min.

## Why this works
- Catches config breakage (DB keys, CORS, RLS), Stripe outages/keys, and accidental regressions.
- Avoids CI flakiness by **separating** local unit tests from **environmental** health checks.
- Gives a tight signal: if smoke fails, we know exactly which subsystem is down from the endpoint.

Bottom line: **Do it.** Add the app/db/billing health checks, but run DB/Stripe checks only as **post-deploy smoke** with a short retry window. It’s low noise, high value.


Okay, we've removed Clark Billing entirely, and we're working on the database issues in Windsurf. I'm going to have Copilot work on adding Stripe Billing. So, what I need is a prompt to break down the installation of Stripe Billing for Copilot. So, I need to ensure that we follow a couple things here. One, everything we do is compatible with Next.js 15, which is what we're using, so we can't break anything. Everything we have to do has to work with Next.js 15. Two, we want to ensure that nothing we do is going to prevent server-side rendering in the future. Although I mostly care about server-side rendering outside of the auth scope, so things on the dashboard and stuff are not a big deal, but things like removing branding from public profiles cannot break server-side rendering. Also, we're using Clark for authentication, and so everything we do has to be compatible with Clark. And then finally, we're using Superbase, so everything has to be compatible with Superbase, and we're using Superbase's third-party auth integration to integrate with Clark, not the old JWT templates, which are depreciated. And so we need to respect all of that. Next, all we're looking for in this, don't worry about pricing tables. All we're looking for in this is adding the ability for a person to upgrade their account within the dashboard. And then go to Stripe checkout, pay, update that user once they've paid to make sure that they're now a pro user in the system. Add a billing portal for them, and we can use a completely Stripe-hosted billing portal. We should do the minimal amount of stuff to get this working. And then the branding on their public profile should turn off. And they should see a pro badge somewhere in their account dashboard. Obviously, follow my Combinator best practices, ship fast, don't break things, and do the minimal implementation we can and lean on Stripe for as much as possible. Integrate with their current stack properly and do things as efficiently as possible.


Got it, Mr. White. Here’s a **single Copilot prompt** you can paste to build Stripe Billing the minimal, correct way for our stack.

---

# Copilot: Implement Stripe Billing (Next.js 15 + Clerk + Supabase)

**Related:** [[coding_troubleshoot]]

**Context / constraints**
- Framework: **Next.js 15 (App Router)**. Do **not** break SSR for public profile pages.
- Auth: **Clerk** via `@clerk/nextjs`. Use **server** auth APIs in server code.
- DB: **Supabase** with **Third-Party Auth (Clerk)** (not JWT templates).
- Minimal scope: **Upgrade to Pro via Stripe Checkout**, **Stripe Customer Portal**, **webhook** to flip `branding_removed` + `plan`, and **Pro badge** in dashboard.
- Guardrails: no `any`, use `next/link` & `next/image`, keep billing webhook on **Node runtime** (not Edge), and keep all secrets server-only.

---

## 0) ENV (add to `.env.local`, staging, prod)
```
APP_URL=https://staging.example.com
STRIPE_PUBLIC_KEY=pk_test_...
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
PRICE_ID_PRO_MONTH=price_...
```

---

## 1) DB migration (Supabase)
Create/append a migration:

```sql
-- profiles table must already exist with primary key id = auth.users.id
alter table public.profiles
  add column if not exists stripe_customer_id text,
  add column if not exists plan text not null default 'free',
  add column if not exists branding_removed boolean not null default false;

create table if not exists public.subscriptions (
  user_id uuid primary key references auth.users(id) on delete cascade,
  stripe_subscription_id text unique,
  status text,
  current_period_end timestamptz,
  price_id text
);

-- RLS: profile owner can update their own row; webhook (service role) can update any
alter table public.profiles enable row level security;
create policy "owner can update self profile"
  on public.profiles for update
  using (auth.uid() = id)
  with check (auth.uid() = id);

alter table public.subscriptions enable row level security;
create policy "owner can read/write own sub"
  on public.subscriptions for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
```

---

## 2) Stripe SDK (server-only helper)
Create `src/lib/stripe.ts`:

```ts
// src/lib/stripe.ts
import Stripe from 'stripe';

export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2024-06-20', // or latest supported
});
```

---

## 3) Supabase server clients
Create helpers:

```ts
// src/lib/supabaseServer.ts
import { cookies } from 'next/headers';
import { createServerClient } from '@supabase/ssr';

export function supabaseServer() {
  const cookieStore = cookies();
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        get: (key) => cookieStore.get(key)?.value,
      },
    }
  );
}

// Admin-only (webhook): NEVER import in client components
// Uses service role key; file must only be imported by server route/edge-disabled code.
export function supabaseAdmin() {
  // @ts-expect-error server-only
  return new (require('@supabase/supabase-js').createClient)(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );
}
```

---

## 4) Server actions for upgrade & portal
Create `src/app/(dashboard)/billing/actions.ts`:

```ts
'use server';

import { auth } from '@clerk/nextjs/server';
import { stripe } from '@/lib/stripe';
import { supabaseServer } from '@/lib/supabaseServer';

export async function createCheckoutSession(priceId: string) {
  const { userId } = auth();
  if (!userId) throw new Error('Unauthorized');

  const supa = supabaseServer();
  const { data: profile, error } = await supa
    .from('profiles')
    .select('stripe_customer_id')
    .eq('id', userId)
    .single();
  if (error) throw error;

  let customerId = profile?.stripe_customer_id ?? null;
  if (!customerId) {
    const customer = await stripe.customers.create({ metadata: { userId } });
    customerId = customer.id;
    const { error: upErr } = await supa
      .from('profiles')
      .update({ stripe_customer_id: customerId })
      .eq('id', userId);
    if (upErr) throw upErr;
  }

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer: customerId,
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${process.env.APP_URL}/dashboard/billing?success=1`,
    cancel_url: `${process.env.APP_URL}/dashboard/billing?canceled=1`,
    allow_promotion_codes: true,
  });

  return session.url!;
}

export async function createPortalSession() {
  const { userId } = auth();
  if (!userId) throw new Error('Unauthorized');

  const supa = supabaseServer();
  const { data: profile, error } = await supa
    .from('profiles')
    .select('stripe_customer_id')
    .eq('id', userId)
    .single();
  if (error || !profile?.stripe_customer_id) throw new Error('No customer');

  const portal = await stripe.billingPortal.sessions.create({
    customer: profile.stripe_customer_id,
    return_url: `${process.env.APP_URL}/dashboard/billing`,
  });

  return portal.url;
}
```

---

## 5) Dashboard billing page (client UI calling server actions)
Create `src/app/(dashboard)/billing/page.tsx`:

```tsx
'use client';

import { useTransition } from 'react';
import { createCheckoutSession, createPortalSession } from './actions';

export default function BillingPage() {
  const [pending, start] = useTransition();

  return (
    <div className="max-w-xl space-y-4">
      <h1 className="text-2xl font-semibold">Billing</h1>
      <div className="rounded-2xl border p-4">
        <p className="mb-3">Upgrade to Pro to remove branding.</p>
        <button
          className="rounded-xl px-4 py-2 bg-black text-white disabled:opacity-50"
          disabled={pending}
          onClick={() =>
            start(async () => {
              const url = await createCheckoutSession(process.env.NEXT_PUBLIC_PRICE_ID_PRO_MONTH!);
              window.location.href = url;
            })
          }
        >
          {pending ? 'Redirecting…' : 'Upgrade — Monthly'}
        </button>
      </div>

      <div className="rounded-2xl border p-4">
        <p className="mb-3">Manage your subscription.</p>
        <button
          className="rounded-xl px-4 py-2 border"
          onClick={() =>
            start(async () => {
              const url = await createPortalSession();
              window.location.href = url;
            })
          }
        >
          Open Customer Portal
        </button>
      </div>
    </div>
  );
}
```

> Add `NEXT_PUBLIC_PRICE_ID_PRO_MONTH` to env (public ok).

---

## 6) Stripe webhook (sync truth → DB)
Create `src/app/api/stripe/webhook/route.ts`:

```ts
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { stripe } from '@/lib/stripe';
import { supabaseAdmin } from '@/lib/supabaseServer';

export const runtime = 'nodejs'; // ensure Node, not Edge

export async function POST(req: NextRequest) {
  const sig = req.headers.get('stripe-signature');
  if (!sig) return NextResponse.json({ error: 'No signature' }, { status: 400 });

  const raw = await req.text();
  let event;
  try {
    event = stripe.webhooks.constructEvent(raw, sig, process.env.STRIPE_WEBHOOK_SECRET!);
  } catch (e: any) {
    return NextResponse.json({ error: `Invalid signature: ${e.message}` }, { status: 400 });
  }

  const supa = supabaseAdmin();

  const upsertSub = async ({
    userId,
    subId,
    status,
    currentPeriodEnd,
    priceId,
  }: {
    userId: string;
    subId: string;
    status: string;
    currentPeriodEnd: number;
    priceId?: string | null;
  }) => {
    await supa.from('subscriptions').upsert({
      user_id: userId,
      stripe_subscription_id: subId,
      status,
      current_period_end: new Date(currentPeriodEnd * 1000).toISOString(),
      price_id: priceId ?? null,
    });
  };

  const setPlan = async (userId: string, active: boolean) => {
    await supa.from('profiles').update({
      plan: active ? 'pro' : 'free',
      branding_removed: active,
    }).eq('id', userId);
  };

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const s = event.data.object as any;
        const subId = s.subscription as string;
        const customerId = s.customer as string;
        const sub = await stripe.subscriptions.retrieve(subId);
        // map customer -> profile (stored earlier)
        const { data: prof } = await supa
          .from('profiles')
          .select('id')
          .eq('stripe_customer_id', customerId)
          .single();
        const userId: string | undefined = prof?.id ?? sub.metadata?.userId;
        if (!userId) break;

        await setPlan(userId, true);
        await upsertSub({
          userId,
          subId: sub.id,
          status: sub.status,
          currentPeriodEnd: sub.current_period_end!,
          priceId: sub.items.data[0]?.price.id,
        });
        break;
      }
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted': {
        const sub = event.data.object as any;
        const customerId = sub.customer as string;
        const { data: prof } = await supa
          .from('profiles')
          .select('id')
          .eq('stripe_customer_id', customerId)
          .single();
        const userId: string | undefined = prof?.id ?? sub.metadata?.userId;
        if (!userId) break;

        const active = ['active', 'trialing', 'past_due'].includes(sub.status);
        await setPlan(userId, active);
        await upsertSub({
          userId,
          subId: sub.id,
          status: sub.status,
          currentPeriodEnd: sub.current_period_end!,
          priceId: sub.items.data[0]?.price.id,
        });
        break;
      }
    }
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }

  return NextResponse.json({ received: true });
}

// Tell Next to read raw body for signature:
export const config = { api: { bodyParser: false } }; // Next 15 keeps this via route handler settings
```

> In Vercel, add the webhook endpoint and set the **signing secret**.

---

## 7) Public profile SSR → hide branding when Pro
In `src/app/[handle]/page.tsx` (server component), fetch profile and gate branding:

```tsx
import { supabaseServer } from '@/lib/supabaseServer';

export default async function PublicProfilePage({ params }: { params: { handle: string } }) {
  const supa = supabaseServer();
  const { data: profile } = await supa
    .from('artist_profiles')
    .select('handle, display_name, owner_id:owner(id, profiles(branding_removed))')
    .eq('handle', params.handle)
    .single();

  const brandingOff = Boolean(profile?.owner_id?.profiles?.branding_removed);

  return (
    <div>
      {/* …profile UI… */}
      {!brandingOff && (
        <div className="mt-6 text-xs opacity-70">
          Powered by Jovie
        </div>
      )}
    </div>
  );
}
```

*(Adjust joins to your schema; key point: **SSR fetch** and gate on `branding_removed`.)*

---

## 8) Pro badge in dashboard (server or client)
In the dashboard layout or header, fetch the user’s profile and render a badge if `plan === 'pro'`.

```tsx
// server component header snippet
const { data: me } = await supa
  .from('profiles')
  .select('plan')
  .eq('id', userId)
  .single();

{me?.plan === 'pro' && (
  <span className="ml-2 rounded-full border px-2 py-0.5 text-xs">Pro</span>
)}
```

---

## 9) Tests (minimal smoke)
- After deploy to preview: hit `/dashboard/billing`, click Upgrade, complete Stripe test card (**4242…**), return → dashboard shows **Pro** badge; visiting public `/:handle` shows **no branding**.
- Webhook retries must be idempotent (UPSERT subscription).

---

## 10) Gotchas / rules
- **Do not** render webhook route on Edge. Keep `runtime = 'nodejs'`.
- **Do not** import admin client outside server routes.
- Use **relative** app routes; only Stripe needs absolute `success_url`/`cancel_url` using `APP_URL`.
- Keep **TypeScript strict**; no `any`.
- Internal nav uses `<Link>`; images use `<Image>`.

---

**Acceptance Criteria**
- User can upgrade via Checkout; webhook flips `plan='pro'` + `branding_removed=true`.
- Public profile SSR hides branding immediately after webhook.
- Customer Portal opens and allows cancel/update; cancellation flips plan back to `free`.
- No SSR breakage on public pages; no client-only secrets exposed.

--- 

Use this prompt to generate/edit only the listed files, keep changes minimal, and pass typecheck/lint.


We should take advantage of potshog as well to ensure feature flags and everything are compatible and users are tagged by their plan and that we dont create unnecessary or redundant code


Got it, Mr. White. Here’s the lean way to wire **PostHog** so flags + analytics stay in lockstep with Stripe plans, with zero duplicate code and no SSR breakage.

# Principles
- **Single source of truth:** `profiles.plan` & `branding_removed` in Supabase.
- **One analytics surface:** import **only** from `@/lib/analytics` (client) and `@/lib/analytics-server` (server).
- **Server-gated flags:** compute flags on the server from PostHog, hydrate UI to avoid flicker.
- **Plan tagging:** set PostHog person properties `{ plan, branding_removed }` when plan changes.

---

## 1) Client wrapper (only import this on the client)
```ts
// src/lib/analytics.ts
'use client';
import posthog from 'posthog-js';

let loaded = false;
export function init() {
  if (loaded || typeof window === 'undefined') return;
  posthog.init(process.env.NEXT_PUBLIC_POSTHOG_KEY!, {
    api_host: process.env.NEXT_PUBLIC_POSTHOG_HOST,
    capture_pageview: true,
    autocapture: true,
  });
  loaded = true;
}

export function identify(id: string, props?: Record<string, unknown>) {
  init();
  posthog.identify(id, props);
}

export function capture(event: string, props?: Record<string, unknown>) {
  init();
  posthog.capture(event, props);
}

export function isOn(flag: string) {
  init();
  return posthog.isFeatureEnabled(flag);
}
```

> ESLint: **ban direct** `posthog-js` imports anywhere else.

---

## 2) Server helper (use in webhook or RSC)
```ts
// src/lib/analytics-server.ts
import type { NextRequest } from 'next/server';

const host = process.env.NEXT_PUBLIC_POSTHOG_HOST!;
const token = process.env.POSTHOG_API_KEY!; // server-side key

export async function phIdentify(distinctId: string, props: Record<string, unknown>) {
  await fetch(`${host}/capture/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // $set updates person properties; $token is your project API key
    body: JSON.stringify({
      api_key: token,
      distinct_id: distinctId,
      event: '$identify',
      properties: { $set: props },
    }),
    // avoid blocking; failures are non-fatal
    keepalive: true,
  }).catch(() => {});
}

export async function phCapture(distinctId: string, event: string, props?: Record<string, unknown>) {
  await fetch(`${host}/capture/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: token, distinct_id: distinctId, event, properties: props ?? {} }),
    keepalive: true,
  }).catch(() => {});
}
```

---

## 3) Tag plan on **plan change** (Stripe webhook)
Add after you update Supabase in the webhook:

```ts
import { phIdentify, phCapture } from '@/lib/analytics-server';

// after setPlan(userId, active)
await phIdentify(userId, { plan: active ? 'pro' : 'free', branding_removed: active });
await phCapture(userId, active ? 'plan_upgraded' : 'plan_downgraded', { source: 'stripe_webhook' });
```

*This keeps PostHog’s person properties synced without any client workarounds.*

---

## 4) Identify + hydrate flags on dashboard (client, not public SSR)
```tsx
// src/app/(dashboard)/layout.tsx (client boundary inside layout)
'use client';
import { useEffect } from 'react';
import { useUser } from '@clerk/nextjs';
import { identify } from '@/lib/analytics';

export default function DashboardClient({ plan }: { plan: 'free'|'pro' }) {
  const { user } = useUser();
  useEffect(() => {
    if (user?.id) identify(user.id, { plan, branding_removed: plan === 'pro' });
  }, [user?.id, plan]);
  return null;
}
```

Render `<DashboardClient plan={serverPlan} />` in your dashboard layout; **do not** include this on public SSR pages.

---

## 5) Server-gated feature flags (no flicker)
```ts
// src/lib/flags.ts (server)
import { cookies, headers } from 'next/headers';
import { createHash } from 'crypto';

const host = process.env.NEXT_PUBLIC_POSTHOG_HOST!;
const token = process.env.POSTHOG_API_KEY!;

export async function getFlagsForUser(distinctId: string | null, plan: 'free'|'pro') {
  // Call /decide to evaluate flags server-side with stable identity
  const body = {
    api_key: token,
    distinct_id: distinctId ?? 'anon:' + createHash('sha1').update(headers().get('x-forwarded-for') ?? '0').digest('hex'),
    person_properties: { plan },
  };
  const res = await fetch(`${host}/decide/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    cache: 'no-store',
  });
  const json = await res.json().catch(()=>({}));
  return (json?.featureFlags ?? []) as string[];
}
```

Use in server layouts/pages to pass `initialFlags` to a `FlagProvider` context; read flags in components. **Public profile SSR** can use these flags *without* any client decide call.

---

## 6) Minimal events (centralized constants)
```ts
// src/lib/analytics-events.ts
export const EV = {
  UPGRADE_CLICKED: 'upgrade_clicked',
  CHECKOUT_STARTED: 'checkout_started',
  PORTAL_OPENED: 'portal_opened',
  PLAN_UPGRADED: 'plan_upgraded',
  PLAN_DOWNGRADED: 'plan_downgraded',
} as const;
```
Use `capture(EV.UPGRADE_CLICKED, { priceId })` etc. Keeps names consistent.

---

## 7) ENV
```
NEXT_PUBLIC_POSTHOG_HOST=https://us.i.posthog.com   # or your EU/US host
NEXT_PUBLIC_POSTHOG_KEY=phc_...
POSTHOG_API_KEY=phx_...  # server key
```

---

## 8) Lint guardrails (no redundancy, no misuse)
- **ESLint `no-restricted-imports`**: block `posthog-js` except in `src/lib/analytics.ts`.
- **Rule**: fail if any client calls PostHog outside wrapper; fail if any server file imports the client wrapper.

---

## 9) CI smoke (optional)
After deploy, hit `/api/health/flags` that calls `getFlagsForUser` with a dummy user to ensure PostHog creds aren’t broken. Return `{ ok: true }`.

---

### Result
- **Users are auto-tagged** with `{ plan, branding_removed }` at the moment their plan changes.
- **Flags are evaluated server-side**, so public SSR never flickers and branding logic stays deterministic.
- **One wrapper per side** (client/server) = no duplicate patterns, easy for AI to follow.
- **No SSR risk**: client analytics run only in dashboard; public pages read flags & plan on the server.

If you want, I can add the ESLint rules and tiny `/api/health/flags` route to your issues list.


Okay, let's break it off into some very simple core steps. Like, let's plan it out into minimal tasks that we can do where we can then commit each one and deploy and ensure nothing breaks and then move on to the next step, etc. Okay, let's do that. Okay, let's do that.


Got it, Mr. White. Here’s a **minimal, sequential rollout plan**—each step is tiny, shippable, and reversible.

# Phase 0 — Prep (no user-visible change)

1) **Env scaffold**
- Add `APP_URL`, `STRIPE_PUBLIC_KEY/SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `NEXT_PUBLIC_PRICE_ID_PRO_MONTH`.
- Commit: `chore(env): stripe keys + app url`
- ✅ Build passes, app runs.

2) **DB fields (no usage yet)**
- Migration: add `profiles.plan ('free')`, `profiles.branding_removed (false)`, `profiles.stripe_customer_id`, `subscriptions` table.
- Commit: `db(migration): billing fields`
- ✅ Health DB passes; app unchanged.

3) **Stripe server helper**
- Add `lib/stripe.ts` (server-only), no imports elsewhere.
- Commit: `feat(stripe): server sdk helper`
- ✅ Build passes.

# Phase 1 — Minimal upgrade path (no plan flip yet)

4) **Billing page shell**
- Add `/dashboard/billing` route (copy, text + placeholder buttons).
- Commit: `feat(billing): page shell`
- ✅ Route renders; no actions wired.

5) **Checkout session (redirect only)**
- Server action `createCheckoutSession(priceId)`; creates/fetches `stripe_customer_id`; returns `session.url`.
- Wire button → redirect; **no DB plan change yet**.
- Commit: `feat(billing): checkout session create`
- ✅ Reaches Stripe Checkout; cancel returns.

6) **Customer Portal (manage only)**
- Server action `createPortalSession()` using stored `stripe_customer_id`.
- Wire button; returns to `/dashboard/billing`.
- Commit: `feat(billing): customer portal`
- ✅ Portal opens; no DB changes.

# Phase 2 — Source of truth sync (plan flips via webhook)

7) **Webhook endpoint (no-op log)**
- Add `/api/stripe/webhook` (Node runtime), verify signature, log events only.
- Commit: `feat(webhook): stripe endpoint verify-only`
- ✅ Stripe can deliver events (200).

8) **Webhook → DB updates**
- Handle `checkout.session.completed`, `customer.subscription.updated|deleted`.
- Update `profiles.plan` + `branding_removed`; upsert `subscriptions`.
- Commit: `feat(webhook): sync plan + subscription`
- ✅ Completing Checkout flips DB to `pro`; cancel flips to `free`.

# Phase 3 — User-visible gating (SSR-safe)

9) **Public profile SSR branding gate**
- In `/:handle` server route, read `branding_removed`; hide/show branding.
- Commit: `feat(profile): ssr branding gate`
- ✅ After purchase, public page hides branding (no client flicker).

10) **Dashboard Pro badge**
- Fetch `profiles.plan`; render “Pro” chip in dashboard header.
- Commit: `feat(billing): pro badge`
- ✅ Badge appears when plan is `pro`.

# Phase 4 — PostHog (single surface, minimal)

11) **Server analytics sync on plan change**
- In webhook, call `phIdentify(userId, { plan, branding_removed })` and `phCapture(plan_upgraded/plan_downgraded)`.
- Commit: `feat(analytics): plan tagging via webhook`
- ✅ PostHog person shows `{ plan }` changes.

12) **Dashboard identify (client)**
- On dashboard only, `identify(user.id, { plan })` (no public pages).
- Commit: `feat(analytics): dashboard identify`
- ✅ No console errors; events appear.

# Phase 5 — Health + tests

13) **Health: /api/health/billing**
- Add endpoint that lists 1 Stripe product (or returns OK).
- Commit: `feat(health): billing check`
- ✅ Smoke shows OK.

14) **Smoke test (post-deploy)**
- Script hits `/api/health/app`, `/api/health/db`, `/api/health/billing`.
- Commit: `chore(ci): post-deploy smoke`
- ✅ Preview must pass smoke.

15) **E2E happy path (optional now, required later)**
- Playwright: signup → upgrade (test card) → webhook → dashboard Pro → public no branding.
- Commit: `test(e2e): billing happy path`
- ✅ Green in CI (can be marked flaky=off until DB stable).

# Phase 6 — Cleanup (reduce surface area)

16) **Remove dead code flags**
- Delete Clerk billing remnants, old envs, unused components.
- Commit: `chore(billing): remove legacy code`
- ✅ Repo search shows no legacy refs.

---

## Rollout notes
- Deploy **one step per PR**; verify ✅, then proceed.
- If anything breaks: revert last PR; prior steps keep system stable.
- Keep SSR-only branding gate; client analytics never used on public pages.

Want these as GitHub issues with checklists? I can output a CSV or Markdown bundle ready to import.


**Topic:** [[chatgpt-clusters/coding_troubleshoot]]


## See Also
- [[chatgpt/chatgpt_mvp-blockers-and-fixes-part1]]
- [[chatgpt/chatgpt_1-of-body-weight-part2]]
- [[chatgpt/chatgpt_accident-liability-and-insurance-part2]]
- [[chatgpt/chatgpt_accident-timing-and-coverage-part2]]
- [[chatgpt/chatgpt_age-field-update-issue-part2]]
