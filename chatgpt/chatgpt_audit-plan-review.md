---
title: "Audit Plan Review"
type: guide
created: 2026-02-22
updated: 2026-02-22
source: chatgpt-export
conversation_id: 699a5c0f-fb34-8330-823a-63bc37525b47
message_count: 2
tags: [chatgpt, import, code]
---
# Audit Plan Review

> Conversation ID: 699a5c0f-fb34-8330-823a-63bc37525b47
> Created: 2026-02-22T01:29:54Z
> Updated: 2026-02-22T01:30:32Z
> Messages: 2

---

## User

audit this plan

---

## Assistant

Mr. White — here’s a direct audit of the plan from an architecture, scalability, and risk perspective.

---

# High-Level Assessment

**Overall structure: Strong (8/10)**  
You have:
- Clear phased separation
- Logical flow (tracking → generation → storage → orchestration)
- Extensibility for future creative types
- Good use of lazy + batch hybrid model

But there are **three architectural risks** and **two performance blind spots** that should be addressed before implementation.

---

# Phase 1 — Tracking Integration

### ✅ What’s Solid
- Dedicated `claim_page_visit` event type
- Username normalization early
- Proper CAPI mapping
- Distinguishing `content_category`

### ⚠️ Issues

### 1. Enum Migration Risk
Adding to a Postgres enum is fine — but:
- It requires migration ordering discipline.
- Rollbacks are painful.

**Better pattern:**  
Replace enum with a string union at DB level if long-term flexibility matters.  
If not, acceptable — just note deployment ordering dependency.

---

### 2. Event Semantics Are Slightly Ambiguous

You’re using:
```
claim_page_visit
```

But what you’re really tracking is:
> “Unclaimed profile viewed with claim intent”

That is closer to:
```
profile_claim_intent
```

Why this matters:
- Future ad modeling
- LTV segmentation
- Lookalike audiences

Right now you're mixing:
- page view
- intent signal

Clarify whether this event fires:
- on page load
- on CTA click
- both

You should separate:
- `claim_page_view`
- `claim_cta_click`

Meta optimizes better on click-intent than view-only.

---

# Phase 2 — Ad Creative Generation Architecture

This is the strongest phase conceptually.

### ✅ Excellent Decisions
- Entity-agnostic
- Generator interface
- Registry dispatch pattern
- Multiple aspect ratios
- Reusing existing OG infra

---

## ⚠️ Risk 1: `next/og` at Runtime Scale

`ImageResponse`:
- Is CPU heavy
- Cold starts are expensive
- Can timeout under burst traffic

If:
- Claim pages spike (ads go live)
- Many creatives need generation simultaneously

You could hit:
- Edge timeout
- Blob storage race conditions
- Duplicate generation

### Fix:
Before generating:
- Acquire a DB row lock OR
- Insert “pending” record first
- Then generate

Otherwise two parallel requests will generate the same creative.

---

## ⚠️ Risk 2: Creative Config Too Generic Too Early

You defined:

```
AdCreativeConfig:
entityId
entityType
text
colors
ctaText
```

That’s premature abstraction.

Claim creatives don’t need:
- dynamic colors
- arbitrary text

Over-generalizing early increases:
- complexity
- testing surface
- bugs

Recommendation:
Keep config minimal per generator.
Expand when release creatives are implemented.

---

# Phase 3 — Storage and Retrieval

### ✅ Strong:
- Composite unique constraint
- Indexed lookup
- 1-year cache headers
- Blob path structure

---

## ⚠️ Missing: Content Hashing

If you change:
- design
- gradient
- typography
- CTA wording

You’ll want regeneration.

Right now:
```
(entityType, entityId, size) UNIQUE
```

That prevents regeneration when design updates.

### Better:

Add:
```
version INT
```

or

```
designHash TEXT
```

Then composite unique on:
```
(entityType, entityId, size, version)
```

Without this, you'll need destructive migrations to refresh creatives.

---

# Phase 4 — Lazy + Cron Generation

This is strategically smart.

Lazy ensures:
- No wasted compute.

Cron ensures:
- High-value targets are pre-warmed.

---

## ⚠️ Risk 3: Generation Inside Pixel Pipeline

You wrote:
> Hook into pixel event processing in /api/px route  
> Use after() for non-blocking generation

This is risky.

Even non-blocking:
- Adds pressure to tracking endpoint
- Complicates failure handling
- Increases latency risk

Tracking endpoints must be:
- extremely thin
- resilient
- fast

Better architecture:
- Push event to queue (Upstash / SQS / Redis)
- Worker handles creative generation

Keep pixel ingestion pure.

---

# What’s Missing Entirely

## 1. Rate Limiting Strategy Definition

You mention:
> Rate limit to prevent abuse

But:
- By IP?
- By entity?
- Per size?
- Per day?

Ad creative endpoints are abuse magnets.

Define:
- IP limit
- entityId limit
- global circuit breaker

---

## 2. Observability

No mention of:
- generation duration tracking
- failure rate
- Blob upload failures
- queue backlog
- CAPI forwarding errors

You need:
- structured logging
- generation metrics
- alerting thresholds

Otherwise you won’t know when it degrades.

---

## 3. Ad Testing Strategy

You are generating:
```
"jov.ie/{username}"
"Claim your Jovie profile"
```

You should consider:
- CTA A/B testing
- Background gradient variation
- Headline variation

If you're building infrastructure — build it to test.

Add:
```
variant: string
```
to DB schema now.

Future you will thank you.

---

# Scalability Review

### Traffic Scenario:

If:
- 10,000 claim visits in 1 hour
- 4 sizes per profile
- 300ms per generation

You’re at:
> 40,000 image generations  
> ~3.3 hours CPU time burst

If not distributed — you’ll hit bottlenecks.

---

# Suggested Architecture Upgrade (Minimal Change)

1. Pixel event → enqueue job
2. Worker:
   - checks DB
   - generates missing sizes
   - uploads
   - writes record
3. API route just:
   - checks DB
   - returns Blob URL
   - if missing → enqueue async job + return 202

This makes system:
- resilient
- horizontally scalable
- burst-safe

---

# Security Review

### Username Injection

Since creative renders:
```
jov.ie/{username}
```

Sanitize:
- strip HTML
- enforce slug pattern
- max length

Otherwise you risk:
- layout breakage
- SVG injection inside next/og

---

# Final Scorecard

| Category | Score |
|----------|--------|
| Conceptual clarity | 9/10 |
| Scalability | 6.5/10 |
| Extensibility | 8/10 |
| Operational safety | 6/10 |
| Abuse protection | 5/10 |

Overall: **7.5/10 — strong foundation, needs production hardening.**

---

If you want, I can:

- Redesign this into a production-grade version 2 architecture
- Or pressure-test the revenue upside of this retargeting strategy itself


**Topic:** [[chatgpt-clusters/code_review]]
