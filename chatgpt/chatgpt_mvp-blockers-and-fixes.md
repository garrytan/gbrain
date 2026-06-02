---
title: "MVP blockers and fixes"
type: essay
created: 2025-08-18
updated: 2025-08-18
source: chatgpt-export
conversation_id: 68a3491b-d3d4-8323-8011-2639e9fb77ff
message_count: 16
tags: [chatgpt, import, code, long-form]
---
# MVP blockers and fixes

> Conversation ID: 68a3491b-d3d4-8323-8011-2639e9fb77ff
> Created: 2025-08-18T15:39:12Z
> Updated: 2025-08-18T19:03:16Z
> Messages: 16

---

## User

Okay, I'm just going to dictate some bugs that I'm noticing so far. So, if we log into our staging site, we create a new account. After auth, it forwards us to our production site to go to the dashboard, instead of the dashboard on the staging site. So, if I change the URL back, then I get to the staging site, then I get to the claim. On the user screen, the live validation, where it gives you the green checkmark if you type in a handle that's available. If I type in a handle that's available, I see the green checkmark, then I see the spinner, then I see the green checkmark, then I see the spinner, and then that just repeats continually, even though I'm not typing anything. And it continues to flip between the green checkmark and the spinner, instead of just staying on the green checkmark. Also, there's excessive space in the design above the input on that screen. When I'm clicking create profile, I'm getting user creation failed on an error. Hit retry. I then have to click create profile again, and I get the same error. I assume it's related to a SuperBase connection, because I'm noticing that if I go to any profiles, they're not showing up right now on the staging site. So, I think that the SuperBase connection is not working properly, or something's blocking SuperBase. It looks like it's working, but something that we did must have broken it or something, because it's currently not working. Anyway, so that's blocking, that SuperBase issue is blocking us from getting to profiles, which is a major block, and then also, it's keeping us from getting to the dashboard, which is a major block. Also, the pricing page is still throwing errors. So, that needs to be resolved. Our core requirement for achieving a launchable MVP would be that a user hits the homepage, they type in their handle as the input on the home screen, and claim handle form. They're then taken to the Clark sign-up. They sign up, put their email and password, ask them to verify their email with the code that they got. It then takes them to the onboarding screen, passing along the handle that they put in on the first screen, or if they bypass the first screen, it prompts them for a handle. When they put in the handle, it then takes them to the dashboard, and they're able to finish setting up the profile. And then it should register that user in the database, connect that user to an artist profile with that handle, and when I go to the URL of that handle, I should be able to see their profile. That would be the base minimum for a working MVP, and that's what we need to get to right now. Once we get to that, I would want to add a simple end-to-end test that tests that whole sign-up flow, so that as we add features, we know that they don't get merged in unless they don't break that flow. Next, we would start adding the ability for you to set up payments, so that if you upgrade your account to a pro account, we remove branding. Once we have the ability for you to sign up and remove branding, then I would want to work on making sure that you have the ability to add your social links and all that to your profile, and we can go from there and continue building. But right now, we don't want to focus on any of that until we have the core MVP functionality done. So the goal is for us to ship that core functionality as fast as possible.

---

## Assistant

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

    create policy "owner can insert/update own profile"
      on public.profiles for insert with check (auth.uid() = id)
      , for update using (auth.uid() = id);
    ```
  - Confirm the insert path: Clerk webhook (user.created) → upsert into `profiles` OR first-run onboarding API creates `artist_profile` + link to user. Verify both endpoints use the staging **service key**.

5) Pricing page still errors (Clerk pricing table)
- **Fastest MVP path**: remove pricing widget from staging; replace with Stripe Checkout link(s) behind feature flag. Fix the widget later.
- If you want it now: pin compatible versions and avoid unmount crash.
  - Ensure `@clerk/clerk-react` and `@clerk/clerk-js` are on versions that support `mountPricingTable/unmountPricingTable` **both**.
  - Or swap to the **component** form if available, not imperative mount.
  - Guard SSR: only render on client after `window.Clerk` ready.

# Minimal flow (MVP)
1. Home → claim handle (pass via query or context).
2. Clerk sign-up + email code verification.
3. Onboarding:
   - Pre-fill handle (or prompt).
   - POST `/api/onboarding/complete`:
     - upsert user → `profiles`
     - create `artist_profile` with `handle`
     - link user↔artist
4. Redirect → `/dashboard`.
5. Public page resolves `/:handle` → render profile.

# Quick hardening
- **Single source of truth for base URL**
  ```env
  NEXT_PUBLIC_APP_URL=https://staging.domain.com
  ```
  Use everywhere (Clerk, redirects, links, OG).
- **Absolute DB checks**: add health route `/api/health` that runs a Supabase read (`select 1`) so we can instantly see if staging DB is reachable and RLS OK.

# One end-to-end test (Playwright)
```ts
import { test, expect } from '@playwright/test';

test('signup → onboard → dashboard → public profile', async ({ page }) => {
  const base = process.env.BASE_URL || 'https://staging.domain.com';
  const handle = `tim${Date.now()}`;

  await page.goto(base);
  await page.fill('[data-testid=claim-handle-input]', handle);
  await page.click('[data-testid=claim-handle-submit]');

  // Clerk hosted
  await page.fill('input[type=email]', `qa+${Date.now()}@example.com`);
  await page.fill('input[type=password]', 'Test1234!');
  await page.click('button:has-text("Sign up")');

  // DEV ONLY: bypass code or mock; otherwise read from test inbox
  await page.click('button:has-text("Continue")');

  // Onboarding
  await page.waitForURL(`${base}/onboarding*`);
  await page.fill('[data-testid=handle-input]', handle);
  await page.click('[data-testid=create-profile]');

  // Dashboard
  await page.waitForURL(`${base}/dashboard`);
  await expect(page.getByText('Welcome')).toBeVisible();

  // Public profile
  await page.goto(`${base}/${handle}`);
  await expect(page.getByText(handle)).toBeVisible();
});
```

# Linear/GitHub issue titles (ready to paste)
1. **Clerk (staging): redirect URLs & afterSignIn pointing to prod — fix env + relative routes**
2. **Handle availability: debounce + abort inflight; lock spinner to pending state**
3. **Onboarding form spacing: tighten label/input stack to `space-y-3`**
4. **Supabase (staging): wrong env / missing CORS / RLS — audit & repair; run migrations**
5. **Profiles not visible on staging: confirm RLS read policy for `profiles`**
6. **Pricing page: remove Clerk pricing widget for MVP; swap to Stripe Checkout links**
7. **Add `/api/health` DB probe and status badge**
8. **Playwright E2E: home→claim→sign-up→onboarding→dashboard→public profile on every PR**

# Env checklist (staging)
- `NEXT_PUBLIC_APP_URL=https://staging.domain.com`
- Clerk: **staging** publishable/secret keys + redirect URLs set to staging
- Supabase:
  - `NEXT_PUBLIC_SUPABASE_URL` (staging)
  - `NEXT_PUBLIC_SUPABASE_ANON_KEY`
  - `SUPABASE_SERVICE_ROLE_KEY` (server only)
  - CORS: `https://staging.domain.com`
  - Auth redirect URLs include staging
- Feature flag: `PRICING_ENABLED=false` on staging

If you want, I’ll turn these into a PR (config + debounce + health route) and a Linear batch next.

---

## User

Okay, I think the other thing we're going to do is we're going to switch to Stripe directly instead of using clerk billing because we're hitting all sorts of issues with it, and I think AI will be better at coding Stripe since it's so well documented. First, I'd like a recommendation for the stack for what we should use for Stripe initially. I was thinking Stripe checkout, but lay out what we need to do just to get, basically, we need a pricing table and a pricing page. We need the ability for you to upgrade your account, check out the credit card, or whatever, and then have our system then know that you've paid, have your accounts status upgraded, and then have the branding disappear from your profile, have you be able to update your payment info, and your credit card, and cancel, and do all that stuff, and then that's basically what we're going to, what we need for now. That's kind of it. We'll feature flag some more features later based on payments, and eventually we'll turn the tipping feature into a direct payment feature where we'll have creators be able to sign up for their own payment accounts and accept payments and stuff, but, and then we'll be taking, you know, fees off the top of that, but for now, for now that's it.

---

## Assistant

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

  const portal = await stripe.billingPortal.sessions.create({
    customer: profile.stripe_customer_id,
    return_url: `${process.env.APP_URL}/dashboard/billing`
  });
  return { url: portal.url };
}
```

## 3) Webhooks (single endpoint)
Listen and update DB; this drives branding removal and feature flags.

Events to handle:
- `checkout.session.completed` → fetch subscription → set `plan='pro'`, `branding_removed=true`, upsert `subscriptions`.
- `customer.subscription.updated` → update `status`, `current_period_end`, `price_id`, toggle `branding_removed` if canceled/paused.
- `customer.subscription.deleted` → set `plan='free'`, `branding_removed=false`.
- (Optional) `invoice.payment_failed` to warn users.

```ts
// app/api/stripe/webhook/route.ts
import { NextResponse } from 'next/server';
import Stripe from 'stripe';
import { db } from '@/lib/db';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET!;

export async function POST(req: Request) {
  const sig = req.headers.get('stripe-signature')!;
  const body = await req.text();
  let event: Stripe.Event;

  try { event = stripe.webhooks.constructEvent(body, sig, endpointSecret); }
  catch (e) { return new NextResponse('Bad signature', { status: 400 }); }

  switch (event.type) {
    case 'checkout.session.completed': {
      const s = event.data.object as Stripe.Checkout.Session;
      const subId = s.subscription as string;
      const customerId = s.customer as string;

      const sub = await stripe.subscriptions.retrieve(subId);
      const userId = sub.metadata.userId ?? (await getUserIdFromCustomer(customerId)); // set metadata at checkout if desired

      await db.updateProfile(userId, {
        stripe_customer_id: customerId,
        plan: 'pro',
        branding_removed: true
      });

      await db.upsertSubscription({
        user_id: userId,
        stripe_subscription_id: sub.id,
        status: sub.status,
        current_period_end: new Date(sub.current_period_end * 1000),
        price_id: sub.items.data[0]?.price.id ?? null
      });
      break;
    }
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const sub = event.data.object as Stripe.Subscription;
      const customerId = sub.customer as string;
      const userId = sub.metadata.userId ?? (await getUserIdFromCustomer(customerId));

      const active = sub.status === 'active' || sub.status === 'trialing' || sub.status === 'past_due';
      await db.updateProfile(userId, {
        plan: active ? 'pro' : 'free',
        branding_removed: active
      });
      await db.upsertSubscription({
        user_id: userId,
        stripe_subscription_id: sub.id,
        status: sub.status,
        current_period_end: new Date(sub.current_period_end * 1000),
        price_id: sub.items.data[0]?.price.id ?? null
      });
      break;
    }
  }
  return NextResponse.json({ received: true });
}

// helper: map customer->userId (store on create, or use Stripe customer metadata)
async function getUserIdFromCustomer(customerId: string) {
  // Look up by profiles.stripe_customer_id
  const profile = await db.getProfileByCustomer(customerId);
  return profile.id;
}
```

> **Important**: Set `metadata: { userId }` when creating the Stripe **Customer** and/or **Subscription** for easy mapping.

# UI pieces

## Pricing table/page (simple)
- Render prices from environment (safe & fast) or fetch from Stripe on the **server** (cache 1h).
- Buttons:
  - “Upgrade Monthly” → server action `createCheckoutSession({ priceId: PRICE_ID_PRO_MONTH })`
  - “Manage Billing” → server action `createPortalSession()`

## Branding removal
- Gate with a single selector: `branding_removed` from profile.
- SSR: in the public profile route `/:handle`, fetch profile → if `branding_removed`, don’t render the badge.

# ENV (staging & prod)
```
APP_URL=https://staging.yourapp.com
STRIPE_PUBLIC_KEY=pk_live_...
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...
PRICE_ID_PRO_MONTH=price_...
PRICE_ID_PRO_YEAR=price_...
```
(Use separate keys for staging; set Dashboard “test mode” for test cards.)

# Security & DX
- Verify webhook signatures; keep handler **edge-disabled** (use Node runtime).
- Use **idempotency keys** on Checkout creation to avoid dupes.
- Add Stripe CLI to dev: `stripe listen --forward-to localhost:3000/api/stripe/webhook`.

# Tests (Playwright)
- Happy path: free → Checkout (test card 4242) → webhook → dashboard shows Pro → public page no branding.
- Cancel path via Customer Portal → webhook → branding returns.
- Regression: public page never shows branding for Pro.

# Why this stack
- **Smallest surface area**: Checkout + Portal + webhooks.
- **Fastest to ship**: no custom card forms; no PCI scope.
- **Easy to extend**: add metered/tiers later; swap Portal for in-app management when ready.
- **Creator payouts later**: add **Stripe Connect** (Express) as a separate track without touching core subscriptions.

# Next steps (I’ll wire these in one PR)
1) Create Stripe products/prices; paste IDs to env.
2) Add `stripe_customer_id/branding_removed/plan` fields + RLS (owner-only update).
3) Implement server actions + webhook route.
4) Replace Clerk billing UI with pricing page + two buttons.
5) Add Playwright E2E around upgrade/cancel and branding visibility.

If you want, I’ll also stub the DB helpers (`db.getProfile`, `db.updateProfile`, `db.upsertSubscription`) and drop in a minimal pricing page so you can toggle this today.

---

## User

Okay, so I'm on the preview branch and looks like we have a simple build error related to post hog. Um, so I need to fix that build error. Okay, so I'm on the preview branch and looks like we have a simple build error related to post hog. So I need to fix that. Okay, so I'm on the preview branch and looks like we have a simple build error related And instead, add a Stripe checkout, um, Stripe billing portable, and a Stripe pricing table to the pricing page. Um, and then do anything that's needed to make sure that Stripe is fully configured for everything we need to get, allow people to upgrade their account. Um, and then we want to build that end-to-end test for the minimal flow. And we want to do that single source of truth for the base URL. Um, break these all out into, um, concise, single objective, um, GitHub issues like, um, Y Combinator would recommend.

---

## Assistant

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
- Add “Manage Billing” button on `/dashboard/billing`.
**Acceptance**
- Users can update card and cancel from the portal; return to app works.

---

## 8) Stripe webhook endpoint
**Why:** Make app state reflect billing truth.
**Tasks**
- `POST /api/stripe/webhook` (Node runtime)
- Handle:
  - `checkout.session.completed` → set `plan='pro'`, `branding_removed=true`, upsert subscription
  - `customer.subscription.updated`/`deleted` → sync status + toggle `branding_removed`
- Verify signature; idempotent upserts.
**Acceptance**
- Toggling/canceling in Stripe updates DB and UI state within seconds.

---

## 9) Pricing page with Stripe Pricing Table (fastest)
**Why:** Quick, reliable purchase UI.
**Tasks**
- Embed `<stripe-pricing-table pricing-table-id="pt_..." publishable-key="pk_..."></stripe-pricing-table>` on `/pricing`.
- Hide old billing UI.
**Acceptance**
- Pricing page renders prices; selecting a plan launches Checkout and completes successfully.

---

## 10) Hide branding when Pro (SSR + client)
**Why:** Immediate user-visible value.
**Tasks**
- In public profile route `/:handle`, fetch profile → conditionally render/no-render branding based on `branding_removed`.
- Dashboard header/footer: same gate.
**Acceptance**
- Free users see branding; Pro users don’t—across SSR and client navigations.

---

## 11) Single source of truth for base URL
**Why:** Stop cross-env misroutes.
**Tasks**
- Add `APP_URL` env; replace hard-coded origins in redirects, success/cancel URLs, emails, OG tags.
- Audit Clerk `afterSignIn/afterSignUp` to use relative paths plus `APP_URL` where needed.
**Acceptance**
- Staging stays on staging, prod stays on prod throughout auth and billing flows.

---

## 12) E2E test: signup → upgrade → no-branding
**Why:** Guard the MVP path.
**Tasks**
- Playwright test:
  - Claim handle → sign up
  - Open pricing → Checkout (Stripe test card)
  - Wait for webhook effect (poll UI/API)
  - Assert dashboard shows Pro; public page has no branding
- Tag as required on PRs touching auth/billing/profile.
**Acceptance**
- Test passes locally and on CI; fails if branding not removed after purchase.

---

## 13) Healthcheck endpoints
**Why:** Faster triage.
**Tasks**
- `/api/health/db` → lightweight Supabase read
- `/api/health/billing` → check `STRIPE_PUBLIC_KEY` presence, optional simple API call (e.g., retrieve product with cached key)
**Acceptance**
- Both endpoints return 200 in staging; surfaced in logs.

---

## 14) Remove dead billing code paths & flags
**Why:** Reduce surface area/bugs.
**Tasks**
- Delete obsolete components, envs, and feature flags related to old billing.
- Update docs/README.
**Acceptance**
- Repo search for previous billing identifiers returns none (except migration history).

---

If you want, I can output these as a **ready-to-import GitHub Issue Markdown bundle** or a **CSV** with `Title,Body,Labels,Assignees`—your pick.

---

## User

I'm noticing a couple issues we're just having consistently is one is like with AI coding anyway is one is AI not leveraging Next.js in some situations like for example using a-links instead of next-links or using image tags instead of next-image. Also not respecting the fact that we're using like post-hoc for feature flags and analytics and writing in random references to like segment or something which we're no longer using. Another one is like not fully leveraging TypeScript, putting in any as the type rather than defining a type, which creates some issues. Another one would be there's a lot of stuff related to server-side rendering and client slash server stuff particularly when it comes to integrating with ClerkAuth and you know properly scoping things and whatnot. Or you know using improper libraries of things when there's a Next.js specific library and it's using the JS library of something. A couple things whether it's not leveraging Tailwind for CSS fully and instead putting in custom CSS which is unnecessary. Some situations where it's not respecting atomic design principles. Which that one is less of a concern for me because we can always refactor later. You know sometimes I guess it's faster to just build the feature and then refactor it into atomic design later and I don't, I'm not opposed to that. But there's sometimes some issues with it just not bothering to like when it designs something not bothering to check to see if dark mode and light mode are accessible. You know sometimes you get situations where in like one of the modes it'll be white text on white or black text on black stuff like that. And so I just want to know are there some rules that we could put in Windsurf to help it respect this stuff. Is that a good idea? Is that a bad idea? And is that going to work? And then also like just yeah I mean yeah how do we, what's the best way to ensure that it kind of like doesn't keep making those mistakes.

---

## Assistant

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
          { group: ['*segment*','*rudder*'], message: 'Only PostHog allowed.' }
        ]
      }
    ],
    // Next.js lint rules:
    '@next/next/no-img-element': 'error',
    '@next/next/no-html-link-for-pages': 'warn',
  }
};
```

## tsconfig.json (strict on)
```json
{
  "compilerOptions": {
    "strict": true,
    "noImplicitAny": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "forceConsistentCasingInFileNames": true,
    "noFallthroughCasesInSwitch": true
  }
}
```

## Analytics wrapper (single entry)
```ts
// src/lib/analytics.ts
'use client';
import posthog from 'posthog-js';

export function init() {
  if (typeof window === 'undefined') return;
  if (!posthog.__loaded) {
    posthog.init(process.env.NEXT_PUBLIC_POSTHOG_KEY!, {
      api_host: process.env.NEXT_PUBLIC_POSTHOG_HOST
    });
  }
}

export const track = (e: string, p?: Record<string, unknown>) => posthog.capture(e, p);
export const isFeatureOn = (key: string) => posthog.isFeatureEnabled(key);
```
> Ban any other direct analytics imports via ESLint rule above.

## Clerk import guard (App Router)
```ts
// OK
import { auth, currentUser } from '@clerk/nextjs/server'; // server
// OK
'use client';
import { useUser, SignInButton } from '@clerk/nextjs'; // client
```

## Pre-commit + CI
**package.json**
```json
{
  "scripts": {
    "lint": "eslint . --ext .ts,.tsx",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "playwright test"
  },
  "lint-staged": {
    "*.{ts,tsx}": ["eslint --fix", "tsc -p tsconfig.json --noEmit"]
  }
}
```
**.husky/pre-commit**
```
pnpm lint-staged
```
**CI gate (GitHub Actions)**
- run `pnpm install`, `pnpm typecheck`, `pnpm lint`, `pnpm test` → fail PR if any.

# 3) SSR/client boundaries

- Add ESLint rule `next/no-async-client-component` and `next/no-assign-module-variable` (included in next/core-web-vitals).
- Create **`/src/lib/server-only.ts`** and **`/src/lib/client-only.ts`** helpers:
```ts
// server-only.ts
import 'server-only';
// client-only.ts
import 'client-only';
```
Import them at the top of files to make intent explicit (helps AI choose correct APIs).

# 4) Tailwind + a11y + theming

- **Tailwind**: keep everything in utilities. If custom CSS, require a **component**.
- **Dark/Light test** (Playwright + axe):
```ts
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

test('pricing has no contrast issues in both themes', async ({ page }) => {
  await page.goto('/pricing');
  for (const scheme of ['light','dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a','wcag2aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  }
});
```

# 5) Ban “any” and force types by construction

- `@typescript-eslint/no-explicit-any: error` (already in ESLint).
- Add a **type barrel**: `src/types/index.ts` and instruct Windsurf to place/reuse types there.
- Provide scaffolds: `ComponentProps<T>`, `Enum` types, API response types.

# 6) PostHog feature flags—server gating pattern

Expose flags on the server (avoid client flicker), hydrate via props:

```ts
// app/(dashboard)/layout.tsx (server)
import { cookies } from 'next/headers';
import { getFlagsForUser } from '@/lib/flags'; // hits DB or PostHog API server-side

export default async function Layout({ children }: { children: React.ReactNode }) {
  const flags = await getFlagsForUser();
  return (
    <FlagProvider initialFlags={flags}>
      {children}
    </FlagProvider>
  );
}
```

# 7) PR template (enforces DoD)
```
### What
- …

### Checklist
- [ ] No <img> / internal <a>; used next/image & next/link
- [ ] No '@clerk/clerk-react'; used '@clerk/nextjs'
- [ ] No 'any'; explicit types added
- [ ] SSR-safe: no window/document in server files
- [ ] Tailwind only; dark & light look acceptable
- [ ] Tests: unit/Playwright updated or N/A
```

# 8) Optional: Danger.js quick checks (CI)
```js
// dangerfile.js
import { danger, fail, warn } from 'danger';

const files = [...danger.git.created_files, ...danger.git.modified_files];

const badImports = ['@clerk/clerk-react','posthog-js','segment','rudder'];
for (const f of files.filter(f=>f.endsWith('.tsx')||f.endsWith('.ts'))) {
  const content = danger.fileContents(f);
  if (/\<img[\s>]/.test(content)) fail(`Use next/image in ${f}`);
  if (/from ['"]@clerk\/clerk-react['"]/.test(content)) fail(`Use @clerk/nextjs in ${f}`);
  if (/from ['"](segment|rudder)/.test(content)) fail(`Analytics not allowed in ${f}`);
}
```

---

### Will Windsurf follow this?
- **Yes**, if you: (1) pin these rules at top, (2) give it the type barrel & wrappers, and (3) fail CI on violations. Agents adapt fast when failures are deterministic and actionable.

### TL;DR playbook
1) Add the **Windsurf guardrails** (above).  
2) Enforce with **ESLint + TS strict + no-restricted-imports**, **husky**, **CI**.  
3) Provide **blessed wrappers** (`analytics`, `flags`, `server-only`, `client-only`).  
4) Add **axe + Playwright** for dark/light.  

If you want, I’ll package this as a PR with all files wired and one sample Playwright test.

---

## User

Okay, we added our health checkpoint for the database, which is currently showing a fail. So we're working on that. Is there a way that we can, can, and or should, and like should we, add a check so that, like, should we check the API health point and see if things that we're doing are breaking it? You know what I mean? Is that worth adding to the test and to have it check that the API health point works, or is that just going to be cumbersome and cause issues?

---

## Assistant

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

---

## User

Okay, we've removed Clark Billing entirely, and we're working on the database issues in Windsurf. I'm going to have Copilot work on adding Stripe Billing. So, what I need is a prompt to break down the installation of Stripe Billing for Copilot. So, I need to ensure that we follow a couple things here. One, everything we do is compatible with Next.js 15, which is what we're using, so we can't break anything. Everything we have to do has to work with Next.js 15. Two, we want to ensure that nothing we do is going to prevent server-side rendering in the future. Although I mostly care about server-side rendering outside of the auth scope, so things on the dashboard and stuff are not a big deal, but things like removing branding from public profiles cannot break server-side rendering. Also, we're using Clark for authentication, and so everything we do has to be compatible with Clark. And then finally, we're using Superbase, so everything has to be compatible with Superbase, and we're using Superbase's third-party auth integration to integrate with Clark, not the old JWT templates, which are depreciated. And so we need to respect all of that. Next, all we're looking for in this, don't worry about pricing tables. All we're looking for in this is adding the ability for a person to upgrade their account within the dashboard. And then go to Stripe checkout, pay, update that user once they've paid to make sure that they're now a pro user in the system. Add a billing portal for them, and we can use a completely Stripe-hosted billing portal. We should do the minimal amount of stuff to get this working. And then the branding on their public profile should turn off. And they should see a pro badge somewhere in their account dashboard. Obviously, follow my Combinator best practices, ship fast, don't break things, and do the minimal implementation we can and lean on Stripe for as much as possible. Integrate with their current stack properly and do things as efficiently as possible.

---

## Assistant

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

---

## User

We should take advantage of potshog as well to ensure feature flags and everything are compatible and users are tagged by their plan and that we dont create unnecessary or redundant code

---

## Assistant

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

---

## User

Okay, let's break it off into some very simple core steps. Like, let's plan it out into minimal tasks that we can do where we can then commit each one and deploy and ensure nothing breaks and then move on to the next step, etc. Okay, let's do that. Okay, let's do that.

---

## Assistant

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
