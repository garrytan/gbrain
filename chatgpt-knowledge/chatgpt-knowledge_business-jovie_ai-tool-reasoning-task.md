---
title: "AI Tool Reasoning Task"
type: guide
created: 2026-05-20
updated: 2026-05-20
source: chatgpt-export
topic: business-jovie
message_count: 6
tags: [chatgpt, knowledge, business-jovie]
---
**Topic:** [[chatgpt-knowledge/_topics/business-jovie]]

# AI Tool Reasoning Task

> **Source:** ChatGPT conversation
> **Date:** 2026-05-20T04:22:59Z
> **Messages:** 6
> **Topic:** business-jovie

## Question

i want to test a new complex ai tool. give me a reasoning task for jovie that would meaningfully help us

## Answer

I’ll make this a Jovie-specific AI evaluation prompt that tests strategy, product judgment, data synthesis, GTM tradeoffs, and execution planning while producing a usable company artifact.

## Answer

Mr. White, use this task:

## Reasoning task: **AI Artist Manager: Catalog-to-Revenue Plan**

Jovie’s public positioning is “Monetize your music catalog with AI,” where users connect a catalog and Jovie turns releases into fan paths, presaves, or playlist pitches. It also positions Jovie as an “always-on AI artist manager.” citeturn571098view0

### Task prompt to give the AI tool

```text
You are acting as Jovie’s AI artist manager.

Goal:
Given an artist’s catalog, audience signals, release history, and constraints, decide the highest-leverage 30-day monetization plan.

You must reason through:
1. Which release or catalog asset should be activated first.
2. Whether the next best move is a fan path, presave campaign, playlist pitch, smart link campaign, content push, or audience reactivation.
3. Which audience segments should receive which actions.
4. What data is missing and how much it affects confidence.
5. What Jovie should automate versus what the artist/team should manually approve.

Inputs:
- Artist profile
- Full release catalog
- Streaming performance by track
- Save rate, skip rate, playlist adds, follower growth
- Smart link clicks
- Fan opt-ins
- Email/SMS/social audience data
- Recent campaign history
- Upcoming release dates
- Budget
- Team size
- Genre
- Geographic audience distribution
- Artist goals: revenue, fan growth, playlisting, presaves, touring, merch, or catalog revival

Output:
Produce a 30-day operating plan with:
- Executive recommendation
- Ranked opportunity list
- Reasoning for the top 3 opportunities
- Campaign calendar
- Fan segmentation plan
- Specific Jovie automations to trigger
- Manual approvals needed from the artist/team
- Expected upside
- Risks
- Missing data
- Confidence score
- “Do not do” list explaining low-value actions
```

### Add this test case

```text
Artist: Independent electronic artist
Genre: melodic house / techno
Catalog: 24 releases over 3 years
Upcoming release: single in 18 days
Team: artist + part-time manager
Budget: $750
Goal: grow presaves for upcoming release, reactivate older fans, and increase catalog streams

Signals:
- Latest single: 86,000 streams, 9.2% save rate, 22% skip rate
- Best catalog track: 1.8M streams, 14% save rate, 18% skip rate, released 16 months ago
- Recent smart link campaign: 4,200 clicks, 310 fan opt-ins
- Email list: 2,800 fans, 38% open rate, 4.5% click rate
- SMS list: 420 fans, 18% click rate
- Top markets: Los Angeles, London, Amsterdam, Berlin, Mexico City
- Spotify followers: 19,500
- Instagram: 42,000 followers, weak link click-through
- TikTok: 8,000 followers, one old sound with 600 creator uses
- Previous playlist pitches were generic and inconsistent
- Artist has 6 unreleased short-form videos and 2 live clips
- Manager can spend 5 hours/week
```

### What makes this a good complex-AI test

This tests whether the tool can do **business reasoning**, not just content generation. A strong answer should connect catalog data, fan behavior, release 

*(Answer truncated — 4740 chars total)*

## Question

in less than 3 seocnds:


## Answer

The output is structured and fast, but speed alone is masking several reasoning weaknesses worth testing.

## Answer

Mr. White, **fast answer: speed passed, reasoning failed.**

The output looks polished, but it has several product-relevant problems:

## Biggest issues

1. **Impossible forecast**
   - Claims **5–10k presaves** from a 2,800-person email list, 420 SMS list, and prior 4,200 smart-link clicks. That is likely inflated.
   - This is useful: Jovie needs guardrails against fake precision and unrealistic growth projections. fileciteturn0file0

2. **Bad metric reasoning**
   - It says a 12% lift on the 1.8M-stream catalog track equals **215k extra streams**.
   - That treats lifetime streams as the baseline. It should use recent monthly streams, not total historical streams. fileciteturn0file0

3. **Privacy/API hallucination**
   - It says Jovie can automatically tag users who “streamed any Jovie track in the last 90 days” via Spotify data.
   - That data is generally unavailable at individual-fan level. This is a serious product hallucination. fileciteturn0file0

4. **Contradictory execution plan**
   - It says only the top 4 opportunities will be executed, but the calendar includes playlist pitching and email-only catalog actions beyond that. fileciteturn0file0

5. **Weak constraint handling**
   - It says total manager time is **5h30m** and still calls it within a **5h/week** limit. That should have been flagged. fileciteturn0file0

## Better 3-second benchmark prompt

Use this:

```text
You are Jovie’s AI artist manager.

Given the artist data below, choose exactly ONE primary campaign for the next 18 days.

Constraints:
- $750 max budget
- Manager has 5 hours/week
- Upcoming single releases in 18 days
- Do not assume access to individual Spotify listener identities
- Do not use lifetime streams as a 30-day forecast baseline
- Give only realistic forecasts

Artist data:
- 24 releases over 3 years
- Best catalog track: 1.8M lifetime streams, 14% save rate, 18% skip rate, released 16 months ago
- Latest single: 86k streams, 9.2% save rate, 22% skip rate
- Email: 2,800 fans, 38% open rate, 4.5% click rate
- SMS: 420 fans, 18% click rate
- Recent smart link: 4,200 clicks, 310 opt-ins
- Top markets: LA, London, Amsterdam, Berlin, Mexico City
- TikTok: 8k followers, one old sound with 600 creator uses
- Instagram: 42k followers, weak link CTR
- 6 short-form videos, 2 live clips

Output:
1. Primary recommendation
2. Why this beats the alternatives
3. 18-day action plan
4. Budget allocation
5. What Jovie should automate
6. What requires approval
7. Realistic forecast
8. Top 5 assumptions
9. Top 5 failure risks
10. Product features Jovie should build based on this case
```

## Scoring rule

The AI passes only if it:

- Refuses fake precision.
- Uses recent conversion math.
- Separates lifetime streams from current opportunity.
- Avoids claiming individual Spotify listener tracking.
- Picks one main strategy.
- Produces a plan that fits $750 and 5 hours/week.

This is a better test because it pressures the model on **business judgment, data real

*(Answer truncated — 3082 chars total)*
