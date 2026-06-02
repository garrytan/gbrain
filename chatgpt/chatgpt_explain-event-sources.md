---
title: "Explain event sources"
type: note
created: 2025-12-22
updated: 2025-12-22
source: chatgpt-export
conversation_id: 6948c08c-54ac-832b-8571-3225b8e35e53
message_count: 2
tags: [chatgpt, import, code]
---
# Explain event sources

> Conversation ID: 6948c08c-54ac-832b-8571-3225b8e35e53
> Created: 2025-12-22T03:53:08Z
> Updated: 2025-12-22T03:53:30Z
> Messages: 2

---

## User

explain where these events are coming from out of nowehere. weve pre-launch how do we have so many events?

---

## Assistant

Mr. White—

These **Web Analytics Events are not “real users” hitting your app**. They’re coming from **automated and internal traffic**. Pre-launch apps commonly see this. Here’s exactly where they’re coming from:

---

## The primary sources (in order of impact)

### 1. **Your own development activity**
Every page load and navigation triggers events.
- You, teammates, QA
- Repeated refreshes
- Client-side route changes
- Hot reloads in preview deployments

If you open `/signin` 50 times, that’s **50+ events**.

---

### 2. **Vercel Preview Deployments**
Each PR, branch, and preview URL:
- Generates its own analytics events
- Is hit automatically during testing
- Is often refreshed by CI, reviewers, and bots

Preview traffic **counts unless explicitly excluded**.

---

### 3. **CI / automated checks**
- Lighthouse
- Playwright / Cypress / Vitest
- Health checks
- Internal monitoring pings

These load pages like a browser → **analytics fires**.

---

### 4. **Search engine + internet scanners**
Even pre-launch:
- Googlebot
- Bingbot
- SEO scanners
- Security crawlers
- Random botnets probing common routes (`/signin`, `/admin`, etc.)

They hit the URL → analytics fires.

---

### 5. **Speed Insights + Observability**
You’re also running:
- Speed Insights
- Observability instrumentation

These **do not create Web Analytics events themselves**, but they **increase page loads** during testing, which *does* increase analytics.

---

## Why the number looks huge
You’re seeing **~430k events**, not users.

One developer can easily generate:
- 100–300 events/hour
- Across multiple routes
- Across multiple deployments

Multiply by:
- Preview builds
- CI runs
- Bot traffic
- Days in the billing cycle

This stacks fast.

---

## How to fix this immediately

### 1. **Exclude non-production environments**
Only track analytics on production.

```ts
if (process.env.NODE_ENV === "production") {
  // load analytics
}
```

---

### 2. **Block bots**
In Vercel Analytics settings:
- Enable bot filtering
- Exclude known crawlers

---

### 3. **Exclude internal traffic**
Filter by:
- IP ranges
- Authenticated admin routes
- Preview domains (`*.vercel.app`)

---

### 4. **Delay analytics until post-launch**
Only fire analytics after:
- Public access enabled
- Authenticated user confirmed

---

## Bottom line
Nothing is “wrong”.
This is **expected behavior** for:
- Active development
- Multiple previews
- CI pipelines
- Public URLs (even if “unlaunched”)

The data is **polluted, not dangerous**. Clean it before launch and your post-launch metrics will normalize immediately.

If you want, I can give you a **precise Vercel + Next.js config** to zero this out in under 10 minutes.


## See Also
- [[chatgpt/chatgpt_convert-code-to-emit-event]]
- [[chatgpt/chatgpt_create-calendar-event]]
- [[chatgpt/chatgpt_event-prep-plan]]
- [[chatgpt/chatgpt_event-setup-instructions]]
- [[chatgpt/chatgpt_event-time-change-tracking]]
