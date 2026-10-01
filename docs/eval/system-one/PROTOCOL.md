# System One v1 eval protocol

This is how every verdict in [README.md](README.md) was measured. The plan
(`docs/designs/SYSTEM_ONE_JEV_V1.md`, "Evals and verdicts") sets the rules;
this page records how they were applied and where the eval deviated.

## Matched pairs

Each slot is measured as a matched pair: the same commit, the same data, the
same seed and the same brain, with only the slot's mode different (`off` is
today's path, `on` is the slot acting at its calibrated threshold).

- **Commit.** Every run used `feat/system-one-v1-evals` at the commit named in
  its receipt directory. Runs never mixed commits within a pair.
- **Provider.** `typesafe:jev-1.13.0`, pinned. Every response reported
  `model: jev-1.13.0`; no run saw a mixed or drifted model.
- **Frozen splits.** Every dataset is built by `gbrain decide dataset`, which
  assigns each *family* (conversation, transcript, question or fact family) to
  the calibrate or eval half by a stable hash of the family id, and records a
  `split_hash`. Calibration reads only the calibrate half. Every reported
  effectiveness number comes from the eval half. Hashes are in
  [datasets/HASHES.md](datasets/HASHES.md).
- **Thresholds.** From `gbrain decide calibrate` on the calibrate half. For a
  harmful-direction slot the target protects the positive class, because the
  harmful action is the *negative* prediction (prune, reject, quarantine,
  suppress): S7 `--target recall --min 1.0`, S8 `--target recall --min 0.95`,
  S3 `--target recall --min 0.98`. S6 and S9 use F1. S2 has no calibrate
  target that fits its reducer, so its threshold is the calibrate-half
  accuracy maximum (runner `s2-analyze.ts`).
- **Qualification.** `gbrain decide qualify` on the eval half, family-level
  Wilson 95% lower bound after the production reducer, gate 0.90;
  `insufficient_n` below 35 families with a harmful action.
- **Stability.** `retest_sd` and `repack_sd` come from calibrate (50 families,
  3 repeats, 3 resampled co-packed neighbour draws). Each slot's decision
  flip rate comes from asking the eval half twice.
- **Timeouts** count as failures in every effectiveness number (none occurred
  in the recorded runs unless a receipt says so).

## Two ways a pair was run

1. **Production path end to end.** S7 (`runners/s7-triage-pair.ts` calls
   `runTriagePass`, the function `gbrain dream` uses) and the LongMemEval arms
   (`runners/lme-arms.sh` calls `gbrain eval longmemeval --decide ...`).
2. **Recorded answers + production reducer.** S2, S6, S8 and S9: the eval half
   is asked once through the slot's dataset adapter (the same request shape
   `calibrate` and production send, `runners/ask-dataset.ts`), then the slot's
   production reducer is applied at the calibrated threshold and compared with
   today's deterministic path (regex, reflex, mechanical checks, cosine rule).
   No verdict needed a second paid run, and the same answers give the flip rate.

## Labels

Every dataset line carries `label_source`: `upstream-gold` (a corpus's own
construction labels: Cat 35 `expected_triage`, BrainBench gold, LongMemEval
answer sessions and question types), `synthetic-construction` (a generator's
intent, not checked by a person), or `llm:<model>` (an LLM judge). **No label
in this eval is a human hand label.** The plan's hand-labelled S8 sample is
still owed.

## Latency

Latency figures are wall-clock from one Capy cloud machine (or the named
Ubicloud VM) to TypeSafe, not production hot-lane figures under load.
Per-request figures for dataset-adapter runs are background-lane requests at
concurrency 2–8.

## Cost

Every paid call is in [ledger.jsonl](ledger.jsonl) (this lane) and
[ledger-datasets.jsonl](ledger-datasets.jsonl) (dataset building). Jev spend
comes from the eval brains' `decide_spend` rows; LLM spend from provider
usage at the repo's price table; embeddings at list price.
