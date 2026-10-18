# Entity-anchored retrieval in query and search: verdict

Entity anchoring passes gates 1 and 2 here. `search.entity_anchoring` stays off until the harness lane's gate 3
(dev slices, then validation) passes, and that run has not happened. On the seeded appended-corrections
workload (3 seeds, embeddings on), turning the key on lifted `query` + reader at equal tokens from 88.4% to
100% accuracy, from 11.6% to 0% stale-wrong answers, and from 0.139 to 0 batches of freshness lag. Turning it on
lowered no question's recall in the existing evals that cover `query`, but on their as-written questions it
never fired, so that pass shows only that nothing else moves.

Measured build: gbrain 2fa44f149 (the `capy/mpw-integration` branch). c4add4176 moves the op seam into
`entity-anchor.ts` with no change in behavior. Stage: dev.

## The change

Some questions name one entity and ask for its current state: "Which city does acme-example build widgets in
now?" For these, `query` and `search` put the entity page first, then pages that link to it or name it,
newest first, ahead of the organic rows. The row count and the token budget stay what the caller asked for.
The code is `src/core/search/entity-anchor.ts`. Pinned-question refresh already used this anchoring, and both
callers now share it (`entityAnchoredPages`).

- **Detection is deterministic and makes no model call.** It needs a current-state cue in the query ("now",
  "currently", "latest", "these days" and similar) and exactly one entity page whose title the query mentions
  as a token run. That page must be a person, company, organization, fund, project, deal or concept, and the
  caller must be able to read it. With no entity or several entities, nothing changes.
- **Read safety.** Every row the change adds comes from `getChunkWindows`, which re-authorizes each page under
  the caller's scope: source, deleted, projection, archived source, quarantine, private pages and safe chunks.
  A page in the organic set keeps its row and moves up.
- **Scope.** Anchoring applies to plain queries only. It is skipped with `offset`, `types`, `since`, `until`,
  `lang`, `symbol_kind` or `near_symbol`, and on the keyword-only `search` path. Anchored rows take at most
  half the rows.
- **Touch points.** The change is additive in the op layer, and `hybridSearch` ranking is untouched:
  - `src/core/ops/search.ts`: one guarded call each in `search` (after the declared-name fan-out) and in
    `query` (after the fan-out, before the CRAG grade).
  - `src/core/search/entity-anchor.ts` (new).
  - `src/core/questions/refresh.ts`: `anchoredSlugs` now calls the shared function with the same SQL.
  - `src/core/types.ts`: the optional `SearchResult.entity_anchored` field.
  - `src/core/config.ts`: the key registration.

## Results

### Gate 1: seeded workload (pass)

Every state of every seed triggered anchoring (216 of 216). Each cell is the mean across seeds 42, 7 and 1234,
with the min and max in brackets.

| Arm | Accuracy | Stale-wrong | Freshness lag (batches) | Correct at change | $ per correct |
|---|---|---|---|---|---|
| **key on, equal tokens** | 1.000 [1.000, 1.000] | 0.000 | 0.000 | 1.000 | 0.00127 |
| key off, equal tokens | 0.884 [0.875, 0.903] | 0.116 [0.097, 0.125] | 0.139 [0.117, 0.150] | 0.861 [0.850, 0.883] | 0.00133 |
| key on, full evidence | 1.000 | 0.000 | 0.000 | 1.000 | 0.00230 |
| key off, full evidence | 0.981 [0.972, 0.986] | 0.009 [0.000, 0.028] | 0.022 [0.017, 0.033] | 0.978 [0.967, 0.983] | 0.00235 |

| Seed | Accuracy on / off | Lag on / off | Wins | Accuracy lower |
|---|---|---|---|---|
| 42 | 1.000 / 0.875 | 0.000 / 0.150 | yes | no |
| 7 | 1.000 / 0.903 | 0.000 / 0.117 | yes | no |
| 1234 | 1.000 / 0.875 | 0.000 / 0.150 | yes | no |

- The key-off arm reproduces run 3's query + reader arm (0.884), so the comparison sits on a known baseline.
- At equal tokens, anchoring puts the newest note about the entity inside the budget. Off, keyword and vector
  ranking often surface an older note first, and the reader repeats the superseded city.
- Cost per correct answer falls slightly (0.00127 against 0.00133), because the reader reads the same tokens
  and is right more often.
- **Caveat.** This workload was built around exactly this failure mode, so every question is an entity-scoped
  current-state question. It shows the mechanism works; it cannot say how often real questions take this shape.
  Gate 3 measures that.

Metered spend: $1.52 of the $10 cap. Voyage embedding and rerank calls are not metered.

### Gate 2: existing retrieval evals (pass)

All corpora were run through the `query` op, keyword-only and hermetic. Recall@10 and MRR are shown key on /
key off.

| Corpus | Questions | Anchoring fired | Recall@10 lower | Recall@10 higher | Recall@10 on / off | MRR on / off |
|---|---|---|---|---|---|---|
| namedthing | 12 | 0 | 0 | 0 | 0.917 / 0.917 | 1.000 / 1.000 |
| namedthing+now | 12 | 0 | 0 | 0 | 0.833 / 0.833 | 0.917 / 0.917 |
| relational | 38 | 0 | 0 | 0 | 1.000 / 1.000 | 0.289 / 0.289 |
| relational+now | 38 | 24 | 0 | 8 | 0.136 / 0.000 | 0.096 / 0.000 |
| longmemeval-nightly | 10 | 0 | 0 | 0 | 1.000 / 1.000 | 1.000 / 1.000 |
| longmemeval-nightly+now | 10 | 0 | 0 | 0 | 1.000 / 1.000 | 1.000 / 1.000 |

- The `+now` rows are a diagnostic, not the gate: each question has " now" appended so anchoring can fire.
  On the relational fixture it fired on 24 of 38 questions. 8 gained recall and none lost.
  NamedThingBench titles are not entity pages, and the LongMemEval nightly fixture has none either, so
  anchoring never fires there.
- No hard-negative question lost its clean top 3.
- **Key off matches the build without the change.** Every key-off response in this script, 120 rows across the
  corpora, matches the same script run on the pre-change code. The only differences are fields that vary
  between any two runs: scores carry a recency term computed from the clock, and page revisions are random
  UUIDs.
- Reproduce: `bun evals/entity-anchoring/regression.ts --json`.

## Where else this applies

The pinned-questions run 3 also recommended think's gather for current-state questions about one entity, and
context_pack's entity cards. Neither is built. Each needs its own gate.

## Gates (preregistered)

1. **Seeded workload.** This is the appended-corrections workload from
   `docs/eval/decisions/c4-pinned-questions/` (run 3).
   - Setup: seeds 42, 7 and 1234; 6 entities; 12 write batches; `voyage:voyage-4` embeddings after every
     batch; balanced search.
   - Arms: the `query` op (expansion off) with `search.entity_anchoring` on and off, read by the B-suite
     reader `anthropic:claude-sonnet-5-5` at equal tokens. The budget is 200 tokens of rows in rank order,
     the same as run 3's query + reader arm.
   - Sensitivity arms, reported but not decisive: the same two arms at full evidence (16 rows).
   - Metrics, as in run 3: accuracy, stale-wrong rate, freshness lag in batches, correct at change and
     dollars per correct answer.
   - **Rule:** the key-on arm wins gate 1 if, in every seed, its accuracy is higher or its mean freshness lag
     is lower, and its accuracy is lower in no seed.
2. **No regression on the existing evals that cover `query`**, each run through the `query` op with the key
   on and off. Each reports how many questions triggered anchoring, because a corpus where it never fires
   proves nothing:
   - NamedThingBench and the relational retrieval-quality fixture (`test/fixtures/retrieval-quality/`),
     hermetic and keyword-only.
   - The LongMemEval nightly fixture (`test/fixtures/longmemeval-nightly.jsonl`), ingested the way
     `gbrain eval longmemeval` ingests it.
   - **Rule:** with the key on, no question's top-10 recall is lower than with the key off.
   - The `gbrain eval longmemeval` command itself calls `hybridSearch` directly, so the key cannot change it.
3. **Harness lane.** This is run by the harness lane, not here: dev slices (LongMemEval knowledge-update,
   PersonaMem, BEAM dev), then confirmation on validation. The harness must retrieve through the `query` op
   (or `gbrain query`) with `search.entity_anchoring=true` for the change to apply.

**Decision.** The key becomes default-on only if gates 1 and 2 pass here and gate 3 passes in the harness
lane. Until then it stays off. The cap for gates 1 and 2 is $10.

## Reproduce

```bash
bun evals/entity-anchoring/query-gate.ts --plan --seeds 42,7,1234 --embeddings voyage:voyage-4
bun evals/entity-anchoring/query-gate.ts --run --yes --max-usd 4 --seeds 42,7,1234 --entities 6 \
  --reader-model anthropic:claude-sonnet-5-5 --embeddings voyage:voyage-4 --json
bun evals/entity-anchoring/regression.ts --json
```

## Changelog

- 2026-10-05: gates 1 and 2 pass on 2fa44f149. The key stays off pending gate 3.

- 2026-10-05: gates preregistered before any gated run.
