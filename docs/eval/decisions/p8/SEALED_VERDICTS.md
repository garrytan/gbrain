# P8 held-out verdicts

Each part's held-out result, measured by the custodian (P0) against the gates in
[PREREGISTRATION.md](PREREGISTRATION.md). A part turns on by default only when its row says PASS.

| Part | Gate | Held-out result | Verdict | Default |
|---|---|---|---|---|
| Write cost (section 2) | commit-path generative attempts = 0 in both arms | 0 in the extraction-on and extraction-off arms | PASS | Guard on; cost published |
| Quote grounding (section 6) | supported spans wrongly flagged, Wilson 95% upper bound ≤ 5% | 4.7% wrongly flagged, upper bound 7.6%; the second custodian's rescore with the fixed scorer: 16 of 319 (5.0%), upper bound 8.0% | FAIL | superseded by the retest below |
| Quote grounding retest on sealed-confirmation-v2 | — | stopped after a 26-question pilot and 31 of 260 questions; no gate computed (v2 is reserved for release decisions) | VOID | — |
| Quote grounding retest (section 6, amendment 2026-10-05) | same gate, fresh custodian-written sessions, build 7715e647a | 5 of 321 supported spans wrongly flagged (1.56%), upper bound 3.59% | PASS | `think.quote_verify` and `dream.quote_verify` on by default |
| Semantic withdrawal review (section 3) | precision LB ≥ 0.90, end-to-end recall ≥ 0.60, zero proposals on corrected values, N5 unchanged | precision LB 0.970 (124/124 eval families, 248 actions), end-to-end recall 0.977, 0 proposals on corrected values, N5 contracts pass | PASS | `review_withdraw` on (proposes where the conflict slot is on with a TypeSafe key); reference calibration shipped |
| Advertised tool surface (section 7) | pooled success ≥ control − 3 pts, no leak rise, hidden-tool family ≥ control − 5 pts | `starter` −8.5 pts pooled (95% CI −12.5 to −4.8), hidden-tool −50.0; `verbs` −9.9 pts (−13.3 to −6.7), hidden-tool −21.2; no leaks | FAIL (both arms) | new installs advertise `full`; `mcp.advertised_surface` stays opt-in; `rate_answer` not added as an eighth verb |
| HTTP graph freshness (report-only) | remote `put_page`: timeline row at commit; mention links after the `links` effect; typed edges only after extract | as stated, on PGLite (`test/remote-graph-freshness.test.ts`) | REPORT | no switch |
| Duplicate review kinds (section 4) | per kind, as section 3 | not run until P1/P5 enqueue candidates | — | off |

## Quote grounding

The new quote grounding (think answers and the `synthesize` verb, `think --save`, concept narratives, pattern
pages) is on by default after its retest passed; `gbrain config set think.quote_verify false` and
`gbrain config set dream.quote_verify false` turn it off. The dream synthesis quote check that predates P8
(`dream.synthesize.quote_verify`, default on) matches master byte for byte: the matching tolerance P8 adds applies
only to the new coverage's sources (`groundSource(…, { tolerant: true })`).

The record, in order:

1. **First sealed run: FAIL.** 4.7% of supported spans wrongly flagged (upper bound 7.6%) on build 6c958d6e2.
2. **Rescore: FAIL stands.** The second custodian fixed a scorer defect (flagged quotes were matched to answer
   spans by substring containment) and replayed the sealed answers and judge labels with no model calls: 16 of 319
   (5.0%, upper bound 8.0%). Record: gbrain-evals `docs/benchmarks/2026-10-05-heldout-verdicts/p8-quotes-rerun-2026-10-05.json`.
   Most false flags were matcher gaps, now handled by the tolerant matcher (described without sealed text):
   - link display text written as `[Name]` without the target, against the source's `[Name](target)`;
   - the source's inner `"` written as `'` inside a quotation (a repair never inserts a `"`);
   - editorial brackets in or at the end of a word: `[T]he` for `the`, `decide[s]` or `want[ed]`;
   - a quote of the user's own question (policy decision): the question is a grounding source for think answers.
3. **Retest on sealed-confirmation-v2: VOID.** Stopped after a 26-question pilot and 31 of 260 questions, with no
   gate computed, because that corpus is reserved for release decisions; its results did not shape P8.
4. **Retest on fresh material: PASS.** Per the 2026-10-05 retest amendment, on frozen build 7715e647a, think model
   `claude-sonnet-5-5`, judge `gpt-6.1-sol` (it sees the question, so a quote of the question counts as
   supported): 320 questions over 552 custodian-written synthetic sessions (new seed, disjoint from the dev
   questions and the first sealed set, no sealed-confirmation-v2 content). 5 of 321 supported spans wrongly flagged
   (1.56%, Wilson 95% upper bound 3.59%; bar below 5%). Reported, not gated: 5 of 173 questions had a wrong flag
   (upper bound 6.6%). Cost about $15. Record: gbrain-evals
   `docs/benchmarks/2026-10-05-heldout-verdicts/p8-quotes-retest2-2026-10-05.json` (gbrain-evals#85).

What the gate does not show: of the 7 spans the judge labeled unsupported, gbrain flagged 2 and kept 5. The run is
sized to measure false flags only, so quote grounding is not yet a measured safety net against made-up quotes.
Follow-up: a run sized to measure how often unsupported quotes are caught.

## Advertised tool surface

Cat 40 on P0's seed-disjoint held-out world, callable surface `full` in every arm, uncapped tool results, four
models (`claude-sonnet-5-5`, `gpt-6.1-sol`, `claude-opus-5-5`, `claude-fable-5-1`). Disclosure: per the 2026-10-05
amendment, Fable ran 1 repeat per task; the other models ran 2. Spend about $767 of the $800 limit.

| Arm | Pooled success | Δ vs `full` (95% CI) | Hidden-tool success | Δ vs `full` |
|---|---|---|---|---|
| `full` (control) | 93.2% | — | 96.9% | — |
| `starter` | 84.7% | −8.5 (−12.5 to −4.8) | 46.9% | −50.0 |
| `verbs` | 83.3% | −9.9 (−13.3 to −6.7) | 75.6% | −21.2 |

Neither narrower arm passes the pooled gate (≥ control − 3 points) or the hidden-tool gate (≥ control − 5 points),
so the held-out result rejects narrowing the default list. Hidden-tool tasks collapse under `starter`: GPT goes from
87.5% to 5% and Fable from 100% to 25%. Opus is the only model that passes `starter`; the outcome is the same
without Fable. No arm raised leaks or context exposures, no model sat at a ceiling, and the arms cost about the
same, so the narrower lists saved no tokens.

Default: fresh installs keep advertising every callable tool, and new stdio registrations keep master's
`serve --surface starter` pin. The `mcp.advertised_surface` setting (every tool stays callable; `request_tools`
reaches the unlisted ones) ships as an opt-in. `rate_answer` stays on the `full` surface only and does not join the
verbs.

## HTTP graph freshness (report-only)

Measured on master with #6025 (remote bulk writes and mention links) merged in. A remote OAuth `put_page` with a
dated timeline bullet and `[[people/alice-example]] … works at [[companies/acme-example]]`:

| Stage | What is queryable | Time from submit (PGLite, local run) |
|---|---|---|
| Commit | the page and its dated `timeline_entries` row; no links | 206 ms |
| `links` effect drained | `mentions` edges to the two visible same-source pages; no typed edge | 259 ms |
| `extract` phase | typed `works_at` edges added beside the mentions | 390 ms |

With `mcp.remote_auto_links=false` no mention pass is queued. Times are one local run on a small PGLite brain and
include no worker scheduling delay; on a served brain the mention links wait for the effect worker and typed edges
for the next extract (dream cycle or `gbrain extract`). #6025's own contract tests cover confinement, revoked
clients, restarts, superseded revisions and reconcile on PGLite and Postgres.

Lock order: #6025's effects take the brain row before the source row (`guardEffectSource`). P8's write paths take
no brain or source row lock (the `remember.replaces` target-fact lock lives inside the publication transaction,
the review queue row commits inside the withdrawal transaction, and attribution is async context only), so there
is no inverted order. The P8 Postgres E2E and #6025's links-effect E2E pass together on direct Postgres and through
transaction-mode PgBouncer.

## Semantic withdrawal review

Held-out record: gbrain-evals `docs/benchmarks/2026-10-05-heldout-verdicts/p8-withdraw-heldout-2026-10-05.json`
(build 6c958d6e2, reviewer TypeSafe `jev-1.13.0`). 240 families with disjoint name and value pools: 66 paraphrase
pairs written by Google Gemini and checked one by one by the custodian (7 rewritten, 0 dropped; the 2026-10-05
amendment), 414 model restatements, and 240 each of corrected values, negations, past-tense versions, compound
claims and independent facts. Calibrated on the 116-family half (threshold 0.62, precision and recall 1.0);
qualified on the 124-family half: 124/124 families correct over 248 withdraw actions (Wilson lower bound 0.970).
Retrieval at the 0.80 cosine floor finds 97.7% of restatements (model 404/414, custodian-checked 65/66).

Default: `decide.slots.conflict.review_withdraw` is on unless turned off, and the binary ships the held-out
calibration as reference `conflict-review-withdraw-jev-1.13.0-2026-10-05`, so the lane proposes wherever the
conflict slot is on with a TypeSafe key. It never withdraws on its own: every proposal needs the owner's accept.
