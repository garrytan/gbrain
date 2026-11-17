# P3 preregistration: use-attributed retrieval feedback and relational triplet scoring

This file fixes, before any held-out data is opened, what the P3 held-out runs measure, on which data, and which
result turns each feature on by default. The custodian freezes it (with any edits recorded below the line at the end)
before the first sealed cell runs. Dev results that informed it are listed in [Dev evidence](#dev-evidence); none of
them is eligible to set a default.

## Builds

| Arm | Build | Settings |
|---|---|---|
| Baseline | foresights `master` at the P3 merge base (`5bd9e8497`) | as shipped |
| Feedback | P3 pull-request head (frozen SHA recorded at handoff) | `feedback.enabled=true`, `feedback.influence=0.1`, `search.triplet_scoring=false` |
| Triplet | same build | `feedback.enabled=false`, `search.triplet_scoring=true`, `search.triplet_penalty=3.0` |

Every arm runs on its own copy of the trained database, and scoring runs with `feedback.learn=false`, so scoring
calls, judge repetitions and sealed questions never change the state under test. Embeddings come from one
content-addressed cache that is warm before either arm runs, so both arms read identical vectors (a cold cache lets
fresh provider vectors and cached vectors differ in the last float bits, which reorders near-ties; see the dev
guardrail note below).

`feedback.influence` (λ) is fixed at **0.1**, the shipped default. λ = 0.05 and 0.2 are reported as exploratory rows.

## Data and splits

| Corpus | Split | Unit |
|---|---|---|
| LoCoMo | P0 split `eval/decisions/splits/locomo.json` (gbrain-evals): 3 dev conversations, 7 sealed | conversation = one brain |
| LongMemEval-S | P0 split `eval/decisions/splits/lme-s.json`: all 500 questions are dev (no sealed portion) | question (own haystack) |
| world-v1 relational (template + paraphrase) | P0 split `eval/decisions/splits/world-v1-relational.json`: 73 dev / 72 sealed base questions; template and paraphrase forms of one question share a half | one shared brain |
| NamedThingBench core + relational | as committed | query |

P0's frozen world-v1 relational split has the same dev half as the split these dev runs used, so no sealed world-v1
question has been read.

## Experiments and pass bars

All bars apply to sealed data only. Confidence intervals are cluster bootstraps (cluster = conversation for LoCoMo,
base question for world-v1), 1,000 resamples or more.

**E1. Feedback with oracle ratings (judge-free upper bound).** Per brain, questions stream in a fixed seeded order.
After a training question, each returned page gets a targeted rating (5 if gold, 1 if not). Arms: (a) train on dev,
freeze, score sealed; (b) online predict-then-update over the whole stream, metrics on sealed questions only;
(c) 20% of labels flipped; (d) exposure-frequency weights from dev with no ratings. Metrics: NDCG@10 (primary) and
Recall@5. The cold-start subgroup (sealed questions whose gold pages never appeared as gold in a training answer) is
reported separately.

**E2. Feedback from the implicit citation signal only.** LoCoMo, runner `feedback-think-replay.ts`: every answer goes
through the `think` operation, so the pages its synthesis cites feed the ranking. Questions inside the sealed
conversations split into train and score halves by sha256(seed 42, id); per conversation the first 50 train and 40
score questions in that order. Arms: off (influence 0, answers still recorded), frozen (learn on the train half, score
with `feedback.learn=false`), sparse (frozen on a seeded 25% of the train half), online (one seeded stream, metrics on
score questions only). One `think` answer per score question per arm (model `anthropic:claude-sonnet-5-5`, the
newest Sonnet), judged 10 times with P0's LoCoMo prompts (`openai:gpt-4o-2024-08-06`, temperature 0.7); reported:
judge mean ± SD across replicates, gather Recall@5, cited events per 100 answers, adversarial abstention and trap
repeats. The judge gates use the cluster bootstrap over the 7 conversations.

**E3. No-regression guards.** LongMemEval-S: retrieval lists identical between baseline and feedback arms (no
ratings exist, so the stage must be a no-op). LongMemEval-S has no sealed portion (P0 split), so this part is decided
on the full 500-question dev run, decision `p3-e3-lmes-full-dev`. NamedThingBench core + relational with weights trained on world-v1
dev: 0 hit@1 losses. p50/p95 read latency deltas.

**E4. Triplet scoring.** `search.triplet_scoring=true` (wider relational fetch plus path scoring, penalty 3.0) against
off, on the `constrained-relational` category: seeded worlds whose questions name one seed, one relation and one
attribute constraint, so a seed has 8 to 14 relational neighbors and 1 to 4 are gold. The custodian renders the held-out
worlds from held-out phrasing and seeds (`--phrasing-file`, access-logged); the implementer has seen only phrasing A and
dev seeds 11 and 13. Guards: world-v1 relational sealed half and NamedThingBench relational. Precondition: the
relational arm fires on at least 80% of the constrained questions. Metrics: NDCG@10 (primary), hit@1, hit@3.

**E5. Declared single-value relations (correctness).** P1's temporal-edges category on the custodian's held-out
phrasing set C, seeds 11, 13 and 17 (`eval/runner/temporal-edges.ts --phrasing-file …`), with a test pack that
extends the default pack and declares `works_at` `cardinality: one_per_from`. Arms on the same build: off (default
pack) and on (test pack, then one `edge_contradictions` pass with `dream.single_value.mode=apply` and
`dream.edge_contradictions.mode=off`, so no model is called). Measurements, against the generator's employment ledger:
wrong closures (a closed relationship the ledger says is current, or a close date that differs from the ledger's
next start), conflicts left open for undated and same-date starts, and the category's as-of exact rate, now-precision
and during-F1. Gate: 0 wrong closures; every undated or same-date conflict left open; as-of exact rate, now-precision
and during-F1 each no lower than the off arm (cluster-bootstrap lower bound ≥ −0.01, cluster = person). Traps
(advisor roles, investments and alumni meetings at former employers, rejoins) must still pass at ≥ 0.99. Cost: $0
(no model calls).

Default decisions (the per-corpus E1 reading and the fixed λ were approved on 2026-10-04, before any sealed data was opened):

- **Feedback ON by default** iff all hold: E2 judge mean +1.0 point or more with CI excluding 0 in the frozen and
  online arms, and the sparse arm still positive; E1 NDCG@10 improves with CI excluding 0 and beats arm (d); the
  cold-start subgroup loses at most 1.0 NDCG@10 point; no category drops more than 1.0 point; E3 shows zero
  LongMemEval change, 0 NamedThingBench hit@1 losses and p95 latency +10 ms or less.
- E1 is evaluated **per corpus** (LoCoMo and world-v1 separately); "E1 passes" requires both. If world-v1 passes and
  LoCoMo fails, feedback ships with `feedback.enabled=false` (opt-in, explicit ratings only, `feedback.implicit=false`).
- If E1 passes but E2 does not: ship with `feedback.enabled=false` as above.
- Sealed E2 runs only if sealed E1 passes on both corpora (approved 2026-10-04, before any sealed data was opened).
  If E1 fails on LoCoMo or world-v1, feedback ships off by default whatever E2 shows, so E2 is recorded as "not run:
  preregistered gate, see the dev result".
- If E1 fails on both corpora: the feedback subsystem leaves the pull request.
- **Triplet scoring ON** iff sealed constrained-relational NDCG@10 improves by +2.0 points or more with CI excluding
  0 (cluster bootstrap over held-out seeds and templates) and the guards show 0 hit@1 losses. Otherwise the setting
  is removed from the pull request. The wider fetch only runs with triplet scoring on, so the plan's E4a is not a
  separate arm.
- **Declared single-value relations: `dream.single_value.mode` defaults to `apply`** iff E5 shows 0 wrong closures,
  every undated or same-date conflict left open, and no as-of regression. Otherwise the default is `propose`
  (closures recorded for review, nothing written to pages). Added 2026-10-05, before any E5 cell ran.

Budget caps: E1 $16, E2 $180 (dev spent $23.65; the sealed run as specified is estimated at about $130), E3 $20, E4 $12
E5 $0 (plan total cap $260).

## Harness requirements

- E5: `temporal-edges.ts` needs two additions for the on arm: a `--pack <file>` option that installs the test pack
  before the pages are written, and a pass of the `edge_contradictions` phase (declared-only, no judge) before the
  probes, plus the wrong-closure and conflicts-left-open counts in its rows.

- E1: `eval/runner/feedback-replay-locomo.ts` and `eval/runner/feedback-replay-world.ts` (gbrain-evals
  `p0-heldout-harness`), custodian mode `--split sealed --decision-id <id> --purpose <text>` with the access log.
- E2: `eval/runner/feedback-think-replay.ts` (gbrain-evals branch `p3-e2-e4-feedback-evals`), custodian mode
  `--split sealed --decision-id <id> --purpose <text>`; sealed flags `--train-limit 50 --score-limit 40 --judge-runs 10
  --lambda 0.1`.
- E3: the P0 kit (`eval:decide`), LongMemEval-S as above; NamedThingBench through its committed script.
- E4: `eval/runner/constrained-relational.ts` (same branch) with `GBRAIN_EVAL_SEARCH_PINS=search.triplet_scoring=true`
  on the candidate arm; custodian mode `--phrasing-file <custody path> --seeds <held-out seeds> --decision-id <id>
  --purpose <text>`.

## Dev evidence

Dev data only; nothing here can set a default.

**Guardrail (P0 kit, decision `p3-feedback-guardrail-dev-v2`).** Baseline `master` against the P3 build with
feedback on and no ratings ([`../p3-feedback-guardrail-dev-v2/`](../p3-feedback-guardrail-dev-v2/), build `5e5fdcbbe`):
identical retrieval lists on all 587 LoCoMo dev questions and on a 100-question LongMemEval-S dev subset (Recall@5
0.7565 and 0.9479 on both arms), mean read latency +1.2 ms and +1.1 ms, p95 +3.0 ms and +0.9 ms. An earlier run
with a cold embedding cache showed adjacent near-tie swaps in 18 of 587 LoCoMo lists (and 6 of 100 LongMemEval-S
lists) with identical metrics; the same comparison with a warm cache shows 0 of 587, and a master-against-master run
shows 0, so the swaps came from cache warm-up, not from the feature.

**E1-shaped replay on dev questions** (oracle ratings; a held-back half inside the dev questions is scored; build
`ce8092562`; cost $0.02). ΔNDCG@10 in points against feedback off, with a dev-only question-resampling 95% interval:

| Corpus (scored questions) | λ | Frozen | Online | 20% noise | Frequency only |
|---|---|---|---|---|---|
| LoCoMo dev (236) | 0.05 (positive-only labels) | −0.35 [−0.9, 0.2] | +0.02 [−0.5, 0.5] | −0.29 | −1.15 |
| LoCoMo dev (236) | 0.1 | −0.34 [−1.4, 0.7] | −1.08 [−2.4, 0.1] | −2.13 | −4.02 |
| LoCoMo dev (236) | 0.2 | −3.67 [−5.6, −1.4] | −2.72 [−4.4, −0.8] | −4.56 | −7.89 |
| world-v1 relational dev (74) | 0.05 | +1.32 [0.4, 2.6] | +1.77 [0.6, 3.4] | +0.84 | +0.17 |
| world-v1 relational dev (74) | 0.1 | +1.71 [0.5, 3.3] | +2.48 [0.7, 4.6] | +0.42 | −0.80 |
| world-v1 relational dev (74) | 0.2 | +2.20 [0.6, 3.9] | +4.70 [2.7, 7.3] | +1.46 | −1.33 |

**E3 LongMemEval-S, all 500 dev questions** (P0 kit, decision
[`p3-e3-lmes-full-dev`](../p3-e3-lmes-full-dev/), baseline `master` 6622a119 against build `70ad30e4e`, feedback on, no
ratings): identical retrieval lists on all 500 questions (strict Recall@5 0.9277 on both arms), mean read latency
+0.6 ms [−0.3, 1.3], p95 74.8 ms against 73.3 ms. Cost $6.15. This settles the LongMemEval-S part of E3.

**E2 dev (implicit citations, LoCoMo dev conversations, 25 train and 20 score questions each, judge 3x, build
`23d2597e2`, cost $23.65).** Judge mean against off (0.783): frozen +0.0 [−4.4, 5.0] points, sparse −2.2 [−9.4, 6.7],
online −1.7 [−6.7, 2.2]; judge SD across replicates 0.014. Gather Recall@5 is 0.739 in every arm: at λ = 0.1 the
citation signal (rating 4 at half the learning rate) raises a cited page's multiplier by about 0.25% per citation and
at most 5%, too little to change which pages `think` gathers here, so the judge differences are answer-sampling noise. Cited events: 369 to 416 per 100 answers.
Summary: [`dev/think-replay-locomo-dev.json`](dev/think-replay-locomo-dev.json).

**E4 dev (constrained-relational, seeds 11 and 13, 142 questions, build `23d2597e2`).** The relational arm fires on
100% of questions. Triplet scoring on against off: NDCG@10 +1.94 points [0.87, 3.14] (0.738 → 0.758), hit@1 0.669 →
0.711 with 6 wins and 0 losses. By template: who-at-topic +2.7 (off 0.960, near ceiling), portfolio-by-sector +1.3
(off 0.909), attendees-by-role +1.4 (off 0.105: the attendees reach the relational arm but text rows outrank them).
Summary: [`dev/triplet-constrained-relational-dev.json`](dev/triplet-constrained-relational-dev.json).

**E4-shaped triplet probe on the world-v1 relational dev half** (146 template + paraphrase questions, one shared
index, build `70ad30e4e`, cost $0.02): with `search.triplet_scoring` on at penalties 1, 3 and 6, ΔNDCG@10 is −0.05
points [−0.23, 0.06] at every penalty, hit@3 is unchanged (0.692) and there are 0 hit@1 losses or wins. The
relational arm fires on 48% of these questions. Summary: [`dev/triplet-world-v1-dev.json`](dev/triplet-world-v1-dev.json).

Reading: on a shared entity brain, where the same people and company pages answer many different questions,
learned usefulness transfers and beats exposure frequency. On conversation sessions, where a session that answers one
question is usually wrong for the next, a page-level weight does not transfer and costs ranking quality, more so at
higher λ. That is why E1 is judged per corpus above. Raw summaries: [`dev/`](dev/).

---

Custodian edits (dated, with reason) go below this line.

2026-10-05: E5 ran (decision `p3-e5-heldout-2026-10-05`) and failed; per the rule above, `dream.single_value.mode`
defaults to `propose`. Results and cause: [`VERDICTS.md`](VERDICTS.md#e5-declared-single-value-relations--fail).
