---
title: "Pay gating setup guide"
type: essay
created: 2025-08-06
updated: 2025-08-06
source: chatgpt-export
conversation_id: 6892aa5d-bc84-8330-8452-677b571d2d7c
message_count: 12
tags: [chatgpt, import, code, long-form]
---
# Pay gating setup guide

> Conversation ID: 6892aa5d-bc84-8330-8452-677b571d2d7c
> Created: 2025-08-06T01:05:34Z
> Updated: 2025-08-06T01:49:21Z
> Messages: 12

---

## User

stripe, stripe checkout, stripe elements, clerk, clerk stripe integration, revenuecat, supabase, next. etc whats the best way for us to go about pay gating some of our features on jovie link in bio product? We want to install in a way that is easy for us to keep building quickly without breaking things. Id be cool with a hosted checkout page rather than building that all ourselves. The less we have to build the better. But I want to do it smart. 

---

## Assistant

Stripe already does 95 % of the heavy lifting for SaaS paywalls, and Clerk now bolts on the missing 5 % (user identity → entitlement) with almost no code. For Jovie, the “least-to-build, hardest-to-break” stack is:

1. **Clerk Billing (B2C)** → talks to  
2. **Stripe Checkout (hosted page)** → fires webhooks to  
3. **Supabase edge functions** that flip a boolean (`is_paid`) or role (`tier = 'pro'`) on the user row.  
4. **Next.js middleware** gates routes with a single `<Gate plan="pro">…</Gate>` component from Clerk’s `use-stripe-subscription` hook.

That gives you a battle-tested checkout, a self-service customer portal, automatic retries, and RLS-level gating without ever touching card data.

---

## 1. Why this combo wins

| Criterion | Stripe Checkout + Clerk Billing | Stripe Elements DIY | RevenueCat Web |
|-----------|---------------------------------|---------------------|----------------|
| **Time to ship** | Minutes—hosted form + clerical entitlements | Days—build UI, state machine, PCI-scope | Hours, but adds a new dashboard |
| **Custom UI need** | Brand colours/logo, that’s it | Full control | Zero (RC hosts the paywall) |
| **Entitlement logic** | `<Gate>` component; Clerk stores Stripe ID in user metadata | You must wire webhooks + DB | Built-in, great for mobile parity |
| **Cost** | Stripe fees + 0.7 % to Clerk | Stripe fees only | Stripe fees + 0.7 % to RC |
| **Break-resistance** | Stripe handles SCA, taxes, upgrades | You own every edge case | Extra moving parts |

Sources: Stripe Checkout docs citeturn4search5, Hosted-page overview citeturn4search8, Clerk Billing B2C guide citeturn2search2, Clerk `<Gate>` hook article citeturn2search3, RevenueCat-Stripe web billing guide citeturn1view0.

---

## 2. Implementation blueprint

### a. Stripe side  
1. In the dashboard, create **Products → Prices** (e.g., *Pro $10/mo*).  
2. Enable **Stripe Tax** and **Customer Portal** (free upsell/upgrade UI).  
3. Create a Checkout “Pricing Table” snippet if you want an embeddable button; otherwise you’ll redirect programmatically. citeturn4search1

### b. Clerk Billing  
1. Toggle **Billing → B2C** in the Clerk console, connect your Stripe account, and map the Stripe price IDs to `plan_slug`s. citeturn2search2  
2. Drop the `<PricingTable />` component or build your own button that calls `redirectToCheckout(priceId)`.  
3. Gate content:  

```tsx
import { Gate } from '@clerk/nextjs';
<Gate plan="pro">
  <ProOnlyComponent />
</Gate>
```

Clerk automatically injects the Stripe Customer → User mapping via webhooks. citeturn2search7

### c. Supabase  
1. Add `tier` column to `auth.users` or a profile table.  
2. In an Edge Function, listen for Clerk user.updated webhook and update that column (or use JWT claims).  
3. Write RLS: `CREATE POLICY "pro only" ON profiles FOR SELECT USING (tier = 'pro');`.

Blog example with Next + Stripe + Supabase webhooks: citeturn0search6

### d. Next.js  
1. Base your repo on Vercel’s **saas-starter** (successor to `nextjs-subscription-payments`) to get tests, CI, and preview environments wired in. citeturn3view0  
2. Keep secrets in Vercel env-vars; use Preview deployments for experiment-safe changes.

---

## 3. Alternatives & when to use them

| Option | Use when… | Notes |
|--------|-----------|-------|
| **Stripe Elements** | You need fully embedded, brand-perfect UI or one-click upsells inside a modal. | More code, manage PCI SAQ A → A-EP. FAQ: less prefab, more control. citeturn0search3 |
| **Payment Links** | One-off charges or you don’t have a backend. | No deep user linking; bad for gated SaaS. citeturn4search3 |
| **RevenueCat Web** | You must sync mobile in-app purchases with web (future iOS/Android apps). | RC mediates receipts across stores; adds another dashboard. citeturn0search0 |
| **DIY Elements + Supabase only** | You refuse third-party billing UI and want zero per-transaction fee. | Expect weeks of edge-case polish; see Stripe vs Elements trade-off. citeturn0search8 |

---

## 4. Safe-launch checklist

1. **Test in Stripe “test mode”** with Clerk’s sandbox—no cards needed.  
2. Add `checkout.session.completed`, `invoice.paid`, `customer.subscription.updated` webhooks to a staging endpoint first.  
3. Feature-flag paid sections in Next.js so shipping unfinished work doesn’t block free users.  
4. Use Vercel Preview ↔︎ Supabase “shadow” branch for DB migrations.  
5. Write an e2e Cypress test: create user → pay → hit `/dashboard` → expect 200; repeat with free user → expect 402/redirect.

---

## 5. TL;DR for Jovie

*Flip the Clerk Billing switch, map your Stripe products, wrap premium routes in `<Gate>`, and let Supabase policies enforce it. You’ll ship a robust paywall before lunch and keep moving fast without duct-taping payments, auth, and entitlements together.*

---

## User

Why not revenue cat?

---

## Assistant

**Short answer:** RevenueCat shines when you must sync iOS / Android in-app purchases with web subscriptions, but Jovie is a **web-only SaaS today**, so RevenueCat would just sit between Stripe and Clerk, add another dashboard, another fee, and a still-beta web SDK—while giving you no benefit you don’t already get from Stripe Checkout + Clerk.  

---

## What RevenueCat is built for  
*   Single source of truth for entitlements across **App Store, Google Play, and web**.citeturn0search4  
*   Remote-config “Paywalls”: tweak copy, prices, A/B tests without code.citeturn0search3  
*   Handles Apple/Google receipt validation, prorations, and cross-platform analytics out of the box.citeturn0search6  

If you launch native apps soon, this is gold.

---

## Why it’s overkill for Jovie right now  

| Issue | Impact on Jovie |
|-------|-----------------|
| **Still need Stripe** | RC Web is just a thin layer over Stripe; you set up the products in Stripe anyway.citeturn0search7 |
| **Web support is in beta** | Official docs and community threads flag Web Billing as “recently launched/beta,” so expect edge-case bugs.citeturn0search0turn1search4 |
| **Extra fee + threshold** | RC is free until \$2.5 k MTR, then 0.7 % on all revenue—on top of Stripe’s 2.9 % + 30¢.citeturn1search0turn0search1 |
| **Duplicate dashboards & webhooks** | You’d pipe Stripe → RevenueCat → Clerk → Supabase instead of Stripe → Clerk, adding latency and another webhook failure mode. |
| **Limited UI control** | RC paywall customization is colors & shapes only; Clerk lets you own the whole React tree.citeturn1search1 |
| **No identity layer** | RC doesn’t manage log-ins—Clerk already binds Stripe customer IDs to users and ships a `<Gate>` component for feature gating. |

---

## When to reconsider RevenueCat  

* **Native apps roadmap** – If you ship iOS/Android and want users to buy on one platform and unlock everywhere, RC unifies receipts and solves Apple/Google edge cases.citeturn1news20  
* **Heavy paywall testing** – Their remote paywall CMS can out-iterate building UIs in Next.js for every copy tweak.  
* **Looking beyond Stripe** – RC just added Paddle billing; if you ever switch processors, RC abstracts that away.citeturn1search9  

---

## Bottom line  

Stick with **Stripe Checkout + Clerk Billing + Supabase RLS** for the current web-only MVP—fast to ship, fewer moving parts, no extra fee or beta risk. Re-evaluate RevenueCat when you have mobile apps or need cross-store receipts; until then it’s unnecessary overhead.

---

## User

Why not stripe prebuilt checkout pages or payment links? Why the extra layer with clerk?

---

## Assistant

**Bottom line, Mr. White:** Stripe’s pre-built Checkout page or a Payment Link is perfect for *taking* money, but they know nothing about *who* paid or *what* that unlocks inside your app. Clerk supplies that missing identity→entitlement bridge so you don’t have to write webhooks, DB updaters, or custom route guards.

---

## 1. What Stripe’s hosted pages already cover  
* PCI-compliant card capture, SCA, Apple Pay, taxes, invoicing, retries, refunds. citeturn0search1  
* One click to create a shareable Payment Link—no code, no backend. citeturn0search0  
* Optional customer-portal so users can self-manage cards and plans. citeturn0search3  

## 2. The gaps you’d still have to patch  
| Needed for Jovie | What you’d code without Clerk |
|------------------|--------------------------------|
| Tie the Checkout session back to the logged-in user | Parse `checkout.session.completed` webhooks, look up the `customer_id`, and update Supabase. citeturn0search7 |
| Store plan/feature flags | Add columns, write an updater, keep JWT claims in sync. |
| Gate pages and API routes | Write custom middleware or sprinkle `if (user.tier!==‘pro’)` everywhere. |
| Handle team accounts later (B2B) | More tables + billing logic. |

Even with Payment Links you still need all of the above—links only fire the same webhooks and don’t return to your app with entitlement data. citeturn0search12turn0search5  

## 3. What Clerk layers on top (in ~5 minutes)  
* **Automatic mapping**: Clerk stores the Stripe `customer_id` on the user record the moment Checkout returns—zero webhook code. citeturn0search4  
* **Feature flags**: Define “pro”, “analytics”, etc. in the Clerk dashboard; get a ready-made `<Gate plan="pro">` React wrapper. citeturn0search9  
* **Role-aware JWTs**: Supabase RLS can rely on `user.plan` without extra syncing.  
* **Unified auth + billing UI**: Same widget style as your sign-in/sign-up, branded once.  

Developers who tried pure Payment Links for SaaS usually hit these hurdles and switch to a user-aware layer or custom code. citeturn0search10  

## 4. When you could skip Clerk  
* **No login app** (e-commerce, donations): a Payment Link alone is fine.  
* **Native mobile next**: Consider RevenueCat instead, as we covered earlier.  
* **Willing to own all webhook + gating code**: Fine if you need zero third-party fees and accept the maintenance load.

---

**TL;DR:** Stripe Checkout or Payment Links handle payments; Clerk turns those payments into roles your Next.js/Supabase stack can understand—saving you from writing and maintaining the glue yourself.

---

## User

okay. We will make a simple 5 buck pro plan to remove branding. No other paid features for now. Give me an ai prompt to roll it out with your recommended setup

---

## Assistant

Below is a ready-to-paste **AI prompt** you can drop into o3/Claude/etc. to generate the code-mod PR that rolls out a single **$5-per-month “Pro” plan that removes the Jovie branding badge**, using **Clerk Billing +B2C → Stripe Checkout → Supabase** exactly as recommended. The prompt assumes your repo is Next 15 (App Router) with Tailwind 4, Supabase client, and Clerk already wired.

---

## One-paragraph recap  

Stripe’s hosted Checkout page covers payment capture and taxes citeturn0search1, while Clerk Billing’s B2C mode automatically maps the resulting Stripe `customer_id` to the signed-in user and exposes a `<Gate plan="pro">` React helper for feature gating citeturn0search0turn0search4. By creating a single Stripe Price (`price_5BUCK_PRO`) and linking it to a `pro` plan slug in Clerk, you can hide the “Made with Jovie” component for subscribers with no custom webhook code citeturn0search6turn0search11. Supabase changes are optional (JWT already contains the plan), but you can add a `tier` column and RLS if you later gate SQL data citeturn0search7.

---

## AI prompt ⬇️  

```markdown
# System
You are an elite Next.js/Tailwind/Billing engineer. Follow atomic-design, keep commits small, and write lint-clean TypeScript.

# Context
Repo: https://github.com/itstimwhite/Jovie  (Next 15 App Router, Tailwind 4, Supabase, Clerk auth)
Goal: Roll out a $5-per-month “Pro” subscription that **removes the Jovie branding badge**. No other paid perks yet.

# Constraints
* Use **Stripe Checkout (hosted)** + **Clerk Billing (B2C)**; no custom card UI.
* Map Stripe Price **price_5BUCK_PRO** → Clerk `plan_slug: "pro"`.
* Keep free tier as default (`plan: "free"` in Clerk).
* All env vars must use Vercel conventions (`STRIPE_PRICE_PRO`, etc.).
* No DB schema change unless absolutely needed.

# Tasks
1. **Stripe**
   * Assume product “Jovie Pro” and Price ID `price_5BUCK_PRO` already exist (monthly \$5).
   * Success URL: `/billing/success`; Cancel URL: current page.

2. **Clerk Config**
   * In `clerk.billing.json` (or dashboard), add:
     ```json
     {
       "plans": [
         { "slug": "free", "name": "Free" },
         { "slug": "pro",  "name": "Pro", "stripe_price_id": "price_5BUCK_PRO" }
       ]
     }
     ```
   * Enable **Billing → B2C** and **Customer Portal**.

3. **Pricing UI**
   * Create `app/(public)/pricing/page.tsx` using Clerk’s `<PricingTable />` component with the single Pro tier.
   * Fallback: a `<Button onClick={() => redirectToCheckout("price_5BUCK_PRO")}>Go Pro – $5</Button>`.

4. **Checkout Route**
   * Add `app/api/stripe/redirect/route.ts` that calls Clerk’s `redirectToCheckout`.
   * After payment, Clerk auto-updates the user; no webhooks needed.

5. **Branding Gate**
   * Wrap `components/BrandingBadge.tsx` export with:
     ```tsx
     import { Gate } from "@clerk/nextjs";
     export default function BrandingBadge() {
       return (
         <Gate plan="free">
           <div className="text-xs opacity-60">Made with Jovie</div>
         </Gate>
       );
     }
     ```
   * Remove any prior hard-coded badge imports and use this new component app-wide.

6. **Middleware (optional)**
   * Add `middleware.ts` to redirect non-pro users hitting `/billing/success` → `/dashboard`.

7. **Supabase (optional)**
   * If future SQL gating is needed, add `tier` claim to JWT via Clerk template and create RLS policy:
     ```sql
     CREATE POLICY "pro_only"
       ON public.analytics
       FOR SELECT USING (current_setting('jwt.claims.tier', true) = 'pro');
     ```

8. **Tests**
   * Cypress e2e: sign-up → pay → expect badge absent.
   * Playwright unit test: `<Gate plan="pro">` visibility.

# Deliverables
* All code changes in a single PR titled `feat: $5 Pro plan`.
* Update `README.md` with **Billing** section: setup steps, env vars, test commands.
* Changelog entry.

# Output
Respond with a step-by-step commit plan followed by the full diff for each modified/new file.
```

---

### How to use  
1. Replace `price_5BUCK_PRO` with the real price ID from your Stripe dashboard.  
2. Paste the prompt into your preferred AI code assistant (OpenAI o3, Claude 3, etc.) and point it at the repo root.  
3. Review & merge the generated PR, then create the Price and enable Clerk Billing in the dashboards.

This delivers a **one-click upgrade flow** and hides Jovie branding for paid users with <100 LoC touched—fast, safe, and future-proof.

---

## User

What env stuff do i need

---

## Assistant

**Key take-away, Mr. White:**  you only need **11 total env vars** to ship the $5 “Pro” plan—and just four ever touch the browser.  Everything else stays server-side, so you stay PCI-scope-free and leak-proof.

---

## 1. Stripe 🔑  

| Variable | Scope | Purpose |
|----------|-------|---------|
| `STRIPE_SECRET_KEY` | **Server** | Your live secret key—needed any time you call the Stripe SDK. citeturn0search6 |
| `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | **Browser** | Lets Checkout.js load safely client-side; safe to expose. citeturn0search6 |
| `STRIPE_WEBHOOK_SECRET` | **Server** | Verifies `checkout.session.completed` payloads if you later add custom webhooks. citeturn0search2turn0search12 |
| `STRIPE_PRICE_PRO` | **Server + Browser** | Stores the price ID (`price_5BUCK_PRO`) so code and UI stay in sync. |

---

## 2. Clerk 🪪  

| Variable | Scope | Purpose |
|----------|-------|---------|
| `CLERK_SECRET_KEY` | **Server** | Authenticates server-side SDK calls. citeturn0search0 |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | **Browser** | Boots the Clerk provider in React; required on every page. citeturn0search20 |
| `CLERK_WEBHOOK_SECRET` *(optional)* | **Server** | Only if you add extra Clerk webhooks later. citeturn0search5 |
| `CLERK_API_KEY` *(optional)* | **Server** | Needed for backend admin scripts (e.g., bulk role changes). citeturn0search21 |

> **Why the NEXT\_PUBLIC prefix?** Next.js only exposes env vars that start with `NEXT_PUBLIC_` to the client bundle; everything else is hidden server-side. citeturn0search4

---

## 3. Supabase 🗄️  *(for future SQL gating)*  

| Variable | Scope | Purpose |
|----------|-------|---------|
| `NEXT_PUBLIC_SUPABASE_URL` | **Browser** | Project URL for the JS client. citeturn0search8 |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | **Browser** | Public anon key for row-level-secured reads. citeturn0search3 |
| `SUPABASE_SERVICE_ROLE_KEY` | **Server** | Only if you run Edge Functions that bypass RLS. citeturn0search13 |

---

## 4. Optional site-wide helpers  

| Variable | Scope | Purpose |
|----------|-------|---------|
| `NEXT_PUBLIC_SITE_URL` | **Browser + Server** | Builds dynamic success/cancel URLs on Vercel Preview & Prod. citeturn0search9 |

---

## 5. Sample `.env.local`

```bash
# --- Stripe ---
STRIPE_SECRET_KEY=sk_live_...
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_PRICE_PRO=price_5BUCK_PRO

# --- Clerk ---
CLERK_SECRET_KEY=sk_live_...
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_live_...
# optional
# CLERK_WEBHOOK_SECRET=whsec_clerk_...
# CLERK_API_KEY=...

# --- Supabase ---
NEXT_PUBLIC_SUPABASE_URL=https://xyz.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=ey...
# SUPABASE_SERVICE_ROLE_KEY=...

# --- Misc ---
NEXT_PUBLIC_SITE_URL=https://jov.ie
```

> **TIP:**  Add each variable under all three Vercel scopes (Development, Preview, Production) so every branch works out-of-the-box. citeturn0search14  

---

## 6. Quick sanity checks  

1. **Front-end builds fail?**  Verify the two `NEXT_PUBLIC_*` Clerk keys exist—build will error without them. citeturn0search20  
2. **Webhook 4xx?**  Confirm `STRIPE_WEBHOOK_SECRET` matches the endpoint in your Stripe dashboard. citeturn0search7  
3. **JWT missing `plan`?**  Make sure Clerk Billing B2C is enabled and mapped to `STRIPE_PRICE_PRO`. citeturn0search17  

Set these once in Vercel, redeploy, and your $5 Pro plan is live with zero extra config.

---

## User

Do i really need strip keys if I have clerk connected to stripe?
Clerk gave me a plan id cplan_30tRJAM0XPd9K9dLrKSemr1D2LL

---

## Assistant

You can skip **Stripe _secret_ keys** if you let Clerk handle everything, but you still need the **publishable key** in the browser so Stripe .js can load—and you’ll want the secret key the moment you touch Stripe directly (custom webhooks, invoices, refunds, etc.).  

---

## Do-I-Need-It Matrix

| Key | Needed when… | Why | Notes |
|------|--------------|-----|-------|
| `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | **Always** (PricingTable, `redirectToCheckout`) | Stripe.js must initialise in the browser. citeturn0search6 |
| `STRIPE_SECRET_KEY` | Only if your *server* calls Stripe APIs (e.g. manual refunds, metered usage, custom email receipts) | Server auth header; Clerk doesn’t expose it. citeturn0search2 |
| `STRIPE_WEBHOOK_SECRET` | Only if you consume Stripe webhooks yourself | Verifies payloads; not required for Clerk-managed flow. citeturn0search12 |
| **Clerk plan ID** `cplan_…` | Always | Tells Clerk which Stripe price to sell; you don’t reference it in code—Clerk does. citeturn0search3 |

---

## What happens in the default Clerk-only flow

1. **Client** calls `redirectToCheckout("cplan_…")`.  
2. Clerk backend creates a Stripe Checkout Session with its own secret key.  
3. User pays → Stripe pings Clerk’s webhook → Clerk sets `plan: "pro"` on the user.  
4. Your frontend sees the updated user object; no Stripe keys or webhooks on your side. citeturn0search10

---

## When you’ll suddenly need the secret key

* **Issuing a prorated refund** from your app UI.  
* **Generating invoices/usage records** from a Supabase cron or edge function.  
* **Migrating customers** (read-only list/transfer).  
If any of those appear on the roadmap, add `STRIPE_SECRET_KEY` now so you don’t redeploy later. citeturn0search4

---

### TL;DR

Keep the **publishable key** in `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` so Checkout loads; ignore the secret key until you need server-side Stripe calls. Clerk’s `cplan_…` ID is all the backend plumbing you need today.
