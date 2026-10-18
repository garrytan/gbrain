# Interleaved supersession candidates: dev verdict

`facts.candidate_fusion = interleave` (candidate) against `rrf_free`, the single cosine arm (baseline), on
gbrain 91081f319, through an offline PGLite replay of a seeded fixture. Interleave adds no measurable benefit,
so the default stays `rrf_free`. Interleave never improved twin recall@5 and lost 1 to 2 twins out of 280.
False supersession and preserved distinct claims were identical in both arms at every threshold. The verdict
is `dev`, so it cannot set a default.

| Threshold | Twin recall@5 | False supersession | Preserved distinct claims | Correct decisions |
|---|---|---|---|---|
| 0.85 | 99.6% → 98.9% (CI −1.8 to 0 pts) | 19.5% → 19.5% | 93.3% → 93.3% | 64.5% → 64.5% |
| 0.90 | 99.6% → 98.9% (CI −1.8 to 0 pts) | 9.8% → 9.8% | 96.7% → 96.7% | 49.0% → 49.0% |
| 0.95 (product) | 99.3% → 98.9% (CI −1.1 to 0 pts) | 0.75% → 0.75% | 99.75% → 99.75% | 39.0% → 39.0% |

The overall result is `inconclusive` under the decision-kit gates, because the twin-recall superiority gate
neither passed nor failed. Both guards pass.

## What was measured

The fixture has 40 synthetic companies, 1,148 seeded rows and 400 probes. The seeded rows are:

- Single-valued claims, such as revenue, headcount, runway, headquarters, CEO, price, customers, launch date,
  churn and NPS.
- Coexisting similar claims that differ only in numbers or dates: funding rounds, quarterly revenue, office
  openings and board meeting dates.
- Private rows for world claims (a private copy and a private note) and one private-only claim per company.

Every fourth company is dense. It has all four coexisting families with up to 8 members each and three more
private notes per claim, so its cosine top 5 is crowded.

The probes are applied in order, as explicit-lane writes:

- 120 corrections with a changed number, date or name.
- 40 restatements.
- 80 back-to-back corrections of one claim. This is the state a concurrent pair reaches after the publication
  guard's retry.
- 40 private corrections.
- 80 new members of coexisting claims, such as the next funding round or quarter.
- 40 new claims.

Every row carries its claim key, so each probe's expected twin is known by construction.

Each arm replays the fixture on a fresh in-memory brain through the product's `listSupersessionCandidates`.
The arms run the same decision rule as `decideSingleFact`: an exact fingerprint duplicate, or else the
highest-cosine eligible candidate at or above the threshold. The threshold is swept because it is calibrated
for the production embedding model, and this run uses a free local model (`BAAI/bge-small-en-v1.5`, 384
dimensions). At 0.95, the product's explicit-lane threshold, the real `decideSingleFact` ran beside the replay
and agreed on all 800 decisions. Statistics are paired by probe and clustered by company: a cluster bootstrap
CI and a cluster sign-flip p, using `pairedClusterStatistics`.

## Why interleave doesn't help here

The decision takes the highest-cosine eligible candidate, so a keyword-arm row can only change a decision in two
cases:

- Every row in the cosine top 5 is ineligible, for example a private row for a world write.
- The cut to 5 drops a cosine row that would have won.

In 341 to 348 probes the fused set held a row that the cosine arm did not. Still, the first case never occurred:
the cosine arm found 99.3 to 99.6% of twins, including in the dense slice (69 of 70). The second case cost
interleave 1 to 2 twins. No decision changed in either direction.

The dense slice was added after a first run showed no crowding in the standard slice. It is the keyword arm's
best case on this fixture, and it still did not help.

## What dominates instead

The decision threshold and the embedding model matter far more than candidate fusion. Both arms behave the
same way:

- At 0.95, the local model misses 116 of 120 corrections. Those corrections are inserted beside the old value,
  which leaves 166 single-valued claims with two active values at the end.
- At 0.85, the local model falsely supersedes 70 of 80 coexisting claims. A Series B replaces the Series A, and
  one quarter's revenue replaces another's.

These rates belong to this model and are not product numbers. They mean the supersession gate needs to be
checked against the production embedding model. This fixture can do that check with real embeddings for a
fraction of a cent once paid embedding calls are approved.

## Production embeddings

The [supersession-threshold-dev](../supersession-threshold-dev/README.md) follow-up re-embedded this fixture with
`voyage:voyage-4` (the default) and `openai:text-embedding-3-large`, and swept thresholds 0.80 to 0.97 for both
arms. Interleave never helped. With voyage-4 it lost one twin out of 280 to the cut to 5, so at thresholds
0.80 to 0.89 one more correction was missed than with `rrf_free`. From 0.90 up the two arms decided the same.
With 3-large both arms found every twin and decided the same at every threshold. The verdict stands: keep `rrf_free`.

## Reproduce

```bash
bun scripts/eval-c2-candidate-fusion.ts texts > /tmp/c2-texts.json
pip install fastembed==0.8.1
python3 scripts/eval-c2-embed.py /tmp/c2-texts.json /tmp/c2-embeddings.json.gz
bun scripts/eval-c2-candidate-fusion.ts run --embeddings /tmp/c2-embeddings.json.gz --out docs/eval/decisions/c2-interleave-dev
```

`verdict.json` records the sha256 of the fixture texts (`821285709d…`) and of the embeddings file
(`35723141e7…`). Dev spend was $0.
