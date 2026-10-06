# Decision: fact keys in chunk embeddings — killed

- **Plan:** P6, mechanism F2 (fact keys from gbrain's facts extractor merged
  into the chunk embedding input).
- **Decided:** 2026-10-05, on development data, under the preregistered kill
  gate ([`TIME_AWARE_RETRIEVAL_PREREG.md`](../../TIME_AWARE_RETRIEVAL_PREREG.md),
  "Kill gates", amendments 1 and 2).
- **Gate:** F2 must beat `balanced` on its target metric with a paired 95% CI
  excluding zero, **and** beat the `tokenmax` contextual-synopsis bundle.
- **Verdict:** **fail.** On the LoCoMo development conversations fact keys
  under `balanced` score −1.1 points strict recall_all@5 against `tokenmax`
  (95% CI [−2.4, 0.0], 1 win / 6 losses) and +0.4 against `balanced`
  (CI [−0.7, +1.7]). `tokenmax` beats `balanced` by +1.5 (CI [+0.2, +2.8]).
- **Context:** on LongMemEval-M development questions fact keys beat
  `balanced` by +3.2 points (CI [+1.3, +5.1], 18 wins / 3 losses); M did not
  run the `tokenmax` comparison because of cost.
- **Consequence:** no product code, schema, config key or backfill ships. The
  eval arms stay (`--fact-keys`, `--fact-extractor paper|production`), as do
  the harness's production synopses for `--mode tokenmax` and the LoCoMo
  converter.
- **Full build, not shipped:** branch `capy/p6-time-aware-reading` at
  `5024ec99f4f591227d12b39b38e304d3255de2c5` (migration v209, publication with
  prepare-then-swap, retirement hook, withdrawal discovery, a `fact-keys` CLI
  command, doctor `retrieval_enrichment`, and a `--fact-extractor pipeline` arm that
  runs that shipping path). Design: [`docs/designs/FACT_KEYS.md`](../../../designs/FACT_KEYS.md).
- **Untested follow-up:** fact keys stacked on `tokenmax`, against `tokenmax`
  alone.

Numbers: [`TIME_AWARE_RETRIEVAL_RESULTS.md`](../../TIME_AWARE_RETRIEVAL_RESULTS.md), "Fact keys".
