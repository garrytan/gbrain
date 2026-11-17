# Baseline for the 2026-10-04 test, eval and CI wave

Three full pull-request runs of the master tree plus only the executed-test
receipts and ledger (no behavior change), on aimonk2025/gbrain#6013. Every job ran
on attempt 1; Bun 1.4.2.

| Run | Commit | Test run | E2E run | PR time to green | Ubicloud vCPU-min | Unit shard max / mean | Selected E2E shard max / mean |
|---|---|---|---|---:|---:|---:|---:|
| A | 7e62a9c12 | 37224651910 | 37224651643 | 1067 s | 940 | 735 / 532 s | 970 / 826 s |
| B | 207d2f3f1 | 37225885152 | 37225884968 | 1020 s | 927 | 813 / 579 s | 933 / 776 s |
| C | c23218296 | 37227060980 | 37227060659 | 1010 s | 899 | 762 / 542 s | 904 / 721 s |

Time to green is the later of the two workflows' last job completion, measured
from run creation. vCPU-min sums job duration times the runner's vCPU count
(GitHub-hosted macOS and Windows cells count zero).

## Executed identities

`bun scripts/ci-executed-counts.ts --base-run <A> --head-run <B|C> --fail-on-additions --deltas docs/test-audit/2026-10-04/expected-deltas.tsv`
passes for A→B, A→C and B→C: the three runs executed the same identity set.

| Lane | Executed | Skipped |
|---|---:|---:|
| unit | 33199 | 55 |
| serial | 4324 | 30 |
| e2e | 3671 | 82 |
| backend-matrix | 1480 | 2 |
| tier1 | 214 | 0 |
| verify | 69 | 0 |
| slow | 39 | 0 |
| jsonb-parity | 16 | 0 |
| verify-tests | 7 | 0 |
| shared-skills | 1 | 0 |
| tier2 | 0 | 8 |

Tier 2 executes nothing while the OPENAI_API_KEY and ANTHROPIC_API_KEY repository
secrets are unset; expected-deltas.tsv declares that lane's skip until they are set.

Acceptance compares the wave head against run C with the same command, after the
baseline is re-taken on a new merge-base whenever the collector is rebased.

## Acceptance

Three full pull-request runs of the finished wave (weights re-mined, backend
matrix in two shards), same measurement. The identity comparison against run C
passes for each: every dropped identity is declared in expected-deltas.tsv.

| Run | Commit | Test run | E2E run | PR time to green | Ubicloud vCPU-min | Unit shard max / mean | Selected E2E shard max / mean |
|---|---|---|---|---:|---:|---:|---:|
| 1 | ce1921e21 | 37237153118 | 37237152915 | 874 s | 739 | 732 / 567 s | 365 / 323 s |
| 2 | b332a88aa | 37238586428 | 37238586232 | 696 s | 740 | 614 / 544 s | 373 / 345 s |
| 3 | 0bfbac34d | 37239440492 | 37239440211 | 743 s | 755 | 680 / 558 s | 451 / 331 s |
