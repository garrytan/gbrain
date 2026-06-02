---
title: "SSR vs SSG vs ISR"
type: guide
created: 2026-02-02
updated: 2026-02-02
source: chatgpt-export
conversation_id: 69801bfa-a760-8331-b69a-d497f406e616
message_count: 4
tags: [chatgpt, import, code]
---
# SSR vs SSG vs ISR

> Conversation ID: 69801bfa-a760-8331-b69a-d497f406e616
> Created: 2026-02-02T03:37:31Z
> Updated: 2026-02-02T03:40:53Z
> Messages: 4

---

## User

explain ssr vs ssg in next.js and isr and ppr and suspense and how they all fit together. be concise.

---

## Assistant

Mr. White — here’s the **clean mental model** for Next.js rendering. Short, factual, no fluff.

---

## The core question
**When is HTML generated, and how often is it regenerated?**

---

## SSR — Server-Side Rendering
**When:** Every request  
**How:** Server runs code → generates HTML → sends to browser

**Pros**
- Always fresh data
- Good for highly dynamic content (auth, dashboards)

**Cons**
- Slower TTFB
- More server cost

**Use when:** Data must be real-time.

---

## SSG — Static Site Generation
**When:** At build time  
**How:** HTML prebuilt → served from CDN

**Pros**
- Fastest possible
- Cheapest to serve
- SEO-friendly

**Cons**
- Data can go stale

**Use when:** Content changes rarely (marketing, docs, blogs).

---

## ISR — Incremental Static Regeneration
**When:** At build time **+ periodically after**  
**How:** Serve static HTML → revalidate in background

**Key idea:** *SSG + controlled freshness*

**Pros**
- Near-SSG speed
- No rebuilds for small updates

**Cons**
- Data is eventually consistent

**Use when:** Content changes occasionally (pricing, listings).

---

## PPR — Partial Prerendering (Next.js App Router)
**When:** Mixed  
**How:**  
- Static shell prerendered  
- Dynamic parts rendered per request or streamed

**Key idea:** *Static where possible, dynamic where needed*

**Pros**
- Best performance/freshness balance
- Reduces SSR blast radius

**Use when:** Pages have both static + dynamic sections.

---

## Suspense (React)
**What:** A **loading boundary**, not a rendering strategy  
**How:** Allows parts of the UI to **wait** for data while others render

**Enables**
- Streaming HTML
- Progressive rendering
- PPR + SSR + ISR to coexist cleanly

---

## How it all fits together

```
Build time:
  SSG → ISR → Static shell (PPR)

Request time:
  SSR → Dynamic segments (inside Suspense)

Streaming:
  Suspense sends HTML in chunks
```

**Mental shortcut**
- **SSG** = prebuilt
- **ISR** = prebuilt + refreshed
- **SSR** = built per request
- **PPR** = mix static + dynamic
- **Suspense** = orchestrates loading + streaming

If you want, I can give **decision rules** (2–3 lines) or a **real Next.js page example** showing all of these in one file.

---

## User

with ppr is there reason to not just use it exclusively?

---

## Assistant

Mr. White — **short answer: no, you shouldn’t use PPR everywhere.** It’s powerful, but not free.

Here’s the **decision logic**.

---

## Why PPR is tempting
PPR gives you:
- Static shell (CDN-fast)
- Dynamic islands (fresh data)
- Streaming via Suspense

So it *feels* like “best of all worlds.”

---

## Reasons **not** to use PPR exclusively

### 1. **Added mental & architectural complexity**
- You must think in **boundaries** (what’s static vs dynamic)
- Mistakes silently downgrade you to SSR
- Harder to reason about cache behavior

**Cost:** developer velocity.

---

### 2. **You still pay SSR costs**
Dynamic segments:
- Run on every request
- Consume compute
- Increase tail latency

If a page is **fully static**, PPR is strictly worse than pure SSG.

---

### 3. **Caching is less predictable**
- Static shell cached
- Dynamic parts depend on `fetch` cache + revalidation rules
- Easy to accidentally disable caching with headers, cookies, or auth

SSG/ISR is more deterministic.

---

### 4. **Not all pages benefit**
Examples where PPR adds zero value:
- Docs
- Blogs
- Marketing pages
- Legal pages

These should stay **pure SSG/ISR**.

---

### 5. **Operational maturity required**
PPR works best when:
- You understand Next’s caching model deeply
- You monitor server compute + cold starts
- You design Suspense boundaries intentionally

Without that, you’ll get “why is this SSR?” bugs.

---

## When PPR **is** the default choice

Use PPR when a page has:
- Mostly static layout
- Small dynamic sections
- High traffic + performance sensitivity

Examples:
- Product pages (price, inventory)
- Feeds with personalization
- Dashboards with static chrome

---

## Practical rule of thumb

**Default**
- SSG / ISR for content
- SSR for fully dynamic
- **PPR only when you need both**

> PPR is a **scalpel**, not a hammer.

If you want, I can give a **one-page decision table** or a **code example showing accidental SSR pitfalls**.
