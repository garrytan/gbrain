# Running real-world eval benchmarks against your gbrain changes

Audience: gbrain maintainers and contributors. If you're touching retrieval
(search, ranking, embeddings, intent classification, query expansion, source
boost, hybrid fusion), this is the doc.

For the **NDJSON wire format** consumed by gbrain-evals, see
[`eval-capture.md`](./eval-capture.md). This doc is the human dev loop
that lives on top of that format.

If you're touching **memory behavior** rather than retrieval ranking — the
Retrieval Reflex push path, conversation→facts write-back, cross-session
continuity, source isolation — the gate for that layer is **BrainBench**
(`gbrain eval brainbench`): see [`eval/BRAINBENCH.md`](./eval/BRAINBENCH.md).
The two stack: this doc's capture→baseline→replay loop gates query-level
result sets; BrainBench gates the memory behaviors above them, with its own
committed baseline (`evals/brainbench/baselines/main.json`) compared against
MAIN's copy in CI so a PR can't self-approve a regression.

## Recorded experiments, including negative results

Before repeating an approach, read its measured outcome and limitations:

- [Answer-evidence packets: did not help](eval/ANSWER_PACKET_RESULTS.md).
  Query-selected conversational excerpts over fixed retrieved sessions produced
  zero answer improvements and five judged regressions on a 60-question holdout
  (48/60 correct versus 53/60 for full sessions). A wider-context variant only
  tied in development, mostly with unchanged prompts. The notes cover both
  attempts, every regression, grading caveats, the $8.01 total usage-priced cost,
  and why full sessions remain the default. This tested presentation, not
  retrieval quality. The [experiment guide](eval/ANSWER_PACKET.md) records the
  reproducible setup and spending safeguards.

- [What actually helps an AI use its memory?](research/answer-evidence/compendium.md)
  explains the relevant research in plain English, separates published findings
  from GBrain's measured failures, and ranks narrowly testable next experiments.
  Its [source index](research/answer-evidence/index.md) records primary citations,
  per-paper summaries and limits on what the results establish.

- [Intact-evidence reading replication](eval/READING_NOTES_REPLICATION.md)
  records a frozen follow-up: 361 fresh GBrain comparisons and the full
  500-question, four-condition published reading comparison. The completed
  [GBrain results](eval/READING_NOTES_RESULTS.md) improved from 308/361 to
  324/361 under automated judging, with source-verified wins, grading caveats
  and nine truncated notes responses. The completed paper replication improved
  from 424/500 to 463/500; notes helped in both formats, while JSON alone did
  not demonstrate a benefit.

## The eval gate loop

`gbrain bench publish` + `gbrain eval gate` stitch captured eval rows into
a pass/fail gate. Two gates:

- **Regression gate** (`--baseline X.baseline.ndjson`): replays a baseline
  you captured against your current brain. Catches: "did my refactor break
  search?" Compares jaccard / top-1 stability / latency multiplier.
- **Correctness gate** (`--qrels Y.qrels.json`): runs known-right queries
  against your current brain via bare `hybridSearch`. Catches: "is my
  retrieval actually any good?" Computes recall@K, first-relevant-hit-rate,
  expected_top1-hit-rate.

Both can be passed together; both must pass for verdict `pass`. At least
one is required.

### The full LOOP for your own brain

```bash
# 1. Capture (one-time; uses queries already in eval_candidates)
gbrain eval export --limit 200 --tool query > /tmp/captured.ndjson

# 2. Publish a baseline
mkdir -p ~/.gbrain/baselines
gbrain bench publish --from /tmp/captured.ndjson --to ~/.gbrain/baselines/personal.baseline.ndjson --label "personal-$(date +%Y%m%d)"

# 3. Gate against it
gbrain eval gate --baseline ~/.gbrain/baselines/personal.baseline.ndjson
```

### Privacy posture

**Public baselines in `gbrain-evals` are hermetic-synthetic ONLY.** Real
user captures stay local in `~/.gbrain/baselines/`. The boundary is
enforced at the file source, not by post-hoc scrubbing. If you publish a
baseline to `gbrain-evals`, generate it from a fixture-seeded test brain
(placeholder names like `alice-example`, `widget-co-example`) — never
from a real user's `eval_candidates` table.

### Deterministic-pipeline disclosure

`gbrain eval gate --qrels` uses bare `hybridSearch` (not the production
`query` op handler). This is deliberate: gates need to be deterministic in
CI. Production retrieval differs via the query cache, salience freshness,
expansion, etc. The gate measures retrieval quality with a fixed pipeline;
your users may see different results when the cache is warm.

For a fully hermetic run (CI canaries, keyless environments), add
`--embedder deterministic` to the correctness gate: query embeddings come
from the qrels fixture's basis-vector dims (`src/eval/deterministic-embed.ts`)
instead of the gateway, so the gate runs with no API keys and no network.
Correctness-gate-only — it is rejected together with `--baseline` (replay
re-embeds captured queries via the gateway) and requires `--qrels`. Bare
`hybridSearch` never reads or writes the semantic query cache, so a
deterministic run cannot poison cached production results. This is what the
hermetic retrieval canary (`scripts/run-eval-canary.ts`) runs: a throwaway
PGLite brain seeded from the qrels fixture, gating the hybrid ranking
pipeline (keyword/title/alias arms + RRF) with synthetic vectors. In CI the
canary runs via `test/eval-canary.test.ts` in the unit matrix; `bun run
check:eval-canary` is the on-demand package script (it is deliberately not
in the `verify` battery — the unit-matrix twin already gates it). Honest
scope: semantic-embedding regressions remain the keyed eval suites' job.
Reproduce locally with `bun run scripts/run-eval-canary.ts` (`--record`
appends to the `.gbrain-evals/eval-results.jsonl` ledger, a local file that is
gitignored; `gbrain eval compare` reads it).

### `.qrels.json` shape

Two equivalent representations per entry:

```json
{
  "schema_version": 1,
  "queries": [
    {
      "query_id": "q1",
      "query": "fintech founder",
      "relevant_slugs": ["people/alice-example"],
      "first_relevant_slug": "people/alice-example"
    }
  ]
}
```

For federated / multi-source brains, use the explicit shape (no defaults
to `source_id='default'`):

```json
{
  "query_id": "q2",
  "query": "anything",
  "relevant": [
    {"source_id": "host", "slug": "people/alice"},
    {"source_id": "team-a", "slug": "people/alice"}
  ],
  "expected_top1": {"source_id": "host", "slug": "people/alice"}
}
```

Without `source_id`, a hit from the wrong source could false-pass the
gate. The compare everywhere is `${source_id}::${slug}` strings.

### Example GitHub Actions workflow

```yaml
name: gbrain-eval-gate
on: [pull_request]
jobs:
  gate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: bun install
      - run: |
          # Run both gates; CI fails on any breach.
          gbrain eval gate \
            --baseline gbrain-evals/baselines/v0.41-launch.baseline.ndjson \
            --qrels gbrain-evals/qrels/v0.41-launch.qrels.json \
            --json | tee /tmp/gate.json
```

---

## Prerequisite: turn on contributor mode

Capture is **off by default** for production users (privacy-positive — no
surprise data accumulation). Contributors flip it on with one line:

```bash
# In ~/.zshrc or ~/.bashrc:
export GBRAIN_CONTRIBUTOR_MODE=1
```

Verify:

```bash
gbrain query "anything" >/dev/null
psql $DATABASE_URL -c 'SELECT count(*) FROM eval_candidates'   # should be > 0
```

The full on/off resolution order (config beats env var, both directions) is
documented once in [`eval-capture.md`](./eval-capture.md) — that file is the
capture contract.

## The 4-command loop

```bash
# ① Capture: writes to eval_candidates whenever CONTRIBUTOR_MODE is set.
#   Inspect what's been collected:
gbrain doctor                                     # surfaces capture failures
psql $DATABASE_URL -c 'SELECT count(*) FROM eval_candidates'

# ② Snapshot: freeze a baseline before your code change.
gbrain eval export --since 7d > baseline.ndjson

# ③ Code change: do whatever you want — tune RRF_K, swap embed model, edit
#    hybrid.ts, add a new boost source, change the intent classifier.

# ④ Replay: re-run every captured query against the current build.
gbrain eval replay --against baseline.ndjson
```

Output:

```
Replaying 247 captured queries…
  ...25/247
  ...50/247
  ...
Replayed 247 of 247 captured queries (0 skipped, 0 errored)
Mean Jaccard@k:    0.927
Top-1 stability:   91.5%
Mean latency Δ:    +14ms (current vs captured)

Top 5 regression(s):
  jaccard=0.20  captured=12  current=3   "find every reference to widget-co"
  jaccard=0.43  captured=14  current=8   "show me everything tagged for review"
  jaccard=0.50  captured=8   current=4   "what did alice say about the spec"
  ...
```

Three numbers tell you whether the change is safe to land:

| Metric | What it means | Healthy range |
|---|---|---|
| **Mean Jaccard@k** | Average overlap between captured retrieved slugs and current run's slugs. 1.0 = identical sets. | ≥0.85 for "neutral" changes. <0.7 means major retrieval shift. |
| **Top-1 stability** | Fraction of queries whose #1 result didn't change. | ≥85% for tuning passes. <70% means top-of-funnel broke. |
| **Mean latency Δ** | Current minus captured. Positive = slower now. | Within ±50ms of captured. >2× anywhere = regression alarm. |

## What it actually does

`gbrain eval replay` reads your NDJSON snapshot and, for each row:

1. Re-executes the same op (`searchKeyword` for `tool_name='search'`,
   `hybridSearch` for `tool_name='query'`) with the captured `detail` and
   `expand_enabled` values threaded back in.
2. Captures the current `retrieved_slugs` (deduped, in result order).
3. Computes set-Jaccard between captured and current slug sets.
4. Records top-1 match (was the #1 result the same slug?).
5. Records latency delta vs captured `latency_ms`.

It does NOT compute MRR or nDCG — those need ground-truth relevance labels,
not a baseline comparison. For metric-against-truth eval, use
`gbrain eval gate --qrels <path>` (the correctness gate above). The
replay tool answers a different question: "did my code change move
retrieval, and which queries did it move most?"

For a third evaluation axis — public benchmark, ground-truth labels, full
question-answer pipeline (not just retrieval) — `gbrain eval longmemeval
<dataset.jsonl>` runs the LongMemEval benchmark against gbrain's
hybrid retrieval. Each question gets a clean in-memory PGLite, its haystack
imported, the question asked, the hypothesis emitted as JSONL — exactly the
shape LongMemEval's `evaluate_qa.py` consumes. Your `~/.gbrain` brain is
never opened. See `## Public benchmarks: LongMemEval` below.

## Best-effort by design

Replay is not pure. Three things can drift between capture and replay:

1. **Brain state** — your brain probably has more pages now than when the
   snapshot was taken. Unless you explicitly seed a fixed corpus, mean
   Jaccard will drop simply because new pages are eligible.
2. **Embedding source** — if you changed `OPENAI_API_KEY` between capture
   and replay (or the embedding model rotated), vector-path results drift
   even with identical code.
3. **Capture cap** — captured `retrieved_slugs` is a deduped set; it doesn't
   preserve internal ranking metadata. Two tools can return the same slug
   set with different scores — Jaccard will say 1.0, but a downstream
   consumer that orders by score may behave differently.

The metrics are **regression alarms on real queries**, not a hash check.
Pair them with manual inspection of the top regressions.

## Cost

Every `query` row in the snapshot embeds the query string via OpenAI to run
the vector half of `hybridSearch`. Cost is identical to a normal `gbrain
query` invocation — text-embedding-3-large at OpenAI list price, batched
inside a single replay row.

If you're iterating locally and don't want to pay per change, use
`--limit 50` to cap rows replayed. The 50 most recent rows are usually
enough to catch direction; expand for the final pre-merge run.

```bash
# Iteration mode — 50 most recent queries
gbrain eval replay --against baseline.ndjson --limit 50

# Pre-merge — full snapshot
gbrain eval replay --against baseline.ndjson --top-regressions 20
```

## CI integration

```bash
gbrain eval replay --against baseline.ndjson --json > replay.json
jq -e '.summary.mean_jaccard >= 0.85' replay.json || exit 1
jq -e '.summary.top1_stability_rate >= 0.85' replay.json || exit 1
```

Stable JSON shape (schema_version: 1):

```json
{
  "schema_version": 1,
  "summary": {
    "rows_total": 247,
    "rows_replayed": 247,
    "rows_skipped": 0,
    "rows_errored": 0,
    "mean_jaccard": 0.927,
    "top1_stability_rate": 0.915,
    "mean_latency_delta_ms": 14,
    "rows_over_2x_latency": 0
  }
}
```

`--verbose` adds a `results: [...]` array with one entry per replayed row
(useful for piping into jq or a notebook for deeper analysis).

## When to run this

Before merging anything that touches:

- `src/core/search/hybrid.ts` (RRF, fusion, dedup, two-pass retrieval)
- `src/core/search/source-boost.ts` / `sql-ranking.ts` (per-source ranking)
- `src/core/search/query-intent.ts` (auto-detail classification)
- `src/core/search/expansion.ts` (Haiku query expansion)
- `src/core/search/dedup.ts` (cross-page result collapse)
- `src/core/embedding.ts` or any embedding model swap
- `src/core/ops/search.ts` `query` or `search` op handlers (capture surface)
- `src/core/postgres-engine.ts` / `pglite-engine.ts` `searchKeyword` /
  `searchVector` SQL

Skip for: schema-only migrations, doc changes, tests-only PRs, CLI ergonomics
that don't touch retrieval.

## Building your own corpus

If you don't have captured traffic yet (fresh install, can't dogfood for a
week before merging), you can hand-author an NDJSON file:

```jsonl
{"schema_version":1,"id":1,"tool_name":"query","query":"who is alice","retrieved_slugs":["people/alice","people/alice-bio"],"expand_enabled":false,"detail":null,"latency_ms":0,"remote":false}
{"schema_version":1,"id":2,"tool_name":"search","query":"acme deal","retrieved_slugs":["deals/acme-seed","companies/acme"],"latency_ms":0,"remote":false}
```

Then run `gbrain eval replay --against handcrafted.ndjson` to confirm the
authoritative slugs come back. This is the seam between the BrainBench-Real
pipeline (replay against live captures) and the BrainBench fixed-fixture
pipeline (`gbrain eval gate --qrels` with the sibling
[gbrain-evals](https://github.com/garrytan/gbrain-evals) corpus).

## Off-switch

Two ways to disable capture:

```bash
unset GBRAIN_CONTRIBUTOR_MODE             # easy: just unset the env var
```

Or force off regardless of the env var via `~/.gbrain/config.json`:

```json
{"eval": {"capture": false}}
```

Existing `eval_candidates` rows stay until you `gbrain eval prune
--older-than 0d` (or just drop the table).

## Failure modes

| What you see | What it means |
|---|---|
| `Mean Jaccard@k: 0.4`, top regressions all in one source dir | Source boost or hard-exclude regression on that prefix |
| `Top-1 stability: 30%`, mean Jaccard still high | RRF tuning shifted the rank order without changing the set — re-tune `rrfK` |
| `Mean latency Δ: +500ms`, jaccard high | Vector path got slower; check embedding API or HNSW probes |
| `rows_errored > 0` | One or more queries threw. Inspect first 3 in human output, or `--json` to see all `error_message` fields |
| Many `skipped: empty query` | Capture ran on rows where someone passed empty `query` — check why those were captured |

## Public benchmarks: LongMemEval

`gbrain eval longmemeval` runs the public [LongMemEval](https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned)
benchmark directly against gbrain's hybrid retrieval. Different evaluation
axis from `eval replay`: public dataset with ground-truth labels, end-to-end
question-answer pipeline, hermetic per-question brains.

The in-repo command is the reproduction path for the numbers below: it scores
the official strict metric (`recall_all@k` — every gold session among the top-k
distinct retrieved sessions), joins on the dataset's raw session ids, drops the
30 abstention questions from the denominator as the official scorer does, and
pins the reranker and autocut per run (see "Download and run" and "Flags").

**Say to your agent:** *"Run the public LongMemEval benchmark like-for-like
against my gbrain retrieval"* (no skill backs this; your agent runs
`gbrain eval longmemeval <dataset> --retrieval-only --top-k 5 --by-type --no-trajectory --mode balanced --reranker off --autocut off`)
— *"Run LongMemEval at my brain's shipped default search path"* (your agent runs
the same command with `--reranker on --autocut off`, the release default; add
`--autocut on --capture-pool` to reproduce the autocut floor replay).

### Current measured result

**95.53% session-level `recall_all@5` (449/470) on the release default path**
(`balanced`: `voyage:rerank-2.5` on, autocut off, relational pin 3, metadata
gate lexical) and **93.40% (439/470) with the reranker off**, the like-for-like
row against systems that run no reranker. LongMemEval's official retrieval
metric: a question counts only when EVERY gold session appears among the top-5
distinct retrieved sessions; retrieval only, no reader model. Any-hit
`recall_any@5` is 99.79% / 98.72% and is a diagnostic, not the headline.

- **Dataset:** `longmemeval_s_cleaned.json`, the cleaned September 2025
  revision of the S split (`xiaowu0162/longmemeval-cleaned`, sha256
  `d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442`). 500
  questions; the 30 abstention (`_abs`) questions are excluded from the
  recall denominator, as the official `print_retrieval_metrics.py` does, so
  470 are scored. The ceiling at k=5 is 99.4%: 3 questions carry 6 gold
  sessions and cannot fit in a top-5 list.
- **Measured:** 2026-09-06 at gbrain v0.48.4.0 with `gbrain eval longmemeval`
  (this repo; the sibling runner's 2026-09-02 receipt is reproduced by the A1
  parity row: 439 vs 438 of 470, 469 of 470 rows agree per question, any-hit
  identical), k=5, embedder `openai:text-embedding-3-large` at 1536 dims
  through one content-addressed embedding cache (every arm after A1 ran with
  0 misses, so all arms fused byte-identical vectors), single run, 0 errors
  in every arm. Knob decisions were made on the 430 questions outside the
  committed seed-42 dev slice (`evals/longmemeval/dev-slice-seed42.txt`); the
  470 column is the comparable one.

"Paired" is per question against A1 (reranker off): questions this arm gets
right that A1 missed / questions it loses that A1 had.

| Arm | `recall_all@5` (470) | `recall_any@5` | Mean distinct sessions in top 5 | Paired vs A1 | On the 430 |
|---|---|---|---|---|---|
| A1 hybrid, reranker off, autocut off (like-for-like row) | **93.40%** (439/470) | 98.72% | 4.90 | +0 / −0 | 403/430 |
| A2 hybrid + reranker (`voyage:rerank-2.5`), autocut off | **95.53%** (449/470) | 99.79% | 4.89 | +18 / −8 | 412/430 |
| A3 hybrid + LLM multi-query expansion, legacy weighting (`--expansion`) | **54.26%** (255/470) | 84.89% | 5.00 | +3 / −187 | 231/430 |
| A4 the default that shipped before v0.48.4.0 (reranker on, autocut 0.35) | **80.64%** (379/470) | 99.36% | 2.36 | +16 / −76 | 344/430 |
| A3′ hybrid + expansion at `expansion_variant_budget` 0.25, reranker off | **83.83%** (394/470) | 97.45% | 5.00 | +3 / −48 | 360/430 |
| A3′R `tokenmax` + expansion at 0.25, reranker on, autocut 0.35 | **81.06%** (381/470) | 99.15% | 2.30 | +12 / −10 vs A4 | 347/430 |
| `tokenmax` as released (legacy expansion, reranker on, autocut off) | **92.77%** (436/470) | 99.57% | 4.19 | +2 / −15 vs A2 | 400/430 |
| **release default** (`balanced`: reranker on, autocut off, pin 3, gate lexical) | **95.53%** (449/470) | 99.79% | 4.89 | +18 / −8 | 412/430 |

`recall_all@5` by question type, same run:

| Question type | n | A1 | A2 / release default | A3 | A4 | A3′ | `tokenmax` as released |
|---|---|---|---|---|---|---|---|
| knowledge-update | 72 | 98.6% (71) | 100.0% (72) | 61.1% (44) | 73.6% (53) | 90.3% (65) | 100.0% (72) |
| multi-session | 121 | 92.6% (112) | 92.6% (112) | 38.0% (46) | 73.6% (89) | 75.2% (91) | 86.8% (105) |
| single-session-assistant | 56 | 100.0% (56) | 100.0% (56) | 82.1% (46) | 100.0% (56) | 100.0% (56) | 100.0% (56) |
| single-session-preference | 30 | 96.7% (29) | 100.0% (30) | 66.7% (20) | 100.0% (30) | 100.0% (30) | 96.7% (29) |
| single-session-user | 64 | 98.4% (63) | 100.0% (64) | 76.6% (49) | 100.0% (64) | 96.9% (62) | 100.0% (64) |
| temporal-reasoning | 127 | 85.0% (108) | 90.6% (115) | 39.4% (50) | 68.5% (87) | 70.9% (90) | 86.6% (110) |
| **all scored** | **470** | **93.40% (439)** | **95.53% (449)** | **54.26% (255)** | **80.64% (379)** | **83.83% (394)** | **92.77% (436)** |

What the arms say:

- **The release default IS the reranker row.** 449/470 is byte-identical per
  question to A2: on this corpus the relational pin never fires (no relational
  intent) and the metadata gate changes no top-5 (chat sessions carry no
  backlinks or graph edges). The reranker is worth +2.13 points over A1
  (+18 / −8 paired), every gain outside multi-session (112/121 both ways),
  the largest in temporal-reasoning (108 → 115 of 127). Any-hit rises to
  99.79%: the reranker promotes sessions already in the pool.
- **Autocut, not the reranker, was the regression in the old default.** A4
  vs A2 is +0 / −68 on the 430, the losses entirely in the three types whose
  questions need more than one session (multi-session −22, temporal −27,
  knowledge-update −19); any-hit is unchanged. Replaying every floor from A4's
  captured post-rerank pool found no floor within two questions of "off" on
  either seeded half, so autocut is off in `balanced` and `tokenmax`
  (`docs/architecture/RETRIEVAL.md`, "Autocut"). The mean returned window
  shrank from 3256 to 1633 estimated tokens under the cut — that saving was
  paid for with the second gold session.
- **LLM multi-query expansion is still harmful at k=5, and the budget knob is
  real but not enough.** Legacy weighting (one full RRF vote per variant):
  255/470, +3 / −187. `search.expansion_variant_budget` shares one total
  weight across the variants; replaying the SAME recorded variants, the
  dev-slice sweep climbs monotonically as the budget shrinks (24 → 26 → 30 →
  34 of 40 at 2.0 → 1.0 → 0.5 → 0.25; plain hybrid 36) and A3′ at 0.25
  recovers 139 questions over A3 — yet still trails A1 by 43 on the 430, so
  every bundle keeps `null` and the knob is an operator lever. A3′R (tokenmax
  under the old autocut) equals A4 only because the cut pins both near 80%.
  Conditional expansion (expand only when the original query's evidence is
  weak) is the filed next mechanism.
- **`tokenmax` as released scores 436/470 (92.77%).** With the reranker on
  and autocut off, expansion costs thirteen questions against `balanced`
  (+2 / −15: multi-session −7, temporal −5) plus the Haiku call per query.
  `gbrain config set search.mode balanced` keeps the reranker and drops
  expansion (`gbrain query` still expands in every mode unless `--no-expand`);
  `gbrain config set search.expansion_variant_budget 0.25`
  recovers most of the loss if you keep it on.
- **Slot starvation is not the miss class** (from the 2026-09-02 sibling run;
  no in-repo arm yet): session-diverse over-fetch fills every top-5 to 5.00
  distinct sessions and adds exactly one question (+1 / −0, with or without
  the reranker). The remaining misses are ranking misses among sessions that
  are all in the pool — the diagnosis that decided Phase B of the ranker
  wave (`docs/eval/FIX_WAVE_BASELINES.md`).

How to read other systems' numbers. On the strict metric on this dataset we
found no published score above 93.19%. The closest strict comparisons are
our own recomputations from MemPalace's committed rankings (85.7% raw,
90.0% with an LLM reranker; MemPalace publishes only any-hit, 96.6% and
98.4%) and ContextFit's self-reported 87.45% All@5 (its rerank layer reads
gold labels, so loosely comparable). The 90-96% figures from Mem0, Mastra,
MemCog, Zep, Hindsight, ByteRover and Supermemory are LLM-judged answer
accuracy, a different quantity that moves with the reader and judge model.
gbrain's own judged answer-accuracy lane (`--judge`, "Judged answer accuracy"
below) uses the official prompts and judge model with full protocol
disclosure; its first number is 86.6% (433/500, v0.48.4.0, default Sonnet
reader, gpt-4o judge — see "Judged answer accuracy" below), and it carries no
SOTA claim because those competitor numbers are protocol-unmatched. Full report,
comparison table, and receipts:
[gbrain-evals `docs/benchmarks/2026-05-07-longmemeval-s.md`](https://github.com/garrytan/gbrain-evals/blob/main/docs/benchmarks/2026-05-07-longmemeval-s.md).

### Download and run

```bash
# Download the cleaned (September 2025) revision of the S split. The HF
# dataset may ask you to accept its terms in a browser first.
mkdir -p ~/datasets/longmemeval
curl -Lo ~/datasets/longmemeval/longmemeval_s_cleaned.json \
  https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_s_cleaned.json

# The embedder is not a per-run flag: it resolves from the `embedding_model`
# config key (`<provider>:<model>`; new-install default `voyage:voyage-4`,
# existing brains keep their configured model) or the
# GBRAIN_EMBEDDING_MODEL / GBRAIN_EMBEDDING_DIMENSIONS env overrides. The
# measured result above used openai:text-embedding-3-large at 1536 dims.
export GBRAIN_EMBEDDING_MODEL=openai:text-embedding-3-large
export GBRAIN_EMBEDDING_DIMENSIONS=1536

# Like-for-like reproduction of the 93.40% A1 row (the sibling runner's 93.19% receipt
# reproduces here too): retrieval-only at the published
# cutoff, reranker and autocut pinned off, --no-trajectory (skips the per-session
# Haiku claim-extractor call, so no chat key is needed). --by-type appends the
# schema-v2 summary: strict recall_all@5 per type + aggregate, any-hit as the
# diagnostic, the 30 _abs questions excluded from the denominator, and run_config
# (pins, embedder, dataset sha256, knobs hash, embed-cache receipt).
gbrain eval longmemeval ~/datasets/longmemeval/longmemeval_s_cleaned.json \
  --retrieval-only --top-k 5 --by-type --no-trajectory \
  --mode balanced --reranker off --autocut off \
  --output ~/lme-receipts/hybrid.ndjson

# The shipped default path (what balanced/tokenmax run: reranker on, autocut off since v0.48.4.0).
# The reranker gate keys on the RESOLVED pin (flag, --search-pin, snapshot or
# bundle): a run that resolves to reranker on preflights readiness (exit 2 with
# the fix if it cannot run) and fails the run (exit 1) if any row fell through
# un-reranked — so a balanced run with no VOYAGE_API_KEY refuses to start (exit 2,
# naming the fix) rather than scoring un-reranked rows, and a resume of a file that
# already holds un-reranked rows exits 1; pass --reranker off for a reranker-free run. A run
# where every question errored also exits 1. Note the 95.53% row above was
# reranker on with autocut OFF (`--reranker on --autocut off`).
gbrain eval longmemeval ~/datasets/longmemeval/longmemeval_s_cleaned.json \
  --retrieval-only --top-k 5 --by-type --no-trajectory \
  --mode balanced --reranker on --autocut off \
  --output ~/lme-receipts/default.ndjson

# Embeddings are cached content-addressed at ~/.cache/gbrain-eval/longmemeval-embed.sqlite
# (--embed-cache FILE to relocate, --no-embed-cache to disable), so every arm after
# the first sees byte-identical vectors; run_config.cache.misses must be 0 for a
# like-for-like arm. --record appends the run to .gbrain-evals/eval-results.jsonl;
# --question-ids evals/longmemeval/dev-slice-seed42.txt runs the committed
# 40-question dev slice.

# Judged answer accuracy (see "Judged answer accuracy" below): the reader answers
# each question from the retrieved sessions (a chat key for the reader model) and
# the in-repo judge grades every answer with LongMemEval's official evaluate_qa.py
# prompts (OPENAI_API_KEY for the gpt-4o judge). --max-usd caps JUDGE spend only.
gbrain eval longmemeval ~/datasets/longmemeval/longmemeval_s_cleaned.json \
  --top-k 5 --no-trajectory --mode balanced --reranker on \
  --judge --judge-model openai:gpt-4o --max-usd 5 --yes \
  --output ~/lme-receipts/judged.ndjson

# Re-judge until judge_errors and skipped_budget are both 0: a judge-only backfill
# (no reader calls) under the same retrieval pins; FILE is rewritten in place.
gbrain eval longmemeval ~/datasets/longmemeval/longmemeval_s_cleaned.json \
  --top-k 5 --no-trajectory --mode balanced --reranker on \
  --judge --resume-from ~/lme-receipts/judged.ndjson --output ~/lme-receipts/judged.ndjson

# The hypotheses in that file also score under LongMemEval's own evaluate_qa.py
# (not bundled): python evaluate_qa.py ~/lme-receipts/judged.ndjson
```

### Judged answer accuracy (`--judge`)

**Protocol (v0.48.4.0).** Retrieval = the release default (`balanced`,
reranker on, autocut off, k=5). Reader context = the FULL text of every
distinct session among the top-5 retrieved chunk rows, wrapped in
`<chat_session>` blocks (the sanitizer's 4000-char cap is an extractor-era
default and does not apply to the reader; each row records
`reader_context_chars`, `reader_context_sessions`, `reader_sessions_truncated`).
The original reader used `max_tokens` 512 with an abstention instruction
(disclosed deviation from the official reading prompt). New runs default to
brief evidence notes before a concise answer, with `max_tokens` 1024.
`--reader-mode direct` retains the original system text and 512-token budget;
`--reader-mode notes --reader-max-tokens 512` reproduces the measured treatment's
original output cap. The notes mode changes only the final system instruction:
the sanitizer, sessions, dates, evidence order and abstention boundary are
unchanged. A `max_tokens` finish is recorded as `reader_max_tokens`, with no
completed hypothesis or judge verdict; its question still counts as an error in
the judged headline denominator, and the run exits nonzero. A larger cap avoids
known cutoffs but does not establish a new measured accuracy figure. A bounded
[completion smoke](eval/reading-notes-completion-smoke.json) replayed the nine
original cutoff inputs through the packaged reader request and gateway at 1024:
all nine finished naturally with nonempty outputs (445–603 tokens), at $0.562143
for nine calls and no retries. This selected-case completion check was not a
fresh accuracy comparison; the original 512-token labels remain unchanged.
Judge `openai:gpt-4o`, official
`evaluate_qa.py` prompt per question type, temperature 0, `max_tokens` 16 —
the OpenAI API's minimum; the official 10 is rejected, and a one-token yes/no
verdict is unaffected. Gold and hypothesis sit inside a data-boundary wrapper
(disclosed deviation). Every row carries the provider-reported reader and
judge snapshot ids and the reader prompt sha.

**Result (2026-09-06, v0.48.4.0, 500/500 judged, 0 judge errors, `complete: true`):**

| Slice | Correct | Accuracy |
|---|---|---|
| **All 500 (headline)** | **433/500** | **86.6%** (95% CI 83.6–89.6, question-sampling only) |
| Non-abstention 470 | 404/470 | 86.0% |
| Abstention 30 | 29/30 | 96.7% |
| single-session-assistant | 56/56 | 100.0% |
| single-session-user | 69/70 | 98.6% |
| knowledge-update | 70/78 | 89.7% |
| multi-session | 111/133 | 83.5% |
| temporal-reasoning | 107/133 | 80.5% |
| single-session-preference | 20/30 | 66.7% |

Evidence versus verdict on the 470 non-abstention questions: every gold
session retrieved AND correct 396; every gold session retrieved but judged
wrong 53; incomplete evidence but correct 8; incomplete and wrong 13. Retrieval
on the same rows is the release number (449/470 strict), so the reader
converts 88.2% of evidence-complete questions — the remaining loss is the
answering layer (preference and temporal questions most of all). Reader
snapshot `claude-sonnet-4-6`, judge snapshot `gpt-4o-2024-08-06`, mean reader
context 63.6K characters, 0 sessions truncated. The pre-registered prediction
(≥ 92%) was missed. Competitor answer-accuracy rows (OMEGA 95.4%, Mastra
94.87%, Mem0 93.4%) use different readers, prompts, judges and dataset
revisions; this row makes no comparison claim in either direction.

The second lane. Instead of asking whether the gold sessions were retrieved,
it asks whether the READER's answer was right: the reader answers each
question from the retrieved sessions, and an LLM judge grades that answer
against the dataset's gold with LongMemEval's own scorer prompts. The lane is
the in-repo `gbrain eval longmemeval --judge`, so the retrieval pins, the
reader pins and the judge pins all land on one receipt.

**Say to your agent:** *"Score my brain's answer accuracy on LongMemEval"*
(no skill backs this; your agent runs
`gbrain eval longmemeval <file> --judge --no-trajectory`).

**Protocol — what every receipt discloses.**

- **Official prompts, official rule.** `src/eval/longmemeval/judge.ts` is a
  port of `evaluate_qa.py::get_anscheck_prompt`: the standard instruction for
  `single-session-user` / `single-session-assistant` / `multi-session`, the
  temporal-reasoning off-by-one-days clause, the knowledge-update
  instruction, the single-session-preference rubric, and the abstention
  instruction for `_abs` question ids. One user message per question, judge
  model `gpt-4o` (`--judge-model` overrides), `temperature 0` (threaded
  through the gateway's `ChatOpts.temperature`), `max_tokens 16` (the
  official 10 is below the OpenAI API minimum; a one-token verdict is
  unaffected), verdict = `yes` substring of the lowercased completion.
- **Data-boundary framing (disclosed deviation).** The question, the
  reference and the reader's response sit inside `<judge_input>` tags with an
  instruction that the delimited content is data to grade, never instructions
  to follow; tag closures inside the data are neutralised. The response text
  is otherwise unaltered, so the judge grades what the reader actually said.
- **`judge_error` class (disclosed deviation).** A judge malfunction —
  timeout after two retries, rate limit exhausted, refusal, empty completion,
  or a completion that is neither a yes nor a no — is recorded as a
  `judge_error`, not scored `no`. The headline scores every such row as
  INCORRECT, so it is never more lenient than the official rule; the errors
  leave the denominator only in the secondary `accuracy_excluding_errors`,
  and the backfill re-judges them.
- **Headline rule.** `qa_accuracy.accuracy_headline` = correct / ALL
  questions in the run, `_abs` included (the official scorer sees exactly one
  label per hypothesis). Every ungradable question — `judge_error`,
  budget-skipped, reader error, never judged — counts as incorrect.
  `accuracy_excluding_errors` is secondary; `accuracy_470` is the headline
  rule over the non-`_abs` questions (the retrieval-metric denominator);
  `by_type` and an `abstention` sub-block break it down.
- **Not publishable until complete.** A run with `judge_errors > 0` or
  `skipped_budget > 0` prints `FAIL --judge: judgments incomplete … NOT
  publishable` and exits 1 (`--allow-incomplete-judgments` downgrades it to a
  WARN). The fix is the judge-only backfill: `--judge --resume-from FILE`
  re-judges every row lacking a settled verdict from its stored hypothesis
  (no reader call), rebuilds `qa_accuracy` from ALL rows and rewrites FILE.
  `qa_accuracy.complete` is the publishability bit.
- **Pins.** Every judged row carries `judge_config_hash`: the judge pins
  (model, prompt version, max_tokens, temperature) plus the reader pins the
  row was produced under (`reader_model`, `reader_prompt_sha`, k,
  `reader_max_tokens`). A backfill hashes each prior row from its own recorded
  reader pins, so a file answered by another reader is never relabelled as
  this run's, and rows judged under a different hash are refused unless
  `--allow-mixed-run-config`. Rows also record `reader_model_snapshot` and
  `judge_model_snapshot` — the provider-reported model ids (a dated API
  snapshot) when they differ from the requested ids.
- **Reader prompt (disclosed deviation).** The official generation prompt
  carries no abstention instruction; ours tells the reader to say the
  information is not available when the retrieved sessions lack it
  (pre-registered — without it the 30 `_abs` questions are answered and
  judged wrong by construction). The retrieved sessions are wrapped in the
  same `<chat_session>` UNTRUSTED framing as the rest of the harness; max
  output tokens 1024 in the default notes mode (512 in the original direct
  mode; official 500). `reader_mode`, `reader_prompt_version`,
  `reader_prompt_sha`, `reader_max_tokens`, `reader_config_hash` and
  `reader_finish_reason` pin the configuration and completion. A historical
  direct receipt can resume only with explicit `--reader-mode direct`;
  `--allow-mixed-run-config` cannot mix reader modes or budgets.
- **Confidence intervals are question-sampling only.** `ci95_bootstrap` is a
  seeded percentile bootstrap over the headline 0/1 vector (10,000 resamples,
  seed 42), labelled `question-sampling only`: it says how much the number
  would move under a different draw of questions, and nothing about reader /
  judge nondeterminism, dataset revision or prompt drift.
- **No SOTA claim.** The 90-96% judged-accuracy figures other systems publish
  differ in context construction, reader prompt, judge, aggregation and
  dataset revision, so they are protocol-unmatched. gbrain's number is
  published as its first judged result with the disclosure line above and a
  "not directly comparable" label; the only path to a comparative claim is a
  protocol-matched replication of one competitor's setup.
- **Spend.** `--max-usd N` (default 5) caps JUDGE spend only. The preflight
  estimates the run (`READER_MAX_TOKENS` per live hypothesis, the stored
  hypothesis for backfill rows) and refuses an estimate over the cap without
  `--yes` (exit 2); at run time the lane soft-stops at the cap and stamps the
  remaining rows `judge_skipped: "budget"`. An unpriced judge model requires
  `--max-usd off`. Reader spend is not metered here — wrap a paid receipt in
  `scripts/eval-spend-guard.sh`.

Row fields with `--judge`: exactly one of `judge_correct` / `judge_error`
(+ `judge_error_detail`) / `judge_skipped`, plus `judge_model`,
`judge_model_snapshot`, `judge_raw` (first 200 chars), `judge_cost_usd`,
`judge_attempts`, `judge_prompt_kind`, `judge_prompt_version`,
`judge_config_hash`. The summary's `qa_accuracy` block adds
`total_questions`, `judged`, `correct`, `judge_errors`, `skipped_budget`,
`reader_errors`, `unjudged`, `judge_error_classes`, `est_cost_usd` /
`actual_cost_usd` / `run_cost_usd`, `mixed_judge_config`, and
`methodology_note` (the disclosure text, verbatim, on every receipt).
`qa_accuracy` is in the metric glossary (`docs/eval/METRIC_GLOSSARY.md`).

**Diagnosing misses.** When a strict-recall row is a miss, find out WHERE the
gold was lost before choosing a fix:
`bun run scripts/lme-miss-diagnostics.ts <receipt.ndjson> --dataset FILE
[--splits evals/longmemeval/splits-seed42.json]` re-creates each missed
question's brain exactly as the harness built it (same pins — defaulting to
the receipt's flat `run_config` on the summary line — every embed a cache hit) and locates every
missing gold session per arm (vector / keyword / title to depth 200, fused
and post-rerank order from one `hybridSearch` call at limit 50, the final
returned rows). It classifies the miss — (i) absent from every arm, (ii) in
an arm pool but outside the fused top-k, (iii) in the fused top-k but
reranked out, (iv) ceiling (more gold sessions than k), plus `rerun_hit` when
the miss does not reproduce and `autocut_dropped` / `post_fusion_dropped`
when a later trim removed a survivor — and probes the frozen hypotheses
(second-event starvation signature, counterfactual clause sub-queries,
candidate-generation vs reranker-depth). The clause sub-query embeds bypass
the shared embed cache, so a diagnostics run never changes the like-for-like
cache's canonical hash. `--out-md` renders a markdown report, `--out-ndjson`
the per-miss rows, `--all` diagnoses every scored question. It is not a
`gbrain` subcommand; exit 2 when the gateway or reranker is not ready.

### Architecture (read this if you're touching the harness)

- In-memory PGLite brains via `createBenchmarkBrain`. Your `~/.gbrain` is
  never opened. `TRUNCATE` never returns PGLite's WASM memory, which grows
  with each question's vectors, so a harness-owned brain is replaced with a
  fresh, re-configured one every `LME_BRAIN_RECYCLE_EVERY` (40) questions
  (`brainRecycler` in `src/eval/longmemeval/harness.ts`); without it a long
  single-process run stalls at 100% CPU around question 90-120.
- Between questions: `TRUNCATE` over runtime-enumerated `pg_tables`, NOT a
  hardcoded list — schema migrations don't silently leak data across
  questions. Infrastructure tables (`sources`, `config`,
  `gbrain_cycle_locks`, `subagent_rate_leases`) are preserved across resets.
- Sanitization parity: re-uses `INJECTION_PATTERNS` from
  `src/core/think/sanitize.ts` so adding a new injection pattern
  automatically covers takes AND benchmarks. One source of truth.
- Retrieved chat content is wrapped in `<chat_session id="..." date="...">`
  framing; the answer-gen system prompt declares the content UNTRUSTED.
  Same posture as `<take>` framing.
- The reader config and request builder in `src/eval/longmemeval/reader.ts`
  select the notes default or byte-identical direct baseline; the selected
  system text's sha is the row's `reader_prompt_sha`. The judge lives in
  `src/eval/longmemeval/judge.ts` (official prompt port) over the
  dataset-agnostic `src/eval/shared/judge-runner.ts` (retries, `judge_error`
  classes, canonical-price cost, budget ledger); `qa-accuracy.ts` builds the
  summary block, `src/eval/shared/bootstrap.ts` its interval.
- LLM injection seam: `runEvalLongMemEval(args, {client?: ThinkLLMClient})`.
  Tests stub the client so the full pipeline runs hermetically without any
  API key.

### Flags

Every flag lives in one table in `src/commands/eval-longmemeval.ts`
(`LME_FLAGS`) that drives both the parser and `--help`, so `--help` is the
authoritative list. The table below is maintained by hand and can lag it.
Unknown flags exit 1 before any work starts.

| Flag | Default | Purpose |
|---|---|---|
| `--limit N` | run all | Run only the first N questions (after `--question-ids` filtering) |
| `--model M` | `GBRAIN_MODEL`, else `sonnet` | Answer-generation model. A standalone run opens no brain, so it never reads `models.eval.longmemeval` or `models.tier.*`; the nightly probe resolves those against the brain and passes the result here |
| `--retrieval-only` | off | Skip LLM answer generation; emit the retrieved sessions as the hypothesis |
| `--keyword-only` | off | Skip vector embedding: pure keyword retrieval (no reranker, no embed cache) |
| `--expansion` | **off** | LLM multi-query expansion. Off for EVERY mode — the per-call setting beats the bundle, so `--mode tokenmax` alone does not expand. One Haiku call per question, non-deterministic; each row records `expansion_variants` |
| `--expansion-replay FILE` | off | Serve the `expansion_variants` recorded in FILE (a prior `--expansion` run) instead of calling the LLM, so cells differ only in their knobs; implies `--expansion`. A question missing from FILE is an `expansion_replay_miss` error row and the run exits 1 |
| `--expansion-variant-budget B` | not pinned | Pin `search.expansion_variant_budget`: `legacy` (every RRF list weight 1) or a number in (0, 4] — the total RRF weight shared by the expansion variant lists (the original list always keeps weight 1) |
| `--top-k K` | 8 | Retrieve K chunk rows per question; `recall_*@k` is scored over the distinct sessions among those K rows (the published rows use `--top-k 5`) |
| `--reader-mode direct\|notes` | notes | Notes-first evidence extraction and reasoning followed by a concise answer; `direct` preserves the original v3 reader prompt and 512-token output cap. This is an eval-reader default, not a `gbrain think` change |
| `--reader-max-tokens N` | 1024 for notes; 512 for direct | Positive integer reader output cap; notes with 512 reproduces the measured treatment's original budget, including cutoff risk. `max_tokens` completions fail rather than scoring partial text |
| `--mode M` | `balanced` (or an injected config snapshot) | Search mode `conservative` / `balanced` / `tokenmax`, resolved through `src/core/search/mode.ts` so retrieval matches production under that mode. No mode implies `--expansion` |
| `--reranker on\|off` | not pinned (bundle decides) | Pin `search.reranker.enabled` for the run (beats any injected snapshot and any `--search-pin` on the key). The reranker gate keys on the RESOLVED pin — flag, `--search-pin`, snapshot or bundle: whenever the run resolves to reranker on, readiness is preflighted (exit 2 with the fix if it cannot run) and the run exits non-zero if any row fell through un-reranked (`reranker_skipped_rows`). A `balanced`/`tokenmax` run with no `VOYAGE_API_KEY` therefore refuses to start (exit 2 with the fix text; a resume holding un-reranked rows exits 1) — pass `--reranker off` or set the key. A run in which every question errored also exits 1 |
| `--autocut on\|off` | not pinned (bundle decides) | Pin `search.autocut` for the run (beats any injected snapshot) |
| `--search-pin KEY=VALUE` | none | Pin any `search.*` config key for the run (repeatable, e.g. `--search-pin search.metadata_boost_gate=always`). The raw pin map folds into `retrieval_config_hash` (so a resumed file cannot mix pin sets); the knobs hash covers only the mode knobs the pins resolve into. Explicit flags (`--mode`, `--reranker`, `--autocut`, `--expansion-variant-budget`) win over a `--search-pin` on the same key. Unknown keys are set verbatim — check `gbrain search modes` to confirm a key exists |
| `--output FILE` | stdout | Write JSONL to FILE |
| `--resume-from FILE` | off | Skip `question_id`s already present in FILE (usually the `--output` path, which then appends). Prior rows are re-scored from their `retrieved[]` + the dataset gold; different reader mode, model, prompt or token budget is always refused. Use `--reader-mode direct` for historical direct receipts |
| `--allow-mixed-run-config` | off | Resume even when FILE rows carry a different `retrieval_config_hash`; never overrides the reader configuration guard |
| `--question-ids FILE` | all | Run only the listed `question_id`s (one per line, `#` comments); unknown ids or an empty file exit 1. Dev-slice / held-out discipline (`evals/longmemeval/`) |
| `--no-trajectory` | off | Skip the Haiku claim extractor AND the per-question intent routing (like-for-like retrieval receipts) |
| `--by-type` | off | Append the `schema_version: 2` `by_type_summary` line: per type `{total, all_hit, all_rate, any_hit, any_rate}` + aggregate, `excluded_abstention`, `mean_distinct_sessions`, `run_config` |
| `--by-type-floor F` | off | Exit non-zero if any question type's rate is below F in [0, 1]; gates on `recall_all` by default; implies `--by-type` |
| `--by-type-floor-metric M` | `recall_all` | Which rate `--by-type-floor` gates on: `recall_all` or `recall_any` |
| `--include-abstention` | off | Count `_abs` (abstention) questions in the recall denominators (default: emitted with `abstention: true`, excluded; the count lands in `excluded_abstention`) |
| `--embed-cache FILE` | `~/.cache/gbrain-eval/longmemeval-embed.sqlite` | Content-addressed embedding cache (bun:sqlite); hits/misses land in `run_config.cache`, and misses must be 0 for a like-for-like arm |
| `--no-embed-cache` | — | Disable the embedding cache for this run |
| `--capture-pool` | off | Record `rerank_pool` per row: the post-rerank candidate pool BEFORE autocut / the limit slice (`slug`, `chunk_id`, `session_id`, `rrf_rank`, `rerank_score`, `alias_hit`, `est_tokens`) for `scripts/replay-autocut-floor.ts`. Rows with answer sessions also get `pool_recall`: the fused (pre-rerank) pool size, each answer session's first rank in it (`gold_rank`, null when absent) and, at fused depths 30/50/100/300, how many answer sessions are present plus `all` / `any` |
| `--eval-pool-depth N` | off | Eval-only recall experiment: every retrieval arm fetches N candidates (N ≤ 300; production caps each arm at 100, unchanged) and `search.reranker.top_n_in` is pinned to N unless a `--search-pin` sets it. Folds into `retrieval_config_hash` and `run_config.eval_pool_depth` |
| `--decide SLOT=MODE` | all off | System One arm (repeatable; `off`, `on`, `shadow`). See "System One arms" below |
| `--decide-provider ID` | `typesafe:jev-1.13.0` | Decide provider written into the benchmark brain |
| `--decide-calibration FILE\|ref:ID` | none | Calibration row(s) for `on` slots: `gbrain decide calibrate --slot X --json` or `decide calibrations list --json` output (object, array or JSONL), or a reference id; inserted and adopted in each benchmark brain |
| `--decide-threshold SLOT=X` | none | Operator threshold override (the action-precision gate still applies) |
| `--decide-force-on SLOT` | off | Bypass the action-precision gate for SLOT (loud stderr WARN, recorded in `run_config.decide.force_on`) |
| `--decide-dataset JSONL` | none | The frozen labelled dataset (`gbrain decide dataset`): the run keeps only question ids in its eval half, and refuses (exit 1, `split_mismatch`) a calibration whose `split_hash` differs or whose `calibrate_only` is false |
| `--record` | off | Append an `EvalRunRecord` (suite `longmemeval`, params = `run_config`, error text secret-redacted) to `.gbrain-evals/eval-results.jsonl` |
| `--judge` | off | LLM-judge each reader answer against the gold with the official LongMemEval `evaluate_qa.py` prompts (temperature 0, max_tokens 16 — the official 10 is below the OpenAI API minimum; a one-token verdict is unaffected). Implies `--by-type` (the summary gains `qa_accuracy`, whose headline scores judge errors as incorrect); incompatible with `--retrieval-only`. With `--resume-from FILE`: judge-only backfill of rows lacking a settled verdict (no reader call; `judge_error` rows are re-judged), then `qa_accuracy` is rebuilt from ALL rows and FILE is rewritten with the judged rows |
| `--judge-model M` | `openai:gpt-4o` | Judge model (the official scorer's model); a bare id is read as an `openai` model |
| `--max-usd N\|off` | 5 | Cap on JUDGE spend only (the reader / extractor lanes are not metered here). Preflight refuses an estimate over the cap without `--yes` (exit 2); at run time the lane soft-stops at the cap and stamps the remaining rows `judge_skipped: "budget"` (not publishable). An unpriced judge model requires `off` |
| `--yes` | off | Proceed when the judge estimate exceeds `--max-usd` (the cap still soft-stops the run) |
| `--judge-concurrency N` | 1 | Parallel judge calls during a `--resume-from` backfill (live rows are judged inline after each reader call) |
| `--allow-incomplete-judgments` | off | Exit 0 even when `judge_errors > 0`, `skipped_budget > 0` or `unjudged > 0`. Default: such a run is NOT publishable (stderr `FAIL` line, exit 1) — re-run with `--judge --resume-from FILE` until all three are 0 |

Row fields: `recall_all_hit`, `recall_any_hit`, `recall_hit` (a DEPRECATED alias
of `recall_any_hit`, kept for v1 readers), `abstention`,
`distinct_sessions_in_top_k`, `retrieved[]`, `retrieved_session_ids`,
`search_meta`, `retrieval_config_hash`; on answered rows the reader pins
`reader_model`, `reader_model_snapshot`, `reader_mode`,
`reader_prompt_version`, `reader_prompt_sha`, `reader_max_tokens`,
`reader_config_hash`, `reader_finish_reason` (`--retrieval-only` rows carry `retrieval_only: true`
instead); with `--judge`, the `judge_*` fields listed under "Judged answer
accuracy".

### Fact-key and time-scope arms (`--fact-keys`, `--time-scope`)

Eval-only arms for time-aware retrieval (`src/eval/longmemeval/retrieval-arms.ts`);
nothing in production search calls them. Mechanism choices are made on the
frozen development split only.

| Flag | Default | Purpose |
|---|---|---|
| `--fact-keys chunk\|page` | off | Merge each session's extracted facts into its chunks' embedding input and re-embed (chunk = each fact on its best-matching chunk; page = all facts on every chunk). Retrieval still returns raw sessions; rows carry `fact_keys` |
| `--fact-extractor paper\|production` | paper | `paper` = the benchmark's published user-turn fact prompt; `production` = gbrain's facts extractor as shipped (8,000-character input) |
| `--fact-keys-model M` | utility tier (haiku); production extractor: `facts.extraction_model` | Extraction model |
| `--fact-keys-max-usd N` | 20 | Cap on uncached extraction spend; extractions are cached by content hash under `~/.cache/gbrain-eval/fact-keys-*.jsonl` |
| `--time-scope reserved\|partition` | off | Re-order a widened pool by the question's explicit time range (resolved against `question_date`) using each session's date and the dates it mentions. `reserved` keeps the top half of k in place; `partition` moves every in-range session first |
| `--time-scope-pool N` | 50 | Pool depth for `--time-scope`; rows carry `time_scope` and the same pool's unscoped top-k (`unscoped_recall_all_hit`), a paired control inside one run |

Active arms fold into `retrieval_config_hash` as `retrieval_arms`.

`--mode tokenmax` builds the vectors production builds for that mode
(`src/eval/longmemeval/synopsis-tier.ts`): after import, every session is
re-embedded at the per-chunk synopsis tier through the production
contextual-retrieval service with the backfill's synopsis model. Rows carry
`contextual_synopsis`; the model, prompt version, document cap and output cap
fold into `retrieval_config_hash` and `run_config.contextual_synopsis`.

| Flag | Default | Purpose |
|---|---|---|
| `--synopsis-max-usd N` | 20 | Cap on uncached synopsis spend; at the cap the run stops after the current question and exits 1 |
| `--synopsis-concurrency N` | 8 | Sessions synopsized in parallel per question (chunks within a session follow `GBRAIN_CONTEXTUAL_CHUNK_CONCURRENCY`) |
| `--synopsis-cache FILE` | `~/.cache/gbrain-eval/synopsis-<model>.jsonl` | Synopsis cache keyed by the service's cache-key shape |

LoCoMo runs through the same harness after
`bun scripts/locomo-to-longmemeval.ts --input locomo10.json --conversations <ids> --output <file>`
(`src/eval/longmemeval/locomo.ts`): one question per non-adversarial QA, the
conversation's sessions as the haystack, evidence dialog ids mapped to gold
sessions. There is no default conversation list, and the sealed split is
converted only with `--custodian`.

Kill gates, sealed bars and budgets are fixed in
[`docs/eval/TIME_AWARE_RETRIEVAL_PREREG.md`](eval/TIME_AWARE_RETRIEVAL_PREREG.md).

### System One arms (`--decide`)

`gbrain eval longmemeval`, `gbrain eval brainbench` and `gbrain eval
retrieval-quality` accept the same flags, so matched runs differ only in the
slot under test:

```bash
# Baseline and S3 arm (same commit, data and pins; both --no-trajectory, see below)
gbrain eval longmemeval data.jsonl --retrieval-only --no-trajectory --reranker off --by-type --output base.jsonl
gbrain eval longmemeval data.jsonl --retrieval-only --no-trajectory --reranker off --by-type --output s3.jsonl \
  --decide evidence=on --decide-calibration evidence-cal.json --decide-dataset evidence.jsonl

# S1: --decide rerank=on also pins search.reranker.model typesafe:jev-1.13.0 and enables the reranker
gbrain eval longmemeval data.jsonl --retrieval-only --no-trajectory --decide rerank=on --by-type --output s1.jsonl

# Recall experiment: a fused pool of 300, reranked with top_n_in 300, with pool_recall per row
gbrain eval longmemeval data.jsonl --retrieval-only --no-trajectory --decide rerank=on --eval-pool-depth 300 --capture-pool --output deep.jsonl

# S4: the harness reader abstains when the S4 verdict is abstain (scored by --judge on the _abs questions)
gbrain eval longmemeval data.jsonl --no-trajectory --judge --decide answerable=on --decide-calibration answerable-cal.json

gbrain eval brainbench --suite know-to-ask --decide recall_needed=on --decide-calibration s6-cal.json --out bb.json
gbrain eval retrieval-quality fixture.jsonl --json --decide evidence=on
```

- The flags merge over an inherited `GBRAIN_DECIDE_SLOTS` (flags win), set it
  for the process and opt the command in; the effective value lands in
  `run_config.decide.gbrain_decide_slots` and every receipt. With no slot on
  or shadow, output is byte-identical to a run without the flags.
- LongMemEval and BrainBench build throwaway in-memory brains, so the command
  writes what the slot needs there: `decide.provider`, consent for the
  slot's data classes, `decide.egress.private allow` (public benchmark data),
  thresholds, `force_on`, awaited shadow (`shadow_wait on`, `shadow_sample
  1`) and the supplied calibrations. `retrieval-quality` runs on your
  connected brain and never writes its config: it refuses with the
  catalogued line when the provider, key or consent is missing, and refuses
  `--decide-calibration` / `--decide-threshold` / `--decide-force-on`.
- A LongMemEval `--decide` arm refuses trajectory routing, which reads the
  dataset's `question_type` labels; run both arms with `--no-trajectory` so
  routing uses text-only classifiers and the labels only score.
- Per-row receipts: each LongMemEval row gains `decide.<slot>` (mode,
  effective, skipped reason — `not_reached` when the slot's call site never
  ran — threshold, outcome tally, latency, resolved model, judged count,
  decide input tokens and cost from the benchmark brain's `decide_spend`
  for that question; S1 `on` reports the Jev reranker's latency and tokens;
  S2 adds `late` when the answer missed `decide.slots.intent.wait_ms`;
  S4 adds `answerability` and `reader_abstained`). The summary's `run_config`
  gains `decide` (flags, provider, calibration ids, thresholds, force_on,
  dataset split hashes; folded into `retrieval_config_hash`) and
  `decide_summary` (per slot: rows, acted, outcomes, skips, latency p50/p95,
  tokens, cost, S2 `late_rate`). BrainBench adds `turn_rows[].decide` (S6
  `recall_needed` at the claude-code turn-context seam) and a result-level
  `decide` block, and refuses `--update-baseline`; retrieval-quality `--json`
  adds `decide` with per-query receipts.
- Judge agreement (eval-only, no brain needed): `gbrain decide
  judge-agreement --suite longmemeval --input judged.jsonl` (a `--judge`
  output) or `--suite grounding --input grounding-labels.jsonl` asks Jev one
  question per item and reports n, raw agreement, Cohen's kappa with a 95%
  CI, the confusion matrix, per `question_type` slices, Jev cost and latency
  p50/p95. The reference labels are LLM verdicts: this is judge-vs-judge
  agreement. `--dry-run` estimates tokens and cost without sending anything.

### Numbers

p50 25.9ms / p99 30.3ms warm reset+import+search on Apple Silicon (per the
`test/eval-longmemeval.slow.test.ts` perf gate). Per-question cost well under the
500ms speed gate. 500 questions = ~13s of overhead plus your retrieval and
LLM latency.

## Measuring brain consistency over time

`gbrain eval suspected-contradictions` is a complementary measurement
instrument: it samples retrieval results for unmarked semantic
contradictions (e.g., compiled_truth vs chat content, intra-page chunk
vs active take). Where LongMemEval measures retrieval correctness on a
fixed labeled set, the contradiction probe measures how often a real
brain surfaces conflicting answers.

### Recommended nightly cadence

The probe is not part of the dream cycle or autopilot (the cycle only reads
the latest run), so schedule it yourself (cron, launchd or a systemd timer).
It needs queries: either write your own list (`--queries-file`, JSONL or one
query per line; nothing creates `~/.gbrain/queries.jsonl` for you), or turn
on query capture (`gbrain config set eval.capture true`; capture is off by
default) and use `--from-capture` once real queries have been recorded.

```bash
# Once a day, against queries you maintain:
gbrain eval suspected-contradictions \
  --queries-file ~/.gbrain/queries.jsonl \
  --top-k 5 \
  --budget-usd 5 \
  --output ~/.gbrain/probe-runs/$(date +%Y-%m-%d).json

# Or, with eval.capture on, against captured queries:
gbrain eval suspected-contradictions --from-capture --top-k 5 --budget-usd 5 \
  --output ~/.gbrain/probe-runs/$(date +%Y-%m-%d).json
```

Persistent cache (`eval_contradictions_cache`) makes re-runs near-zero
cost until you bump `PROMPT_VERSION`. Trend-track via:

```bash
gbrain eval suspected-contradictions trend --days 30
```

The ASCII bar chart shows total flagged per day. Headline % surfaces in
`gbrain doctor`'s `contradictions` check with paste-ready resolution
commands per high-severity finding.

### See also

- `docs/contradictions.md` — architecture, severity rubric, action criteria.
- `CHANGELOG.md` — release history.

## Eval infrastructure: by-type breakdowns, the hermetic gate, batch scoring

Three further eval surfaces, and the dev loop that uses them.

### `gbrain eval longmemeval --by-type` — per-question-type `recall_all@k` / `recall_any@k` breakdown

LongMemEval computes per-question-type recall internally, and surfaces it in
machine-readable form:

1. Every per-question JSONL row includes `question: string` (so the
   `gbrain eval cross-modal --batch` consumer below can read it without joining
   back against the dataset), `question_type`, `abstention`, `recall_all_hit`
   (every gold session among the top-k distinct sessions), `recall_any_hit`
   (at least one), `recall_hit` — a DEPRECATED alias of `recall_any_hit` kept
   for v1 readers — `gold_total` / `gold_found`, `distinct_sessions_in_top_k`,
   `retrieved[]` (every returned chunk row with its raw `session_id`, rank,
   score and `rerank_score`), `retrieved_session_ids`, `search_meta`
   (`vector_enabled`, `expansion_applied`, `degraded`, `reranked`, `autocut`)
   and `retrieval_config_hash`.
2. The `--by-type` flag emits a final `schema_version: 2` aggregate line keyed
   by `question_type` (values illustrative):

```json
{"schema_version": 2, "kind": "by_type_summary", "metric": "recall_all@k", "k": 5,
 "excluded_abstention": 3,
 "recall_by_type": {"single-session-user": {"total": 19, "all_hit": 17, "all_rate": 0.895, "any_hit": 18, "any_rate": 0.947}},
 "aggregate": {"total": 120, "all_hit": 104, "all_rate": 0.867, "any_hit": 112, "any_rate": 0.933},
 "legacy_rows": 0, "gold_missing_from_haystack": 0, "slug_collisions": 0,
 "mean_distinct_sessions": 4.9,
 "run_config": {"mode": "balanced", "keyword_only": false,
   "reranker": {"enabled": false, "model": "voyage:rerank-2.5"}, "autocut": false,
   "expansion": false, "expansion_variant_budget": null, "expansion_replay": null,
   "embedder": "openai:text-embedding-3-large@1536", "topK": 5, "trajectory": false,
   "dataset_sha256": "<sha256>", "dataset_questions": 500, "question_ids_file": null,
   "retrieval_config_hash": "<sha256>", "knobs_hash": "<hash>", "knobs_hash_version": 29,
   "cache": {"path": "~/.cache/gbrain-eval/longmemeval-embed.sqlite", "hits": 4210,
     "misses": 0, "bypassed": 0, "infra_faults": 0, "canonical_sha256": "<sha256>", "sha256": "<sha256>"},
   "reranker_skipped_rows": 0, "vector_degraded_rows": 0, "expansion_failed_rows": 0,
   "expansion_replay_miss": 0, "gold_missing_from_haystack": 0, "slug_collisions": 0,
   "excluded_abstention": 3, "errors": 0}}
```

`metric` names the headline: `all_rate` is strict `recall_all@k`, `any_rate`
the lenient `recall_any@k` (rates are `null` on an empty bucket, never NaN).
`excluded_abstention` counts the `_abs` questions kept out of the denominators
(`--include-abstention` folds them in). `legacy_rows` counts rows folded via
`addRowToBucket` with only a `recall_hit` (when non-zero the `all_rate` is a
lower bound). It is 0 on a fresh run AND on a resume: `--resume-from` re-scores
every prior row (pre-v2 rows included) from its retrieved ids against the
dataset's gold, so it only moves if a caller folds rows through
`addRowToBucket` directly. `run_config.cache` is `null` with a
`cache_skipped` reason when the embed cache was disabled, the run was
`--keyword-only`, or no embedding gateway was configured.

**Resume-safe.** When `--resume-from` is the same path as `--output`, prior
rows are re-scored from their `retrieved[]` (or `retrieved_session_ids`)
against the dataset's gold — stored booleans are never trusted — so the final
aggregate covers every resumed question, not just this run's slice. A file
whose rows carry a different `retrieval_config_hash` (other pins, or a config
snapshot that differs in any result-shaping knob) is refused unless
`--allow-mixed-run-config`. The prior summary at the file tail is replaced,
not appended — a run that resumes 5 times across 500 questions ends with
exactly ONE summary at the tail.

**Optional gate.** `--by-type-floor 0.85` exits non-zero when any
`question_type`'s `all_rate` (strict `recall_all@k`) falls below 0.85;
`--by-type-floor-metric recall_any` gates on the lenient rate instead.
Default: informational only.

```bash
# Diagnose per-type ranking quality after a search-touching change.
gbrain eval longmemeval ~/datasets/longmemeval_s.jsonl \
  --by-type --output /tmp/run.jsonl
tail -1 /tmp/run.jsonl | jq .   # summary line

# Strict gate in a CI script.
gbrain eval longmemeval test/fixtures/longmemeval-mini.jsonl \
  --by-type --by-type-floor 0.80 --output /tmp/run.jsonl
echo "exit=$?"  # 1 if any type fell below 0.80
```

### Hermetic retrieval gate — `test/eval-replay-gate.test.ts`

Guards against PRs touching `src/core/search/` silently regressing
retrieval. A "replay against captured eval_candidates" design can't work in
CI (CI has no captured production queries), so the gate is hermetic; see the
`contributor-mode CI capture` TODO in `TODOS.md` for the deferred
real-query version.

How it works:
- Hand-curated qrels fixture at `test/fixtures/eval-baselines/qrels-search.json`
  with PLACEHOLDER names only (no real people / companies per CLAUDE.md privacy
  rule).
- The test seeds a PGLite engine with synthetic pages whose embeddings are
  basis vectors (the same `basisEmbedding(idx)` pattern as
  `test/e2e/search-quality.test.ts`). No API keys, no DATABASE_URL.
- For each qrels query, calls `engine.searchVector(basisEmbedding(dim))` and
  computes `top1_match_rate` and `recall@10`. Asserts both meet floors
  (`>= 0.80` and `>= 0.85` by default).
- Lives in the unit-shard test matrix (`.github/workflows/test.yml`) so it
  runs on every PR via `bun test`, NOT in the E2E fixed-file workflow.

#### Refreshing the qrels fixture (the `Why:` discipline)

When CI fails because a legitimate ranking change moved expected slugs, the
fix is to edit `qrels-search.json` directly. **Always include a `Why:` line
in the commit body** so future maintainers can read the audit trail. Without
the `Why:`, the gate degrades to a rubber stamp within months. The convention
is informational (not a commit-hook block), but enforce it in PR review.

Example commit body:

```
chore(eval): refresh qrels for new source-boost ordering

Why: source-boost weights originals/ over concepts/, so q12
(founder-mode) correctly surfaces originals/founder-mode-example top-1. Manual verification: ran the production query; new ranking is
clearly better-aligned with the query intent.
```

#### Env-overrides for floors

```bash
GBRAIN_REPLAY_GATE_TOP1_FLOOR=0.85 \
GBRAIN_REPLAY_GATE_RECALL_FLOOR=0.90 \
  bun test test/eval-replay-gate.test.ts
```

Use to tighten or loosen the gate as the qrels fixture matures.

### `gbrain eval cross-modal --batch` — batch quality scoring

Single-task cross-modal eval scores one (task, output) pair. Batch mode runs
the same scoring over an entire LongMemEval JSONL output, with cost guardrails.

```bash
# Step 1: produce LongMemEval hypotheses (real cost: depends on model + N).
gbrain eval longmemeval ~/datasets/longmemeval_s.jsonl \
  --limit 10 --output /tmp/run.jsonl

# Step 2: batch-score those hypotheses (real cost: ~$0.70 for 10 questions,
# 1 cycle, 3 model slots at default --max-usd 5 budget cap).
gbrain eval cross-modal --batch /tmp/run.jsonl \
  --limit 10 --cycles 1 --concurrent 3 --max-usd 5 --json
echo "exit=$?"  # 0=all-pass, 1=any-fail, 2=any-error-or-inconclusive
```

**Key behaviors:**
- Default `--cycles 1` in batch mode (single-task default is 3 in TTY) to bound
  cost. Pass `--cycles 3` to match single-task strictness.
- `--concurrent 3` runs up to 3 questions in parallel x 3 model slots each =
  9 simultaneous API calls. Below tier-1 rate limits for all three providers.
- `--max-usd FLOAT` refuses to start if the pre-flight cost estimate exceeds
  the cap, unless `--yes` bypasses (required for non-interactive cron / CI).
- Filters `kind: "by_type_summary"` rows automatically (the LongMemEval
  `--by-type` summary line is metadata, not a question).
- `--batch` is mutually exclusive with `--task`; fail-fast usage error if both
  are set.
- Exit precedence (fail-loud): ERROR > FAIL > INCONCLUSIVE > PASS.
- Per-question receipts land in a tempdir and are deleted at end of batch; the
  summary inlines per-question verdicts so the audit trail is self-contained.
  Each scored question also carries `slot_scores`: per dimension, one score
  per slot in slot order, `null` for a slot that gave none.
- The summary's `panel` counts the distinct judge models and providers
  among the slots that scored at least one question, and records per slot
  (`slot_scored_questions`, slot order) how many questions it scored. The
  stderr verdict line prints both counts. Stderr also names a model that
  holds two or more of those slots (its votes count more than once), a slot
  that scored no question (it did not judge), and says when fewer than
  three providers judged (the panel is then not cross-modal). None of this
  changes the verdict or the exit code.

### Nightly cross-modal quality probe (opt-in, autopilot)

`src/core/cycle/nightly-quality-probe.ts` ships a phase that runs the longmemeval
+ cross-modal pipeline once per 24h. **Disabled by default** to avoid surprise
API spend. Enable per-host:

```bash
gbrain config set autopilot.nightly_quality_probe.enabled true
```

The autopilot scheduler invokes the probe on its tick cadence when the
config gate is on (`src/commands/autopilot.ts`, pinned by
`test/autopilot-nightly-probe-wiring.test.ts`); the phase also stays
callable in isolation, and the test harness exercises it via DI stubs.

```bash
# Manual smoke (exercises the path via DI stubs, no real API spend).
bun test test/nightly-quality-probe.test.ts
```

**What it measures.** The probe is a synthetic smoke test, not a health
score for your brain. It answers the 10 committed questions in
`test/fixtures/longmemeval-nightly.jsonl` from an isolated in-memory
benchmark brain, with your search mode, reranker and model routes, and has
three judges grade the answers. A PASS says the retrieval-plus-answer
pipeline and the judges work end to end tonight; it says nothing about the
pages in your own brain. The fixture is embedded in the gbrain binary, so
source checkouts and compiled installs run the same probe.

#### Model routes

The probe runs inside the autopilot daemon, which holds your brain. Right
before each run it refreshes the daemon's AI gateway from the brain (the way
queued jobs do), resolves every model against the brain, and passes the
result to the two eval commands, which open no brain of their own.
`gbrain models` prints the same routes under "Nightly quality probe", each
with its source. It judges provider keys from the shell you run it in: a key
that only `~/.gbrain/env` holds (the daemon's launcher sources that file)
reads there as missing, so a slot default it serves shows as a substitute and
a key-aware default can differ from the daemon's.

| Route | Resolution (first one set wins) | Reaches |
|---|---|---|
| Reader | `models.eval.longmemeval` → `models.tier.reasoning` → `models.default` → `GBRAIN_MODEL` → key-aware reasoning default | `gbrain eval longmemeval --model` |
| Trajectory extractor | `models.tier.utility` → `models.default` → `GBRAIN_MODEL` → key-aware utility default | the claim extractor; the rows' `methodology_note` names it |
| Judge slot A / B / C | `models.eval.cross_modal.slot_a` / `slot_b` / `slot_c` (aliases expand), else the panel default `openai:gpt-5.2` / `anthropic:claude-opus-4-7` / `deepseek:deepseek-v4-pro` | `gbrain eval cross-modal --slot-<x>-model` |

A slot key always wins, even when its provider has no key here (that slot
then errors at call time). An unset slot whose default provider has no key on
this install takes the brain's chat model instead (#4636). Slots A and C share
that substitute: on a brain with no OpenAI or DeepSeek key, two of the three
judges are one model, and setting only `slot_b` to the chat model makes all
three judges one model. When `models.tier.reasoning` is set and neither
`models.chat` nor `models.eval.longmemeval` is, the chat model and the reader
both resolve to that tier, so the substitute is also the reader: those judges
grade their own answers.

**No metered chat calls on a subscription-only brain.** Route the reader and
the extractor through tiers on `claude-cli`, and set the three slot keys to
three *different* models, none of them the reader (`gbrain models` shows it),
so no judge grades its own answers. One provider is enough, for example three
claude-cli models from different families:

```bash
gbrain config set models.tier.reasoning claude-cli:claude-opus-5-5
gbrain config set models.tier.utility claude-cli:claude-sonnet-5
gbrain config set models.eval.cross_modal.slot_a claude-cli:claude-fable-5-1
gbrain config set models.eval.cross_modal.slot_b claude-cli:claude-sonnet-5-5
gbrain config set models.eval.cross_modal.slot_c claude-cli:claude-haiku-4-5-20251001
gbrain models   # the "Nightly quality probe" block shows every route and its source
```

Query embeddings still go to your embedding provider.

**Say to your agent:** *"Make the nightly quality probe judge with three
different Claude subscription models, none of them the model that answers the
questions, so it stops spending on API keys."* (the
agent runs `gbrain config set models.eval.cross_modal.slot_<a|b|c> <model>`
and checks the result with `gbrain models`).

Observability:
- `~/.gbrain/audit/quality-probe-YYYY-Www.jsonl` — one event per run with
  outcome (pass / fail / inconclusive / error / budget_exceeded /
  no_embedding_key / skipped), pass/fail/inconclusive/error counts,
  est_cost_usd, fixture_sha8. ISO-week rotation (mirrors slug-fallback
  audit). The row also carries the evidence behind its verdict, in the
  optional fields below (rows written by older releases lack them and
  still read).
- `gbrain doctor` surfaces `nightly_quality_probe_health`:
  - SKIPPED (disabled) — with paste-ready enable command.
  - OK (enabled, no events yet) — autopilot hasn't fired its first run.
  - OK (last 7d all PASS) — with timestamp of latest run.
  - WARN — any run that did not pass in the window (FAIL, ERROR,
    INCONCLUSIVE, BUDGET_EXCEEDED, NO_EMBEDDING_KEY or SKIPPED), with
    outcome counts and the latest run's reason (the digest in `detail`).
    SKIPPED means the probe could not run (its fixture was unreadable), so
    it gave no quality signal; it is never reported as OK.
  - The OK and WARN messages name the latest run's judge panel and any
    slot that scored no question (it did not judge). When one model holds
    two or more of the slots that judged, its votes count more than once:
    doctor names that model and the next step, three different models in
    `models.eval.cross_modal.slot_a`, `slot_b` and `slot_c` (one provider
    is enough, for example three claude-cli models). Judges from fewer
    than three providers are reported as not cross-modal, as information;
    the check's status does not change.
- **Collapsed panel → inconclusive.** When one model holds two or more of
  the slots that judged (for example the sonnet/opus/sonnet panel an
  Anthropic-only brain gets from the #4636 substitute), or fewer than two
  models judged, the run is `inconclusive` with `reason: panel_collapsed`,
  whatever the batch's verdict was: one model voting twice is not a cross
  check. The `detail` names the model and slots, keeps the batch verdict,
  and gives the next step (`gbrain config set
  models.eval.cross_modal.slot_a <model>`, and `slot_b`, `slot_c`).
- **Receipts.** A run that did not pass keeps its batch summary and
  LongMemEval output under `~/.gbrain/audit/nightly-probe/<timestamp>/`
  (newest 7 runs) and names the directory in `receipt_dir`. The fixture is
  synthetic, so receipts hold no user data.

| Audit field | Written on | Meaning |
|---|---|---|
| `reader_model`, `extractor_model` | rows written after the model routes resolved | The reader and the trajectory extractor the run used. |
| `judge_models` | rows from a completed batch | The configured judge models in slot order (A, B, C). |
| `judge_scored_questions` | rows from a completed batch | Per slot in slot order, the questions that judge scored; `0` names a slot that did not judge. |
| `distinct_judge_models`, `distinct_judge_providers` | rows from a completed batch | How many different models and providers judged, counted over the slots that scored at least one question. The batch's stderr verdict line prints both. |
| `failures` | fail, inconclusive and error rows from a batch | Up to 10 non-passing questions in summary order: `question_id`, `verdict`, then either `dimensions` (each failing dimension with its `mean`, its per-slot `scores` in slot order, `null` for a slot that gave no score, and its `fail_reason`, `mean_below_7` or `min_below_5`; a dimension name the probe does not ask for reads `unrecognized`) or the `error` text, cut before any raw model output, redacted and cut to 200 characters. An inconclusive question lists the `slot_errors` of the judges that did not score. |
| `detail` | the same rows | A one-line digest, for example `6/10 questions did not pass (directness mean_below_7 x6); judges: 2 distinct models from 1 provider`. It counts every question that did not pass, also past the 10 listed, and malformed batch rows (`malformed xN`), and names a slot that scored no question. |
| `chat_calls`, `chat_cost_usd`, `unpriced_chat_calls` | rows of a run that reached its model calls, including a run that failed part-way | The run's metered chat spend: successful chat calls (reader, extractor, judges), their USD cost from canonical pricing, and the calls with no price on file, whose cost is unknown and never counted as 0. |
| `cap_usd`, `cap_source` | rows of a run that reached its model calls | The run-level cap and where it came from: `user` (a configured `max_usd`) or `default` ($5). |
| `reason` | skipped, collapsed-panel inconclusive and budget_exceeded rows | `fixture_unavailable`, `panel_collapsed`, or the budget's `cost` / `runtime` / `no_pricing`. |
| `receipt_dir` | rows of a run that did not pass and got as far as writing output | Where its `summary.json` and `lme-output.jsonl` were kept. |

**Say to your agent:** *"Why did last night's quality probe fail?"* (the
agent reads the `detail` and `failures` of the latest
`quality-probe-*.jsonl` row and runs `gbrain doctor`).

Cost: two numbers that cover different calls, so neither bounds the other.
- `est_cost_usd` is the batch's pre-flight estimate for its judge calls
  only (an assumed 5,000 input and 4,000 output tokens per judge call). At
  the fixture's 10 questions it depends on the panel: about $1.80 on the
  default three-provider panel and $2.80 on a sonnet/opus/sonnet panel (the
  #4636 substitute on an Anthropic-only brain). Unpriced judges such as
  `claude-cli:*` add nothing, and a row written without a batch summary (a
  run that failed part-way) records 0.
- `chat_cost_usd` is what every chat call of the run cost (reader,
  extractor and judges), metered as they succeed and recorded also on a row
  of a run that failed part-way. Calls with no price on file are counted
  in `unpriced_chat_calls`, not here. Query embeddings are priced
  separately and not included. On an Anthropic-keyed brain with the
  sonnet/opus/sonnet panel, one run metered about $0.38 where the batch
  estimated $2.80; with unpriced judges and a priced reader the metered
  cost can exceed the estimate.

**Run cap.** `autopilot.nightly_quality_probe.max_usd` (default $5) caps
every paid call of a run as one budget: the LongMemEval reader, extractor
and query embeddings, then the judges. Each call is reserved against the cap
before it is sent. When the cap runs out the run stops, makes no further
paid call (no judging when LongMemEval used it up), and records
`budget_exceeded` with the reason, never `fail`. Pricing follows the
spend-control rule: under the default cap a model with no price on file
warns and runs (counted in `unpriced_chat_calls`); once you set `max_usd`
yourself, an unpriced model is refused with the `no_pricing` guidance, which
names the `gbrain pricing set` command that registers its rate (or add it to
`pricing.overrides`). A typical run on priced API models costs well under a
dollar of metered chat (`chat_cost_usd`), plus query embeddings.

## Local benchmark scripts

Three deterministic, keyless benchmarks run an in-process PGLite brain and
print a report (`--json` for machine-readable output). They are not collected
by any test runner; run them when touching the code they measure.

### Graph quality benchmark (`scripts/bench-graph-quality.ts`)

80 fictional pages (people, companies, meetings, concepts) seeded with the
current extraction contract: meeting attendance from the meeting's
frontmatter `attendees:` (edges person -> meeting, type `attended`), founders
from the person's frontmatter `founded:`, and employment, advising and
investment from prose links. After `gbrain extract links --source db
--include-frontmatter` and `extract timeline`, it scores link recall and
precision, type accuracy, timeline recall and precision, typed and relational
traversal, idempotent re-extraction, multi-hop traversal, a top-N aggregate,
a two-type intersection, and keyword ranking with the backlink boost, each
against a grep-over-page-text baseline (A). It exits 1 when a threshold fails
(link recall 0.85, link precision 0.95, timeline recall 0.85 and precision
0.95, type accuracy 0.80, relational recall 0.80, both idempotency checks).

Last recorded run (2026-10-04, v0.60.48.0): every threshold passes at 100%
(90 links, 95 timeline rows); the grep baseline reaches the same relational
recall with 45.5% precision; multi-hop recall is 10/10 against 0/10 for grep.
In the ranking section the boost leaves unlinked pages where they were (avg
rank 27.5) and does not lift the four most-linked startups above the other
linked startups (avg rank 12.5 without, 13.25 with); the order of equal
keyword scores is not stable between runs.

### Knowledge runtime benchmark (`scripts/bench-knowledge-runtime.ts`)

Three checks with mocked resolvers: timeline rows are queryable right after
`put_page` with `auto_timeline` on and off (they are a canonical projection
that commits with the page, so both arms read 100%); the bare-tweet repair
buckets under a 70/20/10 resolver confidence mix (35 repaired, 10 to review, 5
skipped of 50); and doctor's integrity scan surfacing planted issues (last
run: 5 of 6, with 2 of 3 bare tweets caught).

### put_page latency (`scripts/bench-put-page-latency.ts`)

200 `put_page` operation calls against 10 target pages, half carrying three
timeline bullets. Reports mean, p50, p95, p99 and max latency and the timeline
rows committed (300 expected). Last run on one Capy cloud machine: p50 21 ms,
p95 42 ms, p99 142 ms.
