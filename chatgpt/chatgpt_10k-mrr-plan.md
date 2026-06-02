---
title: "10k MRR plan"
type: note
created: 2025-08-07
updated: 2025-08-07
source: chatgpt-export
conversation_id: 68952326-e5f8-832c-80df-ec1dd47fb5d9
message_count: 4
tags: [chatgpt, import, long-form]
---
# 10k MRR plan

> Conversation ID: 68952326-e5f8-832c-80df-ec1dd47fb5d9
> Created: 2025-08-07T22:05:41Z
> Updated: 2025-08-07T23:35:37Z
> Messages: 4

---

## User

Lay out a plan for me to get to 10k MRR ASAP

---

## Assistant

Alright, Mr. White — let’s get surgical.  
We’ll use a “speed-to-revenue” playbook that prioritizes **fast validation, recurring cash flow, and compounding acquisition**. I’ll assume this is for Jovie unless you tell me otherwise.  

---

## **Phase 1 – Nail the $ → Don’t Overbuild** (Week 1–2)
**Goal:** Validate people will pay *now*, not “when it’s ready.”  

1. **Freeze new features** — Only ship what directly enables payment.  
2. **Define the $5–50/mo “Pro” hook** — Single clear value prop (e.g., remove branding, unlock pro analytics, VIP link types).  
3. **Hot-list 50–100 target customers** — Artists already on Linktree/Linkfire who look like they’d benefit from better UX or cheaper pricing.  
4. **Pitch manually** — Cold DM/email them a *done-for-you migration* to Jovie, offer them 2–3 months free for feedback *if* they put a card down today.  
5. **Close first 20 paying customers** — Even if tiny MRR, this is your proof.

---

## **Phase 2 – Sell Before You Scale** (Week 3–5)  
**Goal:** $1–2k MRR from high-conversion manual sales.  

1. **Productized onboarding** — Turn your manual migration into a simple form + Loom walk-through.  
2. **Basic referral engine** — $10/mo account credit per referral. Track manually if needed.  
3. **Target creators with leverage** — TikTok music coaches, indie artist communities, small labels. Offer them affiliate rev share (20–30%).  
4. **Start content drip** — Weekly 30–60s TikToks/IG Reels of “Smart link hacks” → CTA to Jovie.

---

## **Phase 3 – Pour Fuel** (Week 6–10)  
**Goal:** $5k MRR by scaling the channels that worked in Phase 2.  

1. **Automate onboarding + billing** — Stripe Checkout, Clerk auth, minimal CRM.  
2. **Launch in marketplaces** — Spotify App Directory, Linktree alternative lists, Product Hunt.  
3. **Run ultra-targeted ads** — $10–20/day at indie musicians in the US/UK/Aus. Test only 3–5 creatives.  
4. **Land 2–3 bigger accounts** — Labels, agencies, artist managers who can bring in 20–50 artists each.  
5. **Leverage testimonials + case studies** — Publish “How X artist grew streams 35% with Jovie.”

---

## **Phase 4 – Compounding Growth Loop** (Month 3–6)  
**Goal:** Hit $10k MRR by multiplying LTV × acquisition.  

1. **Upsell** — $29–49/mo tiers for more links, analytics, SMS fan alerts.  
2. **Affiliate army** — Any artist on Jovie gets rev share to onboard their friends.  
3. **Integrations** — Bandsintown, Mailchimp, Shopify for merch.  
4. **Retargeting** — Retarget profile visitors who *aren’t* subscribed yet.  
5. **Expand beyond music** — Creators in comedy, acting, modeling who also need high-converting bio links.

---

## **Expected Ramp if You Push Hard**
- **Month 1:** $1–2k MRR (manual hustle, early adopters)  
- **Month 2:** $4–5k MRR (referrals, first affiliates, targeted ads)  
- **Month 3:** $8–10k MRR (larger accounts, expanded audience)

---

If you want, I can map out **exact daily actions for the first 30 days** so you’re stacking revenue from day 1 instead of waiting for the “perfect” launch. That would get you to $10k faster than just having phases on paper.

---

## User

Lay out comprehensive plan for phase 1.  Look at where our code is: https://github.com/itstimwhite/Jovie

---

## Assistant

Got it, Mr. White. Here’s a tight, do-first **Phase 1 (Weeks 1–2)** plan wired to your repo’s current stack: **Next 15, Supabase, Clerk (with Stripe billing), Statsig flags**. citeturn1view2

# Phase 1 Objectives (2 weeks)
- **Collect money now** with a single, obvious Pro benefit: **remove Jovie branding** (already supported in your Billing section). citeturn1view2  
- **Close 20–30 paying artists** via manual outreach + done-for-you migration.  
- **Prove activation → retention loop** with minimal analytics & support.

---

# Engineering — what to ship (and where)

## 1) Turn on billing & plan gating (Day 1–2)
- **Env:** set  
  `NEXT_PUBLIC_CLERK_BILLING_ENABLED=true`  
  `NEXT_PUBLIC_CLERK_BILLING_GATEWAY=stripe`  
  and your Clerk/Stripe keys already listed in README/env. citeturn1view1
- **Plans (Clerk Billing → Stripe gateway):** one “Free” (branding on) + one “Pro $5/mo” (branding off). Your README’s flow: Clerk billing → Stripe → user metadata → **hide BrandingBadge for Pro**. Ensure this actually gates in code on every public profile render. citeturn1view2
- **UI entry points:**  
  - Add a **/pricing** page under `app/(marketing)/pricing/page.tsx` with one CTA: **“Go Pro – $5/mo”** → Clerk billing portal.  
  - Add **“Remove branding”** CTA in `app/dashboard/*` header and in the **BrandingBadge** hover state on public profiles.
- **Server check:** centralize `isPro(user)` in `lib/billing.ts` reading Clerk public metadata (set by webhook) and SSR gate in profile pages.
- **Webhooks:** in `app/api/webhooks/billing/route.ts` (or existing API routes), handle `subscription.created|updated|canceled` to flip `user.metadata.plan` and mirror basics in Supabase `users` table for redundancy (read-only cache).

**PR: “Enable Pro plan + SSR gating”**  
Checklist: envs, pricing page, dashboard CTA, metadata mapping, webhook tests, e2e happy path.

---

## 2) Feature-flag the risky bits (Day 2)
You already document Statsig usage + current flags. Add:  
- `pro_cta_enabled` (Gate) – show upgrade CTAs across app.  
- `billing_nav_enabled` (Gate) – show Billing in dashboard sidebar.  
- `promo_free2mo_enabled` (Gate) – for manual deals in outreach.  
Wire with your `useFeatureFlags()` helper already described in README. citeturn1view1

**PR: “Billing flags”**  
Checklist: flags, defaults, component guards, kill-switch in prod.

---

## 3) “Done-for-you migration” intake (Day 3)
- **Fastest path:** new route `app/migrate/page.tsx` → short form: current link-in-bio URL + Spotify artist URL + email + notes.  
- Store to Supabase `migrations` table; send you a Discord/Slack ping via simple webhook.  
- After submit: success page with **Calendly** link (15-min setup call) + **“Start 2 months free (card required)”** button → Clerk billing checkout.

**PR: “Migration intake form”**  
Checklist: table, form, validation, success flow, event logging.

---

## 4) Analytics you’ll actually use (Day 3–4)
- Add **Vercel Analytics** (already in stack) for funnel pages and a basic **/analytics** dashboard panel: Visits → Signups → Checkout → Active Pro. citeturn1view2
- Add a `click_events` insert on pricing CTAs (schema reference exists in README). citeturn1view1

**PR: “Minimal revenue funnel analytics”**  
Checklist: client events, SSR counters, one dashboard chart.

---

## 5) Harden auth + onboarding seams (Day 4)
- Make **claim-handle first**: homepage input `@handle` → Clerk auth → onboarding step to link Spotify artist → dashboard.  
- If no Venmo set, hide /tip routes (your README mentions a tip jar feature flag—keep it off for Phase 1). citeturn1view2

**PR: “Handle-first onboarding”**  
Checklist: input → auth → claim artist → dashboard, e2e test.

---

# GTM — what to do this week to close $$$

## 6) Targets & offer (Day 1)
- **List 150 artists** already on Linktree/Linkfire w/ recent activity (TikTok/IG). Start US first.  
- **Offer:** Pro $5/mo, **2 months free if you put a card down today**, **we migrate your links for you in 24 hours**.

## 7) Outreach scripts (Day 2–10)
- **DM (short):**  
  “Hey \[Name], I built **Jovie**—a faster link-in-bio for musicians. I’ll **migrate your current page for free** and comp **2 months** if you drop your card today. Want me to set it up? Example: jov.ie/\[artist].”
- **Email (short):**  
  Subject: “I’ll rebuild your link-in-bio by tomorrow”  
  Body: 3 bullets (speed, auto-routing to DSPs, analytics) + “Reply YES, I’ll do the rest. 2 months free for early users.”

## 8) Onboarding playbook (Day 3–10)
- When a lead says yes → send `/migrate` form → **book 15-min call** → **start checkout** (Clerk billing) **before** migration.  
- After Stripe succeeds → you duplicate their tree manually (fast), set handle, push live, reply with a shareable preview link.  
- Ask for **one testimonial sentence + permission to logo**.

## 9) Light referral loop (Day 7–14)
- Tell every new Pro: “**Get a free month per referral**—have them enter your handle at checkout.”  
- Implement as a text field in billing checkout (read via webhook, credit both users via metadata note), no full affiliate infra yet.

---

# Day-by-Day (first 14 days)

**Day 1:** Env + flags + pricing page; compile 150-artist lead sheet. citeturn1view1turn1view2  
**Day 2:** Wire Clerk↔Stripe webhooks & SSR gating; ship upgrade CTAs; send first 40 DMs/emails. citeturn1view2  
**Day 3:** Ship `/migrate` intake; add Calendly; 40 more DMs; 3–5 calls.  
**Day 4:** Handle-first onboarding; basic funnel analytics; publish 1 Loom demo. citeturn1view2  
**Day 5:** Close first 10 subs; migrate their pages; collect 3 testimonials.  
**Day 6–7:** 80 more DMs; 5–8 calls; ship referral text field in checkout.  
**Week 2:** Repeat daily: 40 DMs + 3–5 calls; post 3 creator-tips Reels with Jovie CTA; close 20–30 total.

**Targets:** 30–50 trials with card → 20–30 active at end of free period → **$100–150 MRR locked** (tiny but proven). Scale in Phase 2.

---

# QA / CI you need “on” for Phase 1
- **Playwright e2e**: Signup → claim handle → connect Spotify → upgrade → profile renders without BrandingBadge when Pro.  
- **Vitest unit** for `isPro()` and webhook handlers.  
- **Danger/Commitlint** stays as-is; only block merges if e2e green on `develop` → auto-PR to `preview`. (You already surface CI/quality badges & pipeline status in README—keep them passing.) citeturn0view0

---

# What I need from you today
1) Confirm price: **$5/mo** (no annual yet).  
2) Send me your Stripe product/price IDs (or the Clerk plan IDs) and I’ll map them. Your README already expects Clerk-billing-with-Stripe. citeturn1view2  
3) Green-light the **2 months free (card required)** offer flag.

Want me to draft the exact PR templates and a 1-page outreach tracker (Notion or Google Sheet)?
