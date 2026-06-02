---
title: "QA Check Request"
type: guide
created: 2026-05-09
updated: 2026-05-09
source: chatgpt-export
conversation_id: 69fe942b-2768-83e8-9565-1b5b240737d7
message_count: 7
tags: [chatgpt, import, code, long-form]
---
# QA Check Request

> Conversation ID: 69fe942b-2768-83e8-9565-1b5b240737d7
> Created: 2026-05-09T01:55:55Z
> Updated: 2026-05-09T02:11:22Z
> Messages: 7

---

## User

You have context of what we're building here. This is kind of a live implementation. I'd love for you to do a couple of things:
1. Know what's in linear and what's shifted recently and what's in your own memory.
2. Take a look at this screen and think about: is anything here broken?
One thing I see is that reliability 0% means there are no issues. I think that's actually supposed to be 100%. I think that's inverting the calculation. I'm not sure, but if it's showing 0, it means Century has no unresolved issues in the last 24 hours. Wouldn't that make reliability 100%?
It looks like it is not showing. I don't know. I would just crawl through all the main pages here and look around and let you know what is supposed to have landed and stuff. Can you just do a quick little QA check for me?

---

## Assistant

I’ll do a quick pass from three angles: current screen QA, recent Linear/GitHub context, and remembered project intent. I’ll treat the visible Ops page as primary evidence and flag anything inconsistent or ship-risky.

---

## Assistant

The first concrete issue is the reliability tile: with no unresolved Sentry issues, it should read as healthy/100%, and live Sentry wiring still appears backlog.

---

## Assistant

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

`getAdminReliabilitySummary()` includes `unresolvedSentryIssues24h`, but `getHudMetrics()` only forwards `errorRatePercent`, `p95LatencyMs`, `incidents24h`, and `lastIncidentAtIso`. The card cannot show the Sentry clean state because the HUD payload drops it. fileciteturn12file0 fileciteturn15file0

That explains your intuition: if Sentry has zero unresolved issues, the UI has no way to show “0 issues / healthy” right now.

### 3. Runway / default status are also semantically wrong when Mercury is unavailable

The screen shows:

> Runway ∞  
> Cash $0.00  
> Burn $0.00  
> Default status DEAD  
> Cannot calculate status: Mercury unavailable

That is internally contradictory. Unknown Mercury data should render as **Unknown / unavailable**, not `∞`, `$0`, and `DEAD`.

The code returns `runwayMonths: null` and `isDefaultAlive: false` when Stripe/Mercury cannot calculate. Then the UI formats `null` runway as `∞` and converts `false` into `DEAD`. fileciteturn12file0 fileciteturn22file0

Recommended behavior:

- Mercury unavailable → `Default status: UNKNOWN`
- Runway → `—`
- Cash / Burn → `Unavailable`
- Detail → `Cannot calculate: Mercury unavailable`

### 4. The active screen appears behind current `main`

The active page still shows **“Presentation view”** and the old **“Trigger.dev deploy check mismatch”** artifact. Current `main` shows the button text should be **“TV view”**, and the fixture should be **“Agent PR needs human review”** instead of the Trigger.dev item. fileciteturn21file0 fileciteturn23file0

PR `#8338` says it merged the Ops layout overhaul, renamed Presentation view to TV view, added dismiss/restore, and removed the Trigger.dev fixture. The active screen still showing the old content suggests the deployment is still catching up, the tab is stale, or production is serving an older build. PR `#8338` also had a Sonar quality gate failure for duplication despite merging, so I would keep an eye on that change. fileciteturn19file0

### 5. Mercury fix is not merged yet

The screen’s Mercury behavior lines up with the fact that PR `#8335` is still open. That PR fixes Mercury USD/cents handling and adds timeout resilience so a slow transactions fetch does not make all Mercury metrics unavailable. Until that lands, the current `Mercury unavailable → DEAD / ∞ / $0` behavior is expected from current code, though still bad UX. fileciteturn20file0

### 6. AgentOS fixture data looks too live

The panel has a small “WDK fixture” label, but most of the content reads like live operational state. Since `AgentOsRunsPanel` is currently being fed `AGENT_OS_ADMIN_FIXTURE_ARTIFACTS`, I would make the fixture/live boundary louder. fileciteturn21file0 fileciteturn23file0

Suggested copy:

> Fixture data — AgentOS live run ingestion not yet wired.

Or show a source badge per row:

> Source: fixture / GitHub / Hermes / CI / Linear

### 7. Possible stuck transition text

The active page context includes:

> Opening Releases  
> Preparing your release workspace.

If that was visibly on screen, it is likely a stuck route-transition/loading overlay. If it was only hidden DOM text, ignore it. If visible, it is a UI bug on the admin shell.

## Suggested immediate fix ticket

**Title:** Fix Ops HUD reliability score and unavailable financial state

**Acceptance criteria:**

1. Reliability card shows `100.00%` when `errorRatePercent = 0` and there are no unresolved Sentry issues.
2. HUD payload includes `unresolvedSentryIssues24h`.
3. Card subtitle shows Sentry issue count, e.g. `0 unresolved · p95 42ms`.
4. Error rate remains available as a separate field or secondary label.
5. Mercury unavailable renders `Unknown`, `—`, and `Unavailable`, never `DEAD`, `∞`, or `$0.00`.
6. Add tests for:
   - zero incident/error rate → 100% reliability
   - nonzero error rate → reduced reliability
   - Mercury unavailable → default status unknown
   - Sentry unavailable → reliability displays degraded/unknown source state
7. Verify production `/app/admin/ops` shows **TV view**, not **Presentation view**, after the latest main deployment completes.

My priority order: **Reliability label/calculation first, financial unknown-state second, stale deployment/main mismatch third.**

---

## User

Can you open up an issue for me for this? 

---

## Assistant

I’ll file a focused Linear issue for the Ops HUD reliability inversion and related unavailable-state bugs, with clear acceptance criteria for implementation.

---

## Assistant

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

For Sentry-specific clean state, preserve and expose `unresolvedSentryIssues24h` from `getAdminReliabilitySummary()` through `getHudMetrics()`.

For financial state, add an explicit default status variant:

```ts
defaultStatus: 'alive' | 'dead' | 'unknown'
```

Do not map unavailable Mercury data to `isDefaultAlive: false`.

## Acceptance criteria

- [ ] Ops HUD shows `Reliability 100.00%` when no incidents/errors are present.
- [ ] Reliability card no longer displays raw error rate under the label “Reliability.”
- [ ] HUD payload includes `unresolvedSentryIssues24h`.
- [ ] Reliability card subtitle includes unresolved Sentry issue count when configured.
- [ ] Sentry unavailable state is visible and does not silently render as healthy.
- [ ] Mercury unavailable state renders `UNKNOWN` / `—` / `Unavailable`, not `DEAD` / `∞` / `$0.00`.
- [ ] Unit tests cover:
  - zero error rate → 100% reliability
  - nonzero error rate → reduced reliability
  - Sentry unavailable → degraded/unknown source copy
  - Mercury unavailable → unknown default status
- [ ] Production/admin screen reflects current main labels and fixtures after deploy.
- [ ] Verify and fix/remove stuck “Opening Releases / Preparing your release workspace” text if visible.

## QA targets

- `/app/admin/ops`
- `/app/admin`
- `/app/admin/ops?mode=kiosk`
