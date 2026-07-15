# Proposal: Temporal Axis for Contradiction Probe

**Status:** Report / RFC
**Date:** 2026-05-14
**Context:** A large production run of `gbrain eval suspected-contradictions` surfaced ~115 HIGH findings. Walking through them by hand exposed a structural limitation in the probe.

## The Problem

The contradiction probe (`gbrain eval suspected-contradictions`) treats all claims as timeless. When two chunks make conflicting statements, the judge flags a contradiction regardless of whether both statements were true at their respective points in time.

This worked fine when the brain was mostly static wiki pages. It breaks now that the brain contains:
- Conversation transcripts with claims that were true when spoken
- Meeting pages capturing what people said on specific dates
- Takes that evolve (a founder's ARR claim in January vs. July)
- Status records that supersede each other (a state moves from "trial" to "confirmed")

The probe can't distinguish "this changed" from "this is wrong."

## Bug-class examples (synthetic placeholders)

### 1. Temporal Evolution (False Positive)

```
Finding: HIGH
  A: [daily/transcripts/2026/2026-04-28] "status: trial"
  B: [meetings/2026-05-07-session] "status: confirmed"
  Axis: Whether status is trial or confirmed
```

Both are correct as of their respective dates. April 28: trial. May 7: confirmed. The probe flags this because it has no concept of "this claim was valid from X until Y." The May 7 record didn't make the April 28 transcript wrong; it recorded a change.

### 2. Negation Parsing (False Positive)

```
Finding: HIGH
  A: [people/alice-example] "person traveled to city-a for alice-example's event — NOT bob-example's event"
  B: [meetings/2026-05-11-context] mentions of bob-example's event in city-b
  Axis: Whose event the city-a trip was for
```

The disambiguation fact contains "NOT bob-example's event" as an explicit negation. The judge reads "bob-example's event" as a positive claim and flags it against the alice-example context. The data is correct; the probe can't parse negation.

### 3. Role Changes (True Positive That Needs Time Awareness)

```
Finding: HIGH
  A: [sources/notes/2017-03-28] advisor-example: "Partner, venture-firm-a"
  B: [people/advisor-example] advisor-example: "Senior Policy Advisor, gov-org-b"
```

Both true at their respective times. 2017: partner at venture-firm-a. 2025: gov-org-b advisor. The current probe correctly flags this as a contradiction, but the resolution should be "superseded by time" not "one side is wrong." The 2017 note isn't wrong; it's a historical record.

## Scenario #1: Founder Tracking (the big one)

This is the use case that makes a time axis transformative rather than incremental.

The brain holds hundreds of company pages and thousands of meeting pages. Founders make claims:

- "We're at $50K MRR" (January OH)
- "We hit $200K MRR" (April OH)
- "We're at $150K MRR" (July OH — what happened?)

Today the probe would flag January vs. April as a contradiction. The real signal is April vs. July: **a claimed metric went backwards.** That's not a data quality issue; that's intelligence.

What a time-aware probe could surface:

**Claim trajectory tracking:**
```
Company: Acme Corp
  2026-01: "$50K MRR" (source: OH transcript)
  2026-04: "$200K MRR" (source: OH transcript)
  2026-07: "$150K MRR" (source: OH transcript) ← REGRESSION DETECTED
  2026-07: "$2M ARR" (source: investor update) ← INCONSISTENT WITH MRR
```

**Prediction vs. outcome:**
```
Founder: Jane Doe (Acme Corp)
  2026-01: "We'll hit $1M ARR by June" (source: batch kickoff)
  2026-06: Actual ARR: $400K (source: investor update)
  → Prediction accuracy: 40%
  → Pattern: consistently 2-3x optimistic on timeline
```

**Narrative consistency:**
```
Founder: John Smith (WidgetCo)
  2026-01: "Our moat is proprietary data" (source: interview)
  2026-03: "We're pivoting to an API-first model" (source: OH)
  2026-06: "Our moat is network effects" (source: Demo Day)
  → Moat narrative changed 3x in 6 months — flag for review
```

This isn't adversarial. It's the kind of pattern an experienced operator notices intuitively across hundreds of conversations. GBrain can make it systematic.

## Scenario #2: Event Disambiguation

Two distinct events within a short window can conflate during ingestion because the probe has no temporal frame to say "event A is a different event from event B."

Time-aware facts would store (synthetic placeholders):
```
fact: "alice-example milestone" valid_from: 2026-04-15 valid_until: 2026-04-15
fact: "alice-example event in city-a" valid_from: 2026-04-17 valid_until: 2026-04-19
fact: "bob-example milestone" valid_from: 2026-05-04 valid_until: 2026-05-04
fact: "bob-example event in city-b" valid_from: 2026-05-12 valid_until: 2026-05-12
```

The probe should recognize these as two distinct events with non-overlapping time windows, not as contradictions about "whose event."

## Scenario #3: Role and Status Changes

People change roles. Companies change status. The brain records history. Synthetic examples representative of the cases observed in production:

- advisor-example: venture-firm-a partner (2019) → gov-org-b advisor (2025)
- investor-example: fund-a partner → fund-b CEO (2023)
- agent-fork: provider restriction event (2026-04-04) ≠ shutdown
- fund-c: "interesting fund" (early) → "declined" (later) → "losing confidence" (latest)

All of these are correct historical records. The probe should classify them as **temporal supersession** rather than **contradiction.**

## Scenario #4: Decision Tracking

Multi-step decisions that supersede earlier framings example (synthetic):
```
2026-04-24: "status: trial" (initial framing)
2026-04-25: "status: in progress" (confirmed, no longer "trial")
2026-05-07: "status: finalized" (session record)
2026-05-11: follow-up actions taken
```

Each step supersedes the previous. A time-aware probe would show the **evolution chain** rather than flagging each pair as a contradiction.

## What Exists Today

The probe already has some temporal infrastructure:

1. **`date-filter.ts`** — `shouldSkipForDateMismatch()` pre-filters pairs, but only checks whether dates are "too far apart" (a coarse heuristic). It doesn't reason about which claim is newer or whether one supersedes the other.

2. **`auto-supersession.ts`** — proposes resolution commands, checks `since_date` on takes. But this is post-hoc (after the judge flags a contradiction). The judge itself doesn't see dates.

3. **Facts table** has `valid_from` and `valid_until` columns. These exist but are sparsely populated and not used by the probe.

4. **Takes table** has `since_date`. Also sparsely populated.

## What Would Need to Change

### Phase 1: Judge prompt enhancement (smallest change, biggest impact)

Pass the source dates to the judge. The current judge prompt shows two text chunks and asks "are these contradictory?" If it also showed:

```
Statement A (from: 2026-04-28):
  "status: trial"

Statement B (from: 2026-05-07):
  "status: confirmed"
```

The judge could output a `temporal_supersession` verdict instead of `contradiction`. New verdict taxonomy:

- `no_contradiction` — statements are compatible
- `contradiction` — genuinely conflicting claims at the same point in time
- `temporal_supersession` — newer claim updates/replaces older claim (not an error)
- `temporal_regression` — a metric or status went backwards (potential signal)
- `temporal_evolution` — legitimate change over time, neither supersession nor regression
- `negation_artifact` — one side contains an explicit negation the judge misread

### Phase 2: Claim trajectory view (new command)

```bash
gbrain eval trajectory "Acme Corp MRR"
gbrain eval trajectory "advisor-example role"
gbrain eval trajectory "deal-x status"
```

Pull all time-stamped claims about an entity+attribute, sort chronologically, detect:
- Regressions (metric went down)
- Contradictions within the same time window
- Prediction vs. outcome gaps
- Narrative drift (moat story changed 3x)

### Phase 3: Automatic `valid_from`/`valid_until` population

During `extract_facts`, infer temporal bounds from source context:
- Meeting page dated 2026-04-28 → claims valid_from 2026-04-28
- Takes from transcripts → valid_from = transcript date
- Imported notes → valid_from = note date
- Entity pages with no date → valid_from = page created date (weakest signal)

### Phase 4: Founder scorecard

For founders specifically, a temporal probe could generate:
- **Claim accuracy score** — what they predicted vs. what happened
- **Consistency score** — how stable their narrative is over time
- **Growth trajectory** — whether the numbers are actually moving
- **Red flag detector** — metrics going backwards, story changing, timeline slipping

## Recommendation

Start with Phase 1. The judge prompt change is small. It immediately eliminates the temporal false positives (which were a majority of the residual HIGH findings in the production audit) and gives the probe a new vocabulary for time-aware reasoning.

Phase 2 (trajectory view) is the one that would change how operators use the brain for founder evaluation. Worth scoping as a standalone feature.

Phases 3–4 are downstream and can wait.

## Appendix: Production probe stats (2026-05-14)

- ~107K pages, ~257K chunks
- Previous run: ~115 HIGH findings across 50 queries
- After manual resolution: ~25 residual findings
- Of those ~25: roughly two-thirds temporal false positives, the remainder probe artifacts (self-contradiction, negation parsing)
- 0 genuine data contradictions remained on the queries tested
- Fresh targeted probe on a representative entity-role query: 0 contradictions (was 14+ before fixes)
