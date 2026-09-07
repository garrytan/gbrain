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

## Ranker wave (2026-09-06, branch stuttgart, v0.48.4.0)

The read-path wave whose receipt producer is the in-repo harness
(`gbrain eval longmemeval`: strict `recall_all@5` plus the new judged
`qa_accuracy` lane) and the R1 reranker A/B. Rows fill in as the receipts
land; "pending" means the run is queued or in flight, not skipped. Every paid
command runs through `scripts/eval-spend-guard.sh 75 <estimate> -- …`
(ledger `~/gbrain-lme-receipts/spend.jsonl`, wave cap $75).

- **Dev-slice parity (harness-only commit, the 40-question
  `evals/longmemeval/dev-slice-seed42.txt`):** 40/40 rows agree on
  `recall_all_hit` with the sibling receipt (gbrain-evals `main`, the
  2026-09-02 hybrid ndjson).
- **A1 parity gate (full 470, hybrid, `--reranker off --autocut off`):**
  PASS — 439/470 strict `recall_all@5` (93.40%) against the sibling
  receipt's 438/470; 469 of 470 rows agree on `recall_all_hit`; any-hit
  identical at 464/470; per-type identical except temporal-reasoning 108 vs
  107 (one question flipped to a hit without a shared embedding cache).
  Reranker-on companion: 449/470 (95.53%) with the same +18 / −8 paired
  pattern as the receipt. Rule was: ≥ 465/470 rows agree with the sibling's
  hybrid ndjson AND the count is within ±2 of 438; every disagreeing
  `question_id` is itemized with per-arm ranks.
- **R1 — NamedThingBench balanced reranker ON vs OFF
  (`scripts/r1-namedthing-rerank-ab.ts --relational`, `voyage:rerank-2.5`,
  paired per query, one in-memory brain, embed cache pinned):** core 11
  non-relational queries PASS (0 hit@1 / 0 hit@3 losses). Relational 39
  graph-relationship queries FAIL without the relational re-pin: hit@1
  21/39 → 3/39 (19 losses), hit@3 27/39 → 5/39 (22 losses) — a
  shipped-default regression the reranker flip had never measured. With
  `search.relational_rerank_pin=3` (the new bundle default; measured with
  `--autocut on`, the shape that shipped before rule R2 turned autocut
  off): PASS — 0 hit@1 / 0 hit@3 losses,
  21/39 and 27/39, core unchanged. Balanced reranker stays ON.
- **Cat 13 conceptual recall (sibling repo, Voyage space, 20 tuning / 10
  held-out concepts, seed 42):** E0 reproduced the gap — held-out nDCG@5 bare
  vector 60.5 vs gbrain 53.0 (off/off) and 55.8 (shipped default). E2
  (`search.keyword_arm_confidence_floor`, calibrated 0.6121 on the tuning
  split): held-out 53.0 → 53.0, rule FAILED, knob ships off; the calibration
  showed 83% of the losing probes had an EMPTY keyword arm. E1 localized the
  loss to the post-fusion metadata boosts promoting hub pages when the vector
  arm was the only voter. E3 (`search.metadata_boost_gate=lexical`, rule
  ≥ 57.0 written before the run): held-out 57.8 (off/off) and 57.9 (shipped
  default), tuning 57.3 = projection; NamedThingBench 50/50, BrainBench,
  the retrieval canary and the LongMemEval dev slice (40/40) byte-identical →
  PASS, flipped to `lexical` in every bundle. Stretch (vector 60.5) not met.
- **Expansion variant budget (A3 frozen variants via `--expansion-replay`):**
  A3 (legacy weighting, reranker off) reproduced the regression: 255/470,
  paired +3 / −187 vs A1 (sibling receipt 258, +3 / −183). Dev-slice sweep on
  the 40: budget 2.0 → 24, 1.0 → 26, 0.5 → 30, 0.25 → 34 hits (A1 36) →
  pick 0.25 (largest budget within 1 of the best). A3′ (balanced, reranker
  off, 0.25): 394/470; on the 430 decision set 360 vs A1 403 (−43, paired
  +2 / −45; multi-session −20, temporal −17) → rule FAILED. A3′R (tokenmax,
  0.25, reranker on, autocut 0.35 as tokenmax shipped it): 381/470 vs A4
  379 (+3 on the 430) — passes its literal rule but both arms sit under the
  autocut cut that pins strict recall near 80%, so it is published as
  confounded and does not justify a flip. Bundles stay `null`; the knob ships
  for operators; CRAG-style conditional expansion is filed.
- **Final release-configuration arm (gate D11):** `balanced`, reranker on,
  autocut off (bundle), relational pin 3, metadata gate lexical, on the
  release SHA: **449/470 (95.53%)**, any-hit 469/470, mean 4.89 distinct
  sessions; byte-identical per question to A2 (the pin never fires on this
  corpus and the gate changes no top-5); vs the pre-wave default (A4) +68 / −0
  on the 430, every type gains or holds → recall gate PASS. NamedThingBench in
  the same shape (`r1-namedthing-release-receipt.json`): core hit@1 10→11,
  relational 21/27 both arms, 0 losses; BrainBench PASS (same-hash); retrieval
  canary PASS → **gate D11 PASS**, no flip reverted.
- **Judged answer accuracy (Phase D, release configuration):** 433/500 =
  **86.6%** (CI 83.6–89.6), 500/500 judged, 0 judge errors; abstention 29/30;
  per type SSA 100 / SSU 98.6 / KU 89.7 / MS 83.5 / TR 80.5 / SSP 66.7. Reader
  `anthropic:claude-sonnet-4-6` (full sessions, mean 63.6K chars), judge
  `openai:gpt-4o` (2024-08-06), official prompts, temperature 0, max_tokens 16.
  Evidence-complete 449/470; reader converts 396 of them. Prediction ≥ 92%
  MISSED; no SOTA claim (pre-registered); matched-reader row not run (budget).
- **`tokenmax` as released (legacy expansion weight, reranker on, autocut
  off; frozen A3 variants):** 436/470 (92.77%), +2 / −15 vs the balanced
  release path (multi-session −7, temporal −5); +186 / −5 vs A3. The
  CHANGELOG "If you run tokenmax" warning quotes this row.
- **Autocut floor replay (A4 `--capture-pool` capture; floors off / 0.10 /
  0.20 / 0.35 / 0.50 / 0.65 / 0.80; `--validate-live 0.35` reproduced all
  500 live decisions):** A4 (shipped default: reranker on, autocut 0.35)
  379/470 vs A2 (autocut off) 449/470, paired +0 / −68 on the 430 decision
  set (multi-session −22, temporal −27, knowledge-update −19). Replay over
  the 500 captured rows: off 475 → 0.35 399 → 0.50 413 → 0.65 444 → 0.80
  466 (−9, all knowledge-update); same shape on both seeded halves; any-hit
  ≥ 99.4% at every floor; mean returned tokens 3256 (off) → 1633 (0.35).
  Rule R2 FAILED at every floor → **autocut OFF in balanced and tokenmax**
  (`DEFAULT_AUTOCUT` unchanged for operators who re-enable it).
- **Judged QA accuracy (`--judge`, `openai:gpt-4o` judge with the official
  prompts at temperature 0; reader = the shipped default pipeline;
  `--no-trajectory`):** pending (receipts running). Published only once
  `judge_errors` and `skipped_budget` are both 0 (`qa_accuracy.complete`);
  no SOTA claim — competitor numbers are protocol-unmatched.

How to refresh each row (the plan's verification block; `$DS` is the cleaned
S split, `$G` the spend guard):

```bash
export OPENAI_API_KEY=… GBRAIN_EMBEDDING_MODEL=openai:text-embedding-3-large GBRAIN_EMBEDDING_DIMENSIONS=1536
DS=~/datasets/longmemeval/longmemeval_s_cleaned.json
G="bash scripts/eval-spend-guard.sh 75"
COMMON="--retrieval-only --top-k 5 --by-type --no-trajectory --embed-cache ~/.cache/gbrain-eval/lme.sqlite --record"

# Dev-slice parity (40) and the A1 parity gate (470): diff recall_all_hit per question_id against the sibling ndjson.
$G 1 -- bun run src/cli.ts eval longmemeval $DS $COMMON --mode balanced --reranker off --autocut off \
  --question-ids evals/longmemeval/dev-slice-seed42.txt --output ~/gbrain-lme-receipts/dev-A1.ndjson
$G 3 -- bun run src/cli.ts eval longmemeval $DS $COMMON --mode balanced --reranker off --autocut off --output ~/gbrain-lme-receipts/A1.ndjson

# R1 (needs VOYAGE_API_KEY + the embedder key). --relational-pin N|off overlays search.relational_rerank_pin
# on BOTH arms: the no-pin cell is --relational-pin off (or 0); omitting the flag is the default cell, which
# resolves the bundle default (3) exactly as production does.
bun run scripts/r1-namedthing-rerank-ab.ts --relational --autocut on \
  --embed-cache ~/.cache/gbrain-eval/lme.sqlite --out ~/gbrain-lme-receipts/r1-namedthing-receipt.json

# Expansion budget sweep on the A3 frozen variants (A3 = --expansion --reranker off --autocut off, records expansion_variants).
for B in 2.0 1.0 0.5 0.25; do $G 1 -- bun run src/cli.ts eval longmemeval $DS $COMMON --mode balanced --reranker off --autocut off \
  --expansion --expansion-replay ~/gbrain-lme-receipts/A3.ndjson --expansion-variant-budget $B \
  --question-ids evals/longmemeval/dev-slice-seed42.txt --output ~/gbrain-lme-receipts/dev-b$B.ndjson; done

# Autocut replay from the A4 capture (A4 = --reranker on --autocut on --capture-pool: the balanced shape that shipped before rule R2 turned autocut off).
bun run scripts/replay-autocut-floor.ts ~/gbrain-lme-receipts/A4.ndjson \
  --floors off,0.10,0.20,0.35,0.50,0.65,0.80 --validate-live 0.35 --split-half seed42

# Cat 13 E0: re-pin gbrain-evals to the PR head (cd gbrain && bun link && cd ../gbrain-evals && bun link gbrain),
# then run its Cat 13 runner with search.reranker.enabled / search.autocut pinned per arm.

# Judged QA: 25-question dry run, then the full run; re-judge with --judge --resume-from until judge_errors and skipped_budget are 0.
$G 3 -- bun run src/cli.ts eval longmemeval $DS --top-k 5 --by-type --no-trajectory --mode balanced --reranker on \
  --embed-cache ~/.cache/gbrain-eval/lme.sqlite --judge --judge-model openai:gpt-4o --max-usd 5 --yes --limit 25 \
  --output ~/gbrain-lme-receipts/D-dry.ndjson
```

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
