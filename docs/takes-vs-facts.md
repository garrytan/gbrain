# Takes vs Facts — Architectural Distinction

gbrain has two epistemological storage layers that serve different purposes.
**Never conflate them.**

## Takes (cold storage — `takes` table)

The epistemological layer. WHO believes WHAT, with confidence weight and time.

- **Source:** Extracted from brain pages (markdown) by LLM analysis
- **Scope:** Multi-holder — captures beliefs from *any* speaker, not just the brain owner
- **Kinds:** `take` (opinion), `fact` (verifiable), `bet` (prediction), `hunch` (intuition)
- **Lifecycle:** Cold storage, retrospective. Updated when pages change or re-extraction runs.
- **Scale:** 100K+ rows across thousands of holders in a mature brain

**Example takes:**
- `holder=people/garry-tan kind=bet` "AI will replace 50% of coding by 2030" (w=0.75)
- `holder=people/jared-friedman kind=take` "Momo has strong retention" (w=0.80)
- `holder=world kind=fact` "Clipboard raised $100M Series C" (w=1.0)
- `holder=brain kind=hunch` "Garry has a hero/rescuer pattern" (w=0.70)

**Query surface:** `gbrain takes list`, `gbrain takes search`, `gbrain think`

## Facts (hot memory — `facts` table, v0.31)

Personal knowledge from the brain owner's conversations. Real-time capture.

- **Source:** Extracted per-turn from conversation by the facts hook (Haiku)
- **Scope:** Single-user — only the brain owner's stated knowledge
- **Kinds:** `event`, `preference`, `commitment`, `belief`, `fact`
- **Lifecycle:** Hot storage, real-time. Captured as conversations happen.
- **Bridge:** Dream cycle `consolidate` phase promotes hot facts → cold takes nightly

**Example facts:**
- `kind=event` "I have a meeting with Brian tomorrow"
- `kind=preference` "I don't drink coffee"
- `kind=commitment` "We decided on nesting custody"
- `kind=belief` "I think the market is overheated"

**Query surface:** `gbrain recall`, MCP `_meta.brain_hot_memory`

## The Category Error

**Never dump takes into the facts table.** Takes include other people's attributed
beliefs (Jared's assessment of a company, PG's view on schools, a founder's
revenue claims). These are NOT the brain owner's personal facts.

**Never dump facts into the takes table without transformation.** Facts are
scoped to what the owner said in conversation. They become takes only through
the dream cycle's consolidate phase, which adds proper attribution, deduplication,
and temporal reasoning.

## The Bridge

The dream cycle's `consolidate` phase (v0.31) is the one-way bridge:

```
hot facts → [dream consolidate] → cold takes
```

Facts flow in ONE direction. The consolidate phase:
1. Groups related facts by entity
2. Deduplicates against existing takes
3. Promotes durable facts to takes with proper holder/weight
4. Marks consolidated facts with `consolidated_at` + `consolidated_into`

## Production Extraction Data (2026-05-10)

First full takes extraction run on a ~100K-page brain:
- **Model:** Azure GPT-5.5 (ties Opus quality at 1/8th cost — $0.033 vs $0.260/page)
- **Result:** 100,720 takes from 28,256 on-disk pages, $361.49, 83 errors (0.3%)
- **Breakdown:** 70,960 takes / 24,342 facts / 2,875 bets / 2,649 hunches
- **Holders:** 6,239 unique holders
- **Cross-modal eval:** 6.8/10 overall (GPT-5.5 + Opus 4.6 scored independently)

### Eval Dimensions

| Dimension | Score | Notes |
|-----------|-------|-------|
| Accuracy | 7.5 | Claims faithfully represent sources |
| Attribution | 6.5 | Holder/subject confusion was #1 issue |
| Weight calibration | 7.0 | Good range usage, some false precision |
| Kind classification | 6.5 | Occasional fact/take misclassification |
| Signal density | 6.5 | Some trivial extractions pass through |

### Key Learnings for Extraction Prompts

1. **Holder ≠ subject.** "Garry has a hero/rescuer pattern" → holder=brain, NOT people/garry-tan
2. **Atomic claims.** Split compound claims into separate rows
3. **Amplification ≠ endorsement.** Retweet-only → max weight 0.55
4. **Self-reported ≠ verified.** "Reports 7 figures" → holder=person, weight=0.75, NOT world/1.0
5. **No false precision.** Use 0.05 increments (0.35, 0.55, 0.75), not 0.74 or 0.82
6. **"So what" test.** Skip Twitter handles, follower counts, obvious metadata
