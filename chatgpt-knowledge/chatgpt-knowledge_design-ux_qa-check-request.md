---
title: "QA Check Request"
type: guide
created: 2026-05-09
updated: 2026-05-09
source: chatgpt-export
topic: design-ux
message_count: 7
tags: [chatgpt, knowledge, design-ux]
---
**Topic:** [[chatgpt-knowledge/_topics/design-ux]]

# QA Check Request

> **Source:** ChatGPT conversation
> **Date:** 2026-05-09T01:55:55Z
> **Messages:** 7
> **Topic:** design-ux

## Question

You have context of what we're building here. This is kind of a live implementation. I'd love for you to do a couple of things:
1. Know what's in linear and what's shifted recently and what's in your own memory.
2. Take a look at this screen and think about: is anything here broken?
One thing I see is that reliability 0% means there are no issues. I think that's actually supposed to be 100%. I think that's inverting the calculation. I'm not sure, but if it's showing 0, it means Century has no unresolved issues in the last 24 hours. Wouldn't that make reliability 100%?
It looks like it is not showing. I don't know. I would just crawl through all the main pages here and look around and let you know what is supposed to have landed and stuff. Can you just do a quick little QA check for me?

## Answer

I’ll do a quick pass from three angles: current screen QA, recent Linear/GitHub context, and remembered project intent. I’ll treat the visible Ops page as primary evidence and flag anything inconsistent or ship-risky.

## Answer

The first concrete issue is the reliability tile: with no unresolved Sentry issues, it should read as healthy/100%, and live Sentry wiring still appears backlog.

## Answer

Mr. White, quick QA result: **yes, the Reliability card is broken semantically.** The current code displays `metrics.reliability.errorRatePercent` under the label **Reliability**, so a clean state renders as `0.00%`. If the card is meant to represent reliability, `0 unresolved Sentry issues / 0 incident rate` should read as **100% reliability**. The clean fix is to add a separate `reliabilityScorePercent` field and keep `errorRatePercent` as its own metric. The current implementation also fetches Sentry unresolved issue data, but the Ops HUD does not actually expose that field on the card. fileciteturn15file0 fileciteturn16file0 fileciteturn22file0

## What recently shifted

**Ops / AgentOS work has partially landed.** `JOV-1941` is Done and was intended to add the private `/admin/ops` AgentRunArtifact panel with status, model route, approval state, and verification gate progress. fileciteturn5file0

**Shipping Velocity landed in Linear.** `JOV-2006` is Done and specifies the `/app/admin/ops` shipping velocity chart using GitHub GraphQL, Redis cache, `7D / 30D / 1Y`, merged/opened/closed series, and chart states. fileciteturn6file0

**The Sentry/CI/Linear event wiring has not landed.** `JOV-1999` is still Backlog, so anything claiming to be live Sentry/CI/Linear event-backed should be treated cautiously unless it is using a separate direct fetch. fileciteturn7file0

**The Reliability department agent has not landed.** `JOV-2009` is still Backlog; the screen should not imply a mature reliability agent loop yet. fileciteturn8file0

**Linear is slightly inconsistent.** The parent HUD v0 issue `JOV-1864` is still Todo even though child pieces are landing and visible. That makes status tracking muddy. fileciteturn4file0

**A new major focus area was created:** `JOV-2018`, the Public Profile Hardening epic, with 11 sub-issues covering mobile-native shell, bottom tab bar, subscribe flow, no-horizontal-overflow, metadata, Gmail link opening, performance, and final QA. fileciteturn26file0

## Likely broken on this screen

### 1. Reliability card is using the wrong metric

Current card:

> Reliability  
> 0.00%  
> p95 42ms

The code renders:

```ts
value={`${metrics.reliability.errorRatePercent.toFixed(2)}%`}
```

under label `Reliability`. That is an **error rate**, not a reliability score. fileciteturn22file0

Recommended fix:

```ts
const reliabilityScorePercent = Math.max(
  0,
  Math.min(100, 100 - metrics.reliability.errorRatePercent)
);
```

Then display:

> Reliability  
> 100.00%  
> 0 unresolved Sentry issues · p95 42ms

Even better: keep both fields in the data contract:

```ts
reliability: {
  reliabilityScorePercent: number;
  errorRatePercent: number;
  unresolvedSentryIssues24h: number;
  p95LatencyMs: number | null;
  incidents24h: number;
}
```

### 2. Sentry data is fetched, then mostly hidden

`getAdminReliabilitySummary()` includes `unresolvedSentryIssues24h`, but `getHudMetrics()` only forwards `errorRate

*(Answer truncated — 7134 chars total)*

## Question

Can you open up an issue for me for this? 

## Answer

I’ll file a focused Linear issue for the Ops HUD reliability inversion and related unavailable-state bugs, with clear acceptance criteria for implementation.

## Answer

Mr. White, I couldn’t create the Linear issue directly from this session because the Linear connector exposed search/read tools, not issue creation. Use this:

```markdown
Title: Fix Ops HUD reliability score, unavailable financial state, and stale UI indicators

Priority: High
Labels: area:ops, area:ui, agentos, type:bug
Parent: JOV-1864 or JOV-1965

## Problem

The Ops HUD currently shows `Reliability 0.00%` when there are no unresolved Sentry issues / no incidents. That reads as total failure, but the underlying state appears healthy. If the card is meant to represent reliability, a clean state should display `100.00%`.

There are also related semantic issues in the Ops/Admin surfaces:

- Mercury unavailable can render `Runway ∞`, `Cash $0.00`, `Burn $0.00`, and `Default status DEAD`, which is misleading. Unknown financial data should render as unknown/unavailable, not as zero cash, zero burn, infinite runway, or dead.
- Sentry unresolved issue count is fetched in the reliability summary but not surfaced clearly in the HUD reliability card.
- The active production UI may be stale: current main expects “TV view” and a generic “Agent PR needs human review” fixture, while the live screen still showed “Presentation view” and the old Trigger.dev fixture.
- `/app/admin` also appears to include stale route-transition text: “Opening Releases / Preparing your release workspace.” Verify whether this is visible or hidden DOM; if visible, it is a stuck shell/loading-state bug.

## Expected behavior

### Reliability

- `errorRatePercent = 0` renders `Reliability 100.00%`.
- Nonzero error rate reduces the reliability score.
- The card distinguishes reliability score from error rate.
- The subtitle includes useful context such as:
  - `0 unresolved · p95 42ms`
  - `3 unresolved · p95 120ms`
  - `Sentry unavailable · p95 42ms`

### Financial/default status

When Mercury is unavailable or partially unavailable:

- Runway renders `—` or `Unknown`, not `∞`.
- Cash and burn render `Unavailable`, not `$0.00`.
- Default status renders `UNKNOWN`, not `DEAD`.
- Detail copy says exactly which source is unavailable.

### Stale UI/deploy verification

- `/app/admin/ops` shows `TV view`, not `Presentation view`.
- AgentOS fixture no longer mentions the stale Trigger.dev blocked fixture if main has removed it.
- Verify whether the stale “Opening Releases / Preparing your release workspace” text is visible; remove or fix stuck transition state if visible.

## Implementation notes

Add a separate field to the HUD reliability payload instead of overloading `errorRatePercent`:

```ts
reliability: {
  reliabilityScorePercent: number;
  errorRatePercent: number;
  unresolvedSentryIssues24h: number;
  p95LatencyMs: number | null;
  incidents24h: number;
}
```

Suggested reliability calculation for v0:

```ts
const reliabilityScorePercent = Math.max(
  0,
  Math.min(100, 100 - errorRatePercent)
);
```

For Sentry-specific clean state, preserve and expose `unresolvedSentryIssues24

*(Answer truncated — 4256 chars total)*
