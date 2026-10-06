# Time-aware retrieval and reading: results

Results for the mechanisms preregistered in
[`TIME_AWARE_RETRIEVAL_PREREG.md`](TIME_AWARE_RETRIEVAL_PREREG.md).

**Held-out verdict — date frame in `think`: pass.** On the seven sealed LoCoMo
conversations (1,399 paired questions) judged accuracy rises from 74.2% to
88.2% (+14.0 pts, clustered 95% CI [+11.8, +16.2], 229 wins / 33 losses);
every conversation improves; temporal questions 27 → 199 of 221; retrieval is
identical. `think` p95 latency is unchanged (ratio 0.93, CI [0.88, 1.03], dev).
The date frame ships on. Record:
[`decisions/p6-think-dates-sealed/`](decisions/p6-think-dates-sealed/).
LongMemEval-M sealed confirmation is pending.

The sections below are development results; they set no default.

## Setup

- **Retrieval arms:** `gbrain eval longmemeval` with the eval-only
  `--fact-keys` / `--time-scope` arms, release default `balanced` (reranker on,
  autocut off), strict `recall_all@5` and NDCG@5 over distinct sessions,
  `openai:text-embedding-3-large` at 1536 dimensions, paired bootstrap (10,000
  draws) over questions. All 500 LongMemEval-S questions are development data;
  LongMemEval-M uses the same question ids with 500-session haystacks.
- **Reading arms:** the decision kit (`eval:decide`, gbrain-evals) `memory-qa`
  think lane — production `runThink` over each conversation's sessions, judged
  with the official LongMemEval prompts — on the LongMemEval-S 150-question
  stratified dev sample and the three LoCoMo dev conversations. Records:
  [`decisions/p6-think-dates/`](decisions/p6-think-dates/).

## Results

### Baselines

| Benchmark | Strict R@5 | Notes |
|---|---:|---|
| LongMemEval-S | 450/470 (95.7%) | reproduces the published 449/470 release-default row |
| LongMemEval-M | 367/470 (78.1%) | temporal-reasoning 81/127, multi-session 81/121 |

### Date frame in `think` (current date + page content dates) — passes development

| Source | Baseline | Date frame | Δ (95% CI) |
|---|---:|---:|---:|
| LongMemEval-S think, 150 questions | 80.7% | 90.0% | +9.3 pts [+4.0, +15.3] |
| LoCoMo dev think, 3 conversations | 76.7% | 89.1% | +12.4 pts (3 clusters) |
| Retrieval (LME-S, LoCoMo, BEAM-100K) | — | identical | 0.0 |

### Time scope — killed

| Arm | Benchmark | Questions with a range | Wins / losses (strict R@5) | NDCG@5 Δ (95% CI) |
|---|---|---:|---:|---:|
| reserved slots | LME-S | 59 | 0 / 3 | −0.013 [−0.027, −0.002] |
| full partition | LME-S | 59 | 0 / 11 | −0.101 [−0.150, −0.056] |
| reserved slots | LME-M | 59 | 0 / 1 | −0.011 [−0.030, +0.001] |

Questions without an explicit time cue are byte-identical in every arm. The
range is not selective on these haystacks: 48% of distractor sessions fall
inside the parsed range, and 39 of 135 gold sessions fall outside it (for
example "last Saturday" questions whose evidence spans several Saturdays, or
preference questions about "this weekend" whose evidence predates it).

### Fact keys — killed by the `tokenmax` gate

Fact keys win on LongMemEval-M but lose the preregistered gate on LoCoMo:
under `balanced` they do not beat `tokenmax` synopses, and on LoCoMo they do
not beat `balanced` either. No product code ships
([decision record](decisions/p6-fact-keys/); the full build stays in branch
history at `5024ec99f`).


| Arm | Benchmark | Strict R@5 | NDCG@5 Δ (95% CI) | Wins / losses (NDCG) |
|---|---|---:|---:|---:|
| chunk keys, published user-fact prompt (Haiku 4.5) | LME-S | 451/470 | +0.008 [+0.002, +0.015] | 21 / 8 |
| page keys, published prompt | LME-S | 435/470 | −0.018 [−0.027, −0.010] | 13 / 41 |
| chunk keys, gbrain's facts extractor as shipped (Haiku 4.5) | LME-S | 452/470 | +0.005 [+0.0001, +0.011] | 16 / 8 |
| chunk keys, published prompt | LME-M | 383/470 (vs 367) | +0.025 [+0.012, +0.038] | 58 / 33 |
| chunk keys, gbrain's facts extractor as shipped (Haiku 4.5) | LME-M | 381/468 (vs 366) | +0.022 [+0.011, +0.034] | 58 / 25 |

On LongMemEval-M the published-prompt arm replicates key expansion: strict
R@5 rises from 78.1% to 81.5% (+3.4 points, 95% CI [+1.5, +5.5], 20 wins / 4
losses), mostly on temporal-reasoning (81 → 89 of 127) and single-session-user
(59 → 63 of 64) questions; the relative gain (+4.4%) matches the published
session-granularity result. The M baseline row is the unscoped top-5 from the
time-scope run's 50-candidate pool; on LongMemEval-S that row is identical to
the plain limit-5 baseline on every question.

gbrain's own facts extractor gives the same gain on LongMemEval-M: strict
R@5 rises from 78.2% to 81.4% (+3.2 points, 95% CI [+1.3, +5.1], 18 wins / 3
losses) on the 468 questions where both runs completed (two questions failed
on embedding-provider timeouts and are excluded from every arm in this
comparison). Against the published-prompt arm on the same questions it is
indistinguishable (−0.2 points, 95% CI [−2.1, +1.7], 9 wins / 10 losses),
with the gains in the same types: temporal-reasoning 81 → 86 of 127,
multi-session 81 → 86 of 120, single-session-user 59 → 63 of 64.

Page keys (every fact on every chunk) are rejected: the shared prefix makes a
session's chunks look alike and pushes gold sessions down. The published
prompt extracts 404 facts per question against 174 for gbrain's extractor,
which reads the first 8,000 characters of a page and keeps notable facts.

**The gate, on LoCoMo development conversations** (conv-44, conv-47, conv-48;
464 questions without the adversarial category; strict recall_all@5 over
sessions, `--reranker on --autocut off`, paired bootstrap over questions, 10,000
draws). A = `balanced`; B = `balanced` + chunk keys from gbrain's extractor
(Haiku 4.5); C = `tokenmax` with production per-chunk synopses (Haiku 4.5):

| Comparison | Strict R@5 | Δ (95% CI) | Wins / losses | NDCG@5 Δ (95% CI) |
|---|---:|---:|---:|---:|
| B vs C (the gate) | 86.4% vs 87.5% | −1.1 pts [−2.4, 0.0] | 1 / 6 | −0.009 [−0.020, +0.001] |
| B vs A | 86.4% vs 86.0% | +0.4 pts [−0.7, +1.7] | 5 / 3 | +0.001 [−0.005, +0.007] |
| C vs A | 87.5% vs 86.0% | +1.5 pts [+0.2, +2.8] | 8 / 1 | +0.010 [+0.001, +0.020] |

By category (strict R@5, A / B / C): single-hop 256 / 255 / 259 of 263,
multi-hop 31 / 36 / 35 of 71, temporal 92 / 92 / 92 of 100, open-domain
20 / 18 / 20 of 30. Keys help only multi-hop questions, where synopses gain
the same. The bootstrap resamples questions and ignores clustering within
three conversations, so the intervals are optimistic. Development spend:
$45 of synopses plus about $6 of extraction, embedding and reranking.

Side by side: fact keys add +3.2 points over `balanced` on LongMemEval-M
(500-session haystacks) and nothing on LoCoMo (one conversation per
haystack), where `tokenmax` adds +1.5. The M comparison against `tokenmax`
was not run because of cost (preregistration amendment 2).

Follow-up, untested: fact keys stacked on `tokenmax`, against `tokenmax` alone.

### Notes-first reading — no gain, removed

Same build with the date frame on, notes on vs off
([`decisions/p6-think-notes/`](decisions/p6-think-notes/)):

| Source | Notes off | Notes on | Δ (95% CI) |
|---|---:|---:|---:|
| LongMemEval-S think, 150 questions | 88.7% | 88.0% | −0.7 pts [−3.3, +2.0] |
| LoCoMo dev think, 3 conversations | 89.4% | 87.9% | −1.5 pts [−3.4, 0.0] |

With the date frame in place, asking the reader for notes before its answer
added output tokens and no accuracy, so the mode was removed rather than kept
as an unmeasured option. The published reading-notes gain was measured on
oracle sessions with direct-answer readers; gbrain's `think` already returns a
structured answer with citations and gaps.

## Deviations

- The `tokenmax` comparison moved from LongMemEval-M to LoCoMo
  (preregistration amendment 2): production per-chunk synopses for M project
  to about $4,280. The harness now builds production synopses for
  `--mode tokenmax`; LoCoMo converts to the LongMemEval format with
  `scripts/locomo-to-longmemeval.ts`.
- The reading-arm think lane passed each question's date as the reference
  date through a local harness change pending in gbrain-evals.
