# Pinned questions: B5 verdict

Pinned questions ship **opt-in**. The win is the anchored retrieval, not the maintained answer. Run 3 used
embeddings and three seeds. A plain reader handed the same entity-anchored evidence that pinned refresh uses,
at the same token budget, was as accurate as a pinned answer: 96.8% of reads against 98.1%, and pinned did not
beat it in seed 42. Handed all of that evidence, the reader was right on every read. The same anchoring lifts
query plus a reader from 88.4% to 96.8% at equal tokens and removes its stale-wrong answers (11.6% to 0%). The
safety gate passes with zero leakage, including 144 restricted-grant probes in run 3.

Pinned answers stay available for owners who want them. They are the cheapest way to serve an entity question
read many times: at 100 reads per write, a correct pinned answer costs $0.00057, against $0.00152 for the
anchored reader at equal tokens and $0.00284 at full evidence. Opt-in means gbrain creates no pin by itself.
Pinning a question is the owner's consent for its paid refresh (plan C1), and a brain with no pins makes no
model call. The refresh phase and `context_pack` delivery stay on for pins that exist, so no setting changed.

The anchored retrieval ships in pinned refresh (`retrieveEvidence` in `src/core/questions/refresh.ts`). Where
else it should apply is under "Where anchored retrieval applies" below.

Measured build: gbrain 1384a0db (the `capy/mpw-integration` branch). Stage: dev.

## Benefit gate

Run 3 decides. Its rule was written into this README and pushed (e17258eb) before any run-3 cell ran. Run 2's
rule compared pinned with query plus a reader on a keyword-only brain, which left the retrieval question open.

### Run 3: maintained answer against anchored retrieval (preregistered 2026-10-05, before any run-3 cell)

Run 2 left one open question. Pinned refresh retrieves evidence anchored on the pin's entity, newest first, and
the other arms did not, so run 2 cannot say whether the win comes from the maintained answer or from that
retrieval. Run 3 is designed to separate the two. It reuses run 2's workload generator unchanged.

- **Control arm, anchored retrieval + reader.** For each state it calls the exact retrieval pinned refresh uses
  (`retrieveEvidence` in `src/core/questions/refresh.ts`: the entity page, then pages that link to it or name
  it, newest first, then hybrid hits, facts, timeline and takes). It hands that evidence to the same reader
  (`anthropic:claude-sonnet-5-5`) at the same token budget as query + reader: the pinned answer's delivered
  tokens, with a floor of 200. No answer is maintained between batches.
- **Sensitivity arms, reported but not decisive.** The anchored control and query + reader each also run at
  full evidence: every item pinned refresh sees, or the top 16 hybrid hits, with no token budget.
- **Embeddings on for every arm.** Pages are embedded with `voyage:voyage-4` (1024 dimensions, gbrain's default)
  after every write batch, and search runs in gbrain's default mode (balanced: hybrid keyword + vector with the
  default reranker). Pinned refresh, query + reader, the anchored control and `think` all search the same
  embedded brain.
- **Three seeds:** 42, 7 and 1234. Results report each seed, the mean and the spread (min and max).
- **Arms otherwise as run 2:** pinned with the default refresh model (`anthropic:claude-opus-4-7`), pinned with
  `anthropic:claude-sonnet-5-5` refresh (model-matched to the reader), query + reader and `think`. Reads per
  write are 1, 10 and 100. Leakage is probed for every seed. The cap is $15.

**Decision rule.** Pinned with the default model beats the anchored control if, in every seed, either its
accuracy is higher or its mean freshness lag is lower, and if there are zero leaks across all seeds.

- If pinned beats the control, pinned questions stay default-on.
- If pinned only ties the control (the rule above fails without a leak), the anchored retrieval is the win. It
  ships, along with a recommendation for where else it applies (such as query for entity-scoped questions),
  and pinned questions go back to opt-in.
- Any leak means opt-in, whatever the accuracy.

#### Run 3 results

Every arm ran on 3 seeds with `voyage:voyage-4` embeddings and gbrain's default balanced search. Each cell is
the mean across seeds, with the min and max in brackets. The reads-per-write ratio does not change accuracy or
freshness.

| Arm | Accuracy | Stale-wrong | Freshness lag (batches) | Correct at change |
|---|---|---|---|---|
| pinned, default model (Opus 4.7) | 0.981 [0.972, 1.000] | 0.000 | 0.022 [0.000, 0.033] | 0.978 [0.967, 1.000] |
| pinned, Sonnet 5.5 refresh | 0.995 [0.986, 1.000] | 0.000 | 0.006 [0.000, 0.017] | 0.994 [0.983, 1.000] |
| **anchored retrieval + reader (control)** | 0.968 [0.944, 0.986] | 0.000 | 0.039 [0.017, 0.067] | 0.961 [0.933, 0.983] |
| anchored retrieval + reader, full evidence | 1.000 | 0.000 | 0.000 | 1.000 |
| query + reader | 0.884 [0.875, 0.903] | 0.116 [0.097, 0.125] | 0.139 [0.117, 0.150] | 0.861 [0.850, 0.883] |
| query + reader, full evidence | 0.991 [0.972, 1.000] | 0.009 [0.000, 0.028] | 0.011 [0.000, 0.033] | 0.989 [0.967, 1.000] |
| think | 1.000 | 0.000 | 0.000 | 1.000 |

Per seed, against the control:

| Seed | Pinned accuracy | Control accuracy | Pinned lag | Control lag | Pinned beats control |
|---|---|---|---|---|---|
| 42 | 0.972 | 0.986 | 0.033 | 0.017 | no |
| 7 | 1.000 | 0.972 | 0.000 | 0.033 | yes |
| 1234 | 0.972 | 0.944 | 0.033 | 0.067 | yes |

**Outcome: tie.** Pinned beats the control in two seeds out of three, and in seed 42 the control is ahead on
both accuracy and freshness, so the preregistered rule fails. There were zero leaks in 144 probes. Under the
rule, the anchored retrieval is the win and pinned questions go back to opt-in.

- Most of run 2's gap was keyword-only search and a tight token budget. With embeddings on, query plus a
  reader at full evidence reaches 0.991, and `think` reaches 1.000.
- At equal tokens, the anchoring itself is worth about 8 accuracy points over plain query (0.968 against
  0.884). It also takes stale-wrong answers from 11.6% to 0%, because it puts the newest notes about the
  entity first.
- Pinned with Sonnet refresh (0.995) is the arm model-matched to the reader. It stays within a seed's
  variation of the full-evidence anchored reader (1.000), so a maintained answer adds no accuracy over
  handing the same evidence to the same model.
- No refresh failed in 432 attempts. The refresh path now parses tolerantly and retries once (see "Malformed
  refresh output" below).

Dollars per correct answer (mean across seeds):

| Reads per write | Pinned (Opus 4.7) | Pinned (Sonnet 5.5) | Anchored, equal tokens | Anchored, full | Query + reader | Query, full | Think |
|---|---|---|---|---|---|---|---|
| 1 | 0.00966 | 0.00683 | 0.00152 | 0.00284 | 0.00133 | 0.00231 | 0.02665 |
| 10 | 0.00139 | 0.00139 | 0.00152 | 0.00284 | 0.00133 | 0.00231 | 0.02665 |
| 100 | 0.00057 | 0.00084 | 0.00152 | 0.00284 | 0.00133 | 0.00231 | 0.02665 |

A pinned read costs about $0.00047, because the reader sees one short answer instead of the evidence. Keeping
a pin current costs about $0.108 per pin over the 12 batches with Opus, or $0.072 with Sonnet. Pinned overtakes
the anchored reader at equal tokens after about 110 reads per pin, and the full-evidence anchored reader after
about 46. That makes pinning a cost choice for questions read often. It is not an accuracy choice.

Metered spend for run 3: $11.80 of the $15 cap. That is $10.95 for the run, $0.38 for a one-entity smoke run
and $0.48 for a Sonnet refresh replay that looked for the malformed output. Voyage embedding and rerank calls
are not metered and were small.

#### Where anchored retrieval applies

Anchoring helps whenever a question names one entity and asks for its current state. It puts the entity page
first, then pages that link to it or name it, newest first. Keyword and vector ranking both treat older and
newer notes about the entity alike.

- **query / search, for entity-scoped questions** (the largest measured effect: +8 accuracy points and no
  stale-wrong answers at equal tokens). When the query resolves to one entity and asks for its latest or
  current state, the newest anchored pages can be blended into the candidate pool ahead of fusion.
- **think's gather** for "now" or "current" questions about one entity. With embeddings, `think` already reaches
  1.000 here at 17 times the anchored reader's cost, so anchoring is the cheaper route to the same answer.
- **context_pack's entity cards**, which choose which pages about a packed entity to show.

Each of these needs its own measured gate before it becomes a default; this run measured only the reader
arms.

#### Malformed refresh output

Run 2's Sonnet refresh failed twice with `model_output_not_json`. A 72-refresh replay on seed 42 did not
reproduce it, so the raw reply was never seen. The parser had two gaps that fit the symptom: it only tried the
span from the first `{` to the last `}`, so prose with braces around the JSON or a draft object followed by a
corrected one broke it, and one bad reply failed the whole refresh. 1384a0db fixes both. The parser now tries
every balanced top-level object and takes the last one shaped like an answer. A reply with no answer object
is retried once with a JSON-only reminder; both calls are charged. Tests are in
`test/pinned-questions-refresh-parse.test.ts`, and 6 of the 7 fail without the fix.

### Run 2: corrections appended as new evidence

The workload is seeded (seed 42) and has 6 entities and 12 write batches, which is 13 writes per entity. Each
entity has a widget-factory city, and corrections arrive as dated notes while the older notes stay as written.
Batch 4 adds two conflicting notes in one week, and the later note corrects the earlier one. Batch 6 delivers
the update through `remember`. Batch 7 withdraws it with `forget`, and the answer reverts. Batch 10 makes the
newest note private. After each batch every question is read 1, 10 or 100 times, depending on the frozen
reads-per-write ratio. The cost counted is total lifecycle dollars: the first answer, every refresh attempt,
delivered read tokens and every model call.

| Arm | Accuracy | Stale-wrong | Freshness lag (batches) | Correct at change | Lifecycle $ |
|---|---|---|---|---|---|
| pinned, default model (Opus 4.7) | 0.986 | 0.000 | 0.017 | 0.983 | 0.649 |
| pinned, Sonnet 5.5 refresh | 0.958 | 0.014 | 0.050 | 0.950 | 0.415 |
| query + reader | 0.514 | 0.486 | 0.583 | 0.483 | — |
| think | 0.792 | 0.208 | 0.250 | 0.783 | — |

Freshness lag is the mean number of write batches before an answer reflects one of the 60 value changes.
Correct at change is the share of those changes answered correctly in the batch they happened.

Dollars per correct answer:

| Reads per write | Pinned (Opus 4.7) | Pinned (Sonnet 5.5) | Query + reader | Think |
|---|---|---|---|---|
| 1 | 0.00961 | 0.00681 | 0.00234 | 0.03061 |
| 10 | 0.00138 | 0.00141 | 0.00234 | 0.03061 |
| 100 | 0.00056 | 0.00087 | 0.00234 | 0.03061 |

- Pinned spends more total dollars than query plus a reader until about 147 reads per pin (163 with the Sonnet
  refresh model). Because it is right twice as often, it is already cheaper per correct answer at 10 reads per
  write, and at 100 it costs a quarter as much.
- Pinned is 3.2 times cheaper than `think` per correct answer at 1 read per write, 22 times at 10 and 55 times
  at 100, and it is also more accurate.
- The Sonnet refresh model cuts lifecycle cost by 36% ($0.415 against $0.649) for 2.8 points of accuracy.
  It returned non-JSON on 2 of 72 refreshes; each time the pin kept its previous answer, which counts against
  it.
- Withdrawal is the weakest event. After `forget` in batch 7, 1 of 6 default-model answers and 2 of 6 Sonnet
  answers missed the revert.
- Leakage: 48 probes through a restricted MCP grant that cannot read private pages, covering search,
  `get_page`, `context_pack` and `questions_status`, found 0 leaks.

**Retrieval asymmetry.** Pinned refresh anchors retrieval on the pin's scope: the entity page first, then
pages that link to it or name it, newest first, with question and synthesis pages excluded. Query plus a
reader uses ordinary keyword retrieval, and `think` uses its own gather. Every arm is keyword-only because the
harness brain has no embedding key. Query plus a reader fails here the way it does in real use: once notes
pile up, keyword ranking treats every note that mentions the entity's city alike and often misses the newest.

**Diagnostic attempt before the fix.** The first run-2 attempt, on 183fee7f, found pinned no better than query
plus a reader (0.528 and 0.542 accuracy against 0.514). Pinned refresh retrieval had the same newest-note
blind spot. baadfc04 fixed it in `src/core/questions/refresh.ts` with a regression test. The attempt is
recorded in `verdict.json` as a diagnostic and was not a decision input.

#### Models

- Answer and refresh model: `anthropic:claude-opus-4-7`, gbrain's default for questions
  (`models.standing_questions`, which resolves to the deep tier). The cost-lever arm refreshes with
  `anthropic:claude-sonnet-5-5`.
- `think` arm: the same default model.
- Reader for the pinned and query arms: `anthropic:claude-sonnet-5-5`, the fixed reader of the B suites.

Metered spend for run 2: $5.92 of the $10 cap ($2.98 for the run and $2.93 for the diagnostic
attempt).

### Run 1: corrections rewrite the evidence page

Measured build: gbrain a4267eed7. Verdict at the time: opt-in. Run 1 found that the benefit gate did not pass
against query plus a reader. Accuracy was at the ceiling for every arm, and pinned answers did not cost less
per correct answer until a pin had been read about 240 times.

The cost counted is total lifecycle dollars per correct, fresh answer: the first answer, every refresh
attempt, delivered read tokens and every model call. The workload is seeded and has 6 entities and
4 write batches. Each entity has a widget-factory city, and later batches correct some of those cities.
After each batch, every question is read 1 or 10 times, depending on the frozen reads-per-write ratio.

| Reads per write | Arm | Reads | Correct | Stale-wrong | Dollars | Dollars per correct |
|---|---|---|---|---|---|---|
| 1 | pinned | 24 | 24 | 0 | 0.0559 | 0.00233 |
| 1 | query + reader | 24 | 24 | 0 | 0.0127 | 0.00053 |
| 1 | think | 24 | 24 | 0 | 0.1828 | 0.00762 |
| 10 | pinned | 240 | 240 | 0 | 0.1262 | 0.00053 |
| 10 | query + reader | 240 | 240 | 0 | 0.1270 | 0.00053 |
| 10 | think | 240 | 240 | 0 | 1.8355 | 0.00765 |

- Pinned lifecycle split: $0.048 went to the first answers and 14 refresh attempts, and $0.0079 (1 read per
  write) or $0.078 (10 reads per write) went to reader tokens over the fresh sentences.
- Break-even: pinned overtakes query + reader after about 240 reads per pin (242 and 237 in the two runs).
  Both arms hand the reader about the same number of tokens per read, so a pin saves little at read time.
  The cost of keeping the answer current is repaid slowly.
- Against on-demand `think`, pinned is cheaper at both ratios: 3.3 times at 1 read per write and 14.5 times
  at 10.

**Ceiling.** Every arm answered every read correctly. The workload rewrites the evidence page when a city is
corrected, so no arm had a superseded value to repeat (stale-wrong is 0 everywhere). This run cannot show an
accuracy or freshness advantage. It decides on cost alone.

#### Models

- Answer and refresh model: `anthropic:claude-opus-4-7`. This is gbrain's default for questions
  (`models.standing_questions`, which resolves to the deep tier).
- `think` arm: the same default model.
- Reader for the pinned and query arms: `anthropic:claude-sonnet-5-5`, the fixed reader of the B suites.
- Retrieval is keyword-only for all three arms, because the harness brain has no embedding key.

Metered spend: $2.34 of the $40 cap.

## Safety gate

`test/helpers/pinned-questions-scenarios.ts` passes 33 of 33 scenarios on PGLite
(`test/pinned-questions-safety.test.ts`) and 33 of 33 on live Postgres
(`test/e2e/pinned-questions-postgres.test.ts`). The full `bun run ci:ubicloud` gate passes on the integrated
tree at 170422f4 (merged with master c9ba7782). The suite covers:

- Zero leakage to restricted grants on search, query, list_pages, get_page, get_versions, context_pack and
  recall.
- No answer text in pages, chunks, versions, history or export.
- Read-time staleness for edits, soft and hard deletes, forget, clock expiry, supersession, visibility changes,
  takes, timeline entries and owner edits.
- Refresh that never publishes over a concurrent edit, a duplicate worker, a crash between publication stages
  or a failure.
- The consent, keyless, budget and no-worker states, and the operator journeys over MCP.

## Reproduce

```bash
# Run 3 (deciding)
bun evals/pinned-questions/appended-gate.ts --plan --json --seeds 42,7,1234 --entities 6 \
  --reader-model anthropic:claude-sonnet-5-5 --refresh-models anthropic:claude-opus-4-7,anthropic:claude-sonnet-5-5 \
  --embeddings voyage:voyage-4
bun evals/pinned-questions/appended-gate.ts --run --yes --max-usd 14.1 --seeds 42,7,1234 --entities 6 \
  --reader-model anthropic:claude-sonnet-5-5 --refresh-models anthropic:claude-opus-4-7,anthropic:claude-sonnet-5-5 \
  --embeddings voyage:voyage-4 --partial run3-partial.json --json

# Run 2
bun evals/pinned-questions/appended-gate.ts --plan --json --entities 6 --seed 42 \
  --reader-model anthropic:claude-sonnet-5-5 --refresh-models anthropic:claude-opus-4-7,anthropic:claude-sonnet-5-5
bun evals/pinned-questions/appended-gate.ts --run --yes --max-usd 7 --entities 6 --seed 42 \
  --reader-model anthropic:claude-sonnet-5-5 --refresh-models anthropic:claude-opus-4-7,anthropic:claude-sonnet-5-5 --json

# Run 1
bun evals/pinned-questions/benefit-gate.ts --run --yes --max-usd 40 --entities 6 --batches 4 --seed 42 \
  --reader-model anthropic:claude-sonnet-5-5 --json
```

`verdict.json` carries all three run reports and the run-2 diagnostic attempt, and `decision.json` records the arms,
models, workloads, decision rule and budget.

## Changelog

- 2026-10-05, run 3: anchored-retrieval control, embeddings on, 3 seeds, on 1384a0db. Pinned ties the anchored
  control (it loses seed 42), so the anchored retrieval is the win and the verdict returns to opt-in. The
  refresh parser now handles malformed replies and retries once.
- 2026-10-05, run 2: appended-corrections workload on baadfc04. Pinned beats query plus a reader on accuracy
  and freshness with zero leakage, so the verdict moves from opt-in to default-on.
- 2026-10-05, run 1: rewrite workload on a4267eed7. Every arm hit the accuracy ceiling and pinned did not win
  on cost against query plus a reader, so pinned questions shipped opt-in.
