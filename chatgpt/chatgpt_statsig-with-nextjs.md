---
conversation_id: 697ea22e-3338-8331-8ac1-75e4e0d2df20
created: 2026-02-01
links:
- '[[chatgpt-clusters/coding_web_dev]]'
message_count: 2
source: chatgpt-export
tags:
- chatgpt
- import
- long-form
title: Statsig with Next.js
type: note
updated: 2026-02-01
---

# Statsig with Next.js

**Related:** [[coding_web_dev]]

> Conversation ID: 697ea22e-3338-8331-8ac1-75e4e0d2df20
> Created: 2026-02-01T00:46:52Z
> Updated: 2026-02-01T00:47:57Z
> Messages: 2

---

## User

Explain using StatSig with Next.js for feature flags. Should we be using it on the server side or on the client side? Because I believe that they offer a client side and a server side SDK. I'm wondering what is ideal for us, our marketing site and our homepage are entirely static. Our public profiles for users are ISR and our app is dynamic with various states of suspense and PPR, ISR depending or whatever. And we're looking, which we're flexible to change that if it makes sense, but looking to have the most performative, performant version of the setup that we can. So just trying to figure out if uh what we're looking at for like best practices here. So, I'll get it.

---

## Assistant

Mr. White — in Next.js, the “ideal” Statsig setup is usually **hybrid**:

- **Server/edge evaluates flags when the result must affect HTML, routing, caching, SEO, or security**
- **Client evaluates flags for purely interactive/UI behavior after hydration**
- **Bootstrap server-evaluated values into the client** so you don’t pay an extra client init request or get UI flicker/mismatches (Statsig explicitly supports this). citeturn0search5turn0search1

Below is how that maps to your site.

---

## The decision rule (what goes where)

### Prefer **server/edge-side** evaluation when flags affect:
- **Redirects/rewrites/routing** (e.g., A/B test landing pages)
- **What HTML is initially sent** (SEO, “above the fold”, no flicker)
- **Cacheability** (you want static/ISR to stay fast while varying experience)
- **Anything sensitive** (entitlements, access control, paid features)

Next.js middleware runs in the **Edge runtime by default** (limited Node APIs), so you typically use an edge-compatible Statsig option there. citeturn0search9turn0search2

### Prefer **client-side** evaluation when flags affect:
- Post-hydration UI only (component variants, minor UX tweaks)
- Things that *can* tolerate “default → update after init”
- Highly interactive states inside your app where you already accept client reactivity

Statsig notes client SDK init happens “when a screen is rendered” and can impact UX (network + render timing), which is why bootstrapping is valuable. citeturn0search1turn0search12

---

## Your architecture, route by route

## 1) Marketing site + homepage (entirely static)
Static HTML can’t be personalized per-request, so you have two realistic patterns (Statsig calls these out for SSG): citeturn1search0

### Best-performing (keeps pages static **and** avoids flicker)
**Edge Middleware + Edge Config adapter → rewrite/redirect to static variants**
- Create `/` variants like `/home-a` and `/home-b` (both fully static)
- Middleware assigns a user to a variant (sets a cookie) and rewrites to the correct static route
- With the Vercel integration, Statsig can sync config to **Vercel Edge Config** to reduce latency and avoid a network trip back to Statsig at request time. citeturn1search1turn1search7
- There’s an official Vercel example using `statsig-node-lite` + Edge Config adapter in middleware. citeturn1search3

**This is the go-to if you care about:**
- fastest TTFB
- no UI flicker
- A/B tests that affect SEO/hero content
- keeping the “marketing” surface static/CDN-cached

### Simpler (but can flicker and isn’t great for SEO tests)
**Client-only flags inside hydrated components**
- Keep page static, but gate certain components with the client SDK
- Risk: user sees default then it flips after init (unless you bootstrap)

---

## 2) Public profiles (ISR)
ISR gives you *cached HTML per path* until revalidate, so it also can’t truly personalize per-viewer without breaking caching.

Two good options:

### If you want viewer-based experiments but keep ISR fast
**Same pattern as marketing**: middleware chooses variant and rewrites to cached variants (or adds a variant segment).
- You preserve ISR/CDN benefits
- You can still run experiments on the profile shell/CTA placement, etc.

### If you need true per-viewer personalization in HTML
Make that route (or part of it) **dynamic** and evaluate on the server (Node runtime), then **bootstrap** to the client to keep hydration consistent. (More below.)

---

## 3) App (dynamic, Suspense, PPR/ISR mixed)
Here’s the common “best practice” for performance + correctness:

### A) Evaluate on the **server** for anything that affects:
- which RSC tree you render
- which data you fetch
- what the user is allowed to do

Use Statsig’s **server SDK** in Node runtime, initialize once, and reuse it. After initialize, operations are essentially synchronous and the SDK refreshes in the background. citeturn1search17turn0search21

### B) **Bootstrap** those values into the client Statsig provider
Statsig server SDK can generate the client initialize payload (`getClientInitializeResponse`) so the browser doesn’t need an extra “first load” fetch and you avoid mismatches. citeturn0search5turn0search12

This is especially important with Suspense/streaming because you want the client to agree with what the server rendered.

### C) Client SDK is still useful
Once bootstrapped, client-side flags are great for:
- interactive toggles
- conditional components after hydration
- logging exposures consistently

---

## Identity & consistency (important for experiments)
For logged-out marketing traffic, you’ll usually want a stable device identifier so bucketing doesn’t reshuffle each visit. Statsig’s **Stable ID** is designed for that. citeturn0search3turn0search0  
When a user logs in, you can add `userID` while keeping stable bucketing behavior for device-level tests. citeturn0search18

---

## Practical recommendation for you
If your goal is “most performant overall”:

1) **Marketing + homepage:** Edge Middleware + static variants (SSG) + Vercel Edge Config integration  
   → fastest, no flicker, keeps everything static. citeturn1search0turn1search1turn1search3

2) **Public profiles (ISR):**
   - If experiments are “layout/CTA” and can be variant-based: **middleware rewrite to variant routes** (keeps ISR benefits)
   - If personalization must be per-viewer in HTML: switch that route (or a wrapper layout) to **dynamic server rendering + bootstrap**

3) **App:** Server-side (Node runtime) evaluation for anything meaningful + **bootstrap to client** + client SDK for interactive UI and event logging. citeturn0search5turn0search1turn1search17

---

## One hard rule
**Never rely on client-side flags for security or access control.** Client flags are inherently bypassable; enforce permissions server-side and treat client flags as UX hints.

If you tell me whether you deploy on **Vercel** (sounds likely) and whether you want **A/B tests that change hero copy / SEO**, I can outline a concrete Next.js App Router structure (middleware routing scheme + where to bootstrap in layouts).


**Topic:** [[chatgpt-clusters/coding_web_dev]]


## See Also
- [[chatgpt/chatgpt_clerk-with-nextjs-react-e2e]]
- [[chatgpt/chatgpt_1password-with-chatgpt-atlas]]
- [[chatgpt/chatgpt_adjusting-parfait-with-pecans]]
- [[chatgpt/chatgpt_ai-model-comparison-for-nextjs]]
- [[chatgpt/chatgpt_arguing-with-facts]]
