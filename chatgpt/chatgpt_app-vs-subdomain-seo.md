---
title: "App vs Subdomain SEO"
type: note
created: 2026-01-31
updated: 2026-01-31
source: chatgpt-export
conversation_id: 697e5b2a-d934-832e-bf5d-8962f04d244a
message_count: 8
tags: [chatgpt, import, long-form]
---
# App vs Subdomain SEO

> Conversation ID: 697e5b2a-d934-832e-bf5d-8962f04d244a
> Created: 2026-01-31T19:44:18Z
> Updated: 2026-01-31T20:19:32Z
> Messages: 8

---

## User

Talk to me about app sitting on the root domain or app sitting on a subdomain, and marketing pages sitting on a root domain, public profiles sitting on the subdomain, root domain, just keeping everything together, and any benefit to either of these versions of isolation, SEO-wise, performance-wise, security-wise, etc. We're already a monorepo, turbo repo, on Next.js, and just trying to figure out how to separate the app, and if it's just a subdirectory on the root domain, and then if it is, what to call that, call it app or call it slash u slash, or like, what's, what do they do on like, what do the big companies do, like, how does like Instagram handle this? Which would be a good example because they have public profiles, but then they also have their marketing site, and then they also have like the actual app. But how do like, how do companies handle this type of stuff, like big companies?

---

## Assistant

Mr. White — there are three common ways to structure this, and the “best” choice is mostly about **isolation vs. SEO consolidation vs. operational simplicity**.

## The 3 patterns

### 1) Marketing + public profiles on the root, app on a subdomain (most common for SaaS)
- **example.com/** → marketing + docs + SEO content + public profiles  
- **app.example.com/** → authenticated product

**Why teams like it**
- **Security isolation:** you can keep auth/session cookies scoped to `app.` (host-only / `__Host-` cookies). A marketing-page XSS is less likely to compromise app sessions if cookies aren’t shared.
- **Operational isolation:** deploy marketing fast, deploy app carefully; separate caching rules; separate WAF/rate limits.
- **Performance:** marketing can be aggressively cached; the app can be “no-store” or personalized without worrying about cache bleed.

**Tradeoff**
- **SEO:** your app subdomain is *effectively a separate site* in practice (even if Google *can* handle either). Your *public* SEO content should live on the root (or `www`) so authority and internal linking stay concentrated. Google has long said there aren’t “major differences” between subdomains vs. subdirectories, so pick what works for users/ops. citeturn3search0

This tends to be the sweet spot if your public profiles matter for search.

---

### 2) Marketing on root, app in a subdirectory (`example.com/app`)
- **example.com/** → marketing + public profiles  
- **example.com/app/** → product

**Why teams like it**
- **SEO consolidation:** everything is under one host, so links, crawl context, and analytics tend to be simpler.
- **Simpler SSO/cookies:** one origin; fewer cross-origin headaches.

**Tradeoff**
- **Weaker isolation:** any serious security issue on the root origin (XSS, bad third-party script, misconfig) is closer to your authenticated surface because it’s the same origin.
- **Caching complexity:** you need stricter cache boundaries so “public marketing” behavior doesn’t accidentally affect “private app” routes.

This is popular when the product pages themselves are SEO-relevant and public (or when teams want one “site” operationally).

---

### 3) Everything together on the root (GitHub-style)
- Marketing pages, public profiles, and the app all live on `example.com` with route-based separation.

**Pros**
- One origin, clean links, minimal DNS/TLS hops.
- Easy sharing: public profiles can be `example.com/@handle` or `example.com/handle`.

**Cons**
- Least isolation; you must be disciplined about CSP, third-party scripts, permissions, cookie scope, and caching.

---

## Public profiles: root vs. subdomain vs. “inside the app”
If you want profiles to rank and be shared broadly, best practice is:
- Put profiles on the **root** (or `www`) as **fully server-rendered, crawlable** pages.
- Keep anything requiring auth (dashboard, settings, internal pages) on **`app.`** or **`/app`**.

A common trick: reserve a namespace so handles don’t collide with marketing routes.
- `example.com/@tim` (very common now)
- or `example.com/u/tim`
- or `example.com/tim` (cleanest, but you must reserve every marketing slug forever)

If your marketing site needs a lot of top-level routes (`/pricing`, `/blog`, `/security`, etc.), `@handle` (or `/u/`) avoids collisions cleanly.

---

## SEO reality check (subdomain vs. subdirectory)
- Google’s guidance: **no major difference** inherently; choose what’s best for users and maintainability. citeturn3search0
- In practice, many teams find **subdirectories feel easier** to consolidate authority and internal linking, while **subdomains feel easier** to isolate and operate. (Both can work if you interlink well and set canonicals correctly.)

Also: if you verify a **Domain property** in entity["organization","Google Search Console","search analytics tool"], it aggregates data across subdomains and paths, which helps you monitor either architecture. citeturn2view1

---

## Security & isolation differences that actually matter
**Subdomain isolation helps when you:**
- Scope cookies to `app.example.com` (host-only), so marketing can’t read/receive them.
- Use different CSP policies (marketing often needs more third-party scripts; app should be strict).
- Want separate rate limits / bot protections (profiles get scraped; app gets attacked differently).

**Subdirectory isolation helps less** because it’s still one origin; you’re relying on route-level discipline rather than origin boundaries.

---

## What big companies do (patterns you can copy)

- **Instagram**: public profiles live on `instagram.com/<username>`, while marketing/info content also exists on separate properties like `about.instagram.com` and business-focused surfaces like `business.instagram.com`. citeturn5search14turn5search7turn5search1  
- **entity["company","Stripe","payments company"]**: core marketing on `stripe.com`, authenticated dashboard on `dashboard.stripe.com`. citeturn0search1turn4search23  
- **entity["company","Shopify","ecommerce platform"]**: admin consolidated under `admin.shopify.com`, and stores historically have `*.myshopify.com` as a default domain. citeturn0search16turn0search12  
- **entity["company","Slack","collaboration software company"]**: customer workspaces use `workspace.slack.com` style subdomains, and the web client uses `app.slack.com/client/...` flows. citeturn4search17  
- **entity["company","Atlassian","software company"]**: cloud tenants commonly live at `name.atlassian.net` with app-specific paths like `/wiki`. citeturn4search2  

The recurring theme: **public “brand + discovery” content stays on the main domain**, while **authenticated product surfaces get their own subdomain** (or tenant subdomains).

---

## A practical recommendation for your Next.js monorepo
Given you’re on Next.js + turborepo already:

**Most robust setup**
- **`www.example.com` (or apex)**: marketing + docs + public profiles (`/@handle` or `/u/handle`)
- **`app.example.com`**: authenticated app

Build as **two Next.js apps** in the monorepo (shared UI packages). You get:
- clean security boundaries,
- independent deploy cadence,
- simple caching rules,
- and strong SEO where it matters (root domain).

**Naming**
- Authenticated product: `/app` is the most universally understood (or `/dashboard`).
- Public profiles: `@handle` is the cleanest collision-avoidance pattern for modern products.

If you tell me whether your profiles are meant to be **SEO landing pages** (indexed, shareable, branded) or mostly **logged-in surfaces**, I’ll map that to a concrete URL + routing plan (including rewrite/canonical rules) without changing your monorepo shape.

---

## User

Profiles are landing page yes. And they must be at jov.ie/uername

---

## Assistant

Mr. White — if profiles are true SEO landing pages **and must live at `jov.ie/username`**, that’s totally doable and common. The main thing you’re trading for that clean URL is **route-collision complexity** (and a bit less isolation vs. putting profiles on a separate host).

## What this implies (and how to make it safe)

### 1) You must reserve “system” slugs forever
If `/username` is a catch-all, then `/pricing`, `/blog`, `/login`, `/app`, `/api`, etc. would otherwise be “taken” by a user named “pricing”.

**Solution:** maintain a **reserved words** denylist and prevent signups/renames to those slugs.

Typical reserved list (starter):
- `pricing`, `blog`, `about`, `careers`, `docs`, `security`, `terms`, `privacy`
- `login`, `logout`, `signup`, `settings`, `dashboard`, `app`
- `api`, `_next`, `favicon.ico`, `robots.txt`, `sitemap.xml`, `assets`, `static`, `images`
- anything you might add later (this is why teams prefer `@username` or `/u/username`, but you’ve said you can’t)

Also reserve **common typos** of your critical routes (e.g., `prcing` if you care).

### 2) Your routing must prioritize “known routes” over profiles
In Next.js, don’t rely on a single catch-all that tries to guess. Make it deterministic:

- Explicit routes for marketing pages: `/pricing`, `/blog/*`, `/docs/*`, etc.
- Then a dynamic route for profiles: `app/[username]/page.tsx`

This works because Next route matching will prefer the static routes over the dynamic segment.

### 3) Keep profiles on the root host, but put the authenticated app on a subdomain
With your constraints, the clean separation that still preserves SEO is:

- `jov.ie/<username>` → public profiles + marketing pages
- `app.jov.ie` → authenticated product

Why this is the best mix:
- **SEO stays concentrated** on the root domain (profiles are the SEO asset).
- **Security isolation** improves: you can scope session cookies to `app.jov.ie` (host-only / `__Host-` cookies) so a marketing/profile XSS is far less likely to compromise logged-in sessions.
- **Performance/caching** is easier: profiles can be cached/ISR; app routes can be private/no-store.

### 4) Profiles should be built like “content pages,” not like “app pages”
Since they’re landing pages:

- **SSR or ISR** (not client-only).  
- Proper **canonical** URLs (avoid duplicates like `/username/` vs `/username`).
- Full **Open Graph / Twitter cards**, clean metadata, and fast TTFB.
- Add them to your **sitemap** and link them internally.

### 5) Security gotchas for user-generated pages
Profiles are attacker playgrounds. Do these:
- Strict HTML sanitization (if you allow rich text).
- Strong CSP (especially on root pages that might include third-party scripts).
- Rate limit profile endpoints (scraping + enumeration is real).
- If you use images, proxy them or restrict remote domains.

## Next.js implementation pattern (works well in a turborepo)
In a monorepo, keep two apps:

- `apps/web` → `jov.ie` (marketing + profiles)
- `apps/app` → `app.jov.ie` (authenticated app)

Shared packages for UI/auth types are fine.

### Route sketch for `apps/web` (App Router)
- `app/(marketing)/pricing/page.tsx`
- `app/(marketing)/blog/[...slug]/page.tsx`
- `app/[username]/page.tsx`  ✅ profiles

Then enforce reserved slugs at two layers:
1) **At write-time** (don’t allow the username)
2) **At request-time** (if `username` is reserved, render the marketing route or 404)

### Extra: make collisions impossible even as you add pages later
When marketing wants a new page like `/partners`, you:
- add `partners` to reserved list
- create `/partners` static route  
No risk that a user already owns it.

## What big companies do (relevant pattern)
entity["company","Instagram","social media company"] keeps public profiles at `/username` on the main domain and uses other properties/subdomains for marketing/business surfaces. That’s essentially the model you’re adopting—just be disciplined about reserved routes.

---

## Recommendation for your exact requirement
- Keep **profiles at `jov.ie/:username`**.
- Put **logged-in app at `app.jov.ie`**.
- Maintain a **reserved slug list** and treat it as product-critical.
- Optimize profiles as **ISR/SSR pages** with full metadata and sitemap inclusion.

If you tell me your current top-level marketing routes (even just a rough list like pricing/blog/docs/login), I’ll give you a hardened reserved-slug list + a clean Next.js route layout that won’t paint you into a corner.

---

## User

How do the public profiles on the root domain get generated if that project is sitting at the root? And does this simplify our middleware at all?

---

## Assistant

Mr. White — if the **root-domain project is the “web” app** (marketing + profiles), then public profiles at `jov.ie/username` are just a **dynamic route** in that same Next.js app.

## How profiles get generated on the root project

### Option A: Server-render every request (simplest, always fresh)
- You create `app/[username]/page.tsx`
- On request to `/tim`, Next runs the server component, looks up `username=tim` in your DB, and renders HTML.

Best when:
- Profiles change frequently
- You don’t want cache invalidation complexity

### Option B: ISR (cache pages, re-render in the background)
Same route, but you allow Next to **cache the rendered result** and revalidate periodically or on-demand (the Next “App Router” revalidation model). Next’s ISR guide is here. citeturn0search0

Common patterns:
- **Time-based revalidate** (e.g., every N seconds) via Next’s caching/revalidation primitives. citeturn0search10turn0search18
- **On-demand revalidation** when a user updates their profile (invalidate `/username` right then), using `revalidatePath()` or tags. citeturn0search3turn0search14turn0search17

Best when:
- You want fast profiles at scale
- Updates can tolerate seconds/minutes of staleness (or you trigger on-demand)

### Option C: Pre-generate “top” profiles + fallback for the rest
You prebuild some popular usernames (or those with high traffic), and everything else is generated on first hit and then cached (works well with ISR). This is essentially the “scale to millions of pages” approach that ISR is meant for. citeturn0search0

---

## Does this simplify middleware?
Yes, **a lot**, if you split domains like this:

- `jov.ie/*` → marketing + profiles (public)
- `app.jov.ie/*` → authenticated app

### Why it’s simpler
**Middleware complexity comes from having to decide “what is this request?”** (marketing vs profile vs app) *and* apply auth rules.

With the split:
- On `app.jov.ie`, middleware can be straightforward: “protect everything except a few auth routes” (or protect everything). You can also restrict middleware to certain paths using `matcher`. citeturn0search1turn0search8
- On `jov.ie`, middleware can be minimal:
  - reserved-slug handling (optional)
  - redirects (optional)
  - bot/rate limiting (optional)

No more “if path starts with /app then auth else …” logic on the same origin.

---

## How this maps cleanly in a turborepo (operationally)
In Vercel terms (if you’re using it), you typically configure **two projects pointing at the same repo** (each with a different root directory), then attach `jov.ie` to one and `app.jov.ie` to the other. That’s the standard monorepo setup. citeturn0search6turn0search9turn0search13

(You only need the “proxy multiple projects under one domain” approach if you were trying to split by *paths* under a single host, like `jov.ie/app` served by a different project. citeturn0search2turn0search16)

---

## The one hard part with `jov.ie/username`
This isn’t middleware-heavy, but it *is* product-heavy:
- You must maintain a **reserved slug list** so `/pricing` can’t be a username.
- Next routing already prioritizes explicit routes (`/pricing`) over `[username]`, but you still need to block users from claiming those slugs.

---

### Practical recommendation (given your constraint)
- Generate profiles in the **root web project** via `app/[username]/page.tsx`
- Use **ISR + on-demand revalidation** if you expect high traffic + many profiles (fast + scalable). citeturn0search0turn0search3turn0search14
- Keep auth app on **`app.jov.ie`** so middleware becomes dead simple and your session cookies can be host-scoped.

If you tell me how often profiles update (rare vs frequent) and roughly how many you expect (10k vs 10M), I’ll tell you which of A/B/C is the best default and what caching mode to pick.

---

## User

We’re going everything on one domain. Should we use /app or something else like /u/

---

## Assistant

Mr. White — if you’re keeping **everything on one domain**, use **`/app` for the authenticated product**, and keep **profiles at `/:username`** (since you said that’s required). Don’t use `/u/` for the app; `/u/` is typically for public users when you *can’t* do `/:username`.

### Recommended URL scheme (single-domain)
- `jov.ie/` → marketing
- `jov.ie/:username` → public profile landing pages
- `jov.ie/app/...` → authenticated product
- `jov.ie/login`, `/signup` → auth entry points (or `jov.ie/app/login` if you prefer)

This is a very common “GitHub-style” layout.

---

## Why `/app` is the right call
### 1) It avoids collisions with usernames
If profiles are `/:username`, you need a **reserved list** anyway. Reserving `app` is obvious and future-proof.

### 2) It keeps middleware simple
Your middleware becomes basically:
- If path starts with `/app`, enforce auth (except maybe `/app/login`).
- Else: public.

That’s much simpler than trying to treat `/u/*` as “app” (confusing) or mixing auth pages at top-level routes.

### 3) Cleaner mental model for users and your team
“App lives under `/app`” is instantly understood. `/dashboard` is also common, but `/app` is more universal.

---

## When you might choose something else
- **`/dashboard`**: if the core experience is a dashboard-heavy B2B tool.
- **`/product`**: rarely used; too vague.
- **No prefix at all** (everything mixed): only if you *love* route complexity and slug collisions (I wouldn’t).

I would not use:
- **`/u/`** for the app (it reads as “user”)
- **`/users/`** (profiles are already at root)
- **`/me/`** (only works for a single “current user” page)

---

## Critical requirement for `/:username` + `/app`
You must maintain a **reserved slug list** and enforce it at username creation/rename:
- include `app`, `api`, `_next`, `login`, `signup`, `pricing`, `blog`, `docs`, `terms`, `privacy`, `security`, `sitemap.xml`, `robots.txt`, etc.

Even with `/app`, you’ll keep adding marketing routes over time — reserve them before you ship them.

---

## Next.js routing layout (clean and collision-safe)
- `app/(marketing)/page.tsx`
- `app/(marketing)/pricing/page.tsx`
- `app/app/(authed)/...` for all authenticated routes
- `app/[username]/page.tsx` for profiles

Next will route `/app/...` to the static segment before it ever considers `[username]`.

---

### Bottom line
Use **`/app`** for the authenticated product. Keep **`/:username`** for profiles. Don’t introduce `/u/` unless you *can’t* do root usernames.

If you want, tell me your current top-level marketing routes (pricing/blog/docs/etc.) and I’ll give you a hardened reserved-slug list that won’t bite you later.
