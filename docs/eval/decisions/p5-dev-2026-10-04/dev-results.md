# P5 dev results (development data; not eligible to set a default)

Baseline gbrain master 6622a119e; candidate branch `capy/p5-line-grammar-wanted-pages`, pinned at 21befeb5b in
`decision.json`. H1, H2, H4 and H5a are dev diagnostics run from scripts against the two builds (the kit has no runners
for them yet); the LME-S guardrail and the N4 resolver comparison run through `eval:decide` (gbrain-evals
`p0-heldout-harness` 847ef5c), with the kit's output in `verdict.json`.

## H1 — link typing on world-v1 (240 pages, 280 gold edges)

| Build | Type accuracy | Any-type accuracy | Strict F1 | Spurious founded / invested_in / advises / works_at |
|---|---|---|---|---|
| baseline | 0.747 | 0.945 | 0.188 | 77 / 95 / 61 / 44 |
| candidate | 0.767 | 0.945 | 0.195 | 67 / 93 / 54 / 42 |

Pages without relation lines extract identically with the grammar on and off (240/240). The gain comes from the
per-edge verb attachment fix; the two reported failure shapes are fixed:

| Shape | baseline | candidate |
|---|---|---|
| "Joined [Acme] as engineer" (timeline line, prose never names Acme) | mentions | works_at |
| "works at [Acme] ... and also advises [Widget]" | Acme advises, Widget advises | Acme works_at, Widget advises |
| "co-founded [Beta] in 2019, and she works at [Acme]" | Beta founded, Acme founded | Beta founded, Acme works_at |

## H2 — relation lines replacing prose (world-v1 variant, dev seeds 1–3)

| Seed | Rendered lines | Baseline typed recall | Candidate typed recall | Decoy types added by the grammar |
|---|---|---|---|---|
| 1 | 57 | 0.947 | 1.000 | 0 |
| 2 | 55 | 0.873 | 1.000 | 0 |
| 3 | 78 | 0.923 | 1.000 | 0 |

When the prose states the relationship, inference already types it (rendered recall 1.0 in both builds with the prose
kept); relation lines matter where they are the only statement.

## H4 — forward references (world-v1, seeded shuffled writes, sweep every 10 pages)

| Seed | Reference edges | Lost, baseline | Lost, candidate | Withheld entities referenced | In `wanted_pages` | Non-entity wanted targets |
|---|---|---|---|---|---|---|
| 1 | 635 / 623 | 306 (48%) | 0 | 29 | 28 (0.97) | 0 |
| 2 | 635 / 623 | 294 (46%) | 0 | 30 | 29 (0.97) | 0 |
| 3 | 635 / 623 | 309 (49%) | 0 | 29 | 29 (1.00) | 0 |

(Reference edge counts differ by build because the candidate's inference fix removes spurious duplicate-typed edges.)
The full world-v1 corpus has 109 linked person/company pages that do not exist; `wanted_pages` lists them.

## H5a — similar-page hint on the N4 entity ledger (dev seed 1)

| Mention family | n | recall@3 |
|---|---|---|
| exact name | 24 | 1.00 |
| exact slug | 26 | 0.92 |
| typo | 15 | 1.00 |
| initials (declared alias) | 14 | 1.00 |
| changed name | 2 | 1.00 |
| handle | 19 | 0.68 |
| nickname | 14 | 0.50 |
| first name only | 9 | 0.00 |
| no-referent (hint rate) | 4 | 0.00 |

Lexically detectable families: 79/81 = 0.975. Nicknames without a declared alias, handles and first names are the
semantic gap (deferred). Seeds 2 and 3 give overall solvable recall@3 0.789 and 0.764, with no hints on no-referent names.

## LME-S guardrail and N4 resolver (`eval:decide`, verdict PASS)

| Source | Comparison | Baseline | Candidate | Δ (95% CI) | n |
|---|---|---|---|---|---|
| lme-s-dev | recall_all@5, noninferiority (tolerance 0.01) | 0.9277 | 0.9277 | 0.0000 [0.0000, 0.0000] | 470 questions |
| lme-s-dev | nDCG@10, exploratory | 0.9429 | 0.9429 | 0.0000 [0.0000, 0.0000] | 470 |
| n4-entity-resolution | resolver correct, noninferiority (tolerance 0.01) | 0.6176 | 0.6176 | 0.0000 [0.0000, 0.0000] | 136 items, 10 families |
| n4-entity-resolution | no new wrong merge, exact | pass | pass | | 136 |

Retrieval on LongMemEval-S is identical item for item: chat-session pages carry no relation lines, link targets or
near-duplicate names, so P5 changes nothing they index. The exploratory latency column (168 ms baseline, 61 ms candidate)
is a run-order artifact, not a P5 effect: the baseline shards ran first, alongside the N4 runners and a cold embedding
cache. Resolver outcomes on N4 are unchanged because the similar-page hint is advisory and never merges. Both N4 arms
still miss the runner's absolute bars (b3_f1 0.771 < 0.9, unresolved rate 0.294 > 0.1) identically; that is the
resolver's state on master, outside P5. The LME-S arms cost $4.53 in embeddings.

## Harness gaps (requirements on the eval harness)

1. `eval/runner/type-accuracy.ts` ignores `--gbrain` and `--output`, so the kit now refuses it as a source; H1 needs
   overlay import (`importGbrain`) and a receipt at `--output` with `data.rows` before it can run under `eval:decide`.
2. Category runners take only `search.*` pins, so `candidate.config` (the P5 flags) does not reach
   `n4-entity-resolution`; it measures the candidate's defaults, which have every P5 flag on. A flags-off arm on the
   candidate build needs config pins for category runners.
3. H2: a world-v1 relation-line variant generator with held-out seeds and template families not used in dev.
4. H3: the junk-audit runner (corpus loaders for LongMemEval-S haystacks and LoCoMo transcripts as markdown, a public
   notes vault, two-judge labeling with adjudication).
5. H4: a sequential-write runner (seeded write order, sweep cadence, withheld variant) that reads `wanted_links`, and
   an HTTP-transport arm.
6. H5: a no-referent name set of at least 50 per seed for the false-hint rate, and the "save these notes" agent loop
   recording page creates and edits.
7. H6: the agent-writes-the-brain QA loop with a fair-guidance baseline arm.
