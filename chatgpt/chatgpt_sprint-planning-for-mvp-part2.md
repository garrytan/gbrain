
Great question, Mr. White — **exactly what YC partners would push you on**: what’s the *ongoing* value of a Founding Member once the “skip the line” moment passes?

Here’s the breakdown:

---

## Year-1 Value (obvious, already strong)
- **Instant access vs. waitlist** → solves urgency.
- **Badge / status** → early adopter cred.
- **Handle guarantee** → they own their preferred handle permanently.

That’s enough for an initial cash-grab / validation. But you’re right: without ongoing value, **renewals will crater**.

---

## How to Create Ongoing Renewal Value
You don’t need to overbuild now — just seed **future entitlements** so you can justify Year 2 billing.

### Options (all low-scope, high-perceived value):
1. **Lifetime perks locked to “Founding Member”**
   - Always keep the badge.  
   - “Never pay the $5/mo remove branding” → effectively, $25/yr buys permanent branding removal (saves them $35/yr).  
   - Free or discounted access to new “Pro” features (tracking pixels, advanced analytics).  
   → This makes Founding Member the *cheapest way* to lock in long-term.

2. **Price lock**
   - Guarantee “Founding Member” never pays more than $25/yr for life.  
   - Regular users see price hikes over time; Founders keep their rate.

3. **Priority access**
   - Early access to new features / betas.  
   - Front of line for handle disputes, support tickets, etc.

4. **Exclusivity / community**
   - Optional: invite-only Slack/Discord, collab directory, “Founding Member” showcase carousel.  
   - Social proof → “you want to be in the 1,000 club.”

---

## MVP Recommendation
**Bundle tangible utility + status**:
- **Skip waitlist NOW** (short-term hook).  
- **Badge & early adopter cred** (status, permanent).  
- **Branding removal included** ($5/mo feature bundled → $60 value vs. $25).  
- **Price lock guarantee** (hedge against future increases).  

That way, renewal = *continued savings* (cheapest plan) + status retention. Even if they don’t care about status in Year 2, the math makes sense.

---

## YC Framing
YC would say: *“Don’t sell futures you can’t deliver. Sell something real now. But don’t burn trust — make sure the $25/yr buys an actual durable benefit.”*  
→ So anchor **Founding Member = “best deal you’ll ever get on Jovie”**. Everything else is upside.

---

Want me to draft copy (landing page + checkout modal) that frames it this way so it feels irresistible *and* explains renewal cleanly?


But people who throw money at the founding member are qualifying themselves as spenders. So we dont want to cap them, we want to upsell them


Exactly, Mr. White — spot on. The **1,000-member cap** was useful as a scarcity gimmick, but the *bigger truth* is:  

> **Anyone willing to drop $25 upfront is self-identifying as a high-value, high-LTV customer.**  

So instead of capping them, you want to:  
- **Onboard them first**,  
- **Lock them into renewal**,  
- **Upsell them into higher tiers / add-ons**.  

---

## Rethink “Founding Member” Mechanics
### ✅ Keep
- **Skip waitlist** = immediate access.  
- **Badge** = status.  
- **Price lock** = they feel smart.  

### ❌ Drop
- Arbitrary cap. Instead: use **time-boxed promo** (e.g., “Founding Member pricing available until Dec 31, 2025”). That drives urgency without limiting whales.

---

## How to Upsell Them Later
1. **Founding Member = baseline**  
   - $25/yr = permanent entry tier. Includes branding removal + badge.  
   - Guarantees they’ll renew just to keep their handle & badge.  

2. **Pro / Growth tiers** (add MRR on top)  
   - Analytics & pixels.  
   - SMS/email fan notifications.  
   - Custom domains.  
   - Collaboration tools (DMs, shared links, etc.).  
   - Start $12–15/mo, rising to $29/mo for power features.  

3. **Add-ons / usage-based billing**  
   - Run paid ads through Jovie.  
   - Premium templates / designs.  
   - Paid fan messaging / CRM features.  
   - Extra profiles / team members.  

---

## Framing
- Founding Member isn’t the ceiling — it’s the **front door**.  
- The “skip waitlist” gets them inside **where you can sell more**.  
- YC-style: don’t put a hard limit on people raising their hand to pay you.  

---

## Suggested Copy
> **Become a Founding Member — $25/year**  
> Get instant access, lock in your handle, remove branding for life, and earn your permanent Founding badge.  
>  
> Founding Members always keep this deal, forever. Want more? Upgrade anytime to Pro for advanced features.

---

Do you want me to re-draft the **Linear issue spec** to reflect this (drop the 1,000 cap, add upsell hooks), so your Stripe agent builds it correctly?


I want to charge more for branding removal, especially early so we get jovie promo


Got it. If your KPI is **MRR + growth loop**, then you’re right: **don’t make branding removal cheap** — especially early when you want Jovie logos plastered everywhere.  

Here’s how YC-style framing works:

---

## 1. Default Path = Free w/ Branding
- Everyone can publish a profile, but **“Made with Jovie”** is *always* visible.  
- That’s your viral promo engine. Every profile = ad for Jovie.  
- YC would say: don’t subsidize turning that off early.

---

## 2. Branding Removal = Premium, not baseline
- Make it at least **$10–15/mo** (instead of $5).  
- Anchor Founding Member as a **better deal** (gets removal included).  
- That way, casuals = free promo, and only serious users pay to hide it.

---

## 3. Founding Member Positioning
- $25/yr = **badge + branding removal included for life**.  
- This makes FM clearly the *smart buy* → you front-load cash + qualify spenders.  
- Regular users who hate branding but miss FM end up paying *much more* ($120–180/yr).  

---

## 4. Upsell Funnel
- **FM ($25/yr)** → “status + cheapest way to remove branding forever.”  
- **Pro ($12–15/mo)** → analytics, pixels, domains.  
- **Enterprise/Growth later** → team features, ad routing.  

---

## 5. Messaging (copy idea)
> **Show the world you’re serious.**  
> Free profiles come with Jovie branding. To remove it, go Pro ($15/mo).  
> Or lock in lifetime branding removal + your Founding Member badge today for just $25/year.

---

### Net Result
- Free users = promo engine.  
- Founding Members = early cash + long-tail renewals.  
- Late adopters who want unbranded = higher ARPU.  

---

Mr. White, want me to **rewrite the Founding Member Linear spec** so it explicitly bundles branding removal (making FM the cheapest way to get it), and set normal branding removal at **$15/mo baseline**? That way your Stripe agent codes the pricing model correctly from the start.


Sure but also you skip waitlist if you're a founding member. Maybe founding ember Is 25 one time? And then we charge monthly upsell to remove branding? 5/months then upsell them to pro for 12,15 later? thoughts?


That’s a strong variant, Mr. White. Let’s lay out the trade-offs clearly so you can decide what to encode in Stripe and how to pitch it:

---

# **Option A — Founding Member Annual ($25/yr, recurring)**  
**Pros**  
- Recurring revenue baked in → renewals without reselling.  
- Bundling branding removal at $25/yr = obvious “cheapest forever deal.”  
- Locks spenders in long-term.  

**Cons**  
- Cheapens branding removal (vs. $15/mo) if you include it.  
- Renewal value must be defended (badge + locked-in perks).  

---

# **Option B — Founding Member One-Time ($25 once)**  
- **Value:**  
  - Skip waitlist.  
  - Claim handle.  
  - Permanent badge.  
  - Status story: *“I was here at the start.”*  

- **Pros:**  
  - Cash injection, low friction.  
  - Super clear psychology: it’s a *ticket* into Jovie, not a subscription.  
  - You’re not on the hook for ongoing perks.  

- **Cons:**  
  - No renewal revenue → you’ve got to upsell them later.  
  - They might feel nickel-and-dimed if removal / Pro is extra.  

---

# **Hybrid Funnel (my reco)**  
1. **Founding Member = $25 one-time**  
   - Skip waitlist, claim handle, get badge.  
   - Feels like buying an *NFT-like ticket / early adopter pass*.  
   - Keeps friction low to say “yes” immediately.  

2. **Baseline plan:** Free w/ branding.  
   - Everyone promotes Jovie until they pay more.  

3. **Upsell path (recurring):**  
   - **Remove branding = $5/mo (intro)** → easy low-end MRR capture.  
   - **Pro = $12–15/mo** → analytics, pixels, custom domain, notifications.  
   - Later: usage-based add-ons (ads, email, SMS, etc.).  

**Psychology:**  
- FM is status, not utility.  
- Monthly branding removal turns into a natural ARPU ladder.  
- Founders pay once, then many will *also* pay monthly to remove branding → you get both cash up-front + recurring.  

---

# YC Lens
YC would likely push:  
- **Charge monthly for functional value (branding removal, analytics).**  
- **Charge once for status (Founding Member).**  
- Don’t undersell yourself by making status = cheap SaaS plan; status is one-time, functional is recurring.

---

⚡ Suggestion:  
- Make **Founding Member = $25 one-time**.  
- Remove branding = $5/mo.  
- Later, Pro = $12–15/mo.  
- Position FM as “skip waitlist + badge forever,” while recurring is where you stack MRR.

---

Want me to rewrite the **Stripe/Linear spec** for your agents so FM is one-time (non-recurring) and branding removal is a monthly subscription, with an upsell path to Pro?


Ok give me a claude code prompt to check our stripe implementation and then continue it to finish this tasks. Outline clearly the founding member flow with the hybrid model.


Here’s a drop-in **Claude Code prompt** you can paste to audit & complete Stripe + the hybrid Founding Member flow. It’s scoped, idempotent, and tells Claude exactly what to ship.

---

**PROMPT FOR CLAUDE CODE**

You are a senior full-stack engineer in a Next.js 15 + TypeScript + Drizzle + Neon + Vercel app (“Jovie”). Your task is to **audit our current Stripe implementation** and **finish the hybrid Founding Member flow**:

- **Founding Member (FM)** = **$25 one-time** (non-recurring). Value: **skip waitlist**, keep **handle**, **permanent badge**. No functional perks tied to renewal.
- **Remove Branding** = **$5/mo** subscription (recurring). Functional entitlement that hides the “Made with Jovie” mark.
- (Later) **Pro** = $12–15/mo (hidden now; create artifacts but don’t surface).

Use **PostHog** for analytics & feature flags, **Sentry** for error telemetry. Follow **idempotency** and **transactional** best practices. Keep changes small, cohesive PRs.

### Repo assumptions
- Next.js app dir, React Server Components, Route Handlers in `/app/api/*`.
- Auth via Clerk; `auth()` returns `userId`.
- DB: Drizzle ORM (Postgres/Neon).
- Feature flags via PostHog SDK.
- Email via Resend.
- CI: preview → main → manual prod promote.

---

## 0) High-level goals (acceptance)
1) **Stripe objects exist & wired**  
   - Products/Prices:  
     - `founding_member_onetime` → **$25 one-time** (Payment Link or Checkout Session w/ `mode: payment`).  
     - `remove_branding_monthly` → **$5/mo**, recurring.  
     - `pro_monthly` → **$15/mo** (create but **HIDE** in UI for now).  
2) **Checkout works**: user can purchase FM or Remove Branding and return to app.  
3) **Webhooks** persist **entitlements** correctly (create/update/revoke).  
4) **Gate**: If `founding_member_gate` is ON and user **lacks FM**, block dashboard with modal offering **Buy FM** or **Join Waitlist**.  
5) **Badge** renders for FM; **branding** hides if Remove Branding active.  
6) **PostHog funnel events** fire; **Sentry** captures errors.  
7) **Docs + tests** included.

---

## 1) Stripe audit & remediation
**Deliverables**
- Create/verify products & prices via Stripe Dashboard OR through `stripe.products`/`stripe.prices` scripts (prefer dashboard; commit JSON snapshots to `/docs/stripe/`).
- Add envs: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_REMOVE_BRANDING_MONTHLY`, `STRIPE_PRODUCT_FOUNDING_MEMBER_ONETIME`, `STRIPE_PRICE_PRO_MONTHLY` (hidden use), `APP_URL`, `POSTHOG_API_KEY`, `SENTRY_DSN`.

**Actions**
- Inspect `/app/api/stripe/*`, `/lib/stripe.ts`, `/lib/db/*`, `/drizzle/*`.  
- Normalize a **single** `lib/stripe.ts` client with proper API version; enforce **idempotency keys** on writes.

---

## 2) Data model (Drizzle)
Create or migrate to:

```ts
// drizzle/000_fm_and_entitlements.sql (or .ts)
-- entitlements: holds feature flags per user allocated via payments
CREATE TABLE IF NOT EXISTS entitlements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  key TEXT NOT NULL,              -- 'founding_member' | 'remove_branding' | 'pro'
  value JSONB,                    -- { stripe_cust, stripe_sub?, price_id, source }
  starts_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ends_at TIMESTAMPTZ,            -- null for one-time FM (no expiry)
  source TEXT NOT NULL DEFAULT 'stripe',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, key)
);

-- waitlist
CREATE TABLE IF NOT EXISTS waitlist (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL,
  desired_handle TEXT,
  referrer TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

Add Drizzle schema + types in `/db/schema.ts`. Generate migration, run locally, confirm.

---

## 3) Founding Member (one-time) flow
**Server endpoints**
- `POST /api/billing/fm/checkout` → creates Stripe Checkout Session with `mode: 'payment'`, `success_url`, `cancel_url`. Attach `client_reference_id=userId`. If user already has FM entitlement, **return 409**.  
- `POST /api/billing/remove-branding/checkout` → creates Checkout Session with `mode: 'subscription'` and `price=STRIPE_PRICE_REMOVE_BRANDING_MONTHLY`.

**Webhook handler** `/api/stripe/webhook` (single route):
- Verify signature; handle (idempotently) events:
  - `checkout.session.completed`  
    - If `mode=payment` and line items include `founding_member_onetime` → **UPSERT entitlement** `{key:'founding_member', ends_at: NULL}`.  
    - If subscription purchase (`remove_branding_monthly`) → **UPSERT** `{key:'remove_branding', ends_at = current_period_end}`; store `stripe_sub`.
  - `customer.subscription.updated` / `...deleted`  
    - Update `remove_branding` entitlement `ends_at` and **revoke** immediately on cancel now/delete.  
  - `charge.refunded`  
    - If FM refund → **delete FM entitlement**. If remove-branding refund → revoke.
- Use **DB transaction** + **idempotency** keyed on `event.id`.

**Frontend gating**
- Hook: `useEntitlements()` → `{ hasFM, hasRemoveBranding }`.  
- Gate logic: `canAccess = !flag('founding_member_gate') || hasFM`.  
- Modal (blocking) when `!canAccess`:  
  - Primary CTA: **Become Founding Member — $25 (one-time)** → calls FM checkout.  
  - Secondary: **Join Waitlist** → POST `/api/waitlist`, then show success.

**Badge + branding**
- In Profile/Dashboard header: show pill “Founding Member”.  
- Branding strip: shown by default; hide when `hasRemoveBranding`.

**Copy (short)**
- Title: **Early access**  
- Body: *Skip the waitlist and secure your handle. Founding Member is a one-time $25.*  
- Primary: **Buy Founding Member — $25**  
- Secondary: **Join Waitlist**

**PostHog**
- `fm_gate_shown`, `fm_checkout_opened`, `fm_purchase_succeeded`, `waitlist_joined`, `rb_checkout_opened`, `rb_purchase_succeeded`.

---

## 4) Remove Branding ($5/mo)
- Settings → “Branding” card:
  - If `!hasRemoveBranding`: CTA **Remove branding — $5/mo** → opens subscription Checkout.  
  - If active: show renewal date + **Manage in Portal** button.
- Customer Portal route `GET /api/billing/portal` → returns Stripe billing portal URL.

---

## 5) Flags, telemetry, emails
- PostHog feature flags: `founding_member_gate` (default ON for launch), `remove_branding_available` (ON).  
- Sentry initialized in client/server.  
- Resend transactional templates:  
  - `email_fm_thanks` (on FM purchase)  
  - `email_rb_active` (on RB purchase)  
  - `email_rb_canceled` (on cancel/refund)

---

## 6) QA & tests
**Unit/integration (Vitest/Playwright minimal):**
- Mock webhook events; assert entitlement rows.  
- Gate behavior snapshot: with/without FM.  
- Branding visibility toggles with RB entitlement.

**Manual smoke (staging):**
1) New user + gate ON → modal shows → FM purchase → lands in dashboard with badge.  
2) New user waitlists → blocked.  
3) RB subscribe → branding disappears; Portal cancel → branding returns within 60s.  
4) Refund FM → badge removed; gate re-applies.

Emit PostHog events and verify in UI.

---

## 7) DX & docs
- `/docs/billing.md`:  
  - Product/price IDs, env var list, webhook setup steps, test matrix, failure modes, rollback.  
- Sample `.env.example` updated.

---

## 8) Guardrails & edge cases
- Prevent duplicate FM purchases (server-side precheck).  
- Handle lowercase/uppercase handle uniqueness (case-insensitive).  
- Rate limit checkout endpoints.  
- Secure success/cancel redirects (origin check).  
- Log + surface webhook failures to Sentry.

---

## 9) Output format
Create a **single PR** with:
- Migrations + schema updates.  
- New/updated API routes.  
- Stripe client + webhook handler.  
- UI: gate modal, badge, branding toggle, settings actions.  
- Docs `/docs/billing.md`.  
- Minimal tests.  
- A brief PR description summarizing acceptance criteria and test steps.

When done, post:
- Product/Price IDs used.  
- Test receipts (last 4 digits of test card).  
- Screenshots/GIFs of gate → FM → dashboard, and RB subscribe/cancel flow.  
- Checklist proving all acceptance criteria.

---

**Constraints**
- Keep it simple, small diffs, conventional commits.
- No new libraries unless essential.
- If anything is missing in the repo, scaffold with sensible defaults and note TODOs in the PR.

**Begin by**:  
1) Scanning current Stripe code & envs.  
2) Listing gaps as a task list in PR description.  
3) Implementing changes in the order: **data → webhooks → checkout endpoints → UI → tests → docs**.


Also tell it use stripe mcp to talk to stripe for product creation etc. and ensure it creates both production and test stuff and then also uses the vercel map to push any env variables needed for both preview and production. Ensure it respects our stack, supports ssr, uses drizzle and neon, and talks to clerk if needed. (But we dont use clerk billing product just auth).


Mr. White — here’s the **updated Claude Code prompt** that (1) checks Stripe, (2) finishes the hybrid Founding Member flow, **and** (3) uses the **Stripe MCP tool** to create **test + live** products/prices/webhooks, then **pushes env vars to Vercel** for **development/preview/production**. It assumes **Next.js 15 + SSR**, **Drizzle + Neon**, **Clerk for auth only**, **PostHog + Sentry**.

---

# PROMPT FOR CLAUDE CODE (STRIPE + MCP + VERCEL ENV)

You are a senior full-stack engineer working in a Next.js 15 (app router, SSR) + TypeScript + Drizzle + Neon + Vercel repo (“Jovie”), with Clerk for auth (not billing). Use **Stripe MCP** (the MCP “stripe” tool) for all Stripe object creation and inspection. Use **Vercel env** to map variables into **development**, **preview**, and **production**. Keep PRs small and idempotent. No new libs unless essential.

## Objectives (acceptance)
1) **Hybrid monetization implemented**:
   - **Founding Member (FM)** = **$25 one-time** (non-recurring): *skip waitlist, claim handle, badge*, no functional perks.
   - **Remove Branding (RB)** = **$5/mo** subscription: hides “Made with Jovie”.
   - (Seed only) **Pro** = **$15/mo** (no UI surfaces yet).
2) **Stripe** fully wired via **MCP**:
   - Create **TEST** and **LIVE** products/prices for FM (onetime), RB (recurring), Pro (recurring).
   - Create **webhook endpoints** for **LIVE** (production domain) and **TEST** (staging/preview stable URL if available; else skip endpoint and document Stripe CLI usage).
   - Return created IDs and secrets; write them to repo docs and **push envs to Vercel** (dev/preview/prod).
3) **Checkout + Webhooks**:
   - Users can buy FM (one-time) and RB (subscription) → entitlements persisted.
   - Portal works for RB (manage/cancel).
4) **Gate + Badge + Branding**:
   - `founding_member_gate`: if ON and user lacks FM → blocking modal (Buy FM or Join Waitlist).
   - Badge shows for FM; branding hides for RB.
5) **SSR-safe**:
   - All secrets server-only (route handlers/server actions). No client exposure.
6) **Telemetry + Flags**:
   - PostHog funnel/flags; Sentry on server/client.
7) **Docs + minimal tests** shipped.

---

## 0) Audit current Stripe & envs
- Search repo for Stripe code (`/app/api/stripe/*`, `/lib/stripe.ts`, etc.), Drizzle schema, and env usage.
- List gaps in the PR description first.

---

## 1) Create Stripe objects via **Stripe MCP**
**Use the MCP “stripe” tool** (not raw HTTP) to create/list resources. Prefer *idempotent names* with a `jovie_` prefix.

### TEST mode (first), then LIVE mode
Create in **test**:
- **Product** `jovie_founding_member_onetime`
  - **Price**: `$25`, `type=one_time`
- **Product** `jovie_remove_branding`
  - **Price**: `$5`, `recurring.interval=month`
- **Product** `jovie_pro`
  - **Price**: `$15`, `recurring.interval=month`

Then mirror in **live** with identical product names.

**MCP calls** (conceptually):
- `stripe.products.create` with `{name, description, metadata}` (test/live).
- `stripe.prices.create` with `{product, unit_amount, currency:'usd', recurring?}`.
- `stripe.webhook_endpoints.create` for **LIVE** pointing to `https://<production-domain>/api/stripe/webhook` (events: `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.payment_failed`, `charge.refunded`). Store the **webhook secret** it returns.

> If preview/staging has a stable URL, also create a **TEST** webhook endpoint. If not, document Stripe CLI setup (`stripe listen`) in `/docs/billing.md`.

**Output**: Capture all IDs/secrets in `/docs/stripe/ids.json` (NOT committed with secrets; commit a sanitized sample and write secrets to Vercel envs only).

---

## 2) Map env vars to **Vercel** (dev/preview/prod)
Use Vercel CLI in the repo root:

For **development** (local) **TEST** keys:
- `STRIPE_SECRET_KEY` (test)
- `STRIPE_WEBHOOK_SECRET` (test, if endpoint created; else leave empty and document CLI use)
- `STRIPE_PRICE_REMOVE_BRANDING_MONTHLY`
- `STRIPE_PRODUCT_FOUNDING_MEMBER_ONETIME`
- `STRIPE_PRICE_PRO_MONTHLY`

Repeat for **preview** (TEST) and **production** (LIVE) with the corresponding IDs/secrets.

Commands (example):
```bash
vercel env add STRIPE_SECRET_KEY production
vercel env add STRIPE_WEBHOOK_SECRET production
vercel env add STRIPE_PRICE_REMOVE_BRANDING_MONTHLY production
vercel env add STRIPE_PRODUCT_FOUNDING_MEMBER_ONETIME production
vercel env add STRIPE_PRICE_PRO_MONTHLY production

vercel env add STRIPE_SECRET_KEY preview
# ...same for preview (TEST IDs)

vercel env add STRIPE_SECRET_KEY development
# ...same for development (TEST IDs)

vercel env pull .env.local
```

**Rule**: `VERCEL_ENV=production` → **LIVE** IDs; `preview|development` → **TEST** IDs.

---

## 3) Drizzle schema (Neon)
Add migrations + schema:

```ts
// db/schema.ts
export const entitlements = pgTable('entitlements', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: text('user_id').notNull(),
  key: text('key').notNull(), // 'founding_member' | 'remove_branding' | 'pro'
  value: jsonb('value'),      // { stripe_cust, stripe_sub?, price_id, source }
  startsAt: timestamp('starts_at', { withTimezone: true }).defaultNow().notNull(),
  endsAt: timestamp('ends_at', { withTimezone: true }),
  source: text('source').default('stripe').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  uq: unique().on(t.userId, t.key),
}));

export const waitlist = pgTable('waitlist', {
  id: uuid('id').defaultRandom().primaryKey(),
  email: text('email').notNull(),
  desiredHandle: text('desired_handle'),
  referrer: text('referrer'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}));
```

Generate/run migration. Add simple `useEntitlements(userId)` query.

---

## 4) Server-only Stripe client & endpoints (SSR-safe)
- `lib/stripe.ts`: single server-only client, API version pinned, **never imported in client**.
- **Checkout endpoints** (Route Handlers):
  - `POST /api/billing/fm/checkout` → `mode:'payment'` for the FM onetime price. If user already has FM, return 409.
  - `POST /api/billing/rb/checkout` → `mode:'subscription'` for RB monthly price.
  - `GET /api/billing/portal` → create billing portal session for current user.

Use **Clerk** `auth()` to get `userId` and (optionally) email for Stripe Customer. We **do not** use Clerk Billing — only auth.

---

## 5) Webhook (single route)
`POST /api/stripe/webhook`:
- Verify signature with `STRIPE_WEBHOOK_SECRET`.
- Handle idempotently (keyed by `event.id`):
  - `checkout.session.completed`
    - If `mode=payment` and FM price → **UPSERT** `entitlements('founding_member')` with `endsAt=NULL`.
    - If subscription (RB) → **UPSERT** `entitlements('remove_branding')` with `endsAt=current_period_end`, store `stripe_sub`.
  - `customer.subscription.updated` / `...deleted`
    - Update/revoke `remove_branding` entitlement.
  - `invoice.payment_failed` → mark grace (optional).
  - `charge.refunded` → revoke corresponding entitlement.

Wrap DB writes in a transaction. Emit PostHog events. Log failures to Sentry.

---

## 6) Gate + Badge + Branding
- **Feature flags (PostHog)**: `founding_member_gate`, `remove_branding_available`.
- **Gate**: In a server layout or top-level RSC, compute `canAccess = !flag('founding_member_gate') || hasFM`. If false, render a **blocking modal**:
  - Primary: **Become Founding Member — $25 (one-time)** → calls FM checkout endpoint.
  - Secondary: **Join Waitlist** → POST to `/api/waitlist`.
- **Badge**: small “Founding Member” pill in dashboard/profile header when FM present.
- **Branding**: “Made with Jovie” shows by default; hidden when RB active.

**Events**: `fm_gate_shown`, `fm_checkout_opened`, `fm_purchase_succeeded`, `waitlist_joined`, `rb_checkout_opened`, `rb_purchase_succeeded`.

---

## 7) Vercel deployment rules
- Ensure secrets only used server-side.  
- CI: preview builds; **no auto-promote to prod**.  
- Add `robots.txt` to block indexing on preview.  
- Confirm SSR (no client fetches Stripe).

---

## 8) Docs & tests
- `/docs/billing.md`:
  - Table of TEST vs LIVE IDs, how they’re mapped in Vercel.
  - How to rotate webhook secrets.
  - Dev: Stripe CLI (`stripe listen --forward-to localhost:3000/api/stripe/webhook`).
  - Failure modes + rollback.
- Tests:
  - Unit: entitlement upserts from mocked webhook events.
  - Minimal e2e: gate behavior, RB toggle visibility.

---

## 9) Deliverables
- PR with: migrations, `lib/stripe.ts`, 3 endpoints (FM checkout, RB checkout, Portal), webhook route, gate modal, badge, branding check, flags/events, docs, tests.
- Comment PR with:
  - Created product/price IDs (TEST & LIVE).
  - Webhook endpoint IDs + the **LIVE webhook secret** (posted only to Vercel env, not the PR).
  - Screenshots/GIFs of FM purchase flow, RB subscribe/cancel, and gate modal.

---

## Guardrails
- Do not expose any Stripe keys or price IDs to client bundles.  
- Rate limit checkout endpoints.  
- Prevent duplicate FM purchases (precheck entitlement).  
- Handle handle-case uniqueness at claim.  
- Idempotency on webhook writes.  
- Respect our stack: **Next.js SSR**, **Drizzle + Neon**, **Clerk auth only**.

**Begin by**:
1) Running MCP to **list** existing products/prices (both test/live) and diff against desired spec.  
2) Creating any missing products/prices via MCP (test first, then live).  
3) Creating LIVE webhook endpoint and capturing the secret.  
4) Pushing envs to Vercel (dev/preview=test, production=live).  
5) Implementing data → webhooks → checkout → gate/UI → tests → docs, in that order.

--- 

If you need anything not present in the repo, scaffold minimally and note TODOs in the PR.


Describe in a prompt what issues windsurf should open for us


Here’s a **Windsurf prompt** you can paste so it auto-opens the right set of issues for this sprint (all scoped, YC-style).  

---

**PROMPT FOR WINDSURF**  

Open Linear/GitHub issues for the following **Paid MVP sprint** (Jovie). Each issue must include: title, description, acceptance criteria, and dependencies. Group them under an epic: **Epic: Paid MVP GA**.  

---

### **Stripe / Billing**
1. **Audit + Normalize Stripe Integration**  
   - Audit existing Stripe code.  
   - Ensure one canonical `lib/stripe.ts`.  
   - Env vars consistent across dev/preview/prod.  
   - AC: All Stripe references centralized, secrets server-only.  

2. **Create Stripe Products/Prices via MCP**  
   - Products: `founding_member_onetime ($25 one-time)`, `remove_branding_monthly ($5/mo)`, `pro_monthly ($15/mo, hidden)`.  
   - Create both TEST and LIVE.  
   - Map IDs into Vercel envs (dev/preview=test, production=live).  
   - AC: IDs available via `process.env.*`, doc in `/docs/billing.md`.  

3. **Implement Checkout Endpoints**  
   - `/api/billing/fm/checkout` → one-time.  
   - `/api/billing/rb/checkout` → subscription.  
   - `/api/billing/portal` → billing portal.  
   - AC: Returns working sessions; prevents duplicate FM.  

4. **Webhook Handler for Entitlements**  
   - Handle events: `checkout.session.completed`, `customer.subscription.updated`, `...deleted`, `invoice.payment_failed`, `charge.refunded`.  
   - Upsert entitlements table.  
   - AC: DB reflects correct state; idempotency keys enforced.  

5. **Drizzle Migrations: Entitlements + Waitlist**  
   - Add `entitlements` table and `waitlist` table.  
   - AC: Migration applied to Neon; types generated.  

---

### **Frontend / UX**
6. **Founding Member Gate Modal**  
   - If `founding_member_gate=ON` and user lacks FM, show blocking modal.  
   - Primary CTA: Buy FM ($25). Secondary: Join Waitlist.  
   - AC: Modal blocks dashboard until FM or waitlist join.  

7. **Founding Member Badge**  
   - Display badge in dashboard + public profile.  
   - AC: Badge only renders for users with FM entitlement.  

8. **Branding Removal Toggle**  
   - “Made with Jovie” shown by default.  
   - Hide if `remove_branding` entitlement present.  
   - AC: Branding toggles instantly after payment/cancel.  

9. **UI Polish: Dark Mode Toggle + Skeletons**  
   - Fix debounce/race bug.  
   - Skeleton loaders match final components.  
   - AC: No dead toggles; skeletons consistent.  

---

### **Infrastructure / Ops**
10. **Vercel Env Sync**  
    - Push all Stripe secrets + IDs to Vercel envs (dev/preview/prod).  
    - AC: `vercel env pull` yields correct `.env.local`.  

11. **PostHog Funnel + Feature Flags**  
    - Events: `fm_gate_shown`, `fm_checkout_opened`, `fm_purchase_succeeded`, `waitlist_joined`, `rb_checkout_opened`, `rb_purchase_succeeded`.  
    - Flags: `founding_member_gate`, `remove_branding_available`.  
    - AC: Events/flags live in dashboard.  

12. **Sentry Telemetry**  
    - Ensure client + server DSNs live.  
    - AC: Errors visible in Sentry dashboard.  

---

### **Docs / Tests**
13. **Billing Docs**  
    - `/docs/billing.md`: IDs, env mapping, webhook setup, Stripe CLI instructions.  
    - AC: Anyone can reproduce setup from docs.  

14. **Test Suite for Entitlements**  
    - Mock webhook events; assert entitlements DB writes.  
    - E2E: FM gate, FM purchase → badge, RB subscribe/cancel → branding toggles.  
    - AC: Tests pass in CI.  

---

Do not over-scope. Each issue must be ≤ 2 days. Create dependencies (e.g., webhook depends on entitlements migration).  

---  

Mr. White — do you want me to also generate the **titles + descriptions formatted as Linear tickets** so you can paste them directly, or keep them as this Windsurf prompt?


Should founding member be a verified badge instead?


Good instinct, Mr. White — the **badge choice** matters a lot for positioning. Let’s weigh it:

---

## 🔹 Founding Member Badge
**Pros**  
- Signals early adopter / insider status.  
- Creates FOMO: “I was there first.”  
- Simple to implement (text or pill).  

**Cons**  
- Loses luster over time — in year 2 or 3, being “Founding” is less meaningful to new users.  
- Harder to upsell later, because the value is frozen in history.  

---

## 🔹 Verified Badge (FM = auto-verified)
**Pros**  
- Verification is **perennial value** — always desirable.  
- Users can flaunt it forever → retention anchor.  
- Gives you a **ladder**:  
  - Free = no badge.  
  - FM = Verified instantly.  
  - Later, you can monetize verification separately ($X/mo or included in Pro), but FM stays grandfathered.  
- Status that *scales* — doesn’t expire like “Founding.”  

**Cons**  
- You’ll need to be careful not to cheapen “verification” if you plan to sell it later.  
- Requires clarity: “Verified via Founding Member purchase before launch” vs. “Verified via review/system later.”  

---

## Hybrid Play (best of both worlds)
- **FM purchase ($25 one-time)** grants:  
  - **Skip waitlist + claim handle**  
  - **Verified badge** (status that persists & keeps value)  
  - Profile note in dashboard: “Founding Member” (visible only to user, or in About panel, not on profile face)  

This way:  
- Users get a **public badge that always matters (verified)**.  
- You still get to nod to early adopters with “Founding” in-app.  
- You avoid the FM badge aging out as a weak status signal.  

---

## YC-Style Lens
- YC would say: *“Badges are marketing. Which one helps you grow?”*  
- Verified → continues to show value on every profile, year after year.  
- FM alone → marketing story for 6–12 months max.  

---

⚡ Recommendation: **Founding Members get “Verified” as their permanent badge.**  
Internally, they also see “You’re a Founding Member,” but what the world sees is “Verified.” That gives them lasting prestige and you lasting upsell headroom.  

---

Want me to rewrite your **Founding Member flow spec** so it **outputs a Verified badge publicly** and treats “Founding Member” as a private perk (dashboard copy, email receipt), so your Stripe agent codes it right?


Do verified and give me the new list for ux items. Also the footer branding is Jovie Claim your profile


Got it, Mr. White. With **Verified replacing Founding Member badge** and the new **footer branding copy** (`“Jovie — Claim your profile”`), here’s the updated **UX issue list** for your sprint:  

---

# **UX Issues (Updated for Verified Badge)**  

### 1. **Founding Member Gate Modal**  
- **Trigger:** If `founding_member_gate = ON` and user has no FM entitlement.  
- **Content:**  
  - Title: **Early access**  
  - Body: *Skip the waitlist, claim your handle, and get Verified.*  
  - Primary CTA: **Get Verified — $25 (one-time)** → calls FM checkout.  
  - Secondary CTA: **Join Waitlist** → saves email + desired handle.  
- **AC:** Blocks dashboard until FM purchased or waitlist joined.  

---

### 2. **Verified Badge Rendering**  
- **Public Profile:** Blue-style checkmark (Linear-style minimal) next to handle. Tooltip: *Verified on Jovie*.  
- **Dashboard Header:** Show Verified check. Tooltip: *Verified (Founding Member)*.  
- **Notes:** Verified = **permanent** once FM is purchased.  

---

### 3. **Profile Footer Branding**  
- Default for all **free users:**  
  - Small footer line: *“Jovie — Claim your profile”* (linked to landing).  
- When `remove_branding` entitlement active:  
  - Footer hidden.  
- **AC:** Branding visible on every free profile page; hidden instantly after RB subscription or cancel event.  

---

### 4. **Waitlist Flow UI**  
- Simple form: email + desired handle.  
- Success state: *“Thanks! You’re on the waitlist. We’ll notify you when your profile is ready.”*  
- **AC:** Prevents dashboard access; stores entry in DB.  

---

### 5. **Dark Mode Toggle Fix**  
- Remove debounce/race condition.  
- **AC:** Toggle responds <200ms, two-way.  

---

### 6. **Skeleton Loaders (Atomic)**  
- Add skeletons to all profile atoms (avatar, handle, links, CTA).  
- **AC:** No layout shift or mismatch.  

---

### 7. **Toast Notifications**  
- Unified toast system (success, error).  
- Examples: *“Profile updated”*, *“Payment successful”*.  
- **AC:** Works across app; dismissible.  

---

### 8. **CTA Logic (No-DSP Fallback)**  
- If no music links → primary CTA becomes *“Follow”* (social).  
- If video/stream links → CTA = *“Watch”*.  
- **AC:** Profiles always show a meaningful CTA.  

---

### 9. **Error & Empty States**  
- Avatar upload fail → fallback image + toast.  
- Empty profile → instructive placeholder text.  
- **AC:** No broken UI, always graceful fallback.  

---

Do you want me to also **redraft the Linear UX issues** with full titles + acceptance criteria (ready to paste), or keep them in this list format?
