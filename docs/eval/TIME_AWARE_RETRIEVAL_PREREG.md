# Time-aware retrieval and reading: preregistration

This file fixes, before any development-split run, what each mechanism must
show to proceed, and what the sealed confirmation must show for a default to
change. Mechanisms that fail are reported here as negative results and their
code is removed.

## Mechanisms

| ID | Mechanism | Where it runs |
|---|---|---|
| R1 | `think` date frame: current date line + content dates on page blocks | product (on) |
| R2 | `think` notes-first reading | development arm (removed after its development result) |
| F1 | Fact keys, benchmark user-turn fact prompt (replication of key expansion) | eval arm `--fact-keys … --fact-extractor paper` |
| F2 | Fact keys, gbrain's production facts extractor as shipped | eval arm `--fact-extractor production` |
| F3 | Fact keys merged into the keyword index instead of embeddings | eval probe |
| F4 | Facts as separately ranked keys (rank merging) | eval probe, expected to lose |
| T1 | Soft time scope, reserved slots (top ⌈k/2⌉ kept) | eval arm `--time-scope reserved` |
| T2 | Soft time scope, full partition (published replication) | eval arm `--time-scope partition` |

The time-range grammar (`src/core/temporal-grammar.ts`) is frozen at this
commit. Its goldens are the published LongMemEval time-range examples and
generic English; four development-slice question texts were read while
finalizing the duration-question rule ("how many days did I spend … this
year" counts inside a window and keeps its range).

## Data

- **Development:** the frozen development split of LongMemEval-S and -M
  (same question ids in both), defined by the eval harness owner. Every
  mechanism choice (chunk vs page assignment, reserved vs partition, notes
  on/off/auto) uses only these questions.
- **Sealed:** LoCoMo (never used by gbrain for tuning) and the sealed split of
  LongMemEval-M. LongMemEval-S questions were all used for earlier ranking
  decisions, so M-sealed is reported as disclosed confirmation, never as sole
  proof. Sealed runs are executed once, by the eval custodian, after every
  candidate is frozen.
- **Non-regression:** BrainBench retrieval, NamedThingBench, and a time-cue
  fire-rate audit on a synthetic notes brain (how often a range fires and how
  often it is wrong, counting code and changelog text).

## Metrics

Strict `recall_all@5` (headline), `recall_all@10`, `recall_any@5`, NDCG@5/@10,
per question type; judged answer accuracy (official LongMemEval prompts,
`gpt-4o-2024-08-06` judge) through production `think` for R1/R2. Time-scope
rows carry the unscoped top-k from the same candidate pool; the paired
comparison is scoped vs unscoped per question.

## Kill gates (development split)

A mechanism proceeds only with paired wins > losses and a paired bootstrap
95% interval excluding zero on its target metric:

- F1/F2: NDCG@5 or strict `recall_all@5` on LongMemEval-M development
  questions, and F1/F2 must also beat the `tokenmax` contextual-synopsis
  bundle. F2 runs only if F1 passes; F2 extraction uses Haiku for the gate and
  the shipped Sonnet default only if the gate passes.
- T1/T2: temporal-reasoning recall@5 on questions where a range fires; on
  questions where no range fires, rankings must be byte-identical to the
  baseline.
- R2: judged accuracy through `think`, with p50/p95 latency and $/call reported.

## Default-on bar (sealed)

The exact shipping configuration per mode bundle must show: a paired interval
excluding zero on its target (judged accuracy for R2; retrieval target for
F/T on LoCoMo and M-sealed), no question type down by more than one question,
BrainBench and NamedThingBench non-regression, embedding multiplier ≤ 1.3×
for fact-bearing pages, `think` p95 latency ≤ +20%, sync wall time ≤ +5%.
Anything that fails ships off or is removed.

## Budget

Estimates and approved caps (caps are 2× estimates): early-kill path ≈ $500
cap; full path ≈ $2,290 cap. Spend stops at a cap and is reported.

## Amendment 1 — 2026-10-05 (before any sealed cell)

Recorded before any sealed fact-key cell runs; development results so far are
in [`TIME_AWARE_RETRIEVAL_RESULTS.md`](TIME_AWARE_RETRIEVAL_RESULTS.md).

1. **Cost bounds are reported, not gated.** The embedding-multiplier bound
   (≤ 1.3× for fact-bearing pages) and the sync wall-time bound (≤ +5%) no
   longer decide the default. Fact keys re-embed keyed chunks after
   extraction by design, so their extra embedding spend is the price of the
   intended work; accuracy decides. The verdict and the release notes report
   the embedding-spend ratio on the fact-bearing cohort (keyed pages over a
   full write → extract → refresh cycle) and sync wall time, both against
   the same build with `search.fact_keys off`. The `think` p95 bound is
   unchanged for R-arms.
2. **Visibility coverage is reported under both settings.** Fact keys fail
   closed: a private fact never keys a world-visible page. The verdict
   reports keyed-page coverage with `facts.default_visibility` unset
   (private) and set to `world` (the single-principal posture bootstrap
   configures). The benchmark arms run with `world`, the configuration under
   which a single-user brain keys its own conversations.
3. **The `tokenmax` comparison stays in the gate and runs.** The benchmark
   harness gains production per-chunk synopsis generation for
   `--mode tokenmax`, so the F2 gate compares fact keys under `balanced`
   against synopsis embeddings as production builds them, on LongMemEval-M
   development questions, before any sealed cell.
4. **Shipping configuration under test.** Sealed cells run the frozen build's
   production fact-key path (not the eval arm), with `search.fact_keys on`,
   the release-default `balanced` bundle, and the production default facts
   extraction model; Haiku 4.5 remains disclosed as the development-gate
   stand-in.

## Amendment 2 — 2026-10-05 (before any `tokenmax` cell)

Recorded before any `tokenmax` synopsis cell runs. Amendment 1 item 3 placed
the `tokenmax` comparison on LongMemEval-M; a calibrated projection put that
run at about $4,280 (production per-chunk synopses carry the whole session in
every chunk prompt; M has about 1.04M chunks and synopses do not reuse across
questions), above the plan's full budget cap. The comparison therefore moves
to LoCoMo:

1. **Development:** fact keys (`balanced` + keys, production extractor) vs
   `tokenmax` synopses vs `balanced`, retrieval metrics on the LoCoMo
   development conversations (conv-44, conv-47, conv-48), cost calibrated on a
   few sessions first. The F2 gate's "beats `tokenmax`" clause is evaluated
   here.
2. **Sealed:** the preregistered LoCoMo sealed run gains `tokenmax` as a third
   arm: `balanced` vs fact keys vs `tokenmax`.
3. **LongMemEval-M** remains disclosed confirmation against `balanced` only.
   M does not run the `tokenmax` comparison, because of cost.

## Amendment 3 — 2026-10-05 (freeze before any sealed cell)

Recorded before any sealed cell runs.

1. **Outcomes on development data.** Fact keys (F1/F2) failed the `tokenmax`
   gate on LoCoMo and are removed; the time scope (T1/T2) failed its gate;
   notes-first reading (R2) showed no gain and was removed. The date frame
   (R1) is the only mechanism going to held-out data.
2. **Frozen build.** Candidate gbrain
   `2815a8368cb38d2bbc8bf23bf2c3d2ca34aa6756`; baseline gbrain
   `67c4ff27bd0a5a8a02ccb66cd663d3aa1daf9969` (the master the candidate
   contains). Later commits on the branch that change only documentation do
   not change the frozen build. (Corrected before any sealed cell ran: the
   first text of this amendment named `17c5765ba` as the baseline, but the
   master merged into the candidate is `67c4ff27`.)
3. **Harness.** gbrain-evals `p0-heldout-harness` at
   `cf270c2093d381f104715cd9db7331e6ffe890c8`, `memory-qa` think lane,
   official judge prompts, the development lane's settings (`balanced`,
   reranker off, autocut off, top 10, five sessions read). `think` receives
   the question date as `referenceDate`; LoCoMo questions carry no date, so
   the reference date is the conversation's latest session date, exactly as
   in the development measurement. (Corrected 2026-10-05, before any result
   was read: this item first pinned `0dd5b75c`, which passes no date for
   LoCoMo; `cf270c2` adds the latest-session-date fallback this item
   requires.)
4. **Cells and bar.** Primary: LoCoMo sealed (seven conversations; diagnostic
   evidence per the split's note). Disclosed confirmation: LongMemEval-M
   sealed, same lane. Default on requires a paired interval excluding zero on
   judged accuracy, no question category down by more than one question, and
   `think` p95 latency within +20%. Spec:
   [`decisions/p6-think-dates-sealed/decision.json`](decisions/p6-think-dates-sealed/decision.json).
