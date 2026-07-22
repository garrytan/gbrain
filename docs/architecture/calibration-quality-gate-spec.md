# Calibration Quality Gate — Falsifiability Filter + Category Classification

> **Historical context.** This is the source spec absorbed from PR #1191 into
> two waves of implementation:
>
> - **v0.37.2.0 hotfix** (this release): widens the `takes_resolution_consistency`
>   CHECK constraint to accept `quality='unresolvable'` as a 4th valid state.
>   Unblocks the production grading script. Adds `unresolvable_count` +
>   `unresolvable_rate` to `TakesScorecard` as sibling fields (preserves
>   v0.36.1.0 historical comparison semantics). Migration renumbered v74→v79→v80
>   during successive master merges — v0.37.0.0's autonomous-remediation wave
>   claimed v68-v78, then v0.37.1.0 (brainstorm/lsd) claimed v79.
> - **Follow-up minor** (forthcoming): falsifiability + category extraction at
>   `propose_takes`, SQL-side grade gate, per-category calibration scorecards,
>   pg_trgm-based proposal dedup. Wave-blocking on cat15 F1 re-validation
>   against the v0.36.1.0 fixtures.
>
> Preserved here per the hotfix plan's PR #1191 close protocol so the
> production context (96K-page brain, 6.8% falsifiability rate, category
> breakdown) doesn't get lost in the CHANGELOG → release-notes condensation.

## Problem

v0.36.1.0 ships `propose_takes`, `grade_takes`, and `calibration_profile` as a
connected pipeline: extract claims → grade them against outcomes → build a
calibration profile showing systematic biases.

In production on a 96K-page brain with 36K takes across 6,239 holders, the
grade_takes phase produces noisy results:

- **6.8% falsifiability rate**: Of 500 candidate takes (weight ≥ 0.7), only 34
  passed an LLM falsifiability filter. The other 93% were philosophical beliefs,
  present-state observations, advice, logistics, or vague vibes.
- **50% unresolvable**: Even after filtering, 17/34 predictions couldn't be
  graded because evidence was insufficient or the claim was too ambiguous.
- **Duplicates**: Same claim from the same page extracted multiple times with
  slightly different wording.

The root cause: `propose_takes` extracts everything that looks like a belief or
assertion. That's correct for the *takes* table (epistemological layer), but
`grade_takes` needs a much narrower subset: **falsifiable predictions about
future outcomes** where we can check what actually happened.

### Example classifications from production testing

**Genuine predictions (grade-worthy):**
- "X will reach $1M ARR very soon" → company_outcome
- "X is going to leave Y" → people_move  
- "AI will make authentic authorship more important" → technology
- "X was convinced Y would win the Z market" → market_call

**Not predictions (should skip grading):**
- "Desire is mimetic" → philosophical belief
- "X should charge 10x more" → advice
- "Return from Toronto on Monday" → logistics
- "Something is going to happen there" → vague/unfalsifiable
- "X is growing very quickly" → present-state observation

## Solution

### 1. Falsifiability score at extraction time

Add a `falsifiability` column to the `takes` table (real, 0.0–1.0, nullable,
default null). `propose_takes` sets this during extraction using the same LLM
call that already produces the take — one additional field in the JSON schema.

```sql
ALTER TABLE takes ADD COLUMN IF NOT EXISTS falsifiability real;
ALTER TABLE takes ADD COLUMN IF NOT EXISTS falsifiability_category text;
```

The LLM prompt addition (appended to the existing propose_takes extraction prompt):

```
For each claim, also assess:
- falsifiability (0.0-1.0): Can this claim be checked against future reality?
  1.0 = specific, measurable, time-bounded prediction about an outcome
  0.5 = directional claim that's partially checkable
  0.0 = philosophical belief, advice, observation, or unfalsifiable assertion
- falsifiability_category: one of
  company_outcome | fundraising | technology | people_move | market_call | other_prediction | not_prediction
```

Cost: ~0 incremental tokens (the claim is already being extracted; this adds
two fields to the JSON output schema).

### 2. Grade gate in `grade_takes`

Before attempting grading, filter:

```typescript
const gradeable = candidates.filter(t =>
  t.falsifiability !== null && t.falsifiability >= 0.7
  && t.falsifiability_category !== 'not_prediction'
);
```

This reduces grading volume by ~93% in production, which means:
- LLM cost for grading drops proportionally
- Evidence retrieval load drops (each grade attempt triggers hybrid search)
- Calibration profiles are built on real predictions, not noise

### 3. Deduplication at extraction

`propose_takes` should check for near-duplicate claims before inserting:

```typescript
// Before inserting a new take, check if a similar claim exists
// for the same holder from the same page
const existing = await engine.sql`
  SELECT id, claim FROM takes
  WHERE holder = ${holder}
  AND page_id = ${pageId}
  AND similarity(claim, ${newClaim}) > 0.8
  LIMIT 1
`;
if (existing.length > 0) {
  // Skip — near-duplicate
  continue;
}
```

Requires `pg_trgm` extension (already available on most Postgres installations).
Falls back gracefully: if `similarity()` isn't available, skip the dedup check.

### 4. Category-aware calibration profiles

The `calibration_profile` phase can now group resolved takes by
`falsifiability_category` to produce per-domain scorecards:

```
"Your company_outcome calls are 73% accurate.
 Your people_move calls are 90% accurate.
 Your technology calls are 60% accurate — you tend to be ~18 months early."
```

This is the tweetable output: a calibration profile that says "here's how you're
systematically right and wrong by category."

## Schema Changes

```sql
-- Migration: add falsifiability columns to takes
ALTER TABLE takes ADD COLUMN IF NOT EXISTS falsifiability real;
ALTER TABLE takes ADD COLUMN IF NOT EXISTS falsifiability_category text;

-- Index for grade_takes filter
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_takes_falsifiability
  ON takes (falsifiability)
  WHERE falsifiability IS NOT NULL AND falsifiability >= 0.7;

-- Optional: pg_trgm for dedup (CREATE EXTENSION IF NOT EXISTS pg_trgm;)
```

## Evidence Retrieval (v0.36.1.0 → v0.37 enhancement)

The current `grade_takes` evidence retriever returns a stub placeholder. In
production testing, we wired real evidence retrieval via `gbrain query` (hybrid
search). The pattern that works:

1. Extract the core claim from the take (first 150 chars)
2. Run `engine.query(claim)` to get relevant pages
3. Filter to pages updated AFTER the take's `since_date` (evidence must be newer)
4. Pass top-5 chunks as the evidence block to the judge

This should replace the stub in the `evidenceRetriever` injection point.

## Production Results

After implementing the falsifiability filter (as a pre-processing step outside
the cycle):

| Metric | Before (v2, no filter) | After (v3, with filter) |
|--------|----------------------|----------------------|
| Candidates evaluated | 50 | 34 (from 500 screened) |
| Falsifiable predictions | ~19 (38%) | 34 (100%) |
| Correct | 10 (52.6% of resolvable) | 10 (58.8% of resolvable) |
| Incorrect | 5 (26.3%) | 2 (11.8%) |
| Partial | 4 (21.1%) | 5 (29.4%) |
| Unresolvable | 31 (62%) | 17 (50%) |
| Category breakdown | N/A | people_move:13, company_outcome:11, technology:4, market_call:2 |

Key improvement: **the false positive rate dropped from 62% noise to 0% noise**
in the gradeable set. The remaining 50% unresolvable rate is genuine — those
predictions are about outcomes that haven't happened yet or where the brain
lacks evidence. That's correct behavior, not noise.

## Files to Change

1. **`src/core/cycle/propose-takes.ts`** — Add falsifiability + category to
   extraction prompt and output schema
2. **`src/core/cycle/grade-takes.ts`** — Add falsifiability gate before grading;
   wire real evidence retrieval
3. **`src/core/cycle/calibration-profile.ts`** — Group scorecards by category
4. **`src/core/engine.ts`** — Add `similarity()` helper for dedup (graceful
   fallback)
5. **New migration** — Add columns + index

## Testing

- Unit test: falsifiability classifier on 20 known-good and 20 known-noise takes
- Unit test: dedup correctly merges near-identical claims
- Unit test: grade gate filters below threshold
- Integration test: full cycle with falsifiability → grade → profile pipeline
- Regression test: existing takes without falsifiability score are not broken
  (null falsifiability = ungated, backward compatible)

## Backward Compatibility

- `falsifiability` defaults to null. Existing takes are unaffected.
- `grade_takes` with null falsifiability: configurable behavior. Default:
  grade all (backward compat). Operator can set
  `cycle.grade_takes.require_falsifiability: true` to gate.
- Category column is purely additive.
- Dedup is opt-in: `cycle.propose_takes.dedup.enabled: true`.
