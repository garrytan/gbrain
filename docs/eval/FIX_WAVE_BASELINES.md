# Fix-wave series baselines (W0 → W9)

Recorded per wave so the series' "10x better for 2x effort" claim is measured,
not vibed (fix-wave plan D4.13). Update this file in each wave's PR; keep the
prior rows — the deltas ARE the receipt.

## How to refresh

```bash
wc -l src/commands/doctor.ts src/core/pglite-engine.ts src/core/postgres-engine.ts \
  src/core/operations.ts src/core/migrate.ts src/commands/sync.ts \
  src/core/ai/gateway.ts src/cli.ts src/core/engine.ts \
  src/core/search/hybrid.ts src/core/search/mode.ts src/core/cycle.ts
ls scripts/check-* | wc -l                  # guard count
bash scripts/guard-self-test.sh             # self-tested count + harness runtime
bun run test > /tmp/suite.txt 2>&1; echo $? # wall-clock from the run banner
```

Retrieval-quality canary (MANDATORY before W1, and after W1/W3/W9): run
`gbrain eval gate` against a NON-PRODUCTION brain (the production PGLite brain
is single-writer and usually held by a live `gbrain serve`; eval runs never
touch `~/.gbrain` per the eval discipline — results land in
`<repo>/.gbrain-evals/eval-results.jsonl`). Record the gate verdict + headline
metrics here per run.

## Containment sprint (2026-08-15, v0.46.9.1, branch garrytan/containment-sprint-coverage-modularity)

God-file line counts AFTER the façade peels. Five of the six giants (all but
migrate.ts) were peeled into focused module dirs; the peeled lines live in the sibling dirs
listed below the table (count both when comparing against W0 — the façade
number alone is not the receipt).

| File | Lines |
|---|---|
| src/commands/doctor.ts | 4,177 |
| src/core/operations.ts | 303 |
| src/core/pglite-engine.ts | 5,546 |
| src/core/postgres-engine.ts | 5,704 |
| src/core/migrate.ts | 6,320 |
| src/commands/sync.ts | 4,120 |
| src/core/ai/gateway.ts | 4,049 |
| src/cli.ts | 3,323 |
| src/core/cycle.ts | 2,933 |
| src/core/search/hybrid.ts | 2,453 |
| src/core/engine.ts | 2,343 |
| src/core/search/mode.ts | 1,232 |

Peeled module dirs (where the moved lines live): `src/core/ops/*` 7,759;
`src/commands/doctor/checks/*` 4,944 + four tail modules 1,321;
`src/core/sync-{anchor,cost-gate,git,lock,reconcile,status-report}.ts` 2,030;
`src/core/{pglite,postgres}-engine/*` 3,505. Every façade re-exports its full
prior surface.

Guards: 50 scripts/check-* files; 4 self-tested (harness 0s, budget 30s).
Regrowth is now ratcheted: `check:module-size` (in `bun run verify`) pins
per-file ceilings in `scripts/module-size-limits.tsv` — growth, stale slack,
and unlisted >1,500-line src files all fail.

Test infra: merged lcov coverage on every PR run (advisory), diff-coverage
gate report-only at 80%, corpus-matched baseline gate vs origin/master's
committed baseline, nightly unit+serial+E2E coverage-full pipeline;
behavioral-vs-structural suite classification (`scripts/classify-tests.ts`)
splits the headline test count.

Retrieval canary: NOT RUN in this PR (structural refactor; behavior pinned by
the engine-parity suite, now in CI on every PR and master push). The W1/W3/W9
canary mandate is unchanged.

## W0 (2026-08-14, branch garrytan/code-smell-fix-wave @ post-hotfix)

God-file line counts (the audit's structural targets, BEFORE the registry waves):

| File | Lines |
|---|---|
| src/commands/doctor.ts | 10,057 |
| src/core/operations.ts | 7,459 |
| src/core/pglite-engine.ts | 6,874 |
| src/core/postgres-engine.ts | 6,847 |
| src/core/migrate.ts | 6,201 |
| src/commands/sync.ts | 5,991 |
| src/core/ai/gateway.ts | 4,049 |
| src/cli.ts | 3,301 |
| src/core/cycle.ts | 2,933 |
| src/core/search/hybrid.ts | 2,453 |
| src/core/engine.ts | 2,320 |
| src/core/search/mode.ts | 1,232 |

Guards: 47 scripts/check-* files; 3 self-tested (harness <1s, budget 30s);
single registry established (guards-manifest.tsv; `check:all` deleted; 3
previously-unreachable guards wired into verify).

Test infra: PGLite snapshot default-on for `bun run test`. Per-PGLite-file:
1.63s cold → 0.91s snapshotted (measured on test/db-lock-fencing.test.ts).
Full-suite wall-clock (post-snapshot): recorded in the W0 ship notes — see
the run banner of the W0 PR's `bun run test` evidence.

Retrieval canary: PASS @ f2b40f7ef (hermetic deterministic-embedder CLI run;
recall@10=1.0000 first_relevant=1.0000 expected_top1=0.8333 vs floors
0.70/0.60/0.50; run `bun run scripts/run-eval-canary.ts` to reproduce, ledger:
.gbrain-evals/eval-results.jsonl). Honest scope: the canary gates the hybrid
ranking pipeline (keyword/title/alias arms + RRF against gold qrels) with
synthetic basis vectors — no API keys, no production brain, so the live-serve
lock is moot. Semantic-embedding regressions remain the keyed eval suites'
job. Wired into `bun run verify` as check:eval-canary.

Verified-bug status at W0 ship: cycle-lock refresh + fencing (TODO-OPS-2
closed), stall-death parent unblock, started_at ×4, modality carry, import
typed aborts, lint single-pass, prompt EOF safety, guard self-test harness,
snapshot default-on. W0a superseded by master's WP1/D7 (port-ledger in the
plan file).
