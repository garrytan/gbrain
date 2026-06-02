---
title: "MVP blockers and fixes"
type: essay
created: 2025-08-18
updated: 2025-08-18
source: chatgpt-export
topic: coding-general
message_count: 16
tags: [chatgpt, knowledge, coding-general]
---
**Topic:** [[chatgpt-knowledge/_topics/coding-general]]

# MVP blockers and fixes

> **Source:** ChatGPT conversation
> **Date:** 2025-08-18T15:39:12Z
> **Messages:** 16
> **Topic:** coding-general

## Question

Okay, I'm just going to dictate some bugs that I'm noticing so far. So, if we log into our staging site, we create a new account. After auth, it forwards us to our production site to go to the dashboard, instead of the dashboard on the staging site. So, if I change the URL back, then I get to the staging site, then I get to the claim. On the user screen, the live validation, where it gives you the green checkmark if you type in a handle that's available. If I type in a handle that's available, I see the green checkmark, then I see the spinner, then I see the green checkmark, then I see the spinner, and then that just repeats continually, even though I'm not typing anything. And it continues to flip between the green checkmark and the spinner, instead of just staying on the green checkmark. Also, there's excessive space in the design above the input on that screen. When I'm clicking create profile, I'm getting user creation failed on an error. Hit retry. I then have to click create prof

## Answer

Got it, Mr. White. Here’s the fastest path to green.

# MVP blockers → fixes

1) Staging auth redirects to **prod**
- **Cause**: Clerk redirect URLs or `afterSignInUrl/afterSignUpUrl` hard-coded to prod.
- **Fix**
  - In Clerk dashboard (Staging instance): add staging origins to **Allowed Origins** and **Redirect URLs**.
  - In app, derive all Clerk URLs from env:
    ```ts
    // _app.tsx
    <ClerkProvider
      signInUrl={`${process.env.NEXT_PUBLIC_APP_URL}/sign-in`}
      signUpUrl={`${process.env.NEXT_PUBLIC_APP_URL}/sign-up`}
      afterSignInUrl={`${process.env.NEXT_PUBLIC_APP_URL}/dashboard`}
      afterSignUpUrl={`${process.env.NEXT_PUBLIC_APP_URL}/onboarding`}
    >
    ```
  - Purge any absolute `https://prod...` pushes/links. Use **relative** routes.
  - Add a domain guard in middleware to prevent cross-env redirects.
    ```ts
    // middleware.ts
    const base = new URL(req.nextUrl);
    if (!base.host.endsWith('staging.domain.com')) return NextResponse.next();
    ```

2) Handle validation flickers (✅ ↔︎ spinner loop)
- **Cause**: firing requests on stale value; missing cancellation; state churn.
- **Fix**
  - Debounce and cancel inflight:
    ```ts
    const ctrlRef = useRef<AbortController|null>(null);
    useEffect(() => {
      if (handle.length < 3) return setState('idle');
      const id = setTimeout(async () => {
        ctrlRef.current?.abort();
        const ctrl = new AbortController(); ctrlRef.current = ctrl;
        setState('loading');
        const r = await fetch(`/api/handle/${handle}`, {signal: ctrl.signal, cache:'no-store'});
        setState((await r.json()).available ? 'ok' : 'taken');
      }, 300);
      return () => { clearTimeout(id); ctrlRef.current?.abort(); };
    }, [handle]);
    ```
  - Only show spinner while `state==='loading'`. Don’t re-trigger on parent re-renders.

3) Excess space above input
- **Fix**: audit container spacing; likely stack gap + label margin.
  ```tsx
  <div className="space-y-3">  {/* not 8/10 */}
    <label className="mb-1 block text-sm font-medium">Handle</label>
    <Input ... />
  </div>
  ```

4) “User creation failed” + profiles missing on **staging**
- **Likely causes**
  - Wrong **Supabase** env for staging.
  - CORS / Allowed origins missing.
  - RLS policies blocking inserts/selects.
  - Migrations not run on staging.
- **Fix checklist**
  - Verify `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` point to **staging** project.
  - Server code uses **SERVICE_ROLE** key **only on server** (never expose).
  - Supabase → **Auth > URL config**: add `https://staging.domain.com` to Allowed Callback/Redirect/Embed.
  - Supabase → **API**: add `https://staging.domain.com` to **Allowed CORS origins**.
  - Run staging migrations. If using DB branch: promote to staging.
  - Sanity RLS (example):
    ```sql
    -- profiles table
    create policy "public can read profiles"
      on public.profiles for select
      using (true);

    create policy "owner can insert/updat

*(Answer truncated — 6963 chars total)*

## Question

Okay, I think the other thing we're going to do is we're going to switch to Stripe directly instead of using clerk billing because we're hitting all sorts of issues with it, and I think AI will be better at coding Stripe since it's so well documented. First, I'd like a recommendation for the stack for what we should use for Stripe initially. I was thinking Stripe checkout, but lay out what we need to do just to get, basically, we need a pricing table and a pricing page. We need the ability for you to upgrade your account, check out the credit card, or whatever, and then have our system then know that you've paid, have your accounts status upgraded, and then have the branding disappear from your profile, have you be able to update your payment info, and your credit card, and cancel, and do all that stuff, and then that's basically what we're going to, what we need for now. That's kind of it. We'll feature flag some more features later based on payments, and eventually we'll turn the tip

## Answer

Roger, Mr. White. Here’s the cleanest, low-friction Stripe stack for MVP billing that “just works” and is easy for AI to code/maintain.

# Stack choice (now)
- **Stripe Billing + Subscriptions**
- **Stripe Checkout** (create subscriptions)
- **Stripe Customer Portal** (manage plan, payment method, cancel)
- **Webhooks** (single handler; Stripe is source of truth)
- **Next.js (App Router) server actions** for session creation
- **Supabase** for a tiny cache of subscription status/plan → drives feature flags (hide branding)

# Data model (Supabase)
Keep it minimal; Stripe is the truth.
- `profiles(id uuid pk, stripe_customer_id text, plan text default 'free', branding_removed boolean default false)`
- `subscriptions(user_id uuid pk, stripe_subscription_id text unique, status text, current_period_end timestamptz, price_id text)`
(You can merge into `profiles` if you want ultra-minimal.)

# Prices / products
Create in Stripe Dashboard:
- Product: **Jovie Pro**
  - Price (recurring monthly) → `PRICE_ID_PRO_MONTH`
  - (Optional) Yearly price → `PRICE_ID_PRO_YEAR`

# Core flows

## 1) Upgrade (create Checkout Session)
- Server action (auth required): find/create Stripe Customer by `user.id`.
- Create **Subscription** Checkout Session with:
  - `mode: 'subscription'`
  - `line_items: [{ price: PRICE_ID, quantity: 1 }]`
  - `allow_promotion_codes: true` (optional)
  - `customer: stripe_customer_id`
  - `success_url: ${APP_URL}/billing/success?session_id={CHECKOUT_SESSION_ID}`
  - `cancel_url: ${APP_URL}/dashboard/billing`
- Redirect user to `session.url`.

```ts
// app/actions/billing.ts
'use server';
import Stripe from 'stripe';
import { auth } from '@clerk/nextjs/server'; // or your auth
import { db } from '@/lib/db'; // supabase server client

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

export async function createCheckoutSession({ priceId }: { priceId: string }) {
  const { userId } = auth();
  if (!userId) throw new Error('Unauthorized');

  const profile = await db.getProfile(userId);
  const customer = profile.stripe_customer_id
    ? profile.stripe_customer_id
    : (await stripe.customers.create({ metadata: { userId } })).id;

  if (!profile.stripe_customer_id) {
    await db.updateProfile(userId, { stripe_customer_id: customer });
  }

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer,
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${process.env.APP_URL}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${process.env.APP_URL}/dashboard/billing`,
    allow_promotion_codes: true
  });

  return { url: session.url! };
}
```

## 2) Manage billing (Customer Portal)
- Server action returns a **Customer Portal** URL.

```ts
export async function createPortalSession() {
  const { userId } = auth();
  const profile = await db.getProfile(userId);
  if (!profile?.stripe_customer_id) throw new Error('No customer');

  const portal = await stripe.billingPor

*(Answer truncated — 8494 chars total)*

## Question

Okay, so I'm on the preview branch and looks like we have a simple build error related to post hog. Um, so I need to fix that build error. Okay, so I'm on the preview branch and looks like we have a simple build error related to post hog. So I need to fix that. Okay, so I'm on the preview branch and looks like we have a simple build error related And instead, add a Stripe checkout, um, Stripe billing portable, and a Stripe pricing table to the pricing page. Um, and then do anything that's needed to make sure that Stripe is fully configured for everything we need to get, allow people to upgrade their account. Um, and then we want to build that end-to-end test for the minimal flow. And we want to do that single source of truth for the base URL. Um, break these all out into, um, concise, single objective, um, GitHub issues like, um, Y Combinator would recommend.

## Answer

Got it, Mr. White. Here are **single-objective GitHub issues** (concise, copy-paste ready). Each has a tight checklist + acceptance criteria.

---

## 1) Fix PostHog build error on preview
**Why:** Preview build fails due to client-only code executing in SSR.
**Tasks**
- Guard imports behind client:
  - Replace any top-level `import posthog from 'posthog-js'` in shared code with `if (typeof window !== 'undefined') { import('posthog-js').then(...) }`
- Ensure any hooks/components that call PostHog are `use client` and wrap init in `useEffect`.
- Add null checks where `window` is referenced.
**Acceptance**
- `pnpm build` succeeds on preview.
- No PostHog errors in server logs.

---

## 2) Remove Clerk Billing from codebase (staging/preview)
**Why:** We’re switching to Stripe directly.
**Tasks**
- Delete Clerk billing components/pages and mounts.
- Remove billing-related Clerk env usage.
- Feature-flag off any references (`PRICING_USE_CLERK=false`).
**Acceptance**
- App compiles with no Clerk billing references.

---

## 3) Create Stripe products/prices (Dashboard)
**Why:** Source of truth for plans.
**Tasks**
- Product: **Jovie Pro**
  - Monthly price → note `PRICE_ID_PRO_MONTH`
  - Yearly price (optional) → `PRICE_ID_PRO_YEAR`
**Acceptance**
- Price IDs documented in the repo `.env.example`.

---

## 4) Configure Stripe env & webhooks (Vercel + local)
**Why:** Wire keys + signatures.
**Tasks**
- Add to **staging** + **prod** envs:
  - `STRIPE_PUBLIC_KEY`
  - `STRIPE_SECRET_KEY`
  - `STRIPE_WEBHOOK_SECRET`
  - `PRICE_ID_PRO_MONTH`, `PRICE_ID_PRO_YEAR` (if used)
- Add local `.env.local` equivalents.
**Acceptance**
- `stripe listen --forward-to localhost:3000/api/stripe/webhook` verifies events are received locally.

---

## 5) Add billing fields to DB (Supabase migration)
**Why:** Gate features, hide branding.
**Tasks**
- `profiles`: `stripe_customer_id text`, `plan text default 'free'`, `branding_removed boolean default false`
- `subscriptions`: `user_id uuid pk`, `stripe_subscription_id text unique`, `status text`, `current_period_end timestamptz`, `price_id text`
- Owner-only RLS for write; public read for minimal profile data as needed.
**Acceptance**
- Migration runs on staging DB; RLS tested with authenticated user.

---

## 6) Implement “Upgrade” via Stripe Checkout (server action)
**Why:** Start subs cleanly.
**Tasks**
- `createCheckoutSession({ priceId })` server action:
  - Find/create Customer; store `stripe_customer_id`
  - Create Checkout Session (mode=subscription)
  - `success_url=${APP_URL}/billing/success?session_id={CHECKOUT_SESSION_ID}`
  - `cancel_url=${APP_URL}/dashboard/billing`
  - Set `metadata.userId` on Customer/Subscription
**Acceptance**
- Clicking “Upgrade” redirects to Stripe hosted Checkout successfully.

---

## 7) Implement Customer Portal (manage payment/cancel)
**Why:** Self-serve billing management.
**Tasks**
- `createPortalSession()` server action returns portal URL for current user’s customer.
- Add “Manage Bill

*(Answer truncated — 5888 chars total)*

## Question

I'm noticing a couple issues we're just having consistently is one is like with AI coding anyway is one is AI not leveraging Next.js in some situations like for example using a-links instead of next-links or using image tags instead of next-image. Also not respecting the fact that we're using like post-hoc for feature flags and analytics and writing in random references to like segment or something which we're no longer using. Another one is like not fully leveraging TypeScript, putting in any as the type rather than defining a type, which creates some issues. Another one would be there's a lot of stuff related to server-side rendering and client slash server stuff particularly when it comes to integrating with ClerkAuth and you know properly scoping things and whatnot. Or you know using improper libraries of things when there's a Next.js specific library and it's using the JS library of something. A couple things whether it's not leveraging Tailwind for CSS fully and instead putting i

## Answer

Got it, Mr. White. Short answer: **yes**, add agent rules *and* enforce them in code. Use both or you’ll keep whack-a-moling.

Below is a tight combo you can drop in today.

# 1) Windsurf rules (global)
Put this in your Windsurf rules file as the first rule block.

```
Title: Jovie Engineering Guardrails
Scope: all
Always:
  - Use Next.js primitives: next/link (no <a> for internal nav), next/image (no <img>), next/font
  - Use @clerk/nextjs (never @clerk/clerk-react in app router)
  - Use PostHog via '@/lib/analytics' wrapper only; feature flags via PostHog Experiments or server-gated flags from DB
  - Write TypeScript with explicit types; no 'any'; export types/interfaces from '@/types'
  - Prefer Server Components; mark Client Components with 'use client' only when needed
  - Use Tailwind utility classes; avoid custom CSS unless reusable (then make a component)
  - Support dark and light modes; verify readable contrast for both themes
Never:
  - Import 'posthog-js' outside '@/lib/analytics'
  - Import 'segment', 'rudderstack', or any analytics other than PostHog
  - Use window/document in Server Components
  - Use fetch in Client Components for server data (add a server action or route handler)
  - Commit TODO code that breaks SSR/edge
Definition of Done (every PR):
  - passes `pnpm typecheck && pnpm lint && pnpm test`
  - no restricted imports; no 'any'
  - pricing/profile pages render correctly in dark & light (Playwright check)
  - internal links use <Link>; images use <Image>
```

# 2) Code-level enforcement (copy/paste)

## .eslintrc.cjs
```js
module.exports = {
  extends: [
    'next/core-web-vitals',
    'plugin:@typescript-eslint/recommended',
    'plugin:jsx-a11y/recommended',
    'plugin:tailwindcss/recommended'
  ],
  plugins: ['@typescript-eslint','jsx-a11y','tailwindcss'],
  rules: {
    '@typescript-eslint/no-explicit-any': 'error',
    '@typescript-eslint/explicit-module-boundary-types': 'warn',
    'react/jsx-no-target-blank': 'warn',
    'tailwindcss/classnames-order': 'warn',
    'tailwindcss/no-custom-classname': 'off',
    'jsx-a11y/alt-text': 'error',
    // Next primitives:
    'no-restricted-syntax': [
      'error',
      {
        selector: "JSXOpeningElement[name.name='img']",
        message: 'Use next/image instead of <img>.'
      },
      {
        selector:
          "JSXOpeningElement[name.name='a'][attributes.some(attr.name && attr.name.name==='href' && /^\\//.test(attr.value && attr.value.value))]",
        message: 'Use next/link for internal navigation.'
      }
    ],
    'no-restricted-imports': [
      'error',
      {
        paths: [
          { name: '@clerk/clerk-react', message: 'Use @clerk/nextjs in App Router.' },
          { name: 'posthog-js', message: "Import '@/lib/analytics' wrapper instead." },
          { name: 'segment-js', message: 'Segment not allowed.' },
          { name: 'analytics.js', message: 'Only PostHog via wrapper.' }
        ],
        patterns: [
          { group: ['*segment*'

*(Answer truncated — 8151 chars total)*

## Question

Okay, we added our health checkpoint for the database, which is currently showing a fail. So we're working on that. Is there a way that we can, can, and or should, and like should we, add a check so that, like, should we check the API health point and see if things that we're doing are breaking it? You know what I mean? Is that worth adding to the test and to have it check that the API health point works, or is that just going to be cumbersome and cause issues?

## Answer

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

*(Answer truncated — 4159 chars total)*

## Question

Okay, we've removed Clark Billing entirely, and we're working on the database issues in Windsurf. I'm going to have Copilot work on adding Stripe Billing. So, what I need is a prompt to break down the installation of Stripe Billing for Copilot. So, I need to ensure that we follow a couple things here. One, everything we do is compatible with Next.js 15, which is what we're using, so we can't break anything. Everything we have to do has to work with Next.js 15. Two, we want to ensure that nothing we do is going to prevent server-side rendering in the future. Although I mostly care about server-side rendering outside of the auth scope, so things on the dashboard and stuff are not a big deal, but things like removing branding from public profiles cannot break server-side rendering. Also, we're using Clark for authentication, and so everything we do has to be compatible with Clark. And then finally, we're using Superbase, so everything has to be compatible with Superbase, and we're using S

## Answer

Got it, Mr. White. Here’s a **single Copilot prompt** you can paste to build Stripe Billing the minimal, correct way for our stack.

---

# Copilot: Implement Stripe Billing (Next.js 15 + Clerk + Supabase)

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
  // @ts-exp

*(Answer truncated — 12552 chars total)*

## Question

We should take advantage of potshog as well to ensure feature flags and everything are compatible and users are tagged by their plan and that we dont create unnecessary or redundant code

## Answer

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

## 4) Ide

*(Answer truncated — 6236 chars total)*

## Question

Okay, let's break it off into some very simple core steps. Like, let's plan it out into minimal tasks that we can do where we can then commit each one and deploy and ensure nothing breaks and then move on to the next step, etc. Okay, let's do that. Okay, let's do that.

## Answer

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
- ✅ No console 

*(Answer truncated — 4178 chars total)*
