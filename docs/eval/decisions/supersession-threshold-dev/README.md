# Fact supersession threshold with production embeddings: dev finding

This replays the C2 supersession fixture (see [c2-interleave-dev](../c2-interleave-dev/README.md)) on gbrain
7d2cc1c70. The fixture was embedded through the product gateway with each production model and swept over
explicit-lane cosine thresholds from 0.80 to 0.97, for both candidate-fusion arms.

For the default model, `voyage:voyage-4`, the product's threshold of 0.95 is already the best guarded
choice, so this finding proposes no change for it. The threshold does depend on the embedding model, though.
With `openai:text-embedding-3-large`, no threshold meets the guard, and at 0.95 it replaces 54% of new
coexisting claims. Even at its best setting on the default model, a cosine threshold alone leaves 47% of
corrections inserted beside the old value. The verdict is `dev`; the per-model table it led to is applied in this wave (see below).

## Results (rrf_free arm; interleave is the same from 0.90 up and one correction worse below)

| Model | Threshold | Corrections missed | Coexisting claims wrongly replaced | All false supersessions | Distinct claims preserved |
|---|---|---|---|---|---|
| voyage-4 (default) | 0.90 | 18.8% | 77.5% | 15.5% | 95.1% |
| voyage-4 | 0.93 | 34.6% | 27.5% | 5.5% | 98.3% |
| voyage-4 | **0.94** (balanced) | 37.1% | 7.5% | 1.5% | 99.5% |
| voyage-4 | **0.95** (product, guarded best) | 46.7% | 3.75% | 0.75% | 99.8% |
| voyage-4 | 0.96 | 55.8% | 1.25% | 0.25% | 99.9% |
| voyage-4 | 0.97 | 73.8% | 0% | 0% | 100% |
| 3-large | 0.90 | 34.6% | 77.5% | 15.5% | 95.1% |
| 3-large | 0.95 (product) | 63.3% | 53.75% | 10.75% | 96.6% |
| 3-large | 0.97 (balanced) | 81.7% | 18.75% | 3.75% | 98.8% |

- "Corrections missed" covers corrections, back-to-back corrections and private corrections: 240 probes,
  each with a known old value.
- Restatements are missed more often at higher thresholds: on voyage-4, 0% up to 0.92, 20% at 0.95 and 45%
  at 0.97.
- The full 18-threshold sweep for both models is in `verdict.json` under `models.*.threshold_sweep`.

The selection rule was fixed in the script before these runs. It picks the lowest correction miss rate with
false supersession at or under 1% of probes and at least 99.5% of distinct claims preserved. For voyage-4 the
rule selects 0.95, the current value. The balanced point (fewest corrections missed plus coexisting claims
wrongly replaced) is 0.94. Moving there would trade 9.6 points of correction misses for 3.75 points more
coexisting claims wrongly replaced, and would put false supersession at 1.5%, over the guard. That isn't
clearly better, so 0.95 stays.

For 3-large, no threshold meets the guard. Every setting from 0.80 to 0.97 wrongly replaces at least 18.75% of
new coexisting claims. Wrong replacements fall only as the threshold rises, and missed corrections rise just
as fast.

## Why: the cosine distributions

| Model | Correction vs. its old value (p10 / median / p90) | Coexisting claim vs. nearest sibling (p10 / median / p90) |
|---|---|---|
| voyage-4 | 0.871 / 0.949 / 0.978 | 0.874 / 0.924 / 0.937 |
| 3-large | 0.772 / 0.920 / 0.979 | 0.861 / 0.951 / 0.979 |

On voyage-4, a correction is usually closer to the value it replaces than a new coexisting claim is to its
siblings, so a window near 0.94 to 0.95 exists. On 3-large the order reverses. Templated coexisting claims,
such as "revenue in Q3 2025 was $12.4M" next to the Q2 row, sit closer together than a reworded correction
sits to its old value, so no single cosine cutoff separates them.

On both models the two distributions overlap. Cosine alone can't tell "same claim, new value" from "a
similar claim about a different period". That's why about half of corrections stay unreplaced even at the
best threshold on the default model.

## Applied in this wave

Fix 1 below is in the memory proof wave. Fix 2 is not.

- **Calibration table.** `src/core/facts/supersession-threshold.ts` holds one table keyed `provider:model@dims`.
  Its only entry is `voyage:voyage-4@1024` at 0.95, so voyage-4 decides exactly as before.
- **Readers.** The fixed 0.95 constants in `capture-dedup.ts`, `write-single.ts` and the classify fast path now
  read the table.
- **Uncalibrated models,** including `openai:text-embedding-3-large`, never supersede or deduplicate by
  cosine. Each new fact is inserted, and the `conflict` decide sweep judges the pair where it is on.
  Exact-text duplicates still collapse: the fingerprint check in `decideSingleFact` and identical text in
  `writeSingleFact`.
- **Override.** `facts.supersession_thresholds` takes a JSON map `{"provider:model@dims": number | "off"}`, so an
  operator can register a measured value without a release.
- **Doctor.** `supersession_calibration` is an informational check. For an uncalibrated model it names the
  model and returns two commands, which need consent because the first one costs money:
  `bun scripts/eval-c2-candidate-fusion.ts calibrate <provider:model> <dims> <out>` embeds the fixture (about a
  cent), sweeps 0.80 to 0.97 and prints `threshold_pick.guarded`; then
  `gbrain config set facts.supersession_thresholds` registers the result.

## Proposed fix

1. **Calibrate per model (applied, see above).** Replace the single `EXPLICIT_DUPLICATE_THRESHOLD = 0.95` (`facts/capture-dedup.ts`,
   also hard-coded in `facts/write-single.ts` and the classify fast path) with a per-embedding-model table.
   Keep `voyage:voyage-4` at 0.95. A model with no calibrated entry, such as `openai:text-embedding-3-large`,
   should not supersede by cosine. Its writes insert the new fact and leave the pair to the existing
   conflict review where that is enabled. At 0.95 on 3-large, that gives up the 37% of corrections it
   catches today and removes the 54% of wrong replacements. `gbrain doctor` flags a brain whose embedding model has
   no calibrated threshold. This fixture calibrates a new model for about a cent with
   `bun scripts/eval-c2-candidate-fusion.ts calibrate <provider:model> <dims> <out>`.
2. **Make supersession slot-aware.** The remaining misses need more than a threshold. Supersession can use
   the claim slot: the typed `claim_metric` and `claim_period` columns when both rows carry them, or the
   caller-named target from `remember.replaces` (#6027). Then cosine only nominates candidates, and the slot
   decides whether the new fact replaces the old one or coexists with it.

## Caveats

- The fixture is synthetic and templated. Coexisting members reuse one sentence template, which is close to
  the worst case for wrong replacements. Real extractor output varies its wording more.
- 3-large ran at 1536 dimensions. Other widths give slightly different cosines.
- The replay used the product's `listSupersessionCandidates`. At 0.95, the real `decideSingleFact` agreed with
  the replayed rule on all 800 decisions per model.

## Reproduce

```bash
bun scripts/eval-c2-candidate-fusion.ts embed --model voyage:voyage-4 --dims 1024 --out /tmp/c2-voyage.json.gz   # paid, ~$0.002
bun scripts/eval-c2-candidate-fusion.ts run --embeddings /tmp/c2-voyage.json.gz --taus 0.80:0.97:0.01 --decision-id supersession-threshold-dev
```

The same steps with `--model openai:text-embedding-3-large --dims 1536` produce the second model's rows.
Embeddings file sha256: voyage-4 `894ca7a6f8…`, 3-large in `verdict.json`. Spend was about $0.005.
