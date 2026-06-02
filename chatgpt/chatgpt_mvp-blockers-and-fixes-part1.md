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


Okay, I'm just going to dictate some bugs that I'm noticing so far. So, if we log into our staging site, we create a new account. After auth, it forwards us to our production site to go to the dashboard, instead of the dashboard on the staging site. So, if I change the URL back, then I get to the staging site, then I get to the claim. On the user screen, the live validation, where it gives you the green checkmark if you type in a handle that's available. If I type in a handle that's available, I see the green checkmark, then I see the spinner, then I see the green checkmark, then I see the spinner, and then that just repeats continually, even though I'm not typing anything. And it continues to flip between the green checkmark and the spinner, instead of just staying on the green checkmark. Also, there's excessive space in the design above the input on that screen. When I'm clicking create profile, I'm getting user creation failed on an error. Hit retry. I then have to click create profile again, and I get the same error. I assume it's related to a SuperBase connection, because I'm noticing that if I go to any profiles, they're not showing up right now on the staging site. So, I think that the SuperBase connection is not working properly, or something's blocking SuperBase. It looks like it's working, but something that we did must have broken it or something, because it's currently not working. Anyway, so that's blocking, that SuperBase issue is blocking us from getting to profiles, which is a major block, and then also, it's keeping us from getting to the dashboard, which is a major block. Also, the pricing page is still throwing errors. So, that needs to be resolved. Our core requirement for achieving a launchable MVP would be that a user hits the homepage, they type in their handle as the input on the home screen, and claim handle form. They're then taken to the Clark sign-up. They sign up, put their email and password, ask them to verify their email with the code that they got. It then takes them to the onboarding screen, passing along the handle that they put in on the first screen, or if they bypass the first screen, it prompts them for a handle. When they put in the handle, it then takes them to the dashboard, and they're able to finish setting up the profile. And then it should register that user in the database, connect that user to an artist profile with that handle, and when I go to the URL of that handle, I should be able to see their profile. That would be the base minimum for a working MVP, and that's what we need to get to right now. Once we get to that, I would want to add a simple end-to-end test that tests that whole sign-up flow, so that as we add features, we know that they don't get merged in unless they don't break that flow. Next, we would start adding the ability for you to set up payments, so that if you upgrade your account to a pro account, we remove branding. Once we have the ability for you to sign up and remove branding, then I would want to work on making sure that you have the ability to add your social links and all that to your profile, and we can go from there and continue building. But right now, we don't want to focus on any of that until we have the core MVP functionality done. So the goal is for us to ship that core functionality as fast as possible.


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


Okay, I think the other thing we're going to do is we're going to switch to Stripe directly instead of using clerk billing because we're hitting all sorts of issues with it, and I think AI will be better at coding Stripe since it's so well documented. First, I'd like a recommendation for the stack for what we should use for Stripe initially. I was thinking Stripe checkout, but lay out what we need to do just to get, basically, we need a pricing table and a pricing page. We need the ability for you to upgrade your account, check out the credit card, or whatever, and then have our system then know that you've paid, have your accounts status upgraded, and then have the branding disappear from your profile, have you be able to update your payment info, and your credit card, and cancel, and do all that stuff, and then that's basically what we're going to, what we need for now. That's kind of it. We'll feature flag some more features later based on payments, and eventually we'll turn the tipping feature into a direct payment feature where we'll have creators be able to sign up for their own payment accounts and accept payments and stuff, but, and then we'll be taking, you know, fees off the top of that, but for now, for now that's it.


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


Okay, so I'm on the preview branch and looks like we have a simple build error related to post hog. Um, so I need to fix that build error. Okay, so I'm on the preview branch and looks like we have a simple build error related to post hog. So I need to fix that. Okay, so I'm on the preview branch and looks like we have a simple build error related And instead, add a Stripe checkout, um, Stripe billing portable, and a Stripe pricing table to the pricing page. Um, and then do anything that's needed to make sure that Stripe is fully configured for everything we need to get, allow people to upgrade their account. Um, and then we want to build that end-to-end test for the minimal flow. And we want to do that single source of truth for the base URL. Um, break these all out into, um, concise, single objective, um, GitHub issues like, um, Y Combinator would recommend.


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


I'm noticing a couple issues we're just having consistently is one is like with AI coding anyway is one is AI not leveraging Next.js in some situations like for example using a-links instead of next-links or using image tags instead of next-image. Also not respecting the fact that we're using like post-hoc for feature flags and analytics and writing in random references to like segment or something which we're no longer using. Another one is like not fully leveraging TypeScript, putting in any as the type rather than defining a type, which creates some issues. Another one would be there's a lot of stuff related to server-side rendering and client slash server stuff particularly when it comes to integrating with ClerkAuth and you know properly scoping things and whatnot. Or you know using improper libraries of things when there's a Next.js specific library and it's using the JS library of something. A couple things whether it's not leveraging Tailwind for CSS fully and instead putting in custom CSS which is unnecessary. Some situations where it's not respecting atomic design principles. Which that one is less of a concern for me because we can always refactor later. You know sometimes I guess it's faster to just build the feature and then refactor it into atomic design later and I don't, I'm not opposed to that. But there's sometimes some issues with it just not bothering to like when it designs something not bothering to check to see if dark mode and light mode are accessible. You know sometimes you get situations where in like one of the modes it'll be white text on white or black text on black stuff like that. And so I just want to know are there some rules that we could put in Windsurf to help it respect this stuff. Is that a good idea? Is that a bad idea? And is that going to work? And then also like just yeah I mean yeah how do we, what's the best way to ensure that it kind of like doesn't keep making those mistakes.


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


Okay, we added our health checkpoint for the database, which is currently showing a fail. So we're working on that. Is there a way that we can, can, and or should, and like should we, add a check so that, like, should we check the API health point and see if things that we're doing are breaking it? You know what I mean? Is that worth adding to the test and to have it check that the API health point works, or is that just going to be cumbersome and cause issues?


**Topic:** [[chatgpt-clusters/coding_troubleshoot]]
