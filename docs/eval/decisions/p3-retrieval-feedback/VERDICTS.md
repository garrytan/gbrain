# P3 held-out verdicts

The custodian ran the sealed cells against the preregistration in
[`PREREGISTRATION.md`](PREREGISTRATION.md) and reported aggregates only. The implementer saw no sealed question,
phrasing or seed.

## E1: oracle ratings, λ = 0.1, frozen arm gating

| Corpus | ΔNDCG@10 (points) | 95% CI | Better / worse | Notes |
|---|---|---|---|---|
| world-v1 relational (72 sealed base questions) | +2.04 | [+1.03, +3.28] | 38 / 5 | beats the exposure-frequency arm (−1.50); cold-start subgroup +1.44; the `advises` category drops 2.0 points (6 rows from 3 base questions) |
| LoCoMo (7 sealed conversations) | −0.12 | [−1.02, +0.61] | | CI includes 0: **fails**; cold-start subgroup −3.0 (16 rows) |

Exploratory rows: λ = 0.2 gives +5.45 on world-v1 and −2.23 on LoCoMo.

LoCoMo fails E1, so feedback cannot ship on by default under any reading.

### Decision: feedback ships, off by default

The preregistration did not say whether "no category drops more than 1.0 point" belongs to E1's pass bar. The clause
appears only in the default-on list:

> **Feedback ON by default** iff all hold: E2 judge mean +1.0 point or more with CI excluding 0 in the frozen and
> online arms, and the sparse arm still positive; E1 NDCG@10 improves with CI excluding 0 and beats arm (d); the
> cold-start subgroup loses at most 1.0 NDCG@10 point; no category drops more than 1.0 point; E3 shows zero
> LongMemEval change, 0 NamedThingBench hit@1 losses and p95 latency +10 ms or less.

and the per-corpus rule uses "E1 passes" without defining it:

> E1 is evaluated **per corpus** (LoCoMo and world-v1 separately); "E1 passes" requires both. If world-v1 passes and
> LoCoMo fails, feedback ships with `feedback.enabled=false` (opt-in, explicit ratings only, `feedback.implicit=false`).
> […] If E1 fails on both corpora: the feedback subsystem leaves the pull request.

Two readings follow:

1. **E1's pass bar is the clause labelled E1** ("E1 NDCG@10 improves with CI excluding 0 and beats arm (d)"); the
   category and cold-start clauses belong only to the default-on list. world-v1 passes, LoCoMo fails, and feedback
   ships with `feedback.enabled=false`.
2. **E1's pass bar is every condition in the list that E1 measures**, including cold-start and categories. world-v1's
   `advises` category drops 2.0 points, so world-v1 fails too, and the subsystem leaves the pull request.

Garry resolved it on 2026-10-05, after the sealed results were known: **reading 1**. Feedback ships with
`feedback.enabled=false` and `feedback.implicit=false` (opt-in, explicit ratings only). Because the reading was chosen
after the result, it is recorded here as a decision, not as a preregistered outcome.

Future preregistrations name the experiment each gate clause belongs to (for example "E1 pass bar: …" versus
"default-on list: …") and define "passes" for every experiment and corpus a later rule refers to.

## E2: implicit citation signal

Not run: preregistered gate (sealed E2 runs only if sealed E1 passes on both corpora). Dev result: at λ = 0.1 a
citation raises a page's multiplier by about 0.25% per citation, at most 5%, and does not change what `think`
gathers (gather Recall@5 identical in every arm).

## E3: no-regression guards

LongMemEval-S (all 500 questions, dev by P0's split): identical retrieval lists, mean read latency +0.6 ms.
NamedThingBench (weights trained on world-v1 dev, 0 hit@1 losses): not run. It was cancelled once feedback became
opt-in; with no ratings the stage is a no-op (LongMemEval-S above), and an opted-in brain's multiplier stays within
0.9x to 1.1x.

## E4: relational triplet scoring — fail

The relational arm fired on 17% of held-out phrasings (who-at-topic 3%, portfolio-by-sector 47%, attendees-by-role
0%) against the ≥ 80% precondition; the effect was +0.39 NDCG@10 points [+0.09, +0.81] against the +2.0 bar.
`search.triplet_scoring` is removed from the pull request.

### Known gap: relational parser brittleness

The held-out phrasings show that the relational-intent parser (`src/core/search/relational-intent.ts`) keys on exact
surface forms: "who at X works on Y" fires, "who at X is working on Y" does not, and the attendee and portfolio
templates miss most rewordings. Any ranking change that acts on the relational arm (triplet scoring included) is
capped by how often the parser recognizes the question. Measuring the parser's recall on held-out phrasings, and
widening it, is a prerequisite for re-testing relational ranking ideas.

## E5: declared single-value relations — fail

Custodian decision `p3-e5-heldout-2026-10-05`, build `bd700323e`, P1's temporal-edges phrasing set C, seeds 11, 13 and
17, with a test pack declaring `works_at` `cardinality: one_per_from`; no model calls ($0).

| Gate | Off → on | Bar | Result |
|---|---|---|---|
| Wrong closures | 3 of 3 applied closures wrong (seed 11: 0, seed 13: 2, seed 17: 1) | 0 | fail |
| Now-precision | 0.943 → 0.913, Δ −0.029, CI [−0.086, 0] | lower bound ≥ −0.01 | fail |
| Undated / same-date conflicts left open | none closed | all open | pass |
| As-of exact rate | 0.678 → 0.678 | no lower | pass |
| During-F1 | 0.653 → 0.653 | no lower | pass |
| Traps | 115/115 | ≥ 0.99 | pass |
| Order invariance | 240/240 | 1 | pass |

Reported only: current-employer recall 0.612 → 0.577, live-edge recall 0.603 → 0.589.

Cause: every wrong closure ended the person's actual current employer (one stint since 2009). The link itself is
typed correctly: "Took an advisory role with [X]" is an `advises` link on every build. The dated timeline cue is
not: the employment start pattern `EMPLOYMENT.start` in `src/core/link-temporal-evidence.ts` has a
`took … role|job|position (at|with)` alternative that also matches advisory roles, so on a page that also asserts
`works_at` to X the line becomes a `works_at` start transition. The chain rule then read X as a newer employer and
closed the real one at that date. The rule did what it specifies; the start cue is too broad for that phrasing.

Decision, as preregistered: `dream.single_value.mode` defaults to `propose`. Closures for declared types are recorded
as proposals (`foresights edge-proposals list`) and nothing is written to pages until a user accepts one or sets the mode
to `apply`.

Follow-ups (not in this pull request; each needs a fresh held-out run):

1. Narrow the `took … role|job|position (at|with)` alternative of `EMPLOYMENT.start` so advisory roles do not start
   `works_at` (in progress in #6017, with a held-out guard).
2. In the chain rule, skip a successor relationship whose target also has an `advises` edge from the same page.
