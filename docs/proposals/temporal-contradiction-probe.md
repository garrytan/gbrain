# Proposal: Temporal Axis for Contradiction Probe

**Status:** Report / RFC  
**Author:** Wintermute (via Garry Tan)  
**Date:** 2026-05-14  
**Context:** 115 HIGH contradiction findings resolved in garrytan/brain; residual findings exposed fundamental probe limitation  

## The Problem

The contradiction probe (`gbrain eval suspected-contradictions`) treats all claims as timeless. When two chunks make conflicting statements, the judge flags a contradiction regardless of whether both statements were true at their respective points in time.

This worked fine when the brain was mostly static wiki pages. It breaks now that the brain contains:
- **92+ conversation transcripts** with claims that were true when spoken
- **Meeting pages** capturing what people said on specific dates  
- **Takes** that evolve (a founder's ARR claim in January vs July)
- **Life events** that supersede each other (trial separation → permanent)

The probe can't distinguish "this changed" from "this is wrong."

## Real Examples from Production

### 1. Temporal Evolution (False Positive)

```
Finding: HIGH
  A: [daily/transcripts/2026/2026-04-28] "trial separation"
  B: [meetings/2026-05-07-donna-couples-session] "permanent separation, confirmed"
  Axis: Whether separation is trial or permanent
```

Both are correct. April 28: trial. May 7: permanent. The probe flags this because it has no concept of "this claim was valid from X until Y." The May 7 session didn't make the April 28 transcript wrong — it recorded a change.

### 2. Negation Parsing (False Positive)

```
Finding: HIGH
  A: [people/cora-hew] "Garry traveled to Toronto for Cora Hew's funeral — NOT grandmother's funeral"
  B: [meetings/2026-05-11-family-dinner-toronto] mentions of funeral context
  Axis: Whose funeral the Toronto trip was for
```

The disambiguation fact contains "NOT grandmother's funeral" as an explicit negation. The judge reads "grandmother's funeral" as a positive claim and flags it against the Cora context. The data is correct — the probe can't parse negation.

### 3. Role Changes (True Positive That Needs Time Awareness)

```
Finding: HIGH
  A: [sources/apple-notes/2017-03-28] Sriram Krishnan: "Partner - AI/ML/Eng"
  B: [people/sriram-krishnan] Sriram Krishnan: "Senior White House AI Policy Advisor"
```

Both true. 2019: partner at a16z. 2025: WH advisor. The current probe correctly flags this as a contradiction, but the resolution should be "superseded by time" not "one side is wrong." The Apple Note isn't wrong — it's a historical record.

## Scenario #1: Founder Tracking (The Big One)

This is the use case that makes a time axis transformative rather than incremental.

The brain has ~790 company pages and thousands of meeting pages from YC office hours. Founders make claims:

- "We're at $50K MRR" (January OH)
- "We hit $200K MRR" (April OH)  
- "We're at $150K MRR" (July OH — wait, what happened?)

Today the probe would flag January vs April as a contradiction. But the real signal is April vs July — **a claimed metric went backwards.** That's not a data quality issue. That's intelligence.

What a time-aware probe could surface:

**Claim trajectory tracking:**
```
Company: Acme Corp
  2026-01: "$50K MRR" (source: OH transcript)
  2026-04: "$200K MRR" (source: OH transcript)  
  2026-07: "$150K MRR" (source: OH transcript) ← REGRESSION DETECTED
  2026-07: "$2M ARR" (source: investor update) ← INCONSISTENT WITH MRR
```

**Prediction vs outcome:**
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
  2026-01: "Our moat is proprietary data" (source: YC interview)
  2026-03: "We're pivoting to an API-first model" (source: OH)
  2026-06: "Our moat is network effects" (source: Demo Day)
  → Moat narrative changed 3x in 6 months — flag for review
```

This isn't adversarial. It's the kind of pattern a great investor notices intuitively across hundreds of conversations. GBrain can make it systematic.

## Scenario #2: Personal Life Event Disambiguation

Two deaths three weeks apart (grandmother in Singapore, April; aunt in Toronto, May). Meeting ingestion conflated them because the probe had no temporal frame to say "the April funeral is a different event from the May funeral."

Time-aware facts would store:
```
fact: "grandmother died" valid_from: 2026-04-15 valid_until: 2026-04-15
fact: "grandmother funeral in Singapore" valid_from: 2026-04-17 valid_until: 2026-04-19
fact: "Cora Hew died" valid_from: 2026-05-04 valid_until: 2026-05-04
fact: "Cora Hew funeral in Toronto" valid_from: 2026-05-12 valid_until: 2026-05-12
```

The probe should recognize these as two distinct events with non-overlapping time windows, not as contradictions about "whose funeral."

## Scenario #3: Role and Status Changes

People change roles. Companies change status. The brain records history. Examples from the current probe:

- Sriram Krishnan: a16z partner (2019) → WH AI advisor (2025)
- Garry Tan: Initialized Capital partner → YC CEO (2023)
- OpenClaw: Anthropic restriction event (2026-04-04) ≠ shutdown
- Josh France: "interesting fund" (early) → "declined" (later) → "losing confidence" (latest)

All of these are correct historical records. The probe should classify them as **temporal supersession** not **contradiction.**

## Scenario #4: Negotiation and Decision Tracking

Separation process example:
```
2026-04-24: "trial separation" (initial framing)
2026-04-25: "it's happening" (confirmed, no longer "trial")
2026-05-07: "permanent, crystallized" (Donna session)
2026-05-11: Three consultations with divorce attorneys
```

Each step supersedes the previous. A time-aware probe would show the **evolution chain** rather than flagging each pair as a contradiction.

## What Exists Today

The probe already has some temporal infrastructure:

1. **`date-filter.ts`** — `shouldSkipForDateMismatch()` pre-filters pairs, but only checks if dates are "too far apart" (a coarse heuristic). It doesn't reason about which claim is newer or whether one supersedes the other.

2. **`auto-supersession.ts`** — proposes resolution commands, checks `since_date` on takes. But this is post-hoc (after the judge flags a contradiction). The judge itself doesn't see dates.

3. **Facts table** has `valid_from` and `valid_until` columns. These exist but are sparsely populated and not used by the probe.

4. **Takes table** has `since_date`. Also sparsely populated.

## What Would Need to Change

### Phase 1: Judge prompt enhancement (smallest change, biggest impact)

Pass the source dates to the judge. The current judge prompt shows two text chunks and asks "are these contradictory?" If it also showed:

```
Statement A (from: 2026-04-28):
  "trial separation"

Statement B (from: 2026-05-07):
  "permanent separation, confirmed"
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
gbrain eval trajectory "Sriram Krishnan role"  
gbrain eval trajectory "separation status"
```

Pull all time-stamped claims about an entity+attribute, sort chronologically, detect:
- Regressions (metric went down)
- Contradictions within the same time window
- Prediction vs outcome gaps
- Narrative drift (moat story changed 3x)

### Phase 3: Automatic `valid_from`/`valid_until` population

During `extract_facts`, infer temporal bounds from source context:
- Meeting page dated 2026-04-28 → claims valid_from 2026-04-28
- Takes from transcripts → valid_from = transcript date
- Apple Notes → valid_from = note date
- Entity pages with no date → valid_from = page created date (weakest signal)

### Phase 4: Founder scorecard (Argus integration)

For YC founders specifically, a temporal probe could generate:
- **Claim accuracy score** — what they predicted vs what happened
- **Consistency score** — how stable their narrative is over time
- **Growth trajectory** — are the numbers actually moving
- **Red flag detector** — metrics going backwards, story changing, timeline slipping

This is Argus's "Throughput" and "Planning" axes with teeth.

## Recommendation

Start with Phase 1. The judge prompt change is ~20 lines. It immediately eliminates the temporal false positives (which are currently ~60% of HIGH findings in production) and gives the probe a new vocabulary for time-aware reasoning.

Phase 2 (trajectory view) is the one that would change how Garry uses the brain for founder evaluation. Worth scoping as a standalone feature.

Phases 3-4 are downstream and can wait.

## Appendix: Current Probe Stats (garrytan/brain, 2026-05-14)

- **107K pages**, **~257K chunks**
- Previous run: 115 HIGH findings across 50 queries
- After manual resolution: ~25 residual findings
- Of those ~25: ~15 are temporal false positives, ~10 are probe artifacts (self-contradiction, negation parsing)
- **0 genuine data contradictions remain** on the queries tested
- Fresh targeted probe on "Garry Tan role at YC": **0 contradictions** (was 14+ before fixes)
