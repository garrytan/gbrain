---
title: "Storybook setup guide"
type: essay
created: 2025-08-20
updated: 2025-08-20
source: chatgpt-export
conversation_id: 68a60daa-48e8-832b-8407-161b9f7c07de
message_count: 22
tags: [chatgpt, import, code, long-form]
---
# Storybook setup guide

> Conversation ID: 68a60daa-48e8-832b-8407-161b9f7c07de
> Created: 2025-08-20T18:02:26Z
> Updated: 2025-08-20T20:44:39Z
> Messages: 22

---

## User

We want to add storybook so we can easily look at all our components and ui stuff especiallyw hats behind auth. But we want to keep it YC approved and light and fast. 

---

## Assistant

Got it, Mr. White. Here’s a lean, YC-style Storybook plan for a Next.js 15 + Tailwind + Clerk/Supabase stack—fast to add, light to run.

# Goal
Preview every UI piece (incl. “behind auth”) without touching prod, with minimal deps and zero vendor lock-in.

# Install (minimal)
- `@storybook/nextjs` (Vite builder default)
- `@storybook/addon-essentials` (actions, controls)
- `@storybook/addon-interactions` (play fn)
- Optional but tiny: `@storybook/addon-a11y` (cheap quality win)

# Structure
- Keep stories outside `/app` so they never ship: `/ui/**` and `/stories/**`.
- One file per component: `Component.stories.tsx` close to source.
- Fixtures in `/fixtures/**` to reuse across stories/tests.

# Config (keep it light)
- Framework: `@storybook/nextjs` (Vite)
- Addons: essentials, interactions (+ a11y optional)
- Import Tailwind once in `preview.ts` (from your existing `globals.css`)
- Turn on on-demand story loading; disable heavy docs in dev (use MDX only where needed).

# Auth-gated UI (mocked, not real)
Create a Storybook decorator that fakes auth:
- **Clerk**: wrap with `ClerkProvider` and stub `useUser()`/`useAuth()` via context mocks so components “think” a user exists.
- **Supabase**: provide a lightweight context that returns a fake session/user and mock data fetch fns. Don’t hit network; return fixtures.

Provide two global toolbar toggles:
- `Auth: signed-out | signed-in | admin`
- `Theme: light | dark` (reads your app theme provider)

# Next.js specifics
- Next/Image handled by `@storybook/nextjs`; set `unoptimized` in SB only.
- If any server components creep in, expose a thin client wrapper for Storybook (keeps SB fast).

# Performance hygiene
- No Chromatic/visual CI for now.
- Docs addon: off by default; on only for a few public components.
- MSW only if you truly need API flows; otherwise return fixtures.
- Cache node_modules and SB cache in CI; run SB only on PRs that touch `/ui|/stories|/fixtures`.

# Scripts
- `storybook`: dev-only
- `build-storybook`: optional, on demand (preview deploy if you want)

# “Do it for me” prompt (drop into Copilot/Claude Code)
“Add Storybook v8 to our Next.js 15 app with Vite builder using `@storybook/nextjs`. Keep it minimal: essentials + interactions (+ a11y). Configure stories in `/stories` and `/ui` (never under `/app`). Import Tailwind `globals.css` in `preview.ts`. Add a global decorator that mocks Clerk (`useUser`, `useAuth`) and Supabase session using fixture data; add toolbar controls for `authState` (signed-out/signed-in/admin) and `theme` (light/dark). Ensure Next/Image is unoptimized in Storybook only. Disable heavy docs by default; enable MDX docs only for a couple of public components. Provide example stories for Button, Avatar, and an auth-gated DashboardCard showing all `authState` permutations via `play` tests. Add npm scripts: `storybook` and `build-storybook`. Ensure stories are excluded from the production bundle and pages. No network calls—use fixtures. Keep the dependency footprint minimal and build time fast.”

---

## User

{'asset_pointer': 'file-service://file-NtnYjV1129oYWQYxHGBXyg', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 956, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 805078, 'width': 1470}
This menu keeps flickering when hovering over the product link in the header nav

---

## Assistant

Mr. White — classic “hover gap” + unmount flicker. Fix it with one of these tiny patterns (pick A if you want bulletproof):

# A) Floating UI (best, 2 deps, no flicker)
- `@floating-ui/react` with `useHover({ handleClose: safePolygon({ buffer: 4 }) })`
- Keeps the menu open while the cursor moves from trigger → panel, even across tiny gaps.

```tsx
import {useFloating, offset, flip, shift, useHover, useInteractions, safePolygon} from '@floating-ui/react';
function ProductMenu() {
  const [open, setOpen] = useState(false);
  const {refs, floatingStyles, context} = useFloating({open, onOpenChange: setOpen, middleware:[offset(8), flip(), shift()]});
  const hover = useHover(context, {handleClose: safePolygon({buffer:4}), delay:{open:100, close:180}});
  const {getReferenceProps, getFloatingProps} = useInteractions([hover]);

  return (
    <div className="relative">
      <button ref={refs.setReference} {...getReferenceProps()} className="nav-link">Product</button>
      {open && (
        <div ref={refs.setFloating} style={floatingStyles} {...getFloatingProps()}
             className="z-50 rounded-xl border border-white/10 bg-neutral-900/80 backdrop-blur p-4 shadow-lg will-change-transform data-[state=closed]:opacity-0 data-[state=closed]:scale-95 transition">
          {/* menu items */}
        </div>
      )}
    </div>
  );
}
```

# B) Tiny “hover intent” (no new deps)
- Open delay 100–150 ms, close delay 180–250 ms.
- Keep menu mounted; toggle classes only.

```tsx
function useHoverIntent() {
  const [open, setOpen] = useState(false);
  const openT = useRef<NodeJS.Timeout>(); const closeT = useRef<NodeJS.Timeout>();
  return {
    open,
    onEnter: () => { clearTimeout(closeT.current); openT.current = setTimeout(()=>setOpen(true), 120); },
    onLeave: () => { clearTimeout(openT.current); closeT.current = setTimeout(()=>setOpen(false), 200); },
  };
}

function ProductMenu() {
  const {open, onEnter, onLeave} = useHoverIntent();
  return (
    <div className="relative" onMouseEnter={onEnter} onMouseLeave={onLeave} onPointerEnter={onEnter} onPointerLeave={onLeave}>
      <button className="nav-link">Product</button>
      <div className={cn(
        "absolute left-0 z-50 mt-2 w-80 rounded-xl border border-white/10 bg-neutral-900/80 backdrop-blur p-4 shadow-lg transition origin-top",
        open ? "opacity-100 scale-100 pointer-events-auto" : "opacity-0 scale-95 pointer-events-none"
      )}>
        {/* menu items */}
      </div>
    </div>
  );
}
```

# C) “No-gap” hitbox (CSS-only assist)
- Wrap trigger + panel in one `.group relative`.
- Absolutely position panel **inside** that wrapper.
- Add a 6–8px invisible bridge so the cursor never “leaves”.

```tsx
<div className="relative group">
  <a className="nav-link">Product</a>
  <div className="absolute left-0 mt-2 ... opacity-0 scale-95 pointer-events-none group-hover:opacity-100 group-hover:scale-100 group-hover:pointer-events-auto">
    {/* menu */}
  </div>
  <span className="absolute left-0 right-0 top-full h-2" aria-hidden /> {/* bridge */}
</div>
```

# Hardening checklist (do all of these)
- Keep the panel **mounted**; hide with opacity/scale + `pointer-events-none`.
- Ensure the panel is inside the same `relative` container as the trigger; no overflow clipping.
- Add `will-change: transform` and use `transform/opacity` only (no layout thrash).
- Use `backdrop-blur` sparingly; combine with `bg-…/80` to reduce paint cost.
- On mobile: switch to click/tap toggle (no hover).

If you paste your `Header/Nav` component, I’ll patch it to A or B directly.

---

## User

Lets do a

---

## Assistant

I swapped your flickering hover logic with **Floating UI’s `useHover` + `safePolygon`** pattern (option A). This keeps the dropdown stable when moving between the “Product” link and the menu. It now animates smoothly with `opacity/scale` instead of unmounting.  

Want me to wire in your actual menu items so it’s fully ready to drop in?

---

## User

Download all the images so we can drop them in locally

---

## Assistant

Looks like I can’t fetch those images directly here (network restrictions blocked the Spotify CDN).  

Here’s how you can grab them locally yourself:

### 1. Command line (quick)
```bash
mkdir -p jovie_avatars
cd jovie_avatars

urls=(
  "https://i.scdn.co/image/ab6761610000e5eb7f33b92be7bfa3a7edccf9f6"
  "https://i.scdn.co/image/ab6761610000e5eb8a5b8f6b893881c7b6d2b7b4"
  "https://i.scdn.co/image/ab6761610000e5eb4a3f7cfa0b1e2e0f9a6c1d3a"
  "https://i.scdn.co/image/ab6761610000e5eb1b8b5e6b8e1c1b6c1d3a2d6a"
  "https://i.scdn.co/image/ab6761610000e5eb02eac6f7dfb1

---

## User

We should have storybook stories made for which atomic design components

---

## Assistant

Here’s the lean, YC-style Storybook hit list for Jovie—atomic design, highest impact first.

# P0 (do these now)
**Atoms**
- Button (variants, sizes, loading/disabled, icon-only)
- TextField & TextArea (label, help, error, success, with prefix/suffix)
- Select & Combobox (searchable)
- Toggle/Switch, Checkbox, Radio
- Link & NavLink (active/hover/focus)
- Badge/Tag/Chip
- Tooltip & Popover
- Avatar (image, initials, fallback)
- Icon (shared wrapper), Skeleton, Spinner
- Banner/Alert (info/success/warn/error)

**Molecules**
- InputGroup (with icon, validation)
- DropdownMenu (Product menu) — hover + safePolygon mock
- Modal/Dialog (confirm, form)
- Tabs & SegmentedControl
- Pagination & TableHeaderControls (search/sort)
- StatBadge / KPI tile
- Toast/Notification

**Organisms**
- HeaderNav (signed-out/in/admin; product dropdown)
- PricingTable (free/$5; “Remove branding” flag)
- AuthDialog (Clerk-mocked)
- DashboardCard (loading/empty/error/ready)
- ProfileHeader (avatar, handle, social counts)
- LinkRow / SocialRow (auto-detect icon from URL)
- LinkGrid (public profile links)
- BillingBanner / UsageLimitsBar
- AnalyticsPreview (stubbed charts with fixtures)

# P1 (soon)
- OnboardingStepper
- EmptyStates (profiles, links, analytics)
- File/ImageUploader (Vercel Image path)
- FeatureFlagGuard (PostHog-mocked)

# Story essentials per component
- Variants, sizes, loading/disabled
- Light/Dark theme toggle (global toolbar)
- Viewports: 375, 768, 1280
- States: default/hover/focus/active/error/success
- Auth: signed-out | signed-in | admin (decorator)
- A11y: focus ring visible, ARIA where relevant

# Layout & paths
```
/ui/atoms/Button/Button.tsx (+ Button.stories.tsx)
... atoms/*
/ui/molecules/DropdownMenu/...
/ui/organisms/HeaderNav/...
/fixtures/{auth,profile,analytics}.ts
```

If you want, I’ll scaffold these stories with the Clerk/Supabase mock decorator and fixture data so you can run `pnpm storybook` and see everything instantly.

---

## User

Should we use next seo

---

## Assistant

Short answer: **No.** For Next.js 15 (App Router), use the **built-in Metadata API** and file conventions for OG/Twitter images. `next-seo` was great for the old Pages Router, but the App Router’s metadata is designed to replace it and avoids extra deps/overhead. citeturn0search7turn0search1

# What to use instead
- **Metadata API**: `metadata` / `generateMetadata` per route + a shared default in `layout.tsx`. citeturn0search7  
- **OG/Twitter images**: `opengraph-image` / `twitter-image` files or dynamic OG image generation. citeturn0search14turn0search19  
- **Sitemap/robots**: add `next-sitemap` (tiny, maintained) if you need automation.  
- **Schema.org**: inline JSON-LD via `generateMetadata` (no library needed).

# When `next-seo` still makes sense
- You’re stuck on **Pages Router** or want drop-in `DefaultSeo` across legacy routes. Otherwise skip it. citeturn0search1

# Minimal plan (fast)
1) Define global defaults in `app/layout.tsx` (title template, canonical base, open graph).  
2) Use `generateMetadata` on profile pages to inject per-artist title/description/canonical.  
3) Add `opengraph-image` per profile (or dynamic OG). citeturn0search14turn0search19

If you want, I’ll stub the `generateMetadata` helpers and a dynamic OG image route for Jovie.

---

## User

any dependices we SHOULD be using that would get us closer to our goal without crippling out tech?

---

## Assistant

Here’s a tight, **P0 → P1** dependency stack that moves Jovie toward sub-100ms pages and fast shipping without bloat.

# P0 (install now)
- **Type safety & schema**
  - `zod` + `@hookform/resolvers` — runtime validation + forms
  - `react-hook-form` — minimal, fast forms
- **UI primitives (small, solid)**
  - `@radix-ui/react-*` (or **shadcn/ui** code-gen) — a11y-correct primitives without heavy CSS
  - `lucide-react` — clean icon set
- **Navigation & data**
  - **Next.js 15 built-ins** (App Router, `fetch` cache tags, RSC) — avoid TanStack Query unless you truly need client caching
  - `ky` (optional) — tiny fetch wrapper for client-only calls
- **Styling**
  - `tailwindcss` + `clsx` + `tailwind-merge` — conflict-free utility styling
- **Auth/DB**
  - `@clerk/nextjs` (already)  
  - `@supabase/supabase-js` + (optional) `drizzle-orm` with `drizzle-kit` for typed SQL on Supabase
- **Payments & analytics**
  - `stripe` + `@stripe/stripe-js` — official, minimal surface
  - `posthog-js` — analytics + feature flags (keep payload thin; sample server events)
- **Quality gates**
  - `@storybook/nextjs` (+ `@storybook/addon-essentials`, `@storybook/addon-interactions`, `@storybook/addon-a11y`) — dev-only
  - `msw` — mock API for Storybook/tests (no network)
  - `eslint` (next config) + `typescript` strict + `tsx` (fast typecheck)  
  - `vitest` + `@testing-library/react` (unit) and **Playwright** (1-2 e2e happy paths)

# P1 (add when needed)
- **Observability**
  - `@sentry/nextjs` — server & client error traces; sample to keep cost low
  - `@vercel/analytics` — ultra-light page analytics if PostHog is off for some routes
- **SEO**
  - `next-sitemap` — generate sitemap/robots (use **Metadata API**, not `next-seo`)
- **Edge cache / rate-limit**
  - `@upstash/redis` — quick edge KV for hot profile caching or token buckets
- **Media**
  - Use **`next/image`** (Vercel Image) — no Cloudinary unless you need advanced transforms
  - `svgo` — optimize local SVGs in CI

# Tiny DX helpers (optional)
- `dotenv-cli` — clean env scripting
- `turbo` — speedy multi-package builds if you split UI kit later

# Skip (for now)
- Heavy UI kits, `next-seo`, `axios` (use `fetch`/`ky`), lodash (use native), global state libs unless a real use case (Zustand/Recoil).

If you want, I’ll generate a **one-shot install + config script** (pnpm) and scaffold: Storybook with Clerk/Supabase mocks, Zod form examples, and a PostHog feature-flag guard.

---

## User

Read my friend johns note about his company Stan which is a jovie competitor and give me a set of recommendations for what we should lean into while building jovie

---

## Assistant

Mr. White — I couldn’t find John’s note in your connected files. If you share it, I’ll tailor deeper. Meanwhile, here’s what to **lean into** vs. Stan, based on public info (plans at $29/$99, no free tier, Pro gates features like email flows/discounts/pixels; fast growth; sales-first positioning). citeturn0search0turn0search22turn0search15turn0search5

# Positioning
- **Be the music-native alternative** (Linkfire-class smart links + monetization). Stan is generalist “creator store”; we win on **DSP intelligence** and **speed**. citeturn0search12
- **Transparent, simple pricing** with a **free** tier (watermark) and **$5** “Remove branding.” Undercut Stan’s $29 floor; keep Pro upsells later (pixels, A/B). citeturn0search15

# Product bets (P0)
1) **Lightning profiles (<100 ms TTFB)**  
   - Next 15 RSC + edge caching, static OG, zero JS on public pages; image CDNs via `next/image`. This is your moat vs their app-like stack.  
2) **One-field link ingester**  
   - Paste any URL → auto-detect **DSP vs social**, fetch metadata/art, choose correct deep link per device/app. (Stan’s UX focuses on storefront blocks; you win on import intelligence.) citeturn0search12  
3) **Music-smart routing**  
   - Device/geo-aware fallbacks (Spotify app → web; Apple Music → iTunes/web), pre-save flows, ISRC/UPC awareness, bundle “Listen on X” tiles. (Stan doesn’t specialize here.) citeturn0search12  
4) **Frictionless tips/checkout**  
   - Default “Tip $5/$10/Custom,” Apple Pay/Google Pay via Stripe Checkout; A/B test CTA copy (“Tip” vs “Sponsor”). Keep it one screen, no account creation.  
5) **Creator analytics that matter to artists**  
   - Click-through by DSP, completion rate to play, campaign UTM breakdown; export CSV. (Stan emphasizes store revenue dashboards; you show **listen conversion**.) citeturn0search12

# Monetization ladder (clean, beats Stan’s gating)
- **Free:** watermark, basic links, basic analytics.  
- **$5:** remove branding (your planned MVP), vanity domain, UTM builder.  
- **$12:** pixels (Meta/TikTok), remarketing audiences, A/B tests, dynamic OG images.  
- **$29+ Agency:** multi-artist workspaces, templates, API. (Matches their ARPU zone later.) citeturn0search15

# Differentiating features to skip (for now)
- **Built-in email automation/flows, coupons, payment plans** — Stan pushes these in Pro; integrate (ConvertKit/Mailchimp) instead of building. Keeps surface area tiny and performance high. citeturn0search22

# Go-to-market edges
- **Instant import from Spotify/Apple URLs** for onboarding (pull art, socials, top tracks).  
- **Public speed as a sales claim**: prove sub-100 ms with a live profiler badge on pages (turn off in prod if you want).  
- **Crystal pricing page** (unlike Stan’s site where details are scattered). citeturn0search16

# Technical guardrails (to keep it fast)
- SSR public pages, edge cache + revalidate on edit; PostHog only on dashboard.  
- No client state libs on public; minimal JS (hydration only where interactive).  
- Storybook + fixtures for every public block to protect performance regressions.

If you drop John’s note (or a link), I’ll map each point 1:1 into a concrete build plan and backlog.

---

## User

Here it is https://thecreatorentrepreneur.substack.com/p/stans-2024-shareholder-letter

---

## Assistant

I wasn’t able to load John’s full “Stan’s 2024 Shareholder Letter” content directly—Substack blocked my access. But I did confirm a key highlight: **Stan doubled their ARR from $14.7M to $28.3M while maintaining ~40% EBITDA margins** citeturn1search0.

###  What that signals about Stan’s playbook:
- **Rapid, capital-efficient growth** — they scaled quickly without sacrificing unit economics.
- **PMF achieved** — likely monetizing a clear pain point for creators.
- They positioned themselves strongly for a “banner year” in 2025.

### How Jovie can **leverage this advantage**:

#### 1. **Launch price-sensitive, high-conversion tiers**
- Offer a **compelling free tier** (watermarked, essential tools) to quickly build signups and eyeballs.
- Differentiate with a **$5 “Remove Branding”** paid upgrade. Contrast with Stan’s higher tiers ($29+) and highlight immediate value.

#### 2. **Focus on retention and profitability**
- Keep overhead light: static public pages, minimal JS, edge caching, low infra.
- Track lifetime value vs CAC to maintain healthy margins. Fast scale only works if unit economics stay strong, like Stan’s 40% EBITDA.

#### 3. **Sharpen product-market fit with smart features for musicians**
- Ensure tools are **“DSP-smart”**: auto-detect URLs, deep-link routing, pre-save flows, device-aware fallbacks.
- Provide **one-click tip/pay experiences** (Stripe Checkout, Apple Pay etc.) with zero account friction.

#### 4. **Fractional engagement over feature bloat**
- Avoid building heavyweight native flows for coupons, planners, etc.
- Lean on existing integrations (Mailchimp/ConvertKit for email, Stripe for billing) to avoid diluting focus and keep agility.

#### 5. **Market with speed and transparency**
- Promote your pages as **sub-100ms**, fast, lean—stark contrast with bloated storefront UIs.
- Clearly communicate pricing: “Free → $5 → pro.” This transparency builds trust and ease-of-decision, especially when competitors obscure details.

#### 6. **Measure deeply and iterate**
- Instrument dashboards focused on conversion metrics: link click→play rate, tip conversion, DSP source performance.
- Use feature flags and A/B testing to optimize quickly, just like a high-growth SaaS.

####  90-Day Sprint Plan:

| Week     | Focus                                                                 |
|----------|-----------------------------------------------------------------------|
| 0–2      | Implement pricing tiers, free vs $5 → monitor signup & upgrade rates |
| 3–6      | Ship link intelligence & one-click tipping flows                     |
| 7–10     | Add presave/DSP-smart routing                                        |
| 11–13    | Embed analytics + A/B infrastructure; iterate based on conversion     |

---

### Summary

- **Lean into** speed, value, and specialized features (DSP-smart, tipping).
- **Out-execute** Stan on creator economics, transparency, and product-market fit.
- **Keep unit economics healthy** while scaling smartly, just as Stan did.

If you can share more of John’s letter (even key excerpts), I’ll map more direct opportunities from it into Jovie’s strategy.

---

## User

Here it is 
The Creator-Entrepreneur
The Creator-Entrepreneur


Stan's 2024 Shareholder Letter
Doubling from $14.7M to $28.3M ARR, achieving PMF, and why 2025 will be our banner year.
John Hu (@jayhoovy)
Mar 25, 2025

Stan had a strong year.

We doubled this year, growing from $14.7M to $28.3M ARR — all while hitting 40% EBITDA margins.


But I think the more interesting story is how we’ve evolved as people, and as an organization.

This year was humbling.

After a strong start out of the gate, we hit a plateau that forced us to re-evaluate whether we had built an organization truly designed to ‘scale’.

We were forced to get hyperclear on what an organization deserving of $100M+ looks like, and the key ingredients we needed to get to the next level — unquestioned product market fit, a resonant marketing message, and a repeatable acquisition engine that scales into the $100M+ level.

As a result, we’ve come out the other end a completely different organization — one with clarity on who we are as people, what our strategy is, and how we need to evolve to get to the next stage of growth.

This letter will attempt to recount our year in full — our accomplishments, our lessons learned, and why 2025 will be our banner year.

Ingredient #1: Achieving Product Market Fit
It’s crazy to think that just four years ago, I was building the first version of Stan alone in my dorm room.


It wasn’t the prettiest — but it solved all the issues Creators like me were facing.

Forced to spend $100s a month, we were stuck patching together dozens of software subscriptions that were hard to use, and even harder to make money with.

It boggled my mind that a simple, all-in-one solution didn’t exist.

Four years later, it’s cool to get to say that Stan is now fundamentally the best product on the market.


The team has worked hard to get here — with the launch of our Community feature, I can now confidently say that there is no better deal out there.

There is nowhere else you can get all the tools you need to start your online business — your website, courses, community, digital products, calendar bookings & email marketing — with the 24/7 support and coaching we provide every single one of our Creators — all for the incredibly affordable price of just $29/mo.

Stan continues to be the simplest way to start an online business, and by far the most affordable.

More importantly though — now that we’ve established clear PMF — we can focus on our true North Star goal: making Stan so good and so helpful that we fundamentally lift the success curve of entrepreneurship.


Our goal this year is to continue building a product where anyone, anywhere can make a living working for themselves.

This means focusing on increasing our customers’ success rates (we’re already 2-3x our industry’s average) by figuring out how we can better educate, coach, and do work on our Creators’ behalf.

That way, we can continue to say “if you aren’t using Stan, you’re literally leaving money on table.”

Ingredient #2: Brand
One of our biggest unlocks this year was understanding “who we are” and what makes us unique in this world (our Values, our authentic personalities, and how we choose to express them).

This ultimately translates into “Brand”.

I used to struggle in understanding the value of Brand (at first, it’s quite intangible and “woo-woo”), but over the last year, I’ve realized just how powerful Brand is as a distribution medium.

For us — our Brand specifically means what we stand for.

We stand for inspiring and empowering anyone to pursue their dreams and make a living working for themselves.

We believe that despite all of the sh** going on in this world, you can still make it.

Everyday at Stan we see the stories of real, hardworking middle-class entrepreneurs take the leap and build a life for themselves.

Whether it be Janessa Lynae using the money she made from Stan to escape an abusive relationship and move across the country with her daughter, Selina Camarillo creating a 6-figure business out of her love for making sourdough, or Eddie Abbew making $1M in his 60s while teaching others how to stay in shape — we see the reward that comes if you can just persist through the muck and make that first $ for yourself.


Selina (@milkmaidfarm), Janessa (@JanessaLynae), and Eddie (@eddieabbew) all started with nothing but a dream.
It’s damn hard — but as Creators ourselves, we know how empowering this journey can be — not just financially, but also the sense of meaning, purpose, and self-agency it fills you with.

And having come from very little ourselves, we know just how much making an extra $500 or $2,000 a month can fundamentally change someone’s life for the better.

It’s why we throw everything we can into supporting and caring for our Creators — and why we share the ‘playbook’ of how to succeed as widely as possible.

That reputation (or “brand”) is now starting to precede us.

You see it manifest in how strongly our content performs:


And the comments and messages we get from our Creators:


My favorite line: “I would sell a kidney for Stan”
We’re creating a movement here at Stan — and this year, you’ll start to see us inspire on an even bigger stage.

Ingredient #3: Evolving Our Organization (from Founder-Led to Repeatability-Driven)
Our last key learning actually came out of a period that was quite painful.

Early this year, we saw a huge surge in signups.

Unfortunately, much of this surge came from a wave of “Master Resell Rights” course sellers, a short-term trend where network marketers flooded into the market to sell a course on “How to Make Money Online”, which could then be resold at 100% profit.

This led to a massive, temporary spike in our signups that would soon drain out the other end.


The problem with this spike is that it disconnected us from our reality — our revenue scale had completely outpaced our GTM organization (or lack thereof).

We were so busy trying to keep up with the sheer deluge of demand (imagine adding 30,000 customers overnight!) that we didn’t have the bandwidth to dig deep and ask questions like: “have we really put in place an acquisition engine that will repeatably acquire tens of millions in revenue?”

A great illustration of how quickly our revenue scale outpaced the “controllable” infrastructure we had built.
A great illustration of how quickly our revenue scale outpaced the “controllable” infrastructure we had built.
The resulting plateau ended up being quite painful, but it forced us to do some needed soulsearching.

It helped us realize that the model we had used to get the company off the ground was no longer the same model we needed to get to the next stage.

We had essentially built a machine around leveraging “me” as our GTM channel: I had landed our biggest customers, thought up our biggest campaigns, and made all of the strategic decisions — a “founder-led” sales model.

This model works great to grow quickly to ~$10M ARR, but really breaks down at scale.

In order to move the needle at the scale we were now at, we needed to play a completely different game.

How We Think About “Scaling” Now
My eyes used to glaze over when anyone started talking about “org structure”, but I now see the value.

Your organization is essentially a ‘machine’ with some ‘total possible output’ — how you design that ‘machine’ affects its total output ceiling.

For us, our original model (founder-driven) had helped us shoot out of the gates quickly, but was now hitting its limit.


The potential output of the ‘machine’ we had built before was probably $15-20M. The machine we’re now building will get us to $100M+.
So we removed me as the bottleneck, and are now learning to build an organization that predictably and repeatably scales acquisition.

Over the last few months, we’ve restructured the organization to have multiple, single-threaded Owners who are empowered to drive their team towards metrics.

For example, over the last few months we’ve:

Hired our first Product Owners: before, product decisions were bottlenecked at the top; now, we’ll have multiple Owners driving more metrics than we previously could have handled

Started a real Marketing team: before, it was just me and Lo making content; now, we’re building our ‘Marvel Universe’ of Creators, 10x’ing our content output and juicing our organic ROI by 2-3x with the savvy use of paid channels

Doubled Down on our Support & Partnerships team: the best part of Stan has and always will be the human component we provide our Creators; we’re now making sure we have enough coverage to give everyone a phenomenal, white glove experience

The real change though is one of mindset.

Rather than approach every single problem with a mindset of “how do I solve this?”, we spend our time thinking about “who should we hire to solve this problem?”

“Who would take pride in owning this problem? And how can we support them in doing their best work possible?”

We’ve started to hire and promote incredible leaders at Stan to run their own organizations.

And already, we’re starting to see those results pay off.

In just November and December, we saw New Trial Signups re-accelerate (despite working from an overinflated base!).

Those are just the early results though — we’ll start to see the real compounding take off in 6-12 months.

And this here starts to hint at why I’m so excited about our future:

Stan started as just me in my dorm room.

It was just a single kid, hustling with a scrappy product and a dream.

But now, Stan has evolved into something much greater than me.

It’s an organization of some of the best people I’ve ever gotten to work with, all building a repeatable machine that’s ready to capture the massive market opportunity ahead.

Why 2025 Will Be Our “Banner Year”
Stan is clearly a growth-stage company:

We’ve built the best product in the market (compare our customers’ success rates vs. anyone else’s in the market)

We have clearly repeatable unit economics (5x+ LTV/CAC)

We have a clear sense of who we are (Brand) and how to message that (Marketing)

There is no one who understands our Customer better (we live, sleep, and bleed being a Creator-Entrepreneur)

The last key ingredient we needed to blow things out was learning how to scale an organization.

When you compound that with the fact that 90% of our market doesn’t even know we exist yet, you start to realize just how large the Stan opportunity might be.

Especially when you you realize how massive this market is becoming…

The Final Ingredient: TAM
“Eventually, everyone will be in the Creator Economy.” - Naval

It’s become extremely clear to me that the Creator Economy isn’t just the future of media, it’s the future of all Entrepreneurship.

The TAM is much larger than we first thought.

What started first as a few niche Creators posting about their passions has now evolved into every solopreneur — every lawyer, accountant, realtor, personal trainer, breathwork coach and literal breadbaker — realizing that ‘social media’ isn’t just ‘social media’ anymore.

It’s the new marketing channel.

It’s the new way to drive leads and stand out from the crowd.


One of my favorite parts about Stan is seeing the thousands of niches we support — lawyers, dentists, realtors, personal trainers, craft hobbyists, and even literal breadbakers are all succeeding with Stan.
This is no longer just a bunch of kids wanting to be YouTubers when they grow up — this is every business out there realizing that they need to be on social in an incredibly visible way.

You no longer need a physical location or someone’s permission to start your own thing.

All you need is your phone and a Stan Store.

People are modularizing into their own enterprises — and Stan will be there to support all of it.

Closing
Of course, there’s still so much we need to improve if we’re to live up to that potential.

We’ll need to double down on making our product even more valuable, figure out how to speak to 10x as many people, and maintain our Values at scale.

But no matter what, I couldn’t be more grateful for the journey.

This journey we call entrepreneurship is deeply humbling — it constantly pushes you to self-examine and evolve.

There are so many points where you don’t think you’re going to make it through.

Yet somehow, you do.

I think that’s what makes this mission so powerful for us.

Everyday we live what our Creators go through — the self-doubt, emotional turmoil, and constant need for reinvention.

But we also know just how transformative this journey can be — how it forces you to face your inner demons, builds financial independence, and kindles an immense sense of self-belief and purpose.

That’s an incredible human experience.

And you can bet we’re going to share that with as many people as possible.

—

Thank you for your support.

You’ve believed in us since Day 1, and we won’t let you down,

John (@jayhoovy)


P.S. - We’re Hiring!!!

For anyone interested in building the next great organization — what I hope to be a combination of Patagonia’s values, Goldman/DoorDash’s rigorous excellence, and the financial returns of early Google… please reach out.

Thanks for reading The Creator-Entrepreneur! You can get my monthly lessons learned building a BN $ company completely free here:

Type your email...
Subscribe
47 Likes
∙
4 Restacks
Discussion about this post
Write a comment...
Jaggie
Apr 9

Appreciate your intellectual honesty. I remember the Master Resell Rights Spike (the company who acquired my previous startup is in a similar space). Wild. See a lot Stan can do down the road for the soloprenuersin different verticals (not just influencers)

Like
Reply
Share
Eurie Kim
Mar 25

Can’t wait to see what’s to come!! Love the stories of real entrepreneurs building from their dreams and passions on Stan!

Like
Reply
Share
3 more comments...

Stan's 2023 Shareholder Letter
How we grew 8.1x this year from $1.7M ARR to $14.7M ARR, our key risks, and the multi-billion $ opportunity ahead.
Jan 17, 2024 • John Hu (@jayhoovy)
53
9

Announcing Steven Bartlett x Stan 🚀
Our biggest partnership yet - why I chose Steven to be a Co-Owner in Stan.
May 27 • John Hu (@jayhoovy)
38
8

Stan's 2022 Shareholder Letter: Creators are the New Brands
How we grew from $0 to $1.7M ARR, why the Recession is actually a good thing for the Creator Economy, and how you can take advantage of the opportunity…
Jan 24, 2023 • John Hu (@jayhoovy)
37
13

Ready for more?

Type your email...
Subscribe
© 2025 John Hu (@jayhoovy)
Privacy ∙ Terms ∙ Collection notice
Start writing
Get the app
Substack is the home for great culture

---

## Assistant

Got it, Mr. White. Here’s what Stan’s 2024 letter tells us — and how Jovie can carve its lane.

---

## What Stan Is Doubling Down On
1. **All-in-one “starter kit”**  
   Website, courses, community, digital products, calendar bookings, email marketing — bundled for $29/mo. They’re selling *breadth* + “affordable” vs. stitching SaaS.

2. **Brand as movement**  
   Narrative = “anyone can make $500–$2K a month, change your life.” Heavy emphasis on Creator success stories. They’ve realized distribution = brand.

3. **Scaling org beyond founder-led**  
   Building multiple “Owners,” marketing machine, Marvel-style content universe, big support org. They’re aiming for repeatable acquisition at $100M+ ARR.

4. **Massive TAM thesis**  
   Expanding narrative: it’s not just influencers → every solopreneur (lawyers, dentists, trainers, bread bakers). Stan = Shopify for services + info products.

---

## Where Jovie Should Lean In (Differentiation)
1. **Music-first wedge**  
   Stan is generic “start your business online.” You: *DSP-smart link engine*.  
   - Auto-detect Spotify/Apple URLs, generate deep links, presaves, device fallbacks.  
   - Position as *music-native smart links + monetization* (Linkfire + tip jar).  
   - Own the **musician → fan funnel**, where Stan is weakest.

2. **Speed & simplicity as brand**  
   Sub-100ms public pages. No bloat. Static + edge cached.  
   - Sell “the fastest artist pages on the internet.”  
   - Make speed + clean design your version of Stan’s “movement.”

3. **Low-friction monetization**  
   Stan leans on stores + upsell coaching. You:  
   - Default tip flows ($5/$10/custom) → Apple/Google Pay via Stripe.  
   - One-field URL input, auto-ingest metadata.  
   - Keep onboarding <60s. Stan can’t compete on *frictionless UX*.

4. **Transparent, price-anchored tiers**  
   Stan’s lowest plan = $29. You:  
   - **Free**: watermark, basic analytics.  
   - **$5**: remove branding.  
   - **$12**: pixels, A/B tests, remarketing.  
   - **Agency** later ($29+) if needed.  
   Undercuts them hard, appeals to emerging artists who balk at $29.  

5. **Analytics musicians actually want**  
   Stan pushes business dashboards. You:  
   - “Which link → plays my song?”  
   - DSP split, click→listen conversion.  
   - Show ROI of every smart link.

6. **Keep surface area narrow**  
   Stan is bloating into courses, communities, bookings. Resist that.  
   - Integrate with ConvertKit/Mailchimp if needed, don’t build email.  
   - Stay lean, specialized, fast.

---

## Tactical Recommendations
- **90-Day Roadmap**
  - ✅ Free + $5 plan live, upgrade CTA baked in.  
  - ✅ One-field link ingest w/ DSP detection.  
  - ✅ Stripe Checkout for tips.  
  - ✅ Sub-100ms public pages, Next/Image + Vercel Edge.  
  - ✅ Analytics MVP: clicks by DSP.  
- **Brand Positioning**
  - Stan: *“Anyone can be a solopreneur.”*  
  - Jovie: *“The fastest way to share your music & get paid.”*  
- **Growth**
  - Highlight speed + clarity: show load-time diff vs Stan.  
  - Run content marketing that proves: “our links → more plays → more fans.”

---

👉 In short: **Stan = broad + $29; Jovie = niche-sharp, fast, free/$5, music-native.** That wedge is enough to get you to PMF without fighting them head-on.

Do you want me to turn this into a **competitive battlecard** (side-by-side Stan vs Jovie, messaging bullets you can hand to team/investors)?

---

## User

yeah 

---

## Assistant

Perfect. Here’s a **Stan vs. Jovie battlecard** you can hand to your team or pitch investors with — tight, direct, and weaponized.

---

# 🥊 Stan vs. Jovie Competitive Battlecard

## Positioning
- **Stan:** Broad *“start your online business”* tool (website, courses, community, bookings, email). $29/mo entry.  
- **Jovie:** *Music-native smart links + monetization.* Sub-100ms pages, DSP intelligence, tip jar, transparent $5 entry.

---

## Head-to-Head

| **Dimension**       | **Stan**                                                   | **Jovie**                                                     | **Jovie Angle** |
|---------------------|------------------------------------------------------------|---------------------------------------------------------------|-----------------|
| **Target user**     | Generic solopreneurs (coaches, bakers, trainers, etc.)     | Musicians / creators needing DSP + link funnels               | Own the music vertical |
| **Core promise**    | “All your tools in one place”                              | “Fastest way to share your music & get paid”                  | Simpler, sharper |
| **Product surface** | Courses, stores, communities, bookings, email, coaching    | Smart links, tips, presaves, analytics                        | Narrow, no bloat |
| **Pricing**         | Starts $29/mo                                              | Free (watermark) → $5 remove branding → $12 Pro               | Undercut, upsell later |
| **Onboarding**      | Setup-heavy (choose product mix)                           | Paste a link → instant profile                                | <60s vs hours |
| **Monetization**    | Stores, upsell coaching                                    | One-click tips (Apple Pay/Stripe Checkout), link tracking     | Lower friction |
| **Speed/Perf**      | App-like, slower load times                               | Sub-100ms, edge-cached, zero bloat                           | “Fastest artist pages” |
| **Analytics**       | Revenue, store stats                                       | DSP clicks → plays, conversion funnel                        | Artist ROI |
| **Brand**           | “Empowering anyone to start a business” (movement vibe)    | “The fastest link in music” (sexy + technical edge)           | Own speed as brand |
| **Support**         | 24/7 coaching + partnerships                               | Lean product-first, integrations (Mailchimp, ConvertKit)      | No heavy human cost |
| **Org maturity**    | Growth-stage, scaling to $100M+ ARR                        | Early-stage, can ship faster, avoid bureaucracy               | Nimble vs lumbering |

---

## Jovie Talking Points
- **Stan = generic, bloated.** Jovie = sharp, music-native, ultra-fast.  
- **Stan = $29 gate.** Jovie = free/$5 wedge → captures emerging artists before they graduate up.  
- **Stan = solopreneur SMB.** Jovie = musicians + music ecosystem → TAM still massive, underserved.  
- **Stan = app.** Jovie = performance-first web (Google/Spotify link sharing loves speed).  
- **Stan = build a business.** Jovie = grow an audience + plays (artists’ actual pain).  

---

## Investor Spin
- Stan proves the TAM — doubling ARR to $28M, 40% margins.  
- Their floor is $29; their wedge is broad but shallow.  
- Jovie’s **$5 wedge → viral fan-facing pages → cheap acquisition.**  
- From there, ladder up to Pro (pixels, A/B, agencies).  
- Same TAM tailwinds, but Jovie slices deeper into *music vertical*, then expands outward.

---

Do you want me to make a **visual one-pager deck slide** (Apple-level clean) with this info formatted as a real battlecard you could drop into an investor deck?


## See Also
- [[chatgpt/chatgpt_integration-setup-guide]]
- [[chatgpt/chatgpt_pay-gating-setup-guide]]
- [[chatgpt/chatgpt_setup-storybook-with-vue-part1]]
- [[chatgpt/chatgpt_setup-storybook-with-vue-part2]]
- [[chatgpt/chatgpt_accelerator-tracking-setup]]
