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

## Eval write-path fix wave (2026-08-31, branch roseau)

The first wave whose receipt is the WRITE path (gbrain-evals Cat 35), bracketed
by two paid runs at the sonnet judge:

- **Pre-wave baseline (Phase 0, REQUIRED before any code change):** gbrain
  master @ aa820c7f re-pinned into gbrain-evals — dream salient recall
  **70.2%** (the published 61.5% was 62 commits stale; +8.7pp had already
  landed via #4152 + oneshot), quote fidelity **54.2%** (130/240),
  hallucination 14.0%, emission **16/20** (same four triage misses, scores
  0.32–0.42 — the F2 rescue band), facts lane 58.6%. Receipt archived at
  `~/gbrain-cat35-receipts/phase0-baseline-aa820c7f.json` (operator machine).
- **Post-wave run (final, RC 079941d2 after the ship-review fixes; gates PASS,
  $6.36, 35 min):** dream salient recall **88.1%** [82.0-93.5] (+17.9pp vs the
  Phase-0 baseline; strict 82.1%), emission **20/20** — and this run is the
  cleanest proof of the rescue: ALL FOUR previously-missed transcripts scored
  BELOW the 0.5 gate (0.45 / 0.35 / 0.42 / 0.42) and still emitted, while
  pure-routine controls stayed at zero pages (no false fires). Quote fidelity
  **82.7%** (115/139 vs 130/240 = 54.2% at baseline), hallucination **7.0%**
  (45/645, halved from 14.0%), facts lane **64.8%** (+6.2pp; idea-kind 50.0%
  vs the published 38.3%), usability 41.9% (from 36%). Per-kind dream, every
  kind up sharply: fact 86.1 (from 64.8) / decision 88.6 / idea 86.7 / entity
  95.0 / vibe 87.5. Judge ceiling 93.0% (stable — runs comparable); 95 item
  flips. Dream distractor leakage 1.2% (1 item) — the Phase-0 baseline also
  measured 1.2% and the intermediate run 0%, so this is single-item run-to-run
  noise, not a rescue cost. Receipt:
  `~/gbrain-cat35-receipts/phase7b-final-079941d2.json` (operator machine).
  An intermediate run at 1ee7db52 (pre-review-fixes) measured dream 80.5% /
  quotes 84.6%; the +7.6pp between them is the quote-span and offset-map fixes
  the ship review caught. Two commits land after the measured SHA
  (docs/TODOs/manifest + the inline-drain phase tag, normalizer code-point
  parity, newline-collapse, mask reuse); all are measurement-neutral on this
  corpus — the scorer normalizes whitespace on both sides (`normalizeWs` in
  cat35-checks.ts), the parity change only moves Greek final-sigma/non-BMP
  folding, and the rest is telemetry.

In-repo gates at the wave head: verify 54/54; BrainBench compare **PASS
(same-hash)** — kta 0/149 on all three seams, push recall/precision and
isolation unchanged (read path untouched by design); live triage calibration
(required Phase-4 gate): band accuracy **95%** on the 20-fixture drift pin,
buried gate passes **5/5** under rubric v2.

Retrieval canary: PASS @ 1ce45f0a (hermetic deterministic-embedder CLI run;
recall@10=1.0000 first_relevant=1.0000 expected_top1=0.8571 vs floors
0.70/0.60/0.85; 14/14 queries; ledger: .gbrain-evals/eval-results.jsonl).

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
job. Runs in CI via `test/eval-canary.test.ts` in the unit matrix;
`check:eval-canary` remains as an on-demand package script (removed from the
verify battery as pure double work).

Verified-bug status at W0 ship: cycle-lock refresh + fencing (TODO-OPS-2
closed), stall-death parent unblock, started_at ×4, modality carry, import
typed aborts, lint single-pass, prompt EOF safety, guard self-test harness,
snapshot default-on. W0a superseded by master's WP1/D7 (port-ledger in the
plan file).
